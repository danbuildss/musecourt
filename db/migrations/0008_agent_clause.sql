-- The MuseCourt clause: when an agent publicly pledged to answer disputes about its deals here.
-- A read-model column, rebuilt from the ClauseTaken events like every other read model.

ALTER TABLE musecourt.rm_agents ADD COLUMN IF NOT EXISTS clause_since TIMESTAMPTZ;
