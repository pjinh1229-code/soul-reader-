const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');
  const topics=['love','chance','work','bond'];
  async function start(lang,mask,pack='bundle'){
   await page.evaluate(lang=>{state.lang=lang;localStorage.setItem('sr4-lang',lang);state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('premium')},lang);
   await page.locator(`[data-pickpack="${pack}"]`).click();await page.locator('[data-demo-unlock]').click();
   if(pack!=='bundle')return;
   assert.equal(await page.locator('[data-final-route]').isDisabled(),true);
   await page.evaluate(({mask,topics})=>{for(let i=0;i<4;i++){
    document.querySelector(`[data-ep="${topics[i]}"]`).click();
    document.querySelector(`[data-sr65-episode-choice="${(mask>>(3-i))&1}"]`).click();
    document.querySelector('[data-ep-complete]').click();
   }},{mask,topics});
   await page.locator('[data-final-route]').click();
  }
  await start('ko',0,'single');await page.evaluate(()=>goto('finale54'));
  assert.equal(await page.locator('[data-ending-choice80]').count(),0,'A single pass must not access the final choice');
  for(const lang of ['ko','en','ja']){
   const ids=new Set(),events=new Set(),afters=new Set(),quotes=new Set(),families=new Set(),titles=new Set();
   const masks=lang==='ko'?Array.from({length:16},(_,i)=>i):[0,1,6,3,7,15];
   for(const mask of masks)for(let finish=0;finish<3;finish++){
    await start(lang,mask);
    assert.equal(await page.locator('.e80-ending').count(),0,'No ending revealed before final choice');
    assert.equal(await page.locator('[data-ending-choice80]').count(),3);
    assert.equal(await page.locator('.e80-history').getAttribute('open'),null,'Prior outcomes stay available without replacing the ending');
    await page.locator(`[data-ending-choice80="${finish}"]`).click();
    assert.equal(await page.locator('[data-ending80]').getAttribute('data-ending80'),String(mask*3+finish));
    assert.equal(await page.locator('[data-ending-choice80]:disabled').count(),3);
    const body=await page.locator('.e80-ending').textContent();
    assert.ok(body.length>(lang==='en'?500:200),'The ending needs a substantive scene, dialogue and aftermath');
    ids.add(await page.locator('[data-ending80]').getAttribute('data-ending80'));
    families.add(await page.locator('[data-family80]').getAttribute('data-family80'));
    titles.add(await page.locator('.e80-ending h2').textContent());
    events.add(await page.locator('.e80-event').textContent());
    afters.add(await page.locator('.e80-after').textContent());
    quotes.add(await page.locator('.e80-ending blockquote').textContent());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.evaluate(finish=>document.querySelector(`[data-ending-choice80="${(finish+1)%3}"]`).dispatchEvent(new MouseEvent('click',{bubbles:true})),finish);
    assert.equal(await page.locator('.e80-ending').textContent(),body,'Synthetic clicks cannot change the final decision');
    if(mask===15&&finish===2){
     await page.reload();await page.evaluate(()=>goto('premium'));await page.locator('[data-resume75]').click();await page.locator('[data-final-route]').click();
     assert.equal(await page.locator('.e80-ending').textContent(),body,'The ending and final decision survive restart');
    }
   }
   assert.equal(families.size,6);assert.equal(titles.size,18);assert.equal(events.size,18);assert.equal(afters.size,18);assert.equal(quotes.size,18);
   assert.equal(ids.size,lang==='ko'?48:18);
   console.log(`PASS: ${lang}: six story setups, 18 distinct closing scenes/dialogues/aftermaths; ${ids.size} routes, one-way final choice and saved ending`);
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
