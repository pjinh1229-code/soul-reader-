const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');
  for(const lang of ['ko','en','ja']){
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('premium');},lang);
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(const topic of ['love','chance','work','bond']){
    await page.locator(`[data-ep="${topic}"]`).click();
    const evidence=await page.locator('.r74-story').first().textContent();
    const count=await page.locator('[data-context76]').count(),bodies=new Set();
    assert.ok(count>=4);
    for(let i=0;i<count;i++){
     await page.locator(`[data-context76="${i}"]`).click();
     assert.equal(await page.locator('.r74-story').count(),4);
     assert.equal(await page.locator('.r74-story').first().textContent(),evidence);
     const body=await page.locator('.r74-premium-sections').textContent();
     assert.doesNotMatch(body,/첫 장면|바라봄에서|등불|달빛|류는|류가|편지/);
     bodies.add(body);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    }
    assert.equal(bodies.size,count,'Each situation needs distinct practical guidance');
    await page.locator('[data-sr65-episode-choice="1"]').click();
    const result=await page.locator('.b75-result').textContent();
    await page.locator('[data-context76="0"]').click();
    assert.equal(await page.locator('.b75-result').textContent(),result);
    assert.equal(await page.locator('[data-sr65-episode-choice]:disabled').count(),2);
    await page.locator('[data-context76="1"]').click();
    await page.locator('[data-ep-complete]').click();
    await page.locator(`[data-ep="${topic}"]`).click();
    assert.equal(await page.locator('[data-context76="1"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-ep-complete]').click();
   }
  }
  await page.reload();await page.evaluate(()=>goto('premium'));await page.locator('[data-resume75]').click();await page.locator('[data-ep="bond"]').click();
  assert.equal(await page.locator('[data-context76="1"]').getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
  console.log('PASS: 51 localized situation readings, measured evidence, no scene prose in guidance, persistent contexts and unchanged committed branches');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
