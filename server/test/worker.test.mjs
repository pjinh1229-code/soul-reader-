import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillingWorker } from '../src/worker.mjs';
import { BillingLedger, tokenHash, DAY_MS } from '../src/ledger.mjs';
import { GoogleClientFailure } from '../src/google_clients.mjs';
import { SqliteD1 } from './sqlite_d1.mjs';

const NOW = Date.UTC(2026, 9, 27, 12);
const PROJECT = 'soul-reader-a91f5';
const PACKAGE = 'com.soulreader.soul_reader';
const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);
const req = n => ({ requestId: `request-${n}`, readingId: `reading-${n}`, productId: 'soul_reading_single', offerKey: 'single' });

function setup(t, { onAck } = {}) {
  let now = NOW;
  const db = new SqliteD1();
  t.after(() => db.close());
  const calls = { get: 0, ack: 0, voided: 0, sql: 0 };
  const originalPrepare = db.prepare.bind(db);
  const originalBatch = db.batch.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    function wrap(stmt) {
      return {
        bind: (...values) => wrap(stmt.bind(...values)),
        first: async (...args) => { calls.sql++; return stmt.first(...args); },
        all: async (...args) => { calls.sql++; return stmt.all(...args); },
        run: async (...args) => { calls.sql++; return stmt.run(...args); },
        execute: (...args) => { calls.sql++; return stmt.execute(...args); },
      };
    }
    return wrap(statement);
  };
  db.batch = statements => originalBatch(statements);
  const purchases = new Map();
  let voided = [];
  let voidedError = null;
  let voidedPages = null;
  let ackError = null;
  let getHook = null;
  const publisher = {
    async getPurchase(token) {
      calls.get++;
      if (getHook) await getHook(token);
      const value = purchases.get(token);
      if (value instanceof Error) throw value;
      if (!value) throw new GoogleClientFailure('play_purchase_not_found', { status: 404 });
      return structuredClone(value);
    },
    async acknowledge(productId, token) {
      calls.ack++;
      if (onAck) await onAck({ productId, token, db });
      if (ackError) throw ackError;
      const value = purchases.get(token);
      if (value instanceof Error || !value) throw new GoogleClientFailure('play_purchase_not_found', { status: 404 });
      value.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    },
    async listVoidedPurchases(args) {
      calls.voided++;
      if (voidedError) throw voidedError;
      if (voidedPages) {
        const index = args.pageToken ? Number(args.pageToken) : 0;
        return { voidedPurchases: structuredClone(voidedPages[index]), nextPageToken: index + 1 < voidedPages.length ? String(index + 1) : null };
      }
      return { voidedPurchases: structuredClone(voided), nextPageToken: null };
    },
  };
  const env = {
    DB: db, FIREBASE_PROJECT_ID: PROJECT, PLAY_PACKAGE_NAME: PACKAGE,
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'test@example.iam.gserviceaccount.com', private_key: 'constructor-injected-fake' }),
    ACCOUNT_HMAC_KEY: Buffer.from(KEY_A).toString('base64'), TOKEN_ENCRYPTION_KEY: Buffer.from(KEY_B).toString('base64'),
  };
  const worker = createBillingWorker({ clock: () => now,
    authenticateFactory: () => ({ async authenticate(header) {
      if (!header || !/^Bearer (alice|bob)$/.test(header)) throw new GoogleClientFailure('authentication_required', { status: 401 });
      const uid = header.slice(7);
      return { uid, userId: `${PROJECT}:${uid}`, projectId: PROJECT };
    } }), publisherFactory: () => publisher });
  const ledger = new BillingLedger(db, { accountHmacKey: KEY_A, tokenEncryptionKey: KEY_B, clock: () => now });
  async function call(path, body, user = 'alice', method = body === undefined ? 'GET' : 'POST') {
    const response = await worker.fetch(new Request(`https://billing.example${path}`, {
      method, headers: { ...(user ? { authorization: `Bearer ${user}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function prepare(n = 1, user = 'alice', changes = {}) {
    const input = { ...req(n), ...changes };
    const result = await call('/v1/billing/prepare', input, user);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { ...input, ...result.body };
  }
  function receipt(prepared, changes = {}) {
    return {
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      obfuscatedExternalAccountId: prepared.obfuscatedAccountId,
      obfuscatedExternalProfileId: prepared.obfuscatedProfileId,
      purchaseStateContext: { purchaseState: 'PURCHASED' },
      purchaseCompletionTime: new Date(now - 60_000).toISOString(),
      productLineItem: [{ productId: prepared.productId, productOfferDetails: {
        purchaseOptionId: prepared.offerKey, consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED', quantity: 1, refundableQuantity: 1,
      } }], ...changes,
    };
  }
  function verifyBody(prepared, token, withContext = true) {
    return { platform: 'android', packageName: PACKAGE, productId: prepared.productId, purchaseToken: token,
      ...(withContext ? { requestId: prepared.requestId, readingId: prepared.readingId } : {}) };
  }
  async function buy(n = 1, user = 'alice', options = {}) {
    const prepared = await prepare(n, user, options);
    const token = `token-${user}-${n}`;
    purchases.set(token, receipt(prepared));
    const result = await call('/v1/billing/verify', verifyBody(prepared, token), user);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { prepared, token, grant: result.body.entitlement };
  }
  function resetCalls() { for (const key of Object.keys(calls)) calls[key] = 0; }
  return { db, env, worker, ledger, publisher, purchases, calls, call, prepare, receipt, verifyBody, buy, resetCalls,
    setNow: value => { now = value; }, setVoided: value => { voided = value; },
    setVoidedPages: value => { voidedPages = value; },
    setVoidedError: value => { voidedError = value; }, setAckError: value => { ackError = value; }, setGetHook: value => { getHook = value; } };
}

test('missing runtime configuration and authentication fail closed without upstream calls', async t => {
  const s = setup(t);
  const missing = await s.worker.fetch(new Request('https://billing.example/v1/billing/entitlements'), {});
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: { code: 'configuration_required' } });
  const noAuth = await s.call('/v1/billing/entitlements', undefined, null);
  assert.equal(noAuth.status, 401);
  assert.equal(s.calls.get, 0);
  assert.equal(noAuth.headers.get('cache-control'), 'no-store');
});

test('purchase is encrypted and durable with finalization job before Google ACK; duplicate replay returns same grant', async t => {
  const s = setup(t, { onAck: async ({ token, db }) => {
    const row = await db.prepare('SELECT * FROM purchases WHERE token_hash=?').bind(await tokenHash(token)).first();
    assert.ok(row);
    assert.equal(row.ack_pending, 1);
    assert.equal(row.status, 'active');
    assert.ok(!row.encrypted_token.includes(token));
  } });
  const { prepared, token, grant } = await s.buy();
  const repeated = await s.call('/v1/billing/verify', s.verifyBody(prepared, token));
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.entitlement, grant);
  assert.equal(await s.db.prepare('SELECT COUNT(*) count FROM purchases').first('count'), 1);
  assert.equal(s.calls.ack, 1);
  assert.equal((await s.ledger.purchase(await tokenHash(token))).ack_pending, 0);
  const response = JSON.stringify(repeated.body);
  assert.ok(!response.includes(token));
  assert.ok(!response.includes(prepared.obfuscatedAccountId));
});

test('request/account/reading/package/product ownership cannot be reassigned by the caller', async t => {
  const s = setup(t);
  const { prepared, token, grant } = await s.buy();
  const bob = await s.call('/v1/billing/verify', s.verifyBody(prepared, token), 'bob');
  assert.equal(bob.status, 403);
  for (const changes of [{ readingId: 'other' }, { requestId: 'other' }, { productId: 'soul_reading_bundle' }]) {
    assert.equal((await s.call('/v1/billing/verify', { ...s.verifyBody(prepared, token), ...changes })).status, 409);
  }
  assert.equal((await s.call('/v1/billing/verify', { ...s.verifyBody(prepared, token), packageName: 'other.package' })).status, 400);
  assert.equal((await s.call(`/v1/billing/entitlements/${grant.entitlementId}/topic`, { topic: 'love' }, 'bob')).status, 404);
  assert.deepEqual((await s.call('/v1/billing/entitlements', undefined, 'bob')).body.entitlements, []);
});

test('new purchase recovers its immutable context from Google profile rather than a caller supplied reading', async t => {
  const s = setup(t);
  const prepared = await s.prepare();
  s.purchases.set('recovered-token', s.receipt(prepared));
  const verified = await s.call('/v1/billing/verify', s.verifyBody(prepared, 'recovered-token', false));
  assert.equal(verified.status, 200);
  assert.equal(verified.body.entitlement.readingId, prepared.readingId);
  const other = await s.prepare(2);
  s.purchases.set('stolen-owner-token', s.receipt(other, { obfuscatedExternalAccountId: 'foreign-account' }));
  assert.equal((await s.call('/v1/billing/verify', s.verifyBody(other, 'stolen-owner-token'))).status, 409);
});

test('pending, unknown consumed, unprepared, malformed quantities and options never grant', async t => {
  const s = setup(t);
  const prepared = await s.prepare();
  for (const [name, mutate, expected] of [
    ['pending', raw => { raw.purchaseStateContext.purchaseState = 'PENDING'; }, 409],
    ['consumed', raw => { raw.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED'; raw.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'; }, 400],
    ['quantity', raw => { raw.productLineItem[0].productOfferDetails.quantity = 2; }, 400],
    ['option', raw => { raw.productLineItem[0].productOfferDetails.purchaseOptionId = 'wrong'; }, 409],
    ['unprepared', raw => { raw.obfuscatedExternalProfileId = 'x'.repeat(43); }, 403],
  ]) {
    const raw = s.receipt(prepared); mutate(raw); s.purchases.set(name, raw);
    assert.equal((await s.call('/v1/billing/verify', s.verifyBody(prepared, name))).status, expected);
  }
  assert.equal(await s.db.prepare('SELECT COUNT(*) count FROM purchases').first('count'), 0);
});

test('known consumed token restores only its original durable grant and immutable topic', async t => {
  const s = setup(t);
  const { prepared, token, grant } = await s.buy();
  const raw = s.purchases.get(token);
  raw.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
  const topic = await s.call(`/v1/billing/entitlements/${grant.entitlementId}/topic`, { topic: 'work' });
  assert.equal(topic.status, 200);
  assert.equal(topic.body.entitlement.topic, 'work');
  assert.equal((await s.call(`/v1/billing/entitlements/${grant.entitlementId}/topic`, { topic: 'love' })).status, 409);
  assert.equal((await s.call('/v1/billing/verify', s.verifyBody(prepared, token))).body.entitlement.topic, 'work');
  assert.equal((await s.call('/v1/billing/entitlements')).body.entitlements[0].topic, 'work');
});

test('ACK outage preserves the grant/job and scheduled retry does not depend on refund feed availability', async t => {
  const s = setup(t);
  s.setAckError(new GoogleClientFailure('play_unavailable', { status: 503, retryable: true }));
  const { token } = await s.buy();
  assert.equal((await s.ledger.purchase(await tokenHash(token))).ack_pending, 1);
  s.setAckError(null);
  s.setVoidedError(new GoogleClientFailure('play_unavailable', { status: 503, retryable: true }));
  const beforeSync = await s.ledger.syncState();
  await assert.rejects(s.worker.scheduled({}, s.env), error => error.code === 'refund_sync_failed' && error.status === 503);
  assert.equal((await s.ledger.purchase(await tokenHash(token))).ack_pending, 0);
  const afterSync = await s.ledger.syncState();
  assert.equal(afterSync.watermark_ms, beforeSync.watermark_ms);
  assert.equal(afterSync.last_completed_ms, beforeSync.last_completed_ms);
});

test('cancel/refund tombstone permanently removes access and stale purchased replay cannot reactivate', async t => {
  const s = setup(t);
  const { prepared, token, grant } = await s.buy();
  s.purchases.get(token).purchaseStateContext.purchaseState = 'CANCELLED';
  const firstList = await s.call('/v1/billing/entitlements');
  assert.equal(firstList.status, 409);
  assert.equal(firstList.body.error.code, 'ledger_changed');
  assert.deepEqual((await s.call('/v1/billing/entitlements')).body.entitlements, []);
  s.purchases.set(token, s.receipt(prepared));
  assert.equal((await s.call('/v1/billing/verify', s.verifyBody(prepared, token))).body.error.code, 'purchase_revoked');
  assert.equal((await s.call(`/v1/billing/entitlements/${grant.entitlementId}/topic`, { topic: 'love' })).status, 404);
});

test('voided feed records unknown tokens too, and cannot grant a subsequently replayed refunded token', async t => {
  const s = setup(t);
  const prepared = await s.prepare();
  s.setVoided([{ purchaseToken: 'already-voided', voidedTimeMillis: String(NOW - 40 * DAY_MS) }]);
  await s.worker.scheduled({}, s.env);
  s.purchases.set('already-voided', s.receipt(prepared));
  assert.equal((await s.call('/v1/billing/verify', s.verifyBody(prepared, 'already-voided'))).body.error.code, 'purchase_revoked');
  assert.equal(await s.db.prepare('SELECT COUNT(*) count FROM purchases').first('count'), 0);
});

test('404/410 only serve finalized durable grant with current complete refund coverage; unavailable feed preserves ledger', async t => {
  const s = setup(t);
  const { prepared, token, grant } = await s.buy();
  for (const code of ['play_purchase_not_found', 'play_purchase_expired']) {
    s.purchases.set(token, new GoogleClientFailure(code, { status: code.endsWith('expired') ? 410 : 404 }));
    const result = await s.call('/v1/billing/verify', s.verifyBody(prepared, token));
    assert.equal(result.status, 200);
    assert.equal(result.body.entitlement.entitlementId, grant.entitlementId);
  }
  s.setNow(NOW + DAY_MS + 1);
  s.setVoidedError(new GoogleClientFailure('play_unavailable', { status: 503 }));
  assert.equal((await s.call('/v1/billing/entitlements')).status, 503);
  assert.equal((await s.ledger.purchase(await tokenHash(token))).status, 'active');
  assert.equal((await s.call('/v1/billing/verify', s.verifyBody(prepared, 'unknown-token'))).status, 404);
});

test('an unacknowledged durable grant never uses 404 fallback or blindly acknowledges the missing purchase', async t => {
  const s = setup(t);
  s.setAckError(new GoogleClientFailure('play_unavailable', { status: 503 }));
  const { prepared, token } = await s.buy();
  await s.ledger.syncRefunds(s.publisher);
  s.purchases.set(token, new GoogleClientFailure('play_purchase_not_found', { status: 404 }));
  s.resetCalls();
  const result = await s.call('/v1/billing/verify', s.verifyBody(prepared, token));
  assert.equal(result.status, 503);
  assert.equal(s.calls.ack, 0);
  assert.equal((await s.ledger.purchase(await tokenHash(token))).status, 'active');
});

test('pagination binds snapshot revision/user/page size and rejects partial results after concurrent topic change', async t => {
  const s = setup(t);
  const grants = [];
  for (let n = 1; n <= 3; n++) grants.push(await s.buy(n));
  const first = await s.call('/v1/billing/entitlements?pageSize=1');
  assert.equal(first.status, 200);
  assert.equal(first.body.entitlements.length, 1);
  assert.ok(first.body.nextCursor);
  const nextPath = `/v1/billing/entitlements?cursor=${first.body.nextCursor}`;
  const second = await s.call(nextPath);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.entitlements[0].entitlementId, first.body.entitlements[0].entitlementId);
  assert.equal((await s.call(nextPath, undefined, 'bob')).status, 400);
  assert.equal((await s.call(`${nextPath}&pageSize=2`)).status, 400);
  await s.call(`/v1/billing/entitlements/${grants[0].grant.entitlementId}/topic`, { topic: 'love' });
  assert.equal((await s.call(nextPath)).body.error.code, 'ledger_changed');
  assert.equal((await s.call('/v1/billing/entitlements?pageSize=21')).status, 400);
});

test('an upstream failure in one row fails entire snapshot instead of returning a partial successful list', async t => {
  const s = setup(t);
  const one = await s.buy(1);
  await s.buy(2);
  s.purchases.set(one.token, new GoogleClientFailure('play_unavailable', { status: 503 }));
  const result = await s.call('/v1/billing/entitlements');
  assert.equal(result.status, 503);
  assert.equal(result.body.entitlements, undefined);
});

test('20 finalized expired purchases paginate with cached refund proof below50 even with401 retries', async t => {
  const s = setup(t);
  const bought = [];
  for (let n = 1; n <= 20; n++) bought.push(await s.buy(n));
  for (const { token } of bought) s.purchases.set(token, new GoogleClientFailure('play_purchase_expired', { status: 410 }));
  s.resetCalls();
  s.setVoidedPages([[], []]);
  const seen = new Set();
  let cursor = null;
  do {
    s.resetCalls();
    const result = await s.call('/v1/billing/entitlements?pageSize=20' + (cursor ? `&cursor=${cursor}` : ''));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.entitlements.length <= 7);
    for (const grant of result.body.entitlements) {
      assert.ok(!seen.has(grant.entitlementId));
      seen.add(grant.entitlementId);
    }
    cursor = result.body.nextCursor;
    // Worst case: each logical Google call gets401 +OAuthrefresh +successfulretry.
    // Two further fetches account for real Firebase JWKS and initial Publisher OAuth.
    assert.ok(s.calls.sql + (s.calls.get + s.calls.ack + s.calls.voided) * 3 + 2 <= 50, JSON.stringify(s.calls));
  } while (cursor);
  assert.equal(seen.size, 20);
});

test('scheduled refund pages plus three acknowledgement retries stay below50 even with401 retries', async t => {
  const s = setup(t);
  s.setAckError(new GoogleClientFailure('play_unavailable', { status: 503 }));
  for (let n = 1; n <= 7; n++) await s.buy(n);
  s.setAckError(null);
  s.setVoidedPages([[], []]);
  s.resetCalls();
  await s.worker.scheduled({}, s.env);
  assert.equal(s.calls.ack, 3);
  assert.equal(s.calls.voided, 2);
  assert.ok(s.calls.sql + (s.calls.get + s.calls.ack + s.calls.voided) * 3 + 1 <= 50, JSON.stringify(s.calls));
  assert.equal((await s.ledger.pendingAcknowledgements(10)).length, 4);
});

test('concurrent refund during an expired snapshot invalidates its revision instead of returning a revoked grant', async t => {
  const s = setup(t);
  const { token } = await s.buy();
  await s.ledger.syncRefunds(s.publisher);
  s.purchases.set(token, new GoogleClientFailure('play_purchase_expired', { status: 410 }));
  let once = false;
  s.setGetHook(async () => { if (!once) { once = true; await s.ledger.revoke(await tokenHash(token)); } });
  const result = await s.call('/v1/billing/entitlements');
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'ledger_changed');
  assert.equal(result.body.entitlements, undefined);
});

test('body and error envelopes do not expose receipts/upstream secrets; oversized or extra ownership fields rejected', async t => {
  const s = setup(t);
  assert.equal((await s.call('/v1/billing/prepare', { ...req(1), userId: 'bob' })).status, 400);
  assert.equal((await s.call('/v1/billing/prepare', { ...req(1), readingId: 'x'.repeat(9000) })).status, 413);
  const prepared = await s.prepare();
  s.purchases.set('private-token', new Error('private-upstream-body-with-secret'));
  const result = await s.call('/v1/billing/verify', s.verifyBody(prepared, 'private-token'));
  assert.deepEqual(result.body, { error: { code: 'billing_storage_failed' } });
  assert.ok(!JSON.stringify(result).includes('private-upstream-body-with-secret'));
});

test('permanently missing old ACK jobs do not starve newer jobs', async t => {
  const s = setup(t);
  s.setAckError(new GoogleClientFailure('play_unavailable', { status: 503 }));
  const purchases = [];
  for (let n = 1; n <= 6; n++) purchases.push(await s.buy(n));
  for (let n = 0; n < 5; n++) s.purchases.set(purchases[n].token, new GoogleClientFailure('play_purchase_not_found', { status: 404 }));
  s.setAckError(null);
  await s.worker.scheduled({}, s.env);
  await s.worker.scheduled({}, s.env);
  assert.equal((await s.ledger.purchase(await tokenHash(purchases[5].token))).ack_pending, 0);
  for (let n = 0; n < 5; n++) assert.equal((await s.ledger.purchase(await tokenHash(purchases[n].token))).ack_pending, 1);
});
