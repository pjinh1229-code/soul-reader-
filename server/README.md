# Billing backend

This directory contains a Cloudflare Worker and durable D1 purchase ledger,
Firebase Google-account authentication, Google Play verification, acknowledgement
retries and refund reconciliation. **It has not been deployed or tested against
a real Play purchase.** The example creates no account, database or paid service.

Cloudflare deploys the backend from `main/server`; Android auth/billing work
remains on `feat/play-billing-8.5.6`. See [deployment instructions](DEPLOY.md) for
the creation form's commands when it has no branch/root directory controls.

Use Node24 or newer (the tests use the real built-in SQLite engine):

```sh
cd server
npm ci --ignore-scripts --no-fund
npm test
npx wrangler deploy --dry-run --config wrangler.example.jsonc --outdir /tmp/soul-reader-worker-check
```

Dry-run bundles the Worker without deployment. This environment uses
`XDG_CONFIG_HOME=/tmp/soul-reader-tools-config`,
`WRANGLER_LOG_PATH=/tmp/soul-reader-wrangler.log` and
`WRANGLER_SEND_METRICS=false` to keep local CLI files in writable directories.

## Runtime configuration

Use an owner-controlled Workers/D1 account and apply `migrations/0001_billing.sql`
before serving requests. Copy the example config to a private deployment config
and replace its placeholder database UUID. Keep the free plan selected; quota
limits still apply. Firebase Spark authentication needs no 90-day Cloud trial.
Neither free quotas nor a local test establish production capacity.

| Binding | Purpose |
| --- | --- |
| `DB` | D1 database containing the migrated durable ledger |
| `FIREBASE_PROJECT_ID` | Public project ID, `soul-reader-a91f5` |
| `PLAY_PACKAGE_NAME` | Public package, `com.soulreader.soul_reader` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Server-only Google Play service-account secret |
| `ACCOUNT_HMAC_KEY` | Independent random32-byte key, standard base64 |
| `TOKEN_ENCRYPTION_KEY` | Independent random32-byte key, standard base64 |

Set the three secrets directly in the hosting provider's secret settings. Do not
put private JSON, passwords or keys in chat, Git, an app asset or a Dart define.
Retain the encryption/HMAC keys securely: replacing them without migration
breaks existing token decryption and prepared account identifiers. The service
account needs Android Publisher API access and the app's appropriate Play Console
permissions. Its credentials are distinct from the public `google-services.json`.

Connect the resulting HTTPS origin through the app's `BILLING_VERIFIER_URL` after
Firebase sign-in is configured. Every billing route authenticates a Google-provider
Firebase ID token. Request-body owner IDs are never trusted. `/health` checks
configuration construction only; it is not a live Google API or migration check.

## HTTP and durability

The app uses `POST /v1/billing/prepare`, `POST /v1/billing/verify`,
`GET /v1/billing/entitlements` and
`POST /v1/billing/entitlements/{id}/topic`.
See [the app/API contract](https://github.com/pjinh1229-code/soul-reader-/blob/feat/play-billing-8.5.6/docs/PLAY_BILLING_SETUP.md)
and [Firebase connection steps](https://github.com/pjinh1229-code/soul-reader-/blob/feat/play-billing-8.5.6/docs/FIREBASE_CONNECT.md)
on the Android development branch.

Tokens are hashed for uniqueness and encrypted with AES-GCM at rest. Immutable
prepared intents bind user, request, reading and SKU; each token and intent can
produce only its original entitlement. SQLite constraints/triggers enforce this
across duplicate requests and process restarts. A grant and its acknowledgement
retry flag are persisted together before contacting Google's acknowledgement API.
The Android client consumes only after receiving a verified grant; the server
never consumes. Single-topic selection is atomic and cannot later change topic.

Entitlement pages carry a signed user/revision cursor. The client collects the
whole snapshot before replacing its rights, and restarts when a concurrent change
returns `ledger_changed`. Pages and scheduled retry batches are bounded for the
free Worker request budget; a response may contain fewer rows than requested.

Refund sync runs every15minutes, persists its page cursor and advances its
watermark only after completing all pages. Revocation tombstones cannot be
reactivated by replay. Google404/410 errors are not refund evidence. An existing
finalized entitlement can survive those retention errors only with recent,
continuous refund coverage; otherwise the server fails temporarily and preserves
the ledger. Google outages never become successful empty entitlement lists.

Before enabling sales, run real license-tester purchase/cancel/pending/restart,
duplicate, restore, account-switch and refund scenarios through the deployed
service. Record the actual free-plan resource measurements and confirm scheduled
refund/ack retries. The included tests use real cryptography/SQLite with fake
upstream transport; they do not demonstrate live credentials or device behavior.

`normalizePlayPurchaseV2` accepts a response fetched by the backend from the
official `purchases.productsv2.get` endpoint. Its expected context must come
from server configuration, the authenticated user's prepared purchase intent
and the durable ledger. Never build that context from unverified client fields.
The configured package is bound by the trusted API request URL; the v2 response
itself does not carry a package name.

The validator requires a completed purchase, the exact single product/purchase
option, quantity1/refundableQuantity1 and the prepared obfuscated account/profile
identifiers. It permits pending acknowledgement before consumption. Already
consumed purchases are accepted only when the backend has a matching durable
transaction. An optional Google order ID is not treated as payment proof. The
result contains no purchase token, personal identity or entitlement grant.

Persist an idempotent entitlement and finalization job atomically before any
acknowledgement or consumption. A later replay must never reactivate a refunded
or revoked ledger entry. The current Android client consumes after verification;
do not add server-side consumption without coordinating that protocol. A server
acknowledgement retry can protect against the client disappearing after a grant.

Registered catalogue, as reported by the owner:

| Product | Purchase option | Korean price | Scope |
| --- | --- | --- | --- |
| `soul_reading_single` | `single` | KRW990 | One selected topic for one photo reading |
| `soul_reading_bundle` | `bundle` | KRW1990 | All four topics for one photo reading |

Keep one default/backward-compatible buy option per product for the currently
pinned Flutter billing plugin. It does not expose arbitrary one-time offer
tokens/purchase-option selection. The server must still validate the option ID.

The owner reported the two Play products registered and the first internal-test
AAB released. Actual catalogue responses and charges remain unverified.
