import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soul_reader/ads/free_reading_ads.dart';

class FakeInterstitial implements FreeReadingInterstitial {
  final completion = Completer<FreeReadingInterstitialResult>();
  int shows = 0;
  int disposals = 0;

  @override
  Future<FreeReadingInterstitialResult> show() {
    shows++;
    return completion.future;
  }

  void dismiss() => completion.complete(FreeReadingInterstitialResult.dismissed);

  @override
  void dispose() => disposals++;
}

class FakeAdsGateway implements FreeReadingAdsGateway {
  bool supported = true;
  bool allowed = true;
  bool privacyRequired = false;
  bool updateFails = false;
  bool initializeFails = false;
  bool loadFails = false;
  int updates = 0;
  int consentForms = 0;
  int consentReads = 0;
  int initializations = 0;
  int loads = 0;
  int privacyForms = 0;
  int? revokeAtConsentRead;
  String? requestedAdUnit;
  Completer<void>? updateWait;
  Completer<void>? consentFormWait;
  Completer<void>? privacyWait;
  Completer<FreeReadingInterstitial>? loadWait;
  final loadedAds = <FakeInterstitial>[];

  @override
  bool get isSupported => supported;

  @override
  Future<void> updateConsent() async {
    updates++;
    if (updateFails) throw StateError('consent network failure');
    await updateWait?.future;
  }

  @override
  Future<void> showConsentFormIfRequired() async {
    consentForms++;
    await consentFormWait?.future;
  }

  @override
  Future<FreeReadingAdsConsent> getConsentState() async {
    consentReads++;
    if (consentReads == revokeAtConsentRead) allowed = false;
    return FreeReadingAdsConsent(
      canRequestAds: allowed,
      privacyOptionsRequired: privacyRequired,
    );
  }

  @override
  Future<void> showPrivacyOptions() async {
    privacyForms++;
    await privacyWait?.future;
  }

  @override
  Future<void> initialize() async {
    initializations++;
    if (initializeFails) throw StateError('SDK initialization failure');
  }

  @override
  Future<FreeReadingInterstitial> loadInterstitial(String adUnitId) async {
    loads++;
    requestedAdUnit = adUnitId;
    if (loadFails) throw StateError('no fill');
    if (loadWait != null) return loadWait!.future;
    final ad = FakeInterstitial();
    loadedAds.add(ad);
    return ad;
  }
}

Future<void> settle() async {
  // Exercise chains of SDK Future callbacks without depending on wall time.
  for (var i = 0; i < 40; i++) {
    await Future<void>.value();
  }
}

void main() {
  late FakeAdsGateway gateway;
  late FreeReadingAdsController controller;
  var contextCurrent = true;

  FreeReadingAdsController create({
    FreeReadingAdsConfig config = const FreeReadingAdsConfig(
      mode: FreeReadingAdsMode.test,
    ),
  }) => FreeReadingAdsController(
    config: config,
    gateway: gateway,
    canPresent: () => contextCurrent,
  );

  setUp(() {
    gateway = FakeAdsGateway();
    contextCurrent = true;
    controller = create();
  });

  tearDown(() => controller.dispose());

  test('off is the default; live never falls back to the Google test unit', () {
    expect(const FreeReadingAdsConfig().isConfigured, isFalse);
    expect(
      const FreeReadingAdsConfig(mode: FreeReadingAdsMode.live).isConfigured,
      isFalse,
    );
    expect(
      const FreeReadingAdsConfig(
        mode: FreeReadingAdsMode.live,
        interstitialAdUnitId: FreeReadingAdsConfig.androidTestInterstitialId,
      ).isConfigured,
      isFalse,
    );
    expect(
      const FreeReadingAdsConfig(
        mode: FreeReadingAdsMode.live,
        interstitialAdUnitId: 'invalid-unit',
      ).isConfigured,
      isFalse,
    );
    expect(
      const FreeReadingAdsConfig(mode: FreeReadingAdsMode.test).adUnitId,
      FreeReadingAdsConfig.androidTestInterstitialId,
    );
  });

  test('disabled configuration never calls the SDK', () async {
    controller = create(config: const FreeReadingAdsConfig());
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.unavailable);
    expect(gateway.updates, 0);
    expect(gateway.initializations, 0);
    expect(gateway.loads, 0);
    expect(controller.available, isFalse);
  });

  test('unsupported platforms never call the SDK', () async {
    gateway.supported = false;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.unavailable);
    expect(gateway.updates, 0);
    expect(gateway.initializations, 0);
  });

  test('no initialization or request happens before consent permits ads', () async {
    gateway.allowed = false;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.consentDenied);
    expect(gateway.updates, 1);
    expect(gateway.consentForms, 1);
    expect(gateway.initializations, 0);
    expect(gateway.loads, 0);
  });

  test('consent errors fail open without an ad request', () async {
    gateway.updateFails = true;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.consentDenied);
    expect(gateway.consentForms, 0);
    expect(gateway.initializations, 0);
    expect(gateway.loads, 0);
  });

  test('duplicate reading waits for dismissal and never shows a second ad', () async {
    final first = controller.showForReading('reading-a');
    final duplicate = controller.showForReading('reading-a');
    expect(identical(first, duplicate), isTrue);
    var finished = false;
    unawaited(duplicate.then((_) => finished = true));
    await settle();
    expect(gateway.loads, 1);
    expect(gateway.loadedAds.single.shows, 1);
    expect(finished, isFalse);
    expect(gateway.requestedAdUnit,
        FreeReadingAdsConfig.androidTestInterstitialId);
    gateway.loadedAds.single.dismiss();
    expect(await first, FreeReadingAdResult.dismissed);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.dismissed);
    expect(gateway.loads, 1);
    expect(gateway.loadedAds.single.disposals, 1);
  });

  test('concurrent other reading skips only after the current ad ends', () async {
    final first = controller.showForReading('reading-a');
    await settle();
    var secondFinished = false;
    final second = controller.showForReading('reading-b');
    unawaited(second.then((_) => secondFinished = true));
    await settle();
    expect(secondFinished, isFalse);
    expect(gateway.loads, 1);
    gateway.loadedAds.single.dismiss();
    expect(await first, FreeReadingAdResult.dismissed);
    expect(await second, FreeReadingAdResult.skipped);
    expect(await controller.showForReading('reading-b'),
        FreeReadingAdResult.skipped);
    expect(gateway.loads, 1);
  });

  test('no fill is attempted once and the next reading can still proceed', () async {
    gateway.loadFails = true;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(gateway.loads, 1);
    gateway.loadFails = false;
    final next = controller.showForReading('reading-b');
    await settle();
    gateway.loadedAds.single.dismiss();
    expect(await next, FreeReadingAdResult.dismissed);
    expect(gateway.loads, 2);
  });

  test('initialization failure fails open and never loads', () async {
    gateway.initializeFails = true;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(gateway.loads, 0);
  });

  testWidgets('load timeout fails open and disposes late loaded ad', (tester) async {
    controller = create(config: const FreeReadingAdsConfig(
      mode: FreeReadingAdsMode.test,
      loadTimeout: Duration(seconds: 1),
    ));
    gateway.loadWait = Completer<FreeReadingInterstitial>();
    final attempt = controller.showForReading('reading-a');
    await tester.pump();
    expect(gateway.loads, 1);
    await tester.pump(const Duration(seconds: 2));
    expect(await attempt, FreeReadingAdResult.loadFailed);
    final lateAd = FakeInterstitial();
    gateway.loadWait!.complete(lateAd);
    await tester.pump();
    expect(lateAd.shows, 0);
    expect(lateAd.disposals, 1);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(gateway.loads, 1);
  });

  testWidgets('visible ad has no timeout or lifecycle early completion', (tester) async {
    final attempt = controller.showForReading('reading-a');
    var completed = false;
    unawaited(attempt.then((_) => completed = true));
    await tester.pump();
    final ad = gateway.loadedAds.single;
    expect(ad.shows, 1);
    controller.setForeground(false);
    contextCurrent = false;
    controller.dispose();
    await tester.pump(const Duration(minutes: 5));
    expect(completed, isFalse);
    expect(ad.disposals, 0);
    ad.dismiss();
    await tester.pump();
    expect(await attempt, FreeReadingAdResult.dismissed);
    expect(ad.disposals, 1);
  });

  testWidgets('UMP form has no timeout and blocks report completion', (tester) async {
    gateway.consentFormWait = Completer<void>();
    final attempt = controller.showForReading('reading-a');
    var completed = false;
    unawaited(attempt.then((_) => completed = true));
    await tester.pump();
    expect(gateway.consentForms, 1);
    await tester.pump(const Duration(minutes: 5));
    expect(completed, isFalse);
    expect(gateway.initializations, 0);
    contextCurrent = false;
    gateway.consentFormWait!.complete();
    await tester.pump();
    expect(await attempt, FreeReadingAdResult.unavailable);
    expect(gateway.loads, 0);
  });

  test('background before the attempt skips consent and loading', () async {
    controller.setForeground(false);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.unavailable);
    expect(gateway.updates, 0);
  });

  test('background while loading disposes the ad without showing', () async {
    gateway.loadWait = Completer<FreeReadingInterstitial>();
    final attempt = controller.showForReading('reading-a');
    await settle();
    controller.setForeground(false);
    final ad = FakeInterstitial();
    gateway.loadWait!.complete(ad);
    expect(await attempt, FreeReadingAdResult.unavailable);
    expect(ad.shows, 0);
    expect(ad.disposals, 1);
  });

  test('canceled route while loading disposes the ad without showing', () async {
    gateway.loadWait = Completer<FreeReadingInterstitial>();
    final attempt = controller.showForReading('reading-a');
    await settle();
    contextCurrent = false;
    final ad = FakeInterstitial();
    gateway.loadWait!.complete(ad);
    expect(await attempt, FreeReadingAdResult.unavailable);
    expect(ad.shows, 0);
    expect(ad.disposals, 1);
  });

  test('canceled route before consent update ends never opens the form', () async {
    gateway.updateWait = Completer<void>();
    final attempt = controller.showForReading('reading-a');
    contextCurrent = false;
    gateway.updateWait!.complete();
    expect(await attempt, FreeReadingAdResult.consentDenied);
    expect(gateway.consentForms, 0);
    expect(gateway.loads, 0);
  });

  test('dispose while loading disposes eventual ad without showing', () async {
    gateway.loadWait = Completer<FreeReadingInterstitial>();
    final attempt = controller.showForReading('reading-a');
    await settle();
    controller.dispose();
    final ad = FakeInterstitial();
    gateway.loadWait!.complete(ad);
    expect(await attempt, FreeReadingAdResult.disposed);
    expect(ad.shows, 0);
    expect(ad.disposals, 1);
  });

  test('fresh consent is checked after load before showing', () async {
    gateway.revokeAtConsentRead = 2;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.consentDenied);
    expect(gateway.loads, 1);
    expect(gateway.loadedAds.single.shows, 0);
    expect(gateway.loadedAds.single.disposals, 1);
  });

  test('SDK failure to show releases the reading and disposes the ad', () async {
    final attempt = controller.showForReading('reading-a');
    await settle();
    final ad = gateway.loadedAds.single;
    ad.completion.complete(FreeReadingInterstitialResult.failedToShow);
    expect(await attempt, FreeReadingAdResult.showFailed);
    expect(ad.disposals, 1);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.showFailed);
    expect(ad.shows, 1);
  });

  testWidgets('privacy options wait for ad dismissal and never time out', (tester) async {
    gateway.privacyRequired = true;
    gateway.privacyWait = Completer<void>();
    final attempt = controller.showForReading('reading-a');
    await tester.pump();
    expect(controller.privacyOptionsRequired, isTrue);
    final privacy = controller.showPrivacyOptions();
    var privacyCompleted = false;
    unawaited(privacy.then((_) => privacyCompleted = true));
    await tester.pump();
    expect(gateway.privacyForms, 0);
    gateway.loadedAds.single.dismiss();
    await tester.pump();
    expect(await attempt, FreeReadingAdResult.dismissed);
    expect(gateway.privacyForms, 1);
    final waitingReading = controller.showForReading('reading-b');
    var readingCompleted = false;
    unawaited(waitingReading.then((_) => readingCompleted = true));
    await tester.pump(const Duration(minutes: 5));
    expect(privacyCompleted, isFalse);
    expect(readingCompleted, isFalse);
    gateway.allowed = false;
    gateway.privacyRequired = false;
    gateway.privacyWait!.complete();
    await tester.pump();
    await privacy;
    expect(await waitingReading, FreeReadingAdResult.skipped);
    expect(controller.privacyOptionsRequired, isFalse);
    expect(await controller.showForReading('reading-c'),
        FreeReadingAdResult.consentDenied);
    expect(gateway.loads, 1);
  });

  test('attempt memory cap never evicts IDs or permits replay', () async {
    controller = create(config: const FreeReadingAdsConfig(
      mode: FreeReadingAdsMode.test,
      maxReadingAttempts: 2,
    ));
    gateway.loadFails = true;
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(await controller.showForReading('reading-b'),
        FreeReadingAdResult.loadFailed);
    expect(await controller.showForReading('reading-c'),
        FreeReadingAdResult.skipped);
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.loadFailed);
    expect(gateway.loads, 2);
  });

  test('empty IDs and disposed controllers never start an ad', () async {
    expect(await controller.showForReading('  '), FreeReadingAdResult.skipped);
    controller.dispose();
    expect(await controller.showForReading('reading-a'),
        FreeReadingAdResult.disposed);
    expect(gateway.updates, 0);
  });
}
