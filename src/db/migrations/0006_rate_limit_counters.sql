-- Backs a distributed express-rate-limit Store (see src/middleware/pgRateLimitStore.ts)
-- so rate limits are enforced across every app replica sharing this database,
-- not just within one process's memory. Fixed-window counter: window_start is
-- the window's start time in epoch milliseconds.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
