const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const html = fs.readFileSync(path.resolve(__dirname, '../assets/web/index.html'), 'utf8');
const billing = fs.readFileSync(path.resolve(__dirname, '../assets/web/billing.js'), 'utf8');
const labels = {
  ko: ['개인정보처리방침', '계정 및 데이터 삭제 요청'],
  en: ['Privacy policy', 'Request account and data deletion'],
  ja: ['プライバシーポリシー', 'アカウントとデータの削除をリクエスト'],
};
const urls = {
  privacy: 'https://soul-reader-billing.jgw98541706.workers.dev/privacy',
  deleteAccount: 'https://soul-reader-billing.jgw98541706.workers.dev/delete-account',
};

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    async function open(native) {
      const page = await browser.newPage({viewport: {width: 360, height: 800}});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/index.html') return route.fulfill({contentType: 'text/html', body: html});
        if (pathname === '/billing.js') return route.fulfill({contentType: 'application/javascript', body: billing});
        return route.abort();
      });
      await page.addInitScript(native => {
        window.legalMessages = [];
        window.externalOpens = [];
        window.billingMessages = [];
        window.open = (...args) => { externalOpens.push(args); return null; };
        if (native) window.LegalSupport = {postMessage(action) { legalMessages.push(action); }};
        window.StoreBilling = {postMessage(raw) {
          const message = JSON.parse(raw);
          billingMessages.push(message);
          if (message.action === 'status') queueMicrotask(() => {
            window.soulBillingReceive?.({type: 'auth', epoch: 1, available: true, signedIn: true, label: 'private-account-label', busy: false});
            window.soulBillingReceive?.({type: 'state', epoch: 1, status: 'unconfigured', configured: false, storeAvailable: false, busy: false, products: []});
          });
        }};
      }, native);
      await page.goto('https://soul-reader.test/index.html?token=private-query-token');
      await page.waitForFunction(() => !!window.SoulBilling);
      return {page, errors};
    }

    async function snapshot(page) {
      return page.evaluate(() => ({
        screen: state.screen,
        billingMessages: structuredClone(billingMessages),
        photoData: state.photoData,
        readingId: state.reading?.id,
        storage: {...localStorage},
      }));
    }

    async function expectLinks(page, lang) {
      const footer = page.locator('#legal-support');
      assert.equal(await footer.count(), 1, 'Legal links remain available after each render');
      for (const [index, action] of ['privacy', 'deleteAccount'].entries()) {
        const button = footer.getByRole('button', {name: labels[lang][index], exact: true});
        assert.equal(await button.isVisible(), true, `${lang} ${action} is discoverable`);
        assert.equal(await button.getAttribute('data-legal-action'), action);
        assert.equal(await button.isEnabled(), true, 'Legal help remains available without configured purchases');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Legal labels fit a mobile viewport');
    }

    for (const native of [true, false]) {
      const {page, errors} = await open(native);
      for (const lang of Object.keys(labels)) {
        await page.evaluate(() => goto('welcome'));
        // The existing developer-tools toggle overlaps the home language bar
        // at this viewport; keep real pointer clicks for the legal links below.
        await page.locator(`[data-lang="${lang}"]`).evaluate(button => button.click());
        await expectLinks(page, lang);
        assert.deepEqual(await page.evaluate(() => [legalMessages, externalOpens]), [[], []], 'Rendering and language changes never open legal pages');

        for (const screen of ['welcome', 'premium', 'checkout52']) {
          if (screen !== 'welcome') await page.evaluate(screen => {
            state.theme = 'love';
            state.sr67 = null;
            state.reading = buildReading();
            state.reading.id = 'private-reading-id';
            state.reading.photoData = 'data:image/png;base64,private-photo';
            state.photoData = state.reading.photoData;
            localStorage.setItem('legal-test-private-token', 'private-token');
            goto(screen);
          }, screen);
          await expectLinks(page, lang);
          for (const action of Object.keys(urls)) {
            const before = await snapshot(page);
            // An injected URL must never override the app's fixed public destination.
            await page.locator(`#legal-support [data-legal-action="${action}"]`).evaluate(button => {
              button.dataset.url = 'https://untrusted.test/?token=private-token';
            });
            await page.locator(`#legal-support [data-legal-action="${action}"]`).click();
            assert.deepEqual(await snapshot(page), before, 'Opening legal help never navigates the app, changes data, or sends billing commands');
            if (native) {
              assert.deepEqual(await page.evaluate(() => legalMessages), [action], 'The native bridge receives only an allowlisted action, with no account, photo, URL, or query payload');
              assert.deepEqual(await page.evaluate(() => externalOpens), [], 'Native opens are delegated to the external browser channel');
            } else {
              assert.deepEqual(await page.evaluate(() => legalMessages), []);
              assert.deepEqual(await page.evaluate(() => externalOpens), [[urls[action], '_blank', 'noopener,noreferrer']], 'Browser clicks open only the fixed public URL with opener protection');
            }
            await page.evaluate(() => { legalMessages.length = 0; externalOpens.length = 0; });
          }
        }
      }

      const before = await snapshot(page);
      await page.locator('#legal-support [data-legal-action="privacy"]').evaluate(button => {
        button.dataset.legalAction = 'https://untrusted.test/?token=private-token';
        button.click();
      });
      assert.deepEqual(await page.evaluate(() => [legalMessages, externalOpens]), [[], []], 'Unknown actions cannot open a URL or cross the native bridge');
      assert.deepEqual(await snapshot(page), before);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: persistent ko/en/ja legal links on home and purchase screens, explicit fixed public browser destinations, action-only native bridge, and unchanged app/account/photo state');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
