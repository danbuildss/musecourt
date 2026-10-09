-- Phase 6: one-time challenges for linking a world identity (operational state, not court record).
-- A challenge is issued to one agent for one connector, is valid for minutes and is used at most once.

CREATE TABLE musecourt.world_identity_challenges (
  nonce        TEXT        PRIMARY KEY,
  agent_id     TEXT        NOT NULL,
  connector_id TEXT        NOT NULL,
  audience     TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

CREATE INDEX world_identity_challenges_expiry_idx ON musecourt.world_identity_challenges (expires_at);
