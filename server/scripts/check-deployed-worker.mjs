import { setTimeout as delay } from 'node:timers/promises';
import { isOperationalFailure } from '../src/operational_diagnostics.mjs';

// Owner-supplied public origin. These checks send no credentials and do not
// create intents, purchases, or entitlements. Only fixed outcome codes are logged.
const ORIGIN = 'https://soul-reader-billing.jgw98541706.workers.dev';
const setupOnly = process.argv.includes('--setup-only');
const checks = setupOnly ? [
  { path: '/setup/service-account', format: 'html', status: 200,
    valid: text => typeof text === 'string' && text.includes('id="json-file"') && text.includes('id="copy-value"') },
  { path: '/setup/upload-key', format: 'html', status: 200,
    valid: text => typeof text === 'string' && text.includes('id="backup-file"') && text.includes('id="copy-backup"') },
] : [
  { path: '/health', status: 200, valid: body => body?.status === 'configured'
    && body?.operational?.databaseSchema === true },
  { path: '/v1/billing/entitlements', status: 401,
    valid: body => body?.error?.code === 'authentication_required' },
];

async function readText(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16_384) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return null; }
}

async function probe(check) {
  try {
    const response = await fetch(`${ORIGIN}${check.path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Accept: 'application/json' },
    });
    const text = await readText(response);
    let body = text;
    if (check.format !== 'html') {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '');
    const protectedPage = check.format !== 'html' ||
      (/connect-src 'none'/.test(response.headers.get('content-security-policy') ?? '') &&
       /form-action 'none'/.test(response.headers.get('content-security-policy') ?? '') &&
       response.headers.get('x-frame-options') === 'DENY');
    const valid = response.status === check.status && check.valid(body) && noStore && protectedPage;
    const knownCode = ['configuration_required', 'google_configuration_required', 'billing_storage_failed',
      'authentication_required', 'internal_error']
      .includes(body?.error?.code) ? `; code=${body.error.code}` : '';
    const diagnosticNames = ['serviceAccount', 'accountHmacKey', 'tokenEncryptionKey', 'database', 'project'];
    const diagnostics = !valid && diagnosticNames.every(name => typeof body?.checks?.[name] === 'boolean')
      ? `; checks: ${diagnosticNames.map(name => `${name}=${body.checks[name]}`).join(', ')}` : '';
    const operational = check.path === '/health' && typeof body?.operational?.databaseSchema === 'boolean'
      ? body.operational : null;
    const notices = operational ? [`databaseSchema=${operational.databaseSchema}`] : [];
    if (operational && Array.isArray(operational.lastFailures)) {
      for (const failure of operational.lastFailures.filter(isOperationalFailure).slice(0, 4)) {
        notices.push(`route=${failure.route}; stage=${failure.stage}; status=${failure.status}; code=${failure.code}`);
      }
    }
    return { valid, notices, outcome: `${check.path} HTTP ${response.status}; expected body/cache: ${valid ? 'PASS' : 'FAIL'}${knownCode}${diagnostics}` };
  } catch {
    return { valid: false, outcome: `${check.path} request unavailable` };
  }
}

let passed = false;
let finalResults = [];
const attempts = setupOnly ? 16 : 12;
for (let attempt = 1; attempt <= attempts; attempt++) {
  const results = await Promise.all(checks.map(probe));
  finalResults = results;
  console.log(`Public Worker check ${attempt}: ${ORIGIN}`);
  for (const result of results) console.log(result.outcome);
  if (results.every(result => result.valid)) { passed = true; break; }
  if (attempt < attempts) await delay(5000);
}
for (const result of finalResults) {
  for (const notice of result.notices ?? []) console.log(`::notice title=Billing operational diagnosis::${notice}`);
}
if (!passed) {
  for (const result of finalResults.filter(result => !result.valid)) {
    console.error(`::error title=Public Worker readiness::${result.outcome}`);
  }
  process.exitCode = 1;
}
