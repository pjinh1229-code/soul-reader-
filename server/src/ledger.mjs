/** Durable D1 state; all production cryptography uses the Web Crypto API. */
export class BillingServerFailure extends Error {
  constructor(code, status = 400) {
    super('Billing request failed.');
    this.name = 'BillingServerFailure';
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, status = 400) => { throw new BillingServerFailure(code, status); };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const DAY_MS = 86_400_000;
const RETENTION_MS = 30 * DAY_MS;

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function unbase64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) fail('invalid_request');
  try {
    return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
  } catch { return fail('invalid_request'); }
}
export function secretKey(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(text)) fail('configuration_required', 503);
  try {
    const key = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    if (key.length !== 32 || btoa(String.fromCharCode(...key)) !== text) fail('configuration_required', 503);
    return key;
  } catch { return fail('configuration_required', 503); }
}
export async function tokenHash(token) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}
export function publicGrant(row) {
  return {
    entitlementId: row.entitlement_id,
    transactionId: row.transaction_id,
    offerKey: row.offer_key,
    productId: row.product_id,
    readingId: row.reading_id,
    requestId: row.request_id,
    topic: row.topic,
    status: row.status,
  };
}
const rows = result => result.results ?? [];

export class BillingLedger {
  #db;
  #hmac;
  #aes;
  #clock;
  constructor(db, { accountHmacKey, tokenEncryptionKey, clock = Date.now }) {
    if (!db?.prepare || !db?.batch) fail('configuration_required', 503);
    this.#db = db;
    this.#clock = clock;
    this.#hmac = crypto.subtle.importKey('raw', accountHmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    this.#aes = crypto.subtle.importKey('raw', tokenEncryptionKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  statement(sql, ...values) { return this.#db.prepare(sql).bind(...values); }
  async first(sql, ...values) { return this.statement(sql, ...values).first(); }
  async all(sql, ...values) { return rows(await this.statement(sql, ...values).all()); }
  randomId() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
  async sign(text) {
    return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await this.#hmac, encoder.encode(text))));
  }
  async accountId(userId) { return this.sign(`account\0${userId}`); }
  async encryptToken(token, hash) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(hash) }, await this.#aes, encoder.encode(token)));
    return `${base64url(iv)}.${base64url(encrypted)}`;
  }
  async decryptToken(row) {
    try {
      const [iv, encrypted, extra] = row.encrypted_token.split('.');
      if (extra !== undefined) fail('billing_storage_failed', 503);
      return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(iv), additionalData: encoder.encode(row.token_hash) }, await this.#aes, unbase64url(encrypted)));
    } catch { return fail('billing_storage_failed', 503); }
  }
  async rateLimit(userId, action, limit) {
    const minute = Math.floor(this.#clock() / 60_000);
    const result = await this.statement(`INSERT INTO rate_limits(user_id,action,minute,count) VALUES(?,?,?,1)
      ON CONFLICT(user_id,action,minute) DO UPDATE SET count=count+1 WHERE count<?`, userId, action, minute, limit).run();
    if (result.meta?.changes !== 1) fail('billing_rate_limited', 429);
  }
  async prepare(userId, request) {
    const account = await this.accountId(userId);
    await this.statement(`INSERT OR IGNORE INTO purchase_intents
      (user_id,request_id,reading_id,product_id,offer_key,account_id,profile_id,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?)`, userId, request.requestId, request.readingId,
    request.productId, request.offerKey, account, this.randomId(), this.#clock()).run();
    const intent = await this.intent(userId, request.requestId);
    if (!intent || intent.reading_id !== request.readingId || intent.product_id !== request.productId
      || intent.offer_key !== request.offerKey || intent.account_id !== account) fail('purchase_context_mismatch', 409);
    return intent;
  }
  intent(userId, requestId) {
    return this.first('SELECT * FROM purchase_intents WHERE user_id=? AND request_id=?', userId, requestId);
  }
  intentByProfile(userId, profileId) {
    return this.first('SELECT * FROM purchase_intents WHERE user_id=? AND profile_id=?', userId, profileId);
  }
  purchase(hash) { return this.first(`SELECT p.*,i.account_id,i.profile_id FROM purchases p JOIN purchase_intents i USING(user_id,request_id) WHERE p.token_hash=?`, hash); }
  purchaseById(userId, entitlementId) {
    return this.first(`SELECT p.*,i.account_id,i.profile_id FROM purchases p JOIN purchase_intents i USING(user_id,request_id) WHERE p.user_id=? AND p.entitlement_id=?`, userId, entitlementId);
  }
  tombstone(hash) { return this.first('SELECT token_hash FROM refund_tombstones WHERE token_hash=?', hash); }
  async storePurchase(userId, intent, token, hash, acknowledged) {
    const encrypted = await this.encryptToken(token, hash);
    const now = this.#clock();
    await this.statement(`INSERT OR IGNORE INTO purchases
      (token_hash,encrypted_token,entitlement_id,transaction_id,user_id,request_id,reading_id,product_id,
       offer_key,topic,status,ack_pending,created_at_ms,last_verified_ms)
      SELECT ?,?,?,?,user_id,request_id,reading_id,product_id,offer_key,NULL,'active',?,?,?
      FROM purchase_intents WHERE user_id=? AND request_id=? AND profile_id=?`,
    hash, encrypted, this.randomId(), this.randomId(), acknowledged ? 0 : 1, now, now,
    userId, intent.request_id, intent.profile_id).run();
    const purchase = await this.purchase(hash);
    if (await this.tombstone(hash)) fail('purchase_revoked', 409);
    if (!purchase || purchase.user_id !== userId || purchase.request_id !== intent.request_id
      || purchase.product_id !== intent.product_id || purchase.reading_id !== intent.reading_id) {
      fail('purchase_context_mismatch', 409);
    }
    if (purchase.status !== 'active') fail('purchase_revoked', 409);
    return purchase;
  }
  async verified(hash, acknowledged) {
    await this.statement(`UPDATE purchases SET last_verified_ms=?, ack_pending=CASE WHEN ? THEN 0 ELSE 1 END
      WHERE token_hash=? AND status='active'`, this.#clock(), acknowledged ? 1 : 0, hash).run();
  }
  async verifiedRows(hashes) {
    if (!hashes.length) return;
    await this.statement(`UPDATE purchases SET last_verified_ms=? WHERE status='active'
      AND token_hash IN (SELECT value FROM json_each(?))`, this.#clock(), JSON.stringify(hashes)).run();
  }
  async acknowledged(hash) {
    await this.statement('UPDATE purchases SET ack_pending=0 WHERE token_hash=?', hash).run();
  }
  async revoke(hash, time = this.#clock()) {
    await this.#db.batch([
      this.statement('INSERT OR IGNORE INTO refund_tombstones(token_hash,voided_at_ms) VALUES(?,?)', hash, time),
      this.statement("UPDATE purchases SET status='revoked',ack_pending=0 WHERE token_hash=?", hash),
    ]);
  }
  async revision(userId) {
    const value = await this.first('SELECT revision FROM user_revisions WHERE user_id=?', userId);
    return value?.revision ?? 0;
  }
  async encodeCursor(userId, revision, after, pageSize) {
    const data = base64url(encoder.encode(JSON.stringify({ v: 1, userId, revision, after, pageSize })));
    return `${data}.${await this.sign(`cursor\0${data}`)}`;
  }
  async decodeCursor(cursor, userId) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 2048) fail('invalid_cursor');
      const [data, signature, extra] = cursor.split('.');
      if (extra !== undefined || !data || !signature
        || !await crypto.subtle.verify('HMAC', await this.#hmac, unbase64url(signature), encoder.encode(`cursor\0${data}`))) fail('invalid_cursor');
      const value = JSON.parse(decoder.decode(unbase64url(data)));
      if (value.v !== 1 || value.userId !== userId || !Number.isSafeInteger(value.revision) || value.revision < 0
        || typeof value.after !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.after)
        || !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 20) fail('invalid_cursor');
      return value;
    } catch { return fail('invalid_cursor'); }
  }
  page(userId, after, pageSize) {
    return this.all(`SELECT p.*,i.account_id,i.profile_id FROM purchases p JOIN purchase_intents i USING(user_id,request_id) WHERE p.user_id=? AND p.status='active' AND p.entitlement_id>? ORDER BY p.entitlement_id LIMIT ?`,
      userId, after, pageSize + 1);
  }
  async selectTopic(userId, id, topic) {
    await this.statement(`UPDATE purchases SET topic=? WHERE user_id=? AND entitlement_id=?
      AND status='active' AND offer_key='single' AND topic IS NULL`, topic, userId, id).run();
    const row = await this.purchaseById(userId, id);
    if (!row || row.status !== 'active') fail('invalid_entitlement', 404);
    if (row.offer_key !== 'single') fail('invalid_topic');
    if (row.topic !== topic) fail('topic_already_selected', 409);
    return row;
  }
  async markAcknowledgementAttempt(hash) {
    await this.statement('UPDATE purchases SET last_ack_attempt_ms=? WHERE token_hash=?', this.#clock(), hash).run();
  }
  pendingAcknowledgements(limit = 3) {
    return this.all(`SELECT p.*,i.account_id,i.profile_id FROM purchases p JOIN purchase_intents i USING(user_id,request_id) WHERE p.ack_pending=1 AND p.status='active' ORDER BY p.last_ack_attempt_ms,p.created_at_ms LIMIT ?`, limit);
  }
  syncState() { return this.first('SELECT * FROM refund_sync WHERE singleton=1'); }
  refundsFreshIn(row, sync) {
    const now = this.#clock();
    return Boolean(sync && sync.last_completed_ms > 0 && sync.last_completed_ms <= now
      && now - sync.last_completed_ms <= DAY_MS && sync.watermark_ms <= now
      && now - sync.watermark_ms <= DAY_MS && row.last_verified_ms >= sync.coverage_start_ms);
  }
  async refundsFresh(row) { return this.refundsFreshIn(row, await this.syncState()); }
  /** Range/cursor and tombstones commit together. A watermark never skips an unfinished page. */
  async syncRefunds(publisher, maxPages = 2) {
    const now = this.#clock();
    const owner = this.randomId();
    const claim = await this.statement(`UPDATE refund_sync SET lease_owner=?,lease_until_ms=?
      WHERE singleton=1 AND lease_until_ms<=?`, owner, now + 120_000, now).run();
    if (claim.meta?.changes !== 1) return false;
    try {
      let state = await this.syncState();
      // Leave five minutes at the retention boundary: the API adapter's clock is
      // read after this method, so an exact now-30d start would already be too old.
      const retentionFloor = Math.max(0, now - RETENTION_MS + 300_000);
      if (state.range_start_ms === null || state.range_end_ms < now - RETENTION_MS
        || (state.page_token === null && state.range_start_ms < retentionFloor)) {
        const start = Math.max(retentionFloor, state.watermark_ms ? state.watermark_ms - 300_000 : 0);
        const coverageStart = state.coverage_start_ms === 0 || state.watermark_ms < retentionFloor
          ? start : state.coverage_start_ms;
        await this.statement(`UPDATE refund_sync SET range_start_ms=?,range_end_ms=?,page_token=NULL,coverage_start_ms=?
          WHERE singleton=1 AND lease_owner=?`, start, now, coverageStart, owner).run();
        state = await this.syncState();
      }
      const seen = new Set();
      for (let page = 0; page < maxPages; page++) {
        if (seen.has(state.page_token)) fail('play_unavailable', 503);
        seen.add(state.page_token);
        const result = await publisher.listVoidedPurchases({ startTimeMs: state.range_start_ms,
          endTimeMs: state.range_end_ms, pageToken: state.page_token ?? undefined });
        if (!result || !Array.isArray(result.voidedPurchases) || result.voidedPurchases.length > 1000
          || (result.nextPageToken !== null && result.nextPageToken !== undefined
            && (typeof result.nextPageToken !== 'string' || !result.nextPageToken || result.nextPageToken.length > 4096))
          || (result.nextPageToken && seen.has(result.nextPageToken))) fail('play_unavailable', 503);
        const items = [];
        for (const item of result.voidedPurchases) {
          if (!item || typeof item.purchaseToken !== 'string' || !item.purchaseToken
            || item.purchaseToken.length > 4096 || !/^\d{1,16}$/.test(String(item.voidedTimeMillis))
            || !Number.isSafeInteger(Number(item.voidedTimeMillis)) || Number(item.voidedTimeMillis) > now + 300_000) {
            fail('play_unavailable', 503);
          }
          // Google filters by system-seen time, not the possibly much older voidedTimeMillis.
          items.push({ hash: await tokenHash(item.purchaseToken), time: Number(item.voidedTimeMillis) });
        }
        const json = JSON.stringify(items);
        const statements = [
          this.statement(`INSERT OR IGNORE INTO refund_tombstones(token_hash,voided_at_ms)
            SELECT json_extract(value,'$.hash'),json_extract(value,'$.time') FROM json_each(?)`, json),
          this.statement(`UPDATE purchases SET status='revoked',ack_pending=0
            WHERE token_hash IN (SELECT json_extract(value,'$.hash') FROM json_each(?))`, json),
        ];
        const next = result.nextPageToken ?? null;
        if (next !== null) {
          statements.push(this.statement('UPDATE refund_sync SET page_token=? WHERE singleton=1 AND lease_owner=?', next, owner));
        } else {
          statements.push(this.statement(`UPDATE refund_sync SET watermark_ms=range_end_ms,last_completed_ms=range_end_ms,
            range_start_ms=NULL,range_end_ms=NULL,page_token=NULL WHERE singleton=1 AND lease_owner=?`, owner));
        }
        await this.#db.batch(statements);
        if (next === null) return true;
        state = { ...state, page_token: next };
      }
      return false;
    } finally {
      await this.statement('UPDATE refund_sync SET lease_owner=NULL,lease_until_ms=0 WHERE singleton=1 AND lease_owner=?', owner).run();
    }
  }
  async cleanRateLimits() {
    await this.statement('DELETE FROM rate_limits WHERE minute<?', Math.floor(this.#clock() / 60_000) - 2).run();
  }
}
