import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/face_measure.dart';

// Native ML Kit channel-format fixture. This exercises plugin deserialization
// and app validation; it does not replace a real-device detector test.
Map<String, dynamic> detectedFace() => {
  'rect': {'left': 50.0, 'top': 50.0, 'right': 250.0, 'bottom': 350.0},
  'headEulerAngleX': 0.0,
  'headEulerAngleY': 0.0,
  'headEulerAngleZ': 0.0,
  'landmarks': <String, dynamic>{},
  'contours': {
    'face': List.generate(36, (i) => [
      (150 + 100 * math.cos(i * math.pi / 18)).round(),
      (200 + 150 * math.sin(i * math.pi / 18)).round(),
    ]),
    'leftEye': [[90, 150], [100, 145], [110, 150], [100, 155], [95, 153]],
    'rightEye': [[190, 150], [200, 145], [210, 150], [200, 155], [195, 153]],
    // ML Kit NOSE_BRIDGE has TWO points, unlike NOSE_BOTTOM's three.
    'noseBridge': [[150, 160], [150, 190]],
    'noseBottom': [[135, 210], [150, 215], [165, 210]],
    'upperLipTop': [[115, 250], [130, 245], [150, 248], [170, 245], [185, 250]],
    'leftEyebrowTop': [[90, 125], [100, 120], [110, 125]],
    'rightEyebrowTop': [[190, 125], [200, 120], [210, 125]],
  },
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('google_mlkit_face_detector');
  late List<Map<String, dynamic>> nativeFaces;
  setUp(() {
    nativeFaces = [detectedFace()];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'vision#startFaceDetector') {
        final options = (call.arguments as Map)['options'] as Map;
        expect(options['enableContours'], isTrue);
        expect(options['mode'], 'accurate');
        return nativeFaces;
      }
      return null;
    });
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('accepts a detected face with a two-point ML Kit nose bridge', () async {
    final result = await FaceMeasure.process('/test-photo.png');
    expect(result['ok'], isTrue);
    final metrics = result['metrics'] as Map;
    expect(metrics['measurementSource'], 'native_mlkit_face_contours');
    expect(metrics['nose'], closeTo((211.6666666667 - 175) / 300, 0.00001));
    expect(metrics['jaw'], greaterThan(0));
    expect((result['face'] as Map).keys,
        containsAll(['brow', 'eyes', 'nose', 'smile', 'jaw', 'aura']));
  });

  test('still rejects an incomplete nose contour', () async {
    (nativeFaces.single['contours'] as Map)['noseBridge'] = [[150, 160]];
    await expectLater(FaceMeasure.process('/test-photo.png'),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('CONTOUR_MISSING'))));
  });

  test('does not create results when no face was detected', () async {
    nativeFaces = [];
    await expectLater(FaceMeasure.process('/test-photo.png'),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('NO_FACE'))));
  });

  test('rejects multiple faces', () async {
    nativeFaces.add(detectedFace());
    await expectLater(FaceMeasure.process('/test-photo.png'),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('MULTIPLE_FACES'))));
  });

  test('rejects an angled face', () async {
    nativeFaces.single['headEulerAngleY'] = 30.0;
    await expectLater(FaceMeasure.process('/test-photo.png'),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('FACE_ANGLE'))));
  });

  test('rejects a face too small to measure', () async {
    nativeFaces.single['rect'] = {'left': 0.0, 'top': 0.0, 'right': 30.0, 'bottom': 40.0};
    await expectLater(FaceMeasure.process('/test-photo.png'),
        throwsA(isA<StateError>().having((e) => e.message, 'message', contains('FACE_TOO_SMALL'))));
  });
}
