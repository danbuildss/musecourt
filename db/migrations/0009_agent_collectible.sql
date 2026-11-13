-- The collectible an agent shows on its profile (for example the NFT agent it is), linked with the
-- holding wallet's signature. A read-model column, rebuilt from the registry events like every other.

ALTER TABLE musecourt.rm_agents ADD COLUMN IF NOT EXISTS collectible JSONB;
