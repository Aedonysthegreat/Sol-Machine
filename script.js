const API_BASE = "http://localhost:3001/api"; // Replace with real backend url later

const boostTimer = document.getElementById("boostTimer");
const connectWalletBtn = document.getElementById("connectWalletBtn");
const carSelects = document.querySelectorAll(".car-select");
const boostButtons = document.querySelectorAll(".boost-btn");

const CycleState = {
  VOTING: "voting",
  FINALIZING: "finalizing",
  BOOST: "boost"
};

let currentCycleId = null;
let currentState = null;
let currentWinnerCarId = null;
let currentCycleEndsAt = null;
let selectedCarId = null;
let currentVoteIntentId = null;
let pollInterval = null;
let countdownInterval = null;

let isSubmittingVote = false;
let submittingVoteCycleId = null;

let lockedCarId = localStorage.getItem("lockedCarId") || null;

let votedCycleId = Number(localStorage.getItem("votedCycleId")) || null;

const VOTING_DURATION = 60;
const FINALIZING_DURATION = 3;
const BOOST_DURATION = 10;

const DEMO_WALLET = "DemoWallet123";

let activeBoostCard = null;

function applyCarSelectionUI() {
  const activeCarId = lockedCarId || selectedCarId;
  const allCarCards = document.querySelectorAll(".car-card");

  allCarCards.forEach((carCard) => {
    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");

    if (!select || !button) return;

    if (activeCarId) {
      if (carCard.dataset.car === activeCarId) {
        carCard.classList.remove("hidden");
        select.classList.add("hidden");
        button.classList.remove("hidden");
      } else {
        carCard.classList.add("hidden");
      }
    } else {
      carCard.classList.remove("hidden");
      select.classList.remove("hidden");
      button.classList.add("hidden");
    }
  });
}

function getCarCardByCarId(carId) {
  return Array.from(document.querySelectorAll(".car-card")).find((card) => {
    return card.dataset.car === carId;
  }) || null;
}

async function fetchCurrentCycle() {
  const res = await fetch(`${API_BASE}/cycle/current`);
  if (!res.ok) throw new Error("Failed to fetch current cycle");
  return res.json();
}

async function fetchCycleResult() {
  const res = await fetch(`${API_BASE}/cycle/result`);
  if (!res.ok) throw new Error("Failed to fetch cycle result");
  return res.json();
}

async function syncFromBackend() {
  try {
    const cycle = await fetchCurrentCycle();

    currentCycleId = cycle.id;
    currentState = cycle.state;
    currentWinnerCarId = cycle.winnerCarId;
    currentCycleEndsAt = cycle.endsAt;

    if (votedCycleId !== null && votedCycleId !== currentCycleId && currentState === "voting") {
      votedCycleId = null;
      localStorage.removeItem("votedCycleId");
    }

    renderStateFromBackend();
    document.querySelector(".page")?.classList.add("ready");
  } catch (error) {
    console.error("Backend sync failed:", error);
    boostTimer.textContent = "Connection issue";
  }
}

function renderStateFromBackend() {
  clearAllBoostFlames();
  applyCarSelectionUI();

  const allCarCards = document.querySelectorAll(".car-card");
  const activeCarId = lockedCarId || selectedCarId;

  if (currentState === "voting") {
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

  if (currentState === "finalizing") {
    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (button) {
        button.disabled = true;
        button.textContent = "Authenticating..."
      }
    });
  }

  if (currentState === "boost") {
    allCarCards.forEach((carCard) => {
      const button = carCard.querySelector(".boost-btn");
      if (button) {
        button.disabled = true;
        button.textContent = "Boosting..."
      }
    });

    if (currentWinnerCarId) {
      const winningCard = getCarCardByCarId(currentWinnerCarId);
      if (winningCard) {
        const winningImage = winningCard.querySelector(".car-image");
        if (winningImage) {
          winningImage.classList.add("boost-active");
        }
      }
    }
  }

  startCountdownToEndsAt();
}

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

function clearAllBoostFlames() {
  document.querySelectorAll(".car-image").forEach((image) => {
    image.classList.remove("boost-active");
  });
}

function switchToBoostButtons(selectedStatsCard) {
  const allCarCards = document.querySelectorAll(".car-card");

  allCarCards.forEach((carCard) => {
    const statsCard = carCard.querySelector(".stats-card");
    const select = carCard.querySelector(".car-select");
    const button = carCard.querySelector(".boost-btn");

    if (!statsCard || !select || !button) return;

    if (statsCard === selectedStatsCard) {
      select.classList.add("hidden");
      button.classList.remove("hidden");
      carCard.classList.remove("hidden");
    } else {
      carCard.classList.add("hidden");
    }
  });
}

carSelects.forEach((select) => {
  select.addEventListener("change", (event) => {
    if (currentState !== "voting") return;

    const chosenValue = event.target.value;
    if (chosenValue === "") return;

    const statsCard = event.target.closest(".stats-card");
    selectedCarId = event.target.closest(".car-card").dataset.car;

    switchToBoostButtons(statsCard);
  });
});

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

function startBackendPolling() {
  clearInterval(pollInterval);

  syncFromBackend();

  pollInterval = setInterval(() => {
    syncFromBackend();
  }, 1000);
}

applyCarSelectionUI();
startBackendPolling();

function resetRaceSelection() {
  selectedCarId = null;
  lockedCarId = null;
  localStorage.removeItem("lockedCarId");
}

connectWalletBtn.addEventListener("click", () => {
  alert("Wallet connection will go here.");
});