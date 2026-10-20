const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800},timezoneId:'Asia/Seoul'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')}):r.abort());
  await page.goto('https://soul-reader.test/index.html');
  for(const lang of ['ko','en','ja']){
   const days=new Set();
   for(let d=1;d<=14;d++){
    await page.evaluate(({lang,d})=>{state.lang=lang;state.theme='love';state.face={brow:1,eyes:1,nose:1,smile:1,jaw:1,aura:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.flirtChoice=0;state.reading=buildReading();state.reading.date=new Date(2026,9,d,12).getTime();goto('result')},{lang,d});
    const direct=await page.locator('.r74-takeaway p').textContent(),id=await page.locator('.r74-takeaway').getAttribute('data-takeaway79');days.add(direct);
    await page.evaluate(()=>render());assert.equal(await page.locator('.r74-takeaway p').textContent(),direct);
    await page.evaluate(()=>{state.reading.choice=1;render()});
    assert.notEqual(await page.locator('.r74-takeaway p').textContent(),direct,'Both tones need distinct wording');
    assert.equal(await page.locator('.r74-takeaway').getAttribute('data-takeaway79'),id,'Tone changes wording, not the suggestion');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   }
   assert.equal(days.size,14,'Two weeks of consecutive dates must produce different suggestions');
  }
  await page.evaluate(()=>{state.lang='ko';state.reading.choice=0;state.archive=[];render();archiveSave()});
  const saved=await page.locator('.r74-takeaway').textContent();
  await page.reload();await page.evaluate(()=>{state.reading=state.archive[0];goto('result')});
  assert.equal(await page.locator('.r74-takeaway').textContent(),saved,'Saved reading must retain its dated suggestion');
  const prior=await page.locator('.r74-takeaway').getAttribute('data-takeaway79');
  await page.evaluate(()=>{state.reading.sr67.face.eyes=2;render()});
  assert.notEqual(await page.locator('.r74-takeaway').getAttribute('data-takeaway79'),prior,'Feature combinations participate in the selection');
  assert.deepEqual(errors,[]);
  console.log('PASS: 14 distinct daily suggestions in 3 languages, stable rerenders, two tone variants, saved-date persistence and feature-based selection');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
