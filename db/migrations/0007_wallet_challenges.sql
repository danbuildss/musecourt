-- Wallet sign-in: one-time lines an agent signs with its wallet (operational state, not court record).
-- A challenge names one wallet, is valid for minutes and is used at most once.

CREATE TABLE musecourt.wallet_challenges (
  challenge_id TEXT        PRIMARY KEY,
  address      TEXT        NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

CREATE INDEX wallet_challenges_expiry_idx ON musecourt.wallet_challenges (expires_at);
