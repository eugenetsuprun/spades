# Solo Cutthroat Spades

A terminal game of **Solo (Cutthroat) Spades** — 4 independent players (you + 3 bots),
no partnerships — with a strong, fair, fully deterministic AI.

Design rationale lives in [`docs/ai-spec.md`](docs/ai-spec.md).

## Play

```bash
npm install
npm run play          # play in your terminal
npm run play -- --fast   # minimal pauses
```

You are seat **YOU**. Each hand: place a bid (Nil = take 0 tricks for +50), then
play cards (←/→ or ↑/↓, Enter). First running total to **40** ends the game after
the hand completes; **sole 1st place wins**.

## Rules implemented

- Standard 52-card deck, 13 cards each, spades trump.
- Bidding clockwise & visible. Nil allowed (no blind nil): made **+50**, failed **−50**
  (failed-nil tricks are **not** bags).
- Normal bid `b`: made = `10b` + 1 per overtrick (each overtrick is a bag); set = `−10b`.
- Bags accumulate; every 3 → **−30** and remove 3 (applied at end of hand).
- Must follow suit; spades can't be led until broken (unless hand is all spades).
- Cumulative scoring, totals may go negative. Game ends after the hand in which any
  total ≥ 40; ranking is by total.

## AI

The bots optimize **placement reward** (sole 1st = 2; shared 1st or sole 2nd = 1;
else 0), not raw score. Each decision:

- samples many **determinizations** of the hidden hands consistent with known voids,
  hand sizes, and played cards (`src/ai/infoset.ts`);
- evaluates candidate moves/bids by **flat Monte-Carlo rollouts** under a strong
  heuristic policy, switching to an **exact `maxn` solver** for the endgame
  (`src/ai/search.ts`);
- backs up the placement-reward value function with a small score-margin
  tie-breaker.

**Deterministic:** the RNG is seeded from a hash of the canonical information set and
a **fixed iteration budget** (not wall-clock) is used, so the same game state always
yields the same decision. Tuned default ≈ 20 ms/decision, far under the 2s budget.

## Develop

```bash
npm test                       # engine unit tests (vitest)
npm run typecheck              # tsc --noEmit
npm run selfplay -- --games 40 --opp heuristic   # measure AI strength
npm run selfplay -- --games 24 --opp random --det 200
```

Self-play reports mean placement reward (AI vs opponents), sole-1st rate,
avg hands/game, ms/decision, and a determinism (replay) check.

## Layout

- `src/engine/` — pure rules engine: cards, state, legal moves, trick resolution,
  scoring, placement value `V`. UI-agnostic and unit-tested.
- `src/ai/` — heuristic policy, determinization sampler/inference, search, agents.
- `src/game/driver.ts` — headless game loop (used by the harness).
- `src/harness/selfplay.ts` — strength/timing/determinism measurement.
- `src/cli/` — Ink terminal UI.
