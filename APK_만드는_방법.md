# SOUL READER 7.3 — APK 자동 빌드 준비본

**이 ZIP은 APK가 아닙니다.** 이 환경에는 Flutter 및 Android SDK가 없고 SDK 다운로드 DNS도 차단되어 실제 APK를 만들거나 갤럭시에서 시험하지 못했습니다.

이 프로젝트는 SOUL READER 7.2의 화면·음성(69개)·BGM·ML Kit 얼굴 인식 코드를 그대로 포함하고, **GitHub Actions에서 APK를 만들어 내려받을 수 있게 하는 자동 빌드 파일**(`.github/workflows/build-android.yml`)을 추가한 것입니다.

## APK 만드는 가장 간단한 순서 (컴퓨터 필요)
1. GitHub.com에서 빈 **Private repository** 생성. README 자동 추가는 끄는 게 단순합니다.
2. 이 ZIP을 압축 해제하고 폴더의 **내용물**(`lib`, `assets`, `pubspec.yaml`, `scripts`, `.github` 포함)을 저장소 루트에 업로드. 숨김 폴더 `.github`도 반드시 포함해야 합니다. 웹 업로드가 어려우면 GitHub Desktop을 사용해도 됩니다.
3. 저장소의 **Actions → Build SOUL READER Android test APK → Run workflow**를 실행.
4. 성공 시 워크플로 실행 페이지의 **Artifacts → SOUL_READER_ANDROID_TEST_APK**를 다운로드하고 압축 해제해 `app-debug.apk`를 갤럭시에 설치.
5. **빌드 실패 시**, Actions 로그를 보내주면 로그를 기준으로 수정해야 합니다. 성공을 보장하지 않습니다.

앱은 아직 테스트용이고 Google Play 등록을 위한 출시 서명/구매 연동/개인정보 정책/실기기 안정성 검증은 완료되지 않았습니다. iOS는 Mac + Xcode 빌드가 별도로 필요합니다. 사진 외형 측정 결과는 전통문화 기반 엔터테인먼트이며 성격·운명 판정이 아닙니다.

**주의:** GitHub 저장소에 올리는 음성 녹음과 앱 콘텐츠를 공개하고 싶지 않다면 반드시 Private 저장소로 만드세요.
