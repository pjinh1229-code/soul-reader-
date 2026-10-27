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
  const authWords = {
    ko:{signIn:'Google로 로그인',signOut:'로그아웃',signInHelp:'구매 내역을 보관할 앱 계정으로 로그인해 줘.',signedIn:'로그인한 앱 계정',authWorking:'앱 계정을 연결하고 있어.',signInCancelled:'로그인을 취소했어. 다시 시도할 수 있어.',signInFailed:'로그인을 완료하지 못했어. 잠시 후 다시 시도해 줘.',signOutFailed:'앱 계정 연결을 해제했어. 다음 로그인에서 계정을 확인해 줘.',configurationRequired:'Google 로그인 설정을 준비하고 있어.',accountRequired:'이 구매에 사용한 앱 계정으로 로그인한 뒤 다시 확인해 줘.',signedOut:'로그아웃했어. 구매 내역은 해당 앱 계정에 보관돼.'},
    en:{signIn:'Sign in with Google',signOut:'Sign out',signInHelp:'Sign in to the app account that will keep your purchase records.',signedIn:'Signed-in app account',authWorking:'Connecting your app account.',signInCancelled:'Sign-in cancelled. You can try again.',signInFailed:'Sign-in could not be completed. Try again later.',signOutFailed:'The app account has been disconnected. Check your account when signing in again.',configurationRequired:'Google sign-in is being configured.',accountRequired:'Sign in to the app account used for this purchase, then check again.',signedOut:'Signed out. Purchase records remain with that app account.'},
    ja:{signIn:'Googleでログイン',signOut:'ログアウト',signInHelp:'購入履歴を保存するアプリのアカウントでログインしてね。',signedIn:'ログイン中のアプリアカウント',authWorking:'アプリのアカウントを接続しているよ。',signInCancelled:'ログインを取り消したよ。もう一度試せるよ。',signInFailed:'ログインできなかったよ。しばらくしてから試してね。',signOutFailed:'アプリのアカウントの接続を解除したよ。次のログインでアカウントを確認してね。',configurationRequired:'Googleログインを準備しているよ。',accountRequired:'この購入に使ったアプリのアカウントでログインしてから、もう一度確認してね。',signedOut:'ログアウトしたよ。購入履歴はそのアプリのアカウントに保存されているよ。'}
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let state = {status:window.StoreBilling?'loading':'unavailable',configured:false,storeAvailable:false,products:[],busy:false,errorCode:null};
  let sequence = 0, currentRequest = null, pendingTopic = null, message = '';
  let auth = null, authRequest = null;
  const context = () => app.context();
  const text = () => ({...(words[context().lang] || words.ko),...(authWords[context().lang] || authWords.ko)});
  const requestId = () => `billing-${Date.now()}-${++sequence}`;
  const product = key => state.products.find(item => item.offerKey === key);
  const busy = () => state.busy || auth?.busy || authRequest !== null || currentRequest !== null || pendingTopic !== null;
  const signedIn = () => auth === null || auth.signedIn;
  const unsettled = () => state.busy || currentRequest !== null || pendingTopic !== null || ['purchasing','pending','verifying','restoring'].includes(state.status);
  const ready = () => signedIn() && ['ready','canceled'].includes(state.status) && state.configured && state.storeAvailable && !!window.StoreBilling;
  const owned = key => {const pass=context().entitlement;return !!pass && (pass.offerKey==='bundle'||pass.offerKey===key);};
  function send(action, extra={}) {
    if (!window.StoreBilling?.postMessage) return false;
    try {window.StoreBilling.postMessage(JSON.stringify({action,requestId:requestId(),...(auth?{epoch:auth.epoch}:{}),...extra}));return true;} catch {return false;}
  }
  function statusText() {
    const t=text();
    if (auth?.busy || authRequest) return t.authWorking;
    if (pendingTopic) return t.selecting;
    if (state.status === 'pending' || state.errorCode === 'purchase_pending') return t.pending;
    if (message) return message;
    if (busy()) return t.working;
    if (auth?.available && !auth.signedIn) return t.signInHelp;
    if (state.status === 'unconfigured') return t.unconfigured;
    if (state.status === 'unavailable') return t.unavailable;
    if (state.status === 'error') return t.failed;
    return ready()?t.ready:t.loading;
  }
  function authControls() {
    if (!auth?.available) return '';
    const t=text();
    if (!auth.signedIn) return `<section class="billing-account"><p class="billing-note">${esc(t.signInHelp)}</p><button class="btn-line" data-billing-sign-in ${auth.busy||authRequest?'disabled':''}>${esc(t.signIn)}</button></section>`;
    return `<section class="billing-account"><p class="billing-note">${esc(t.signedIn)}${auth.label?' · '+esc(auth.label):''}</p><button class="btn-line" data-billing-sign-out ${auth.busy||authRequest||unsettled()?'disabled':''}>${esc(t.signOut)}</button></section>`;
  }
  function common() {
    const t=text();
    return `${authControls()}<p class="billing-status" role="status" aria-live="polite">${esc(statusText())}</p><div class="billing-actions"><button class="btn-line" data-billing-refresh ${busy()?'disabled':''}>${esc(t.refresh)}</button><button class="btn-line" data-billing-restore ${!signedIn()||!state.configured||state.canRestore===false||!window.StoreBilling||busy()?'disabled':''}>${esc(t.restore)}</button></div><p class="billing-note">${esc(t.restoreHelp)}</p>`;
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
    if (!signedIn() || busy() || !pass || pass.offerKey!=='single' || pass.topic!==null || !['love','chance','work','bond'].includes(topic)) return;
    const id=requestId();pendingTopic={id,readingId:c.readingId,entitlementId:pass.entitlementId,topic};message='';
    if (!send('selectTopic',{requestId:id,readingId:c.readingId,entitlementId:pass.entitlementId,topic})) {pendingTopic=null;message=text().selectedError;}
    app.refresh();
  }
  function resetAccount(epoch) {
    currentRequest=null;pendingTopic=null;authRequest=null;message='';
    state={status:'unconfigured',configured:false,storeAvailable:false,products:[],busy:false,errorCode:null};
    app.setEntitlements([],true);
    if (auth) auth={...auth,epoch,signedIn:false,label:'',busy:false};
    if (['chapters52','episode52','finale54'].includes(context().screen)) app.route('premium');
  }
  function authError(code) {
    const t=text();
    if (['sign_in_cancelled','sign_in_canceled','authentication_cancelled'].includes(code)) return t.signInCancelled;
    if (['configuration_required','google_configuration_required','google_sign_in_not_configured'].includes(code)) return t.configurationRequired;
    if (['authentication_required','authentication_invalid','owned_purchase_needs_account','purchase_context_mismatch'].includes(code)) return t.accountRequired;
    if (code==='sign_out_failed') return t.signOutFailed;
    return t.signInFailed;
  }
  function receive(payload) {
    if (!payload || typeof payload!=='object') return;
    if (payload.type==='auth' || payload.type==='accountReset') {
      if (!Number.isSafeInteger(payload.epoch) || payload.epoch<0 || (auth && payload.epoch<auth.epoch)) return;
      if (payload.type==='accountReset') {
        if (!auth || payload.epoch>auth.epoch) resetAccount(payload.epoch);
        // Auth is negotiated even when the first native event is a reset.
        if (!auth) auth={epoch:payload.epoch,available:false,signedIn:false,label:'',busy:false};
      } else {
        if (typeof payload.available!=='boolean'||typeof payload.signedIn!=='boolean'||typeof payload.busy!=='boolean') return;
        if (!auth || payload.epoch>auth.epoch || (auth.signedIn && !payload.signedIn)) resetAccount(payload.epoch);
        auth={epoch:payload.epoch,available:payload.available,signedIn:payload.available&&payload.signedIn,label:typeof payload.label==='string'?payload.label.slice(0,160):'',busy:payload.busy};
        if (!auth.busy) authRequest=null;
      }
      app.refresh();return;
    }
    if (auth && payload.epoch!==auth.epoch) return;
    if (auth && !auth.signedIn && ['grant','entitlements'].includes(payload.type)) return;
    if (payload.type==='error' && (authRequest || ['sign_in_cancelled','sign_in_canceled','authentication_cancelled','sign_in_failed','authentication_failed','authentication_unavailable','authentication_busy','authentication_session_changed','sign_out_failed','google_configuration_required'].includes(payload.code))) {
      if (payload.requestId && authRequest && payload.requestId!==authRequest.id) return;
      authRequest=null;if(auth)auth={...auth,busy:false};message=authError(payload.code);app.refresh();return;
    }
    if (payload.type==='state') {
      state={...state,...payload,products:Array.isArray(payload.products)?payload.products:state.products};
      if (payload.busy===false && ['ready','canceled','error','recovery_required'].includes(payload.status)) currentRequest=null;
      if (payload.status==='canceled') {pendingTopic=null;message=text().cancelled;}
      if (payload.errorCode) {
        if(!/pending/i.test(payload.errorCode))currentRequest=null;
        message=['owned_purchase_needs_account','purchase_context_mismatch','authentication_required'].includes(payload.errorCode)?text().accountRequired:/cancel/i.test(payload.errorCode)?text().cancelled:/pending/i.test(payload.errorCode)?'':text().failed;
      }
    } else if (payload.type==='entitlements') {
      const explicitRestore=currentRequest?.restore===true;
      app.setEntitlements(payload.entitlements,true);
      if (pendingTopic) {
        const p=pendingTopic,pass=context().entitlement;
        if (pass?.entitlementId===p.entitlementId && pass.topic===p.topic) {pendingTopic=null;if(context().readingId===p.readingId){app.openTopic(p.topic);return;}}
      }
      if(explicitRestore){currentRequest=null;message=text().restored;}
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
      message=['owned_purchase_needs_account','purchase_context_mismatch','authentication_required'].includes(payload.code)?text().accountRequired:/cancel/i.test(payload.code||'')?text().cancelled:text().failed;
    }
    app.refresh();
  }
  window.soulBillingReceive=receive;
  window.SoulBilling=Object.freeze({selectTopic,isBusy:busy});
  window.addEventListener('click',event=>{
    const b=event.target.closest?.('[data-billing-buy],[data-billing-refresh],[data-billing-restore],[data-billing-sign-in],[data-billing-sign-out]');if(!b)return;
    event.preventDefault();event.stopImmediatePropagation();if(b.disabled)return;
    if(b.hasAttribute('data-billing-sign-in')||b.hasAttribute('data-billing-sign-out')) {
      const signingIn=b.hasAttribute('data-billing-sign-in');
      if(!auth?.available||auth.busy||authRequest||(!signingIn&&unsettled()))return;
      if(signingIn===auth.signedIn)return;
      authRequest={id:requestId(),action:signingIn?'signIn':'signOut'};message='';
      if(!send(authRequest.action,{requestId:authRequest.id})){message=text().signInFailed;authRequest=null;}
      app.refresh();return;
    }
    if(b.dataset.billingBuy){purchase(b.dataset.billingBuy);return;}
    if(b.hasAttribute('data-billing-restore')){if(!signedIn()||!state.configured||busy())return;currentRequest={id:requestId(),readingId:context().readingId,restore:true};message='';if(!send('restore',{requestId:currentRequest.id})){currentRequest=null;state.busy=false;state.status='unavailable';message=text().failed;}app.refresh();return;}
    if(b.hasAttribute('data-billing-refresh')){message='';if(!send('status')){state.status='unavailable';message=text().failed;}app.refresh();}
  },true);
  const style=document.createElement('style');style.textContent='.billing-status{padding:15px;border:1px solid #d4b3d34d;border-radius:13px;color:#f6ddc9;font-size:14px;line-height:1.8}.billing-note,.billing-scope{font-size:12px;line-height:1.8;color:#cdb7cf}.billing-actions{display:flex;gap:9px;flex-wrap:wrap}.billing-actions button{flex:1;min-width:120px}.billing-page .pack-head{flex-wrap:wrap;gap:8px}.billing-page .pack-price{white-space:normal;overflow-wrap:anywhere}.billing-page button:disabled{opacity:.45}.billing-owned{color:#f1d4ad}.billing-account{padding:12px 0}.billing-account .billing-note{overflow-wrap:anywhere}';document.head.appendChild(style);
  app.refresh();
  if(!send('status')){state.status='unavailable';app.refresh();}
})();
