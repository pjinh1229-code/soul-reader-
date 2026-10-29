import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from 'jose';

const NOW = Date.UTC(2026, 9, 27, 20);
const PROJECT = 'soul-reader-a91f5';
const PACKAGE = 'com.soulreader.soul_reader';
const KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PURCHASE_URL = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/purchases/productsv2/tokens/synthetic-purchase`;

test('production Google clients fetch successfully in workerd and reject redirects without following them', async () => {
  // All keys and tokens are generated test fixtures. The outbound service below
  // handles every fetch, so this test cannot contact Google or another host.
  const keys = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const idToken = await new SignJWT({
    sub: 'fixture-user', iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    iat: NOW / 1000 - 5, exp: NOW / 1000 + 3595, auth_time: NOW / 1000 - 10,
    firebase: { sign_in_provider: 'google.com' },
  }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(keys.privateKey);
  const fixture = {
    now: NOW, projectId: PROJECT, packageName: PACKAGE, idToken,
    serviceAccount: {
      type: 'service_account', client_email: 'fixture@fixture.iam.gserviceaccount.com',
      private_key: await exportPKCS8(keys.privateKey),
    },
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'billing-workerd-google-'));
  let mf;
  try {
    const scriptPath = path.join(directory, 'worker.mjs');
    await build({
      stdin: {
        resolveDir: fileURLToPath(new URL('..', import.meta.url)),
        contents: `
          import { FirebaseTokenAuthenticator, GooglePlayPublisherClient, GoogleClientFailure } from './src/google_clients.mjs';
          export default { async fetch(request, env) {
            const fixture = env.FIXTURE;
            try {
              if (new URL(request.url).pathname === '/firebase') {
                const auth = new FirebaseTokenAuthenticator({ projectId: fixture.projectId, clock: () => fixture.now });
                const account = await auth.authenticate('Bearer ' + fixture.idToken);
                return Response.json({ authenticated: account.uid === 'fixture-user' && account.projectId === fixture.projectId });
              }
              const publisher = new GooglePlayPublisherClient({
                serviceAccount: fixture.serviceAccount, packageName: fixture.packageName, clock: () => fixture.now,
              });
              const purchase = await publisher.getPurchase('synthetic-purchase');
              return Response.json({ purchased: purchase.purchaseStateContext?.purchaseState === 'PURCHASED' });
            } catch (error) {
              return Response.json({ error: { code: error instanceof GoogleClientFailure ? error.code : 'unexpected_failure' } }, { status: 503 });
            }
          } };
        `,
      },
      outfile: scriptPath, bundle: true, format: 'esm', platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'], target: 'es2022', logLevel: 'silent',
    });
    const calls = [];
    const violations = [];
    let redirectUrl;
    mf = new Miniflare(convertV4MiniflareOptions({
      scriptPath, modules: true, modulesRoot: directory, rootPath: directory,
      compatibilityDate: '2026-10-27',
      cf: false, log: new Log(LogLevel.NONE), bindings: { FIXTURE: fixture },
      outboundService: async request => {
        calls.push(request.url);
        if (request.url === redirectUrl) {
          return new Response(null, { status: 302, headers: { location: 'https://must-never-follow.invalid/' } });
        }
        if (request.url === KEYS_URL) return Response.json({ keys: [publicJwk] });
        if (request.url === TOKEN_URL) {
          if (request.method !== 'POST') violations.push('oauth_method');
          const body = new URLSearchParams(await request.text());
          if (body.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !body.get('assertion')) {
            violations.push('oauth_body');
          }
          return Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3599 });
        }
        if (request.url === PURCHASE_URL) {
          if (request.headers.get('authorization') !== 'Bearer synthetic-access-token') violations.push('publisher_authorization');
          return Response.json({ purchaseStateContext: { purchaseState: 'PURCHASED' } });
        }
        violations.push('unexpected_outbound_destination');
        return new Response(null, { status: 502 });
      },
    }));

    const authenticated = await mf.dispatchFetch('https://fixture.invalid/firebase');
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { authenticated: true });
    assert.deepEqual(calls, [KEYS_URL]);

    const purchased = await mf.dispatchFetch('https://fixture.invalid/publisher');
    assert.equal(purchased.status, 200);
    assert.deepEqual(await purchased.json(), { purchased: true });
    assert.deepEqual(calls, [KEYS_URL, TOKEN_URL, PURCHASE_URL]);

    for (const [url, route, code, expectedCalls] of [
      [KEYS_URL, 'firebase', 'authentication_unavailable', [KEYS_URL]],
      [TOKEN_URL, 'publisher', 'play_unavailable', [TOKEN_URL]],
      [PURCHASE_URL, 'publisher', 'play_unavailable', [TOKEN_URL, PURCHASE_URL]],
    ]) {
      redirectUrl = url;
      const before = calls.length;
      const rejected = await mf.dispatchFetch(`https://fixture.invalid/${route}`);
      assert.equal(rejected.status, 503);
      assert.deepEqual(await rejected.json(), { error: { code } });
      assert.deepEqual(calls.slice(before), expectedCalls);
    }
    assert.deepEqual(violations, []);
  } finally {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
