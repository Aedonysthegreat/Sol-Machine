import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import db from "./db.js";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const VOTING_DURATION_MS = 60 * 1000;
const FINALIZING_DURATION_MS = 3 * 1000;
const BOOST_DURATION_MS = 10 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function seedInitialCycleIfNeeded() {
  const existing = db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT 1").get();
  if (existing) return;

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + VOTING_DURATION_MS);

  db.prepare(`
    INSERT INTO cycles (state, started_at, ends_at, winner_car_id)
    VALUES (?, ?, ?, ?)
  `).run("voting", startedAt.toISOString(), endsAt.toISOString(), null);
}

function getCurrentCycle() {
  return db.prepare("SELECT * FROM cycles ORDER BY id DESC LIMIT 1").get();
}

function setCycleState(id, state, durationMs, winnerCarId = null) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + durationMs);

  db.prepare(`
    UPDATE cycles
    SET state = ?, started_at = ?, ends_at = ?, winner_car_id = ?
    WHERE id = ?
  `).run(state, startedAt.toISOString(), endsAt.toISOString(), winnerCarId, id);
}

function startNextVotingCycle() {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + VOTING_DURATION_MS);

  db.prepare(`
    INSERT INTO cycles (state, started_at, ends_at, winner_car_id)
    VALUES (?, ?, ?, ?)
  `).run("voting", startedAt.toISOString(), endsAt.toISOString(), null);
}

function getWinningCarForCycle(cycleId) {
  const rows = db.prepare(`
    SELECT car_id, COUNT(*) as vote_count
    FROM votes
    WHERE cycle_id = ? AND status = 'confirmed'
    GROUP BY car_id
    ORDER BY vote_count DESC, car_id ASC
  `).all(cycleId);

  if (!rows.length) return "Car 1";
  return rows[0].car_id;
}

function advanceCycleIfNeeded() {
  const cycle = getCurrentCycle();
  if (!cycle) return;

  const endsAtMs = new Date(cycle.ends_at).getTime();
  if (nowMs() < endsAtMs) return;

  if (cycle.state === "voting") {
    setCycleState(cycle.id, "finalizing", FINALIZING_DURATION_MS, null);
    return;
  }

  if (cycle.state === "finalizing") {
    const winner = getWinningCarForCycle(cycle.id);
    setCycleState(cycle.id, "boost", BOOST_DURATION_MS, winner);
    return;
  }

  if (cycle.state === "boost") {
    startNextVotingCycle();
  }
}

setInterval(() => {
  advanceCycleIfNeeded();
}, 1000);

seedInitialCycleIfNeeded();

app.get("/api/cycle/current", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  res.json({
    id: cycle.id,
    state: cycle.state,
    startedAt: cycle.started_at,
    endsAt: cycle.ends_at,
    winnerCarId: cycle.winner_car_id
  });
});

app.get("/api/cycle/result", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  const totals = db.prepare(`
    SELECT car_id, COUNT(*) as vote_count
    FROM votes
    WHERE cycle_id = ? AND status = 'confirmed'
    GROUP BY car_id
  `).all(cycle.id);

  res.json({
    cycleId: cycle.id,
    state: cycle.state,
    winnerCarId: cycle.winner_car_id,
    totals
  });
});

app.post("/api/vote-intent", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state !== "voting") {
    return res.status(400).json({ error: "Voting is not open" });
  }

  const { wallet, carId } = req.body;

  if (!wallet || !carId) {
    return res.status(400).json({ error: "wallet and carId are required" });
  }

  const existingVote = db.prepare(`
    SELECT id FROM votes WHERE cycle_id = ? AND wallet = ?
  `).get(cycle.id, wallet);

  if (existingVote) {
    return res.status(400).json({ error: "Wallet has already voted this cycle" });
  }

  const intentId = nanoid();

  db.prepare(`
    INSERT INTO vote_intents (id, cycle_id, wallet, car_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(intentId, cycle.id, wallet, carId, "created", nowIso());

  res.json({
    intentId,
    cycleId: cycle.id,
    carId,
    tokenCost: 1
  });
});

app.post("/api/vote-submit", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state !== "voting") {
    return res.status(400).json({ error: "Voting is not open" });
  }

  const { intentId, wallet, txSignature, messageSignature } = req.body;

  if (!intentId || !wallet || !txSignature || !messageSignature) {
    return res.status(400).json({
      error: "intentId, wallet, txSignature, and messageSignature are required"
    });
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

  const existingVote = db.prepare(`
    SELECT id FROM votes WHERE cycle_id = ? AND wallet = ?
  `).get(cycle.id, wallet);

  if (existingVote) {
    return res.status(400).json({ error: "Wallet has already voted this cycle" });
  }

  // TEMPORARY MVP STUB:
  // Later this is where you verify:
  // - Solana tx exists
  // - correct mint
  // - exact amount = 1 token
  // - treasury destination
  // - tx confirmed
  const mockVerificationPassed = true;

  if (!mockVerificationPassed) {
    db.prepare(`
      UPDATE vote_intents SET status = ? WHERE id = ?
    `).run("rejected", intentId);

    return res.status(400).json({ error: "Vote payment verification failed" });
  }

  db.prepare(`
    INSERT INTO votes (cycle_id, wallet, car_id, tx_signature, message_signature, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cycle.id, wallet, intent.car_id, txSignature, messageSignature, "confirmed", nowIso());

  db.prepare(`
    UPDATE vote_intents SET status = ? WHERE id = ?
  `).run("confirmed", intentId);

  res.json({
    success: true,
    cycleId: cycle.id,
    carId: intent.car_id
  });
});

app.post("/api/admin/advance-cycle", (req, res) => {
  advanceCycleIfNeeded();
  const cycle = getCurrentCycle();

  if (cycle.state === "voting") {
    setCycleState(cycle.id, "finalizing", FINALIZING_DURATION_MS, null);
  } else if (cycle.state === "finalizing") {
    const winner = getWinningCarForCycle(cycle.id);
    setCycleState(cycle.id, "boost", BOOST_DURATION_MS, winner);
  } else {
    startNextVotingCycle();
  }

  res.json({ success: true, cycle: getCurrentCycle() });
});

app.listen(PORT, () => {
  console.log(`Sol Machine backend running on http://localhost:${PORT}`);
});