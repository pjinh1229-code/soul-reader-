import 'dart:async';

import 'http_purchase_verifier.dart';

/// Native identity. The key is never exposed to JavaScript or used as a token.
class BillingIdentity {
  const BillingIdentity({required this.key, required this.label});

  final String key;
  final String label;
}

/// Errors contain fixed UI codes, never SDK messages or credentials.
class BillingAuthFailure implements Exception {
  const BillingAuthFailure(this.code);
  final String code;

  @override
  String toString() => 'BillingAuthFailure($code)';
}

abstract interface class InteractiveBillingSession
    implements BillingSessionProvider {
  BillingIdentity? get currentIdentity;
  Stream<BillingIdentity?> get identityChanges;
  Future<BillingIdentity> signIn();
  Future<void> signOut();
  Future<void> dispose();
}

/// SDK boundary, also used to test account changes without platform plugins.
abstract interface class BillingIdentityGateway {
  BillingIdentity? get currentIdentity;
  Stream<BillingIdentity?> get identityChanges;
  Future<BillingIdentity> signIn();
  Future<void> signOut();
  Future<String?> accessToken();
  Future<void> dispose();
}

/// Keeps persisted native authentication silent until an explicit sign-in tap.
/// Every identity transition invalidates token work, including A -> B -> A.
class ManagedBillingSession implements InteractiveBillingSession {
  ManagedBillingSession(this._gateway) {
    _subscription = _gateway.identityChanges.listen(
      _onGatewayIdentity,
      onError: (Object _) => _setIdentity(null),
    );
    _identity = _gateway.currentIdentity;
  }

  final BillingIdentityGateway _gateway;
  final StreamController<BillingIdentity?> _changes =
      StreamController<BillingIdentity?>.broadcast();
  late final StreamSubscription<BillingIdentity?> _subscription;
  BillingIdentity? _identity;
  int _epoch = 0;
  bool _disposed = false;
  bool _suppressIdentities = false;
  Future<BillingIdentity>? _signInFuture;
  Future<void>? _signOutFuture;

  @override
  bool get isConfigured => !_disposed;

  @override
  BillingIdentity? get currentIdentity => _identity;

  @override
  Stream<BillingIdentity?> get identityChanges => _changes.stream;

  void _setIdentity(BillingIdentity? next, {bool invalidate = false}) {
    if (_disposed) return;
    final previous = _identity;
    if (invalidate || previous?.key != next?.key) _epoch++;
    if (!invalidate && previous?.key == next?.key &&
        previous?.label == next?.label) return;
    _identity = next;
    _changes.add(next);
  }

  void _onGatewayIdentity(BillingIdentity? next) {
    if (_disposed || _suppressIdentities) return;
    // SDK streams may have queued an older account before sign-out completed.
    if (next?.key != _gateway.currentIdentity?.key) {
      // Even a skipped intermediate account invalidates work already underway.
      // With an asynchronous SDK stream, A -> B -> A can arrive after the SDK's
      // current account has already returned to A.
      _epoch++;
      return;
    }
    _setIdentity(next);
  }

  @override
  Future<String?> accessToken() async {
    if (_disposed || _suppressIdentities || _identity == null) return null;
    final epoch = _epoch;
    final key = _identity!.key;
    try {
      final token = await _gateway.accessToken();
      if (_disposed || _suppressIdentities || epoch != _epoch ||
          _identity?.key != key || _gateway.currentIdentity?.key != key ||
          token == null || token.isEmpty ||
          token.contains(RegExp(r'[\r\n]'))) return null;
      return token;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<BillingIdentity> signIn() {
    if (_disposed) {
      return Future.error(
        const BillingAuthFailure('authentication_unavailable'));
    }
    if (_signInFuture != null) return _signInFuture!;
    if (_signOutFuture != null) {
      return Future.error(const BillingAuthFailure('authentication_busy'));
    }
    final completer = Completer<BillingIdentity>();
    _signInFuture = completer.future;
    _suppressIdentities = true;
    _setIdentity(null, invalidate: true);
    unawaited(() async {
      try {
        final identity = await _gateway.signIn();
        if (_disposed || identity.key.isEmpty ||
            identity.key != _gateway.currentIdentity?.key) {
          throw const BillingAuthFailure('authentication_session_changed');
        }
        _suppressIdentities = false;
        _setIdentity(identity);
        completer.complete(identity);
      } catch (error) {
        // Failed authentication leaves this session locally signed out.
        completer.completeError(error is BillingAuthFailure
            ? error : const BillingAuthFailure('authentication_failed'));
      } finally {
        _signInFuture = null;
      }
    }());
    return completer.future;
  }

  @override
  Future<void> signOut() {
    if (_disposed) return Future<void>.value();
    if (_signOutFuture != null) return _signOutFuture!;
    if (_signInFuture != null) {
      return Future.error(const BillingAuthFailure('authentication_busy'));
    }
    // Revoke local use immediately, even if platform sign-out later fails.
    _suppressIdentities = true;
    _setIdentity(null, invalidate: true);
    final completer = Completer<void>();
    _signOutFuture = completer.future;
    unawaited(() async {
      try {
        await _gateway.signOut();
        completer.complete();
      } catch (_) {
        completer.completeError(const BillingAuthFailure('sign_out_failed'));
      } finally {
        _signOutFuture = null;
      }
    }());
    return completer.future;
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _epoch++;
    _identity = null;
    await _subscription.cancel();
    await _gateway.dispose();
    await _changes.close();
  }
}
