# Firebase Google 로그인 연결

프로젝트는 `soul-reader-a91f5`, Android 패키지는
`com.soulreader.soul_reader`입니다. Firebase 무료 Spark 요금제로 Google
로그인을 연결할 수 있습니다. 이 단계에는 90일 체험판이나 Google Cloud
결제 계정 생성이 필요하지 않습니다.

## Google 화면에서 소유자가 완료할 설정

1. Firebase 프로젝트의 **Authentication → 시작하기 → 로그인 방법 →
   Google**을 사용 설정합니다. 앱 공개 이름과 지원 이메일을 확인해 저장합니다.
2. Play Console **앱 서명** 화면의 **앱 서명 키 인증서 SHA-1**을 Firebase
   **프로젝트 설정 → 내 앱 → Android 앱 → 디지털 지문 추가**에 등록합니다.
   업로드 키 인증서와 Play 앱 서명 인증서는 다를 수 있습니다. Play에서
   설치한 앱에는 Play 앱 서명 인증서가 필요합니다. 개발용 APK를 따로
   시험할 때에는 해당 APK의 인증서도 등록합니다.
3. 갱신된 `google-services.json`을 내려받아
   `assets/firebase/google-services.json`으로 연결합니다. 이 파일은 공개
   Android 앱 설정입니다. 서비스 계정 비공개 JSON과 구분합니다.

앱은 Android 패키지, 프로젝트 번호, Firebase 앱 ID와 Web OAuth 클라이언트
ID를 검사합니다. OAuth 정보가 없거나 설정이 맞지 않으면 로그인과 구매가
비활성화됩니다. 갱신된 공개 설정을 `assets/firebase/google-services.json`에
연결했습니다. 프로젝트·패키지·Firebase 앱 ID와 Web OAuth 정보가 일치합니다.

소유자가 전달한 Play 인증서 SHA-1은
`5B:64:DA:B9:F4:D5:74:79:85:3D:BD:E6:10:D0:CD:2C:B6:47:A8:2F`입니다.
다운로드 당시 설정 파일의 Android OAuth 인증서에는
`64:89:75:50:D5:1B:03:FE:9F:2E:5E:36:D8:29:3B:93:3D:90:8A:1E`만
표시되어 있었습니다. 2026-10-28 소유자가 공유한 해당 Android 앱의 Firebase
설정 화면에서 기존 `64:89…`와 새 `5B:64…` SHA-1이 모두 등록된 것을
확인했습니다. 지문 등록 확인은 완료했습니다. 현재 앱은 명시적인
FirebaseOptions와 기존 Web OAuth 클라이언트 ID를 사용하며 Android OAuth
인증서 메타데이터를 읽지 않으므로 SHA-1 추가만으로 JSON 재다운로드나
재빌드가 필요하지 않습니다. JSON 값을 직접 바꾸지 않습니다. 실제 Play
앱 서명 인증서와 일치하는지는 Play 설치 앱의 Google 로그인에서 확인합니다.

## 구현 범위

사용자가 로그인 버튼을 누를 때만 Google 계정 선택 창을 엽니다. 앱 시작,
무료 화면과 구매 상태 조회에서는 로그인 창을 열지 않습니다. Firebase ID
토큰은 네이티브에서 갱신해 HTTPS 서버에 전달합니다. 토큰, 사용자 식별자와
구매 영수증은 WebView로 보내지 않습니다.

계정 전환과 로그아웃은 화면의 구매 권한과 이전 계정의 비동기 응답을
초기화합니다. 미완료 구매 문맥은 계정별 파일로 분리합니다. 결제창이 진행
중이면 명시적인 계정 전환을 막습니다.

Firebase 설정만으로 실제 구매가 열리지는 않습니다. 구매 검증 서버,
Google Play API 권한, 영구 원장과 실제 기기 검증이 필요합니다. 기본 서버
주소는 비어 있습니다. 자동 테스트는 실제 로그인과 실제 구매 검증을 대신하지
않습니다. 공개 출시 전에 개인정보처리방침, 데이터 보안 신고와 계정 삭제
절차를 최종 인증 동작에 맞춰 완료합니다.

공개 설정용 빌드 옵션은 `FIREBASE_API_KEY`, `FIREBASE_APP_ID`,
`FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`,
`GOOGLE_WEB_CLIENT_ID`입니다. 사용자 토큰이나 서버 비공개 키를 앱 설정에
넣지 않습니다. 네이티브 SDK는 명시적인 FirebaseOptions와 Web 클라이언트
ID를 사용하므로 Firebase 안내 화면의 Gradle 수정은 별도로 필요하지 않습니다.

## 확인한 결과

갱신된 설정 파일을 반영한 `55b08ad`의 [CI 40616936062](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40616936062)가 통과했습니다. 실제 번들 자산을 기본 로더로 읽는 테스트, 전체 Flutter 테스트, Dart 분석, Chromium·Python 검사, release AAB 컴파일과 debug APK 빌드·서명·원본 음원 검사가 포함됩니다. 이 결과는 설정 파일의 포함과 앱 빌드를 검증하며 Google 계정으로 실제 로그인한 결과는 아닙니다.

기존 Play 버전 95에는 새 로그인 코드가 없으므로 실제 시험에는 원래 업로드
키를 재사용한 버전 96 이상의 AAB를 내부 테스트에서 설치해야 합니다.
현재 작업 환경에는 원래 비공개 키가 없으며 안전한 복원이 필요합니다.
CI 개발용 APK는 별도 인증서이므로 Play 앱의 지문 등록으로 로그인 시험을
대신하지 않습니다. 원래 업로드 키를 재생성하지 않습니다.

소유자는 Cloudflare 계정이 없다고 확인했습니다. 다음 단계는 무료 계정
가입 후 구매 검증 서버의 계정 인증·D1 구성·보안 런타임 설정 연결입니다.

앱 연결 코드 `b33be78`의 [CI 40596026771](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40596026771)에서 Dart 분석, 전체 Flutter 테스트, Chromium·Python 검사, release AAB 컴파일, debug APK 빌드와 서명·원본 음원 검사가 통과했습니다. 임시 CI 키로 만든 release AAB는 업로드용으로 배포하지 않습니다.

별도 서버 검사 66개와 Wrangler 배포 없는 번들 생성, 로컬 D1 마이그레이션 16개 SQL 명령 및 재실행 검사를 통과했습니다. 설치·재실행 환경 설정도 저장했습니다. 실제 Firebase 로그인·외부 서버 배포·Google Play 구매·정식 출시는 검증 범위에 포함되지 않습니다.
