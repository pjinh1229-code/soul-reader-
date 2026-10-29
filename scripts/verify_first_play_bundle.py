#!/usr/bin/env python3
"""Verify an owner-signed SOUL READER AAB and write public build facts."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import verify_assets


BUNDLETOOL_SHA256 = '378b5434cd1378bef6b2bc527b8c7f0ff2584b273830335bce54d6d0813c8584'
PACKAGE = 'com.soulreader.soul_reader'
VERSION_CODE = 95
VERSION_NAME = '8.5.6'
ANDROID = '{http://schemas.android.com/apk/res/android}'
BILLING_PERMISSION = 'com.android.vending.BILLING'
BILLING_METADATA = 'com.google.android.play.billingclient.version'
CERTIFICATE_PATTERN = re.compile(
    r'-----BEGIN CERTIFICATE-----\s*(.*?)\s*-----END CERTIFICATE-----', re.S)


class BundleVerificationError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _version_code(value: int | str) -> int:
    if isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,9}', value):
        value = int(value)
    if type(value) is not int or not 1 <= value <= 2100000000:
        raise BundleVerificationError('Expected version code must be an integer from 1 to 2100000000.')
    return value


def _certificate_sha256(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        raise BundleVerificationError('Expected certificate SHA-256 must contain exactly 64 hexadecimal characters.')
    return value.lower()


def _run(command: list[str], label: str, *, include_stderr: bool = False) -> str:
    # These tools inspect public artifacts. Do not forward CI signing passwords.
    environment = {name: os.environ[name] for name in
                   ('PATH', 'JAVA_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT')
                   if name in os.environ}
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                timeout=180, env=environment)
    except (OSError, subprocess.SubprocessError):
        raise BundleVerificationError(f'{label} could not be executed.') from None
    if result.returncode:
        raise BundleVerificationError(f'{label} failed.')
    output = result.stdout + ('\n' + result.stderr if include_stderr else '')
    if len(output) > 16 * 1024 * 1024:
        raise BundleVerificationError(f'{label} returned excessive output.')
    return output


def validate_manifest(xml: str, expected_version_code: int = VERSION_CODE) -> dict:
    expected_version_code = _version_code(expected_version_code)
    if '<!DOCTYPE' in xml.upper():
        raise BundleVerificationError('Manifest document types are not permitted.')
    try:
        manifest = ET.fromstring(xml)
    except ET.ParseError:
        raise BundleVerificationError('Bundle manifest is not valid XML.') from None
    if manifest.tag != 'manifest' or manifest.get('package') != PACKAGE:
        raise BundleVerificationError('Bundle package does not match SOUL READER.')
    if manifest.get(ANDROID + 'versionCode') != str(expected_version_code):
        raise BundleVerificationError(f'Bundle version code must be {expected_version_code}.')
    if manifest.get(ANDROID + 'versionName') != VERSION_NAME:
        raise BundleVerificationError('Bundle version name must be 8.5.6.')
    applications = manifest.findall('application')
    if len(applications) != 1:
        raise BundleVerificationError('Bundle must contain exactly one application.')
    application = applications[0]
    if application.get(ANDROID + 'debuggable') not in (None, 'false'):
        raise BundleVerificationError('Bundle must not be debuggable.')
    permissions = [item for item in manifest.findall('uses-permission')
                   if item.get(ANDROID + 'name') == BILLING_PERMISSION]
    if not any(item.get(ANDROID + 'maxSdkVersion') is None for item in permissions):
        raise BundleVerificationError('Bundle is missing an unrestricted BILLING permission.')
    metadata = [item for item in application.findall('meta-data')
                if item.get(ANDROID + 'name') == BILLING_METADATA]
    version = metadata[0].get(ANDROID + 'value', '') if len(metadata) == 1 else ''
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', version):
        raise BundleVerificationError('Bundle billing-client version metadata is missing or invalid.')
    return {
        'packageName': PACKAGE,
        'versionCode': expected_version_code,
        'versionName': VERSION_NAME,
        'debuggable': False,
        'billingPermission': BILLING_PERMISSION,
        'billingClientVersion': version,
    }


def _certificate_der(text: str) -> bytes:
    certificates = CERTIFICATE_PATTERN.findall(text)
    # The first-upload key is a self-signed leaf. Extra signers/chains are unexpected.
    if len(certificates) != 1:
        raise BundleVerificationError('Exactly one upload certificate is required.')
    try:
        value = base64.b64decode(re.sub(r'\s+', '', certificates[0]), validate=True)
    except ValueError:
        raise BundleVerificationError('Upload certificate encoding is invalid.') from None
    if not value:
        raise BundleVerificationError('Upload certificate is empty.')
    return value


def verify_signature(bundle: Path, certificate: Path,
                     expected_certificate_sha256: str | None = None) -> str:
    expected_certificate_sha256 = _certificate_sha256(expected_certificate_sha256)
    expected = _certificate_der(certificate.read_text(encoding='ascii'))
    if (expected_certificate_sha256 is not None
            and hashlib.sha256(expected).hexdigest() != expected_certificate_sha256):
        raise BundleVerificationError('Public upload certificate does not match the expected SHA-256.')
    verification = _run([
        'java', '-Duser.language=en', '-Duser.country=US', '-m',
        'jdk.jartool/sun.security.tools.jarsigner.Main', '-verify', '-verbose',
        '-certs', str(bundle)], 'Bundle JAR signature verification', include_stderr=True)
    if not re.search(r'^jar verified\.\s*$', verification, re.M):
        raise BundleVerificationError('Bundle does not have a verified JAR signature.')
    if re.search(r'unsigned entr(?:y|ies)|treated as unsigned', verification, re.I):
        raise BundleVerificationError('Bundle contains unsigned entries or disabled signatures.')
    printed = _run(['keytool', '-printcert', '-jarfile', str(bundle), '-rfc'],
                   'Bundle signing-certificate inspection')
    actual = _certificate_der(printed)
    if actual != expected:
        raise BundleVerificationError('Bundle signing certificate does not match the upload key.')
    description = _run(['keytool', '-J-Duser.language=en', '-J-Duser.country=US',
                        '-printcert', '-file', str(certificate)],
                       'Upload-certificate inspection')
    if re.search(r'CN\s*=\s*Android Debug(?:\s*[,\r\n]|$)', description, re.I):
        raise BundleVerificationError('Android debug upload certificates are not permitted.')
    return hashlib.sha256(actual).hexdigest()


def verify_bundle(bundle: Path, bundletool: Path, certificate: Path,
                  project_root: Path | None = None, *,
                  expected_version_code: int = VERSION_CODE,
                  expected_certificate_sha256: str | None = None) -> dict:
    expected_version_code = _version_code(expected_version_code)
    expected_certificate_sha256 = _certificate_sha256(expected_certificate_sha256)
    if sha256_file(bundletool) != BUNDLETOOL_SHA256:
        raise BundleVerificationError('Official bundletool SHA-256 does not match the pinned release.')
    _run(['java', '-jar', str(bundletool), 'validate', '--bundle=' + str(bundle)],
         'Bundletool validation')
    xml = _run(['java', '-jar', str(bundletool), 'dump', 'manifest',
                '--bundle=' + str(bundle), '--module=base'], 'Bundle manifest inspection')
    info = validate_manifest(xml, expected_version_code)
    info['uploadCertificateSha256'] = verify_signature(bundle, certificate,
                                                     expected_certificate_sha256)
    root = project_root or Path(__file__).resolve().parent.parent
    expected = verify_assets.verify_source(root)
    if len(expected) != 70 or verify_assets.verify_archive(bundle, expected) != 'AAB':
        raise BundleVerificationError('Expected 70 original audio files inside an AAB.')
    info['originalAudioFiles'] = 70
    info['aabSha256'] = sha256_file(bundle)
    source_commit = os.environ.get('GITHUB_SHA')
    if source_commit:
        if not re.fullmatch(r'[0-9a-fA-F]{40}|[0-9a-fA-F]{64}', source_commit):
            raise BundleVerificationError('Source commit metadata is invalid.')
        info['sourceCommit'] = source_commit.lower()
    return info


def _write_public_report(path: Path, info: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.build-info-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            json.dump(info, output, indent=2, ensure_ascii=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--bundletool', required=True, type=Path)
    parser.add_argument('--certificate', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--version-code', default=str(VERSION_CODE),
                        help='Expected Android version code (default: 95).')
    parser.add_argument('--certificate-sha256',
                        help='Expected upload-certificate SHA-256, as 64 hexadecimal characters.')
    args = parser.parse_args(argv)
    try:
        expected_version_code = _version_code(args.version_code)
        expected_certificate_sha256 = _certificate_sha256(args.certificate_sha256)
        if args.output.is_symlink() or args.output.resolve() in {
                args.bundle.resolve(), args.bundletool.resolve(), args.certificate.resolve()}:
            raise BundleVerificationError('Public report must not replace a verification input.')
        info = verify_bundle(args.bundle, args.bundletool, args.certificate,
                             expected_version_code=expected_version_code,
                             expected_certificate_sha256=expected_certificate_sha256)
        _write_public_report(args.output, info)
    except (BundleVerificationError, verify_assets.VerificationError) as error:
        print('First Play bundle verification failed: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        # No filesystem paths, child-process output or credentials in failure reports.
        print('First Play bundle verification failed while reading public artifacts.', file=sys.stderr)
        return 1
    print(json.dumps(info, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
