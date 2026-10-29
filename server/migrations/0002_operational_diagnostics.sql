-- Four fixed diagnostic slots; no account or purchase data and no grant authority.
CREATE TABLE IF NOT EXISTS operational_failures (
  route TEXT PRIMARY KEY NOT NULL CHECK(route IN ('entitlements','prepare','verify','topic')),
  stage TEXT NOT NULL CHECK(stage IN ('authentication','rate_limit','ledger','purchase_verify','topic_select')),
  code TEXT NOT NULL CHECK(code IN (
    'authentication_invalid','authentication_required','authentication_unavailable',
    'billing_rate_limited','billing_storage_failed','configuration_required',
    'google_configuration_required','invalid_cursor','invalid_entitlement','invalid_product',
    'invalid_purchase_context','invalid_purchase_token','invalid_receipt','invalid_request',
    'invalid_topic','ledger_changed','play_permission_denied','play_purchase_expired',
    'play_purchase_not_found','play_rate_limited','play_unavailable',
    'purchase_context_mismatch','purchase_pending','purchase_revoked','topic_already_selected')),
  status INTEGER NOT NULL CHECK(status IN (400,401,403,404,409,429,503)),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms)='integer' AND updated_ms>=0 AND updated_ms%60000=0),
  CHECK(stage IN ('authentication','rate_limit')
    OR (stage='ledger' AND route IN ('entitlements','prepare'))
    OR (stage='purchase_verify' AND route='verify')
    OR (stage='topic_select' AND route='topic'))
);
