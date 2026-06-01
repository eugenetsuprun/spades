import { beats, isSpade, suitOf, type Card, type Suit } from "./cards.js";
import { nextSeat, NUM_PLAYERS, type GameState } from "./state.js";

// ----- Bidding -----

export const NIL = 0;

export function legalBids(): number[] {
  // 0 = nil (no blind nil), 1..13 normal.
  const bids: number[] = [];
  for (let b = 0; b <= 13; b++) bids.push(b);
  return bids;
}

export function applyBid(state: GameState, bid: number): void {
  if (state.phase !== "bidding") throw new Error("not bidding");
  state.bids[state.turn] = bid;
  state.turn = nextSeat(state.turn);
  if (state.bids.every((b) => b !== null)) {
    state.phase = "playing";
    state.turn = state.firstLeader;
  }
}

// ----- Card play -----

// Legal moves for the player to act. Assumes phase === "playing".
export function legalMoves(state: GameState): Card[] {
  const hand = state.hands[state.turn]!;
  if (state.trick.length === 0) {
    // Leading.
    if (state.spadesBroken) return hand.slice();
    const nonSpades = hand.filter((c) => !isSpade(c));
    // Spades can be led only if broken or the hand is all spades.
    return nonSpades.length > 0 ? nonSpades : hand.slice();
  }
  // Following: must follow the led suit if able.
  const led = state.ledSuit!;
  const inSuit = hand.filter((c) => suitOf(c) === led);
  return inSuit.length > 0 ? inSuit : hand.slice();
}

// True iff `card` is a legal play for the seat to act.
export function isLegalMove(state: GameState, card: Card): boolean {
  return legalMoves(state).includes(card);
}

// Checked play used at real-game boundaries (UI, driver): rejects any illegal
// move with a descriptive error. The search uses raw `applyPlay` on moves it
// has already generated from `legalMoves`, so it pays no validation cost.
export function playCard(state: GameState, card: Card): void {
  if (state.phase !== "playing") throw new Error("not in the playing phase");
  if (!isLegalMove(state, card)) {
    throw new Error(`illegal move: card ${card} is not a legal play for seat ${state.turn}`);
  }
  applyPlay(state, card);
}

// Apply a card play, mutating state. Resolves the trick when complete.
// NOTE: trusts the caller to pass a legal move (no validation — hot path).
export function applyPlay(state: GameState, card: Card): void {
  if (state.phase !== "playing") throw new Error("not playing");
  const seat = state.turn;
  const hand = state.hands[seat]!;
  const ix = hand.indexOf(card);
  if (ix < 0) throw new Error("card not in hand");
  hand.splice(ix, 1);

  if (state.trick.length === 0) {
    state.ledSuit = suitOf(card);
  }
  if (isSpade(card)) state.spadesBroken = true;
  state.trick.push({ seat, card });

  if (state.trick.length === NUM_PLAYERS) {
    resolveTrick(state);
  } else {
    state.turn = nextSeat(seat);
  }
}

function resolveTrick(state: GameState): void {
  const led = state.ledSuit!;
  let best = state.trick[0]!;
  for (let i = 1; i < state.trick.length; i++) {
    const e = state.trick[i]!;
    if (beats(e.card, best.card, led)) best = e;
  }
  state.tricksWon[best.seat] = state.tricksWon[best.seat]! + 1;
  state.completedTricks += 1;
  state.trick = [];
  state.ledSuit = null;
  state.turn = best.seat;
  if (state.completedTricks === 13) {
    state.phase = "handDone";
  }
}

// Winner of a completed trick (helper for tests / UI). `entries` must be 4.
export function trickWinner(entries: { seat: number; card: Card }[], ledSuit: Suit): number {
  let best = entries[0]!;
  for (let i = 1; i < entries.length; i++) {
    if (beats(entries[i]!.card, best.card, ledSuit)) best = entries[i]!;
  }
  return best.seat;
}

// ----- Scoring -----

export interface HandScore {
  scoreDelta: number[]; // points added to each player's running total this hand
  bagsAfter: number[]; // each player's bag count after applying penalties
  bagPenalty: number[]; // -30 * (#triples) for each player (already in scoreDelta)
}

// Score a completed hand. `bids` (0 = nil), `tricks` taken, `bagsBefore` carried in.
export function scoreHand(
  bids: number[],
  tricks: number[],
  bagsBefore: number[],
): HandScore {
  const scoreDelta = [0, 0, 0, 0];
  const bagsAfter = bagsBefore.slice();
  const bagPenalty = [0, 0, 0, 0];

  for (let p = 0; p < NUM_PLAYERS; p++) {
    const bid = bids[p]!;
    const won = tricks[p]!;
    if (bid === NIL) {
      // Nil: +50 made / -50 failed. Tricks on a failed nil are NOT bags.
      scoreDelta[p] = scoreDelta[p]! + (won === 0 ? 50 : -50);
    } else if (won >= bid) {
      const overtricks = won - bid;
      scoreDelta[p] = scoreDelta[p]! + (10 * bid + overtricks);
      bagsAfter[p] = bagsAfter[p]! + overtricks;
    } else {
      scoreDelta[p] = scoreDelta[p]! + -10 * bid;
    }
  }

  // Apply bag penalties: every 3 accumulated -> -30, remove 3.
  for (let p = 0; p < NUM_PLAYERS; p++) {
    const triples = Math.floor(bagsAfter[p]! / 3);
    if (triples > 0) {
      bagPenalty[p] = -30 * triples;
      scoreDelta[p] = scoreDelta[p]! + bagPenalty[p]!;
      bagsAfter[p] = bagsAfter[p]! % 3;
    }
  }

  return { scoreDelta, bagsAfter, bagPenalty };
}

// Marginal value of taking `overtricks` more, given current bag count.
// Each bag is +1, except the one that completes a triple costs a net -29.
export function bagDelta(currentBags: number, overtricks: number): number {
  let delta = 0;
  let bags = currentBags;
  for (let i = 0; i < overtricks; i++) {
    delta += 1;
    bags += 1;
    if (bags % 3 === 0) {
      delta -= 30;
    }
  }
  return delta;
}

// ----- Game end + placement reward (the AI's value function V) -----

export function isGameOver(scores: number[]): boolean {
  return scores.some((s) => s >= 40);
}

// Placement reward for `seat`:
//   2 = strict highest (sole 1st)
//   1 = tied for highest, OR unique second-highest (sole 2nd)
//   0 = otherwise
export function placementReward(scores: number[], seat: number): number {
  const me = scores[seat]!;
  const max = Math.max(...scores);
  const countMax = scores.filter((s) => s === max).length;
  if (me === max) return countMax === 1 ? 2 : 1;
  // Not in first. Find the second-highest distinct value.
  let second = -Infinity;
  for (const s of scores) if (s < max && s > second) second = s;
  if (me === second && scores.filter((s) => s === second).length === 1) return 1;
  return 0;
}

// Project the value function for all seats at once (used by the driver).
export function placementRewards(scores: number[]): number[] {
  return scores.map((_, seat) => placementReward(scores, seat));
}
