"""Authenticated restore tests use newly generated disposable fixture keys only."""
import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
try:
    import restore_upload_signing as recovery
    import first_upload_bootstrap as bootstrap
finally:
    sys.path.pop(0)


@unittest.skipUnless(all(shutil.which(tool) for tool in ("openssl", "keytool", "java")), "Signing tools required")
class UploadRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.fixture = Path(cls.temporary.name)
        cls.password = "fixture-recipient-password-DO-NOT-LOG"
        cls.recipient_key = cls.fixture / "recipient.encrypted.pem"
        cls.recipient = cls.fixture / "recipient.pem"
        environ = {**os.environ, "FIXTURE_PASSWORD": cls.password}
        result = subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-days", "1",
            "-subj", "/CN=DISPOSABLE RECOVERY TEST", "-passout", "env:FIXTURE_PASSWORD",
            "-keyout", str(cls.recipient_key), "-out", str(cls.recipient),
        ], env=environ, capture_output=True)
        if result.returncode:
            raise RuntimeError("Disposable encrypted recipient generation failed")
        project = cls.fixture / "source"
        project.mkdir()
        cls.source_private = cls.fixture / "source-private"
        cls.cms = cls.fixture / "backup.cms"
        cls.metadata = bootstrap.bootstrap(project, {
            "SOUL_BOOTSTRAP_PRIVATE_DIR": str(cls.source_private),
            "SOUL_BOOTSTRAP_BACKUP_PATH": str(cls.cms),
            "SOUL_BOOTSTRAP_RECIPIENT_CERT": str(cls.recipient),
        })
        result = subprocess.run(["openssl", "x509", "-in", str(cls.recipient), "-outform", "DER"], capture_output=True)
        if result.returncode:
            raise RuntimeError("Disposable recipient could not be read")
        cls.recipient_hash = hashlib.sha256(result.stdout).hexdigest()
        cls.cms_hash = hashlib.sha256(cls.cms.read_bytes()).hexdigest()
        cls.archive_bytes = cls.make_zip({
            "owner/backup.cms": cls.cms.read_bytes(),
            "owner/recipient.encrypted.pem": cls.recipient_key.read_bytes(),
            "owner/README.txt": b"Local disposable fixture only",
        })
        cls.signing = json.loads((cls.source_private / "signing.json").read_bytes())

    @staticmethod
    def make_zip(contents):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in contents.items():
                archive.writestr(name, value)
        return stream.getvalue()

    def setUp(self):
        self.temporary_run = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_run.cleanup)
        self.run = Path(self.temporary_run.name)
        self.project = self.run / "project"
        recipient_dir = self.project / "release/first-upload"
        recipient_dir.mkdir(parents=True)
        shutil.copyfile(self.recipient, recipient_dir / "backup-recipient.pem")
        self.runner = self.run / "runner"
        self.runner.mkdir()
        self.environment_file = self.run / "environment"
        self.environment_file.touch()
        self.env = {
            "RUNNER_TEMP": str(self.runner), "GITHUB_ENV": str(self.environment_file),
            "SOUL_INTERNAL_VERSION_CODE": "96",
            "SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64": base64.b64encode(self.archive_bytes).decode(),
            "SOUL_UPLOAD_RECOVERY_PASSWORD": self.password,
        }
        for name, value in (
            ("CERTIFICATE_SHA256", self.metadata["certificateSha256"]),
            ("CMS_SHA256", self.cms_hash), ("RECIPIENT_SHA256", self.recipient_hash),
        ):
            patcher = mock.patch.object(recovery, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def call_main(self, environ=None, argv=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = recovery.main(argv or [], self.project, self.env if environ is None else environ)
        output = stdout.getvalue() + stderr.getvalue()
        for secret in (self.password, self.signing["SOUL_UPLOAD_KEYSTORE_PASSWORD"],
                       self.signing["SOUL_UPLOAD_KEY_PASSWORD"], self.env["SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64"]):
            self.assertNotIn(secret, output)
        return status, output

    def assert_clean_failure(self, environ=None):
        status, output = self.call_main(environ)
        self.assertEqual(status, 1, output)
        self.assertFalse((self.runner / recovery.PRIVATE_NAME).exists())
        self.assertFalse((self.runner / recovery.CERTIFICATE_NAME).exists())
        self.assertEqual(self.environment_file.read_text(), "")
        return output

    def test_authenticated_real_restore_private_key_proof_permissions_and_no_output(self):
        status, output = self.call_main()
        self.assertEqual(status, 0, output)
        private = self.runner / recovery.PRIVATE_NAME
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
        self.assertEqual({path.name for path in private.iterdir()}, {"signing.json", "upload-keystore.jks"})
        for path in private.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual((private / "upload-keystore.jks").read_bytes(), (self.source_private / "upload-keystore.jks").read_bytes())
        recovered = json.loads((private / "signing.json").read_bytes())
        self.assertEqual(recovered["SOUL_UPLOAD_KEYSTORE_PASSWORD"], self.signing["SOUL_UPLOAD_KEYSTORE_PASSWORD"])
        self.assertEqual(recovered["SOUL_UPLOAD_KEYSTORE_PATH"], str(private / "upload-keystore.jks"))
        exported = self.environment_file.read_text()
        self.assertEqual(exported.splitlines(), [
            "SOUL_OWNER_SIGNING_CONFIG=" + str(private / "signing.json"),
            "SOUL_UPLOAD_KEYSTORE_PATH=" + str(private / "upload-keystore.jks"),
        ])
        self.assertNotIn(self.password, exported)
        self.assertNotIn(self.signing["SOUL_UPLOAD_KEY_PASSWORD"], exported)

    def test_original_four_bindings_preferred_over_invalid_recovery(self):
        environ = dict(self.env, SOUL_UPLOAD_RECOVERY_PASSWORD="wrong", SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64="not base64")
        environ.update({name: self.signing[name] for name in recovery.DIRECT_NAMES[1:]})
        environ["SOUL_UPLOAD_KEYSTORE_BASE64"] = base64.b64encode((self.source_private / "upload-keystore.jks").read_bytes()).decode()
        status, output = self.call_main(environ)
        self.assertEqual(status, 0, output)

    def test_partial_original_bindings_do_not_fallback(self):
        output = self.assert_clean_failure(dict(self.env, SOUL_UPLOAD_KEY_ALIAS="fixture-partial"))
        self.assertIn("SOUL_UPLOAD_KEYSTORE_BASE64", output)

    def test_wrong_backup_password_fails_without_private_files(self):
        self.assert_clean_failure(dict(self.env, SOUL_UPLOAD_RECOVERY_PASSWORD="wrong-password"))

    def test_modified_canonical_ciphertext_rejected_before_decryption(self):
        damaged = bytearray(self.cms.read_bytes())
        damaged[-1] ^= 1
        archive = self.make_zip({"backup.cms": damaged, "recipient.pem": self.recipient_key.read_bytes()})
        self.assert_clean_failure(dict(self.env, SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64=base64.b64encode(archive).decode()))

    def test_gcm_tag_failure_never_parses_unauthenticated_plaintext(self):
        damaged = bytearray(self.cms.read_bytes())
        damaged[-1] ^= 1
        archive = self.make_zip({"backup.cms": damaged, "recipient.pem": self.recipient_key.read_bytes()})
        with mock.patch.object(recovery, "CMS_SHA256", hashlib.sha256(damaged).hexdigest()), mock.patch.object(recovery, "_tar_contents") as parse:
            self.assert_clean_failure(dict(self.env, SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64=base64.b64encode(archive).decode()))
            parse.assert_not_called()

    def test_wrong_private_key_password_fails_real_jar_signing(self):
        environ = dict(self.env)
        environ.update({name: self.signing[name] for name in recovery.DIRECT_NAMES[1:]})
        environ["SOUL_UPLOAD_KEYSTORE_BASE64"] = base64.b64encode((self.source_private / "upload-keystore.jks").read_bytes()).decode()
        environ["SOUL_UPLOAD_KEY_PASSWORD"] = "wrong-private-key-password"
        self.assert_clean_failure(environ)

    def test_certificate_pin_mismatch_fails(self):
        with mock.patch.object(recovery, "CERTIFICATE_SHA256", "0" * 64):
            self.assert_clean_failure()

    def test_recipient_pin_mismatch_fails(self):
        with mock.patch.object(recovery, "RECIPIENT_SHA256", "0" * 64):
            self.assert_clean_failure()

    def test_existing_paths_preserved(self):
        private = self.runner / recovery.PRIVATE_NAME
        private.mkdir()
        marker = private / "existing"
        marker.write_bytes(b"preserve")
        status, output = self.call_main()
        self.assertEqual(status, 1, output)
        self.assertEqual(marker.read_bytes(), b"preserve")

    def test_input_size_base64_and_version_checks(self):
        for field, value in (
            ("SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64", "!bad!"),
            ("SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64", "A" * 48_001),
            ("SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64", base64.b64encode(b"A" * 36_001).decode()),
            ("SOUL_UPLOAD_RECOVERY_PASSWORD", "newline\nsecret"),
            ("SOUL_INTERNAL_VERSION_CODE", "95"), ("SOUL_INTERNAL_VERSION_CODE", "2100000001"),
            ("SOUL_INTERNAL_VERSION_CODE", "96\n"),
        ):
            with self.subTest(field=field, length=len(value)):
                self.assert_clean_failure(dict(self.env, **{field: value}))

    def test_unsafe_zip_members_duplicates_and_bombs(self):
        for name in ("../evil", "/evil", "owner/../../evil", "owner\\evil", "C:/evil", "owner//evil"):
            with self.subTest(name=name), self.assertRaises(recovery.RecoveryError):
                recovery._zip_contents(self.make_zip({name: b"x"}))
        for kind in (stat.S_IFLNK, stat.S_IFIFO):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                member = zipfile.ZipInfo("special")
                member.external_attr = (kind | 0o600) << 16
                archive.writestr(member, b"target")
            with self.assertRaises(recovery.RecoveryError):
                recovery._zip_contents(stream.getvalue())
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("same", b"one")
            with self.assertWarns(UserWarning):
                archive.writestr("same", b"two")
        with self.assertRaises(recovery.RecoveryError):
            recovery._zip_contents(stream.getvalue())
        with self.assertRaises(recovery.RecoveryError):
            recovery._zip_contents(self.make_zip({"bomb": b"A" * (recovery.MAX_MEMBER_BYTES + 1)}))

    def test_strict_tar_rejects_traversal_links_duplicates_and_extra_members(self):
        for name, kind in (("../evil", tarfile.REGTYPE), ("upload-keystore.jks", tarfile.SYMTYPE), ("extra", tarfile.REGTYPE)):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w:gz") as archive:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = 1 if kind == tarfile.REGTYPE else 0
                archive.addfile(info, io.BytesIO(b"x") if info.size else None)
            with self.subTest(name=name, kind=kind), self.assertRaises(recovery.RecoveryError):
                recovery._tar_contents(stream.getvalue())
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            for _ in range(2):
                info = tarfile.TarInfo("README.txt")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
        with self.assertRaises(recovery.RecoveryError):
            recovery._tar_contents(stream.getvalue())

    def test_configure_uses_fixed_private_config_without_exporting_secrets(self):
        status, output = self.call_main()
        self.assertEqual(status, 0, output)
        from configure_release_signing import DEFAULT_BUILD_TYPES
        gradle = self.project / "android/app/build.gradle.kts"
        gradle.parent.mkdir(parents=True)
        gradle.write_text('plugins {\n    id("com.android.application")\n}\n\nandroid {\n' + DEFAULT_BUILD_TYPES + '}\n')
        before = self.environment_file.read_bytes()
        status, output = self.call_main(argv=["--configure"])
        self.assertEqual(status, 0, output)
        properties = self.project / "android/key.properties"
        self.assertTrue(properties.is_file())
        self.assertEqual(stat.S_IMODE(properties.stat().st_mode), 0o600)
        self.assertIn(self.signing["SOUL_UPLOAD_KEYSTORE_PASSWORD"], properties.read_text())
        self.assertEqual(self.environment_file.read_bytes(), before)

    def test_gzip_bomb_bounded_before_tar_parser(self):
        packed = gzip.compress(b"A" * (recovery.MAX_CONTENT_BYTES + 64_001))
        with mock.patch.object(recovery.tarfile, "open") as parse, self.assertRaises(recovery.RecoveryError):
            recovery._tar_contents(packed)
        parse.assert_not_called()

    def test_json_duplicate_credentials_rejected(self):
        with self.assertRaises(recovery.RecoveryError):
            recovery._json_object(b'{"secret":"one","secret":"two"}')


if __name__ == "__main__":
    unittest.main()
