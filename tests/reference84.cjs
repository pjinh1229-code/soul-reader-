const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).pathname==='/index.html'
   ?route.fulfill({contentType:'text/html',body:fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8')})
   :route.abort());
  await page.goto('https://soul-reader.test/index.html');
  const topics=['love','chance','work','bond'];
  const catalog=()=>page.locator('.ref83-catalog');
  async function fresh(lang='ko',tier=1,screen='result'){
   await page.evaluate(({lang,tier,screen})=>{
    state.lang=lang;state.theme='love';
    state.face={brow:tier,eyes:tier,nose:tier,smile:tier,jaw:tier,aura:tier};
    state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{eye:.1+tier*.1,nose:.1+tier*.1}};
    state.reading=buildReading();goto(screen);
   },{lang,tier,screen});
  }
  async function openReference(){
   assert.equal(await page.locator('[data-route="theory83"],.ref83-link').count(),0,'Catalog entry is removed from the app screens');await page.evaluate(()=>goto('theory83'));
   assert.equal(await page.evaluate(()=>state.screen),'theory83');
   assert.equal(await catalog().getAttribute('data-ref84-total'),'60');
  }
  async function fit(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Reference controls and long text must fit a phone viewport');}
  async function displayed(){
   return page.locator('.ref83-entry').evaluateAll(entries=>entries.map(el=>({
    id:el.getAttribute('data-reference83'),
    title:el.querySelector('h3')?.textContent.trim(),
    general:el.querySelector('.ref84-general')?.textContent.trim(),
    themed:el.querySelector('.ref84-themed')?.textContent.trim()||null
   })));
  }
  async function reset(){await page.locator('[data-ref84-reset]').click();}
  async function allEntries(mode='general'){
   await reset();
   assert.equal(await catalog().getAttribute('data-ref84-mode'),mode);
   assert.equal(await catalog().getAttribute('data-ref84-filtered'),'60');
   const entries=[];
   for(let number=1;number<=5;number++){
    if(number>1)await page.locator(`[data-ref84-page="${number}"]`).click();
    const rows=await displayed();assert.equal(rows.length,12,`Page ${number} should contain twelve entries`);
    entries.push(...rows);await fit();
   }
   assert.equal(new Set(entries.map(row=>row.id)).size,60,'Pagination must show every type once');
   assert.equal(new Set(entries.map(row=>row.title)).size,60,'Types need distinct names');
   for(const row of entries){
    assert.ok(row.general&&row.general.length>15,'Every type needs a general explanation');
    if(mode==='general')assert.equal(row.themed,null,'Free general mode must not expose paid topic notes');
    else {assert.ok(row.themed&&row.themed.length>15,'Every type needs the selected topic explanation');assert.notEqual(row.themed,row.general);}
   }
   assert.equal(await page.locator('.ref83-entry button,.ref83-entry.selected,.ref83-entry.active,.ref83-entry [aria-pressed]').count(),0,'Catalog types are not selected or matched to a person');
   assert.equal(await page.locator('.p82-observed,[data-ratio82]').count(),0,'Keep photo measurement separate from the cultural catalog');
   return entries;
  }
  async function buy(pack){
   await page.locator(`[data-pickpack="${pack}"]`).click();
   await page.locator('[data-demo-unlock]').click();
  }
  const baselines=new Map();
  for(const lang of ['ko','en','ja']){
   await fresh(lang);await openReference();
   assert.equal(await catalog().getAttribute('data-ref84-mode'),'general');
   for(const topic of topics){
    assert.equal(await page.locator(`[data-ref84-topic="${topic}"]`).isDisabled(),true,'Unowned topic must be locked');
    await page.locator(`[data-ref84-topic="${topic}"]`).evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    assert.equal(await catalog().getAttribute('data-ref84-mode'),'general','Synthetic clicks must not bypass the paid-topic gate');
    assert.equal(await page.locator('.ref84-themed').count(),0);
   }
   const rows=await allEntries();baselines.set(lang,rows);
   await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'result');
   await fresh(lang,2);await openReference();
   assert.deepEqual(await allEntries(),rows,'Different facial measurements must not change reference text or ranking');
   await page.evaluate(()=>{state.reading=null;state.sr67={status:'manual'};goto('welcome');goto('theory83')});
   assert.deepEqual(await allEntries(),rows,'The same catalog must be available without a photo');
   console.log(`PASS: ${lang}: all 60 general types across five pages; fixed reference for changed photos/no photo; free topic lock and phone layout`);
  }

  // Browsing controls filter the reference; they do not collect personality answers.
  await fresh('ko');await openReference();
  const groupIDs=new Set();
  for(let group=0;group<5;group++){
   await page.locator(`[data-ref84-group="${group}"]`).click();
   assert.equal(await catalog().getAttribute('data-ref84-filtered'),'12');
   const rows=await displayed();assert.equal(rows.length,12);
   for(const row of rows){assert.equal(groupIDs.has(row.id),false,'Each type belongs to one category');groupIDs.add(row.id);}
  }
  assert.deepEqual([...groupIDs].sort(),baselines.get('ko').map(row=>row.id).sort());
  await reset();
  const target=baselines.get('ko')[0];
  await page.locator('[data-ref84-search]').fill(target.title);
  await page.locator('[data-ref84-search]').press('Enter');
  const matches=await displayed();assert.ok(matches.length>0);assert.ok(matches.some(row=>row.id===target.id));
  for(const row of matches)assert.ok(`${row.title} ${row.general}`.includes(target.title),'Search results must match the submitted text');
  await page.locator('[data-ref84-search]').fill('reference84_no_such_text_7d2fe1');
  await page.locator('[data-ref84-search]').press('Enter');
  assert.equal(await catalog().getAttribute('data-ref84-filtered'),'0');
  assert.equal(await page.locator('.ref83-entry').count(),0);assert.equal(await page.locator('.ref84-empty').isVisible(),true);
  await reset();assert.equal(await catalog().getAttribute('data-ref84-filtered'),'60');
  console.log('PASS: five complete category filters, text search, empty-result state and reset');

  // A single pass opens only its committed theme; an upgrade opens all four.
  await fresh('ko',1,'premium');await buy('single');
  await page.locator('[data-ep="work"]').click();await openReference();
  assert.equal(await catalog().getAttribute('data-ref84-mode'),'work');
  assert.equal(await page.locator('[data-ref84-topic="work"]').isDisabled(),false);
  for(const topic of ['love','chance','bond']){
   assert.equal(await page.locator(`[data-ref84-topic="${topic}"]`).isDisabled(),true);
   await page.locator(`[data-ref84-topic="${topic}"]`).evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
   assert.equal(await catalog().getAttribute('data-ref84-mode'),'work');
  }
  await page.locator('[data-ref84-topic="general"]').click();
  assert.deepEqual(await allEntries(),baselines.get('ko'));
  await page.locator('[data-ref84-topic="work"]').click();
  assert.equal(new Set((await allEntries('work')).map(row=>row.themed)).size,60);
  await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'episode52');
  await page.evaluate(()=>goto('premium'));await buy('bundle');
  await page.locator('[data-ep="work"]').click();await openReference();
  const allThemed=new Set();
  for(const topic of topics){
   assert.equal(await page.locator(`[data-ref84-topic="${topic}"]`).isDisabled(),false);
   await page.locator(`[data-ref84-topic="${topic}"]`).click();
   for(const row of await allEntries(topic))allThemed.add(row.themed);
  }
  assert.equal(allThemed.size,240,'All four topics need 60 distinct editorial expansions each');
  await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'episode52');
  console.log('PASS: single-topic ownership, synthetic gate enforcement, bundle upgrade and all 240 distinct Korean topic explanations');

  for(const lang of ['en','ja']){
   await fresh(lang,1,'premium');await buy('bundle');await page.locator('[data-ep="love"]').click();await openReference();
   const texts=new Set();
   for(const topic of topics){
    await page.locator(`[data-ref84-topic="${topic}"]`).click();await reset();
    assert.equal(await catalog().getAttribute('data-ref84-mode'),topic);
    assert.equal(await catalog().getAttribute('data-ref84-filtered'),'60');
    const rows=await displayed();assert.equal(rows.length,12);
    for(const row of rows){assert.ok(row.themed&&row.themed.length>15);assert.notEqual(row.themed,row.general);texts.add(row.themed);}
    await fit();
   }
   assert.equal(texts.size,48,'Localized topic previews must differ across all four themes');
   await page.locator('.circle-back').click();assert.equal(await page.evaluate(()=>state.screen),'episode52');
   console.log(`PASS: ${lang}: all four localized topic modes, distinct editorial previews, owned-topic access and return navigation`);
  }

  // Regression: the active result renderer must display the integrated 8.5 script.
  const reports=[];
  for(const tier of [0,1,2]){
   await fresh('ko',tier);
   assert.equal(await page.locator('.sr85-report').count(),1);
   assert.equal(await page.locator('.sr85-part').count(),6);
   assert.equal(await page.locator('.sr85-overall').count(),1);
   assert.ok(await page.locator('.sr85-report').isVisible());
   assert.equal(await page.locator('[data-route="theory83"],.ref83-link').count(),0);
   assert.equal(await page.evaluate(()=>{
    const ryu=document.querySelector('.sr85-report'),photo=document.querySelector('.r74-takeaway');
    return !!(ryu.compareDocumentPosition(photo)&Node.DOCUMENT_POSITION_FOLLOWING);
   }),true,'RYU reading must appear before the daily takeaway and collapsed details');
   reports.push(await page.locator('.sr85-report').innerText());
   await fit();
  }
  assert.equal(new Set(reports).size,3,'Different classifications must select different script variants');
  await page.evaluate(()=>{state.sr67={status:'error'};render()});
  assert.equal(await page.locator('.sr85-report').innerText(),reports[2],'Saved result must retain its own analyzed snapshot');
  await page.evaluate(()=>{state.sr67={status:'manual'};state.reading=buildReading();goto('result')});
  assert.equal(await page.locator('.sr85-part').count(),0,'Manual inputs must not pretend to be ML Kit analysis');
  for(const lang of ['en','ja']){await fresh(lang);assert.equal(await page.locator('.sr85-report').count(),1);assert.equal(await page.locator('.sr85-part').count(),6);assert.equal(/[가-힣]/u.test(await page.locator('.sr85-report').innerText()),false);}
  console.log('PASS: 8.5 active result displays six script sections and summary; varied classifications, saved snapshot, manual gate and localized reports');

  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
