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
  int calls = 0;
  @override
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body) async {
    calls++;
    expect(uri.scheme, 'https');
    expect(headers[HttpHeaders.authorizationHeader], 'Bearer test-session');
    return response;
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
