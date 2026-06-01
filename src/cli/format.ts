import chalk from "chalk";
import { suitOf, rankIxOf, RANK_LABELS, SUIT_GLYPHS, type Card } from "../engine/cards.js";

// Colored card label: red for hearts/diamonds, white for clubs/spades.
export function color(card: Card): string {
  const suit = suitOf(card);
  const label = RANK_LABELS[rankIxOf(card)] + SUIT_GLYPHS[suit];
  return suit === 1 || suit === 2 ? chalk.red(label) : chalk.whiteBright(label);
}

export function dim(card: Card): string {
  return chalk.dim(RANK_LABELS[rankIxOf(card)] + SUIT_GLYPHS[suitOf(card)]);
}

// Sort a hand for display: by suit (clubs, diamonds, hearts, spades), then rank.
export function sortForDisplay(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => {
    const sa = suitOf(a);
    const sb = suitOf(b);
    if (sa !== sb) return sa - sb;
    return rankIxOf(a) - rankIxOf(b);
  });
}

export function bidLabel(bid: number | null): string {
  if (bid === null) return "—";
  return bid === 0 ? "NIL" : String(bid);
}

export function seatName(seat: number, humanSeat: number): string {
  return seat === humanSeat ? "YOU" : `Bot${seat}`;
}
