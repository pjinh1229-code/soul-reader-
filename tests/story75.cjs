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
  await page.locator('[data-route="themes"]').first().click();
  assert.equal(await page.evaluate(()=>state.screen),'photo','Free entry must go straight to photos');
  assert.equal(await page.locator('[data-theme]').count(),0);
  const topics=['love','chance','work','bond'];
  async function fresh(lang='ko'){
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('premium');},lang);
  }
  async function buy(pack){
   await page.locator(`[data-pickpack="${pack}"]`).click();
   assert.equal(await page.locator('[data-single-theme],[data-ep]').count(),0,'Do not ask for a theme before checkout');
   assert.equal(await page.locator('.pack-price').textContent(),pack==='single'?'₩990':'₩1,990');
   await page.locator('[data-demo-unlock]').click();
   assert.equal(await page.locator('[data-ep]').count(),4,'Offer four themes after checkout');
  }
  // Single pass chooses its one theme after checkout, and cannot change it.
  await fresh();await buy('single');
  await page.locator('[data-ep="work"]').click();
  assert.equal(await page.locator('[data-ep-complete]').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('[data-ep-complete]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(await page.evaluate(()=>state.screen),'episode52','Completion is blocked until a decision is committed');
  await page.locator('[data-sr65-episode-choice="1"]').click();
  const chosen=await page.locator('.b75-result').textContent();
  assert.match(chosen,/두 사람이 다시 그린 설계도/);
  assert.equal(await page.locator('[data-sr65-episode-choice="0"]').isDisabled(),true);
  await page.evaluate(()=>document.querySelector('[data-sr65-episode-choice="0"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(await page.locator('.b75-result').textContent(),chosen,'Synthetic clicks must not change an already committed choice');
  await page.locator('[data-ep-complete]').click();
  assert.equal(await page.locator('[data-ep="love"]').isDisabled(),true);
  assert.equal(await page.locator('[data-final-route]').count(),0,'Single pass does not include the bundle ending');
  await page.locator('[data-ep="work"]').click();
  assert.equal(await page.locator('.b75-result').textContent(),chosen);
  await page.reload();await page.evaluate(()=>goto('premium'));
  await page.locator('[data-resume75]').click();
  await page.locator('[data-ep="work"]').click();
  assert.equal(await page.locator('.b75-result').textContent(),chosen,'Decision must survive reload');
  assert.equal(await page.locator('[data-sr65-episode-choice="0"]').isDisabled(),true);
  // A bundle demo upgrade retains the committed route instead of resetting it.
  await page.evaluate(()=>goto('premium'));await buy('bundle');
  await page.locator('[data-ep="work"]').click();
  assert.equal(await page.locator('.b75-result').textContent(),chosen);
  console.log('PASS: direct free entry, new prices, checkout-before-theme, single-theme limits, one-way decisions, completion guard, reload persistence and upgrade persistence');
  // Every route has different events, gains, costs, and aftermath, in each locale.
  for(const lang of ['ko','en','ja']){
   const outcomes=new Map();
   for(const topic of topics){
    for(const n of [0,1]){
     await fresh(lang);await buy('bundle');await page.locator(`[data-ep="${topic}"]`).click();
     assert.equal(await page.locator('.b75-result').count(),0,'Do not reveal either outcome before the decision');
     await page.locator(`[data-sr65-episode-choice="${n}"]`).click();
     assert.equal(await page.locator('.b75-result').getAttribute('data-outcome75'),`${topic}-${n}`);
     assert.equal(await page.locator('[data-sr65-episode-choice]:disabled').count(),2);
     const result=await page.locator('.b75-result').textContent();
     assert.ok(result.length>140,`${lang}/${topic}/${n}: outcome contains substantive scenes`);
     const gain=await page.locator('.b75-gain strong').textContent(),cost=await page.locator('.b75-cost p').textContent();
     if(n===0)outcomes.set(topic,{result,gain,cost});
     else {const old=outcomes.get(topic);assert.notEqual(result,old.result);assert.notEqual(gain,old.gain);assert.notEqual(cost,old.cost);}
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    }
   }
  }
  console.log('PASS: 24 localized branch outcomes; events, gains and trade-offs differ for both paths');
  // Complete each of the sixteen combinations through the real UI.
  const endings=new Set(),bodies=new Set();
  for(let mask=0;mask<16;mask++){
   await fresh('ko');await buy('bundle');
   assert.equal(await page.locator('[data-final-route]').isDisabled(),true);
   for(let i=0;i<4;i++){
    await page.locator(`[data-ep="${topics[i]}"]`).click();
    await page.locator(`[data-sr65-episode-choice="${(mask>>(3-i))&1}"]`).click();
    await page.locator('[data-ep-complete]').click();
   }
   assert.equal(await page.locator('[data-final-route]').isDisabled(),false);
   await page.locator('[data-final-route]').click();
   assert.equal(await page.locator('[data-ending75]').getAttribute('data-ending75'),String(mask));
   endings.add(await page.locator('.b75-finale h2').textContent());bodies.add(await page.locator('.b75-finale').textContent());
   assert.equal(await page.locator('.b75-final-scene').count(),4);
  }
  assert.equal(endings.size,16);assert.equal(bodies.size,16);
  assert.deepEqual(errors,[]);
  console.log('PASS: all 16 complete bundle routes produce distinct endings carrying all four decisions');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
