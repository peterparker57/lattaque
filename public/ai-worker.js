// ============================================================
// STRATEGO AI - Web Worker
// Minimax with Alpha-Beta Pruning, Iterative Deepening
// ============================================================

const RED = 0, BLUE = 1;
const ROWS = 10, COLS = 10;

const RANK = {
  MARSHAL: 1, GENERAL: 2, COLONEL: 3, MAJOR: 4, CAPTAIN: 5,
  LIEUTENANT: 6, SERGEANT: 7, MINER: 8, SCOUT: 9,
  SPY: 10, BOMB: 11, FLAG: 12, UNKNOWN: 13
};

const WATER_SET = new Set();
[[4,2],[4,3],[5,2],[5,3],[4,6],[4,7],[5,6],[5,7]].forEach(([r,c]) => WATER_SET.add(r*10+c));
const isWater = (r, c) => WATER_SET.has(r * 10 + c);

// --- Piece Values for Evaluation ---
// Based on Java source: power-of-2 scaling from Marshal down
// Marshal=6400, General=3200, Colonel=1600, Major=800, Captain=400, etc.
const BASE_VALUES = {
  [RANK.MARSHAL]: 6400,
  [RANK.GENERAL]: 3200,
  [RANK.COLONEL]: 1600,
  [RANK.MAJOR]: 800,
  [RANK.CAPTAIN]: 400,
  [RANK.LIEUTENANT]: 200,
  [RANK.SERGEANT]: 120,
  [RANK.MINER]: 250,     // Miners boosted: 5/4 of Lieutenant (defuse bombs!)
  [RANK.SCOUT]: 80,
  [RANK.SPY]: 60,         // Low base but high strategic value vs Marshal
  [RANK.BOMB]: 150,
  [RANK.FLAG]: 20000,     // Must not lose
  [RANK.UNKNOWN]: 200,    // Average unknown value
};

// Stealth bonus: unknown pieces have hidden strategic value
const STEALTH_VALUES = {
  [RANK.MARSHAL]: 400,
  [RANK.GENERAL]: 300,
  [RANK.COLONEL]: 200,
  [RANK.MAJOR]: 150,
  [RANK.CAPTAIN]: 100,
  [RANK.LIEUTENANT]: 60,
  [RANK.SERGEANT]: 40,
  [RANK.MINER]: 80,
  [RANK.SCOUT]: 20,
  [RANK.SPY]: 200,        // Unknown spy is very dangerous
  [RANK.BOMB]: 50,
  [RANK.FLAG]: 500,       // Unknown flag location is critical
};

function pieceValue(piece) {
  const base = BASE_VALUES[piece.rank] || 200;
  const stealth = (!piece.known && piece.rank !== RANK.UNKNOWN) ? (STEALTH_VALUES[piece.rank] || 0) : 0;
  return base + stealth;
}

// Positional evaluation
function positionalBonus(r, c, color, rank) {
  let bonus = 0;

  // Forward advancement (move toward opponent territory)
  const advance = color === RED ? r : (9 - r);
  if (rank !== RANK.FLAG && rank !== RANK.BOMB) {
    bonus += advance * 4;
  }

  // Center control
  const centerDist = Math.abs(c - 4.5) + Math.abs(r - 4.5);
  bonus += Math.max(0, 8 - centerDist) * 2;

  // Flag/bombs prefer back row
  if (rank === RANK.FLAG || rank === RANK.BOMB) {
    bonus = 0;
    const backRow = color === RED ? 0 : 9;
    bonus += (color === RED ? (3 - r) : (r - 6)) * 15;
    if (bonus < 0) bonus = 0;
  }

  // Scouts get extra forward bonus
  if (rank === RANK.SCOUT) bonus += advance * 3;

  // Spy wants to be near opponent Marshal area but not exposed
  if (rank === RANK.SPY) {
    if (advance >= 4 && advance <= 7) bonus += 20;
  }

  // Miners get bonus for advancing (need to reach bombs)
  if (rank === RANK.MINER) bonus += advance * 3;

  return bonus;
}

// --- AI Board (lightweight copy for search) ---
class AIBoard {
  constructor() {
    this.grid = new Array(100).fill(null); // flat array [r*10+c]
    this.capturedRed = [];
    this.capturedBlue = [];
    this.moveStack = []; // for undo during search
  }

  static fromGame(boardData) {
    const b = new AIBoard();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = boardData.grid[r][c];
        if (p) {
          b.grid[r * 10 + c] = {
            color: p.color,
            rank: p.rank,
            known: p.known,
            moved: p.moved,
            id: p.id
          };
        }
      }
    }
    b.capturedRed = boardData.capturedRed.map(p => ({ ...p }));
    b.capturedBlue = boardData.capturedBlue.map(p => ({ ...p }));
    return b;
  }

  get(r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return undefined;
    return this.grid[r * 10 + c];
  }

  set(r, c, piece) {
    this.grid[r * 10 + c] = piece;
  }

  // Generate all legal moves for a color
  generateMoves(color) {
    const moves = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.get(r, c);
        if (!p || p.color !== color) continue;
        if (p.rank === RANK.BOMB || p.rank === RANK.FLAG) continue;

        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

        if (p.rank === RANK.SCOUT) {
          for (const [dr, dc] of dirs) {
            let nr = r + dr, nc = c + dc;
            while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !isWater(nr, nc)) {
              const target = this.get(nr, nc);
              if (target) {
                if (target.color !== color) {
                  moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, isAttack: true });
                }
                break;
              }
              moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, isAttack: false });
              nr += dr;
              nc += dc;
            }
          }
        } else {
          for (const [dr, dc] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            if (isWater(nr, nc)) continue;
            const target = this.get(nr, nc);
            if (!target) {
              moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, isAttack: false });
            } else if (target.color !== color) {
              moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, isAttack: true });
            }
          }
        }
      }
    }
    return moves;
  }

  // Execute move and push undo info onto stack
  makeMove(move) {
    const { fromR, fromC, toR, toC } = move;
    const attacker = this.get(fromR, fromC);
    const defender = this.get(toR, toC);

    const undo = {
      fromR, fromC, toR, toC,
      attacker: attacker ? { ...attacker } : null,
      defender: defender ? { ...defender } : null,
    };

    if (defender) {
      // Combat
      const result = winFight(attacker, defender);
      undo.result = result;

      if (result === 1) {
        this.set(fromR, fromC, null);
        this.set(toR, toC, { ...attacker, known: true, moved: true });
        this.capture(defender);
      } else if (result === 0) {
        this.set(fromR, fromC, null);
        this.capture(attacker);
      } else {
        this.set(fromR, fromC, null);
        this.set(toR, toC, null);
        this.capture(attacker);
        this.capture(defender);
      }
    } else {
      this.set(fromR, fromC, null);
      this.set(toR, toC, { ...attacker, moved: true });
    }

    this.moveStack.push(undo);
    return undo;
  }

  // Undo last move
  unmakeMove() {
    const undo = this.moveStack.pop();
    if (!undo) return;

    // Restore positions
    this.set(undo.fromR, undo.fromC, undo.attacker);
    this.set(undo.toR, undo.toC, undo.defender);

    // Remove from captured lists
    if (undo.defender && undo.result !== undefined) {
      if (undo.result === 1 || undo.result === -1) {
        this.uncapture(undo.defender);
      }
      if (undo.result === 0 || undo.result === -1) {
        this.uncapture(undo.attacker);
      }
    }
  }

  capture(piece) {
    if (piece.color === RED) this.capturedRed.push({ ...piece });
    else this.capturedBlue.push({ ...piece });
  }

  uncapture(piece) {
    const arr = piece.color === RED ? this.capturedRed : this.capturedBlue;
    const idx = arr.findIndex(p => p.id === piece.id);
    if (idx >= 0) arr.splice(idx, 1);
  }

  // Check if game is over
  isGameOver() {
    if (this.capturedRed.some(p => p.rank === RANK.FLAG)) return BLUE;
    if (this.capturedBlue.some(p => p.rank === RANK.FLAG)) return RED;
    return -1;
  }

  // Evaluate board position from perspective of 'color'
  evaluate(color) {
    const winner = this.isGameOver();
    if (winner === color) return 99999;
    if (winner === (1 - color)) return -99999;

    let score = 0;
    let myPieceCount = 0, oppPieceCount = 0;
    let myMovable = 0, oppMovable = 0;
    let flagR = -1, flagC = -1;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.get(r, c);
        if (!p) continue;
        if (isWater(r, c)) continue;

        const value = pieceValue(p);
        const posBonus = positionalBonus(r, c, p.color, p.rank);

        if (p.color === color) {
          myPieceCount++;
          score += value + posBonus;

          if (p.rank !== RANK.BOMB && p.rank !== RANK.FLAG) myMovable++;

          // Track own flag position
          if (p.rank === RANK.FLAG) { flagR = r; flagC = c; }

          // Bonus for adjacent friendly pieces (mutual protection)
          let friendlyNeighbors = 0;
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
              const adj = this.get(nr, nc);
              if (adj && adj.color === color) friendlyNeighbors++;
            }
          }

          // Flag protection is critical
          if (p.rank === RANK.FLAG) {
            score += friendlyNeighbors * 80;
            // Penalty if flag is exposed (on front lines)
            const advance = color === RED ? r : (9 - r);
            if (advance > 3) score -= advance * 100;
          }
        } else {
          oppPieceCount++;
          score -= value + posBonus;

          if (p.rank !== RANK.BOMB && p.rank !== RANK.FLAG) oppMovable++;

          // Intelligence bonus: knowing opponent pieces is valuable
          if (p.known) score += 30;

          // Threat assessment: known strong pieces near our territory
          if (p.known && p.rank <= RANK.CAPTAIN) {
            const advance = color === RED ? (9 - r) : r; // how deep into our territory
            if (advance <= 3) score -= (4 - advance) * 20;
          }
        }
      }
    }

    // Material advantage amplification (winning side benefits from trades)
    const materialDiff = myPieceCount - oppPieceCount;
    if (materialDiff > 0) score += materialDiff * 50;

    // Mobility matters more in endgame
    if (myPieceCount + oppPieceCount < 20) {
      score += (myMovable - oppMovable) * 15;
    }

    // Miner survival bonus (need miners to defuse bombs protecting flag)
    const myMiners = this.countPiece(color, RANK.MINER);
    const oppBombs = this.countPiece(1 - color, RANK.BOMB);
    if (myMiners === 0 && oppBombs > 0) {
      score -= 500; // No miners left but opponent has bombs = bad
    }

    // Spy survival bonus (only way to kill Marshal)
    const mySpy = this.countPiece(color, RANK.SPY);
    const oppMarshal = this.countPiece(1 - color, RANK.MARSHAL);
    if (mySpy > 0 && oppMarshal > 0) {
      score += 200; // Having spy while opponent Marshal lives = advantage
    }

    return score;
  }

  countPiece(color, rank) {
    let count = 0;
    for (let i = 0; i < 100; i++) {
      const p = this.grid[i];
      if (p && p.color === color && p.rank === rank) count++;
    }
    return count;
  }
}

// Combat resolution (same as main game)
function winFight(attacker, defender) {
  if (defender.rank === RANK.FLAG) return 1;
  if (attacker.rank === defender.rank) return -1;
  if (defender.rank === RANK.BOMB) {
    return attacker.rank === RANK.MINER ? 1 : 0;
  }
  if (attacker.rank === RANK.SPY && defender.rank === RANK.MARSHAL) return 1;
  return attacker.rank < defender.rank ? 1 : 0;
}

// --- Move Ordering ---
function scoreMove(board, move, aiColor) {
  let score = 0;
  const attacker = board.get(move.fromR, move.fromC);

  if (move.isAttack) {
    const defender = board.get(move.toR, move.toC);
    const attackerVal = BASE_VALUES[attacker.rank] || 200;
    const defenderVal = BASE_VALUES[defender.rank] || 200;

    // Flag capture = instant max priority
    if (defender.known && defender.rank === RANK.FLAG) return 100000;

    if (defender.known) {
      const result = winFight(attacker, defender);
      if (result === 1) {
        // Winning attack: MVV-LVA (Most Valuable Victim - Least Valuable Attacker)
        score = 20000 + defenderVal - attackerVal / 10;
      } else if (result === -1) {
        // Trade: favorable if trading up
        score = 5000 + defenderVal - attackerVal;
      } else {
        // Losing attack: only consider if very low value attacker
        score = -10000 + attackerVal;
      }
    } else {
      // Unknown defender: risk assessment
      if (attacker.rank >= RANK.SERGEANT) {
        // Expendable pieces probe unknowns
        score = 4000 + (attacker.rank * 100); // Higher rank = more expendable
      } else if (attacker.rank === RANK.MINER) {
        // Miners attack unmoved pieces (likely bombs)
        score = defender.moved ? 3000 : 6000;
      } else if (attacker.rank === RANK.SPY) {
        // Spy only attacks if target might be Marshal
        score = defender.moved ? 2000 : 500;
      } else {
        // Valuable piece attacking unknown = risky
        score = 1000 - attackerVal / 10;
      }
    }
  } else {
    // Non-attack: forward movement and center control
    const forwardDelta = attacker.color === RED
      ? (move.toR - move.fromR)
      : (move.fromR - move.toR);
    score += forwardDelta * 15;

    // Center control bonus
    const fromCenter = Math.abs(move.fromC - 4.5) + Math.abs(move.fromR - 4.5);
    const toCenter = Math.abs(move.toC - 4.5) + Math.abs(move.toR - 4.5);
    score += (fromCenter - toCenter) * 5;

    // Unmoved pieces should explore
    if (!attacker.moved) score += 10;
  }

  return score;
}

function orderMoves(board, moves, aiColor, killerMove) {
  const scored = moves.map(m => ({
    ...m,
    score: scoreMove(board, m, aiColor) +
      (killerMove && m.fromR === killerMove.fromR && m.fromC === killerMove.fromC &&
       m.toR === killerMove.toR && m.toC === killerMove.toC ? 5000 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// --- Simple Transposition Table ---
const TT_SIZE = 1 << 16; // 65536 entries
const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
let ttable = new Array(TT_SIZE);

function boardHash(board) {
  // Simple hash based on piece positions
  let h = 0;
  for (let i = 0; i < 100; i++) {
    const p = board.grid[i];
    if (p) {
      h = (h * 31 + (p.color * 15 + p.rank) * (i + 1)) | 0;
    }
  }
  return h >>> 0; // unsigned
}

// --- Negamax with Alpha-Beta Pruning + TT ---
let nodesSearched = 0;
let stopTime = 0;
let searchAborted = false;

function negamax(board, depth, alpha, beta, color, killerMoves) {
  nodesSearched++;

  // Time check every 4096 nodes
  if ((nodesSearched & 4095) === 0) {
    if (performance.now() >= stopTime) {
      searchAborted = true;
      return 0;
    }
  }

  // Terminal check
  const winner = board.isGameOver();
  if (winner === color) return 99999 + depth;
  if (winner === (1 - color)) return -(99999 + depth);

  // Leaf node - quiescence check
  if (depth === 0) {
    return quiesce(board, alpha, beta, color, 3);
  }

  // TT lookup
  const hash = boardHash(board);
  const ttIdx = hash % TT_SIZE;
  const ttEntry = ttable[ttIdx];
  let ttMove = null;

  if (ttEntry && ttEntry.hash === hash && ttEntry.depth >= depth) {
    if (ttEntry.flag === TT_EXACT) return ttEntry.value;
    if (ttEntry.flag === TT_LOWER) alpha = Math.max(alpha, ttEntry.value);
    if (ttEntry.flag === TT_UPPER) beta = Math.min(beta, ttEntry.value);
    if (alpha >= beta) return ttEntry.value;
  }
  if (ttEntry && ttEntry.hash === hash && ttEntry.bestMove) {
    ttMove = ttEntry.bestMove;
  }

  const moves = board.generateMoves(color);
  if (moves.length === 0) return -(99999 + depth);

  // Order moves (TT move first, then killer, then scored)
  const killer = killerMoves[depth] || null;
  const orderedMoves = orderMoves(board, moves, color, killer);

  // Put TT move first if found
  if (ttMove) {
    const ttIdx2 = orderedMoves.findIndex(m =>
      m.fromR === ttMove.fromR && m.fromC === ttMove.fromC &&
      m.toR === ttMove.toR && m.toC === ttMove.toC);
    if (ttIdx2 > 0) {
      const [m] = orderedMoves.splice(ttIdx2, 1);
      orderedMoves.unshift(m);
    }
  }

  let bestValue = -Infinity;
  let bestMove = null;
  const origAlpha = alpha;

  for (const move of orderedMoves) {
    board.makeMove(move);
    const value = -negamax(board, depth - 1, -beta, -alpha, 1 - color, killerMoves);
    board.unmakeMove();

    if (searchAborted) return 0;

    if (value > bestValue) {
      bestValue = value;
      bestMove = move;
    }

    alpha = Math.max(alpha, value);
    if (alpha >= beta) {
      if (!move.isAttack) killerMoves[depth] = move;
      break;
    }
  }

  // Store in TT
  if (!searchAborted) {
    let flag = TT_EXACT;
    if (bestValue <= origAlpha) flag = TT_UPPER;
    else if (bestValue >= beta) flag = TT_LOWER;

    ttable[ttIdx] = {
      hash, depth, value: bestValue, flag,
      bestMove: bestMove ? { fromR: bestMove.fromR, fromC: bestMove.fromC, toR: bestMove.toR, toC: bestMove.toC } : null
    };
  }

  return bestValue;
}

// Quiescence search - only look at captures to avoid horizon effect
function quiesce(board, alpha, beta, color, depth) {
  const standPat = board.evaluate(color);
  if (depth === 0) return standPat;
  if (standPat >= beta) return beta;
  if (standPat > alpha) alpha = standPat;

  // Generate only attack moves
  const moves = board.generateMoves(color).filter(m => m.isAttack);
  if (moves.length === 0) return standPat;

  const orderedMoves = orderMoves(board, moves, color, null);

  for (const move of orderedMoves) {
    // Skip obviously bad captures (known losing attacks on low-value pieces)
    if (move.score < -5000) continue;

    board.makeMove(move);
    const value = -quiesce(board, -beta, -alpha, 1 - color, depth - 1);
    board.unmakeMove();

    if (searchAborted) return 0;

    if (value >= beta) return beta;
    if (value > alpha) alpha = value;
  }

  return alpha;
}

// --- Iterative Deepening ---
function findBestMove(board, color, timeLimitMs) {
  const startTime = performance.now();
  stopTime = startTime + timeLimitMs;
  searchAborted = false;
  nodesSearched = 0;
  ttable = new Array(TT_SIZE); // Clear TT each move for correctness

  const moves = board.generateMoves(color);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0]; // Only one legal move

  let bestMove = moves[0]; // Fallback
  let bestValue = -Infinity;
  let completedDepth = 0;

  const killerMoves = {};

  // Iterative deepening from depth 1 to max
  for (let depth = 1; depth <= 30; depth++) {
    const orderedMoves = orderMoves(board, moves, color, null);
    let currentBest = null;
    let currentBestValue = -Infinity;

    for (const move of orderedMoves) {
      board.makeMove(move);
      const value = -negamax(board, depth - 1, -Infinity, -currentBestValue, 1 - color, killerMoves);
      board.unmakeMove();

      if (searchAborted) break;

      if (value > currentBestValue) {
        currentBestValue = value;
        currentBest = move;
      }
    }

    if (searchAborted) break;

    // Completed this depth
    bestMove = currentBest || bestMove;
    bestValue = currentBestValue;
    completedDepth = depth;

    // If we found a winning move, stop searching
    if (bestValue > 90000) break;

    // If we've used more than half the time, don't start a new depth
    if (performance.now() - startTime > timeLimitMs * 0.6) break;
  }

  return {
    move: bestMove,
    value: bestValue,
    depth: completedDepth,
    nodes: nodesSearched,
    timeMs: Math.round(performance.now() - startTime)
  };
}

// --- Worker Message Handler ---
self.onmessage = function(e) {
  const { type, boardData, color, timeLimitMs } = e.data;

  if (type === 'findMove') {
    const board = AIBoard.fromGame(boardData);
    const result = findBestMove(board, color, timeLimitMs);

    if (result && result.move) {
      self.postMessage({
        type: 'moveFound',
        move: {
          fromR: result.move.fromR,
          fromC: result.move.fromC,
          toR: result.move.toR,
          toC: result.move.toC
        },
        stats: {
          depth: result.depth,
          nodes: result.nodes,
          timeMs: result.timeMs,
          value: result.value
        }
      });
    } else {
      self.postMessage({ type: 'noMove' });
    }
  }
};
