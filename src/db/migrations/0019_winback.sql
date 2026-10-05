-- Win-back messaging for converted leads who explicitly opted in (see
-- src/winback.ts, COMPLIANCE.md "Win-back messaging for past customers").
ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_win_back_at TIMESTAMPTZ;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS win_back_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS win_back_cooldown_days INT;
