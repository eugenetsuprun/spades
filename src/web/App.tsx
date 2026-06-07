import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, TrickEntry } from '../engine/state.js';
import { createInitialState, cloneState, nextSeat, CARDS_PER_HAND, NUM_PLAYERS } from '../engine/state.js';
import type { Card, Suit } from '../engine/cards.js';
import { fullDeck, RANK_LABELS, SUIT_GLYPHS, suitOf, rankIxOf } from '../engine/cards.js';
import {
  applyBid, applyPlay, legalMoves as getLegalMoves,
  scoreHand, isGameOver, placementRewards,
} from '../engine/rules.js';
import type { PublicKnowledge } from '../ai/infoset.js';
import { emptyKnowledge, buildInfoSet, observePlay } from '../ai/infoset.js';
import { SearchAgent } from '../ai/agents.js';
import { Rng } from '../engine/rng.js';

// ── Constants ────────────────────────────────────
const HUMAN = 0;
const SEAT_NAMES = ['You', 'East', 'North', 'West'];
const SEAT_DIRS  = ['south', 'east', 'north', 'west'] as const;
const AI_BID_DELAY  = 380;
const AI_PLAY_DELAY = 460;
const TRICK_PAUSE   = 900;

// ── Types ────────────────────────────────────────────
interface TrickPause {
  entries: TrickEntry[];
  winner: number;
  ledSuit: Suit;
}

interface HandSummaryData {
  handNumber: number;
  bids: number[];
  tricks: number[];
  delta: number[];
  scoresAfter: number[];
  bagsAfter: number[];
}

type AppState =
  | { tag: 'start' }
  | { tag: 'game'; gs: GameState; pk: PublicKnowledge; trickPause: TrickPause | null }
  | { tag: 'hand-summary'; data: HandSummaryData; nextGs: GameState; nextPk: PublicKnowledge }
  | { tag: 'game-over'; scores: number[]; placements: number[] };

// ── Helpers ───────────────────────────────────────
function clonePk(pk: PublicKnowledge): PublicKnowledge {
  return { played: pk.played.slice(), voids: pk.voids.map(v => v.slice()) };
}

function dealIntoState(gs: GameState, rng: Rng): void {
  const deck = rng.shuffle(fullDeck());
  for (let s = 0; s < NUM_PLAYERS; s++) {
    gs.hands[s] = deck.slice(s * CARDS_PER_HAND, (s + 1) * CARDS_PER_HAND).sort((a, b) => a - b);
  }
}

function startHandState(prevGs: GameState | null, rng: Rng): { gs: GameState; pk: PublicKnowledge } {
  const firstLeader = prevGs ? nextSeat(prevGs.firstLeader) : rng.int(NUM_PLAYERS);
  const gs = createInitialState(firstLeader);
  if (prevGs) {
    gs.scores = prevGs.scores.slice();
    gs.bags   = prevGs.bags.slice();
    gs.handNumber = prevGs.handNumber + 1;
  }
  dealIntoState(gs, rng);
  return { gs, pk: emptyKnowledge() };
}

// AI agents — created once, reused across games
const AI_AGENTS: (SearchAgent | null)[] = [
  null,
  new SearchAgent(),
  new SearchAgent(),
  new SearchAgent(),
];

// ══════════════════════════════════════════════════
//  CARD COMPONENT
// ══════════════════════════════════════════════════
interface CardProps {
  card: Card;
  playable?: boolean;
  illegal?: boolean;
  winner?: boolean;
  size?: 'sm';
  onClick?: () => void;
}

function PlayingCard({ card, playable, illegal, winner, size, onClick }: CardProps) {
  const suit   = suitOf(card);
  const rank   = RANK_LABELS[rankIxOf(card)]!;
  const glyph  = SUIT_GLYPHS[suit]!;
  const isRed  = suit === 1 || suit === 2;

  const cls = [
    'card',
    isRed ? 'card--red' : 'card--black',
    playable ? 'card--playable' : '',
    illegal  ? 'card--illegal'  : '',
    winner   ? 'card--winner'   : '',
    size     ? `card--${size}`  : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} onClick={playable && !illegal && onClick ? onClick : undefined} role={playable ? 'button' : undefined}>
      <div className="card__corner card__corner--tl">
        <span className="card__rank">{rank}</span>
        <span className="card__suit-sm">{glyph}</span>
      </div>
      <div className="card__center">{glyph}</div>
      <div className="card__corner card__corner--br">
        <span className="card__rank">{rank}</span>
        <span className="card__suit-sm">{glyph}</span>
      </div>
    </div>
  );
}

function CardBack({ size }: { size?: 'sm' }) {
  return <div className={['card', 'card--back', size ? `card--${size}` : ''].filter(Boolean).join(' ')} />;
}

// ══════════════════════════════════════════════════
//  PLAYER BADGE
// ══════════════════════════════════════════════════
function PlayerBadge({ seat, gs, isActive }: { seat: number; gs: GameState; isActive: boolean }) {
  const name    = SEAT_NAMES[seat]!;
  const bid     = gs.bids[seat];
  const tricks  = gs.tricksWon[seat]!;
  const score   = gs.scores[seat]!;
  const isHuman = seat === HUMAN;
  const bidStr  = bid === null ? '—' : bid === 0 ? 'NIL' : String(bid);

  return (
    <div className={['badge', isHuman ? 'badge--human' : '', isActive ? 'badge--active' : ''].filter(Boolean).join(' ')}>
      <div className="badge__name">{name}</div>
      <div className="badge__score">{score}</div>
      <div className="badge__meta">
        <span>bid {bidStr}</span>
        <span>won {tricks}</span>
      </div>
    </div>
  );
}

// Small face-down cards showing how many cards an opponent holds
function OppHand({ count }: { count: number }) {
  const shown = Math.min(count, 5);
  return (
    <div className="opp-cards">
      {Array.from({ length: shown }).map((_, i) => <CardBack key={i} size="sm" />)}
    </div>
  );
}

// ══════════════════════════════════════════════════
//  TRICK AREA
// ══════════════════════════════════════════════════
function TrickArea({
  gs, trickPause,
}: {
  gs: GameState;
  trickPause: TrickPause | null;
}) {
  const displayEntries = trickPause ? trickPause.entries : gs.trick;
  const winner = trickPause?.winner ?? null;

  return (
    <div className="trick-area">
      <div className="trick-inner">
        {[0, 1, 2, 3].map(seat => {
          const entry = displayEntries.find(e => e.seat === seat);
          return (
            <div key={seat} className={`trick-slot trick-slot--${seat}`}>
              {entry ? (
                <PlayingCard
                  card={entry.card}
                  winner={winner === seat && trickPause !== null}
                />
              ) : (
                <div className="trick-slot--empty"><div className="card-ghost" /></div>
              )}
            </div>
          );
        })}
        <div className="trick-meta">
          {gs.completedTricks}/{13}<br/>
          {gs.spadesBroken ? '♠ broken' : '♠ not led'}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  STATUS BAR TEXT
// ══════════════════════════════════════════════════
function StatusText({ gs, trickPause, isHandDone }: {
  gs: GameState;
  trickPause: TrickPause | null;
  isHandDone: boolean;
}) {
  if (isHandDone) return <span>Hand complete</span>;
  if (trickPause) {
    const winner = trickPause.winner;
    return <span>{SEAT_NAMES[winner]} takes the trick</span>;
  }
  const turn = gs.turn;
  if (gs.phase === 'bidding') {
    if (turn === HUMAN) return <span>Your bid:</span>;
    return (
      <span>
        {SEAT_NAMES[turn]} is bidding
        <ThinkingDots />
      </span>
    );
  }
  if (gs.phase === 'playing') {
    if (turn === HUMAN) return <span>Your turn to play</span>;
    return (
      <span>
        {SEAT_NAMES[turn]} is playing
        <ThinkingDots />
      </span>
    );
  }
  return null;
}

function ThinkingDots() {
  return (
    <span className="thinking-dots" style={{ marginLeft: 6 }}>
      <span /><span /><span />
    </span>
  );
}

// ══════════════════════════════════════════════════
//  BID SELECTOR
// ══════════════════════════════════════════════════
function BidSelector({ onBid }: { onBid: (bid: number) => void }) {
  return (
    <div className="bid-panel">
      <div className="bid-label">CHOOSE YOUR BID</div>
      <div className="bid-grid">
        {Array.from({ length: 14 }, (_, i) => (
          <button
            key={i}
            className={`bid-btn ${i === 0 ? 'bid-btn--nil' : ''}`}
            onClick={() => onBid(i)}
          >
            {i === 0 ? 'NIL' : i}
          </button>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  HAND SUMMARY OVERLAY
// ══════════════════════════════════════════════════
function HandSummaryOverlay({
  data, onContinue,
}: {
  data: HandSummaryData;
  onContinue: () => void;
}) {
  return (
    <div className="overlay">
      <div className="overlay-panel">
        <h2>Hand {data.handNumber + 1} Results</h2>
        <table className="score-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="col-num">Bid</th>
              <th className="col-num">Won</th>
              <th className="col-num">+/−</th>
              <th className="col-num">Total</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map(seat => {
              const d = data.delta[seat]!;
              return (
                <tr key={seat} className={seat === HUMAN ? 'you' : ''}>
                  <td>{SEAT_NAMES[seat]}</td>
                  <td className="col-num">{data.bids[seat] === 0 ? 'NIL' : data.bids[seat]}</td>
                  <td className="col-num">{data.tricks[seat]}</td>
                  <td className={`col-num ${d > 0 ? 'delta-pos' : d < 0 ? 'delta-neg' : ''}`}>
                    {d > 0 ? `+${d}` : d}
                  </td>
                  <td className="col-num" style={{ fontWeight: 700 }}>{data.scoresAfter[seat]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="btn btn--primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  GAME OVER OVERLAY
// ══════════════════════════════════════════════════
function GameOverOverlay({
  scores, placements, onNewGame,
}: {
  scores: number[];
  placements: number[];
  onNewGame: () => void;
}) {
  const order = [0, 1, 2, 3].sort((a, b) => scores[b]! - scores[a]!);
  const medals = ['🥇', '🥈', '🥉', '4️⃣'];

  return (
    <div className="overlay">
      <div className="overlay-panel">
        <h2>Game Over</h2>
        <div className="podium">
          {order.map((seat, rank) => (
            <div
              key={seat}
              className={[
                'podium__row',
                rank === 0 ? 'podium__row--1st' : '',
                seat === HUMAN ? 'podium__row--you' : '',
              ].filter(Boolean).join(' ')}
            >
              <span className="podium__rank">{medals[rank]}</span>
              <span className="podium__name">{SEAT_NAMES[seat]}</span>
              <span className="podium__score">{scores[seat]}</span>
            </div>
          ))}
        </div>
        {placements[HUMAN] === 2
          ? <p style={{ textAlign: 'center', color: '#6ee86e', fontWeight: 700, marginBottom: 16 }}>You won! 🎉</p>
          : placements[HUMAN] === 0
          ? <p style={{ textAlign: 'center', opacity: 0.6, marginBottom: 16 }}>Better luck next time.</p>
          : <p style={{ textAlign: 'center', color: '#e8c060', marginBottom: 16 }}>Well played!</p>}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="btn btn--primary" onClick={onNewGame}>
            Play Again
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  START SCREEN
// ══════════════════════════════════════════════════
function StartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="start-screen">
      <div className="start-screen__logo">♠</div>
      <div>
        <h1 className="start-screen__title">Solo Cutthroat Spades</h1>
        <p className="start-screen__subtitle">
          4-player free-for-all. First to 40 wins.
        </p>
      </div>
      <ul className="start-screen__rules">
        <li>Bid your tricks — make your bid or get set</li>
        <li>Bid NIL to score +50 by taking zero tricks</li>
        <li>Bags (over-tricks) accumulate — every 3 costs 30 pts</li>
        <li>Spades always trump</li>
      </ul>
      <button className="btn btn--primary" onClick={onStart}>
        Deal Cards
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  GAME TABLE
// ══════════════════════════════════════════════════
function GameTable({
  gs, pk, trickPause, onBid, onPlay,
}: {
  gs: GameState;
  pk: PublicKnowledge;
  trickPause: TrickPause | null;
  onBid: (bid: number) => void;
  onPlay: (card: Card) => void;
}) {
  const isHumanBid  = gs.phase === 'bidding' && gs.turn === HUMAN && !trickPause;
  const isHumanPlay = gs.phase === 'playing' && gs.turn === HUMAN && !trickPause;
  const legal = isHumanPlay ? new Set(getLegalMoves(gs)) : new Set<Card>();
  const humanHand = gs.hands[HUMAN]!;
  const isHandDone = gs.phase === 'handDone';

  // Sort hand: clubs, diamonds, hearts, spades; then by rank
  const sortedHand = humanHand.slice().sort((a, b) => {
    const sa = suitOf(a), sb = suitOf(b);
    if (sa !== sb) return sa - sb;
    return rankIxOf(a) - rankIxOf(b);
  });

  return (
    <div className="table">
      <div className="table__header">
        <span>♠ Spades</span>
        <span className="subtitle">Hand {gs.handNumber + 1} · First to 40</span>
        <span className="score">You: {gs.scores[HUMAN]}</span>
      </div>

      <div className="table__felt">
        <div className="player player--west">
          <OppHand count={gs.hands[3]!.length} />
          <PlayerBadge seat={3} gs={gs} isActive={gs.turn === 3 && !trickPause} />
        </div>

        <div className="player player--north">
          <OppHand count={gs.hands[2]!.length} />
          <PlayerBadge seat={2} gs={gs} isActive={gs.turn === 2 && !trickPause} />
        </div>

        <div className="player player--east">
          <OppHand count={gs.hands[1]!.length} />
          <PlayerBadge seat={1} gs={gs} isActive={gs.turn === 1 && !trickPause} />
        </div>

        <TrickArea gs={gs} trickPause={trickPause} />

        <div className="player player--south">
          <PlayerBadge seat={HUMAN} gs={gs} isActive={isHumanBid || isHumanPlay} />
        </div>
      </div>

      <div className="human-area">
        <div className="status-bar">
          <StatusText gs={gs} trickPause={trickPause} isHandDone={isHandDone} />
        </div>

        {/* Bid grid — visible above hand when it's your turn to bid */}
        {isHumanBid && <BidSelector onBid={onBid} />}

        {/* Hand — always visible so you can see your cards when bidding */}
        <div className={`hand${isHumanBid ? ' hand--bidding' : ''}`}>
          {sortedHand.map(card => (
            <PlayingCard
              key={card}
              card={card}
              playable={isHumanPlay && legal.has(card)}
              illegal={isHumanPlay && !legal.has(card)}
              onClick={isHumanPlay ? () => onPlay(card) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════
//  ROOT APP
// ══════════════════════════════════════════════════
export default function App() {
  const [appState, setAppState] = useState<AppState>({ tag: 'start' });
  const rngRef = useRef<Rng | null>(null);

  // ── Start / New Game ─────────────────────────────
  const startGame = useCallback(() => {
    const rng = new Rng((Date.now() ^ Math.random() * 0xffffffff) >>> 0);
    rngRef.current = rng;
    const { gs, pk } = startHandState(null, rng);
    setAppState({ tag: 'game', gs, pk, trickPause: null });
  }, []);

  // ── Human actions ────────────────────────────────────
  const handleBid = useCallback((bid: number) => {
    setAppState(prev => {
      if (prev.tag !== 'game' || prev.gs.phase !== 'bidding' || prev.gs.turn !== HUMAN) return prev;
      const gs = cloneState(prev.gs);
      applyBid(gs, bid);
      return { ...prev, gs };
    });
  }, []);

  const handlePlay = useCallback((card: Card) => {
    setAppState(prev => {
      if (prev.tag !== 'game' || prev.trickPause !== null) return prev;
      if (prev.gs.phase !== 'playing' || prev.gs.turn !== HUMAN) return prev;
      if (!getLegalMoves(prev.gs).includes(card)) return prev;

      const gs  = cloneState(prev.gs);
      const pk  = clonePk(prev.pk);
      const wasLead          = gs.trick.length === 0;
      const ledBefore        = gs.ledSuit;
      const willFinishTrick  = gs.trick.length === NUM_PLAYERS - 1;
      const trickSnapshot    = willFinishTrick ? gs.trick.map(t => ({ ...t })) : null;

      applyPlay(gs, card);
      observePlay(pk, HUMAN, card, ledBefore, wasLead);

      if (willFinishTrick) {
        return {
          ...prev, gs, pk,
          trickPause: {
            entries: [...trickSnapshot!, { seat: HUMAN, card }] as TrickEntry[],
            winner: gs.turn,
            ledSuit: ledBefore!,
          },
        };
      }
      return { ...prev, gs, pk };
    });
  }, []);

  // ── Continue after hand summary ───────────────────
  const handleContinue = useCallback(() => {
    setAppState(prev => {
      if (prev.tag !== 'hand-summary') return prev;
      const { nextGs, nextPk } = prev;
      return { tag: 'game', gs: nextGs, pk: nextPk, trickPause: null };
    });
  }, []);

  // ── AI effect: drives AI turns + trick-pause ──
  useEffect(() => {
    if (appState.tag !== 'game') return;
    const { gs, pk, trickPause } = appState;

    // 1) Trick pause → clear after delay, then maybe transition to hand summary
    if (trickPause !== null) {
      const id = window.setTimeout(() => {
        setAppState(prev => {
          if (prev.tag !== 'game' || prev.trickPause === null) return prev;
          if (prev.gs.phase === 'handDone') {
            return buildHandSummaryState(prev.gs, prev.pk, rngRef.current!);
          }
          return { ...prev, trickPause: null };
        });
      }, TRICK_PAUSE);
      return () => window.clearTimeout(id);
    }

    // 2) Hand done without trick pause (shouldn't happen normally, safety net)
    if (gs.phase === 'handDone') {
      setAppState(buildHandSummaryState(gs, pk, rngRef.current!));
      return;
    }

    // 3) Human's turn → wait for input
    if (gs.turn === HUMAN) return;

    // 4) AI's turn → schedule move
    const delay = gs.phase === 'bidding' ? AI_BID_DELAY : AI_PLAY_DELAY;
    const id = window.setTimeout(() => {
      setAppState(prev => {
        if (prev.tag !== 'game' || prev.trickPause !== null) return prev;
        if (prev.gs.phase === 'handDone') return prev;
        if (prev.gs.turn === HUMAN) return prev;

        const gs  = cloneState(prev.gs);
        const pk  = clonePk(prev.pk);
        const seat = gs.turn;
        const info = buildInfoSet(gs, pk, seat);

        if (gs.phase === 'bidding') {
          applyBid(gs, AI_AGENTS[seat]!.chooseBid(info));
          return { ...prev, gs, pk };
        }

        // Playing
        const wasLead         = gs.trick.length === 0;
        const ledBefore       = gs.ledSuit;
        const willFinish      = gs.trick.length === NUM_PLAYERS - 1;
        const trickSnapshot   = willFinish ? gs.trick.map(t => ({ ...t })) : null;

        const card = AI_AGENTS[seat]!.chooseCard(info);
        applyPlay(gs, card);
        observePlay(pk, seat, card, ledBefore, wasLead);

        if (willFinish) {
          return {
            ...prev, gs, pk,
            trickPause: {
              entries: [...trickSnapshot!, { seat, card }] as TrickEntry[],
              winner: gs.turn,
              ledSuit: ledBefore!,
            },
          };
        }
        return { ...prev, gs, pk };
      });
    }, delay);

    return () => window.clearTimeout(id);
  }, [appState]);

  // ── Render ────────────────────────────────────────────
  if (appState.tag === 'start') {
    return <StartScreen onStart={startGame} />;
  }

  if (appState.tag === 'game') {
    const { gs, pk, trickPause } = appState;
    return (
      <>
        <GameTable
          gs={gs} pk={pk} trickPause={trickPause}
          onBid={handleBid} onPlay={handlePlay}
        />
      </>
    );
  }

  if (appState.tag === 'hand-summary') {
    const { data, nextGs, nextPk } = appState;
    return (
      <>
        {/* Keep the table visible behind the overlay */}
        <GameTable
          gs={nextGs} pk={nextPk} trickPause={null}
          onBid={() => {}} onPlay={() => {}}
        />
        <HandSummaryOverlay data={data} onContinue={handleContinue} />
      </>
    );
  }

  if (appState.tag === 'game-over') {
    const { scores, placements } = appState;
    return (
      <div style={{ flex: 1, background: 'var(--felt-dark)' }}>
        <GameOverOverlay scores={scores} placements={placements} onNewGame={startGame} />
      </div>
    );
  }

  return null;
}

// ── Build hand-summary state ───────────────────────
function buildHandSummaryState(gs: GameState, pk: PublicKnowledge, rng: Rng): AppState {
  const bids   = gs.bids.map(b => b ?? 0);
  const result = scoreHand(bids, gs.tricksWon, gs.bags);

  const scoresAfter = gs.scores.map((s, i) => s + result.scoreDelta[i]!);
  const data: HandSummaryData = {
    handNumber: gs.handNumber,
    bids,
    tricks:     gs.tricksWon.slice(),
    delta:      result.scoreDelta.slice(),
    scoresAfter,
    bagsAfter:  result.bagsAfter.slice(),
  };

  if (isGameOver(scoresAfter)) {
    return {
      tag: 'game-over',
      scores: scoresAfter,
      placements: placementRewards(scoresAfter),
    };
  }

  // Prepare next hand
  const nextGs = cloneState(gs);
  nextGs.scores = scoresAfter.slice();
  nextGs.bags   = result.bagsAfter.slice();
  const { gs: dealtGs, pk: dealtPk } = startHandState(nextGs, rng);

  return { tag: 'hand-summary', data, nextGs: dealtGs, nextPk: dealtPk };
}
