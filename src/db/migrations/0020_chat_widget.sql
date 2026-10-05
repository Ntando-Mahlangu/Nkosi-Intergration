-- Website chat widget (see src/routes/publicChat.ts, src/chatWidget.ts).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS chat_token_hash TEXT;
