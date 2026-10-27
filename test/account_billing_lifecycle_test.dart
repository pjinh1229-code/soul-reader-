import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/billing/account_billing_lifecycle.dart';
import 'package:soul_reader/billing/auth_session.dart';
import 'package:soul_reader/billing/billing_controller.dart';
import 'package:soul_reader/billing/http_purchase_verifier.dart';

const accountA = BillingIdentity(key: 'firebase:private-uid-a', label: 'Account A');
const accountB = BillingIdentity(key: 'firebase:private-uid-b', label: 'Account B');
const context = PurchaseContext(offerKey: 'single', productId: 'soul_reading_single',
  requestId: 'request-1', readingId: 'reading-1');
const grant = VerifiedGrant(entitlementId: 'grant-1', transactionId: 'txn-1',
  offerKey: 'single', productId: 'soul_reading_single', requestId: 'request-1', readingId: 'reading-1');
const receipt = StorePurchase(productId: 'soul_reading_single',
  state: StorePurchaseState.purchased, verificationData: 'private-purchase-token');

class FakeSession implements InteractiveBillingSession {
  final identities = StreamController<BillingIdentity?>.broadcast(sync: true);
  BillingIdentity? identity;
  int pickerCalls = 0;
  bool configured = true;
  bool logoutFails = false;
  Completer<String?>? tokenWait;
  void change(BillingIdentity? next) { identity = next; identities.add(next); }
  @override
  bool get isConfigured => configured;
  @override
  BillingIdentity? get currentIdentity => identity;
  @override
  Stream<BillingIdentity?> get identityChanges => identities.stream;
  @override
  Future<String?> accessToken() async => tokenWait == null ? 'private-id-token' : tokenWait!.future;
  @override
  Future<BillingIdentity> signIn() async { pickerCalls++; change(accountA); return accountA; }
  @override
  Future<void> signOut() async {
    change(null);
    if (logoutFails) throw const BillingAuthFailure('authentication_failed');
  }
  @override
  Future<void> dispose() => identities.close();
}

class FakeVerifier implements PurchaseVerifier {
  Completer<PurchaseContext>? prepared;
  Completer<VerifiedGrant>? verified;
  Completer<List<VerifiedGrant>>? restored;
  @override
  bool get isConfigured => true;
  @override
  Future<PurchaseContext> preparePurchase(PurchaseContext request) async =>
      prepared == null ? request : prepared!.future;
  @override
  Future<VerifiedGrant> verify(PurchaseVerificationRequest request) async =>
      verified == null ? grant : verified!.future;
  @override
  Future<List<VerifiedGrant>> restoreEntitlements() async =>
      restored == null ? [grant] : restored!.future;
}

class FakeJournal implements PendingPurchaseJournal {
  int writes = 0;
  Completer<void>? writing;
  @override
  Future<List<PurchaseContext>> load() async => [];
  @override
  Future<void> put(PurchaseContext value) async { writes++; await writing?.future; }
  @override
  Future<void> remove(String productId) async { writes++; }
}

class FakeStore implements StoreGateway {
  final updates = StreamController<List<StorePurchase>>.broadcast(sync: true);
  int consumed = 0;
  int bought = 0;
  @override
  Stream<List<StorePurchase>> get purchaseUpdates => updates.stream;
  @override
  Future<bool> isAvailable() async => true;
  @override
  Future<List<StoreProduct>> queryProducts(Set<String> ids) async => [];
  @override
  Future<bool> buy({required String productId, required bool consumable,
    required PurchaseContext context}) async { bought++; return true; }
  @override
  Future<List<StorePurchase>> recoverPurchases() async => [];
  @override
  Future<void> consume(StorePurchase purchase) async { consumed++; }
  @override
  Future<void> complete(StorePurchase purchase) async {}
}

void main() {
  late FakeSession session;
  late AccountBillingLifecycle lifecycle;
  late List<AccountBillingScope> scopes;
  late List<Map<String, dynamic>> events;
  setUp(() {
    session = FakeSession();
    scopes = [];
    events = [];
    lifecycle = AccountBillingLifecycle(session: session,
      onAuth: events.add, onAccountChanged: scopes.add);
  });
  tearDown(() => lifecycle.dispose());

  test('startup restores identity without opening the Google picker', () {
    session.identity = accountA;
    lifecycle.start();
    expect(lifecycle.signedIn, isTrue);
    expect(session.pickerCalls, 0);
    expect(scopes.single.identity!.key, accountA.key);
    expect(events.single['signedIn'], isTrue);
    expect(events.single.toString(), isNot(contains(accountA.key)));
    expect(events.single.toString(), isNot(contains('private-id-token')));
  });

  test('signed out startup and status never prompt; explicit action prompts', () async {
    lifecycle.start();
    lifecycle.emitAuth();
    expect(lifecycle.signedIn, isFalse);
    expect(session.pickerCalls, 0);
    await lifecycle.signIn();
    expect(session.pickerCalls, 1);
    expect(lifecycle.signedIn, isTrue);
    expect(events.last['busy'], isFalse);
  });

  test('auth epoch is announced before reset callback', () {
    final order = <String>[];
    lifecycle = AccountBillingLifecycle(session: session,
      onAuth: (event) => order.add('auth:${event['epoch']}'),
      onAccountChanged: (scope) => order.add('reset:${scope.epoch}'));
    lifecycle.start();
    expect(order, ['auth:1', 'reset:1']);
  });

  test('same account label refresh retains scope; A B A invalidates old scopes', () {
    session.identity = accountA;
    lifecycle.start();
    final first = scopes.single;
    session.change(const BillingIdentity(key: 'firebase:private-uid-a', label: 'Renamed'));
    expect(scopes.length, 1);
    expect(events.last['label'], 'Renamed');
    session.change(accountB);
    session.change(accountA);
    expect(scopes.map((scope) => scope.epoch), [1, 2, 3]);
    expect(first.isCurrent, isFalse);
    expect(() => first.ensureCurrent(), throwsA(isA<BillingFailure>()));
    expect(scopes.last.isCurrent, isTrue);
  });

  test('failed remote logout still invalidates all local account work', () async {
    session.identity = accountA;
    session.logoutFails = true;
    lifecycle.start();
    final first = scopes.single;
    await expectLater(lifecycle.signOut(), throwsA(isA<BillingAuthFailure>()));
    expect(first.isCurrent, isFalse);
    expect(lifecycle.signedIn, isFalse);
    expect(events.last['busy'], isFalse);
  });

  test('late access token cannot cross logout or a return to same account', () async {
    session.identity = accountA;
    lifecycle.start();
    session.tokenWait = Completer<String?>();
    final token = scopes.single.guardSession(session).accessToken();
    final rejected = expectLater(token, throwsA(isA<BillingFailure>()));
    session.change(accountB);
    session.change(accountA);
    session.tokenWait!.complete('private-old-token');
    await rejected;
  });

  test('late preparation cannot launch an old account purchase', () async {
    session.identity = accountA;
    lifecycle.start();
    final inner = FakeVerifier()..prepared = Completer<PurchaseContext>();
    final prepared = scopes.single.guardVerifier(inner).preparePurchase(context);
    final rejected = expectLater(prepared, throwsA(isA<BillingFailure>()));
    session.change(accountB);
    inner.prepared!.complete(context);
    await rejected;
  });

  test('late verification and ledger snapshots cannot grant in a new account', () async {
    session.identity = accountA;
    lifecycle.start();
    final inner = FakeVerifier()
      ..verified = Completer<VerifiedGrant>()
      ..restored = Completer<List<VerifiedGrant>>();
    final verifier = scopes.single.guardVerifier(inner);
    final verification = verifier.verify(const PurchaseVerificationRequest(
      purchase: receipt, offer: BillingOffer(key: 'single', productId: 'soul_reading_single'),
      context: context));
    final restoration = verifier.restoreEntitlements();
    final rejectedVerification = expectLater(verification, throwsA(isA<BillingFailure>()));
    final rejectedRestoration = expectLater(restoration, throwsA(isA<BillingFailure>()));
    session.change(accountB);
    inner.verified!.complete(grant);
    inner.restored!.complete([grant]);
    await rejectedVerification;
    await rejectedRestoration;
  });

  test('revoked scope cannot consume another account receipt or edit journal', () async {
    session.identity = accountA;
    lifecycle.start();
    final store = FakeStore();
    final journal = FakeJournal();
    final oldStore = scopes.single.guardStore(store);
    final oldJournal = scopes.single.guardJournal(journal);
    session.change(accountB);
    await expectLater(oldStore.consume(receipt), throwsA(isA<BillingFailure>()));
    await expectLater(oldStore.buy(productId: 'soul_reading_single', consumable: true,
      context: context), throwsA(isA<BillingFailure>()));
    await expectLater(oldJournal.remove('soul_reading_single'), throwsA(isA<BillingFailure>()));
    expect(store.consumed, 0);
    expect(store.bought, 0);
    expect(journal.writes, 0);
    await store.updates.close();
  });

  test('already started old journal write may finish but its continuation is fenced', () async {
    session.identity = accountA;
    lifecycle.start();
    final journal = FakeJournal()..writing = Completer<void>();
    final write = scopes.single.guardJournal(journal).put(context);
    final rejected = expectLater(write, throwsA(isA<BillingFailure>()));
    session.change(accountB);
    journal.writing!.complete();
    await rejected;
    expect(journal.writes, 1);
  });

  test('disposal invalidates scope before cancelling identity subscription', () async {
    session.identity = accountA;
    lifecycle.start();
    final first = scopes.single;
    await lifecycle.dispose();
    expect(first.isCurrent, isFalse);
    expect(() => first.ensureCurrent(), throwsA(isA<BillingFailure>()));
  });

  test('missing auth keeps public session unavailable without picker', () async {
    final auth = <Map<String, dynamic>>[];
    final missing = AccountBillingLifecycle(session: const MissingBillingSession(),
      onAuth: auth.add, onAccountChanged: (_) {});
    missing.start();
    expect(auth.single['available'], isFalse);
    expect(auth.single['signedIn'], isFalse);
    await expectLater(missing.signIn(), throwsA(isA<BillingAuthFailure>()));
    await missing.dispose();
  });
}
