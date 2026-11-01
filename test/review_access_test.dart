import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/billing/http_purchase_verifier.dart';
import 'package:soul_reader/review_access.dart';

const _response = <String, dynamic>{
  'access': 'review', 'sessionDurationSeconds': 3600,
};
final _code = ''.padRight(43, 'A');

class _Transport implements BillingJsonTransport {
  final List<({Uri uri, String method, Map<String, String> headers,
      Map<String, dynamic>? body})> requests = [];
  Future<Map<String, dynamic>> Function()? respond;
  Map<String, dynamic> response = _response;

  @override
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body) {
    requests.add((uri: uri, method: method, headers: headers, body: body));
    return respond?.call() ?? Future.value(response);
  }
}

void main() {
  Matcher failure() => isA<ReviewAccessFailure>();

  test('credential request uses only the fixed endpoint and no account token', () async {
    final transport = _Transport();
    await ReviewAccessClient(transport: transport).authenticate(_code);
    final request = transport.requests.single;
    expect(request.uri.toString(), '$reviewAccessOrigin/v1/review-access');
    expect(request.method, 'POST');
    expect(request.headers, {HttpHeaders.acceptHeader: 'application/json'});
    expect(request.body, {'username': 'play-review', 'accessCode': _code});
    expect(request.headers.containsKey(HttpHeaders.authorizationHeader), false);
    expect(request.headers.containsKey(HttpHeaders.cookieHeader), false);
  });

  test('invalid configuration cannot send credentials', () async {
    for (final url in [
      'http://soul-reader-billing.jgw98541706.workers.dev',
      'https://another.example.test',
      'https://soul-reader-billing.jgw98541706.workers.dev.evil.test',
      'https://user:password@soul-reader-billing.jgw98541706.workers.dev',
      '$reviewAccessOrigin:444',
      '$reviewAccessOrigin/prefix',
      '$reviewAccessOrigin?token=example',
      '$reviewAccessOrigin#fragment',
      '',
    ]) {
      final transport = _Transport();
      final client = ReviewAccessClient(baseUrl: url, transport: transport);
      expect(client.isConfigured, false);
      await expectLater(client.authenticate(_code), throwsA(failure()));
      expect(transport.requests, isEmpty);
    }
    expect(ReviewAccessClient(baseUrl: '$reviewAccessOrigin/').isConfigured, true);
  });

  test('only a bounded base64url access code is submitted', () async {
    for (final code in ['', 'short', ''.padRight(42, 'A'),
        ''.padRight(44, 'A'), '${_code.substring(1)}=',
        '${_code.substring(1)}\n', '${_code.substring(1)} ']) {
      final transport = _Transport();
      await expectLater(ReviewAccessClient(transport: transport).authenticate(code),
        throwsA(failure()));
      expect(transport.requests, isEmpty);
    }
    final transport = _Transport();
    await ReviewAccessClient(transport: transport)
      .authenticate('${_code.substring(2)}_-');
    expect(transport.requests.length, 1);
  });

  test('response must be exactly an hour of review access without token fields', () async {
    for (final response in <Map<String, dynamic>>[
      {}, {'access': 'review'}, {..._response, 'access': 'billing'},
      {..._response, 'sessionDurationSeconds': '3600'},
      {..._response, 'sessionDurationSeconds': 3600.0},
      {..._response, 'sessionDurationSeconds': 0},
      {..._response, 'sessionDurationSeconds': 3599},
      {..._response, 'sessionDurationSeconds': 3601},
      {..._response, 'token': 'must never become a session token'},
      {..._response, 'entitlement': <String, dynamic>{}},
      {..._response, 'padding': ''.padRight(4097, 'x')},
    ]) {
      final transport = _Transport()..response = response;
      await expectLater(ReviewAccessClient(transport: transport).authenticate(_code),
        throwsA(failure()));
    }
  });

  test('wire response rejects errors, redirects, malformed JSON and excess bytes', () {
    expect(decodeReviewAccessResponse(200, utf8.encode(jsonEncode(_response))), _response);
    for (final status in [201, 301, 302, 400, 401, 403, 429, 500, 503]) {
      expect(() => decodeReviewAccessResponse(status, utf8.encode(jsonEncode(_response))),
        throwsA(failure()));
    }
    for (final bytes in <List<int>>[
      utf8.encode('[]'), utf8.encode('null'), utf8.encode('<html>outage</html>'),
      [255], List.filled(4097, 32),
    ]) {
      expect(() => decodeReviewAccessResponse(200, bytes), throwsA(failure()));
    }
  });

  test('transport exceptions reveal no credentials or server details', () async {
    final transport = _Transport()
      ..respond = () => Future.error(StateError('private provider response $_code'));
    try {
      await ReviewAccessClient(transport: transport).authenticate(_code);
      fail('Authentication should fail');
    } catch (error) {
      expect(error, failure());
      expect(error.toString(), 'ReviewAccessFailure');
      expect(error.toString(), isNot(contains(_code)));
      expect(error.toString(), isNot(contains('private provider')));
    }
  });

  test('session emits only active and expiration, expires exactly once, and is reusable', () async {
    var now = DateTime.utc(2026, 11, 1);
    final snapshots = <Map<String, dynamic>>[];
    final transport = _Transport();
    late ReviewAccessSession session;
    session = ReviewAccessSession(client: ReviewAccessClient(transport: transport),
      clock: () => now, elapsed: () => Duration.zero,
      onChanged: () => snapshots.add(session.snapshot));
    expect(session.snapshot, {'active': false, 'expiresAt': null});
    await session.open(_code, canActivate: () => true);
    expect(session.snapshot, {'active': true,
      'expiresAt': now.add(const Duration(hours: 1)).millisecondsSinceEpoch});
    expect(session.authenticating, false);
    await expectLater(session.open(_code, canActivate: () => true), throwsA(failure()));
    expect(transport.requests.length, 1);
    now = now.add(const Duration(minutes: 59, seconds: 59));
    session.expire();
    expect(session.active, true);
    now = now.add(const Duration(seconds: 1));
    session.expire();
    session.expire();
    expect(session.snapshot, {'active': false, 'expiresAt': null});
    expect(snapshots.length, 2);
    expect(snapshots.last, {'active': false, 'expiresAt': null});
    await session.open(_code, canActivate: () => true);
    expect(session.active, true);
    expect(transport.requests.length, 2);
    session.dispose();
  });

  test('busy billing is checked before sending and after HTTP completes', () async {
    final transport = _Transport();
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: transport));
    var canActivate = false;
    await expectLater(session.open(_code, canActivate: () => canActivate),
      throwsA(failure()));
    expect(transport.requests, isEmpty);
    canActivate = true;
    final response = Completer<Map<String, dynamic>>();
    transport.respond = () => response.future;
    final attempt = session.open(_code, canActivate: () => canActivate);
    final rejected = expectLater(attempt, throwsA(failure()));
    expect(session.authenticating, true);
    await expectLater(session.open(_code, canActivate: () => true), throwsA(failure()));
    canActivate = false;
    response.complete(_response);
    await rejected;
    expect(session.active, false);
    expect(session.authenticating, false);
    session.dispose();
  });

  test('exit, account/billing invalidation, resume, and dispose reject stale completion', () async {
    for (final invalidation in ['exit', 'account', 'billing', 'resume', 'dispose']) {
      final transport = _Transport();
      final response = Completer<Map<String, dynamic>>();
      transport.respond = () => response.future;
      var changes = 0;
      final session = ReviewAccessSession(client: ReviewAccessClient(transport: transport),
        onChanged: () => changes++);
      final attempt = session.open(_code, canActivate: () => true);
      final rejected = expectLater(attempt, throwsA(failure()));
      switch (invalidation) {
        case 'exit' || 'account' || 'billing': session.close();
        case 'resume': session.resume();
        case 'dispose': session.dispose();
      }
      response.complete(_response);
      await rejected;
      expect(session.active, false, reason: invalidation);
      expect(session.authenticating, false, reason: invalidation);
      expect(changes, 0, reason: invalidation);
      session.dispose();
    }
  });

  test('an old completion cannot replace a later successful review session', () async {
    var now = DateTime.utc(2026, 11, 1);
    final transport = _Transport();
    final oldResponse = Completer<Map<String, dynamic>>();
    transport.respond = () => oldResponse.future;
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: transport),
      clock: () => now, elapsed: () => Duration.zero);
    final oldAttempt = session.open(_code, canActivate: () => true);
    final rejected = expectLater(oldAttempt, throwsA(failure()));
    session.cancelPending();
    now = now.add(const Duration(minutes: 5));
    transport.respond = () async => _response;
    await session.open(_code, canActivate: () => true);
    final current = session.snapshot;
    oldResponse.complete(_response);
    await rejected;
    expect(session.snapshot, current);
    expect(session.authenticating, false);
    session.dispose();
  });

  test('resume preserves a valid session and clears an expired session permanently', () async {
    var now = DateTime.utc(2026, 11, 1);
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: _Transport()),
      clock: () => now, elapsed: () => Duration.zero);
    await session.open(_code, canActivate: () => true);
    now = now.add(const Duration(minutes: 30));
    session.resume();
    expect(session.active, true);
    now = now.add(const Duration(minutes: 30));
    session.resume();
    expect(session.active, false);
    now = now.subtract(const Duration(hours: 1));
    session.resume();
    expect(session.active, false);
    await session.open(_code, canActivate: () => true);
    session.expire(force: true);
    expect(session.active, false);
    session.dispose();
  });

  test('disposed session cannot make new requests or publish state', () async {
    final transport = _Transport();
    var changes = 0;
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: transport),
      onChanged: () => changes++);
    session.dispose();
    await expectLater(session.open(_code, canActivate: () => true), throwsA(failure()));
    session.close();
    session.resume();
    session.expire(force: true);
    expect(transport.requests, isEmpty);
    expect(changes, 0);
    expect(session.snapshot, {'active': false, 'expiresAt': null});
  });

  test('idle billing invalidation does not change the review generation', () {
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: _Transport()));
    final generation = session.generation;
    session.close();
    session.cancelPending();
    session.resume();
    expect(session.generation, generation);
    session.dispose();
  });

  test('backward wall clock and resume cannot extend the original elapsed hour', () async {
    var now = DateTime.utc(2026, 11, 1);
    var elapsed = Duration.zero;
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: _Transport()),
      clock: () => now, elapsed: () => elapsed);
    await session.open(_code, canActivate: () => true);
    expect(session.remaining, const Duration(hours: 1));
    elapsed = const Duration(minutes: 40);
    now = now.subtract(const Duration(hours: 3));
    session.resume();
    expect(session.active, true);
    expect(session.remaining, const Duration(minutes: 20));
    expect(session.snapshot, {'active': true,
      'expiresAt': now.add(const Duration(minutes: 20)).millisecondsSinceEpoch});
    elapsed = const Duration(minutes: 59, seconds: 59);
    session.resume();
    expect(session.remaining, const Duration(seconds: 1));
    elapsed = const Duration(hours: 1);
    session.resume();
    expect(session.snapshot, {'active': false, 'expiresAt': null});
    now = now.subtract(const Duration(days: 1));
    expect(session.active, false);
    expect(session.remaining, null);
    session.dispose();
  });

  test('forward wall clock expires immediately and rollback cannot revive access', () async {
    var now = DateTime.utc(2026, 11, 1);
    var elapsed = Duration.zero;
    final session = ReviewAccessSession(client: ReviewAccessClient(transport: _Transport()),
      clock: () => now, elapsed: () => elapsed);
    await session.open(_code, canActivate: () => true);
    now = now.add(const Duration(minutes: 50));
    elapsed = const Duration(minutes: 10);
    expect(session.remaining, const Duration(minutes: 10));
    now = now.add(const Duration(minutes: 10));
    expect(session.snapshot, {'active': false, 'expiresAt': null});
    now = now.subtract(const Duration(hours: 1));
    expect(session.active, false);
    expect(session.remaining, null);
    session.dispose();
  });
}
