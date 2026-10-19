# SOUL READER 7.1 — Android + iPhone 공용 ML Kit 연결 소스

**상태: 소스 코드 제작 완료 / 실제 빌드 및 기기 검증 미완료.**

이 폴더는 휴대폰에서 ZIP을 누르면 실행되는 파일이 아니라, **Flutter 개발 환경에서 안드로이드 APK/AAB와 iOS 앱을 만드는 소스 프로젝트**입니다. 사용자가 안드로이드·아이폰 두 기종 출시를 목표로 했기 때문에, 앱 제작의 공통 기반으로 작성했습니다.

## 이번에 들어간 기능

- `assets/web/index.html`: 기존 SOUL READER의 다국어 UI·스토리·관상 화면
- `assets/web/audio`: **류 대사 69개 + BGM 1개** (사용자가 제공한 원본 음원, 총 70개)
- `lib/main.dart`: Android/iOS 공통 화면, 기기 카메라·갤러리 호출, 사진 이미지 정규화, 웹 UI와 원시 ML Kit 분석 결과 연결
- `lib/face_measure.dart`: `google_mlkit_face_detection` 얼굴 감지 및 눈·코·입·윤곽 특징 측정; 여러 얼굴·비정면·부위 누락 시 오류를 보여줌
- **오류 원인이었던 `unpkg`/`jsDelivr` 원격 MediaPipe 코드 로딩 제거.** 스마트폰 앱 내부의 네이티브 ML Kit 사용을 시도하도록 변경
- 사진은 분석 중 임시 파일로만 저장하고 분석 후 삭제하며, 네트워크 서버로 업로드하는 코드는 추가하지 않음
- 기존의 무료·500원·1,900원은 여전히 **시연용**, 실제 결제 기능 없음

## 빌드 준비 (개발자용)

필수: Flutter SDK, Android Studio/SDK, 인터넷 연결(개발 중 플러그인·빌드 의존성 최초 설치용). iOS 빌드는 **macOS + Xcode + CocoaPods** 필요.

최신 Face Detection Flutter 플러그인은 최소 **Flutter 3.44 / Dart 3.12**를 요구합니다. iOS 최소 버전은 15.5입니다. Android는 이 소스에서 minSdk 24로 설정합니다.

### Android (macOS/Linux/Windows에서 가능)

```bash
cd SOUL_READER_7_1_Flutter_MLKit
# Windows는 다음 scripts/create_platform_projects.sh 대신 동등한 명령을 실행하세요.
flutter create --project-name soul_reader --org com.soulreader --platforms android,ios .
python scripts/configure_platforms.py
flutter pub get
flutter analyze
flutter run
flutter build apk --debug
# 실제 플레이스토어 등록용은 서명 설정 후 flutter build appbundle --release
```

### iPhone (Mac에서만 가능)

```bash
flutter create --project-name soul_reader --org com.soulreader --platforms android,ios .
python3 scripts/configure_platforms.py
flutter pub get
cd ios && pod install && cd ..
flutter run
# Apple 개발자 계정 서명 설정 이후 flutter build ipa
```

> `flutter create`는 이 소스 프로젝트에 아직 없는 `android/`, `ios/` 프로젝트를 생성하는 과정입니다. 기존 `lib/`, `assets/`, `pubspec.yaml`은 보존되어야 하며 실행 전에 파일을 백업하세요. `scripts/configure_platforms.py`는 생성된 기본 설정 파일에 카메라·갤러리 사용 설명 및 SDK 최소 버전을 추가합니다.

## 실제 갤럭시에서 확인할 것

1. 앱 실행 → 사진 촬영 챕터 → 사진 사용 안내 동의
2. Flutter 하단의 **사진 촬영** 또는 **갤러리** 버튼 → 정면 사진 선택
3. 앱 내부 ML Kit이 눈·코·입·얼굴 윤곽을 찾으면 `분석 완료` / 특징 제안 표시
4. 얼굴이 없거나 눈·코·입 윤곽이 부족하면 결과를 꾸며내지 않고 오류 표시
5. 무료 풀이·500원·1,900원 시연 장면 및 3개국어 음성, BGM이 모두 유지되는지 검사
6. iPhone에서도 같은 흐름 검사

## 주의할 점

- **이 작업 환경에는 Flutter·Android SDK·Xcode가 없어서 `flutter analyze`, APK 생성, 실기기 카메라/ML Kit, 오디오 재생 테스트를 실행하지 못했습니다.** 빌드 호환성은 아직 검증되지 않았습니다.
- ML Kit 플러그인을 처음 빌드할 때 개발 컴퓨터가 Maven/CocoaPods/Flutter 저장소에 접근해야 합니다. **최종 설치 앱에서 원격 MediaPipe CDN을 필요로 하지는 않습니다.**
- 두 운영체제의 이미지 디코딩·WebView 파일 재생·권한 동작은 실제 기기에서 반드시 확인해야 합니다.
- ML Kit으로 관찰한 비율은 얼굴의 **외형 측정**이지 성격·재물·연애·운명을 판정하는 기술이 아닙니다. 결과는 전통 관상의 상징에서 영감을 받은 오락 콘텐츠입니다. 이 구현의 비율 구간은 검증된 임상 또는 인구통계 기준이 아닌 초기 UI용 기준값입니다.
- 사진이 실제로 업로드되지 않는지, 개인정보 처리방침·미성년자 안전·구매 복원·과금 등은 배포 전 별도로 검토해야 합니다.
- Flutter 앱에서 사용한 WebView 방식만으로 플레이스토어/앱스토어 심사를 통과한다는 보장은 없습니다. 실제 결제는 각 앱스토어 요건에 맞게 연결해야 합니다.

## 파일 설명

- `pubspec.yaml` — 의존성 버전과 Flutter 에셋
- `lib/main.dart` — 사진 촬영/갤러리 네이티브 버튼, WebView ↔ Dart 메시지
- `lib/face_measure.dart` — ML Kit 검출 및 측정
- `assets/web/index.html` — SOUL READER 게임 웹 UI + ML Kit JavaScript 브리지
- `scripts/create_platform_projects.sh` — Flutter 프로젝트 준비(macOS/Linux)
- `scripts/configure_platforms.py` — Android/iOS 설정
