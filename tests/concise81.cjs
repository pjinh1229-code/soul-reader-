const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');await page.evaluate(()=>{state.lang='ko';goto('photo')});
  const consent=page.locator('.consent-cta');
  assert.match(await consent.textContent(),/필수/);
  assert.equal(await consent.getAttribute('aria-pressed'),'false');
  const colors=await consent.evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopColor}));
  assert.equal(colors.background,'rgb(89, 27, 38)');assert.equal(colors.border,'rgb(255, 102, 120)');
  await consent.click();assert.equal(await consent.getAttribute('aria-pressed'),'true');
  await consent.click();assert.equal(await consent.getAttribute('aria-pressed'),'false');
  for(const lang of ['ko','en','ja']){
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('result')},lang);
   assert.equal(await page.locator('.c81-feature-details').getAttribute('open'),null);
   assert.equal(await page.locator('.r74-part').first().isVisible(),false);
   assert.equal(await page.locator('.c81-focus,.t78-mode,.p82-report,.r74-summary').count(),0);
   assert.equal(await page.locator('.r74-takeaway').isVisible(),true);
   assert.equal(await page.locator('#sr60VoicePanel').count(),0,'Old scene dialogue must not push the reading down');
   assert.doesNotMatch(await page.locator('.r74-report').textContent(),/등불|첫 장면|류는|류가|달빛/);
   assert.ok((await page.locator('.r74-takeaway p').textContent()).length<500);
   await page.locator('.c81-feature-details > summary').click();
   assert.equal(await page.locator('.r74-part').first().isVisible(),true);
   if(lang==='ko')assert.match(await page.locator('.r74-parts').textContent(),/상정.*감찰관.*재백궁.*출납관.*하정/s);
   await page.locator('[data-route="premium"]').last().click();
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(const topic of ['love','chance','work','bond']){
    await page.locator(`[data-ep="${topic}"]`).click();
    assert.ok((await page.locator('.g77-result p').nth(1).textContent()).length<250,'Situation guidance is short');
    assert.ok((await page.locator('.g77-result p').last().textContent()).length<400,'One short next action');
    assert.doesNotMatch(await page.locator('.g77-result').textContent(),/등불|첫 장면|류는|류가|달빛/);
    assert.equal(await page.locator('.c81-paid-details').getAttribute('open'),null);
    await page.locator('[data-sr65-episode-choice="0"]').click();await page.locator('[data-ep-complete]').click();
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: red required consent with opt-in toggling, concise cultural summaries, collapsed five-feature details, 12 short paid topic views and no scene metaphors in readings');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
