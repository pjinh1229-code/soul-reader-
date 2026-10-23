import 'dart:io';

import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';
import 'package:in_app_purchase_android/billing_client_wrappers.dart';

import 'billing_controller.dart';

/// Android Play Billing only. iOS purchases require a separate StoreKit verifier.
class PlayStoreGateway implements StoreGateway {
  PlayStoreGateway({InAppPurchase? connection})
      : _store = connection ?? InAppPurchase.instance;

  final InAppPurchase _store;
  final Map<String, ProductDetails> _products = {};

  @override
  Stream<List<StorePurchase>> get purchaseUpdates => _store.purchaseStream.map(
        (purchases) => purchases.map(_convert).toList(growable: false),
      );

  @override
  Future<bool> isAvailable() async =>
      Platform.isAndroid && await _store.isAvailable();

  @override
  Future<List<StoreProduct>> queryProducts(Set<String> productIds) async {
    if (!Platform.isAndroid) throw const BillingFailure('store_unavailable');
    final response = await _store.queryProductDetails(productIds);
    if (response.error != null) {
      throw const BillingFailure('catalog_unavailable');
    }
    _products.clear();
    return response.productDetails.map((product) {
      _products[product.id] = product;
      return StoreProduct(
        productId: product.id,
        title: product.title,
        description: product.description,
        price: product.price,
        currencyCode: product.currencyCode,
        rawPrice: product.rawPrice,
      );
    }).toList(growable: false);
  }

  @override
  Future<bool> buy({
    required String productId,
    required bool consumable,
    required PurchaseContext context,
  }) async {
    if (!Platform.isAndroid) throw const BillingFailure('store_unavailable');
    final product = _products[productId];
    if (product == null) throw const BillingFailure('product_unavailable');
    final parameters = GooglePlayPurchaseParam(
      productDetails: product,
      applicationUserName: context.obfuscatedAccountId,
      obfuscatedProfileId: context.obfuscatedProfileId,
    );
    if (consumable) {
      // Keep ownership until server verification and durable grant delivery.
      return _store.buyConsumable(
        purchaseParam: parameters,
        autoConsume: false,
      );
    }
    return _store.buyNonConsumable(purchaseParam: parameters);
  }

  @override
  Future<List<StorePurchase>> recoverPurchases() async {
    if (!Platform.isAndroid) throw const BillingFailure('store_unavailable');
    final addition = _store
        .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>();
    final response = await addition.queryPastPurchases();
    if (response.error != null) throw const BillingFailure('restore_failed');
    return response.pastPurchases.map((purchase) {
      final result = _convert(purchase);
      return StorePurchase(
        productId: result.productId,
        state: result.state == StorePurchaseState.purchased
            ? StorePurchaseState.restored
            : result.state,
        purchaseId: result.purchaseId,
        verificationData: result.verificationData,
        verificationSource: result.verificationSource,
        pendingCompletion: result.pendingCompletion,
        nativeHandle: result.nativeHandle,
      );
    }).toList(growable: false);
  }

  @override
  Future<void> consume(StorePurchase purchase) async {
    if (!Platform.isAndroid) throw const BillingFailure('store_unavailable');
    final addition = _store
        .getPlatformAddition<InAppPurchaseAndroidPlatformAddition>();
    final result = await addition.consumePurchase(_native(purchase));
    if (result.responseCode != BillingResponse.ok) {
      throw const BillingFailure('purchase_consumption_failed');
    }
    // Consumption acknowledges Android consumables. Do not acknowledge again.
  }

  @override
  Future<void> complete(StorePurchase purchase) async {
    if (!Platform.isAndroid) throw const BillingFailure('store_unavailable');
    await _store.completePurchase(_native(purchase));
  }

  PurchaseDetails _native(StorePurchase purchase) {
    final handle = purchase.nativeHandle;
    if (handle is! GooglePlayPurchaseDetails) {
      throw const BillingFailure('invalid_native_purchase');
    }
    return handle;
  }

  StorePurchase _convert(PurchaseDetails purchase) => StorePurchase(
        productId: purchase.productID,
        state: switch (purchase.status) {
          PurchaseStatus.pending => StorePurchaseState.pending,
          PurchaseStatus.purchased => StorePurchaseState.purchased,
          PurchaseStatus.restored => StorePurchaseState.restored,
          PurchaseStatus.canceled => StorePurchaseState.canceled,
          PurchaseStatus.error => StorePurchaseState.error,
        },
        purchaseId: purchase.purchaseID,
        verificationData: purchase.verificationData.serverVerificationData,
        verificationSource: purchase.verificationData.source,
        pendingCompletion: purchase.pendingCompletePurchase,
        errorCode: purchase.error?.code,
        nativeHandle: purchase,
      );
}
