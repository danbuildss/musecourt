-- Operational, not court record: when Solon last failed to rule on a case, so a failing model
-- is retried about once an hour instead of on every clock run. A failed draft is not a court fact.
CREATE TABLE musecourt.solon_attempts (
  case_id   TEXT PRIMARY KEY,
  failed_at TIMESTAMPTZ NOT NULL
);
