import { SignJWT, createLocalJWKSet, importPKCS8, jwtVerify } from 'jose';
import { PLAY_PURCHASE_CATALOG } from './play_purchase.mjs';

const FIREBASE_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const MAX_JSON_BYTES = 1024 * 1024;
const GOOGLE_TIMEOUT_MS = 15_000;
const SKEW_MS = 5 * 60_000;

/** Only fixed codes and non-sensitive metadata leave the Google boundary. */
export class GoogleClientFailure extends Error {
  constructor(code, { status = 503, retryable = false } = {}) {
    super('Google service request failed.');
    this.name = 'GoogleClientFailure';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const fail = (code, status = 503, retryable = false) => {
  throw new GoogleClientFailure(code, { status, retryable });
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaque = (value, limit = 4096) => typeof value === 'string'
  && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
const projectIdValid = (value) => typeof value === 'string'
  && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
const packageValid = (value) => typeof value === 'string' && value.length <= 255
  && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value);
const nowMillis = (clock) => {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('google_configuration_required');
  return value;
};

async function safeFetch(fetchImpl, url, init, unavailableCode = 'play_unavailable') {
  try {
    const response = await fetchImpl(url, {
      ...init,
      // Workers supports manual redirects; reject every 3xx below without following.
      redirect: 'manual',
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!(response instanceof Response) || response.redirected
        || (response.status >= 300 && response.status < 400)) {
      fail(unavailableCode, 503, true);
    }
    return response;
  } catch (error) {
    if (error instanceof GoogleClientFailure) throw error;
    fail(unavailableCode, 503, true);
  }
}

async function boundedJson(response, code = 'play_unavailable', limit = MAX_JSON_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) fail(code, 503, true);
  const chunks = [];
  let length = 0;
  const timeout = AbortSignal.timeout(GOOGLE_TIMEOUT_MS);
  let onTimeout;
  const timedOut = new Promise((_, reject) => {
    onTimeout = () => reject(new Error('timeout'));
    timeout.addEventListener('abort', onTimeout, { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timedOut]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) fail(code, 503, true);
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(value)) fail(code, 503, true);
    return value;
  } catch (error) {
    if (error instanceof GoogleClientFailure) throw error;
    fail(code, 503, true);
  } finally {
    timeout.removeEventListener('abort', onTimeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function publisherFailure(status) {
  if (status === 404) fail('play_purchase_not_found', 404);
  if (status === 410) fail('play_purchase_expired', 410);
  if (status === 401 || status === 403) fail('play_permission_denied');
  if (status === 429) fail('play_rate_limited', 503, true);
  fail('play_unavailable', 503, status >= 500);
}

/** Firebase ID tokens are distinct from Google OAuth access/identity tokens. */
export class FirebaseTokenAuthenticator {
  #projectId;
  #fetch;
  #clock;
  #resolver;
  #remoteResolver;
  #loadedAt = -Infinity;
  #loading;

  constructor({ projectId, jwks, clock = Date.now, fetchImpl = globalThis.fetch } = {}) {
    if (!projectIdValid(projectId) || typeof clock !== 'function' || typeof fetchImpl !== 'function') {
      fail('google_configuration_required');
    }
    this.#projectId = projectId;
    this.#fetch = fetchImpl;
    this.#clock = clock;
    if (jwks !== undefined) {
      if (typeof jwks === 'function' || jwks instanceof Uint8Array || jwks instanceof CryptoKey) {
        this.#resolver = jwks;
      } else {
        try { this.#resolver = createLocalJWKSet(jwks); }
        catch (_) { fail('google_configuration_required'); }
      }
    }
  }

  async #loadKeys(force = false) {
    const now = nowMillis(this.#clock);
    if (this.#remoteResolver && ((!force && now - this.#loadedAt < 60 * 60_000)
        || (force && now - this.#loadedAt < 30_000))) return;
    if (!this.#loading) {
      this.#loading = (async () => {
        const response = await safeFetch(this.#fetch, FIREBASE_KEYS,
          { headers: { accept: 'application/json' } }, 'authentication_unavailable');
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          fail('authentication_unavailable', 503, true);
        }
        const keys = await boundedJson(response, 'authentication_unavailable', 128 * 1024);
        if (!Array.isArray(keys.keys) || keys.keys.length < 1 || keys.keys.length > 100) {
          fail('authentication_unavailable', 503, true);
        }
        try { this.#remoteResolver = createLocalJWKSet(keys); }
        catch (_) { fail('authentication_unavailable', 503, true); }
        this.#loadedAt = now;
      })().finally(() => { this.#loading = undefined; });
    }
    await this.#loading;
  }

  async authenticate(authorizationHeader) {
    if (authorizationHeader === undefined || authorizationHeader === null || authorizationHeader === '') {
      fail('authentication_required', 401);
    }
    if (typeof authorizationHeader !== 'string' || authorizationHeader.length > 16_384
        || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(authorizationHeader)) {
      fail('authentication_invalid', 401);
    }
    const token = authorizationHeader.slice(7);
    const nowMs = nowMillis(this.#clock);
    const options = {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${this.#projectId}`,
      audience: this.#projectId,
      currentDate: new Date(nowMs),
      clockTolerance: 0,
      requiredClaims: ['sub', 'iat', 'exp', 'auth_time', 'firebase'],
    };
    try {
      if (!this.#resolver) await this.#loadKeys();
      let result;
      try { result = await jwtVerify(token, this.#resolver ?? this.#remoteResolver, options); }
      catch (error) {
        if (!this.#resolver && error?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
          await this.#loadKeys(true);
          result = await jwtVerify(token, this.#remoteResolver, options);
        } else throw error;
      }
      const { payload } = result;
      const nowSeconds = Math.floor(nowMs / 1000);
      if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 128
          || /[\x00-\x1f\x7f]/.test(payload.sub)
          || payload.aud !== this.#projectId
          || !Number.isSafeInteger(payload.iat) || payload.iat < 0 || payload.iat > nowSeconds
          || !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds || payload.exp <= payload.iat
          || !Number.isSafeInteger(payload.auth_time) || payload.auth_time < 0
          || payload.auth_time > payload.iat || payload.auth_time > nowSeconds
          || !record(payload.firebase) || payload.firebase.sign_in_provider !== 'google.com') {
        fail('authentication_invalid', 401);
      }
      return Object.freeze({ userId: `${this.#projectId}:${payload.sub}`, uid: payload.sub, projectId: this.#projectId });
    } catch (error) {
      if (error instanceof GoogleClientFailure) throw error;
      fail('authentication_invalid', 401);
    }
  }
}

/** Google Play uses a server-only service account. This adapter never consumes. */
export class GooglePlayPublisherClient {
  #account;
  #package;
  #fetch;
  #clock;
  #key;
  #token;
  #tokenUntil = 0;
  #tokenPending;

  constructor({ serviceAccount, packageName, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    let account = serviceAccount;
    if (typeof account === 'string') {
      try { account = JSON.parse(account); } catch (_) { fail('google_configuration_required'); }
    }
    if (!record(account) || account.type !== 'service_account'
        || typeof account.client_email !== 'string'
        || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(account.client_email)
        || typeof account.private_key !== 'string' || account.private_key.length > 65_536
        || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
        || (account.token_uri !== undefined && account.token_uri !== GOOGLE_TOKEN)
        || (account.private_key_id !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(account.private_key_id))
        || !packageValid(packageName) || typeof fetchImpl !== 'function' || typeof clock !== 'function') {
      fail('google_configuration_required');
    }
    this.#account = { client_email: account.client_email, private_key: account.private_key,
      private_key_id: account.private_key_id };
    this.#package = packageName;
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  async #accessToken() {
    const now = nowMillis(this.#clock);
    if (this.#token && now < this.#tokenUntil - 60_000) return this.#token;
    if (!this.#tokenPending) {
      this.#tokenPending = (async () => {
        let assertion;
        try {
          this.#key ??= await importPKCS8(this.#account.private_key, 'RS256');
          const issuedAt = Math.floor(now / 1000);
          assertion = await new SignJWT({ scope: PUBLISHER_SCOPE })
            .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(this.#account.private_key_id
              ? { kid: this.#account.private_key_id } : {}) })
            .setIssuer(this.#account.client_email).setAudience(GOOGLE_TOKEN)
            .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3600).sign(this.#key);
        } catch (_) { fail('google_configuration_required'); }
        const response = await safeFetch(this.#fetch, GOOGLE_TOKEN, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            fail('google_configuration_required');
          }
          if (response.status === 429) fail('play_rate_limited', 503, true);
          fail('play_unavailable', 503, true);
        }
        const value = await boundedJson(response);
        if (!opaque(value.access_token, 16_384) || typeof value.token_type !== 'string'
            || value.token_type.toLowerCase() !== 'bearer'
            || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 7200) {
          fail('play_unavailable', 503, true);
        }
        this.#token = value.access_token;
        this.#tokenUntil = now + Math.min(value.expires_in, 3600) * 1000;
        return this.#token;
      })().finally(() => { this.#tokenPending = undefined; });
    }
    return this.#tokenPending;
  }

  #base() { return PUBLISHER + encodeURIComponent(this.#package); }

  async #request(url, { method = 'GET', body, empty = false } = {}) {
    let token = await this.#accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await safeFetch(this.#fetch, url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401 && attempt === 0) {
        void response.body?.cancel().catch(() => {});
        // Do not let a late rejected request discard a newly refreshed token.
        if (this.#token === token) { this.#token = undefined; this.#tokenUntil = 0; }
        token = await this.#accessToken();
        continue;
      }
      if (response.status !== 200 && !(empty && response.status === 204)) {
        void response.body?.cancel().catch(() => {});
        publisherFailure(response.status);
      }
      if (empty) { void response.body?.cancel().catch(() => {}); return; }
      return boundedJson(response);
    }
    fail('play_permission_denied');
  }

  async getPurchase(purchaseToken) {
    if (!opaque(purchaseToken)) fail('invalid_purchase_token', 400);
    return this.#request(`${this.#base()}/purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  }

  async acknowledge(productId, purchaseToken) {
    if (!Object.hasOwn(PLAY_PURCHASE_CATALOG, productId)) fail('invalid_product', 400);
    if (!opaque(purchaseToken)) fail('invalid_purchase_token', 400);
    await this.#request(`${this.#base()}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      { method: 'POST', body: {}, empty: true });
  }

  async listVoidedPurchases({ startTimeMs, endTimeMs, pageToken } = {}) {
    const now = nowMillis(this.#clock);
    const retentionMs = 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(startTimeMs) || startTimeMs < 0
        || !Number.isSafeInteger(endTimeMs) || endTimeMs <= startTimeMs || endTimeMs > now
        || endTimeMs - startTimeMs > retentionMs
        || (!pageToken && startTimeMs < now - retentionMs)
        || (pageToken !== undefined && pageToken !== null && !opaque(pageToken))) {
      fail('google_configuration_required');
    }
    const url = new URL(`${this.#base()}/purchases/voidedpurchases`);
    url.search = new URLSearchParams({ startTime: String(startTimeMs), endTime: String(endTimeMs),
      type: '0', includeQuantityBasedPartialRefund: 'true', maxResults: '100',
      ...(pageToken ? { token: pageToken } : {}) }).toString();
    const value = await this.#request(url.toString());
    const raw = value.voidedPurchases ?? [];
    const rawNextPageToken = value.tokenPagination?.nextPageToken;
    const nextPageToken = rawNextPageToken === undefined || rawNextPageToken === null || rawNextPageToken === ''
      ? null : rawNextPageToken;
    if (!Array.isArray(raw) || raw.length > 1000
        || (value.tokenPagination !== undefined && !record(value.tokenPagination))
        || (nextPageToken !== null && !opaque(nextPageToken))) fail('play_unavailable', 503, true);
    const voidedPurchases = raw.map((item) => {
      if (!record(item) || !opaque(item.purchaseToken)
          || typeof item.voidedTimeMillis !== 'string' || !/^\d{1,16}$/.test(item.voidedTimeMillis)
          || !Number.isSafeInteger(Number(item.voidedTimeMillis))
          || Number(item.voidedTimeMillis) > now + SKEW_MS
          || (item.voidedQuantity !== undefined
            && (!Number.isSafeInteger(item.voidedQuantity) || item.voidedQuantity < 1))) {
        fail('play_unavailable', 503, true);
      }
      // API start/end filters use when Google saw a void, not this actual void time.
      // A valid older refund must still create a durable token-hash tombstone.
      return Object.freeze({ purchaseToken: item.purchaseToken, voidedTimeMillis: item.voidedTimeMillis,
        ...(item.voidedQuantity !== undefined ? { voidedQuantity: item.voidedQuantity } : {}) });
    });
    return Object.freeze({ voidedPurchases: Object.freeze(voidedPurchases), nextPageToken });
  }
}
