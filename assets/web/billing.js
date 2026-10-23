/* Store checkout UI. The native layer verifies purchases and owns all grants. */
(() => {
  'use strict';
  const app = window.SoulBillingApp;
  if (!app) return;
  app.enable();
  const words = {
    ko: {title:'이용권 구매',storageError:'풀이 기록을 저장하지 못해 결제를 시작하지 않았어. 저장 공간을 확인해 줘.',history:'구매한 풀이 기록',saved:'저장한 풀이',single:'한 주제 풀이',bundle:'네 주제 전체 풀이',scope:'이 이용권은 이번 사진 한 장의 풀이에만 적용돼.',singleHelp:'구매 후 한 주제를 고르면 다른 주제로 바꿀 수 없어.',bundleHelp:'사랑·기회·일·인연 네 주제를 모두 볼 수 있어.',buy:'구매하기',restore:'구매 내역 복원',refresh:'다시 확인',back:'이용권 목록으로',loading:'스토어 가격을 확인하고 있어.',unconfigured:'결제 준비 중이야. 현재 구매할 수 없어.',unavailable:'이 기기에서는 스토어 결제를 사용할 수 없어.',pending:'결제 확인을 기다리고 있어. 확인이 끝날 때까지 다시 구매하지 않아도 돼.',working:'구매 내역을 확인하고 있어.',ready:'최종 금액은 Google Play 결제창에서 확인해 줘.',need:'사진의 무료 풀이를 먼저 완성해 줘.',start:'사진 풀이 시작',unknown:'가격 확인 중',owned:'이미 이용 중인 이용권',resume:'구매한 풀이 보기',cancelled:'결제를 취소했어. 이용권은 추가되지 않았어.',failed:'구매를 확인하지 못했어. 다시 확인하거나 잠시 후 시도해 줘.',restored:'이 기기에 저장된 풀이의 구매 내역을 확인했어.',selecting:'선택한 주제를 확정하고 있어.',selectedError:'주제를 확정하지 못했어. 다시 시도해 줘.',complete:'구매가 확인됐어.',noReceipt:'구매한 이용권이 아직 확인되지 않았어.',restoreHelp:'소비형 이용권은 구매 서버에 보관된 내역으로 복원해. 사진과 풀이 기록은 삭제하지 않고 보관해 줘.'},
    en: {title:'Buy a reading pass',storageError:'Your reading could not be saved, so payment was not started. Check available device storage.',history:'Purchased readings',saved:'Saved reading',single:'One topic reading',bundle:'All four topics',scope:'This pass applies only to the reading for this one photo.',singleHelp:'Choose one topic after purchase. That choice cannot be changed.',bundleHelp:'Includes love, opportunity, work, and connections.',buy:'Buy pass',restore:'Restore purchases',refresh:'Check again',back:'Back to passes',loading:'Checking store prices.',unconfigured:'Purchases are being prepared and are currently unavailable.',unavailable:'Store purchases are unavailable on this device.',pending:'Payment is pending. You do not need to buy again while it is being confirmed.',working:'Checking your purchase.',ready:'Review the final price in the Google Play purchase sheet.',need:'Complete the free reading for a photo first.',start:'Start a photo reading',unknown:'Checking price',owned:'You already own this pass',resume:'Open purchased reading',cancelled:'Purchase cancelled. No pass was added.',failed:'Your purchase could not be verified. Check again or try later.',restored:'Purchase records for readings stored on this device have been checked.',selecting:'Confirming your chosen topic.',selectedError:'Your topic could not be confirmed. Try again.',complete:'Purchase verified.',noReceipt:'No purchased pass has been verified yet.',restoreHelp:'Consumed passes are restored from the purchase server. Keep the photo reading records on your device.'},
    ja: {title:'利用パスの購入',storageError:'読みの記録を保存できなかったため、決済を開始していないよ。端末の空き容量を確認してね。',history:'購入した読みの記録',saved:'保存した読み',single:'一つのテーマ',bundle:'四つのテーマ全部',scope:'このパスは今回の写真一枚の読みにだけ適用されるよ。',singleHelp:'購入後に一テーマを選ぶと変更できないよ。',bundleHelp:'恋愛・チャンス・仕事・ご縁の四テーマを読めるよ。',buy:'購入する',restore:'購入履歴を復元',refresh:'もう一度確認',back:'パス一覧へ',loading:'ストアの価格を確認しているよ。',unconfigured:'購入の準備中だよ。現在は購入できないよ。',unavailable:'この端末ではストア購入を利用できないよ。',pending:'決済の確認待ちだよ。確認が終わるまで再購入しなくて大丈夫。',working:'購入履歴を確認しているよ。',ready:'最終金額はGoogle Playの決済画面で確認してね。',need:'まず写真の無料の読みを完成させてね。',start:'写真の読みを始める',unknown:'価格を確認中',owned:'このパスは購入済みだよ',resume:'購入した読みを開く',cancelled:'購入を取り消したよ。パスは追加されていないよ。',failed:'購入を確認できなかったよ。再確認するか、後で試してね。',restored:'この端末に保存された読みの購入履歴を確認したよ。',selecting:'選んだテーマを確定しているよ。',selectedError:'テーマを確定できなかったよ。もう一度試してね。',complete:'購入を確認したよ。',noReceipt:'購入したパスはまだ確認できていないよ。',restoreHelp:'消費済みのパスは購入サーバーの履歴から復元するよ。端末の写真と読みの記録を保管してね。'}
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let state = {status:window.StoreBilling?'loading':'unavailable',configured:false,storeAvailable:false,products:[],busy:false,errorCode:null};
  let sequence = 0, currentRequest = null, pendingTopic = null, message = '';
  const context = () => app.context();
  const text = () => words[context().lang] || words.ko;
  const requestId = () => `billing-${Date.now()}-${++sequence}`;
  const product = key => state.products.find(item => item.offerKey === key);
  const busy = () => state.busy || currentRequest !== null || pendingTopic !== null;
  const ready = () => ['ready','canceled'].includes(state.status) && state.configured && state.storeAvailable && !!window.StoreBilling;
  const owned = key => {const pass=context().entitlement;return !!pass && (pass.offerKey==='bundle'||pass.offerKey===key);};
  function send(action, extra={}) {
    if (!window.StoreBilling?.postMessage) return false;
    try {window.StoreBilling.postMessage(JSON.stringify({action,requestId:requestId(),...extra}));return true;} catch {return false;}
  }
  function statusText() {
    const t=text();
    if (pendingTopic) return t.selecting;
    if (state.status === 'pending' || state.errorCode === 'purchase_pending') return t.pending;
    if (message) return message;
    if (busy()) return t.working;
    if (state.status === 'unconfigured') return t.unconfigured;
    if (state.status === 'unavailable') return t.unavailable;
    if (state.status === 'error') return t.failed;
    return ready()?t.ready:t.loading;
  }
  function common() {
    const t=text();
    return `<p class="billing-status" role="status" aria-live="polite">${esc(statusText())}</p><div class="billing-actions"><button class="btn-line" data-billing-refresh ${busy()?'disabled':''}>${esc(t.refresh)}</button><button class="btn-line" data-billing-restore ${!state.configured||state.canRestore===false||!window.StoreBilling||busy()?'disabled':''}>${esc(t.restore)}</button></div><p class="billing-note">${esc(t.restoreHelp)}</p>`;
  }
  function passCard(key, checkout=false) {
    const t=text(),p=product(key),canBuy=ready()&&p&&p.available!==false&&p.canBuy!==false&&context().readingId&&!busy()&&!owned(key);
    return `<section class="pack-tile ${key==='bundle'?'featured':''}" data-billing-offer="${key}"><div class="pack-head"><h2>${esc(t[key])}</h2><strong class="pack-price">${esc(p?.price||t.unknown)}</strong></div><p>${esc(key==='single'?t.singleHelp:t.bundleHelp)}</p><p class="billing-scope">${esc(t.scope)}</p>${owned(key)?`<p class="billing-owned">${esc(t.owned)}</p><button class="btn-line" data-route="chapters52">${esc(t.resume)}</button>`:checkout?`<button class="btn-primary" data-billing-buy="${key}" ${canBuy?'':'disabled'}>${esc(t.buy)}${p?' · '+esc(p.price):''}</button>`:`<button class="${key==='bundle'?'btn-primary':'btn-line'}" data-pickpack="${key}" ${busy()?'disabled':''}>${esc(t.buy)} →</button>`}</section>`;
  }
  function history(ctx) {
    const t=text(),saved=(ctx.ownedReadings||[]).filter(item=>item.readingId!==ctx.readingId);
    if(!saved.length)return '';
    return `<section class="billing-history"><h2>${esc(t.history)}</h2>${saved.map(item=>{const date=item.date?new Date(item.date):null,label=date&&!Number.isNaN(date.getTime())?date.toLocaleString(ctx.lang):t.saved;return `<button class="btn-line" data-resume75="${esc(item.readingId)}">${esc(label)} · ${esc(t[item.offerKey])}</button>`}).join('')}</section>`;
  }
  app.installViews({
    premium(ctx) {
      const t=text();
      return app.shell(`<h1 class="main-heading">${esc(t.title)}</h1>${ctx.readingId?['single','bundle'].map(k=>passCard(k)).join(''):`<p>${esc(t.need)}</p><button class="btn-primary" data-route="themes">${esc(t.start)}</button>`}${history(ctx)}${common()}`,'result');
    },
    checkout(ctx) {
      const t=text();
      return app.shell(`<div class="eyebrow">GOOGLE PLAY</div><h1 class="main-heading">${esc(t.title)}</h1>${ctx.readingId?passCard(ctx.offerKey==='single'?'single':'bundle',true):`<p>${esc(t.need)}</p>`}${common()}<button class="btn-line" data-route="premium">${esc(t.back)}</button>`);
    }
  });
  function purchase(key) {
    if (!ready() || !product(key) || product(key).available===false || product(key).canBuy===false || busy() || owned(key) || !context().readingId) return;
    const id=requestId(),readingId=context().readingId;
    if(!app.persistPurchaseReading({requestId:id,offerKey:key})){message=text().storageError;app.refresh();return;}
    currentRequest={id,readingId,offerKey:key};message='';
    if (!send('buy',{requestId:id,readingId,offerKey:key})) {currentRequest=null;state.status='unavailable';}
    app.refresh();
  }
  function selectTopic(topic) {
    const c=context(),pass=c.entitlement;
    if (busy() || !pass || pass.offerKey!=='single' || pass.topic!==null || !['love','chance','work','bond'].includes(topic)) return;
    const id=requestId();pendingTopic={id,readingId:c.readingId,entitlementId:pass.entitlementId,topic};message='';
    if (!send('selectTopic',{requestId:id,readingId:c.readingId,entitlementId:pass.entitlementId,topic})) {pendingTopic=null;message=text().selectedError;}
    app.refresh();
  }
  function receive(payload) {
    if (!payload || typeof payload!=='object') return;
    if (payload.type==='state') {
      state={...state,...payload,products:Array.isArray(payload.products)?payload.products:state.products};
      if (payload.busy===false && ['ready','canceled','error','recovery_required'].includes(payload.status)) currentRequest=null;
      if (payload.status==='canceled') {pendingTopic=null;message=text().cancelled;}
      if (payload.errorCode) {
        if(!/pending/i.test(payload.errorCode))currentRequest=null;
        message=/cancel/i.test(payload.errorCode)?text().cancelled:/pending/i.test(payload.errorCode)?'':text().failed;
      }
    } else if (payload.type==='entitlements') {
      app.setEntitlements(payload.entitlements,true);
      if (pendingTopic) {
        const p=pendingTopic,pass=context().entitlement;
        if (pass?.entitlementId===p.entitlementId && pass.topic===p.topic) {pendingTopic=null;if(context().readingId===p.readingId){app.openTopic(p.topic);return;}}
      }
      currentRequest=null;message=text().restored;
    } else if (payload.type==='grant' && payload.entitlement) {
      const pass=payload.entitlement,pending=currentRequest,selected=pendingTopic;
      app.setEntitlements([pass]);
      if (selected && pass.entitlementId===selected.entitlementId && pass.topic===selected.topic) {
        pendingTopic=null;if(context().readingId===selected.readingId){app.openTopic(selected.topic);return;}
      }
      if (pending && pass.requestId===pending.id && pass.readingId===pending.readingId) {
        currentRequest=null;message=text().complete;
        if(context().readingId===pending.readingId){app.route('chapters52');return;}
      }
    } else if (payload.type==='error') {
      if(/pending/i.test(payload.code||'')){state.status='pending';state.busy=true;message='';app.refresh();return;}
      if (payload.requestId && currentRequest && payload.requestId!==currentRequest.id && payload.requestId!==pendingTopic?.id) return;
      currentRequest=null;pendingTopic=null;state.busy=false;
      message=/cancel/i.test(payload.code||'')?text().cancelled:text().failed;
    }
    app.refresh();
  }
  window.soulBillingReceive=receive;
  window.SoulBilling=Object.freeze({selectTopic,isBusy:busy});
  window.addEventListener('click',event=>{
    const b=event.target.closest?.('[data-billing-buy],[data-billing-refresh],[data-billing-restore]');if(!b)return;
    event.preventDefault();event.stopImmediatePropagation();if(b.disabled)return;
    if(b.dataset.billingBuy){purchase(b.dataset.billingBuy);return;}
    if(b.hasAttribute('data-billing-restore')){if(!state.configured||busy())return;currentRequest={id:requestId(),readingId:context().readingId,restore:true};message='';if(!send('restore',{requestId:currentRequest.id})){currentRequest=null;state.busy=false;state.status='unavailable';message=text().failed;}app.refresh();return;}
    if(b.hasAttribute('data-billing-refresh')){message='';if(!send('status')){state.status='unavailable';message=text().failed;}app.refresh();}
  },true);
  const style=document.createElement('style');style.textContent='.billing-status{padding:15px;border:1px solid #d4b3d34d;border-radius:13px;color:#f6ddc9;font-size:14px;line-height:1.8}.billing-note,.billing-scope{font-size:12px;line-height:1.8;color:#cdb7cf}.billing-actions{display:flex;gap:9px;flex-wrap:wrap}.billing-actions button{flex:1;min-width:120px}.billing-page .pack-head{flex-wrap:wrap;gap:8px}.billing-page .pack-price{white-space:normal;overflow-wrap:anywhere}.billing-page button:disabled{opacity:.45}.billing-owned{color:#f1d4ad}';document.head.appendChild(style);
  app.refresh();
  if(!send('status')){state.status='unavailable';app.refresh();}
})();
