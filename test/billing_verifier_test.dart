import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/billing/billing_controller.dart';
import 'package:soul_reader/billing/http_purchase_verifier.dart';
import 'package:soul_reader/billing/pending_journal.dart';

class _Session implements BillingSessionProvider {
  @override
  bool get isConfigured => true;
  @override
  Future<String?> accessToken() async => 'test-session';
}

class _Transport implements BillingJsonTransport {
  Map<String, dynamic> response = {};
  final List<Object> responses = [];
  final List<Uri> uris = [];
  int calls = 0;
  @override
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body) async {
    calls++;
    uris.add(uri);
    expect(uri.scheme, 'https');
    expect(headers[HttpHeaders.authorizationHeader], 'Bearer test-session');
    if (responses.isEmpty) return response;
    final next = responses.removeAt(0);
    if (next is BillingFailure) throw next;
    return next as Map<String, dynamic>;
  }
}

void main() {
  final config = BillingConfig(offers: const [
    BillingOffer(key: 'single', productId: 'reading.single'),
    BillingOffer(key: 'bundle', productId: 'reading.bundle'),
  ]);
  const context = PurchaseContext(offerKey: 'single',
    productId: 'reading.single', requestId: 'request-1', readingId: 'photo-1');
  const grantJson = {
    'status': 'active', 'entitlementId': 'pass-1', 'transactionId': 'order-1',
    'productId': 'reading.single', 'offerKey': 'single',
    'requestId': 'request-1', 'readingId': 'photo-1', 'topic': null,
  };
  PurchaseVerificationRequest receipt() => PurchaseVerificationRequest(
    purchase: const StorePurchase(productId: 'reading.single',
      state: StorePurchaseState.purchased, verificationData: 'test-receipt'),
    offer: config.offers.first, context: context);
  HttpPurchaseVerifier verifier(_Transport transport, {
    String url = 'https://billing.example.test', BillingSessionProvider? session,
  }) => HttpPurchaseVerifier(baseUrl: url, packageName: 'com.soulreader.soul_reader',
    config: config, session: session ?? _Session(), transport: transport);

  test('missing account and insecure endpoints cannot submit receipts', () async {
    for (final url in ['http://billing.example.test',
        'https://user:password@billing.example.test',
        'https://billing.example.test?token=example']) {
      final transport = _Transport();
      final v = verifier(transport, url: url);
      expect(v.isConfigured, false);
      await expectLater(v.verify(receipt()), throwsA(isA<BillingFailure>()));
      expect(transport.calls, 0);
    }
    final transport = _Transport();
    final v = verifier(transport, session: const MissingBillingSession());
    expect(v.isConfigured, false);
    await expectLater(v.restoreEntitlements(), throwsA(isA<BillingFailure>()));
    expect(transport.calls, 0);
  });

  test('HTTP success without an active, matching ledger grant is rejected', () async {
    final transport = _Transport();
    final v = verifier(transport);
    for (final bad in [
      {...grantJson, 'status': 'pending'},
      {...grantJson, 'readingId': 'another-photo'},
      {...grantJson, 'productId': 'reading.bundle'},
      {...grantJson, 'topic': 'arbitrary-topic'},
    ]) {
      transport.response = {'entitlement': bad};
      await expectLater(v.verify(receipt()), throwsA(isA<BillingFailure>()));
    }
    transport.response = {'entitlement': grantJson};
    expect((await v.verify(receipt())).readingId, 'photo-1');
  });

  test('topic binding cannot switch ownership or a previously locked topic', () async {
    final transport = _Transport();
    final v = verifier(transport);
    final grant = VerifiedGrant.fromJson(grantJson);
    transport.response = {'entitlement': {...grantJson,
      'readingId': 'another-photo', 'topic': 'love'}};
    await expectLater(v.selectTopic(grant, 'love'), throwsA(isA<BillingFailure>()));
    transport.response = {'entitlement': {...grantJson, 'topic': 'love'}};
    final locked = await v.selectTopic(grant, 'love');
    final before = transport.calls;
    await expectLater(v.selectTopic(locked, 'work'), throwsA(isA<BillingFailure>()));
    expect(transport.calls, before);
  });

  Map<String, dynamic> grant(int index) => {...grantJson,
    'entitlementId': 'pass-$index', 'transactionId': 'order-$index',
    'requestId': 'request-$index', 'readingId': 'photo-$index'};
  Matcher failure(String code) => isA<BillingFailure>()
    .having((error) => error.code, 'code', code);

  test('restore combines complete pages with opaque cursor and same revision', () async {
    final transport = _Transport()..responses.addAll([
      {'entitlements': [grant(1)], 'nextCursor': 'payload.signature', 'revision': 8},
      {'entitlements': [grant(2)], 'nextCursor': null, 'revision': 8},
    ]);
    final restored = await verifier(transport,
      url: 'https://billing.example.test/base/').restoreEntitlements();
    expect(restored.map((entry) => entry.entitlementId), ['pass-1', 'pass-2']);
    expect(transport.uris.first.path, '/base/v1/billing/entitlements');
    expect(transport.uris.first.hasQuery, false);
    expect(transport.uris.last.queryParameters, {'cursor': 'payload.signature'});
  });

  test('legacy restore accepts one complete response without pagination fields', () async {
    final transport = _Transport()..response = {'entitlements': [grant(1)]};
    expect((await verifier(transport).restoreEntitlements()).length, 1);
    expect(transport.calls, 1);
  });

  test('restore rejects malformed pagination and mixed snapshot revisions', () async {
    for (final bad in <Map<String, dynamic>>[
      {'entitlements': [], 'nextCursor': null},
      {'entitlements': [], 'revision': 1},
      {'entitlements': [], 'nextCursor': null, 'revision': -1},
      {'entitlements': [], 'nextCursor': null, 'revision': '1'},
      {'entitlements': [], 'nextCursor': null, 'revision': 1.0},
      {'entitlements': [], 'nextCursor': null, 'revision': 9007199254740992},
      {'entitlements': [grant(1)], 'nextCursor': '', 'revision': 1},
      {'entitlements': [grant(1)], 'nextCursor': 'unsafe?cursor', 'revision': 1},
      {'entitlements': [grant(1)], 'nextCursor': ''.padRight(2049, 'x'), 'revision': 1},
      {'entitlements': [grant(1)], 'nextCursor': 1, 'revision': 1},
      {'entitlements': [], 'nextCursor': 'empty-page', 'revision': 1},
      {'entitlements': List.generate(21, (index) => grant(index)),
        'nextCursor': null, 'revision': 1},
    ]) {
      final transport = _Transport()..response = bad;
      await expectLater(verifier(transport).restoreEntitlements(),
        throwsA(failure('invalid_server_response')));
      expect(transport.calls, 1);
    }
    for (final second in <Map<String, dynamic>>[
      {'entitlements': [grant(2)], 'nextCursor': null, 'revision': 2},
      {'entitlements': [grant(2)]},
    ]) {
      final transport = _Transport()..responses.addAll([
        {'entitlements': [grant(1)], 'nextCursor': 'page-2', 'revision': 1},
        second,
      ]);
      await expectLater(verifier(transport).restoreEntitlements(),
        throwsA(failure('invalid_server_response')));
      expect(transport.calls, 2);
    }
  });

  test('restore rejects repeated cursors and duplicate ledger identities', () async {
    final cursorLoop = _Transport()..responses.addAll([
      {'entitlements': [grant(1)], 'nextCursor': 'loop', 'revision': 1},
      {'entitlements': [grant(2)], 'nextCursor': 'loop', 'revision': 1},
    ]);
    await expectLater(verifier(cursorLoop).restoreEntitlements(),
      throwsA(failure('invalid_server_response')));
    expect(cursorLoop.calls, 2);
    for (final duplicate in <Map<String, dynamic>>[
      {...grant(2), 'entitlementId': 'pass-1'},
      {...grant(2), 'transactionId': 'order-1'},
    ]) {
      final transport = _Transport()..responses.addAll([
        {'entitlements': [grant(1)], 'nextCursor': 'page-2', 'revision': 1},
        {'entitlements': [duplicate], 'nextCursor': null, 'revision': 1},
      ]);
      await expectLater(verifier(transport).restoreEntitlements(),
        throwsA(failure('invalid_server_response')));
    }
  });

  test('ledger change discards partial grants and restarts only whole snapshot', () async {
    final transport = _Transport()..responses.addAll([
      {'entitlements': [grant(1)], 'nextCursor': 'old-cursor', 'revision': 1},
      const BillingFailure('ledger_changed'),
      {'entitlements': [grant(2)], 'nextCursor': null, 'revision': 2},
    ]);
    final restored = await verifier(transport).restoreEntitlements();
    expect(restored.map((entry) => entry.entitlementId), ['pass-2']);
    expect(transport.uris.map((uri) => uri.queryParameters),
      [{}, {'cursor': 'old-cursor'}, {}]);
  });

  test('ledger retries are bounded and other errors never retry', () async {
    final transport = _Transport()..responses.addAll([
      const BillingFailure('ledger_changed'),
      const BillingFailure('ledger_changed'),
      const BillingFailure('ledger_changed'),
    ]);
    await expectLater(verifier(transport).restoreEntitlements(),
      throwsA(failure('ledger_changed')));
    expect(transport.calls, 3);
    for (final code in ['authentication_required', 'purchase_context_mismatch',
        'billing_connection_failed', 'invalid_server_response']) {
      final rejected = _Transport()..responses.add(BillingFailure(code));
      await expectLater(verifier(rejected).restoreEntitlements(),
        throwsA(failure(code)));
      expect(rejected.calls, 1);
    }
  });

  test('HTTP decoder keeps only fixed codes appropriate for the status', () {
    for (final entry in <int, String>{
      409: 'ledger_changed', 403: 'purchase_context_mismatch',
      401: 'authentication_required', 429: 'billing_rate_limited',
      503: 'play_unavailable',
    }.entries) {
      expect(() => decodeBillingJsonResponse(entry.key,
        utf8.encode(jsonEncode({'error': {'code': entry.value,
          'message': 'secret receipt must not escape'}}))),
        throwsA(failure(entry.value)));
    }
    for (final body in ['<html>private provider outage</html>',
      '{"error":{"code":"private receipt value"}}',
      '{"error":{"code":"ledger_changed"}}']) {
      expect(() => decodeBillingJsonResponse(500, utf8.encode(body)),
        throwsA(failure('billing_server_rejected')));
    }
    expect(() => decodeBillingJsonResponse(403,
      utf8.encode('{"error":{"code":"ledger_changed"}}')),
      throwsA(failure('authentication_required')));
    expect(() => decodeBillingJsonResponse(409, utf8.encode('{}')),
      throwsA(failure('billing_server_rejected')));
  });

  test('HTTP decoder bounds and validates success and error bodies equally', () {
    expect(decodeBillingJsonResponse(200, utf8.encode('{"entitlements":[]}')),
      {'entitlements': []});
    for (final status in [200, 503]) {
      expect(() => decodeBillingJsonResponse(status,
        List<int>.filled(512 * 1024 + 1, 32)),
        throwsA(failure('invalid_server_response')));
    }
    for (final bytes in [utf8.encode('[]'), utf8.encode('not json'), [255]]) {
      expect(() => decodeBillingJsonResponse(200, bytes),
        throwsA(failure('invalid_server_response')));
    }
  });

  test('pending contexts survive reopening and sequential writes without receipts', () async {
    final directory = await Directory.systemTemp.createTemp('soul-billing-test-');
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/pending.json');
    final journal = FilePendingPurchaseJournal(file);
    await journal.put(context);
    final reopened = FilePendingPurchaseJournal(file);
    expect((await reopened.load()).single.readingId, 'photo-1');
    expect(await file.readAsString(), isNot(contains('test-receipt')));
    await Future.wait([reopened.remove('reading.single'), reopened.put(context)]);
    expect((await reopened.load()).single.requestId, 'request-1');
  });
}
