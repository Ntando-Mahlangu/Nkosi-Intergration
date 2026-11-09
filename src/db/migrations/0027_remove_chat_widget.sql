-- The embeddable website chat widget (src/chatWidget.ts, src/routes/
-- publicChat.ts, public/chat-widget.js) has been removed entirely. Drops
-- its one dedicated column, added by migration 0020 and explicitly spared
-- by 0025's chatbot cleanup (0025's own comment: "unrelated to auto-reply").
--
-- NOT touched: leads.source and messages.channel can still hold the literal
-- value "chat" — those are kept in the TypeScript types (see types.ts's own
-- comments) purely so a lead or message created by the widget before this
-- removal still reads back correctly. Nothing can produce a new one.
ALTER TABLE leads DROP COLUMN IF EXISTS chat_token_hash;
