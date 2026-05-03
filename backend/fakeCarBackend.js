/*
  ============================================================
  FAKE CAR BACKEND
  ============================================================

  Temporary mock backend for testing race results and bet settlement.

  This simulates the future external car/race backend.

  Later, this file can be replaced by:
  - an HTTP request to the real car backend
  - a webhook listener
  - a message queue
  - a database/event stream

  For now:
  - it randomly shuffles Car 1, Car 2, Car 3
  - returns full finishing order
  - returns the winner as the first car
*/

const ALLOWED_CARS = ["Car 1", "Car 2", "Car 3"];

/*
  Randomly shuffles an array without mutating the original.
*/
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

/*
  Simulates pulling a race result from another backend.

  raceId is included so the function feels like a real backend call.
*/
export async function fetchFakeRaceResult(raceId) {
  /*
    Small artificial delay so it behaves more like an external request.
  */
  await new Promise((resolve) => setTimeout(resolve, 250));

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