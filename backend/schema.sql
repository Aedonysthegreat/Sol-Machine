CREATE TABLE IF NOT EXISTS cycles (
  id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  winner_car_id TEXT
);

CREATE TABLE IF NOT EXISTS vote_intents (
  id TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  car_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  car_id TEXT NOT NULL,
  tx_signature TEXT,
  message_signature TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(cycle_id, wallet)
);