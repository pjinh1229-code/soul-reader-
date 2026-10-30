#!/usr/bin/env node
// Local SQL preparation only. This script has no network or authentication code.
import { constants, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ID = 'soul-reader-a91f5';
const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const help = `Prepare private account-deletion SQL; never executes it.
Usage: node scripts/prepare-account-deletion.mjs --uid-file /private/uid.txt --output-dir /private/new-directory
       [--prepare-deletion --confirm-target '${PROJECT_ID}:FIREBASE_UID']
Alternative input: --uid FIREBASE_UID (may enter shell history).
Default: write only 01-preview.sql. Deletion mode also writes 02-tombstones.sql
and 03-purge.sql. Output directory must be new, absolute and outside the checkout.
Read docs/ACCOUNT_DELETION_RUNBOOK.md before preparing or executing deletion SQL.`;

function fail(message) { throw new Error(message); }
function literal(value) { return `'${value.replaceAll("'", "''")}'`; }

export function accountDeletionSql(uid) {
  // Match the production verifier's control-free, 1..128 UTF-16-unit UID boundary.
  if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128 || /[\x00-\x1f\x7f]/.test(uid)) {
    fail('UID must be 1..128 characters without control characters.');
  }
  const target = `${PROJECT_ID}:${uid}`;
  const owner = literal(target);
  const uncovered = `SELECT 1 FROM purchases p WHERE p.user_id=${owner}
    AND NOT EXISTS (SELECT 1 FROM refund_tombstones t WHERE t.token_hash=p.token_hash)`;
  // Every destructive statement must resolve all affected tables before running.
  // The coverage check still works after purchases have been removed on a rerun.
  const schema = `(SELECT COUNT(*) FROM purchase_intents WHERE user_id=${owner})>=0
    AND (SELECT COUNT(*) FROM user_revisions WHERE user_id=${owner})>=0
    AND (SELECT COUNT(*) FROM rate_limits WHERE user_id=${owner})>=0`;
  const guard = `NOT EXISTS (${uncovered}) AND ${schema}`;
  const preview = `-- Private: contains a Firebase account identifier. Counts only; no mutations.
SELECT 'purchases' AS item,COUNT(*) AS remaining FROM purchases WHERE user_id=${owner}
UNION ALL SELECT 'purchase_intents',COUNT(*) FROM purchase_intents WHERE user_id=${owner}
UNION ALL SELECT 'user_revisions',COUNT(*) FROM user_revisions WHERE user_id=${owner}
UNION ALL SELECT 'rate_limits',COUNT(*) FROM rate_limits WHERE user_id=${owner}
UNION ALL SELECT 'uncovered_purchase_receipts',COUNT(*) FROM purchases p
  WHERE p.user_id=${owner} AND NOT EXISTS
    (SELECT 1 FROM refund_tombstones t WHERE t.token_hash=p.token_hash);
`;
  const tombstones = `-- Run only after verifying ownership, disabling Firebase user and waiting two hours.
-- Retains only receipt digests and timestamps; never copies UID, email or raw tokens.
INSERT OR IGNORE INTO refund_tombstones(token_hash,voided_at_ms)
SELECT token_hash,CAST(strftime('%s','now') AS INTEGER)*1000 FROM purchases
WHERE user_id=${owner} AND ${schema};
-- This count MUST be zero before running 03-purge.sql.
SELECT COUNT(*) AS uncovered_purchase_receipts FROM purchases p
WHERE p.user_id=${owner} AND NOT EXISTS
  (SELECT 1 FROM refund_tombstones t WHERE t.token_hash=p.token_hash);
`;
  const purge = `-- Private, destructive, narrowly scoped. This file is NOT an atomic transaction.
-- Never run before 02-tombstones.sql succeeds and its uncovered count is zero.
-- Keep the Firebase user disabled; no active requests may recreate account rows.
DELETE FROM purchases WHERE user_id=${owner} AND ${guard};
DELETE FROM purchase_intents WHERE user_id=${owner} AND ${guard};
DELETE FROM user_revisions WHERE user_id=${owner} AND ${guard};
DELETE FROM rate_limits WHERE user_id=${owner} AND ${guard};
-- ALL counts must be zero. A successful command alone does not prove deletion.
${preview}`;
  return { target, preview, tombstones, purge };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(`${help}\n`); return; }
  const options = new Map();
  const flags = new Set(['--uid', '--uid-file', '--output-dir', '--confirm-target']);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (options.has(flag)) fail('Duplicate option.');
    if (flag === '--prepare-deletion') { options.set(flag, true); continue; }
    if (!flags.has(flag) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('Invalid option; use --help.');
    options.set(flag, argv[++index]);
  }
  if (options.has('--uid') === options.has('--uid-file')) fail('Provide exactly one of --uid-file or --uid.');
  let uid = options.get('--uid');
  if (options.has('--uid-file')) {
    const inputPath = options.get('--uid-file');
    const stat = lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (stat.mode & 0o077) !== 0) {
      fail('UID input must be a private regular file (0600 or stricter), at most 1024 bytes.');
    }
    uid = readFileSync(inputPath, 'utf8').replace(/\r?\n$/, '');
  }
  const sql = accountDeletionSql(uid);
  const deleting = options.has('--prepare-deletion');
  if (deleting && options.get('--confirm-target') !== sql.target) fail('Deletion preparation requires --confirm-target with the exact project:UID target.');
  if (!deleting && options.has('--confirm-target')) fail('--confirm-target requires --prepare-deletion.');
  const output = options.get('--output-dir');
  if (!output || !isAbsolute(output)) fail('--output-dir must be an absolute path to a new directory outside the checkout.');
  // Resolve an existing parent to reject symlink paths leading back into checkout.
  const parent = realpathSync(dirname(resolve(output)));
  const location = resolve(parent, basename(resolve(output)));
  const within = relative(repository, location);
  if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within))) {
    fail('SQL output must be outside the checkout.');
  }
  mkdirSync(location, { mode: 0o700 }); // New directory only; never overwrite another case.
  const files = [['01-preview.sql', sql.preview]];
  if (deleting) files.push(['02-tombstones.sql', sql.tombstones], ['03-purge.sql', sql.purge]);
  for (const [name, contents] of files) {
    writeFileSync(resolve(location, name), contents, { encoding: 'utf8', mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL });
  }
  process.stdout.write(deleting ? 'Prepared three private SQL files. Nothing was executed.\n' : 'Prepared private preview SQL only. Nothing was executed.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch { process.stderr.write('Preparation failed. Check inputs, private file permissions, confirmation and output path; use --help.\n'); process.exitCode = 1; }
}
