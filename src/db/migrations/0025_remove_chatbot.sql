-- The auto-reply chatbot feature (src/chatbot.ts, migration 0004) has been
-- removed: inbound "question"/"unknown" replies always escalate to a human
-- now, on every channel including the chat widget. Drops exactly the 3
-- columns that only ever backed that feature.
--
-- NOT touched: messages.kind (also added by 0004, but general-purpose —
-- still used for closer/appointment_reminder/win_back/manual_reply, and its
-- "auto_reply" value is kept in the TypeScript type so historical rows still
-- read back correctly) and leads.chat_token_hash (added by 0020, the chat
-- widget's own session-token column, unrelated to auto-reply).
ALTER TABLE tenants DROP COLUMN IF EXISTS knowledge_base;
ALTER TABLE tenants DROP COLUMN IF EXISTS auto_reply_enabled;
ALTER TABLE tenants DROP COLUMN IF EXISTS bot_disclosure_enabled;
