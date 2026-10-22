const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../assets/web'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const clips=['result','love_59','chance','work','bond'];
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 try{
  for(const lang of ['ko','en','ja']){
   const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{
    window.voiceCalls856=[];window.blockNext856=false;
    const nativePlay=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
     if(this.src.includes('/audio/')&&!this.src.endsWith('/bgm.mp3')){
      window.voiceMedia856=this;voiceCalls856.push(this.src);
      if(blockNext856){blockNext856=false;return Promise.reject(new DOMException('Test autoplay block','NotAllowedError'));}
     }
     return nativePlay.call(this);
    };
   });
   await page.route('**/*',r=>{
    const pathname=new URL(r.request().url()).pathname;
    if(pathname==='/index.html')return r.fulfill({contentType:'text/html',body:html});
    if(/^\/audio\/(ko|en|ja)\/(result|love_59|chance|work|bond)\.mp3$/.test(pathname))return r.fulfill({contentType:'audio/mpeg',body:fs.readFileSync(path.join(root,pathname.slice(1)))});
    return r.abort();
   });
   await page.goto('https://soul-reader.test/index.html');
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.face={eyes:1,brow:1,smile:1,aura:1,nose:1,jaw:1};state.sr67={status:'ready',source:'mlkit',face:{...state.face},metrics:{}};state.reading=buildReading();goto('result')},lang);
   async function assertPlayback(key){
    await page.waitForFunction(({lang,key})=>window.voiceMedia856?.src.endsWith(`/audio/${lang}/${key}.mp3`)&&!voiceMedia856.paused&&voiceMedia856.currentTime>0,{lang,key},{timeout:12000});
    assert.equal(await page.locator('.sr856-voice').count(),1);
    assert.equal(await page.locator('#sr60AudioStatus').count(),1);
    assert.equal(await page.locator('.sr856-voice').getAttribute('data-voice856'),key);
    assert.equal(await page.locator('.sr856-voice').getAttribute('lang'),lang);
    const line=await page.locator('.sr856-voice .ryu56-dialogue').textContent();
    assert.ok(line.length>20);
    assert.equal(/[가-힣]/u.test(line),lang==='ko');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const count=await page.evaluate(()=>voiceCalls856.length);
    await page.evaluate(()=>{render();render()});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>voiceCalls856.length),count,'Same-screen rerender must not restart or duplicate speech');
    assert.equal(await page.locator('.sr856-voice').count(),1);
   }
   await assertPlayback('result');
   // A new result on the same route must speak its introduction again.
   const beforeNew=await page.evaluate(()=>voiceCalls856.length);
   await page.evaluate(()=>{state.reading={...state.reading,id:state.reading.id+'-new'};render()});
   await page.waitForFunction(n=>voiceCalls856.length===n+1,beforeNew);
   await page.evaluate(()=>goto('premium'));
   assert.equal(await page.evaluate(()=>voiceMedia856.paused),true,'Stop speech on leaving the reading');
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   for(const topic of ['love','chance','work','bond']){
    await page.locator(`[data-ep="${topic}"]`).click();await assertPlayback(topic==='love'?'love_59':topic);
    assert.equal(await page.locator('.sr853-part').count(),6);
    assert.equal(await page.locator('.sr853-overall').count(),1);
    assert.equal(await page.locator('.g76-fiction,.sr65-episode-branch,[data-final-route]').count(),0);
    await page.locator('[data-back855]').click();
    assert.equal(await page.evaluate(()=>voiceMedia856.paused),true);
   }
   // Mute remains an explicit user preference across route changes.
   await page.locator('#voiceToggle').click();
   const mutedCount=await page.evaluate(()=>voiceCalls856.length);
   await page.evaluate(()=>goto('result'));await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>voiceCalls856.length),mutedCount);
   assert.equal(await page.locator('.sr856-voice').count(),1);
   await page.locator('#voiceToggle').click();await assertPlayback('result');
   await page.locator('[data-stop856]').click();
   assert.equal(await page.evaluate(()=>voiceMedia856.paused),true);
   const stopped=await page.evaluate(()=>voiceCalls856.length);
   await page.evaluate(()=>render());await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>voiceCalls856.length),stopped);
   await page.locator('[data-replay856]').click();await assertPlayback('result');
   await page.evaluate(()=>goto('chapters52'));
   await page.evaluate(()=>{blockNext856=true;goto('result')});
   await page.waitForFunction(()=>document.querySelector('#sr60AudioStatus')?.dataset.type==='error');
   assert.ok((await page.locator('#sr60AudioStatus').textContent()).length>10);
   assert.equal(await page.locator('#sr60AudioStatus button').count(),0,'Bundled audio errors must not ask for file imports');
   await page.locator('[data-replay856]').click();await assertPlayback('result');
   // Changing language on the same screen must select a new recording.
   const other=lang==='en'?'ja':'en';
   await page.evaluate(other=>{state.lang=other;render()},other);
   await page.waitForFunction(other=>voiceMedia856.src.endsWith(`/audio/${other}/result.mp3`)&&!voiceMedia856.paused,other);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${lang}: actual MP3 playback for free + four topics, one panel, no rerender restart, stop/replay, mute, navigation cleanup, autoplay-block recovery and locale switching`);
   await page.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
