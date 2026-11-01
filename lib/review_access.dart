import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'billing/http_purchase_verifier.dart';

/// Review access never produces a billing token, receipt, or persisted grant.
class ReviewAccessFailure implements Exception {
  const ReviewAccessFailure();

  @override
  String toString() => 'ReviewAccessFailure';
}

const reviewAccessOrigin = 'https://soul-reader-billing.jgw98541706.workers.dev';
const reviewAccessUsername = 'play-review';
const reviewAccessDuration = Duration(hours: 1);
const _maximumResponseBytes = 4096;

/// Reject arbitrary fields, server messages, tokens, and non-hour sessions.
Map<String, dynamic> decodeReviewAccessResponse(int status, List<int> bytes) {
  if (bytes.length > _maximumResponseBytes || status != HttpStatus.ok) {
    throw const ReviewAccessFailure();
  }
  try {
    final value = jsonDecode(utf8.decode(bytes));
    if (value is Map<String, dynamic> && value.length == 2 &&
        value['access'] == 'review' &&
        value['sessionDurationSeconds'] is int &&
        value['sessionDurationSeconds'] == reviewAccessDuration.inSeconds) {
      return value;
    }
  } catch (_) {
    // A fixed failure also covers malformed JSON and non-UTF-8 responses.
  }
  throw const ReviewAccessFailure();
}

/// This transport has no cookie jar or authenticated billing-session provider.
class IoReviewAccessTransport implements BillingJsonTransport {
  @override
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 15);
    final deadline = Timer(const Duration(seconds: 25), () => client.close(force: true));
    try {
      final request = await client.openUrl(method, uri)
          .timeout(const Duration(seconds: 15));
      request.followRedirects = false;
      headers.forEach(request.headers.set);
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
      final response = await request.close()
          .timeout(const Duration(seconds: 15));
      final bytes = BytesBuilder();
      await for (final chunk in response.timeout(const Duration(seconds: 15))) {
        if (bytes.length + chunk.length > _maximumResponseBytes) {
          throw const ReviewAccessFailure();
        }
        bytes.add(chunk);
      }
      return decodeReviewAccessResponse(response.statusCode, bytes.takeBytes());
    } catch (_) {
      // Never expose request credentials, response bodies, or raw exceptions.
      throw const ReviewAccessFailure();
    } finally {
      deadline.cancel();
      client.close(force: true);
    }
  }
}

class ReviewAccessClient {
  ReviewAccessClient({String baseUrl = reviewAccessOrigin,
      BillingJsonTransport? transport})
      : _base = Uri.tryParse(baseUrl),
        _transport = transport ?? IoReviewAccessTransport();

  final Uri? _base;
  final BillingJsonTransport _transport;

  bool get isConfigured {
    final base = _base;
    return base != null && base.scheme == 'https' &&
        base.host == 'soul-reader-billing.jgw98541706.workers.dev' &&
        base.port == 443 && base.userInfo.isEmpty &&
        (base.path.isEmpty || base.path == '/') &&
        !base.hasQuery && !base.hasFragment;
  }

  Future<void> authenticate(String accessCode) async {
    if (!isConfigured || !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(accessCode)) {
      throw const ReviewAccessFailure();
    }
    try {
      final value = await _transport.send(
        _base!.replace(path: '/v1/review-access'), 'POST',
        {HttpHeaders.acceptHeader: 'application/json'},
        {'username': reviewAccessUsername, 'accessCode': accessCode},
      ).timeout(const Duration(seconds: 30));
      // Validate injected transports just as strictly as the wire response.
      decodeReviewAccessResponse(HttpStatus.ok, utf8.encode(jsonEncode(value)));
    } catch (_) {
      throw const ReviewAccessFailure();
    }
  }
}

/// A process-local session. Invalidation makes every older HTTP result inert.
/// The owner schedules expiry and calls resume when the app returns foreground.
class ReviewAccessSession {
  ReviewAccessSession({required this.client, DateTime Function()? clock,
      Duration Function()? elapsed, this.onChanged})
      : _clock = clock ?? DateTime.now,
        _elapsed = elapsed ?? _elapsedClock();

  static Duration Function() _elapsedClock() {
    final stopwatch = Stopwatch()..start();
    return () => stopwatch.elapsed;
  }

  final ReviewAccessClient client;
  final DateTime Function() _clock;
  final Duration Function() _elapsed;
  final void Function()? onChanged;
  DateTime? _expiresAt;
  Duration? _expiresElapsed;
  int _generation = 0;
  bool _disposed = false;
  bool _authenticating = false;

  int get generation => _generation;
  bool get authenticating => _authenticating;
  bool get active {
    expire();
    return !_disposed && _expiresAt != null;
  }
  DateTime? get expiresAt {
    if (!active) return null;
    // Project the elapsed deadline onto the current wall clock for the page.
    final elapsedDeadline = _clock().add(_expiresElapsed! - _elapsed());
    return elapsedDeadline.isBefore(_expiresAt!) ? elapsedDeadline : _expiresAt;
  }
  Duration? get remaining {
    if (!active) return null;
    final wall = _expiresAt!.difference(_clock());
    final monotonic = _expiresElapsed! - _elapsed();
    return wall < monotonic ? wall : monotonic;
  }
  Map<String, dynamic> get snapshot {
    final until = expiresAt;
    return {'active': until != null, 'expiresAt': until?.millisecondsSinceEpoch};
  }

  Future<void> open(String accessCode, {required bool Function() canActivate}) async {
    expire();
    if (_disposed || active || _authenticating || !canActivate()) {
      throw const ReviewAccessFailure();
    }
    final generation = ++_generation;
    _authenticating = true;
    try {
      await client.authenticate(accessCode);
      if (_disposed || generation != _generation || !canActivate()) {
        throw const ReviewAccessFailure();
      }
      _expiresAt = _clock().add(reviewAccessDuration);
      _expiresElapsed = _elapsed() + reviewAccessDuration;
      onChanged?.call();
    } finally {
      if (generation == _generation) _authenticating = false;
    }
  }

  void cancelPending() {
    if (_disposed || !_authenticating) return;
    _generation++;
    _authenticating = false;
  }

  void close() {
    if (_disposed || (!_authenticating && _expiresAt == null)) return;
    _generation++;
    _authenticating = false;
    final hadSession = _expiresAt != null;
    _expiresAt = null;
    _expiresElapsed = null;
    if (hadSession) onChanged?.call();
  }

  void expire({bool force = false}) {
    if (_expiresAt != null && (force || !_clock().isBefore(_expiresAt!) ||
        _elapsed() >= _expiresElapsed!)) close();
  }

  void resume() {
    cancelPending();
    expire();
  }

  void dispose() {
    _generation++;
    _disposed = true;
    _authenticating = false;
    _expiresAt = null;
    _expiresElapsed = null;
  }
}
