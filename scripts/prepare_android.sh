#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d android ]; then
  platform_dir=$(mktemp -d)
  trap 'rm -rf "$platform_dir"' EXIT
  flutter create --project-name soul_reader --org com.soulreader --platforms android --empty --no-pub "$platform_dir/soul_reader"
  cp -a "$platform_dir/soul_reader/android" ./android
fi
python3 scripts/configure_platforms.py
flutter pub get
