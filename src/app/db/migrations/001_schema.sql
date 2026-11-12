-- Every table that holds a fund manager's data carries tenant_id, and every query the
-- service runs filters on it. Money is BIGINT cents. Dates are DATE.

CREATE TABLE funds (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  tenant_id     VARCHAR(64)  NOT NULL,
  code          VARCHAR(8)   NOT NULL,
  name          VARCHAR(200) NOT NULL,
  currency      CHAR(3)      NOT NULL,
  account_iban  VARCHAR(34)  NOT NULL,
  eq_rate_bps   INT          NOT NULL,
  eq_interest_to ENUM('rebalanced_investors','fund') NOT NULL,
  pref_bps      INT          NOT NULL,
  carry_bps     INT          NOT NULL,
  min_ticket    BIGINT       NOT NULL,
  max_ticket    BIGINT       NOT NULL,
  notice_days   INT          NOT NULL,
  grace_days    INT          NOT NULL,
  last_event_date DATE       NULL,
  waterfall_state TEXT       NULL,
  contributed_calls INT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_fund_code (tenant_id, code),
  UNIQUE KEY uq_fund_account (account_iban)
);

CREATE TABLE investors (
  id         VARCHAR(36)  NOT NULL PRIMARY KEY,
  tenant_id  VARCHAR(64)  NOT NULL,
  fund_id    VARCHAR(36)  NOT NULL,
  number     INT          NOT NULL,
  name       VARCHAR(200) NOT NULL,
  email      VARCHAR(200) NOT NULL,
  iban       VARCHAR(34)  NOT NULL,
  defaulted  BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_investor_number (fund_id, number),
  KEY ix_investor_iban (fund_id, iban),
  CONSTRAINT fk_investor_fund FOREIGN KEY (fund_id) REFERENCES funds(id)
);

CREATE TABLE closings (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id  VARCHAR(64) NOT NULL,
  fund_id    VARCHAR(36) NOT NULL,
  number     INT         NOT NULL,
  close_date DATE        NOT NULL,
  interest_to_fund BIGINT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_closing_number (fund_id, number),
  CONSTRAINT fk_closing_fund FOREIGN KEY (fund_id) REFERENCES funds(id)
);

CREATE TABLE commitments (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  fund_id     VARCHAR(36) NOT NULL,
  investor_id VARCHAR(36) NOT NULL,
  closing_id  VARCHAR(36) NOT NULL,
  amount      BIGINT      NOT NULL,
  document_id VARCHAR(36) NULL,
  UNIQUE KEY uq_commitment (closing_id, investor_id),
  KEY ix_commitment_fund (fund_id, investor_id),
  CONSTRAINT fk_commitment_investor FOREIGN KEY (investor_id) REFERENCES investors(id),
  CONSTRAINT fk_commitment_closing FOREIGN KEY (closing_id) REFERENCES closings(id)
);

CREATE TABLE calls (
  id        VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  fund_id   VARCHAR(36) NOT NULL,
  number    INT         NOT NULL,
  call_date DATE        NOT NULL,
  due_date  DATE        NOT NULL,
  amount    BIGINT      NOT NULL,
  purpose   VARCHAR(40) NOT NULL,
  UNIQUE KEY uq_call_number (fund_id, number),
  CONSTRAINT fk_call_fund FOREIGN KEY (fund_id) REFERENCES funds(id)
);

-- Each investor's current share of each call. Equalisation rewrites these rows;
-- share_changes keeps every rewrite.
CREATE TABLE call_shares (
  call_id     VARCHAR(36) NOT NULL,
  investor_id VARCHAR(36) NOT NULL,
  tenant_id   VARCHAR(64) NOT NULL,
  fund_id     VARCHAR(36) NOT NULL,
  amount      BIGINT      NOT NULL,
  PRIMARY KEY (call_id, investor_id),
  KEY ix_share_fund (fund_id, investor_id)
);

CREATE TABLE share_changes (
  id                BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id         VARCHAR(64) NOT NULL,
  fund_id           VARCHAR(36) NOT NULL,
  closing_id        VARCHAR(36) NOT NULL,
  call_id           VARCHAR(36) NOT NULL,
  investor_id       VARCHAR(36) NOT NULL,
  delta             BIGINT      NOT NULL,
  interest_paid     BIGINT      NOT NULL,
  interest_received BIGINT      NOT NULL,
  KEY ix_change_closing (closing_id)
);

-- Money the fund owes an investor and nets against their next notice:
-- rebalancing credits and equalisation interest from closings. Uses are negative rows.
CREATE TABLE credits (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  fund_id     VARCHAR(36) NOT NULL,
  investor_id VARCHAR(36) NOT NULL,
  kind        ENUM('rebalancing','interest','applied') NOT NULL,
  amount      BIGINT      NOT NULL,
  source_id   VARCHAR(36) NOT NULL,
  KEY ix_credit_investor (fund_id, investor_id)
);

CREATE TABLE notices (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  fund_id        VARCHAR(36) NOT NULL,
  investor_id    VARCHAR(36) NOT NULL,
  kind           ENUM('call','catch_up','distribution','reminder') NOT NULL,
  source_id      VARCHAR(36) NOT NULL,
  reference      VARCHAR(25) NULL,
  gross          BIGINT      NOT NULL,
  interest       BIGINT      NOT NULL DEFAULT 0,
  credit_applied BIGINT      NOT NULL DEFAULT 0,
  amount_due     BIGINT      NOT NULL,
  paid           BIGINT      NOT NULL DEFAULT 0,
  due_date       DATE        NULL,
  status         ENUM('open','paid','defaulted','info') NOT NULL,
  issued_on      DATE        NOT NULL,
  UNIQUE KEY uq_notice_reference (reference),
  UNIQUE KEY uq_notice_source (source_id, investor_id, kind),
  KEY ix_notice_open (fund_id, status, due_date)
);

-- A message is written here in the same transaction as the notice it carries, and
-- only marked sent when the provider confirms it.
CREATE TABLE outbox (
  id              BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL,
  notice_id       VARCHAR(36) NOT NULL,
  channel         ENUM('email') NOT NULL,
  recipient       VARCHAR(200) NOT NULL,
  subject         VARCHAR(300) NOT NULL,
  body            TEXT        NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  status          ENUM('pending','confirmed','failed') NOT NULL DEFAULT 'pending',
  -- 'ambiguous' means a send may have reached the provider; the provider is asked
  -- before anything is sent again.
  last_outcome    ENUM('none','not_sent','ambiguous') NOT NULL DEFAULT 'none',
  lease_until     DATETIME(3) NULL,
  attempts        INT         NOT NULL DEFAULT 0,
  provider_id     VARCHAR(100) NULL,
  last_error      VARCHAR(300) NULL,
  UNIQUE KEY uq_outbox_key (idempotency_key),
  KEY ix_outbox_status (status, lease_until)
);

CREATE TABLE bank_entries (
  id             BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL,
  fund_id        VARCHAR(36) NOT NULL,
  entry_ref      VARCHAR(80) NOT NULL,
  statement_id   VARCHAR(80) NOT NULL,
  amount         BIGINT      NOT NULL,
  currency       CHAR(3)     NOT NULL,
  booking_date   DATE        NOT NULL,
  debtor_iban    VARCHAR(34) NULL,
  debtor_name    VARCHAR(200) NULL,
  structured_ref VARCHAR(40) NULL,
  unstructured   VARCHAR(500) NULL,
  match_kind     VARCHAR(30) NOT NULL,
  notice_id      VARCHAR(36) NULL,
  applied        BIGINT      NOT NULL DEFAULT 0,
  unapplied      BIGINT      NOT NULL DEFAULT 0,
  review_reason  VARCHAR(200) NULL,
  status         ENUM('applied','review','ignored','resolved') NOT NULL,
  UNIQUE KEY uq_entry (fund_id, entry_ref),
  KEY ix_entry_status (fund_id, status)
);

CREATE TABLE distributions (
  id        VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  fund_id   VARCHAR(36) NOT NULL,
  number    INT         NOT NULL,
  dist_date DATE        NOT NULL,
  amount    BIGINT      NOT NULL,
  to_investors BIGINT   NOT NULL,
  to_gp     BIGINT      NOT NULL,
  tiers     TEXT        NOT NULL,
  UNIQUE KEY uq_distribution_number (fund_id, number)
);

CREATE TABLE documents (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  tenant_id   VARCHAR(64) NOT NULL,
  fund_id     VARCHAR(36) NOT NULL,
  content_sha CHAR(64)    NOT NULL,
  body        MEDIUMTEXT  NOT NULL,
  fields      TEXT        NOT NULL,
  problems    TEXT        NOT NULL,
  status      ENUM('accepted','review','resolved','used') NOT NULL,
  resolved_by VARCHAR(100) NULL,
  UNIQUE KEY uq_document (fund_id, content_sha)
);

CREATE TABLE idempotency (
  tenant_id    VARCHAR(64)  NOT NULL,
  idem_key     VARCHAR(100) NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  status_code  INT          NULL,
  response     MEDIUMTEXT   NULL,
  PRIMARY KEY (tenant_id, idem_key)
);

CREATE TABLE schema_migrations (
  name VARCHAR(100) NOT NULL PRIMARY KEY
);
