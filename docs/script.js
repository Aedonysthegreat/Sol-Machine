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
let lockedCarId = localStorage.getItem("lockedCarId") || null;

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
  isSubmittingBet = false;

  hideBoostResultModal();

  localStorage.removeItem("lockedCarId");
  localStorage.removeItem("votedCycleId");
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

  In demo mode:
  - paymentTxSignature is a fake mock value
  - messageSignature is a fake mock value

  Later:
  - these will come from the connected Solana wallet/payment flow
*/
async function submitBet(betId, wallet) {
  const fakePaymentTxSignature = `mock_bet_tx_${Date.now()}`;
  const fakeMessageSignature = `mock_bet_msg_${Date.now()}`;

  const res = await fetch(`${API_BASE}/bet-submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      betId,
      wallet,
      paymentTxSignature: fakePaymentTxSignature,
      messageSignature: fakeMessageSignature
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
  ============================================================
  BACKEND -> FRONTEND STATE SYNC
  ============================================================
*/

// Apply backend cycle data to frontend state.
function applyCycleFromBackend(cycle) {
  previousState = currentState;

  currentCycleId = cycle.id;
  currentState = cycle.state;
  currentWinnerCarId = cycle.winnerCarId ?? cycle.winner_car_id ?? null;
  currentCycleEndsAt = cycle.endsAt ?? cycle.ends_at ?? null;

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

    const msRemaining = new Date(currentCycleEndsAt).getTime() - Date.now();
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
    if (startRaceBtn) {
      startRaceBtn.disabled = false;
      startRaceBtn.textContent = "Start Race";
    }

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
    if (startRaceBtn) {
      startRaceBtn.disabled = true;
      startRaceBtn.textContent = "Race Starting";
    }

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
    if (startRaceBtn) {
      startRaceBtn.disabled = true;
      startRaceBtn.textContent = "Race Active";
    }

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
    if (startRaceBtn) {
      startRaceBtn.disabled = true;
      startRaceBtn.textContent = "Race Active";
    }

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
    if (startRaceBtn) {
      startRaceBtn.disabled = true;
      startRaceBtn.textContent = "Race Active";
    }

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

    console.log("Dropdown raw value:", chosenValue);

    if (chosenValue === "") return;

    const chosenCarId = select.closest(".car-card")?.dataset.car;
    if (!chosenCarId) return;

    const stakeAmount = Number.parseInt(chosenValue, 10);

    console.log("Parsed stake amount:", stakeAmount);

    if (!Number.isInteger(stakeAmount) || ![1, 5, 10].includes(stakeAmount)) {
      console.log("Invalid chosenValue:", chosenValue);
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

      isSubmittingBet = true;

      selectedCarId = chosenCarId;
      pendingRaceStartCarId = chosenCarId;
      lockedCarId = chosenCarId;
      localStorage.setItem("lockedCarId", lockedCarId);

      applyCarSelectionUI();

      boostTimer.textContent = "Submitting bet...";

      const betIntent = await createBetIntent(DEMO_WALLET, chosenCarId, stakeAmount);
      currentBetId = betIntent.betId;

      const betResult = await submitBet(betIntent.betId, DEMO_WALLET);

      currentBetStatus = "confirmed";
      isSubmittingBet = false;

      boostTimer.textContent = `Bet submitted: ${stakeAmount} ${betIntent.tokenSymbol} on ${chosenCarId}`;

      await syncFromBackend();
    } catch (error) {
      console.error(error);

      isSubmittingBet = false;
      selectedCarId = null;
      pendingRaceStartCarId = null;
      lockedCarId = null;
      currentBetId = null;
      currentBetStatus = null;

      localStorage.removeItem("lockedCarId");

      renderIdleUI();
      alert(error.message);
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
      startRaceBtn.disabled = false;
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
  Wallet connection placeholder.
  Later this becomes your real Solana wallet connect logic.
*/
connectWalletBtn.addEventListener("click", () => {
  alert("Wallet connection will go here.");
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

    console.log("Loaded app config:", appConfig);

    startBackendPolling();
  } catch (error) {
    console.error("App init failed:", error);

    if (boostTimer) {
      boostTimer.textContent = "Connection issue";
    }
  }
}

initApp();