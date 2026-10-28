import { setTimeout as delay } from 'node:timers/promises';

// Owner-supplied public origin. These checks send no credentials and do not
// create intents, purchases, or entitlements. Only fixed outcome codes are logged.
const ORIGIN = 'https://soul-reader-billing.jgw98541706.workers.dev';
const checks = [
  { path: '/health', status: 200, valid: body => body?.status === 'configured' },
  { path: '/v1/billing/entitlements', status: 401,
    valid: body => body?.error?.code === 'authentication_required' },
];

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

async function probe(check) {
  try {
    const response = await fetch(`${ORIGIN}${check.path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' },
    });
    const body = await readJson(response);
    const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '');
    const valid = response.status === check.status && check.valid(body) && noStore;
    const knownCode = ['configuration_required', 'authentication_required', 'internal_error']
      .includes(body?.error?.code) ? `; code=${body.error.code}` : '';
    return { valid, outcome: `${check.path} HTTP ${response.status}; expected body/cache: ${valid ? 'PASS' : 'FAIL'}${knownCode}` };
  } catch {
    return { valid: false, outcome: `${check.path} request unavailable` };
  }
}

let passed = false;
let finalResults = [];
for (let attempt = 1; attempt <= 4; attempt++) {
  const results = await Promise.all(checks.map(probe));
  finalResults = results;
  console.log(`Public Worker check ${attempt}: ${ORIGIN}`);
  for (const result of results) console.log(result.outcome);
  if (results.every(result => result.valid)) { passed = true; break; }
  if (attempt < 4) await delay(2000);
}
if (!passed) {
  for (const result of finalResults.filter(result => !result.valid)) {
    console.error(`::error title=Public Worker readiness::${result.outcome}`);
  }
  process.exitCode = 1;
}
