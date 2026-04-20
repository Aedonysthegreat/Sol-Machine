"use strict";

/*
  ============================================================
  CONFIG
  ============================================================
*/

// Base URL for your backend API.
// This should point at your live backend, including the /api prefix,
// because all backend routes are under /api/...
const API_BASE = "https://sol-machine-production.up.railway.app/api";

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
function showBoostResultModal(winnerCarId) {
  if (!boostResultModal || !boostResultText) return;

  boostResultText.textContent = `${winnerCarId} won the boost.`;
  boostResultModal.classList.remove("hidden");
  boostResultModal.setAttribute("aria-hidden", "false");
}

/*
  Hides the modal and restores it to its hidden state.
*/
function hideBoostResultModal() {
  if (!boostResultModal) return;

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

  This decides which car card should remain visible.

  Priority:
  1. lockedCarId
     The car currently "locked in" visually for this round

  2. pendingRaceStartCarId
     The car the user picked while race start is still transitioning

  3. selectedCarId
     The immediate current UI selection
*/
function applyCarSelectionUI() {
  const activeCarId = lockedCarId || pendingRaceStartCarId || selectedCarId;
  const allCarCards = document.querySelectorAll(".car-card");

  allCarCards.forEach((carCard) => {
    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");

    if (!select || !button) return;

    if (activeCarId) {
      // Show only the selected/locked car
      if (carCard.dataset.car === activeCarId) {
        carCard.classList.remove("hidden");
        select.classList.add("hidden");
        button.classList.remove("hidden");
      } else {
        carCard.classList.add("hidden");
      }
    } else {
      // No selected car yet -> show full selection UI
      carCard.classList.remove("hidden");
      select.classList.remove("hidden");
      button.classList.add("hidden");
    }
  });
}

/*
  renderIdleUI()

  Restores the "start state" UI:
  - all cars visible
  - dropdowns visible
  - boost buttons hidden
*/
function renderIdleUI() {
  document.querySelectorAll(".car-card").forEach((carCard) => {
    carCard.classList.remove("hidden");

    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");

    if (select) {
      select.classList.remove("hidden");
      select.value = "";
    }

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

    if (currentState === "voting") {
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
*/
function renderStateFromBackend() {
  clearAllBoostFlames();

  // ----------------------------------------------------------
  // IDLE
  // ----------------------------------------------------------
  if (currentState === "idle") {
    // If user has chosen a car and race start is still in progress,
    // keep showing that car instead of jumping back to select state.
    if (isStartingRace && (pendingRaceStartCarId || selectedCarId || lockedCarId)) {
      applyCarSelectionUI();
      boostTimer.textContent = "Starting race...";
      return;
    }

    // Only clear round state if we actually returned from an active race.
    if (previousState && previousState !== "idle") {
      resetRaceSelection();
    }

    renderIdleUI();
    return;
  }

  // Non-idle states always show the selected/locked car UI.
  applyCarSelectionUI();

  const allCarCards = document.querySelectorAll(".car-card");
  const activeCarId = lockedCarId || selectedCarId;

  // ----------------------------------------------------------
  // VOTING
  // ----------------------------------------------------------
  if (currentState === "voting") {
    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (!button) return;

      // Only the active car should be interactable.
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
    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (!button) return;

      button.disabled = true;
      button.textContent = "Boosting...";
    });

    // Add the flame effect to the winning car's video/image box.
    if (currentWinnerCarId) {
      const winningCard = getCarCardByCarId(currentWinnerCarId);
      const winningImage = winningCard?.querySelector(".car-image");

      if (winningImage) {
        winningImage.classList.add("boost-active");
      }
    }

    // Work out which car this user currently had selected.
    const userCarId = lockedCarId || selectedCarId;

    /*
      Show the result modal only if:
      - there is a winner
      - the user had chosen a car
      - the winning car is NOT the user's car
      - the popup has not already been shown for this cycle
    */
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

  startCountdownToEndsAt();
}

/*
  ============================================================
  EVENT HANDLERS
  ============================================================
*/

/*
  CAR SELECTION

  Flow:
  1. user picks a car from dropdown
  2. immediately show only that car
  3. if backend is idle -> start race
  4. if already voting -> just keep that car selected
*/
carSelects.forEach((select) => {
  select.addEventListener("change", async (event) => {
    const chosenValue = event.target.value;

    // Ignore blank/default option
    if (chosenValue === "") return;

    const chosenCarId = event.target.closest(".car-card")?.dataset.car;
    if (!chosenCarId) return;

    try {
      // Make sure frontend knows current backend state before acting.
      if (!hasInitialSync || currentState === null) {
        await syncFromBackend();
      }

      // Store UI selection.
      selectedCarId = chosenCarId;
      pendingRaceStartCarId = chosenCarId;
      lockedCarId = chosenCarId;
      localStorage.setItem("lockedCarId", lockedCarId);

      // Show selected car immediately.
      applyCarSelectionUI();

      // If idle, this selection starts the race.
      if (currentState === "idle") {
        isStartingRace = true;
        boostTimer.textContent = "Starting race...";

        clearInterval(pollInterval);

        const raceStartData = await startRace();
        applyCycleFromBackend(raceStartData.cycle);

        // Invalidate any old in-flight sync expectations.
        syncRequestCounter++;

        if (currentState === "idle") {
          // Backend has not transitioned visually yet; keep selection visible.
          applyCarSelectionUI();
          boostTimer.textContent = "Starting race...";
        } else {
          renderStateFromBackend();
        }

        startBackendPolling();
        return;
      }

      // If already in voting, just keep showing selected car.
      if (currentState === "voting") {
        applyCarSelectionUI();
      }
    } catch (error) {
      console.error(error);
      isStartingRace = false;
      boostTimer.textContent = "Unable to start race";
      startBackendPolling();
      alert(error.message);
    }
  });
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

// Start polling as soon as the script loads.
showBoostResultModal("Car 2");
startBackendPolling();