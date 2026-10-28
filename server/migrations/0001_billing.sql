PRAGMA foreign_keys = ON;

CREATE TABLE purchase_intents (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reading_id TEXT NOT NULL,
  product_id TEXT NOT NULL CHECK(product_id IN ('soul_reading_single','soul_reading_bundle')),
  offer_key TEXT NOT NULL CHECK(offer_key IN ('single','bundle')),
  account_id TEXT NOT NULL,
  profile_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(user_id, request_id),
  CHECK((product_id='soul_reading_single' AND offer_key='single') OR
        (product_id='soul_reading_bundle' AND offer_key='bundle'))
);

CREATE TABLE purchases (
  token_hash TEXT PRIMARY KEY,
  encrypted_token TEXT NOT NULL,
  entitlement_id TEXT NOT NULL UNIQUE,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reading_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  offer_key TEXT NOT NULL CHECK(offer_key IN ('single','bundle')),
  topic TEXT CHECK(topic IN ('love','chance','work','bond')),
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  ack_pending INTEGER NOT NULL CHECK(ack_pending IN (0,1)),
  last_ack_attempt_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  last_verified_ms INTEGER NOT NULL,
  UNIQUE(user_id, request_id),
  FOREIGN KEY(user_id, request_id) REFERENCES purchase_intents(user_id, request_id),
  CHECK(offer_key='single' OR topic IS NULL)
);
CREATE INDEX purchases_owner_page ON purchases(user_id, status, entitlement_id);
CREATE INDEX purchases_finalization ON purchases(ack_pending, status, last_ack_attempt_ms, created_at_ms);

CREATE TABLE user_revisions (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 0)
);
CREATE TRIGGER purchases_insert_revision AFTER INSERT ON purchases BEGIN
  INSERT INTO user_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER purchases_change_revision AFTER UPDATE OF status,topic ON purchases
WHEN NEW.status IS NOT OLD.status OR NEW.topic IS NOT OLD.topic BEGIN
  INSERT INTO user_revisions(user_id,revision) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER purchases_immutable BEFORE UPDATE ON purchases
WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.encrypted_token IS NOT OLD.encrypted_token
  OR NEW.entitlement_id IS NOT OLD.entitlement_id OR NEW.transaction_id IS NOT OLD.transaction_id
  OR NEW.user_id IS NOT OLD.user_id OR NEW.request_id IS NOT OLD.request_id
  OR NEW.reading_id IS NOT OLD.reading_id OR NEW.product_id IS NOT OLD.product_id
  OR NEW.offer_key IS NOT OLD.offer_key OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR (OLD.status='revoked' AND NEW.status!='revoked')
  OR (OLD.topic IS NOT NULL AND NEW.topic IS NOT OLD.topic)
BEGIN SELECT RAISE(ABORT, 'immutable purchase'); END;
CREATE TRIGGER intents_immutable BEFORE UPDATE ON purchase_intents
BEGIN SELECT RAISE(ABORT, 'immutable purchase intent'); END;

CREATE TABLE refund_tombstones (
  token_hash TEXT PRIMARY KEY,
  voided_at_ms INTEGER NOT NULL
);
CREATE TRIGGER purchases_reject_voided BEFORE INSERT ON purchases
WHEN EXISTS(SELECT 1 FROM refund_tombstones WHERE token_hash=NEW.token_hash)
BEGIN SELECT RAISE(IGNORE); END;

CREATE TABLE refund_sync (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  watermark_ms INTEGER NOT NULL DEFAULT 0,
  coverage_start_ms INTEGER NOT NULL DEFAULT 0,
  last_completed_ms INTEGER NOT NULL DEFAULT 0,
  range_start_ms INTEGER,
  range_end_ms INTEGER,
  page_token TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO refund_sync(singleton) VALUES(1);
CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  minute INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(user_id, action, minute)
);
