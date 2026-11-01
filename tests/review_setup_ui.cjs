'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const {REVIEW_SETUP_PAGE,REVIEW_SETUP_CSP}=await import('../server/src/review_setup_page.mjs');
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:360,height:800}}),requests=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.copiedReviewCodes=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.copiedReviewCodes.push(value);}}});});
  await page.route('**/*',r=>{
   const url=new URL(r.request().url());
   if(url.pathname==='/setup/review-access')return r.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':REVIEW_SETUP_CSP},body:REVIEW_SETUP_PAGE});
   if(url.pathname==='/v1/review-access'){requests.push(r.request());return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({access:'review',sessionDurationSeconds:3600})});}
   return r.abort();
  });
  await page.goto('https://review-helper.test/setup/review-access');
  assert.equal(requests.length,0,'Loading helper never authenticates or sends a code');
  assert.equal(await page.locator('#code').getAttribute('type'),'password');
  assert.equal(await page.locator('#copy').isDisabled(),true);
  await page.locator('#generate').click();
  const testGeneratedCode=await page.locator('#code').inputValue();
  assert.match(testGeneratedCode,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests.length,0,'Generating local code never writes server configuration');
  await page.locator('#copy').click();
  assert.equal(await page.evaluate(()=>copiedReviewCodes.length),1);
  assert.equal(requests.length,0,'Copying does not authenticate');
  const waitingForDownload=page.waitForEvent('download');
  await page.locator('#save').click();
  const download=await waitingForDownload;
  assert.equal(download.suggestedFilename(),'SOUL_READER_REVIEW_ACCESS_PRIVATE.txt');
  assert.equal(requests.length,0,'Saving a private code file stays in the owner browser');
  await page.locator('#check').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('연결 확인 완료'));
  assert.equal(requests.length,1);
  assert.equal(requests[0].url(),'https://review-helper.test/v1/review-access');
  assert.deepEqual(requests[0].postDataJSON(),{username:'play-review',accessCode:testGeneratedCode});
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.evaluate(()=>dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('#code').inputValue(),'');
  assert.equal(await page.locator('#copy').isDisabled(),true);
  assert.equal(await page.locator('#check').isDisabled(),true);
  assert.equal(await page.locator('#save').isDisabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);
  console.log('Review setup helper: browser-only generation/copy, explicit same-origin verification, no storage, masked/cleared code, mobile layout PASS.');
 }finally{await browser.close();}
})().catch(()=>{console.error('Review setup helper UI test failed (private fixture values suppressed).');process.exitCode=1;});
