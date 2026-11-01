import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillingWorker } from '../src/worker.mjs';
import { cleanupReviewRateLimits } from '../src/review_access.mjs';
import { SqliteD1 } from './sqlite_d1.mjs';

const NOW = Date.UTC(2026, 9, 27, 12);
// Synthetic deterministic fixtures, never a deployed review credential.
const SECRET = Buffer.alloc(32, 17).toString('base64url');
const HMAC = Buffer.alloc(32, 23).toString('base64');
const LOGIN = { username: 'play-review', accessCode: SECRET };
const SUCCESS = { access: 'review', sessionDurationSeconds: 3600 };
const IP = '203.0.113.19';

function setup(t) {
  const db = new SqliteD1();
  t.after(() => db.close());
  let now = NOW;
  let runtimeCalls = 0;
  const env = { DB: db, PLAY_REVIEW_ACCESS_CODE: SECRET, ACCOUNT_HMAC_KEY: HMAC };
  const worker = createBillingWorker({ clock: () => now,
    authenticateFactory: () => { runtimeCalls++; throw new Error('synthetic-authentication-runtime-error'); },
    publisherFactory: () => { runtimeCalls++; throw new Error('synthetic-publisher-runtime-error'); } });
  async function call({ value = LOGIN, raw, ip = IP, method = 'POST', path = '/v1/review-access',
    headers = {}, bindings = env, body, protocol = 'https:' } = {}) {
    const request = new Request(`${protocol}//billing.example${path}`, {
      method, headers: { 'content-type': 'application/json', ...(ip === null ? {} : { 'CF-Connecting-IP': ip }), ...headers },
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: body ?? raw ?? JSON.stringify(value) }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
    const response = await worker.fetch(request, bindings);
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
  }
  return { db, env, worker, call, setNow: value => { now = value; }, runtimeCalls: () => runtimeCalls };
}

function error(result, status, code) {
  assert.equal(result.status, status, result.text);
  assert.deepEqual(result.body, { error: { code } });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.text.includes(SECRET), false);
  assert.equal(result.text.includes(HMAC), false);
  assert.equal(result.text.includes(IP), false);
}

test('public review login works before Google, Firebase and encryption configuration without issuing a token or grant', async t => {
  const s = setup(t);
  const result = await s.call();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, SUCCESS);
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(s.runtimeCalls(), 0);
  for (const table of ['purchase_intents', 'purchases', 'user_revisions', 'refund_tombstones']) {
    assert.equal(await s.db.prepare(`SELECT count(*) AS count FROM ${table}`).first('count'), 0);
  }
  assert.equal((await s.db.prepare('SELECT watermark_ms FROM refund_sync').first()).watermark_ms, 0);
  const rows = (await s.db.prepare('SELECT * FROM rate_limits').all()).results;
  assert.equal(rows.length, 1);
  assert.match(rows[0].user_id, /^review:[A-Za-z0-9_-]{43}$/);
  assert.equal(rows[0].action, 'review_login');
  assert.equal(rows[0].count, 1);
  assert.equal(JSON.stringify(rows).includes(IP), false);
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
  assert.equal(JSON.stringify(rows).includes('play-review'), false);
  const key = await crypto.subtle.importKey('raw', Buffer.from(HMAC, 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`review-ip\0${IP}`))).toString('base64url');
  assert.equal(rows[0].user_id, `review:${expected}`);
});

test('wrong code and username share a fixed denial without leaking input', async t => {
  const s = setup(t);
  for (const value of [
    { ...LOGIN, accessCode: 'synthetic-wrong-private-code' },
    { ...LOGIN, accessCode: '' },
    { ...LOGIN, username: 'synthetic-private-username' },
    { username: 'PLAY-REVIEW', accessCode: SECRET },
  ]) {
    const result = await s.call({ value });
    error(result, 401, 'review_access_denied');
    assert.equal(result.text.includes('synthetic-'), false);
  }
});

test('review configuration fails closed for missing and noncanonical secrets, keys and database', async t => {
  const s = setup(t);
  for (const overrides of [
    { PLAY_REVIEW_ACCESS_CODE: undefined }, { PLAY_REVIEW_ACCESS_CODE: '' },
    { PLAY_REVIEW_ACCESS_CODE: SECRET + '=' },
    { PLAY_REVIEW_ACCESS_CODE: SECRET.slice(0, -1) + 'F' },
    { PLAY_REVIEW_ACCESS_CODE: '-'.repeat(43) },
    { ACCOUNT_HMAC_KEY: undefined }, { ACCOUNT_HMAC_KEY: HMAC.slice(0, -1) },
    { DB: undefined }, { DB: { prepare() {} } },
    { DB: { prepare() { throw new Error('synthetic-private-sql-error'); }, batch() {} } },
  ]) {
    const result = await s.call({ bindings: { ...s.env, ...overrides } });
    error(result, 503, 'review_configuration_required');
    assert.equal(result.text.includes('synthetic-'), false);
  }
  const unmigrated = new SqliteD1(':memory:', { migrate: false });
  t.after(() => unmigrated.close());
  error(await s.call({ bindings: { ...s.env, DB: unmigrated } }), 503, 'review_configuration_required');
});

test('review endpoint requires exact HTTPS POST with no query and advertises only POST', async t => {
  const s = setup(t);
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const result = await s.call({ method });
    error(result, 405, 'invalid_request');
    assert.equal(result.headers.get('allow'), 'POST');
  }
  error(await s.call({ path: '/v1/review-access?debug=1' }), 400, 'invalid_request');
  error(await s.call({ path: '/v1/review-access?' }), 400, 'invalid_request');
  error(await s.call({ protocol: 'http:' }), 400, 'invalid_request');
  assert.equal(s.runtimeCalls(), 0);
});

test('review endpoint validates content type, JSON fields, UTF-8 and declared size', async t => {
  const s = setup(t);
  const invalid = [
    { headers: { 'content-type': 'text/plain' } },
    { headers: { 'content-type': 'application/jsonp' } },
    { headers: { 'content-type': 'application/json; charset=latin1' } },
    { headers: { 'content-length': '1025' } },
    { headers: { 'content-length': '-1' } },
    { raw: '{synthetic-private-malformed-json' },
    { raw: '[]' }, { raw: 'null' }, { value: { ...LOGIN, extra: true } },
    { value: { username: 'play-review' } }, { value: { accessCode: SECRET } },
    { value: { ...LOGIN, accessCode: 123 } }, { value: { ...LOGIN, username: null } },
    { body: new Uint8Array([0xff]) },
  ];
  for (const [index, options] of invalid.entries()) {
    const result = await s.call({ ...options, ip: `203.0.113.${index + 40}` });
    error(result, 400, 'invalid_request');
    assert.equal(result.text.includes('synthetic-'), false);
  }
  assert.deepEqual((await s.call({ headers: { 'content-type': 'Application/JSON; charset=UTF-8' } })).body, SUCCESS);
});

test('review body reader accepts exactly1024 bytes and cancels oversized streamed requests', async t => {
  const s = setup(t);
  const raw = JSON.stringify(LOGIN);
  assert.deepEqual((await s.call({ raw: raw.padEnd(1024, ' ') })).body, SUCCESS);
  error(await s.call({ raw: raw.padEnd(1025, ' ') }), 400, 'invalid_request');
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(400).fill(32)); },
    cancel() { cancelled = true; },
  });
  error(await s.call({ body }), 400, 'invalid_request');
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4, `read ${chunks} chunks`);
});

test('missing and invalid Cloudflare source IPs fail closed without a shared rate-limit bucket', async t => {
  const s = setup(t);
  for (const ip of [null, '', 'unknown', '256.1.1.1', '1.2.3', '01.2.3.4', '203.0.113.19, 203.0.113.20',
    '2001:db8:::1', '[2001:db8::1]', 'fe80::1%eth0']) {
    error(await s.call({ ip, headers: { 'x-forwarded-for': IP, 'x-real-ip': IP } }), 400, 'invalid_request');
  }
  assert.equal(await s.db.prepare('SELECT count(*) AS count FROM rate_limits').first('count'), 0);
});

test('durable per-IP limit allows10 attempts per minute across worker instances and isolates billing counters', async t => {
  const s = setup(t);
  const minute = Math.floor(NOW / 60_000);
  await s.db.prepare("INSERT INTO rate_limits VALUES('alice','verify',?,30)").bind(minute).run();
  for (let attempt = 1; attempt <= 10; attempt++) {
    error(await s.call({ value: { ...LOGIN, accessCode: 'synthetic-wrong-code' } }), 401, 'review_access_denied');
  }
  const otherWorker = createBillingWorker({ clock: () => NOW });
  const blocked = await otherWorker.fetch(new Request('https://billing.example/v1/review-access', {
    method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': IP }, body: JSON.stringify(LOGIN),
  }), s.env);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: { code: 'review_rate_limited' } });
  assert.deepEqual((await s.call({ ip: '203.0.113.20' })).body, SUCCESS);
  assert.equal(await s.db.prepare("SELECT count FROM rate_limits WHERE action='review_login' ORDER BY count DESC").first('count'), 10);
  assert.equal(await s.db.prepare("SELECT count FROM rate_limits WHERE user_id='alice' AND action='verify'").first('count'), 30);
  s.setNow(NOW + 60_000);
  assert.deepEqual((await s.call()).body, SUCCESS);
});

test('concurrent valid requests share the atomic10-attempt cap and IPv6 spellings share a bucket', async t => {
  const s = setup(t);
  const results = await Promise.all(Array.from({ length: 16 }, () => s.call()));
  assert.equal(results.filter(result => result.status === 200).length, 10);
  assert.equal(results.filter(result => result.status === 429).length, 6);
  for (let attempt = 0; attempt < 10; attempt++) {
    const ip = attempt % 2 ? '2001:0db8:0000:0000:0000:0000:0000:0001' : '2001:db8::1';
    assert.deepEqual((await s.call({ ip })).body, SUCCESS);
  }
  error(await s.call({ ip: '2001:db8::1' }), 429, 'review_rate_limited');
});

test('opportunistic and scheduled cleanup remove only expired review counters without review or Google configuration', async t => {
  const s = setup(t);
  const minute = Math.floor(NOW / 60_000);
  const insert = (id, action, age) => s.db.prepare('INSERT INTO rate_limits VALUES(?,?,?,1)').bind(id, action, minute - age).run();
  await insert('review:expired-opportunistic', 'review_login', 3);
  await insert('review:recent', 'review_login', 2);
  await insert('alice', 'verify', 3);
  await insert('review:other-action', 'verify', 3);
  await insert('alice', 'review_login', 3);
  assert.equal((await s.call()).status, 200);
  assert.equal(await s.db.prepare("SELECT user_id FROM rate_limits WHERE user_id='review:expired-opportunistic'").first(), null);
  await insert('review:expired-scheduled', 'review_login', 3);
  await assert.rejects(s.worker.scheduled({}, { DB: s.db }), error => error.code === 'configuration_required');
  assert.equal(await s.db.prepare("SELECT user_id FROM rate_limits WHERE user_id='review:expired-scheduled'").first(), null);
  const remaining = (await s.db.prepare('SELECT user_id,action FROM rate_limits').all()).results;
  for (const [id, action] of [['review:recent', 'review_login'], ['alice', 'verify'], ['review:other-action', 'verify'], ['alice', 'review_login']]) {
    assert.ok(remaining.some(row => row.user_id === id && row.action === action));
  }
  await cleanupReviewRateLimits({ DB: s.db }, NOW);
});

test('failed optional review cleanup leaves configured billing reconciliation running', async t => {
  const s = setup(t);
  let cleanupFailures = 0;
  let refundCalls = 0;
  const db = {
    prepare(sql) {
      if (sql.includes("action='review_login'")) { cleanupFailures++; throw new Error('synthetic-private-cleanup-failure'); }
      return s.db.prepare(sql);
    },
    batch: statements => s.db.batch(statements),
  };
  const env = { DB: db, ACCOUNT_HMAC_KEY: HMAC, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString('base64'),
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.iam.gserviceaccount.com', private_key: 'synthetic-injected-key' }) };
  const worker = createBillingWorker({ clock: () => NOW,
    publisherFactory: () => ({ async listVoidedPurchases() { refundCalls++; return { voidedPurchases: [], nextPageToken: null }; } }) });
  await worker.scheduled({}, env);
  assert.equal(cleanupFailures, 1);
  assert.equal(refundCalls, 1);
});

test('content-only success and review credentials cannot authenticate to any billing endpoint', async t => {
  const s = setup(t);
  assert.deepEqual((await s.call()).body, SUCCESS);
  const env = { ...s.env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString('base64'),
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'synthetic@example.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-unused-key\n-----END PRIVATE KEY-----' }) };
  const worker = createBillingWorker({ clock: () => NOW });
  for (const authorization of [undefined, `Bearer ${SECRET}`, 'Bearer review', `Bearer ${JSON.stringify(SUCCESS)}`, 'Bearer play-review']) {
    for (const [path, method] of [['/v1/billing/prepare', 'POST'], ['/v1/billing/verify', 'POST'],
      ['/v1/billing/entitlements', 'GET'], [`/v1/billing/entitlements/${'a'.repeat(43)}/topic`, 'POST']]) {
      const response = await worker.fetch(new Request(`https://billing.example${path}`, {
        method, headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(SUCCESS) } : {}),
      }), env);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: { code: authorization ? 'authentication_invalid' : 'authentication_required' } });
    }
  }
  assert.equal(await s.db.prepare('SELECT count(*) AS count FROM purchases').first('count'), 0);
  assert.equal(await s.db.prepare('SELECT count(*) AS count FROM purchase_intents').first('count'), 0);
});
