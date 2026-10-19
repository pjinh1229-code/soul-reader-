#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v flutter >/dev/null || { echo 'Flutter SDK required'; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 required'; exit 1; }
flutter create --project-name soul_reader --org com.soulreader --platforms ios .
python3 scripts/configure_platforms.py
flutter pub get
flutter analyze
echo 'Run flutter run on a connected iPhone. Apple signing is required for distribution.'
