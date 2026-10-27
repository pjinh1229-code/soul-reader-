"""Authoritative manifest and real JDK signature checks for first Play upload."""

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('verify_first_play_bundle',
                                            ROOT / 'scripts/verify_first_play_bundle.py')
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)

MANIFEST = '''<manifest xmlns:android="http://schemas.android.com/apk/res/android"
 package="com.soulreader.soul_reader" android:versionCode="95" android:versionName="8.5.6">
 <uses-permission android:name="com.android.vending.BILLING"/>
 <application android:debuggable="false">
  <meta-data android:name="com.google.android.play.billingclient.version" android:value="9.1.0"/>
 </application>
</manifest>'''


class ManifestTests(unittest.TestCase):
    def test_release_manifest_and_default_false_debuggable(self):
        for xml in (MANIFEST, MANIFEST.replace(' android:debuggable="false"', '')):
            info = VERIFY.validate_manifest(xml)
            self.assertEqual(info['packageName'], 'com.soulreader.soul_reader')
            self.assertEqual(info['versionCode'], 95)
            self.assertEqual(info['versionName'], '8.5.6')
            self.assertFalse(info['debuggable'])
            self.assertEqual(info['billingClientVersion'], '9.1.0')

    def test_wrong_package_version_or_debuggable_rejected(self):
        for old, new in [('com.soulreader.soul_reader', 'com.other.application'),
                         ('versionCode="95"', 'versionCode="94"'),
                         ('versionName="8.5.6"', 'versionName="8.5.5"'),
                         ('debuggable="false"', 'debuggable="true"'),
                         ('debuggable="false"', 'debuggable="@bool/debug"')]:
            with self.subTest(replacement=new):
                with self.assertRaises(VERIFY.BundleVerificationError):
                    VERIFY.validate_manifest(MANIFEST.replace(old, new))

    def test_missing_or_sdk_limited_billing_permission_rejected(self):
        permission = '<uses-permission android:name="com.android.vending.BILLING"/>'
        for replacement in ['', permission.replace('/>', ' android:maxSdkVersion="23"/>')]:
            with self.subTest(replacement=replacement):
                with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'BILLING'):
                    VERIFY.validate_manifest(MANIFEST.replace(permission, replacement))

    def test_missing_ambiguous_or_invalid_billing_metadata_rejected(self):
        metadata = '<meta-data android:name="com.google.android.play.billingclient.version" android:value="9.1.0"/>'
        for replacement in ['', metadata + metadata,
                            metadata.replace('9.1.0', ''),
                            metadata.replace('9.1.0', '@string/version'),
                            metadata.replace('android:value="9.1.0"', 'android:resource="@string/version"')]:
            with self.subTest(replacement=replacement):
                with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'metadata'):
                    VERIFY.validate_manifest(MANIFEST.replace(metadata, replacement))

    def test_missing_multiple_or_malformed_application_rejected(self):
        for xml in ['not XML', '<!DOCTYPE manifest><manifest/>',
                    MANIFEST.replace('<application android:debuggable="false">', '<other>')
                            .replace('</application>', '</other>'),
                    MANIFEST.replace('</manifest>', '<application/></manifest>')]:
            with self.subTest(xml=xml):
                with self.assertRaises(VERIFY.BundleVerificationError):
                    VERIFY.validate_manifest(xml)

    def test_wrong_bundletool_digest_never_executes_a_jar(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            untrusted = root / 'bundletool.jar'
            untrusted.write_bytes(b'not the pinned official tool')
            with mock.patch.object(VERIFY, '_run') as run:
                with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'SHA-256'):
                    VERIFY.verify_bundle(root / 'app.aab', untrusted, root / 'upload.pem')
                run.assert_not_called()

    def test_public_tool_process_does_not_receive_signing_credentials(self):
        with mock.patch.dict(os.environ, {'SOUL_UPLOAD_KEYSTORE_PASSWORD': 'test-secret',
                                         'SOUL_UPLOAD_KEY_PASSWORD': 'another-secret'}):
            result = VERIFY._run([sys.executable, '-c',
                'import os; print(any(n.startswith("SOUL_UPLOAD_") for n in os.environ))'],
                'Environment isolation check')
        self.assertEqual(result.strip(), 'False')

    def test_cli_failure_does_not_expose_paths_or_write_a_success_report(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            untrusted = root / 'private-looking-input.jar'
            untrusted.write_bytes(b'wrong tool')
            output, errors = io.StringIO(), io.StringIO()
            report = root / 'BUILD_INFO.json'
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                status = VERIFY.main(['--bundle', str(root / 'private-looking-app.aab'),
                                      '--bundletool', str(untrusted), '--certificate',
                                      str(root / 'private-looking-certificate.pem'), '--output', str(report)])
            self.assertEqual(status, 1)
            self.assertNotIn('private-looking', output.getvalue() + errors.getvalue())
            self.assertNotIn('Traceback', errors.getvalue())
            self.assertFalse(report.exists())


@unittest.skipUnless(shutil.which('java') and shutil.which('keytool'), 'JDK tools required')
class RealJarSignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.environment = {**os.environ, 'FIRST_PLAY_FIXTURE_PASSWORD': 'temporary-test-password'}
        cls.key = cls.root / 'fixture.jks'
        cls.certificates = {}
        for alias in ['owner', 'other', 'debug']:
            dn = 'CN=Android Debug, O=Android, C=US' if alias == 'debug' else 'CN=FIRST PLAY ' + alias
            cls.command(['keytool', '-genkeypair', '-keystore', str(cls.key), '-storetype', 'JKS',
                         '-alias', alias, '-storepass:env', 'FIRST_PLAY_FIXTURE_PASSWORD',
                         '-keypass:env', 'FIRST_PLAY_FIXTURE_PASSWORD', '-keyalg', 'RSA',
                         '-keysize', '2048', '-validity', '1', '-dname', dn])
            certificate = cls.root / (alias + '.pem')
            certificate.write_text(cls.command(['keytool', '-exportcert', '-rfc',
                '-keystore', str(cls.key), '-alias', alias,
                '-storepass:env', 'FIRST_PLAY_FIXTURE_PASSWORD']))
            cls.certificates[alias] = certificate

    @classmethod
    def command(cls, command):
        result = subprocess.run(command, env=cls.environment, capture_output=True,
                                text=True, timeout=90)
        if result.returncode:
            raise AssertionError('Real JDK fixture command failed: ' + command[0])
        return result.stdout

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.directory.cleanup)
        self.bundle = Path(self.directory.name) / 'fixture.jar'
        with zipfile.ZipFile(self.bundle, 'w') as archive:
            archive.writestr('payload.txt', 'original payload')

    def sign(self, alias='owner'):
        self.command(['java', '-m', 'jdk.jartool/sun.security.tools.jarsigner.Main',
                      '-keystore', str(self.key), '-storepass:env', 'FIRST_PLAY_FIXTURE_PASSWORD',
                      '-keypass:env', 'FIRST_PLAY_FIXTURE_PASSWORD', str(self.bundle), alias])

    def test_real_signature_and_expected_certificate_match(self):
        self.sign()
        fingerprint = VERIFY.verify_signature(self.bundle, self.certificates['owner'])
        self.assertRegex(fingerprint, r'^[0-9a-f]{64}$')

    def test_unsigned_archive_rejected(self):
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'verified JAR signature'):
            VERIFY.verify_signature(self.bundle, self.certificates['owner'])

    def test_an_unsigned_entry_appended_to_signed_archive_is_rejected(self):
        self.sign()
        with zipfile.ZipFile(self.bundle, 'a') as archive:
            archive.writestr('appended.txt', 'not covered by signature')
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'unsigned'):
            VERIFY.verify_signature(self.bundle, self.certificates['owner'])

    def test_modified_signed_payload_rejected(self):
        self.sign()
        with zipfile.ZipFile(self.bundle) as archive:
            items = [(info, archive.read(info)) for info in archive.infolist()]
        with zipfile.ZipFile(self.bundle, 'w') as archive:
            for info, value in items:
                archive.writestr(info, b'tampered' if info.filename == 'payload.txt' else value)
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'signature verification failed'):
            VERIFY.verify_signature(self.bundle, self.certificates['owner'])

    def test_wrong_owner_certificate_rejected(self):
        self.sign()
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'does not match'):
            VERIFY.verify_signature(self.bundle, self.certificates['other'])

    def test_multiple_signing_certificates_rejected(self):
        self.sign('owner')
        self.sign('other')
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'Exactly one'):
            VERIFY.verify_signature(self.bundle, self.certificates['owner'])

    def test_debug_certificate_rejected_even_when_expected_matches(self):
        self.sign('debug')
        with self.assertRaisesRegex(VERIFY.BundleVerificationError, 'debug upload certificates'):
            VERIFY.verify_signature(self.bundle, self.certificates['debug'])


if __name__ == '__main__':
    unittest.main()
