-- Phase 6 M2: takedown propagation for world evidence.

-- Derived (read model): until when a case's unredacted world evidence is re-checked for takedowns.
ALTER TABLE musecourt.rm_cases ADD COLUMN world_recheck_until TIMESTAMPTZ;
CREATE INDEX rm_cases_world_recheck ON musecourt.rm_cases (world_recheck_until)
  WHERE world_recheck_until IS NOT NULL;

-- Operational, not court record: when the court last re-checked a case's world evidence.
-- A re-check that finds nothing is not a court fact, so it never enters the event log.
CREATE TABLE musecourt.world_evidence_checks (
  case_id    TEXT PRIMARY KEY,
  checked_at TIMESTAMPTZ NOT NULL
);
