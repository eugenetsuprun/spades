// Deterministic, seedable PRNG (mulberry32) + a small string hasher (FNV-1a).
// Used so that "same game state -> same decision": the search seeds its RNG from
// a hash of the canonical information set, and all sampling draws from it.

export class Rng {
  private s: number;

  constructor(seed: number) {
    // Avoid a zero state.
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  // mulberry32
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Integer in [0, n).
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  // Fisher-Yates shuffle in place.
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)]!;
  }
}

// FNV-1a 32-bit hash of a string -> seed.
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
