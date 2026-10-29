import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import {
  FirebaseTokenAuthenticator,
  GoogleClientFailure,
  GooglePlayPublisherClient,
} from '../src/google_clients.mjs';

const NOW = Date.UTC(2026, 9, 27, 20, 0);
const PROJECT = 'soul-reader-a91f5';
const PACKAGE = 'com.soulreader.soul_reader';
const KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const keys = await generateKeyPair('RS256', { extractable: true });
const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'firebase-key', alg: 'RS256', use: 'sig' };
const account = Object.freeze({
  type: 'service_account', client_email: 'billing@soul-reader-a91f5.iam.gserviceaccount.com',
  private_key: await exportPKCS8(keys.privateKey), private_key_id: 'server-key', token_uri: TOKEN_URL,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const checkError = (code, status, retryable) => (error) => {
  assert(error instanceof GoogleClientFailure);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  if (retryable !== undefined) assert.equal(error.retryable, retryable);
  assert.equal(error.message, 'Google service request failed.');
  return true;
};
async function idToken(overrides = {}, header = {}) {
  return new SignJWT({
    sub: 'firebase-user', iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    iat: NOW / 1000 - 5, exp: NOW / 1000 + 3595, auth_time: NOW / 1000 - 10,
    firebase: { sign_in_provider: 'google.com' }, ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'firebase-key', ...header }).sign(keys.privateKey);
}
const auth = (options = {}) => new FirebaseTokenAuthenticator({
  projectId: PROJECT, jwks: { keys: [publicJwk] }, clock: () => NOW, ...options,
});

test('Firebase accepts only verified same-project Google-provider Firebase ID tokens', async () => {
  const result = await auth().authenticate(`Bearer ${await idToken()}`);
  assert.deepEqual(result, { userId: `${PROJECT}:firebase-user`, uid: 'firebase-user', projectId: PROJECT });
  assert(Object.isFrozen(result));
});

test('Firebase rejects absent or malformed authorization without exposing supplied values', async () => {
  const verifier = auth();
  await assert.rejects(verifier.authenticate(), checkError('authentication_required', 401, false));
  for (const value of ['private-token', 'Bearer secret\r\nheader', 'Bearer a.b', 'Bearer  a.b.c', 'Basic a.b.c']) {
    await assert.rejects(verifier.authenticate(value), (error) => {
      checkError('authentication_invalid', 401, false)(error);
      assert(!JSON.stringify(error).includes(value));
      return true;
    });
  }
});

test('Firebase rejects Google OAuth IDs, other projects, anonymous and non-Google providers', async () => {
  for (const override of [
    { iss: 'https://accounts.google.com' },
    { aud: 'different-project' },
    { aud: [PROJECT, 'different-project'] },
    { firebase: { sign_in_provider: 'anonymous' } },
    { firebase: { sign_in_provider: 'password' } },
    { firebase: {} },
    { firebase: undefined },
  ]) {
    await assert.rejects(auth().authenticate(`Bearer ${await idToken(override)}`),
      checkError('authentication_invalid', 401));
  }
});

test('Firebase rejects invalid times, UID and signatures', async () => {
  for (const override of [
    { exp: NOW / 1000 }, { exp: NOW / 1000 - 1 }, { exp: 'tomorrow' },
    { iat: NOW / 1000 + 1 }, { iat: NOW / 1000 - 0.5 },
    { auth_time: NOW / 1000 + 1 }, { auth_time: NOW / 1000 - 4 },
    { auth_time: undefined }, { sub: '' }, { sub: 'x'.repeat(129) }, { sub: 'a\nb' },
  ]) {
    await assert.rejects(auth().authenticate(`Bearer ${await idToken(override)}`),
      checkError('authentication_invalid', 401));
  }
  const differentKeys = await generateKeyPair('RS256');
  const different = await new SignJWT({ sub: 'someone' }).setProtectedHeader({ alg: 'RS256', kid: 'firebase-key' })
    .sign(differentKeys.privateKey);
  await assert.rejects(auth().authenticate(`Bearer ${different}`), checkError('authentication_invalid', 401));
});

test('Firebase rejects algorithm confusion', async () => {
  const token = await new SignJWT({ sub: 'someone' }).setProtectedHeader({ alg: 'HS256', kid: 'firebase-key' })
    .sign(new TextEncoder().encode('a'.repeat(32)));
  await assert.rejects(auth().authenticate(`Bearer ${token}`), checkError('authentication_invalid', 401));
});

test('Firebase fetches only the fixed bounded Google JWKS endpoint and coalesces requests', async () => {
  let fetches = 0;
  const verifier = new FirebaseTokenAuthenticator({ projectId: PROJECT, clock: () => NOW,
    fetchImpl: async (url, init) => {
      fetches++;
      assert.equal(url, KEYS_URL);
      assert.equal(init.redirect, 'manual');
      assert(init.signal instanceof AbortSignal);
      await Promise.resolve();
      return json({ keys: [publicJwk] });
    },
  });
  const token = await idToken();
  await Promise.all(Array.from({ length: 4 }, () => verifier.authenticate(`Bearer ${token}`)));
  assert.equal(fetches, 1);
  assert.equal(JSON.stringify(verifier), '{}');
});

test('Firebase JWKS failure and oversize body fail safely as unavailable', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('secret network detail'); },
    async () => json({ error: 'secret detail' }, 403),
    async () => json({ keys: [], extra: 'x'.repeat(129 * 1024) }),
    async () => json({ keys: [] }),
    async () => new Response('not json'),
  ]) {
    const verifier = new FirebaseTokenAuthenticator({ projectId: PROJECT, clock: () => NOW, fetchImpl });
    await assert.rejects(verifier.authenticate(`Bearer ${await idToken()}`),
      checkError('authentication_unavailable', 503, true));
  }
});

test('Firebase refreshes rotated JWKS after cooldown while unknown keys cannot flood fetches', async () => {
  let now = NOW;
  let fetches = 0;
  const rotated = { ...publicJwk, kid: 'rotated-key' };
  const verifier = new FirebaseTokenAuthenticator({ projectId: PROJECT, clock: () => now,
    fetchImpl: async () => json({ keys: [++fetches > 1 ? rotated : publicJwk] }),
  });
  await verifier.authenticate(`Bearer ${await idToken()}`);
  const token = await idToken({}, { kid: 'rotated-key' });
  await assert.rejects(verifier.authenticate(`Bearer ${token}`), checkError('authentication_invalid', 401));
  assert.equal(fetches, 1);
  now += 30_001;
  assert.equal((await verifier.authenticate(`Bearer ${token}`)).uid, 'firebase-user');
  assert.equal(fetches, 2);
});

function publisher(fetchImpl, extra = {}) {
  return new GooglePlayPublisherClient({ serviceAccount: account, packageName: PACKAGE,
    clock: () => NOW, fetchImpl, ...extra });
}
const oauthResponse = () => json({ access_token: 'private-access-token', token_type: 'Bearer', expires_in: 3599 });

test('Publisher OAuth assertion is correctly signed, scoped and cached; purchase path is package-bound', async () => {
  const calls = [];
  const client = publisher(async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.redirect, 'manual');
    assert(init.signal instanceof AbortSignal);
    if (url === TOKEN_URL) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const { payload, protectedHeader } = await jwtVerify(body.get('assertion'), keys.publicKey,
        { issuer: account.client_email, audience: TOKEN_URL, currentDate: new Date(NOW), algorithms: ['RS256'] });
      assert.equal(payload.scope, 'https://www.googleapis.com/auth/androidpublisher');
      assert.equal(payload.exp - payload.iat, 3600);
      assert.equal(payload.sub, undefined);
      assert.equal(protectedHeader.kid, 'server-key');
      return oauthResponse();
    }
    assert.equal(init.headers.authorization, 'Bearer private-access-token');
    assert(url.startsWith(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/productsv2/tokens/`));
    return json({ purchaseStateContext: { purchaseState: 'PURCHASED' } });
  });
  const token = 'opaque/token?part=1';
  const response = await client.getPurchase(token);
  await client.getPurchase('second');
  assert.equal(response.purchaseStateContext.purchaseState, 'PURCHASED');
  assert.equal(calls.length, 3);
  assert(calls[1][0].endsWith(encodeURIComponent(token)));
  assert.equal(JSON.stringify(client), '{}');
  assert(!JSON.stringify(client).includes(account.private_key));
});

test('Publisher concurrent calls coalesce OAuth and renew expired tokens', async () => {
  let now = NOW;
  let tokenCalls = 0;
  const client = publisher(async (url) => {
    if (url === TOKEN_URL) { tokenCalls++; await Promise.resolve(); return oauthResponse(); }
    return json({ ok: true });
  }, { clock: () => now });
  await Promise.all([client.getPurchase('first'), client.getPurchase('second'), client.getPurchase('third')]);
  assert.equal(tokenCalls, 1);
  now += 3540_000;
  await client.getPurchase('last');
  assert.equal(tokenCalls, 2);
});

test('Publisher refreshes one rejected access token and never retries forever', async () => {
  let oauthCalls = 0;
  let playCalls = 0;
  const client = publisher(async (url) => {
    if (url === TOKEN_URL) { oauthCalls++; return oauthResponse(); }
    playCalls++;
    return json({ error: 'server-secret-response' }, 401);
  });
  await assert.rejects(client.getPurchase('private-purchase-token'), checkError('play_permission_denied', 503, false));
  assert.equal(oauthCalls, 2);
  assert.equal(playCalls, 2);
});

test('Publisher acknowledge calls only v1 acknowledge POST and never consumes', async () => {
  const calls = [];
  const client = publisher(async (url, init) => {
    if (url === TOKEN_URL) return oauthResponse();
    calls.push([url, init]);
    return new Response(null, { status: 204 });
  });
  await client.acknowledge('soul_reading_single', 'purchase/token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/products/soul_reading_single/tokens/purchase%2Ftoken:acknowledge`);
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].body, '{}');
  assert(!calls[0][0].includes(':consume'));
});

test('Publisher rejects invalid product/token/config before network', async () => {
  let calls = 0;
  const client = publisher(async () => { calls++; return oauthResponse(); });
  for (const token of ['', 'token\nsecret', 'x'.repeat(4097)]) {
    await assert.rejects(client.getPurchase(token), checkError('invalid_purchase_token', 400, false));
  }
  await assert.rejects(client.acknowledge('foreign-product', 'token'), checkError('invalid_product', 400, false));
  assert.equal(calls, 0);
  for (const altered of [
    { ...account, type: 'authorized_user' },
    { ...account, token_uri: 'https://attacker.example/token' },
    { ...account, client_email: 'normal@gmail.com' },
    { ...account, private_key: 'not a private key' },
  ]) assert.throws(() => publisher(async () => {}, { serviceAccount: altered }), checkError('google_configuration_required', 503));
  assert.throws(() => publisher(async () => {}, { packageName: '../foreign' }), checkError('google_configuration_required', 503));
});

test('Publisher maps 404/410 separately from refund evidence and hides all upstream error details', async () => {
  for (const [status, code, retryable] of [
    [404, 'play_purchase_not_found', false], [410, 'play_purchase_expired', false],
    [403, 'play_permission_denied', false], [429, 'play_rate_limited', true],
    [500, 'play_unavailable', true], [400, 'play_unavailable', false],
  ]) {
    const client = publisher(async (url) => url === TOKEN_URL ? oauthResponse() : json({ error: 'private-token owner-email' }, status));
    await assert.rejects(client.getPurchase('opaque-token'), (error) => {
      checkError(code, status === 404 || status === 410 ? status : 503, retryable)(error);
      assert(!JSON.stringify(error).includes('private-token'));
      assert(!error.stack.includes('owner-email'));
      return true;
    });
  }
});

test('Publisher never follows redirects and rejects invalid or oversized success bodies', async () => {
  for (const playResponse of [
    () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }),
    () => new Response('malformed'),
    () => json(['not', 'a', 'record']),
    () => json({ value: 'x'.repeat(1024 * 1024) }),
  ]) {
    const client = publisher(async (url) => url === TOKEN_URL ? oauthResponse() : playResponse());
    await assert.rejects(client.getPurchase('token'), checkError('play_unavailable', 503, true));
  }
});

test('Publisher rejects malformed OAuth response or credentials without exposing credentials', async () => {
  for (const response of [
    () => json({ access_token: 'secret', token_type: 'Bearer', expires_in: 0 }),
    () => json({ access_token: 'secret\nheader', token_type: 'Bearer', expires_in: 3600 }),
    () => json({ access_token: 'secret', token_type: 'invalid', expires_in: 3600 }),
    () => json({ error: account.private_key }, 400),
    () => { throw new Error(account.private_key); },
  ]) {
    const client = publisher(async () => response());
    await assert.rejects(client.getPurchase('token'), (error) => {
      assert(error instanceof GoogleClientFailure);
      assert(!JSON.stringify(error).includes('BEGIN PRIVATE KEY'));
      assert(!error.message.includes('secret'));
      return true;
    });
  }
});

test('Voided purchases use bounded IAP/system-seen query and retain older actual refund timestamps', async () => {
  const startTimeMs = NOW - 24 * 60 * 60_000;
  const oldRefundTime = String(NOW - 90 * 24 * 60 * 60_000);
  const client = publisher(async (url) => {
    if (url === TOKEN_URL) return oauthResponse();
    const target = new URL(url);
    assert(target.pathname.endsWith('/purchases/voidedpurchases'));
    assert.equal(target.searchParams.get('startTime'), String(startTimeMs));
    assert.equal(target.searchParams.get('endTime'), String(NOW));
    assert.equal(target.searchParams.get('type'), '0');
    assert.equal(target.searchParams.get('includeQuantityBasedPartialRefund'), 'true');
    assert.equal(target.searchParams.get('maxResults'), '100');
    assert.equal(target.searchParams.get('token'), 'page/token');
    return json({ voidedPurchases: [{ purchaseToken: 'refunded-token', voidedTimeMillis: oldRefundTime,
      voidedQuantity: 1, orderId: 'private-order-id', arbitrary: 'ignored' }],
    tokenPagination: { nextPageToken: 'next/token' } });
  });
  assert.deepEqual(await client.listVoidedPurchases({ startTimeMs, endTimeMs: NOW, pageToken: 'page/token' }), {
    voidedPurchases: [{ purchaseToken: 'refunded-token', voidedTimeMillis: oldRefundTime, voidedQuantity: 1 }],
    nextPageToken: 'next/token',
  });
});

test('Voided purchases empty page is complete, malformed pages fail rather than dropping refunds', async () => {
  const range = { startTimeMs: NOW - 60_000, endTimeMs: NOW };
  const empty = publisher(async (url) => url === TOKEN_URL ? oauthResponse() : json({}));
  assert.deepEqual(await empty.listVoidedPurchases(range), { voidedPurchases: [], nextPageToken: null });
  const emptyCursor = publisher(async (url) => url === TOKEN_URL ? oauthResponse() : json({ tokenPagination: { nextPageToken: '' } }));
  assert.deepEqual(await emptyCursor.listVoidedPurchases(range), { voidedPurchases: [], nextPageToken: null });
  for (const value of [
    { voidedPurchases: {} },
    { voidedPurchases: [{ purchaseToken: 'token', voidedTimeMillis: 'tomorrow' }] },
    { voidedPurchases: [{ purchaseToken: '', voidedTimeMillis: String(NOW) }] },
    { voidedPurchases: [{ purchaseToken: 'token', voidedTimeMillis: String(NOW + 300_001) }] },
    { tokenPagination: { nextPageToken: '\nprivate' } },
    { tokenPagination: [] },
  ]) {
    const client = publisher(async (url) => url === TOKEN_URL ? oauthResponse() : json(value));
    await assert.rejects(client.listVoidedPurchases(range), checkError('play_unavailable', 503, true));
  }
});

test('Voided query rejects invalid ranges without network', async () => {
  let calls = 0;
  const client = publisher(async () => { calls++; return oauthResponse(); });
  for (const range of [
    {}, { startTimeMs: NOW, endTimeMs: NOW },
    { startTimeMs: NOW - 1, endTimeMs: NOW + 1 },
    { startTimeMs: NOW - 1, endTimeMs: NOW + 300_001 },
    { startTimeMs: NOW - 31 * 24 * 60 * 60_000, endTimeMs: NOW - 30 * 24 * 60 * 60_000 },
    { startTimeMs: 1, endTimeMs: NOW },
    { startTimeMs: NOW - 1, endTimeMs: NOW, pageToken: 'bad\npage' },
  ]) await assert.rejects(client.listVoidedPurchases(range), checkError('google_configuration_required', 503, false));
  assert.equal(calls, 0);
});
