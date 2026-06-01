import { describe, it, expect } from "vitest";
import { beats, makeCard, suitOf, rankIxOf, cardLabel, SPADES } from "../cards.js";
import {
  scoreHand,
  bagDelta,
  placementReward,
  legalMoves,
  applyPlay,
  playCard,
  applyBid,
  NIL,
} from "../rules.js";
import { createInitialState } from "../state.js";

describe("cards", () => {
  it("decodes suit/rank", () => {
    const c = makeCard(3, 12); // Ace of spades
    expect(suitOf(c)).toBe(3);
    expect(rankIxOf(c)).toBe(12);
    expect(cardLabel(c)).toBe("A♠");
  });

  it("beats: trump beats led suit", () => {
    const twoSpades = makeCard(SPADES, 0);
    const aceHearts = makeCard(2, 12);
    // hearts led, spade trumps
    expect(beats(twoSpades, aceHearts, 2)).toBe(true);
    expect(beats(aceHearts, twoSpades, 2)).toBe(false);
  });

  it("beats: off-suit non-trump never wins", () => {
    const aceClubs = makeCard(0, 12);
    const twoHearts = makeCard(2, 0);
    // hearts led; clubs is off-suit non-trump
    expect(beats(aceClubs, twoHearts, 2)).toBe(false);
  });

  it("beats: higher of led suit wins", () => {
    const kHearts = makeCard(2, 11);
    const qHearts = makeCard(2, 10);
    expect(beats(kHearts, qHearts, 2)).toBe(true);
  });
});

describe("scoreHand", () => {
  it("normal made bid with overtricks adds bags", () => {
    const r = scoreHand([4, 3, 2, 1], [5, 3, 2, 3], [0, 0, 0, 0]);
    // p0 bid 4 took 5: 40 + 1 overtrick = 41, +1 bag
    expect(r.scoreDelta[0]).toBe(41);
    expect(r.bagsAfter[0]).toBe(1);
    // p1 bid 3 took 3: 30, 0 bags
    expect(r.scoreDelta[1]).toBe(30);
    expect(r.bagsAfter[1]).toBe(0);
    // p3 bid 1 took 3: 10 + 2 overtricks = 12, +2 bags
    expect(r.scoreDelta[3]).toBe(12);
    expect(r.bagsAfter[3]).toBe(2);
  });

  it("set bid scores negative, no bags", () => {
    const r = scoreHand([4, 0, 0, 0], [2, 0, 0, 0], [0, 0, 0, 0]);
    expect(r.scoreDelta[0]).toBe(-40);
    expect(r.bagsAfter[0]).toBe(0);
  });

  it("nil made = +50, failed = -50 with no bags from tricks", () => {
    const made = scoreHand([NIL, 1, 1, 1], [0, 1, 1, 1], [0, 0, 0, 0]);
    expect(made.scoreDelta[0]).toBe(50);
    expect(made.bagsAfter[0]).toBe(0);

    const failed = scoreHand([NIL, 1, 1, 1], [3, 1, 1, 1], [0, 0, 0, 0]);
    expect(failed.scoreDelta[0]).toBe(-50);
    expect(failed.bagsAfter[0]).toBe(0); // failed-nil tricks are NOT bags
  });

  it("bag triple triggers -30 at end of hand", () => {
    // p0 at 2 bags, bids 1 takes 3 -> +2 bags -> 4 total -> one triple -> -30, 1 left
    const r = scoreHand([1, 1, 1, 1], [3, 1, 1, 1], [2, 0, 0, 0]);
    // base: 10 + 2 overtricks = 12, then -30 penalty = -18
    expect(r.scoreDelta[0]).toBe(12 - 30);
    expect(r.bagsAfter[0]).toBe(1);
    expect(r.bagPenalty[0]).toBe(-30);
  });

  it("multiple triples in one hand", () => {
    // 2 bags + 4 overtricks = 6 -> two triples -> -60, 0 left
    const r = scoreHand([1, 1, 1, 1], [5, 1, 1, 1], [2, 0, 0, 0]);
    expect(r.bagsAfter[0]).toBe(0);
    expect(r.bagPenalty[0]).toBe(-60);
  });
});

describe("bagDelta", () => {
  it("plain bag is +1", () => {
    expect(bagDelta(0, 1)).toBe(1);
  });
  it("the triple-completing bag costs net -29", () => {
    expect(bagDelta(2, 1)).toBe(1 - 30);
  });
  it("two overtricks from 1 bag: +1 then +1-30", () => {
    expect(bagDelta(1, 2)).toBe(1 + (1 - 30));
  });
});

describe("placementReward", () => {
  it("sole 1st = 2", () => {
    expect(placementReward([50, 30, 20, 10], 0)).toBe(2);
  });
  it("tie for 1st = 1 each", () => {
    expect(placementReward([50, 50, 20, 10], 0)).toBe(1);
    expect(placementReward([50, 50, 20, 10], 1)).toBe(1);
  });
  it("unique 2nd = 1, others 0", () => {
    expect(placementReward([50, 30, 20, 10], 1)).toBe(1);
    expect(placementReward([50, 30, 20, 10], 2)).toBe(0);
  });
  it("tie for 2nd = no 2nd (0)", () => {
    expect(placementReward([50, 30, 30, 10], 1)).toBe(0);
    expect(placementReward([50, 30, 30, 10], 2)).toBe(0);
  });
  it("negatives handled", () => {
    expect(placementReward([40, -10, -20, -30], 0)).toBe(2);
    expect(placementReward([40, -10, -20, -30], 1)).toBe(1);
  });
});

describe("legalMoves", () => {
  it("cannot lead spades until broken unless only spades", () => {
    const s = createInitialState(0);
    s.phase = "playing";
    s.turn = 0;
    s.hands[0] = [makeCard(0, 0), makeCard(3, 5), makeCard(3, 6)]; // 2c, 7s, 8s
    s.spadesBroken = false;
    const moves = legalMoves(s);
    expect(moves).toContain(makeCard(0, 0));
    expect(moves).not.toContain(makeCard(3, 5));

    // all spades -> may lead spades
    s.hands[0] = [makeCard(3, 5), makeCard(3, 6)];
    expect(legalMoves(s).length).toBe(2);
  });

  it("must follow suit if able", () => {
    const s = createInitialState(0);
    s.phase = "playing";
    s.turn = 1;
    s.ledSuit = 2; // hearts led
    s.trick = [{ seat: 0, card: makeCard(2, 5) }];
    s.hands[1] = [makeCard(2, 1), makeCard(0, 0), makeCard(3, 0)];
    const moves = legalMoves(s);
    expect(moves).toEqual([makeCard(2, 1)]); // only the heart
  });
});

describe("playCard rejects illegal moves", () => {
  it("throws when leading spades before they are broken", () => {
    const s = createInitialState(0);
    for (let i = 0; i < 4; i++) applyBid(s, 3);
    s.turn = 0;
    s.hands[0] = [makeCard(0, 0), makeCard(3, 5)]; // 2c, 7s
    s.spadesBroken = false;
    expect(() => playCard(s, makeCard(3, 5))).toThrow(/illegal/);
    expect(() => playCard(s, makeCard(0, 0))).not.toThrow();
  });

  it("throws when not following suit while able", () => {
    const s = createInitialState(0);
    for (let i = 0; i < 4; i++) applyBid(s, 3);
    s.turn = 1;
    s.ledSuit = 2; // hearts led
    s.trick = [{ seat: 0, card: makeCard(2, 5) }];
    s.hands[1] = [makeCard(2, 1), makeCard(0, 0)]; // has a heart -> must play it
    expect(() => playCard(s, makeCard(0, 0))).toThrow(/illegal/);
    expect(() => playCard(s, makeCard(2, 1))).not.toThrow();
  });

  it("throws on a card not in hand", () => {
    const s = createInitialState(0);
    for (let i = 0; i < 4; i++) applyBid(s, 3);
    s.turn = 0;
    s.hands[0] = [makeCard(0, 0)];
    expect(() => playCard(s, makeCard(1, 1))).toThrow();
  });
});

describe("trick flow", () => {
  it("plays out a full trick and assigns the win", () => {
    const s = createInitialState(0);
    // bid quickly
    for (let i = 0; i < 4; i++) applyBid(s, 3);
    expect(s.phase).toBe("playing");
    s.turn = 0;
    s.hands[0] = [makeCard(2, 5)]; // 7h
    s.hands[1] = [makeCard(2, 11)]; // Kh
    s.hands[2] = [makeCard(0, 12)]; // Ac (off-suit)
    s.hands[3] = [makeCard(3, 0)]; // 2s (trump)
    applyPlay(s, makeCard(2, 5));
    applyPlay(s, makeCard(2, 11));
    applyPlay(s, makeCard(0, 12));
    applyPlay(s, makeCard(3, 0));
    // spade trumps -> seat 3 wins
    expect(s.tricksWon[3]).toBe(1);
    expect(s.turn).toBe(3);
  });
});
