/* One native interstitial opportunity at the start of a new free report. */
(() => {
  'use strict';
  const storageKey = 'sr-free-reading-ad-attempts';
  const attempted = new Set();
  const labels = {ko: '광고 개인정보 설정', en: 'Ad privacy settings', ja: '広告のプライバシー設定'};
  let enabled = true, privacyOptionsRequired = false, sequence = 0, pending = null;
  const bridge = () => typeof window.FreeReadingAds?.postMessage === 'function';
  const context = () => window.SoulBillingApp?.context() || {};
  const current = request => {
    const c = context();
    return !request.invalidated && c.screen === 'loading' && c.readingId === request.readingId;
  };
  const requestId = () => `free-reading-${window.crypto?.randomUUID?.() || `${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`}`;

  function ledger() {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function wasAttempted(reading) {
    if (reading.freeReadingAdAttemptedAt || attempted.has(reading.id)) return true;
    try { return Object.hasOwn(ledger(), reading.id); } catch { return false; }
  }
  function persistAttempt(reading) {
    // Persist before crossing the bridge. A crash or reload cannot replay this ad.
    const at = Date.now();
    attempted.add(reading.id);
    reading.freeReadingAdAttemptedAt = at;
    try {
      const next = ledger();
      Object.defineProperty(next, reading.id, {value: at, enumerable: true, configurable: true});
      const serialized = JSON.stringify(next);
      localStorage.setItem(storageKey, serialized);
      return localStorage.getItem(storageKey) === serialized;
    } catch { return false; }
  }
  function patchPrivacy() {
    const footer = document.getElementById('legal-support');
    if (!footer) return;
    let button = footer.querySelector('[data-free-reading-ad-privacy]');
    if (!bridge() || !enabled || !privacyOptionsRequired) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.freeReadingAdPrivacy = '';
      footer.append(button);
    }
    const label = labels[document.documentElement.lang] || labels.ko;
    if (button.textContent !== label) button.textContent = label;
    button.disabled = pending !== null;
  }
  function pauseAudio() {
    window.dispatchEvent(new Event('sr-free-reading-ads-pause'));
    document.querySelectorAll('audio,video').forEach(media => media.pause());
    window.speechSynthesis?.cancel();
  }
  function receive(payload) {
    if (!pending || !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !['completed', 'skipped'].includes(payload.status) ||
        payload.requestId !== pending.requestId || payload.readingId !== pending.readingId) return;
    const request = pending;
    pending = null;
    patchPrivacy();
    window.dispatchEvent(new Event('sr-free-reading-ads-release'));
    if (request.action === 'show' && current(request)) request.continueReading();
  }
  function send(action, readingId, continueReading) {
    const request = {action, requestId: requestId(), readingId, continueReading, invalidated: false};
    pending = request;
    pauseAudio();
    patchPrivacy();
    try {
      window.FreeReadingAds.postMessage(JSON.stringify({action, requestId: request.requestId, readingId}));
    } catch {
      receive({requestId: request.requestId, readingId, status: 'skipped'});
    }
    // Only native dismissal/load failure releases the gate. In particular, a
    // JavaScript timer must never start report audio over a live native overlay.
  }
  function beforeOpen(reading, continueReading) {
    if (typeof continueReading !== 'function') return;
    if (pending) return;
    const c = context();
    if (!reading || typeof reading.id !== 'string' || !reading.id ||
        c.screen !== 'loading' || c.readingId !== reading.id ||
        !enabled || !bridge() || c.reviewActive || c.entitlement?.readingId === reading.id ||
        window.SoulBilling?.isBusy() || wasAttempted(reading)) {
      continueReading();
      return;
    }
    // If durable storage is unavailable, keep the report accessible and omit
    // this opportunity rather than risk repeating it after a reload.
    if (!persistAttempt(reading)) { continueReading(); return; }
    send('show', reading.id, continueReading);
  }
  function invalidate() {
    if (pending?.action !== 'show' || pending.invalidated) return;
    pending.invalidated = true;
    // Native handles this immediately, including while it is still loading.
    // Retain the gate until native confirms that any live overlay has closed.
    try { window.FreeReadingAds.postMessage(JSON.stringify({action: 'cancel', requestId: pending.requestId, readingId: pending.readingId})); } catch {}
  }
  function setState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.enabled === 'boolean') enabled = value.enabled;
    if (typeof value.privacyOptionsRequired === 'boolean') privacyOptionsRequired = value.privacyOptionsRequired;
    patchPrivacy();
  }
  window.SRFreeReadingAds = Object.freeze({
    beforeOpen, receive, setState,
    isPending: () => pending !== null,
    setEnabled(value) { setState({enabled: value !== false}); },
    routeChanging(route) { if (route !== 'loading') invalidate(); },
  });
  window.addEventListener('pagehide', invalidate);
  window.addEventListener('click', event => {
    const button = event.target.closest?.('[data-free-reading-ad-privacy]');
    if (button) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (bridge() && enabled && privacyOptionsRequired && !pending && !window.SoulBilling?.isBusy()) send('privacy', context().readingId || '');
      return;
    }
    if (pending && event.target.closest?.('[data-sr60-clip],[data-ryu-clip],[data-replay856],#voiceToggle,#musicToggle,#sr64TestAudio,#sr70-voice,#sr70-bgm')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  new MutationObserver(() => {
    if (pending?.action === 'show' && !current(pending)) invalidate();
    patchPrivacy();
  }).observe(document.getElementById('app'), {childList: true, subtree: true});
  patchPrivacy();
})();
