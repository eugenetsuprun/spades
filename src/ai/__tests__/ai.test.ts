import { describe, it, expect } from "vitest";
import { fullDeck, suitOf, type Card } from "../../engine/cards.js";
import { applyBid, applyPlay } from "../../engine/rules.js";
import { createInitialState, CARDS_PER_HAND } from "../../engine/state.js";
import { Rng } from "../../engine/rng.js";
import {
  buildInfoSet,
  emptyKnowledge,
  observePlay,
  sampleDeterminization,
} from "../infoset.js";
import { SearchAgent } from "../agents.js";
import { playGame } from "../../game/driver.js";
import { HeuristicAgent } from "../agents.js";

// Build a mid-hand state: deal, bid heuristically, play a few cards.
function midHandState(seed: number) {
  const rng = new Rng(seed);
  const state = createInitialState(0);
  const deck = rng.shuffle(fullDeck());
  for (let s = 0; s < 4; s++) {
    state.hands[s] = deck.slice(s * CARDS_PER_HAND, (s + 1) * CARDS_PER_HAND).sort((a, b) => a - b);
  }
  const knowledge = emptyKnowledge();
  const h = new HeuristicAgent();
  while (state.phase === "bidding") {
    applyBid(state, h.chooseBid(buildInfoSet(state, knowledge, state.turn)));
  }
  // Play 5 cards.
  for (let i = 0; i < 5 && state.phase === "playing"; i++) {
    const seat = state.turn;
    const isLead = state.trick.length === 0;
    const led = state.ledSuit;
    const card = h.chooseCard(buildInfoSet(state, knowledge, seat));
    applyPlay(state, card);
    observePlay(knowledge, seat, card, led, isLead);
  }
  return { state, knowledge };
}

describe("determinism", () => {
  it("chooseCard gives the same move for the same info set", () => {
    const { state, knowledge } = midHandState(42);
    const seat = state.turn;
    const ai = new SearchAgent({ determinizations: 40 });
    const a = ai.chooseCard(buildInfoSet(state, knowledge, seat));
    const b = ai.chooseCard(buildInfoSet(state, knowledge, seat));
    expect(a).toBe(b);
  });

  it("chooseBid gives the same bid for the same info set", () => {
    const rng = new Rng(7);
    const state = createInitialState(0);
    const deck = rng.shuffle(fullDeck());
    for (let s = 0; s < 4; s++) {
      state.hands[s] = deck.slice(s * CARDS_PER_HAND, (s + 1) * CARDS_PER_HAND).sort((a, b) => a - b);
    }
    const knowledge = emptyKnowledge();
    const ai = new SearchAgent({ determinizations: 40 });
    const info = buildInfoSet(state, knowledge, 0);
    expect(ai.chooseBid(info)).toBe(ai.chooseBid(info));
  });

  it("a whole game replays identically from the same seed", () => {
    const agents = [new SearchAgent({ determinizations: 30 }), new HeuristicAgent(), new HeuristicAgent(), new HeuristicAgent()];
    const r1 = playGame(agents, 12345);
    const r2 = playGame(agents, 12345);
    expect(r1.scores).toEqual(r2.scores);
    expect(r1.rewards).toEqual(r2.rewards);
  });
});

describe("determinization sampler", () => {
  it("respects own hand, played cards, hand sizes, and voids", () => {
    const { state, knowledge } = midHandState(99);
    const seat = state.turn;
    // Force a known void to exercise the constraint.
    knowledge.voids[(seat + 1) % 4]![0] = true; // that opponent void in clubs
    const info = buildInfoSet(state, knowledge, seat);
    const rng = new Rng(5);

    for (let t = 0; t < 50; t++) {
      const d = sampleDeterminization(info, rng);
      // Own hand preserved exactly.
      expect(d.hands[seat]!.slice().sort((a, b) => a - b)).toEqual(
        info.ownHand.slice().sort((a, b) => a - b),
      );
      // Hand sizes match the public counts.
      for (let s = 0; s < 4; s++) expect(d.hands[s]!.length).toBe(info.handSizes[s]);
      // No played card appears in any hand; every card appears at most once.
      const seen = new Set<Card>();
      for (let s = 0; s < 4; s++) {
        for (const c of d.hands[s]!) {
          expect(info.played[c]).toBe(false);
          expect(seen.has(c)).toBe(false);
          seen.add(c);
        }
      }
      // The void constraint is honored (unless relax fallback was needed, which
      // shouldn't happen for a single consistent void).
      for (const c of d.hands[(seat + 1) % 4]!) {
        expect(suitOf(c)).not.toBe(0);
      }
    }
  });
});

describe("full game integrity", () => {
  it("terminates, crosses the threshold, and yields valid rewards", () => {
    const agents = [
      new SearchAgent({ determinizations: 30 }),
      new HeuristicAgent(),
      new HeuristicAgent(),
      new HeuristicAgent(),
    ];
    const r = playGame(agents, 2024);
    expect(r.numHands).toBeGreaterThanOrEqual(1);
    expect(Math.max(...r.scores)).toBeGreaterThanOrEqual(40);
    for (const reward of r.rewards) expect([0, 1, 2]).toContain(reward);
    // Exactly one bucket has the max; at least one player is top.
    expect(r.rewards.some((x) => x >= 1)).toBe(true);
  });
});
