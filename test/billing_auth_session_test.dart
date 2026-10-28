import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/billing/auth_session.dart';
import 'package:soul_reader/billing/firebase_session.dart';
import 'package:soul_reader/billing/http_purchase_verifier.dart';

const alice = BillingIdentity(key: 'project:alice', label: 'Alice');
const bob = BillingIdentity(key: 'project:bob', label: 'Bob');
const sender = '626760618280';
const webClient = '$sender-test.apps.googleusercontent.com';

Matcher authError(String code) => isA<BillingAuthFailure>()
    .having((failure) => failure.code, 'code', code);

class FakeGateway implements BillingIdentityGateway {
  FakeGateway([this.currentIdentity])
      : changes = StreamController<BillingIdentity?>.broadcast(sync: true);
  FakeGateway.asynchronous([this.currentIdentity])
      : changes = StreamController<BillingIdentity?>.broadcast();
  final StreamController<BillingIdentity?> changes;
  @override
  BillingIdentity? currentIdentity;
  Future<String?> tokenResult = Future.value('native-firebase-token');
  Future<BillingIdentity>? signInResult;
  Future<void>? signOutResult;
  int signInCalls = 0;
  int signOutCalls = 0;
  int tokenCalls = 0;
  bool disposed = false;

  @override
  Stream<BillingIdentity?> get identityChanges => changes.stream;
  void emit(BillingIdentity? identity) {
    currentIdentity = identity;
    if (!changes.isClosed) changes.add(identity);
  }
  void staleEvent(BillingIdentity? identity) => changes.add(identity);
  @override
  Future<BillingIdentity> signIn() async {
    signInCalls++;
    final identity = await (signInResult ?? Future.value(alice));
    emit(identity);
    return identity;
  }
  @override
  Future<void> signOut() async {
    signOutCalls++;
    await signOutResult;
    emit(null);
  }
  @override
  Future<String?> accessToken() {
    tokenCalls++;
    return tokenResult;
  }
  @override
  Future<void> dispose() async {
    disposed = true;
    await changes.close();
  }
}

Map<String, dynamic> services({bool oauth = true,
    String package = 'com.soulreader.soul_reader'}) => {
  'project_info': {'project_number': sender, 'project_id': 'soul-reader-a91f5'},
  'client': [{
    'client_info': {
      'mobilesdk_app_id': '1:$sender:android:96fe33243f4204847e401d',
      'android_client_info': {'package_name': package},
    },
    'api_key': [{'current_key': 'AIza${List.filled(35, 'a').join()}'}],
    'oauth_client': oauth ? [{'client_type': 3, 'client_id': webClient}] : [],
  }],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('native session', () {
    test('persisted identity and tokens never open a Google picker', () async {
      final gateway = FakeGateway(alice);
      final session = ManagedBillingSession(gateway);
      expect(session.isConfigured, isTrue);
      expect(session.currentIdentity?.key, alice.key);
      expect(await session.accessToken(), 'native-firebase-token');
      expect(await session.accessToken(), 'native-firebase-token');
      expect(gateway.signInCalls, 0);
      await session.dispose();
    });

    test('signed-out token requests stay silent', () async {
      final gateway = FakeGateway();
      final session = ManagedBillingSession(gateway);
      expect(await session.accessToken(), isNull);
      expect(gateway.tokenCalls, 0);
      expect(gateway.signInCalls, 0);
      await session.dispose();
    });

    test('explicit sign-in is coalesced and blocks conflicting sign-out', () async {
      final gateway = FakeGateway();
      final result = Completer<BillingIdentity>();
      gateway.signInResult = result.future;
      final session = ManagedBillingSession(gateway);
      final first = session.signIn();
      final second = session.signIn();
      expect(identical(first, second), isTrue);
      expect(gateway.signInCalls, 1);
      await expectLater(session.signOut(), throwsA(authError('authentication_busy')));
      expect(session.currentIdentity, isNull);
      result.complete(alice);
      expect((await first).key, alice.key);
      expect(session.currentIdentity?.key, alice.key);
      await session.dispose();
    });

    test('logout clears identity immediately and coalesces SDK work', () async {
      final gateway = FakeGateway(alice);
      final result = Completer<void>();
      gateway.signOutResult = result.future;
      final session = ManagedBillingSession(gateway);
      final first = session.signOut();
      final second = session.signOut();
      expect(identical(first, second), isTrue);
      expect(session.currentIdentity, isNull);
      expect(await session.accessToken(), isNull);
      await expectLater(session.signIn(), throwsA(authError('authentication_busy')));
      gateway.staleEvent(alice);
      expect(session.currentIdentity, isNull);
      result.complete();
      await first;
      expect(gateway.signOutCalls, 1);
      gateway.emit(alice);
      expect(session.currentIdentity, isNull);
      await session.signIn();
      expect(session.currentIdentity?.key, alice.key);
      await session.dispose();
    });

    test('failed logout cannot resurrect a cached Firebase user', () async {
      final gateway = FakeGateway(alice);
      gateway.signOutResult = Future.error(StateError('SDK private detail'));
      final session = ManagedBillingSession(gateway);
      await expectLater(session.signOut(), throwsA(authError('sign_out_failed')));
      gateway.emit(alice);
      expect(session.currentIdentity, isNull);
      expect(await session.accessToken(), isNull);
      await session.dispose();
    });

    test('late token after account change is discarded', () async {
      final gateway = FakeGateway(alice);
      final result = Completer<String?>();
      gateway.tokenResult = result.future;
      final session = ManagedBillingSession(gateway);
      final token = session.accessToken();
      gateway.emit(bob);
      result.complete('alice-token');
      expect(await token, isNull);
      expect(session.currentIdentity?.key, bob.key);
      await session.dispose();
    });

    test('A to B to A does not reuse an earlier token request', () async {
      final gateway = FakeGateway(alice);
      final result = Completer<String?>();
      gateway.tokenResult = result.future;
      final session = ManagedBillingSession(gateway);
      final token = session.accessToken();
      gateway.emit(bob);
      gateway.emit(alice);
      result.complete('earlier-token');
      expect(await token, isNull);
      await session.dispose();
    });

    test('queued intermediate account invalidates an in-flight token', () async {
      final gateway = FakeGateway.asynchronous(alice);
      final result = Completer<String?>();
      gateway.tokenResult = result.future;
      final session = ManagedBillingSession(gateway);
      final token = session.accessToken();
      gateway.emit(bob);
      gateway.emit(alice);
      await Future<void>.delayed(Duration.zero);
      expect(session.currentIdentity?.key, alice.key);
      result.complete('earlier-token');
      expect(await token, isNull);
      await session.dispose();
    });

    test('late token after logout is discarded', () async {
      final gateway = FakeGateway(alice);
      final result = Completer<String?>();
      gateway.tokenResult = result.future;
      final session = ManagedBillingSession(gateway);
      final token = session.accessToken();
      await session.signOut();
      result.complete('alice-token');
      expect(await token, isNull);
      await session.dispose();
    });

    test('stale queued SDK account event is ignored', () async {
      final gateway = FakeGateway(alice);
      final session = ManagedBillingSession(gateway);
      gateway.emit(bob);
      gateway.staleEvent(alice);
      expect(session.currentIdentity?.key, bob.key);
      await session.dispose();
    });

    test('cancelled sign-in stays signed out after a late SDK event', () async {
      final gateway = FakeGateway();
      gateway.signInResult = Future.error(
          const BillingAuthFailure('sign_in_cancelled'));
      final session = ManagedBillingSession(gateway);
      await expectLater(session.signIn(), throwsA(authError('sign_in_cancelled')));
      gateway.emit(alice);
      expect(session.currentIdentity, isNull);
      expect(await session.accessToken(), isNull);
      await session.dispose();
    });

    test('token SDK failures and header-injection strings are not returned', () async {
      final gateway = FakeGateway(alice);
      final session = ManagedBillingSession(gateway);
      gateway.tokenResult = Future.value('token\r\nX-Injected: value');
      expect(await session.accessToken(), isNull);
      gateway.tokenResult = Future.error(StateError('private SDK detail'));
      expect(await session.accessToken(), isNull);
      await session.dispose();
    });

    test('dispose fences token work and rejects future login', () async {
      final gateway = FakeGateway(alice);
      final result = Completer<String?>();
      gateway.tokenResult = result.future;
      final session = ManagedBillingSession(gateway);
      final token = session.accessToken();
      await session.dispose();
      result.complete('old-token');
      expect(await token, isNull);
      expect(session.isConfigured, isFalse);
      expect(gateway.disposed, isTrue);
      await expectLater(session.signIn(),
          throwsA(authError('authentication_unavailable')));
      await session.dispose();
    });

    test('dispose during sign-in never publishes the late identity', () async {
      final gateway = FakeGateway();
      final result = Completer<BillingIdentity>();
      gateway.signInResult = result.future;
      final session = ManagedBillingSession(gateway);
      final login = session.signIn();
      final expectation = expectLater(login,
          throwsA(authError('authentication_session_changed')));
      // Allow SDK completion without writing to its closed test stream.
      await session.dispose();
      gateway.currentIdentity = alice;
      result.complete(alice);
      await expectation;
      expect(session.currentIdentity, isNull);
    });
  });

  group('public Firebase configuration', () {
    test('bundled Firebase asset configures silent native authentication', () async {
      final gateway = FakeGateway();
      final received = <FirebaseBillingPublicConfig>[];
      final session = await createConfiguredFirebaseBillingSession(
        overrides: const FirebaseBillingOverrides(),
        gatewayFactory: (config) async {
          received.add(config);
          return gateway;
        },
      );
      addTearDown(() async {
        if (session is InteractiveBillingSession) await session.dispose();
      });

      expect(received, hasLength(1));
      final config = received.single;
      expect(config.isValid, isTrue);
      expect(config.projectId, 'soul-reader-a91f5');
      expect(config.messagingSenderId, sender);
      expect(config.appId, '1:$sender:android:96fe33243f4204847e401d');
      expect(config.webClientId,
          '$sender-k29si0jdamedfkqal0iapn98mr7et8kh.apps.googleusercontent.com');
      expect(session, isA<InteractiveBillingSession>());
      expect(session.isConfigured, isTrue);
      expect(gateway.signInCalls, 0);
      expect(gateway.tokenCalls, 0);
    });

    test('selects the exact Android package and valid Web client', () {
      final config = FirebaseBillingPublicConfig.fromGoogleServices(services());
      expect(config.isValid, isTrue);
      expect(config.projectId, 'soul-reader-a91f5');
      expect(config.webClientId, webClient);
    });

    test('missing OAuth keeps login unavailable without SDK initialization', () async {
      var calls = 0;
      final session = await createConfiguredFirebaseBillingSession(
        assetLoader: (_) async => jsonEncode(services(oauth: false)),
        gatewayFactory: (_) async { calls++; return FakeGateway(); },
        overrides: const FirebaseBillingOverrides(),
      );
      expect(session, isA<MissingBillingSession>());
      expect(calls, 0);
    });

    test('a matching explicit public Web client completes the asset', () async {
      var calls = 0;
      final session = await createConfiguredFirebaseBillingSession(
        assetLoader: (_) async => jsonEncode(services(oauth: false)),
        gatewayFactory: (_) async { calls++; return FakeGateway(); },
        overrides: const FirebaseBillingOverrides(webClientId: webClient),
      );
      expect(session.isConfigured, isTrue);
      expect(calls, 1);
      await (session as InteractiveBillingSession).dispose();
    });

    test('missing asset and incomplete overrides never initialize SDK', () async {
      var calls = 0;
      final session = await createConfiguredFirebaseBillingSession(
        assetLoader: (_) async => throw StateError('asset absent'),
        gatewayFactory: (_) async { calls++; return FakeGateway(); },
        overrides: const FirebaseBillingOverrides(),
      );
      expect(session.isConfigured, isFalse);
      expect(calls, 0);
    });

    test('wrong package, duplicate package, and malformed JSON fail closed', () async {
      final duplicate = services();
      (duplicate['client'] as List).add((duplicate['client'] as List).single);
      for (final source in [
        jsonEncode(services(package: 'com.other.app')),
        jsonEncode(duplicate), '{broken', '[]',
      ]) {
        var calls = 0;
        final session = await createConfiguredFirebaseBillingSession(
          assetLoader: (_) async => source,
          gatewayFactory: (_) async { calls++; return FakeGateway(); },
          overrides: const FirebaseBillingOverrides(),
        );
        expect(session.isConfigured, isFalse);
        expect(calls, 0);
      }
    });

    test('cross-project overrides and Web client numbers are rejected', () async {
      for (final override in [
        const FirebaseBillingOverrides(projectId: 'another-project'),
        const FirebaseBillingOverrides(messagingSenderId: '999999999999'),
        const FirebaseBillingOverrides(webClientId:
            '999999999999-test.apps.googleusercontent.com'),
      ]) {
        var calls = 0;
        final session = await createConfiguredFirebaseBillingSession(
          assetLoader: (_) async => jsonEncode(services()),
          gatewayFactory: (_) async { calls++; return FakeGateway(); },
          overrides: override,
        );
        expect(session.isConfigured, isFalse);
        expect(calls, 0);
      }
    });

    test('ambiguous Web clients are rejected', () {
      final json = services();
      final client = (json['client'] as List).single as Map;
      (client['oauth_client'] as List).add({
        'client_type': 3,
        'client_id': '$sender-other.apps.googleusercontent.com',
      });
      expect(FirebaseBillingPublicConfig.fromGoogleServices(json).isValid, isFalse);
    });

    test('appinvite fallback accepts only a Web OAuth client', () {
      final json = services(oauth: false);
      final client = (json['client'] as List).single as Map;
      client['services'] = {'appinvite_service': {
        'other_platform_oauth_client': [
          {'client_type': 1, 'client_id': 'android-client'},
          {'client_type': 3, 'client_id': webClient},
        ],
      }};
      expect(FirebaseBillingPublicConfig.fromGoogleServices(json).isValid, isTrue);
    });

    test('valid configuration still fails closed when native SDK fails', () async {
      final session = await createFirebaseBillingSession(
        config: FirebaseBillingPublicConfig.fromGoogleServices(services()),
        gatewayFactory: (_) async => throw StateError('private plugin message'),
      );
      expect(session.isConfigured, isFalse);
    });
  });
}
