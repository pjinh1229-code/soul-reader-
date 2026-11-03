import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:google_mobile_ads/google_mobile_ads.dart';

import 'free_reading_ads.dart';

/// Android-only standard interstitials. No reading, photo, account, or face
/// information is attached to an ad request.
class GoogleMobileAdsGateway implements FreeReadingAdsGateway {
  @override
  bool get isSupported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  Future<void> updateConsent() async {
    if (!isSupported) throw StateError('unsupported_ads_platform');
    final completed = Completer<void>();
    ConsentInformation.instance.requestConsentInfoUpdate(
      ConsentRequestParameters(),
      () {
        if (!completed.isCompleted) completed.complete();
      },
      (_) {
        if (!completed.isCompleted) {
          completed.completeError(StateError('consent_update_failed'));
        }
      },
    );
    await completed.future;
  }

  @override
  Future<FreeReadingConsentForm?> loadConsentFormIfRequired() async {
    if (!isSupported) throw StateError('unsupported_ads_platform');
    final information = ConsentInformation.instance;
    if (await information.getConsentStatus() != ConsentStatus.required) {
      return null;
    }
    if (!await information.isConsentFormAvailable()) {
      throw StateError('consent_form_unavailable');
    }
    final completed = Completer<FreeReadingConsentForm>();
    try {
      ConsentForm.loadConsentForm(
        (form) {
          if (completed.isCompleted) {
            unawaited(form.dispose().catchError((Object _) {}));
          } else {
            completed.complete(_GoogleConsentForm(form));
          }
        },
        (_) {
          if (!completed.isCompleted) {
            completed.completeError(StateError('consent_form_load_failed'));
          }
        },
      );
    } catch (_) {
      if (!completed.isCompleted) {
        completed.completeError(StateError('consent_form_load_failed'));
      }
    }
    return completed.future;
  }

  @override
  Future<FreeReadingAdsConsent> getConsentState() async {
    if (!isSupported) {
      return const FreeReadingAdsConsent(
        canRequestAds: false,
        privacyOptionsRequired: false,
      );
    }
    final allowed = await ConsentInformation.instance.canRequestAds();
    final privacy = await ConsentInformation.instance
        .getPrivacyOptionsRequirementStatus();
    return FreeReadingAdsConsent(
      canRequestAds: allowed,
      privacyOptionsRequired:
          privacy == PrivacyOptionsRequirementStatus.required,
    );
  }

  @override
  Future<void> showPrivacyOptions() async {
    if (!isSupported) throw StateError('unsupported_ads_platform');
    FormError? failure;
    await ConsentForm.showPrivacyOptionsForm((error) {
      failure = error;
    });
    if (failure != null) throw StateError('privacy_options_failed');
  }

  @override
  Future<void> initialize() async {
    if (!isSupported) throw StateError('unsupported_ads_platform');
    await MobileAds.instance.initialize();
  }

  @override
  Future<FreeReadingInterstitial> loadInterstitial(String adUnitId) async {
    if (!isSupported) throw StateError('unsupported_ads_platform');
    final completed = Completer<FreeReadingInterstitial>();
    try {
      unawaited(InterstitialAd.load(
        adUnitId: adUnitId,
        request: const AdRequest(nonPersonalizedAds: true),
        adLoadCallback: InterstitialAdLoadCallback(
          onAdLoaded: (ad) {
            if (completed.isCompleted) {
              unawaited(ad.dispose().catchError((Object _) {}));
            } else {
              completed.complete(_GoogleInterstitial(ad));
            }
          },
          onAdFailedToLoad: (_) {
            if (!completed.isCompleted) {
              completed.completeError(StateError('interstitial_load_failed'));
            }
          },
        ),
      ).catchError((Object _) {
        if (!completed.isCompleted) {
          completed.completeError(StateError('interstitial_load_failed'));
        }
      }));
    } catch (_) {
      if (!completed.isCompleted) {
        completed.completeError(StateError('interstitial_load_failed'));
      }
    }
    return completed.future;
  }
}

class _GoogleConsentForm implements FreeReadingConsentForm {
  _GoogleConsentForm(this._form);

  final ConsentForm _form;
  Completer<void>? _completion;
  bool _disposed = false;

  @override
  Future<void> show() {
    if (_completion != null) return _completion!.future;
    if (_disposed) return Future.error(StateError('consent_form_disposed'));
    final completion = Completer<void>();
    _completion = completion;
    void finish(FormError? error) {
      if (!completion.isCompleted) {
        if (error == null) {
          completion.complete();
        } else {
          completion.completeError(StateError('consent_form_show_failed'));
        }
      }
      dispose();
    }

    try {
      _form.show(finish);
    } catch (_) {
      if (!completion.isCompleted) {
        completion.completeError(StateError('consent_form_show_failed'));
      }
      dispose();
    }
    return completion.future;
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(_form.dispose().catchError((Object _) {}));
  }
}

class _GoogleInterstitial implements FreeReadingInterstitial {
  _GoogleInterstitial(this._ad);

  final InterstitialAd _ad;
  Completer<FreeReadingInterstitialResult>? _completion;
  bool _disposed = false;

  @override
  Future<FreeReadingInterstitialResult> show() {
    if (_completion != null) return _completion!.future;
    if (_disposed) {
      return Future.value(FreeReadingInterstitialResult.failedToShow);
    }
    final completion = Completer<FreeReadingInterstitialResult>();
    _completion = completion;
    void finish(FreeReadingInterstitialResult result) {
      if (!completion.isCompleted) completion.complete(result);
      dispose();
    }

    _ad.fullScreenContentCallback = FullScreenContentCallback<InterstitialAd>(
      onAdDismissedFullScreenContent: (_) {
        finish(FreeReadingInterstitialResult.dismissed);
      },
      onAdFailedToShowFullScreenContent: (_, _) {
        finish(FreeReadingInterstitialResult.failedToShow);
      },
    );
    try {
      // The platform-call Future is not a dismissal signal.
      unawaited(_ad.show().catchError((Object _) {
        finish(FreeReadingInterstitialResult.failedToShow);
      }));
    } catch (_) {
      finish(FreeReadingInterstitialResult.failedToShow);
    }
    return completion.future;
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(_ad.dispose().catchError((Object _) {}));
  }
}
