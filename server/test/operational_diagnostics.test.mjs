import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SqliteD1 } from './sqlite_d1.mjs';
import { OPERATIONAL_ROUTES, OPERATIONAL_CODES, OPERATIONAL_STATUSES,
  isOperationalFailure, recordOperationalFailure, readOperationalDiagnostics } from '../src/operational_diagnostics.mjs';

const NOW = Date.UTC(2026, 9, 29, 12);
const FAILURE = { route: 'entitlements', stage: 'ledger', code: 'billing_storage_failed', status: 503 };
const EMPTY = { databaseSchema: false, lastFailures: [] };
function setup(t, { diagnostics = true } = {}) {
  const DB = new SqliteD1();
  t.after(() => DB.close());
  if (diagnostics) DB.prepare(readFileSync(new URL('../migrations/0002_operational_diagnostics.sql', import.meta.url), 'utf8')).run();
  else DB.prepare('DROP TABLE IF EXISTS operational_failures').run();
  return { DB };
}

test('one read reports schema readiness and fixed failure fields without touching ledger rows', async t => {
  const env = setup(t);
  const before = await env.DB.prepare('SELECT * FROM purchases').all();
  assert.deepEqual(await readOperationalDiagnostics(env, NOW), { databaseSchema: true, lastFailures: [] });
  assert.equal(await recordOperationalFailure(env, FAILURE, NOW), true);
  const originalPrepare = env.DB.prepare.bind(env.DB);
  let reads = 0;
  env.DB.prepare = sql => { reads++; return originalPrepare(sql); };
  assert.deepEqual(await readOperationalDiagnostics(env, NOW), { databaseSchema: true, lastFailures: [FAILURE] });
  assert.equal(reads, 1);
  assert.deepEqual(await env.DB.prepare('SELECT * FROM purchases').all(), before);
  assert.deepEqual((await env.DB.prepare('SELECT * FROM purchase_intents').all()).results, []);
});

test('failure writes are throttled across minute boundaries and keep at most four route slots', async t => {
  const env = setup(t);
  assert.equal(await recordOperationalFailure(env, FAILURE, NOW + 1), true);
  const changed = { ...FAILURE, stage: 'authentication', code: 'authentication_invalid', status: 401 };
  assert.equal(await recordOperationalFailure(env, changed, NOW + 59_999), false);
  assert.equal(await recordOperationalFailure(env, changed, NOW + 60_000), false);
  assert.equal(await recordOperationalFailure(env, changed, NOW + 120_000), true);
  for (const route of OPERATIONAL_ROUTES) {
    await recordOperationalFailure(env, { ...changed, route }, NOW + 240_000);
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM operational_failures').first()).n, 4);
  const result = await readOperationalDiagnostics(env, NOW + 240_000);
  assert.equal(result.lastFailures.length, 4);
  assert.equal(JSON.stringify(result).includes('updated_ms'), false);
});

test('schema probe stays ready with populated billing tables and exposes none of their values', async t => {
  const env = setup(t);
  const marker = 'private-billing-row-fixture';
  await env.DB.prepare(`INSERT INTO purchase_intents
    (user_id,request_id,reading_id,product_id,offer_key,account_id,profile_id,created_at_ms)
    VALUES(?,?,?,'soul_reading_single','single',?,?,?)`).bind(marker, marker, marker, marker, marker, NOW).run();
  await env.DB.prepare(`INSERT INTO purchases
    (token_hash,encrypted_token,entitlement_id,transaction_id,user_id,request_id,reading_id,
     product_id,offer_key,status,ack_pending,created_at_ms,last_verified_ms)
    VALUES(?,?,?,?,?,?,?,'soul_reading_single','single','active',0,?,?)`)
    .bind(marker, marker, marker, marker, marker, marker, marker, NOW, NOW).run();
  await env.DB.prepare('INSERT INTO rate_limits(user_id,action,minute,count) VALUES(?,?,?,1)')
    .bind(marker, marker, Math.floor(NOW / 60_000)).run();
  await env.DB.prepare('INSERT INTO refund_tombstones(token_hash,voided_at_ms) VALUES(?,?)').bind(marker, NOW).run();
  const result = await readOperationalDiagnostics(env, NOW);
  assert.deepEqual(result, { databaseSchema: true, lastFailures: [] });
  assert.equal(JSON.stringify(result).includes(marker), false);
});

test('failures expire after ten minutes from their rounded timestamp without exposing time', async t => {
  const env = setup(t);
  assert.equal(await recordOperationalFailure(env, FAILURE, NOW + 1), true);
  // The stored minute rounds upward, so this boundary is just under 11 minutes
  // after the actual failure. One millisecond later it must disappear.
  assert.deepEqual(await readOperationalDiagnostics(env, NOW + 11 * 60_000),
    { databaseSchema: true, lastFailures: [FAILURE] });
  assert.deepEqual(await readOperationalDiagnostics(env, NOW + 11 * 60_000 + 1),
    { databaseSchema: true, lastFailures: [] });
});

test('nulls, enum injection, bad stages and timestamps never reach the database', async () => {
  let queries = 0;
  const env = { DB: { prepare() { queries++; throw new Error('private-prepare-fixture'); } } };
  for (const failure of [null, [], {}, { ...FAILURE, route: "verify'); DROP TABLE purchases;--" },
    { ...FAILURE, stage: 'purchase_verify' }, { ...FAILURE, code: 'private-code-fixture' },
    { ...FAILURE, status: '503' }, { ...FAILURE, status: 500 }]) {
    assert.equal(isOperationalFailure(failure), false);
    assert.equal(await recordOperationalFailure(env, failure, NOW), false);
  }
  for (const now of [null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await recordOperationalFailure(env, FAILURE, now), false);
    assert.deepEqual(await readOperationalDiagnostics(env, now), EMPTY);
  }
  assert.equal(queries, 0);
});

test('SQL constraints independently reject non-whitelisted and null diagnostic metadata', async t => {
  const env = setup(t);
  const insert = values => env.DB.prepare('INSERT INTO operational_failures(route,stage,code,status,updated_ms) VALUES(?,?,?,?,?)').bind(...values).run();
  for (const values of [
    ['private-route-fixture', 'ledger', 'billing_storage_failed', 503, NOW],
    ['entitlements', 'private-stage-fixture', 'billing_storage_failed', 503, NOW],
    ['entitlements', 'ledger', 'private-code-fixture', 503, NOW],
    ['entitlements', 'purchase_verify', 'billing_storage_failed', 503, NOW],
    ['entitlements', 'ledger', 'billing_storage_failed', 500, NOW],
    ['entitlements', 'ledger', 'billing_storage_failed', 503, NOW + 1],
    [null, 'ledger', 'billing_storage_failed', 503, NOW],
    ['entitlements', null, 'billing_storage_failed', 503, NOW],
    ['entitlements', 'ledger', null, 503, NOW],
    ['entitlements', 'ledger', 'billing_storage_failed', null, NOW],
    ['entitlements', 'ledger', 'billing_storage_failed', 503, null],
  ]) await assert.rejects(insert(values));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM operational_failures').first()).n, 0);
  // Every exported enum value is accepted by the independent migration constraints.
  for (const [i, code] of OPERATIONAL_CODES.entries()) {
    assert.equal(await recordOperationalFailure(env, { ...FAILURE, code }, NOW + i * 120_000), true);
  }
  for (const [i, status] of OPERATIONAL_STATUSES.entries()) {
    assert.equal(await recordOperationalFailure(env, { ...FAILURE, status }, NOW + (i + OPERATIONAL_CODES.length) * 120_000), true);
  }
});

test('missing migrations, required columns and singleton metadata fail schema readiness safely', async t => {
  const missingMigration = setup(t, { diagnostics: false });
  assert.equal(await recordOperationalFailure(missingMigration, FAILURE, NOW), false);
  assert.deepEqual(await readOperationalDiagnostics(missingMigration, NOW), EMPTY);
  const missingColumn = setup(t);
  await missingColumn.DB.prepare('ALTER TABLE rate_limits RENAME COLUMN count TO wrong_count').run();
  assert.deepEqual(await readOperationalDiagnostics(missingColumn, NOW), EMPTY);
  const missingSingleton = setup(t);
  await missingSingleton.DB.prepare('DELETE FROM refund_sync').run();
  assert.deepEqual(await readOperationalDiagnostics(missingSingleton, NOW), EMPTY);
});

test('reader sanitizes hostile stored rows and emits neither private fixtures nor timestamps', async () => {
  const rows = [
    { database_schema: 1, ...FAILURE, updated_ms: NOW, private: 'private-field-fixture' },
    { database_schema: 1, ...FAILURE, route: 'verify', stage: 'purchase_verify', code: 'private-code-fixture', updated_ms: NOW },
    { database_schema: 1, ...FAILURE, route: 'topic', stage: 'topic_select', updated_ms: NOW + 120_000 },
    { database_schema: 1, ...FAILURE, route: 'prepare', updated_ms: null },
  ];
  const env = { DB: { prepare: () => ({ all: async () => ({ success: true, results: rows }) }) } };
  const result = await readOperationalDiagnostics(env, NOW);
  assert.deepEqual(result, { databaseSchema: true, lastFailures: [FAILURE] });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes(String(NOW)), false);
});

test('reader rejects a corrupt real SQLite diagnostic row even if constraints were bypassed', async t => {
  const env = setup(t);
  await env.DB.prepare('PRAGMA ignore_check_constraints=ON').run();
  await env.DB.prepare('INSERT INTO operational_failures(route,stage,code,status,updated_ms) VALUES(?,?,?,?,?)')
    .bind('verify', 'purchase_verify', 'private-corrupt-row-fixture', 503, NOW).run();
  assert.deepEqual(await readOperationalDiagnostics(env, NOW), { databaseSchema: true, lastFailures: [] });
});

test('database read/write failures and constructor-shaped fakes never throw or prove readiness', async () => {
  const broken = { DB: { prepare() { throw new Error('private-sql-error-fixture'); } } };
  for (const env of [null, {}, { DB: { prepare() {}, batch() {} } }, broken,
    { get DB() { throw new Error('private-binding-error-fixture'); } },
    { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('private-write-error-fixture'); } }),
      all: async () => { throw new Error('private-read-error-fixture'); } }) } }]) {
    assert.equal(await recordOperationalFailure(env, FAILURE, NOW), false);
    assert.deepEqual(await readOperationalDiagnostics(env, NOW), EMPTY);
  }
});
