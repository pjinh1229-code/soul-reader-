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
   await page.evaluate(lang=>{
    state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};
    state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{eye:.22,nose:.18,mouth:.4}};
    state.reading=buildReading();goto('result');
   },lang);
   assert.equal(await page.locator('.p82-report,.p82-feature').count(),0);
   await page.locator('.c81-feature-details > summary').click();
   const observed=await page.locator('#r74-nose .r74-observed').textContent();
   const history=await page.locator('#r74-nose .r74-core').textContent();
   await page.evaluate(()=>{state.reading.sr67.face.nose=2;render()});
   assert.notEqual(await page.locator('#r74-nose .r74-observed').textContent(),observed);
   assert.equal(await page.locator('#r74-nose .r74-core').textContent(),history);
   assert.equal(await page.locator('.r74-part').count(),5);
   assert.equal(await page.locator('.r74-dictionary').count(),1);
   await page.evaluate(()=>{state.reading.sr67.status='manual';render()});
   assert.equal(await page.locator('.sr85-part').count(),0);
   assert.equal(await page.locator('.p82-report,[data-ratio82]').count(),0);
   await page.evaluate(()=>{state.reading.sr67.status='ready';goto('premium')});
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(const topic of ['love','chance','work','bond']){
    await page.locator(`[data-ep="${topic}"]`).click();
    assert.equal(await page.locator('.p82-report,.p82-feature').count(),0);
    assert.equal(await page.locator('.r74-theme-reading').count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.equal(await page.locator('[data-sr65-episode-choice],.g76-fiction').count(),0);await page.locator('[data-back855]').click();
   }
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: removed photo-context panels; retained five feature details and traditional dictionary, changing observations, manual gate and premium chapters');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
