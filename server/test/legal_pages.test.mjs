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

test('public developer website identifies the service without billing configuration', async () => {
  const worker = createBillingWorker();
  const response = await worker.fetch(new Request('https://billing.example/'), {});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /com\.soulreader\.soul_reader/);
  assert.match(html, /SOUL READER 운영자/);
  assert.ok(html.includes(SUPPORT_EMAIL));
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/delete-account"/);
  assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b|<img\b|<link\b/i);
  const head = await worker.fetch(new Request('https://billing.example/', { method: 'HEAD' }), {});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await worker.fetch(new Request('https://billing.example/', { method: 'POST' }), {});
  assert.equal(post.status, 405);
});

test('privacy describes ads conditionally and does not equate non-personalized or test ads with no processing', async () => {
  const worker = createBillingWorker();
  const response = await worker.fetch(new Request('https://billing.example/privacy'), {});
  const html = await response.text();
  assert.match(html, /광고 기능이 포함된 버전에서는/);
  assert.match(html, /광고 기능이 없는 기존 버전에는 광고 SDK가 없으며/);
  assert.match(html, /AdMob\(Google Mobile Ads SDK\)/);
  assert.match(html, /UMP/);
  assert.match(html, /IP 주소와 그로부터 추정한 대략적 위치/);
  assert.match(html, /비개인 맞춤 광고·테스트 광고/);
  assert.match(html, /풀이 내용·식별자/);
  assert.match(html, /광고 정보를 자동 삭제하지 않습니다/);
});

test('app-ads.txt is absent unless an owner publisher ID is explicitly configured', async () => {
  const worker = createBillingWorker();
  for (const publisher of [undefined, '', 'pub-3940256099942544', 'pub-0000000000000000',
    'ca-app-pub-1234567890123456~1234567890', 'pub-123456789012345',
    'pub-12345678901234567', 'pub-1234567890123456\ninjected.example', 1234567890123456]) {
    const env = publisher === undefined ? {} : { ADMOB_PUBLISHER_ID: publisher };
    const response = await worker.fetch(new Request('https://billing.example/app-ads.txt'), env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Not found\n');
    const head = await worker.fetch(new Request('https://billing.example/app-ads.txt', { method: 'HEAD' }), env);
    assert.equal(head.status, 404);
    assert.equal(await head.text(), '');
  }
});

test('app-ads.txt publishes only the public seller declaration and supports read methods', async () => {
  const worker = createBillingWorker();
  const env = { ADMOB_PUBLISHER_ID: 'pub-1234567890123456', GOOGLE_SERVICE_ACCOUNT_JSON: 'private-billing-secret' };
  const response = await worker.fetch(new Request('https://billing.example/app-ads.txt?token=private-query', {
    headers: { authorization: 'Bearer private-auth' },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  const head = await worker.fetch(new Request('https://billing.example/app-ads.txt', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const write = await worker.fetch(new Request('https://billing.example/app-ads.txt', { method }), env);
    assert.equal(write.status, 405);
    assert.equal(write.headers.get('allow'), 'GET, HEAD');
  }
});
