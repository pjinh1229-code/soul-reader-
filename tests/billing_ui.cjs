const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const html=fs.readFileSync(path.resolve(__dirname,'../assets/web/index.html'),'utf8');
const billing=fs.readFileSync(path.resolve(__dirname,'../assets/web/billing.js'),'utf8');
const catalog={status:'ready',configured:true,storeAvailable:true,busy:false,products:[{offerKey:'single',productId:'test.single',price:'₩990',currencyCode:'KRW',rawPrice:990},{offerKey:'bundle',productId:'test.bundle',price:'₩1,990',currencyCode:'KRW',rawPrice:1990}]};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  async function open({lang='ko',native=true,configured=true,loadModule=true}={}){
   const page=await browser.newPage({viewport:{width:360,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>{const p=new URL(r.request().url()).pathname;if(p==='/index.html')return r.fulfill({contentType:'text/html',body:html});if(p==='/billing.js'&&loadModule)return r.fulfill({contentType:'application/javascript',body:billing});return r.abort()});
   await page.addInitScript(({native,configured,catalog})=>{window.billingMessages=[];window.billingCatalog=configured?catalog:{status:'unconfigured',configured:false,storeAvailable:true,busy:false,products:[]};if(native)window.StoreBilling={postMessage(raw){const m=JSON.parse(raw);billingMessages.push(m);if(m.action==='status')queueMicrotask(()=>window.soulBillingReceive?.({type:'state',...billingCatalog}));}};},{native,configured,catalog});
   await page.goto('https://soul-reader.test/index.html');
   if(loadModule)await page.waitForFunction(()=>!!window.SoulBilling);
   await page.evaluate(lang=>{state.lang=lang;state.theme='love';state.sr67=null;state.reading=buildReading();state.reading.id='reading-one';goto('premium')},lang);
   return {page,errors};
  }
  async function state(page,data={}){await page.evaluate(v=>soulBillingReceive({type:'state',...v}),{...catalog,...data});}
  async function buy(page,offer='single'){
   await page.locator(`[data-pickpack="${offer}"]`).click();await page.locator(`[data-billing-buy="${offer}"]`).click();
   return page.evaluate(()=>billingMessages.filter(m=>m.action==='buy').at(-1));
  }
  function grant(request,extra={}){return{entitlementId:'entitlement-one',transactionId:'transaction-one',productId:'test.'+request.offerKey,offerKey:request.offerKey,readingId:request.readingId,requestId:request.requestId,topic:null,...extra};}
  for(const lang of ['ko','en','ja']){
   const {page,errors}=await open({lang,configured:false});
   assert.equal(await page.locator('[data-demo-unlock]').count(),0,'Real checkout has no demo unlock');
   await page.locator('[data-pickpack="single"]').click();
   assert.equal(await page.locator('[data-billing-buy]').isDisabled(),true,'Unregistered products cannot be charged');
   assert.equal(await page.locator('[data-billing-restore]').isDisabled(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open();
   assert.deepEqual(await page.locator('.pack-price').allTextContents(),['₩990','₩1,990'],'Prices come from native catalog');
   const request=await buy(page);
   assert.equal(request.readingId,'reading-one');assert.equal(request.offerKey,'single');
   assert.equal(await page.locator('[data-billing-buy]').isDisabled(),true,'Duplicate purchase taps are disabled immediately');
   await page.evaluate(()=>{const b=document.createElement('button');b.dataset.demoUnlock='1';document.body.append(b);b.click();b.remove()});
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sr75-stories')||'{}')['reading-one']?.unlocked===true),false,'Legacy demo action cannot grant access');
   await state(page,{status:'pending',busy:true,errorCode:'purchase_pending'});
   assert.equal(await page.locator('[data-billing-buy]').isDisabled(),true);
   assert.equal(await page.evaluate(()=>billingMessages.filter(m=>m.action==='buy').length),1);
   await page.evaluate(()=>goto('chapters52'));
   assert.equal(await page.locator('[data-ep]').count(),0,'Pending payment cannot open paid topics');
   await page.evaluate(()=>soulBillingReceive({type:'error',code:'purchase_cancelled'}));await state(page);
   assert.equal(await page.locator('[data-pickpack]').count(),2,'Cancellation leaves the pass locked');
   const retry=await buy(page);
   await page.evaluate(e=>soulBillingReceive({type:'grant',entitlement:e}),grant(retry));
   assert.equal(await page.evaluate(()=>state.screen),'chapters52');
   assert.equal(await page.locator('[data-ep]:enabled').count(),4,'A verified single pass asks the user to commit one topic');
   await page.locator('[data-ep="work"]').click();
   const selection=await page.evaluate(()=>billingMessages.filter(m=>m.action==='selectTopic').at(-1));
   assert.equal(selection.entitlementId,'entitlement-one');assert.equal(selection.topic,'work');
   assert.equal(await page.evaluate(()=>state.screen),'chapters52','Selecting does not unlock until server confirmation');
   assert.equal(await page.locator('[data-ep]:enabled').count(),0,'Topic commitment cannot be raced');
   await page.evaluate(e=>soulBillingReceive({type:'grant',entitlement:e}),grant(retry,{topic:'work',requestId:selection.requestId}));
   assert.equal(await page.evaluate(()=>state.screen),'episode52');
   await page.evaluate(()=>goto('chapters52'));
   assert.equal(await page.locator('[data-ep="work"]').isEnabled(),true);
   assert.equal(await page.locator('[data-ep]:disabled').count(),3,'Other topics remain locked');
   await page.evaluate(()=>{state.reading={...state.reading,id:'reading-two'};goto('chapters52')});
   assert.equal(await page.locator('[data-ep]').count(),0,'A pass cannot be carried to a new photo reading');
   assert.equal(await page.locator('[data-resume75="reading-one"]').count(),1,'A previously purchased reading stays accessible from purchase history');
   await page.locator('[data-resume75="reading-one"]').click();
   assert.equal(await page.evaluate(()=>state.reading.id),'reading-one');
   assert.equal(await page.locator('[data-ep]:disabled').count(),3);
   await page.evaluate(()=>{state.reading={...state.reading,id:'reading-one'};goto('premium')});
   await state(page);const bundle=await buy(page,'bundle');
   await page.evaluate(e=>soulBillingReceive({type:'grant',entitlement:e}),grant(bundle,{entitlementId:'bundle-one',transactionId:'transaction-two'}));
   assert.equal(await page.locator('[data-ep]:enabled').count(),4,'Verified bundle opens all topics');
   await page.evaluate(()=>soulBillingReceive({type:'entitlements',entitlements:[]}));
   assert.equal(await page.locator('[data-ep]').count(),0,'Server revocation removes access despite saved local book');
   await state(page);
   await page.locator('[data-billing-restore]').click();
   assert.equal(await page.evaluate(()=>billingMessages.at(-1).action),'restore');
   await page.evaluate(e=>soulBillingReceive({type:'entitlements',entitlements:[e]}),grant(bundle,{entitlementId:'bundle-one',transactionId:'transaction-two'}));
   await state(page);await page.evaluate(()=>goto('chapters52'));
   assert.equal(await page.locator('[data-ep]:enabled').count(),4,'Server ledger restores a consumed pass for the matching saved reading');
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open();
   await page.evaluate(()=>{const r={...state.reading};localStorage.setItem('sr75-stories',JSON.stringify({[r.id]:{id:r.id,pack:'bundle',topic:null,unlocked:true,choices:{},completed:[],reading:r}}))});
   await page.reload();await page.waitForFunction(()=>!!window.SoulBilling);
   await page.evaluate(()=>{state.theme='love';state.reading=buildReading();state.reading.id='reading-one';goto('chapters52')});
   assert.equal(await page.locator('[data-ep]').count(),0,'A legacy/localStorage entitlement is never proof of payment');
   const rejected=await buy(page);
   await page.evaluate(id=>soulBillingReceive({type:'error',code:'verification_rejected',requestId:id}),rejected.requestId);
   await page.evaluate(()=>goto('chapters52'));
   assert.equal(await page.locator('[data-ep]').count(),0,'Receipt verification failure cannot grant a pass');
   await state(page);await buy(page);
   await state(page,{status:'canceled',busy:false,errorCode:null});
   assert.equal(await page.locator('[data-billing-buy]').isEnabled(),true,'Native cancelled status releases the purchase button for retry');
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open();
   await page.evaluate(()=>{const original=StoreBilling.postMessage;StoreBilling.postMessage=raw=>{if(JSON.parse(raw).action==='restore')throw new Error('bridge disconnected');original(raw)}});
   await page.locator('[data-billing-restore]').click();
   assert.equal(await page.locator('[data-billing-refresh]').isEnabled(),true,'A bridge failure while restoring cannot leave checkout permanently busy');
   assert.equal(await page.locator('[data-billing-restore]').isEnabled(),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open();
   await page.evaluate(()=>{state.reading.photoData='data:image/png;base64,not-a-real-photo';state.reading.photoUrl='file:///private/photo.png';});
   const request=await buy(page,'bundle');
   const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('sr75-stories'))['reading-one']);
   assert.equal(saved.unlocked,false,'Saving a checkout snapshot never grants access');
   assert.equal(saved.billingPending.requestId,request.requestId);
   assert.equal(saved.reading.id,request.readingId);
   assert.equal(saved.reading.photoData,undefined,'Checkout persistence excludes photo bytes');
   assert.equal(saved.reading.photoUrl,undefined,'Checkout persistence excludes local photo URLs');
   // The process can die while Google Play is open, before any grant is delivered.
   await page.reload();await page.waitForFunction(()=>!!window.SoulBilling);
   await page.evaluate(()=>goto('premium'));
   assert.equal(await page.locator('[data-resume75="reading-one"]').count(),0,'A pending persisted snapshot stays locked after restart');
   await page.evaluate(e=>soulBillingReceive({type:'grant',entitlement:e}),grant(request));
   assert.equal(await page.locator('[data-resume75="reading-one"]').count(),1,'A later verified grant finds the durable checkout snapshot');
   await page.locator('[data-resume75="reading-one"]').click();
   assert.equal(await page.evaluate(()=>state.reading.id),'reading-one','Recovered purchase reopens its original reading ID');
   assert.equal(await page.locator('[data-ep]:enabled').count(),4);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open();
   await page.locator('[data-pickpack="single"]').click();
   await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='sr75-stories')throw new DOMException('Storage is full','QuotaExceededError');return original.call(this,key,value)}});
   await page.locator('[data-billing-buy="single"]').click();
   assert.equal(await page.evaluate(()=>billingMessages.filter(m=>m.action==='buy').length),0,'Storage failure must stop before charging Google Play');
   assert.equal(await page.locator('[data-billing-buy]').isEnabled(),true,'Storage failure does not leave purchase pending');
   assert.match(await page.locator('.billing-status').textContent(),/저장하지 못해 결제를 시작하지/);
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open({native:false});
   await page.locator('[data-pickpack="bundle"]').click();
   assert.equal(await page.locator('[data-billing-buy]').isDisabled(),true,'Browser cannot pretend to charge Google Play');
   assert.deepEqual(errors,[]);await page.close();
  }
  {
   const {page,errors}=await open({loadModule:false});
   await page.locator('[data-pickpack="bundle"]').click();await page.locator('[data-demo-unlock]').click();
   assert.equal(await page.evaluate(()=>state.screen),'checkout52','Missing UI asset fails closed with native channel present');
   assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('sr75-stories')||'{}')['reading-one']?.unlocked===true),false);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: store prices, unconfigured/unsupported devices, pending/cancel/retry, verified-only per-photo grants, atomic topic lock, bundle upgrade, ledger restore/revocation, durable precharge snapshots/process-restart recovery, storage failure, legacy-action and asset-failure protection');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
