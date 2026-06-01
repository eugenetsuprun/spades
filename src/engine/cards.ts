// Card model. A card is an integer 0..51.
//   suit  = Math.floor(id / 13)   -> 0 clubs, 1 diamonds, 2 hearts, 3 spades
//   rankIx = id % 13              -> 0 = "2", ... , 8 = "10", 9 = "J", 10 = "Q", 11 = "K", 12 = "A"
// Spades (suit 3) is the trump suit. Higher rankIx beats lower within a suit.

export type Card = number; // 0..51
export type Suit = 0 | 1 | 2 | 3; // clubs, diamonds, hearts, spades

export const SPADES: Suit = 3;
export const NUM_CARDS = 52;

export const SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"] as const;
export const SUIT_GLYPHS = ["♣", "♦", "♥", "♠"] as const; // ♣ ♦ ♥ ♠
export const RANK_LABELS = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
] as const;

export function suitOf(card: Card): Suit {
  return Math.floor(card / 13) as Suit;
}

export function rankIxOf(card: Card): number {
  return card % 13;
}

export function makeCard(suit: Suit, rankIx: number): Card {
  return suit * 13 + rankIx;
}

export function isSpade(card: Card): boolean {
  return suitOf(card) === SPADES;
}

export function cardLabel(card: Card): string {
  return RANK_LABELS[rankIxOf(card)] + SUIT_GLYPHS[suitOf(card)];
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < NUM_CARDS; i++) deck.push(i);
  return deck;
}

// Compare two cards played to a trick, given the led suit. Returns true if `a`
// beats `b` (a was played, b is current best). Trump beats non-trump; within a
// suit higher rank wins; off-suit non-trump cards never win.
export function beats(a: Card, b: Card, ledSuit: Suit): boolean {
  const sa = suitOf(a);
  const sb = suitOf(b);
  if (sa === sb) return rankIxOf(a) > rankIxOf(b);
  if (sa === SPADES) return true; // a trumps
  if (sb === SPADES) return false; // b is trump, a is not
  // Different non-trump suits: only the led suit can win.
  if (sa === ledSuit) return true;
  return false;
}
