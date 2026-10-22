const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {chromium}=require('playwright');
const html=fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8');
const fixture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../scripts/ryu_topics853.json'),'utf8'));
const keys=['eyes','brow','smile','aura','nose','jaw'];
const weights=[['심','강','온'],['온','강','심'],['온','온','심'],['온','강','심'],['강','온','온'],['온','강','심']];
const topics=['love','chance','work','bond'];
const pure=html.slice(html.indexOf("const SR853_TOPICS="),html.indexOf('const SR854_LOCALES='));
const classify=vm.runInNewContext(pure+';classify853');
const cases={};
for(let n=0;n<729;n++){
 let value=n;const face={},counts={온:0,강:0,심:0};
 keys.forEach((k,i)=>{face[k]=value%3;value=Math.floor(value/3);counts[weights[i][face[k]]]++});
 const ranked=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
 const type=ranked[0][1]===2&&ranked[2][1]===2?'balanced':ranked[0][1]===ranked[1][1]?'mixed':ranked[0][0];
 const actual=classify(face);assert.equal(actual.type,type);assert.deepEqual(JSON.parse(JSON.stringify(actual.counts)),counts);
 cases[type]??=face;
}
assert.equal(Object.keys(cases).length,5);
const example={eyes:1,brow:1,smile:1,aura:2,nose:0,jaw:1};
assert.equal(classify(example).type,'강');assert.equal(classify(example).counts.강,4);
for(const bad of [null,{},Object.fromEntries(keys.map(k=>[k,0]))]){
 if(bad)delete bad.nose;assert.equal(classify(bad),null);
}
for(const bad of [-1,3,NaN,'1',null])assert.equal(classify({...example,nose:bad}),null);
console.log('PASS: all 729 six-feature combinations, all five energy types, strong example and invalid-input gates');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:html}):r.abort());
  await page.goto('https://soul-reader.test/index.html');
  await page.evaluate(()=>{state.lang='ko';state.theme='love';state.face={eyes:0,brow:0,smile:0,aura:0,nose:0,jaw:0};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();sampleEpisode='love';goto('episode52')});
  assert.equal(await page.locator('.sr853-report').count(),0,'Locked topics must not expose the new report');
  await page.evaluate(()=>goto('premium'));await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
  for(let column=0;column<topics.length;column++){
   await page.evaluate(()=>goto('chapters52'));await page.locator(`[data-ep="${topics[column]}"]`).click();
   for(const tier of [0,1,2]){
    await page.evaluate(tier=>{for(const k of ['eyes','brow','smile','aura','nose','jaw'])state.reading.sr67.face[k]=tier;render()},tier);
    assert.equal(await page.locator('.sr853-report').getAttribute('data-topic853'),topics[column]);
    assert.equal(await page.locator('.sr853-part').count(),6);
    for(const key of keys)assert.equal(await page.locator(`[data-part853="${key}"] p`).textContent(),fixture.parts[key][tier][column]);
    const type=await page.locator('.sr853-overall').getAttribute('data-energy853');
    assert.equal(await page.locator('.sr853-overall p').textContent(),fixture.summaries[type][column]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   }
   for(const [type,face] of Object.entries(cases)){
    await page.evaluate(face=>{state.reading.sr67.face=face;render()},face);
    assert.equal(await page.locator('.sr853-overall').getAttribute('data-energy853'),type);
    assert.equal(await page.locator('.sr853-overall p').textContent(),fixture.summaries[type][column]);
   }
  }
  const saved=await page.locator('.sr853-report').textContent();
  await page.evaluate(()=>{state.sr67={status:'error'};render()});
  assert.equal(await page.locator('.sr853-report').textContent(),saved,'Use saved reading rather than a later photo');
  for(const invalid of ['manual','error']){
   await page.evaluate(status=>{state.reading.sr67.status=status;render()},invalid);
   assert.equal(await page.locator('.sr853-part,.sr853-overall').count(),0);
  }
  await page.evaluate(()=>{state.reading.sr67.status='ready';delete state.reading.sr67.face.nose;render()});
  assert.equal(await page.locator('.sr853-overall').count(),0,'Do not classify incomplete six-feature readings');
  for(const lang of ['en','ja']){await page.evaluate(lang=>{state.lang=lang;render()},lang);assert.equal(await page.locator('.sr853-report').count(),1);assert.equal(await page.locator('.sr853-overall').count(),0)}
  assert.deepEqual(errors,[]);
  console.log('PASS: all 72 supplied topic lines and 20 summaries on real topic screens, access gate, saved snapshot, invalid-input handling and mobile layout');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
