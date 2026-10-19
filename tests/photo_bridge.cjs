const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({ viewport: {width: 412, height: 915} });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'soul-reader.test' && url.pathname === '/index.html') {
        return route.fulfill({contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../assets/web/index.html'), 'utf8')});
      }
      return route.abort();
    });
    await page.addInitScript(() => {
      window.nativeMessages = { screen: [], picker: [], face: [] };
      window.PhotoScreen = {postMessage: message => nativeMessages.screen.push(JSON.parse(message))};
      window.PhotoPicker = {postMessage: message => nativeMessages.picker.push(JSON.parse(message))};
      window.FaceScan = {postMessage: message => {
        const request = JSON.parse(message);
        nativeMessages.face.push(request);
        queueMicrotask(() => window.soulMlKitReceive(request.requestId, {ok: true,
          face: {brow: 1, eyes: 1, nose: 1, smile: 1, jaw: 1, aura: 1},
          metrics: {measurementSource: 'test_native_response'}}));
      }};
    });
    await page.goto('https://soul-reader.test/index.html');
    assert.equal(await page.evaluate(() => typeof window.soulNativePhoto), 'function', 'Native bridge must initialize');
    await page.evaluate(() => {state.screen = 'photo'; render();});
    await page.waitForFunction(() => nativeMessages.screen.at(-1)?.show === true);
    assert.equal(await page.evaluate(() => nativeMessages.screen.at(-1).consent), false);
    assert.equal(await page.locator('#photoInput').count(), 0, 'Consent is required');
    await page.locator('[data-action="toggle-consent"]').click();
    await page.waitForFunction(() => nativeMessages.screen.at(-1)?.consent === true);
    await page.locator('label:has(#photoInput)').click();
    await page.locator('label:has(#galleryInput)').click();
    await page.locator('label:has(#fileBrowserInput)').click();
    await page.locator('[data-action="open-camera"]').click();
    assert.deepEqual(await page.evaluate(() => nativeMessages.picker.map(m => m.source)), ['camera', 'gallery', 'gallery', 'camera']);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      await window.soulNativePhoto(canvas.toDataURL('image/png'));
    });
    await page.waitForFunction(() => state.sr67?.status === 'ready');
    assert.equal(await page.evaluate(() => nativeMessages.face.length), 1, 'Photo must reach native ML Kit');
    assert.equal(await page.evaluate(() => state.sr67.source), 'mlkit');
    await page.locator('[data-action="toggle-consent"]').click();
    await page.waitForFunction(() => nativeMessages.screen.at(-1)?.consent === false);
    assert.equal(await page.locator('#photoInput').count(), 0);
    await page.evaluate(() => {state.screen = 'themes'; render();});
    await page.waitForFunction(() => nativeMessages.screen.at(-1)?.show === false);
    assert.deepEqual(errors, [], 'Page must not throw');
    console.log('PASS: consent, camera/gallery/file/alternate routing, native photo-to-ML Kit response, and navigation');
    await page.close();
    const web = await browser.newPage();
    await web.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'soul-reader.test' && url.pathname === '/index.html') {
        return route.fulfill({contentType: 'text/html', body: fs.readFileSync(path.resolve(__dirname, '../assets/web/index.html'), 'utf8')});
      }
      return route.abort();
    });
    await web.goto('https://soul-reader.test/index.html');
    await web.evaluate(() => {state.screen = 'photo'; render();});
    await web.locator('[data-action="toggle-consent"]').click();
    for (const id of ['photoInput', 'galleryInput', 'fileBrowserInput']) {
      const chooser = web.waitForEvent('filechooser');
      await web.locator(`label:has(#${id})`).click();
      await chooser;
    }
    console.log('PASS: browser-only file chooser fallback preserved');
    await web.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
