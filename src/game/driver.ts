// Headless game driver: runs a full Solo Cutthroat Spades game between four
// agents and returns final scores + placement rewards. Deterministic given a
// seed (used both for dealing and, indirectly, for agent decisions).

import { fullDeck } from "../engine/cards.js";
import {
  applyBid,
  playCard,
  scoreHand,
  isGameOver,
  placementRewards,
} from "../engine/rules.js";
import {
  createInitialState,
  nextSeat,
  CARDS_PER_HAND,
  type GameState,
} from "../engine/state.js";
import { Rng } from "../engine/rng.js";
import { buildInfoSet, emptyKnowledge, observePlay, type PublicKnowledge } from "../ai/infoset.js";
import type { Agent } from "../ai/agents.js";

export interface HandRecord {
  handNumber: number;
  bids: number[];
  tricks: number[];
  scoreDelta: number[];
  scoresAfter: number[];
  bagsAfter: number[];
}

export interface GameResult {
  scores: number[];
  rewards: number[];
  hands: HandRecord[];
  numHands: number;
}

// Resolve the card-play phase without pauses or UI updates. Every agent still
// acts from its own information set, so this is equivalent to normal play
// rather than giving the automated human seat access to hidden hands.
export function playHandToCompletion(
  state: GameState,
  knowledge: PublicKnowledge,
  agents: Agent[],
): void {
  while (state.phase === "playing") {
    const seat = state.turn;
    const isLead = state.trick.length === 0;
    const ledBefore = state.ledSuit;
    const info = buildInfoSet(state, knowledge, seat);
    const card = agents[seat]!.chooseCard(info);
    playCard(state, card);
    observePlay(knowledge, seat, card, ledBefore, isLead);
  }
}

function dealHand(state: GameState, rng: Rng, firstLeader: number): PublicKnowledge {
  const deck = rng.shuffle(fullDeck());
  for (let seat = 0; seat < 4; seat++) {
    state.hands[seat] = deck
      .slice(seat * CARDS_PER_HAND, (seat + 1) * CARDS_PER_HAND)
      .sort((a, b) => a - b);
  }
  state.bids = [null, null, null, null];
  state.tricksWon = [0, 0, 0, 0];
  state.firstLeader = firstLeader;
  state.turn = firstLeader;
  state.trick = [];
  state.ledSuit = null;
  state.spadesBroken = false;
  state.phase = "bidding";
  state.completedTricks = 0;
  return emptyKnowledge();
}

export function playGame(agents: Agent[], seed: number, maxHands = 200): GameResult {
  const rng = new Rng(seed);
  let firstLeader = rng.int(4);
  const state = createInitialState(firstLeader);
  const hands: HandRecord[] = [];

  for (let h = 0; h < maxHands; h++) {
    state.handNumber = h;
    const knowledge = dealHand(state, rng, firstLeader);

    // Bidding.
    while (state.phase === "bidding") {
      const seat = state.turn;
      const info = buildInfoSet(state, knowledge, seat);
      applyBid(state, agents[seat]!.chooseBid(info));
    }

    // Play.
    playHandToCompletion(state, knowledge, agents);

    // Score the hand.
    const res = scoreHand(
      state.bids.map((b) => b ?? 0),
      state.tricksWon,
      state.bags,
    );
    for (let p = 0; p < 4; p++) state.scores[p]! += res.scoreDelta[p]!;
    state.bags = res.bagsAfter;

    hands.push({
      handNumber: h,
      bids: state.bids.map((b) => b ?? 0),
      tricks: state.tricksWon.slice(),
      scoreDelta: res.scoreDelta.slice(),
      scoresAfter: state.scores.slice(),
      bagsAfter: state.bags.slice(),
    });

    if (isGameOver(state.scores)) break;
    firstLeader = nextSeat(firstLeader);
  }

  return {
    scores: state.scores.slice(),
    rewards: placementRewards(state.scores),
    hands,
    numHands: hands.length,
  };
}
