import assert from 'node:assert/strict';
import test from 'node:test';
import { createBillingWorker } from '../src/worker.mjs';
import { SUPPORT_EMAIL } from '../src/legal_pages.mjs';

test('public privacy and deletion pages work without billing credentials or authentication', async () => {
  const worker = createBillingWorker();
  for (const path of ['/privacy', '/delete-account']) {
    const response = await worker.fetch(new Request(`https://billing.example${path}`), {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
    const html = await response.text();
    assert.match(html, /com\.soulreader\.soul_reader/);
    assert.ok(html.includes(SUPPORT_EMAIL));
    assert.match(html, /운영자가/);
    assert.match(html, /단방향 해시/);
    assert.match(html, /서비스 운영 기간/);
    assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b|<img\b|<link\b/i);
  }
});

test('public support pages never echo queries or credentials and accept only reads', async () => {
  const worker = createBillingWorker();
  for (const path of ['/privacy', '/delete-account']) {
    const plain = await worker.fetch(new Request(`https://billing.example${path}`), {});
    const tainted = await worker.fetch(new Request(`https://billing.example${path}?email=private-user@example.com&token=private-secret`, {
      headers: { authorization: 'Bearer private-auth' },
    }), {});
    assert.equal(await tainted.text(), await plain.text());
    const head = await worker.fetch(new Request(`https://billing.example${path}`, { method: 'HEAD' }), {});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await worker.fetch(new Request(`https://billing.example${path}`, { method: 'POST', body: 'private-body' }), {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  }
});
