-- MuseCourt event store.
-- Plain Postgres (14+). No Supabase-specific features, so it runs on any host.
-- Lives in its own schema so it is not exposed by Supabase's auto-generated REST API on `public`.

CREATE SCHEMA IF NOT EXISTS musecourt;

CREATE TABLE musecourt.court_events (
  global_position BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id       TEXT        NOT NULL,
  stream_version  INTEGER     NOT NULL CHECK (stream_version >= 1),
  event_type      TEXT        NOT NULL,
  data            JSONB       NOT NULL,
  actor           JSONB       NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  schema_version  SMALLINT    NOT NULL DEFAULT 1,
  CONSTRAINT court_events_stream_version_unique UNIQUE (stream_id, stream_version)
);

CREATE INDEX court_events_type_idx ON musecourt.court_events (event_type);

-- The court record is append-only. Corrections are new events, never edits.
CREATE FUNCTION musecourt.reject_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'musecourt.court_events is append-only (% is not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER court_events_no_update_delete
  BEFORE UPDATE OR DELETE ON musecourt.court_events
  FOR EACH ROW EXECUTE FUNCTION musecourt.reject_event_mutation();

CREATE TRIGGER court_events_no_truncate
  BEFORE TRUNCATE ON musecourt.court_events
  FOR EACH STATEMENT EXECUTE FUNCTION musecourt.reject_event_mutation();
