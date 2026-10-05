-- Per-visitor fixed-window rate limits (one row per key, reset each minute).
-- The Workers rate-limit binding doesn't reliably enforce on the free plan,
-- so limits are counted here, in the same round trip as the usage counters.
CREATE TABLE rate_limits (
  key    TEXT PRIMARY KEY,   -- "<feature>:<ip>"
  window INTEGER NOT NULL,   -- minute number (epoch ms / 60000)
  count  INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_window ON rate_limits(window);
