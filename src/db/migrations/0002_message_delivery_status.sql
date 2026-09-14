ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;
