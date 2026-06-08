/// <reference types="vite-plugin-pwa/react" />
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
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

// ── Constants ───────────────────────────────
const HUMAN = 0;
const SEAT_NAMES = ['You', 'East', 'North', 'West'];
const AI_BID_DELAY  = 380;
const AI_PLAY_DELAY = 460;
const TRICK_PAUSE   = 900;

// ── Types ────────────────────────────────────
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

// ── Helpers ──────────────────────────────────
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

const AI_AGENTS: (SearchAgent | null)[] = [
  null,
  new SearchAgent(),
  new SearchAgent(),
  new SearchAgent(),
];

// ── Suit display order: ♠ ♥ ♦ ♣ (spades first = trump first) ──
const SUIT_ORDER = [3, 2, 1, 0] as const;

// ════════════════════════════════════════════
//  TRICK CARD  (used inside trick area)
// ════════════════════════════════════════════
function TrickCard({ card, winner }: { card: Card; winner: boolean }) {
  const suit  = suitOf(card);
  const rank  = RANK_LABELS[rankIxOf(card)]!;
  const glyph = SUIT_GLYPHS[suit]!;
  const isRed = suit === 1 || suit === 2;
  return (
    <div className={`tcard${isRed ? ' tcard--red' : ''}${winner ? ' tcard--win' : ''}`}>
      <span className="tcard__rank">{rank}</span>
      <span className="tcard__suit">{glyph}</span>
    </div>
  );
}

// ════════════════════════════════════════════
//  PLAYER BADGE
// ════════════════════════════════════════════
function Badge({ seat, gs, isActive }: { seat: number; gs: GameState; isActive: boolean }) {
  const bid    = gs.bids[seat];
  const tricks = gs.tricksWon[seat]!;
  const score  = gs.scores[seat]!;
  const bidStr = bid === null ? '?' : bid === 0 ? 'NIL' : String(bid);
  const isHuman = seat === HUMAN;

  return (
    <div className={[
      'badge',
      isActive ? 'badge--active' : '',
      isHuman ? 'badge--you' : '',
    ].filter(Boolean).join(' ')}>
      <div className="badge__score">{score}</div>
      <div className="badge__bid-row">bid {bidStr}</div>
      <div className="badge__won-row">took {tricks}</div>
    </div>
  );
}

// ════════════════════════════════════════════
//  TRICK AREA
// ════════════════════════════════════════════
function TrickArea({ gs, trickPause, isHumanPlay }: {
  gs: GameState;
  trickPause: TrickPause | null;
  isHumanPlay: boolean;
}) {
  const displayEntries = trickPause ? trickPause.entries : gs.trick;
  const winner = trickPause?.winner ?? null;

  return (
    <div className="trick-area">
      <div className="trick-inner">
        {[0, 1, 2, 3].map(seat => {
          const entry = displayEntries.find(e => e.seat === seat);
          const prompt = !entry && seat === HUMAN && isHumanPlay;
          return (
            <div key={seat} className={`trick-slot trick-slot--${seat}`}>
              {entry
                ? <TrickCard card={entry.card} winner={winner === seat && trickPause !== null} />
                : <div className={prompt ? 'tcard--prompt' : 'tcard--empty'} />
              }
            </div>
          );
        })}
        <div className="trick-meta">
          {gs.completedTricks}/13
          {gs.spadesBroken && <><br />♠ led</>}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  STATUS TEXT
// ════════════════════════════════════════════
function StatusText({ gs, trickPause, isHandDone }: {
  gs: GameState;
  trickPause: TrickPause | null;
  isHandDone: boolean;
}) {
  if (isHandDone) return <span>Hand complete</span>;
  if (trickPause) return <span>{SEAT_NAMES[trickPause.winner]} takes the trick</span>;
  const turn = gs.turn;
  if (gs.phase === 'bidding') {
    if (turn === HUMAN) return <span>Choose your bid</span>;
    return <span>{SEAT_NAMES[turn]} is bidding <ThinkingDots /></span>;
  }
  if (gs.phase === 'playing') {
    if (turn === HUMAN) return <span>Your turn</span>;
    return <span>{SEAT_NAMES[turn]} is playing <ThinkingDots /></span>;
  }
  return null;
}

function ThinkingDots() {
  return (
    <span className="thinking-dots">
      <span /><span /><span />
    </span>
  );
}

// ════════════════════════════════════════════
//  BID SELECTOR
// ════════════════════════════════════════════
function BidSelector({ onBid }: { onBid: (bid: number) => void }) {
  return (
    <div className="bid-panel">
      <div className="bid-label">CHOOSE YOUR BID</div>
      <div className="bid-grid">
        {Array.from({ length: 14 }, (_, i) => (
          <button
            key={i}
            className={`bid-btn${i === 0 ? ' bid-btn--nil' : ''}`}
            onClick={() => onBid(i)}
          >
            {i === 0 ? 'NIL' : i}
          </button>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  HAND  (suit rows — no fan, no ResizeObserver)
// ════════════════════════════════════════════
function Hand({ cards, isPlay, isBid, legal, onPlay }: {
  cards: Card[];
  isPlay: boolean;
  isBid: boolean;
  legal: Set<Card>;
  onPlay: (card: Card) => void;
}) {
  return (
    <div className={`hand-area${isBid ? ' hand-area--bid' : ''}`}>
      {SUIT_ORDER.map(suit => {
        const suitCards = cards
          .filter(c => suitOf(c) === suit)
          .sort((a, b) => rankIxOf(b) - rankIxOf(a));
        if (suitCards.length === 0) return null;
        const isRed = suit === 1 || suit === 2;
        return (
          <div key={suit} className="suit-row">
            <span className={`suit-label${isRed ? ' suit-label--red' : ''}`}>
              {SUIT_GLYPHS[suit]}
            </span>
            {suitCards.map(card => {
              const isLegal   = isPlay && legal.has(card);
              const isIllegal = isPlay && !legal.has(card);
              return (
                <button
                  key={card}
                  className={[
                    'chip',
                    isRed ? 'chip--red' : '',
                    isLegal ? 'chip--play' : '',
                    isIllegal ? 'chip--dim' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={isLegal ? () => onPlay(card) : undefined}
                  tabIndex={isLegal ? 0 : -1}
                  aria-label={`${RANK_LABELS[rankIxOf(card)]} of ${['clubs','diamonds','hearts','spades'][suit]}`}
                >
                  {RANK_LABELS[rankIxOf(card)]}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════
//  HAND SUMMARY OVERLAY
// ════════════════════════════════════════════
function HandSummaryOverlay({ data, onContinue }: { data: HandSummaryData; onContinue: () => void }) {
  return (
    <div className="overlay">
      <div className="overlay-panel">
        <h2>Hand {data.handNumber + 1}</h2>
        <table className="score-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="col-num">Bid</th>
              <th className="col-num">Took</th>
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
          <button className="btn btn--primary" onClick={onContinue}>Continue</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  GAME OVER OVERLAY
// ════════════════════════════════════════════
function GameOverOverlay({ scores, placements, onNewGame }: {
  scores: number[];
  placements: number[];
  onNewGame: () => void;
}) {
  const order  = [0, 1, 2, 3].slice().sort((a, b) => scores[b]! - scores[a]!);
  const medals = ['🥇', '🥈', '🥉', '4️⃣'];
  const place  = placements[HUMAN]!;

  return (
    <div className="overlay">
      <div className="overlay-panel">
        <h2>Game Over</h2>
        <div className="podium">
          {order.map((seat, rank) => (
            <div key={seat} className={[
              'podium__row',
              rank === 0 ? 'podium__row--1st' : '',
              seat === HUMAN ? 'podium__row--you' : '',
            ].filter(Boolean).join(' ')}>
              <span className="podium__rank">{medals[rank]}</span>
              <span className="podium__name">{SEAT_NAMES[seat]}</span>
              <span className="podium__score">{scores[seat]}</span>
            </div>
          ))}
        </div>
        <p style={{ textAlign: 'center', marginBottom: 16, fontSize: 14,
          color: place === 2 ? '#6adb6a' : place === 0 ? 'var(--text-dim)' : 'var(--gold)' }}>
          {place === 2 ? 'You won!' : place === 0 ? 'Better luck next time.' : 'Well played!'}
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button className="btn btn--primary" onClick={onNewGame}>Play Again</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  RULES OVERLAY
// ════════════════════════════════════════════
function RulesOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-panel" onClick={e => e.stopPropagation()}>
        <h2>How to Play</h2>
        <ul className="rules-list">
          <li>Each player bids how many tricks they'll take.</li>
          <li>Make your bid exactly — extra tricks are bags.</li>
          <li>Every 3 bags costs you 30 points.</li>
          <li>Bid NIL to score +50 by taking zero tricks.</li>
          <li>Spades are always trump and can't lead until broken.</li>
          <li>Highest card of the led suit wins unless trumped.</li>
          <li>First to 40 points wins.</li>
        </ul>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
          <button className="btn btn--primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  GAME TABLE
// ════════════════════════════════════════════
function GameTable({ gs, pk, trickPause, onBid, onPlay, onRestart }: {
  gs: GameState;
  pk: PublicKnowledge;
  trickPause: TrickPause | null;
  onBid: (bid: number) => void;
  onPlay: (card: Card) => void;
  onRestart: () => void;
}) {
  const [showRules, setShowRules] = useState(false);
  const isHumanBid  = gs.phase === 'bidding' && gs.turn === HUMAN && !trickPause;
  const isHumanPlay = gs.phase === 'playing' && gs.turn === HUMAN && !trickPause;
  const legal       = isHumanPlay ? new Set(getLegalMoves(gs)) : new Set<Card>();
  const isHandDone  = gs.phase === 'handDone';

  return (
    <div className="table">
      {showRules && <RulesOverlay onClose={() => setShowRules(false)} />}
      <div className="table__header">
        <span className="hdr__title">♠ Solo Spades</span>
        <span className="hdr__hand">Hand {gs.handNumber + 1} · First to 40</span>
        <div className="hdr__right">
          <span className="hdr__score">You: {gs.scores[HUMAN]}</span>
          <button className="hdr__restart-btn" onClick={() => setShowRules(true)} aria-label="Rules">?</button>
          <button className="hdr__restart-btn" onClick={onRestart} aria-label="New game">↺</button>
        </div>
      </div>

      <div className="table__body">
        <div className="felt">
          <div className="seat seat--north">
            <Badge seat={2} gs={gs} isActive={gs.turn === 2 && !trickPause} />
          </div>
          <div className="seat seat--west">
            <Badge seat={3} gs={gs} isActive={gs.turn === 3 && !trickPause} />
          </div>
          <div className="seat seat--east">
            <Badge seat={1} gs={gs} isActive={gs.turn === 1 && !trickPause} />
          </div>
          <TrickArea gs={gs} trickPause={trickPause} isHumanPlay={isHumanPlay} />
          <div className="seat seat--south">
            <Badge seat={HUMAN} gs={gs} isActive={isHumanBid || isHumanPlay} />
          </div>
        </div>

        <div className="panel">
          <div className="status-bar">
            <StatusText gs={gs} trickPause={trickPause} isHandDone={isHandDone} />
          </div>
          {isHumanBid && <BidSelector onBid={onBid} />}
          <Hand
            cards={gs.hands[HUMAN]!}
            isPlay={isHumanPlay}
            isBid={isHumanBid}
            legal={legal}
            onPlay={onPlay}
          />
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  ROOT APP
// ════════════════════════════════════════════
export default function App() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  const rngRef = useRef<Rng | null>(null);
  const [appState, setAppState] = useState<AppState>(() => {
    const rng = new Rng((Date.now() ^ Math.random() * 0xffffffff) >>> 0);
    rngRef.current = rng;
    const { gs, pk } = startHandState(null, rng);
    return { tag: 'game', gs, pk, trickPause: null };
  });

  const startGame = useCallback(() => {
    const rng = new Rng((Date.now() ^ Math.random() * 0xffffffff) >>> 0);
    rngRef.current = rng;
    const { gs, pk } = startHandState(null, rng);
    setAppState({ tag: 'game', gs, pk, trickPause: null });
  }, []);

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
      const wasLead         = gs.trick.length === 0;
      const ledBefore       = gs.ledSuit;
      const willFinish      = gs.trick.length === NUM_PLAYERS - 1;
      const trickSnapshot   = willFinish ? gs.trick.map(t => ({ ...t })) : null;

      applyPlay(gs, card);
      observePlay(pk, HUMAN, card, ledBefore, wasLead);

      if (willFinish) {
        return {
          ...prev, gs, pk,
          trickPause: {
            entries: [...trickSnapshot!, { seat: HUMAN, card }] as TrickEntry[],
            winner:  gs.turn,
            ledSuit: ledBefore!,
          },
        };
      }
      return { ...prev, gs, pk };
    });
  }, []);

  const handleContinue = useCallback(() => {
    setAppState(prev => {
      if (prev.tag !== 'hand-summary') return prev;
      return { tag: 'game', gs: prev.nextGs, pk: prev.nextPk, trickPause: null };
    });
  }, []);

  // AI + trick-pause driver
  useEffect(() => {
    if (appState.tag !== 'game') return;
    const { gs, pk, trickPause } = appState;

    if (trickPause !== null) {
      const id = window.setTimeout(() => {
        setAppState(prev => {
          if (prev.tag !== 'game' || prev.trickPause === null) return prev;
          if (prev.gs.phase === 'handDone') return buildHandSummaryState(prev.gs, prev.pk, rngRef.current!);
          return { ...prev, trickPause: null };
        });
      }, TRICK_PAUSE);
      return () => window.clearTimeout(id);
    }

    if (gs.phase === 'handDone') {
      setAppState(buildHandSummaryState(gs, pk, rngRef.current!));
      return;
    }

    if (gs.turn === HUMAN) return;

    const delay = gs.phase === 'bidding' ? AI_BID_DELAY : AI_PLAY_DELAY;
    const id = window.setTimeout(() => {
      setAppState(prev => {
        if (prev.tag !== 'game' || prev.trickPause !== null) return prev;
        if (prev.gs.phase === 'handDone' || prev.gs.turn === HUMAN) return prev;

        const gs   = cloneState(prev.gs);
        const pk   = clonePk(prev.pk);
        const seat = gs.turn;
        const info = buildInfoSet(gs, pk, seat);

        if (gs.phase === 'bidding') {
          applyBid(gs, AI_AGENTS[seat]!.chooseBid(info));
          return { ...prev, gs, pk };
        }

        const wasLead       = gs.trick.length === 0;
        const ledBefore     = gs.ledSuit;
        const willFinish    = gs.trick.length === NUM_PLAYERS - 1;
        const trickSnapshot = willFinish ? gs.trick.map(t => ({ ...t })) : null;

        const card = AI_AGENTS[seat]!.chooseCard(info);
        applyPlay(gs, card);
        observePlay(pk, seat, card, ledBefore, wasLead);

        if (willFinish) {
          return {
            ...prev, gs, pk,
            trickPause: {
              entries: [...trickSnapshot!, { seat, card }] as TrickEntry[],
              winner:  gs.turn,
              ledSuit: ledBefore!,
            },
          };
        }
        return { ...prev, gs, pk };
      });
    }, delay);

    return () => window.clearTimeout(id);
  }, [appState]);

  // Haptic when it becomes the human's turn
  const prevIsHumanTurnRef = useRef(true);
  useEffect(() => {
    if (appState.tag !== 'game') { prevIsHumanTurnRef.current = false; return; }
    const { gs, trickPause } = appState;
    const isHumanTurn = trickPause === null && gs.turn === HUMAN &&
      (gs.phase === 'bidding' || gs.phase === 'playing');
    if (isHumanTurn && !prevIsHumanTurnRef.current) navigator.vibrate?.(100);
    prevIsHumanTurnRef.current = isHumanTurn;
  }, [appState]);

  // Auto-play when only one legal move available
  useEffect(() => {
    if (appState.tag !== 'game') return;
    const { gs, trickPause } = appState;
    if (trickPause !== null || gs.phase !== 'playing' || gs.turn !== HUMAN) return;
    const moves = getLegalMoves(gs);
    if (moves.length !== 1) return;
    const id = window.setTimeout(() => handlePlay(moves[0]!), 350);
    return () => window.clearTimeout(id);
  }, [appState, handlePlay]);

  // ── Render ──────────────────────────────────────
  const updateBanner = needRefresh ? (
    <div className="update-banner">
      <span>Update available</span>
      <button className="update-banner__btn" onClick={() => updateServiceWorker(true)}>
        Reload
      </button>
    </div>
  ) : null;

  if (appState.tag === 'game') {
    const { gs, pk, trickPause } = appState;
    return (
      <>
        {updateBanner}
        <GameTable gs={gs} pk={pk} trickPause={trickPause} onBid={handleBid} onPlay={handlePlay} onRestart={startGame} />
      </>
    );
  }

  if (appState.tag === 'hand-summary') {
    const { data, nextGs, nextPk } = appState;
    return (
      <>
        {updateBanner}
        <GameTable gs={nextGs} pk={nextPk} trickPause={null} onBid={() => {}} onPlay={() => {}} onRestart={startGame} />
        <HandSummaryOverlay data={data} onContinue={handleContinue} />
      </>
    );
  }

  if (appState.tag === 'game-over') {
    const { scores, placements } = appState;
    return (
      <>
        {updateBanner}
        <div style={{ flex: 1, background: 'var(--bg)' }}>
          <GameOverOverlay scores={scores} placements={placements} onNewGame={startGame} />
        </div>
      </>
    );
  }

  return null;
}

// ── Build hand-summary state ────────────────────────
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
    return { tag: 'game-over', scores: scoresAfter, placements: placementRewards(scoresAfter) };
  }

  const nextGs = cloneState(gs);
  nextGs.scores = scoresAfter.slice();
  nextGs.bags   = result.bagsAfter.slice();
  const { gs: dealtGs, pk: dealtPk } = startHandState(nextGs, rng);
  return { tag: 'hand-summary', data, nextGs: dealtGs, nextPk: dealtPk };
}
