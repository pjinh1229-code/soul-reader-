import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('verify_assets', ROOT / 'scripts/verify_assets.py')
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
EXPECTED = json.loads((ROOT / 'scripts/audio_sha256.json').read_text())


class VerifyAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / 'artifact.zip'

    def write_archive(self, prefix, *, omit=None, corrupt=None, extra=None):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            for name in EXPECTED:
                if name == omit:
                    continue
                if name == corrupt:
                    archive.writestr(prefix + name, b'changed audio')
                else:
                    archive.write(ROOT / name, prefix + name)
            if extra:
                archive.writestr(extra, b'extra')

    def test_original_source_inventory_and_hashes(self):
        verified = VERIFY.verify_source(ROOT)
        self.assertEqual(len(verified), 70)
        self.assertEqual(verified, EXPECTED)

    def test_apk_and_aab_content_detection_does_not_require_extension(self):
        for kind, prefix in [('APK', 'assets/flutter_assets/'),
                             ('AAB', 'base/assets/flutter_assets/')]:
            with self.subTest(kind=kind):
                self.write_archive(prefix)
                self.assertEqual(VERIFY.verify_archive(self.archive, EXPECTED), kind)

    def test_corrupt_audio_rejected_in_both_layouts(self):
        for prefix in ['assets/flutter_assets/', 'base/assets/flutter_assets/']:
            with self.subTest(prefix=prefix):
                self.write_archive(prefix, corrupt=next(iter(EXPECTED)))
                with self.assertRaisesRegex(VERIFY.VerificationError, 'audio changed:'):
                    VERIFY.verify_archive(self.archive, EXPECTED)

    def test_missing_audio_rejected_in_both_layouts(self):
        for prefix in ['assets/flutter_assets/', 'base/assets/flutter_assets/']:
            with self.subTest(prefix=prefix):
                self.write_archive(prefix, omit=next(iter(EXPECTED)))
                with self.assertRaisesRegex(VERIFY.VerificationError, 'inventory changed or incomplete'):
                    VERIFY.verify_archive(self.archive, EXPECTED)

    def test_extra_audio_rejected(self):
        self.write_archive('base/assets/flutter_assets/',
                           extra='base/assets/flutter_assets/assets/web/audio/new.mp3')
        with self.assertRaisesRegex(VERIFY.VerificationError, 'inventory changed or incomplete'):
            VERIFY.verify_archive(self.archive, EXPECTED)

    def test_full_layout_plus_partial_other_layout_is_ambiguous(self):
        self.write_archive('base/assets/flutter_assets/',
                           extra='assets/flutter_assets/' + next(iter(EXPECTED)))
        with self.assertRaisesRegex(VERIFY.VerificationError, 'ambiguous'):
            VERIFY.verify_archive(self.archive, EXPECTED)

    def test_duplicate_zip_paths_rejected_even_outside_audio(self):
        self.write_archive('assets/flutter_assets/')
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(self.archive, 'a') as archive:
                archive.writestr('other.txt', b'one')
                archive.writestr('other.txt', b'two')
        with self.assertRaisesRegex(VERIFY.VerificationError, 'duplicate ZIP paths'):
            VERIFY.verify_archive(self.archive, EXPECTED)

    def test_unknown_layout_rejected(self):
        with zipfile.ZipFile(self.archive, 'w') as archive:
            archive.writestr('unrecognized/audio.mp3', b'audio')
        with self.assertRaisesRegex(VERIFY.VerificationError, 'no APK or AAB'):
            VERIFY.verify_archive(self.archive, EXPECTED)

    def test_source_missing_extra_and_modified_audio_rejected(self):
        copied_root = self.directory / 'source'
        shutil.copytree(ROOT / 'assets/web/audio', copied_root / 'assets/web/audio')
        (copied_root / 'scripts').mkdir()
        shutil.copyfile(ROOT / 'scripts/audio_sha256.json', copied_root / 'scripts/audio_sha256.json')
        self.assertEqual(VERIFY.verify_source(copied_root), EXPECTED)
        sample = copied_root / next(iter(EXPECTED))
        original = sample.read_bytes()
        sample.unlink()
        with self.assertRaisesRegex(VERIFY.VerificationError, 'inventory changed'):
            VERIFY.verify_source(copied_root)
        sample.write_bytes(original)
        extra = copied_root / 'assets/web/audio/extra.mp3'
        extra.write_bytes(b'extra')
        with self.assertRaisesRegex(VERIFY.VerificationError, 'inventory changed'):
            VERIFY.verify_source(copied_root)
        extra.unlink()
        sample.write_bytes(b'corrupt')
        with self.assertRaisesRegex(VERIFY.VerificationError, 'Audio changed:'):
            VERIFY.verify_source(copied_root)

    def test_cli_reports_aab_and_malformed_archive_fails_without_traceback(self):
        self.write_archive('base/assets/flutter_assets/')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify_assets.py'),
                                 str(self.archive)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('70 original audio/BGM files inside AAB', result.stdout)
        self.archive.write_bytes(b'not a zip')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify_assets.py'),
                                 str(self.archive)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
