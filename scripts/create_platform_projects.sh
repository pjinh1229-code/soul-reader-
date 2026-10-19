#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v flutter >/dev/null; then
  echo 'Flutter SDK가 필요합니다: https://docs.flutter.dev/get-started/install' >&2
  exit 1
fi
flutter create --project-name soul_reader --org com.soulreader --platforms android,ios .
python3 scripts/configure_platforms.py
flutter pub get
flutter analyze
echo 'Android: flutter build apk --debug'
echo 'iOS: macOS + Xcode에서 flutter build ios --no-codesign'
