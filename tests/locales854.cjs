const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const html=fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8');
const keys=['eyes','brow','smile','aura','nose','jaw'];
const topics=['love','chance','work','bond'];
const weights=[['심','강','온'],['온','강','심'],['온','온','심'],['온','강','심'],['강','온','온'],['온','강','심']];
const cases={};
for(let n=0;n<729;n++){
 let v=n;const face={},c={온:0,강:0,심:0};
 keys.forEach((k,i)=>{face[k]=v%3;v=Math.floor(v/3);c[weights[i][face[k]]]++});
 const entries=Object.entries(c).sort((a,b)=>b[1]-a[1]);
 const type=entries.every(e=>e[1]===2)?'balanced':entries[0][1]===entries[1][1]?'mixed':entries[0][0];
 cases[type]??=face;
}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  for(const lang of ['en','ja']){
   const fixture=JSON.parse(fs.readFileSync(path.resolve(__dirname,`../scripts/ryu_${lang}854.json`),'utf8'));
   const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:html}):r.abort());
   await page.goto('https://soul-reader.test/index.html');
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={eyes:0,brow:0,smile:0,aura:0,nose:0,jaw:0};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();sampleEpisode='love';goto('episode52')},lang);
   assert.equal(await page.locator('.sr853-report').count(),0);
   await page.evaluate(()=>goto('premium'));await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(let column=0;column<topics.length;column++){
    await page.evaluate(()=>goto('chapters52'));await page.locator(`[data-ep="${topics[column]}"]`).click();
    for(const tier of [0,1,2]){
     await page.evaluate(tier=>{for(const k of ['eyes','brow','smile','aura','nose','jaw'])state.reading.sr67.face[k]=tier;render()},tier);
     assert.equal(await page.locator('.sr853-report').count(),1);
     assert.equal(await page.locator('.sr853-report').getAttribute('lang'),lang);
     assert.equal(await page.locator('.sr853-part').count(),6);
     for(const [i,key] of keys.entries()){
      assert.equal(await page.locator(`[data-part853="${key}"] p`).textContent(),fixture.parts[key][tier][column]);
      assert.equal(await page.locator(`[data-part853="${key}"] b`).textContent(),fixture.ui.titles[i]);
      assert.equal(await page.locator(`[data-part853="${key}"] em`).textContent(),fixture.ui.options[i][tier]);
     }
     assert.equal(/[가-힣]/u.test(await page.locator('.sr853-report').textContent()),false);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    }
    for(const [type,face] of Object.entries(cases)){
     await page.evaluate(face=>{state.reading.sr67.face=face;render()},face);
     assert.equal(await page.locator('.sr853-overall').getAttribute('data-energy853'),type);
     assert.equal(await page.locator('.sr853-overall p').textContent(),fixture.summaries[type][column]);
    }
   }
   // Existing reading updates immediately when the language changes.
   for(const switchLang of ['ko',lang]){
    await page.evaluate(l=>{state.lang=l;render()},switchLang);
    assert.equal(await page.locator('.sr853-report').count(),1);
    assert.equal(/[가-힣]/u.test(await page.locator('.sr853-report').textContent()),switchLang==='ko');
   }
   await page.evaluate(()=>goto('result'));
   for(const tier of [0,1,2]){
    await page.evaluate(tier=>{for(const k of ['eyes','brow','smile','aura','nose','jaw'])state.reading.sr67.face[k]=tier;render()},tier);
    assert.equal(await page.locator('.sr854-general').count(),1);
    assert.equal(await page.locator('.sr854-general .sr85-part').count(),6);
    for(const key of keys)assert.equal(await page.locator(`.sr854-general [data-part853="${key}"] p`).textContent(),fixture.general[key][tier]);
    assert.equal(/[가-힣]/u.test(await page.locator('.sr854-general').textContent()),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   }
   for(const [type,face] of Object.entries(cases)){
    await page.evaluate(face=>{state.reading.sr67.face=face;render()},face);
    assert.equal(await page.locator('.sr854-general .sr85-overall').getAttribute('data-energy854'),type);
    assert.equal(await page.locator('.sr854-general .sr85-overall p').textContent(),fixture.generalSummaries[type]);
   }
   await page.evaluate(()=>{state.reading.sr67.status='error';render()});
   assert.equal(await page.locator('.sr854-general .sr85-part').count(),0);
   assert.ok((await page.locator('.sr854-general').textContent()).includes(fixture.ui.pending));
   assert.deepEqual(errors,[]);
   console.log(`PASS ${lang}: 72 topic lines, 20 summaries, 18 general readings, five general summaries, localized labels, language switching, lock/analysis gates, mobile width`);
   await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
