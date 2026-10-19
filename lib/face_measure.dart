import 'dart:math' as math;

import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';

/// Converts observable facial contour measurements to coarse visual categories.
/// These are *not* scientific measurements of personality, health or fate.
class FaceMeasure {
  static final FaceDetector _detector = FaceDetector(
    options: FaceDetectorOptions(
      enableContours: true,
      enableLandmarks: true,
      performanceMode: FaceDetectorMode.accurate,
    ),
  );

  static double _clampRatio(double value) => value.isFinite ? value.clamp(0.0, 4.0) : 0.0;

  static int _tier(double v, double lower, double upper) => v < lower ? 0 : (v > upper ? 2 : 1);

  static double _spanX(FaceContour? contour) {
    final points = contour?.points;
    if (points == null || points.isEmpty) return 0;
    final xs = points.map((p) => p.x.toDouble()).toList();
    return xs.reduce(math.max) - xs.reduce(math.min);
  }

  static double _spanY(FaceContour? contour) {
    final points = contour?.points;
    if (points == null || points.isEmpty) return 0;
    final ys = points.map((p) => p.y.toDouble()).toList();
    return ys.reduce(math.max) - ys.reduce(math.min);
  }

  static double _avgY(FaceContour? contour) {
    final points = contour?.points;
    if (points == null || points.isEmpty) return double.nan;
    return points.map((p) => p.y).reduce((a, b) => a + b) / points.length;
  }

  static double _widestAtY(FaceContour contour, double y, double band) {
    final nearby = contour.points.where((p) => (p.y - y).abs() < band).toList();
    if (nearby.length < 2) return 0;
    final xs = nearby.map((p) => p.x.toDouble()).toList();
    return xs.reduce(math.max) - xs.reduce(math.min);
  }

  static Future<Map<String, dynamic>> process(String path) async {
    final faces = await _detector.processImage(InputImage.fromFilePath(path));
    if (faces.isEmpty) throw StateError('NO_FACE: 정면 얼굴을 찾지 못했어.');
    if (faces.length != 1) throw StateError('MULTIPLE_FACES: 한 사람만 나오게 촬영해 줘.');
    final f = faces.single;
    final r = f.boundingBox;
    if (r.width < 85 || r.height < 110) {
      throw StateError('FACE_TOO_SMALL: 얼굴이 작게 나왔어.');
    }
    if ((f.headEulerAngleY ?? 0).abs() > 19 ||
        (f.headEulerAngleZ ?? 0).abs() > 15 ||
        (f.headEulerAngleX ?? 0).abs() > 19) {
      throw StateError('FACE_ANGLE: 정면을 바라보도록 다시 촬영해 줘.');
    }

    FaceContour? c(FaceContourType type) => f.contours[type];
    final leftEye = c(FaceContourType.leftEye);
    final rightEye = c(FaceContourType.rightEye);
    final face = c(FaceContourType.face);
    final lips = c(FaceContourType.upperLipTop);
    final nose = c(FaceContourType.noseBridge);
    final noseBottom = c(FaceContourType.noseBottom);
    final browLeft = c(FaceContourType.leftEyebrowTop);
    final browRight = c(FaceContourType.rightEyebrowTop);
    if (face == null || face.points.length < 12 ||
        leftEye == null || leftEye.points.length < 5 ||
        rightEye == null || rightEye.points.length < 5 ||
        nose == null || nose.points.length < 3 ||
        lips == null || lips.points.length < 5 ||
        browLeft == null || browRight == null ||
        noseBottom == null || noseBottom.points.length < 3) {
      throw StateError('CONTOUR_MISSING: 눈·코·입이 충분히 선명하지 않아.');
    }
    final w = r.width.toDouble();
    final h = r.height.toDouble();
    final eyeHeight = (_spanY(leftEye) + _spanY(rightEye)) / 2;
    final eyeWidth = (_spanX(leftEye) + _spanX(rightEye)) / 2;
    final eyeRatio = _clampRatio(eyeHeight / math.max(eyeWidth, 1));
    final browsY = (_avgY(browLeft) + _avgY(browRight)) / 2;
    final browRatio = _clampRatio((browsY - r.top) / h);
    final noseRatio = _clampRatio((_avgY(noseBottom) - _avgY(nose)) / h);
    final mouthRatio = _clampRatio(_spanX(lips) / w);
    final jawWidth = _widestAtY(face, r.top + h * 0.77, h * 0.055);
    if (jawWidth == 0) {
      throw StateError('JAW_CONTOUR_MISSING: 하관 윤곽을 찾지 못했어.');
    }
    final jawRatio = _clampRatio(jawWidth / w);
    final aspect = _clampRatio(w / h);

    final metrics = <String, dynamic>{
      'upper': browRatio,
      'eye': eyeRatio,
      'nose': noseRatio,
      'mouth': mouthRatio,
      'jaw': jawRatio,
      'aspect': aspect,
      'roll': (f.headEulerAngleZ ?? 0).abs(),
      'yaw': (f.headEulerAngleY ?? 0).abs(),
      'faceW': w,
      'faceH': h,
      'measurementSource': 'native_mlkit_face_contours',
    };
    // Thresholds are *provisional visual bins*, not validated population norms.
    final features = <String, int>{
      'brow': _tier(browRatio, .24, .35),
      'eyes': _tier(eyeRatio, .21, .34),
      'nose': _tier(noseRatio, .15, .28),
      'smile': _tier(mouthRatio, .31, .46),
      'jaw': _tier(jawRatio, .58, .75),
      'aura': _tier(aspect, .72, .84),
    };
    return {'ok': true, 'face': features, 'metrics': metrics};
  }

  static Future<void> close() => _detector.close();
}
