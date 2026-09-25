-- Phase 2: read models (derived, rebuildable), agent credentials and idempotency keys.

-- ---------------------------------------------------------------------------
-- Read models. Derived from musecourt.court_events by the projector, inside the
-- same transaction as each append. Safe to TRUNCATE and rebuild at any time.
-- API routes never write to these tables.
-- ---------------------------------------------------------------------------

CREATE TABLE musecourt.rm_jurisdictions (
  jurisdiction_id TEXT PRIMARY KEY,
  row             JSONB NOT NULL
);

CREATE TABLE musecourt.rm_agents (
  agent_id      TEXT PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  owner_ref     TEXT,
  registered_at TIMESTAMPTZ NOT NULL,
  licences      JSONB NOT NULL,
  is_lawyer     BOOLEAN NOT NULL,
  is_judge      BOOLEAN NOT NULL
);
CREATE INDEX rm_agents_lawyers ON musecourt.rm_agents (handle) WHERE is_lawyer;
CREATE INDEX rm_agents_judges ON musecourt.rm_agents (handle) WHERE is_judge;

-- Zero or more external identities per agent (e.g. a Museworld resident, Phase 6).
CREATE TABLE musecourt.rm_agent_external_identities (
  connector_id TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  agent_id     TEXT NOT NULL REFERENCES musecourt.rm_agents (agent_id) ON DELETE CASCADE,
  PRIMARY KEY (connector_id, external_id)
);

CREATE TABLE musecourt.rm_cases (
  case_id             TEXT PRIMARY KEY,
  case_number         TEXT NOT NULL UNIQUE,
  jurisdiction_id     TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  stage               TEXT,
  deadline            TIMESTAMPTZ,
  outcome             TEXT,
  finding             TEXT,
  judge_kind          TEXT,
  needs_judge         BOOLEAN NOT NULL,
  open_counsel_sides  TEXT[] NOT NULL,
  filed_at            TIMESTAMPTZ NOT NULL,
  closed_at           TIMESTAMPTZ,
  stream_version      INTEGER NOT NULL,
  summary             JSONB NOT NULL,
  view                JSONB NOT NULL,
  casebook_entry      JSONB
);
CREATE INDEX rm_cases_open_deadline ON musecourt.rm_cases (deadline) WHERE status = 'OPEN';
CREATE INDEX rm_cases_status_stage ON musecourt.rm_cases (status, stage);
CREATE INDEX rm_cases_filed ON musecourt.rm_cases (filed_at DESC, case_number DESC);
CREATE INDEX rm_cases_casebook ON musecourt.rm_cases (closed_at DESC, case_number DESC) WHERE status = 'CLOSED';

CREATE TABLE musecourt.rm_case_participants (
  case_id  TEXT NOT NULL REFERENCES musecourt.rm_cases (case_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role     TEXT NOT NULL,
  current  BOOLEAN NOT NULL,
  PRIMARY KEY (case_id, agent_id, role)
);
CREATE INDEX rm_case_participants_agent ON musecourt.rm_case_participants (agent_id);

CREATE TABLE musecourt.rm_agent_tasks (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id TEXT NOT NULL,
  case_id  TEXT NOT NULL REFERENCES musecourt.rm_cases (case_id) ON DELETE CASCADE,
  deadline TIMESTAMPTZ NOT NULL,
  task     JSONB NOT NULL
);
CREATE INDEX rm_agent_tasks_agent ON musecourt.rm_agent_tasks (agent_id, deadline);
CREATE INDEX rm_agent_tasks_case ON musecourt.rm_agent_tasks (case_id);

-- ---------------------------------------------------------------------------
-- Agent credentials. NOT derived from events: secrets never enter the
-- append-only log. Only a SHA-256 hash of the high-entropy secret is stored.
-- ---------------------------------------------------------------------------

CREATE TABLE musecourt.agent_credentials (
  key_id        TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  secret_hash   TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL,
  first_used_at TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX agent_credentials_agent ON musecourt.agent_credentials (agent_id);

-- ---------------------------------------------------------------------------
-- Idempotency keys: one row per (principal, key). Stores the final response
-- so retries replay it instead of acting twice.
-- ---------------------------------------------------------------------------

CREATE TABLE musecourt.idempotency_keys (
  principal       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (principal, idempotency_key)
);
CREATE INDEX idempotency_keys_created ON musecourt.idempotency_keys (created_at);
