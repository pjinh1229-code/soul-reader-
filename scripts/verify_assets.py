import hashlib
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path


class VerificationError(ValueError):
    pass


def verify_source(root):
    expected = json.loads((root / 'scripts/audio_sha256.json').read_text())
    actual = {
        p.relative_to(root).as_posix()
        for p in (root / 'assets/web/audio').rglob('*.mp3')
    }
    if actual != set(expected):
        raise VerificationError('Audio inventory changed')
    for name, checksum in expected.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != checksum:
            raise VerificationError(f'Audio changed: {name}')
    return expected


def verify_archive(archive_path, expected):
    layouts = {
        'APK': 'assets/flutter_assets/',
        'AAB': 'base/assets/flutter_assets/',
    }
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if any(count > 1 for count in Counter(names).values()):
            raise VerificationError('Archive contains duplicate ZIP paths')
        audio = {
            kind: {
                name[len(prefix):]
                for name in names
                if name.startswith(prefix + 'assets/web/audio/')
                and name.endswith('.mp3')
            }
            for kind, prefix in layouts.items()
        }
        present = [kind for kind, inventory in audio.items() if inventory]
        if len(present) > 1:
            raise VerificationError('Archive contains ambiguous APK and AAB audio layouts')
        if not present:
            raise VerificationError('Archive contains no APK or AAB Flutter audio layout')
        kind = present[0]
        if audio[kind] != set(expected):
            raise VerificationError(f'{kind} audio inventory changed or incomplete')
        for name, checksum in expected.items():
            digest = hashlib.sha256()
            with archive.open(layouts[kind] + name) as asset:
                for chunk in iter(lambda: asset.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != checksum:
                raise VerificationError(f'{kind} audio changed: {name}')
        return kind


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) > 1:
        print('Usage: verify_assets.py [app.apk|app.aab]', file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parent.parent
    try:
        expected = verify_source(root)
        kind = verify_archive(args[0], expected) if args else None
    except VerificationError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, zipfile.BadZipFile, RuntimeError, ValueError, KeyError):
        print('Cannot read audio manifest, source files or APK/AAB archive', file=sys.stderr)
        return 1
    suffix = f' inside {kind}' if kind else ''
    print(f'Verified {len(expected)} original audio/BGM files{suffix}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
