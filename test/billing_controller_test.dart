import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/billing/billing_controller.dart';

const single = BillingOffer(key: 'single', productId: 'soul_single');
const bundle = BillingOffer(key: 'bundle', productId: 'soul_bundle');
const receipt = StorePurchase(
  productId: 'soul_single',
  state: StorePurchaseState.purchased,
  purchaseId: 'order-1',
  verificationData: 'receipt-secret-never-send-to-web',
  pendingCompletion: true,
);
const grant = VerifiedGrant(
  entitlementId: 'entitlement-1',
  transactionId: 'transaction-1',
  productId: 'soul_single',
  offerKey: 'single',
  requestId: 'request-1',
  readingId: 'reading-1',
);

class FakeJournal implements PendingPurchaseJournal {
  final Map<String, PurchaseContext> entries = {};
  Completer<void>? putWait;
  Completer<void>? putStarted;
  @override
  Future<List<PurchaseContext>> load() async => entries.values.toList();
  @override
  Future<void> put(PurchaseContext context) async {
    putStarted?.complete();
    await putWait?.future;
    entries[context.productId] = context;
  }
  @override
  Future<void> remove(String productId) async {
    entries.remove(productId);
  }
}

class FakeStore implements StoreGateway {
  final updates = StreamController<List<StorePurchase>>.broadcast(sync: true);
  bool available = true;
  bool launchResult = true;
  bool consumeFails = false;
  bool catalogFails = false;
  int buyCount = 0;
  int consumeCount = 0;
  int completeCount = 0;
  PurchaseContext? boughtContext;
  List<StorePurchase> owned = [];
  List<StoreProduct> products = const [
    StoreProduct(
      productId: 'soul_single',
      title: 'One topic',
      description: 'One reading',
      price: '₩990',
      currencyCode: 'KRW',
      rawPrice: 990,
    ),
    StoreProduct(
      productId: 'soul_bundle',
      title: 'All topics',
      description: 'One reading, four topics',
      price: '₩1,990',
      currencyCode: 'KRW',
      rawPrice: 1990,
    ),
  ];

  @override
  Stream<List<StorePurchase>> get purchaseUpdates => updates.stream;
  @override
  Future<bool> isAvailable() async => available;
  @override
  Future<List<StoreProduct>> queryProducts(Set<String> ids) async {
    if (catalogFails) throw const BillingFailure('catalog_unavailable');
    return products;
  }
  @override
  Future<bool> buy({
    required String productId,
    required bool consumable,
    required PurchaseContext context,
  }) async {
    buyCount++;
    boughtContext = context;
    return launchResult;
  }
  @override
  Future<List<StorePurchase>> recoverPurchases() async => owned;
  @override
  Future<void> consume(StorePurchase purchase) async {
    consumeCount++;
    if (consumeFails) throw const BillingFailure('purchase_consumption_failed');
  }
  @override
  Future<void> complete(StorePurchase purchase) async {
    completeCount++;
  }

  void emit(StorePurchase purchase) => updates.add([purchase]);
}

class FakeVerifier implements PurchaseVerifier {
  bool configured = true;
  bool reject = false;
  bool wrongPreparedContext = false;
  Completer<VerifiedGrant>? verifyWait;
  Completer<void>? verifyStarted;
  int verifyCount = 0;
  int prepareCount = 0;
  VerifiedGrant verified = grant;
  List<VerifiedGrant> ledger = [];
  Completer<List<VerifiedGrant>>? ledgerWait;
  Completer<void>? ledgerStarted;
  PurchaseVerificationRequest? lastVerification;

  @override
  bool get isConfigured => configured;
  @override
  Future<PurchaseContext> preparePurchase(PurchaseContext request) async {
    prepareCount++;
    return PurchaseContext(
      offerKey: request.offerKey,
      productId: request.productId,
      requestId: request.requestId,
      readingId: wrongPreparedContext ? 'another-reading' : request.readingId,
      obfuscatedAccountId: 'server-account',
      obfuscatedProfileId: 'server-order',
    );
  }
  @override
  Future<VerifiedGrant> verify(PurchaseVerificationRequest request) async {
    verifyCount++;
    lastVerification = request;
    if (reject) throw const BillingFailure('receipt_invalid');
    verifyStarted?.complete();
    return verifyWait == null ? verified : await verifyWait!.future;
  }
  @override
  Future<List<VerifiedGrant>> restoreEntitlements() async {
    ledgerStarted?.complete();
    return ledgerWait == null ? ledger : await ledgerWait!.future;
  }
}

void main() {
  late FakeStore store;
  late FakeVerifier verifier;
  late FakeJournal journal;
  late BillingController controller;
  late List<VerifiedGrant> delivered;
  late List<List<VerifiedGrant>> ledgerSnapshots;
  Future<void> Function(VerifiedGrant)? deliveryOverride;

  setUp(() {
    store = FakeStore();
    verifier = FakeVerifier();
    journal = FakeJournal();
    delivered = [];
    ledgerSnapshots = [];
    deliveryOverride = null;
    controller = BillingController(
      config: BillingConfig(offers: const [single, bundle]),
      store: store,
      verifier: verifier,
      journal: journal,
      onState: (_) {},
      onGrant: (value) async {
        if (deliveryOverride != null) await deliveryOverride!(value);
        delivered.add(value);
      },
      onEntitlements: (values) async => ledgerSnapshots.add(values),
    );
  });

  tearDown(() async {
    await controller.dispose();
    await store.updates.close();
  });

  Future<void> buy() async {
    expect(await controller.buy('single',
        requestId: 'request-1', readingId: 'reading-1'), isTrue);
  }

  test('unconfigured verification prevents purchase and receipt grants', () async {
    verifier.configured = false;
    await controller.initialize();
    expect(store.updates.hasListener, isTrue);
    expect(controller.snapshot['status'], 'configuration_required');
    expect(controller.canBuy('single'), isFalse);
    expect(await controller.buy('single',
        requestId: 'request-1', readingId: 'reading-1'), isFalse);
    store.emit(receipt);
    await controller.flush();
    expect(store.buyCount, 0);
    expect(verifier.verifyCount, 0);
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
  });

  test('uses store prices and keeps receipts out of public snapshots', () async {
    await controller.initialize();
    final products = controller.snapshot['products'] as List;
    expect(products.first['price'], '₩990');
    expect(products.last['price'], '₩1,990');
    expect(controller.snapshot.toString(), isNot(contains(receipt.verificationData)));
    expect(grant.toJson().toString(), isNot(contains(receipt.verificationData)));
  });

  test('durable delivery must finish before consuming; duplicates grant once', () async {
    final persisted = Completer<void>();
    final started = Completer<void>();
    deliveryOverride = (_) {
      started.complete();
      return persisted.future;
    };
    await buy();
    expect(store.boughtContext!.obfuscatedProfileId, 'server-order');
    expect(journal.entries['soul_single']!.readingId, 'reading-1');
    store.emit(receipt);
    await started.future;
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
    expect(controller.canBuy('bundle'), isFalse);
    persisted.complete();
    await controller.flush();
    expect(delivered.length, 1);
    expect(store.consumeCount, 1);
    expect(store.completeCount, 0, reason: 'Consumption acknowledges Android consumables');
    expect(journal.entries, isEmpty);
    expect(controller.canBuy('single'), isTrue);
    store.emit(receipt);
    store.emit(receipt);
    await controller.flush();
    expect(verifier.verifyCount, 1);
    expect(delivered.length, 1);
    expect(store.consumeCount, 1);
  });

  test('pending and cancellation never unlock or acknowledge', () async {
    await buy();
    store.emit(const StorePurchase(
        productId: 'soul_single', state: StorePurchaseState.pending));
    await controller.flush();
    expect(controller.snapshot['status'], 'pending');
    expect(controller.canBuy('bundle'), isFalse);
    expect(delivered, isEmpty);
    store.emit(const StorePurchase(
        productId: 'soul_single', state: StorePurchaseState.canceled));
    await controller.flush();
    expect(controller.snapshot['status'], 'canceled');
    expect(controller.canBuy('single'), isTrue);
    expect(verifier.verifyCount, 0);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
  });

  test('invalid receipt remains recoverable and never completes', () async {
    verifier.reject = true;
    await buy();
    store.emit(receipt);
    await controller.flush();
    expect(controller.snapshot['errorCode'], 'receipt_invalid');
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
    expect(journal.entries, isNotEmpty);
    verifier.reject = false;
    store.owned = [receipt];
    await controller.restore();
    expect(delivered.length, 1);
    expect(store.consumeCount, 1);
    expect(journal.entries, isEmpty);
  });

  test('another reading cannot receive a grant for this purchase context', () async {
    verifier.verified = const VerifiedGrant(
      entitlementId: 'entitlement-1', transactionId: 'transaction-1',
      productId: 'soul_single', offerKey: 'single',
      requestId: 'request-1', readingId: 'another-reading',
    );
    await buy();
    store.emit(receipt);
    await controller.flush();
    expect(controller.snapshot['errorCode'], 'purchase_context_mismatch');
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
  });

  test('a mismatched prepared order never opens Google Play', () async {
    verifier.wrongPreparedContext = true;
    expect(await controller.buy('single',
        requestId: 'request-1', readingId: 'reading-1'), isFalse);
    expect(store.buyCount, 0);
    expect(journal.entries, isEmpty);
    expect(controller.snapshot['errorCode'], 'invalid_purchase_context');
  });

  test('failed durable delivery leaves receipt unconsumed for retry', () async {
    var failDelivery = true;
    deliveryOverride = (_) async {
      if (failDelivery) throw StateError('disk write failed');
    };
    await buy();
    store.emit(receipt);
    await controller.flush();
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
    failDelivery = false;
    store.emit(receipt);
    await controller.flush();
    expect(delivered.length, 1);
    expect(store.consumeCount, 1);
  });

  test('consumption retry does not deliver a duplicate entitlement', () async {
    store.consumeFails = true;
    await buy();
    store.emit(receipt);
    await controller.flush();
    expect(delivered.length, 1);
    expect(journal.entries, isNotEmpty);
    expect(controller.snapshot['errorCode'], 'purchase_consumption_failed');
    store.consumeFails = false;
    store.emit(receipt);
    await controller.flush();
    expect(delivered.length, 1);
    expect(store.consumeCount, 2);
    expect(store.completeCount, 0);
    expect(journal.entries, isEmpty);
  });

  test('consumed passes restore from ledger and empty ledger revokes cache', () async {
    verifier.ledger = [grant];
    await controller.restore();
    expect(delivered, [grant]);
    expect(ledgerSnapshots.last, [grant]);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
    verifier.ledger = [];
    await controller.restore();
    expect(ledgerSnapshots.last, isEmpty);
    expect(delivered.length, 1);
  });

  test('restart recovers journaled context before processing owned receipt', () async {
    journal.entries['soul_single'] = const PurchaseContext(
      offerKey: 'single', productId: 'soul_single',
      requestId: 'request-1', readingId: 'reading-1',
      obfuscatedAccountId: 'server-account', obfuscatedProfileId: 'server-order',
    );
    store.owned = [receipt];
    await controller.initialize();
    expect(verifier.lastVerification!.context!.readingId, 'reading-1');
    expect(verifier.prepareCount, 0);
    expect(delivered.length, 1);
    expect(store.consumeCount, 1);
    expect(journal.entries, isEmpty);
  });

  test('restore retries a failed catalog and queries fresh store prices', () async {
    store.catalogFails = true;
    await controller.initialize();
    expect(controller.canBuy('single'), isFalse);
    store.catalogFails = false;
    await controller.restore();
    expect(controller.canBuy('single'), isTrue);
    expect(controller.snapshot['status'], 'ready');
  });

  test('login after initial unconfigured state can refresh the catalog', () async {
    verifier.configured = false;
    await controller.initialize();
    expect(controller.canBuy('single'), isFalse);
    verifier.configured = true;
    await controller.refresh();
    expect(controller.canBuy('single'), isTrue);
    expect(controller.snapshot['status'], 'ready');
  });

  test('late ledger response cannot erase a concurrently received purchase', () async {
    await buy();
    final active = <String>{};
    deliveryOverride = (value) async {
      active.add(value.entitlementId);
    };
    verifier.ledgerStarted = Completer<void>();
    verifier.ledgerWait = Completer<List<VerifiedGrant>>();
    final restoring = controller.restore();
    await verifier.ledgerStarted!.future;
    store.emit(receipt);
    // The receipt must wait until the authoritative ledger operation ends.
    await Future<void>.delayed(Duration.zero);
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    verifier.ledgerWait!.complete([]);
    await restoring;
    await controller.flush();
    expect(ledgerSnapshots.single, isEmpty);
    expect(active, {'entitlement-1'});
    expect(delivered, [grant]);
    expect(store.consumeCount, 1);
  });

  test('transaction identity cannot be redelivered as a second entitlement', () async {
    store.consumeFails = true;
    await buy();
    store.emit(receipt);
    await controller.flush();
    verifier.verified = const VerifiedGrant(
      entitlementId: 'a-different-entitlement', transactionId: 'transaction-1',
      productId: 'soul_single', offerKey: 'single',
      requestId: 'request-1', readingId: 'reading-1',
    );
    store.consumeFails = false;
    store.emit(receipt);
    await controller.flush();
    expect(delivered, [grant]);
    expect(controller.snapshot['errorCode'], 'conflicting_verified_grant');
    expect(store.consumeCount, 1);
  });

  test('missing products have no fallback price and cannot be purchased', () async {
    store.products = [];
    await controller.initialize();
    expect(controller.snapshot['status'], 'products_unavailable');
    expect(controller.canBuy('single'), isFalse);
    final products = controller.snapshot['products'] as List;
    expect(products.first.containsKey('price'), isFalse);
  });

  test('unknown product and revoked grants cannot unlock content', () async {
    await controller.initialize();
    store.emit(const StorePurchase(
      productId: 'unconfigured_product', state: StorePurchaseState.purchased,
      verificationData: 'unknown-token', pendingCompletion: true,
    ));
    await controller.flush();
    expect(verifier.verifyCount, 0);
    expect(delivered, isEmpty);
    verifier.ledger = [const VerifiedGrant(
      entitlementId: 'revoked', transactionId: 'transaction-1',
      productId: 'soul_single', offerKey: 'single', requestId: 'request-1',
      readingId: 'reading-1', status: 'revoked',
    )];
    await controller.restore();
    expect(controller.snapshot['errorCode'], 'invalid_verified_grant');
    expect(delivered, isEmpty);
    expect(ledgerSnapshots, isEmpty);
    expect(store.consumeCount, 0);
    expect(store.completeCount, 0);
  });

  test('account change stays blocked while waiting for the store outcome', () async {
    await buy();
    expect(controller.snapshot['busy'], isFalse);
    expect(controller.canChangeAccount, isFalse);
    store.emit(const StorePurchase(productId: 'soul_single',
      state: StorePurchaseState.canceled));
    await controller.flush();
    expect(controller.canChangeAccount, isTrue);
  });

  test('owned receipt from another account blocks rebuy without a local intent', () async {
    verifier.reject = true;
    store.owned = [receipt];
    await controller.initialize();
    expect(controller.snapshot['status'], 'recovery_required');
    expect(controller.snapshot['errorCode'], 'receipt_invalid');
    expect(controller.canBuy('single'), isFalse);
    expect(controller.canBuy('bundle'), isFalse);
    expect(controller.canChangeAccount, isTrue);
    expect(journal.entries, isEmpty);
    expect(store.consumeCount, 0);
    // Only a fresh successful Play ownership query can clear the block.
    store.owned = [];
    await controller.restore();
    expect(controller.canBuy('single'), isTrue);
  });

  test('late cancellation preserves an unresolved verified receipt context', () async {
    verifier.reject = true;
    await buy();
    store.emit(receipt);
    await controller.flush();
    store.emit(const StorePurchase(productId: 'soul_single',
      state: StorePurchaseState.canceled));
    await controller.flush();
    expect(journal.entries['soul_single']!.requestId, 'request-1');
    expect(controller.canBuy('single'), isFalse);
    expect(controller.snapshot['status'], 'recovery_required');
    expect(controller.canChangeAccount, isTrue);
    expect(store.consumeCount, 0);
    store.owned = [];
    await controller.restore();
    expect(journal.entries, isEmpty);
    expect(controller.canBuy('single'), isTrue);
  });

  test('disposal during durable intent write never launches the old store checkout', () async {
    journal.putWait = Completer<void>();
    journal.putStarted = Completer<void>();
    final buying = controller.buy('single', requestId: 'request-1', readingId: 'reading-1');
    await journal.putStarted!.future;
    await controller.dispose();
    journal.putWait!.complete();
    expect(await buying, isFalse);
    expect(store.buyCount, 0);
    expect(journal.entries['soul_single']!.readingId, 'reading-1');
  });

  test('disposal during verification cannot deliver or consume the old receipt', () async {
    await buy();
    verifier.verifyWait = Completer<VerifiedGrant>();
    verifier.verifyStarted = Completer<void>();
    store.emit(receipt);
    await verifier.verifyStarted!.future;
    await controller.dispose();
    verifier.verifyWait!.complete(grant);
    await controller.flush();
    expect(delivered, isEmpty);
    expect(store.consumeCount, 0);
    expect(journal.entries, isNotEmpty);
  });

}
