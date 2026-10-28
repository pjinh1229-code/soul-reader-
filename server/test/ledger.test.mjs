import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BillingLedger, BillingServerFailure, secretKey, tokenHash, DAY_MS } from '../src/ledger.mjs';
import { SqliteD1 } from './sqlite_d1.mjs';

const NOW = Date.UTC(2026, 9, 27, 12);
const keys = { accountHmacKey: new Uint8Array(32).fill(1), tokenEncryptionKey: new Uint8Array(32).fill(2) };
const USER = 'soul-reader-a91f5:alice';
const request = n => ({ requestId: `request-${n}`, readingId: `reading-${n}`, productId: 'soul_reading_single', offerKey: 'single' });
function setup(t, clock = () => NOW) {
  const db = new SqliteD1();
  t.after(() => db.close());
  return { db, ledger: new BillingLedger(db, { ...keys, clock }) };
}
async function insert(ledger, n = 1, user = USER) {
  const intent = await ledger.prepare(user, request(n));
  const token = `purchase-token-${user}-${n}`;
  const row = await ledger.storePurchase(user, intent, token, await tokenHash(token), false);
  return { row, token, intent };
}
function rejects(code) { return e => e instanceof BillingServerFailure && e.code === code; }

test('secret key parser requires canonical base64 exactly32 bytes', () => {
  assert.equal(secretKey(Buffer.alloc(32, 1).toString('base64')).length, 32);
  for (const value of [null, '', 'a'.repeat(43), Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    assert.throws(() => secretKey(value), rejects('configuration_required'));
  }
});

test('prepared intent is stable across concurrent repeats and cannot be rebound', async t => {
  const { ledger } = setup(t);
  const [one, two] = await Promise.all([ledger.prepare(USER, request(1)), ledger.prepare(USER, request(1))]);
  assert.equal(one.profile_id, two.profile_id);
  assert.equal(one.account_id.length, 43);
  assert.notEqual(one.account_id, USER);
  assert.notEqual((await ledger.prepare('soul-reader-a91f5:bob', request(1))).account_id, one.account_id);
  await assert.rejects(ledger.prepare(USER, { ...request(1), readingId: 'another' }), rejects('purchase_context_mismatch'));
});

test('one token/intent makes exactly one encrypted durable entitlement, even with concurrent duplicate verifies', async t => {
  const { db, ledger } = setup(t);
  const intent = await ledger.prepare(USER, request(1));
  const token = 'private-google-purchase-token';
  const hash = await tokenHash(token);
  const [a, b] = await Promise.all([
    ledger.storePurchase(USER, intent, token, hash, false),
    ledger.storePurchase(USER, intent, token, hash, false),
  ]);
  assert.equal(a.entitlement_id, b.entitlement_id);
  assert.equal(await ledger.revision(USER), 1);
  assert.equal(await db.prepare('SELECT COUNT(*) count FROM purchases').first('count'), 1);
  assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM purchases').all()).includes(token));
  assert.equal(await ledger.decryptToken(a), token);
  await assert.rejects(ledger.decryptToken({ ...a, token_hash: await tokenHash('tampered') }), rejects('billing_storage_failed'));
  await assert.rejects(ledger.storePurchase(USER, intent, 'different-token', await tokenHash('different-token'), false), rejects('purchase_context_mismatch'));
});

test('SQLite enforces immutable owner, transaction, topic, and revoked-state tombstones', async t => {
  const { db, ledger } = setup(t);
  const { row, intent, token } = await insert(ledger);
  await assert.rejects(db.prepare('UPDATE purchases SET user_id=? WHERE token_hash=?').bind('other', row.token_hash).run());
  const topics = await Promise.allSettled([
    ledger.selectTopic(USER, row.entitlement_id, 'love'),
    ledger.selectTopic(USER, row.entitlement_id, 'work'),
  ]);
  assert.equal(topics.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(topics.filter(x => x.status === 'rejected' && x.reason.code === 'topic_already_selected').length, 1);
  const current = await ledger.purchase(row.token_hash);
  assert.equal((await ledger.selectTopic(USER, row.entitlement_id, current.topic)).topic, current.topic);
  await ledger.revoke(row.token_hash);
  await assert.rejects(db.prepare("UPDATE purchases SET status='active' WHERE token_hash=?").bind(row.token_hash).run());
  await assert.rejects(ledger.storePurchase(USER, intent, token, row.token_hash, true), rejects('purchase_revoked'));
  assert.equal((await ledger.purchase(row.token_hash)).status, 'revoked');
});

test('refund tombstones arriving before a verify cannot be bypassed by a later ledger insert', async t => {
  const { ledger } = setup(t);
  const intent = await ledger.prepare(USER, request(1));
  const hash = await tokenHash('refunded-before-verify');
  await ledger.revoke(hash);
  await assert.rejects(ledger.storePurchase(USER, intent, 'refunded-before-verify', hash, true), rejects('purchase_revoked'));
  assert.equal(await ledger.purchase(hash), null);
});

test('D1 batch rolls back tombstones and status changes together on a failed statement', async t => {
  const { db, ledger } = setup(t);
  const { row } = await insert(ledger);
  await assert.rejects(db.batch([
    db.prepare("UPDATE purchases SET status='revoked' WHERE token_hash=?").bind(row.token_hash),
    db.prepare("UPDATE purchases SET status='active' WHERE token_hash=?").bind(row.token_hash),
  ]));
  assert.equal((await ledger.purchase(row.token_hash)).status, 'active');
  assert.equal(await ledger.revision(USER), 1);
});

test('cursor HMAC binds user, revision, page size and position', async t => {
  const { ledger } = setup(t);
  const { row } = await insert(ledger);
  const value = await ledger.encodeCursor(USER, 1, row.entitlement_id, 20);
  assert.equal((await ledger.decodeCursor(value, USER)).after, row.entitlement_id);
  await assert.rejects(ledger.decodeCursor(value, 'another'), rejects('invalid_cursor'));
  await assert.rejects(ledger.decodeCursor(value.replace(/^./, value[0] === 'a' ? 'b' : 'a'), USER), rejects('invalid_cursor'));
});

test('a paused refund pass keeps cursor and old watermark, then commits tombstones before completion', async t => {
  const { ledger } = setup(t);
  const { row, token } = await insert(ledger);
  const calls = [];
  const publisher = { async listVoidedPurchases(args) {
    calls.push(args);
    return args.pageToken ? { voidedPurchases: [], nextPageToken: null }
      : { voidedPurchases: [{ purchaseToken: token, voidedTimeMillis: String(NOW - 40 * DAY_MS) }], nextPageToken: 'page-two' };
  } };
  assert.equal(await ledger.syncRefunds(publisher, 1), false);
  let state = await ledger.syncState();
  assert.equal(state.watermark_ms, 0);
  assert.equal(state.last_completed_ms, 0);
  assert.equal(state.page_token, 'page-two');
  assert.equal((await ledger.purchase(row.token_hash)).status, 'revoked');
  assert.equal(await ledger.syncRefunds(publisher, 1), true);
  state = await ledger.syncState();
  assert.equal(state.watermark_ms, NOW);
  assert.equal(state.last_completed_ms, NOW);
  assert.equal(state.range_start_ms, null);
  assert.equal(calls[1].pageToken, 'page-two');
});

test('malformed/looping/failed voided page cannot advance watermark or mark refunds fresh', async t => {
  const { ledger } = setup(t);
  await assert.rejects(ledger.syncRefunds({ listVoidedPurchases: async () => ({ voidedPurchases: [{ purchaseToken: 'x' }], nextPageToken: null }) }));
  assert.equal((await ledger.syncState()).watermark_ms, 0);
  await assert.rejects(ledger.syncRefunds({ listVoidedPurchases: async () => { throw Error('upstream'); } }));
  assert.equal((await ledger.syncState()).last_completed_ms, 0);
  await assert.rejects(ledger.syncRefunds({ listVoidedPurchases: async () => ({ voidedPurchases: [], nextPageToken: 'loop' }) }, 2));
  assert.equal((await ledger.syncState()).watermark_ms, 0);
});

test('freshness expires after24h and missed retention windows forbid fallback for older unverified grants', async t => {
  let now = NOW;
  const { ledger } = setup(t, () => now);
  const { row } = await insert(ledger);
  const publisher = { listVoidedPurchases: async () => ({ voidedPurchases: [], nextPageToken: null }) };
  await ledger.syncRefunds(publisher);
  assert.equal(await ledger.refundsFresh(row), true);
  now += DAY_MS + 1;
  assert.equal(await ledger.refundsFresh(row), false);
  now += 31 * DAY_MS;
  await ledger.syncRefunds(publisher);
  assert.equal(await ledger.refundsFresh(row), false);
  await ledger.verified(row.token_hash, true);
  assert.equal(await ledger.refundsFresh(await ledger.purchase(row.token_hash)), true);
});

test('file-backed ledger survives process/database re-open with token identity, topic, and retry job', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'billing.sqlite');
  let db = new SqliteD1(path);
  let ledger = new BillingLedger(db, { ...keys, clock: () => NOW });
  const { row, token } = await insert(ledger);
  await ledger.selectTopic(USER, row.entitlement_id, 'bond');
  db.close();
  db = new SqliteD1(path, { migrate: false });
  t.after(() => db.close());
  ledger = new BillingLedger(db, { ...keys, clock: () => NOW });
  const restored = await ledger.purchase(await tokenHash(token));
  assert.equal(restored.entitlement_id, row.entitlement_id);
  assert.equal(restored.topic, 'bond');
  assert.equal(restored.ack_pending, 1);
  assert.equal(await ledger.decryptToken(restored), token);
  assert.equal(await ledger.revision(USER), 2);
});

test('per-user fixed-minute rate cap is durable and does not stop another owner', async t => {
  const { ledger } = setup(t);
  await ledger.rateLimit(USER, 'verify', 1);
  await assert.rejects(ledger.rateLimit(USER, 'verify', 1), rejects('billing_rate_limited'));
  await ledger.rateLimit('soul-reader-a91f5:bob', 'verify', 1);
});

test('finishing a days-old persisted range cannot make its old watermark fresh today', async t => {
  let now = NOW;
  const { ledger } = setup(t, () => now);
  const { row } = await insert(ledger);
  await ledger.syncRefunds({ listVoidedPurchases: async () => ({ voidedPurchases: [], nextPageToken: 'resume-later' }) }, 1);
  now += 3 * DAY_MS;
  await ledger.syncRefunds({ listVoidedPurchases: async args => {
    assert.equal(args.pageToken, 'resume-later');
    return { voidedPurchases: [], nextPageToken: null };
  } }, 1);
  const stale = await ledger.syncState();
  assert.equal(stale.watermark_ms, NOW);
  assert.equal(stale.last_completed_ms, NOW);
  assert.equal(await ledger.refundsFresh(row), false);
  await ledger.syncRefunds({ listVoidedPurchases: async () => ({ voidedPurchases: [], nextPageToken: null }) });
  assert.equal((await ledger.syncState()).watermark_ms, now);
  assert.equal(await ledger.refundsFresh(row), true);
});

test('moving clocks cannot put an initial refund range outside the Google30-day retention limit', async t => {
  let now = NOW;
  const { ledger } = setup(t, () => now++);
  await ledger.syncRefunds({ listVoidedPurchases: async args => {
    const publisherNow = now + 2;
    assert.ok(args.startTimeMs >= publisherNow - 30 * DAY_MS);
    assert.ok(args.endTimeMs <= publisherNow);
    assert.ok(args.endTimeMs - args.startTimeMs < 30 * DAY_MS);
    return { voidedPurchases: [], nextPageToken: null };
  } });
});

test('a failed first refund query can resume after the retention headroom expires', async t => {
  let now = NOW;
  const { ledger } = setup(t, () => now);
  await assert.rejects(ledger.syncRefunds({ listVoidedPurchases: async () => { throw Error('temporary failure'); } }));
  const oldStart = (await ledger.syncState()).range_start_ms;
  now += 10 * 60_000;
  await ledger.syncRefunds({ listVoidedPurchases: async args => {
    assert.ok(args.startTimeMs > oldStart);
    assert.ok(args.startTimeMs >= now - 30 * DAY_MS);
    return { voidedPurchases: [], nextPageToken: null };
  } });
  assert.equal((await ledger.syncState()).watermark_ms, now);
});
