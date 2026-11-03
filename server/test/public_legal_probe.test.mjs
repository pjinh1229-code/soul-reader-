import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkPublicLegal, ADMOB_SELLER_LINE } from '../scripts/check-public-legal.mjs';
import { legalPageResponse } from '../src/legal_pages.mjs';

const publisher = 'pub-1953724823797056';
const publicResponse = url => legalPageResponse(new Request(url), { ADMOB_PUBLISHER_ID: publisher });

test('production public probe checks the developer website, ads privacy and exact owner seller without authentication', async () => {
  const paths = [];
  const messages = [];
  await checkPublicLegal({
    fetchImpl: async (url, options) => {
      paths.push(new URL(url).pathname);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers, undefined);
      return publicResponse(url);
    },
    report: message => messages.push(message),
  });
  assert.deepEqual(paths, ['/', '/privacy', '/delete-account', '/app-ads.txt']);
  assert.equal(messages.length, 4);
  assert.equal(ADMOB_SELLER_LINE, `google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n`);
  // This reads public deployment variables only, never runtime secret bindings.
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"ADMOB_PUBLISHER_ID":\s*"pub-1953724823797056"/);
});

test('production public probe rejects missing or different publishers and extra seller rows', async () => {
  for (const [status, body] of [[404, 'Not found\n'], [200, ADMOB_SELLER_LINE.replace(publisher, 'pub-3940256099942544')],
    [200, `${ADMOB_SELLER_LINE}unexpected.example, 123, DIRECT\n`]]) {
    await assert.rejects(checkPublicLegal({
      fetchImpl: async url => new URL(url).pathname === '/app-ads.txt'
        ? new Response(body, { status, headers: { 'Content-Type': 'text/plain' } }) : publicResponse(url),
      report: () => {},
    }), /public_admob_seller_invalid/);
  }
});

test('production public probe rejects a stale privacy page without the conditional advertising disclosure', async () => {
  await assert.rejects(checkPublicLegal({
    fetchImpl: async url => {
      const response = publicResponse(url);
      if (new URL(url).pathname !== '/privacy') return response;
      return new Response((await response.text()).replaceAll('광고 기능이 포함된 버전에서는', ''), {
        headers: response.headers,
      });
    },
    report: () => {},
  }), /public_ads_privacy_invalid/);
});
