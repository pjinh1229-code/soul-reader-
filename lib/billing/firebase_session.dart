import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'auth_session.dart';
import 'http_purchase_verifier.dart';

/// Public configuration only. No service-account key belongs in this app.
class FirebaseBillingOverrides {
  const FirebaseBillingOverrides({
    this.apiKey = '', this.appId = '', this.projectId = '',
    this.messagingSenderId = '', this.webClientId = '',
  });

  const FirebaseBillingOverrides.fromEnvironment()
      : apiKey = const String.fromEnvironment('FIREBASE_API_KEY'),
        appId = const String.fromEnvironment('FIREBASE_APP_ID'),
        projectId = const String.fromEnvironment('FIREBASE_PROJECT_ID'),
        messagingSenderId =
            const String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID'),
        webClientId = const String.fromEnvironment('GOOGLE_WEB_CLIENT_ID');

  final String apiKey;
  final String appId;
  final String projectId;
  final String messagingSenderId;
  final String webClientId;
}

class FirebaseBillingPublicConfig {
  const FirebaseBillingPublicConfig({
    required this.apiKey, required this.appId, required this.projectId,
    required this.messagingSenderId, required this.webClientId,
  });

  final String apiKey;
  final String appId;
  final String projectId;
  final String messagingSenderId;
  final String webClientId;

  bool get isValid {
    final app = RegExp(r'^1:([0-9]+):android:[a-fA-F0-9]+$').firstMatch(appId);
    final web = RegExp(r'^([0-9]+)-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$')
        .firstMatch(webClientId);
    return RegExp(r'^AIza[A-Za-z0-9_-]{35}$').hasMatch(apiKey) &&
        RegExp(r'^[a-z][a-z0-9-]{4,28}[a-z0-9]$').hasMatch(projectId) &&
        RegExp(r'^[0-9]{6,}$').hasMatch(messagingSenderId) &&
        app?.group(1) == messagingSenderId &&
        web?.group(1) == messagingSenderId;
  }

  FirebaseOptions get options => FirebaseOptions(
    apiKey: apiKey, appId: appId, projectId: projectId,
    messagingSenderId: messagingSenderId,
  );

  factory FirebaseBillingPublicConfig.fromGoogleServices(
    Map<String, dynamic> json, {
    String packageName = 'com.soulreader.soul_reader',
  }) {
    final project = json['project_info'];
    final clients = json['client'];
    if (project is! Map || clients is! List) {
      throw const BillingAuthFailure('configuration_required');
    }
    final matches = clients.whereType<Map>().where((client) {
      final info = client['client_info'];
      return info is Map && info['android_client_info'] is Map &&
          (info['android_client_info'] as Map)['package_name'] == packageName;
    }).toList();
    if (matches.length != 1) {
      throw const BillingAuthFailure('configuration_required');
    }
    final client = matches.single;
    final info = client['client_info'] as Map;
    final keys = client['api_key'];
    final apiKeys = keys is List
        ? keys.whereType<Map>().map((key) => key['current_key'])
            .whereType<String>().where((key) => key.isNotEmpty).toSet()
        : <String>{};
    if (apiKeys.length != 1) {
      throw const BillingAuthFailure('configuration_required');
    }
    Set<String> webIds(dynamic values) => values is List
        ? values.whereType<Map>()
            .where((entry) => entry['client_type'] == 3)
            .map((entry) => entry['client_id']).whereType<String>().toSet()
        : <String>{};
    var web = webIds(client['oauth_client']);
    if (web.isEmpty) {
      final services = client['services'];
      final invite = services is Map ? services['appinvite_service'] : null;
      web = webIds(invite is Map ? invite['other_platform_oauth_client'] : null);
    }
    final config = FirebaseBillingPublicConfig(
      apiKey: apiKeys.single,
      appId: info['mobilesdk_app_id'] is String
          ? info['mobilesdk_app_id'] as String : '',
      projectId: project['project_id'] is String
          ? project['project_id'] as String : '',
      messagingSenderId: project['project_number'] is String
          ? project['project_number'] as String : '',
      webClientId: web.length == 1 ? web.single : '',
    );
    // A missing Web OAuth client is expected before Google provider setup.
    // Return the public fields so a matching explicit Web ID can complete them.
    return config;
  }

  FirebaseBillingPublicConfig apply(FirebaseBillingOverrides overrides) {
    // A partial override must not quietly bind an asset to another project.
    for (final pair in [
      [projectId, overrides.projectId],
      [appId, overrides.appId],
      [messagingSenderId, overrides.messagingSenderId],
    ]) {
      if (pair[0].isNotEmpty && pair[1].isNotEmpty && pair[0] != pair[1]) {
        throw const BillingAuthFailure('configuration_required');
      }
    }
    String choose(String existing, String value) => value.isEmpty ? existing : value;
    return FirebaseBillingPublicConfig(
      apiKey: choose(apiKey, overrides.apiKey),
      appId: choose(appId, overrides.appId),
      projectId: choose(projectId, overrides.projectId),
      messagingSenderId: choose(messagingSenderId, overrides.messagingSenderId),
      webClientId: choose(webClientId, overrides.webClientId),
    );
  }
}

typedef BillingGatewayFactory = Future<BillingIdentityGateway> Function(
    FirebaseBillingPublicConfig config);

Future<BillingSessionProvider> createFirebaseBillingSession({
  required FirebaseBillingPublicConfig config,
  BillingGatewayFactory? gatewayFactory,
}) async {
  if (!config.isValid) return const MissingBillingSession();
  try {
    final gateway = await (gatewayFactory ?? _FirebaseIdentityGateway.create)(config);
    return ManagedBillingSession(gateway);
  } catch (_) {
    return const MissingBillingSession();
  }
}

Future<BillingSessionProvider> createConfiguredFirebaseBillingSession({
  FirebaseBillingOverrides overrides =
      const FirebaseBillingOverrides.fromEnvironment(),
  Future<String> Function(String path)? assetLoader,
  BillingGatewayFactory? gatewayFactory,
}) async {
  const empty = FirebaseBillingPublicConfig(
    apiKey: '', appId: '', projectId: '', messagingSenderId: '', webClientId: '');
  var config = empty;
  try {
    String? source;
    try {
      source = await (assetLoader ?? rootBundle.loadString)(
          'assets/firebase/google-services.json');
    } catch (_) {
      // Build-time public options may be used when no asset has been supplied.
    }
    if (source != null) {
      final json = jsonDecode(source);
      if (json is! Map<String, dynamic>) return const MissingBillingSession();
      config = FirebaseBillingPublicConfig.fromGoogleServices(json);
    }
    return await createFirebaseBillingSession(
      config: config.apply(overrides), gatewayFactory: gatewayFactory);
  } catch (_) {
    return const MissingBillingSession();
  }
}

class _FirebaseIdentityGateway implements BillingIdentityGateway {
  _FirebaseIdentityGateway(this._auth, this._projectId);

  final FirebaseAuth _auth;
  final String _projectId;
  static Future<void>? _googleInitialization;
  static String? _googleWebClientId;

  static Future<BillingIdentityGateway> create(
      FirebaseBillingPublicConfig config) async {
    if (_googleWebClientId != null && _googleWebClientId != config.webClientId) {
      throw const BillingAuthFailure('configuration_required');
    }
    _googleWebClientId = config.webClientId;
    _googleInitialization ??= GoogleSignIn.instance.initialize(
        serverClientId: config.webClientId);
    await _googleInitialization;
    const appName = 'soul-reader-billing';
    final existing = Firebase.apps.where((app) => app.name == appName);
    final app = existing.isEmpty
        ? await Firebase.initializeApp(name: appName, options: config.options)
        : existing.single;
    if (app.options.projectId != config.projectId ||
        app.options.appId != config.appId ||
        app.options.apiKey != config.apiKey) {
      throw const BillingAuthFailure('configuration_required');
    }
    return _FirebaseIdentityGateway(
        FirebaseAuth.instanceFor(app: app), config.projectId);
  }

  BillingIdentity? _identity(User? user) {
    if (user == null || user.isAnonymous ||
        !user.providerData.any((provider) => provider.providerId == 'google.com')) {
      return null;
    }
    final label = (user.displayName ?? user.email ?? 'Google')
        .replaceAll(RegExp(r'[\r\n\x00-\x1F]'), ' ').trim();
    return BillingIdentity(
      key: '$_projectId:${user.uid}',
      label: label.isEmpty ? 'Google' : label.substring(0, label.length > 80 ? 80 : label.length),
    );
  }

  @override
  BillingIdentity? get currentIdentity => _identity(_auth.currentUser);

  @override
  Stream<BillingIdentity?> get identityChanges =>
      _auth.authStateChanges().map(_identity);

  @override
  Future<BillingIdentity> signIn() async {
    try {
      final google = await GoogleSignIn.instance.authenticate();
      final token = google.authentication.idToken;
      if (token == null || token.isEmpty) {
        throw const BillingAuthFailure('authentication_failed');
      }
      final result = await _auth.signInWithCredential(
          GoogleAuthProvider.credential(idToken: token));
      final identity = _identity(result.user);
      if (identity == null) {
        throw const BillingAuthFailure('authentication_failed');
      }
      return identity;
    } on GoogleSignInException catch (error) {
      throw BillingAuthFailure(error.code == GoogleSignInExceptionCode.canceled
          ? 'sign_in_cancelled' : 'authentication_failed');
    } on FirebaseAuthException catch (error) {
      throw BillingAuthFailure(switch (error.code) {
        'network-request-failed' => 'authentication_unavailable',
        'operation-not-allowed' || 'invalid-api-key' || 'app-not-authorized' =>
          'configuration_required',
        _ => 'authentication_failed',
      });
    } on BillingAuthFailure {
      rethrow;
    } catch (_) {
      throw const BillingAuthFailure('authentication_failed');
    }
  }

  @override
  Future<String?> accessToken() async {
    final user = _auth.currentUser;
    if (_identity(user) == null) return null;
    // Firebase refreshes expired ID tokens. No Google chooser is involved.
    final token = await user!.getIdTokenResult();
    if (token.signInProvider != 'google.com') return null;
    return token.token;
  }

  @override
  Future<void> signOut() async {
    // Firebase sign-out is the authority; Google SDK sign-out clears chooser state.
    Object? failure;
    try { await _auth.signOut(); } catch (error) { failure = error; }
    try { await GoogleSignIn.instance.signOut(); } catch (error) { failure ??= error; }
    if (failure != null) throw const BillingAuthFailure('sign_out_failed');
  }

  @override
  Future<void> dispose() async {}
}
