# Cloudflare 대시보드에서 배포

소유자는 무료 Cloudflare 계정을 만들었습니다. 현재 Codex 실행 환경에는
Cloudflare 보안 토큰이 전달되지 않았고, API 접속도 프록시 CONNECT403으로
차단됩니다. Cloudflare 대시보드에서 GitHub를 연결하는 Workers Builds 방식으로
진행합니다. 토큰값을 채팅이나 Codex에 전달하지 않습니다.

소유자가 만든 계정 소유 API 토큰은 이 경로에서 사용하지 않습니다. 현재
공식 Workers Builds 문서는 사용자 토큰만 지원한다고 명시합니다. Cloudflare가
빌드용 사용자 토큰을 생성·보관하도록 설정합니다. 사진에 노출된 기존 토큰은
Cloudflare 목록에서 폐기합니다. 토큰값을 코드나 API 요청에 사용한 적은 없습니다.

## 1. 데이터베이스 식별자 준비

1. [D1 화면](https://dash.cloudflare.com/ee33db3044223ccec6ff9c0da863d2a5/workers/d1)을 엽니다.
2. 기존 `soul-reader-billing`이 있으면 열고, 없으면 **Create Database**에서
   이름을 `soul-reader-billing`으로 지정해 무료 플랜에서 생성합니다.
3. **Database ID(UUID)**만 전달합니다. 이 값은 인증 토큰이 아닌 공개 구성
   식별자입니다. Codex가 실제 UUID를 넣은 `server/wrangler.jsonc`를 준비합니다.

소유자가 생성한 데이터베이스 ID는
`e510df4a-00f3-4d29-b689-c08cdb422caf`입니다. 실제 바인딩을
`server/wrangler.jsonc`에 연결했습니다. 계정 ID도 명시했으며 비공개 값은
포함하지 않습니다. 소유자의 ID 전달을 확인했지만 원격 데이터베이스에
접속하거나 원격 마이그레이션을 실행한 상태는 아닙니다.

## 2. Cloudflare에서 저장소 연결

소유자가 **Workers & Pages → Create application → GitHub**에서 다음을
설정합니다. 실제 D1 UUID는 저장소 설정에 반영되어 있습니다.

| 항목 | 값 |
| --- | --- |
| 저장소 | `pjinh1229-code/soul-reader-` |
| 브랜치 | `main` (초기 생성 화면의 기본 브랜치) |
| Worker 이름 | `soul-reader-billing` |
| Root directory | 저장소 루트 `/` (기본값) |
| Build command | `cd server && npm ci --include=dev --ignore-scripts --no-fund && npm test` |
| Deploy command (첫 업로드) | `cd server && npx --no-install wrangler deploy --config wrangler.jsonc` |
| 미리보기 빌드 | 끔 |
| Node | 루트 `.node-version`의 24 |

소유자의 실제 생성 화면에는 브랜치·루트 디렉터리 입력이 없어 기본 브랜치의
서버 폴더를 배포하도록 준비했습니다. `main`에는 검증한 `server/`와 Node
선택·서버 CI만 추가하고 기존 Android 앱 파일을 보존합니다. Android 로그인
코드와 다음 Play AAB 작업은 계속 `feat/play-billing-8.5.6`에서 진행합니다.

기본 브랜치의 서버 추가 커밋 `1bad565`는
[서버 CI 40654690779](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40654690779)를 통과했습니다.
Node24 선택·의존성 설치·서버 테스트·실제 설정의 배포 없는 번들 생성을
확인했습니다. 같은 빌드 명령의 로컬 실행에서는 테스트 66개가 통과했습니다.

Cloudflare가 생성하는 기본 빌드용 토큰에는 D1 권한이 포함되지 않습니다.
**My Profile → API Tokens**에서 해당 Cloudflare 보관 사용자 토큰에 대상
계정의 **D1 → Edit**를 추가하고 Builds에서 선택해야 원격 마이그레이션을
실행할 수 있습니다. 계정 소유 토큰을 재사용하지 않습니다. 토큰은 Cloudflare
안에서 관리하며 채팅으로 보내지 않습니다.

첫 업로드는 Worker와 DB 바인딩을 준비하는 단계입니다. 원격 API의 실제
업로드 승인은 아직 확인하지 않았습니다. 토큰의 D1 권한을 설정한 다음
**Worker → Settings → Builds → Deploy command**를 아래처럼 바꿔 재실행합니다.

```sh
cd server && npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.jsonc && npx --no-install wrangler deploy --config wrangler.jsonc
```

D1 콘솔에 원시 SQL을 넣는 방식과 Wrangler 마이그레이션을 혼용하면
`d1_migrations` 추적 정보가 어긋날 수 있어 위 명령으로 초기화합니다.
재실행 시 Wrangler의 완료된 마이그레이션 추적을 사용합니다.

보안 런타임 설정은 원격 마이그레이션 성공 후 입력합니다. 초기 업로드만
완료한 동안 `/health`의 HTTP503과 예약 작업의 설정 오류는 준비 미완료
상태를 나타냅니다. 이 상태를 결제 서버 운영 완료로 안내하지 않습니다.

## 3. 서버 보안 설정과 검증

Worker의 **Settings → Variables and Secrets**에서 **Secret** 유형으로
`GOOGLE_SERVICE_ACCOUNT_JSON`, `ACCOUNT_HMAC_KEY`, `TOKEN_ENCRYPTION_KEY`를
별도 설정해야 합니다. Build secrets는 서버 런타임 설정을 대신하지 않습니다.
Google 비공개 키는 채팅·저장소·앱 파일에 넣지 않습니다.

서버 코드는 테스트 66개와 배포 없는 번들 검사를 통과했습니다. 실제 배포와
무료 Worker CPU 사용량, Google API 권한, 로그인·구매는 아직 검증하지
않았습니다. 앱의 서버 주소도 비어 있어 실제 구매는 비활성 상태입니다.
`/health`는 설정 생성만 검사하며 실제 Google 결제 검증을 증명하지 않습니다.

실제 ID를 반영한 `server/wrangler.jsonc`로 배포 없는 번들 생성과 `--local`
마이그레이션의 16개 SQL 명령 검사를 통과했습니다. 이 검사는 원격 DB에
접속하거나 원격 스키마를 변경한 결과가 아닙니다.

공식 자료: [Builds 설정](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[빌드 환경](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/),
[D1 시작](https://developers.cloudflare.com/d1/get-started/).
