// ============================================================
// STRATEGO / L'Attaque — GAME CORE (shared rules)
// Framework-free: no DOM, no window, no browser APIs. This same module runs
// in the browser UI and in the Cloudflare Worker / GameRoom Durable Object
// (the authoritative server). Ported from braathwaate/stratego (Java).
// ============================================================

// --- Constants ---
const RED = 0, BLUE = 1;
const ROWS = 10, COLS = 10;

const RANK = {
  MARSHAL: 1, GENERAL: 2, COLONEL: 3, MAJOR: 4, CAPTAIN: 5,
  LIEUTENANT: 6, SERGEANT: 7, MINER: 8, SCOUT: 9,
  SPY: 10, BOMB: 11, FLAG: 12, UNKNOWN: 13
};

const RANK_NAMES = {
  [RANK.MARSHAL]: '1', [RANK.GENERAL]: '2', [RANK.COLONEL]: '3',
  [RANK.MAJOR]: '4', [RANK.CAPTAIN]: '5', [RANK.LIEUTENANT]: '6',
  [RANK.SERGEANT]: '7', [RANK.MINER]: '8', [RANK.SCOUT]: '9',
  [RANK.SPY]: 'S', [RANK.BOMB]: 'B', [RANK.FLAG]: 'F',
  [RANK.UNKNOWN]: '?'
};

const RANK_FULL_NAMES = {
  [RANK.MARSHAL]: 'Marshal', [RANK.GENERAL]: 'General', [RANK.COLONEL]: 'Colonel',
  [RANK.MAJOR]: 'Major', [RANK.CAPTAIN]: 'Captain', [RANK.LIEUTENANT]: 'Lieutenant',
  [RANK.SERGEANT]: 'Sergeant', [RANK.MINER]: 'Miner', [RANK.SCOUT]: 'Scout',
  [RANK.SPY]: 'Spy', [RANK.BOMB]: 'Bomb', [RANK.FLAG]: 'Flag'
};

const RANK_ICONS = {
  [RANK.MARSHAL]: '\u2654',     // chess king crown
  [RANK.GENERAL]: '\u2655',     // chess queen
  [RANK.COLONEL]: '\u2656',     // chess rook
  [RANK.MAJOR]: '\u2658',       // chess knight
  [RANK.CAPTAIN]: '\u2657',     // chess bishop
  [RANK.LIEUTENANT]: '\u2694\uFE0F',  // crossed swords
  [RANK.SERGEANT]: '\u{1F6E1}\uFE0F', // shield
  [RANK.MINER]: '\u26CF\uFE0F',       // pick
  [RANK.SCOUT]: '\u{1F441}\uFE0F',    // eye
  [RANK.SPY]: '\u{1F575}\uFE0F',      // detective
  [RANK.BOMB]: '\u{1F4A3}',           // bomb
  [RANK.FLAG]: '\u{1F6A9}',           // flag
};

const HIDDEN_ICON = '\u2753'; // question mark

// Piece counts per rank per side
const PIECE_COUNTS = {
  [RANK.FLAG]: 1, [RANK.SPY]: 1, [RANK.MARSHAL]: 1, [RANK.GENERAL]: 1,
  [RANK.COLONEL]: 2, [RANK.MAJOR]: 3, [RANK.CAPTAIN]: 4,
  [RANK.LIEUTENANT]: 4, [RANK.SERGEANT]: 4, [RANK.MINER]: 5,
  [RANK.SCOUT]: 8, [RANK.BOMB]: 6
};

// Water squares (lakes) - [row, col]
const WATER_SQUARES = [
  [4, 2], [4, 3], [5, 2], [5, 3],
  [4, 6], [4, 7], [5, 6], [5, 7]
];

const isWater = (r, c) => WATER_SQUARES.some(([wr, wc]) => wr === r && wc === c);

// --- Piece Class ---
class Piece {
  constructor(color, rank, id) {
    this.color = color;
    this.rank = rank;
    this.id = id;
    this.known = false;    // revealed through combat
    this.moved = false;    // has this piece ever moved
    this.moveCount = 0;
  }

  clone() {
    const p = new Piece(this.color, this.rank, this.id);
    p.known = this.known;
    p.moved = this.moved;
    p.moveCount = this.moveCount;
    return p;
  }

  isMovable() {
    return this.rank !== RANK.BOMB && this.rank !== RANK.FLAG;
  }

  isScout() {
    return this.rank === RANK.SCOUT;
  }

  displayRank(forPlayer) {
    if (this.color === forPlayer || this.known) return RANK_NAMES[this.rank];
    return '?';
  }

  static winFight(attacker, defender) {
    // Returns: 1 = attacker wins, 0 = defender wins, -1 = both die
    if (defender.rank === RANK.FLAG) return 1;
    if (attacker.rank === defender.rank) return -1;
    if (defender.rank === RANK.BOMB) {
      return attacker.rank === RANK.MINER ? 1 : 0;
    }
    if (attacker.rank === RANK.SPY && defender.rank === RANK.MARSHAL) return 1;
    return attacker.rank < defender.rank ? 1 : 0;
  }
}

// --- Board Class ---
class Board {
  constructor() {
    // grid[row][col] = Piece or null
    this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.capturedRed = [];
    this.capturedBlue = [];
    this.moveHistory = [];
    this.lastMove = null;
  }

  clone() {
    const b = new Board();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        b.grid[r][c] = this.grid[r][c] ? this.grid[r][c].clone() : null;
    b.capturedRed = this.capturedRed.map(p => p.clone());
    b.capturedBlue = this.capturedBlue.map(p => p.clone());
    b.moveHistory = [...this.moveHistory];
    b.lastMove = this.lastMove;
    return b;
  }

  getPiece(r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    return this.grid[r][c];
  }

  setPiece(r, c, piece) {
    this.grid[r][c] = piece;
  }

  removePiece(r, c) {
    const p = this.grid[r][c];
    this.grid[r][c] = null;
    return p;
  }

  // Get all valid moves for a piece at (r,c)
  getValidMoves(r, c) {
    const piece = this.grid[r][c];
    if (!piece || !piece.isMovable()) return [];

    const moves = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    if (piece.isScout()) {
      // Scouts can move any number of squares in a straight line
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS && !isWater(nr, nc)) {
          const target = this.grid[nr][nc];
          if (target) {
            if (target.color !== piece.color) {
              moves.push({ toR: nr, toC: nc, isAttack: true });
            }
            break; // blocked
          }
          moves.push({ toR: nr, toC: nc, isAttack: false });
          nr += dr;
          nc += dc;
        }
      }
    } else {
      // Regular pieces move one square
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
        if (isWater(nr, nc)) continue;
        const target = this.grid[nr][nc];
        if (!target) {
          moves.push({ toR: nr, toC: nc, isAttack: false });
        } else if (target.color !== piece.color) {
          moves.push({ toR: nr, toC: nc, isAttack: true });
        }
      }
    }

    return moves;
  }

  // Execute a move. Returns combat result or null.
  executeMove(fromR, fromC, toR, toC) {
    const attacker = this.grid[fromR][fromC];
    const defender = this.grid[toR][toC];

    attacker.moved = true;
    attacker.moveCount++;

    const moveRecord = {
      fromR, fromC, toR, toC,
      attacker: attacker.clone(),
      defender: defender ? defender.clone() : null,
      result: null
    };

    if (defender) {
      // Combat!
      attacker.known = true;
      defender.known = true;
      const result = Piece.winFight(attacker, defender);
      moveRecord.result = result;

      if (result === 1) {
        // Attacker wins
        this.grid[fromR][fromC] = null;
        this.grid[toR][toC] = attacker;
        this.capture(defender);
      } else if (result === 0) {
        // Defender wins
        this.grid[fromR][fromC] = null;
        this.capture(attacker);
      } else {
        // Both die
        this.grid[fromR][fromC] = null;
        this.grid[toR][toC] = null;
        this.capture(attacker);
        this.capture(defender);
      }
    } else {
      // Simple move
      this.grid[fromR][fromC] = null;
      this.grid[toR][toC] = attacker;
    }

    this.moveHistory.push(moveRecord);
    this.lastMove = { fromR, fromC, toR, toC };
    return moveRecord;
  }

  capture(piece) {
    if (piece.color === RED) this.capturedRed.push(piece);
    else this.capturedBlue.push(piece);
  }

  // Check if a color has lost (flag captured or no moves)
  checkWin() {
    // Check if flag was captured
    for (const p of this.capturedRed) {
      if (p.rank === RANK.FLAG) return BLUE;
    }
    for (const p of this.capturedBlue) {
      if (p.rank === RANK.FLAG) return RED;
    }

    // Check if a side has no movable pieces
    let redCanMove = false, blueCanMove = false;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.grid[r][c];
        if (!p) continue;
        if (p.isMovable() && this.getValidMoves(r, c).length > 0) {
          if (p.color === RED) redCanMove = true;
          else blueCanMove = true;
        }
        if (redCanMove && blueCanMove) return -1;
      }
    }

    if (!redCanMove) return BLUE;
    if (!blueCanMove) return RED;
    return -1;
  }

  // Undo last move (2 half-moves = 1 full turn)
  undoLastTurn() {
    if (this.moveHistory.length < 2) return false;

    for (let i = 0; i < 2; i++) {
      const move = this.moveHistory.pop();
      if (!move) break;

      // Restore attacker to original position
      this.grid[move.fromR][move.fromC] = move.attacker;

      if (move.defender) {
        // Restore defender
        this.grid[move.toR][move.toC] = move.defender;
        // Remove from captured
        if (move.result === 1 || move.result === -1) {
          this.uncapture(move.defender);
        }
        if (move.result === 0 || move.result === -1) {
          this.uncapture(move.attacker);
        }
      } else {
        this.grid[move.toR][move.toC] = null;
      }
    }

    this.lastMove = this.moveHistory.length > 0 ?
      this.moveHistory[this.moveHistory.length - 1] : null;
    return true;
  }

  uncapture(piece) {
    const arr = piece.color === RED ? this.capturedRed : this.capturedBlue;
    const idx = arr.findIndex(p => p.id === piece.id);
    if (idx >= 0) arr.splice(idx, 1);
  }

  // Get all pieces of a color that can move
  getMovablePieces(color) {
    const pieces = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.grid[r][c];
        if (p && p.color === color && p.isMovable()) {
          const moves = this.getValidMoves(r, c);
          if (moves.length > 0) {
            pieces.push({ r, c, piece: p, moves });
          }
        }
      }
    }
    return pieces;
  }
}

// --- Setup Generation ---
function generateSetup(color) {
  const pieces = [];
  let id = color === RED ? 0 : 40;

  for (const [rank, count] of Object.entries(PIECE_COUNTS)) {
    for (let i = 0; i < count; i++) {
      pieces.push(new Piece(color, parseInt(rank), id++));
    }
  }

  // Shuffle
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }

  // Strategic placement improvements
  // Put flag in back row, surrounded by bombs
  const flag = pieces.find(p => p.rank === RANK.FLAG);
  const bombs = pieces.filter(p => p.rank === RANK.BOMB);
  const others = pieces.filter(p => p.rank !== RANK.FLAG && p.rank !== RANK.BOMB);

  const positions = [];
  const startRow = color === RED ? 0 : 6;

  // Place flag in a back corner-ish position
  const flagCol = Math.random() < 0.5 ? Math.floor(Math.random() * 3) : 7 + Math.floor(Math.random() * 3);
  const flagRow = startRow + (color === RED ? 0 : 3);
  positions.push({ piece: flag, r: flagRow, c: flagCol });

  // Place bombs around flag
  const bombPositions = [
    [flagRow, flagCol - 1], [flagRow, flagCol + 1],
    [flagRow - (color === RED ? -1 : 1), flagCol]
  ];

  let bombIdx = 0;
  for (const [br, bc] of bombPositions) {
    if (bombIdx >= bombs.length) break;
    if (bc >= 0 && bc < COLS && br >= startRow && br < startRow + 4) {
      positions.push({ piece: bombs[bombIdx++], r: br, c: bc });
    }
  }

  // Place remaining bombs randomly in back rows
  while (bombIdx < bombs.length) {
    const r = startRow + (color === RED ? 0 : 2) + Math.floor(Math.random() * 2);
    const c = Math.floor(Math.random() * COLS);
    if (!positions.some(p => p.r === r && p.c === c)) {
      positions.push({ piece: bombs[bombIdx++], r, c });
    }
  }

  // Place remaining pieces
  const remaining = [...others];
  // Put strong pieces more toward center/front
  remaining.sort((a, b) => a.rank - b.rank); // strongest first

  for (const piece of remaining) {
    let placed = false;
    // Front row preference for stronger pieces
    const rowOrder = piece.rank <= RANK.CAPTAIN
      ? [startRow + (color === RED ? 3 : 0), startRow + (color === RED ? 2 : 1),
         startRow + (color === RED ? 1 : 2), startRow + (color === RED ? 0 : 3)]
      : [startRow + (color === RED ? 2 : 1), startRow + (color === RED ? 3 : 0),
         startRow + (color === RED ? 1 : 2), startRow + (color === RED ? 0 : 3)];

    for (const row of rowOrder) {
      if (placed) break;
      // Randomize column order
      const cols = Array.from({ length: COLS }, (_, i) => i);
      for (let i = cols.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cols[i], cols[j]] = [cols[j], cols[i]];
      }
      for (const col of cols) {
        if (!positions.some(p => p.r === row && p.c === col)) {
          positions.push({ piece, r: row, c: col });
          placed = true;
          break;
        }
      }
    }
  }

  return positions;
}

// --- Serialization (Durable Object storage + WebSocket transport) ---
// The server stores/loads the FULL board (it knows every rank). Compact keys
// keep the payload small.

function serializePiece(p) {
  if (!p) return null;
  return { c: p.color, r: p.rank, id: p.id, k: p.known ? 1 : 0, m: p.moved ? 1 : 0, mc: p.moveCount };
}
function deserializePiece(o) {
  if (!o) return null;
  const p = new Piece(o.c, o.r, o.id);
  p.known = !!o.k;
  p.moved = !!o.m;
  p.moveCount = o.mc || 0;
  return p;
}
function serializeBoard(board) {
  return {
    grid: board.grid.map((row) => row.map(serializePiece)),
    capturedRed: board.capturedRed.map(serializePiece),
    capturedBlue: board.capturedBlue.map(serializePiece),
    lastMove: board.lastMove || null,
  };
}
function deserializeBoard(data) {
  const b = new Board();
  b.grid = data.grid.map((row) => row.map(deserializePiece));
  b.capturedRed = (data.capturedRed || []).map(deserializePiece);
  b.capturedBlue = (data.capturedBlue || []).map(deserializePiece);
  b.lastMove = data.lastMove || null;
  return b;
}

// --- Per-player filtered view (the anti-cheat core) ---
// Returns what `forColor` is ALLOWED to see: own pieces at full rank, enemy
// pieces with rank ONLY if revealed through combat (piece.known), else rank=null
// (hidden). Captured pieces are known to both sides. The client reconstructs a
// Board from this, mapping rank=null enemies to RANK.UNKNOWN so the UI shows '?'.
function buildPlayerView(board, forColor, revealAll = false) {
  const grid = board.grid.map((row) =>
    row.map((p) => {
      if (!p) return null;
      const reveal = revealAll || p.color === forColor || p.known;
      return {
        color: p.color,
        id: p.id,
        known: !!p.known,
        moved: !!p.moved,
        rank: reveal ? p.rank : null, // null = hidden from this player
      };
    }),
  );
  return {
    grid,
    capturedRed: board.capturedRed.map((p) => ({ color: p.color, rank: p.rank })),
    capturedBlue: board.capturedBlue.map((p) => ({ color: p.color, rank: p.rank })),
    lastMove: board.lastMove || null,
  };
}

// --- Exports (shared by the browser UI and the Cloudflare Worker) ---
export {
  RED, BLUE, ROWS, COLS, RANK, RANK_NAMES, RANK_FULL_NAMES, RANK_ICONS, HIDDEN_ICON,
  PIECE_COUNTS, WATER_SQUARES, isWater,
  Piece, Board, generateSetup,
  serializePiece, deserializePiece, serializeBoard, deserializeBoard, buildPlayerView,
};
