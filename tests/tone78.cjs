const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');

  for(const lang of ['ko','en','ja'])for(const n of [0,1,2]){
   await page.evaluate(({lang,n})=>{
    state.lang=lang;state.theme='love';state.face={brow:n,eyes:n,nose:n,smile:n,jaw:n,aura:n};
    state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};
    state.flirtChoice=0;goto('traits');
   },{lang,n});
   await page.locator('[data-route="romance"]').click();
   await page.waitForFunction(()=>state.screen==='result');
   assert.equal(await page.locator('[data-action="flirt-choice"],.flirt-options,.t78-mode,.c81-focus,.p82-report,.r74-summary').count(),0);
   assert.equal(await page.evaluate(()=>state.reading.choice),null);
   assert.equal(await page.locator('.r74-takeaway').isVisible(),true);
   assert.equal(await page.locator('.c81-feature-details').getAttribute('open'),null);
   await page.locator('.c81-feature-details > summary').click();
   assert.equal(await page.locator('.r74-part').count(),5);
   assert.equal(await page.locator('.r74-part').first().isVisible(),true);
   assert.equal(await page.locator('.sr85-part').count(),lang==='ko'?6:0);
   const saved=await page.locator('.r74-report').textContent();
   await page.evaluate(()=>{state.flirtChoice=1;render()});
   assert.equal(await page.locator('.r74-report').textContent(),saved,'Saved report does not change with stale tone selection');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: direct traits-to-result flow without tone choices; RYU report, daily takeaway and expandable details preserved in three locales');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
