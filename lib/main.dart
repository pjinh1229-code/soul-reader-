import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'face_measure.dart';
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

class _SoulReaderHomeState extends State<SoulReaderHome> {
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
  Map<String, dynamic> _billingState = {
    'status': 'unconfigured', 'configured': false,
    'storeAvailable': false, 'busy': false, 'products': <Object>[],
  };

  @override
  void initState() {
    super.initState();
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
      ..setNavigationDelegate(NavigationDelegate(
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
        },
      ));
    _accountBilling = AccountBillingLifecycle(
      session: widget.billingSession,
      onAuth: (payload) {
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
    final previous = _billing;
    _billing = null;
    _purchaseVerifier = null;
    if (previous != null) unawaited(previous.dispose());
    _grants.clear();
    _billingOutbox.removeWhere((payload) => payload['epoch'] != scope.epoch);
    _billingState = {'status': 'unconfigured', 'configured': false,
      'storeAvailable': false, 'busy': false, 'products': <Object>[]};
    unawaited(_emitBilling({'type': 'accountReset'}, epoch: scope.epoch));
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
      if (controller.isConfigured) await controller.restore();
    } catch (_) {
      if (!scope.isCurrent || !mounted) return;
      _billingState = {'status': 'error', 'configured': false,
        'storeAvailable': false, 'busy': false, 'products': <Object>[],
        'errorCode': 'billing_initialization_failed'};
      await _emitBilling({'type': 'state', ..._billingState}, epoch: scope.epoch);
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
    final receivedEpoch = _billingEpoch;
    _billingCommandQueue = _billingCommandQueue
        .then((_) => _handleBillingMessage(message, receivedEpoch))
        .catchError((Object _) {});
  }

  Future<void> _handleBillingMessage(JavaScriptMessage message, int receivedEpoch) async {
    String? requestId;
    final commandEpoch = receivedEpoch;
    try {
      if (message.message.length > 4096) throw const BillingFailure('invalid_request');
      final request = jsonDecode(message.message) as Map<String, dynamic>;
      requestId = request['requestId'] as String?;
      if (commandEpoch != _billingEpoch ||
          (request['epoch'] != null && request['epoch'] != _billingEpoch)) return;
      if (request['action'] == 'signIn' || request['action'] == 'signOut') {
        if (_billing?.canChangeAccount == false) {
          throw const BillingFailure('purchase_busy');
        }
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
      if (request['action'] == 'status' && controller == null) {
        await _emitBilling({'type': 'state', ..._billingState});
        return;
      }
      if (scope?.identity == null) throw const BillingFailure('authentication_required');
      if (controller == null) throw const BillingFailure('configuration_required');
      switch (request['action']) {
        case 'status':
          if (controller.isConfigured && controller.canChangeAccount) {
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
          await controller.buy(offer, requestId: requestId, readingId: reading);
          break;
        case 'restore':
          await controller.restore();
          break;
        case 'selectTopic':
          final id = request['entitlementId'];
          final topic = request['topic'];
          final grant = _grants[id];
          if (grant == null || topic is! String || request['readingId'] != grant.readingId) {
            throw const BillingFailure('invalid_entitlement');
          }
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
