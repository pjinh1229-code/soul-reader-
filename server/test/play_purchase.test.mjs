import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePlayPurchaseV2,
  PLAY_PURCHASE_CATALOG,
  PlayPurchaseValidationError,
} from '../src/play_purchase.mjs';

const NOW = Date.UTC(2026, 9, 27, 12);
const clock = Object.freeze({ nowMs: NOW });
const context = Object.freeze({
  packageName: 'com.soulreader.soul_reader',
  productId: 'soul_reading_single',
  purchaseOptionId: 'single',
  obfuscatedAccountId: 'prepared_account_opaque',
  obfuscatedProfileId: 'prepared_profile_opaque',
  knownTransaction: false,
});

function purchased() {
  return {
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    obfuscatedExternalAccountId: context.obfuscatedAccountId,
    obfuscatedExternalProfileId: context.obfuscatedProfileId,
    purchaseStateContext: { purchaseState: 'PURCHASED' },
    purchaseCompletionTime: '2026-10-27T11:59:00.123456789Z',
    productLineItem: [{
      productId: context.productId,
      productOfferDetails: {
        purchaseOptionId: context.purchaseOptionId,
        consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED',
        quantity: 1,
        refundableQuantity: 1,
      },
    }],
  };
}

function reject(receipt, code, expected = context, options = clock) {
  assert.throws(() => normalizePlayPurchaseV2(receipt, expected, options), error => {
    assert.ok(error instanceof PlayPurchaseValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('a purchased unacknowledged unit is valid and returns immutable non-secret facts', () => {
  const raw = purchased();
  raw.purchaseToken = 'receipt-secret-must-not-escape';
  raw.orderId = 'order-private-value';
  raw.regionCode = 'KR';
  raw.developerPayload = 'untrusted-extra-field';
  const before = structuredClone(raw);
  const normalized = normalizePlayPurchaseV2(raw, context, clock);
  assert.equal(normalized.offerKey, 'single');
  assert.equal(normalized.acknowledgementState, 'ACKNOWLEDGEMENT_STATE_PENDING');
  assert.equal(normalized.purchaseCompletionTime, '2026-10-27T11:59:00.123Z');
  assert.equal(normalized.purchaseCompletionTimeMillis, NOW - 59_877);
  assert.equal(normalized.testPurchase, false);
  assert.ok(Object.isFrozen(normalized));
  assert.deepEqual(raw, before);
  for (const secret of [raw.purchaseToken, raw.orderId, raw.obfuscatedExternalAccountId,
    raw.obfuscatedExternalProfileId, raw.developerPayload]) {
    assert.ok(!JSON.stringify(normalized).includes(secret));
  }
  assert.throws(() => { normalized.offerKey = 'bundle'; }, TypeError);
});

test('the registered bundle SKU must match its registered bundle purchase option', () => {
  const receipt = purchased();
  receipt.productLineItem[0].productId = 'soul_reading_bundle';
  receipt.productLineItem[0].productOfferDetails.purchaseOptionId = 'bundle';
  const expected = { ...context, productId: 'soul_reading_bundle', purchaseOptionId: 'bundle' };
  const result = normalizePlayPurchaseV2(receipt, expected, clock);
  assert.equal(result.offerKey, 'bundle');
  assert.equal(result.productId, 'soul_reading_bundle');
  assert.ok(Object.isFrozen(PLAY_PURCHASE_CATALOG));
  assert.ok(Object.isFrozen(PLAY_PURCHASE_CATALOG.soul_reading_bundle));
});

test('pending, cancelled and unspecified purchases cannot become paid entitlements', () => {
  for (const [state, code] of [
    ['PENDING', 'purchase_pending'],
    ['CANCELLED', 'purchase_cancelled'],
    ['PURCHASE_STATE_UNSPECIFIED', 'invalid_purchase_state'],
    ['purchased', 'invalid_purchase_state'],
    [0, 'invalid_purchase_state'],
    [undefined, 'invalid_purchase_state'],
  ]) {
    const receipt = purchased();
    receipt.purchaseStateContext.purchaseState = state;
    reject(receipt, code);
  }
});

test('missing or malformed response/state/line-item structures are rejected', () => {
  for (const raw of [null, [], 'PURCHASED', 1, {}, { purchaseStateContext: null }]) {
    reject(raw, 'invalid_play_purchase');
  }
  for (const items of [undefined, null, {}, [], [null], [[]], [purchased().productLineItem[0], purchased().productLineItem[0]]]) {
    const receipt = purchased();
    receipt.productLineItem = items;
    reject(receipt, 'invalid_purchase_line_items');
  }
});

test('wrong SKU, purchase option and prepared account/profile fail closed', () => {
  for (const productId of ['soul_reading_bundle', 'other', undefined, 1]) {
    const receipt = purchased();
    receipt.productLineItem[0].productId = productId;
    reject(receipt, 'purchase_product_mismatch');
  }
  for (const option of ['bundle', 'wrong', undefined, null, 1]) {
    const receipt = purchased();
    receipt.productLineItem[0].productOfferDetails.purchaseOptionId = option;
    reject(receipt, 'purchase_option_mismatch');
  }
  for (const field of ['obfuscatedExternalAccountId', 'obfuscatedExternalProfileId']) {
    for (const value of ['other-prepared-id', undefined, null, '', 1]) {
      const receipt = purchased();
      receipt[field] = value;
      reject(receipt, 'purchase_context_mismatch');
    }
  }
});

test('v2 quantity and refundable quantity have no invented missing-field default', () => {
  for (const quantity of [undefined, null, 0, 2, -1, 1.5, '1', true, NaN]) {
    const receipt = purchased();
    receipt.productLineItem[0].productOfferDetails.quantity = quantity;
    reject(receipt, 'invalid_purchase_quantity');
  }
  for (const refundableQuantity of [undefined, null, 2, -1, 1.5, '1', true, NaN]) {
    const receipt = purchased();
    receipt.productLineItem[0].productOfferDetails.refundableQuantity = refundableQuantity;
    reject(receipt, 'invalid_refundable_quantity');
  }
  const refunded = purchased();
  refunded.productLineItem[0].productOfferDetails.refundableQuantity = 0;
  reject(refunded, 'purchase_refunded');
});

test('rentals and preorders are never silently converted to permanent passes', () => {
  for (const property of ['rentOfferDetails', 'preorderOfferDetails']) {
    for (const value of [{}, null, undefined]) {
      const receipt = purchased();
      receipt.productLineItem[0].productOfferDetails[property] = value;
      reject(receipt, 'unsupported_purchase_offer');
    }
  }
  for (const details of [undefined, null, [], 'offer']) {
    const receipt = purchased();
    receipt.productLineItem[0].productOfferDetails = details;
    reject(receipt, 'invalid_purchase_offer_details');
  }
});

test('only supported acknowledgement/consumption enums are accepted', () => {
  for (const state of [undefined, null, 'CONSUMPTION_STATE_UNSPECIFIED', 'consumed', 0, 1]) {
    const receipt = purchased();
    receipt.productLineItem[0].productOfferDetails.consumptionState = state;
    reject(receipt, 'invalid_purchase_consumption_state');
  }
  for (const state of [undefined, null, 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED', 'acknowledged', 0, 1]) {
    const receipt = purchased();
    receipt.acknowledgementState = state;
    reject(receipt, 'invalid_purchase_acknowledgement_state');
  }
  const acknowledged = purchased();
  acknowledged.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  assert.equal(normalizePlayPurchaseV2(acknowledged, context, clock).acknowledgementState,
    'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');
});

test('consumed receipts replay only a durable known transaction', () => {
  const receipt = purchased();
  receipt.productLineItem[0].productOfferDetails.consumptionState = 'CONSUMPTION_STATE_CONSUMED';
  receipt.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  reject(receipt, 'unknown_consumed_purchase');
  const known = { ...context, knownTransaction: true };
  assert.equal(normalizePlayPurchaseV2(receipt, known, clock).consumptionState, 'CONSUMPTION_STATE_CONSUMED');
  receipt.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_PENDING';
  reject(receipt, 'inconsistent_purchase_finalization', known);
});

test('completion time validates calendar, timezone, nanoseconds and future bounds', () => {
  const receipt = purchased();
  for (const time of [undefined, null, 0, '', 'yesterday', '2026-02-30T11:59:00Z',
    '2026-13-01T11:59:00Z', '2026-10-27T24:00:00Z', '2026-10-27T11:59:60Z',
    '2026-10-27T11:59:00', '2026-10-27T11:59:00.1234567890Z',
    '2026-10-27T11:59:00+24:00', '1969-12-31T23:59:59Z',
    '2026-10-27T12:05:00.001Z']) {
    receipt.purchaseCompletionTime = time;
    reject(receipt, 'invalid_purchase_completion_time');
  }
  receipt.purchaseCompletionTime = '2026-10-27T20:59:00+09:00';
  assert.equal(normalizePlayPurchaseV2(receipt, context, clock).purchaseCompletionTime, '2026-10-27T11:59:00.000Z');
  receipt.purchaseCompletionTime = '2026-10-27T12:05:00Z';
  assert.equal(normalizePlayPurchaseV2(receipt, context, clock).purchaseCompletionTimeMillis, NOW + 300_000);
  receipt.purchaseCompletionTime = '2024-02-29T12:00:00Z';
  assert.equal(normalizePlayPurchaseV2(receipt, context, clock).purchaseCompletionTime, '2024-02-29T12:00:00.000Z');
});

test('order IDs are optional; malformed IDs and test context are not silently accepted', () => {
  assert.equal(normalizePlayPurchaseV2(purchased(), context, clock).testPurchase, false);
  const receipt = purchased();
  receipt.testPurchaseContext = { fopType: 'TEST' };
  assert.equal(normalizePlayPurchaseV2(receipt, context, clock).testPurchase, true);
  for (const testPurchaseContext of [null, [], {}, { fopType: 'FOP_TYPE_UNSPECIFIED' }, { fopType: 1 }]) {
    receipt.testPurchaseContext = testPurchaseContext;
    reject(receipt, 'invalid_test_purchase_context');
  }
  delete receipt.testPurchaseContext;
  for (const orderId of [null, '', 1, {}, 'order\nsecret', 'x'.repeat(257)]) {
    receipt.orderId = orderId;
    reject(receipt, 'invalid_purchase_order_id');
  }
});

test('trusted expected configuration is explicit, allowlisted and immutable', () => {
  const receipt = purchased();
  for (const invalid of [null, [], {},
    { ...context, packageName: 'not-a-package' },
    { ...context, productId: '__proto__' },
    { ...context, productId: 'unknown' },
    { ...context, purchaseOptionId: 'bundle' },
    { ...context, obfuscatedAccountId: '' },
    { ...context, obfuscatedAccountId: 'person@example.com' },
    { ...context, obfuscatedProfileId: 'x'.repeat(65) },
    { ...context, knownTransaction: undefined },
    { ...context, knownTransaction: 'true' },
  ]) reject(receipt, 'invalid_expected_purchase_context', invalid);
  const before = structuredClone(context);
  normalizePlayPurchaseV2(receipt, context, clock);
  assert.deepEqual(context, before);
});

test('validation clock rejects invalid configuration instead of disabling future checks', () => {
  for (const options of [null, [], { nowMs: null }, { nowMs: NaN }, { nowMs: -1 }, { nowMs: Infinity },
    { nowMs: 'now' }, { nowMs: NOW, maxFutureSkewMs: -1 },
    { nowMs: NOW, maxFutureSkewMs: null }, { nowMs: NOW, maxFutureSkewMs: Infinity },
    { nowMs: NOW, maxFutureSkewMs: 300_001 }]) {
    reject(purchased(), 'invalid_purchase_validation_clock', context, options);
  }
});

test('errors never retain or print receipt tokens, account identifiers or arbitrary fields', () => {
  const receipt = purchased();
  receipt.purchaseToken = 'sensitive-receipt-token';
  receipt.orderId = 'private-order';
  receipt.obfuscatedExternalProfileId = 'some-other-private-profile';
  try {
    normalizePlayPurchaseV2(receipt, context, clock);
    assert.fail('The mismatched prepared profile must fail');
  } catch (error) {
    assert.equal(error.code, 'purchase_context_mismatch');
    const printed = [String(error), error.stack, JSON.stringify(error)].join('\n');
    for (const sensitive of [receipt.purchaseToken, receipt.orderId,
      receipt.obfuscatedExternalProfileId, receipt.obfuscatedExternalAccountId]) {
      assert.ok(!printed.includes(sensitive));
    }
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
  }
});
