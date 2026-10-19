# SOUL READER 7.2 통합 프로젝트 — 실제 상태

**실행 앱(APK/IPA)이 아닌 Android + iOS 공용 Flutter 개발 프로젝트입니다.** ZIP을 휴대폰에서 클릭해 실행할 수 없습니다. Flutter SDK 및 Android Studio / Mac + Xcode에서 빌드해야 설치 앱이 됩니다. 이 작업 환경에는 Flutter, Android SDK, Xcode가 없어 빌드와 갤럭시·아이폰 실기기 테스트를 수행하지 못했습니다. 따라서 얼굴 인식 성공 및 출시 준비 완료를 주장하지 않습니다.

## 실제로 통합된 파일

- `assets/web/index.html` : 기존 SOUL READER 관상·스토리·한국어/영어/일본어 화면, 데모 구매 흐름
- `assets/web/audio` : BGM 1개와 기존 류 음성 69개
- `lib/main.dart` : 네이티브 사진 선택 → PNG 정규화 → WebView 사진 전달 → FaceScan 메시지 → ML Kit 결과 전달
- `lib/face_measure.dart` : 기기 내 얼굴 윤곽 탐지 및 **시험용 비율 계산**
- `BUILD_ANDROID_WINDOWS.bat` : 개발 도구가 설치된 Windows PC에서 Android 디버그 APK 생성 시도
- `BUILD_IOS_MAC.sh` : Mac 개발 환경에서 iOS 플랫폼 생성 및 코드 분석

## 어떻게 진짜로 실행하나?

- Windows PC: Flutter SDK + Android Studio 설치 후 `BUILD_ANDROID_WINDOWS.bat`. 성공하면 `build/app/outputs/flutter-apk/app-debug.apk` 생성. 개발용 APK이므로 Play Store 등록용 아님.
- Mac: Flutter SDK + Xcode 설치 후 `BUILD_IOS_MAC.sh` 실행, 연결된 iPhone에서 `flutter run`. iOS 개발 서명 필수.
- 실사용 배포 전 Flutter 빌드 성공 → 테스트 기기에서 **실제 사진 인식·사진 보관 정책·BGM·음성·결제** 순으로 검증.

**한계:** 얼굴 비율은 관찰 가능한 외형의 시험용 지표일 뿐 성격·운세의 과학적 측정이 아닙니다. 500원·1,900원은 아직 가짜 결제 흐름입니다. 앱스토어 출시용 결제 및 구매 복원, 개인정보 정책, 카메라 권한, iOS 서명 등의 작업이 남아 있습니다.
