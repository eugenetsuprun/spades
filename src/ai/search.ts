// Search: deterministic flat Monte-Carlo over determinizations, with an exact
// maxn solver once the hand is small. The value backed up is the placement
// reward (V) of the projected post-hand scores, plus a tiny score-margin
// gradient so ties resolve smoothly. Same info set -> same seed -> same move.

import type { Card } from "../engine/cards.js";
import {
  legalMoves,
  applyPlay,
  scoreHand,
  placementReward,
  NIL,
} from "../engine/rules.js";
import { cloneState, type GameState } from "../engine/state.js";
import { Rng, hashString } from "../engine/rng.js";
import {
  sampleDeterminization,
  canonicalKey,
  type InfoSet,
} from "./infoset.js";
import { chooseHeuristicCard, estimateTricks, heuristicBid } from "./heuristic.js";

export interface SearchOptions {
  determinizations: number; // worlds sampled per decision
  exactCards: number; // run exact maxn when total cards left <= this
  gradientWeight: number; // weight of the score-margin tie-breaker
}

export const DEFAULT_OPTIONS: SearchOptions = {
  // Tuned via self-play: strong and ~20 ms/decision here, leaving wide margin
  // under the 2s budget even on much slower hardware.
  determinizations: 400,
  exactCards: 12,
  gradientWeight: 0.04,
};

// Determinization cap once the exact endgame solver is active.
const ENDGAME_DETERMINIZATIONS = 80;

// Placement value with a small score-margin gradient for smooth tie-breaking.
function placementValue(scores: number[], seat: number, gradientWeight: number): number {
  const pr = placementReward(scores, seat);
  let bestOther = -Infinity;
  for (let s = 0; s < scores.length; s++) {
    if (s !== seat && scores[s]! > bestOther) bestOther = scores[s]!;
  }
  const margin = scores[seat]! - bestOther;
  const grad = Math.max(-1, Math.min(1, margin / 50)) * gradientWeight;
  return pr + grad;
}

// Project scores after the (assumed complete) hand in `state`.
function postHandScores(state: GameState): number[] {
  const res = scoreHand(
    state.bids.map((b) => b ?? 0),
    state.tricksWon,
    state.bags,
  );
  return state.scores.map((s, i) => s + res.scoreDelta[i]!);
}

// Play a hand to completion with the heuristic policy, return placement value
// vector for all seats.
function rolloutValues(state: GameState, gradientWeight: number): number[] {
  const s = state; // mutate in place (caller owns the clone)
  while (s.phase === "playing") {
    const card = chooseHeuristicCard(s);
    applyPlay(s, card);
  }
  const finalScores = postHandScores(s);
  return finalScores.map((_, seat) => placementValue(finalScores, seat, gradientWeight));
}

// Exact maxn: each player maximizes its own placement value. Returns the value
// vector under optimal play from `state`.
function maxn(state: GameState, gradientWeight: number): number[] {
  if (state.phase !== "playing") {
    const finalScores = postHandScores(state);
    return finalScores.map((_, seat) => placementValue(finalScores, seat, gradientWeight));
  }
  const seat = state.turn;
  const moves = legalMoves(state);
  let best: number[] | null = null;
  for (const m of moves) {
    const child = cloneState(state);
    applyPlay(child, m);
    const vec = maxn(child, gradientWeight);
    if (best === null || vec[seat]! > best[seat]!) best = vec;
  }
  return best!;
}

function totalCardsLeft(info: InfoSet): number {
  return info.handSizes.reduce((a, b) => a + b, 0);
}

// Evaluate the value (for the searching seat) of `state` after a candidate move
// has been applied: exact when small, else heuristic rollout.
function evaluateState(
  state: GameState,
  seat: number,
  opts: SearchOptions,
): number {
  const cardsLeft = state.hands.reduce((a, h) => a + h.length, 0);
  if (cardsLeft <= opts.exactCards) {
    return maxn(state, opts.gradientWeight)[seat]!;
  }
  return rolloutValues(state, opts.gradientWeight)[seat]!;
}

// Build a minimal state to query legal moves for the acting seat (own hand
// only — opponents' cards don't affect the searching seat's legality).
function legalForInfo(info: InfoSet): Card[] {
  const temp: GameState = {
    hands: [[], [], [], []],
    scores: info.scores,
    bags: info.bags,
    bids: info.bids,
    tricksWon: info.tricksWon,
    firstLeader: info.firstLeader,
    turn: info.seat,
    trick: info.trick,
    ledSuit: info.ledSuit,
    spadesBroken: info.spadesBroken,
    phase: "playing",
    handNumber: 0,
    completedTricks: info.completedTricks,
  };
  temp.hands[info.seat] = info.ownHand;
  return legalMoves(temp).slice().sort((a, b) => a - b);
}

export function chooseCard(info: InfoSet, opts: SearchOptions = DEFAULT_OPTIONS): Card {
  const legal = legalForInfo(info);
  if (legal.length === 1) return legal[0]!;

  const rng = new Rng(hashString(canonicalKey(info, "card")));
  const q = new Array<number>(legal.length).fill(0);

  // The exact endgame solver plays optimally per world, so it needs far fewer
  // sampled worlds than the rollout regime — cap determinizations there to keep
  // the per-decision cost comfortably inside the time budget.
  const cardsLeft = totalCardsLeft(info);
  const det =
    cardsLeft <= opts.exactCards
      ? Math.min(opts.determinizations, ENDGAME_DETERMINIZATIONS)
      : opts.determinizations;

  for (let d = 0; d < det; d++) {
    const base = sampleDeterminization(info, rng);
    for (let i = 0; i < legal.length; i++) {
      const s = cloneState(base);
      applyPlay(s, legal[i]!);
      q[i]! += evaluateState(s, info.seat, opts);
    }
  }

  let bestIx = 0;
  for (let i = 1; i < legal.length; i++) if (q[i]! > q[bestIx]!) bestIx = i;
  return legal[bestIx]!;
}

function candidateBids(info: InfoSet): number[] {
  const mu = estimateTricks(info.ownHand);
  const base = Math.max(1, Math.min(13, Math.round(mu)));
  const set = new Set<number>();
  for (const b of [base - 1, base, base + 1]) {
    if (b >= 1 && b <= 13) set.add(b);
  }
  const normals = [...set].sort((a, b) => a - b);
  return [...normals, NIL]; // nil last so ties favor a normal bid
}

export function chooseBid(info: InfoSet, opts: SearchOptions = DEFAULT_OPTIONS): number {
  const candidates = candidateBids(info);
  const rng = new Rng(hashString(canonicalKey(info, "bid")));
  const totals = new Array<number>(candidates.length).fill(0);

  // Common random numbers: every candidate bid is evaluated on the SAME sampled
  // worlds, so differences in value reflect the bid, not sampling noise.
  for (let d = 0; d < opts.determinizations; d++) {
    const base = sampleDeterminization(info, rng);
    // Opponents' bids depend only on their (now fixed) hands: known bids stay,
    // unknown ones use the heuristic bidder. Identical across candidates.
    const oppBids = base.bids.slice();
    for (let seat = 0; seat < 4; seat++) {
      if (seat !== info.seat && oppBids[seat] === null) {
        oppBids[seat] = heuristicBid(base.hands[seat]!);
      }
    }

    for (let c = 0; c < candidates.length; c++) {
      const s = cloneState(base);
      s.bids = oppBids.slice();
      s.bids[info.seat] = candidates[c]!;
      // No cards played yet during bidding: set up the play phase.
      s.phase = "playing";
      s.turn = s.firstLeader;
      s.trick = [];
      s.ledSuit = null;
      s.spadesBroken = false;
      s.tricksWon = [0, 0, 0, 0];
      s.completedTricks = 0;
      totals[c]! += rolloutValues(s, opts.gradientWeight)[info.seat]!;
    }
  }

  let bestIx = 0;
  for (let c = 1; c < candidates.length; c++) if (totals[c]! > totals[bestIx]!) bestIx = c;
  return candidates[bestIx]!;
}
