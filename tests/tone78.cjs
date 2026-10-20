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
   const outputs=[];
   for(const choice of [0,1]){
    await page.evaluate(({lang,n})=>{state.lang=lang;state.theme='love';state.face={brow:n,eyes:n,nose:n,smile:n,jaw:n,aura:n};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.flirtChoice=null;goto('romance');},{lang,n});
    await page.locator(`[data-action="flirt-choice"][data-choice="${choice}"]`).click();
    await page.evaluate(()=>{state.reading=buildReading();goto('result')});
    assert.equal(await page.evaluate(()=>state.reading.choice),choice);
    assert.equal(await page.locator('.r74-report').getAttribute('data-tone78'),choice===0?'direct':'gentle');
    outputs.push({focus:await page.locator('.c81-focus h2').textContent(),observed:await page.locator('.r74-observed').allTextContents(),labels:await page.locator('.r74-part h3').allTextContents(),cores:await page.locator('.r74-core').allTextContents(),snapshot:await page.evaluate(()=>JSON.stringify(state.reading.sr67))});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   }
   assert.notEqual(outputs[0].focus,outputs[1].focus,'The first visible reading also reflects the chosen tone');
   assert.deepEqual(outputs[0].observed,outputs[1].observed,'Tone must never change measurement statements');
   assert.deepEqual(outputs[0].labels,outputs[1].labels);
   assert.equal(outputs[0].snapshot,outputs[1].snapshot);
   assert.equal(outputs[0].cores.length,5);
   outputs[0].cores.forEach((text,i)=>assert.notEqual(text,outputs[1].cores[i],'Every feature must actually use the selected tone'));
   // A saved reading uses its own tone, even after another dialogue choice.
   await page.evaluate(()=>{state.flirtChoice=0;render()});
   assert.equal(await page.locator('.r74-report').getAttribute('data-tone78'),'gentle');
  }
  await page.evaluate(()=>{state.flirtChoice=null;state.reading=buildReading();goto('result')});
  assert.equal(await page.locator('.r74-report').getAttribute('data-tone78'),'gentle');
  assert.deepEqual(errors,[]);
  console.log('PASS: 18 tone-specific free reports from real dialogue choices, all 5 feature paragraphs differ, identical measurements, saved-reading tone and gentle skip default');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
