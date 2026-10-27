#!/usr/bin/env python3
"""Generate a first Play upload key and an authenticated, recipient-encrypted backup.

This is a one-time bootstrap, not the normal release build path. Plaintext key
material stays in a new private directory outside the checkout. Only the CMS
ciphertext may be uploaded as an artifact. Never publish signing.json or the JKS.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from collections.abc import Mapping


class BootstrapError(Exception):
    """Credential-free diagnostic suitable for public CI logs."""


def _run(command: list[str], environ: Mapping[str, str] | None = None) -> bytes:
    try:
        result = subprocess.run(command, env=environ, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        raise BootstrapError("Required encryption or key-generation tool could not run.") from None
    if result.returncode:
        raise BootstrapError("Encryption or key-generation command failed; no credentials printed.")
    return result.stdout


def _write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(content)


def _new_absolute_path(value: str, message: str) -> Path:
    if not value or any(c in value for c in "\r\n\0"):
        raise BootstrapError(message)
    path = Path(value)
    if not path.is_absolute() or path.exists() or path.is_symlink():
        raise BootstrapError(message)
    if not path.parent.is_dir():
        raise BootstrapError("Output parent directory must already exist.")
    return path.resolve()


def bootstrap(project_root: Path, environ: Mapping[str, str]) -> dict[str, str]:
    root = project_root.resolve()
    private = _new_absolute_path(
        environ.get("SOUL_BOOTSTRAP_PRIVATE_DIR", ""),
        "Use a new absolute private directory; existing key material is never replaced.",
    )
    backup = _new_absolute_path(
        environ.get("SOUL_BOOTSTRAP_BACKUP_PATH", ""),
        "Use a new absolute encrypted-backup path; existing backups are never replaced.",
    )
    if private.is_relative_to(root):
        raise BootstrapError("Private upload-key material must remain outside the checkout.")
    if backup.is_relative_to(private):
        raise BootstrapError("Encrypted backup output must be outside the private key directory.")
    recipient_value = environ.get("SOUL_BOOTSTRAP_RECIPIENT_CERT", "")
    if not recipient_value or any(c in recipient_value for c in "\r\n\0"):
        raise BootstrapError("A public backup-recipient certificate is required.")
    recipient = Path(recipient_value)
    if not recipient.is_absolute() or not recipient.is_file():
        raise BootstrapError("A public backup-recipient certificate is required.")
    recipient = recipient.resolve()
    recipient_bytes = recipient.read_bytes()
    if len(recipient_bytes) > 100_000 or b"PRIVATE KEY" in recipient_bytes:
        raise BootstrapError("Supply only a public backup-recipient certificate.")
    alias = environ.get("SOUL_BOOTSTRAP_KEY_ALIAS", "soulreader-upload")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", alias):
        raise BootstrapError("Upload key alias contains unsupported characters.")
    for tool in ("openssl", "keytool"):
        if not shutil.which(tool):
            raise BootstrapError("Required encryption or key-generation tool is unavailable.")

    certificate_info = _run(["openssl", "x509", "-in", str(recipient), "-noout", "-text"])
    bits = re.search(rb"Public-Key:\s*\((\d+) bit\)", certificate_info)
    if b"Public Key Algorithm: rsaEncryption" not in certificate_info or not bits or int(bits[1]) < 2048:
        raise BootstrapError("Backup-recipient certificate must use RSA with at least 2048 bits.")

    private.mkdir(mode=0o700)
    os.chmod(private, 0o700)
    keystore = private / "upload-keystore.jks"
    store_password, key_password = secrets.token_urlsafe(36), secrets.token_urlsafe(36)
    command_env = dict(os.environ)
    command_env.update({
        "SOUL_BOOTSTRAP_STORE_PASSWORD": store_password,
        "SOUL_BOOTSTRAP_KEY_PASSWORD": key_password,
    })
    # keytool refuses an existing alias/key; this directory was exclusively created.
    _run([
        "keytool", "-genkeypair", "-keystore", str(keystore), "-storetype", "JKS",
        "-alias", alias, "-storepass:env", "SOUL_BOOTSTRAP_STORE_PASSWORD",
        "-keypass:env", "SOUL_BOOTSTRAP_KEY_PASSWORD", "-keyalg", "RSA", "-keysize", "3072",
        "-validity", "10000", "-dname", "CN=SOUL READER Upload",
    ], command_env)
    keystore.chmod(0o600)
    certificate = _run([
        "keytool", "-exportcert", "-rfc", "-keystore", str(keystore), "-alias", alias,
        "-storepass:env", "SOUL_BOOTSTRAP_STORE_PASSWORD",
    ], command_env)
    _write_private(private / "upload-certificate.pem", certificate)
    certificate_der = _run([
        "openssl", "x509", "-in", str(private / "upload-certificate.pem"), "-outform", "DER",
    ])
    signing = {
        "SOUL_UPLOAD_KEYSTORE_PATH": str(keystore),
        "SOUL_UPLOAD_KEYSTORE_PASSWORD": store_password,
        "SOUL_UPLOAD_KEY_ALIAS": alias,
        "SOUL_UPLOAD_KEY_PASSWORD": key_password,
    }
    metadata = {
        "schemaVersion": "1",
        "packageName": "com.soulreader.soul_reader",
        "keyAlias": alias,
        "certificateSha256": hashlib.sha256(certificate_der).hexdigest(),
        "recipientCertificateFileSha256": hashlib.sha256(recipient_bytes).hexdigest(),
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "purpose": "Google Play upload key; not the Google-managed app signing key",
    }
    _write_private(private / "signing.json", (json.dumps(signing, indent=2) + "\n").encode())
    _write_private(private / "metadata.json", (json.dumps(metadata, indent=2) + "\n").encode())
    _write_private(private / "README.txt", (
        "PRIVATE SOUL READER UPLOAD-KEY BACKUP\n"
        "Keep this archive, its decryption private key and password securely.\n"
        "Never commit the JKS or signing.json or upload plaintext backup to public artifacts.\n"
        "After decrypting, verify OpenSSL exited successfully before reading or extracting.\n"
        "Extract into a private directory outside the source checkout.\n"
        "Replace SOUL_UPLOAD_KEYSTORE_PATH with the absolute extracted upload-keystore.jks path.\n"
        "Other SOUL_UPLOAD_* values in signing.json are the original key credentials.\n"
    ).encode())

    archive = private / "plaintext-backup.tar.gz"
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    temporary_cipher: Path | None = None
    try:
        with os.fdopen(descriptor, "wb") as output:
            with tarfile.open(fileobj=output, mode="w:gz") as packed:
                for name in ("upload-keystore.jks", "signing.json", "upload-certificate.pem", "metadata.json", "README.txt"):
                    packed.add(private / name, arcname=name, recursive=False)
        cipher_descriptor, temporary_name = tempfile.mkstemp(prefix=".soul-owner-backup-", dir=backup.parent)
        os.close(cipher_descriptor)
        temporary_cipher = Path(temporary_name)
        _run([
            "openssl", "cms", "-encrypt", "-aes-256-gcm", "-binary", "-outform", "DER",
            "-in", str(archive), "-out", str(temporary_cipher), "-recip", str(recipient),
            "-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256",
            "-keyopt", "rsa_mgf1_md:sha256",
        ])
        envelope_info = _run([
            "openssl", "cms", "-cmsout", "-print", "-inform", "DER", "-in", str(temporary_cipher),
        ])
        if any(oid not in envelope_info for oid in (
            b"1.2.840.113549.1.9.16.1.23", b"2.16.840.1.101.3.4.1.46", b"1.2.840.113549.1.1.7",
        )):
            raise BootstrapError("Backup must use authenticated CMS AES-256-GCM and RSA-OAEP encryption.")
        # Exclusive publication: do not replace a backup created during the operation.
        os.link(temporary_cipher, backup)
    finally:
        archive.unlink(missing_ok=True)
        if temporary_cipher is not None:
            temporary_cipher.unlink(missing_ok=True)
    return {key: str(value) for key, value in metadata.items()}


def main(project_root: Path | None = None, environ: Mapping[str, str] | None = None) -> int:
    try:
        metadata = bootstrap(
            project_root or Path(__file__).resolve().parent.parent,
            os.environ if environ is None else environ,
        )
    except BootstrapError as error:
        print("First-upload bootstrap failed: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("First-upload bootstrap failed while processing private files; no credentials printed.", file=sys.stderr)
        return 1
    print("Upload key generated with an authenticated encrypted owner backup.")
    print("Upload certificate SHA-256: " + metadata["certificateSha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
