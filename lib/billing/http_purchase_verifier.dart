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

/// Decode the bounded wire format without exposing arbitrary server messages.
/// The same boundary applies to success and error responses.
Map<String, dynamic> decodeBillingJsonResponse(int statusCode, List<int> bytes) {
  if (bytes.length > 512 * 1024) {
    throw const BillingFailure('invalid_server_response');
  }
  Object? value;
  try {
    value = jsonDecode(utf8.decode(bytes));
  } catch (_) {
    // Error pages can be HTML (for example, a reverse proxy outage).
  }
  if (statusCode == 200 || statusCode == 201) {
    if (value is! Map<String, dynamic>) {
      throw const BillingFailure('invalid_server_response');
    }
    return value;
  }
  const allowedErrors = <int, Set<String>>{
    400: {'invalid_request', 'invalid_purchase_context', 'invalid_receipt',
      'invalid_topic', 'invalid_purchase_token', 'invalid_product'},
    401: {'authentication_required', 'authentication_invalid'},
    403: {'authentication_required', 'purchase_context_mismatch',
      'purchase_revoked', 'play_permission_denied'},
    404: {'invalid_entitlement', 'entitlement_not_found',
      'play_purchase_not_found'},
    409: {'topic_already_selected', 'ledger_changed',
      'purchase_context_mismatch', 'purchase_pending', 'purchase_revoked'},
    429: {'billing_rate_limited', 'play_rate_limited'},
    503: {'billing_unavailable', 'play_unavailable',
      'authentication_unavailable', 'configuration_required',
      'google_configuration_required'},
  };
  final error = value is Map<String, dynamic> ? value['error'] : null;
  final code = error is Map<String, dynamic> ? error['code'] : null;
  if (code is String && allowedErrors[statusCode]?.contains(code) == true) {
    throw BillingFailure(code);
  }
  throw BillingFailure(switch (statusCode) {
    401 || 403 => 'authentication_required',
    429 => 'billing_rate_limited',
    _ => 'billing_server_rejected',
  });
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
      final bytes = BytesBuilder();
      await for (final chunk in response
          .timeout(const Duration(seconds: 15))) {
        if (bytes.length + chunk.length > 512 * 1024) {
          throw const BillingFailure('invalid_server_response');
        }
        bytes.add(chunk);
      }
      return decodeBillingJsonResponse(response.statusCode, bytes.takeBytes());
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
  bool get isConfigured {
    final base = _base;
    return base != null && base.scheme == 'https' && base.host.isNotEmpty &&
        base.userInfo.isEmpty && !base.hasQuery && !base.hasFragment &&
        RegExp(r'^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$')
            .hasMatch(packageName) && config.isConfigured && session.isConfigured;
  }

  Future<Map<String, dynamic>> _request(String method, String path, {
      Map<String, dynamic>? body, Map<String, String>? query}) async {
    final base = _base;
    if (!isConfigured || base == null) {
      throw const BillingFailure('configuration_required');
    }
    final token = await session.accessToken();
    if (token == null || token.isEmpty || token.contains(RegExp(r'[\r\n]'))) {
      throw const BillingFailure('authentication_required');
    }
    final prefix = base.path.replaceFirst(RegExp(r'/+$'), '');
    final uri = base.replace(path: '$prefix$path', queryParameters: query);
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
    final value = await _request('POST', '/v1/billing/prepare', body: {
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
    final value = await _request('POST', '/v1/billing/verify', body: {
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
    // A concurrent purchase/refund may invalidate a cursor. Discard the entire
    // partial snapshot and retry, so callers never replace their ledger with
    // a mixture of revisions or a truncated successful page.
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return await _restoreSnapshot();
      } on BillingFailure catch (error) {
        if (error.code != 'ledger_changed' || attempt == 2) rethrow;
      }
    }
    throw const BillingFailure('ledger_changed');
  }

  Future<List<VerifiedGrant>> _restoreSnapshot() async {
    final grants = <VerifiedGrant>[];
    final entitlementIds = <String>{};
    final transactionIds = <String>{};
    final cursors = <String>{};
    String? cursor;
    int? revision;
    for (var page = 0; page < 1000; page++) {
      final value = await _request('GET', '/v1/billing/entitlements',
        query: cursor == null ? null : {'cursor': cursor});
      final list = value['entitlements'];
      final hasCursor = value.containsKey('nextCursor');
      final hasRevision = value.containsKey('revision');
      final legacy = !hasCursor && !hasRevision;
      if (list is! List || list.length > 20000 ||
          (legacy && page != 0) || hasCursor != hasRevision) {
        throw const BillingFailure('invalid_server_response');
      }
      Object? nextCursor;
      if (!legacy) {
        final pageRevision = value['revision'];
        nextCursor = value['nextCursor'];
        if (pageRevision is! int || pageRevision < 0 ||
            pageRevision > 9007199254740991 ||
            (revision != null && revision != pageRevision) ||
            list.length > 20 ||
            (nextCursor != null && (nextCursor is! String ||
              nextCursor.isEmpty || nextCursor.length > 2048 ||
              !RegExp(r'^[A-Za-z0-9._~-]+$').hasMatch(nextCursor))) ||
            (nextCursor != null && list.isEmpty)) {
          throw const BillingFailure('invalid_server_response');
        }
        revision = pageRevision;
      }
      for (final entry in list) {
        final grant = _grant(entry);
        if (!entitlementIds.add(grant.entitlementId) ||
            !transactionIds.add(grant.transactionId)) {
          throw const BillingFailure('invalid_server_response');
        }
        grants.add(grant);
      }
      if (legacy || nextCursor == null) {
        return List<VerifiedGrant>.unmodifiable(grants);
      }
      cursor = nextCursor as String;
      if (!cursors.add(cursor)) {
        throw const BillingFailure('invalid_server_response');
      }
    }
    throw const BillingFailure('invalid_server_response');
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
      body: {'topic': topic});
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
