# Cloudflare GitHub deployment

Cloudflare's initial creation form defaults to the repository root on `main`.
The server is published under `main/server`; Android app work remains on
`feat/play-billing-8.5.6`. Existing Android app files on main are preserved.

Use project name `soul-reader-billing` and these initial commands:

Build:

```sh
cd server && npm ci --include=dev --ignore-scripts --no-fund && npm test
```

Deploy:

```sh
cd server && npx --no-install wrangler deploy --config wrangler.jsonc
```

Keep the build root at the repository root and use `main`. Root `.node-version`
selects Node24. The explicit `cd server` in each command avoids requiring root
directory controls in the creation form. Disable preview builds for this backend.
Cloudflare holds its generated user build token; no token goes to Codex or Git.

The real public D1 UUID is already in `wrangler.jsonc` as binding `DB`. Initial
upload prepares infrastructure only. Runtime secrets are not configured, so
`/health`503 and scheduled configuration errors are expected at this stage.

After import, add account-scoped **D1 Edit** to the Cloudflare-held user build
token and select that token in the Worker build settings. Then change Deploy to:

```sh
cd server && npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.jsonc && npx --no-install wrangler deploy --config wrangler.jsonc
```

Rerun the build to initialize migration tracking. Do not initialize by pasting
raw schema and later run Wrangler migrations without reconciling their history.
The owner confirmed successful remote migration and deployment in build
`53354f53-1326-439d-bc38-4ca2b906d685`. Codex can trigger these builds through
GitHub; direct Cloudflare API access from Codex is blocked by a proxy. Configure
the server secrets below and keep the app verifier URL unset until live checks pass.

## Private runtime key initialization

The owner supplies `GOOGLE_SERVICE_ACCOUNT_JSON` directly as a production runtime
Secret. The custom build helper can then initialize `ACCOUNT_HMAC_KEY` and
`TOKEN_ENCRYPTION_KEY` inside the production Workers Builds environment, using
its existing build authentication. Neither generated value is printed, written
to the checkout, returned to Codex, or stored in D1. Each is generated from
32 independent random bytes and sent directly to Cloudflare's secrets API.

The helper verifies the actual Wrangler parent invocation and skips local,
preview, and dry-run builds. It validates the target account/Worker and requires
the service-account Secret before generating keys. Existing keys are retained.
A unique row in the separate D1 `runtime_secret_initialization` metadata table
serializes first initialization. It contains only the Worker name, build ID,
state, and timestamp. Completed setup never automatically replaces a missing
key; an interrupted or ambiguous write never grants a different build the lock.
Investigate such failures before any recovery operation. Do not delete/reset
this record or rotate keys to work around a deployment error.

Wrangler preserves runtime secrets during the subsequent Worker deployment.
Successful initialization establishes configuration only; live Google API
permissions, sign-in, purchases, refunds, and Worker CPU capacity require their
own checks. Never add private JSON or API token values to GitHub or build logs.

The owner's public origin is
`https://soul-reader-billing.jgw98541706.workers.dev`. Run
`node server/scripts/check-deployed-worker.mjs` from the repository root to check
`/health` configuration and the unauthenticated entitlement boundary. The
`Check deployed billing Worker` GitHub workflow runs these read-only checks from
an external runner, including after successful production Workers Builds. These
checks send no token and cannot establish live Google Play purchase permissions.
