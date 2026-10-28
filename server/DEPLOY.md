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
After migration succeeds, configure server secrets as described in README.md.
Keep the app verifier URL unset until live checks pass. The deployment has not
been executed by Codex, whose Cloudflare API access is blocked by a proxy.
