# SOUL READER account deletion requests

The public contact is `jgw98541706@gmail.com`. Requests are handled manually;
opening the app's request instructions or composing an email does not submit or
complete deletion. This runbook covers Firebase project `soul-reader-a91f5` and
the D1 database `soul-reader-billing`. It does not authorize unrelated users'
data deletion, Google-account deletion, refunds, or changes to cryptographic keys.

## Verify the request and stop writes

1. Ask for the Google email used to sign into SOUL READER. Do not request a
   password, verification code, identity document, ID token, or purchase token.
   A sender display name or the email's From header is insufficient proof.
2. In Firebase Console → Authentication → Users, locate that email and check
   that it is the requested Google sign-in account in the pinned project.
   Send a fresh confirmation message to the address registered there and require
   a reply confirming deletion. If no matching account exists, clarify the email
   or explain that no matching account was found; never substitute another user.
3. Explain that the app account, server purchase rights and linked records will
   be removed; purchases will no longer restore to that account. The user's
   Google account and Google's own payment records are not deleted, and deletion
   does not itself refund a purchase. Obtain the requested deletion confirmation.
4. Copy the exact Firebase **UID**, then **disable** that Firebase user. Keep
   it disabled through the final server checks. Revoke refresh tokens through an
   approved existing Admin tool if one is available; this helper does not do so.
5. Wait at least **two hours after disabling** before the final D1 deletion.
   Firebase ID tokens normally last an hour. This is an operational buffer,
   not a legal retention deadline or a promised response time. Our Worker checks
   token signatures and expiration, but does not check Firebase disablement or
   revocation on every request. Disabling/deleting a Firebase user alone therefore
   does not immediately stop its existing ID tokens. The local helper cannot
   verify disablement, elapsed time or token expiration. If the account was
   reenabled, identity changed, or writes continue, stop and investigate before
   marking deletion complete.

Firebase reference: [Manage user sessions](https://firebase.google.com/docs/auth/admin/manage-sessions).
Use Console's current disable/delete controls; do not upload service-account
credentials or paste them into chat, SQL files or request correspondence.

## Prepare private SQL locally

Run these commands from `server/` on the operator's trusted machine. Choose a
private working directory **outside this checkout**. The helper uses no cloud
credentials, makes no network requests, and never executes SQL. Its default is
read-only counts. Generated SQL includes the target UID; do not commit, share,
or paste it into public issue trackers. Output directories are created with mode
0700 and files with mode 0600. Existing output directories are rejected.

```bash
umask 077
CASE_DIR=$(mktemp -d /tmp/soul-reader-deletion.XXXXXX)
read -r -p 'Firebase UID: ' FIREBASE_UID
printf '%s\n' "$FIREBASE_UID" > "$CASE_DIR/uid.txt"
unset FIREBASE_UID
node scripts/prepare-account-deletion.mjs \
  --uid-file "$CASE_DIR/uid.txt" --output-dir "$CASE_DIR/preview"
```

Review `preview/01-preview.sql` locally and verify its target against Firebase.
The D1 user identifier is **`soul-reader-a91f5:UID`**, never the email or display
name. UIDs containing SQL quotes are escaped by the helper. Do not edit the
generated WHERE clauses. You can personally run the read-only preview with the
repository's installed Wrangler and your existing Cloudflare authentication:

```bash
npx --no-install wrangler d1 execute soul-reader-billing --remote \
  --config wrangler.jsonc --file "$CASE_DIR/preview/01-preview.sql"
```

After ownership is verified, the user is disabled, and the two-hour wait has
finished, prepare the deletion files. Type the full target rather than deriving
it automatically from the UID file; compare it with Firebase again. Reading the
confirmation into a variable avoids putting a literal UID in shell history.

```bash
read -r -p 'Type the exact soul-reader-a91f5:UID target: ' DELETION_TARGET
node scripts/prepare-account-deletion.mjs \
  --uid-file "$CASE_DIR/uid.txt" --output-dir "$CASE_DIR/deletion" \
  --prepare-deletion --confirm-target "$DELETION_TARGET"
unset DELETION_TARGET
```

## Execute and verify in order

Review all three files before execution. Confirm the selected Cloudflare account,
database and Firebase UID. Commands below are operator actions; the preparation
helper does not execute them. These Wrangler scripts are **not promised to be
atomic transactions**. A command succeeding is not proof that rows were removed.

1. Run `02-tombstones.sql` first. It copies only this user's receipt digests into
   `refund_tombstones`, preserving existing entries. Check that the returned
   `uncovered_purchase_receipts` count is **zero**. If the command fails or the
   count is nonzero, stop before the purge and resolve the problem.

   ```bash
   npx --no-install wrangler d1 execute soul-reader-billing --remote \
     --config wrangler.jsonc --file "$CASE_DIR/deletion/02-tombstones.sql"
   ```

2. Run `03-purge.sql`. It deletes the target's `purchases` (including encrypted
   raw tokens, rights and reading IDs), then `purchase_intents`, `user_revisions`
   and `rate_limits`. Each DELETE checks that every remaining target receipt has
   a tombstone, and resolves the required tables before running. Foreign-key
   dependencies require deleting purchases before intents. The scripts can be
   rerun after an interruption, but concurrent writes must remain stopped.

   ```bash
   npx --no-install wrangler d1 execute soul-reader-billing --remote \
     --config wrangler.jsonc --file "$CASE_DIR/deletion/03-purge.sql"
   ```

3. Confirm that **all five final counts are zero**. Rerun `01-preview.sql` to
   independently check the final state. If any query fails or any count is
   nonzero, keep Firebase disabled, investigate and rerun the relevant steps;
   do not report completion. A missing or changed ledger schema is a blocker,
   not a reason to remove the guards or clear entire tables.
4. Delete the disabled user in Firebase Authentication, then verify that the
   exact UID is absent. If this fails, the request is not yet complete. Do not
   sign into that account during processing: a new sign-in after deletion may
   create a new Firebase account with a different UID.
5. Notify the requester after both Firebase and D1 checks succeed. Explain the
   retained receipt-security records below, and ask them to clear local data on
   every device. Remove private SQL/UID files and request correspondence once
   request handling is complete. Avoid retaining email, UID or case notes in
   application logs or security tombstones. Use the operator's normal handling
   for mail trash/backups; do not promise instant deletion of provider backups.

Never change `ACCOUNT_HMAC_KEY` or `TOKEN_ENCRYPTION_KEY`, delete another user's
rows, clear shared tables, or reset `refund_sync`. Never remove existing refund
tombstones as part of this request. Deletion must not turn an old receipt into a
new entitlement. If there is a specific applicable obligation to preserve an
otherwise linked record, establish and disclose its actual scope and duration
before completing the request; this runbook invents no legal retention period.

## What remains and what the user must clear

`refund_tombstones` retains only a one-way SHA-256 purchase-token digest and its
revocation timestamp for the service lifetime to prevent receipt reuse. The
table contains no Firebase UID, email, photo or raw purchase token. These are
pseudonymous security records, not guaranteed anonymous data: someone holding
the corresponding receipt could match its digest. Google retains its own
transaction records, including the original obfuscated account/profile fields;
deleting our D1 rows does not erase Google's records. The 30-day constant in
refund synchronization is an API lookback, **not** a personal-data retention
promise. This workflow must not be described as deleting every trace of a payment.

Photos, derived face measurements, reading snapshots and story choices are
processed/stored locally; the server cannot remotely wipe those devices. On
Android, use **Settings → Apps → SOUL READER → Storage → Clear storage/data** on
each device (wording varies). This also removes pending billing journals and
the local sign-in state. The app's existing archive-delete button clears only
its basic archive; it does not clear all story storage or native files. Original
gallery photos belong to the user's photo library and are outside this deletion
flow. Temporary camera/cache copies may remain under platform cache management.
No automated account deletion or remote device wipe is implemented by this helper.
