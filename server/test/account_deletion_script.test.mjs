import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { accountDeletionSql, PROJECT_ID } from '../scripts/prepare-account-deletion.mjs';

const script = fileURLToPath(new URL('../scripts/prepare-account-deletion.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const migration = readFileSync(new URL('../migrations/0001_billing.sql', import.meta.url), 'utf8');
const python = String.raw`
import json,sqlite3,sys
value=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.executescript(value['migration'])
target=value['target']
other='soul-reader-a91f5:other-user'
for n,owner in enumerate([target,other]):
 db.execute("INSERT INTO purchase_intents VALUES(?,?,?,?,?,?,?,?)",(owner,'request-'+str(n),'reading-'+str(n),'soul_reading_single','single','account-'+str(n),'profile-'+str(n),1))
 db.execute("INSERT INTO purchases(token_hash,encrypted_token,entitlement_id,transaction_id,user_id,request_id,reading_id,product_id,offer_key,topic,status,ack_pending,created_at_ms,last_verified_ms) VALUES(?,?,?,?,?,?,?,?,?,NULL,'active',1,1,1)",('hash-'+str(n),'encrypted-'+str(n),'entitlement-'+str(n),'transaction-'+str(n),owner,'request-'+str(n),'reading-'+str(n),'soul_reading_single','single'))
 db.execute("INSERT INTO rate_limits VALUES(?,'list',1,1)",(owner,))
db.execute("INSERT INTO refund_tombstones VALUES('existing-refund',7)")
db.commit()
tables=['purchases','purchase_intents','user_revisions','rate_limits']
def counts(owner):
 return {table:db.execute('SELECT COUNT(*) FROM '+table+' WHERE user_id=?',(owner,)).fetchone()[0] for table in tables}
before=counts(other)
mode=value['mode']
if mode=='uncovered':
 db.executescript(value['purge'])
 assert counts(target)=={'purchases':1,'purchase_intents':1,'user_revisions':1,'rate_limits':1}
elif mode=='missing':
 db.executescript(value['tombstones'])
 db.execute('PRAGMA foreign_keys=OFF')
 missing=value['missing']
 db.execute('DROP TABLE '+missing)
 db.execute('PRAGMA foreign_keys=ON')
 remaining=[table for table in tables+['refund_tombstones'] if table!=missing]
 snapshot={table:db.execute('SELECT * FROM '+table).fetchall() for table in remaining}
 try:
  db.executescript(value['purge'])
  raise AssertionError('missing table did not block purge')
 except sqlite3.OperationalError:
  pass
 assert snapshot=={table:db.execute('SELECT * FROM '+table).fetchall() for table in remaining}
 print(json.dumps({'blocked':True}))
 sys.exit(0)
else:
 # No changes in default preview; production foreign keys remain enabled.
 snapshot=counts(target)
 db.executescript(value['preview'])
 assert counts(target)==snapshot
 assert db.execute('PRAGMA foreign_keys').fetchone()[0]==1
 db.executescript(value['tombstones'])
 assert db.execute("SELECT COUNT(*) FROM purchases p WHERE p.user_id=? AND NOT EXISTS(SELECT 1 FROM refund_tombstones t WHERE t.token_hash=p.token_hash)",(target,)).fetchone()[0]==0
 db.executescript(value['purge'])
 assert all(n==0 for n in counts(target).values())
 # All phases remain safe when rerun after completion.
 db.executescript(value['tombstones'])
 db.executescript(value['purge'])
 assert db.execute("SELECT COUNT(*) FROM refund_tombstones WHERE token_hash='hash-0'").fetchone()[0]==1
 assert db.execute("SELECT COUNT(*) FROM refund_tombstones WHERE token_hash='hash-1'").fetchone()[0]==0
 assert db.execute("SELECT voided_at_ms FROM refund_tombstones WHERE token_hash='existing-refund'").fetchone()[0]==7
 assert [row[1] for row in db.execute('PRAGMA table_info(refund_tombstones)')]==['token_hash','voided_at_ms']
assert counts(other)==before
assert db.execute('SELECT COUNT(*) FROM refund_sync').fetchone()[0]==1
print(json.dumps({'isolated':True}))
`;

function sqlite(sql, mode = 'delete', missing) {
  const result = spawnSync('python3', ['-c', python], {
    input: JSON.stringify({ ...sql, migration, mode, missing }), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function fixture(t) {
  const path = mkdtempSync(resolve(tmpdir(), 'account-deletion-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const uidFile = resolve(path, 'uid.txt');
  writeFileSync(uidFile, 'test-user\n', { mode: 0o600 });
  return { path, uidFile, output: resolve(path, 'sql') };
}
const cli = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('generated SQL isolates user, respects foreign keys, retains receipt protection and is rerunnable', () => {
  assert.deepEqual(sqlite(accountDeletionSql('test-user')), { isolated: true });
});

test('SQL literals safely preserve quoted, unicode and injection-shaped Firebase UIDs', () => {
  for (const uid of ["O'Hara", "x'; DELETE FROM purchases; --", '사용자:東京']) {
    assert.deepEqual(sqlite(accountDeletionSql(uid)), { isolated: true });
  }
  for (const uid of ['', 'a'.repeat(129), 'line\nbreak', 'nul\x00value', '\x7f']) {
    assert.throws(() => accountDeletionSql(uid));
  }
});

test('purge without complete receipt tombstones leaves every account row intact', () => {
  assert.deepEqual(sqlite(accountDeletionSql('test-user'), 'uncovered'), { isolated: true });
});

test('each missing required ledger table blocks purge without partial deletion', () => {
  for (const missing of ['purchases', 'purchase_intents', 'user_revisions', 'rate_limits', 'refund_tombstones']) {
    assert.deepEqual(sqlite(accountDeletionSql('test-user'), 'missing', missing), { blocked: true });
  }
});

test('CLI defaults to private read-only preview outside checkout without printing UID', (t) => {
  const f = fixture(t);
  const result = cli(['--uid-file', f.uidFile, '--output-dir', f.output]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.output), ['01-preview.sql']);
  assert.equal(statSync(f.output).mode & 0o777, 0o700);
  assert.equal(statSync(resolve(f.output, '01-preview.sql')).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /test-user/);
  assert.doesNotMatch(readFileSync(resolve(f.output, '01-preview.sql'), 'utf8'), /\b(?:DELETE|INSERT|UPDATE)\b/);
});

test('CLI needs explicit exact confirmation and never overwrites an existing case', (t) => {
  const f = fixture(t);
  const base = ['--uid-file', f.uidFile, '--output-dir', f.output, '--prepare-deletion'];
  assert.notEqual(cli(base).status, 0);
  assert.notEqual(cli([...base, '--confirm-target', 'other-project:test-user']).status, 0);
  const complete = [...base, '--confirm-target', `${PROJECT_ID}:test-user`];
  const result = cli(complete);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.output), ['01-preview.sql', '02-tombstones.sql', '03-purge.sql']);
  for (const file of readdirSync(f.output)) assert.equal(statSync(resolve(f.output, file)).mode & 0o777, 0o600);
  assert.notEqual(cli(complete).status, 0);
});

test('CLI rejects checkout output, symlink escapes, public UID files and invalid options', (t) => {
  const f = fixture(t);
  const inside = resolve(repo, 'generated-account-deletion-private-test');
  assert.notEqual(cli(['--uid-file', f.uidFile, '--output-dir', inside]).status, 0);
  symlinkSync(repo, resolve(f.path, 'repo-link'));
  assert.notEqual(cli(['--uid-file', f.uidFile, '--output-dir', resolve(f.path, 'repo-link/sql')]).status, 0);
  const publicInput = resolve(f.path, 'public-uid');
  writeFileSync(publicInput, 'test-user', { mode: 0o644 });
  chmodSync(publicInput, 0o644);
  assert.notEqual(cli(['--uid-file', publicInput, '--output-dir', f.output]).status, 0);
  assert.notEqual(cli(['--uid', 'test-user', '--uid-file', f.uidFile, '--output-dir', f.output]).status, 0);
  assert.notEqual(cli(['--uid-file', f.uidFile, '--output-dir', 'relative']).status, 0);
  assert.notEqual(cli(['--uid-file', f.uidFile, '--output-dir', f.output, '--unknown']).status, 0);
});
