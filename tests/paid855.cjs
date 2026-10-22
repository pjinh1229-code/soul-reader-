const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const html=fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8');
const retired='.sr65-episode-branch,.b75-result,.g76-fiction,.g76-story-label,.c81-story-audio,.e80-page,[data-final-route],[data-ep-complete],[data-sr65-episode-choice],.b75-progress';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  for(const lang of ['ko','en','ja']){
   const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).pathname==='/index.html'?r.fulfill({contentType:'text/html',body:html}):r.abort());
   await page.goto('https://soul-reader.test/index.html');
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={eyes:1,brow:1,smile:1,aura:1,nose:1,jaw:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();sampleEpisode='work';goto('episode52')},lang);
   assert.equal(await page.locator('.sr853-report').count(),0,'Locked reading stays locked');
   for(const pack of ['single','bundle']){
    await page.evaluate(()=>goto('premium'));
    assert.doesNotMatch(await page.locator('.page').textContent(),/후속|엔딩|선택형|secret ending|branching|選択式|エンディング/i);
    assert.equal(await page.locator('.pack-price').count(),2);
    await page.locator(`[data-pickpack="${pack}"]`).click();
    assert.equal(await page.evaluate(()=>state.screen),'checkout52');
    assert.doesNotMatch(await page.locator('.page').textContent(),/후속|엔딩|branching|secret ending|選択式|エンディング/i);
    await page.locator('[data-demo-unlock]').click();
    assert.equal(await page.locator(retired).count(),0);
    const topics=pack==='single'?['work']:['love','chance','work','bond'];
    for(const topic of topics){
     await page.locator(`[data-ep="${topic}"]`).click();
     assert.equal(await page.locator('.sr853-part').count(),6);
     assert.equal(await page.locator('.sr853-overall').count(),1);
     assert.equal(await page.locator(retired).count(),0);
     assert.equal(await page.locator('.sr856-voice [data-sr60-clip]').count(),1,'Keep the topic introduction, without restoring follow-up story audio');
     assert.equal(await page.locator('[data-back855]').isEnabled(),true,'No decision or completion prerequisite');
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
     await page.locator('[data-back855]').click();
     assert.equal(await page.evaluate(()=>state.screen),'chapters52');
    }
    if(pack==='single'){
     for(const topic of ['love','chance','bond'])assert.equal(await page.locator(`[data-ep="${topic}"]`).isDisabled(),true);
     await page.evaluate(()=>{sampleEpisode='love';goto('episode52')});
     assert.equal(await page.locator('.sr853-report').count(),0,'Cannot enter an unowned topic directly');
    }
   }
   // Saved legacy paths cannot restore story UI or require completing old decisions.
   await page.evaluate(()=>{const book=JSON.parse(localStorage.getItem('sr75-stories'));const s=book[state.reading.id];s.choices={love:1,chance:0,work:1,bond:0};s.completed=['love','chance','work','bond'];s.endingChoice=1;localStorage.setItem('sr75-stories',JSON.stringify(book))});
   await page.reload();await page.evaluate(lang=>{state.lang=lang;goto('premium')},lang);
   await page.locator('[data-resume75]').click();
   assert.equal(await page.locator('[data-ep]:disabled').count(),0,'Owned bundle survives restart');
   assert.equal(await page.locator(retired).count(),0);
   await page.locator('[data-ep="work"]').click();
   assert.equal(await page.locator('.sr853-part').count(),6);
   await page.evaluate(()=>goto('finale54'));
   assert.equal(await page.evaluate(()=>state.screen),'chapters52');
   assert.equal(await page.locator(retired).count(),0);
   const saved=await page.evaluate(()=>localStorage.getItem('sr75-stories'));
   await page.evaluate(()=>{for(const key of ['data-sr65-episode-choice','data-final-route','data-ep-complete']){const b=document.createElement('button');b.setAttribute(key,'0');document.body.append(b);b.click();b.remove()}});
   assert.equal(await page.evaluate(()=>localStorage.getItem('sr75-stories')),saved,'Retired actions cannot mutate stored progress');
   assert.deepEqual(errors,[]);
   console.log(`PASS ${lang}: no paid fiction/ending or stale offers; six readings and summary; direct return; single/bundle gating, upgrade, reload and legacy-session compatibility`);
   await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
