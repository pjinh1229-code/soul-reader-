const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport: {width: 360, height: 800}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).pathname === '/index.html'
      ? route.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}) : route.abort());
    await page.addInitScript(() => {
      window.nativeMessages = [];
      window.holdFace = false;
      window.testFace = {brow:0,eyes:0,nose:0,smile:0,jaw:0,aura:0};
      window.PhotoScreen = {postMessage() {}};
      window.PhotoPicker = {postMessage() {}};
      window.FaceScan = {postMessage(message) {
        const request = JSON.parse(message);nativeMessages.push(request);
        if (holdFace) return;
        queueMicrotask(() => soulMlKitReceive(request.requestId,{ok:true,face:{...testFace},metrics:{measurementSource:'test_native_response'}}));
      }};
    });
    await page.goto('https://soul-reader.test/index.html');
    await page.evaluate(async () => {
      state.screen='photo';state.consent=true;render();
      const c=document.createElement('canvas');c.width=400;c.height=600;
      const ctx=c.getContext('2d'),g=ctx.createLinearGradient(0,0,400,600);
      g.addColorStop(0,'red');g.addColorStop(1,'blue');ctx.fillStyle=g;ctx.fillRect(0,0,400,600);
      ctx.fillStyle='white';ctx.fillRect(0,0,100,100);
      window.originalTestPhoto=c.toDataURL('image/png');
      await soulNativePhoto(originalTestPhoto);
    });
    await page.waitForFunction(() => state.sr67?.status === 'ready');
    assert.equal(await page.locator('[data-sr65-range]').count(),3);
    assert.doesNotMatch(await page.locator('.sr65-adjust').textContent(),/얼굴을 자동으로 인식하지 않아/);
    const originalData = await page.evaluate(() => state.photoData);
    for (const [key,value] of [['zoom','1.40'],['x','20'],['y','-15']]) {
      await page.locator(`[data-sr65-range="${key}"]`).evaluate((input,value) => {
        input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
      },value);
    }
    assert.equal(await page.evaluate(() => state.sr67.status),'adjusting');
    assert.equal(await page.locator('button[data-route="traits"]').isDisabled(),true);
    await page.locator('[data-sr65-btn="save"]').click();
    await page.waitForFunction(() => state.sr67?.status === 'ready');
    const cropped = await page.evaluate(async () => {
      const im=new Image();im.src=state.photoData;await im.decode();
      return {photo:state.photoData,width:im.naturalWidth,position:{...sr65Position},request:nativeMessages.at(-1).dataUrl};
    });
    assert.notEqual(cropped.photo,originalData,'Applying framing must create new analyzed pixels');
    assert.equal(cropped.width,960);
    assert.equal(cropped.request,cropped.photo,'ML Kit must receive the adjusted photo, not the previous original');
    assert.deepEqual(cropped.position,{zoom:1.4,x:20,y:-15});
    await page.locator('[data-sr65-btn="reset"]').click();
    await page.waitForFunction(() => state.sr67?.status === 'ready');
    assert.deepEqual(await page.evaluate(() => ({...sr65Position})),{zoom:1,x:0,y:0});
    assert.equal(await page.evaluate(async () => {const im=new Image();im.src=state.photoData;await im.decode();return im.naturalWidth}),400);

    // An older scan must never overwrite the result of a newly adjusted photo.
    await page.evaluate(async () => {holdFace=true;await soulNativePhoto(originalTestPhoto);});
    await page.waitForFunction(() => state.sr67?.status === 'loading');
    const oldRequest = await page.evaluate(() => nativeMessages.at(-1).requestId);
    await page.locator('[data-sr65-range="zoom"]').evaluate(input => {input.value='1.25';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.evaluate(() => {holdFace=false;testFace={brow:2,eyes:2,nose:2,smile:2,jaw:2,aura:2};});
    await page.locator('[data-sr65-btn="save"]').click();
    await page.evaluate(requestId => soulMlKitReceive(requestId,{ok:true,face:{brow:0,eyes:0,nose:0,smile:0,jaw:0,aura:0},metrics:{}}),oldRequest);
    await page.waitForFunction(() => state.sr67?.status === 'ready' && state.face.eyes===2);
    console.log('PASS: zoom/x/y, actual crop-to-ML Kit, original reset, and stale scan protection');

    const titles = [];
    for (const lang of ['ko','en','ja']) {
      for (const n of [0,1,2]) {
        await page.evaluate(({lang,n}) => {
          state.lang=lang;state.theme='love';state.face={brow:n,eyes:n,nose:n,smile:n,jaw:n,aura:n};
          state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};
          state.reading=buildReading();state.screen='result';render();
        },{lang,n});
        assert.equal(await page.locator('.r74-part').count(),5,`${lang}: all five features must be free`);
        assert.equal(await page.locator('.r74-part .r74-meaning').count(),5);
        assert.equal(await page.locator('.r74-dictionary').count(),1,'General definitions belong in the free report once');
        const summary=await page.locator('.r74-summary h2').textContent();titles.push(`${lang}:${summary}`);
        assert.equal(await page.locator('.c81-feature-details').getAttribute('open'),null,'Feature explanations start collapsed');
        assert.ok((await page.locator('.c81-focus h2').textContent()).length>8,'Show one plain-language takeaway first');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'Mobile report must fit viewport');
        if (lang==='ko' && n===2) {
          assert.match(await page.locator('[data-feature-key="nose"]').textContent(),/세로 길이가 긴/);
          assert.doesNotMatch(await page.locator('[data-feature-key="nose"]').textContent(),/둥근 코끝/,'Length measurement must not be presented as a measured nose-tip shape');
          await page.evaluate(()=>scrollTo(0,0));
          await page.screenshot({path:'/tmp/soul74-free-mobile.png'});
        }
      }
      await page.evaluate(()=>{state.screen='premium';render();});
      await page.locator('[data-pickpack="bundle"]').click();
      await page.locator('[data-demo-unlock]').click();
      for (const theme of ['love','chance','work','bond']) {
        await page.evaluate(({lang,theme})=>{state.lang=lang;sampleEpisode=theme;samplePack='bundle';state.screen='episode52';render();},{lang,theme});
        assert.equal(await page.locator('.r74-theme-reading').count(),1);
        assert.equal(await page.locator('.r74-part').count(),0,'Do not repeat the full free report in every premium chapter');
        assert.equal(await page.locator('.r74-story').count(),2);
        assert.equal(await page.locator('.r74-theme-reading').getAttribute('data-theme'),theme);
        const sectionLength=(await page.locator('.r74-premium-sections').textContent()).length;
        assert.ok(sectionLength>80,`${lang}/${theme}: observations and traditional context are present`);
        assert.equal(await page.locator('.c81-paid-details').getAttribute('open'),null,'Keep supporting details collapsed');
        assert.ok((await page.locator('.g77-result').textContent()).length<1500,'The main paid reading should be concise');
        assert.doesNotMatch(await page.locator('.g77-result').textContent(),/역할의 비유|등불|류는|첫 장면/,'Keep fictional scene prose out of the main topic guidance');
        assert.equal(await page.locator('.sr65-episode-branch button').count(),2,'Keep the original consequential story choices');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth+1),true,'Mobile premium screen must fit viewport');
        const fullStory=await page.locator('.r74-premium-sections').textContent();
        await page.evaluate(()=>{for(const k of ['brow','eyes','nose','smile','jaw','aura'])state.reading.sr67.face[k]=0;render();});
        assert.notEqual(await page.locator('.r74-premium-sections').textContent(),fullStory,'Premium text must vary with the measured photo combination');
        await page.evaluate(()=>{for(const k of ['brow','eyes','nose','smile','jaw','aura'])state.reading.sr67.face[k]=2;render();scrollTo(0,0);});
        if(lang==='ko'&&theme==='work')await page.screenshot({path:'/tmp/soul74-premium-mobile.png'});
      }
    }
    assert.equal(new Set(titles).size,9,'The summary must change with the input features in each language');
    let freeTakeaway;
    for (const theme of ['love','opportunity','career','relationship']) {
      await page.evaluate(theme=>{state.lang='ko';state.reading.theme=theme;state.screen='result';render();},theme);
      const line=await page.locator('.r74-takeaway').textContent();
      if(freeTakeaway===undefined)freeTakeaway=line;
      else assert.equal(line,freeTakeaway,'The free reading must be independent of premium themes');
    }
    await page.evaluate(()=>{state.screen='result';render();});
    await page.locator('[data-action="save"]').click();
    assert.equal(await page.evaluate(()=>state.archive.length),1,'Saving the new full report must work');
    await page.evaluate(()=>goto('archive'));
    await page.locator('[data-open]').first().click();
    assert.equal(await page.locator('.r74-part').count(),5,'Archived results must reopen the complete report');
    await page.evaluate(()=>{state.lang='ko';state.sr67=null;state.face={brow:0,eyes:1,smile:1,aura:0};state.reading=buildReading();state.screen='result';render();});
    assert.match(await page.locator('h1').textContent(),/직접 선택/);
    assert.match(await page.locator('[data-feature-key="nose"]').textContent(),/아직 선택하지/);
    await page.evaluate(()=>{state.screen='premium';render();});
    assert.equal(await page.locator('[data-pickpack]').count(),2);
    await page.locator('[data-pickpack="single"]').click();
    assert.equal(await page.locator('[data-demo-unlock]').count(),1,'Keep demo checkout working');
    assert.deepEqual(errors,[],'New report/framing flows must not throw');
    console.log('PASS: five free features, 9 distinct localized summaries, 12 distinct premium chapter views, mobile layout, manual fallback, and demo checkout');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
