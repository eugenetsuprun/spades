// Headless self-play harness: measures the strong AI's placement reward against
// baselines, checks determinism, and reports per-decision timing.
//
// Usage:
//   npm run selfplay -- --games 40 --opp heuristic --det 120 --exact 8
//   npm run selfplay -- --games 20 --opp random

import type { Card } from "../engine/cards.js";
import { playGame } from "../game/driver.js";
import {
  SearchAgent,
  HeuristicAgent,
  RandomAgent,
  type Agent,
} from "../ai/agents.js";
import type { InfoSet } from "../ai/infoset.js";
import type { SearchOptions } from "../ai/search.js";

function arg(name: string, def: string): string {
  const ix = process.argv.indexOf(`--${name}`);
  return ix >= 0 && process.argv[ix + 1] ? process.argv[ix + 1]! : def;
}

// Wraps an agent to record decision count and elapsed time.
class Timed implements Agent {
  name: string;
  inner: Agent;
  decisions = 0;
  ms = 0;
  maxMs = 0;
  constructor(inner: Agent) {
    this.inner = inner;
    this.name = inner.name;
  }
  private track(dt: number) {
    this.ms += dt;
    this.decisions++;
    if (dt > this.maxMs) this.maxMs = dt;
  }
  chooseBid(info: InfoSet): number {
    const t = performance.now();
    const r = this.inner.chooseBid(info);
    this.track(performance.now() - t);
    return r;
  }
  chooseCard(info: InfoSet): Card {
    const t = performance.now();
    const r = this.inner.chooseCard(info);
    this.track(performance.now() - t);
    return r;
  }
}

function makeOpponent(kind: string): Agent {
  if (kind === "random") return new RandomAgent();
  if (kind === "ai") return new SearchAgent();
  return new HeuristicAgent();
}

function main() {
  const games = parseInt(arg("games", "40"), 10);
  const oppKind = arg("opp", "heuristic");
  const det = parseInt(arg("det", "400"), 10);
  const exact = parseInt(arg("exact", "12"), 10);
  const opts: Partial<SearchOptions> = { determinizations: det, exactCards: exact };

  console.log(
    `Self-play: ${games} games | AI(det=${det},exact=${exact}) vs ${oppKind}`,
  );

  let aiReward = 0;
  let oppRewardSum = 0;
  let aiWins = 0; // sole or shared 1st (reward >= 1 from being top? track reward==2 and >=1)
  let aiTop = 0; // reward >= 1
  let aiSole = 0; // reward == 2
  let totalHands = 0;
  let aiNilBids = 0;
  let aiNilMade = 0;
  const timed = new Timed(new SearchAgent(opts, "AI"));

  // For determinism check.
  let detCheckPassed = true;

  for (let g = 0; g < games; g++) {
    const aiSeat = g % 4;
    const agents: Agent[] = [];
    for (let s = 0; s < 4; s++) {
      agents[s] = s === aiSeat ? timed : makeOpponent(oppKind);
    }
    const result = playGame(agents, 1000 + g);

    aiReward += result.rewards[aiSeat]!;
    for (let s = 0; s < 4; s++) if (s !== aiSeat) oppRewardSum += result.rewards[s]!;
    if (result.rewards[aiSeat]! === 2) aiSole++;
    if (result.rewards[aiSeat]! >= 1) aiTop++;
    if (result.scores[aiSeat]! === Math.max(...result.scores)) aiWins++;
    totalHands += result.numHands;
    for (const hand of result.hands) {
      if (hand.bids[aiSeat] === 0) {
        aiNilBids++;
        if (hand.tricks[aiSeat] === 0) aiNilMade++;
      }
    }

    // Determinism: replay the first game identically.
    if (g === 0) {
      const replay = playGame(agents, 1000 + g);
      detCheckPassed =
        JSON.stringify(replay.scores) === JSON.stringify(result.scores) &&
        JSON.stringify(replay.rewards) === JSON.stringify(result.rewards);
    }
  }

  const oppCount = games * 3;
  console.log("");
  console.log(`AI mean placement reward:      ${(aiReward / games).toFixed(3)}`);
  console.log(`Opponent mean placement reward: ${(oppRewardSum / oppCount).toFixed(3)}`);
  console.log(`AI sole-1st rate (reward 2):   ${((aiSole / games) * 100).toFixed(1)}%`);
  console.log(`AI top (1st incl. tie):        ${((aiWins / games) * 100).toFixed(1)}%`);
  console.log(`AI in-the-money (reward >=1):  ${((aiTop / games) * 100).toFixed(1)}%`);
  console.log(`Avg hands/game:                ${(totalHands / games).toFixed(2)}`);
  console.log(
    `AI nil bids:                   ${aiNilBids} (${aiNilBids ? ((aiNilMade / aiNilBids) * 100).toFixed(0) : "0"}% made)`,
  );
  console.log(
    `AI decisions: ${timed.decisions} | avg ${(timed.ms / timed.decisions).toFixed(1)} ms/decision | max single decision ${timed.maxMs.toFixed(0)} ms (budget 2000)`,
  );
  console.log(`Determinism check (replay==orig): ${detCheckPassed ? "PASS" : "FAIL"}`);

  // Baseline expectation: with 4 players, total reward per game is ~3 (one sole
  // 1st=2 + one sole 2nd=1), so a neutral player averages ~0.75.
  console.log(`(neutral baseline ~0.75; AI should beat both that and the opponent mean)`);
}

main();
