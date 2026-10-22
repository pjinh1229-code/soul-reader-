import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'face_measure.dart';

void main() => runApp(const SoulReaderApp());

class SoulReaderApp extends StatelessWidget {
  const SoulReaderApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'SOUL READER',
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: const SoulReaderHome(),
      );
}

class SoulReaderHome extends StatefulWidget {
  const SoulReaderHome({super.key});
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
      ..addJavaScriptChannel('FaceScan', onMessageReceived: _onFaceRequest);
    _loadWebContent();
    // Recover a camera/gallery result on Android after a process restart.
    _restoreLostImage();
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
