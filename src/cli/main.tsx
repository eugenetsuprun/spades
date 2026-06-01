import { useEffect, useRef, useState } from "react";
import { render, Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";

import { fullDeck, suitOf, SUIT_GLYPHS, type Card } from "../engine/cards.js";
import {
  applyBid,
  playCard,
  scoreHand,
  legalMoves,
  trickWinner,
  isGameOver,
  placementReward,
} from "../engine/rules.js";
import {
  createInitialState,
  nextSeat,
  CARDS_PER_HAND,
  type GameState,
  type TrickEntry,
} from "../engine/state.js";
import { Rng } from "../engine/rng.js";
import {
  buildInfoSet,
  emptyKnowledge,
  observePlay,
  type PublicKnowledge,
} from "../ai/infoset.js";
import { SearchAgent } from "../ai/agents.js";
import { color, dim, sortForDisplay, bidLabel, seatName } from "./format.js";

const HUMAN = 0;
const FAST = process.argv.includes("--fast") || process.env.SPADES_FAST === "1";
const THINK_MS = FAST ? 60 : 250;
const TRICK_PAUSE_MS = FAST ? 250 : 1100;

const ai = new SearchAgent({}, "AI");

interface LastTrick {
  entries: TrickEntry[];
  winner: number;
  ledSuit: number;
}

type UiState =
  | { kind: "boot" }
  | { kind: "humanBid"; options: { label: string; value: number }[] }
  | { kind: "humanCard"; options: { label: string; value: number }[] }
  | { kind: "thinking"; seat: number }
  | { kind: "handEnd"; lines: string[] }
  | { kind: "gameOver"; lines: string[] };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Seat -> compass position. Human (seat 0) sits South; play rotates clockwise
// S -> E -> N -> W, matching the engine's clockwise turn order.
const POS_OF_SEAT = ["S", "E", "N", "W"] as const;

function bagPips(b: number): string {
  return "●".repeat(b) + "○".repeat(Math.max(0, 2 - b)) + (b === 2 ? " ⚠" : "");
}

function PlayerPanel({
  state,
  seat,
  ui,
}: {
  state: GameState;
  seat: number;
  ui: UiState;
}) {
  const active = state.phase === "bidding" || state.phase === "playing";
  const isTurn = state.turn === seat && active;
  const thinking = ui.kind === "thinking" && ui.seat === seat;
  const human = seat === HUMAN;
  const isLeader = state.firstLeader === seat;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isTurn ? "yellow" : human ? "cyan" : "gray"}
      paddingX={1}
      width={22}
    >
      <Text bold color={human ? "cyan" : undefined}>
        {isTurn ? "▶ " : "  "}
        {seatName(seat, HUMAN)} ({POS_OF_SEAT[seat]}){isLeader ? " ⬦lead" : ""}
      </Text>
      <Text>
        bid {bidLabel(state.bids[seat] ?? null)} · took {state.tricksWon[seat]}
      </Text>
      <Text dimColor>
        score {state.scores[seat]} · {bagPips(state.bags[seat]!)}
      </Text>
      {thinking ? (
        <Text color="yellow">
          <Spinner type="dots" /> thinking…
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

function TrickCell({
  state,
  lastTrick,
  seat,
}: {
  state: GameState;
  lastTrick: LastTrick | null;
  seat: number;
}) {
  const useLast = state.trick.length === 0 && lastTrick !== null;
  const entries = useLast ? lastTrick!.entries : state.trick;
  const winner = useLast ? lastTrick!.winner : -1;
  const entry = entries.find((e) => e.seat === seat);
  const pos = POS_OF_SEAT[seat];
  if (!entry) return <Text dimColor>{pos}: ·</Text>;
  const isWin = seat === winner;
  return (
    <Text>
      {pos}: {color(entry.card)}
      {isWin ? <Text color="green"> ◄</Text> : ""}
    </Text>
  );
}

function CenterTable({
  state,
  lastTrick,
}: {
  state: GameState;
  lastTrick: LastTrick | null;
}) {
  const led = state.ledSuit;
  const banner =
    led !== null
      ? `led ${SUIT_GLYPHS[led]}`
      : state.spadesBroken
        ? "♠ broken"
        : "— table —";
  const W = 25;
  return (
    <Box flexDirection="column" alignItems="center" width={W} marginX={1}>
      <Text dimColor>{banner}</Text>
      <Box width={W} justifyContent="center">
        <TrickCell state={state} lastTrick={lastTrick} seat={2} />
      </Box>
      <Box width={W} justifyContent="space-between">
        <TrickCell state={state} lastTrick={lastTrick} seat={3} />
        <TrickCell state={state} lastTrick={lastTrick} seat={1} />
      </Box>
      <Box width={W} justifyContent="center">
        <TrickCell state={state} lastTrick={lastTrick} seat={0} />
      </Box>
      <Text dimColor>
        {lastTrick && state.trick.length === 0
          ? `won by ${seatName(lastTrick.winner, HUMAN)}`
          : " "}
      </Text>
    </Box>
  );
}

function bidOptions(): { label: string; value: number }[] {
  const opts = [{ label: "Nil (0)", value: 0 }];
  for (let b = 1; b <= 13; b++) opts.push({ label: String(b), value: b });
  return opts;
}

function App() {
  const engine = useRef<{ state: GameState; knowledge: PublicKnowledge } | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((v) => v + 1);
  const [ui, setUi] = useState<UiState>({ kind: "boot" });
  const [lastTrick, setLastTrick] = useState<LastTrick | null>(null);
  const [message, setMessage] = useState<string>("");

  // Resolver for the current human input prompt.
  const resolver = useRef<((v: number) => void) | null>(null);
  const ackResolver = useRef<(() => void) | null>(null);

  const waitHuman = (kind: "humanBid" | "humanCard", options: { label: string; value: number }[]) =>
    new Promise<number>((res) => {
      resolver.current = res;
      setUi({ kind, options });
    });

  const waitAck = () => new Promise<void>((res) => (ackResolver.current = res));

  useInput((input, key) => {
    if (ackResolver.current && (key.return || input === " ")) {
      const r = ackResolver.current;
      ackResolver.current = null;
      r();
    }
  });

  useEffect(() => {
    let cancelled = false;
    const rng = new Rng((Date.now() ^ (Math.random() * 1e9)) >>> 0);

    async function run() {
      let firstLeader = rng.int(4);
      const state = createInitialState(firstLeader);
      engine.current = { state, knowledge: emptyKnowledge() };

      for (let h = 0; !cancelled; h++) {
        // Deal.
        const deck = rng.shuffle(fullDeck());
        for (let s = 0; s < 4; s++) {
          state.hands[s] = deck.slice(s * CARDS_PER_HAND, (s + 1) * CARDS_PER_HAND).sort((a, b) => a - b);
        }
        state.bids = [null, null, null, null];
        state.tricksWon = [0, 0, 0, 0];
        state.firstLeader = firstLeader;
        state.turn = firstLeader;
        state.trick = [];
        state.ledSuit = null;
        state.spadesBroken = false;
        state.phase = "bidding" as GameState["phase"];
        state.handNumber = h;
        state.completedTricks = 0;
        engine.current.knowledge = emptyKnowledge();
        setLastTrick(null);
        setMessage(`Hand ${h + 1} — ${seatName(firstLeader, HUMAN)} leads`);
        rerender();

        // Bidding.
        while (state.phase === "bidding" && !cancelled) {
          const seat = state.turn;
          let bid: number;
          if (seat === HUMAN) {
            bid = await waitHuman("humanBid", bidOptions());
          } else {
            setUi({ kind: "thinking", seat });
            await delay(THINK_MS);
            bid = ai.chooseBid(buildInfoSet(state, engine.current!.knowledge, seat));
          }
          if (cancelled) return;
          applyBid(state, bid);
          setMessage(`${seatName(seat, HUMAN)} bids ${bidLabel(bid)}`);
          rerender();
          if (seat !== HUMAN) await delay(FAST ? 80 : 350);
        }

        // Play.
        while (state.phase === "playing" && !cancelled) {
          const seat = state.turn;
          const isLead = state.trick.length === 0;
          const ledBefore = state.ledSuit;
          let card: Card;
          if (seat === HUMAN) {
            const legal = sortForDisplay(legalMoves(state));
            const options = legal.map((c) => ({ label: color(c), value: c }));
            card = await waitHuman("humanCard", options);
          } else {
            setUi({ kind: "thinking", seat });
            await delay(THINK_MS);
            card = ai.chooseCard(buildInfoSet(state, engine.current!.knowledge, seat));
          }
          if (cancelled) return;

          const willComplete = state.trick.length === 3;
          const snapshot = state.trick.map((t) => ({ ...t }));
          const ledForTrick = isLead ? suitOf(card) : ledBefore!;
          playCard(state, card); // rejects any illegal move
          observePlay(engine.current!.knowledge, seat, card, ledBefore, isLead);
          setMessage(`${seatName(seat, HUMAN)} plays ${color(card)}`);

          if (willComplete) {
            const entries = [...snapshot, { seat, card }];
            const winner = trickWinner(entries, ledForTrick);
            setLastTrick({ entries, winner, ledSuit: ledForTrick });
            rerender();
            await delay(TRICK_PAUSE_MS);
          } else {
            rerender();
          }
        }
        if (cancelled) return;

        // Score the hand.
        const res = scoreHand(state.bids.map((b) => b ?? 0), state.tricksWon, state.bags);
        for (let p = 0; p < 4; p++) state.scores[p]! += res.scoreDelta[p]!;
        state.bags = res.bagsAfter;

        const lines = [0, 1, 2, 3].map((p) => {
          const b = state.bids[p] ?? 0;
          const won = state.tricksWon[p]!;
          const d = res.scoreDelta[p]!;
          const sign = d >= 0 ? "+" : "";
          return `${seatName(p, HUMAN).padEnd(5)} bid ${bidLabel(b).padEnd(3)} took ${won}  ${sign}${d}  → ${state.scores[p]} (${state.bags[p]} bags)`;
        });

        if (isGameOver(state.scores)) {
          const r = placementReward(state.scores, HUMAN);
          const verdict =
            r === 2 ? "🏆 You win outright (1st)!" : r === 1 ? "You finish in the money." : "You lose this one.";
          setUi({ kind: "gameOver", lines: [...lines, "", verdict] });
          return;
        }

        setUi({ kind: "handEnd", lines: [...lines, "", "Press Enter for the next hand…"] });
        rerender();
        await waitAck();
        firstLeader = nextSeat(firstLeader);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const eng = engine.current;
  if (!eng) return <Text>Dealing…</Text>;
  const { state } = eng;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green" bold>
        ♠ Solo Cutthroat Spades ♠  (first to 40 — sole 1st = win)
      </Text>

      {/* Diamond table: N / W·center·E / S(YOU) */}
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <PlayerPanel state={state} seat={2} ui={ui} />
        <Box flexDirection="row" alignItems="center">
          <PlayerPanel state={state} seat={3} ui={ui} />
          <CenterTable state={state} lastTrick={lastTrick} />
          <PlayerPanel state={state} seat={1} ui={ui} />
        </Box>
        <PlayerPanel state={state} seat={0} ui={ui} />
      </Box>

      {/* Your hand */}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>your hand:</Text>
        <Text>
          {sortForDisplay(state.hands[HUMAN]!)
            .map((c) => color(c))
            .join(" ")}
        </Text>
      </Box>

      {/* Status / prompt */}
      <Box marginTop={1} flexDirection="column">
        <Text>{message}</Text>
        {ui.kind === "thinking" && (
          <Text color="yellow">
            <Spinner type="dots" /> {seatName(ui.seat, HUMAN)} thinking…
          </Text>
        )}
        {ui.kind === "humanBid" && (
          <Box flexDirection="column">
            <Text color="cyan">Your bid (Nil = take 0 tricks for +50):</Text>
            <SelectInput
              items={ui.options}
              limit={8}
              onSelect={(item) => {
                const r = resolver.current;
                resolver.current = null;
                setUi({ kind: "thinking", seat: HUMAN });
                r?.(item.value as number);
              }}
            />
          </Box>
        )}
        {ui.kind === "humanCard" && (
          <Box flexDirection="column">
            <Text color="cyan">Choose a card (←/→ or ↑/↓, Enter):</Text>
            <SelectInput
              items={ui.options}
              limit={13}
              onSelect={(item) => {
                const r = resolver.current;
                resolver.current = null;
                setUi({ kind: "thinking", seat: HUMAN });
                r?.(item.value as number);
              }}
            />
            <Text dimColor>
              (full hand, illegal dimmed) {sortForDisplay(state.hands[HUMAN]!)
                .map((c) => (legalMoves(state).includes(c) ? color(c) : dim(c)))
                .join(" ")}
            </Text>
          </Box>
        )}
        {(ui.kind === "handEnd" || ui.kind === "gameOver") && (
          <Box marginTop={1} flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{ui.kind === "gameOver" ? "GAME OVER" : "Hand complete"}</Text>
            {ui.lines.map((l, i) => (
              <Text key={i}>{l}</Text>
            ))}
            {ui.kind === "gameOver" && <Text dimColor>Press Ctrl-C to exit.</Text>}
          </Box>
        )}
      </Box>
    </Box>
  );
}

render(<App />);
