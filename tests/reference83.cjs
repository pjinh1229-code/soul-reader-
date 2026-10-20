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
   let reference,referenceGenerals;
   for(const n of [0,1,2]){
    await page.evaluate(({lang,n})=>{state.lang=lang;state.theme='love';state.face={brow:n,eyes:n,nose:n,smile:n,jaw:n,aura:n};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{eye:n*.1+.1,nose:n*.1+.1}};state.reading=buildReading();goto('result')},{lang,n});
    assert.equal(await page.locator('.ref83-entry').count(),0,'General symbolic types must not be inserted into the personal photo report');
    await page.locator('[data-route="theory83"]').click();
    assert.equal(await page.evaluate(()=>state.screen),'theory83');
    assert.equal(await page.locator('.ref83-entry').count(),12);
    assert.equal(await page.locator('[data-ref84-group]:not([data-ref84-group="all"])').count(),5);
    assert.equal(await page.locator('.p82-observed,[data-ratio82]').count(),0,'Keep reference material separate from photo measurement');
    assert.equal(await page.locator('.ref83-entry button,.ref83-entry.selected,.ref83-entry.active,.ref83-entry [aria-pressed]').count(),0,'No matched or selected type');
    const text=await page.locator('.ref83-catalog').textContent();
    if(reference===undefined){reference=text;referenceGenerals=await page.locator('.ref84-general').allTextContents()}else assert.equal(text,reference,'All types remain identical for every photo');
    assert.doesNotMatch(text,/당신은|이 사진에 해당|맞춤 결과/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'result');
   }
   await page.evaluate(()=>{state.reading=null;state.sr67={status:'manual'};goto('theory83')});
   assert.equal(await page.locator('.ref83-catalog').textContent(),reference,'The same reference is available without a photo');
   if(lang==='ko'){assert.match(reference,/차분|신중/);await page.locator('[data-ref84-group="1"]').click();assert.match(await page.locator('.ref84-results').textContent(),/재물|재백궁/);await page.locator('[data-ref84-reset]').click();}
   await page.evaluate(()=>{state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('premium')});
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();await page.locator('[data-ep="work"]').click();
   await page.locator('[data-route="theory83"]').click();assert.equal(await page.locator('.ref83-catalog').getAttribute('data-ref84-mode'),'work');await page.locator('[data-ref84-topic="general"]').click();assert.deepEqual(await page.locator('.ref84-general').allTextContents(),referenceGenerals);
   await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'episode52');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 60 general symbolic reference entries with 12 per page in 3 languages, identical for every photo and no-photo state, no automatic matching, separate reference screen and free/paid return navigation');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
