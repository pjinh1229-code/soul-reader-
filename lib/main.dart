import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'face_measure.dart';
import 'review_access.dart';
import 'ads/free_reading_ads.dart';
import 'ads/google_mobile_ads_gateway.dart';
import 'billing/account_billing_lifecycle.dart';
import 'billing/auth_session.dart';
import 'billing/billing_controller.dart';
import 'billing/firebase_session.dart';
import 'billing/http_purchase_verifier.dart';
import 'billing/pending_journal.dart';
import 'billing/play_store_gateway.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final session = await createConfiguredFirebaseBillingSession();
  runApp(SoulReaderApp(billingSession: session));
}

class SoulReaderApp extends StatelessWidget {
  const SoulReaderApp({super.key, this.billingSession = const MissingBillingSession()});
  final BillingSessionProvider billingSession;
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'SOUL READER',
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: SoulReaderHome(billingSession: billingSession),
      );
}

class SoulReaderHome extends StatefulWidget {
  const SoulReaderHome({super.key, this.billingSession = const MissingBillingSession()});
  final BillingSessionProvider billingSession;
  @override
  State<SoulReaderHome> createState() => _SoulReaderHomeState();
}

class _SoulReaderHomeState extends State<SoulReaderHome> with WidgetsBindingObserver {
  late final WebViewController _web;
  final _picker = ImagePicker();
  bool _photoScreen = false;
  bool _consented = false;
  bool _busy = false;
  String? _message;
  late final AccountBillingLifecycle _accountBilling;
  int _billingEpoch = 0;
  final Map<String, FilePendingPurchaseJournal> _accountJournals = {};
  BillingController? _billing;
  HttpPurchaseVerifier? _purchaseVerifier;
  Future<void>? _billingInitialization;
  final Map<String, VerifiedGrant> _grants = {};
  final List<Map<String, dynamic>> _billingOutbox = [];
  Future<void> _billingJsQueue = Future<void>.value();
  Future<void> _billingCommandQueue = Future<void>.value();
  bool _webPageReady = false;
  bool _legalSupportOpen = false;
  late final ReviewAccessSession _reviewAccess;
  Timer? _reviewExpiryTimer;
  Future<void> _reviewJsQueue = Future<void>.value();
  bool _reviewDialogOpen = false;
  bool _applicationActive = true;
  bool _billingInitializing = false;
  int _billingCommandsPending = 0;
  late final FreeReadingAdsController _freeReadingAds;
  Future<void> _adsCommandQueue = Future<void>.value();
  Future<void> _adsJsQueue = Future<void>.value();
  int _adsCommandsPending = 0;
  int _adsPageEpoch = 0;
  String? _activeAdsRequestId;
  String? _activeAdsReadingId;
  int? _activeAdsPageEpoch;
  bool _activeAdsRequestCancelled = false;
  final List<({int epoch, Map<String, dynamic> payload})> _adsOutbox = [];
  Map<String, dynamic> _billingState = {
    'status': 'unconfigured', 'configured': false,
    'storeAvailable': false, 'busy': false, 'products': <Object>[],
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _reviewAccess = ReviewAccessSession(
      client: ReviewAccessClient(),
      onChanged: _onReviewAccessChanged,
    );
    _freeReadingAds = FreeReadingAdsController(
      config: FreeReadingAdsConfig.fromEnvironment(),
      gateway: GoogleMobileAdsGateway(),
      canPresent: () => _activeAdsRequestId != null &&
          !_activeAdsRequestCancelled &&
          _activeAdsPageEpoch == _adsPageEpoch && _canOpenFreeReadingAd,
      onChanged: () => unawaited(_emitFreeReadingAdsState()),
    );
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF16101F))
      ..addJavaScriptChannel('PhotoScreen', onMessageReceived: (msg) {
        if (!mounted) return;
        final info = jsonDecode(msg.message) as Map<String,dynamic>;
        final visible = info['show'] == true;
        final consent = info['consent'] == true;
        if (visible != _photoScreen || consent != _consented) {
          setState(() { _photoScreen = visible; _consented = consent; });
        }
      })
      ..addJavaScriptChannel('PhotoPicker', onMessageReceived: _onPhotoPicker)
      ..addJavaScriptChannel('FaceScan', onMessageReceived: _onFaceRequest)
      ..addJavaScriptChannel('StoreBilling', onMessageReceived: _onBillingMessage)
      ..addJavaScriptChannel('LegalSupport', onMessageReceived: _onLegalSupport)
      ..addJavaScriptChannel('ReviewAccess', onMessageReceived: _onReviewAccess)
      ..addJavaScriptChannel('FreeReadingAds', onMessageReceived: _onFreeReadingAds)
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) {
          _webPageReady = false;
          _adsPageEpoch++;
          _adsOutbox.clear();
        },
        onNavigationRequest: (request) {
          final uri = Uri.tryParse(request.url);
          final trusted = uri != null && uri.scheme == 'file' &&
              uri.path.endsWith('/assets/web/index.html');
          return trusted ? NavigationDecision.navigate : NavigationDecision.prevent;
        },
        onPageFinished: (_) async {
          if (!mounted) return;
          _webPageReady = true;
          final pending = List<Map<String, dynamic>>.from(_billingOutbox);
          _billingOutbox.clear();
          // Auth may have been coalesced after grants while the page loaded.
          // Negotiate current identity first, then replay this epoch only.
          _accountBilling.emitAuth();
          for (final payload in pending) {
            if (payload['type'] != 'auth') await _emitBilling(payload);
          }
          await _emitBilling({'type': 'state', ..._billingState});
          await _emitReviewAccess();
          await _emitFreeReadingAdsState();
          await _flushFreeReadingAds();
        },
      ));
    _accountBilling = AccountBillingLifecycle(
      session: widget.billingSession,
      onAuth: (payload) {
        if (_billingEpoch != payload['epoch'] || payload['busy'] == true) {
          _reviewAccess.close();
        }
        _billingEpoch = payload['epoch'] as int;
        unawaited(_emitBilling(payload));
      },
      onAccountChanged: _onBillingAccountChanged,
    );
    _accountBilling.start();
    _loadWebContent();
    // Recover a camera/gallery result on Android after a process restart.
    _restoreLostImage();
  }

  void _onBillingAccountChanged(AccountBillingScope scope) {
    _reviewAccess.close();
    final previous = _billing;
    _billing = null;
    _purchaseVerifier = null;
    if (previous != null) unawaited(previous.dispose());
    _grants.clear();
    _billingOutbox.removeWhere((payload) => payload['epoch'] != scope.epoch);
    _billingState = {'status': 'unconfigured', 'configured': false,
      'storeAvailable': false, 'busy': false, 'products': <Object>[]};
    unawaited(_emitBilling({'type': 'accountReset'}, epoch: scope.epoch));
    _billingInitializing = true;
    _billingInitialization = _initializeBilling(scope);
  }

  Future<void> _initializeBilling(AccountBillingScope scope) async {
    try {
      if (scope.identity == null) {
        await _emitBilling({'type': 'state', ..._billingState}, epoch: scope.epoch);
        return;
      }
      final directory = await getApplicationSupportDirectory();
      if (!mounted || !scope.isCurrent) return;
      final config = BillingConfig(offers: const [
        BillingOffer(key: 'single', productId: String.fromEnvironment(
          'BILLING_SINGLE_PRODUCT', defaultValue: 'soul_reading_single')),
        BillingOffer(key: 'bundle', productId: String.fromEnvironment(
          'BILLING_BUNDLE_PRODUCT', defaultValue: 'soul_reading_bundle')),
      ]);
      final verifier = HttpPurchaseVerifier(
        baseUrl: const String.fromEnvironment('BILLING_VERIFIER_URL'),
        packageName: const String.fromEnvironment('BILLING_PACKAGE_NAME',
          defaultValue: 'com.soulreader.soul_reader'),
        config: config,
        session: scope.guardSession(widget.billingSession),
      );
      _purchaseVerifier = verifier;
      // Hashing prevents a UID from entering filenames. Reusing each journal
      // preserves its write queue across A -> B -> A account switches.
      final accountHash = sha256.convert(utf8.encode(scope.identity!.key));
      final path = '${directory.path}/billing_pending_$accountHash.json';
      final journal = _accountJournals.putIfAbsent(path,
          () => FilePendingPurchaseJournal(File(path)));
      final controller = BillingController(
        config: config,
        store: scope.guardStore(PlayStoreGateway()),
        verifier: scope.guardVerifier(verifier),
        journal: scope.guardJournal(journal),
        onState: (snapshot) {
          if (!mounted || !scope.isCurrent) return;
          final status = switch (snapshot['status']) {
            'configuration_required' => 'unconfigured',
            'initializing' => 'loading',
            'store_unavailable' || 'products_unavailable' => 'unavailable',
            final other => other,
          };
          _billingState = {...snapshot, 'status': status};
          if (snapshot['busy'] == true || snapshot['status'] == 'pending' ||
              _billing?.canChangeAccount == false) {
            _reviewAccess.close();
          }
          unawaited(_emitBilling({'type': 'state', ..._billingState}, epoch: scope.epoch));
        },
        onEntitlements: (grants) async {
          scope.ensureCurrent();
          _grants
            ..clear()
            ..addEntries(grants.map((grant) => MapEntry(grant.entitlementId, grant)));
          await _emitBilling({'type': 'entitlements',
            'entitlements': grants.map((grant) => grant.toJson()).toList()}, epoch: scope.epoch);
          scope.ensureCurrent();
        },
        onGrant: (grant) async {
          scope.ensureCurrent();
          _grants[grant.entitlementId] = grant;
          await _emitBilling({'type': 'grant', 'entitlement': grant.toJson()}, epoch: scope.epoch);
          scope.ensureCurrent();
        },
      );
      _billing = controller;
      await controller.initialize();
      if (!scope.isCurrent || !mounted) return;
      if (controller.isConfigured && !_reviewAccess.active) await controller.restore();
    } catch (_) {
      if (!scope.isCurrent || !mounted) return;
      _billingState = {'status': 'error', 'configured': false,
        'storeAvailable': false, 'busy': false, 'products': <Object>[],
        'errorCode': 'billing_initialization_failed'};
      await _emitBilling({'type': 'state', ..._billingState}, epoch: scope.epoch);
    } finally {
      if (scope.isCurrent) _billingInitializing = false;
    }
  }

  Future<void> _emitBilling(Map<String, dynamic> payload, {int? epoch}) {
    final expectedEpoch = epoch ?? (payload['epoch'] as int?) ?? _billingEpoch;
    if (!mounted || expectedEpoch != _billingEpoch) return Future<void>.value();
    final tagged = {...payload, 'epoch': expectedEpoch};
    if (!_webPageReady) {
      if (payload['type'] == 'state' || payload['type'] == 'auth') {
        _billingOutbox.removeWhere((value) => value['type'] == payload['type']);
      }
      _billingOutbox.add(tagged);
      return Future<void>.value();
    }
    final next = _billingJsQueue.then((_) async {
      if (!mounted || expectedEpoch != _billingEpoch) return;
      await _web.runJavaScript(
        'if(window.soulBillingReceive)window.soulBillingReceive(${jsonEncode(tagged)});');
    });
    _billingJsQueue = next.catchError((Object _) {});
    return _billingJsQueue;
  }

  void _onBillingMessage(JavaScriptMessage message) {
    if (!mounted) return;
    _reviewAccess.expire();
    final receivedEpoch = _billingEpoch;
    final receivedDuringReview = _reviewAccess.active;
    _reviewAccess.cancelPending();
    final reviewGeneration = _reviewAccess.generation;
    // Reserve even queued work: buy() has its own asynchronous initialization.
    _billingCommandsPending++;
    _billingCommandQueue = _billingCommandQueue
        .then((_) => _handleBillingMessage(message, receivedEpoch,
          reviewGeneration, receivedDuringReview))
        .whenComplete(() { _billingCommandsPending--; })
        .catchError((Object _) {});
  }

  Future<void> _handleBillingMessage(JavaScriptMessage message, int receivedEpoch,
      int reviewGeneration, bool receivedDuringReview) async {
    String? requestId;
    final commandEpoch = receivedEpoch;
    try {
      if (!mounted) return;
      if (message.message.length > 4096) throw const BillingFailure('invalid_request');
      final request = jsonDecode(message.message) as Map<String, dynamic>;
      requestId = request['requestId'] as String?;
      if (commandEpoch != _billingEpoch ||
          (request['epoch'] != null && request['epoch'] != _billingEpoch)) return;
      final statusOnly = request['action'] == 'status';
      void requireBillingAccess() {
        if (_adsCommandsPending > 0) {
          throw const BillingFailure('purchase_busy');
        }
        if (receivedDuringReview || _reviewAccess.active ||
            reviewGeneration != _reviewAccess.generation) {
          throw const BillingFailure('review_mode_active');
        }
      }
      // Check before waiting for initialization and again at each side effect.
      if (!statusOnly) requireBillingAccess();
      if (request['action'] == 'signIn' || request['action'] == 'signOut') {
        if (_billing?.canChangeAccount == false) {
          throw const BillingFailure('purchase_busy');
        }
        requireBillingAccess();
        if (request['action'] == 'signIn') {
          await _accountBilling.signIn();
        } else {
          await _accountBilling.signOut();
        }
        return;
      }
      if (request['action'] == 'status') {
        _accountBilling.emitAuth();
      }
      await _billingInitialization;
      if (!mounted || commandEpoch != _billingEpoch) return;
      final scope = _accountBilling.scope;
      final controller = _billing;
      if (statusOnly && _reviewAccess.active) {
        await _emitBilling({'type': 'state', ..._billingState});
        await _emitBilling({'type': 'entitlements',
          'entitlements': _grants.values.map((grant) => grant.toJson()).toList()});
        await _emitReviewAccess();
        return;
      }
      if (statusOnly && _adsCommandsPending > 0) {
        await _emitBilling({'type': 'state', ..._billingState});
        return;
      }
      if (!statusOnly) requireBillingAccess();
      if (request['action'] == 'status' && controller == null) {
        await _emitBilling({'type': 'state', ..._billingState});
        return;
      }
      if (scope?.identity == null) throw const BillingFailure('authentication_required');
      if (controller == null) throw const BillingFailure('configuration_required');
      switch (request['action']) {
        case 'status':
          if (!receivedDuringReview && reviewGeneration == _reviewAccess.generation &&
              !_reviewAccess.active && controller.isConfigured && controller.canChangeAccount) {
            await controller.restore();
          }
          await _emitBilling({'type': 'state', ..._billingState}, epoch: commandEpoch);
          if (controller.canChangeAccount) {
            await _emitBilling({'type': 'entitlements',
              'entitlements': _grants.values.map((grant) => grant.toJson()).toList()}, epoch: commandEpoch);
          }
          break;
        case 'buy':
          final offer = request['offerKey'];
          final reading = request['readingId'];
          if (offer is! String || reading is! String || requestId == null) {
            throw const BillingFailure('invalid_purchase_context');
          }
          requireBillingAccess();
          await controller.buy(offer, requestId: requestId, readingId: reading);
          break;
        case 'restore':
          requireBillingAccess();
          await controller.restore();
          break;
        case 'selectTopic':
          final id = request['entitlementId'];
          final topic = request['topic'];
          final grant = _grants[id];
          if (grant == null || topic is! String || request['readingId'] != grant.readingId) {
            throw const BillingFailure('invalid_entitlement');
          }
          requireBillingAccess();
          final selected = await scope!.guard(() => _purchaseVerifier!.selectTopic(grant, topic));
          _grants[selected.entitlementId] = selected;
          await _emitBilling({'type': 'grant', 'entitlement': selected.toJson()}, epoch: commandEpoch);
          break;
        default:
          throw const BillingFailure('invalid_request');
      }
    } catch (error) {
      // Auth can advance the epoch before reporting a safe picker error.
      final authError = error is BillingAuthFailure;
      await _emitBilling({'type': 'error', 'requestId': requestId,
        'code': error is BillingAuthFailure ? error.code : error is BillingFailure ? error.code : 'billing_request_failed'},
        epoch: authError ? _billingEpoch : commandEpoch);
    }
  }

  bool get _canActivateReview => mounted && _applicationActive &&
      _adsCommandsPending == 0 &&
      !_billingInitializing && _billingCommandsPending == 0 &&
      !_accountBilling.busy && _billing?.canChangeAccount != false &&
      _billingState['busy'] != true &&
      !const ['pending', 'recovery_required'].contains(_billingState['status']);

  void _onReviewAccessChanged() {
    _scheduleReviewExpiry();
    unawaited(_emitReviewAccess());
  }

  void _scheduleReviewExpiry() {
    _reviewExpiryTimer?.cancel();
    _reviewExpiryTimer = null;
    final remaining = _reviewAccess.remaining;
    if (remaining != null) {
      _reviewExpiryTimer = Timer(remaining, () {
        if (mounted) _reviewAccess.expire(force: true);
      });
    }
  }

  Future<void> _emitReviewAccess() {
    if (!mounted || !_webPageReady) return Future<void>.value();
    final next = _reviewJsQueue.then((_) async {
      if (!mounted || !_webPageReady) return;
      // Read current state at delivery time; queued events cannot revive it.
      final payload = _reviewAccess.snapshot;
      await _web.runJavaScript(
        'if(window.soulReviewAccessReceive)window.soulReviewAccessReceive(${jsonEncode(payload)});');
    });
    _reviewJsQueue = next.catchError((Object _) {});
    return _reviewJsQueue;
  }

  Future<void> _onReviewAccess(JavaScriptMessage message) async {
    if (!mounted) return;
    _reviewAccess.expire();
    // Credentials, identities, and URLs are never accepted from the page.
    switch (message.message) {
      case 'exit':
        _reviewAccess.close();
        await _emitReviewAccess();
        return;
      case 'status':
        await _emitReviewAccess();
        return;
      case 'open':
        if (_reviewDialogOpen || _reviewAccess.active || !_applicationActive ||
            _adsCommandsPending > 0) {
          await _emitReviewAccess();
          return;
        }
        break;
      default:
        return;
    }
    _reviewDialogOpen = true;
    try {
      var language = 'ko';
      try {
        final raw = await _web.runJavaScriptReturningResult('document.documentElement.lang');
        final value = raw is String && raw.startsWith('"') ? jsonDecode(raw) : raw;
        if (value == 'en' || value == 'ja') language = value as String;
      } catch (_) {}
      if (!mounted || !_applicationActive) return;
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => _ReviewAccessDialog(
          language: language,
          onAuthenticate: (accessCode) => _reviewAccess.open(accessCode,
            canActivate: () => _canActivateReview),
          onClosed: _reviewAccess.cancelPending,
        ),
      );
    } finally {
      _reviewAccess.cancelPending();
      _reviewDialogOpen = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _applicationActive = state == AppLifecycleState.resumed;
    _freeReadingAds.setForeground(_applicationActive);
    if (_applicationActive) {
      _reviewAccess.resume();
      _scheduleReviewExpiry();
      unawaited(_emitReviewAccess());
      unawaited(_flushFreeReadingAds());
    } else {
      // An HTTP response received after backgrounding requires a new attempt.
      _reviewAccess.cancelPending();
    }
  }

  bool get _canOpenFreeReadingAd => mounted && _applicationActive &&
      _webPageReady && !_reviewAccess.active && !_reviewDialogOpen &&
      !_reviewAccess.authenticating && !_busy && !_legalSupportOpen &&
      !_billingInitializing && _billingCommandsPending == 0 &&
      !_accountBilling.busy && _billing?.canChangeAccount != false &&
      _billingState['busy'] != true &&
      !const ['pending', 'recovery_required'].contains(_billingState['status']);

  void _onFreeReadingAds(JavaScriptMessage message) {
    if (!mounted || message.message.length > 4096) return;
    try {
      final request = jsonDecode(message.message);
      if (request is Map<String, dynamic> && request['action'] == 'cancel') {
        if (request['requestId'] == _activeAdsRequestId &&
            request['readingId'] == _activeAdsReadingId) {
          _activeAdsRequestCancelled = true;
        }
        return;
      }
    } catch (_) {
      return;
    }
    final pageEpoch = _adsPageEpoch;
    _adsCommandsPending++;
    _adsCommandQueue = _adsCommandQueue
        .then((_) => _handleFreeReadingAds(message.message, pageEpoch))
        .whenComplete(() { _adsCommandsPending--; })
        .catchError((Object _) {});
  }

  Future<void> _handleFreeReadingAds(String raw, int pageEpoch) async {
    String? requestId;
    var readingId = '';
    var status = 'skipped';
    var reason = 'unavailable';
    try {
      final request = jsonDecode(raw);
      if (request is! Map<String, dynamic>) return;
      final token = request['requestId'];
      final reading = request['readingId'];
      if (token is! String || token.isEmpty || token.length > 160 ||
          !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(token) ||
          reading is! String || reading.length > 128 ||
          !RegExp(r'^[A-Za-z0-9_-]*$').hasMatch(reading)) return;
      requestId = token;
      readingId = reading;
      _activeAdsRequestId = requestId;
      _activeAdsReadingId = readingId;
      _activeAdsPageEpoch = pageEpoch;
      _activeAdsRequestCancelled = false;
      if (pageEpoch != _adsPageEpoch || !_canOpenFreeReadingAd) return;
      switch (request['action']) {
        case 'show':
          if (readingId.isEmpty || _grants.values.any((grant) =>
              grant.isValid && grant.readingId == readingId)) return;
          final result = await _freeReadingAds.showForReading(readingId);
          status = result == FreeReadingAdResult.dismissed ? 'completed' : 'skipped';
          reason = result.name;
          break;
        case 'privacy':
          await _freeReadingAds.showPrivacyOptions();
          status = 'completed';
          reason = 'privacy';
          break;
        default:
          reason = 'invalid_request';
      }
    } catch (_) {
      // Advertising cannot make an otherwise free reading inaccessible.
      reason = 'unavailable';
    } finally {
      _activeAdsRequestId = null;
      _activeAdsReadingId = null;
      _activeAdsPageEpoch = null;
      _activeAdsRequestCancelled = false;
      if (requestId != null && mounted && pageEpoch == _adsPageEpoch) {
        _adsOutbox.add((epoch: pageEpoch, payload: {
          'requestId': requestId, 'readingId': readingId,
          'status': status, 'reason': reason,
        }));
        await _flushFreeReadingAds();
      }
    }
  }

  Future<void> _emitFreeReadingAdsState() async {
    if (!mounted || !_webPageReady) return;
    try {
      final state = {
        'enabled': _freeReadingAds.available,
        'privacyOptionsRequired': _freeReadingAds.privacyOptionsRequired,
      };
      await _web.runJavaScript(
        'if(window.SRFreeReadingAds)window.SRFreeReadingAds.setState(${jsonEncode(state)});');
    } catch (_) {
      // A page reload will request the current state after loading again.
    }
  }

  Future<void> _flushFreeReadingAds() {
    final next = _adsJsQueue.then((_) async {
      if (!mounted || !_webPageReady || !_applicationActive) return;
      final pending = List.of(_adsOutbox);
      _adsOutbox.clear();
      for (final response in pending) {
        if (response.epoch != _adsPageEpoch) continue;
        try {
          await _web.runJavaScript(
            'if(window.SRFreeReadingAds)window.SRFreeReadingAds.receive(${jsonEncode(response.payload)});');
        } catch (_) {
          // Only this page/request can use the callback; never replay on reload.
        }
      }
    });
    _adsJsQueue = next.catchError((Object _) {});
    return _adsJsQueue;
  }

  Future<void> _onLegalSupport(JavaScriptMessage message) async {
    // The page sends only an action. Never launch a URL supplied by JavaScript.
    final url = switch (message.message) {
      'privacy' => 'https://soul-reader-billing.jgw98541706.workers.dev/privacy',
      'deleteAccount' => 'https://soul-reader-billing.jgw98541706.workers.dev/delete-account',
      _ => null,
    };
    if (!mounted || url == null || _legalSupportOpen) return;
    _legalSupportOpen = true;
    try {
      try {
        if (await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication)) return;
      } catch (_) {
        // A missing browser must still leave the public address accessible.
      }
      if (!mounted) return;
      var language = 'ko';
      try {
        final raw = await _web.runJavaScriptReturningResult('document.documentElement.lang');
        final value = raw is String && raw.startsWith('"') ? jsonDecode(raw) : raw;
        if (value == 'en' || value == 'ja') language = value as String;
      } catch (_) {}
      if (!mounted) return;
      final labels = switch (language) {
        'en' => (
          title: 'Open in browser',
          help: 'The browser could not open. Copy this address and open it in your browser.',
          copy: 'Copy link', copied: 'Link copied', close: 'Close',
        ),
        'ja' => (
          title: 'ブラウザで開く',
          help: 'ブラウザを開けませんでした。このアドレスをコピーして、ブラウザで開いてください。',
          copy: 'リンクをコピー', copied: 'コピーしました', close: '閉じる',
        ),
        _ => (
          title: '브라우저에서 열기',
          help: '브라우저를 열지 못했어요. 아래 주소를 복사해 브라우저에서 열어 주세요.',
          copy: '링크 복사', copied: '복사했어요', close: '닫기',
        ),
      };
      var copied = false;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, updateDialog) => AlertDialog(
            title: Text(labels.title),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(labels.help),
                const SizedBox(height: 16),
                SelectableText(url),
              ],
            ),
            actions: [
              TextButton.icon(
                icon: Icon(copied ? Icons.check : Icons.copy),
                label: Text(copied ? labels.copied : labels.copy),
                onPressed: () async {
                  try {
                    await Clipboard.setData(ClipboardData(text: url));
                    if (context.mounted) updateDialog(() => copied = true);
                  } catch (_) {
                    // The selectable address also supports the system copy menu.
                  }
                },
              ),
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: Text(labels.close),
              ),
            ],
          ),
        ),
      );
    } finally {
      _legalSupportOpen = false;
    }
  }

  Future<void> _loadWebContent() async {
    if (Platform.isAndroid && _web.platform is AndroidWebViewController) {
      final android = _web.platform as AndroidWebViewController;
      await android.setMediaPlaybackRequiresUserGesture(false);
    }
    if (!mounted) return;
    await _web.loadFlutterAsset('assets/web/index.html');
  }

  Future<void> _restoreLostImage() async {
    final response = await _picker.retrieveLostData();
    if (!response.isEmpty && response.files != null && response.files!.isNotEmpty) {
      // The page might still be starting; user can reselect if necessary.
      await Future<void>.delayed(const Duration(seconds: 2));
      await _deliverPhoto(response.files!.first);
    }
  }

  // Converts image through the device decoder, fixing camera EXIF orientation
  // and ensuring the browser and ML Kit examine the *same pixels*.
  Future<Uint8List> _normalizedPng(Uint8List original) async {
    final codec = await ui.instantiateImageCodec(original, targetWidth: 960);
    final frame = await codec.getNextFrame();
    final bytes = await frame.image.toByteData(format: ui.ImageByteFormat.png);
    frame.image.dispose();
    codec.dispose();
    if (bytes == null) throw StateError('이미지를 열 수 없어.');
    return bytes.buffer.asUint8List();
  }

  void _onPhotoPicker(JavaScriptMessage message) {
    if (!mounted || !_photoScreen || !_consented || _busy) return;
    try {
      final data = jsonDecode(message.message) as Map<String, dynamic>;
      switch (data['source']) {
        case 'camera':
          _pick(ImageSource.camera);
          break;
        case 'gallery':
          _pick(ImageSource.gallery);
          break;
      }
    } catch (_) {
      setState(() => _message = '사진 선택 요청을 읽지 못했어. 다시 눌러 줘.');
    }
  }

  Future<void> _pick(ImageSource source) async {
    if (!mounted || !_photoScreen || !_consented || _busy) return;
    setState(() { _busy = true; _message = null; });
    try {
      final photo = await _picker.pickImage(source: source,
          maxWidth: 1600, maxHeight: 1600, imageQuality: 86,
          requestFullMetadata: false);
      if (photo != null) await _deliverPhoto(photo);
    } catch (e) {
      if (mounted) setState(() => _message = '사진을 열지 못했어: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deliverPhoto(XFile photo) async {
    final png = await _normalizedPng(await photo.readAsBytes());
    final dataUrl = 'data:image/png;base64,${base64Encode(png)}';
    await _web.runJavaScript('window.soulNativePhoto(${jsonEncode(dataUrl)});');
  }

  Future<void> _onFaceRequest(JavaScriptMessage message) async {
    String requestId = '';
    try {
      final data = jsonDecode(message.message) as Map<String, dynamic>;
      requestId = data['requestId']?.toString() ?? '';
      final dataUrl = data['dataUrl'] as String;
      if (!dataUrl.startsWith('data:image/') || !dataUrl.contains(';base64,')) {
        throw StateError('IMAGE_FORMAT');
      }
      final raw = base64Decode(dataUrl.split(';base64,').last);
      if (raw.length > 12 * 1024 * 1024) throw StateError('IMAGE_TOO_LARGE');
      final temp = await getTemporaryDirectory();
      final path = File('${temp.path}/soul_face_scan_${DateTime.now().microsecondsSinceEpoch}.png');
      try {
        await path.writeAsBytes(raw, flush: true);
        final result = await FaceMeasure.process(path.path);
        await _sendResult(requestId, result);
      } finally {
        if (await path.exists()) await path.delete();
      }
    } catch (e) {
      await _sendResult(requestId, {'ok': false, 'error': e.toString()});
    }
  }

  Future<void> _sendResult(String id, Map<String, dynamic> result) async {
    if (!mounted || id.isEmpty) return;
    try {
      await _web.runJavaScript(
        'window.soulMlKitReceive(${jsonEncode(id)},${jsonEncode(result)});',
      );
    } catch (_) { /* Page might have been closed. */ }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _reviewExpiryTimer?.cancel();
    _reviewAccess.dispose();
    _freeReadingAds.dispose();
    final billing = _billing;
    if (billing != null) unawaited(billing.dispose());
    unawaited(_accountBilling.dispose());
    FaceMeasure.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: const Color(0xFF160F21),
        body: SafeArea(
          child: Column(children: [
            Expanded(child: WebViewWidget(controller: _web)),
            if (_photoScreen)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                color: const Color(0xFF261B31),
                child: Row(children: [
                  Expanded(child: FilledButton.icon(
                    onPressed: (_busy || !_consented) ? null : () => _pick(ImageSource.camera),
                    icon: const Icon(Icons.camera_alt_outlined),
                    label: const Text('사진 촬영'),
                  )),
                  const SizedBox(width: 10),
                  Expanded(child: OutlinedButton.icon(
                    onPressed: (_busy || !_consented) ? null : () => _pick(ImageSource.gallery),
                    icon: const Icon(Icons.photo_library_outlined),
                    label: const Text('갤러리'),
                  )),
                ]),
              ),
            if (_busy) const LinearProgressIndicator(minHeight: 3),
            if (_message != null)
              Padding(padding: const EdgeInsets.all(8), child: Text(_message!,
                  style: const TextStyle(color: Color(0xFFFFC6C6)))),
          ]),
        ),
      );
}

class _ReviewAccessDialog extends StatefulWidget {
  const _ReviewAccessDialog({required this.language,
    required this.onAuthenticate, required this.onClosed});

  final String language;
  final Future<void> Function(String accessCode) onAuthenticate;
  final VoidCallback onClosed;

  @override
  State<_ReviewAccessDialog> createState() => _ReviewAccessDialogState();
}

class _ReviewAccessDialogState extends State<_ReviewAccessDialog> {
  final _accessCode = TextEditingController();
  bool _submitting = false;
  bool _failed = false;
  bool _closed = false;

  void _close() {
    if (_closed) return;
    _closed = true;
    _accessCode.clear();
    widget.onClosed();
  }

  ({String title, String username, String code, String help, String submit,
      String cancel, String failure}) get _labels => switch (widget.language) {
    'en' => (
      title: 'Review access', username: 'Username', code: 'Access code',
      help: 'Enter the review credentials. Access lasts for one hour and does not make a purchase.',
      submit: 'Continue', cancel: 'Cancel',
      failure: 'Unable to open review access. Check the credentials and try again when billing is idle.',
    ),
    'ja' => (
      title: '審査用アクセス', username: 'ユーザー名', code: 'アクセスコード',
      help: '審査用の認証情報を入力してください。有効期間は1時間で、購入は行われません。',
      submit: '続ける', cancel: 'キャンセル',
      failure: '審査用アクセスを開始できません。認証情報を確認し、購入処理の終了後にもう一度お試しください。',
    ),
    _ => (
      title: '검토용 접근', username: '사용자 이름', code: '접근 코드',
      help: '검토용 인증 정보를 입력해 주세요. 접근은 1시간 동안 유지되며 구매가 발생하지 않아요.',
      submit: '계속', cancel: '취소',
      failure: '검토용 접근을 시작하지 못했어요. 인증 정보를 확인하고 결제 처리가 끝난 뒤 다시 시도해 주세요.',
    ),
  };

  Future<void> _submit() async {
    if (_submitting || _closed) return;
    setState(() { _submitting = true; _failed = false; });
    try {
      final operation = widget.onAuthenticate(_accessCode.text);
      _accessCode.clear();
      await operation;
      if (mounted && !_closed) Navigator.of(context).pop();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) {
        _accessCode.clear();
        setState(() => _submitting = false);
      }
    }
  }

  @override
  void dispose() {
    _close();
    _accessCode.clear();
    _accessCode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final labels = _labels;
    return PopScope(
      onPopInvokedWithResult: (didPop, _) { if (didPop) _close(); },
      child: AlertDialog(
      title: Text(labels.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(labels.help),
            const SizedBox(height: 16),
            TextFormField(
              initialValue: reviewAccessUsername,
              readOnly: true,
              decoration: InputDecoration(labelText: labels.username),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _accessCode,
              autofocus: true,
              enabled: !_submitting,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              enableIMEPersonalizedLearning: false,
              autofillHints: const [],
              maxLength: 43,
              textInputAction: TextInputAction.done,
              decoration: InputDecoration(labelText: labels.code, counterText: ''),
              onSubmitted: (_) => _submit(),
            ),
            if (_failed) ...[
              const SizedBox(height: 12),
              Text(labels.failure, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
            if (_submitting) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () { _close(); Navigator.of(context).pop(); },
          child: Text(labels.cancel),
        ),
        FilledButton(
          onPressed: _submitting ? null : _submit,
          child: Text(labels.submit),
        ),
      ],
      ),
    );
  }
}
