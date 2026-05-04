/*
  ============================================================
  FAKE CAR BACKEND
  ============================================================

  Temporary mock backend for testing race results and bet settlement.

  Supports forced test outcomes via .env:

  FAKE_RACE_FORCE_STATUS=completed
  FAKE_RACE_FORCE_STATUS=invalid
  FAKE_RACE_FORCE_STATUS=cancelled

  Leave it blank for normal random completed results.
*/

const ALLOWED_CARS = ["Car 1", "Car 2", "Car 3"];

function shuffleArray(items) {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const randomIndex = Math.floor(Math.random() * (i + 1));

    const temp = shuffled[i];
    shuffled[i] = shuffled[randomIndex];
    shuffled[randomIndex] = temp;
  }

  return shuffled;
}

export function fetchFakeRaceResult(raceId) {
  const forcedStatus = process.env.FAKE_RACE_FORCE_STATUS || "";

  /*
    Force a refund scenario.

    invalid/cancelled means:
    - no winner
    - no finishing order
    - all confirmed bets should become refunded
    - no payout is required
  */
  if (forcedStatus === "invalid" || forcedStatus === "cancelled") {
    const result = {
      raceId,
      status: forcedStatus,
      source: "fake-car-backend",

      winningCarId: null,

      firstCarId: null,
      secondCarId: null,
      thirdCarId: null,

      finishingOrder: []
    };

    console.log("Fake car backend forced refund result:", result);

    return result;
  }

  /*
    Normal completed mock race.
  */
  const finishingOrder = shuffleArray(ALLOWED_CARS);

  const result = {
    raceId,
    status: "completed",
    source: "fake-car-backend",

    winningCarId: finishingOrder[0],

    firstCarId: finishingOrder[0],
    secondCarId: finishingOrder[1],
    thirdCarId: finishingOrder[2],

    finishingOrder
  };

  console.log("Fake car backend result:", result);

  return result;
}