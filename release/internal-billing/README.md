# Internal billing update, version 96

Use the Android source on `feat/play-billing-8.5.6`. Default `main` still has
the older Android app and must not be used for this update.

The public Worker configuration and unauthenticated access boundary passed
[the live check](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40794407830/job/123187237773):
`/health` returned configured/200 and unauthenticated entitlements returned
authentication_required/401. This does not verify Google Play permissions,
device sign-in, purchases or refunds.

The internal AAB recipe now supplies
`BILLING_VERIFIER_URL=https://soul-reader-billing.jgw98541706.workers.dev`,
requires a version code of at least 96 and checks the live configuration again
before building. The ordinary debug APK keeps its verifier URL unset.

The original owner upload certificate is required before Flutter is installed:

`c4d31b29444fcd6fabea9ee91a01fd6bab3383a07079302e19ff32a1d7805139`

The final AAB must also pass the checksum-pinned official bundletool, exact
package/version and release manifest checks, billing permission/library checks,
JAR signature and original-certificate checks, and all 70 original audio checks.
Only the AAB, its checksum and public build facts are published as artifacts.
Private signing files are removed even when a job fails.

## Remaining owner-controlled prerequisite

[The signing binding check](https://github.com/pjinh1229-code/soul-reader-/actions/runs/40794553615/job/123187709184)
found all four repository secrets missing:

- `SOUL_UPLOAD_KEYSTORE_BASE64`
- `SOUL_UPLOAD_KEYSTORE_PASSWORD`
- `SOUL_UPLOAD_KEY_ALIAS`
- `SOUL_UPLOAD_KEY_PASSWORD`

The owner confirmed both recovery files are retained on their phone. Restore
the existing upload key through the owner's secure GitHub Actions settings.
Never generate another first-upload key, reuse a debug key, put private signing
material in chat or commit it. The owner previously received
`SOUL_READER_UPLOAD_KEY_BACKUP.zip` and the separate
`SOUL_READER_BACKUP_PASSWORD.txt`. The former private/export directories are
not retained in this cloud machine.

### Owner-controlled recovery from the two retained files

Open the [local file-copy tool](https://soul-reader-billing.jgw98541706.workers.dev/setup/upload-key).
It reads selected files only inside the owner's browser, blocks network
requests and forms, and copies values only on explicit clicks. The ZIP is
bounded to 36,000 bytes; its base64 stays below GitHub's per-secret limit. The
password file must contain a single nonempty UTF-8 line. Neither file's contents
or filename is rendered, logged or stored; selections and state are cleared
after copying or leaving the page.

Create these two **repository Actions secrets** through the owner's
[GitHub settings](https://github.com/pjinh1229-code/soul-reader-/settings/secrets/actions/new):

- `SOUL_UPLOAD_RECOVERY_ARCHIVE_BASE64`: the tool's **백업 값 복사** value
  after selecting `SOUL_READER_UPLOAD_KEY_BACKUP.zip`.
- `SOUL_UPLOAD_RECOVERY_PASSWORD`: the tool's **비밀번호 복사** value
  after selecting `SOUL_READER_BACKUP_PASSWORD.txt`.

These are GitHub repository secrets, not Cloudflare runtime or Codex environment
values. Do not send either value through chat. The tool itself does not decrypt
the archive or upload it; only the owner pastes the copied values into GitHub.

`scripts/restore_upload_signing.py` runs only in the internal AAB job with these
secrets. It pins the original CMS ciphertext and public recipient certificate,
uses OpenSSL's authenticated decryption before parsing any plaintext, accepts
only bounded safe ZIP/TAR members, checks the original upload certificate, and
proves the recovered private-key password by signing a temporary test JAR.
Only a 0700 private runner directory with 0600 JKS/signing JSON survives until
the build; no derived credential is logged or written to action outputs or
cross-step environment commands. `--configure` passes the private settings
directly to the signing configurator after Android generation. The workflow
always removes private signing files. Public artifacts remain restricted to
the AAB, checksum and build facts.

When any old four-secret binding is populated, all four must be valid; a partial
old route blocks recovery instead of silently mixing credentials. All four were
confirmed absent before this recovery route was prepared. Nonempty bindings
alone do not prove successful recovery. The actual owner archive is verified
only after the owner has securely registered both values.

After configuring the existing key, rerun the signing-binding check. Nonempty
bindings alone do not prove the key is correct; the AAB job enforces the public
certificate and actual signing proves the private-key password.

## Trigger the prepared build

The workflow on the feature branch accepts `artifact_type=internal_aab` and
`version_code=96` with `workflow_dispatch`. Select the feature ref explicitly;
the default branch's older workflow has no matching dispatch inputs.

When dispatch API access is unavailable, push the reviewed feature source to
`build/internal-play-v96` using existing HTTPS Git authentication. First check
the remote branch state and preserve any existing work. A push to this exact
branch runs the internal AAB job, waits for backend checks, and skips the debug
APK job. It builds version 96 by default; do not reuse it for later Play
version codes or recreate the archived first-upload bootstrap. This build
branch has not been created while signing prerequisites are missing.

The resulting `SOUL_READER_8.5.6_INTERNAL_BILLING_96.aab` is for Play internal
testing. Upload to the existing app, then verify Google login and license-tester
purchase, cancellation, pending, restart, restore/replay and refund behavior
before enabling public sales.
