// Fixed operational metadata only. This table never authorizes an entitlement.
export const OPERATIONAL_ROUTES = Object.freeze(['entitlements', 'prepare', 'verify', 'topic']);
export const OPERATIONAL_STAGES = Object.freeze(['authentication', 'rate_limit', 'ledger', 'purchase_verify', 'topic_select']);
export const OPERATIONAL_CODES = Object.freeze([
  'authentication_invalid', 'authentication_required', 'authentication_unavailable',
  'billing_rate_limited', 'billing_storage_failed', 'configuration_required',
  'google_configuration_required', 'invalid_cursor', 'invalid_entitlement', 'invalid_product',
  'invalid_purchase_context', 'invalid_purchase_token', 'invalid_receipt', 'invalid_request',
  'invalid_topic', 'ledger_changed', 'play_permission_denied', 'play_purchase_expired',
  'play_purchase_not_found', 'play_rate_limited', 'play_unavailable',
  'purchase_context_mismatch', 'purchase_pending', 'purchase_revoked', 'topic_already_selected',
]);
export const OPERATIONAL_STATUSES = Object.freeze([400, 401, 403, 404, 409, 429, 503]);
const MINUTE_MS = 60_000;
const FAILURE_TTL_MS = 10 * MINUTE_MS;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - MINUTE_MS;
const empty = () => ({ databaseSchema: false, lastFailures: [] });

export function isOperationalFailure(value) {
  if (!record(value) || !OPERATIONAL_ROUTES.includes(value.route)
      || !OPERATIONAL_STAGES.includes(value.stage) || !OPERATIONAL_CODES.includes(value.code)
      || !OPERATIONAL_STATUSES.includes(value.status)) return false;
  return ['authentication', 'rate_limit'].includes(value.stage)
    || (value.stage === 'ledger' && ['entitlements', 'prepare'].includes(value.route))
    || (value.stage === 'purchase_verify' && value.route === 'verify')
    || (value.stage === 'topic_select' && value.route === 'topic');
}

export async function recordOperationalFailure(env, failure, nowMs = Date.now()) {
  try {
    if (!isOperationalFailure(failure) || !validTime(nowMs)) return false;
    // Round upward so the persisted minute cannot permit two writes less than
    // 60 seconds apart, including requests on opposite sides of a minute boundary.
    const updatedMs = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS;
    const result = await env.DB.prepare(`INSERT INTO operational_failures(route,stage,code,status,updated_ms)
      VALUES(?,?,?,?,?) ON CONFLICT(route) DO UPDATE SET stage=excluded.stage,code=excluded.code,
      status=excluded.status,updated_ms=excluded.updated_ms
      WHERE operational_failures.updated_ms<=?`).bind(
      failure.route, failure.stage, failure.code, failure.status, updatedMs, nowMs - MINUTE_MS).run();
    return result?.success === true && result.meta?.changes === 1;
  } catch { return false; }
}

// One bounded read examines known schema columns, the refund singleton, and
// at most four diagnostic rows. It reads no account, purchase, or receipt rows.
const READ_DIAGNOSTICS = `WITH schema_probe AS (
  SELECT r.user_id,r.action,r.minute,r.count,u.user_id,u.revision,
    p.user_id,p.request_id,p.status,p.entitlement_id,i.user_id,i.request_id,i.account_id,i.profile_id,
    t.token_hash,t.voided_at_ms,s.singleton,s.watermark_ms,s.coverage_start_ms,s.last_completed_ms,
    s.range_start_ms,s.range_end_ms,s.page_token,s.lease_owner,s.lease_until_ms
  FROM rate_limits r CROSS JOIN user_revisions u CROSS JOIN purchases p
    CROSS JOIN purchase_intents i CROSS JOIN refund_tombstones t CROSS JOIN refund_sync s WHERE 0)
  SELECT ((SELECT COUNT(*) FROM schema_probe)=0
    AND EXISTS(SELECT 1 FROM refund_sync WHERE singleton=1)) AS database_schema,
    f.route,f.stage,f.code,f.status,f.updated_ms
  FROM (SELECT 1) LEFT JOIN operational_failures f ON 1=1 ORDER BY f.route LIMIT 4`;

export async function readOperationalDiagnostics(env, nowMs = Date.now()) {
  try {
    if (!validTime(nowMs)) return empty();
    const result = await env.DB.prepare(READ_DIAGNOSTICS).all();
    if (result?.success !== true || !Array.isArray(result.results)
        || result.results.length < 1 || result.results.length > 4) return empty();
    const lastFailures = [];
    const seen = new Set();
    for (const row of result.results) {
      if (!isOperationalFailure(row) || !validTime(row.updated_ms)
          || row.updated_ms % MINUTE_MS !== 0
          || row.updated_ms > Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS
          // Upward minute rounding retains a failure for at most 11 minutes.
          || row.updated_ms < nowMs - FAILURE_TTL_MS || seen.has(row.route)) continue;
      seen.add(row.route);
      lastFailures.push({ route: row.route, stage: row.stage, code: row.code, status: row.status });
    }
    return { databaseSchema: result.results.every(row => record(row) && row.database_schema === 1), lastFailures };
  } catch { return empty(); }
}
