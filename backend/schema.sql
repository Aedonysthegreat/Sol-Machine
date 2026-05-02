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
  state TEXT NOT NULL CHECK (state IN ('idle', 'starting', 'voting', 'finalizing', 'boost')),

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
-- bets
-- ============================================================
-- Stores one betting record per wallet per race.
--
-- Bet types:
-- - winner   = user picks one car to win
-- - trifecta = user picks exact 1st / 2nd / 3rd order
--
-- Security:
-- - one wallet can only place one bet per race
-- - payout multiplier is stored at bet creation time
-- - frontend does not decide payout
-- - frontend does not decide boost access

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,

  race_id INTEGER NOT NULL,
  cycle_id INTEGER NOT NULL,

  wallet TEXT NOT NULL,

  -- winner or trifecta
  bet_type TEXT NOT NULL CHECK (bet_type IN ('winner', 'trifecta')),

  -- Used for winner bets.
  -- For trifecta bets, this should match trifecta_first_car_id
  -- so older frontend/HUD logic can still show a primary backed car.
  car_id TEXT NOT NULL,

  -- Used for trifecta exact order.
  -- For winner bets these can be null.
  trifecta_first_car_id TEXT,
  trifecta_second_car_id TEXT,
  trifecta_third_car_id TEXT,

  token_symbol TEXT NOT NULL,
  stake_amount INTEGER NOT NULL,

  payout_multiplier REAL NOT NULL,
  potential_payout INTEGER NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('pending_payment', 'confirmed', 'won', 'lost', 'refunded', 'void')
  ),

  payment_tx_signature TEXT UNIQUE,
  message_signature TEXT,

  created_at TEXT NOT NULL,
  settled_at TEXT,
  refunded_at TEXT,

  FOREIGN KEY (cycle_id) REFERENCES cycles(id),

  UNIQUE (race_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_bets_race_status
  ON bets (race_id, status);

CREATE INDEX IF NOT EXISTS idx_bets_wallet
  ON bets (wallet);

-- ============================================================
-- race_boost_balances
-- ============================================================
-- Internal website boost-token balance.
--
-- These are NOT crypto tokens.
-- These are temporary race-specific voting credits.
--
-- Security:
-- - backend is source of truth
-- - tokens are tied to race + wallet + bet
-- - tokens cannot transfer between races
-- - users cannot buy more race-control power
-- - tokens expire after race

CREATE TABLE IF NOT EXISTS race_boost_balances (
  race_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  bet_id TEXT NOT NULL,

  tokens_granted INTEGER NOT NULL DEFAULT 3,
  tokens_spent INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'active', 'expired', 'void')
  ),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  PRIMARY KEY (race_id, wallet),

  FOREIGN KEY (bet_id) REFERENCES bets(id)
);

CREATE INDEX IF NOT EXISTS idx_race_boost_balances_bet
  ON race_boost_balances (bet_id);

CREATE INDEX IF NOT EXISTS idx_race_boost_balances_status
  ON race_boost_balances (race_id, status);

-- ============================================================
-- race_results
-- ============================================================
-- Stores official final race results received from the external
-- car/race backend.
--
-- Important:
-- - This betting backend does NOT decide the race winner.
-- - The external race backend/admin system submits the result.
-- - Once a result is recorded, confirmed bets can be settled.
--
-- status meanings:
-- - completed = race finished normally and has a winning car
-- - cancelled = race was cancelled and bets should be refunded
-- - invalid   = race result should not count and bets should be refunded

CREATE TABLE IF NOT EXISTS race_results (
  race_id INTEGER PRIMARY KEY,

  -- Winner-only result support.
  winning_car_id TEXT,

  -- Full finishing order support for trifecta.
  first_car_id TEXT,
  second_car_id TEXT,
  third_car_id TEXT,

  status TEXT NOT NULL CHECK (status IN ('completed', 'cancelled', 'invalid')),

  source TEXT NOT NULL,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_race_results_status
  ON race_results (status);

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