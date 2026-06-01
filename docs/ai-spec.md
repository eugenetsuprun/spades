# Solo Cutthroat Spades — AI Strategy & Architecture Spec (Research/Design)

> **Status:** implemented. See [`../README.md`](../README.md) for how to play, test, and
> run self-play. This document is the original design rationale; the shipped code follows
> it, with two deliberate simplifications noted in §7/§9 (flat Monte-Carlo instead of a full
> ISMCTS tree, and uniform-constrained — not yet bid-weighted — determinization sampling).

## Context

We are designing the AI for a **Solo (Cutthroat) Spades** game — delivered as a **simple, fast terminal app (Ink-based CLI)**: 4 independent players (1 human, 3 bots), no partnerships. The deliverable for this phase is a *research/design spec only* — no implementation. The goal is a single, well-reasoned blueprint for a **strong, fair, deterministic** bot that we can implement later with confidence. (Front-end surface decided: **terminal/CLI**, prioritizing simplicity and speed over a browser/PWA shell; the engine is UI-agnostic, so a web front-end remains possible later on the same core.)

Three decisions, confirmed with the user, dominate the design:

1. **Sprint format (win threshold = 40).** With `10×bid` scoring, one made bid of 4 ends the game. Games last ~1–3 hands. Consequences: enormous variance, **nil (+50) is effectively game-winning**, and *every decision must be evaluated against final placement, not raw score*, from hand 1.
2. **Reward is an egocentric placement bucket.** A bot maximizes **its own** expected placement reward:
   - **2** = unique highest score (sole 1st)
   - **1** = tied for highest (any 2+ way tie for 1st) **or** unique second-highest (sole 2nd)
   - **0** = otherwise (tied 2nd, 3rd, 4th)
   This is the single source of truth for all evaluation. Note the sharp incentives it creates (see §5).
3. **Opponent model:** placement-aware adversaries when compute allows; graceful fallback to a fixed strong heuristic policy under the time budget.

Engine latitude: **TypeScript-first**, with the search running off the UI thread (a Node `worker_threads` worker) so the terminal stays responsive during the 2s think. A documented **Rust→WASM** (or native N-API) port of the hot search loop remains the fallback if the budget can't be met.

---

## Rules (canonical, as implemented)

- 52-card deck, 13 cards each, 4 seats. First leader random hand 1, rotate clockwise each hand.
- Bidding sequential clockwise, fully visible. Nil allowed; **no blind nil**.
- Follow suit if able; if void, any card. Spades can't be **led** until broken, *unless* hand is all spades. Spades **may** be played on trick 1 if void in the led suit. (No first-trick scoring restriction.)
- **Scoring per hand:**
  - Normal bid `b` made: `+10b + 1` per overtrick (each overtrick = +1 point **and** +1 bag).
  - Normal bid `b` set (took < b): `−10b`.
  - Nil made (0 tricks): **+50**. Nil failed (≥1 trick): **−50**. **Tricks taken on a failed nil do NOT count as bags** — the −50 stands alone.
  - Bags: every 3 accumulated → **−30** and remove 3 (rolling, persists across hands). The −30 is applied **at end of hand**, after that hand's overtricks are added in.
- **Scoring is cumulative:** after each hand, every player's hand result (bid score ± overtricks ± any bag penalty) is added to a running total. **Totals may go negative.**
- **Game end:** after a *completed* hand in which any player's running total is **≥40**. All four score the hand first, then totals (negatives included) and the tie rules determine standings.

---

## Core principle: one value function

Everything below — bidding, nil, card play, bag decisions — is unified by a single **terminal value function** `V(player)` evaluated on a *projected end-of-game state*:

```
V(p) =  2  if score[p] is the strict maximum
        1  if score[p] ties the maximum (≥2 players share it)
        1  if score[p] is the strict second-highest
        0  otherwise
```

A decision is "good" iff it raises the bot's **expected** `V` over the belief distribution of hidden cards and future play. Because the game is a sprint, the projected end-of-game state is usually **the end of the current hand** (often hand 1–2), so the search horizon is short and `V` is reachable by direct simulation rather than long-run heuristics.

Two structural consequences of `V` to exploit:
- **Unique 1st is worth double a shared 1st.** When a bot can reach the top, *breaking the tie* (denying others your score level, or edging one point ahead) is worth +1 expected reward — a first-class objective, not a tiebreaker afterthought.
- **Sole 2nd == shared 1st (both = 1).** A bot that cannot realistically be sole 1st is indifferent between "tie the leader" and "lock a clean 2nd." This collapses a lot of endgame branching and tells trailing bots when *not* to gamble.

---

## 1. Bidding strategy

Bidding maximizes expected `V` of the projected end-of-game state, **not** expected tricks or expected score. The pipeline:

1. **Fast trick-estimate prior (pruning only).** A cheap closed-form estimate of mean tricks `μ` and spread `σ` for the hand, used to generate a small candidate bid set (typically `{0(nil), ⌊μ−1⌋ … ⌈μ+1⌉}`) so search isn't spent on absurd bids.
   - Spades: A≈1.0, guarded K≈0.85, guarded Q≈0.6; **length premium** ~+0.5 per spade beyond 3 (trumping is strong with 3 opponents who each hold ~3 spades).
   - Side aces ≈0.9; guarded side kings ≈0.55; guarded side queens ≈0.3.
   - Short-suit trump potential: add value only in proportion to spade length that can actually ruff (singleton ≈ +0.3–0.5 if ≥3 spades, void more).
   - These constants are *priors for candidate generation only*; the search produces the real numbers.
2. **Search-based evaluation.** For each candidate bid, run the trick-play engine (§3/§7) over many determinizations, assuming the bot then plays its best line under that contract, and opponents bid/play to their own `V`. Score each rollout to final standings → average `V`. Pick the argmax.
3. **Positional awareness from bid order.** Bidding is sequential and visible, so later seats condition on earlier bids (a high bid → that hand is strong & spade-heavy → adjust both my trick expectation *and* my belief model, §6). A bot bidding last has the most information and should exploit it (e.g., shade its bid to claim *unique* top, or duck into a safe 2nd).
4. **Sprint-specific bid shaping (emergent, but worth stating):**
   - From a level start, prefer the bid that, if made, yields **unique** 1st; avoid bids whose only making outcome ties a likely opponent (worth half).
   - Going set is catastrophic in a sprint (`−10b` with no time to recover), so the search will favor slightly conservative bids unless aggression is needed to overtake a leader in a final hand.
   - When trailing late, the search will naturally pick high-variance bids (or nil) because only the placement bucket matters, not the margin of loss.

---

## 2. Nil strategy

Nil is the highest-leverage decision in this format: **+50 ≈ a won game**, and a failed nil (**−50**) ≈ a lost one. Treated as a special candidate bid evaluated by the same `V`-search, but with dedicated modeling because the dynamics differ.

**Make-probability estimate (prior + simulation):**
- A nil hand wants: no un-duckable winners. Per suit, flag *forced winners* — e.g., a bare A, or A/K with too few low cards beneath to duck under leads. Count "escape cards" (low cards that can be shed when void elsewhere).
- **Spades are the chief danger:** holding any high/middling spade risks being forced to win late when you're stripped and must lead or ruff. Low spades with cover are tolerable; `Q+` spades or short high spades sharply cut `P(make)`.
- Length in a low side suit is good (lets you duck repeatedly); length in a high suit is bad.
- The fast estimate only *gates* whether nil enters the candidate set; the **simulation** (§7) produces the actual `P(make)` against placement-aware defenders.

**Defending against an opponent's nil (cutthroat dynamics):**
- Each defender independently decides whether to "set" the nil by *forcing* the nil player to win (leading suits where the nil hand is likely high, or under-leading to strand a high card).
- **Free-rider tension:** setting a nil helps *all three* opponents, so there's an incentive to let someone else do the work. The `V`-search resolves this honestly: a bot pays the cost of attacking a nil **only when doing so improves its own placement bucket** (e.g., the nil player is the only one who can overtake it). This naturally prevents both over-cooperation and total neglect.
- Defenders should track the nil player's revealed voids and forced holdings to time the "throw-in" that forces a win.

**Asymmetry to encode:** because −50 ≈ losing the game, the search must apply the placement bucket, which already penalizes the catastrophic tail correctly — *do not* add an extra ad-hoc risk term (it would double-count). The bot bids nil exactly when `E[V | nil] > E[V | best normal bid]`.

---

## 3. Trick-play strategy

Card play is produced by the search engine (§7); these are the **heuristics that power the rollout/eval policy** (so rollouts are strong and fast) and the principles the exact solver will rediscover:

- **Contract-relative intent.** Each player has a live target: make its own bid *exactly* (overtricks = bags, see §4), make/protect a nil, or — for placement — push a rival's bucket down.
- **When trying to win a trick:** win as cheaply as possible; preserve high cards and trump for when they're needed; don't waste an ace on a trick a lower card wins.
- **When trying to lose (nil, or already at bid):** duck under, shed dangerous high cards into others' winners, create voids to gain flexibility.
- **Trump (spades) discipline:** don't break spades early without reason; count outstanding trump (perfect memory makes this exact); time ruffs to extract opponents' winners or to set a contract.
- **Placement targeting (late hand):** when standings are clear, direct pressure at the player whose movement changes *your* bucket — set their bid, deny their nil, or feed them overtricks to trip a bag penalty — but only when the search shows it raises your own `E[V]`.
- **Throw-in / endplay tactics** against nils and against players who must avoid the lead.

These heuristics are *the rollout policy*, not the final move — the final move comes from search.

---

## 4. Bag management

Marginal bag value is **state-dependent** and must be computed exactly inside `V`, not approximated:

- A bag is `+1` now but the **3rd bag in a rolling triple costs −30** (net −29 for that specific overtrick). So with `bags mod 3 == 2`, the next overtrick is worth ≈ **−29**; otherwise ≈ **+1**.
- In a sprint, even one hand of loose play can reach 3 bags, so the penalty is live.
- **Implications the search will enforce:**
  - Avoid overtricks when `bags mod 3 == 2`, or whenever the −30 would drop your placement bucket.
  - Conversely, a `+1` bag is mildly good when it doesn't approach a triple and doesn't risk the contract.
  - **Offensive bagging:** forcing the *leader* to take overtricks to trip their −30 is a legitimate endgame tactic when it changes your bucket — though hard to engineer within a single hand.
- Provide a closed-form `bagDelta(currentBags, overtricks)` used both by the exact scorer and by the heuristic eval so rollouts price bags correctly.

---

## 5. Endgame / placement strategy

Because the game ends the hand someone reaches 40, **most hands are "the endgame."** The search must, for the hand in progress, project final standings and apply `V` and the tie rules. Position-dependent behavior emerges from `V`:

- **Leader / can-win-outright:** play to *secure unique 1st*. Often means bidding conservatively to avoid a set, dodging the bag penalty, and — when close — grabbing the **one extra point that breaks a tie** (2 vs 1). Don't take needless risk; you already hold the most valuable bucket.
- **Chaser who can reach the top:** maximize `P(unique 1st)`; tie-or-better is only worth 1, so pure ties aren't the goal unless they're a stepping stone to overtaking.
- **Player who can't realistically be sole 1st:** since *sole 2nd = shared 1st = 1*, lock the **safest** path to a `1` bucket; don't gamble for an outcome that pays the same as a safer one. This is a strong, non-obvious pruning rule the bot gets for free from `V`.
- **Targeting is instrumental only.** Hurting a rival has value **iff** it changes the bot's own bucket. The egocentric `V` keeps this disciplined — no altruistic "set the leader" plays that don't help the bot.
- **Tie-breaking is a real lever**, not an afterthought: design `V` (above) and the scorer to read ties exactly as the rules specify, and let search chase the +1 that converts shared→unique 1st.

---

## 6. Hidden-card inference model

Bots are **fair** (never see hidden cards) but have **perfect memory** of all public information and infer the rest.

**Hard constraints (exact):**
- Every played card is known and removed from the unseen pool.
- A player who fails to follow a led suit is **void** in it (permanent constraint).
- Hand-size constraints: remaining unseen cards partition exactly among the 3 unknown hands by their current counts.

**Soft constraints / priors (likelihood weighting):**
- **Bids leak strength:** a high bid → more high cards / spade length; nil → few high cards, duckable shape. Maintain `P(card ∈ hand_i | bid_i)`.
- **Play leaks shape:** ducking, discards, ruff/over-ruff choices, and refusal to lead spades all update beliefs (e.g., a player who discards a suit signals shortness/disinterest).

**Representation:** a **particle filter / weighted determinization sampler**:
- A *determinization* = one full assignment of unseen cards to the 3 hidden hands consistent with all hard constraints.
- Sample determinizations by constraint-respecting dealing, **weighted** by `P(observed bids & plays | determinization)` (importance sampling). Resample/normalize as the hand progresses.
- This belief is the input to the search (§7): every rollout starts from a sampled determinization, so inference and search are one pipeline.

**Note on fairness & determinism:** beliefs are a pure function of the public record + the bot's own hand, so they're reproducible (see §7 determinism).

---

## 7. Search approach (ISMCTS / determinization / rollout hybrid)

**Backbone: Single-Observer Information-Set MCTS (SO-ISMCTS)** with biased determinization, because it handles hidden information without the *strategy-fusion* and *non-locality* errors that pure PIMC suffers. Structure:

- Tree nodes = the searching bot's **information sets**; edges = legal actions.
- Each iteration: draw a determinization from the belief sampler (§6), descend the tree using that world, expand, then **roll out with the heuristic policy (§3)**, and back up the **terminal `V`** (placement reward) — not tricks.
- Opponents in-tree act under their **own** `V` (placement-aware) when the budget allows; otherwise they follow the fixed heuristic policy (the §3 rollout policy). This is the user-approved hybrid: *placement-aware if affordable, fixed heuristic fallback.* A single switch selects the opponent model per difficulty/perf tier.

**Endgame exact solve.** Once few cards remain (≈ ≤6–8 cards/hand, branching collapsed by follow-suit), replace MCTS leaves with an **exact perfect-information `maxn` search** (one per determinization, each player maximizing own `V`), averaged over determinizations. Small Spades layouts solve in well under the budget; this gives provably correct late-hand play (throw-ins, last-trick bag/tie management) where it matters most.

**Baseline / fallback: PIMC** (sample deals → perfect-info `maxn` solve each → vote/average the action). Simpler to build and strong for trick games; we ship it first as a correctness baseline and A/B target, then layer ISMCTS on top. Document its known weaknesses (strategy fusion, non-locality) as the reason ISMCTS is the eventual backbone.

**Bidding** uses the same engine: each candidate bid is the root action, evaluated by simulating the rest of the hand to `V`.

**Determinism (critical design constraint).** "Same game state → same decision" requires two things:
1. **Seeded RNG:** seed = hash of the canonical-serialized information set (public state + bot's own hand + ply index). All sampling (determinizations, rollouts) draws from this seeded stream → fully reproducible. Use a small fast PRNG (e.g., mulberry32/xoshiro).
2. **Fixed iteration budget, not wall-clock.** A wall-clock 2s cutoff yields machine-dependent iteration counts → **non-deterministic** results. Instead use a **fixed sample/iteration count** calibrated to complete within 2s on the target tier; the 2s is an upper *bound*, not the stopping rule. (If we ever need adaptive time, gate it behind a "deterministic mode" flag for tests/replays.)

**Budget allocation.** Within the fixed budget, trade determinizations × rollouts-per-determinization; tune via offline self-play. Spend more on bidding and on the first few plays of a hand (highest leverage), less on forced/near-forced plays (detect singletons / forced follows and short-circuit).

---

## 8. Recommended architecture (for future implementation)

**Topology:** a **standalone Node.js terminal app** — no server, no network, fully offline. UI renders on the main thread (Ink); the AI runs in a **`worker_threads` worker** so the 2s think never freezes input/rendering. Gameplay is deterministic.

**Module boundaries (engine is UI-agnostic, pure, and unit-testable):**
- `GameState` — immutable snapshot: hands (own known), played cards, bids, scores, bags, turn, trump-broken, leader rotation.
- `RulesEngine` — legal-move generation, trick resolution, **exact scorer** (including `bagDelta` and the tie-aware standings/`V`).
- `InferenceEngine` — hard constraints + bid/play likelihood → belief.
- `Sampler` — weighted determinization generator (particle filter) over the belief.
- `SearchEngine` — SO-ISMCTS + endgame `maxn` solver + PIMC baseline, behind one `decide(state) → action` API.
- `Policy` — heuristic rollout/eval policy (§3) shared by rollouts and as opponent fallback.
- `Evaluator` — `V` and projected-standings logic (§Core principle, §5).
- `RNG` — seedable deterministic PRNG; seed derived from canonical state hash.

**Performance plan (matches "TS now, WASM if needed"):**
1. Build the whole engine in **TypeScript**; run it in a `worker_threads` worker; tune fixed budgets to hit 2s on a typical laptop/desktop.
2. **Profile.** If iteration counts are too low for strong play within 2s, port the **hot loop** (Sampler + SearchEngine + RulesEngine move-gen/scoring) to **Rust → WASM** (or a native N-API addon), keeping the TS API identical. UI stays TS regardless.

**Persistence:** a single local JSON save file (e.g., under the OS config dir) for resume + deterministic replay — no DB, no network.

**Testability:** seedable RNG + pure engine ⇒ **replayable games and snapshot tests**; assert `decide()` reproducibility; build a **self-play harness** (headless, no Ink) to tune heuristics/budgets and to measure placement-reward win-rate vs. baselines.

**Suggested initial layout** (to be created when we exit research phase):
- `docs/ai-spec.md` (this document, materialized)
- `packages/engine/` (pure TS engine: the modules above — UI-agnostic, the reusable core)
- `packages/engine/__tests__/` (rules, scorer, determinism, self-play)
- `apps/cli/` (Ink terminal front-end + worker bridge + headless self-play harness)

---

## 8b. Terminal UI & rendering

**Goal: simple and fast, minimal motion.** Spades is interaction-light — the only inputs are **pick a bid** and **choose a card** — so the terminal is a great fit and needs no game framework, no canvas, no animation library.

**Library: Ink** (React-for-the-terminal, MIT). It lets us build the TUI with the same component model as the engine's TS, with flexbox layout (`ink`), text styling (`chalk`), and ready-made input widgets (`ink-select-input` for bid/card menus, `ink-spinner` for the bot "thinking…" indicator). Mature, small, well-maintained.
- Alternative if we want zero React deps: **blessed / neo-blessed** (lower-level, more boilerplate) — not recommended given the engine is already TS/React-shaped.

**Card rendering: Unicode + ANSI color, no images.**
- Render cards as `A♠ K♥ 10♦ Q♣` with red/black coloring via `chalk` (♥♦ red, ♠♣ default). Optionally use the Unicode playing-card code points (🂡…) behind a flag, but plain rank+suit glyphs are the most legible across terminals — default to those.
- The human's hand is a horizontal list; **legal cards come straight from `RulesEngine.legalMoves()`** and illegal cards are dimmed/non-selectable. The UI holds zero game logic — it's a thin view over engine state.

**Motion: essentially none.** Per the "simple and fast" requirement, advance state by **re-rendering** (Ink diffs efficiently) rather than animating. The only dynamic affordance is a `ink-spinner` while the worker computes a bot move, and a brief, skippable pause between tricks so the human can read the board. No tweening, no card-flight effects. A `--fast`/`--no-pause` flag removes even the inter-trick pause.

**Screen sketch (single full-screen Ink view):**
```
  Bot2 (W2/0 bags)   bid 3   [▮▮▮ ▮ ]      <- hand counts as pips
        ── trick ──
  Bot1: K♠   You: ?   Bot3: 7♠   Bot2: —
        ───────────
  YOU (score 0, 0 bags)   bid: NIL
  Hand:  2♣ 5♣ 9♦ J♦ Q♥ A♥ 3♠ ...   (illegal cards dimmed)
  Scores  You 0 | B1 10 | B2 0 | B3 -10     Bags: B1●●  (next bag = -30!)
  > choose a card  [◀ ▶ to move, Enter to play]
```
A side/footer panel always shows scores and **bag pips, flagging when `bags mod 3 == 2`** (the dangerous overtrick). End-of-hand and end-of-game summaries are plain text screens.

**Why no turn-based game framework (e.g., boardgame.io)?** It would want to own game state, turn flow, and bot orchestration — exactly what our **custom deterministic engine + worker AI** already does, and it would fight our determinism/seed requirements. Skip it; Ink just subscribes to engine state.

**Net stack:** Node.js · **Ink** (+ `chalk`, `ink-select-input`, `ink-spinner`) for the TUI · **custom engine in a `worker_threads` worker** · no game framework, no canvas, no animation library.

---

## 9. Risks & open questions

**Confirmed (resolved):** win threshold = 40 (sprint); tie-for-1st reward = 1 each; placement-aware opponents with heuristic fallback; TS-now/WASM-later; **failed-nil tricks are NOT bags**; **bag −30 applied at end of hand**; **cumulative scoring, totals may go negative, rank by total after each hand** (no "first to 40 wins" — pure highest total after the completing hand); front-end = **terminal (Ink)**.

**Open questions to resolve before/early in build:**
1. **All-spades-only edge** lead rule, leading-before-broken edge cases, and any other rare legality edges — enumerate for the RulesEngine test suite.
2. **Made-nil + bags:** a made nil takes 0 tricks so contributes no bags — assumed no interaction. (Trivially confirmed; noted for completeness.)

**Technical risks:**
- **Budget vs. strength within 2s:** ISMCTS quality within a *fixed* deterministic budget on a typical machine is the central risk → mitigated by endgame exact solve, forced-move short-circuiting, and the WASM/native fallback.
- **Strategy fusion / non-locality** if we lean on PIMC too long → mitigated by moving the backbone to ISMCTS and exact endgame.
- **Opponent-model recursion cost:** placement-aware opponents inside the tree can blow up cost → the heuristic-fallback switch and depth caps bound it; tune per tier.
- **Inference quality:** bad likelihood weights → worse-than-fair-random beliefs. Validate the particle filter against held-out self-play; keep hard constraints exact even if soft priors are crude initially.
- **Determinism pitfalls:** any unseeded `Math.random`, `Map`/`Set` iteration-order assumptions, or float non-associativity across TS↔WASM could break reproducibility → centralize RNG, canonicalize serialization, add reproducibility tests in CI.

---

## Verification (for this research phase)

This deliverable is the spec itself. "Done" for this phase = the user reviews this document and confirms the strategy/architecture is solid. The only build action in this phase is materializing the spec as `docs/ai-spec.md`; **no game code is written until a separate implementation go-ahead.**

When implementation does begin, end-to-end verification will be: (1) `RulesEngine` + scorer unit tests incl. bag triples, failed-nil-no-bags, cumulative/negative totals, and tie-aware `V`; (2) determinism tests (`decide()` reproducible from seed); (3) a headless self-play harness measuring placement-reward win-rate of the strong AI vs. the PIMC baseline and vs. a naive heuristic, confirming it meets "strongest level" within the 2s deterministic budget on target hardware.
