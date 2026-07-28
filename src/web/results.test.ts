import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEDAL_LEDGER,
  applyMedalResult,
  finishOutcome,
} from './results.js';

describe('finishOutcome', () => {
  it('awards one point only for a sole first', () => {
    expect(finishOutcome([50, 40, 30, 20], 0)).toEqual({
      place: 1,
      tied: false,
      pointsDelta: 1,
    });
  });

  it('awards zero points for a tied first', () => {
    expect(finishOutcome([50, 50, 30, 20], 0)).toEqual({
      place: 1,
      tied: true,
      pointsDelta: 0,
    });
  });

  it('awards zero points for a sole second', () => {
    expect(finishOutcome([40, 50, 30, 20], 0)).toEqual({
      place: 2,
      tied: false,
      pointsDelta: 0,
    });
  });

  it('deducts half a point for a tied second', () => {
    expect(finishOutcome([40, 50, 40, 20], 0)).toEqual({
      place: 2,
      tied: true,
      pointsDelta: -0.5,
    });
  });

  it('deducts half a point for third and fourth', () => {
    expect(finishOutcome([30, 50, 40, 20], 0).pointsDelta).toBe(-0.5);
    expect(finishOutcome([20, 50, 40, 30], 0).pointsDelta).toBe(-0.5);
  });
});

describe('applyMedalResult', () => {
  it('tracks tied finishes separately from medals', () => {
    const next = applyMedalResult(
      EMPTY_MEDAL_LEDGER,
      finishOutcome([50, 50, 30, 20], 0),
    );
    expect(next).toEqual({
      ...EMPTY_MEDAL_LEDGER,
      ties: 1,
      form: 0,
    });
  });

  it('updates sole-finish medals and form', () => {
    const next = applyMedalResult(
      EMPTY_MEDAL_LEDGER,
      finishOutcome([50, 40, 30, 20], 0),
    );
    expect(next.gold).toBe(1);
    expect(next.form).toBe(1);
  });
});
