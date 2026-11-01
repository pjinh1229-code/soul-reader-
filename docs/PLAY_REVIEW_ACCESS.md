# SOUL READER 심사용 접근 등록

일반 사용자는 기존 Google 로그인과 Google Play 구매를 이용합니다. 검토용 접근은 별도 비밀번호로 **같은 실제 사진 풀이와 네 주제 콘텐츠**를 확인하는 기능입니다. 심사자·기기·지역을 감지해 화면을 숨기거나 바꾸지 않습니다. 검토용 계정으로 실제 구매, 결제 영수증, 구매 내역을 만들지 않습니다.

## 현재 확인 범위

- 검토용 접근 기능은 새 앱 **8.5.6+98**에 포함합니다. 기존 v96·v97에는 없습니다.
- [v98 빌드](https://github.com/pjinh1229-code/soul-reader-/actions/runs/41269282887)는 네이티브 분석·테스트, 원래 서명·버전 98·음원 70개 검사 및 아티팩트 업로드를 통과했습니다. GitHub에 로그인해 Artifacts의 `SOUL_READER_8.5.6_INTERNAL_BILLING_AAB`를 받으면 `SOUL_READER_8.5.6_INTERNAL_BILLING_98.aab`가 들어 있습니다. 제출할 기존 파일 대신 이 기능이 포함된 파일을 사용합니다.
- [최신 서버 배포 후 검사](https://github.com/pjinh1229-code/soul-reader-/actions/runs/41269552828)는 코드 준비 페이지와 빈 코드 거부 경로를 확인했습니다. 이때 실제 운영 코드는 아직 등록되지 않아 검토용 로그인은 잠긴 상태였습니다. 코드 등록·실제 앱 확인 완료를 의미하지 않습니다.
- 서버에 `PLAY_REVIEW_ACCESS_CODE`가 없으면 검토용 로그인이 거부됩니다. 새 코드 생성 페이지를 열었다고 서버에 자동 등록되는 것이 아닙니다.
- 코드와 실제 앱으로 접근 확인을 마치기 전에는 Console의 ‘모든 기능과 콘텐츠에 대한 전체 액세스 권한’ 확인란을 선택하지 않습니다.

2026-11-01 소유자가 코드 등록과 준비 페이지 연결 확인을 완료했습니다. Play Console의 버전 98 내부 테스트 제공 상태를 확인했고, 새 앱의 검토용 접근 배너 스크린샷과 네 주제가 결제 없이 열린다는 소유자 확인을 받았습니다. 실제 비밀번호는 Codex에 전달되지 않았습니다. 아래 준비 절차를 이미 마쳤다면 같은 코드를 유지하고 **4번 Console 입력**으로 진행합니다.

## 1. 코드 생성과 보관

브라우저에서 다음 주소를 엽니다. 실제 배포 후 접속 검사가 완료됐는지도 확인합니다.

```text
https://soul-reader-billing.jgw98541706.workers.dev/setup/review-access
```

**새 코드 만들기 → 코드 보관 파일 저장** 순서로 누르면 휴대폰에 `SOUL_READER_REVIEW_ACCESS_PRIVATE.txt` 파일을 저장할 수 있습니다. 비밀번호 관리자를 이용해도 됩니다. 보관 파일에는 코드가 그대로 들어 있으므로 본인의 기기에만 두고 채팅이나 공개 저장소에 보내지 않습니다. 코드는 사용자의 브라우저에서 생성합니다. 탭을 바꾸면 입력값이 지워지므로 보관한 코드를 다시 붙여넣어 사용합니다. 이미 등록한 코드가 있다면 새로 만들지 않습니다.

## 2. Cloudflare에 코드 등록

기존 Worker **soul-reader-billing → 설정 → 런타임 변수 및 시크릿 → 변수 추가**로 이동합니다.

| 항목 | 값 |
| --- | --- |
| 환경 | 프로덕션 |
| 이름 | `PLAY_REVIEW_ACCESS_CODE` |
| 유형 | 비밀 |
| 값 | 위에서 생성해 보관한 동일한 코드 |

**변수 추가 및 배포**를 완료합니다. 기존 Google 서비스 계정·구매 암호화·계정 HMAC 비밀 값은 변경하지 않습니다. 이 코드를 Codex 환경 변수에 넣는 것만으로 실제 Worker에 등록되지는 않습니다.

코드 준비 페이지로 돌아와 보관한 값을 붙여넣고 **등록한 코드로 연결 확인**을 누릅니다. ‘연결 확인 완료’가 나와야 합니다. 이 버튼은 같은 서비스에 HTTPS로 코드를 보내 확인하며 Cloudflare 설정을 수정하지 않습니다.

## 3. 새 앱에서 실제 확인

검토용 접근이 포함된 버전 98 이상을 설치하고, 아래 Console 안내문과 같은 순서로 확인합니다. 앱에서 **검토용 접근**을 열고 표시된 사용자 이름 `play-review`와 보관한 코드를 사용합니다.

확인할 내용:

- Google 계정 생성·추가 로그인·결제·OTP 없이 검토용 인증이 됩니다.
- 정면 사진을 촬영하거나 선택해 실제 기기 내 얼굴 분석과 무료 풀이를 마칩니다.
- 네 주제의 실제 상세 풀이와 음성을 확인합니다. 검토용 접근 배너가 표시됩니다.
- 검토용 접근 종료 후에는 기존 구매 권한이 없는 사진의 이용권 화면이 다시 표시됩니다. 실제 구매·기존 구매 내역은 바뀌지 않습니다.
- 앱 재시작·한 시간 경과 후에는 같은 인증 정보로 다시 접속할 수 있습니다. 자격 정보는 만료되지 않지만 한 번의 검토 세션은 최대 한 시간입니다. 코드 자체는 Cloudflare에서 변경하기 전까지 유지됩니다.

실제 Google 로그인과 결제 절차는 일반 이용 모드에 그대로 있습니다. 검토용 모드는 같은 유료 풀이 콘텐츠를 별도 구매 없이 제공하며, 결제 절차를 진행하거나 구매 권한을 지급한 것처럼 표시하지 않습니다.

## 4. 현재 Console 팝업에 입력

| 입력칸 | 넣을 값 |
| --- | --- |
| 이름 | `SOUL READER review access` |
| 사용자 이름, 이메일 주소 또는 전화번호 | `play-review` |
| 비밀번호 | Cloudflare에 등록한 동일한 코드 |

**추가 안내**에는 다음 영어 문구를 붙여넣습니다. 본문 468자로 500자 제한 안입니다.

```text
Select English. Tap 'Review access' at the bottom of the home screen and use username play-review with the password above. Take or choose a clear front-facing photo and complete the free reading. Tap 'Stories', then 'View all four topics', and open each topic. The same paid content is available without Google sign-in, payment, OTP or a trial. Sessions last one hour; sign in again with the same credentials if needed. Tap 'Exit' in the banner to leave review access.
```

실제 접근 확인을 마친 뒤 전체 액세스 확인란을 체크하고 **추가 → 저장**을 완료합니다. 심사에 제출하는 AAB에도 이 기능이 포함돼야 합니다. Console에 문구를 입력하는 것으로 이전 버전의 기능이 바뀌지는 않습니다.

심사와 후속 검토 동안 코드를 유지하세요. 코드를 바꾸면 Cloudflare와 Console을 함께 갱신하고 실제 앱으로 다시 확인합니다. 개인 Google 계정 비밀번호는 사용하지 않습니다.
