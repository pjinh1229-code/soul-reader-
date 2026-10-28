import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Public deployment identifiers only. Secret values stay in process memory and
// are sent directly to Cloudflare's secret API; they never enter D1 or files.
const ACCOUNT = 'ee33db3044223ccec6ff9c0da863d2a5';
const WORKER = 'soul-reader-billing';
const DATABASE = 'e510df4a-00f3-4d29-b689-c08cdb422caf';
const RUNTIME_KEYS = ['ACCOUNT_HMAC_KEY', 'TOKEN_ENCRYPTION_KEY'];
const GOOGLE_KEY = 'GOOGLE_SERVICE_ACCOUNT_JSON';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURE_CODES = new Set([
  'runtime_setup_failed', 'invocation_unverified', 'deployment_target_mismatch',
  'build_identity_required', 'managed_auth_required', 'api_request_failed',
  'secret_metadata_invalid', 'google_secret_required', 'database_request_failed',
  'initialization_in_progress', 'initialization_state_invalid',
  'completed_initialization_missing_secret', 'entropy_failed',
  'secret_verification_failed', 'clock_invalid',
]);

export class RuntimeSetupFailure extends Error {
  constructor(code) {
    const safeCode = FAILURE_CODES.has(code) ? code : 'runtime_setup_failed';
    super(`Runtime secret initialization failed: ${safeCode}.`);
    this.name = 'RuntimeSetupFailure';
    this.code = safeCode;
  }
}

const fail = code => { throw new RuntimeSetupFailure(code); };

/** Read only this process's own parent chain, never unrelated processes. */
export function readOwnWranglerAncestors() {
  const ancestors = [];
  const seen = new Set();
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && Number.isSafeInteger(pid) && pid > 0; depth++) {
    if (seen.has(pid)) break;
    seen.add(pid);
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      ancestors.push(cmdline.split('\0').filter(Boolean));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The process name is parenthesized and may itself contain parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const parent = Number(fields[1]);
      if (!Number.isSafeInteger(parent) || parent === pid) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return ancestors;
}

/** Verify the actual Wrangler parent invocation; its build env omits dry-run. */
export function inspectWranglerInvocation(ancestors) {
  if (!Array.isArray(ancestors)) return 'unknown';
  let found = false;
  let dryRun = false;
  for (const argv of ancestors) {
    if (!Array.isArray(argv) || !argv.every(value => typeof value === 'string')) continue;
    const executable = argv.findIndex(value =>
      /(?:^|\/)wrangler\/(?:bin\/wrangler\.js|wrangler-dist\/cli\.js)$/.test(value));
    if (executable < 0) continue;
    const args = argv.slice(executable + 1);
    if (args[0] !== 'deploy') return 'unknown';
    let config = false;
    let invocationDryRun = false;
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--dry-run' || arg === '--dry-run=true') {
        invocationDryRun = true;
      } else if (arg === '--config' || arg === '-c') {
        if (config || args[++index] !== 'wrangler.jsonc') return 'unknown';
        config = true;
      } else if (arg.startsWith('--config=')) {
        if (config || arg !== '--config=wrangler.jsonc') return 'unknown';
        config = true;
      } else if (arg === '--name') {
        if (args[++index] !== WORKER) return 'unknown';
      } else if (arg.startsWith('--name=')) {
        if (arg !== `--name=${WORKER}`) return 'unknown';
      } else if (arg === '--outdir') {
        if (!args[++index] || args[index].startsWith('-')) return 'unknown';
      } else if (arg.startsWith('--outdir=')) {
        if (arg === '--outdir=') return 'unknown';
      } else {
        // Includes --env/-e, other configs, script overrides and unknown flags.
        return 'unknown';
      }
    }
    if (!config) return 'unknown';
    found = true;
    dryRun ||= invocationDryRun;
  }
  return !found ? 'unknown' : dryRun ? 'dry-run' : 'live';
}

const CREATE_LOCK_TABLE = `CREATE TABLE IF NOT EXISTS runtime_secret_initialization (
  worker_name TEXT PRIMARY KEY,
  owner_build TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('initializing', 'complete')),
  created_at_ms INTEGER NOT NULL
)`;

export async function ensureRuntimeSecrets({
  env = process.env,
  fetchImpl = fetch,
  ancestors = readOwnWranglerAncestors,
  entropy = n => randomBytes(n),
  now = Date.now,
} = {}) {
  try {
    if (env.WORKERS_CI !== '1') return { status: 'skipped', reason: 'outside_workers_build' };
    if (env.WORKERS_CI_BRANCH !== 'main') return { status: 'skipped', reason: 'non_production_branch' };
    if (env.WRANGLER_COMMAND !== 'deploy') return { status: 'skipped', reason: 'not_deploy' };
    const invocation = inspectWranglerInvocation(
      typeof ancestors === 'function' ? await ancestors() : ancestors);
    if (invocation === 'dry-run') return { status: 'skipped', reason: 'dry_run' };
    if (invocation !== 'live') fail('invocation_unverified');
    if (env.WRANGLER_CI_OVERRIDE_NAME !== undefined && env.WRANGLER_CI_OVERRIDE_NAME !== WORKER) {
      fail('deployment_target_mismatch');
    }
    for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID']) {
      if (env[name] !== undefined && env[name] !== ACCOUNT) fail('deployment_target_mismatch');
    }
    const owner = env.WORKERS_CI_BUILD_UUID;
    if (typeof owner !== 'string' || !UUID.test(owner)) fail('build_identity_required');
    const token = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
    if (typeof token !== 'string' || !token) fail('managed_auth_required');
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('clock_invalid');

    async function request(route, { method = 'GET', body, contentType } = {}) {
      try {
        const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/${route}`, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'Content-Type': contentType ?? 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) fail('api_request_failed');
        const payload = await response.json();
        if (!payload || payload.success !== true) fail('api_request_failed');
        return payload.result;
      } catch {
        // API response bodies and thrown fetch errors can contain request data.
        fail('api_request_failed');
      }
    }

    async function metadata() {
      const result = await request(`workers/scripts/${WORKER}/secrets`);
      if (!Array.isArray(result)) fail('secret_metadata_invalid');
      const names = new Map();
      for (const entry of result) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.type !== 'string'
          || names.has(entry.name)) fail('secret_metadata_invalid');
        names.set(entry.name, entry.type);
      }
      if (names.get(GOOGLE_KEY) !== 'secret_text') fail('google_secret_required');
      for (const name of RUNTIME_KEYS) {
        if (names.has(name) && names.get(name) !== 'secret_text') fail('secret_metadata_invalid');
      }
      return names;
    }

    async function query(sql, params = []) {
      const result = await request(`d1/database/${DATABASE}/query`, {
        method: 'POST', body: { sql, params },
      });
      if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true
        || !Array.isArray(result[0].results)) fail('database_request_failed');
      return result[0];
    }

    async function lockState() {
      const { results: rows } = await query(
        'SELECT owner_build, state FROM runtime_secret_initialization WHERE worker_name = ?', [WORKER]);
      if (rows.length !== 1 || typeof rows[0].owner_build !== 'string'
        || !['initializing', 'complete'].includes(rows[0].state)) fail('initialization_state_invalid');
      return rows[0];
    }

    let names = await metadata();
    const initialMissing = RUNTIME_KEYS.filter(name => !names.has(name));
    await query(CREATE_LOCK_TABLE);
    const acquisition = await query(
      'INSERT OR IGNORE INTO runtime_secret_initialization (worker_name, owner_build, state, created_at_ms) VALUES (?, ?, ?, ?)',
      [WORKER, owner, initialMissing.length ? 'initializing' : 'complete', createdAt]);
    if (![0, 1].includes(acquisition.meta?.changes)) fail('database_request_failed');
    let lock = await lockState();
    if (lock.state === 'complete') {
      if (initialMissing.length) fail('completed_initialization_missing_secret');
      return { status: 'ready', created: [] };
    }
    if (acquisition.meta.changes !== 1 || lock.owner_build !== owner) fail('initialization_in_progress');

    // Only this invocation's freshly inserted lock permits generation. Any
    // abandoned lock blocks even the same build ID after an ambiguous write.
    names = await metadata();
    const missing = RUNTIME_KEYS.filter(name => !names.has(name));
    if (missing.length) {
      const secrets = {};
      for (const name of missing) {
        let bytes;
        try { bytes = entropy(32); } catch { fail('entropy_failed'); }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) fail('entropy_failed');
        secrets[name] = { name, text: Buffer.from(bytes).toString('base64'), type: 'secret_text' };
      }
      // One request creates the missing pair together. Neither a failed nor an
      // ambiguous write is retried; the D1 lock remains for manual inspection.
      await request(`workers/scripts/${WORKER}/secrets-bulk`, {
        method: 'PATCH', contentType: 'application/merge-patch+json', body: { secrets },
      });
    }
    names = await metadata();
    if (RUNTIME_KEYS.some(name => !names.has(name))) fail('secret_verification_failed');
    await query(
      "UPDATE runtime_secret_initialization SET state = 'complete' WHERE worker_name = ? AND owner_build = ? AND state = 'initializing'",
      [WORKER, owner]);
    lock = await lockState();
    if (lock.owner_build !== owner || lock.state !== 'complete') fail('initialization_state_invalid');
    return { status: 'ready', created: missing };
  } catch (error) {
    if (error instanceof RuntimeSetupFailure) throw error;
    throw new RuntimeSetupFailure('runtime_setup_failed');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await ensureRuntimeSecrets();
    console.log(result.status === 'skipped'
      ? `Runtime secret setup skipped: ${result.reason}.`
      : result.created.length
        ? `Runtime secrets initialized: ${result.created.join(', ')}.`
        : 'Runtime secrets are already configured.');
  } catch (error) {
    const code = error instanceof RuntimeSetupFailure ? error.code : 'runtime_setup_failed';
    console.error(`Runtime secret setup stopped: ${code}.`);
    process.exitCode = 1;
  }
}
