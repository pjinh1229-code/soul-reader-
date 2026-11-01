import { base64url, secretKey } from './ledger.mjs';

const encoder = new TextEncoder();
const BODY_LIMIT = 1024;
const SESSION_SECONDS = 3600;
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers },
});

class ReviewFailure extends Error {
  constructor(code, status) { super('Review access failed.'); this.code = code; this.status = status; }
}
const deny = (code, status) => { throw new ReviewFailure(code, status); };

function reviewSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    deny('review_configuration_required', 503);
  }
  const decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
  if (decoded.length !== 32 || base64url(decoded) !== value) deny('review_configuration_required', 503);
  return value;
}

function sourceIp(request) {
  const value = request.headers.get('CF-Connecting-IP');
  if (typeof value !== 'string' || value.length > 45) deny('invalid_request', 400);
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)
    && value.split('.').every(part => Number(part) <= 255)) return value;
  // URL's IPv6 parser validates and canonicalizes compressed/expanded forms.
  // CF supplies this header; never use forwarded headers or a shared fallback.
  if (value.includes(':') && /^[A-Fa-f0-9:.]+$/.test(value)) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { /* Fixed failure below. */ }
  }
  return deny('invalid_request', 400);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    deny('invalid_request', 400);
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) deny('invalid_request', 400);
  const reader = request.body?.getReader();
  if (!reader) deny('invalid_request', 400);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        deny('invalid_request', 400);
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'username') || !Object.hasOwn(value, 'accessCode')
      || typeof value.username !== 'string' || typeof value.accessCode !== 'string') deny('invalid_request', 400);
    return value;
  } catch (error) {
    if (error instanceof ReviewFailure) throw error;
    return deny('invalid_request', 400);
  } finally { reader.releaseLock(); }
}

async function equalSecret(supplied, expected) {
  // Web Crypto is available in workerd. Both digests have a fixed length and
  // every byte participates in the comparison, without an early exit.
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** No review secret or Google runtime is needed to remove expired counters. */
export async function cleanupReviewRateLimits(env, now = Date.now()) {
  if (typeof env?.DB?.prepare !== 'function') throw new Error('Review storage unavailable.');
  const result = await env.DB.prepare("DELETE FROM rate_limits WHERE action='review_login' AND user_id LIKE 'review:%' AND minute<?")
    .bind(Math.floor(now / 60_000) - 2).run();
  if (result?.success === false) throw new Error('Review storage unavailable.');
}

/** Public content-only gate: never creates an account, token, purchase or grant. */
export async function reviewAccessResponse(request, env, now = Date.now()) {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') deny('invalid_request', 400);
    if (request.method !== 'POST') return response({ error: { code: 'invalid_request' } }, 405, { Allow: 'POST' });
    if (url.href.includes('?')) deny('invalid_request', 400);
    const secret = reviewSecret(env?.PLAY_REVIEW_ACCESS_CODE);
    const hmacBytes = secretKey(env?.ACCOUNT_HMAC_KEY);
    if (typeof env?.DB?.prepare !== 'function' || typeof env.DB.batch !== 'function') {
      deny('review_configuration_required', 503);
    }
    const ip = sourceIp(request);
    const key = await crypto.subtle.importKey('raw', hmacBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const userId = 'review:' + base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`review-ip\0${ip}`))));
    await cleanupReviewRateLimits(env, now);
    const result = await env.DB.prepare(`INSERT INTO rate_limits(user_id,action,minute,count) VALUES(?,'review_login',?,1)
      ON CONFLICT(user_id,action,minute) DO UPDATE SET count=count+1 WHERE count<10`)
      .bind(userId, Math.floor(now / 60_000)).run();
    if (result?.success === false || ![0, 1].includes(result?.meta?.changes)) deny('review_configuration_required', 503);
    if (result.meta.changes !== 1) deny('review_rate_limited', 429);
    const value = await readBody(request);
    const validCode = await equalSecret(value.accessCode, secret);
    if (value.username !== 'play-review' || !validCode) deny('review_access_denied', 401);
    return response({ access: 'review', sessionDurationSeconds: SESSION_SECONDS });
  } catch (error) {
    if (error instanceof ReviewFailure) return response({ error: { code: error.code } }, error.status);
    // Deliberately discard parser, crypto, environment and database details.
    return response({ error: { code: 'review_configuration_required' } }, 503);
  }
}
