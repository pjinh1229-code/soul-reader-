/**
 * Validate authoritative Android Publisher ProductPurchaseV2 facts.
 *
 * `expected` must come from authenticated server configuration, the immutable
 * prepared purchase intent, and a durable purchase-token ledger lookup. Never
 * construct its owner IDs or knownTransaction flag from the HTTP request body.
 * The v2 response has no package field: the API adapter must fetch it using
 * the configured packageName in the Android Publisher request URL.
 *
 * Official schema:
 * https://raw.githubusercontent.com/googleapis/google-api-nodejs-client/main/discovery/androidpublisher-v3.json
 */

export const PLAY_PURCHASE_CATALOG = Object.freeze({
  soul_reading_single: Object.freeze({ offerKey: 'single', purchaseOptionId: 'single' }),
  soul_reading_bundle: Object.freeze({ offerKey: 'bundle', purchaseOptionId: 'bundle' }),
});

const CONSUMPTION_STATES = new Set([
  'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
  'CONSUMPTION_STATE_CONSUMED',
]);
const ACKNOWLEDGEMENT_STATES = new Set([
  'ACKNOWLEDGEMENT_STATE_PENDING',
  'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
]);
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export class PlayPurchaseValidationError extends Error {
  constructor(code) {
    super('Google Play purchase validation failed.');
    this.name = 'PlayPurchaseValidationError';
    this.code = code;
  }
}

function fail(code) {
  throw new PlayPurchaseValidationError(code);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function opaquePreparedId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function trustedContext(expected) {
  if (!record(expected)
      || typeof expected.packageName !== 'string'
      || expected.packageName.length > 255
      || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(expected.packageName)
      || typeof expected.productId !== 'string'
      || !Object.hasOwn(PLAY_PURCHASE_CATALOG, expected.productId)
      || expected.purchaseOptionId !== PLAY_PURCHASE_CATALOG[expected.productId].purchaseOptionId
      || !opaquePreparedId(expected.obfuscatedAccountId)
      || !opaquePreparedId(expected.obfuscatedProfileId)
      || typeof expected.knownTransaction !== 'boolean') {
    fail('invalid_expected_purchase_context');
  }
  return {
    packageName: expected.packageName,
    productId: expected.productId,
    purchaseOptionId: expected.purchaseOptionId,
    obfuscatedAccountId: expected.obfuscatedAccountId,
    obfuscatedProfileId: expected.obfuscatedProfileId,
    knownTransaction: expected.knownTransaction,
  };
}

/** Strict RFC3339 validation without Date.parse's invalid-calendar coercion. */
function completedTime(value, nowMs, maxFutureSkewMs) {
  if (typeof value !== 'string') fail('invalid_purchase_completion_time');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('invalid_purchase_completion_time');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    fail('invalid_purchase_completion_time');
  }
  const millis = Number(((match[7] ?? '') + '000').slice(0, 3));
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millis);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
      || calendar.getUTCDate() !== day || calendar.getUTCHours() !== hour
      || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) {
    fail('invalid_purchase_completion_time');
  }
  let offsetMs = 0;
  if (match[8] !== 'Z') {
    const offsetHours = Number(match[8].slice(1, 3));
    const offsetMinutes = Number(match[8].slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) fail('invalid_purchase_completion_time');
    offsetMs = (offsetHours * 60 + offsetMinutes) * 60_000 * (match[8][0] === '+' ? 1 : -1);
  }
  const timeMs = calendar.getTime() - offsetMs;
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > nowMs + maxFutureSkewMs) {
    fail('invalid_purchase_completion_time');
  }
  return { iso: new Date(timeMs).toISOString(), milliseconds: timeMs };
}

/**
 * Return frozen, non-secret receipt facts, not an entitlement or proof to a UI.
 * Token, account/profile IDs, order ID and arbitrary upstream fields are never
 * returned. A known consumed receipt can replay only its original durable grant.
 */
export function normalizePlayPurchaseV2(purchase, expected, options = {}) {
  const context = trustedContext(expected);
  if (!record(options)) fail('invalid_purchase_validation_clock');
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const maxFutureSkewMs = options.maxFutureSkewMs === undefined
    ? DEFAULT_FUTURE_SKEW_MS : options.maxFutureSkewMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
      || !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0
      || maxFutureSkewMs > DEFAULT_FUTURE_SKEW_MS) {
    fail('invalid_purchase_validation_clock');
  }
  if (!record(purchase) || !record(purchase.purchaseStateContext)) fail('invalid_play_purchase');
  const state = purchase.purchaseStateContext.purchaseState;
  if (state === 'PENDING') fail('purchase_pending');
  if (state === 'CANCELLED') fail('purchase_cancelled');
  if (state !== 'PURCHASED') fail('invalid_purchase_state');
  if (!Array.isArray(purchase.productLineItem) || purchase.productLineItem.length !== 1
      || !record(purchase.productLineItem[0])) {
    fail('invalid_purchase_line_items');
  }
  const item = purchase.productLineItem[0];
  if (item.productId !== context.productId) fail('purchase_product_mismatch');
  const details = item.productOfferDetails;
  if (!record(details)) fail('invalid_purchase_offer_details');
  if (details.purchaseOptionId !== context.purchaseOptionId) fail('purchase_option_mismatch');
  if (Object.hasOwn(details, 'rentOfferDetails') || Object.hasOwn(details, 'preorderOfferDetails')) {
    fail('unsupported_purchase_offer');
  }
  // Unlike the legacy v1 quantity field, v2 documents no missing-value default.
  if (!Number.isInteger(details.quantity) || details.quantity !== 1) fail('invalid_purchase_quantity');
  if (details.refundableQuantity === 0) fail('purchase_refunded');
  if (!Number.isInteger(details.refundableQuantity) || details.refundableQuantity !== 1) {
    fail('invalid_refundable_quantity');
  }
  if (purchase.obfuscatedExternalAccountId !== context.obfuscatedAccountId
      || purchase.obfuscatedExternalProfileId !== context.obfuscatedProfileId) {
    fail('purchase_context_mismatch');
  }
  if (!CONSUMPTION_STATES.has(details.consumptionState)) fail('invalid_purchase_consumption_state');
  if (!ACKNOWLEDGEMENT_STATES.has(purchase.acknowledgementState)) fail('invalid_purchase_acknowledgement_state');
  const consumed = details.consumptionState === 'CONSUMPTION_STATE_CONSUMED';
  if (consumed && !context.knownTransaction) fail('unknown_consumed_purchase');
  if (consumed && purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
    fail('inconsistent_purchase_finalization');
  }
  const time = completedTime(purchase.purchaseCompletionTime, nowMs, maxFutureSkewMs);
  let testPurchase = false;
  if (purchase.testPurchaseContext !== undefined) {
    if (!record(purchase.testPurchaseContext) || purchase.testPurchaseContext.fopType !== 'TEST') {
      fail('invalid_test_purchase_context');
    }
    testPurchase = true;
  }
  if (purchase.orderId !== undefined && (typeof purchase.orderId !== 'string'
      || purchase.orderId.length < 1 || purchase.orderId.length > 256
      || /[\x00-\x1f\x7f]/.test(purchase.orderId))) {
    fail('invalid_purchase_order_id');
  }
  return Object.freeze({
    packageName: context.packageName,
    productId: context.productId,
    purchaseOptionId: context.purchaseOptionId,
    offerKey: PLAY_PURCHASE_CATALOG[context.productId].offerKey,
    purchaseState: 'PURCHASED',
    quantity: 1,
    refundableQuantity: 1,
    consumptionState: details.consumptionState,
    acknowledgementState: purchase.acknowledgementState,
    purchaseCompletionTime: time.iso,
    purchaseCompletionTimeMillis: time.milliseconds,
    testPurchase,
  });
}
