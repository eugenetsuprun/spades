import type { Card, Suit } from "./cards.js";

export const NUM_PLAYERS = 4;
export const CARDS_PER_HAND = 13;
export const WIN_THRESHOLD = 40;

export type Phase = "bidding" | "playing" | "handDone";

export interface TrickEntry {
  seat: number;
  card: Card;
}

// Full game state. The driver holds the authoritative copy with every hand
// visible; the search operates on determinized clones of this same shape.
export interface GameState {
  hands: Card[][]; // hands[seat] = cards still held this hand
  scores: number[]; // cumulative running totals (may go negative)
  bags: number[]; // cumulative bag counts (0..2 after each hand's penalty)
  bids: (number | null)[]; // this hand; 0 = nil; null until placed
  tricksWon: number[]; // tricks won this hand
  firstLeader: number; // seat that led the first trick of this hand
  turn: number; // seat to act
  trick: TrickEntry[]; // cards played in the current (incomplete) trick
  ledSuit: Suit | null;
  spadesBroken: boolean;
  phase: Phase;
  handNumber: number; // 0-based
  completedTricks: number; // tricks finished this hand
}

export function createInitialState(firstLeader: number): GameState {
  return {
    hands: [[], [], [], []],
    scores: [0, 0, 0, 0],
    bags: [0, 0, 0, 0],
    bids: [null, null, null, null],
    tricksWon: [0, 0, 0, 0],
    firstLeader,
    turn: firstLeader,
    trick: [],
    ledSuit: null,
    spadesBroken: false,
    phase: "bidding",
    handNumber: 0,
    completedTricks: 0,
  };
}

export function cloneState(s: GameState): GameState {
  return {
    hands: [s.hands[0]!.slice(), s.hands[1]!.slice(), s.hands[2]!.slice(), s.hands[3]!.slice()],
    scores: s.scores.slice(),
    bags: s.bags.slice(),
    bids: s.bids.slice(),
    tricksWon: s.tricksWon.slice(),
    firstLeader: s.firstLeader,
    turn: s.turn,
    trick: s.trick.map((t) => ({ ...t })),
    ledSuit: s.ledSuit,
    spadesBroken: s.spadesBroken,
    phase: s.phase,
    handNumber: s.handNumber,
    completedTricks: s.completedTricks,
  };
}

export function nextSeat(seat: number): number {
  return (seat + 1) % NUM_PLAYERS;
}
