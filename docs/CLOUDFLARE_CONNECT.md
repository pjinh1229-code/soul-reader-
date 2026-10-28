# Cloudflare 계정 연결

소유자는 2026-10-28 무료 계정 가입 완료를 알려주었습니다. 계정을 다시
만들지 않습니다. 서버 소스, D1 마이그레이션과 배포용 Worker 번들은
준비되어 있으며 기존 서버 테스트 66개와 배포 없는 번들 검사를 통과했습니다.
실제 계정 인증·외부 데이터베이스 생성·서버 배포는 아직 하지 않았습니다.

소유자가 계정 API 토큰 생성 화면을 공유했습니다. 계정 ID는 확인했고
`CLOUDFLARE_ACCOUNT_ID` 공개 환경 설정에 기록했습니다. 화면의 사용 예시에
토큰 전체가 포함되어 있어 해당 토큰은 Cloudflare에서 재발급/폐기 후 교체해야
합니다. 토큰값은 기록하거나 API 요청에 사용하지 않았으며 현재 런타임에
`CLOUDFLARE_API_TOKEN` 보안 값은 없습니다. 새 값은 보안 환경 설정으로만
받고, 소유자는 저장 완료 여부만 채팅으로 알립니다.

## 소유자의 연결 단계

1. [사용자 API 토큰](https://dash.cloudflare.com/profile/api-tokens)에서
   **Create Token → Create Custom Token**을 선택합니다.
2. 이름은 `SOUL READER deploy`처럼 용도를 식별할 수 있게 지정하고,
   **Account** 범위에 다음 권한을 설정합니다.

   | 권한 | 수준 | 용도 |
   | --- | --- | --- |
   | Workers Scripts | Edit | Worker 업로드, workers.dev 주소, 보안 설정과 예약 작업 |
   | D1 | Edit | 데이터베이스 생성과 SQL 마이그레이션 |
   | Account Settings | Read | 대상 계정 검색과 연결 확인 |

3. **Account Resources → Include → Specific account**에서 이번에 가입한
   계정을 선택합니다. Zone 권한, Global API Key와 Account Settings Edit는
   이 작업에 사용하지 않습니다.
4. 생성한 토큰을 채팅에 보내지 않고, 이 Codex 작업의 환경 설정에서
   **`CLOUDFLARE_API_TOKEN`** 보안 값으로 입력합니다. 토큰은
   `api.cloudflare.com` HTTPS 요청의 인증 헤더에만 사용합니다.

환경 설정 초안에 토큰 요구사항과 해당 도메인을 추가했습니다. 저장된 초안은
런타임 적용이나 Cloudflare 인증 성공을 뜻하지 않습니다. 현재 인증 없는
접속 검사도 프록시 CONNECT403으로 차단되므로 설정 반영 후 통신부터
다시 확인합니다. 이 응답은 Cloudflare가 토큰을 거부했다는 증거가 아닙니다.

## 계정이 연결된 다음 실행할 준비

첫 확인은 토큰 상태와 계정 조회만 수행합니다. 새 계정 하나가 조회되면 그
공개 계정 ID를 사용하고, 여러 계정이 조회되면 대상을 확인합니다. 기존
데이터베이스나 Worker는 삭제하지 않습니다. 준비한 리소스 이름은 모두
`soul-reader-billing`이며, 같은 이름이 이미 있으면 먼저 상태를 읽습니다.

이번에 만든 것은 계정 소유 API 토큰이므로 상태 확인은
`GET /client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/tokens/verify`를 사용합니다.
사용자 토큰 확인 경로의 실패만으로 계정 토큰이 잘못되었다고 판단하지
않습니다. 인증 헤더는 지정된 Cloudflare API 도메인으로만 전송합니다.

기존 Wrangler 4.153.0과 `server/wrangler.example.jsonc`를 사용해 D1 생성,
`server/migrations/0001_billing.sql` 적용, 실제 D1 바인딩을 포함하는 배포
설정을 준비합니다. Worker 소스는 `server/src/worker.mjs`입니다. 계정 ID와
데이터베이스 UUID는 공개 구성 값이며 토큰이나 Google 비공개 키를 설정
파일에 기록하지 않습니다.

이 연결 토큰은 Google Play 구매 검증 자격증명을 대신하지 않습니다.
`GOOGLE_SERVICE_ACCOUNT_JSON`, `ACCOUNT_HMAC_KEY`, `TOKEN_ENCRYPTION_KEY`는
서버의 보안 런타임 설정에 별도로 필요합니다. 현재 값은 없고, 앱의 서버
주소도 비어 있어 실제 구매는 비활성 상태입니다. Google 비공개 키는 채팅이나
앱 설정 파일로 받지 않습니다. 배포·실기기 구매와 무료 플랜 사용량 검증이
끝나기 전 운영 완료로 안내하지 않습니다.

권한 확인 자료: [공식 API 명세](https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.yaml),
[공식 권한 목록](https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/fundamentals/api/reference/permissions.mdx).
