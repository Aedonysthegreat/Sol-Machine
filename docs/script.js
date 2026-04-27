"use strict";

/*
  ============================================================
  CONFIG
  ============================================================
*/

// Base URL for your backend API.
// This should point at your live backend, including the /api prefix,
// because all backend routes are under /api/...
// const API_BASE = "https://sol-machine-production.up.railway.app/api";

// Local demo backend
const API_BASE = "http://localhost:3001/api";

/*
  ============================================================
  APP CONFIG STATE
  ============================================================

  The backend tells the frontend which mode we are running in.

  demo:
  - use current generated demo wallet
  - use mock transaction signatures
  - current working flow remains unchanged

  devnet:
  - use real Solana wallet connection
  - create real Devnet transactions
  - backend verifies transaction signatures
*/
let appConfig = {
  appMode: "demo",
  demoMode: true,
  solanaCluster: "devnet",
  solanaRpcUrl: "https://api.devnet.solana.com",
  tokenSymbol: "BOOST",
  tokenMint: null,
  treasuryWallet: null
};

/*
  Difference between backend server time and this device's local time.

  Why:
  - countdown end times are created by the backend
  - Date.now() uses the user's device clock
  - different devices can be 1-2 seconds apart
  - using this offset makes all devices count down from backend time
*/
let serverTimeOffsetMs = 0;

/*
  Fetch safe public config from the backend.

  This lets backend .env settings control app mode instead of hardcoding
  demo/devnet behaviour throughout the frontend.
*/
async function fetchAppConfig() {
  const res = await fetch(`${API_BASE}/config?ts=${Date.now()}`, {
    cache: "no-store"
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to fetch app config");
  }

  appConfig = {
    ...appConfig,
    ...data
  };

  return appConfig;
}

/*
  Demo wallet helper.

  While real Solana wallet connection is not implemented yet,
  each browser/device gets its own generated demo wallet ID.

  Why this matters:
  - if the wallet were hardcoded, phone + laptop would look like
    the same player to the backend
  - storing it in localStorage means each device keeps its own
    stable demo identity between refreshes
*/
function getDemoWallet() {
  let demoWallet = localStorage.getItem("demoWallet");

  if (!demoWallet) {
    demoWallet = `DemoWallet_${crypto.randomUUID()}`;
    localStorage.setItem("demoWallet", demoWallet);
  }

  return demoWallet;
}

// The current demo wallet used by this device/browser.
const DEMO_WALLET = getDemoWallet();

/*
  ============================================================
  DOM REFERENCES
  ============================================================
*/

// Timer/status text at the top of the page.
const boostTimer = document.getElementById("boostTimer");

// Placeholder wallet button.
const connectWalletBtn = document.getElementById("connectWalletBtn");

// Button to start a 20 second delay before race starts
const startRaceBtn = document.getElementById("startRaceBtn");

// Car selects and boost buttons.
// These are queried once on load because the page structure is static.
const carSelects = document.querySelectorAll(".car-select");
const boostButtons = document.querySelectorAll(".boost-btn");

/*
  Modal elements used for the "you did not win the boost" popup.

  boostResultModal:
    the dark full-screen overlay

  boostResultText:
    the text node inside the modal that gets updated with the winner

  closeBoostResultModalBtn:
    the button used to dismiss the popup
*/
const boostResultModal = document.getElementById("boostResultModal");
const boostResultText = document.getElementById("boostResultText");
const closeBoostResultModalBtn = document.getElementById("closeBoostResultModal");

/*
  HUD DOM REFERENCES

  These elements display:
  - the current bet
  - the latest settled race result
  - app/wallet/network info
*/
const hudCurrentRaceId = document.getElementById("hudCurrentRaceId");
const hudSelectedCar = document.getElementById("hudSelectedCar");
const hudStakeAmount = document.getElementById("hudStakeAmount");
const hudPotentialPayout = document.getElementById("hudPotentialPayout");
const hudBetStatus = document.getElementById("hudBetStatus");

const hudResultRaceId = document.getElementById("hudResultRaceId");
const hudRaceOutcome = document.getElementById("hudRaceOutcome");
const hudWinningCar = document.getElementById("hudWinningCar");
const hudYourResult = document.getElementById("hudYourResult");
const hudSettlement = document.getElementById("hudSettlement");

const hudAppMode = document.getElementById("hudAppMode");
const hudNetwork = document.getElementById("hudNetwork");
const hudTokenSymbol = document.getElementById("hudTokenSymbol");
const hudWallet = document.getElementById("hudWallet");

/*
  ============================================================
  APP STATE
  ============================================================
  These variables track the frontend's current understanding of:
  - the backend cycle state
  - which car the user has chosen
  - whether a vote is being submitted
  - what the UI should currently show
*/

// Current backend cycle info.
let currentCycleId = null;
let currentState = null;
let currentWinnerCarId = null;
let currentCycleEndsAt = null;
let previousState = null;

// Car selection state:
// selectedCarId:
//   current UI selection for this round
//
// pendingRaceStartCarId:
//   used while user has selected a car but backend is still transitioning
//   from idle -> voting
//
// lockedCarId:
//   the car we keep visible for the current round so the UI does not jump around
let selectedCarId = null;
let pendingRaceStartCarId = null;

/*
  Do not restore lockedCarId directly from localStorage on page load.

  Why:
  - localStorage can survive page refreshes, backend resets, failed wallet
    transactions, or race changes
  - if lockedCarId is restored without a confirmed backend bet, the UI can
    jump straight to the selected-car screen and soft-lock

  From now on, lockedCarId should only be restored from backend truth via
  restoreCurrentBetFromBackend().
*/
let lockedCarId = null;

// Vote submission state.
let currentVoteIntentId = null;
let isSubmittingVote = false;
let submittingVoteCycleId = null;

// Tracks which cycle the user already voted in.
// Stored in localStorage so a refresh keeps the "Vote Submitted" state.
let votedCycleId = Number(localStorage.getItem("votedCycleId")) || null;

// Polling / countdown intervals.
let pollInterval = null;
let countdownInterval = null;

// Used to ignore stale backend sync responses.
let syncRequestCounter = 0;

// Frontend flow flags.
let isStartingRace = false;
let hasInitialSync = false;

/*
  Tracks which cycle has already shown the "lost boost" popup.

  This prevents the modal from repeatedly reopening every time
  renderStateFromBackend() runs during the same boost cycle.
*/
let shownBoostResultCycleId = null;

// Betting states
let currentBetId = null;
let currentBetStatus = null;
let isSubmittingBet = false;

/*
  HUD DATA STATE

  currentBetDetails:
    the current active-race bet for this wallet, if any

  latestSettledBetDetails:
    the most recent won/lost/refunded bet for this wallet
*/
let currentBetDetails = null;
let latestSettledBetDetails = null;

/*
  ============================================================
  WALLET STATE
  ============================================================

  Demo mode:
  - uses DEMO_WALLET generated from localStorage

  Devnet mode:
  - uses a real injected Solana wallet such as Phantom or Solflare
  - connectedWalletPublicKey becomes the wallet address used for bets/votes
*/
let connectedWalletPublicKey = null;
let isWalletConnecting = false;

/*
  ============================================================
  UI HELPERS
  ============================================================
*/

/*
  Shows the styled result modal when another car wins the boost.

  This is only meant to appear if:
  - the user had selected a car
  - the winning car is different from the user's car
  - the popup has not already been shown for this cycle
*/
let boostToastTimeout = null;

function showBoostResultModal(winnerCarId) {
  if (!boostResultModal || !boostResultText) return;

  boostResultText.textContent = `${winnerCarId} took the boost this round.`;
  boostResultModal.classList.remove("hidden");
  boostResultModal.setAttribute("aria-hidden", "false");

  clearTimeout(boostToastTimeout);
  boostToastTimeout = setTimeout(() => {
    hideBoostResultModal();
  }, 3500);
}

/*
  Hides the modal and restores it to its hidden state.
*/
function hideBoostResultModal() {
  if (!boostResultModal) return;

  clearTimeout(boostToastTimeout);
  boostResultModal.classList.add("hidden");
  boostResultModal.setAttribute("aria-hidden", "true");
}

// Returns the DOM card for a given car ID.
function getCarCardByCarId(carId) {
  return (
    Array.from(document.querySelectorAll(".car-card")).find(
      (card) => card.dataset.car === carId
    ) || null
  );
}

// Removes boost flame effect from all car images.
function clearAllBoostFlames() {
  document.querySelectorAll(".car-image").forEach((image) => {
    image.classList.remove("boost-active");
  });
}

/*
  applyCarSelectionUI()

  Controls which car card is visible and how that card is laid out.

  Important state behaviour:
  - idle:
      keep selected car visible after a confirmed bet,
      but do NOT show the Boost button yet
  - starting:
      show the Boost button, but disable it while the race countdown runs
  - voting:
      show the Boost button so the user can vote for the boost
  - finalizing/boost:
      show the button, but renderStateFromBackend() disables it
*/
function applyCarSelectionUI() {
  const activeCarId = lockedCarId || pendingRaceStartCarId || selectedCarId;
  const allCarCards = document.querySelectorAll(".car-card");
  const carsGrid = document.querySelector(".cars-grid");

  allCarCards.forEach((carCard) => {
    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");
    const statsCard = carCard.querySelector(".stats-card");

    if (!select || !button || !statsCard) return;

    if (activeCarId) {
      if (carCard.dataset.car === activeCarId) {
        carCard.classList.remove("hidden");

        // Once a car is selected/bet on, hide the bet controls and stats panel.
        select.classList.add("hidden");
        statsCard.classList.add("hidden");

        /*
          Idle behaviour:
          The user has selected/bet on a car, but the race has not started.
          Keep the chosen car view visible, but do not show Boost yet.
        */
        if (currentState === "idle") {
          button.classList.add("hidden");
          button.disabled = true;
          button.textContent = "Boost";
        }

        /*
          Starting behaviour:
          Race countdown is running.
          Show the button location so the layout is stable, but block clicking.
        */
        else if (currentState === "starting") {
          button.classList.remove("hidden");
          button.disabled = true;
          button.textContent = "Boost Locked";
        }

        /*
          Active race behaviour:
          Show the button. The exact enabled/disabled text is handled later
          in renderStateFromBackend() depending on voting/finalizing/boost.
        */
        else {
          button.classList.remove("hidden");
        }
      } else {
        carCard.classList.add("hidden");
      }
    } else {
      // No car selected yet, so restore the full default card layout.
      carCard.classList.remove("hidden");
      select.classList.remove("hidden");
      statsCard.classList.remove("hidden");

      button.classList.add("hidden");
      button.disabled = false;
      button.textContent = "Boost";
    }
  });

  const visibleCards = Array.from(allCarCards).filter(
    (card) => !card.classList.contains("hidden")
  );

  carsGrid?.classList.toggle("single-car-view", visibleCards.length === 1);
}

/*
  renderIdleUI()

  Resets the car section back to its default pre-race / idle layout.

  What it restores:
  - removes the enlarged single-car layout
  - shows all car cards again
  - shows each stats panel again
  - shows each bet dropdown again
  - hides all Boost buttons
  - resets button state and text

  This is used when the app returns to idle so the user sees the full
  starting selection screen again rather than the stripped-down chosen-car view.
*/
function renderIdleUI() {
  // Return the grid to its normal multi-car layout.
  document.querySelector(".cars-grid")?.classList.remove("single-car-view");

  document.querySelectorAll(".car-card").forEach((carCard) => {
    carCard.classList.remove("hidden");

    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");
    const statsCard = carCard.querySelector(".stats-card");

    // Show the stats panel again in idle mode.
    if (statsCard) {
      statsCard.classList.remove("hidden");
    }

    // Show the dropdown again and reset it to the default option.
    if (select) {
      select.classList.remove("hidden");
      select.value = "";
    }

    // Hide the Boost button and reset its state.
    if (button) {
      button.classList.add("hidden");
      button.disabled = false;
      button.textContent = "Boost";
    }
  });

  updateStartRaceButton();

  boostTimer.textContent = "Select a car to start the race";
}

/*
  resetRaceSelection()

  Clears all round-specific frontend state.
  Called only when a race has actually returned to idle after running.

  Also closes the result modal so it does not hang around between rounds.
*/
function resetRaceSelection() {
  selectedCarId = null;
  pendingRaceStartCarId = null;
  lockedCarId = null;

  currentVoteIntentId = null;
  votedCycleId = null;
  isSubmittingVote = false;
  submittingVoteCycleId = null;
  shownBoostResultCycleId = null;

  // Clear old bet state from the completed race.
  currentBetId = null;
  currentBetStatus = null;
  currentBetDetails = null;
  isSubmittingBet = false;

  hideBoostResultModal();

  localStorage.removeItem("lockedCarId");
  localStorage.removeItem("votedCycleId");
}

/*
  Returns true if the browser has an injected Solana wallet.

  Phantom, Solflare, and other Solana wallets may expose themselves through
  window.solana. For this first devnet step, we keep it simple and use that
  provider directly.
*/
function hasInjectedSolanaWallet() {
  return typeof window !== "undefined" && Boolean(window.solana);
}

/*
  Returns the active wallet ID that should be sent to the backend.

  Demo mode:
  - use the existing generated DEMO_WALLET

  Devnet mode:
  - use the connected wallet public key
*/
function getActiveWallet() {
  if (appConfig.appMode === "devnet") {
    return connectedWalletPublicKey;
  }

  return DEMO_WALLET;
}

/*
  Updates the wallet button text based on the current mode and connection state.
*/
function updateWalletButton() {
  if (!connectWalletBtn) return;

  if (appConfig.appMode === "demo") {
    connectWalletBtn.textContent = "Demo Wallet";
    connectWalletBtn.disabled = false;
    return;
  }

  if (isWalletConnecting) {
    connectWalletBtn.textContent = "Connecting...";
    connectWalletBtn.disabled = true;
    return;
  }

  if (connectedWalletPublicKey) {
    /*
      Show a shortened wallet address so the UI stays clean.
      Example:
      7xK...9ab
    */
    const start = connectedWalletPublicKey.slice(0, 4);
    const end = connectedWalletPublicKey.slice(-4);

    connectWalletBtn.textContent = `${start}...${end}`;
    connectWalletBtn.disabled = false;
    return;
  }

  connectWalletBtn.textContent = "Connect Wallet";
  connectWalletBtn.disabled = false;
}

/*
  Connects to an injected Solana wallet.

  This is devnet-mode only.
  It does not send transactions yet.
*/
async function connectSolanaWallet() {
  if (appConfig.appMode !== "devnet") {
    alert("Demo mode is active. Real wallet connection is only used in devnet mode.");
    return;
  }

  if (!hasInjectedSolanaWallet()) {
    alert("No Solana wallet found. Install Phantom or Solflare, then refresh.");
    return;
  }

  try {
    isWalletConnecting = true;
    updateWalletButton();

    /*
      Only wallet connection belongs inside this try/catch.

      If this succeeds, connectedWalletPublicKey is set.
    */
    const response = await window.solana.connect();

    connectedWalletPublicKey = response.publicKey.toString();
  } catch (error) {
    console.error("Wallet connection failed:", error);
    alert("Wallet connection was cancelled or failed.");
    return;
  } finally {
    isWalletConnecting = false;
    updateWalletButton();
  }

  /*
    Refresh HUD after wallet connection, but do not treat HUD/backend issues
    as wallet connection failures.
  */
  try {
    await refreshHudData();
  } catch (error) {
    console.error("HUD refresh after wallet connect failed:", error);
    updateHud();
  }
}

/*
  Attempts to reconnect silently if the wallet was already trusted.

  This avoids forcing the wallet popup every page refresh.
*/
async function trySilentWalletReconnect() {
  if (appConfig.appMode !== "devnet") return;
  if (!hasInjectedSolanaWallet()) return;

  try {
    const reconnectTimeoutMs = 3000;

    const response = await Promise.race([
      window.solana.connect({ onlyIfTrusted: true }),

      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("Silent wallet reconnect timed out"));
        }, reconnectTimeoutMs);
      })
    ]);

    connectedWalletPublicKey = response.publicKey.toString();

    try {
      await refreshHudData();
    } catch (error) {
      console.error("HUD refresh after silent reconnect failed:", error);
      updateHud();
    }
  } catch {
    connectedWalletPublicKey = null;
    updateHud();
  } finally {
    updateWalletButton();
  }
}

/*
  Shows a temporary bet/payment status in the top bar.

  This is used while the wallet/payment flow is still in progress,
  before the backend has confirmed the bet.
*/
function setBetPendingMessage(message) {
  if (!boostTimer) return;
  boostTimer.textContent = message;
}

/*
  Returns true only when this browser/wallet has a confirmed bet
  for the current race.

  Start Race should only be clickable after this is true.
*/
function userHasConfirmedBet() {
  return currentBetStatus === "confirmed" && currentBetId !== null;
}

/*
  Central place to control the Start Race button.

  Rules:
  - idle + confirmed bet = enabled
  - idle + no confirmed bet = disabled
  - starting/active race = disabled
*/
function updateStartRaceButton() {
  if (!startRaceBtn) return;

  if (currentState === "idle" && userHasConfirmedBet()) {
    startRaceBtn.disabled = false;
    startRaceBtn.textContent = "Start Race";
    return;
  }

  if (currentState === "starting") {
    startRaceBtn.disabled = true;
    startRaceBtn.textContent = "Race Starting";
    return;
  }

  if (
    currentState === "voting" ||
    currentState === "finalizing" ||
    currentState === "boost"
  ) {
    startRaceBtn.disabled = true;
    startRaceBtn.textContent = "Race Active";
    return;
  }

  startRaceBtn.disabled = true;
  startRaceBtn.textContent = "Start Race";
}

/*
  Returns a short middle-truncated string for long values like wallets.
*/
function shortenMiddle(value, start = 4, end = 4) {
  if (!value || typeof value !== "string") return "—";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

/*
  Converts backend status values into friendly display text.
*/
function formatStatusLabel(status) {
  switch (status) {
    case "pending_payment":
      return "Pending";
    case "confirmed":
      return "Confirmed";
    case "won":
      return "Won";
    case "lost":
      return "Lost";
    case "refunded":
      return "Refunded";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case "invalid":
      return "Invalid";
    default:
      return "—";
  }
}

/*
  Returns the CSS status class to apply to HUD status pills.
*/
function getStatusClass(status) {
  switch (status) {
    case "pending_payment":
      return "status-pending";
    case "confirmed":
      return "status-confirmed";
    case "won":
      return "status-won";
    case "lost":
      return "status-lost";
    case "refunded":
      return "status-refunded";
    default:
      return "";
  }
}

/*
  Applies text + status class to a HUD status field.
*/
function setHudStatus(el, status) {
  if (!el) return;

  el.textContent = formatStatusLabel(status);

  el.classList.remove(
    "status-pending",
    "status-confirmed",
    "status-won",
    "status-lost",
    "status-refunded"
  );

  const nextClass = getStatusClass(status);
  if (nextClass) {
    el.classList.add(nextClass);
  }
}

/*
  Formats the settlement line for the latest result panel.
*/
function formatSettlementValue(bet) {
  if (!bet) return "—";

  if (bet.status === "won") {
    return `+${bet.potential_payout} ${bet.token_symbol}`;
  }

  if (bet.status === "refunded") {
    return `Refunded ${bet.stake_amount} ${bet.token_symbol}`;
  }

  if (bet.status === "lost") {
    return `-${bet.stake_amount} ${bet.token_symbol}`;
  }

  return "—";
}

/*
  Renders the betting HUD from frontend state.

  Panel 1:
  - current active bet

  Panel 2:
  - most recent settled result

  Panel 3:
  - app/wallet info
*/
function updateHud() {
  const activeWallet = getActiveWallet();

  // ----------------------------------------------------------
  // SYSTEM PANEL
  // ----------------------------------------------------------
  if (hudAppMode) {
    hudAppMode.textContent = appConfig.appMode?.toUpperCase() || "—";
  }

  if (hudNetwork) {
    hudNetwork.textContent = appConfig.solanaCluster || "—";
  }

  if (hudTokenSymbol) {
    hudTokenSymbol.textContent = appConfig.tokenSymbol || "—";
  }

  if (hudWallet) {
    hudWallet.textContent = activeWallet ? shortenMiddle(activeWallet) : "Not connected";
  }

  // ----------------------------------------------------------
  // CURRENT BET PANEL
  // ----------------------------------------------------------
  if (currentBetDetails) {
    if (hudCurrentRaceId) {
      hudCurrentRaceId.textContent = currentBetDetails.race_id ?? "—";
    }

    if (hudSelectedCar) {
      hudSelectedCar.textContent = currentBetDetails.car_id ?? "—";
    }

    if (hudStakeAmount) {
      hudStakeAmount.textContent = `${currentBetDetails.stake_amount} ${currentBetDetails.token_symbol}`;
    }

    if (hudPotentialPayout) {
      hudPotentialPayout.textContent = `${currentBetDetails.potential_payout} ${currentBetDetails.token_symbol}`;
    }

    setHudStatus(hudBetStatus, currentBetDetails.status);
  } else {
    if (hudCurrentRaceId) hudCurrentRaceId.textContent = "—";
    if (hudSelectedCar) hudSelectedCar.textContent = "—";
    if (hudStakeAmount) hudStakeAmount.textContent = "—";
    if (hudPotentialPayout) hudPotentialPayout.textContent = "—";
    setHudStatus(hudBetStatus, null);
  }

  // ----------------------------------------------------------
  // LATEST RESULT PANEL
  // ----------------------------------------------------------
  if (latestSettledBetDetails) {
    if (hudResultRaceId) {
      hudResultRaceId.textContent = latestSettledBetDetails.race_id ?? "—";
    }

    if (hudRaceOutcome) {
      hudRaceOutcome.textContent = formatStatusLabel(
        latestSettledBetDetails.race_result_status
      );
    }

    if (hudWinningCar) {
      hudWinningCar.textContent = latestSettledBetDetails.winning_car_id || "—";
    }

    setHudStatus(hudYourResult, latestSettledBetDetails.status);

    if (hudSettlement) {
      hudSettlement.textContent = formatSettlementValue(latestSettledBetDetails);
    }
  } else {
    if (hudResultRaceId) hudResultRaceId.textContent = "—";
    if (hudRaceOutcome) hudRaceOutcome.textContent = "—";
    if (hudWinningCar) hudWinningCar.textContent = "—";
    setHudStatus(hudYourResult, null);
    if (hudSettlement) hudSettlement.textContent = "—";
  }
}

/*
  ============================================================
  DEVNET SOL PAYMENT HELPERS
  ============================================================

  First devnet payment version:
  - uses SOL, not SPL tokens yet
  - sends a small Devnet SOL transfer from the connected wallet
    to the treasury wallet from /api/config
  - returns the transaction signature so the backend can record it

  Later:
  - we will verify the signature on the backend
  - then we can swap SOL transfers for SPL token transfers
*/

/*
  Sends a Devnet SOL payment for a bet.

  This should trigger the Phantom transaction approval popup.
*/
async function sendDevnetBetPayment(stakeAmount) {

  if (appConfig.appMode !== "devnet") {
    throw new Error("Devnet payment called while not in devnet mode");
  }

  if (!connectedWalletPublicKey) {
    throw new Error("Connect your wallet before placing a devnet bet");
  }

  if (!appConfig.treasuryWallet) {
    throw new Error("Treasury wallet is not configured");
  }

  if (!window.solana) {
    throw new Error("No Solana wallet found");
  }

  if (!window.solanaWeb3) {
    throw new Error("Solana Web3.js is not loaded");
  }

  /*
    Use the browser bundle directly from window so we do not rely on
    a global variable name that may not exist in every browser.
  */
  const web3 = window.solanaWeb3;

  const connection = new web3.Connection(
    appConfig.solanaRpcUrl,
    "confirmed"
  );

  const fromPubkey = new web3.PublicKey(connectedWalletPublicKey);
  const toPubkey = new web3.PublicKey(appConfig.treasuryWallet);

  const lamports = Math.round(stakeAmount * 0.001 * web3.LAMPORTS_PER_SOL);

  const transaction = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports
    })
  );

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");

  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.feePayer = fromPubkey;

  const result = await window.solana.signAndSendTransaction(transaction);

  const signature =
    typeof result === "string" ? result : result.signature;

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    "confirmed"
  );

  if (confirmation.value.err) {
    console.error("Devnet transaction failed:", confirmation.value.err);
    throw new Error("Devnet transaction failed or was reverted");
  }

  return signature;
  }

/*
  ============================================================
  BACKEND REQUEST HELPERS
  ============================================================
*/

// Fetch current cycle state from backend.
async function fetchCurrentCycle() {
  const res = await fetch(`${API_BASE}/cycle/current?ts=${Date.now()}`, {
    cache: "no-store"
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to fetch current cycle");
  }

  return data;
}

// Start race from idle.
async function startRace() {
  const res = await fetch(`${API_BASE}/race/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to start race");
  }

  return data;
}

/*
  Creates a pending bet intent on the backend.

  This does not confirm the bet yet.
  It tells the backend:
  - which wallet
  - which car
  - which stake amount
*/
async function createBetIntent(wallet, carId, stakeAmount) {
  const res = await fetch(`${API_BASE}/bet-intent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      wallet,
      carId,
      stakeAmount
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to create bet intent");
  }

  return data;
}

/*
  Submits the bet payment proof.

  Demo mode:
  - uses fake mock transaction signatures

  Devnet mode:
  - sends a real Devnet SOL transfer
  - sends the real transaction signature to the backend
*/

async function submitBet(betId, wallet, stakeAmount) {

  let paymentTxSignature;
  let messageSignature;

  if (appConfig.appMode === "devnet") {
    /*
      Real Devnet payment.

      This is the part that should trigger the Phantom approval popup.
      If you are not seeing the popup, this branch is probably not running.
    */

    paymentTxSignature = await sendDevnetBetPayment(stakeAmount);

    /*
      Temporary placeholder.
      Later we can replace this with a signed message or memo.
    */
    messageSignature = `devnet_msg_${Date.now()}`;
  } else {
    /*
      Existing demo behaviour.
    */
    paymentTxSignature = `mock_bet_tx_${Date.now()}`;
    messageSignature = `mock_bet_msg_${Date.now()}`;
  }

  const res = await fetch(`${API_BASE}/bet-submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      betId,
      wallet,
      paymentTxSignature,
      messageSignature
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to submit bet");
  }

  return data;
}

/*
  Fetches this wallet's current bet for the active race.
  Useful after refresh so the UI can recover the user's bet state.
*/
async function fetchCurrentBet(wallet) {
  const res = await fetch(
    `${API_BASE}/bet/current?wallet=${encodeURIComponent(wallet)}`,
    {
      cache: "no-store"
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to fetch current bet");
  }

  return data.bet;
}

/*
  Restore this wallet's confirmed/current bet from the backend.

  Backend is the source of truth.

  This prevents stale localStorage from deciding whether the UI should show
  the selected-car screen.
*/
async function restoreCurrentBetFromBackend() {
  const activeWallet = getActiveWallet();

  /*
    In devnet mode, the wallet may not be connected yet.
    If there is no active wallet, clear local selected-car state.
  */
  if (!activeWallet) {
    currentBetId = null;
    currentBetStatus = null;
    currentBetDetails = null;
    selectedCarId = null;
    pendingRaceStartCarId = null;
    lockedCarId = null;
    localStorage.removeItem("lockedCarId");
    return;
  }

  const bet = await fetchCurrentBet(activeWallet);
  currentBetDetails = bet || null;

  /*
    No current bet for this wallet/race.
    Clear local selected-card state.
  */
  if (!bet) {
    currentBetId = null;
    currentBetStatus = null;
    selectedCarId = null;
    pendingRaceStartCarId = null;
    lockedCarId = null;
    localStorage.removeItem("lockedCarId");
    return;
  }

  /*
    Only confirmed bets should lock the UI into selected-car view.

    Pending payments should not lock the user because wallet transactions can
    be cancelled, fail, or be retried.
  */
  if (bet.status !== "confirmed") {
    currentBetId = bet.id;
    currentBetStatus = bet.status;
    selectedCarId = null;
    pendingRaceStartCarId = null;
    lockedCarId = null;
    localStorage.removeItem("lockedCarId");
    return;
  }

  currentBetId = bet.id;
  currentBetStatus = bet.status;
  selectedCarId = bet.car_id;
  pendingRaceStartCarId = null;
  lockedCarId = bet.car_id;

  localStorage.setItem("lockedCarId", lockedCarId);
}

// Create vote intent.
// Backend stores wallet + cycle + car selection and returns an intent ID.
async function createVoteIntent(wallet, carId) {
  const res = await fetch(`${API_BASE}/vote-intent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ wallet, carId })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to create vote intent");
  }

  return data;
}

// Submit vote against an existing intent.
// For demo mode, signatures are fake placeholders.
// Later this is where real wallet signature / tx data will be sent.
async function submitVote(intentId, wallet) {
  const fakeTxSignature = `mock_tx_${Date.now()}`;
  const fakeMessageSignature = `mock_msg_${Date.now()}`;

  const res = await fetch(`${API_BASE}/vote-submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      intentId,
      wallet,
      txSignature: fakeTxSignature,
      messageSignature: fakeMessageSignature
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to submit vote");
  }

  return data;
}

/*
  Fetch the most recent settled bet for this wallet.

  This lets the HUD show the latest race outcome even after
  the backend has already moved on to the next idle race.
*/
async function fetchLatestSettledBet(wallet) {
  const res = await fetch(
    `${API_BASE}/bet/latest-settled?wallet=${encodeURIComponent(wallet)}`,
    {
      cache: "no-store"
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to fetch latest settled bet");
  }

  return data.bet;
}

/*
  Refreshes HUD-specific data from the backend.

  This fetches:
  - current active bet
  - latest settled result

  Then re-renders the HUD.
*/
async function refreshHudData() {
  const activeWallet = getActiveWallet();

  if (!activeWallet) {
    currentBetDetails = null;
    latestSettledBetDetails = null;
    updateHud();
    return;
  }

  /*
    currentBetDetails is already refreshed by restoreCurrentBetFromBackend().
    Here we only fetch the latest settled result for the result panel.
  */
  latestSettledBetDetails = await fetchLatestSettledBet(activeWallet);

  updateHud();
}

/*
  ============================================================
  BACKEND -> FRONTEND STATE SYNC
  ============================================================
*/

function applyCycleFromBackend(cycle) {
  previousState = currentState;

  currentCycleId = cycle.id;
  currentState = cycle.state;
  currentWinnerCarId = cycle.winnerCarId ?? cycle.winner_car_id ?? null;
  currentCycleEndsAt = cycle.endsAt ?? cycle.ends_at ?? null;

  /*
    Calculate how far this device's clock is from the backend clock.

    Example:
    - if the laptop clock is 2 seconds behind the server,
      serverTimeOffsetMs will be about +2000
    - countdowns then use Date.now() + serverTimeOffsetMs
  */
  if (cycle.serverTime) {
    const serverNowMs = new Date(cycle.serverTime).getTime();

    if (Number.isFinite(serverNowMs)) {
      serverTimeOffsetMs = serverNowMs - Date.now();
    }
  }

  // Once backend leaves idle, race start is no longer "pending"
  if (currentState !== "idle") {
    pendingRaceStartCarId = null;
    isStartingRace = false;
  }

  hasInitialSync = true;
}

/*
  syncFromBackend()

  Polls the backend for latest cycle state and updates the UI.

  Important:
  syncRequestCounter protects against stale responses arriving out of order.
*/
async function syncFromBackend() {
  /*
    If a bet/payment is currently being submitted, do not let the normal
    backend polling renderer overwrite the top-bar message.

    Without this, the UI can briefly show:
    "Select a car to start the race"
    while the wallet popup/payment confirmation is still pending.
  */
  if (isSubmittingBet) {
    return;
  }

  const requestId = ++syncRequestCounter;

  try {
    const cycle = await fetchCurrentCycle();

    // Ignore stale request responses that finished after a newer one started.
    if (requestId < syncRequestCounter) {
      return;
    }

    // If we are starting a race and backend still says idle,
    // keep showing "Starting race..." rather than resetting UI.
    if (isStartingRace && cycle.state === "idle") {
      return;
    }

    applyCycleFromBackend(cycle);

    /*
      While the app is waiting to start, restore the current wallet's bet from
      the backend before rendering.

      This means selected-car view is based on a confirmed backend bet, not stale
      browser storage.
    */
    if (!isSubmittingBet && (currentState === "idle" || currentState === "starting")) {
      await restoreCurrentBetFromBackend();
    }

    /*
      Refresh the HUD so the betting and latest-result panels stay in sync
      with backend truth.
    */
    await refreshHudData();

    // If we have moved into a new voting cycle, clear old voted state.
    if (
      votedCycleId !== null &&
      votedCycleId !== currentCycleId &&
      currentState === "voting"
    ) {
      votedCycleId = null;
      localStorage.removeItem("votedCycleId");
    }

    renderStateFromBackend();

    // Add a "ready" class once we have at least one successful sync.
    document.querySelector(".page")?.classList.add("ready");
  } catch (error) {
    console.error("Backend sync failed:", error);

    // Only replace timer text if this was the newest request.
    if (requestId === syncRequestCounter) {
      boostTimer.textContent = "Connection issue";
    }
  }
}

/*
  ============================================================
  RENDERING
  ============================================================
*/

// Starts or refreshes the countdown timer based on backend endsAt.
function startCountdownToEndsAt() {
  clearInterval(countdownInterval);

  function updateCountdown() {
    if (!currentCycleEndsAt) return;

    const serverAdjustedNowMs = Date.now() + serverTimeOffsetMs;
    const msRemaining = new Date(currentCycleEndsAt).getTime() - serverAdjustedNowMs;
    const seconds = Math.max(0, Math.ceil(msRemaining / 1000));

    if (currentState === "starting") {
      boostTimer.textContent = `Race starts in: ${seconds}s`;
    } else if (currentState === "voting") {
      boostTimer.textContent = `Vote closes in: ${seconds}s`;
    } else if (currentState === "finalizing") {
      boostTimer.textContent = `Finalizing boost... ${seconds}s`;
    } else if (currentState === "boost") {
      boostTimer.textContent = `Boost active: ${seconds}s`;
    }
  }

  updateCountdown();
  countdownInterval = setInterval(updateCountdown, 250);
}

/*
  renderStateFromBackend()

  Main UI renderer based on backend cycle state.

  Important:
  - idle no longer always means "reset the UI"
  - if the user has already submitted a bet in the current idle race,
    we keep the chosen car locked on screen while waiting for Start Race
*/
function renderStateFromBackend() {
  clearAllBoostFlames();

  const hasLockedBetView =
    currentBetStatus === "confirmed" ||
    currentBetId !== null ||
    lockedCarId !== null ||
    selectedCarId !== null;

  // ----------------------------------------------------------
  // IDLE
  // ----------------------------------------------------------
  if (currentState === "idle") {
    /*
      Start Race should only be enabled after a confirmed bet.
    */
    updateStartRaceButton();

    /*
      If we just came back from an active race, reset everything.
      This is the true end-of-race reset.
    */
    if (previousState && previousState !== "idle") {
      resetRaceSelection();
      renderIdleUI();
      return;
    }

    /*
      If the user has already placed a bet while the race is still idle,
      keep the selected car view instead of resetting back to the dropdowns.
    */
    if (hasLockedBetView) {
      applyCarSelectionUI();

      if (currentBetStatus === "confirmed") {
        boostTimer.textContent = "Bet submitted. Waiting for race start.";
      } else {
        boostTimer.textContent = "Select a car to start the race";
      }

      return;
    }

    renderIdleUI();
    return;
  }

  // Non-idle states should keep the selected/locked car UI.
  applyCarSelectionUI();

  // ----------------------------------------------------------
  // STARTING
  // ----------------------------------------------------------
  if (currentState === "starting") {
    updateStartRaceButton();

    document.querySelectorAll(".boost-btn").forEach((button) => {
      button.disabled = true;
      button.textContent = "Boost Locked";
    });

    startCountdownToEndsAt();
    return;
  }

  const allCarCards = document.querySelectorAll(".car-card");
  const activeCarId = lockedCarId || selectedCarId;

  // ----------------------------------------------------------
  // VOTING
  // ----------------------------------------------------------
  if (currentState === "voting") {
    updateStartRaceButton();

    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (!button) return;

      if (!activeCarId || carCard.dataset.car === activeCarId) {
        if (isSubmittingVote && submittingVoteCycleId === currentCycleId) {
          button.disabled = true;
          button.textContent = "Submitting...";
        } else if (votedCycleId === currentCycleId) {
          button.disabled = true;
          button.textContent = "Vote Submitted";
        } else {
          button.disabled = false;
          button.textContent = "Boost";
        }
      }
    });
  }

  // ----------------------------------------------------------
  // FINALIZING
  // ----------------------------------------------------------
  if (currentState === "finalizing") {
    updateStartRaceButton();

    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (!button) return;

      button.disabled = true;
      button.textContent = "Authenticating...";
    });
  }

  // ----------------------------------------------------------
  // BOOST
  // ----------------------------------------------------------
  if (currentState === "boost") {
    updateStartRaceButton();

    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (!button) return;

      button.disabled = true;
      button.textContent = "Boosting...";
    });

    if (currentWinnerCarId) {
      const winningCard = getCarCardByCarId(currentWinnerCarId);
      const winningImage = winningCard?.querySelector(".car-image");

      if (winningImage) {
        winningImage.classList.add("boost-active");
      }
    }

    const userCarId = lockedCarId || selectedCarId;

    if (
      currentWinnerCarId &&
      userCarId &&
      currentWinnerCarId !== userCarId &&
      shownBoostResultCycleId !== currentCycleId
    ) {
      shownBoostResultCycleId = currentCycleId;
      showBoostResultModal(currentWinnerCarId);
    }
  }

  // Keep the timer running for voting/finalizing/boost.
  startCountdownToEndsAt();
}

/*
  ============================================================
  EVENT HANDLERS
  ============================================================
*/

/*
  CAR / BET SELECTION

  New Option B flow:
  1. user chooses a car and stake amount from the dropdown
  2. frontend creates a bet intent
  3. frontend submits mock payment proof
  4. backend confirms the bet
  5. UI locks onto that car and shows the Boost button area
  6. race only starts when Start Race is clicked separately
*/

carSelects.forEach((select) => {
  select.addEventListener("change", async () => {
    const chosenValue = select.value;

    if (chosenValue === "") return;

    const chosenCarId = select.closest(".car-card")?.dataset.car;
    if (!chosenCarId) return;

    const stakeAmount = Number.parseInt(chosenValue, 10);

    if (!Number.isInteger(stakeAmount) || ![1, 5, 10].includes(stakeAmount)) {
      alert("Invalid bet amount selected");
      select.value = "";
      return;
    }

    try {

      if (!hasInitialSync || currentState === null) {
        await syncFromBackend();
      }

      if (currentState !== "idle" && currentState !== "starting") {
        alert("Betting is closed for this race");
        select.value = "";
        return;
      }

      const activeWallet = getActiveWallet();

      if (!activeWallet) {
        /*
          Important:
          If we return here, we must not leave the UI half-locked.
        */
        alert("Connect your wallet before placing a bet.");
        select.value = "";
        renderIdleUI();
        return;
      }

      /*
        Bet is starting, but do NOT lock the selected car UI yet.

        In devnet mode, the user still needs to approve the wallet transaction,
        the transaction needs to confirm, and the backend needs to accept /bet-submit.

        If we lock the UI before that, the frontend can look like the bet worked
        even when the backend has no confirmed bet.
      */
      isSubmittingBet = true;

      setBetPendingMessage("Preparing wallet confirmation...");

      boostTimer.textContent =
        appConfig.appMode === "devnet"
          ? "Preparing wallet transaction..."
          : "Submitting bet...";

      const betIntent = await createBetIntent(
        activeWallet,
        chosenCarId,
        stakeAmount
      );

      currentBetId = betIntent.betId;

      setBetPendingMessage("Waiting for wallet approval...");

      boostTimer.textContent = "Waiting for wallet approval...";

      await submitBet(
        betIntent.betId,
        activeWallet,
        stakeAmount
      );

      /*
        Only now is the bet actually confirmed.

        This point means:
        - demo mode: mock submit succeeded
        - devnet mode: wallet tx succeeded and /api/bet-submit accepted it
      */
      currentBetStatus = "confirmed";
      isSubmittingBet = false;

      selectedCarId = chosenCarId;
      pendingRaceStartCarId = null;
      lockedCarId = chosenCarId;
      localStorage.setItem("lockedCarId", lockedCarId);

      /*
        Update current bet HUD data immediately so the panel changes
        without waiting for the next polling cycle.
      */
      currentBetDetails = {
        id: betIntent.betId,
        race_id: betIntent.raceId,
        cycle_id: betIntent.cycleId,
        car_id: chosenCarId,
        token_symbol: betIntent.tokenSymbol,
        stake_amount: stakeAmount,
        payout_multiplier: betIntent.payoutMultiplier,
        potential_payout: betIntent.potentialPayout,
        status: "confirmed"
      };

      updateHud();

      applyCarSelectionUI();

      updateStartRaceButton();

      boostTimer.textContent = `Bet submitted: ${stakeAmount} ${betIntent.tokenSymbol} on ${chosenCarId}`;

      /*
        Do not immediately sync here while debugging.
        We want to preserve the confirmed selected-car UI first.
      */
    } catch (error) {
      console.error("Bet flow failed:", error);

      isSubmittingBet = false;
      selectedCarId = null;
      pendingRaceStartCarId = null;
      lockedCarId = null;
      currentBetId = null;
      currentBetStatus = null;
      currentBetDetails = null;

      localStorage.removeItem("lockedCarId");

      renderIdleUI();
      updateHud();

      boostTimer.textContent = "Bet was not confirmed. Please try again.";

      alert(error.message || "Bet failed");
    }
  });
});

/*
  START RACE BUTTON

  Starts the shared backend-owned 20-second countdown.

  Betting stays open during "starting".
  Betting locks once backend moves to "voting".
*/
startRaceBtn?.addEventListener("click", async () => {
  if (!userHasConfirmedBet()) {
    alert("Please back a car before starting the race.");
    updateStartRaceButton();
    return;
  }

  try {
    if (!hasInitialSync || currentState === null) {
      await syncFromBackend();
    }

    if (currentState !== "idle") {
      alert("Race countdown has already started or race is active");
      return;
    }

    startRaceBtn.disabled = true;
    startRaceBtn.textContent = "Starting...";

    const raceStartData = await startRace();

    applyCycleFromBackend(raceStartData.cycle);
    renderStateFromBackend();

    await syncFromBackend();
  } catch (error) {
    console.error(error);

    if (startRaceBtn) {
      startRaceBtn.disabled = currentBetStatus !== "confirmed";
      startRaceBtn.textContent = "Start Race";
    }

    alert(error.message);
  }
});

/*
  BOOST BUTTON CLICK

  Flow:
  1. make sure we are in voting state
  2. create vote intent
  3. submit vote
  4. mark current cycle as voted
  5. refresh UI from backend
*/
boostButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (currentState !== "voting") return;

    const carId = lockedCarId || selectedCarId;
    if (!carId) return;

    try {
      isSubmittingVote = true;
      submittingVoteCycleId = currentCycleId;

      button.disabled = true;
      button.textContent = "Submitting...";

      const intent = await createVoteIntent(DEMO_WALLET, carId);
      currentVoteIntentId = intent.intentId;

      const voteResult = await submitVote(intent.intentId, DEMO_WALLET);

      votedCycleId = voteResult.cycleId;
      localStorage.setItem("votedCycleId", String(votedCycleId));

      isSubmittingVote = false;
      submittingVoteCycleId = null;

      // Keep chosen car visually locked for this cycle.
      lockedCarId = carId;
      localStorage.setItem("lockedCarId", lockedCarId);

      button.textContent = "Vote Submitted";

      await syncFromBackend();
    } catch (error) {
      console.error(error);

      isSubmittingVote = false;
      submittingVoteCycleId = null;

      button.disabled = false;
      button.textContent = "Boost";

      alert(error.message);
    }
  });
});

/*
  Wallet connection button.

  Demo mode:
  - just shows that a generated demo wallet is being used

  Devnet mode:
  - connects to the injected Solana wallet
*/
connectWalletBtn.addEventListener("click", async () => {
  if (appConfig.appMode === "demo") {
    alert(`Demo wallet active:\n${DEMO_WALLET}`);
    return;
  }

  await connectSolanaWallet();
});

/*
  Modal close handlers:
  - clicking the close button hides the popup
  - clicking the dark overlay outside the modal card also hides it
*/
closeBoostResultModalBtn?.addEventListener("click", hideBoostResultModal);

boostResultModal?.addEventListener("click", (event) => {
  if (event.target === boostResultModal) {
    hideBoostResultModal();
  }
});

/*
  ============================================================
  POLLING
  ============================================================
*/

// Starts backend polling loop.
// This keeps the frontend synced to cycle changes.
function startBackendPolling() {
  clearInterval(pollInterval);

  syncFromBackend();

  pollInterval = setInterval(() => {
    syncFromBackend();
  }, 1000);
}

/*
  ============================================================
  APP START
  ============================================================
*/

/*
  Initial app load.

  Important:
  - Load app config first.
  - Then start the existing backend polling.
  - This does not change race, bet, or vote behaviour.
*/
async function initApp() {
  try {
    await fetchAppConfig();

    updateWalletButton();

    /*
      Render the HUD immediately with config/default values.

      At this point:
      - app mode is known
      - network/token are known
      - wallet may not be connected yet
    */
    updateHud();

    /*
      Start backend polling first so the top bar and race UI render even if
      Phantom is having extension/provider issues.
    */
    startBackendPolling();

    /*
      Wallet reconnect should not block the app from loading.

      If reconnect succeeds, trySilentWalletReconnect() will refresh the HUD.
      If it fails, the HUD still shows Not connected.
    */
    trySilentWalletReconnect().catch((error) => {
      updateHud();
    });
  } catch (error) {
    console.error("App init failed:", error);

    if (boostTimer) {
      boostTimer.textContent = "Connection issue";
    }
  }
}

initApp();