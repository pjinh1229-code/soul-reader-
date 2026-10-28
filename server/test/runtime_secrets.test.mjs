import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  RuntimeSetupFailure,
  ensureRuntimeSecrets,
  inspectWranglerInvocation,
} from '../scripts/ensure-runtime-secrets.mjs';

const ACCOUNT = 'ee33db3044223ccec6ff9c0da863d2a5';
const DATABASE = 'e510df4a-00f3-4d29-b689-c08cdb422caf';
const WORKER = 'soul-reader-billing';
const BUILD_A = '11111111-1111-4111-8111-111111111111';
const BUILD_B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'unit-test-api-token-not-a-credential';
const OWNER_FIXTURE = 'unit-test-owner-json-not-a-credential';
const RESPONSE_FIXTURE = 'unit-test-response-must-not-reach-errors';
const KEYS = ['ACCOUNT_HMAC_KEY', 'TOKEN_ENCRYPTION_KEY'];
const WRANGLER = '/project/node_modules/wrangler/bin/wrangler.js';
const LIVE = [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc']];
const NOW = 1_800_000_000_000;

function production(overrides = {}) {
  return {
    WORKERS_CI: '1',
    WORKERS_CI_BRANCH: 'main',
    WORKERS_CI_BUILD_UUID: BUILD_A,
    WRANGLER_COMMAND: 'deploy',
    WRANGLER_CI_OVERRIDE_NAME: WORKER,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: TOKEN,
    ...overrides,
  };
}

function response(result, status = 200) {
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function success(result) {
  return response({ success: true, result, errors: [], messages: [] });
}

function gate() {
  let enter;
  let release;
  return {
    entered: new Promise((resolve) => { enter = resolve; }),
    released: new Promise((resolve) => { release = resolve; }),
    enter: () => enter(),
    release: () => release(),
  };
}

class CloudflareFixture {
  constructor(t, initial = ['GOOGLE_SERVICE_ACCOUNT_JSON']) {
    this.database = new DatabaseSync(':memory:');
    t.after(() => this.database.close());
    this.secrets = new Map(initial.map((name) => [name, {
      name,
      type: 'secret_text',
      text: name === 'GOOGLE_SERVICE_ACCOUNT_JSON' ? OWNER_FIXTURE : `unit-test-existing-${name}`,
    }]));
    this.calls = [];
    this.bulkBodies = [];
    this.metadataCalls = 0;
    this.entropyCalls = [];
    this.generated = [];
    this.metadataOverride = null;
    this.queryOverride = null;
    this.bulkMode = 'success';
    this.bulkGate = null;
    this.fetch = this.fetch.bind(this);
    this.entropy = this.entropy.bind(this);
  }

  entropy(size) {
    this.entropyCalls.push(size);
    const bytes = Buffer.alloc(size, this.entropyCalls.length === 1 ? 0x31 : 0x72);
    this.generated.push(bytes.toString('base64'));
    return bytes;
  }

  options(overrides = {}) {
    return {
      env: production(),
      fetchImpl: this.fetch,
      ancestors: () => LIVE,
      entropy: this.entropy,
      now: () => NOW,
      ...overrides,
    };
  }

  row() {
    return this.database.prepare(
      'SELECT worker_name, owner_build, state, created_at_ms FROM runtime_secret_initialization WHERE worker_name = ?',
    ).get(WORKER);
  }

  mutationCalls() {
    return this.calls.filter(({ method }) => method !== 'GET');
  }

  async fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, pathname: url.pathname, body });
    assert.equal(url.origin, 'https://api.cloudflare.com', 'requests stay on the fixed Cloudflare API origin');
    const headers = new Headers(init.headers);
    assert.ok(headers.get('authorization') === `Bearer ${TOKEN}`, 'requests use the injected fixture token');
    const workerBase = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
    if (url.pathname === `${workerBase}/secrets`) {
      assert.equal(method, 'GET');
      this.metadataCalls += 1;
      if (this.metadataOverride) {
        const replacement = await this.metadataOverride(this.metadataCalls);
        if (replacement !== undefined) return replacement;
      }
      return success([...this.secrets.values()].map(({ name, type }) => ({ name, type })));
    }
    if (url.pathname === `/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`) {
      assert.equal(method, 'POST');
      assert.equal(typeof body?.sql, 'string');
      assert.ok(Array.isArray(body.params), 'SQL uses explicit parameter arrays');
      const queryText = JSON.stringify(body);
      for (const value of [TOKEN, OWNER_FIXTURE, ...this.generated]) {
        assert.ok(!queryText.includes(value), 'D1 stores ownership metadata without credentials or key values');
      }
      if (this.queryOverride) {
        const replacement = await this.queryOverride(body);
        if (replacement !== undefined) return replacement;
      }
      const statement = this.database.prepare(body.sql);
      let results = [];
      let changes = 0;
      if (statement.columns().length) {
        results = statement.all(...body.params).map((row) => ({ ...row }));
      } else {
        changes = Number(statement.run(...body.params).changes);
      }
      return success([{ success: true, results, meta: { changes } }]);
    }
    if (url.pathname === `${workerBase}/secrets-bulk`) {
      assert.equal(method, 'PATCH', 'secret initialization is one merge patch');
      assert.equal(headers.get('content-type'), 'application/merge-patch+json');
      assert.ok(body && typeof body.secrets === 'object' && !Array.isArray(body.secrets));
      this.bulkBodies.push(body);
      if (this.bulkGate) {
        this.bulkGate.enter();
        await this.bulkGate.released;
      }
      if (this.bulkMode === 'http-failure') {
        return response({ success: false, errors: [{ message: RESPONSE_FIXTURE }] }, 500);
      }
      if (this.bulkMode === 'ambiguous-unapplied') throw new Error(RESPONSE_FIXTURE);
      for (const [name, entry] of Object.entries(body.secrets)) {
        assert.ok(KEYS.includes(name), 'bulk patch contains only the two owned runtime keys');
        assert.ok(entry && entry.name === name && entry.type === 'secret_text', 'bulk bindings are secret text');
        assert.equal(typeof entry.text, 'string');
        this.secrets.set(name, { ...entry });
      }
      if (this.bulkMode === 'ambiguous-applied') throw new Error(RESPONSE_FIXTURE);
      if (this.bulkMode === 'omit-one-after-success') this.secrets.delete(KEYS[1]);
      return success({});
    }
    assert.fail('unexpected API endpoint');
  }
}

async function failure(run, fixture, forbidden = []) {
  let caught;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof RuntimeSetupFailure, 'unsafe state returns a controlled runtime setup failure');
  assert.equal(typeof caught.code, 'string');
  const printable = `${caught.name}\n${caught.message}\n${caught.stack ?? ''}`;
  for (const value of [TOKEN, OWNER_FIXTURE, RESPONSE_FIXTURE, ...fixture.generated, ...forbidden]) {
    assert.ok(!printable.includes(value), 'failure text excludes credentials, keys, and upstream payloads');
  }
  return caught;
}

test('recognizes pinned Wrangler deploy invocations and detects dry-run anywhere in its flags', () => {
  assert.equal(inspectWranglerInvocation(LIVE), 'live');
  assert.equal(inspectWranglerInvocation([
    ['node', '/project/scripts/ensure-runtime-secrets.mjs'],
    ['node', '/project/node_modules/wrangler/wrangler-dist/cli.js', 'deploy', '--config=wrangler.jsonc'],
  ]), 'live');
  assert.equal(inspectWranglerInvocation([
    ['node', WRANGLER, 'deploy', '-c', 'wrangler.jsonc', '--name', WORKER],
  ]), 'live');
  for (const flag of ['--dry-run', '--dry-run=true']) {
    assert.equal(inspectWranglerInvocation([
      ['node', WRANGLER, 'deploy', '--outdir', '/tmp/unit-test-output', flag, '--config', 'wrangler.jsonc'],
    ]), 'dry-run');
  }
});

test('rejects unrecognized or redirected deployment invocations', () => {
  const cases = [
    [],
    [['npm', 'exec', 'wrangler', 'deploy', '--config', 'wrangler.jsonc']],
    [['node', WRANGLER, 'deploy']],
    [['node', WRANGLER, 'deploy', '--config', 'other.jsonc']],
    [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc', '--name', 'different-worker']],
    [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc', '--env', 'preview']],
    [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc', '-e', 'preview']],
    [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc', '--dry-run=false']],
    [['node', '/project/not-wrangler.js', 'deploy', '--config', 'wrangler.jsonc']],
  ];
  for (const ancestors of cases) assert.equal(inspectWranglerInvocation(ancestors), 'unknown');
});

test('outside production every skip precedes network, ancestry lookup, clock, and entropy', async (t) => {
  const fixture = new CloudflareFixture(t);
  const cases = [
    {},
    production({ WORKERS_CI: undefined }),
    production({ WORKERS_CI_BRANCH: 'feature/test' }),
    production({ WRANGLER_COMMAND: 'dev' }),
    production({ WRANGLER_COMMAND: 'versions upload' }),
  ];
  for (const env of cases) {
    const result = await ensureRuntimeSecrets(fixture.options({
      env,
      ancestors: () => { assert.fail('skipped environments do not inspect processes'); },
      now: () => { assert.fail('skipped environments do not read the clock'); },
    }));
    assert.equal(result.status, 'skipped');
    assert.equal(typeof result.reason, 'string');
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.entropyCalls.length, 0);
});

test('a dry run with complete production markers never networks or generates keys', async (t) => {
  const fixture = new CloudflareFixture(t);
  const result = await ensureRuntimeSecrets(fixture.options({
    ancestors: () => [['node', WRANGLER, 'deploy', '--config', 'wrangler.jsonc', '--dry-run']],
    now: () => { assert.fail('dry runs do not read the clock'); },
  }));
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'dry_run');
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.entropyCalls.length, 0);
});

test('unknown deploy ancestry fails before network or entropy', async (t) => {
  const fixture = new CloudflareFixture(t);
  await failure(() => ensureRuntimeSecrets(fixture.options({ ancestors: () => [] })), fixture);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.entropyCalls.length, 0);
});

test('wrong worker, wrong account, invalid build ID, and absent token fail before networking', async (t) => {
  for (const overrides of [
    { WRANGLER_CI_OVERRIDE_NAME: 'different-worker' },
    { CLOUDFLARE_ACCOUNT_ID: 'different-account' },
    { CF_ACCOUNT_ID: 'different-account' },
    { WORKERS_CI_BUILD_UUID: 'not-a-build-uuid' },
    { CLOUDFLARE_API_TOKEN: undefined },
  ]) {
    const fixture = new CloudflareFixture(t);
    await failure(() => ensureRuntimeSecrets(fixture.options({ env: production(overrides) })), fixture);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.entropyCalls.length, 0);
  }
});

test('creates only missing keys with independent 32-byte standard-base64 values and completes its lock', async (t) => {
  const fixture = new CloudflareFixture(t);
  const result = await ensureRuntimeSecrets(fixture.options());
  assert.equal(result.status, 'ready');
  assert.deepEqual([...result.created].sort(), [...KEYS].sort());
  assert.deepEqual(fixture.entropyCalls, [32, 32]);
  assert.equal(fixture.bulkBodies.length, 1);
  assert.deepEqual(Object.keys(fixture.bulkBodies[0].secrets).sort(), [...KEYS].sort());
  for (const name of KEYS) {
    const value = fixture.secrets.get(name).text;
    assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(value), 'generated key is standard base64 for 32 bytes');
    assert.equal(Buffer.from(value, 'base64').length, 32);
  }
  assert.ok(fixture.secrets.get(KEYS[0]).text !== fixture.secrets.get(KEYS[1]).text, 'the two entropy calls yield independent fixture keys');
  assert.ok(fixture.secrets.get('GOOGLE_SERVICE_ACCOUNT_JSON').text === OWNER_FIXTURE, 'owner-provided Google secret is preserved');
  const row = fixture.row();
  assert.equal(row.worker_name, WORKER);
  assert.equal(row.owner_build, BUILD_A);
  assert.equal(row.state, 'complete');
  assert.equal(row.created_at_ms, NOW);
});

test('preserves an existing runtime key and sends only the missing key in the merge patch', async (t) => {
  const fixture = new CloudflareFixture(t, ['GOOGLE_SERVICE_ACCOUNT_JSON', KEYS[0], 'UNRELATED_SECRET']);
  const existing = fixture.secrets.get(KEYS[0]).text;
  const unrelated = fixture.secrets.get('UNRELATED_SECRET').text;
  const result = await ensureRuntimeSecrets(fixture.options());
  assert.deepEqual(result.created, [KEYS[1]]);
  assert.deepEqual(fixture.entropyCalls, [32]);
  assert.deepEqual(Object.keys(fixture.bulkBodies[0].secrets), [KEYS[1]]);
  assert.ok(fixture.secrets.get(KEYS[0]).text === existing, 'existing runtime key was not overwritten');
  assert.ok(fixture.secrets.get('UNRELATED_SECRET').text === unrelated, 'unrelated secret was not changed');
});

test('existing keys establish a complete marker without generating or writing secrets', async (t) => {
  const fixture = new CloudflareFixture(t, ['GOOGLE_SERVICE_ACCOUNT_JSON', ...KEYS]);
  const result = await ensureRuntimeSecrets(fixture.options());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.created, []);
  assert.equal(fixture.entropyCalls.length, 0);
  assert.equal(fixture.bulkBodies.length, 0);
  assert.equal(fixture.row().state, 'complete');
});

test('a completed retry from a later build cannot overwrite any runtime key', async (t) => {
  const fixture = new CloudflareFixture(t);
  await ensureRuntimeSecrets(fixture.options());
  const original = KEYS.map((name) => fixture.secrets.get(name).text);
  const result = await ensureRuntimeSecrets(fixture.options({ env: production({ WORKERS_CI_BUILD_UUID: BUILD_B }) }));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.created, []);
  assert.equal(fixture.bulkBodies.length, 1);
  assert.deepEqual(fixture.entropyCalls, [32, 32]);
  for (let i = 0; i < KEYS.length; i += 1) assert.ok(fixture.secrets.get(KEYS[i]).text === original[i], 'completed retry preserves each key');
  assert.equal(fixture.row().owner_build, BUILD_A, 'completed lock owner is not taken over');
});

test('overlapping production builds allow only one build to generate and write keys', { timeout: 5000 }, async (t) => {
  const fixture = new CloudflareFixture(t);
  fixture.bulkGate = gate();
  const first = ensureRuntimeSecrets(fixture.options());
  await Promise.race([
    fixture.bulkGate.entered,
    first.then(() => { assert.fail('first build must reach the held merge patch'); }),
  ]);
  try {
    await failure(() => ensureRuntimeSecrets(fixture.options({
      env: production({ WORKERS_CI_BUILD_UUID: BUILD_B }),
      entropy: () => { assert.fail('competing build must not generate any keys'); },
    })), fixture);
    assert.equal(fixture.bulkBodies.length, 1);
    assert.equal(fixture.row().owner_build, BUILD_A);
    assert.equal(fixture.row().state, 'initializing');
  } finally {
    fixture.bulkGate.release();
  }
  assert.equal((await first).status, 'ready');
  assert.equal(fixture.row().state, 'complete');
  assert.deepEqual(fixture.entropyCalls, [32, 32]);
});

test('missing Google secret, malformed metadata, duplicate names, or wrong binding types never mutate', async (t) => {
  const cases = [
    success(null),
    success({ message: RESPONSE_FIXTURE }),
    success([]),
    success([{ name: 'GOOGLE_SERVICE_ACCOUNT_JSON', type: 'plain_text' }]),
    success([
      { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', type: 'secret_text' },
      { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', type: 'secret_text' },
    ]),
    success([
      { name: 'GOOGLE_SERVICE_ACCOUNT_JSON', type: 'secret_text' },
      { name: KEYS[0], type: 'plain_text' },
    ]),
    response({ success: false, errors: [{ message: RESPONSE_FIXTURE }] }, 403),
  ];
  for (const metadata of cases) {
    const fixture = new CloudflareFixture(t);
    fixture.metadataOverride = () => metadata;
    await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
    assert.equal(fixture.mutationCalls().length, 0);
    assert.equal(fixture.entropyCalls.length, 0);
    assert.equal(fixture.bulkBodies.length, 0);
  }
});

test('unexpected metadata fetch errors are redacted and cannot trigger a secret write', async (t) => {
  const fixture = new CloudflareFixture(t);
  fixture.metadataOverride = () => { throw new Error(`${TOKEN} ${RESPONSE_FIXTURE}`); };
  await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
  assert.equal(fixture.mutationCalls().length, 0);
  assert.equal(fixture.entropyCalls.length, 0);
});

test('failed or malformed D1 responses stop before entropy and secret writes', async (t) => {
  for (const d1Response of [
    response({ success: false, errors: [{ message: RESPONSE_FIXTURE }] }, 500),
    response({ success: true, result: [{ success: false, error: RESPONSE_FIXTURE }] }),
    response({ success: true, result: null }),
  ]) {
    const fixture = new CloudflareFixture(t);
    fixture.queryOverride = () => d1Response;
    await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
    assert.equal(fixture.entropyCalls.length, 0);
    assert.equal(fixture.bulkBodies.length, 0);
  }
});

test('ambiguous lock acquisition metadata cannot authorize key generation', async (t) => {
  for (const meta of [undefined, {}, { changes: 2 }, { changes: '1' }]) {
    const fixture = new CloudflareFixture(t);
    fixture.queryOverride = ({ sql }) => {
      if (/^INSERT\s+OR\s+IGNORE/i.test(sql)) {
        return success([{ success: true, results: [], ...(meta === undefined ? {} : { meta }) }]);
      }
    };
    await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
    assert.equal(fixture.entropyCalls.length, 0);
    assert.equal(fixture.bulkBodies.length, 0);
  }
});

for (const mode of ['http-failure', 'ambiguous-unapplied', 'ambiguous-applied']) {
  test(`${mode} bulk outcome retains initialization ownership and blocks generation by a later build`, async (t) => {
    const fixture = new CloudflareFixture(t);
    fixture.bulkMode = mode;
    await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
    assert.equal(fixture.bulkBodies.length, 1, 'uncertain writes are never automatically retried');
    assert.deepEqual(fixture.entropyCalls, [32, 32]);
    assert.equal(fixture.row().state, 'initializing');
    assert.equal(fixture.row().owner_build, BUILD_A);
    fixture.bulkMode = 'success';
    await failure(() => ensureRuntimeSecrets(fixture.options({
      entropy: () => { assert.fail('same-build retry cannot resume an uncertain initialization'); },
    })), fixture);
    assert.equal(fixture.bulkBodies.length, 1);
    await failure(() => ensureRuntimeSecrets(fixture.options({
      env: production({ WORKERS_CI_BUILD_UUID: BUILD_B }),
      entropy: () => { assert.fail('retry must retain the lock without generating replacement keys'); },
    })), fixture);
    assert.equal(fixture.bulkBodies.length, 1);
    assert.equal(fixture.row().state, 'initializing');
    assert.equal(fixture.row().owner_build, BUILD_A);
  });
}

test('a nominally successful bulk response with missing metadata cannot complete initialization', async (t) => {
  const fixture = new CloudflareFixture(t);
  fixture.bulkMode = 'omit-one-after-success';
  await failure(() => ensureRuntimeSecrets(fixture.options()), fixture);
  assert.equal(fixture.bulkBodies.length, 1);
  assert.equal(fixture.row().state, 'initializing');
  assert.equal(fixture.row().owner_build, BUILD_A);
});

test('a missing key after completed initialization fails instead of regenerating it', async (t) => {
  const fixture = new CloudflareFixture(t, ['GOOGLE_SERVICE_ACCOUNT_JSON', ...KEYS]);
  await ensureRuntimeSecrets(fixture.options());
  fixture.secrets.delete(KEYS[1]);
  await failure(() => ensureRuntimeSecrets(fixture.options({
    env: production({ WORKERS_CI_BUILD_UUID: BUILD_B }),
    entropy: () => { assert.fail('completed initialization never rotates a missing key'); },
  })), fixture);
  assert.equal(fixture.bulkBodies.length, 0);
  assert.equal(fixture.entropyCalls.length, 0);
  assert.equal(fixture.row().state, 'complete');
  assert.equal(fixture.row().owner_build, BUILD_A);
});
