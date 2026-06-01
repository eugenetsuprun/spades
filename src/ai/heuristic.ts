// Fast heuristic policy: bid estimation + a strong-ish greedy card chooser.
// Used as the rollout/opponent policy inside the search, and as a standalone
// baseline agent. Operates on a full (determinized) GameState — within the
// search this is the bot's own simulation, not hidden information.

import {
  rankIxOf,
  suitOf,
  isSpade,
  beats,
  type Card,
  type Suit,
  SPADES,
} from "../engine/cards.js";
import { legalMoves } from "../engine/rules.js";
import type { GameState } from "../engine/state.js";

const RANK_A = 12;
const RANK_K = 11;
const RANK_Q = 10;
const RANK_J = 9;

// Expected number of tricks a hand is worth (rough prior, used for bidding).
export function estimateTricks(hand: Card[]): number {
  const spades = hand.filter(isSpade).map(rankIxOf);
  const numSpades = spades.length;
  let t = 0;

  for (const r of spades) {
    if (r === RANK_A) t += 1.0;
    else if (r === RANK_K) t += numSpades >= 2 ? 0.85 : 0.5;
    else if (r === RANK_Q) t += numSpades >= 3 ? 0.6 : 0.3;
    else if (r === RANK_J) t += numSpades >= 4 ? 0.35 : 0.15;
  }
  if (numSpades > 3) t += (numSpades - 3) * 0.5; // length / ruffing premium

  for (let suit = 0; suit < 3; suit++) {
    const ranks = hand.filter((c) => suitOf(c) === suit).map(rankIxOf);
    const len = ranks.length;
    for (const r of ranks) {
      if (r === RANK_A) t += 0.9;
      else if (r === RANK_K) t += len >= 2 ? 0.55 : 0.35;
      else if (r === RANK_Q) t += len >= 3 ? 0.3 : 0.15;
    }
  }
  return Math.max(0, Math.min(13, t));
}

// Quick nil-safety heuristic: higher = safer to bid nil.
export function nilSafety(hand: Card[]): number {
  let danger = 0;
  for (const c of hand) {
    const r = rankIxOf(c);
    const s = suitOf(c);
    if (r === RANK_A) danger += 3;
    else if (r === RANK_K) danger += 2;
    else if (r === RANK_Q) danger += 1;
    if (s === SPADES && r >= RANK_J) danger += 2; // high spades are dangerous
    if (s === SPADES && r >= RANK_Q) danger += 1;
  }
  // Long low suits help (more ducking options).
  return -danger;
}

// Heuristic bid for an opponent in rollouts (0 = nil).
export function heuristicBid(hand: Card[]): number {
  const mu = estimateTricks(hand);
  const safety = nilSafety(hand);
  if (mu < 1.1 && safety >= -1) return 0; // weak + safe -> nil
  return Math.max(1, Math.round(mu));
}

type Mode = "win" | "avoid";

// What is this seat trying to do right now?
function modeFor(state: GameState, seat: number): Mode {
  const bid = state.bids[seat]!;
  if (bid === 0) return "avoid"; // nil
  return state.tricksWon[seat]! < bid ? "win" : "avoid";
}

// Current best card in the trick (the one winning so far), or null if empty.
function currentBest(state: GameState): { card: Card; led: Suit } | null {
  if (state.trick.length === 0) return null;
  const led = state.ledSuit!;
  let best = state.trick[0]!.card;
  for (let i = 1; i < state.trick.length; i++) {
    const c = state.trick[i]!.card;
    if (beats(c, best, led)) best = c;
  }
  return { card: best, led };
}

function lowest(cards: Card[]): Card {
  // Lowest by rank, preferring non-spades to keep trump.
  return cards.slice().sort((a, b) => {
    const sa = isSpade(a) ? 1 : 0;
    const sb = isSpade(b) ? 1 : 0;
    if (sa !== sb) return sa - sb; // non-spade first
    return rankIxOf(a) - rankIxOf(b);
  })[0]!;
}

function highest(cards: Card[]): Card {
  return cards.slice().sort((a, b) => rankIxOf(b) - rankIxOf(a))[0]!;
}

// Greedy card choice for state.turn given a perfect-info (determinized) state.
export function chooseHeuristicCard(state: GameState): Card {
  const moves = legalMoves(state);
  if (moves.length === 1) return moves[0]!;
  const seat = state.turn;
  const mode = modeFor(state, seat);
  const best = currentBest(state);
  const isLastToAct = state.trick.length === 3;

  if (best === null) {
    // Leading.
    if (mode === "win") {
      // Lead a high card likely to hold up: prefer a side-suit Ace, else highest non-spade, else highest.
      const nonSpades = moves.filter((c) => !isSpade(c));
      const pool = nonSpades.length > 0 ? nonSpades : moves;
      return highest(pool);
    }
    // avoid / nil: bleed the lowest card.
    return lowest(moves);
  }

  const led = best.led;
  // Does a given move win the trick if played now? (Only certain when last to act.)
  const winsNow = (c: Card) => beats(c, best.card, led);

  if (mode === "win") {
    // Prefer the cheapest card that currently beats the best.
    const winners = moves.filter(winsNow);
    if (winners.length > 0) {
      // cheapest winner: lowest rank, prefer non-trump win over trumping
      return winners.slice().sort((a, b) => {
        const ta = isSpade(a) ? 1 : 0;
        const tb = isSpade(b) ? 1 : 0;
        if (ta !== tb) return ta - tb;
        return rankIxOf(a) - rankIxOf(b);
      })[0]!;
    }
    // Can't win: dump the lowest (keep high cards / trump).
    return lowest(moves);
  }

  // mode === "avoid" (nil or already satisfied): duck.
  const losers = moves.filter((c) => !winsNow(c));
  if (losers.length > 0) {
    if (isLastToAct) {
      // Safe to throw the highest non-winning card (sheds danger, esp. for nil).
      return highest(losers);
    }
    // Not last: someone may still overtake; play the highest card that's still
    // under the current best to shed danger while likely not winning.
    const under = losers
      .filter((c) => suitOf(c) === led || !isSpade(c)) // following or discarding
      .sort((a, b) => rankIxOf(b) - rankIxOf(a));
    return (under[0] ?? highest(losers))!;
  }
  // Forced to win: take it with the lowest possible card.
  return lowest(moves);
}
