"""Actual encryption/key-generation checks using disposable, local-only keys."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/first_upload_bootstrap.py"
SPEC = importlib.util.spec_from_file_location("first_upload_bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class FirstUploadBootstrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.fixture_root = Path(cls.fixture.name)
        cls.recipient_key = cls.fixture_root / "recipient-fixture.key.pem"
        cls.recipient_cert = cls.fixture_root / "recipient-fixture.cert.pem"
        result = subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=LOCAL TEST RECIPIENT", "-keyout", str(cls.recipient_key),
            "-out", str(cls.recipient_cert),
        ], capture_output=True)
        if result.returncode:
            raise RuntimeError("Disposable recipient certificate generation failed")
        cls.other_key = cls.fixture_root / "other-recipient-fixture.key.pem"
        cls.other_cert = cls.fixture_root / "other-recipient-fixture.cert.pem"
        result = subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=OTHER LOCAL TEST RECIPIENT", "-keyout", str(cls.other_key),
            "-out", str(cls.other_cert),
        ], capture_output=True)
        if result.returncode:
            raise RuntimeError("Other disposable recipient certificate generation failed")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.project = self.directory / "checkout"
        self.project.mkdir()
        self.private = self.directory / "private"
        self.backup = self.directory / "owner-backup.cms"
        self.env = {
            "SOUL_BOOTSTRAP_PRIVATE_DIR": str(self.private),
            "SOUL_BOOTSTRAP_BACKUP_PATH": str(self.backup),
            "SOUL_BOOTSTRAP_RECIPIENT_CERT": str(self.recipient_cert),
        }

    def run_main(self, environ=None):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            status = bootstrap.main(self.project, self.env if environ is None else environ)
        return status, output.getvalue() + errors.getvalue()

    def decrypt(self, source=None, cert=None, key=None):
        return subprocess.run([
            "openssl", "cms", "-decrypt", "-binary", "-inform", "DER",
            "-in", str(source or self.backup), "-recip", str(cert or self.recipient_cert),
            "-inkey", str(key or self.recipient_key),
        ], capture_output=True)

    def test_real_round_trip_key_identity_permissions_and_no_secret_output(self):
        status, output = self.run_main()
        self.assertEqual(status, 0, output)
        signing = json.loads((self.private / "signing.json").read_text())
        metadata = json.loads((self.private / "metadata.json").read_text())
        for field in ("SOUL_UPLOAD_KEYSTORE_PASSWORD", "SOUL_UPLOAD_KEY_PASSWORD"):
            self.assertGreaterEqual(len(signing[field]), 40)
            self.assertNotIn(signing[field], output)
            self.assertNotIn(signing[field].encode(), self.backup.read_bytes())
        self.assertNotEqual(signing["SOUL_UPLOAD_KEYSTORE_PASSWORD"], signing["SOUL_UPLOAD_KEY_PASSWORD"])
        self.assertEqual(stat.S_IMODE(self.private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o600)
        for file in self.private.iterdir():
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
        self.assertFalse((self.private / "plaintext-backup.tar.gz").exists())
        self.assertFalse(list(self.directory.glob(".soul-owner-backup-*")))

        result = self.decrypt()
        self.assertEqual(result.returncode, 0)
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:gz") as archive:
            self.assertEqual(set(archive.getnames()), {
                "upload-keystore.jks", "signing.json", "upload-certificate.pem", "metadata.json", "README.txt",
            })
            for name in archive.getnames():
                self.assertEqual(archive.extractfile(name).read(), (self.private / name).read_bytes())
            restored_config = json.loads(archive.extractfile("signing.json").read())
            self.assertEqual(restored_config, signing)
        self.assertIn(metadata["certificateSha256"], output)
        keystore = self.private / "upload-keystore.jks"
        env = {**os.environ, "SOUL_FIXTURE_STORE_PASSWORD": signing["SOUL_UPLOAD_KEYSTORE_PASSWORD"]}
        listed = subprocess.run([
            "keytool", "-list", "-keystore", str(keystore), "-alias", signing["SOUL_UPLOAD_KEY_ALIAS"],
            "-storepass:env", "SOUL_FIXTURE_STORE_PASSWORD",
        ], env=env, capture_output=True)
        self.assertEqual(listed.returncode, 0)
        self.assertIn(b"PrivateKeyEntry", listed.stdout)

        # Authenticated decryption must reject a changed GCM tag.
        damaged = self.directory / "tampered.cms"
        ciphertext = bytearray(self.backup.read_bytes())
        ciphertext[-1] ^= 1
        damaged.write_bytes(ciphertext)
        self.assertNotEqual(self.decrypt(damaged).returncode, 0)

    def test_actual_wrong_recipient_cannot_decrypt_owner_backup(self):
        status, output = self.run_main()
        self.assertEqual(status, 0, output)
        self.assertNotEqual(self.decrypt(cert=self.other_cert, key=self.other_key).returncode, 0)

    def test_truncated_envelope_cannot_be_accepted_as_backup(self):
        status, output = self.run_main()
        self.assertEqual(status, 0, output)
        truncated = self.directory / "truncated.cms"
        truncated.write_bytes(self.backup.read_bytes()[:-20])
        self.assertNotEqual(self.decrypt(truncated).returncode, 0)

    def test_existing_private_directory_is_never_reused_or_overwritten(self):
        self.private.mkdir()
        existing = self.private / "upload-keystore.jks"
        existing.write_bytes(b"existing owner key")
        status, _ = self.run_main()
        self.assertEqual(status, 1)
        self.assertEqual(existing.read_bytes(), b"existing owner key")
        self.assertFalse(self.backup.exists())

    def test_existing_encrypted_backup_is_never_overwritten(self):
        self.backup.write_bytes(b"existing encrypted backup")
        status, _ = self.run_main()
        self.assertEqual(status, 1)
        self.assertEqual(self.backup.read_bytes(), b"existing encrypted backup")
        self.assertFalse(self.private.exists())

    def test_private_key_directory_inside_checkout_is_refused(self):
        env = {**self.env, "SOUL_BOOTSTRAP_PRIVATE_DIR": str(self.project / "private")}
        status, _ = self.run_main(env)
        self.assertEqual(status, 1)
        self.assertFalse((self.project / "private").exists())

    def test_missing_settings_relative_paths_and_control_characters_fail_before_key_creation(self):
        for name in self.env:
            for value in ("", "relative", "private\nvalue", "private\rvalue", "private\0value"):
                with self.subTest(setting=name, value=repr(value)):
                    status, output = self.run_main({**self.env, name: value})
                    self.assertEqual(status, 1)
                    self.assertNotIn("private\nvalue", output)
                    self.assertFalse(self.private.exists())
                    self.assertFalse(self.backup.exists())

    def test_recipient_private_key_cannot_be_supplied_as_public_certificate(self):
        status, _ = self.run_main({**self.env, "SOUL_BOOTSTRAP_RECIPIENT_CERT": str(self.recipient_key)})
        self.assertEqual(status, 1)
        self.assertFalse(self.private.exists())

    def test_bad_alias_does_not_echo_value_or_generate_key(self):
        status, output = self.run_main({**self.env, "SOUL_BOOTSTRAP_KEY_ALIAS": "bad\nprivate-value"})
        self.assertEqual(status, 1)
        self.assertNotIn("private-value", output)
        self.assertFalse(self.private.exists())


if __name__ == "__main__":
    unittest.main()
