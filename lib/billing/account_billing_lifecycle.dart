import 'dart:async';

import 'auth_session.dart';
import 'billing_controller.dart';
import 'http_purchase_verifier.dart';

/// A generation is never reused, including when the user returns A -> B -> A.
/// Native work must retain its generation until its last side effect completes.
class AccountBillingScope {
  AccountBillingScope._(this.epoch, this.identity);

  final int epoch;
  BillingIdentity? identity;
  bool _active = true;
  bool get isCurrent => _active;

  void ensureCurrent() {
    if (!_active) throw const BillingFailure('account_changed');
  }

  BillingSessionProvider guardSession(BillingSessionProvider session) =>
      _ScopedSession(this, session);
  PurchaseVerifier guardVerifier(PurchaseVerifier verifier) =>
      _ScopedVerifier(this, verifier);
  StoreGateway guardStore(StoreGateway store) => _ScopedStore(this, store);
  PendingPurchaseJournal guardJournal(PendingPurchaseJournal journal) =>
      _ScopedJournal(this, journal);

  Future<T> guard<T>(Future<T> Function() operation) async {
    ensureCurrent();
    final value = await operation();
    ensureCurrent();
    return value;
  }
}

/// Publishes only display labels and an opaque epoch to the WebView. Identity
/// keys and access tokens remain native. Subscribes before reading current user.
class AccountBillingLifecycle {
  AccountBillingLifecycle({
    required this.session,
    required this.onAuth,
    required this.onAccountChanged,
  });

  final BillingSessionProvider session;
  final void Function(Map<String, dynamic> payload) onAuth;
  final void Function(AccountBillingScope scope) onAccountChanged;
  StreamSubscription<BillingIdentity?>? _subscription;
  AccountBillingScope? _scope;
  int _epoch = 0;
  bool _started = false;
  bool _disposed = false;
  bool _busy = false;

  AccountBillingScope? get scope => _scope;
  int get epoch => _scope?.epoch ?? _epoch;
  bool get available => session is InteractiveBillingSession && session.isConfigured;
  bool get signedIn => _scope?.identity != null;
  bool get busy => _busy;

  void start() {
    if (_started || _disposed) return;
    _started = true;
    final interactive = session;
    if (interactive is InteractiveBillingSession) {
      _subscription = interactive.identityChanges.listen(_apply,
          onError: (Object _) {});
      _apply(interactive.currentIdentity);
    } else {
      _apply(null);
    }
  }

  void _apply(BillingIdentity? identity) {
    if (_disposed) return;
    if (_scope != null && _scope!.identity?.key == identity?.key) {
      _scope!.identity = identity;
      emitAuth();
      return;
    }
    _scope?._active = false;
    final next = AccountBillingScope._(++_epoch, identity);
    _scope = next;
    // Negotiate the epoch before any new account state or grants are emitted.
    emitAuth();
    onAccountChanged(next);
  }

  void emitAuth() {
    if (_disposed) return;
    onAuth({
      'type': 'auth',
      'available': available,
      'signedIn': signedIn,
      'label': _scope?.identity?.label ?? '',
      'busy': _busy,
      'epoch': epoch,
    });
  }

  Future<void> signIn() async {
    final interactive = session;
    if (!available || interactive is! InteractiveBillingSession) {
      throw const BillingAuthFailure('authentication_unavailable');
    }
    if (_busy || _disposed) throw const BillingAuthFailure('authentication_busy');
    _busy = true;
    emitAuth();
    try {
      final identity = await interactive.signIn();
      _apply(identity);
    } finally {
      _busy = false;
      emitAuth();
    }
  }

  Future<void> signOut() async {
    final interactive = session;
    if (!available || interactive is! InteractiveBillingSession) {
      throw const BillingAuthFailure('authentication_unavailable');
    }
    if (_busy || _disposed) throw const BillingAuthFailure('authentication_busy');
    _busy = true;
    emitAuth();
    try {
      await interactive.signOut();
    } finally {
      // Managed session clears local identity even when remote logout fails.
      _apply(interactive.currentIdentity);
      _busy = false;
      emitAuth();
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _scope?._active = false;
    await _subscription?.cancel();
    final interactive = session;
    if (interactive is InteractiveBillingSession) await interactive.dispose();
  }
}

class _ScopedSession implements BillingSessionProvider {
  _ScopedSession(this.scope, this.inner);
  final AccountBillingScope scope;
  final BillingSessionProvider inner;
  @override
  bool get isConfigured => scope.isCurrent && scope.identity != null && inner.isConfigured;
  @override
  Future<String?> accessToken() => scope.guard(() async {
    if (scope.identity == null) throw const BillingFailure('authentication_required');
    return inner.accessToken();
  });
}

class _ScopedVerifier implements PurchaseVerifier {
  _ScopedVerifier(this.scope, this.inner);
  final AccountBillingScope scope;
  final PurchaseVerifier inner;
  @override
  bool get isConfigured => scope.isCurrent && inner.isConfigured;
  @override
  Future<PurchaseContext> preparePurchase(PurchaseContext request) =>
      scope.guard(() => inner.preparePurchase(request));
  @override
  Future<VerifiedGrant> verify(PurchaseVerificationRequest request) =>
      scope.guard(() => inner.verify(request));
  @override
  Future<List<VerifiedGrant>> restoreEntitlements() =>
      scope.guard(inner.restoreEntitlements);
}

class _ScopedStore implements StoreGateway {
  _ScopedStore(this.scope, this.inner);
  final AccountBillingScope scope;
  final StoreGateway inner;
  @override
  Stream<List<StorePurchase>> get purchaseUpdates =>
      inner.purchaseUpdates.where((_) => scope.isCurrent);
  @override
  Future<bool> isAvailable() => scope.guard(inner.isAvailable);
  @override
  Future<List<StoreProduct>> queryProducts(Set<String> productIds) =>
      scope.guard(() => inner.queryProducts(productIds));
  @override
  Future<bool> buy({required String productId, required bool consumable,
    required PurchaseContext context}) => scope.guard(() => inner.buy(
      productId: productId, consumable: consumable, context: context));
  @override
  Future<List<StorePurchase>> recoverPurchases() => scope.guard(inner.recoverPurchases);
  @override
  Future<void> consume(StorePurchase purchase) => scope.guard(() => inner.consume(purchase));
  @override
  Future<void> complete(StorePurchase purchase) => scope.guard(() => inner.complete(purchase));
}

class _ScopedJournal implements PendingPurchaseJournal {
  _ScopedJournal(this.scope, this.inner);
  final AccountBillingScope scope;
  final PendingPurchaseJournal inner;
  @override
  Future<List<PurchaseContext>> load() => scope.guard(inner.load);
  @override
  Future<void> put(PurchaseContext context) => scope.guard(() => inner.put(context));
  @override
  Future<void> remove(String productId) => scope.guard(() => inner.remove(productId));
}
