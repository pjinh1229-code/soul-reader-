const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '../assets/web');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ads = fs.readFileSync(path.join(root, 'free_reading_ads.js'), 'utf8');
const billing = fs.readFileSync(path.join(root, 'billing.js'), 'utf8');
const labels = {ko: '광고 개인정보 설정', en: 'Ad privacy settings', ja: '広告のプライバシー設定'};
const storageKey = 'sr-free-reading-ad-attempts';

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']});
  try {
    async function open({native = true, loadModule = true, throwing = false, lang = 'ko'} = {}) {
      const page = await browser.newPage({viewport: {width: 360, height: 800}}), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install();
      await page.route('**/*', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/index.html') return route.fulfill({contentType: 'text/html', body: html});
        if (pathname === '/billing.js') return route.fulfill({contentType: 'application/javascript', body: billing});
        if (pathname === '/free_reading_ads.js' && loadModule) return route.fulfill({contentType: 'application/javascript', body: ads});
        if (/^\/audio\/(ko|en|ja)\/result\.mp3$/.test(pathname)) return route.fulfill({contentType: 'audio/mpeg', body: fs.readFileSync(path.join(root, pathname.slice(1)))});
        return route.abort();
      });
      await page.addInitScript(({native, throwing}) => {
        window.adMessages = []; window.voiceCalls = []; window.adPauseEvents = 0;
        window.addEventListener('sr-free-reading-ads-pause', () => ++adPauseEvents);
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (this.src.includes('/audio/') && !this.src.endsWith('/bgm.mp3')) {
            voiceCalls.push(this.src); window.reportVoice = this;
          }
          return play.call(this);
        };
        if (native) window.FreeReadingAds = {postMessage(raw) {
          adMessages.push(JSON.parse(raw));
          if (throwing) throw new Error('Unavailable native channel');
        }};
        window.ReviewAccess = {postMessage() {}};
        window.StoreBilling = {postMessage(raw) {
          if (JSON.parse(raw).action === 'status') queueMicrotask(() => {
            soulBillingReceive({type: 'auth', epoch: 1, available: true, signedIn: true, label: '', busy: false});
            soulBillingReceive({type: 'state', epoch: 1, status: 'ready', configured: true, storeAvailable: true, busy: false, products: []});
          });
        }};
      }, {native, throwing});
      await page.goto('https://soul-reader.test/index.html');
      await page.evaluate(lang => {state.lang = lang; window.SRFreeReadingAds?.setState({enabled: true, privacyOptionsRequired: true}); render();}, lang);
      return {page, errors};
    }
    async function prepare(page) {
      await page.evaluate(() => {
        state.theme = 'love'; state.face = {eyes: 1, brow: 1, smile: 1, aura: 1, nose: 1, jaw: 1};
        state.sr67 = {status: 'ready', source: 'mlkit', face: {...state.face}, metrics: {}};
        state.photoData = 'data:image/png;base64,private-photo';
        goto('traits');
      });
    }
    async function reveal(page) {
      await prepare(page);
      await page.locator('[data-route="romance"]').click();
      assert.equal(await page.evaluate(() => state.screen), 'loading');
      await page.clock.fastForward(2500);
      return page.evaluate(() => state.reading.id);
    }
    async function respond(page, request, status = 'completed') {
      await page.evaluate(payload => SRFreeReadingAds.receive(payload), {...request, status});
    }
    async function checkReport(page) {
      assert.equal(await page.evaluate(() => state.screen), 'result');
      assert.equal(await page.locator('.sr85-part').count(), 6, 'A single completed gate opens all six free items');
      assert.equal(await page.locator('.sr856-voice').getAttribute('data-voice856'), 'result');
      assert.equal(await page.evaluate(() => voiceCalls.filter(src => src.endsWith('/result.mp3')).length), 1);
    }
    async function finish(page, errors) {assert.deepEqual(errors, []); await page.close();}

    for (const lang of Object.keys(labels)) {
      const {page, errors} = await open({lang});
      assert.equal(await page.locator('[data-free-reading-ad-privacy]').textContent(), labels[lang]);
      assert.deepEqual(await page.evaluate(() => adMessages), [], 'Startup and rendering never request ads or consent forms');
      await prepare(page);
      assert.deepEqual(await page.evaluate(() => adMessages), [], 'Photo/feature selection never requests an ad');
      await page.locator('[data-route="romance"]').click();
      const id = await page.evaluate(() => state.reading.id);
      await page.evaluate(() => {beginReveal(); beginReveal();});
      assert.equal(await page.evaluate(() => state.reading.id), id, 'Double submission retains the actual report ID');
      assert.deepEqual(await page.evaluate(() => adMessages), [], 'The natural loading transition finishes before the ad opportunity');
      await page.clock.fastForward(2500);
      const request = await page.evaluate(() => adMessages[0]);
      assert.deepEqual(Object.keys(request).sort(), ['action', 'readingId', 'requestId']);
      assert.equal(request.action, 'show'); assert.equal(request.readingId, id);
      assert.ok(request.requestId.length > 15);
      assert.equal(await page.evaluate(key => Object.hasOwn(JSON.parse(localStorage.getItem(key)), state.reading.id), storageKey), true);
      assert.equal(await page.evaluate(() => !!state.reading.freeReadingAdAttemptedAt), true);
      assert.equal(await page.evaluate(() => adPauseEvents), 1);
      assert.deepEqual(await page.evaluate(() => voiceCalls), [], 'No report speech starts while consent/ad is open');
      for (const invalid of [null, [], {}, {...request, status: 'shown'}, {...request, status: 'completed', requestId: 'stale'}, {...request, status: 'skipped', readingId: 'other-report'}]) {
        await page.evaluate(payload => SRFreeReadingAds.receive(payload), invalid);
        assert.equal(await page.evaluate(() => SRFreeReadingAds.isPending()), true);
      }
      await page.clock.fastForward(120000);
      assert.equal(await page.evaluate(() => state.screen), 'loading', 'A long-running native overlay cannot be bypassed by a JS timeout');
      assert.deepEqual(await page.evaluate(() => voiceCalls), []);
      await page.evaluate(() => {render(); beginReveal();});
      assert.equal(await page.evaluate(() => adMessages.length), 1);
      await page.evaluate(() => {goto('romance'); goto('romance');});
      assert.equal(await page.evaluate(() => adMessages.length), 1, 'Repeated reveal-route events cannot cancel or duplicate the pending opportunity');
      await respond(page, request, lang === 'en' ? 'skipped' : 'completed');
      await checkReport(page);
      assert.equal(await page.evaluate(() => SRFreeReadingAds.isPending()), false);
      await respond(page, request);
      await page.evaluate(() => {render(); render();});
      assert.equal(await page.evaluate(() => voiceCalls.length), 1, 'Duplicate responses/rerenders cannot replay speech or ads');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

      // Consent choices are explicit, retain the same matching-response contract,
      // and pause the detached report player as well as visible media elements.
      await page.locator('[data-free-reading-ad-privacy]').click();
      const privacy = await page.evaluate(() => adMessages.at(-1));
      assert.equal(privacy.action, 'privacy'); assert.equal(privacy.readingId, id);
      assert.notEqual(privacy.requestId, request.requestId);
      assert.equal(await page.evaluate(() => reportVoice.paused), true);
      const calls = await page.evaluate(() => voiceCalls.length);
      await page.locator('[data-replay856]').evaluate(button => button.click());
      await page.clock.fastForward(120000);
      assert.equal(await page.evaluate(() => voiceCalls.length), calls);
      await respond(page, privacy);
      assert.equal(await page.evaluate(() => voiceCalls.length), calls, 'Closing privacy options does not restart a report mid-reading');

      await page.evaluate(() => {archiveSave(); goto('archive');});
      assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('sr4-archive'))[0].freeReadingAdAttemptedAt));
      await page.locator(`[data-open="${id}"]`).click();
      await page.clock.fastForward(120000);
      assert.equal(await page.evaluate(() => adMessages.length), 2, 'History/reopening has no ad opportunity');
      await page.reload();
      await page.evaluate(() => goto('archive'));
      await page.locator(`[data-open="${id}"]`).click();
      await page.evaluate(() => {
        delete state.reading.freeReadingAdAttemptedAt; goto('loading');
        SRFreeReadingAds.beforeOpen(state.reading, () => goto('result'));
      });
      assert.deepEqual(await page.evaluate(() => adMessages), [], 'The durable report-ID ledger prevents replay even if a historical snapshot lacks the marker');
      assert.equal(await page.evaluate(() => state.screen), 'result');
      await finish(page, errors);
    }

    for (const scenario of ['browser', 'missing-module', 'disabled', 'throwing', 'storage', 'review', 'purchased-current', 'purchased-other', 'busy']) {
      const {page, errors} = await open({native: scenario !== 'browser', loadModule: scenario !== 'missing-module', throwing: scenario === 'throwing'});
      if (scenario === 'disabled') await page.evaluate(() => SRFreeReadingAds.setEnabled(false));
      if (scenario === 'storage') await page.evaluate(key => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, value) {if (name === key) throw new Error('Storage full'); return set.call(this, name, value);};
      }, storageKey);
      if (scenario === 'review') await page.evaluate(() => soulReviewAccessReceive({active: true, expiresAt: Date.now() + 3600000}));
      if (scenario === 'purchased-other') await page.evaluate(() => {
        state.theme = 'love'; state.reading = buildReading(); state.reading.id = 'previous-purchased-photo';
        SoulBillingApp.setEntitlements([{entitlementId: 'verified-pass', readingId: state.reading.id, offerKey: 'bundle'}]);
      });
      if (scenario === 'busy') await page.evaluate(() => soulBillingReceive({type: 'auth', epoch: 1, available: true, signedIn: true, label: '', busy: true}));
      if (scenario === 'purchased-current') {
        await prepare(page);
        await page.locator('[data-route="romance"]').click();
        await page.evaluate(() => SoulBillingApp.setEntitlements([{entitlementId: 'verified-current-pass', readingId: state.reading.id, offerKey: 'bundle'}]));
        await page.clock.fastForward(2500);
      } else await reveal(page);
      if (scenario === 'purchased-other') {
        assert.equal(await page.evaluate(() => adMessages[0].action), 'show', 'An unrelated purchased report does not remove ads from a new free photo');
        await respond(page, await page.evaluate(() => adMessages[0]), 'skipped');
      }
      await checkReport(page);
      assert.equal(await page.evaluate(() => adMessages.length), ['throwing', 'purchased-other'].includes(scenario) ? 1 : 0, `${scenario} keeps the complete free report accessible`);
      if (['browser', 'disabled'].includes(scenario)) assert.equal(await page.locator('[data-free-reading-ad-privacy]').count(), 0);
      await finish(page, errors);
    }
    {
      const {page, errors} = await open();
      await page.evaluate(() => SRFreeReadingAds.setState({enabled: true, privacyOptionsRequired: false}));
      assert.equal(await page.locator('[data-free-reading-ad-privacy]').count(), 0, 'No dead privacy control when UMP has no privacy form');
      await page.evaluate(() => SRFreeReadingAds.setState({enabled: false, privacyOptionsRequired: true}));
      assert.equal(await page.locator('[data-free-reading-ad-privacy]').count(), 0, 'Off mode hides privacy controls');
      await page.evaluate(() => SRFreeReadingAds.setState({enabled: true, privacyOptionsRequired: true}));
      await page.locator('[data-free-reading-ad-privacy]').click();
      const request = await page.evaluate(() => adMessages[0]);
      assert.equal(request.action, 'privacy'); assert.equal(request.readingId, '');
      await respond(page, request, 'skipped');
      assert.equal(await page.evaluate(() => state.screen), 'welcome');
      await reveal(page);
      const oldRequest = await page.evaluate(() => adMessages.at(-1));
      await page.evaluate(() => {goto('premium'); goto('loading');});
      assert.deepEqual(await page.evaluate(() => adMessages.at(-1)), {...oldRequest, action: 'cancel'}, 'Route changes immediately cancel native loading with the matching IDs');
      await page.evaluate(() => {goto('themes'); goto('loading'); render();});
      assert.equal(await page.evaluate(() => adMessages.filter(message => message.action === 'cancel').length), 1, 'A request sends cancellation only once');
      assert.equal(await page.evaluate(() => SRFreeReadingAds.isPending()), true, 'Cancellation retains audio suppression until native dismissal');
      await respond(page, oldRequest);
      assert.equal(await page.evaluate(() => state.screen), 'loading', 'Leaving and returning invalidates the original continuation');
      await page.evaluate(() => goto('themes'));
      await reveal(page);
      const nextRequest = await page.evaluate(() => adMessages.at(-1));
      assert.notEqual(nextRequest.readingId, oldRequest.readingId);
      assert.notEqual(nextRequest.requestId, oldRequest.requestId);
      await respond(page, oldRequest);
      assert.equal(await page.evaluate(() => SRFreeReadingAds.isPending()), true, 'A prior request cannot release the next report');
      await respond(page, nextRequest);
      await checkReport(page);
      await page.evaluate(() => goto('themes'));
      await reveal(page);
      const canceledRequest = await page.evaluate(() => adMessages.at(-1));
      await page.evaluate(() => {state.reading = {...state.reading, id: 'a-different-report'}; goto('result');});
      const calls = await page.evaluate(() => voiceCalls.length);
      await page.clock.fastForward(120000);
      assert.equal(await page.evaluate(() => voiceCalls.length), calls, 'Changing routes cannot start report speech while the old native overlay is open');
      await respond(page, canceledRequest);
      assert.equal(await page.evaluate(() => state.reading.id), 'a-different-report');
      assert.equal(await page.evaluate(() => voiceCalls.length), calls, 'Stale continuation never starts or replaces another report');
      await finish(page, errors);
    }
    assert.doesNotMatch(ads, /setTimeout|setInterval/, 'Only native load/consent failure or dismissal can release a live overlay');
    console.log('PASS: actual reveal/report IDs, one persisted attempt per complete six-item report, double-click/token/route/reload safety, long-overlay audio suppression, native privacy callbacks, KO/EN/JA, history and review/purchase/busy/browser/failure bypasses');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
