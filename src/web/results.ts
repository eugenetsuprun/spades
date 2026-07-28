export type Place = 1 | 2 | 3 | 4;

export interface FinishOutcome {
  place: Place;
  tied: boolean;
  pointsDelta: 1 | 0 | -0.5;
}

export interface MedalLedger {
  gold: number;
  silver: number;
  bronze: number;
  fourth: number;
  ties: number;
  form: number;
}

export const EMPTY_MEDAL_LEDGER: MedalLedger = {
  gold: 0,
  silver: 0,
  bronze: 0,
  fourth: 0,
  ties: 0,
  form: 0,
};

export function finishOutcome(scores: number[], seat: number): FinishOutcome {
  const score = scores[seat]!;
  const higher = scores.filter(candidate => candidate > score).length;
  const tied = scores.filter(candidate => candidate === score).length > 1;
  const place = Math.min(4, higher + 1) as Place;

  let pointsDelta: FinishOutcome['pointsDelta'] = -0.5;
  if (place === 1) pointsDelta = tied ? 0 : 1;
  else if (place === 2 && !tied) pointsDelta = 0;

  return { place, tied, pointsDelta };
}

export function applyMedalResult(
  ledger: MedalLedger,
  outcome: FinishOutcome,
): MedalLedger {
  const next = { ...ledger, form: ledger.form + outcome.pointsDelta };
  if (outcome.tied) {
    next.ties += 1;
  } else if (outcome.place === 1) {
    next.gold += 1;
  } else if (outcome.place === 2) {
    next.silver += 1;
  } else if (outcome.place === 3) {
    next.bronze += 1;
  } else {
    next.fourth += 1;
  }
  return next;
}

export function placementForSeat(scores: number[], seat: number): Place {
  return finishOutcome(scores, seat).place;
}
