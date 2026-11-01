import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBillingWorker } from '../src/worker.mjs';
import { REVIEW_SETUP_PAGE, REVIEW_SETUP_CSP } from '../src/review_setup_page.mjs';

test('owner review helper has exact pinned scripts/styles and no outside resource or storage channel', () => {
  const scripts = [...REVIEW_SETUP_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const styles = [...REVIEW_SETUP_PAGE.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  assert.equal(styles.length, 1);
  for (const value of [...scripts, ...styles]) {
    assert.ok(REVIEW_SETUP_CSP.includes(`'sha256-${createHash('sha256').update(value).digest('base64')}'`));
  }
  assert.match(REVIEW_SETUP_CSP, /connect-src 'self'/);
  assert.match(REVIEW_SETUP_CSP, /form-action 'none'/);
  assert.doesNotMatch(REVIEW_SETUP_PAGE, /<form\b|<iframe\b|<img\b|<script\s+src|localStorage|sessionStorage|indexedDB|console\./i);
  assert.match(REVIEW_SETUP_PAGE, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(REVIEW_SETUP_PAGE, /type="password"/);
  assert.match(REVIEW_SETUP_PAGE, /PLAY_REVIEW_ACCESS_CODE/);
});

test('owner review helper is public before runtime and never reflects inputs', async () => {
  const worker = createBillingWorker();
  const response = await worker.fetch(new Request('https://billing.example/setup/review-access'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), REVIEW_SETUP_PAGE);
  assert.equal(response.headers.get('content-security-policy'), REVIEW_SETUP_CSP);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('permissions-policy'), 'clipboard-write=(self)');
  const tainted = await worker.fetch(new Request('https://billing.example/setup/review-access?code=PRIVATE_VALUE'), {});
  assert.notEqual(tainted.status, 200);
  assert.doesNotMatch(await tainted.text(), /PRIVATE_VALUE/);
});
