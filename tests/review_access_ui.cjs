const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const html = fs.readFileSync(path.resolve(__dirname, '../assets/web/index.html'), 'utf8');
const billing = fs.readFileSync(path.resolve(__dirname, '../assets/web/billing.js'), 'utf8');
const topics = ['love', 'chance', 'work', 'bond'];
const parts = ['eyes', 'brow', 'smile', 'aura', 'nose', 'jaw'];
const labels = {
  ko: ['검토용 접근', '검토용 접근 · 결제 없이 콘텐츠 확인'],
  en: ['Review access', 'Review access · View content without payment'],
  ja: ['審査用アクセス', '審査用アクセス · 決済なしでコンテンツを確認'],
};
const catalog = {type: 'state', epoch: 1, status: 'ready', configured: true, storeAvailable: true, busy: false,
  products: [{offerKey: 'single', price: '₩990'}, {offerKey: 'bundle', price: '₩1,990'}]};

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    async function open({native = true, lang = 'ko', loadModule = true, signedIn = false} = {}) {
      const page = await browser.newPage({viewport: {width: 360, height: 800}}), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/index.html') return route.fulfill({contentType: 'text/html', body: html});
        if (pathname === '/billing.js' && loadModule) return route.fulfill({contentType: 'application/javascript', body: billing});
        return route.abort();
      });
      await page.addInitScript(({native, signedIn, catalog}) => {
        window.reviewMessages = []; window.billingMessages = []; window.externalOpens = [];
        window.open = (...args) => { externalOpens.push(args); return null; };
        if (native) window.ReviewAccess = {postMessage(action) { reviewMessages.push(action); }};
        window.StoreBilling = {postMessage(raw) {
          const message = JSON.parse(raw); billingMessages.push(message);
          if (message.action === 'status') queueMicrotask(() => {
            soulBillingReceive?.({type: 'auth', epoch: 1, available: true, signedIn, label: signedIn ? 'Existing account' : '', busy: false});
            soulBillingReceive?.(catalog);
          });
        }};
      }, {native, signedIn, catalog});
      await page.goto('https://soul-reader.test/index.html');
      if (loadModule) await page.waitForFunction(() => !!window.SoulBilling);
      await page.evaluate(lang => { state.lang = lang; render(); }, lang);
      return {page, errors};
    }
    async function reading(page, id = 'review-photo-one', tier = 1) {
      await page.evaluate(({id, tier}) => {
        state.theme = 'love'; state.face = Object.fromEntries(['eyes', 'brow', 'smile', 'aura', 'nose', 'jaw'].map(key => [key, tier]));
        state.sr67 = {status: 'ready', source: 'mlkit', face: {...state.face}, metrics: {}};
        state.reading = buildReading(); state.reading.id = id;
        goto('premium');
      }, {id, tier});
    }
    async function activate(page, milliseconds = 3600000) {
      await page.evaluate(ms => soulReviewAccessReceive({active: true, expiresAt: Date.now() + ms}), milliseconds);
    }
    async function snapshot(page) {
      return page.evaluate(() => { const ctx = SoulBillingApp.context(); return {storage: {...localStorage}, entitlement: ctx.entitlement, ownedReadings: ctx.ownedReadings, billing: billingMessages.filter(m => m.action !== 'status')}; });
    }
    async function forgeClick(page, attribute, value = '') {
      await page.evaluate(({attribute, value}) => {
        const button = document.createElement('button'); button.setAttribute(attribute, value); document.body.append(button); button.click(); button.remove();
      }, {attribute, value});
    }
    for (const lang of Object.keys(labels)) {
      const {page, errors} = await open({lang});
      assert.equal(await page.locator('#legal-support [data-review-action="open"]').textContent(), labels[lang][0]);
      assert.deepEqual(await page.evaluate(() => reviewMessages), ['status'], 'Only the review status check runs at startup');
      await page.locator('#legal-support [data-review-action="open"]').evaluate(button => {
        button.dataset.url = 'javascript:alert(1)'; button.dataset.password = 'must-never-cross-the-bridge'; button.click();
      });
      assert.deepEqual(await page.evaluate(() => reviewMessages), ['status', 'open'], 'Public entry sends only the fixed action; native owns credential collection');
      assert.deepEqual(await page.evaluate(() => externalOpens), [], 'Review access never launches a JS-provided URL');
      assert.equal(await page.locator('input[type="password"]').count(), 0);
      await reading(page);
      const before = await snapshot(page);
      await activate(page);
      assert.equal(await page.locator('.review-access-banner strong').textContent(), labels[lang][1]);
      assert.equal(await page.locator('[data-billing-sign-in]').isDisabled(), true);
      assert.equal(await page.locator('[data-billing-restore]').isDisabled(), true);
      assert.equal(await page.locator('[data-pickpack]:disabled').count(), 2);
      assert.deepEqual(await page.locator('.pack-price').allTextContents(), ['₩990', '₩1,990'], 'Real catalog prices remain visible');
      assert.equal(await page.evaluate(() => SoulBillingApp.context().entitlement), null, 'Review access never impersonates a paid entitlement');
      await page.locator('.review-access-entry [data-route="chapters52"]').click();
      assert.equal(await page.locator('[data-ep]:enabled').count(), 4);
      assert.doesNotMatch(await page.locator('.page .eyebrow').textContent(), /구매 확인|Verified purchased|購入確認済み/);
      const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../scripts/${lang === 'ko' ? 'ryu_topics853' : 'ryu_' + lang + '854'}.json`), 'utf8'));
      for (const [column, topic] of topics.entries()) {
        await page.evaluate(() => goto('chapters52'));
        await page.locator(`[data-ep="${topic}"]`).click();
        assert.equal(await page.evaluate(() => state.screen), 'episode52');
        assert.equal(await page.locator('.sr853-report').getAttribute('data-topic853'), topic);
        assert.equal(await page.locator('.sr853-part').count(), 6, 'Uses the normal complete per-photo topic renderer');
        for (const part of parts) assert.equal(await page.locator(`.sr853-report [data-part853="${part}"] p`).textContent(), fixture.parts[part][1][column]);
        assert.equal(await page.locator('.sr853-overall p').count(), 1);
        assert.equal(await page.locator('.sr856-voice').getAttribute('data-voice856'), topic === 'love' ? 'love_59' : topic, 'Original topic audio path remains attached');
        const contextChoice = page.locator('[data-context76]').last();
        if (await contextChoice.count()) await contextChoice.click();
        assert.equal(await page.locator('.ref83-link,[data-route="theory83"]').count(), 0, 'Review keeps the existing retired library entry hidden');
        // The retained route must still apply the same access gates if invoked.
        await page.evaluate(() => goto('theory83'));
        assert.equal(await page.locator('.ref83-catalog').getAttribute('data-ref84-mode'), topic);
        assert.equal(await page.locator('[data-ref84-topic]:enabled').count(), 5);
        assert.equal(await page.locator('.ref84-topic-reading').count(), 12, 'Normal topic library is fully available');
      }
      assert.deepEqual(await snapshot(page), before, 'Review sessions never change the paid book, browser history, purchase ledger, or billing requests');
      await reading(page, 'review-photo-two', 2);
      await page.locator('.review-access-entry [data-route="chapters52"]').click();
      await page.locator('[data-ep="work"]').click();
      assert.equal(await page.locator('.sr853-report [data-part853="eyes"]').getAttribute('data-option853'), '2', 'A new photo uses its actual new scan');
      await page.evaluate(() => goto('checkout52'));
      assert.equal(await page.locator('[data-billing-buy]').isDisabled(), true);
      for (const attribute of ['data-billing-buy', 'data-billing-sign-in', 'data-billing-sign-out', 'data-billing-restore', 'data-demo-unlock']) await forgeClick(page, attribute, 'bundle');
      await page.evaluate(() => SoulBilling.selectTopic('love'));
      assert.deepEqual(await snapshot(page), before, 'Capture guards also reject forged and legacy purchase/login/restore actions');
      assert.equal(await page.evaluate(() => SoulBillingApp.persistPurchaseReading({requestId: 'not-a-purchase', offerKey: 'bundle'})), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.evaluate(() => goto('episode52'));
      await page.locator('.review-access-banner [data-review-action="exit"]').click();
      assert.equal(await page.evaluate(() => state.screen), 'premium');
      assert.equal(await page.locator('.review-access-banner').count(), 0);
      assert.deepEqual(await snapshot(page), before);
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]').count(), 0, 'Exit closes every review topic immediately');
      assert.deepEqual(await page.evaluate(() => reviewMessages), ['status', 'open', 'exit']);
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open({native: false}); await reading(page);
      assert.equal(await page.locator('#legal-support [data-review-action]').isDisabled(), true);
      assert.match(await page.locator('#legal-support').textContent(), /설치된 앱/);
      await activate(page); await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]').count(), 0, 'A browser callback cannot activate review access without the native channel');
      assert.deepEqual(await page.evaluate(() => [reviewMessages, externalOpens]), [[], []]);
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open(); await reading(page);
      for (const payload of [null, [], {}, {active: 'true', expiresAt: Date.now() + 10000}, {active: true}, {active: true, expiresAt: '9999999999999'}, {active: true, expiresAt: -1}]) {
        await page.evaluate(payload => soulReviewAccessReceive(payload), payload);
        assert.equal(await page.evaluate(() => SoulReviewAccess.isActive()), false);
      }
      await page.evaluate(() => soulReviewAccessReceive({active: true, expiresAt: Date.now() + 3606000}));
      assert.equal(await page.evaluate(() => SoulReviewAccess.isActive()), false, 'An excessive session lifetime fails closed');
      await activate(page, 250); await page.evaluate(() => goto('episode52'));
      await page.waitForFunction(() => !SoulReviewAccess.isActive() && state.screen === 'premium');
      assert.equal(await page.locator('.sr853-report').count(), 0, 'Timer expiration exits a currently displayed topic');
      await activate(page); await page.evaluate(() => { goto('episode52'); const actual = Date.now; Date.now = () => actual() + 3601000; render(); });
      assert.equal(await page.evaluate(() => state.screen), 'premium', 'Resume/render checks also enforce expiry after clock or app suspension');
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open(); await reading(page); await activate(page);
      await page.evaluate(() => { localStorage.setItem('review-access', JSON.stringify({active: true, expiresAt: Date.now() + 3600000})); goto('episode52'); });
      await page.reload(); await page.waitForFunction(() => !!window.SoulBilling); await reading(page);
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]').count(), 0, 'Reload discards all review access and ignores storage flags');
      await page.evaluate(() => { const r = state.reading; localStorage.setItem('sr75-stories', JSON.stringify({[r.id]: {id: r.id, unlocked: true, pack: 'bundle', reading: r, choices: {}, completed: []}})); });
      await page.reload(); await page.waitForFunction(() => !!window.SoulBilling); await reading(page);
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]').count(), 0, 'A locally unlocked legacy book cannot stand in for native review authentication');
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open({signedIn: true}); await reading(page, 'owned-photo');
      await page.evaluate(() => soulBillingReceive({type: 'entitlements', epoch: 1, entitlements: [{entitlementId: 'existing-server-pass', readingId: 'owned-photo', offerKey: 'single', topic: 'work'}]}));
      const before = await snapshot(page);
      await activate(page); await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]:enabled').count(), 4);
      await page.locator('[data-ep="love"]').click();
      const contextChoice = page.locator('[data-context76]').last();
      if (await contextChoice.count()) await contextChoice.click();
      await page.evaluate(() => SoulBillingApp.openTopic('work'));
      const reviewWork = await page.locator('.sr853-report').textContent();
      assert.deepEqual(await snapshot(page), before, 'Reviewing an owned photo never mutates its real paid pass or persisted metadata');
      await page.locator('.review-access-banner [data-review-action="exit"]').click();
      assert.deepEqual(await snapshot(page), before);
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep="work"]').isEnabled(), true);
      assert.equal(await page.locator('[data-ep]:disabled').count(), 3, 'A real verified single-topic pass remains intact after review exit');
      await page.locator('[data-ep="work"]').click();
      assert.equal(await page.locator('.sr853-report').textContent(), reviewWork, 'Review and real paid access render exactly the same per-photo content');
      assert.equal(await page.locator('.ref83-link,[data-route="theory83"]').count(), 0);
      await page.evaluate(() => goto('theory83'));
      assert.equal(await page.locator('.ref83-catalog').getAttribute('data-ref84-mode'), 'work');
      assert.equal(await page.locator('[data-ref84-topic]:enabled').count(), 2, 'Real paid users have the same actual library, scoped to their purchased topic');
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open(); await reading(page);
      await page.locator('[data-billing-sign-in]').click();
      await activate(page);
      assert.equal(await page.evaluate(() => SoulReviewAccess.isActive()), false, 'Review cannot race an existing Google login request');
      assert.equal(await page.evaluate(() => reviewMessages.at(-1)), 'exit');
      assert.equal(await page.evaluate(() => billingMessages.filter(m => m.action === 'signIn').length), 1);
      assert.deepEqual(errors, []); await page.close();
    }
    {
      const {page, errors} = await open({loadModule: false}); await reading(page); await activate(page);
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]:enabled').count(), 4, 'Authenticated review content does not depend on the optional billing UI asset');
      await forgeClick(page, 'data-demo-unlock', '1');
      assert.equal(await page.evaluate(() => localStorage.getItem('sr75-stories')), null);
      await page.locator('.review-access-banner [data-review-action="exit"]').click();
      await page.evaluate(() => goto('chapters52'));
      assert.equal(await page.locator('[data-ep]').count(), 0);
      assert.deepEqual(errors, []); await page.close();
    }
    assert.doesNotMatch(html + billing, /play-review|REVIEW_ACCESS_PASSWORD/, 'Web assets contain neither credentials nor server secret identifiers');
    console.log('PASS: localized native-only review entry/banner, actual four-topic photo content/audio and retained-route gates, no authentication/purchase or persistence, wrong payload/lifetime/browser/storage/reload rejection, expiry/exit, capture guards, request isolation, billing-asset independence, and preserved real paid rights');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
