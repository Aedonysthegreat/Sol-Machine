import "dotenv/config";
import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import db from "./db.js";
import { fetchFakeRaceResult } from "./fakeCarBackend.js";

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

/*
  AUTO_FAKE_RACE_RESULTS

  Development helper.

  When true:
  - after the final boost cycle ends
  - the backend automatically asks fakeCarBackend.js for a finishing order
  - bets are settled
  - the next idle race is created
*/
const AUTO_FAKE_RACE_RESULTS =
  process.env.AUTO_FAKE_RACE_RESULTS === "true" ||
  (NODE_ENV === "development" && process.env.AUTO_FAKE_RACE_RESULTS !== "false");

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
  APP / BLOCKCHAIN MODE CONFIG
  ------------------------------------------------------------

  APP_MODE controls the broad mode of the app.

  demo:
  - uses the existing generated demo wallet
  - uses mock transaction signatures
  - keeps the current working demo flow intact

  devnet:
  - will use a real Solana wallet
  - will create real Devnet transactions
  - backend will verify transactions before confirming bets/votes
*/
const APP_MODE = process.env.APP_MODE || "demo";

/*
  Solana network settings.

  These are not used by the demo flow yet.
  They are exposed through /api/config so the frontend can prepare
  for devnet mode later.
*/
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || "devnet";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

/*
  Public wallet/token addresses.

  These are safe to expose to the frontend because they are public addresses,
  not private keys.
*/
const TOKEN_MINT = process.env.TOKEN_MINT || "";
const TREASURY_WALLET = process.env.TREASURY_WALLET || "";

/*
  ------------------------------------------------------------
  SOLANA DEVNET VERIFICATION HELPERS
  ------------------------------------------------------------

  Devnet v1 uses native SOL transfers, not SPL tokens yet.

  Frontend mapping:
  - stake 1  = 0.001 SOL
  - stake 5  = 0.005 SOL
  - stake 10 = 0.010 SOL

  The backend must use the same mapping when verifying payment.
*/
const DEVNET_SOL_PER_STAKE_UNIT = 0.001;

const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");

function stakeAmountToExpectedLamports(stakeAmount) {
  return Math.round(
    stakeAmount * DEVNET_SOL_PER_STAKE_UNIT * LAMPORTS_PER_SOL
  );
}

function isValidPublicKeyString(value) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/*
  ------------------------------------------------------------
  TIMING / GAME RULES
  ------------------------------------------------------------
*/

const STARTING_DURATION_MS = 20 * 1000;
const VOTING_DURATION_MS = 10 * 1000;
const FINALIZING_DURATION_MS = 3 * 1000;
const BOOST_DURATION_MS = 3 * 1000;

// Number of boost cycles per race before returning to idle.
const CYCLES_PER_RACE = 3;

// Each confirmed bettor gets this many internal boost tokens per race.
const BOOST_TOKENS_PER_RACE = 1;

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
  FAKE CAR BACKEND HELPERS
  ------------------------------------------------------------
*/

/*
  Returns true if a bet won based on the submitted race result.

  Winner bet:
  - wins if selected car matches winning car

  Trifecta bet:
  - wins only if exact finishing order matches
*/
function didBetWinRace(bet, raceResult) {
  if (!bet || !raceResult) return false;

  if (bet.bet_type === "winner") {
    return bet.car_id === raceResult.winningCarId;
  }

  if (bet.bet_type === "trifecta") {
    return (
      bet.trifecta_first_car_id === raceResult.firstCarId &&
      bet.trifecta_second_car_id === raceResult.secondCarId &&
      bet.trifecta_third_car_id === raceResult.thirdCarId
    );
  }

  return false;
}

/*
  Records the race result and settles all confirmed bets for that race.

  This is the function you can later reuse when the real car backend
  sends the official finishing order.
*/
const recordRaceResultAndSettleBetsTx = db.transaction((raceResult) => {
  const now = nowIso();

  /*
    Store official result for this race.

    INSERT OR REPLACE lets you re-run the fake result during testing,
    but for production you may want stricter one-time-only behaviour.
  */
  db.prepare(`
    INSERT OR REPLACE INTO race_results (
      race_id,
      winning_car_id,
      first_car_id,
      second_car_id,
      third_car_id,
      status,
      source,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    raceResult.raceId,
    raceResult.winningCarId,
    raceResult.firstCarId,
    raceResult.secondCarId,
    raceResult.thirdCarId,
    raceResult.status,
    raceResult.source,
    now
  );

  /*
    Get all confirmed bets for this race.
  */
  const confirmedBets = db.prepare(`
    SELECT *
    FROM bets
    WHERE race_id = ?
      AND status = 'confirmed'
  `).all(raceResult.raceId);

  let settledCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let refundedCount = 0;

  confirmedBets.forEach((bet) => {
    /*
      If the race did not complete properly, do not mark bets as lost.
      Refund them instead.
    */
    if (raceResult.status === "cancelled" || raceResult.status === "invalid") {
      db.prepare(`
        UPDATE bets
        SET status = ?,
            refunded_at = ?
        WHERE id = ?
      `).run("refunded", now, bet.id);

      settledCount += 1;
      refundedCount += 1;
      return;
    }

    /*
      Completed race:
      - winner bets use winningCarId
      - trifecta bets use exact finishing order
    */
    const won = didBetWinRace(bet, raceResult);
    const nextStatus = won ? "won" : "lost";

    db.prepare(`
      UPDATE bets
      SET status = ?,
          settled_at = ?
      WHERE id = ?
    `).run(nextStatus, now, bet.id);

    settledCount += 1;

    if (won) {
      wonCount += 1;
    } else {
      lostCount += 1;
    }
  });

  /*
    Expire boost balances for the race.

    These are race-only native website tokens, so once the race result
    is submitted they should no longer be active.
  */
  db.prepare(`
    UPDATE race_boost_balances
    SET status = 'expired',
        updated_at = ?
    WHERE race_id = ?
      AND status IN ('reserved', 'active')
  `).run(now, raceResult.raceId);

  return {
    raceResult,
    settlement: {
      settledCount,
      wonCount,
      lostCount,
      refundedCount
    }
  };
});

/*
  ------------------------------------------------------------
  BETTING RULES
  ------------------------------------------------------------
  These define the second betting version:
  - one token only
  - preset stake sizes only
  - fixed payout multiplier
  - both single car bet and trifecta bet
*/

/*
  Token symbol stored with bet records.

  In demo mode this can be BOOST.
  In devnet mode this should match your test token symbol.
*/
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || "BOOST";

// Preset bet sizes users are allowed to place.
// Adjust these later to match your actual token design.
const ALLOWED_BET_AMOUNTS = new Set([1, 5, 10]);

// single and trifecta bets
const BET_TYPES = new Set(["winner", "trifecta"]);

const WINNER_PAYOUT_MULTIPLIER = 2.0;
const TRIFECTA_PAYOUT_MULTIPLIER = 5.0;

function getPayoutMultiplierForBetType(betType) {
  if (betType === "winner") return WINNER_PAYOUT_MULTIPLIER;
  if (betType === "trifecta") return TRIFECTA_PAYOUT_MULTIPLIER;
  return null;
}

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

/*
  Starts the next idle race after a race has been settled.

  This is useful for mock/dev settlement because the fake car backend
  can finish the race immediately, before the normal cycle timer reaches
  the end of all boost cycles.

  It only creates a new idle race if the latest cycle still belongs to
  the race that was just settled.
*/
function startNextIdleRaceAfterSettlement(settledRaceId) {
  const currentCycle = getCurrentCycle();

  if (!currentCycle) {
    startIdleRace(settledRaceId + 1);
    return getCurrentCycle();
  }

  /*
    If the app has already moved beyond this race, do not create another
    idle race. This prevents duplicate race jumps.
  */
  if (currentCycle.race_id !== settledRaceId) {
    return currentCycle;
  }

  startIdleRace(settledRaceId + 1);
  return getCurrentCycle();
}

/*
  finishRaceWithFakeCarBackend()

  Called automatically after the final boost cycle ends during development.

  It simulates the real car backend returning:
  - winner
  - full finishing order

  Then it:
  - records race result
  - settles winner/trifecta bets
  - expires boost tokens
  - creates the next idle race
*/
function finishRaceWithFakeCarBackend(raceId) {
  /*
    Do not settle the same race twice.
  */
  if (isRaceAlreadySettled(raceId)) {
    return {
      skipped: true,
      reason: "Race already settled",
      raceId
    };
  }

  /*
    The race should normally have confirmed bets because /api/race/start
    requires at least one confirmed bet.
  */
  if (!raceHasConfirmedBet(raceId)) {
    startNextIdleRaceAfterSettlement(raceId);

    return {
      skipped: true,
      reason: "No confirmed bets found",
      raceId
    };
  }

  const raceResult = fetchFakeRaceResult(raceId);

  const settled = recordRaceResultAndSettleBetsTx(raceResult);

  const nextCycle = startNextIdleRaceAfterSettlement(raceId);

  console.log("Auto mock race settlement:", {
    ...settled,
    nextCycle: serializeCycle(nextCycle)
  });

  return {
    ...settled,
    nextCycle: serializeCycle(nextCycle)
  };
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
  TEMPORARY / LEGACY SETTLEMENT PATH

  This function only supports winner-style settlement because it checks:
    bet.car_id === winningCarId

  It does NOT correctly settle trifecta bets.

  Keep this only for older/manual admin testing.
  The long-term settlement path should be:
    recordRaceResultAndSettleBetsTx()

  That newer path supports:
    - winner bets
    - exact trifecta order
    - boost balance expiry
    - future car-backend result integration
*/

function settleConfirmedBetsForRace(raceId, winningCarId, raceResultState) {
  const bets = db.prepare(`
    SELECT * FROM bets
    WHERE race_id = ? AND status = 'confirmed'
  `).all(raceId);

  const now = nowIso();

  let wonCount = 0;
  let lostCount = 0;
  let refundedCount = 0;

  for (const bet of bets) {
    if (raceResultState === "completed") {
      const nextStatus = bet.car_id === winningCarId ? "won" : "lost";

      if (nextStatus === "won") {
        wonCount += 1;
      } else {
        lostCount += 1;
      }

      db.prepare(`
        UPDATE bets
        SET status = ?, settled_at = ?
        WHERE id = ?
      `).run(nextStatus, now, bet.id);
    } else if (raceResultState === "cancelled" || raceResultState === "invalid") {
      refundedCount += 1;

      db.prepare(`
        UPDATE bets
        SET status = ?, refunded_at = ?
        WHERE id = ?
      `).run("refunded", now, bet.id);
    }
  }

  return {
    totalConfirmedBets: bets.length,
    wonCount,
    lostCount,
    refundedCount
  };
}

function getConfirmedBetForWalletRace(wallet, raceId) {
  return db.prepare(`
    SELECT *
    FROM bets
    WHERE wallet = ?
      AND race_id = ?
      AND status = 'confirmed'
    LIMIT 1
  `).get(wallet, raceId);
}

function getBoostBalance(wallet, raceId) {
  return db.prepare(`
    SELECT *
    FROM race_boost_balances
    WHERE wallet = ? AND race_id = ?
  `).get(wallet, raceId);
}

function isCarAllowedForBet(bet, carId) {
  if (!bet || !isValidCarId(carId)) return false;

  if (bet.bet_type === "winner") {
    return bet.car_id === carId;
  }

  if (bet.bet_type === "trifecta") {
    return (
      bet.trifecta_first_car_id === carId ||
      bet.trifecta_second_car_id === carId ||
      bet.trifecta_third_car_id === carId
    );
  }

  return false;
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

  // Boost ended -> either start the next voting cycle, or finish the race
  if (cycle.state === "boost") {
    if (cycle.cycle_number < CYCLES_PER_RACE) {
      startVotingCycle(cycle.race_id, cycle.cycle_number + 1);
      return;
    }

    /*
      Final boost cycle has ended.

      Development/mock mode:
      - automatically fetch a fake final finishing order
      - record result
      - settle bets
      - move to next idle race

      Future real mode:
      - this is where the app will wait for or receive the real car backend result.
    */
    if (AUTO_FAKE_RACE_RESULTS) {
      finishRaceWithFakeCarBackend(cycle.race_id);
      return;
    }

    /*
      Fallback behaviour if automatic mock results are disabled.

      Later, once the real car backend exists, you may want a state like
      "awaiting_result" here instead of immediately creating the next idle race.
    */
    startIdleRace(cycle.race_id + 1);
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

function isValidRaceResultStatus(status) {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "invalid"
  );
}

function isRaceAlreadySettled(raceId) {
  const existingResult = db.prepare(`
    SELECT race_id FROM race_results WHERE race_id = ?
  `).get(raceId);

  return Boolean(existingResult);
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
  Checks whether bet is single car or trifecta
*/
function isValidBetType(betType) {
  return typeof betType === "string" && BET_TYPES.has(betType);
}

function areUniqueCars(carIds) {
  return Array.isArray(carIds) && new Set(carIds).size === carIds.length;
}

function isValidTrifectaOrder(order) {
  if (!Array.isArray(order)) return false;
  if (order.length !== 3) return false;
  if (!areUniqueCars(order)) return false;
  return order.every((carId) => isValidCarId(carId));
}

function normalizeBetSelection({ betType, carId, trifectaOrder }) {
  if (betType === "winner") {
    if (!isValidCarId(carId)) {
      return { ok: false, error: "Winner bets require a valid carId" };
    }

    return {
      ok: true,
      primaryCarId: carId,
      trifectaFirstCarId: null,
      trifectaSecondCarId: null,
      trifectaThirdCarId: null
    };
  }

  if (betType === "trifecta") {
    if (!isValidTrifectaOrder(trifectaOrder)) {
      return {
        ok: false,
        error: "Trifecta bets require exactly 3 unique valid cars"
      };
    }

    return {
      ok: true,
      primaryCarId: trifectaOrder[0],
      trifectaFirstCarId: trifectaOrder[0],
      trifectaSecondCarId: trifectaOrder[1],
      trifectaThirdCarId: trifectaOrder[2]
    };
  }

  return { ok: false, error: "Invalid bet type" };
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
  Checks whether a race has at least one confirmed bet.

  Why this exists:
  - The frontend disables Start Race before a user backs a car.
  - But frontend checks can be bypassed.
  - This backend check prevents someone from directly calling
    POST /api/race/start before any real/confirmed bet exists.

  Demo rule:
  - A race can only start once at least one bet has status 'confirmed'.
*/
function raceHasConfirmedBet(raceId) {
  const row = db.prepare(`
    SELECT id
    FROM bets
    WHERE race_id = ? AND status = 'confirmed'
    LIMIT 1
  `).get(raceId);

  return Boolean(row);
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

/*
  verifyVoteProof()

  Boost votes are NOT on-chain.

  Betting can still be verified on-chain in devnet mode, but boost votes
  are internal website actions powered by backend-owned race boost tokens.

  This means:
  - no wallet popup for boost votes
  - no Solana transaction for boost votes
  - no on-chain verification for boost votes
  - backend still securely enforces:
      confirmed bet required
      boost tokens remaining
      one vote per cycle
      allowed car for bet type

  We still sanity-check the placeholder signatures so the route shape
  stays compatible with the current frontend.
*/
function verifyVoteProof({ wallet, txSignature, messageSignature, intent }) {
  if (!isValidWallet(wallet)) {
    return { ok: false, error: "Invalid wallet" };
  }

  if (!intent || intent.wallet !== wallet) {
    return { ok: false, error: "Vote intent does not match wallet" };
  }

  if (!isValidSignature(txSignature)) {
    return { ok: false, error: "Invalid vote signature" };
  }

  if (!isValidSignature(messageSignature)) {
    return { ok: false, error: "Invalid vote message signature" };
  }

  return { ok: true };
}

/*
  verifyBetPaymentProof()

  Demo mode:
  - accepts mock signatures so the existing demo mode keeps working.

  Devnet mode:
  - fetches the transaction from Solana Devnet
  - confirms the transaction did not fail
  - checks it contains a native SOL transfer
  - checks sender wallet matches the bettor
  - checks destination matches treasury wallet
  - checks lamports match the selected stake amount

  This prevents someone from confirming a bet with a random fake signature.
*/
async function verifyBetPaymentProof({
  wallet,
  paymentTxSignature,
  bet
}) {
  if (DEMO_MODE) {
    return { ok: true };
  }

  if (APP_MODE !== "devnet") {
    return {
      ok: false,
      error: "Unsupported app mode for bet verification"
    };
  }

  if (!TREASURY_WALLET) {
    return {
      ok: false,
      error: "Treasury wallet is not configured"
    };
  }

  if (!isValidPublicKeyString(wallet)) {
    return {
      ok: false,
      error: "Invalid bettor wallet address"
    };
  }

  if (!isValidPublicKeyString(TREASURY_WALLET)) {
    return {
      ok: false,
      error: "Invalid treasury wallet address"
    };
  }

  const expectedLamports = stakeAmountToExpectedLamports(bet.stake_amount);

  const tx = await solanaConnection.getParsedTransaction(
    paymentTxSignature,
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    }
  );

  if (!tx) {
    return {
      ok: false,
      error: "Transaction not found or not confirmed yet"
    };
  }

  if (tx.meta?.err) {
    return {
      ok: false,
      error: "Transaction failed on-chain"
    };
  }

  const instructions = tx.transaction?.message?.instructions || [];

  const matchingTransfer = instructions.find((instruction) => {
    const parsed = instruction.parsed;

    if (instruction.program !== "system") return false;
    if (!parsed || parsed.type !== "transfer") return false;

    const info = parsed.info || {};

    return (
      info.source === wallet &&
      info.destination === TREASURY_WALLET &&
      Number(info.lamports) === expectedLamports
    );
  });

  if (!matchingTransfer) {
    return {
      ok: false,
      error: "Transaction does not match expected bet payment"
    };
  }

  return {
    ok: true,
    expectedLamports
  };
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
  confirmVoteTx

  Confirms a boost vote and spends 1 internal boost token.

  This is the main security gate for boost voting.

  It enforces:
  - vote intent must still be active
  - vote intent must belong to the current cycle
  - vote intent must not be expired
  - wallet must not have already voted this cycle
  - wallet must have a confirmed bet for this race
  - selected car must be allowed by the bet type
  - boost tokens must be active for this race
  - wallet must have at least 1 boost token remaining
  - one successful vote spends exactly 1 boost token

  This runs inside a database transaction so the vote insert and token spend
  happen together. That helps stop double-click/spam race conditions.
*/
const confirmVoteTx = db.transaction(({
  cycle,
  intent,
  wallet,
  txSignature,
  messageSignature
}) => {
  /*
    The intent must still be waiting to be used.

    If it was confirmed, rejected, or expired already, block it.
  */
  if (intent.status !== "created") {
    const err = new Error("Vote intent is no longer active");
    err.statusCode = 400;
    throw err;
  }

  /*
    The intent must belong to the current cycle.

    This prevents old vote intents from previous cycles being reused.
  */
  if (intent.cycle_id !== cycle.id) {
    const err = new Error("Vote intent does not belong to the current cycle");
    err.statusCode = 400;
    throw err;
  }

  /*
    Expire stale vote intents.

    This stops someone creating an intent during voting, waiting too long,
    and then trying to confirm it later.
  */
  const intentAgeMs = nowMs() - safeParseMs(intent.created_at);

  if (intentAgeMs > INTENT_EXPIRY_MS) {
    db.prepare(`
      UPDATE vote_intents SET status = 'expired' WHERE id = ?
    `).run(intent.id);

    const err = new Error("Vote intent has expired");
    err.statusCode = 400;
    throw err;
  }

  /*
    One vote per wallet per cycle.

    Your votes table also has UNIQUE(cycle_id, wallet), but this gives
    a cleaner controlled error before the insert fails.
  */
  const existingVote = db.prepare(`
    SELECT id FROM votes WHERE cycle_id = ? AND wallet = ?
  `).get(intent.cycle_id, wallet);

  if (existingVote) {
    db.prepare(`
      UPDATE vote_intents SET status = 'rejected' WHERE id = ?
    `).run(intent.id);

    const err = new Error("Wallet has already voted this cycle");
    err.statusCode = 400;
    throw err;
  }

  /*
    The wallet must have a confirmed bet for this race.

    This stops people with no bet from influencing the race.
  */
  const bet = getConfirmedBetForWalletRace(wallet, cycle.race_id);

  if (!bet) {
    db.prepare(`
      UPDATE vote_intents SET status = 'rejected' WHERE id = ?
    `).run(intent.id);

    const err = new Error("Wallet does not have a confirmed bet for this race");
    err.statusCode = 400;
    throw err;
  }

  /*
    Check whether this bet type allows boosting the selected car.

    Winner bet:
    - can only boost its selected winner car

    Trifecta bet:
    - can boost any of the 3 cars in the selected finishing order
  */
  if (!isCarAllowedForBet(bet, intent.car_id)) {
    db.prepare(`
      UPDATE vote_intents SET status = 'rejected' WHERE id = ?
    `).run(intent.id);

    const err = new Error("This bet type cannot boost that car");
    err.statusCode = 400;
    throw err;
  }

  /*
    Fetch this wallet's boost-token balance for this race.

    The balance must exist and be active.
  */
  const balance = getBoostBalance(wallet, cycle.race_id);

  if (!balance || balance.status !== "active") {
    db.prepare(`
      UPDATE vote_intents SET status = 'rejected' WHERE id = ?
    `).run(intent.id);

    const err = new Error("Boost tokens are not active for this race");
    err.statusCode = 400;
    throw err;
  }

  /*
    Check whether the wallet has any boost tokens left.

    Example:
    granted = 3
    spent = 2
    remaining = 1

    If remaining is 0, the user has used all boost votes for this race.
  */
  const tokensRemaining = balance.tokens_granted - balance.tokens_spent;

  if (tokensRemaining <= 0) {
    db.prepare(`
      UPDATE vote_intents SET status = 'rejected' WHERE id = ?
    `).run(intent.id);

    const err = new Error("No boost tokens remaining");
    err.statusCode = 400;
    throw err;
  }

  /*
    Store the confirmed vote.

    This is the vote that counts toward deciding which car gets the boost.
  */
  db.prepare(`
    INSERT INTO votes (
      cycle_id,
      wallet,
      car_id,
      tx_signature,
      message_signature,
      status,
      created_at
    )
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

  /*
    Spend exactly 1 internal boost token.

    This happens in the same transaction as the vote insert.
    So if either operation fails, the whole transaction rolls back.
  */
  db.prepare(`
    UPDATE race_boost_balances
    SET tokens_spent = tokens_spent + 1,
        updated_at = ?
    WHERE race_id = ? AND wallet = ?
  `).run(nowIso(), cycle.race_id, wallet);

  /*
    Mark the intent as used successfully.
  */
  db.prepare(`
    UPDATE vote_intents SET status = 'confirmed' WHERE id = ?
  `).run(intent.id);

  /*
    Return the updated balance so the frontend can immediately update
    the HUD without waiting for another poll.
  */
  const updatedBalance = getBoostBalance(wallet, cycle.race_id);

  return {
    cycleId: intent.cycle_id,
    raceId: cycle.race_id,
    carId: intent.car_id,
    boostTokens: {
      granted: updatedBalance.tokens_granted,
      spent: updatedBalance.tokens_spent,
      remaining: updatedBalance.tokens_granted - updatedBalance.tokens_spent,
      status: updatedBalance.status
    }
  };
});

/*
  createBetIntentTx

  Creates a pending bet record before payment has been confirmed.

  This supports two bet types:

  1. winner
     - user picks one car to win
     - pays 2x

  2. trifecta
     - user picks exact 1st / 2nd / 3rd order
     - pays 5x

  Important security notes:
  - The frontend does NOT decide the payout multiplier.
  - The frontend does NOT decide potential payout.
  - The backend validates the bet type and selected cars.
  - The backend stores the multiplier at bet creation time.
  - One wallet can only have one bet per race.

  Pending bet behaviour:
  - If the wallet already has a confirmed bet, block a new bet.
  - If the wallet has an old pending_payment bet, delete it and replace it.
    This lets the user change their mind before payment is confirmed.
*/
const createBetIntentTx = db.transaction(({
  raceId,
  cycleId,
  wallet,
  betType,
  carId,
  trifectaOrder,
  stakeAmount
}) => {
  /*
    Check if this wallet already has a bet for this race.

    The UNIQUE(race_id, wallet) database rule protects this too,
    but checking here lets us return a nicer error message.
  */
  const existingBet = db.prepare(`
    SELECT id, status
    FROM bets
    WHERE race_id = ? AND wallet = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(raceId, wallet);

  /*
    If the wallet already has a real active/confirmed/settled bet,
    do not allow a second bet for the same race.
  */
  if (existingBet && existingBet.status !== "pending_payment") {
    const err = new Error("Wallet has already placed a bet for this race");
    err.statusCode = 400;
    throw err;
  }

  /*
    If there is an unfinished pending bet, remove it.

    Example:
    - user selected Car 1
    - wallet/payment was cancelled
    - user then selects Car 2

    This prevents old pending bets from blocking a fresh attempt.
  */
  if (existingBet && existingBet.status === "pending_payment") {
    db.prepare(`
      DELETE FROM bets
      WHERE id = ?
    `).run(existingBet.id);
  }

  /*
    Normalize and validate the selected bet.

    For winner:
    - requires one valid carId

    For trifecta:
    - requires exactly 3 unique valid cars
    - stores the first car as the primary car_id
      so older HUD code can still show a backed/primary car.
  */
  const normalized = normalizeBetSelection({
    betType,
    carId,
    trifectaOrder
  });

  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.statusCode = 400;
    throw err;
  }

  /*
    Get the payout multiplier from backend rules.

    Winner = 2x
    Trifecta = 5x

    This must stay backend-controlled so users cannot alter payout
    by editing frontend JavaScript.
  */
  const payoutMultiplier = getPayoutMultiplierForBetType(betType);

  if (payoutMultiplier === null) {
    const err = new Error("Invalid payout multiplier");
    err.statusCode = 400;
    throw err;
  }

  /*
    Create the pending bet.

    potentialPayout is precomputed and stored so settlement can refer
    to the value that was valid at the time the bet was created.
  */
  const betId = nanoid();
  const potentialPayout = Math.floor(stakeAmount * payoutMultiplier);

  db.prepare(`
    INSERT INTO bets (
      id,
      race_id,
      cycle_id,
      wallet,
      bet_type,
      car_id,
      trifecta_first_car_id,
      trifecta_second_car_id,
      trifecta_third_car_id,
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    betId,
    raceId,
    cycleId,
    wallet,
    betType,
    normalized.primaryCarId,
    normalized.trifectaFirstCarId,
    normalized.trifectaSecondCarId,
    normalized.trifectaThirdCarId,
    TOKEN_SYMBOL,
    stakeAmount,
    payoutMultiplier,
    potentialPayout,
    "pending_payment",
    null,
    null,
    nowIso(),
    null,
    null
  );

  /*
    Return enough information for the frontend to show the pending bet.

    The returned values are still not final until the bet is confirmed.
  */
  return {
    betId,
    raceId,
    cycleId,
    betType,
    carId: normalized.primaryCarId,
    trifectaOrder:
      betType === "trifecta"
        ? [
            normalized.trifectaFirstCarId,
            normalized.trifectaSecondCarId,
            normalized.trifectaThirdCarId
          ]
        : null,
    tokenSymbol: TOKEN_SYMBOL,
    stakeAmount,
    payoutMultiplier,
    potentialPayout
  };
});

/*
  confirmBetTx

  Confirms a pending bet after payment verification succeeds.

  This does two important things:

  1. Updates the bet:
     pending_payment -> confirmed

  2. Creates internal race boost tokens:
     - 3 tokens granted
     - 0 spent
     - status = reserved

  Important:
  These boost tokens are NOT crypto tokens.
  They are internal race-specific voting credits.

  Security notes:
  - Boost tokens are tied to race_id + wallet + bet_id.
  - They cannot transfer to another race.
  - They cannot be edited by the frontend.
  - They start as reserved and only become active when the race starts.
*/
const confirmBetTx = db.transaction(({
  bet,
  raceId,
  paymentTxSignature,
  messageSignature
}) => {
  /*
    Only pending bets can be confirmed.

    This prevents already confirmed/won/lost/refunded bets from being
    modified by calling the confirmation endpoint again.
  */
  if (bet.status !== "pending_payment") {
    const err = new Error("Bet is no longer awaiting payment");
    err.statusCode = 400;
    throw err;
  }

  /*
    Make sure the bet still belongs to the current race.

    This prevents a stale bet confirmation from being applied after
    the backend has moved to another race.
  */
  if (bet.race_id !== raceId) {
    const err = new Error("Bet does not belong to the current race");
    err.statusCode = 400;
    throw err;
  }

  const now = nowIso();

  /*
    Mark the bet as confirmed and store the payment proof.

    In demo mode the proof may be mock data.
    In devnet mode this should be a real verified transaction signature.
  */
  db.prepare(`
    UPDATE bets
    SET status = ?, payment_tx_signature = ?, message_signature = ?
    WHERE id = ?
  `).run("confirmed", paymentTxSignature, messageSignature, bet.id);

  /*
    Create the player's internal boost-token balance for this race.

    Status is "reserved" because the race may not have started yet.

    The tokens become usable only when:
    - the race starts
    - this row is changed to status = 'active'
    - the current cycle state is voting
  */
  db.prepare(`
    INSERT INTO race_boost_balances (
      race_id,
      wallet,
      bet_id,
      tokens_granted,
      tokens_spent,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bet.race_id,
    bet.wallet,
    bet.id,
    BOOST_TOKENS_PER_RACE,
    0,
    "reserved",
    now,
    now
  );

  /*
    Return confirmed bet details for frontend/HUD updates.
  */
  return {
    betId: bet.id,
    raceId: bet.race_id,
    betType: bet.bet_type,
    carId: bet.car_id,
    trifectaOrder:
      bet.bet_type === "trifecta"
        ? [
            bet.trifecta_first_car_id,
            bet.trifecta_second_car_id,
            bet.trifecta_third_car_id
          ]
        : null,
    stakeAmount: bet.stake_amount,
    payoutMultiplier: bet.payout_multiplier,
    potentialPayout: bet.potential_payout,
    boostTokens: {
      granted: BOOST_TOKENS_PER_RACE,
      spent: 0,
      remaining: BOOST_TOKENS_PER_RACE,
      status: "reserved"
    }
  };
});

/*
  submitRaceResultTx

  This transaction records the official final race result and settles
  all confirmed bets for that race in one safe database operation.

  Why it is a transaction:
  - If the race result is inserted but bet settlement fails, the database
    could end up in a half-finished state.
  - Wrapping both steps in a transaction means SQLite commits everything
    together or rolls everything back together.
*/
const submitRaceResultTx = db.transaction(
  ({ raceId, winningCarId, status, source }) => {
    /*
      Prevent duplicate settlement.

      race_results.race_id is already the PRIMARY KEY, so the database
      would reject duplicate race results anyway, but this check gives us
      a cleaner error message before trying the insert.
    */
    if (isRaceAlreadySettled(raceId)) {
      const err = new Error("Race result has already been submitted");
      err.statusCode = 400;
      throw err;
    }

    // Store one consistent timestamp for both the race result record
    // and the settlement operation that follows.
    const now = nowIso();

    /*
      Record the official result.

      Important:
      - This backend is not deciding the winner.
      - It is only storing the result submitted by the external car/race backend.
      - winningCarId will be a car ID for completed races.
      - winningCarId should be null for cancelled or invalid races.
    */
    db.prepare(`
      INSERT INTO race_results (
        race_id,
        winning_car_id,
        status,
        source,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      raceId,
      winningCarId,
      status,
      source,
      now
    );

    /*
      Settle all confirmed bets for this race.

      If status is:
      - completed: bets on winningCarId become "won", others become "lost"
      - cancelled/invalid: all confirmed bets become "refunded"

      The function returns a summary count so the API response can show
      how many bets were won, lost, or refunded.
    */
    const settlement = settleConfirmedBetsForRace(
      raceId,
      winningCarId,
      status
    );

    /*
      Return a clean summary object to the route handler.

      This is what POST /api/race/result can send back to the caller.
    */
    return {
      raceId,
      winningCarId,
      status,
      source,
      createdAt: now,
      settlement
    };
  }
);

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
    raceStarted: cycle.state !== "idle",

    /*
      Server time lets the frontend calculate countdowns using the backend's
      clock instead of each user's device clock.

      This prevents laptop/phone countdown differences if one device clock is
      a second or two out of sync.
    */
    serverTime: nowIso()
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
  ============================================================
  DEV / TEST ROUTE
  ============================================================

  POST /api/dev/mock-race-result

  Pulls a fake finishing order from fakeCarBackend.js and settles bets.

  This is temporary and should not be publicly usable in production.
*/

app.post("/api/dev/mock-race-result", requireAdmin, async (req, res) => {
  try {
    advanceCycleIfNeeded();

    const cycle = getCurrentCycle();

    if (!cycle) {
      return res.status(400).json({
        error: "No current race found"
      });
    }

    /*
      Do not allow mock results while the race is still idle.

      A confirmed bet can exist during idle, but the race has not actually run.
      Settlement should only happen after Start Race has been pressed.
    */
    if (cycle.state === "idle") {
      return res.status(400).json({
        error: "Cannot generate a race result before the race has started"
      });
    }

    const raceId = cycle.race_id;

    /*
      Make sure there is at least one confirmed bet for this race.
      If this is false, the mock result would settle zero bets.
    */
    if (!raceHasConfirmedBet(raceId)) {
      return res.status(400).json({
        error: `No confirmed bets found for race ${raceId}`
      });
    }

    /*
      Pretend we are pulling this from the external car backend.
    */
    const raceResult = await fetchFakeRaceResult(raceId);

    /*
      Record result, settle bets, and expire boost balances.
    */
    const settled = recordRaceResultAndSettleBetsTx(raceResult);

    /*
      After settlement, move the backend into the next idle race.

      This prevents the app getting stuck in a started/voting/boost race
      after the fake car backend has already declared a final result.
    */
    const nextCycle = startNextIdleRaceAfterSettlement(raceId);

    return res.json({
      success: true,
      ...settled,
      nextCycle: serializeCycle(nextCycle)
    });
  } catch (error) {
    console.error("Mock race result failed:", error);

    return res.status(500).json({
      error: error.message || "Failed to generate mock race result"
    });
  }
});

/*
  ------------------------------------------------------------
  ROUTES
  ------------------------------------------------------------
*/

/*
  GET /api/config

  Returns safe public app configuration for the frontend.

  Important:
  - Do NOT expose private keys or secrets here.
  - It is safe to expose public addresses such as token mint and treasury wallet.
  - The frontend uses this to know whether it is running in demo mode or devnet mode.
*/
app.get("/api/config", (req, res) => {
  return res.json({
    appMode: APP_MODE,
    demoMode: DEMO_MODE,

    solanaCluster: SOLANA_CLUSTER,
    solanaRpcUrl: SOLANA_RPC_URL,

    tokenSymbol: TOKEN_SYMBOL,
    tokenMint: TOKEN_MINT || null,
    treasuryWallet: TREASURY_WALLET || null
  });
});

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
  GET /api/race/:raceId/bets

  Returns all bets for a specific race.

  Why this exists:
  - /api/bet/current only checks the current active race
  - after a race ends, the backend creates a new idle race
  - this endpoint lets us inspect previous race bets and confirm whether
    they were marked as won, lost, or refunded

  This is useful for local testing and later for admin/result screens.
*/
app.get("/api/race/:raceId/bets", (req, res) => {
  const raceId = Number(req.params.raceId);

  if (!Number.isInteger(raceId) || raceId < 1) {
    return res.status(400).json({ error: "Invalid raceId" });
  }

  const bets = db.prepare(`
    SELECT
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
    FROM bets
    WHERE race_id = ?
    ORDER BY created_at ASC
  `).all(raceId);

  return res.json({
    raceId,
    bets
  });
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

  Demo-mode rule:
  - The race must currently be idle.
  - The race must have at least one confirmed bet.
  - This prevents empty races from being started.

  Later production note:
  - This route may become admin/race-backend controlled instead of
    being publicly triggered by the frontend.
*/
app.post("/api/race/start", (req, res) => {
  // Make sure any expired/finished cycle state is advanced before checking.
  advanceCycleIfNeeded();

  // Get the latest/current cycle after any possible advancement.
  const cycle = getCurrentCycle();

  /*
    Only idle races can be started.

    If the backend is already in starting/voting/finalizing/boost,
    the race is already underway and should not be started again.
  */
  if (cycle.state !== "idle") {
    return res.status(400).json({
      error: "Race countdown has already started"
    });
  }

  /*
    Backend safety check:
    Do not allow a race to start unless at least one confirmed bet exists
    for the current race.

    This protects against:
    - users clicking Start Race before backing a car
    - users calling POST /api/race/start directly from outside the UI
    - frontend state getting out of sync
  */
  if (!raceHasConfirmedBet(cycle.race_id)) {
    return res.status(400).json({
      error: "At least one confirmed bet is required before starting the race"
    });
  }

  /*
    Move the current idle cycle into the starting countdown.

    This does not immediately start boost voting.
    It begins the 20-second pre-race countdown first.
  */
  setCurrentCycleToStarting(cycle.id);

  /*
  Activate internal boost tokens for this race.

  Boost balances are created as "reserved" when bets are confirmed.
  Once the race starts, they become "active".

  This means:
  - users can place bets before the race starts
  - their boost tokens are prepared
  - but they cannot spend boost tokens until the race actually starts

  This also prevents users from receiving global reusable tokens.
  Tokens are always tied to one specific race.
*/
db.prepare(`
  UPDATE race_boost_balances
  SET status = 'active', updated_at = ?
  WHERE race_id = ? AND status = 'reserved'
`).run(nowIso(), cycle.race_id);

  /*
    Return the new cycle state so the frontend can immediately update
    without waiting for the next polling interval.
  */
  return res.json({
    success: true,
    cycle: serializeCycle(getCurrentCycle())
  });
});

/*
  POST /api/vote-intent

  Creates a temporary vote intent for the current voting cycle.

  This does NOT count as a confirmed vote yet.

  Flow:
  1. Frontend asks to create vote intent.
  2. Backend checks voting is open.
  3. Backend checks wallet/car/bet/token permissions.
  4. Backend creates vote_intents row.
  5. Frontend later confirms the vote.

  Why have a vote intent?
  - keeps the vote flow clean
  - prevents old/random confirmations
  - binds wallet + car + cycle together before final confirmation
*/
app.post("/api/vote-intent", (req, res) => {
  /*
    Advance the backend state machine first.

    Example:
    If the voting timer has expired, this may move the race into finalizing,
    and voting should no longer be allowed.
  */
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  /*
    Votes can only be created while the current state is voting.
  */
  if (cycle.state !== "voting") {
    return res.status(400).json({ error: "Voting is not open" });
  }

  const { wallet, carId } = req.body ?? {};

  /*
    Validate wallet and car input.

    Never trust frontend values.
  */
  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  if (!isValidCarId(carId)) {
    return res.status(400).json({ error: "Invalid carId" });
  }

  /*
    Wallet must have a confirmed bet for this race before it can vote.
  */
  const bet = getConfirmedBetForWalletRace(wallet, cycle.race_id);

  if (!bet) {
    return res.status(400).json({
      error: "You need a confirmed bet for this race before voting"
    });
  }

  /*
    Enforce bet-type boost permissions.

    Winner bet:
    - only selected winner car

    Trifecta bet:
    - any car in trifecta order
  */
  if (!isCarAllowedForBet(bet, carId)) {
    return res.status(400).json({
      error: "This bet type cannot boost that car"
    });
  }

  /*
    Check backend-owned boost-token balance.

    Tokens must be active, meaning the race has started.
  */
  const balance = getBoostBalance(wallet, cycle.race_id);

  if (!balance || balance.status !== "active") {
    return res.status(400).json({
      error: "Boost tokens are not active for this race"
    });
  }

  /*
    Check whether the wallet has any boost tokens left.
  */
  if (balance.tokens_spent >= balance.tokens_granted) {
    return res.status(400).json({
      error: "No boost tokens remaining"
    });
  }

  try {
    /*
      Create the vote intent.

      This transaction also checks that the wallet has not already voted
      in this cycle and does not already have an active intent.
    */
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

      /*
        Each confirmed vote will cost 1 internal boost token.
      */
      tokenCost: 1,

      /*
        Return current token balance for the frontend HUD.
        Note: tokens are not spent until the vote is confirmed.
      */
      boostTokens: {
        granted: balance.tokens_granted,
        spent: balance.tokens_spent,
        remaining: balance.tokens_granted - balance.tokens_spent,
        status: balance.status
      }
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
      raceId: result.raceId || cycle.race_id,
      cycleNumber: cycle.cycle_number,
      carId: result.carId,
      boostTokens: result.boostTokens || null
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

  Creates a pending bet before payment confirmation.

  Supports both request shapes:

  Existing winner-bet frontend:
  {
    wallet,
    carId,
    stakeAmount
  }

  New trifecta frontend later:
  {
    wallet,
    betType: "trifecta",
    trifectaOrder: ["Car 2", "Car 1", "Car 3"],
    stakeAmount
  }

  If betType is omitted, it defaults to "winner".
  This keeps your current frontend working while you build the new UI.
*/
app.post("/api/bet-intent", (req, res) => {
  /*
    Move backend state forward if any timers have expired.
  */
  advanceCycleIfNeeded();

  const cycle = getCurrentCycle();

  /*
    Only allow betting while race is idle or starting.

    Current rule:
    - idle = betting open
    - starting = betting still open during countdown
    - voting/finalizing/boost = betting locked
  */
  if (!isRaceOpenForBetting(cycle)) {
    return res.status(400).json({
      error: "Betting is closed for this race"
    });
  }

  /*
    Backward-compatible input handling.

    Existing frontend does not send betType yet,
    so default to "winner".
  */
  const {
    wallet,
    betType = "winner",
    carId = null,
    trifectaOrder = null,
    stakeAmount
  } = req.body ?? {};

  /*
    Validate wallet.
  */
  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  /*
    Validate bet type:
    - winner
    - trifecta
  */
  if (!isValidBetType(betType)) {
    return res.status(400).json({ error: "Invalid bet type" });
  }

  /*
    Validate stake amount.
    Current allowed amounts are still: 1, 5, 10.
  */
  if (!isValidBetAmount(stakeAmount)) {
    return res.status(400).json({ error: "Invalid stake amount" });
  }

  /*
    Create the pending bet.

    createBetIntentTx validates:
    - winner selected car
    - trifecta order
    - payout multiplier
    - one bet per wallet per race
  */
  try {
    const result = createBetIntentTx({
      raceId: cycle.race_id,
      cycleId: cycle.id,
      wallet,
      betType,
      carId,
      trifectaOrder,
      stakeAmount
    });

    return res.json(result);
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
app.post("/api/bet-submit", async (req, res) => {
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
    Verify payment proof before confirming the bet.

    Demo mode:
    - accepts mock signatures

    Devnet mode:
    - verifies the actual Solana transaction
  */
  const verification = await verifyBetPaymentProof({
    wallet,
    paymentTxSignature,
    bet
  });

  if (!verification.ok) {
    return res.status(400).json({
      error: verification.error || "Bet payment verification failed"
    });
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
  GET /api/bet/latest-settled?wallet=...

  Returns the most recent settled bet for this wallet.

  Settled means:
  - won
  - lost
  - refunded

  This is useful for the HUD so the frontend can still show
  the latest race outcome after the backend has already moved
  on to the next idle race.
*/
app.get("/api/bet/latest-settled", (req, res) => {
  const wallet = req.query.wallet;

  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  const bet = db.prepare(`
    SELECT
      b.id,
      b.race_id,
      b.cycle_id,
      b.wallet,

      b.bet_type,
      b.car_id,
      b.trifecta_first_car_id,
      b.trifecta_second_car_id,
      b.trifecta_third_car_id,

      b.token_symbol,
      b.stake_amount,
      b.payout_multiplier,
      b.potential_payout,
      b.status,
      b.payment_tx_signature,
      b.message_signature,
      b.created_at,
      b.settled_at,
      b.refunded_at,

      rr.winning_car_id,
      rr.first_car_id,
      rr.second_car_id,
      rr.third_car_id,
      rr.status AS race_result_status,
      rr.source AS race_result_source,
      rr.created_at AS race_result_created_at

    FROM bets b
    LEFT JOIN race_results rr
      ON rr.race_id = b.race_id
    WHERE b.wallet = ?
      AND b.status IN ('won', 'lost', 'refunded')
    ORDER BY
      COALESCE(b.settled_at, b.refunded_at, b.created_at) DESC
    LIMIT 1
`).get(wallet);

  return res.json({
    bet: bet || null
  });
});

/*
  GET /api/boost-balance?wallet=...

  Returns the current wallet's internal boost-token balance
  for the current race.

  This is used by the frontend HUD to show:

  Boost Tokens: 2 / 3

  Important:
  - This endpoint only displays backend state.
  - The frontend must not calculate or enforce token balance itself.
  - confirmVoteTx is still the real security gate.
*/
app.get("/api/boost-balance", (req, res) => {
  /*
    Advance race state first so the returned balance matches
    the current backend race.
  */
  advanceCycleIfNeeded();

  const wallet = String(req.query.wallet || "");
  const cycle = getCurrentCycle();

  /*
    Validate wallet query param.
  */
  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet" });
  }

  /*
    Get this wallet's boost-token balance for the current race.
  */
  const balance = getBoostBalance(wallet, cycle.race_id);

  /*
    If the wallet has no confirmed bet/balance for this race,
    return null rather than treating it as an error.
  */
  if (!balance) {
    return res.json({
      raceId: cycle.race_id,
      wallet,
      boostTokens: null
    });
  }

  /*
    Return granted/spent/remaining values for the HUD.
  */
  return res.json({
    raceId: cycle.race_id,
    wallet,
    boostTokens: {
      granted: balance.tokens_granted,
      spent: balance.tokens_spent,
      remaining: balance.tokens_granted - balance.tokens_spent,
      status: balance.status
    }
  });
});

/*
  GET /api/boost-power/current

  Returns live boost-power percentages for the race HUD.

  For now this is a placeholder because the car backend will eventually
  calculate real boost power using:
  - repeated boost wins
  - current race position
  - rubber-banding logic

  The website/backend should display these values,
  but the car backend should own the real racing effect.
*/
app.get("/api/boost-power/current", (req, res) => {
  /*
    Advance race state first so the response matches the current cycle.
  */
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  /*
    Temporary placeholder values.

    Later, replace these with real values submitted by or fetched from
    the car/race backend.
  */
  return res.json({
    raceId: cycle.race_id,
    cycleId: cycle.id,
    cycleNumber: cycle.cycle_number,
    state: cycle.state,
    boostPower: [
      { carId: "Car 1", percent: 100 },
      { carId: "Car 2", percent: 100 },
      { carId: "Car 3", percent: 100 }
    ]
  });
});

/*
  POST /api/race/result

  Receives the official final race result from the external car/race backend.

  Important:
  - This betting backend does NOT decide the race winner.
  - This endpoint only accepts and records the final result.
  - Once accepted, confirmed bets for that race are settled.
  - Protected by requireAdmin so random users cannot submit race results.

  Example completed body:
  {
    "raceId": 7,
    "winningCarId": "Car 2",
    "status": "completed",
    "source": "car-backend"
  }

  Example cancelled body:
  {
    "raceId": 7,
    "status": "cancelled",
    "source": "manual-test"
  }
*/
app.post("/api/race/result", requireAdmin, (req, res) => {
  const {
    raceId,
    winningCarId = null,
    status,
    source = "unknown"
  } = req.body || {};

  if (!Number.isInteger(raceId) || raceId < 1) {
    return res.status(400).json({ error: "Invalid raceId" });
  }

  if (!isValidRaceResultStatus(status)) {
    return res.status(400).json({ error: "Invalid race result status" });
  }

  if (status === "completed" && !isValidCarId(winningCarId)) {
    return res.status(400).json({
      error: "Completed race results require a valid winningCarId"
    });
  }

  if (
    (status === "cancelled" || status === "invalid") &&
    winningCarId !== null
  ) {
    return res.status(400).json({
      error: "Cancelled or invalid races should not include winningCarId"
    });
  }

  if (typeof source !== "string" || source.length < 2 || source.length > 64) {
    return res.status(400).json({ error: "Invalid result source" });
  }

  const raceExists = db.prepare(`
    SELECT race_id FROM cycles WHERE race_id = ? LIMIT 1
  `).get(raceId);

  if (!raceExists) {
    return res.status(404).json({ error: "Race not found" });
  }

  try {
    const result = submitRaceResultTx({
      raceId,
      winningCarId,
      status,
      source
    });

    return res.json({
      success: true,
      result
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "Failed to submit race result"
    });
  }
});

/*
  GET /api/race/result/:raceId

  Returns the official final result for a race, if one has been submitted.
*/
app.get("/api/race/result/:raceId", (req, res) => {
  const raceId = Number(req.params.raceId);

  if (!Number.isInteger(raceId) || raceId < 1) {
    return res.status(400).json({ error: "Invalid raceId" });
  }

  const result = db.prepare(`
    SELECT *
    FROM race_results
    WHERE race_id = ?
  `).get(raceId);

  return res.json({
    result: result || null
  });
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