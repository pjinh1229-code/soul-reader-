import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'billing_controller.dart';

/// Supply short-lived credentials from the app's authenticated account flow.
/// Store product IDs and build-time values must never be used as credentials.
abstract interface class BillingSessionProvider {
  bool get isConfigured;
  Future<String?> accessToken();
}

class MissingBillingSession implements BillingSessionProvider {
  const MissingBillingSession();
  @override
  bool get isConfigured => false;
  @override
  Future<String?> accessToken() async => null;
}

abstract interface class BillingJsonTransport {
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body);
}

class IoBillingJsonTransport implements BillingJsonTransport {
  @override
  Future<Map<String, dynamic>> send(Uri uri, String method,
      Map<String, String> headers, Map<String, dynamic>? body) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 15);
    try {
      final request = await client.openUrl(method, uri)
          .timeout(const Duration(seconds: 15));
      request.followRedirects = false;
      headers.forEach(request.headers.set);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close()
          .timeout(const Duration(seconds: 15));
      if (response.statusCode != 200 && response.statusCode != 201) {
        throw BillingFailure(switch (response.statusCode) {
          401 || 403 => 'authentication_required',
          409 => 'topic_already_selected',
          429 => 'billing_rate_limited',
          _ => 'billing_server_rejected',
        });
      }
      final bytes = BytesBuilder();
      await for (final chunk in response
          .timeout(const Duration(seconds: 15))) {
        if (bytes.length + chunk.length > 512 * 1024) {
          throw const BillingFailure('invalid_server_response');
        }
        bytes.add(chunk);
      }
      final value = jsonDecode(utf8.decode(bytes.takeBytes()));
      if (value is! Map<String, dynamic>) {
        throw const BillingFailure('invalid_server_response');
      }
      return value;
    } on BillingFailure {
      rethrow;
    } catch (_) {
      // Do not include responses, authorization headers or receipts in errors.
      throw const BillingFailure('billing_connection_failed');
    } finally {
      client.close(force: true);
    }
  }
}

/// The backend owns verification, token uniqueness, account/reading binding,
/// refunds and a durable entitlement ledger. An HTTP 200 alone is not a grant.
class HttpPurchaseVerifier implements PurchaseVerifier {
  HttpPurchaseVerifier({
    required String baseUrl,
    required this.packageName,
    required this.config,
    required this.session,
    BillingJsonTransport? transport,
  }) : _base = Uri.tryParse(baseUrl),
       _transport = transport ?? IoBillingJsonTransport();

  final Uri? _base;
  final String packageName;
  final BillingConfig config;
  final BillingSessionProvider session;
  final BillingJsonTransport _transport;

  @override
  bool get isConfigured => _base != null &&
      _base!.scheme == 'https' && _base!.host.isNotEmpty &&
      _base!.userInfo.isEmpty && !_base!.hasQuery && !_base!.hasFragment &&
      RegExp(r'^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$')
          .hasMatch(packageName) && config.isConfigured && session.isConfigured;

  Future<Map<String, dynamic>> _request(String method, String path,
      [Map<String, dynamic>? body]) async {
    if (!isConfigured) {
      throw const BillingFailure('configuration_required');
    }
    final token = await session.accessToken();
    if (token == null || token.isEmpty || token.contains(RegExp(r'[\r\n]'))) {
      throw const BillingFailure('authentication_required');
    }
    final prefix = _base!.path.replaceFirst(RegExp(r'/+$'), '');
    final uri = _base!.replace(path: '$prefix$path');
    return _transport.send(uri, method, {
      HttpHeaders.authorizationHeader: 'Bearer $token',
      HttpHeaders.acceptHeader: 'application/json',
    }, body);
  }

  VerifiedGrant _grant(dynamic value) {
    if (value is! Map<String, dynamic> || value['status'] != 'active') {
      throw const BillingFailure('invalid_verified_grant');
    }
    try {
      final grant = VerifiedGrant.fromJson(value);
      final offer = config.offerForProduct(grant.productId);
      if (!grant.isValid || offer == null || offer.key != grant.offerKey) {
        throw const BillingFailure('invalid_verified_grant');
      }
      return grant;
    } on BillingFailure {
      rethrow;
    } catch (_) {
      throw const BillingFailure('invalid_verified_grant');
    }
  }

  @override
  Future<PurchaseContext> preparePurchase(PurchaseContext request) async {
    final value = await _request('POST', '/v1/billing/prepare', {
      'requestId': request.requestId,
      'readingId': request.readingId,
      'offerKey': request.offerKey,
      'productId': request.productId,
    });
    final account = value['obfuscatedAccountId'];
    final profile = value['obfuscatedProfileId'];
    if (account is! String || profile is! String ||
        account.isEmpty || profile.isEmpty ||
        account.length > 64 || profile.length > 64) {
      throw const BillingFailure('invalid_purchase_context');
    }
    return PurchaseContext(
      offerKey: request.offerKey, productId: request.productId,
      requestId: request.requestId, readingId: request.readingId,
      obfuscatedAccountId: account, obfuscatedProfileId: profile,
    );
  }

  @override
  Future<VerifiedGrant> verify(PurchaseVerificationRequest request) async {
    if (request.purchase.verificationSource != 'google_play' ||
        request.purchase.verificationData.isEmpty) {
      throw const BillingFailure('invalid_receipt');
    }
    final value = await _request('POST', '/v1/billing/verify', {
      'platform': 'android', 'packageName': packageName,
      'productId': request.purchase.productId,
      'purchaseToken': request.purchase.verificationData,
      if (request.context != null) ...{
        'requestId': request.context!.requestId,
        'readingId': request.context!.readingId,
      },
    });
    final grant = _grant(value['entitlement']);
    if (grant.productId != request.purchase.productId ||
        grant.offerKey != request.offer.key ||
        (request.context != null &&
          (grant.requestId != request.context!.requestId ||
           grant.readingId != request.context!.readingId))) {
      throw const BillingFailure('purchase_context_mismatch');
    }
    return grant;
  }

  @override
  Future<List<VerifiedGrant>> restoreEntitlements() async {
    final value = await _request('GET', '/v1/billing/entitlements');
    final list = value['entitlements'];
    if (list is! List) {
      throw const BillingFailure('invalid_server_response');
    }
    return list.map(_grant).toList(growable: false);
  }

  Future<VerifiedGrant> selectTopic(VerifiedGrant existing, String topic) async {
    if (existing.offerKey != 'single' ||
        !const ['love', 'chance', 'work', 'bond'].contains(topic)) {
      throw const BillingFailure('invalid_topic');
    }
    if (existing.topic != null && existing.topic != topic) {
      throw const BillingFailure('topic_already_selected');
    }
    final value = await _request('POST',
      '/v1/billing/entitlements/${Uri.encodeComponent(existing.entitlementId)}/topic',
      {'topic': topic});
    final grant = _grant(value['entitlement']);
    if (grant.entitlementId != existing.entitlementId ||
        grant.transactionId != existing.transactionId ||
        grant.productId != existing.productId ||
        grant.readingId != existing.readingId ||
        grant.requestId != existing.requestId ||
        grant.offerKey != existing.offerKey || grant.topic != topic) {
      throw const BillingFailure('purchase_context_mismatch');
    }
    return grant;
  }
}
