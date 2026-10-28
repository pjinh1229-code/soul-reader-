import { FirebaseTokenAuthenticator, GooglePlayPublisherClient, GoogleClientFailure } from './google_clients.mjs';
import { PLAY_PURCHASE_CATALOG, normalizePlayPurchaseV2, PlayPurchaseValidationError } from './play_purchase.mjs';
import { BillingLedger, BillingServerFailure, fail, publicGrant, secretKey, tokenHash } from './ledger.mjs';
import { SETUP_PAGE, SETUP_CSP } from './setup_page.mjs';

const PACKAGE = 'com.soulreader.soul_reader';
// Conservative free-Worker bound, including D1 operations and one OAuth refresh
// per upstream call. Clients may request up to20, but actual pages contain <=7.
const PAGE_LIMIT = 7;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const purchaseToken = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} });

// Public health diagnostics expose only fixed booleans. These constructors
// validate static configuration without importing a private key or fetching.
function configurationChecks(env) {
  const checks = { serviceAccount: false, accountHmacKey: false,
    tokenEncryptionKey: false, database: false, project: false };
  if (!record(env)) return checks;
  try {
    if (typeof env.GOOGLE_SERVICE_ACCOUNT_JSON === 'string') {
      const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
      new GooglePlayPublisherClient({ serviceAccount, packageName: PACKAGE });
      checks.serviceAccount = true;
    }
  } catch { /* Keep configuration contents and parser errors private. */ }
  try { secretKey(env.ACCOUNT_HMAC_KEY); checks.accountHmacKey = true; } catch { /* Boolean only. */ }
  try { secretKey(env.TOKEN_ENCRYPTION_KEY); checks.tokenEncryptionKey = true; } catch { /* Boolean only. */ }
  try { checks.database = typeof env.DB?.prepare === 'function' && typeof env.DB?.batch === 'function'; }
  catch { /* Boolean only. */ }
  try {
    const projectId = env.FIREBASE_PROJECT_ID ?? 'soul-reader-a91f5';
    if (/^[a-z][a-z0-9-]{4,62}$/.test(projectId) && (env.PLAY_PACKAGE_NAME ?? PACKAGE) === PACKAGE) {
      new FirebaseTokenAuthenticator({ projectId });
      checks.project = true;
    }
  } catch { /* Boolean only. */ }
  return checks;
}

async function body(request, allowed) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('invalid_request');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) fail('invalid_request', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_request');
  const bytes = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > 8192) { await reader.cancel(); fail('invalid_request', 413); }
      bytes.push(result.value);
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of bytes) { combined.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
    if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('invalid_request');
    return value;
  } catch (error) {
    if (error instanceof BillingServerFailure) throw error;
    return fail('invalid_request');
  } finally { reader.releaseLock(); }
}
function expected(intent, knownTransaction) {
  return { packageName: PACKAGE, productId: intent.product_id,
    purchaseOptionId: PLAY_PURCHASE_CATALOG[intent.product_id]?.purchaseOptionId,
    obfuscatedAccountId: intent.account_id, obfuscatedProfileId: intent.profile_id, knownTransaction };
}
function revoked(raw, productId) {
  return raw?.purchaseStateContext?.purchaseState === 'CANCELLED'
    || (raw?.productLineItem?.length === 1 && raw.productLineItem[0]?.productId === productId
      && raw.productLineItem[0]?.productOfferDetails?.refundableQuantity === 0);
}
function normalized(raw, intent, known, now) {
  try { return normalizePlayPurchaseV2(raw, expected(intent, known), { nowMs: now }); }
  catch (error) {
    if (!(error instanceof PlayPurchaseValidationError)) throw error;
    if (error.code === 'purchase_pending') fail('purchase_pending', 409);
    if (error.code === 'purchase_cancelled' || error.code === 'purchase_refunded') fail('purchase_revoked', 409);
    if (['purchase_context_mismatch', 'purchase_product_mismatch', 'purchase_option_mismatch'].includes(error.code)) {
      fail('purchase_context_mismatch', 409);
    }
    fail('invalid_receipt');
  }
}
function ensureContext(row, userId, request) {
  if (row.user_id !== userId) fail('purchase_context_mismatch', 403);
  if ((request.productId !== undefined && row.product_id !== request.productId)
    || (request.requestId !== undefined && row.request_id !== request.requestId)
    || (request.readingId !== undefined && row.reading_id !== request.readingId)) fail('purchase_context_mismatch', 409);
  if (row.status !== undefined && row.status !== 'active') fail('purchase_revoked', 409);
}

/** Dependencies are constructor injection for tests, never request/environment trust bypasses. */
export function createBillingWorker({ clock = Date.now, authenticateFactory, publisherFactory } = {}) {
  const runtimes = new WeakMap();
  function runtime(env) {
    if (!record(env)) fail('configuration_required', 503);
    if (runtimes.has(env)) return runtimes.get(env);
    const projectId = env.FIREBASE_PROJECT_ID ?? 'soul-reader-a91f5';
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || (env.PLAY_PACKAGE_NAME ?? PACKAGE) !== PACKAGE
      || typeof env.GOOGLE_SERVICE_ACCOUNT_JSON !== 'string') fail('configuration_required', 503);
    let serviceAccount;
    try { serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); }
    catch { fail('configuration_required', 503); }
    if (!record(serviceAccount) || serviceAccount.type !== 'service_account'
      || typeof serviceAccount.client_email !== 'string' || typeof serviceAccount.private_key !== 'string') fail('configuration_required', 503);
    const ledger = new BillingLedger(env.DB, { accountHmacKey: secretKey(env.ACCOUNT_HMAC_KEY),
      tokenEncryptionKey: secretKey(env.TOKEN_ENCRYPTION_KEY), clock });
    const auth = authenticateFactory ? authenticateFactory({ projectId }) : new FirebaseTokenAuthenticator({ projectId, clock });
    const publisher = publisherFactory ? publisherFactory({ serviceAccount, packageName: PACKAGE })
      : new GooglePlayPublisherClient({ serviceAccount, packageName: PACKAGE, clock });
    const value = { ledger, auth, publisher, projectId };
    runtimes.set(env, value);
    return value;
  }
  async function knownPurchase(rt, row, { reconcile = true, fallbackSnapshot } = {}) {
    const token = await rt.ledger.decryptToken(row);
    let raw;
    try { raw = await rt.publisher.getPurchase(token); }
    catch (error) {
      if (!(error instanceof GoogleClientFailure) || !['play_purchase_not_found', 'play_purchase_expired'].includes(error.code)) throw error;
      // Google retention errors are not proof of a refund. Preserve the paid ledger.
      // Only an already-finalized durable grant can fall back to refund-feed proof.
      if (row.ack_pending) fail('play_unavailable', 503);
      if (fallbackSnapshot) {
        if (!rt.ledger.refundsFreshIn(row, fallbackSnapshot.state) && !fallbackSnapshot.reconciled) {
          fallbackSnapshot.reconciled = true;
          await rt.ledger.syncRefunds(rt.publisher, 2);
          fallbackSnapshot.state = await rt.ledger.syncState();
        }
        if (!rt.ledger.refundsFreshIn(row, fallbackSnapshot.state)) fail('play_unavailable', 503);
        // The caller checks the user's revision after validating the entire page.
        // Every concurrent revoke changes that revision; no per-row database fetch is needed.
        return { row, verified: false, acknowledged: true };
      }
      if (!await rt.ledger.refundsFresh(row) && reconcile) await rt.ledger.syncRefunds(rt.publisher, 2);
      const current = await rt.ledger.purchase(row.token_hash);
      if (!current || current.status !== 'active' || await rt.ledger.tombstone(row.token_hash)) fail('purchase_revoked', 409);
      if (current.ack_pending || !await rt.ledger.refundsFresh(current)) fail('play_unavailable', 503);
      return { row: current, verified: false, acknowledged: true };
    }
    if (revoked(raw, row.product_id)) {
      await rt.ledger.revoke(row.token_hash);
      fail('purchase_revoked', 409);
    }
    const facts = normalized(raw, row, true, clock());
    return { row, verified: true, acknowledged: facts.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
  }
  async function acknowledge(rt, row) {
    try {
      await rt.publisher.acknowledge(row.product_id, await rt.ledger.decryptToken(row));
      await rt.ledger.acknowledged(row.token_hash);
    } catch {
      // The immutable grant and retry job are already durable. Never consume here.
    }
  }
  async function verify(rt, userId, request) {
    const hash = await tokenHash(request.purchaseToken);
    if (await rt.ledger.tombstone(hash)) fail('purchase_revoked', 409);
    let row = await rt.ledger.purchase(hash);
    let acknowledged;
    if (row) {
      ensureContext(row, userId, request);
      const checked = await knownPurchase(rt, row);
      row = checked.row;
      acknowledged = checked.acknowledged;
      if (checked.verified) await rt.ledger.verified(hash, acknowledged);
    } else {
      const raw = await rt.publisher.getPurchase(request.purchaseToken);
      if (revoked(raw, request.productId)) {
        await rt.ledger.revoke(hash);
        fail('purchase_revoked', 409);
      }
      const profile = raw?.obfuscatedExternalProfileId;
      if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(profile)) fail('purchase_context_mismatch', 409);
      const intent = await rt.ledger.intentByProfile(userId, profile);
      if (!intent) fail('purchase_context_mismatch', 403);
      ensureContext(intent, userId, request);
      const facts = normalized(raw, intent, false, clock());
      acknowledged = facts.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      row = await rt.ledger.storePurchase(userId, intent, request.purchaseToken, hash, acknowledged);
    }
    if (!acknowledged && row.ack_pending) await acknowledge(rt, row);
    row = await rt.ledger.purchase(hash);
    if (!row || row.status !== 'active' || await rt.ledger.tombstone(hash)) fail('purchase_revoked', 409);
    return { entitlement: publicGrant(row) };
  }
  async function entitlements(rt, userId, url) {
    if ([...url.searchParams.keys()].some(key => !['cursor', 'pageSize'].includes(key))
      || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('pageSize').length > 1) fail('invalid_request');
    const suppliedSize = url.searchParams.get('pageSize');
    if (suppliedSize !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(suppliedSize)) fail('invalid_request');
    let pageSize = suppliedSize === null ? PAGE_LIMIT : Math.min(PAGE_LIMIT, Number(suppliedSize));
    let after = '';
    const revision = await rt.ledger.revision(userId);
    const cursor = url.searchParams.get('cursor');
    if (cursor !== null) {
      const decoded = await rt.ledger.decodeCursor(cursor, userId);
      if (decoded.revision !== revision) fail('ledger_changed', 409);
      if (suppliedSize !== null && pageSize !== decoded.pageSize) fail('invalid_cursor');
      pageSize = decoded.pageSize;
      after = decoded.after;
    }
    const page = await rt.ledger.page(userId, after, pageSize);
    const selected = page.slice(0, pageSize);
    const verifiedHashes = [];
    const grants = [];
    const fallbackSnapshot = { state: await rt.ledger.syncState(), reconciled: false };
    for (const row of selected) {
      try {
        const checked = await knownPurchase(rt, row, { fallbackSnapshot });
        if (checked.verified) verifiedHashes.push(row.token_hash);
        grants.push(publicGrant(checked.row));
      } catch (error) {
        if (error instanceof BillingServerFailure && error.code === 'purchase_revoked') {
          fail('ledger_changed', 409);
        }
        throw error;
      }
    }
    await rt.ledger.verifiedRows(verifiedHashes);
    if (await rt.ledger.revision(userId) !== revision) fail('ledger_changed', 409);
    return { entitlements: grants, revision, nextCursor: page.length > pageSize
      ? await rt.ledger.encodeCursor(userId, revision, selected.at(-1).entitlement_id, pageSize) : null };
  }
  async function fetch(request, env) {
    let healthRuntimeFailed = false;
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:') fail('invalid_request');
      if (request.method === 'GET' && url.pathname === '/setup/service-account' && !url.search) {
        // This page only reads a user-selected file in that user's browser.
        // It submits no file content and works before runtime secrets are valid.
        return new Response(SETUP_PAGE, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': SETUP_CSP, 'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
          'Permissions-Policy': 'clipboard-write=(self)',
        } });
      }
      const health = request.method === 'GET' && url.pathname === '/health' && !url.search;
      healthRuntimeFailed = health;
      const rt = runtime(env);
      healthRuntimeFailed = false;
      if (health) return json({ status: 'configured' });
      const route = url.pathname;
      const topicMatch = /^\/v1\/billing\/entitlements\/([A-Za-z0-9_-]{43})\/topic$/.exec(route);
      if (!['/v1/billing/prepare', '/v1/billing/verify', '/v1/billing/entitlements'].includes(route) && !topicMatch) fail('not_found', 404);
      const account = await rt.auth.authenticate(request.headers.get('authorization'));
      if (!record(account) || typeof account.uid !== 'string' || !account.uid || account.uid.length > 128
        || account.projectId !== rt.projectId || account.userId !== `${rt.projectId}:${account.uid}`) fail('authentication_invalid', 401);
      const userId = account.userId;
      if (route === '/v1/billing/entitlements' && request.method === 'GET') {
        await rt.ledger.rateLimit(userId, 'list', 60);
        return json(await entitlements(rt, userId, url));
      }
      if (request.method !== 'POST' || url.search) fail('invalid_request');
      if (route === '/v1/billing/prepare') {
        await rt.ledger.rateLimit(userId, 'prepare', 30);
        const value = await body(request, ['requestId', 'readingId', 'offerKey', 'productId']);
        if (!identity(value.requestId) || !identity(value.readingId) || !Object.hasOwn(PLAY_PURCHASE_CATALOG, value.productId)
          || PLAY_PURCHASE_CATALOG[value.productId].offerKey !== value.offerKey) fail('invalid_purchase_context');
        const intent = await rt.ledger.prepare(userId, value);
        return json({ obfuscatedAccountId: intent.account_id, obfuscatedProfileId: intent.profile_id });
      }
      if (route === '/v1/billing/verify') {
        await rt.ledger.rateLimit(userId, 'verify', 30);
        const value = await body(request, ['platform', 'packageName', 'productId', 'purchaseToken', 'requestId', 'readingId']);
        if (value.platform !== 'android' || value.packageName !== PACKAGE || !Object.hasOwn(PLAY_PURCHASE_CATALOG, value.productId)
          || !purchaseToken(value.purchaseToken) || (value.requestId !== undefined && !identity(value.requestId))
          || (value.readingId !== undefined && !identity(value.readingId))) fail('invalid_receipt');
        return json(await verify(rt, userId, value));
      }
      if (topicMatch) {
        await rt.ledger.rateLimit(userId, 'topic', 60);
        const value = await body(request, ['topic']);
        if (!['love', 'chance', 'work', 'bond'].includes(value.topic)) fail('invalid_topic');
        const row = await rt.ledger.purchaseById(userId, topicMatch[1]);
        if (!row || row.status !== 'active') fail('invalid_entitlement', 404);
        if (row.offer_key !== 'single') fail('invalid_topic');
        const checked = await knownPurchase(rt, row);
        if (checked.verified) await rt.ledger.verified(row.token_hash, checked.acknowledged);
        return json({ entitlement: publicGrant(await rt.ledger.selectTopic(userId, row.entitlement_id, value.topic)) });
      }
      fail('invalid_request');
    } catch (error) {
      const diagnostic = healthRuntimeFailed ? { checks: configurationChecks(env) } : {};
      if (error instanceof BillingServerFailure || error instanceof GoogleClientFailure) {
        return json({ error: { code: error.code }, ...diagnostic }, error.status);
      }
      // No receipts, authorization headers, Google error bodies or SQL errors in logs/responses.
      return json({ error: { code: 'billing_storage_failed' }, ...diagnostic }, 503);
    }
  }
  async function scheduled(_event, env) {
    const rt = runtime(env);
    let refundFailed = false;
    try { await rt.ledger.syncRefunds(rt.publisher, 2); } catch { refundFailed = true; }
    for (const row of await rt.ledger.pendingAcknowledgements(3)) {
      await rt.ledger.markAcknowledgementAttempt(row.token_hash);
      try {
        const checked = await knownPurchase(rt, row, { reconcile: false });
        if (checked.verified) await rt.ledger.verified(row.token_hash, checked.acknowledged);
        if (!checked.acknowledged) await acknowledge(rt, row);
      } catch {
        // Keep retry jobs and known paid records intact on transient/unavailable upstreams.
      }
    }
    await rt.ledger.cleanRateLimits();
    if (refundFailed) fail('refund_sync_failed', 503);
  }
  return { fetch, scheduled };
}
export default createBillingWorker();
