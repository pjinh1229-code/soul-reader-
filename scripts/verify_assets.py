import hashlib
import json
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
expected = json.loads((root / 'scripts/audio_sha256.json').read_text())
actual = {str(p.relative_to(root)) for p in (root / 'assets/web/audio').rglob('*.mp3')}
if actual != set(expected):
    raise SystemExit('Audio inventory changed')
for name, checksum in expected.items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != checksum:
        raise SystemExit(f'Audio changed: {name}')
if len(sys.argv) > 1:
    with zipfile.ZipFile(sys.argv[1]) as apk:
        for name, checksum in expected.items():
            data = apk.read('assets/flutter_assets/' + name)
            if hashlib.sha256(data).hexdigest() != checksum:
                raise SystemExit(f'APK audio changed: {name}')
print(f'Verified {len(expected)} original audio/BGM files' + (' inside APK' if len(sys.argv) > 1 else ''))
