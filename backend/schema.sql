-- ============================================================
-- cycles
-- ============================================================
-- Stores the race timeline.
--
-- Notes:
-- - Each row represents one cycle record.
-- - idle is a waiting state before a race starts.
-- - voting/finalizing/boost are active race states.
-- - cycle_number = 0 means idle.
-- - winner_car_id is only set for boost state after winner selection.

CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  race_id INTEGER NOT NULL,
  cycle_number INTEGER NOT NULL,

  -- Restrict state values so bad data cannot be inserted accidentally.
  state TEXT NOT NULL CHECK (state IN ('idle', 'voting', 'finalizing', 'boost')),

  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,

  -- Null until a winning car is decided.
  winner_car_id TEXT
);

-- ============================================================
-- vote_intents
-- ============================================================
-- Stores temporary vote intents before a vote is fully confirmed.
--
-- Why this exists:
-- - lets the frontend begin a vote flow cleanly
-- - gives the backend a record to verify against later
-- - helps bind wallet + car + cycle together
--
-- status meanings:
-- - created   = active intent waiting for submission
-- - confirmed = successfully used
-- - rejected  = failed verification or blocked
-- - expired   = too old to use

CREATE TABLE IF NOT EXISTS vote_intents (
  id TEXT PRIMARY KEY,

  -- Which cycle this intent belongs to.
  cycle_id INTEGER NOT NULL,

  -- Wallet that created this intent.
  wallet TEXT NOT NULL,

  -- Car chosen for this intent.
  car_id TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('created', 'confirmed', 'rejected', 'expired')),

  -- ISO timestamp of intent creation.
  created_at TEXT NOT NULL,

  -- Foreign key gives referential integrity back to cycles.
  FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

-- ============================================================
-- votes
-- ============================================================
-- Stores confirmed votes only.
--
-- This table is your final source of truth for vote counting.
--
-- Important constraints:
-- - UNIQUE(cycle_id, wallet)
--   => one confirmed vote per wallet per cycle
--
-- - UNIQUE(tx_signature)
--   => prevents the same tx from being counted twice
--      once you switch to real chain verification

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Which cycle the vote belongs to.
  cycle_id INTEGER NOT NULL,

  -- Wallet that cast the vote.
  wallet TEXT NOT NULL,

  -- Car the vote applies to.
  car_id TEXT NOT NULL,

  -- Signature fields are kept as text for now.
  -- In demo mode these are mock strings.
  -- Later they should be real Solana-related values.
  tx_signature TEXT,
  message_signature TEXT,

  -- For now only confirmed votes are stored here.
  status TEXT NOT NULL CHECK (status IN ('confirmed')),

  created_at TEXT NOT NULL,

  -- Hard stop: one vote per wallet per cycle.
  UNIQUE(cycle_id, wallet),

  -- Helps stop replay of the same tx later.
  UNIQUE(tx_signature),

  FOREIGN KEY (cycle_id) REFERENCES cycles(id)
);

-- ============================================================
-- INDEXES
-- ============================================================
-- These improve lookup speed for common queries.

-- Useful when checking whether a wallet already has an active intent in a cycle.
CREATE INDEX IF NOT EXISTS idx_vote_intents_cycle_wallet
  ON vote_intents (cycle_id, wallet);

-- Useful for cycle result queries and winner calculation.
CREATE INDEX IF NOT EXISTS idx_votes_cycle_status
  ON votes (cycle_id, status);