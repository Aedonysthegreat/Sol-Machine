import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import db from "./db.js";

/*
  ------------------------------------------------------------
  BASIC APP SETUP
  ------------------------------------------------------------
*/

const app = express();

// Port can be set from the environment later.
// Falls back to 3001 for local testing.
const PORT = Number(process.env.PORT || 3001);

// Environment flags.
// NODE_ENV lets us behave differently in dev vs production.
const NODE_ENV = process.env.NODE_ENV || "development";

// Allowed frontend origin for production CORS.
// In development we allow broader access for convenience.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5500";

// Optional admin token.
// If this is set, the reset endpoint requires it.
// If not set and you are in development, reset remains easy to use.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Demo mode keeps your current mock flow working.
// When DEMO_MODE is true, vote verification is stubbed and always passes.
// Later, when Solana is added, this can be set to false and the
// verification function can do real on-chain checks.
const DEMO_MODE = process.env.DEMO_MODE !== "false";

/*
  ------------------------------------------------------------
  TIMING / GAME RULES
  ------------------------------------------------------------
*/

const STARTING_DURATION_MS = 20 * 1000;
const VOTING_DURATION_MS = 20 * 1000;
const FINALIZING_DURATION_MS = 3 * 1000;
const BOOST_DURATION_MS = 10 * 1000;

// Number of boost cycles per race before returning to idle.
const CYCLES_PER_RACE = 3;

// How long a vote intent stays valid before expiring.
// This stops old intents being reused long after they were created.
const INTENT_EXPIRY_MS = 2 * 60 * 1000;

/*
  ------------------------------------------------------------
  ALLOWED CAR IDS
  ------------------------------------------------------------
  This prevents random garbage values being submitted as car IDs.
  Update this set if you add more cars.
*/

const ALLOWED_CARS = new Set(["Car 1", "Car 2", "Car 3"]);

/*
  ------------------------------------------------------------
  BETTING RULES
  ------------------------------------------------------------
  These define the first betting version:
  - one token only
  - preset stake sizes only
  - fixed payout multiplier
*/

const TOKEN_SYMBOL = "YOURTOKEN";

// Preset bet sizes users are allowed to place.
// Adjust these later to match your actual token design.
const ALLOWED_BET_AMOUNTS = new Set([1, 5, 10]);

// Fixed payout multiplier for now.
// Example: stake 5 tokens -> potential payout 10 tokens.
const FIXED_PAYOUT_MULTIPLIER = 2.0;

/*
  ------------------------------------------------------------
  MIDDLEWARE
  ------------------------------------------------------------
*/

// CORS:
// - In development: allow any origin for convenience.
// - In production: only allow your known frontend origin.
app.use(
  cors({
    origin: NODE_ENV === "development" ? true : [FRONTEND_ORIGIN],
    methods: ["GET", "POST"],
    credentials: false
  })
);

// JSON body parser with a small size limit.
// This helps avoid people sending huge payloads.
app.use(express.json({ limit: "32kb" }));

app.get("/", (req, res) => {
  res.status(200).json({ ok: true, message: "Sol Machine backend is running" });
});

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

/*
  ------------------------------------------------------------
  SMALL DATE/TIME HELPERS
  ------------------------------------------------------------
*/

// Returns current time as ISO string for storing in SQLite.
function nowIso() {
  return new Date().toISOString();
}

// Returns current time in milliseconds for easy comparisons.
function nowMs() {
  return Date.now();
}

// Safely parse an ISO date into milliseconds.
// If parsing fails, return 0 instead of NaN.
function safeParseMs(iso) {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/*
  ------------------------------------------------------------
  DATABASE HELPERS
  ------------------------------------------------------------
*/

// Returns the newest cycle row.
// Your app always treats the most recently created cycle as the current one.
function getCurrentCycle() {
  return db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT 1").get();
}

// Creates an idle cycle.
// This is the "waiting for a race to start" state.
function startIdleRace(raceId) {
  const now = nowIso();

  db.prepare(`
    INSERT INTO cycles (race_id, cycle_number, state, started_at, ends_at, winner_car_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(raceId, 0, "idle", now, now, null);
}

// Creates a voting cycle for a given race and cycle number.
function startVotingCycle(raceId, cycleNumber) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + VOTING_DURATION_MS);

  db.prepare(`
    INSERT INTO cycles (race_id, cycle_number, state, started_at, ends_at, winner_car_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    raceId,
    cycleNumber,
    "voting",
    startedAt.toISOString(),
    endsAt.toISOString(),
    null
  );
}

// Updates an existing cycle row to a new state.
// Used for transitions like:
// voting -> finalizing
// finalizing -> boost
function setCycleState(id, state, durationMs, winnerCarId = null) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + durationMs);

  db.prepare(`
    UPDATE cycles
    SET state = ?, started_at = ?, ends_at = ?, winner_car_id = ?
    WHERE id = ?
  `).run(state, startedAt.toISOString(), endsAt.toISOString(), winnerCarId, id);
}

// If the database is empty, create the first idle race.
function seedInitialCycleIfNeeded() {
  if (!getCurrentCycle()) {
    startIdleRace(1);
  }
}

/*
  settleConfirmedBetsForRace()

  This is the later settlement step once a race has an official result.

  Logic:
  - if the race completed normally:
      winning-car bets -> won
      all others        -> lost
  - if the race is cancelled or invalid:
      all confirmed bets -> refunded

  This does NOT yet send real payouts/refunds.
  It only updates backend bet state cleanly for v1.
*/
function settleConfirmedBetsForRace(raceId, winningCarId, raceResultState) {
  const bets = db.prepare(`
    SELECT * FROM bets
    WHERE race_id = ? AND status = 'confirmed'
  `).all(raceId);

  const now = nowIso();

  for (const bet of bets) {
    if (raceResultState === "completed") {
      const nextStatus = bet.car_id === winningCarId ? "won" : "lost";

      db.prepare(`
        UPDATE bets
        SET status = ?, settled_at = ?
        WHERE id = ?
      `).run(nextStatus, now, bet.id);
    } else if (raceResultState === "cancelled" || raceResultState === "invalid") {
      db.prepare(`
        UPDATE bets
        SET status = ?, refunded_at = ?
        WHERE id = ?
      `).run("refunded", now, bet.id);
    }
  }
}

/*
  ------------------------------------------------------------
  VOTE / WINNER LOGIC
  ------------------------------------------------------------
*/

// Finds the winning car for a cycle by counting confirmed votes.
// Ties are broken alphabetically by car_id because of ORDER BY car_id ASC.
// If no one voted, default to Car 1 for now.
function getWinningCarForCycle(cycleId) {
  const rows = db.prepare(`
    SELECT car_id, COUNT(*) AS vote_count
    FROM votes
    WHERE cycle_id = ? AND status = 'confirmed'
    GROUP BY car_id
    ORDER BY vote_count DESC, car_id ASC
  `).all(cycleId);

  return rows.length ? rows[0].car_id : "Car 1";
}

/*
  ------------------------------------------------------------
  CYCLE ADVANCEMENT
  ------------------------------------------------------------
  This is the heart of the race state machine.

  idle        -> stays idle until /api/race/start is called
  starting    -> 20 second countdown before race starts. Betting still active
  voting      -> turns into finalizing when time is up
  finalizing  -> turns into boost when time is up
  boost       -> starts next voting cycle, or returns to idle after last cycle
*/

function advanceCycleIfNeeded() {
  const cycle = getCurrentCycle();

  // No cycle in DB yet? Nothing to do.
  if (!cycle) return;

  // Idle does not advance automatically.
  if (cycle.state === "idle") return;

  const endsAtMs = safeParseMs(cycle.ends_at);

  // If the current cycle has not ended yet, do nothing.
  if (nowMs() < endsAtMs) return;

  // Starting countdown ended -> begin boost voting cycle
  if (cycle.state === "starting") {
    setCycleState(cycle.id, "voting", VOTING_DURATION_MS);
    return;
  }

  // Voting period ended -> move to finalizing
  if (cycle.state === "voting") {
    setCycleState(cycle.id, "finalizing", FINALIZING_DURATION_MS);
    return;
  }

  // Finalizing ended -> determine winner -> move to boost
  if (cycle.state === "finalizing") {
    const winnerCarId = getWinningCarForCycle(cycle.id);
    setCycleState(cycle.id, "boost", BOOST_DURATION_MS, winnerCarId);
    return;
  }

  // Boost ended -> either start the next voting cycle, or start a fresh idle race
  if (cycle.state === "boost") {
    if (cycle.cycle_number < CYCLES_PER_RACE) {
      startVotingCycle(cycle.race_id, cycle.cycle_number + 1);
    } else {
      startIdleRace(cycle.race_id + 1);
    }
  }
}

/*
  Moves the current idle cycle into the starting state.

  This creates a shared 20-second pre-race countdown.
  During this state:
  - betting is still open
  - race has not started yet
  - after countdown ends, backend moves to voting
*/
function setCurrentCycleToStarting(cycleId) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + STARTING_DURATION_MS);

  db.prepare(`
    UPDATE cycles
    SET state = ?, started_at = ?, ends_at = ?, winner_car_id = ?
    WHERE id = ?
  `).run(
    "starting",
    startedAt.toISOString(),
    endsAt.toISOString(),
    null,
    cycleId
  );
}

/*
  ------------------------------------------------------------
  INPUT VALIDATION HELPERS
  ------------------------------------------------------------
  These are deliberately simple for now.
  Later, wallet and signature validation can become stricter.
*/

// Basic wallet validation.
// For now we just require a string in a sensible length range.
// Later for Solana you may want stricter base58 validation.
function isValidWallet(wallet) {
  return typeof wallet === "string" && wallet.length >= 8 && wallet.length <= 128;
}

// Only allow known car IDs.
function isValidCarId(carId) {
  return typeof carId === "string" && ALLOWED_CARS.has(carId);
}

// Simple signature validation.
// In demo mode this is just sanity checking.
// Later you can validate actual Solana signature formats.
function isValidSignature(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 256;
}

/*
  Checks whether the provided stake amount is one of the allowed preset sizes.
*/
function isValidBetAmount(amount) {
  return Number.isInteger(amount) && ALLOWED_BET_AMOUNTS.has(amount);
}

/*
  Returns the current race ID from the latest cycle.
  This is helpful when looking up whether a wallet already bet in this race.
*/
function getCurrentRaceId() {
  const cycle = getCurrentCycle();
  return cycle ? cycle.race_id : null;
}

/*
  Betting is open before the race starts.

  v1 rule:
  - idle      = betting open, race waiting
  - starting  = betting still open during 20-second countdown
  - voting    = betting locked
  - finalizing/boost = betting locked
*/
function isRaceOpenForBetting(cycle) {
  return cycle && (cycle.state === "idle" || cycle.state === "starting");
}

/*
  ------------------------------------------------------------
  ADMIN AUTH MIDDLEWARE
  ------------------------------------------------------------
  Protects admin routes like reset.

  Behavior:
  - In development with no ADMIN_TOKEN set: allow access for convenience.
  - Otherwise: require x-admin-token header to match ADMIN_TOKEN.
*/

function requireAdmin(req, res, next) {
  if (NODE_ENV === "development" && !ADMIN_TOKEN) {
    return next();
  }

  const token = req.header("x-admin-token");

  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

/*
  ------------------------------------------------------------
  VOTE VERIFICATION STUB
  ------------------------------------------------------------
  This is where real Solana verification will go later.

  In DEMO_MODE:
  - always passes
  - lets your current front end keep working

  In real mode later:
  - verify signed message belongs to wallet
  - verify transaction exists on Solana
  - verify amount / destination / nonce / memo
  - verify it matches the stored intent
*/

function verifyVoteProof({ wallet, txSignature, messageSignature, intent }) {
  if (DEMO_MODE) {
    return { ok: true };
  }

  // Placeholder so variables are intentionally "used" for now.
  void wallet;
  void txSignature;
  void messageSignature;
  void intent;

  return { ok: false, error: "On-chain verification not implemented" };
}

/*
  ------------------------------------------------------------
  DATABASE TRANSACTIONS
  ------------------------------------------------------------
  Wrapping critical flows in transactions makes them safer and cleaner.
*/

/*
  Create vote intent transaction:
  - ensures wallet has not already voted this cycle
  - ensures wallet does not already have an active created intent
  - inserts a fresh intent
*/
const createVoteIntentTx = db.transaction(({ cycleId, wallet, carId }) => {
  const existingVote = db.prepare(`
    SELECT id FROM votes WHERE cycle_id = ? AND wallet = ?
  `).get(cycleId, wallet);

  if (existingVote) {
    const err = new Error("Wallet has already voted this cycle");
    err.statusCode = 400;
    throw err;
  }

  const existingIntent = db.prepare(`
    SELECT id FROM vote_intents
    WHERE cycle_id = ? AND wallet = ? AND status = 'created'
  `).get(cycleId, wallet);

  if (existingIntent) {
    const err = new Error("Wallet already has an active vote intent");
    err.statusCode = 400;
    throw err;
  }

  const intentId = nanoid();

  db.prepare(`
    INSERT INTO vote_intents (id, cycle_id, wallet, car_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(intentId, cycleId, wallet, carId, "created", nowIso());

  return intentId;
});

/*
  Confirm vote transaction:
  - ensures the intent is still active
  - ensures it belongs to the CURRENT cycle
  - ensures the intent has not expired
  - ensures the wallet has not already voted
  - inserts confirmed vote
  - marks intent as confirmed

  Using intent.cycle_id here is important.
  That stops an old intent from being incorrectly applied to a different cycle.
*/
const confirmVoteTx = db.transaction(({ cycle, intent, wallet, txSignature, messageSignature }) => {
  if (intent.status !== "created") {
    const err = new Error("Vote intent is no longer active");
    err.statusCode = 400;
    throw err;
  }

  if (intent.cycle_id !== cycle.id) {
    const err = new Error("Vote intent does not belong to the current cycle");
    err.statusCode = 400;
    throw err;
  }

  const intentAgeMs = nowMs() - safeParseMs(intent.created_at);

  if (intentAgeMs > INTENT_EXPIRY_MS) {
    db.prepare(`UPDATE vote_intents SET status = 'expired' WHERE id = ?`).run(intent.id);
    const err = new Error("Vote intent has expired");
    err.statusCode = 400;
    throw err;
  }

  const existingVote = db.prepare(`
    SELECT id FROM votes WHERE cycle_id = ? AND wallet = ?
  `).get(intent.cycle_id, wallet);

  if (existingVote) {
    db.prepare(`UPDATE vote_intents SET status = 'rejected' WHERE id = ?`).run(intent.id);
    const err = new Error("Wallet has already voted this cycle");
    err.statusCode = 400;
    throw err;
  }

  db.prepare(`
    INSERT INTO votes (cycle_id, wallet, car_id, tx_signature, message_signature, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    intent.cycle_id,
    wallet,
    intent.car_id,
    txSignature,
    messageSignature,
    "confirmed",
    nowIso()
  );

  db.prepare(`
    UPDATE vote_intents SET status = 'confirmed' WHERE id = ?
  `).run(intent.id);

  return {
    cycleId: intent.cycle_id,
    carId: intent.car_id
  };
});

/*
  Create bet intent transaction.

  What it does:
  - ensures this wallet has not already bet in the current race
  - calculates potential payout
  - inserts a new bet in pending_payment state

  Why pending_payment?
  Because this mirrors your current vote flow:
  1. create intent
  2. later submit payment proof
  3. backend confirms the bet
*/
const createBetIntentTx = db.transaction(({ raceId, cycleId, wallet, carId, stakeAmount }) => {
  const existingBet = db.prepare(`
    SELECT id
    FROM bets
    WHERE race_id = ? AND wallet = ?
      AND status IN ('pending_payment', 'confirmed', 'won', 'lost', 'refunded')
  `).get(raceId, wallet);

  if (existingBet) {
    const err = new Error("Wallet has already placed a bet for this race");
    err.statusCode = 400;
    throw err;
  }

  const betId = nanoid();

  // Precompute the possible return now so the value is locked in at bet time.
  const potentialPayout = Math.floor(stakeAmount * FIXED_PAYOUT_MULTIPLIER);

  db.prepare(`
    INSERT INTO bets (
      id,
      race_id,
      cycle_id,
      wallet,
      car_id,
      token_symbol,
      stake_amount,
      payout_multiplier,
      potential_payout,
      status,
      payment_tx_signature,
      message_signature,
      created_at,
      settled_at,
      refunded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    betId,
    raceId,
    cycleId,
    wallet,
    carId,
    TOKEN_SYMBOL,
    stakeAmount,
    FIXED_PAYOUT_MULTIPLIER,
    potentialPayout,
    "pending_payment",
    null,
    null,
    nowIso(),
    null,
    null
  );

  return {
    betId,
    potentialPayout
  };
});

/*
  Confirm bet transaction.

  What it does:
  - checks the bet is still awaiting payment
  - checks it belongs to the current race
  - stores payment proof fields
  - marks the bet as confirmed

  This is the point where the bet becomes "real" for the race.
*/
const confirmBetTx = db.transaction(({ bet, raceId, paymentTxSignature, messageSignature }) => {
  if (bet.status !== "pending_payment") {
    const err = new Error("Bet is no longer awaiting payment");
    err.statusCode = 400;
    throw err;
  }

  if (bet.race_id !== raceId) {
    const err = new Error("Bet does not belong to the current race");
    err.statusCode = 400;
    throw err;
  }

  db.prepare(`
    UPDATE bets
    SET status = ?, payment_tx_signature = ?, message_signature = ?
    WHERE id = ?
  `).run("confirmed", paymentTxSignature, messageSignature, bet.id);

  return {
    betId: bet.id,
    raceId: bet.race_id,
    carId: bet.car_id,
    stakeAmount: bet.stake_amount,
    potentialPayout: bet.potential_payout
  };
});

/*
  ------------------------------------------------------------
  RESPONSE FORMATTER
  ------------------------------------------------------------
  Keeps cycle responses consistent across endpoints.
*/

function serializeCycle(cycle) {
  return {
    id: cycle.id,
    raceId: cycle.race_id,
    cycleNumber: cycle.cycle_number,
    state: cycle.state,
    startedAt: cycle.started_at,
    endsAt: cycle.state === "idle" ? null : cycle.ends_at,
    winnerCarId: cycle.winner_car_id,
    raceStarted: cycle.state !== "idle"
  };
}

/*
  ------------------------------------------------------------
  BACKGROUND TIMER
  ------------------------------------------------------------
  Every 500ms, check whether the current cycle should advance.
  This keeps the race flowing without relying only on frontend polling.
*/

setInterval(() => {
  try {
    advanceCycleIfNeeded();
  } catch (error) {
    console.error("Cycle advance failed:", error);
  }
}, 500);

// Make sure there is an initial idle cycle in the database when the app starts.
seedInitialCycleIfNeeded();

/*
  ------------------------------------------------------------
  ROUTES
  ------------------------------------------------------------
*/

/*
  GET /api/cycle/current
  Returns the latest cycle state for the frontend timer/UI.
*/
app.get("/api/cycle/current", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();
  return res.json(serializeCycle(cycle));
});

/*
  GET /api/cycle/result
  Returns current cycle result totals.
  If the app is idle, return an empty totals array.
*/
app.get("/api/cycle/result", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  const totals =
    cycle.state === "idle"
      ? []
      : db.prepare(`
          SELECT car_id, COUNT(*) AS vote_count
          FROM votes
          WHERE cycle_id = ? AND status = 'confirmed'
          GROUP BY car_id
          ORDER BY car_id ASC
        `).all(cycle.id);

  return res.json({
    cycleId: cycle.id,
    raceId: cycle.race_id,
    cycleNumber: cycle.cycle_number,
    state: cycle.state,
    winnerCarId: cycle.winner_car_id,
    totals
  });
});

/*
  POST /api/race/start

  Starts the pre-race countdown.

  Important:
  This does NOT immediately start the voting/race cycle anymore.
  It changes the current race from idle -> starting.

  During starting:
  - users can still place bets
  - frontend shows "Race starts in Xs"
  - after 20 seconds, backend moves to voting automatically
*/
app.post("/api/race/start", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state !== "idle") {
    return res.status(400).json({ error: "Race countdown has already started" });
  }

  setCurrentCycleToStarting(cycle.id);

  return res.json({
    success: true,
    cycle: serializeCycle(getCurrentCycle())
  });
});

/*
  POST /api/vote-intent
  Creates a short-lived intent for a wallet to vote for a car.
  This is the first step before actual vote submission.
*/
app.post("/api/vote-intent", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state !== "voting") {
    return res.status(400).json({ error: "Voting is not open" });
  }

  const { wallet, carId } = req.body ?? {};

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (!isValidCarId(carId)) {
    return res.status(400).json({ error: "Invalid carId" });
  }

  try {
    const intentId = createVoteIntentTx({
      cycleId: cycle.id,
      wallet,
      carId
    });

    return res.json({
      intentId,
      cycleId: cycle.id,
      raceId: cycle.race_id,
      cycleNumber: cycle.cycle_number,
      carId,
      tokenCost: 1
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to create vote intent"
    });
  }
});

/*
  POST /api/vote-submit
  Confirms a vote using a previously created intent.

  Flow:
  1. make sure voting is open
  2. validate input shape
  3. load the intent
  4. make sure the wallet matches the intent
  5. verify payment/signature (currently stubbed in demo mode)
  6. confirm the vote in a transaction
*/
app.post("/api/vote-submit", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state !== "voting") {
    return res.status(400).json({ error: "Voting is not open" });
  }

  const { intentId, wallet, txSignature, messageSignature } = req.body ?? {};

  if (typeof intentId !== "string" || intentId.length < 8 || intentId.length > 64) {
    return res.status(400).json({ error: "Invalid intentId" });
  }

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (!isValidSignature(txSignature) || !isValidSignature(messageSignature)) {
    return res.status(400).json({ error: "Invalid signature payload" });
  }

  const intent = db.prepare(`
    SELECT * FROM vote_intents WHERE id = ?
  `).get(intentId);

  if (!intent) {
    return res.status(404).json({ error: "Vote intent not found" });
  }

  if (intent.wallet !== wallet) {
    return res.status(400).json({ error: "Wallet does not match intent" });
  }

  const verification = verifyVoteProof({
    wallet,
    txSignature,
    messageSignature,
    intent
  });

  if (!verification.ok) {
    db.prepare(`UPDATE vote_intents SET status = 'rejected' WHERE id = ?`).run(intentId);
    return res.status(400).json({
      error: verification.error || "Vote verification failed"
    });
  }

  try {
    const result = confirmVoteTx({
      cycle,
      intent,
      wallet,
      txSignature,
      messageSignature
    });

    return res.json({
      success: true,
      cycleId: result.cycleId,
      raceId: cycle.race_id,
      cycleNumber: cycle.cycle_number,
      carId: result.carId
    });
  } catch (error) {
    // If two requests race each other, SQLite unique constraints may fire.
    // Turn that into a clean user-facing message instead of a raw DB error.
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(400).json({ error: "Wallet has already voted this cycle" });
    }

    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to submit vote"
    });
  }
});

/*
  POST /api/bet-intent

  Creates a pending bet record before payment is verified.

  Request body:
  {
    wallet: string,
    carId: string,
    stakeAmount: integer
  }

  Rules enforced here:
  - betting must still be open
  - wallet must be valid
  - chosen car must be valid
  - stake amount must be one of the preset allowed sizes
  - one wallet can only have one bet per race
*/
app.post("/api/bet-intent", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (!isRaceOpenForBetting(cycle)) {
    return res.status(400).json({ error: "Betting is not open" });
  }

  const { wallet, carId, stakeAmount } = req.body ?? {};

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (!isValidCarId(carId)) {
    return res.status(400).json({ error: "Invalid carId" });
  }

  if (!isValidBetAmount(stakeAmount)) {
    return res.status(400).json({ error: "Invalid stakeAmount" });
  }

  try {
    const result = createBetIntentTx({
      raceId: cycle.race_id,
      cycleId: cycle.id,
      wallet,
      carId,
      stakeAmount
    });

    return res.json({
      betId: result.betId,
      raceId: cycle.race_id,
      cycleId: cycle.id,
      carId,
      stakeAmount,
      tokenSymbol: TOKEN_SYMBOL,
      payoutMultiplier: FIXED_PAYOUT_MULTIPLIER,
      potentialPayout: result.potentialPayout
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to create bet intent"
    });
  }
});

/*
  POST /api/bet-submit

  Confirms a bet after payment/signature proof is provided.

  Request body:
  {
    betId: string,
    wallet: string,
    paymentTxSignature: string,
    messageSignature: string
  }

  For now:
  - demo mode always passes payment verification
  - later this becomes real Solana token transfer / signature verification
*/
app.post("/api/bet-submit", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (!isRaceOpenForBetting(cycle)) {
    return res.status(400).json({ error: "Betting is not open" });
  }

  const { betId, wallet, paymentTxSignature, messageSignature } = req.body ?? {};

  if (typeof betId !== "string" || betId.length < 8 || betId.length > 64) {
    return res.status(400).json({ error: "Invalid betId" });
  }

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (!isValidSignature(paymentTxSignature) || !isValidSignature(messageSignature)) {
    return res.status(400).json({ error: "Invalid signature payload" });
  }

  const bet = db.prepare(`
    SELECT * FROM bets WHERE id = ?
  `).get(betId);

  if (!bet) {
    return res.status(404).json({ error: "Bet not found" });
  }

  if (bet.wallet !== wallet) {
    return res.status(400).json({ error: "Wallet does not match bet" });
  }

  /*
    Demo-mode payment verification.

    For now:
    - in DEMO_MODE, always accept the payment proof
    - later, replace this with real fixed-token verification on Solana
  */
  const verificationPassed = DEMO_MODE ? true : false;

  if (!verificationPassed) {
    return res.status(400).json({ error: "Bet payment verification failed" });
  }

  try {
    const result = confirmBetTx({
      bet,
      raceId: cycle.race_id,
      paymentTxSignature,
      messageSignature
    });

    return res.json({
      success: true,
      betId: result.betId,
      raceId: result.raceId,
      carId: result.carId,
      stakeAmount: result.stakeAmount,
      potentialPayout: result.potentialPayout
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(400).json({
        error: "Wallet has already placed a bet for this race"
      });
    }

    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to submit bet"
    });
  }
});

/*
  GET /api/bet/current?wallet=...

  Returns this wallet's current bet for the active race, if one exists.

  This will help the frontend later show things like:
  - current chosen car
  - stake amount
  - confirmed/pending status
*/
app.get("/api/bet/current", (req, res) => {
  const wallet = req.query.wallet;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const raceId = getCurrentRaceId();

  if (!raceId) {
    return res.json({ bet: null });
  }

  const bet = db.prepare(`
    SELECT * FROM bets
    WHERE race_id = ? AND wallet = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(raceId, wallet);

  return res.json({ bet: bet || null });
});

/*
  POST /api/admin/reset-race
  Creates a brand new idle race row.
  Protected by requireAdmin unless in relaxed local dev mode.
*/
app.post("/api/admin/reset-race", requireAdmin, (req, res) => {
  const cycle = getCurrentCycle();
  const nextRaceId = cycle ? cycle.race_id + 1 : 1;

  startIdleRace(nextRaceId);

  return res.json({
    success: true,
    cycle: serializeCycle(getCurrentCycle())
  });
});

/*
  ------------------------------------------------------------
  START SERVER
  ------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sol Machine backend running on host 0.0.0.0 port ${PORT}`);
});