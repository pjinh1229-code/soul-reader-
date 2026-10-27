import 'dart:async';

/// Store products are public identifiers. They are not proof of payment.
class BillingOffer {
  const BillingOffer({
    required this.key,
    required this.productId,
    this.consumable = true,
  });

  final String key;
  final String productId;
  final bool consumable;
}

class BillingConfig {
  BillingConfig({required Iterable<BillingOffer> offers, this.enabled = true})
      : offers = List<BillingOffer>.unmodifiable(offers);

  final List<BillingOffer> offers;
  final bool enabled;

  bool get isConfigured =>
      enabled &&
      offers.length == 2 &&
      offers.map((offer) => offer.key).toSet().containsAll({'single', 'bundle'}) &&
      offers.map((offer) => offer.productId).toSet().length == offers.length &&
      offers.every((offer) =>
          RegExp(r'^[a-z0-9][a-z0-9_.]{1,149}$').hasMatch(offer.productId));

  BillingOffer? offerForKey(String key) {
    for (final offer in offers) {
      if (offer.key == key) return offer;
    }
    return null;
  }

  BillingOffer? offerForProduct(String productId) {
    for (final offer in offers) {
      if (offer.productId == productId) return offer;
    }
    return null;
  }
}

class StoreProduct {
  const StoreProduct({
    required this.productId,
    required this.title,
    required this.description,
    required this.price,
    required this.currencyCode,
    required this.rawPrice,
  });

  final String productId;
  final String title;
  final String description;
  final String price;
  final String currencyCode;
  final double rawPrice;
}

enum StorePurchaseState { pending, purchased, restored, canceled, error }

/// Sensitive verificationData remains native and must never be sent to WebView.
class StorePurchase {
  const StorePurchase({
    required this.productId,
    required this.state,
    this.purchaseId,
    this.verificationData = '',
    this.verificationSource = 'google_play',
    this.pendingCompletion = false,
    this.errorCode,
    this.nativeHandle,
  });

  final String productId;
  final StorePurchaseState state;
  final String? purchaseId;
  final String verificationData;
  final String verificationSource;
  final bool pendingCompletion;
  final String? errorCode;
  final Object? nativeHandle;
}

/// IDs are opaque, server-issued identifiers, never email addresses or names.
class PurchaseContext {
  const PurchaseContext({
    required this.offerKey,
    required this.productId,
    required this.requestId,
    required this.readingId,
    this.obfuscatedAccountId = '',
    this.obfuscatedProfileId = '',
  });

  final String offerKey;
  final String productId;
  final String requestId;
  final String readingId;
  final String obfuscatedAccountId;
  final String obfuscatedProfileId;

  bool matches(PurchaseContext other) =>
      offerKey == other.offerKey &&
      productId == other.productId &&
      requestId == other.requestId &&
      readingId == other.readingId;

  Map<String, dynamic> toJson() => {
        'offerKey': offerKey,
        'productId': productId,
        'requestId': requestId,
        'readingId': readingId,
        'obfuscatedAccountId': obfuscatedAccountId,
        'obfuscatedProfileId': obfuscatedProfileId,
      };

  factory PurchaseContext.fromJson(Map<String, dynamic> value) {
    String requiredValue(String name) {
      final text = value[name];
      if (text is! String || text.isEmpty) {
        throw const FormatException('Invalid pending purchase context');
      }
      return text;
    }

    return PurchaseContext(
      offerKey: requiredValue('offerKey'),
      productId: requiredValue('productId'),
      requestId: requiredValue('requestId'),
      readingId: requiredValue('readingId'),
      obfuscatedAccountId: value['obfuscatedAccountId'] as String? ?? '',
      obfuscatedProfileId: value['obfuscatedProfileId'] as String? ?? '',
    );
  }
}

class PurchaseVerificationRequest {
  const PurchaseVerificationRequest({
    required this.purchase,
    required this.offer,
    required this.context,
  });

  final StorePurchase purchase;
  final BillingOffer offer;
  final PurchaseContext? context;
}

/// A durable, authenticated backend ledger grant, not a Play callback.
class VerifiedGrant {
  const VerifiedGrant({
    required this.entitlementId,
    required this.transactionId,
    required this.productId,
    required this.offerKey,
    required this.requestId,
    required this.readingId,
    this.topic,
    this.status = 'active',
  });

  final String entitlementId;
  final String transactionId;
  final String productId;
  final String offerKey;
  final String requestId;
  final String readingId;
  final String? topic;
  final String status;

  bool get isValid => status == 'active' &&
      (topic == null || {'love', 'chance', 'work', 'bond'}.contains(topic)) &&
      (offerKey != 'bundle' || topic == null) && [
        entitlementId,
        transactionId,
        productId,
        offerKey,
        requestId,
        readingId,
      ].every((value) => value.isNotEmpty);

  Map<String, dynamic> toJson() => {
        'entitlementId': entitlementId,
        'transactionId': transactionId,
        'topic': topic,
        'status': status,
        'productId': productId,
        'offerKey': offerKey,
        'requestId': requestId,
        'readingId': readingId,
      };

  factory VerifiedGrant.fromJson(Map<String, dynamic> value) {
    String requiredValue(String name) {
      final text = value[name];
      if (text is! String || text.isEmpty) {
        throw const FormatException('Invalid verified grant');
      }
      return text;
    }

    return VerifiedGrant(
      topic: value['topic'] as String?,
      status: value['status'] as String? ?? 'active',
      entitlementId: requiredValue('entitlementId'),
      transactionId: requiredValue('transactionId'),
      productId: requiredValue('productId'),
      offerKey: requiredValue('offerKey'),
      requestId: requiredValue('requestId'),
      readingId: requiredValue('readingId'),
    );
  }
}

/// Implement with an authenticated HTTPS backend. Never validate tokens in JS.
abstract interface class PurchaseVerifier {
  bool get isConfigured;
  Future<PurchaseContext> preparePurchase(PurchaseContext request);
  Future<VerifiedGrant> verify(PurchaseVerificationRequest request);

  /// Consumed purchases cannot be restored by Google Play; restore this ledger.
  Future<List<VerifiedGrant>> restoreEntitlements();
}

/// Persist context before opening the store; no receipts are stored here.
abstract interface class PendingPurchaseJournal {
  Future<List<PurchaseContext>> load();
  Future<void> put(PurchaseContext context);
  Future<void> remove(String productId);
}

abstract interface class StoreGateway {
  Stream<List<StorePurchase>> get purchaseUpdates;
  Future<bool> isAvailable();
  Future<List<StoreProduct>> queryProducts(Set<String> productIds);
  Future<bool> buy({
    required String productId,
    required bool consumable,
    required PurchaseContext context,
  });

  /// Returns unconsumed/unfinished purchases, including pending transactions.
  Future<List<StorePurchase>> recoverPurchases();
  Future<void> consume(StorePurchase purchase);
  Future<void> complete(StorePurchase purchase);
}

class BillingFailure implements Exception {
  const BillingFailure(this.code);
  final String code;
  @override
  String toString() => 'BillingFailure($code)';
}

/// Coordinates receipt verification, durable delivery and finalization.
///
/// The backend must enforce unique purchase-token/order grants across devices.
/// onGrant must durably apply the verified entitlement before its Future ends.
class BillingController {
  BillingController({
    required this.config,
    required this.store,
    required this.verifier,
    required this.journal,
    required this.onState,
    required this.onGrant,
    this.onEntitlements,
  });

  final BillingConfig config;
  final StoreGateway store;
  final PurchaseVerifier verifier;
  final PendingPurchaseJournal journal;
  final void Function(Map<String, dynamic> state) onState;
  final Future<void> Function(VerifiedGrant grant) onGrant;

  /// Replaces the complete active ledger, including an empty list after refunds.
  final Future<void> Function(List<VerifiedGrant> grants)? onEntitlements;

  final Map<String, StoreProduct> _products = {};
  final Map<String, PurchaseContext> _contexts = {};
  final Set<String> _delivered = {};
  final Map<String, VerifiedGrant> _deliveredTransactions = {};
  final Set<String> _completed = {};
  final Set<String> _storePending = {};
  // An owned Play item may belong to another app account. Keep it unresolved
  // until authoritative recovery says it is gone or this account verifies it.
  final Set<String> _unresolvedOwned = {};
  final Completer<void> _journalReady = Completer<void>();
  StreamSubscription<List<StorePurchase>>? _subscription;
  Future<void>? _initialization;
  Future<void> _queue = Future<void>.value();
  bool _disposed = false;
  bool _storeAvailable = false;
  bool _launching = false;
  bool _restoring = false;
  bool _refreshing = false;
  String? _awaitingStoreProduct;
  int _processing = 0;
  String _status = 'initializing';
  String? _errorCode;

  bool get isConfigured => config.isConfigured && verifier.isConfigured;
  bool get _busy =>
      _launching || _restoring || _refreshing || _processing > 0;

  bool get canChangeAccount => !_busy && _awaitingStoreProduct == null && _storePending.isEmpty;

  bool canBuy(String offerKey) {
    final offer = config.offerForKey(offerKey);
    return !_disposed &&
        isConfigured &&
        _storeAvailable &&
        !_busy &&
        _contexts.isEmpty &&
        _storePending.isEmpty &&
        _unresolvedOwned.isEmpty &&
        offer != null &&
        _products.containsKey(offer.productId);
  }

  Map<String, dynamic> get snapshot => {
        'status': _status,
        'configured': isConfigured,
        'storeAvailable': _storeAvailable,
        'busy': _busy || _storePending.isNotEmpty,
        'canRestore': !_disposed && isConfigured && !_busy,
        'errorCode': _errorCode,
        'products': config.offers.map((offer) {
          final product = _products[offer.productId];
          return {
            'offerKey': offer.key,
            'productId': offer.productId,
            'available': product != null,
            'canBuy': canBuy(offer.key),
            if (product != null) ...{
              'title': product.title,
              'description': product.description,
              'price': product.price,
              'currencyCode': product.currencyCode,
              'rawPrice': product.rawPrice,
            },
          };
        }).toList(growable: false),
      };

  Future<void> initialize() => _initialization ??= _initialize();

  Future<void> _initialize() async {
    // Subscribe before any platform/journal request to avoid missing callbacks.
    _subscription = store.purchaseUpdates.listen(
      _enqueue,
      onError: (Object _) => _setError('store_stream_error'),
    );
    try {
      for (final context in await journal.load()) {
        _contexts[context.productId] = context;
      }
      _journalReady.complete();
      if (!isConfigured) {
        _setStatus('configuration_required');
        return;
      }
      await _queryStore();
      if (_processing == 0 && !_disposed) _setReady();
    } catch (_) {
      if (!_journalReady.isCompleted) _journalReady.complete();
      _setError('billing_initialization_failed');
    }
  }

  /// Requery after login or a transient Play connection/catalog failure.
  Future<void> refresh() async {
    await initialize();
    if (_disposed || _busy) return;
    if (!isConfigured) {
      _setStatus('configuration_required');
      return;
    }
    _refreshing = true;
    _setStatus('initializing');
    try {
      await _queryStore();
      if (!_disposed) _setReady();
    } catch (_) {
      _setError('catalog_unavailable');
    } finally {
      _refreshing = false;
      _emit();
    }
  }

  Future<void> _queryStore() async {
    _storeAvailable = await store.isAvailable();
    _products.clear();
    if (!_storeAvailable || _disposed) return;
    final products = await store.queryProducts(
      config.offers.map((offer) => offer.productId).toSet(),
    );
    for (final product in products) {
      if (config.offerForProduct(product.productId) != null) {
        _products[product.productId] = product;
      }
    }
    await _recoverStore();
  }

  Future<bool> buy(
    String offerKey, {
    required String requestId,
    required String readingId,
  }) async {
    await initialize();
    if (!canBuy(offerKey)) {
      _setError(isConfigured ? 'purchase_unavailable' : 'configuration_required');
      return false;
    }
    if (requestId.isEmpty || readingId.isEmpty ||
        requestId.length > 128 || readingId.length > 128) {
      _setError('invalid_purchase_context');
      return false;
    }
    final offer = config.offerForKey(offerKey)!;
    final request = PurchaseContext(
      offerKey: offer.key,
      productId: offer.productId,
      requestId: requestId,
      readingId: readingId,
    );
    _launching = true;
    _setStatus('purchasing');
    try {
      final context = await verifier.preparePurchase(request);
      if (!request.matches(context) ||
          context.obfuscatedAccountId.isEmpty ||
          context.obfuscatedProfileId.isEmpty ||
          context.obfuscatedAccountId.length > 64 ||
          context.obfuscatedProfileId.length > 64) {
        throw const BillingFailure('invalid_purchase_context');
      }
      if (_disposed) return false;
      await journal.put(context);
      if (_disposed) return false;
      _contexts[offer.productId] = context;
      _awaitingStoreProduct = offer.productId;
      final launched = await store.buy(
        productId: offer.productId,
        consumable: offer.consumable,
        context: context,
      );
      if (_disposed) return false;
      if (!launched) {
        _awaitingStoreProduct = null;
        await journal.remove(offer.productId);
        _contexts.remove(offer.productId);
        _setStatus('canceled');
      }
      return launched;
    } catch (error) {
      // Retain a journaled intent when launch outcome is uncertain. Restore
      // queries Play before allowing it to be replaced by another purchase.
      _setError(error is BillingFailure ? error.code : 'purchase_launch_failed');
      return false;
    } finally {
      _launching = false;
      _emit();
    }
  }

  Future<void> restore() async {
    await initialize();
    if (!isConfigured || _busy || _disposed) {
      _setError(isConfigured ? 'purchase_busy' : 'configuration_required');
      return;
    }
    _restoring = true;
    _setStatus('restoring');
    try {
      // Serialize the ledger read AND replacement with receipt delivery. A
      // late, empty restore response must not erase a newly delivered purchase.
      final ledgerOperation = _queue.then((_) async {
        final grants = await verifier.restoreEntitlements();
        final transactions = <String>{};
        final entitlements = <String>{};
        for (final grant in grants) {
          _validateGrant(grant, config.offerForProduct(grant.productId));
          if (!transactions.add(grant.transactionId) ||
              !entitlements.add(grant.entitlementId)) {
            throw const BillingFailure('conflicting_verified_grant');
          }
        }
        if (onEntitlements != null && !_disposed) {
          await onEntitlements!(List<VerifiedGrant>.unmodifiable(grants));
        }
        // A replaced/revoked ledger also replaces delivery-cache authority.
        // A later independently verified active receipt may rehydrate its pass.
        _delivered.removeWhere((id) => !entitlements.contains(id));
        _deliveredTransactions.removeWhere(
            (_, grant) => !entitlements.contains(grant.entitlementId));
        for (final grant in grants) {
          await _deliver(grant);
        }
      });
      // Keep later receipts runnable after a failed restore, while returning
      // the failure to this operation's caller.
      _queue = ledgerOperation.catchError((Object _) {});
      await ledgerOperation;
      // Query again even after initial catalog/connection failure. Ledger
      // restoration above remains available when Play services are unavailable.
      await _queryStore();
      if (!_disposed) _setReady();
    } catch (error) {
      _setError(error is BillingFailure ? error.code : 'restore_failed');
    } finally {
      _restoring = false;
      _emit();
    }
  }

  Future<void> _recoverStore() async {
    final purchases = await store.recoverPurchases();
    if (_disposed) return;
    _awaitingStoreProduct = null;
    final owned = purchases.where((purchase) =>
        purchase.state == StorePurchaseState.pending ||
        purchase.state == StorePurchaseState.purchased ||
        purchase.state == StorePurchaseState.restored)
        .map((purchase) => purchase.productId).toSet();
    _unresolvedOwned.removeWhere((productId) => !owned.contains(productId));
    _storePending.removeWhere((productId) => !owned.contains(productId));
    for (final productId in _contexts.keys.toList(growable: false)) {
      if (!owned.contains(productId)) {
        await journal.remove(productId);
        _contexts.remove(productId);
        _storePending.remove(productId);
      }
    }
    _enqueue(purchases);
    await flush();
  }

  void _enqueue(List<StorePurchase> purchases) {
    _queue = _queue.then((_) async {
      await _journalReady.future;
      for (final purchase in purchases) {
        if (_disposed) return;
        await _handle(purchase);
      }
    }).catchError((Object _) {
      _setError('purchase_processing_failed');
    });
  }

  /// Waits for the purchase updates already received by the controller.
  Future<void> flush() => _queue;

  Future<void> _handle(StorePurchase purchase) async {
    if (!isConfigured) return; // Never acknowledge unverified receipts.
    final offer = config.offerForProduct(purchase.productId);
    if (offer == null) {
      _setError('unknown_product');
      return;
    }
    final key = '${purchase.productId}\u0000${purchase.purchaseId}\u0000'
        '${purchase.verificationData}';
    final settled = purchase.state == StorePurchaseState.purchased ||
        purchase.state == StorePurchaseState.restored;
    if (settled && _completed.contains(key)) return;
    if (_awaitingStoreProduct == purchase.productId) _awaitingStoreProduct = null;
    if (purchase.state == StorePurchaseState.pending) {
      _storePending.add(purchase.productId);
      _setStatus('pending');
      return;
    }
    _storePending.remove(purchase.productId);
    if (purchase.state == StorePurchaseState.canceled) {
      if (_unresolvedOwned.contains(purchase.productId)) {
        _setReady();
        return;
      }
      await journal.remove(purchase.productId);
      _contexts.remove(purchase.productId);
      _setStatus('canceled');
      return;
    }
    if (purchase.state == StorePurchaseState.error) {
      _setError('store_purchase_failed');
      return;
    }
    _unresolvedOwned.add(purchase.productId);
    if (purchase.verificationData.isEmpty) {
      _setError('receipt_missing');
      return;
    }
    _processing++;
    _setStatus('verifying');
    var phase = 'verification';
    try {
      final context = _contexts[purchase.productId];
      final grant = await verifier.verify(PurchaseVerificationRequest(
        purchase: purchase,
        offer: offer,
        context: context,
      ));
      _validateGrant(grant, offer);
      if (context != null &&
          (context.requestId != grant.requestId ||
              context.readingId != grant.readingId)) {
        throw const BillingFailure('purchase_context_mismatch');
      }
      if (_disposed) return;
      phase = 'delivery';
      await _deliver(grant);
      if (_disposed) return;
      phase = 'finalization';
      if (offer.consumable) {
        // Google Play consumption also acknowledges the purchase. Calling
        // acknowledgePurchase after consume can return ITEM_NOT_OWNED.
        await store.consume(purchase);
      } else if (purchase.pendingCompletion) {
        await store.complete(purchase);
      }
      if (_disposed) return;
      _completed.add(key);
      _unresolvedOwned.remove(purchase.productId);
      await journal.remove(purchase.productId);
      _contexts.remove(purchase.productId);
      _setReady();
    } catch (error) {
      _setError(error is BillingFailure
          ? error.code
          : 'purchase_${phase}_failed');
    } finally {
      _processing--;
      _emit();
    }
  }

  void _validateGrant(VerifiedGrant grant, BillingOffer? offer) {
    if (!grant.isValid || offer == null ||
        grant.productId != offer.productId || grant.offerKey != offer.key) {
      throw const BillingFailure('invalid_verified_grant');
    }
  }

  Future<void> _deliver(VerifiedGrant grant) async {
    if (_disposed) return;
    final previous = _deliveredTransactions[grant.transactionId];
    if (previous != null) {
      if (previous.entitlementId != grant.entitlementId ||
          previous.productId != grant.productId ||
          previous.offerKey != grant.offerKey ||
          previous.requestId != grant.requestId ||
          previous.readingId != grant.readingId) {
        throw const BillingFailure('conflicting_verified_grant');
      }
      return;
    }
    if (_delivered.contains(grant.entitlementId)) {
      throw const BillingFailure('conflicting_verified_grant');
    }
    await onGrant(grant);
    _delivered.add(grant.entitlementId);
    _deliveredTransactions[grant.transactionId] = grant;
  }

  void _setReady() {
    if (!isConfigured) {
      _setStatus('configuration_required');
    } else if (!_storeAvailable) {
      _setStatus('store_unavailable');
    } else if (_storePending.isNotEmpty) {
      _setStatus('pending');
    } else if (_contexts.isNotEmpty || _unresolvedOwned.isNotEmpty) {
      _status = 'recovery_required';
      if (_unresolvedOwned.isNotEmpty && _contexts.isEmpty) {
        _errorCode ??= 'owned_purchase_needs_account';
      }
      _emit();
    } else {
      _setStatus(_products.isEmpty ? 'products_unavailable' : 'ready');
    }
  }

  void _setStatus(String status) {
    _status = status;
    _errorCode = null;
    _emit();
  }

  void _setError(String code) {
    _status = 'error';
    _errorCode = RegExp(r'^[a-z_]{1,64}$').hasMatch(code)
        ? code
        : 'billing_error';
    _emit();
  }

  void _emit() {
    if (!_disposed) onState(snapshot);
  }

  Future<void> dispose() async {
    _disposed = true;
    await _subscription?.cancel();
  }
}
