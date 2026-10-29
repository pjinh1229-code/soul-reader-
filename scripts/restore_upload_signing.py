#!/usr/bin/env python3
"""Restore the original upload key in a private runner directory, without logging secrets."""
from __future__ import annotations

import argparse
import base64
import binascii
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile
from collections.abc import Mapping

from configure_release_signing import configure_release_signing

CERTIFICATE_SHA256 = "c4d31b29444fcd6fabea9ee91a01fd6bab3383a07079302e19ff32a1d7805139"
CMS_SHA256 = "bcedc02a22a9f316c38b018b8bcdf7397c68775426b9b1b54505f2df1f2f7405"
RECIPIENT_SHA256 = "91708a57357c9eeac765cb01ba1c75a9c1d2ba04731e5b39b4a083136446a5e1"
PACKAGE = "com.soulreader.soul_reader"
DIRECT_NAMES = (
    "SOUL_UPLOAD_KEYSTORE_BASE64", "SOUL_UPLOAD_KEYSTORE_PASSWORD",
    "SOUL_UPLOAD_KEY_ALIAS", "SOUL_UPLOAD_KEY_PASSWORD",
)
CONFIG_NAMES = (
    "SOUL_UPLOAD_KEYSTORE_PATH", "SOUL_UPLOAD_KEYSTORE_PASSWORD",
    "SOUL_UPLOAD_KEY_ALIAS", "SOUL_UPLOAD_KEY_PASSWORD",
)
RECOVERY_NAMES = ("SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64", "SOUL_UPLOAD_RECOVERY_PASSWORD")
TAR_NAMES = {"upload-keystore.jks", "signing.json", "upload-certificate.pem", "metadata.json", "README.txt"}
MAX_ZIP_BYTES = 36_000
MAX_BASE64_CHARS = 48_000
MAX_MEMBER_BYTES = 256_000
MAX_CONTENT_BYTES = 1_000_000
PRIVATE_NAME = "soul-owner-upload-signing"
CERTIFICATE_NAME = "soul-owner-upload-certificate.pem"


class RecoveryError(Exception):
    """Only fixed, credential-free diagnostics are exposed to the caller."""


def _setting(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "")
    if not isinstance(value, str) or not value or any(c in value for c in "\r\n\0"):
        raise RecoveryError("A required signing setting is missing or invalid: " + name)
    return value


def _write_private(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _run(command: list[str], secrets: Mapping[str, str] | None = None) -> bytes:
    environ = {name: value for name, value in os.environ.items() if not name.startswith("SOUL_UPLOAD_")}
    environ.update(secrets or {})
    try:
        result = subprocess.run(command, env=environ, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        raise RecoveryError("A required signing or recovery tool could not run.") from None
    if result.returncode:
        # OpenSSL can write unauthenticated plaintext before detecting a GCM tag failure.
        # Never use stdout until the command has completed successfully.
        raise RecoveryError("Signing or authenticated recovery failed; no private details printed.")
    if len(result.stdout) > MAX_CONTENT_BYTES:
        raise RecoveryError("A signing or recovery tool returned an oversized response.")
    return result.stdout


def _decode(value: str, maximum: int, encoded_maximum: int) -> bytes:
    if len(value) > encoded_maximum:
        raise RecoveryError("Encoded signing input exceeds the permitted size.")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise RecoveryError("Signing input must contain single-line base64.") from None
    if not raw or len(raw) > maximum:
        raise RecoveryError("Decoded signing input has an invalid size.")
    return raw


def _safe_archive_name(name: str) -> bool:
    return bool(name) and "\\" not in name and "\0" not in name and not name.startswith("/") and all(
        part not in ("", ".", "..") for part in name.rstrip("/").split("/")
    ) and not re.match(r"^[A-Za-z]:", name)


def _zip_contents(raw: bytes) -> tuple[bytes, bytes]:
    cipher, recipient_key = [], []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            if not 1 <= len(members) <= 32:
                raise RecoveryError("Recovery ZIP has an invalid member count.")
            seen, total = set(), 0
            for member in members:
                name = member.filename
                mode = member.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if (not _safe_archive_name(name) or name in seen or member.flag_bits & 1
                        or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                        or (member.is_dir() and kind == stat.S_IFREG)
                        or (not member.is_dir() and kind == stat.S_IFDIR)):
                    raise RecoveryError("Recovery ZIP contains an unsafe or duplicate member.")
                seen.add(name)
                if member.is_dir():
                    if member.file_size:
                        raise RecoveryError("Recovery ZIP contains a malformed directory.")
                    continue
                if not 0 <= member.file_size <= MAX_MEMBER_BYTES:
                    raise RecoveryError("Recovery ZIP contains an oversized member.")
                total += member.file_size
                if total > MAX_CONTENT_BYTES:
                    raise RecoveryError("Recovery ZIP expands beyond the permitted size.")
                with archive.open(member) as source:
                    content = source.read(MAX_MEMBER_BYTES + 1)
                if len(content) != member.file_size or len(content) > MAX_MEMBER_BYTES:
                    raise RecoveryError("Recovery ZIP has an invalid member size.")
                if hashlib.sha256(content).hexdigest() == CMS_SHA256:
                    cipher.append(content)
                if content.strip().startswith(b"-----BEGIN ENCRYPTED PRIVATE KEY-----"):
                    if not re.fullmatch(
                        rb"-----BEGIN ENCRYPTED PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END ENCRYPTED PRIVATE KEY-----\s*",
                        content.strip(),
                    ):
                        raise RecoveryError("Recovery ZIP contains an invalid encrypted recipient key.")
                    recipient_key.append(content)
                elif re.search(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", content):
                    raise RecoveryError("Recovery ZIP must not contain an unencrypted private key.")
    except RecoveryError:
        raise
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, NotImplementedError):
        raise RecoveryError("Recovery ZIP could not be safely read.") from None
    if len(cipher) != 1 or len(recipient_key) != 1:
        raise RecoveryError("Recovery ZIP must contain the original CMS and exactly one encrypted recipient key.")
    return cipher[0], recipient_key[0]


def _tar_contents(raw: bytes) -> dict[str, bytes]:
    contents: dict[str, bytes] = {}
    total = 0
    try:
        # Bound gzip expansion before tarfile parses extended headers or allocates member data.
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
            unpacked = compressed.read(MAX_CONTENT_BYTES + 64_001)
        if len(unpacked) > MAX_CONTENT_BYTES + 64_000:
            raise RecoveryError("Recovered backup expands beyond the permitted size.")
        with tarfile.open(fileobj=io.BytesIO(unpacked), mode="r:") as archive:
            for member in archive:
                if (member.name not in TAR_NAMES or member.name in contents or not member.isreg()
                        or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                        or set(member.pax_headers) - {"mtime", "atime", "ctime"}
                        or not 0 < member.size <= MAX_MEMBER_BYTES):
                    raise RecoveryError("Recovered backup contains an unexpected or unsafe member.")
                total += member.size
                if total > MAX_CONTENT_BYTES:
                    raise RecoveryError("Recovered backup expands beyond the permitted size.")
                source = archive.extractfile(member)
                if source is None:
                    raise RecoveryError("Recovered backup contains an unreadable member.")
                with source:
                    content = source.read(MAX_MEMBER_BYTES + 1)
                if len(content) != member.size:
                    raise RecoveryError("Recovered backup has an invalid member size.")
                contents[member.name] = content
    except RecoveryError:
        raise
    except (OSError, ValueError, tarfile.TarError, EOFError):
        raise RecoveryError("Authenticated backup could not be safely read.") from None
    if set(contents) != TAR_NAMES:
        raise RecoveryError("Recovered backup is missing required members.")
    return contents


def _json_object(raw: bytes) -> dict:
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("duplicate")
            result[name] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise RecoveryError("Recovered signing metadata is invalid.") from None
    if not isinstance(value, dict):
        raise RecoveryError("Recovered signing metadata must be an object.")
    return value


def _credentials(signing: Mapping[str, str], key: Path) -> dict[str, str]:
    if set(signing) != set(CONFIG_NAMES):
        raise RecoveryError("Recovered signing configuration has an unexpected shape.")
    values = {name: _setting(signing, name) for name in CONFIG_NAMES}
    if not Path(values["SOUL_UPLOAD_KEYSTORE_PATH"]).is_absolute():
        raise RecoveryError("Recovered original keystore path is invalid.")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", values["SOUL_UPLOAD_KEY_ALIAS"]):
        raise RecoveryError("Recovered upload alias is invalid.")
    if any(len(value) > 4096 for value in values.values()):
        raise RecoveryError("Recovered signing setting is too large.")
    values["SOUL_UPLOAD_KEYSTORE_PATH"] = str(key)
    return values


def _recover(root: Path, private: Path, environ: Mapping[str, str]) -> tuple[bytes, dict[str, str]]:
    raw = _decode(_setting(environ, RECOVERY_NAMES[0]), MAX_ZIP_BYTES, MAX_BASE64_CHARS)
    password = _setting(environ, RECOVERY_NAMES[1])
    cipher, recipient_key = _zip_contents(raw)
    recipient = root / "release/first-upload/backup-recipient.pem"
    recipient_der = _run(["openssl", "x509", "-in", str(recipient), "-outform", "DER"])
    if hashlib.sha256(recipient_der).hexdigest() != RECIPIENT_SHA256:
        raise RecoveryError("Public backup-recipient certificate does not match the original.")
    encrypted = private / "recovery.cms"
    encrypted_key = private / "recipient.encrypted.pem"
    _write_private(encrypted, cipher)
    _write_private(encrypted_key, recipient_key)
    try:
        plain = _run([
            "openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(encrypted),
            "-recip", str(recipient), "-inkey", str(encrypted_key),
            "-passin", "env:SOUL_UPLOAD_RECOVERY_PASSWORD",
        ], {"SOUL_UPLOAD_RECOVERY_PASSWORD": password})
    finally:
        encrypted.unlink(missing_ok=True)
        encrypted_key.unlink(missing_ok=True)
    contents = _tar_contents(plain)
    metadata = _json_object(contents["metadata.json"])
    signing = _credentials(_json_object(contents["signing.json"]), private / "upload-keystore.jks")
    if (metadata.get("schemaVersion") != "1" or metadata.get("packageName") != PACKAGE
            or metadata.get("certificateSha256") != CERTIFICATE_SHA256
            or metadata.get("keyAlias") != signing["SOUL_UPLOAD_KEY_ALIAS"]):
        raise RecoveryError("Recovered backup metadata does not identify the original upload key.")
    return contents["upload-keystore.jks"], signing


def _prove_key(private: Path, signing: Mapping[str, str]) -> bytes:
    key, alias = signing["SOUL_UPLOAD_KEYSTORE_PATH"], signing["SOUL_UPLOAD_KEY_ALIAS"]
    tool_secrets = {name: signing[name] for name in ("SOUL_UPLOAD_KEYSTORE_PASSWORD", "SOUL_UPLOAD_KEY_PASSWORD")}
    certificate = _run([
        "keytool", "-exportcert", "-keystore", key, "-storetype", "JKS", "-alias", alias,
        "-storepass:env", "SOUL_UPLOAD_KEYSTORE_PASSWORD",
    ], tool_secrets)
    if not certificate or hashlib.sha256(certificate).hexdigest() != CERTIFICATE_SHA256:
        raise RecoveryError("Upload certificate does not match the original Play upload key.")
    probe = private / "private-key-check.jar"
    try:
        with zipfile.ZipFile(probe, "x") as archive:
            archive.writestr("proof.txt", b"SOUL READER upload private-key verification\n")
        probe.chmod(0o600)
        _run([
            "java", "-m", "jdk.jartool/sun.security.tools.jarsigner.Main",
            "-keystore", key, "-storetype", "JKS",
            "-storepass:env", "SOUL_UPLOAD_KEYSTORE_PASSWORD", "-keypass:env", "SOUL_UPLOAD_KEY_PASSWORD",
            str(probe), alias,
        ], tool_secrets)
        verified = _run(["java", "-Duser.language=en", "-Duser.country=US",
                         "-m", "jdk.jartool/sun.security.tools.jarsigner.Main", "-verify", str(probe)])
        if b"jar verified." not in verified or b"unsigned entries" in verified.lower():
            raise RecoveryError("Recovered private upload key could not verify a test signature.")
    finally:
        probe.unlink(missing_ok=True)
    return certificate


def _paths(root: Path, environ: Mapping[str, str]) -> tuple[Path, Path]:
    temporary = Path(_setting(environ, "RUNNER_TEMP"))
    if not temporary.is_absolute() or not temporary.is_dir() or temporary.is_symlink():
        raise RecoveryError("An existing absolute private runner temporary directory is required.")
    temporary = temporary.resolve()
    if temporary.is_relative_to(root.resolve()):
        raise RecoveryError("Private signing material must remain outside the checkout.")
    return temporary / PRIVATE_NAME, temporary / CERTIFICATE_NAME


def restore(project_root: Path, environ: Mapping[str, str]) -> None:
    root = project_root.resolve()
    version = _setting(environ, "SOUL_INTERNAL_VERSION_CODE")
    if not re.fullmatch(r"[1-9][0-9]{0,9}", version) or not 96 <= int(version) <= 2_100_000_000:
        raise RecoveryError("version_code must be an integer from 96 to 2100000000.")
    direct = any(environ.get(name) for name in DIRECT_NAMES)
    if direct:
        for name in DIRECT_NAMES:
            _setting(environ, name)
    else:
        for name in RECOVERY_NAMES:
            _setting(environ, name)
    private, public_certificate = _paths(root, environ)
    if private.exists() or private.is_symlink() or public_certificate.exists() or public_certificate.is_symlink():
        raise RecoveryError("Signing output paths must be new; existing files are never replaced.")
    private.mkdir(mode=0o700)
    private.chmod(0o700)
    certificate_created = False
    try:
        if direct:
            key_bytes = _decode(_setting(environ, DIRECT_NAMES[0]), MAX_MEMBER_BYTES, 4 * MAX_MEMBER_BYTES)
            signing = _credentials({
                "SOUL_UPLOAD_KEYSTORE_PATH": str(private / "upload-keystore.jks"),
                **{name: environ[name] for name in DIRECT_NAMES[1:]},
            }, private / "upload-keystore.jks")
        else:
            key_bytes, signing = _recover(root, private, environ)
        _write_private(private / "upload-keystore.jks", key_bytes)
        certificate = _prove_key(private, signing)
        pem = b"-----BEGIN CERTIFICATE-----\n" + base64.encodebytes(certificate) + b"-----END CERTIFICATE-----\n"
        _write_private(public_certificate, pem)
        certificate_created = True
        _write_private(private / "signing.json", (json.dumps(signing) + "\n").encode())
        environment_file = Path(_setting(environ, "GITHUB_ENV"))
        # Only nonsecret runner paths cross steps. Restored credentials never become action outputs or environment commands.
        with environment_file.open("a", encoding="utf-8") as output:
            output.write("SOUL_OWNER_SIGNING_CONFIG=" + str(private / "signing.json") + "\n")
            output.write("SOUL_UPLOAD_KEYSTORE_PATH=" + str(private / "upload-keystore.jks") + "\n")
    except BaseException:
        shutil.rmtree(private)
        if certificate_created:
            public_certificate.unlink(missing_ok=True)
        raise


def configure(project_root: Path, environ: Mapping[str, str]) -> None:
    private, _ = _paths(project_root, environ)
    config = private / "signing.json"
    key = private / "upload-keystore.jks"
    if (private.is_symlink() or not private.is_dir() or config.is_symlink() or not config.is_file()
            or key.is_symlink() or not key.is_file() or config.stat().st_size > 32_000
            or stat.S_IMODE(private.stat().st_mode) != 0o700
            or any(stat.S_IMODE(path.stat().st_mode) != 0o600 for path in (config, key))):
        raise RecoveryError("Private restored signing configuration is missing or unsafe.")
    supplied = environ.get("SOUL_OWNER_SIGNING_CONFIG")
    if supplied and supplied != str(config):
        raise RecoveryError("Only the fixed private signing configuration is accepted.")
    signing = _credentials(_json_object(config.read_bytes()), key)
    configure_release_signing(project_root, signing)


def main(argv: list[str] | None = None, project_root: Path | None = None,
         environ: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--configure", action="store_true")
    arguments = parser.parse_args(argv)
    try:
        action = configure if arguments.configure else restore
        action(project_root or Path(__file__).resolve().parents[1], os.environ if environ is None else environ)
    except RecoveryError as error:
        print("Owner upload signing failed: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Owner upload signing failed while processing private files; no credentials printed.", file=sys.stderr)
        return 1
    print("Original owner upload signing configured." if arguments.configure else
          "Original owner upload certificate and private-key password verified. No credentials printed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
