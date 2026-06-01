// Agents: the strong search AI, a heuristic baseline, and a deterministic
// random baseline. All consume only an InfoSet (no hidden information).

import type { Card } from "../engine/cards.js";
import { legalMoves } from "../engine/rules.js";
import type { GameState } from "../engine/state.js";
import { Rng, hashString } from "../engine/rng.js";
import { canonicalKey, type InfoSet } from "./infoset.js";
import { chooseHeuristicCard, heuristicBid } from "./heuristic.js";
import { chooseBid, chooseCard, DEFAULT_OPTIONS, type SearchOptions } from "./search.js";

export interface Agent {
  name: string;
  chooseBid(info: InfoSet): number;
  chooseCard(info: InfoSet): Card;
}

// Build a minimal playable state from an info set (own hand only). Sufficient
// for legalMoves and the heuristic card policy, which inspect only the acting
// seat's hand plus public trick/contract fields.
export function playStateFromInfo(info: InfoSet): GameState {
  const hands: Card[][] = [[], [], [], []];
  hands[info.seat] = info.ownHand.slice();
  return {
    hands,
    scores: info.scores.slice(),
    bags: info.bags.slice(),
    bids: info.bids.slice(),
    tricksWon: info.tricksWon.slice(),
    firstLeader: info.firstLeader,
    turn: info.seat,
    trick: info.trick.map((t) => ({ ...t })),
    ledSuit: info.ledSuit,
    spadesBroken: info.spadesBroken,
    phase: "playing",
    handNumber: 0,
    completedTricks: info.completedTricks,
  };
}

export class SearchAgent implements Agent {
  name: string;
  private opts: SearchOptions;
  constructor(opts: Partial<SearchOptions> = {}, name = "AI") {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.name = name;
  }
  chooseBid(info: InfoSet): number {
    return chooseBid(info, this.opts);
  }
  chooseCard(info: InfoSet): Card {
    return chooseCard(info, this.opts);
  }
}

export class HeuristicAgent implements Agent {
  name = "Heuristic";
  chooseBid(info: InfoSet): number {
    return heuristicBid(info.ownHand);
  }
  chooseCard(info: InfoSet): Card {
    return chooseHeuristicCard(playStateFromInfo(info));
  }
}

export class RandomAgent implements Agent {
  name = "Random";
  chooseBid(info: InfoSet): number {
    const rng = new Rng(hashString(canonicalKey(info, "rbid")));
    // bid near a coin-flip of small numbers, occasionally nil
    const r = rng.next();
    if (r < 0.1) return 0;
    return 1 + rng.int(4);
  }
  chooseCard(info: InfoSet): Card {
    const rng = new Rng(hashString(canonicalKey(info, "rcard")));
    const moves = legalMoves(playStateFromInfo(info));
    return moves[rng.int(moves.length)]!;
  }
}
