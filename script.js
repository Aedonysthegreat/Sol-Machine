const boostTimer = document.getElementById("boostTimer");
const connectWalletBtn = document.getElementById("connectWalletBtn");
const carSelects = document.querySelectorAll(".car-select");
const boostButtons = document.querySelectorAll(".boost-btn");

let boostCooldown = 10;
let cooldownRemaining = 0;
let cooldownInterval = null;

let activeBoostCard = null;

function clearAllBoostFlames() {
  document.querySelectorAll(".car-image").forEach((image) => {
    image.classList.remove("boost-active");
  });
}

function setBoostFlamesFromButton(button) {
  clearAllBoostFlames();

  const statsCard = button.closest(".stats-card");
  if (!statsCard) return;

  const allStatsCards = Array.from(document.querySelectorAll(".stats-card"));
  const cardIndex = allStatsCards.indexOf(statsCard);

  const carImages = document.querySelectorAll(".car-image");
  const targetImage = carImages[cardIndex];

  if (targetImage) {
    targetImage.classList.add("boost-active");
    activeBoostCard = targetImage;
  }
}

function switchToBoostButtons(selectedCard) {
  const statsCards = document.querySelectorAll(".stats-card");

  statsCards.forEach((card) => {
    const select = card.querySelector(".car-select");
    const button = card.querySelector(".boost-btn");

    if (select) {
      select.classList.add("hidden");
    }

    if (button) {
      if (card === selectedCard) {
        button.classList.remove("hidden");
      } else {
        button.classList.add("hidden");
      }
    }
  });
}

carSelects.forEach((select) => {
  select.addEventListener("change", (event) => {
    const chosenValue = event.target.value;

    if (chosenValue !== "") {
      const selectedCard = event.target.closest(".stats-card");
      switchToBoostButtons(selectedCard);
    }
  });
});

boostButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (cooldownRemaining > 0) return;

    setBoostFlamesFromButton(button);
    startBoostCooldown();
  });
});

function updateTimerDisplay() {
  if (cooldownRemaining > 0) {
    boostTimer.textContent = `Next boost in: ${cooldownRemaining}s`;
  } else {
    boostTimer.textContent = "Next boost in: Ready";
  }
}

function startBoostCooldown() {
  cooldownRemaining = boostCooldown;
  updateTimerDisplay();

  boostButtons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Boosting...";
  });

  clearInterval(cooldownInterval);

  cooldownInterval = setInterval(() => {
    cooldownRemaining--;
    updateTimerDisplay();

    if (cooldownRemaining <= 0) {
    clearInterval(cooldownInterval);
    cooldownRemaining = 0;
    updateTimerDisplay();

    clearAllBoostFlames();
    activeBoostCard = null;

    boostButtons.forEach((button) => {
      button.disabled = false;
      button.textContent = "Boost";
    });
  }
  }, 1000);
}

updateTimerDisplay();

connectWalletBtn.addEventListener("click", () => {
  alert("Wallet connection will go here.");
});