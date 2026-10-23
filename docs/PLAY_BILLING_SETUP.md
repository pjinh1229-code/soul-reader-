# SOUL READER Google Play 결제 연결

이 버전은 **사진 한 장의 풀이마다 구매하는 소비형 이용권**을 기준으로 준비합니다. 앱의 결제 클라이언트와 아래 서버 계약을 연결하는 단계이며, 구매 검증 서버·회원 인증·Play Console 등록이 완료된 운영 서비스는 아닙니다. 이 문서의 준비가 끝나기 전에는 실제 결제가 가능하다고 안내하지 마세요.

## 1. Play Console에서 준비할 항목

1. Google Play 개발자 계정과 결제 프로필을 만들고 앱을 등록합니다. 기본 생성 패키지명은 `com.soulreader.soul_reader`입니다. `scripts/prepare_android.sh`가 `--org com.soulreader --project-name soul_reader`로 생성합니다. 기존 등록 앱이 있다면 실제 `android/app/build.gradle.kts`의 `applicationId`를 그 앱과 일치시켜야 합니다.
2. 일회성 인앱 상품 두 개를 만들고 판매할 국가·가격·활성 상태를 설정합니다. 소비형 여부는 구매 후 소비 처리로 결정합니다.

   | 이용권 | 제안 상품 ID | 한국 가격 | 제공 범위 |
   | --- | --- | --- | --- |
   | 한 주제 | `soul_reading_single` | ₩990 | 구매한 풀이 한 건의 네 주제 중 하나 |
   | 네 주제 합본 | `soul_reading_bundle` | ₩1,990 | 구매한 풀이 한 건의 네 주제 모두 |

   두 상품 ID는 **등록 전 제안값**입니다. 실제로 만든 ID를 앱과 서버의 허용 목록에 동일하게 설정하세요. 앱에 보이는 최종 가격은 Google Play가 반환한 현지화 가격을 사용합니다. 코드에 적힌 금액만 바꿔서는 판매 가격이 바뀌지 않습니다.
   구매 한 번에 이용권 한 개를 제공하므로 다중 수량 판매는 사용하지 않고, 서버에서도 구매 수량을 확인해야 합니다.
3. 정식 업로드 서명을 설정하고 Play App Signing에 맞는 release AAB를 만듭니다. 현재 debug APK 빌드 성공만으로 출시용 서명 구성이 완료되지는 않습니다. 업로드 키·비밀번호는 저장소나 앱 에셋에 넣지 마세요.
4. 내부 테스트 트랙에 AAB를 올리고 테스터를 등록합니다. 결제 시험용 Google 계정은 Play Console의 라이선스 테스트에도 추가합니다. 테스터 계정으로 테스트 참여 후 Play에서 설치해 구매·취소·대기 결제·앱 재실행을 확인하세요. 라이선스 테스트 결제와 실제 청구되는 구매를 구분해야 합니다.

서명 설정 후 기본 빌드 순서는 다음과 같습니다.

```bash
bash scripts/prepare_android.sh
flutter analyze --no-fatal-infos
flutter test
flutter build appbundle --release
```

생성된 `build/app/outputs/bundle/release/app-release.aab`를 내부 테스트 트랙에 올립니다. 필요한 상품 ID·서버 주소 등 앱 결제 설정도 실제 등록값으로 지정해야 합니다.

앱 설정 이름은 `BILLING_SINGLE_PRODUCT`, `BILLING_BUNDLE_PRODUCT`, `BILLING_VERIFIER_URL`, `BILLING_PACKAGE_NAME`입니다. 예를 들어 상품 ID는 `--dart-define=BILLING_SINGLE_PRODUCT=soul_reading_single`로 전달합니다. 서버 주소는 HTTPS이며, 패키지명은 실제 Android `applicationId`와 서버 허용 목록에 일치시킵니다. 기본 패키지를 바꾸면 Android 생성·설정 스크립트도 함께 수정해야 합니다. 이 값들은 공개 설정이며 인증 토큰을 넣는 용도가 아닙니다. CI 확인용 APK는 이 설정을 비워 두므로 구매가 비활성화됩니다.

## 2. 인증·구매 검증 서버

**이 저장소의 클라이언트·API 계약만으로 서버가 배포되지는 않습니다.** 서버 운영 환경, 영구 데이터베이스, 로그인 및 세션 발급을 별도로 구현·연결해야 합니다. 앱의 기본 세션 토큰 공급자는 미설정 상태입니다. 서버 주소를 지정해도 인증된 세션 공급자가 연결되지 않으면 구매는 비활성 상태로 남습니다.

- 모든 요청은 인증서 검증을 사용하는 HTTPS로 전송하고, `Authorization: Bearer <access-token>`을 사용합니다. 토큰은 로그인한 사용자의 런타임 세션 공급자가 발급·갱신해야 합니다. 공용 토큰을 `--dart-define`으로 앱에 넣는 방식은 사용하지 않습니다.
- `BillingSessionProvider`를 실제 로그인 모듈에 연결해야 합니다. 현재 `MissingBillingSession` 기본 구현은 구매를 차단합니다. 로그아웃·계정 전환 시에는 이전 사용자의 네이티브 권한 캐시와 화면 권한을 초기화하고 새 계정의 원장을 조회해야 합니다.
- 서버가 Google Play Developer API로 패키지·상품·구매 토큰과 구매 완료 상태를 검증합니다. 대기 중·취소·환불된 거래에는 권한을 발급하지 않습니다. 상품과 패키지는 서버의 허용 목록과 대조합니다.
- 서비스 계정 자격증명은 서버의 보안 설정에만 둡니다. APK, JavaScript, 저장소에 포함하지 않습니다. Play Console에서 서버 계정에 해당 앱의 구매 검증에 필요한 권한을 부여해야 합니다.
- 구매 토큰을 거래 원장의 고유 키로 저장하고 사용자·요청·풀이·상품에 묶습니다. 같은 거래를 재전송해도 기존 권한을 반환하며, 다른 사용자나 다른 풀이에 다시 지급하지 않습니다.
- 권한을 영구 저장한 후 소비·구매 완료 처리를 합니다. 네트워크 오류나 앱 종료 후 재시도해도 권한이 중복되거나 사라지지 않아야 합니다.
- 소비된 상품은 Play의 구매 복원 목록에서 사라집니다. 구매 권한 복원은 로그인 계정에 연결된 **서버 거래 원장**으로 처리해야 합니다. 다만 거래 원장만으로 사진이나 삭제된 로컬 풀이 기록을 재생성할 수는 없습니다. 현재 복원 범위는 기기에 남은 풀이·보관 기록에 한정되며, 재설치·다른 기기에서 풀이까지 복원하려면 사진을 제외한 풀이 스냅샷의 별도 백업·계정 동기화를 구현해야 합니다. 환불·취소 시 권한 회수도 서버에서 반영합니다.
- 한 주제 이용권의 주제 확정은 서버에서 원자적으로 처리합니다. 같은 주제의 재요청은 허용하되, 확정 후 다른 주제로 변경하는 요청은 거부합니다.

## 3. 앱이 호출하는 API 계약

아래 경로는 운영 서버가 구현해야 하는 계약입니다. 상품의 `offerKey`는 `single` 또는 `bundle`이며, 주제는 `love`·`chance`·`work`·`bond` 중 하나입니다. 사용자는 인증 세션으로 식별하며 요청 본문의 사용자 ID를 신뢰하지 않습니다.

### `GET /v1/billing/entitlements`

인증 사용자의 구매 권한을 조회합니다. 소비된 거래도 서버 원장에서 조회합니다. 다른 사용자의 권한을 반환하지 않아야 합니다. 응답은 `{"entitlements": [권한 객체]}`이며, 구매가 없으면 `{"entitlements": []}`입니다.

### `POST /v1/billing/prepare`

결제창을 열기 전에 서버가 요청·풀이·상품을 사용자에게 연결합니다.

```json
{
  "requestId": "구매 시도별 고유 ID",
  "readingId": "구매 대상 풀이 ID",
  "offerKey": "single",
  "productId": "soul_reading_single"
}
```

응답은 Play 결제 요청에 전달할 난독화 식별자입니다. 이메일·실명 등을 그대로 반환하지 않습니다.

```json
{
  "obfuscatedAccountId": "서버가 생성한 사용자 식별자",
  "obfuscatedProfileId": "서버가 생성한 구매 요청 식별자"
}
```

### `POST /v1/billing/verify`

Play 구매 업데이트 수신 후 서버에 검증을 요청합니다.

```json
{
  "platform": "android",
  "packageName": "com.soulreader.soul_reader",
  "productId": "soul_reading_single",
  "purchaseToken": "Google Play 구매 토큰",
  "transactionDate": "구매 시각(선택)",
  "requestId": "구매 시도 ID(선택)",
  "readingId": "풀이 ID(선택)"
}
```

성공 응답은 `{"entitlement": 권한 객체}`입니다.

복원·재전송에서는 `requestId`나 `readingId`가 없을 수 있습니다. 서버는 저장된 준비 기록·Play의 난독화 식별자·거래 원장으로 소유자와 대상 풀이를 확인합니다. 요청 본문에 적힌 대상만으로 권한을 새로 연결하지 않습니다. `transactionDate`도 검증 근거로 신뢰하지 않습니다.

### `POST /v1/billing/entitlements/{id}/topic`

단일 주제 이용권의 주제를 확정합니다. `{id}`는 서버가 발급한 `entitlementId`입니다. 성공 응답은 `{"entitlement": 권한 객체}`입니다.

```json
{"topic": "love"}
```

### 권한 응답 필드

조회·검증·주제 확정 응답의 권한 객체에는 다음 필드가 필요합니다.

```json
{
  "entitlementId": "서버 권한 ID",
  "transactionId": "서버 거래 ID",
  "offerKey": "single",
  "productId": "soul_reading_single",
  "readingId": "구매한 풀이 ID",
  "requestId": "원래 구매 시도 ID",
  "topic": "love",
  "status": "active"
}
```

주제 확정 전이나 합본 권한의 `topic`은 `null`입니다. `status: "active"`는 서버 검증이 끝나 실제 사용 가능한 권한에만 사용합니다. 검증 실패·인증 만료·주제 충돌·서버 장애는 성공 권한으로 응답하지 않습니다. 앱의 로컬 저장 값이나 기존 데모 해금 기록은 실제 구매 증거가 아닙니다.

## 4. 실제 결제를 열기 전 확인

- Play 앱·상품·한국 가격·테스터 등록과 release 서명 구성이 끝났는가?
- 운영 HTTPS 검증 서버와 영구 거래 원장이 배포됐고, 앱의 로그인·세션 토큰 공급자가 연결됐는가?
- 결제 완료 후에만 해금되고, 취소·대기·검증 실패·통신 오류에는 해금되지 않는가?
- 앱 종료 후 재시도, 중복 콜백, 다른 풀이에 토큰 재사용, 구매 복원, 환불 후 권한 회수를 확인했는가?

이 항목이 끝나기 전 결과물은 **실제 결제 연결을 준비한 개발 버전**이며, 실결제 운영 완료 버전이 아닙니다.
