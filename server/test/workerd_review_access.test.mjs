import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

test('actual review worker authenticates offline in workerd with only review secrets and the existing D1 rate-limit table', async () => {
  // Public deterministic fixtures. No production keys, Google configuration,
  // purchase tables, or external services participate in this regression.
  const accessCode = Buffer.alloc(32, 43).toString('base64url');
  const accountHmacKey = Buffer.alloc(32, 47).toString('base64');
  const directory = await mkdtemp(path.join(tmpdir(), 'billing-workerd-review-'));
  let mf;
  try {
    const scriptPath = path.join(directory, 'worker.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))],
      outfile: scriptPath, bundle: true, format: 'esm', platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'], target: 'es2022', logLevel: 'silent',
    });
    const outbound = [];
    const options = {
      scriptPath, modules: true, modulesRoot: directory, rootPath: directory,
      compatibilityDate: '2026-10-27', cf: false, log: new Log(LogLevel.NONE),
      bindings: { PLAY_REVIEW_ACCESS_CODE: accessCode, ACCOUNT_HMAC_KEY: accountHmacKey },
      d1Databases: ['DB'],
      outboundService: async request => {
        outbound.push(request.url);
        return new Response(null, { status: 502 });
      },
    };
    mf = new Miniflare(convertV4MiniflareOptions(options));
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('../migrations/0001_billing.sql', import.meta.url), 'utf8');
    const schema = migration.match(/CREATE TABLE rate_limits\s*\([\s\S]*?\);/)?.[0];
    assert.ok(schema, 'uses the existing migration rate-limit schema');
    await db.prepare(schema).run();
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const before = (await tables()).results;
    assert.ok(before.some(row => row.name === 'rate_limits'));
    for (const name of ['purchase_intents', 'purchases', 'user_revisions', 'refund_tombstones', 'refund_sync']) {
      assert.equal(before.some(row => row.name === name), false);
    }

    const helper = await mf.dispatchFetch('https://fixture.invalid/setup/review-access');
    assert.equal(helper.status, 200);
    assert.equal(helper.headers.get('cache-control'), 'no-store');
    assert.ok((await helper.text()).includes('PLAY_REVIEW_ACCESS_CODE'));

    const login = value => mf.dispatchFetch('https://fixture.invalid/v1/review-access', {
      method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' },
      body: JSON.stringify({ username: 'play-review', accessCode: value }),
    });
    const authenticated = await login(accessCode);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { access: 'review', sessionDurationSeconds: 3600 });
    assert.equal(authenticated.headers.get('cache-control'), 'no-store');
    assert.equal(authenticated.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(authenticated.headers.get('access-control-allow-origin'), null);
    assert.equal(authenticated.headers.get('set-cookie'), null);

    const denied = await login('synthetic-wrong-review-code');
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: { code: 'review_access_denied' } });
    let limited = false;
    // The production worker uses its real clock. Allow a fixed-minute boundary
    // to pass during this test while still requiring the durable cap to be10.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await login(accessCode);
      if (result.status === 429) {
        assert.deepEqual(await result.json(), { error: { code: 'review_rate_limited' } });
        limited = true;
        break;
      }
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { access: 'review', sessionDurationSeconds: 3600 });
    }
    assert.equal(limited, true);
    const counters = (await db.prepare('SELECT * FROM rate_limits').all()).results;
    assert.ok(counters.length >= 1 && counters.length <= 2);
    for (const counter of counters) {
      assert.match(counter.user_id, /^review:[A-Za-z0-9_-]{43}$/);
      assert.equal(counter.action, 'review_login');
      assert.ok(counter.count <= 10);
    }
    assert.ok(counters.some(counter => counter.count === 10));
    assert.deepEqual((await tables()).results, before, 'login creates no account or billing tables');
    assert.equal(JSON.stringify(counters).includes('203.0.113.77'), false);
    assert.equal(JSON.stringify(counters).includes(accessCode), false);

    await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ACCOUNT_HMAC_KEY: accountHmacKey } }));
    const unconfigured = await login(accessCode);
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { error: { code: 'review_configuration_required' } });
    assert.deepEqual(outbound, [], 'the review route never contacts Google or any external host');
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
