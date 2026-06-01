// The information a single bot legitimately has, plus determinization sampling.
// No hidden hands are ever read here — opponents' cards are sampled from the
// unseen pool subject to known void and hand-size constraints.

import {
  suitOf,
  fullDeck,
  type Card,
  type Suit,
} from "../engine/cards.js";
import {
  NUM_PLAYERS,
  type GameState,
  type Phase,
  type TrickEntry,
} from "../engine/state.js";
import type { Rng } from "../engine/rng.js";

export interface PublicKnowledge {
  played: boolean[]; // length 52, true once a card has been played
  voids: boolean[][]; // [seat][suit] -> known void
}

export function emptyKnowledge(): PublicKnowledge {
  return {
    played: new Array(52).fill(false),
    voids: [
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
    ],
  };
}

// Record a play for inference. `isLead` true if this was the trick's lead.
export function observePlay(
  k: PublicKnowledge,
  seat: number,
  card: Card,
  ledSuit: Suit | null,
  isLead: boolean,
): void {
  k.played[card] = true;
  if (!isLead && ledSuit !== null && suitOf(card) !== ledSuit) {
    k.voids[seat]![ledSuit] = true; // failed to follow -> void in led suit
  }
}

export interface InfoSet {
  seat: number;
  ownHand: Card[];
  bids: (number | null)[];
  scores: number[];
  bags: number[];
  tricksWon: number[];
  firstLeader: number;
  turn: number;
  trick: TrickEntry[];
  ledSuit: Suit | null;
  spadesBroken: boolean;
  phase: Phase;
  completedTricks: number;
  handSizes: number[]; // public: how many cards each seat still holds
  played: boolean[];
  voids: boolean[][];
}

export function buildInfoSet(
  state: GameState,
  knowledge: PublicKnowledge,
  seat: number,
): InfoSet {
  return {
    seat,
    ownHand: state.hands[seat]!.slice(),
    bids: state.bids.slice(),
    scores: state.scores.slice(),
    bags: state.bags.slice(),
    tricksWon: state.tricksWon.slice(),
    firstLeader: state.firstLeader,
    turn: state.turn,
    trick: state.trick.map((t) => ({ ...t })),
    ledSuit: state.ledSuit,
    spadesBroken: state.spadesBroken,
    phase: state.phase,
    completedTricks: state.completedTricks,
    handSizes: state.hands.map((h) => h.length),
    played: knowledge.played.slice(),
    voids: knowledge.voids.map((v) => v.slice()),
  };
}

// Canonical string for deterministic RNG seeding. Same info set -> same string.
export function canonicalKey(info: InfoSet, decision: string): string {
  const voidStr = info.voids.map((v) => v.map((b) => (b ? 1 : 0)).join("")).join("|");
  const trickStr = info.trick.map((t) => `${t.seat}:${t.card}`).join(",");
  return [
    decision,
    `seat=${info.seat}`,
    `hand=${info.ownHand.slice().sort((a, b) => a - b).join(".")}`,
    `bids=${info.bids.map((b) => (b === null ? "x" : b)).join(".")}`,
    `scores=${info.scores.join(".")}`,
    `bags=${info.bags.join(".")}`,
    `tw=${info.tricksWon.join(".")}`,
    `fl=${info.firstLeader}`,
    `turn=${info.turn}`,
    `trick=${trickStr}`,
    `led=${info.ledSuit ?? "x"}`,
    `sb=${info.spadesBroken ? 1 : 0}`,
    `phase=${info.phase}`,
    `ct=${info.completedTricks}`,
    `hs=${info.handSizes.join(".")}`,
    `voids=${voidStr}`,
  ].join(";");
}

// Distribute `unseen` cards to the given opponent seats respecting hand-size
// counts and known voids. Returns a per-seat array (length 4); the searching
// seat's slot is left empty (filled by the caller with ownHand).
function dealConstrained(
  rng: Rng,
  unseen: Card[],
  seats: number[],
  counts: number[],
  voids: boolean[][],
  relax = false,
): Card[][] | null {
  const hands: Card[][] = [[], [], [], []];
  const need = counts.slice();

  // Most-constrained-first: order cards by how many seats can legally take them.
  const eligibleSeats = (card: Card): number[] => {
    const s = suitOf(card);
    return seats.filter((seat, i) => need[i]! > 0 && (relax || !voids[seat]![s]));
  };

  const order = unseen
    .map((card) => ({ card, n: seats.filter((seat) => relax || !voids[seat]![suitOf(card)]).length }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.card);

  for (const card of order) {
    const elig = eligibleSeats(card);
    if (elig.length === 0) return null; // dead end
    const seat = elig[rng.int(elig.length)]!;
    hands[seat]!.push(card);
    const ix = seats.indexOf(seat);
    need[ix]! -= 1;
  }
  // Verify counts satisfied.
  for (let i = 0; i < seats.length; i++) {
    if (hands[seats[i]!]!.length !== counts[i]!) return null;
  }
  return hands;
}

// Sample a full GameState consistent with the info set. Opponent hands are
// guessed; the searching seat's own hand is exact.
export function sampleDeterminization(info: InfoSet, rng: Rng): GameState {
  const unseen: Card[] = [];
  const ownSet = new Set(info.ownHand);
  for (const c of fullDeck()) {
    if (!info.played[c] && !ownSet.has(c)) unseen.push(c);
  }

  const oppSeats: number[] = [];
  const counts: number[] = [];
  for (let s = 0; s < NUM_PLAYERS; s++) {
    if (s === info.seat) continue;
    oppSeats.push(s);
    counts.push(info.handSizes[s]!);
  }

  let dealt = dealConstrained(rng, unseen, oppSeats, counts, info.voids, false);
  if (dealt === null) {
    // Retry a few times with fresh randomness, then relax voids as last resort.
    for (let attempt = 0; attempt < 200 && dealt === null; attempt++) {
      dealt = dealConstrained(rng, unseen, oppSeats, counts, info.voids, false);
    }
    if (dealt === null) {
      dealt = dealConstrained(rng, unseen, oppSeats, counts, info.voids, true);
    }
  }
  const hands = dealt ?? [[], [], [], []];
  hands[info.seat] = info.ownHand.slice();

  return {
    hands,
    scores: info.scores.slice(),
    bags: info.bags.slice(),
    bids: info.bids.slice(),
    tricksWon: info.tricksWon.slice(),
    firstLeader: info.firstLeader,
    turn: info.turn,
    trick: info.trick.map((t) => ({ ...t })),
    ledSuit: info.ledSuit,
    spadesBroken: info.spadesBroken,
    phase: info.phase,
    handNumber: 0,
    completedTricks: info.completedTricks,
  };
}
