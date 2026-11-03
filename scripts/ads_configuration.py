"""Resolve public Android AdMob settings without enabling live ads by default."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
from typing import Mapping


TEST_PUBLISHER = '3940256099942544'
TEST_APP_ID = f'ca-app-pub-{TEST_PUBLISHER}~3347511713'
TEST_INTERSTITIAL_ID = f'ca-app-pub-{TEST_PUBLISHER}/1033173712'
APP_ID_METADATA = 'com.google.android.gms.ads.APPLICATION_ID'
DELAY_MEASUREMENT_METADATA = 'com.google.android.gms.ads.DELAY_APP_MEASUREMENT_INIT'
MODE_METADATA = 'com.soulreader.ads.MODE'
UNIT_ID_METADATA = 'com.soulreader.ads.INTERSTITIAL_AD_UNIT_ID'
MIN_ADS_VERSION_CODE = 99


class AdsConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class AdsConfiguration:
    mode: str
    app_id: str
    interstitial_id: str

    def public_info(self) -> dict:
        return {
            'AdsMode': self.mode,
            'IsTest': self.mode == 'test',
            'AdsEnabled': self.mode != 'off',
            'DelayAppMeasurementInit': True,
            'AdMobAndroidAppId': self.app_id,
            'AdMobInterstitialAdUnitId': self.interstitial_id,
        }


def resolve_ads(environ: Mapping[str, str]) -> AdsConfiguration:
    mode = environ.get('ADS_MODE', 'off')
    if mode not in ('off', 'test', 'live'):
        raise AdsConfigurationError('ADS_MODE must be off, test or live.')
    # The SDK's Android content provider requires an app ID even when ads are off.
    # Never copy owner IDs into an off/test build or silently promote it to live.
    if mode != 'live':
        return AdsConfiguration(mode, TEST_APP_ID, TEST_INTERSTITIAL_ID)
    app_id = environ.get('ADMOB_ANDROID_APP_ID', '')
    unit_id = environ.get('ADMOB_INTERSTITIAL_AD_UNIT_ID', '')
    app = re.fullmatch(r'ca-app-pub-([0-9]{16})~([0-9]{10})', app_id)
    unit = re.fullmatch(r'ca-app-pub-([0-9]{16})/([0-9]{10})', unit_id)
    if not app or not unit:
        raise AdsConfigurationError('Live ads require valid ADMOB_ANDROID_APP_ID and ADMOB_INTERSTITIAL_AD_UNIT_ID.')
    if app[1] != unit[1]:
        raise AdsConfigurationError('Live AdMob app and interstitial IDs must have the same publisher.')
    if app[1] in (TEST_PUBLISHER, '0' * 16) or app[2] == '0' * 10 or unit[2] == '0' * 10:
        raise AdsConfigurationError('Live ads require owner AdMob IDs; Google test or zero IDs are not permitted.')
    return AdsConfiguration(mode, app_id, unit_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--github-env', action='store_true', help='Export only validated public ads configuration to the next CI step.')
    parser.add_argument('--require-new-version', action='store_true', help='Require SOUL_INTERNAL_VERSION_CODE >= 99 before signing an ads build.')
    args = parser.parse_args(argv)
    try:
        config = resolve_ads(os.environ)
        if args.require_new_version:
            version = os.environ.get('SOUL_INTERNAL_VERSION_CODE', '')
            if not re.fullmatch(r'[1-9][0-9]{0,9}', version) or not MIN_ADS_VERSION_CODE <= int(version) <= 2_100_000_000:
                raise AdsConfigurationError('Ads AAB version_code must be an integer from 99 to 2100000000; version 98 is already used.')
        if args.github_env:
            with Path(os.environ['GITHUB_ENV']).open('a', encoding='utf-8') as output:
                output.write(f'ADS_MODE={config.mode}\nADMOB_ANDROID_APP_ID={config.app_id}\nADMOB_INTERSTITIAL_AD_UNIT_ID={config.interstitial_id}\nSOUL_ADS_ARTIFACT_LABEL={config.mode.upper()}_ADS\n')
    except AdsConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(config.public_info(), sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
