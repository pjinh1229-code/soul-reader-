const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');
  for(const lang of ['ko','en','ja']){
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{upper:.29,eye:.22,nose:.18,mouth:.4,jaw:.7}};state.reading=buildReading();goto('result')},lang);
   assert.equal(await page.locator('.p82-feature').count(),3);
   assert.equal(await page.locator('.p82-feature').first().isVisible(),true);
   assert.match(await page.locator('[data-ratio82="eye"]').textContent(),/22\.0%/);
   assert.match(await page.locator('[data-ratio82="nose"]').textContent(),/18\.0%/);
   assert.match(await page.locator('[data-ratio82="mouth"]').textContent(),/40\.0%/);
   for(const text of await page.locator('.p82-history').allTextContents())assert.ok(text.length>80,'Provide a substantive historical explanation, not just a label');
   const observed=await page.locator('[data-photo-feature82="nose"] .p82-observed').textContent();
   const history=await page.locator('[data-photo-feature82="nose"] .p82-history').textContent();
   await page.evaluate(()=>{state.reading.sr67.face.nose=2;state.reading.sr67.metrics.nose=.31;render()});
   assert.notEqual(await page.locator('[data-photo-feature82="nose"] .p82-observed').textContent(),observed);
   assert.equal(await page.locator('[data-photo-feature82="nose"] .p82-history').textContent(),history,'Historical context must not turn into a personalized wealth inference');
   await page.evaluate(()=>{state.reading.sr67.metrics={nose:NaN,mouth:'0.4',eye:2};render()});
   assert.equal(await page.locator('[data-ratio82]').count(),0,'Do not invent values or display invalid measurements');
   await page.evaluate(()=>{state.reading.sr67.status='manual';render()});
   assert.equal(await page.locator('[data-ratio82]').count(),0);
   await page.evaluate(()=>{state.reading.sr67.status='ready';goto('premium')});
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(const topic of ['love','chance','work','bond']){
    await page.locator(`[data-ep="${topic}"]`).click();
    assert.equal(await page.locator('.p82-feature').count(),2);
    assert.equal(await page.locator('.p82-feature').first().isVisible(),true);
    assert.ok((await page.locator('.p82-history').first().textContent()).length>80);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.locator('[data-sr65-episode-choice="0"]').click();await page.locator('[data-ep-complete]').click();
   }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: visible measured-photo explanations and historical context in 3 languages, correct ratios and units, missing/invalid/manual value handling, changing observations without invented personal traits, 12 paid topic reports');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
