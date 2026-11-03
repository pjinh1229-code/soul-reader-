import 'dart:async';

enum FreeReadingAdsMode { off, test, live }

/// Public AdMob identifiers are build configuration, never credentials.
class FreeReadingAdsConfig {
  const FreeReadingAdsConfig({
    this.mode = FreeReadingAdsMode.off,
    this.interstitialAdUnitId = '',
    this.loadTimeout = const Duration(seconds: 8),
    this.maxReadingAttempts = 256,
  });

  factory FreeReadingAdsConfig.fromEnvironment() {
    const mode = String.fromEnvironment('ADS_MODE', defaultValue: 'off');
    return FreeReadingAdsConfig(
      mode: switch (mode) {
        'test' => FreeReadingAdsMode.test,
        'live' => FreeReadingAdsMode.live,
        _ => FreeReadingAdsMode.off,
      },
      interstitialAdUnitId:
          const String.fromEnvironment('ADMOB_INTERSTITIAL_AD_UNIT_ID'),
    );
  }

  static const androidTestInterstitialId =
      'ca-app-pub-3940256099942544/1033173712';

  final FreeReadingAdsMode mode;
  final String interstitialAdUnitId;

  /// Bounds loading and other operations that cannot present a full-screen UI.
  /// Consent forms and displayed ads deliberately have no timer.
  final Duration loadTimeout;

  /// Retain attempted IDs instead of evicting them and permitting a replay.
  /// Once full, later readings simply continue without advertising.
  final int maxReadingAttempts;

  String? get adUnitId => switch (mode) {
        FreeReadingAdsMode.off => null,
        FreeReadingAdsMode.test => androidTestInterstitialId,
        FreeReadingAdsMode.live =>
          RegExp(r'^ca-app-pub-\d{16}/\d{10}$')
                      .hasMatch(interstitialAdUnitId) &&
                  !interstitialAdUnitId.startsWith(
                    'ca-app-pub-3940256099942544/',
                  )
              ? interstitialAdUnitId
              : null,
      };

  bool get isConfigured => adUnitId != null;
}

class FreeReadingAdsConsent {
  const FreeReadingAdsConsent({
    required this.canRequestAds,
    required this.privacyOptionsRequired,
  });

  final bool canRequestAds;
  final bool privacyOptionsRequired;
}

enum FreeReadingAdResult {
  dismissed,
  skipped,
  unavailable,
  consentDenied,
  loadFailed,
  showFailed,
  disposed,
}

enum FreeReadingInterstitialResult { dismissed, failedToShow }

abstract interface class FreeReadingInterstitial {
  /// Complete only when the SDK reports dismissal or failure to show.
  Future<FreeReadingInterstitialResult> show();
  void dispose();
}

abstract interface class FreeReadingConsentForm {
  /// Completes only after dismissal or an SDK presentation failure.
  Future<void> show();
  void dispose();
}

/// Keeps platform SDK callbacks out of reading and WebView state management.
abstract interface class FreeReadingAdsGateway {
  bool get isSupported;
  Future<void> updateConsent();
  Future<FreeReadingConsentForm?> loadConsentFormIfRequired();
  Future<FreeReadingAdsConsent> getConsentState();
  Future<void> showPrivacyOptions();
  Future<void> initialize();
  Future<FreeReadingInterstitial> loadInterstitial(String adUnitId);
}

class FreeReadingAdsController {
  FreeReadingAdsController({
    required this.config,
    required this.gateway,
    this.onChanged,
    this.canPresent,
  });

  final FreeReadingAdsConfig config;
  final FreeReadingAdsGateway gateway;
  final void Function()? onChanged;
  final bool Function()? canPresent;

  final _attempts = <String, Future<FreeReadingAdResult>>{};
  bool _disposed = false;
  bool _foreground = true;
  bool _consentPrepared = false;
  bool _initialized = false;
  FreeReadingAdsConsent? _consent;
  Future<void>? _operationDone;
  Future<void>? _privacyOperation;
  _InterstitialHandle? _activeAd;
  _ConsentFormHandle? _activeConsentForm;

  /// Configuration/platform availability, not an ad or consent guarantee.
  bool get available =>
      !_disposed && config.isConfigured && gateway.isSupported;

  bool get privacyOptionsRequired =>
      available && (_consent?.privacyOptionsRequired ?? false);

  bool get _canContinue {
    if (!available || !_foreground) return false;
    try {
      return canPresent?.call() ?? true;
    } catch (_) {
      return false;
    }
  }

  void setForeground(bool foreground) {
    _foreground = foreground;
  }

  /// One attempt per reading for this controller's lifetime, including failures.
  /// Duplicate calls share completion so they cannot release a report while
  /// the original request still owns an ad or consent form.
  Future<FreeReadingAdResult> showForReading(String readingId) {
    if (_disposed) return Future.value(FreeReadingAdResult.disposed);
    if (readingId.trim().isEmpty) {
      return Future.value(FreeReadingAdResult.skipped);
    }
    final previous = _attempts[readingId];
    if (previous != null) return previous;
    if (_attempts.length >= config.maxReadingAttempts) {
      return _afterCurrentOperation(FreeReadingAdResult.skipped);
    }
    final currentOperation = _operationDone;
    if (currentOperation != null) {
      final skipped = currentOperation.then(
        (_) => _disposed
            ? FreeReadingAdResult.disposed
            : FreeReadingAdResult.skipped,
      );
      _attempts[readingId] = skipped;
      return skipped;
    }

    final done = Completer<void>();
    _operationDone = done.future;
    final attempt = _performReading().whenComplete(() {
      _operationDone = null;
      done.complete();
    });
    _attempts[readingId] = attempt;
    return attempt;
  }

  Future<FreeReadingAdResult> _afterCurrentOperation(
    FreeReadingAdResult result,
  ) async {
    await _operationDone;
    return _disposed ? FreeReadingAdResult.disposed : result;
  }

  Future<FreeReadingAdResult> _performReading() async {
    if (!_canContinue) return FreeReadingAdResult.unavailable;
    try {
      if (!await _prepareConsent()) {
        return _disposed
            ? FreeReadingAdResult.disposed
            : FreeReadingAdResult.consentDenied;
      }
    } catch (_) {
      return _disposed
          ? FreeReadingAdResult.disposed
          : FreeReadingAdResult.consentDenied;
    }
    if (!_canContinue) return _unavailableResult;

    _InterstitialHandle? loaded;
    try {
      try {
        if (!_initialized) {
          await gateway.initialize().timeout(config.loadTimeout);
          _initialized = true;
        }
        if (!_canContinue) return _unavailableResult;
        loaded = _InterstitialHandle(await _loadInterstitial());
        _activeAd = loaded;
        if (!_canContinue) return _unavailableResult;

        // A privacy change can invalidate consent while an ad is loading.
        await _refreshConsent();
        if (!_canContinue) return _unavailableResult;
        if (!(_consent?.canRequestAds ?? false)) {
          return FreeReadingAdResult.consentDenied;
        }
      } catch (_) {
        return _disposed
            ? FreeReadingAdResult.disposed
            : FreeReadingAdResult.loadFailed;
      }

      final ad = loaded;
      try {
        // No timeout here: releasing the reading early would put report/audio
        // behind a full-screen ad that the native SDK still owns.
        ad.showing = true;
        final result = await ad.ad.show();
        return result == FreeReadingInterstitialResult.dismissed
            ? FreeReadingAdResult.dismissed
            : FreeReadingAdResult.showFailed;
      } catch (_) {
        return FreeReadingAdResult.showFailed;
      }
    } finally {
      loaded?.dispose();
      if (identical(_activeAd, loaded)) _activeAd = null;
    }
  }

  FreeReadingAdResult get _unavailableResult => _disposed
      ? FreeReadingAdResult.disposed
      : FreeReadingAdResult.unavailable;

  Future<FreeReadingInterstitial> _loadInterstitial() async {
    var timedOut = false;
    final request = gateway.loadInterstitial(config.adUnitId!);
    // Native ad loading cannot be canceled. Dispose any late success instead
    // of leaking it or showing an ad after the reading has continued.
    unawaited(request.then<void>((ad) {
      if (timedOut) {
        try {
          ad.dispose();
        } catch (_) {
          // Cleanup never blocks the free report.
        }
      }
    }, onError: (Object _, StackTrace __) {}));
    return request.timeout(config.loadTimeout, onTimeout: () {
      timedOut = true;
      throw TimeoutException('Interstitial load timed out');
    });
  }

  Future<bool> _prepareConsent() async {
    if (!_consentPrepared) {
      await gateway.updateConsent().timeout(config.loadTimeout);
      if (!_canContinue) return false;
      final form = await _loadConsentForm();
      if (form != null) {
        final handle = _ConsentFormHandle(form);
        _activeConsentForm = handle;
        try {
          if (!_canContinue) return false;
          // Loading is bounded; a visible UMP form deliberately has no timer.
          handle.showing = true;
          await form.show();
        } finally {
          handle.dispose();
          if (identical(_activeConsentForm, handle)) {
            _activeConsentForm = null;
          }
        }
      }
      _consentPrepared = true;
    }
    if (_disposed) return false;
    await _refreshConsent();
    return _consent?.canRequestAds ?? false;
  }

  Future<FreeReadingConsentForm?> _loadConsentForm() {
    var timedOut = false;
    final request = gateway.loadConsentFormIfRequired();
    unawaited(request.then<void>((form) {
      if (timedOut && form != null) {
        try {
          form.dispose();
        } catch (_) {
          // A late form must never appear after the reading continued.
        }
      }
    }, onError: (Object _, StackTrace __) {}));
    return request.timeout(config.loadTimeout, onTimeout: () {
      timedOut = true;
      throw TimeoutException('Consent form load timed out');
    });
  }

  Future<void> _refreshConsent() async {
    final consent = await gateway.getConsentState().timeout(config.loadTimeout);
    if (_disposed) return;
    _consent = consent;
    onChanged?.call();
  }

  Future<void> showPrivacyOptions() {
    if (_disposed) return Future.value();
    return _privacyOperation ??= _performPrivacyOptions().whenComplete(() {
      _privacyOperation = null;
    });
  }

  Future<void> _performPrivacyOptions() async {
    // Serialize every full-screen SDK surface with the reading gate.
    while (_operationDone != null) {
      await _operationDone;
    }
    if (!_canContinue) return;
    final done = Completer<void>();
    _operationDone = done.future;
    try {
      if (!_consentPrepared) await _prepareConsent();
      if (!_canContinue || !privacyOptionsRequired) return;
      await gateway.showPrivacyOptions();
      await _refreshConsent();
    } catch (_) {
      // A privacy SDK/network error must not make the reading unavailable.
      _consent = FreeReadingAdsConsent(
        canRequestAds: false,
        privacyOptionsRequired: _consent?.privacyOptionsRequired ?? false,
      );
      if (!_disposed) onChanged?.call();
    } finally {
      _operationDone = null;
      done.complete();
    }
  }

  void dispose() {
    _disposed = true;
    _foreground = false;
    final ad = _activeAd;
    if (ad != null && !ad.showing) ad.dispose();
    final form = _activeConsentForm;
    if (form != null && !form.showing) form.dispose();
    // A visible native surface still completes through its SDK callback.
  }
}

class _InterstitialHandle {
  _InterstitialHandle(this.ad);
  final FreeReadingInterstitial ad;
  bool showing = false;
  bool _disposed = false;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    try {
      ad.dispose();
    } catch (_) {
      // Cleanup never blocks the free report.
    }
  }
}

class _ConsentFormHandle {
  _ConsentFormHandle(this.form);
  final FreeReadingConsentForm form;
  bool showing = false;
  bool _disposed = false;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    try {
      form.dispose();
    } catch (_) {
      // Cleanup never blocks the free report.
    }
  }
}
