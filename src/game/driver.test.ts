import { describe, expect, it } from 'vitest';
import { HeuristicAgent } from '../ai/agents.js';
import { emptyKnowledge } from '../ai/infoset.js';
import { fullDeck } from '../engine/cards.js';
import { applyBid } from '../engine/rules.js';
import { cloneState, createInitialState } from '../engine/state.js';
import { playHandToCompletion } from './driver.js';

function readyHand() {
  const state = createInitialState(0);
  const deck = fullDeck();
  for (let seat = 0; seat < 4; seat++) {
    state.hands[seat] = deck.slice(seat * 13, (seat + 1) * 13);
    applyBid(state, 3);
  }
  return state;
}

describe('playHandToCompletion', () => {
  it('resolves all 52 legal plays and updates public knowledge', () => {
    const state = readyHand();
    const knowledge = emptyKnowledge();
    const agents = [
      new HeuristicAgent(),
      new HeuristicAgent(),
      new HeuristicAgent(),
      new HeuristicAgent(),
    ];

    playHandToCompletion(state, knowledge, agents);

    expect(state.phase).toBe('handDone');
    expect(state.completedTricks).toBe(13);
    expect(state.tricksWon.reduce((sum, tricks) => sum + tricks, 0)).toBe(13);
    expect(state.hands.every(hand => hand.length === 0)).toBe(true);
    expect(knowledge.played.filter(Boolean)).toHaveLength(52);
  });

  it('is deterministic from the same state', () => {
    const first = readyHand();
    const second = cloneState(first);
    const firstKnowledge = emptyKnowledge();
    const secondKnowledge = emptyKnowledge();
    const agents = [
      new HeuristicAgent(),
      new HeuristicAgent(),
      new HeuristicAgent(),
      new HeuristicAgent(),
    ];

    playHandToCompletion(first, firstKnowledge, agents);
    playHandToCompletion(second, secondKnowledge, agents);

    expect(second).toEqual(first);
    expect(secondKnowledge).toEqual(firstKnowledge);
  });
});
