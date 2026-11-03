"""Ads build modes, generated manifests and authoritative release verification."""

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import ads_configuration as ADS
import configure_platforms as PLATFORMS
import verify_first_play_bundle as VERIFY


LIVE = {'ADS_MODE': 'live',
        'ADMOB_ANDROID_APP_ID': 'ca-app-pub-6123456789012345~1234567890',
        'ADMOB_INTERSTITIAL_AD_UNIT_ID': 'ca-app-pub-6123456789012345/9876543210'}
MANIFEST = '''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
 package="com.soulreader.soul_reader" android:versionCode="99" android:versionName="8.5.6">
 <uses-permission android:name="com.android.vending.BILLING"/>
 <application android:name="${applicationName}" android:label="soul_reader" android:debuggable="false">
  <meta-data android:name="com.google.android.play.billingclient.version" android:value="9.1.0"/>
  <meta-data android:name="existing.metadata" android:value="A &amp; B &quot;quoted&quot;"/>
 </application>
</manifest>'''


class AdsModeTests(unittest.TestCase):
    def test_off_is_default_and_nonproduction_modes_always_use_google_test_ids(self):
        for env in ({}, {'ADS_MODE': 'off'}, {'ADS_MODE': 'test'},
                    {**LIVE, 'ADS_MODE': 'off'}, {**LIVE, 'ADS_MODE': 'test'}):
            with self.subTest(mode=env.get('ADS_MODE')):
                config = ADS.resolve_ads(env)
                self.assertEqual(config.app_id, 'ca-app-pub-3940256099942544~3347511713')
                self.assertEqual(config.interstitial_id, 'ca-app-pub-3940256099942544/1033173712')
                self.assertEqual(config.mode, env.get('ADS_MODE', 'off'))
                self.assertEqual(config.public_info()['IsTest'], config.mode == 'test')
                self.assertEqual(config.public_info()['AdsEnabled'], config.mode != 'off')
                self.assertTrue(config.public_info()['DelayAppMeasurementInit'])

    def test_live_requires_two_matching_owner_format_ids(self):
        config = ADS.resolve_ads(LIVE)
        self.assertEqual(config.app_id, LIVE['ADMOB_ANDROID_APP_ID'])
        self.assertEqual(config.interstitial_id, LIVE['ADMOB_INTERSTITIAL_AD_UNIT_ID'])
        self.assertEqual(config.public_info()['AdsMode'], 'live')
        self.assertFalse(config.public_info()['IsTest'])

    def test_invalid_or_missing_live_ids_never_fall_back_to_test(self):
        cases = [{}, {'ADMOB_ANDROID_APP_ID': LIVE['ADMOB_ANDROID_APP_ID']},
                 {'ADMOB_INTERSTITIAL_AD_UNIT_ID': LIVE['ADMOB_INTERSTITIAL_AD_UNIT_ID']},
                 {**LIVE, 'ADMOB_ANDROID_APP_ID': ADS.TEST_APP_ID},
                 {**LIVE, 'ADMOB_INTERSTITIAL_AD_UNIT_ID': ADS.TEST_INTERSTITIAL_ID},
                 {'ADMOB_ANDROID_APP_ID': ADS.TEST_APP_ID, 'ADMOB_INTERSTITIAL_AD_UNIT_ID': ADS.TEST_INTERSTITIAL_ID},
                 {**LIVE, 'ADMOB_ANDROID_APP_ID': LIVE['ADMOB_ANDROID_APP_ID'].replace('~', '/')},
                 {**LIVE, 'ADMOB_INTERSTITIAL_AD_UNIT_ID': LIVE['ADMOB_INTERSTITIAL_AD_UNIT_ID'].replace('/', '~')},
                 {**LIVE, 'ADMOB_ANDROID_APP_ID': LIVE['ADMOB_ANDROID_APP_ID'] + '\n'},
                 {**LIVE, 'ADMOB_INTERSTITIAL_AD_UNIT_ID': 'ca-app-pub-7123456789012345/9876543210'},
                 {**LIVE, 'ADMOB_ANDROID_APP_ID': 'ca-app-pub-6123456789012345~0000000000'},
                 {**LIVE, 'ADMOB_INTERSTITIAL_AD_UNIT_ID': 'ca-app-pub-6123456789012345/0000000000'},
                 {'ADMOB_ANDROID_APP_ID': 'ca-app-pub-0000000000000000~1234567890',
                  'ADMOB_INTERSTITIAL_AD_UNIT_ID': 'ca-app-pub-0000000000000000/1234567890'}]
        for env in cases:
            with self.subTest(env=env):
                with self.assertRaises(ADS.AdsConfigurationError):
                    ADS.resolve_ads({**env, 'ADS_MODE': 'live'})

    def test_unknown_modes_fail_closed(self):
        for value in ('', 'LIVE', 'production', 'test\nlive', None):
            with self.subTest(mode=value), self.assertRaises(ADS.AdsConfigurationError):
                ADS.resolve_ads({'ADS_MODE': value})

    def test_ci_exports_canonical_public_ids_and_an_explicit_test_artifact_label(self):
        with tempfile.TemporaryDirectory() as name:
            target = Path(name) / 'github-env'
            with mock.patch.dict(os.environ, {**LIVE, 'ADS_MODE': 'test', 'GITHUB_ENV': str(target),
                                              'SOUL_INTERNAL_VERSION_CODE': '99',
                                              'SOUL_UPLOAD_KEYSTORE_PASSWORD': 'never-export-this'}, clear=True):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(ADS.main(['--github-env', '--require-new-version']), 0)
            exported = target.read_text()
            self.assertIn('ADMOB_ANDROID_APP_ID=' + ADS.TEST_APP_ID, exported)
            self.assertIn('SOUL_ADS_ARTIFACT_LABEL=TEST_ADS\n', exported)
            self.assertNotIn('never-export-this', exported + output.getvalue())
            self.assertTrue(json.loads(output.getvalue())['IsTest'])

    def test_ci_rejects_consumed_version_98_and_invalid_versions_before_export(self):
        for version in ('98', '0', '-1', '99.0', '99\n', '2100000001'):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as name:
                target = Path(name) / 'github-env'
                with mock.patch.dict(os.environ, {'ADS_MODE': 'test', 'GITHUB_ENV': str(target),
                                                  'SOUL_INTERNAL_VERSION_CODE': version}, clear=True):
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(ADS.main(['--github-env', '--require-new-version']), 1)
                self.assertFalse(target.exists())


class GeneratedManifestTests(unittest.TestCase):
    def test_generated_ids_and_existing_escaped_xml_survive_without_duplicate_metadata(self):
        for mode in ('off', 'test', 'live'):
            env = {**LIVE, 'ADS_MODE': mode}
            with self.subTest(mode=mode):
                configured = PLATFORMS.configure_android_manifest(MANIFEST, env)
                self.assertEqual(PLATFORMS.configure_android_manifest(configured, env), configured)
                manifest = ET.fromstring(configured)
                app = manifest.find('application')
                self.assertEqual(app.get(VERIFY.ANDROID + 'name'), '${applicationName}')
                self.assertEqual(app.get(VERIFY.ANDROID + 'label'), 'SOUL READER')
                self.assertEqual(app.find("meta-data[@android:name='existing.metadata']", {'android': PLATFORMS.ANDROID_URI})
                                 .get(VERIFY.ANDROID + 'value'), 'A & B "quoted"')
                info = VERIFY.validate_manifest(configured, 99, ADS.resolve_ads(env))
                self.assertEqual(info['AdsMode'], mode)
                self.assertTrue(info['DelayAppMeasurementInit'])
                delayed = app.findall("meta-data[@android:name='" + ADS.DELAY_MEASUREMENT_METADATA + "']",
                                      {'android': PLATFORMS.ANDROID_URI})
                self.assertEqual(len(delayed), 1)
                self.assertEqual(delayed[0].get(VERIFY.ANDROID + 'value'), 'true')
                self.assertEqual(info['billingClientVersion'], '9.1.0')
                self.assertEqual(len(manifest.findall("uses-permission[@android:name='android.permission.INTERNET']",
                                                     {'android': PLATFORMS.ANDROID_URI})), 1)

    def test_mode_change_replaces_old_app_and_unit_ids_and_is_repeatable(self):
        xml = PLATFORMS.configure_android_manifest(MANIFEST, LIVE)
        for mode in ('test', 'off', 'live', 'test'):
            env = {**LIVE, 'ADS_MODE': mode}
            xml = PLATFORMS.configure_android_manifest(xml, env)
            self.assertEqual(VERIFY.validate_manifest(xml, 99, ADS.resolve_ads(env))['AdsMode'], mode)

    def test_duplicate_or_resource_id_entries_are_replaced_with_one_literal_value(self):
        xml = MANIFEST.replace('</application>',
            f'<meta-data android:name="{ADS.APP_ID_METADATA}" android:resource="@string/id"/>'
            f'<meta-data android:name="{ADS.APP_ID_METADATA}" android:value="old"/></application>')
        configured = PLATFORMS.configure_android_manifest(xml, {'ADS_MODE': 'test'})
        self.assertTrue(VERIFY.validate_manifest(configured, 99, ADS.resolve_ads({'ADS_MODE': 'test'}))['IsTest'])
        self.assertNotIn('@string/id', configured)

    def test_malformed_id_xml_injection_is_rejected_before_any_generated_file_changes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            manifest = root / 'android/app/src/main/AndroidManifest.xml'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(MANIFEST)
            gradle = root / 'android/app/build.gradle.kts'
            original = 'minSdk = flutter.minSdkVersion\ncompileSdk = flutter.compileSdkVersion\n'
            gradle.write_text(original)
            for value in ('bad&id', '"/><meta-data android:name="injected"/>', '<tag>', "'quoted'"):
                with self.subTest(value=value), self.assertRaises(ADS.AdsConfigurationError):
                    PLATFORMS.configure(root, {**LIVE, 'ADMOB_ANDROID_APP_ID': value})
                self.assertEqual(manifest.read_text(), MANIFEST)
                self.assertEqual(gradle.read_text(), original)

    def test_full_generated_configuration_is_idempotent_and_preserves_release_gradle(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            manifest = root / 'android/app/src/main/AndroidManifest.xml'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(MANIFEST)
            gradle = root / 'android/app/build.gradle.kts'
            gradle.write_text('minSdk = flutter.minSdkVersion\ncompileSdk = flutter.compileSdkVersion\nsigningConfig = signingConfigs.getByName("release")\n')
            PLATFORMS.configure(root, {'ADS_MODE': 'test'})
            before = (manifest.read_text(), gradle.read_text())
            PLATFORMS.configure(root, {'ADS_MODE': 'test'})
            self.assertEqual((manifest.read_text(), gradle.read_text()), before)
            self.assertIn('minSdk = 24', before[1])
            self.assertIn('compileSdk = 36', before[1])
            self.assertIn('signingConfigs.getByName("release")', before[1])

    def test_invalid_manifest_structure_is_rejected(self):
        for xml in ('broken XML', '<!DOCTYPE manifest><manifest/>', '<manifest/>',
                    '<manifest><application/><application/></manifest>'):
            with self.subTest(xml=xml), self.assertRaises(ValueError):
                PLATFORMS.configure_android_manifest(xml, {'ADS_MODE': 'test'})


class AdsReleaseVerificationTests(unittest.TestCase):
    def test_missing_duplicate_wrong_or_resource_ads_metadata_fails(self):
        config = ADS.resolve_ads(LIVE)
        original = PLATFORMS.configure_android_manifest(MANIFEST, LIVE)
        for key in (ADS.APP_ID_METADATA, ADS.DELAY_MEASUREMENT_METADATA, ADS.MODE_METADATA, ADS.UNIT_ID_METADATA):
            for change in ('missing', 'duplicate', 'wrong', 'resource'):
                xml = ET.fromstring(original)
                application = xml.find('application')
                entry = next(item for item in application.findall('meta-data') if item.get(VERIFY.ANDROID + 'name') == key)
                if change == 'missing':
                    application.remove(entry)
                elif change == 'duplicate':
                    application.append(ET.fromstring(ET.tostring(entry)))
                elif change == 'wrong':
                    entry.set(VERIFY.ANDROID + 'value', 'incorrect')
                else:
                    entry.set(VERIFY.ANDROID + 'resource', '@string/indirect')
                with self.subTest(key=key, change=change), self.assertRaises(VERIFY.BundleVerificationError):
                    VERIFY.validate_manifest(ET.tostring(xml, encoding='unicode'), 99, config)

    def test_test_build_cannot_be_verified_as_live(self):
        xml = PLATFORMS.configure_android_manifest(MANIFEST, {'ADS_MODE': 'test'})
        with self.assertRaises(VERIFY.BundleVerificationError):
            VERIFY.validate_manifest(xml, 99, ADS.resolve_ads(LIVE))

    def test_ads_build_cannot_reuse_version_98(self):
        xml = PLATFORMS.configure_android_manifest(MANIFEST, {'ADS_MODE': 'test'}).replace('versionCode="99"', 'versionCode="98"')
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, '99 or greater'):
            VERIFY.validate_manifest(xml, 98, ADS.resolve_ads({'ADS_MODE': 'test'}))

    def test_new_bundle_cannot_skip_ads_verification(self):
        with mock.patch.object(VERIFY, '_run') as run, mock.patch.object(VERIFY, 'sha256_file') as digest:
            with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'Ads-mode verification'):
                VERIFY.verify_bundle(Path('app.aab'), Path('tool.jar'), Path('certificate.pem'), expected_version_code=99)
            run.assert_not_called()
            digest.assert_not_called()

    def test_verified_bundle_report_has_test_mode_and_checks_the_packaged_ad_bridge(self):
        config = ADS.resolve_ads({'ADS_MODE': 'test'})
        xml = PLATFORMS.configure_android_manifest(MANIFEST, {'ADS_MODE': 'test'})
        for payload in (b'original bridge', b'wrong bridge'):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as name:
                root = Path(name)
                source = root / 'assets/web/free_reading_ads.js'
                source.parent.mkdir(parents=True)
                source.write_bytes(b'original bridge')
                bundle = root / 'app.aab'
                with zipfile.ZipFile(bundle, 'w') as archive:
                    archive.writestr('base/assets/flutter_assets/assets/web/free_reading_ads.js', payload)
                with mock.patch.object(VERIFY, 'sha256_file', return_value=VERIFY.BUNDLETOOL_SHA256), \
                        mock.patch.object(VERIFY, '_run', side_effect=['', xml]), \
                        mock.patch.object(VERIFY, 'verify_signature', return_value='c' * 64), \
                        mock.patch.object(VERIFY.verify_assets, 'verify_source', return_value={str(i): 'hash' for i in range(70)}), \
                        mock.patch.object(VERIFY.verify_assets, 'verify_archive', return_value='AAB'):
                    if payload != b'original bridge':
                        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'ad bridge'):
                            VERIFY.verify_bundle(bundle, root / 'tool.jar', root / 'certificate.pem', root,
                                                 expected_version_code=99, expected_ads=config)
                    else:
                        info = VERIFY.verify_bundle(bundle, root / 'tool.jar', root / 'certificate.pem', root,
                                                    expected_version_code=99, expected_ads=config)
                        self.assertEqual(info['AdsMode'], 'test')
                        self.assertTrue(info['IsTest'])
                        self.assertEqual(info['originalAudioFiles'], 70)


if __name__ == '__main__':
    unittest.main()
