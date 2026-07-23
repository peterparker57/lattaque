// ============================================================
// STRATEGO - Web Version
// Ported from braathwaate/stratego (Java)
// ============================================================


// --- Shared game rules -------------------------------------------------------
// Piece / Board / combat / setup live in game-core.js so the EXACT same rules
// run in the browser AND in the Cloudflare Worker (authoritative server).
// Do not duplicate rule logic here — import it.
import {
  RED, BLUE, ROWS, COLS, RANK, RANK_NAMES, RANK_FULL_NAMES, RANK_ICONS, HIDDEN_ICON,
  PIECE_COUNTS, WATER_SQUARES, isWater,
  Piece, Board, generateSetup,
} from './game-core.js';

// --- AI Worker Bridge (Blob URL for file:// compatibility) ---
let _aiWorkerBlobUrl = null;

function getAIWorkerBlobUrl() {
  if (_aiWorkerBlobUrl) return _aiWorkerBlobUrl;

  // Fetch the worker script synchronously via XMLHttpRequest
  // This works from file:// protocol
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'ai-worker.js', false); // synchronous
    xhr.send();
    if (xhr.status === 200 || xhr.status === 0) { // status 0 = file:// success
      const blob = new Blob([xhr.responseText], { type: 'application/javascript' });
      _aiWorkerBlobUrl = URL.createObjectURL(blob);
      return _aiWorkerBlobUrl;
    }
  } catch (e) {
    console.warn('Failed to load AI worker via XHR:', e);
  }
  return null;
}

class AIWorker {
  constructor(color) {
    this.color = color;
    this.worker = null;
    this.useInline = false;

    const blobUrl = getAIWorkerBlobUrl();
    if (blobUrl) {
      try {
        this.worker = new Worker(blobUrl);
      } catch (e) {
        console.warn('Worker creation failed, using inline AI:', e);
        this.useInline = true;
      }
    } else {
      this.useInline = true;
    }
  }

  serializeBoard(board) {
    const boardData = {
      grid: [],
      capturedRed: board.capturedRed.map(p => ({ color: p.color, rank: p.rank, known: p.known, moved: p.moved, id: p.id })),
      capturedBlue: board.capturedBlue.map(p => ({ color: p.color, rank: p.rank, known: p.known, moved: p.moved, id: p.id })),
    };
    for (let r = 0; r < ROWS; r++) {
      boardData.grid[r] = [];
      for (let c = 0; c < COLS; c++) {
        const p = board.grid[r][c];
        boardData.grid[r][c] = p ? { color: p.color, rank: p.rank, known: p.known, moved: p.moved, id: p.id } : null;
      }
    }
    return boardData;
  }

  getMove(board, difficulty) {
    const timeLimitMs = Math.max(100, difficulty * difficulty * 10);
    const boardData = this.serializeBoard(board);

    if (this.worker) {
      return new Promise((resolve) => {
        this.worker.onmessage = (e) => {
          if (e.data.type === 'moveFound') {
            resolve({ move: e.data.move, stats: e.data.stats });
          } else {
            resolve(null);
          }
        };
        this.worker.postMessage({ type: 'findMove', boardData, color: this.color, timeLimitMs });
      });
    }

    // Inline fallback: pick a random valid move
    return new Promise((resolve) => {
      setTimeout(() => {
        const moves = [];
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const p = board.grid[r][c];
            if (p && p.color === this.color && p.isMovable()) {
              for (const m of board.getValidMoves(r, c)) {
                moves.push({ fromR: r, fromC: c, toR: m.toR, toC: m.toC });
              }
            }
          }
        }
        if (moves.length > 0) {
          resolve({ move: moves[Math.floor(Math.random() * moves.length)], stats: { depth: 0, nodes: 0, timeMs: 0, value: 0 } });
        } else {
          resolve(null);
        }
      }, 100);
    });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
  }
}


// --- Game Controller ---
class Game {
  constructor() {
    this.board = new Board();
    this.playerColor = BLUE;
    this.aiColor = RED;
    this.aiWorker = null;
    this.turn = RED; // Red goes first
    this.status = 'idle'; // idle, setup, playing, gameover
    this.mode = 'ai';     // 'ai' (offline vs AI) or 'online' (multiplayer)
    this.selectedCell = null;
    this.validMoves = [];
    this.showAll = false;
    // Load saved settings or use defaults
    const saved = JSON.parse(localStorage.getItem('stratego-settings') || 'null');
    this.settings = {
      aiDifficulty: saved?.aiDifficulty ?? 10,
      twoSquares: saved?.twoSquares ?? true,
      showAll: saved?.showAll ?? false,
      tileDesign: saved?.tileDesign ?? 'classic',
      musicEnabled: saved?.musicEnabled ?? true,
      musicVolume: saved?.musicVolume ?? 15,
      sfxEnabled: saved?.sfxEnabled ?? true,
      sfxVolume: saved?.sfxVolume ?? 60,
      viewMode: saved?.viewMode ?? '2d',
    };
    this.animating = false;
  }

  newGame() {
    // Show color picker
    document.getElementById('color-modal').classList.remove('hidden');
  }

  initGame(playerColor) {
    document.getElementById('color-modal').classList.add('hidden');

    this.playerColor = playerColor;
    this.aiColor = playerColor === BLUE ? RED : BLUE;
    this.mode = 'ai';

    // Clean up old worker
    if (this.aiWorker) this.aiWorker.terminate();
    this.aiWorker = new AIWorker(this.aiColor);

    this.board = new Board();
    this.turn = RED;
    this.status = 'setup';
    this.selectedCell = null;
    this.validMoves = [];
    this.showAll = false;

    // Place AI pieces (hidden)
    const aiSetup = generateSetup(this.aiColor);
    for (const { piece, r, c } of aiSetup) {
      this.board.setPiece(r, c, piece);
    }

    // Place player pieces randomly (can be rearranged)
    this.randomizePlayerSetup();

    // Show setup UI
    document.getElementById('btn-randomize').classList.remove('hidden');
    document.getElementById('btn-save-layout').classList.remove('hidden');
    document.getElementById('btn-load-layout').classList.remove('hidden');
    document.getElementById('btn-start-game').classList.remove('hidden');
    document.getElementById('btn-undo').disabled = true;

    ui.render();
    ui.setStatus('Arrange your pieces! Click two pieces to swap them, then click Start Game.');

    // Start music on first game
    music.start();
  }

  get playerRows() {
    return this.playerColor === BLUE ? [6, 7, 8, 9] : [0, 1, 2, 3];
  }

  randomizePlayerSetup() {
    const rows = this.playerRows;
    for (const r of rows) {
      for (let c = 0; c < COLS; c++) {
        this.board.grid[r][c] = null;
      }
    }
    const setup = generateSetup(this.playerColor);
    for (const { piece, r, c } of setup) {
      this.board.setPiece(r, c, piece);
    }
  }

  startGame() {
    this.status = 'playing';
    this.selectedCell = null;
    this.validMoves = [];

    // Hide setup UI
    document.getElementById('btn-randomize').classList.add('hidden');
    document.getElementById('btn-save-layout').classList.add('hidden');
    document.getElementById('btn-load-layout').classList.add('hidden');
    document.getElementById('btn-start-game').classList.add('hidden');

    ui.render();

    // Red always moves first
    if (this.playerColor === RED) {
      ui.setStatus('Game started! Your turn — you move first.');
      document.getElementById('btn-undo').disabled = true;
    } else {
      ui.setStatus('Game started! AI is thinking...');
      setTimeout(() => this.aiMove(), 300);
    }
  }

  // --- Online multiplayer (driven by online.js / the server) ---
  initOnlineSetup(myColor) {
    document.getElementById('color-modal').classList.add('hidden');
    document.getElementById('game-over-banner').classList.add('hidden');
    this.mode = 'online';
    this.playerColor = myColor;
    this.aiColor = myColor === BLUE ? RED : BLUE;
    if (this.aiWorker) { this.aiWorker.terminate(); this.aiWorker = null; }
    this.board = new Board();
    this.turn = RED;
    this.status = 'setup';
    this.selectedCell = null;
    this.validMoves = [];
    this.showAll = false;
    this.randomizePlayerSetup(); // place only my own pieces to arrange
    document.getElementById('btn-randomize').classList.remove('hidden');
    document.getElementById('btn-save-layout').classList.remove('hidden');
    document.getElementById('btn-load-layout').classList.remove('hidden');
    document.getElementById('btn-start-game').classList.remove('hidden');
    document.getElementById('btn-undo').disabled = true;
    ui.render();
    ui.setStatus('Arrange your army, then click Start Game to send it.');
    music.start();
  }

  // online.js hands us a reconstructed Board once the server's view arrives.
  setOnlineBoard(board, status, turn) {
    this.board = board;
    this.status = status;
    this.turn = turn;
    this.selectedCell = null;
    this.validMoves = [];
    if (status === 'gameover') this.showAll = true;
    ['btn-randomize', 'btn-save-layout', 'btn-load-layout', 'btn-start-game']
      .forEach((id) => document.getElementById(id).classList.add('hidden'));
    ui.render();
  }

  showOnlineGameOver(iWon, result) {
    this.status = 'gameover';
    if (iWon) { sfx.play(sfx.victory, 0.7); ui.startFireworks(8000); }
    setTimeout(() => {
      document.getElementById('banner-icon').textContent = iWon ? '\u{1F3C6}' : '\u{1F6A9}';
      const titleEl = document.getElementById('banner-title');
      titleEl.textContent = iWon ? 'VICTORY!' : 'DEFEAT';
      titleEl.className = 'banner-title ' + (iWon ? 'victory' : 'defeat');
      let sub = iWon ? 'You captured the enemy flag!' : 'Your flag was captured.';
      if (result && typeof result.delta === 'number') {
        const sign = result.delta >= 0 ? '+' : '';
        sub += `  Rating: ${result.after} (${sign}${result.delta})`;
      }
      document.getElementById('banner-subtitle').textContent = sub;
      document.getElementById('btn-play-again').textContent = 'Rematch';
      document.getElementById('game-over-banner').classList.remove('hidden');
    }, 600);
  }

  handleCellClick(r, c) {
    // Setup mode: swap player pieces (same for offline + online).
    if (this.status === 'setup') {
      this.handleSetupClick(r, c);
      return;
    }

    // Online play: moves go to the server, not the local engine.
    if (this.mode === 'online') {
      if (window.online) window.online.handleMoveClick(r, c);
      return;
    }

    if (this.status !== 'playing' || this.turn !== this.playerColor || this.animating) return;

    const piece = this.board.getPiece(r, c);

    if (this.selectedCell) {
      // Check if clicking a valid move target
      const move = this.validMoves.find(m => m.toR === r && m.toC === c);
      if (move) {
        this.executePlayerMove(this.selectedCell.r, this.selectedCell.c, r, c);
        return;
      }

      // Clicking own piece = select it instead
      if (piece && piece.color === this.playerColor && piece.isMovable()) {
        this.selectPiece(r, c);
        return;
      }

      // Clicking elsewhere = deselect
      this.deselect();
      return;
    }

    // No selection yet - select a piece
    if (piece && piece.color === this.playerColor && piece.isMovable()) {
      this.selectPiece(r, c);
    }
  }

  selectPiece(r, c) {
    this.selectedCell = { r, c };
    this.validMoves = this.board.getValidMoves(r, c);
    ui.render();
  }

  deselect() {
    this.selectedCell = null;
    this.validMoves = [];
    ui.render();
  }

  // --- Layout Save/Load (localStorage) ---
  getPlayerLayout() {
    const layout = [];
    const startRow = this.playerRows[0];
    for (const r of this.playerRows) {
      for (let c = 0; c < COLS; c++) {
        const p = this.board.getPiece(r, c);
        if (p && p.color === this.playerColor) {
          layout.push({ rank: p.rank, r: r - startRow, c }); // normalize rows to 0-3
        }
      }
    }
    return layout;
  }

  applyLayout(layout) {
    const rows = this.playerRows;
    const startRow = rows[0];

    // Clear player rows
    for (const r of rows) {
      for (let c = 0; c < COLS; c++) {
        if (this.board.grid[r][c] && this.board.grid[r][c].color === this.playerColor) {
          this.board.grid[r][c] = null;
        }
      }
    }

    // Create fresh pieces
    const pieces = [];
    let id = this.playerColor === BLUE ? 40 : 0;
    for (const [rank, count] of Object.entries(PIECE_COUNTS)) {
      for (let i = 0; i < count; i++) {
        pieces.push(new Piece(this.playerColor, parseInt(rank), id++));
      }
    }

    // Place pieces according to layout (layout rows are 0-3 relative)
    const used = new Set();
    for (const slot of layout) {
      const boardR = startRow + slot.r;
      const boardC = slot.c;
      const idx = pieces.findIndex((p, i) => p.rank === slot.rank && !used.has(i));
      if (idx >= 0) {
        used.add(idx);
        this.board.setPiece(boardR, boardC, pieces[idx]);
      }
    }

    this.selectedCell = null;
    this.validMoves = [];
    ui.render();
  }

  saveLayout(name) {
    const layouts = JSON.parse(localStorage.getItem('stratego-layouts') || '[]');
    layouts.push({
      name,
      date: new Date().toISOString(),
      layout: this.getPlayerLayout()
    });
    localStorage.setItem('stratego-layouts', JSON.stringify(layouts));
  }

  getLayouts() {
    return JSON.parse(localStorage.getItem('stratego-layouts') || '[]');
  }

  deleteLayout(index) {
    const layouts = this.getLayouts();
    layouts.splice(index, 1);
    localStorage.setItem('stratego-layouts', JSON.stringify(layouts));
  }

  generateStrategicLayouts() {
    const strategies = [
      { name: 'Fortress Defense', desc: 'Flag deeply protected by bombs and strong pieces',
        fn: () => this._genFortress() },
      { name: 'Blitzkrieg', desc: 'Strong pieces up front for aggressive early attacks',
        fn: () => this._genBlitzkrieg() },
      { name: 'Scout Screen', desc: 'Scouts on front line for early recon',
        fn: () => this._genScoutScreen() },
      { name: 'Corner Bunker', desc: 'Flag in corner surrounded by bombs',
        fn: () => this._genCornerBunker() },
      { name: 'Center Rush', desc: 'Marshal and General in center for quick strikes',
        fn: () => this._genCenterRush() },
      { name: 'Randomized', desc: 'Fully random placement',
        fn: () => this._genRandom() },
    ];
    return strategies.map(s => ({ name: s.name, desc: s.desc, layout: s.fn() }));
  }

  _layoutFromGrid(grid) {
    // grid is a 4x10 array of ranks, convert to layout format
    const layout = [];
    const used = {};
    for (const [rank, count] of Object.entries(PIECE_COUNTS)) {
      used[rank] = 0;
    }
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < COLS; c++) {
        const rank = grid[r][c];
        if (rank && used[rank] < PIECE_COUNTS[rank]) {
          layout.push({ rank, r, c });
          used[rank]++;
        }
      }
    }
    return layout;
  }

  _genRandom() {
    // Use existing generateSetup and extract layout
    const setup = generateSetup(BLUE);
    return setup.map(s => ({ rank: s.piece.rank, r: s.r - 6, c: s.c }));
  }

  _genFortress() {
    const R = RANK;
    // Flag in center-back, bombs around it, strong pieces nearby
    const flagC = 4 + Math.floor(Math.random() * 2);
    const grid = Array.from({length: 4}, () => Array(10).fill(null));

    // Row 3 (back): flag + bombs
    grid[3][flagC] = R.FLAG;
    grid[3][flagC - 1] = R.BOMB;
    grid[3][flagC + 1] = R.BOMB;
    grid[2][flagC] = R.BOMB;
    grid[2][flagC - 1] = R.BOMB;
    grid[2][flagC + 1] = R.BOMB;
    grid[3][flagC - 2] = R.BOMB;

    // Strong pieces guarding
    grid[1][flagC] = R.MARSHAL;
    grid[1][flagC - 1] = R.GENERAL;
    grid[1][flagC + 1] = R.COLONEL;
    grid[1][flagC - 2] = R.COLONEL;
    grid[1][flagC + 2] = R.SPY;

    // Fill rest randomly
    return this._fillRemaining(grid);
  }

  _genBlitzkrieg() {
    const R = RANK;
    const grid = Array.from({length: 4}, () => Array(10).fill(null));

    // Front row: strong pieces
    grid[0][3] = R.MARSHAL;
    grid[0][4] = R.GENERAL;
    grid[0][5] = R.COLONEL;
    grid[0][6] = R.COLONEL;
    grid[0][2] = R.MAJOR;
    grid[0][7] = R.MAJOR;
    grid[0][1] = R.CAPTAIN;
    grid[0][8] = R.CAPTAIN;
    grid[0][0] = R.SPY;
    grid[0][9] = R.MAJOR;

    // Back: flag + bombs
    const flagC = Math.floor(Math.random() * 3);
    grid[3][flagC] = R.FLAG;
    grid[3][flagC + 1] = R.BOMB;
    grid[2][flagC] = R.BOMB;

    return this._fillRemaining(grid);
  }

  _genScoutScreen() {
    const R = RANK;
    const grid = Array.from({length: 4}, () => Array(10).fill(null));

    // Front row: all scouts
    for (let c = 0; c < 8; c++) grid[0][c] = R.SCOUT;

    // Second row: miners and mid-rank
    grid[1][0] = R.MINER; grid[1][1] = R.MINER; grid[1][2] = R.MINER;
    grid[1][3] = R.CAPTAIN; grid[1][4] = R.MARSHAL; grid[1][5] = R.GENERAL;
    grid[1][6] = R.CAPTAIN; grid[1][7] = R.MINER; grid[1][8] = R.MINER;
    grid[1][9] = R.SPY;

    // Back: flag + bombs
    const flagC = 7 + Math.floor(Math.random() * 3);
    grid[3][flagC] = R.FLAG;
    if (flagC > 0) grid[3][flagC - 1] = R.BOMB;
    if (flagC < 9) grid[3][flagC + 1] = R.BOMB;
    grid[2][flagC] = R.BOMB;

    return this._fillRemaining(grid);
  }

  _genCornerBunker() {
    const R = RANK;
    const grid = Array.from({length: 4}, () => Array(10).fill(null));
    const left = Math.random() < 0.5;
    const fc = left ? 0 : 9;
    const d = left ? 1 : -1;

    // Corner flag with bombs
    grid[3][fc] = R.FLAG;
    grid[3][fc + d] = R.BOMB;
    grid[2][fc] = R.BOMB;
    grid[2][fc + d] = R.BOMB;
    grid[3][fc + d * 2] = R.BOMB;
    grid[1][fc] = R.BOMB;
    grid[1][fc + d] = R.BOMB;

    // Strong pieces on opposite side
    grid[0][9 - fc] = R.MARSHAL;
    grid[0][9 - fc - d] = R.GENERAL;
    grid[0][9 - fc - d * 2] = R.SPY;

    return this._fillRemaining(grid);
  }

  _genCenterRush() {
    const R = RANK;
    const grid = Array.from({length: 4}, () => Array(10).fill(null));

    // Center columns loaded with power
    grid[0][4] = R.MARSHAL;
    grid[0][5] = R.GENERAL;
    grid[0][3] = R.SPY;
    grid[0][6] = R.COLONEL;
    grid[1][4] = R.COLONEL;
    grid[1][5] = R.MAJOR;
    grid[1][3] = R.MAJOR;
    grid[1][6] = R.MAJOR;

    // Miners on flanks
    grid[0][0] = R.MINER; grid[0][1] = R.MINER;
    grid[0][8] = R.MINER; grid[0][9] = R.MINER;

    // Flag in back corner
    const flagC = Math.random() < 0.5 ? 0 : 9;
    grid[3][flagC] = R.FLAG;
    grid[3][flagC === 0 ? 1 : 8] = R.BOMB;
    grid[2][flagC] = R.BOMB;

    return this._fillRemaining(grid);
  }

  _fillRemaining(grid) {
    // Count what's placed
    const placed = {};
    for (const [rank] of Object.entries(PIECE_COUNTS)) placed[rank] = 0;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 10; c++)
        if (grid[r][c]) placed[grid[r][c]]++;

    // Collect remaining pieces
    const remaining = [];
    for (const [rank, count] of Object.entries(PIECE_COUNTS)) {
      for (let i = placed[rank] || 0; i < count; i++) {
        remaining.push(parseInt(rank));
      }
    }

    // Shuffle
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    // Fill empty cells
    let ri = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 10; c++) {
        if (!grid[r][c] && ri < remaining.length) {
          grid[r][c] = remaining[ri++];
        }
      }
    }

    return this._layoutFromGrid(grid);
  }

  handleSetupClick(r, c) {
    const piece = this.board.getPiece(r, c);
    const rows = this.playerRows;
    const inZone = rows.includes(r);

    // Only interact with player pieces
    if (piece && piece.color !== this.playerColor) return;

    if (this.selectedCell) {
      const selR = this.selectedCell.r;
      const selC = this.selectedCell.c;

      // Must be in player zone
      if (!inZone || isWater(r, c)) {
        this.selectedCell = null;
        ui.render();
        return;
      }

      // Swap the two positions
      const pieceA = this.board.getPiece(selR, selC);
      const pieceB = this.board.getPiece(r, c);
      this.board.grid[selR][selC] = pieceB;
      this.board.grid[r][c] = pieceA;

      this.selectedCell = null;
      ui.render();
      ui.setStatus('Pieces swapped! Keep arranging or click Start Game.');
    } else {
      // Select a player piece to swap
      if (piece && piece.color === this.playerColor && inZone) {
        this.selectedCell = { r, c };
        this.validMoves = [];
        for (const tr of rows) {
          for (let tc = 0; tc < COLS; tc++) {
            if ((tr !== r || tc !== c) && !isWater(tr, tc)) {
              this.validMoves.push({ toR: tr, toC: tc, isAttack: false });
            }
          }
        }
        ui.render();
      }
    }
  }

  async executePlayerMove(fromR, fromC, toR, toC) {
    this.animating = true;
    this.selectedCell = null;
    this.validMoves = [];
    ui.render();

    const defender = this.board.getPiece(toR, toC);

    if (defender) {
      // COMBAT SEQUENCE
      await ui.playCombatSequence(this.board, fromR, fromC, toR, toC);
    } else {
      // Simple move — just slide
      await ui.animateSlide(fromR, fromC, toR, toC);
    }

    const record = this.board.executeMove(fromR, fromC, toR, toC);
    this.turn = this.aiColor;
    document.getElementById('btn-undo').disabled = true;
    this.animating = false;

    ui.render();

    // Check for game over
    const winner = this.board.checkWin();
    if (winner >= 0) {
      this.gameOver(winner);
      return;
    }

    // AI's turn
    setTimeout(() => this.aiMove(), 200);
  }

  async aiMove() {
    if (this.status !== 'playing') return;

    ui.setStatus('AI is thinking...');

    const result = await this.aiWorker.getMove(this.board, this.settings.aiDifficulty);
    if (!result || !result.move) {
      this.gameOver(this.playerColor);
      return;
    }

    const move = result.move;
    const stats = result.stats;
    const defender = this.board.getPiece(move.toR, move.toC);

    ui.render();

    if (defender) {
      await ui.playCombatSequence(this.board, move.fromR, move.fromC, move.toR, move.toC);
    } else {
      await ui.animateSlide(move.fromR, move.fromC, move.toR, move.toC);
    }

    const record = this.board.executeMove(move.fromR, move.fromC, move.toR, move.toC);
    this.turn = this.playerColor;

    ui.render();

    // Show AI search stats
    if (stats) {
      console.log(`AI: depth=${stats.depth} nodes=${stats.nodes} time=${stats.timeMs}ms value=${stats.value}`);
    }

    // Check for game over
    const winner = this.board.checkWin();
    if (winner >= 0) {
      this.gameOver(winner);
      return;
    }

    // Check if player can move
    const playerMoves = this.board.getMovablePieces(this.playerColor);
    if (playerMoves.length === 0) {
      this.gameOver(this.aiColor);
      return;
    }

    ui.setStatus('Your turn - select a piece to move');
    document.getElementById('btn-undo').disabled = false;
  }

  showCombatResult(record) {
    if (!record.defender) return;

    const attackerName = RANK_FULL_NAMES[record.attacker.rank];
    const defenderName = RANK_FULL_NAMES[record.defender.rank];

    // Play combat sound and animation
    sfx.combat(record);
    ui.playCombatAnimation(record);

    if (record.result === 1) {
      ui.flashStatus(`${attackerName} defeats ${defenderName}!`);
    } else if (record.result === 0) {
      ui.flashStatus(`${defenderName} defeats ${attackerName}!`);
    } else {
      ui.flashStatus(`${attackerName} and ${defenderName} both destroyed!`);
    }
  }

  gameOver(winner) {
    this.status = 'gameover';
    this.showAll = true;
    if (this.aiWorker) this.aiWorker.terminate();
    ui.render();
    document.getElementById('btn-undo').disabled = true;

    const moves = this.board.moveHistory.length;
    const captured = winner === this.playerColor ? this.board.capturedRed.length : this.board.capturedBlue.length;
    const isVictory = winner === this.playerColor;

    // Play victory sound and fireworks for a win
    if (isVictory) {
      sfx.play(sfx.victory, 0.7);
      ui.startFireworks(8000);
    }

    // Show banner after a short delay
    setTimeout(() => {
      const banner = document.getElementById('game-over-banner');
      const iconEl = document.getElementById('banner-icon');
      const titleEl = document.getElementById('banner-title');
      const subtitleEl = document.getElementById('banner-subtitle');

      if (isVictory) {
        iconEl.textContent = '\u{1F3C6}';
        titleEl.textContent = 'VICTORY!';
        titleEl.className = 'banner-title victory';
        subtitleEl.textContent = `You captured the flag in ${moves} moves, taking ${captured} enemy pieces.`;
      } else {
        iconEl.textContent = '\u{1F6A9}';
        titleEl.textContent = 'DEFEAT';
        titleEl.className = 'banner-title defeat';
        subtitleEl.textContent = `Your flag was captured after ${moves} moves. You took ${captured} enemy pieces.`;
      }

      banner.classList.remove('hidden');
    }, 800);
  }

  undo() {
    if (this.status !== 'playing' || this.turn !== this.playerColor) return;
    if (this.board.undoLastTurn()) {
      this.selectedCell = null;
      this.validMoves = [];
      ui.render();
      ui.setStatus('Your turn - select a piece to move');
    }
  }
}

// --- UI Renderer ---
class UI {
  constructor() {
    this.boardEl = document.getElementById('board');
    this.statusEl = document.getElementById('status-text');
    // Rosters rendered dynamically

    this.createBoard();
    this.bindEvents();
  }

  createBoard() {
    this.boardEl.innerHTML = '';
    this.dragState = null; // { fromR, fromC, ghost, moved }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;

        if (isWater(r, c)) {
          cell.classList.add('water');
        } else {
          cell.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');
        }

        cell.addEventListener('click', () => {
          if (!this.dragState || !this.dragState.moved) {
            game.handleCellClick(r, c);
          }
        });
        this.boardEl.appendChild(cell);
      }
    }

    // Drag-and-drop (mouse)
    this.boardEl.addEventListener('mousedown', (e) => this.onDragStart(e));
    document.addEventListener('mousemove', (e) => this.onDragMove(e));
    document.addEventListener('mouseup', (e) => this.onDragEnd(e));

    // Drag-and-drop (touch)
    this.boardEl.addEventListener('touchstart', (e) => this.onDragStart(e), { passive: false });
    document.addEventListener('touchmove', (e) => this.onDragMove(e), { passive: false });
    document.addEventListener('touchend', (e) => this.onDragEnd(e));
  }

  getCellFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const cell = el.closest('.cell');
    if (!cell) return null;
    return { r: parseInt(cell.dataset.row), c: parseInt(cell.dataset.col) };
  }

  canDragFrom(r, c) {
    const piece = game.board.getPiece(r, c);
    if (!piece || piece.color !== game.playerColor) return false;
    if (game.status === 'setup') return game.playerRows.includes(r);
    if (game.status === 'playing' && game.turn === game.playerColor && !game.animating) {
      return piece.isMovable();
    }
    return false;
  }

  onDragStart(e) {
    const touch = e.touches ? e.touches[0] : e;
    const pos = this.getCellFromPoint(touch.clientX, touch.clientY);
    if (!pos || !this.canDragFrom(pos.r, pos.c)) return;

    // Find the piece element in the cell
    const idx = pos.r * COLS + pos.c;
    const cell = this.boardEl.children[idx];
    const pieceEl = cell.querySelector('.piece');
    if (!pieceEl) return;

    // Select the piece (shows valid moves)
    game.selectPiece(pos.r, pos.c);

    // Create floating ghost
    const ghost = pieceEl.cloneNode(true);
    ghost.className = pieceEl.className + ' drag-ghost';
    const rect = pieceEl.getBoundingClientRect();
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    ghost.style.left = (touch.clientX - rect.width / 2) + 'px';
    ghost.style.top = (touch.clientY - rect.height / 2) + 'px';
    document.body.appendChild(ghost);

    // Dim the original
    pieceEl.style.opacity = '0.3';

    this.dragState = { fromR: pos.r, fromC: pos.c, ghost, moved: false, startX: touch.clientX, startY: touch.clientY };

    if (e.touches) e.preventDefault();
  }

  onDragMove(e) {
    if (!this.dragState) return;
    const touch = e.touches ? e.touches[0] : e;
    const dx = touch.clientX - this.dragState.startX;
    const dy = touch.clientY - this.dragState.startY;
    if (!this.dragState.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      this.dragState.moved = true;
    }
    this.dragState.ghost.style.left = (touch.clientX - parseInt(this.dragState.ghost.style.width) / 2) + 'px';
    this.dragState.ghost.style.top = (touch.clientY - parseInt(this.dragState.ghost.style.height) / 2) + 'px';

    // Highlight cell under cursor
    const pos = this.getCellFromPoint(touch.clientX, touch.clientY);
    this.boardEl.querySelectorAll('.cell.drag-over').forEach(c => c.classList.remove('drag-over'));
    if (pos) {
      const idx = pos.r * COLS + pos.c;
      this.boardEl.children[idx].classList.add('drag-over');
    }

    if (e.touches) e.preventDefault();
  }

  onDragEnd(e) {
    if (!this.dragState) return;
    const { fromR, fromC, ghost, moved } = this.dragState;

    // Remove ghost and hover highlight
    ghost.remove();
    this.boardEl.querySelectorAll('.cell.drag-over').forEach(c => c.classList.remove('drag-over'));

    // Restore original piece opacity
    const idx = fromR * COLS + fromC;
    const origPiece = this.boardEl.children[idx].querySelector('.piece');
    if (origPiece) origPiece.style.opacity = '';

    if (!moved) {
      this.dragState = null;
      return; // Was a click, not a drag — click handler will fire
    }

    const touch = e.changedTouches ? e.changedTouches[0] : e;
    const pos = this.getCellFromPoint(touch.clientX, touch.clientY);
    this.dragState = null;

    if (!pos || (pos.r === fromR && pos.c === fromC)) {
      game.deselect();
      return;
    }

    if (game.status === 'setup') {
      // Setup mode: swap pieces via the same handler
      game.selectedCell = { r: fromR, c: fromC };
      game.handleSetupClick(pos.r, pos.c);
    } else if (game.status === 'playing') {
      // Playing mode: execute move if valid
      const move = game.validMoves.find(m => m.toR === pos.r && m.toC === pos.c);
      if (move) {
        game.executePlayerMove(fromR, fromC, pos.r, pos.c);
      } else {
        game.deselect();
      }
    }
  }

  render() {
    // View mode
    const container = document.getElementById('board-container');
    const gameArea = document.getElementById('game-area');
    container.classList.toggle('view-3d', game.settings.viewMode === '3d');
    gameArea.classList.toggle('view-3d-layout', game.settings.viewMode === '3d');

    // Turn indicator on board border
    const boardEl = document.getElementById('board');
    boardEl.classList.remove('turn-player', 'turn-ai', 'turn-setup');
    if (game.status === 'setup') {
      boardEl.classList.add('turn-setup');
    } else if (game.status === 'playing') {
      boardEl.classList.add(game.turn === game.playerColor ? 'turn-player' : 'turn-ai');
    }

    const cells = this.boardEl.children;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        const cell = cells[idx];
        const piece = game.board.getPiece(r, c);

        // Reset cell classes
        cell.className = 'cell';
        if (isWater(r, c)) {
          cell.classList.add('water');
        } else {
          cell.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');
        }

        // Setup zone highlighting
        if (game.status === 'setup' && game.playerRows.includes(r) && !isWater(r, c)) {
          cell.classList.add('setup-zone');
        }

        // Highlight last move
        if (game.board.lastMove) {
          const lm = game.board.lastMove;
          if ((r === lm.fromR && c === lm.fromC) || (r === lm.toR && c === lm.toC)) {
            cell.classList.add('last-move');
          }
        }

        // Selected cell
        if (game.selectedCell && game.selectedCell.r === r && game.selectedCell.c === c) {
          cell.classList.add('selected');
        }

        // Valid move highlights
        const validMove = game.validMoves.find(m => m.toR === r && m.toC === c);
        if (validMove) {
          cell.classList.add(validMove.isAttack ? 'valid-attack' : 'valid-move');
        }

        // Render piece
        cell.innerHTML = '';
        if (piece && !isWater(r, c)) {
          const pieceEl = document.createElement('div');
          pieceEl.className = `piece ${piece.color === RED ? 'red' : 'blue'}`;

          const showRank = piece.color === game.playerColor ||
                           piece.known ||
                           game.showAll ||
                           game.settings.showAll ||
                           game.status === 'gameover';

          if (!showRank) {
            pieceEl.classList.add('hidden-piece');
            pieceEl.classList.add('tile-' + game.settings.tileDesign);
          }

          // Rank number in upper-right corner
          if (showRank) {
            const num = document.createElement('span');
            num.className = 'rank-number';
            num.textContent = RANK_NAMES[piece.rank];
            pieceEl.appendChild(num);
          }

          // Icon
          const icon = document.createElement('span');
          icon.className = 'piece-icon';
          if (showRank) {
            icon.textContent = RANK_ICONS[piece.rank] || '';
          } else {
            const tileIcons = {
              classic: HIDDEN_ICON,
              shield: '\u{1F6E1}\uFE0F',
              stars: '\u2726',
              crosshatch: '',
              eagle: '\u{1F985}',
              skull: '\u2620\uFE0F'
            };
            icon.textContent = tileIcons[game.settings.tileDesign] || HIDDEN_ICON;
          }
          pieceEl.appendChild(icon);

          // Rank label below icon
          const label = document.createElement('span');
          label.className = 'rank-label';
          if (showRank) {
            label.textContent = RANK_FULL_NAMES[piece.rank] || RANK_NAMES[piece.rank];
          }
          pieceEl.appendChild(label);

          if (piece.known && piece.color !== game.playerColor) {
            pieceEl.classList.add('highlight');
          }

          cell.appendChild(pieceEl);
        }
      }
    }

    this.renderRosters();
  }

  renderRosters() {
    // Rank order to display (top to bottom)
    const rankOrder = [
      RANK.MARSHAL, RANK.GENERAL, RANK.COLONEL, RANK.MAJOR, RANK.CAPTAIN,
      RANK.LIEUTENANT, RANK.SERGEANT, RANK.MINER, RANK.SCOUT,
      RANK.SPY, RANK.BOMB, RANK.FLAG
    ];

    this.renderRoster(document.getElementById('roster-blue'), BLUE, rankOrder);
    this.renderRoster(document.getElementById('roster-red'), RED, rankOrder);
  }

  renderRoster(container, color, rankOrder) {
    container.innerHTML = '';

    // Count alive pieces on the board
    const alive = {};
    for (const rank of rankOrder) alive[rank] = 0;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = game.board.getPiece(r, c);
        if (p && p.color === color && alive[p.rank] !== undefined) {
          alive[p.rank]++;
        }
      }
    }

    for (const rank of rankOrder) {
      const count = alive[rank];
      const total = PIECE_COUNTS[rank];
      const isDepleted = count === 0;

      const row = document.createElement('div');
      row.className = 'roster-row';
      row.title = `${RANK_FULL_NAMES[rank]}: ${count} of ${total} remaining`;

      const countEl = document.createElement('div');
      countEl.className = 'roster-count' + (isDepleted ? ' zero' : '');
      countEl.textContent = count;

      const pieceEl = document.createElement('div');
      pieceEl.className = `roster-piece ${color === RED ? 'red' : 'blue'}${isDepleted ? ' depleted' : ''}`;

      const rankNum = document.createElement('span');
      rankNum.className = 'roster-rank';
      rankNum.textContent = RANK_NAMES[rank];
      pieceEl.appendChild(rankNum);

      const icon = document.createElement('span');
      icon.className = 'roster-icon';
      icon.textContent = RANK_ICONS[rank] || '';
      pieceEl.appendChild(icon);

      // Blue roster: count on left, piece on right
      // Red roster: piece on left, count on right
      if (color === BLUE) {
        row.appendChild(countEl);
        row.appendChild(pieceEl);
      } else {
        row.appendChild(pieceEl);
        row.appendChild(countEl);
      }

      container.appendChild(row);
    }
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  async playCombatSequence(board, fromR, fromC, toR, toC) {
    const attacker = board.getPiece(fromR, fromC);
    const defender = board.getPiece(toR, toC);
    const result = Piece.winFight(attacker, defender);

    const fromCell = this.boardEl.children[fromR * COLS + fromC];
    const toCell = this.boardEl.children[toR * COLS + toC];
    const fromPiece = fromCell.querySelector('.piece');
    const toPiece = toCell.querySelector('.piece');
    const boardEl = document.getElementById('board');

    const isBomb = attacker.rank === RANK.BOMB || defender.rank === RANK.BOMB;
    const isHighValue = attacker.rank <= RANK.COLONEL || defender.rank <= RANK.COLONEL;

    // Calculate bump direction
    const fromRect = fromCell.getBoundingClientRect();
    const toRect = toCell.getBoundingClientRect();
    const dx = Math.sign(toRect.left - fromRect.left);
    const dy = Math.sign(toRect.top - fromRect.top);
    const bumpDist = 18;

    // --- PHASE 1: CLASH (1.5s) — pieces bump toward each other ---
    sfx.combat({ attacker, defender });

    // Screen shake
    if (isHighValue || isBomb) {
      boardEl.classList.add('shake');
      setTimeout(() => boardEl.classList.remove('shake'), 1000);
    }

    // Combat ring
    const ring = document.createElement('div');
    ring.className = 'combat-ring';
    toCell.appendChild(ring);

    // Bump animation — attacker bumps toward defender and back, multiple times
    if (fromPiece) {
      fromPiece.animate([
        { transform: 'translate(0, 0)' },
        { transform: `translate(${dx * bumpDist}px, ${dy * bumpDist}px)` },
        { transform: 'translate(0, 0)' },
        { transform: `translate(${dx * bumpDist * 0.7}px, ${dy * bumpDist * 0.7}px)` },
        { transform: 'translate(0, 0)' },
        { transform: `translate(${dx * bumpDist * 0.5}px, ${dy * bumpDist * 0.5}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 1500, easing: 'ease-in-out' });
    }

    if (toPiece) {
      toPiece.animate([
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-dx * bumpDist}px, ${-dy * bumpDist}px)` },
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-dx * bumpDist * 0.7}px, ${-dy * bumpDist * 0.7}px)` },
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-dx * bumpDist * 0.5}px, ${-dy * bumpDist * 0.5}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 1500, easing: 'ease-in-out' });
    }

    // Show swords during clash
    const swords = document.createElement('div');
    swords.className = 'battle-overlay';
    swords.textContent = '\u2694\uFE0F';
    swords.style.fontSize = '28px';
    swords.style.animationDuration = '1.5s';
    toCell.appendChild(swords);

    // Wait for clash phase
    await new Promise(r => setTimeout(r, 1500));
    swords.remove();
    ring.remove();

    // --- PHASE 2: REVEAL RESULT (1.5s) — loser fades, result shown ---

    // Show skull over the loser's cell
    const skull = '\u2620\uFE0F';

    if (result === 1) {
      // Attacker wins — skull on defender (toCell)
      const overlay = document.createElement('div');
      overlay.className = 'battle-overlay';
      overlay.textContent = skull;
      overlay.style.animationDuration = '1.5s';
      toCell.appendChild(overlay);
      setTimeout(() => overlay.remove(), 1500);
    } else if (result === 0) {
      // Defender wins — skull on attacker (fromCell)
      const overlay = document.createElement('div');
      overlay.className = 'battle-overlay';
      overlay.textContent = skull;
      overlay.style.animationDuration = '1.5s';
      fromCell.appendChild(overlay);
      setTimeout(() => overlay.remove(), 1500);
    } else {
      // Both die — skull on both cells
      const overlay1 = document.createElement('div');
      overlay1.className = 'battle-overlay';
      overlay1.textContent = skull;
      overlay1.style.animationDuration = '1.5s';
      fromCell.appendChild(overlay1);
      const overlay2 = document.createElement('div');
      overlay2.className = 'battle-overlay';
      overlay2.textContent = skull;
      overlay2.style.animationDuration = '1.5s';
      toCell.appendChild(overlay2);
      setTimeout(() => { overlay1.remove(); overlay2.remove(); }, 1500);
    }

    // Bomb explosion particles
    if (isBomb) {
      const explosion = document.createElement('div');
      explosion.className = 'explosion';
      const colors = ['#e74c3c', '#f39c12', '#f1c40f', '#e67e22', '#ff6b6b', '#fff'];
      for (let i = 0; i < 12; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const angle = (i / 12) * Math.PI * 2;
        const dist = 25 + Math.random() * 20;
        const tx = Math.cos(angle) * dist;
        const ty = Math.sin(angle) * dist;
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        p.animate([
          { transform: `translate(-50%, -50%) scale(1)`, opacity: 1 },
          { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0.3)`, opacity: 0 }
        ], { duration: 1200 + Math.random() * 300, easing: 'ease-out', fill: 'forwards' });
        explosion.appendChild(p);
      }
      toCell.appendChild(explosion);
      setTimeout(() => explosion.remove(), 1500);
    }

    // Fade out the loser
    if (result === 1 && toPiece) {
      // Attacker wins — defender dies
      toPiece.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(1.1) rotate(5deg)', opacity: 0.8 },
        { transform: 'scale(0.5) rotate(-10deg)', opacity: 0.4 },
        { transform: 'scale(0) rotate(15deg)', opacity: 0 },
      ], { duration: 1200, easing: 'ease-in', fill: 'forwards' });
    } else if (result === 0 && fromPiece) {
      // Defender wins — attacker dies
      fromPiece.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(1.1) rotate(-5deg)', opacity: 0.8 },
        { transform: 'scale(0.5) rotate(10deg)', opacity: 0.4 },
        { transform: 'scale(0) rotate(-15deg)', opacity: 0 },
      ], { duration: 1200, easing: 'ease-in', fill: 'forwards' });
    } else if (result === -1) {
      // Both die
      if (fromPiece) {
        fromPiece.animate([
          { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
          { transform: 'scale(1.1)', opacity: 0.9, filter: 'brightness(2)' },
          { transform: 'scale(0)', opacity: 0, filter: 'brightness(0)' },
        ], { duration: 1200, easing: 'ease-in', fill: 'forwards' });
      }
      if (toPiece) {
        toPiece.animate([
          { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
          { transform: 'scale(1.1)', opacity: 0.9, filter: 'brightness(2)' },
          { transform: 'scale(0)', opacity: 0, filter: 'brightness(0)' },
        ], { duration: 1200, easing: 'ease-in', fill: 'forwards' });
      }
    }

    // Winner pulses
    if (result === 1 && fromPiece) {
      fromPiece.animate([
        { boxShadow: '0 0 0 0 rgba(46,204,113,0)', transform: 'scale(1)' },
        { boxShadow: '0 0 20px 8px rgba(46,204,113,0.7)', transform: 'scale(1.15)' },
        { boxShadow: '0 0 10px 4px rgba(46,204,113,0.3)', transform: 'scale(1.05)' },
        { boxShadow: '0 0 0 0 rgba(46,204,113,0)', transform: 'scale(1)' },
      ], { duration: 1200, easing: 'ease-in-out' });
    } else if (result === 0 && toPiece) {
      toPiece.animate([
        { boxShadow: '0 0 0 0 rgba(46,204,113,0)', transform: 'scale(1)' },
        { boxShadow: '0 0 20px 8px rgba(46,204,113,0.7)', transform: 'scale(1.15)' },
        { boxShadow: '0 0 10px 4px rgba(46,204,113,0.3)', transform: 'scale(1.05)' },
        { boxShadow: '0 0 0 0 rgba(46,204,113,0)', transform: 'scale(1)' },
      ], { duration: 1200, easing: 'ease-in-out' });
    }

    // Wait for reveal phase
    await new Promise(r => setTimeout(r, 1500));

    // --- PHASE 3: Winner slides into the conquered square ---
    if (result === 1 && fromPiece) {
      // Attacker won — slide attacker to defender's cell
      await this.animateSlide(fromR, fromC, toR, toC);
    }
    // Defender wins — stays in place, no slide needed

    // Status text
    const attackerName = RANK_FULL_NAMES[attacker.rank];
    const defenderName = RANK_FULL_NAMES[defender.rank];
    if (result === 1) {
      ui.flashStatus(`${attackerName} defeats ${defenderName}!`);
    } else if (result === 0) {
      ui.flashStatus(`${defenderName} defeats ${attackerName}!`);
    } else {
      ui.flashStatus(`${attackerName} and ${defenderName} both destroyed!`);
    }
  }

  animateSlide(fromR, fromC, toR, toC) {
    const fromCell = this.boardEl.children[fromR * COLS + fromC];
    const piece = fromCell.querySelector('.piece');
    if (!piece) return Promise.resolve();

    const is3d = game.settings.viewMode === '3d';
    const z = is3d ? 'translateZ(16px) ' : '';

    // Use grid-local coordinates (each cell = boardWidth / 10)
    const cellW = this.boardEl.offsetWidth / COLS;
    const cellH = this.boardEl.offsetHeight / ROWS;
    const dx = (toC - fromC) * cellW;
    const dy = (toR - fromR) * cellH;

    return new Promise(resolve => {
      piece.animate([
        { transform: `${z}translate(0, 0)` },
        { transform: `${z}translate(${dx}px, ${dy}px)` }
      ], {
        duration: 300,
        easing: 'ease-in-out',
        fill: 'forwards'
      }).onfinish = resolve;
    });
  }

  playCombatAnimation(record) {
    const { fromR, fromC, toR, toC } = record;
    const toCell = this.boardEl.children[toR * COLS + toC];
    const fromCell = this.boardEl.children[fromR * COLS + fromC];
    const boardEl = document.getElementById('board');

    const isBomb = record.defender.rank === RANK.BOMB || record.attacker.rank === RANK.BOMB;
    const isHighValue = record.attacker.rank <= RANK.COLONEL || record.defender.rank <= RANK.COLONEL;

    // Screen shake for high-value combat or bombs
    if (isHighValue || isBomb) {
      boardEl.classList.add('shake');
      setTimeout(() => boardEl.classList.remove('shake'), 1000);
    }

    // Combat ring flash
    const ring = document.createElement('div');
    ring.className = 'combat-ring';
    toCell.appendChild(ring);
    setTimeout(() => ring.remove(), 1200);

    // Bomb explosion particles
    if (isBomb) {
      const explosion = document.createElement('div');
      explosion.className = 'explosion';
      const colors = ['#e74c3c', '#f39c12', '#f1c40f', '#e67e22', '#ff6b6b', '#fff'];
      for (let i = 0; i < 12; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        const angle = (i / 12) * Math.PI * 2;
        const dist = 25 + Math.random() * 20;
        const tx = Math.cos(angle) * dist;
        const ty = Math.sin(angle) * dist;
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        p.style.animation = `explodeParticle 0.7s ease-out forwards`;
        p.style.setProperty('--tx', tx + 'px');
        p.style.setProperty('--ty', ty + 'px');
        // Use inline keyframes via transform
        p.animate([
          { transform: `translate(-50%, -50%) scale(1)`, opacity: 1 },
          { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0.3)`, opacity: 0 }
        ], { duration: 2000 + Math.random() * 800, easing: 'ease-out', fill: 'forwards' });
        explosion.appendChild(p);
      }
      toCell.appendChild(explosion);
      setTimeout(() => explosion.remove(), 3500);
    }

    // Result emoji overlay
    let emoji;
    if (record.result === 1) {
      // Attacker wins
      emoji = record.attacker.color === game.playerColor ? '\u2B50' : '\u{1F480}'; // star or skull
      toCell.classList.add('combat-win');
    } else if (record.result === 0) {
      // Defender wins
      emoji = record.defender.color === game.playerColor ? '\u{1F6E1}\uFE0F' : '\u{1F480}'; // shield or skull
    } else {
      // Both die
      emoji = '\u{1F4A5}'; // collision/explosion
      toCell.classList.add('combat-draw');
      fromCell.classList.add('combat-draw');
    }

    const overlay = document.createElement('div');
    overlay.className = 'battle-overlay';
    overlay.textContent = emoji;
    toCell.appendChild(overlay);

    // Also show crossed swords
    const swords = document.createElement('div');
    swords.className = 'battle-overlay';
    swords.textContent = '\u2694\uFE0F';
    swords.style.fontSize = '28px';
    swords.style.animationDuration = '2.5s';
    toCell.appendChild(swords);

    // Cleanup
    setTimeout(() => {
      overlay.remove();
      swords.remove();
      toCell.classList.remove('combat-win', 'combat-lose', 'combat-draw');
      fromCell.classList.remove('combat-draw');
    }, 3500);
  }

  showLayoutsModal() {
    const layouts = game.getLayouts();
    const listEl = document.getElementById('layouts-list');
    listEl.innerHTML = '';

    // --- Saved Boards ---
    const savedHeader = document.createElement('h3');
    savedHeader.className = 'layouts-section-header';
    savedHeader.textContent = 'Saved Boards';
    listEl.appendChild(savedHeader);

    if (layouts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-layouts';
      empty.textContent = 'No saved boards yet. Arrange pieces and click Save Layout.';
      listEl.appendChild(empty);
    } else {
      layouts.forEach((entry, index) => {
        listEl.appendChild(this._createLayoutItem(entry.name,
          new Date(entry.date).toLocaleDateString() + ' ' + new Date(entry.date).toLocaleTimeString(),
          () => {
            game.applyLayout(entry.layout);
            document.getElementById('layouts-modal').classList.add('hidden');
            ui.setStatus(`Layout "${entry.name}" loaded! Adjust or click Start Game.`);
          },
          () => {
            game.deleteLayout(index);
            this.showLayoutsModal();
          }
        ));
      });
    }

    // --- Generated Boards ---
    const genHeader = document.createElement('h3');
    genHeader.className = 'layouts-section-header';
    genHeader.textContent = 'Generated Boards';
    listEl.appendChild(genHeader);

    const generated = game.generateStrategicLayouts();
    for (const strat of generated) {
      listEl.appendChild(this._createLayoutItem(strat.name, strat.desc,
        () => {
          game.applyLayout(strat.layout);
          document.getElementById('layouts-modal').classList.add('hidden');
          ui.setStatus(`"${strat.name}" layout loaded! Adjust or click Start Game.`);
        },
        null // no delete for generated
      ));
    }

    document.getElementById('layouts-modal').classList.remove('hidden');
  }

  _createLayoutItem(name, subtitle, onLoad, onDelete) {
    const item = document.createElement('div');
    item.className = 'layout-item';

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'layout-name';
    nameEl.textContent = name;
    const subEl = document.createElement('div');
    subEl.className = 'layout-date';
    subEl.textContent = subtitle;
    info.appendChild(nameEl);
    info.appendChild(subEl);

    const actions = document.createElement('div');
    actions.className = 'layout-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn-load-item';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', (e) => { e.stopPropagation(); onLoad(); });
    actions.appendChild(loadBtn);

    if (onDelete) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-delete-item';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
      actions.appendChild(deleteBtn);
    }

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }

  startFireworks(durationMs) {
    // Create a full-screen fireworks canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'fireworks-canvas';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:150;';
    document.body.appendChild(canvas);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const particles = [];
    const rockets = [];
    const colors = [
      '#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff', '#44ffff',
      '#ff8800', '#ff0088', '#88ff00', '#0088ff', '#ffaa44', '#aa44ff',
      '#ff6666', '#66ff66', '#6666ff', '#ffdd00', '#ff66aa', '#66ddff'
    ];
    const startTime = performance.now();

    function launchRocket() {
      const x = Math.random() * canvas.width;
      const targetY = canvas.height * (0.15 + Math.random() * 0.35);
      rockets.push({
        x, y: canvas.height,
        targetY,
        speed: 4 + Math.random() * 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        trail: []
      });
    }

    function explodeRocket(rocket) {
      const count = 30 + Math.floor(Math.random() * 40);
      const baseColor = rocket.color;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
        const speed = 1.5 + Math.random() * 4;
        const r = parseInt(baseColor.slice(1, 3), 16);
        const g = parseInt(baseColor.slice(3, 5), 16);
        const b = parseInt(baseColor.slice(5, 7), 16);
        particles.push({
          x: rocket.x, y: rocket.targetY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.008 + Math.random() * 0.012,
          r, g, b,
          size: 2 + Math.random() * 2,
          gravity: 0.03 + Math.random() * 0.02,
          sparkle: Math.random() > 0.5
        });
      }
    }

    let nextLaunch = 0;
    function frame(now) {
      const elapsed = now - startTime;
      if (elapsed > durationMs) {
        // Let remaining particles fade
        if (particles.length === 0 && rockets.length === 0) {
          canvas.remove();
          return;
        }
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';

      // Launch rockets periodically
      if (elapsed < durationMs) {
        nextLaunch -= 16;
        if (nextLaunch <= 0) {
          launchRocket();
          nextLaunch = 200 + Math.random() * 500;
          // Sometimes launch bursts
          if (Math.random() > 0.6) {
            setTimeout(() => { if (elapsed < durationMs) launchRocket(); }, 100);
            if (Math.random() > 0.5) {
              setTimeout(() => { if (elapsed < durationMs) launchRocket(); }, 200);
            }
          }
        }
      }

      // Update and draw rockets
      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.trail.push({ x: r.x, y: r.y });
        if (r.trail.length > 8) r.trail.shift();
        r.y -= r.speed;
        r.x += (Math.random() - 0.5) * 0.5;

        // Draw rocket trail
        for (let t = 0; t < r.trail.length; t++) {
          const alpha = t / r.trail.length * 0.6;
          ctx.beginPath();
          ctx.arc(r.trail[t].x, r.trail[t].y, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 220, 150, ${alpha})`;
          ctx.fill();
        }

        // Draw rocket head
        ctx.beginPath();
        ctx.arc(r.x, r.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffaa';
        ctx.fill();

        if (r.y <= r.targetY) {
          explodeRocket(r);
          rockets.splice(i, 1);
        }
      }

      // Update and draw particles
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.99;
        p.life -= p.decay;

        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }

        const alpha = p.life;
        const flicker = p.sparkle ? (0.7 + Math.random() * 0.3) : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha * flicker})`;
        ctx.fill();

        // Glow
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha * 0.15})`;
        ctx.fill();
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  flashStatus(text) {
    this.statusEl.textContent = text;
    // Revert after 2 seconds
    setTimeout(() => {
      if (game.status === 'playing') {
        if (game.turn === game.playerColor) {
          this.setStatus('Your turn - select a piece to move');
        } else {
          this.setStatus('AI is thinking...');
        }
      }
    }, 2000);
  }

  bindEvents() {
    document.getElementById('btn-new-game').addEventListener('click', () => {
      document.getElementById('game-over-banner').classList.add('hidden');
      game.newGame();
    });
    document.getElementById('btn-play-again').addEventListener('click', () => {
      document.getElementById('game-over-banner').classList.add('hidden');
      if (game.mode === 'online') {
        if (window.online) window.online.requestRematch();
      } else {
        game.newGame();
      }
    });
    document.getElementById('btn-pick-blue').addEventListener('click', () => {
      game.initGame(BLUE);
    });
    document.getElementById('btn-pick-red').addEventListener('click', () => {
      game.initGame(RED);
    });
    document.getElementById('btn-undo').addEventListener('click', () => game.undo());
    document.getElementById('btn-randomize').addEventListener('click', () => {
      if (game.status === 'setup') {
        game.randomizePlayerSetup();
        game.selectedCell = null;
        game.validMoves = [];
        ui.render();
        ui.setStatus('Pieces randomized! Arrange them or click Start Game.');
      }
    });
    document.getElementById('btn-start-game').addEventListener('click', () => {
      if (game.status !== 'setup') return;
      if (game.mode === 'online') {
        if (window.online) window.online.submitSetup();
      } else {
        game.startGame();
      }
    });

    // Save layout
    document.getElementById('btn-save-layout').addEventListener('click', () => {
      if (game.status !== 'setup') return;
      document.getElementById('layout-name').value = '';
      document.getElementById('save-modal').classList.remove('hidden');
      document.getElementById('layout-name').focus();
    });
    document.getElementById('btn-save-confirm').addEventListener('click', () => {
      const name = document.getElementById('layout-name').value.trim() || 'Untitled';
      game.saveLayout(name);
      document.getElementById('save-modal').classList.add('hidden');
      ui.setStatus(`Layout "${name}" saved!`);
    });
    document.getElementById('btn-save-cancel').addEventListener('click', () => {
      document.getElementById('save-modal').classList.add('hidden');
    });

    // Load layout
    document.getElementById('btn-load-layout').addEventListener('click', () => {
      if (game.status !== 'setup') return;
      this.showLayoutsModal();
    });
    document.getElementById('btn-layouts-close').addEventListener('click', () => {
      document.getElementById('layouts-modal').classList.add('hidden');
    });

    // View mode picker clicks
    document.querySelector('.view-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('.view-btn');
      if (!btn) return;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });

    // Tile design picker clicks
    document.getElementById('tile-design-picker').addEventListener('click', (e) => {
      const opt = e.target.closest('.tile-option');
      if (!opt) return;
      document.querySelectorAll('.tile-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
      document.getElementById('ai-difficulty').value = game.settings.aiDifficulty;
      document.getElementById('diff-label').textContent = game.settings.aiDifficulty;
      document.getElementById('two-squares').checked = game.settings.twoSquares;
      document.getElementById('show-all').checked = game.settings.showAll;
      // Select current view mode
      document.querySelectorAll('.view-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.view === game.settings.viewMode);
      });
      // Select current tile design
      document.querySelectorAll('.tile-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.tile === game.settings.tileDesign);
      });
      document.getElementById('music-enabled').checked = game.settings.musicEnabled;
      document.getElementById('music-volume').value = game.settings.musicVolume;
      document.getElementById('music-vol-label').textContent = game.settings.musicVolume + '%';
      document.getElementById('sfx-enabled').checked = game.settings.sfxEnabled;
      document.getElementById('sfx-volume').value = game.settings.sfxVolume;
      document.getElementById('sfx-vol-label').textContent = game.settings.sfxVolume + '%';
      document.getElementById('settings-modal').classList.remove('hidden');
    });

    document.getElementById('ai-difficulty').addEventListener('input', (e) => {
      document.getElementById('diff-label').textContent = e.target.value;
    });

    document.getElementById('music-volume').addEventListener('input', (e) => {
      document.getElementById('music-vol-label').textContent = e.target.value + '%';
    });

    document.getElementById('sfx-volume').addEventListener('input', (e) => {
      document.getElementById('sfx-vol-label').textContent = e.target.value + '%';
    });

    document.getElementById('btn-settings-ok').addEventListener('click', () => {
      game.settings.aiDifficulty = parseInt(document.getElementById('ai-difficulty').value);
      game.settings.twoSquares = document.getElementById('two-squares').checked;
      game.settings.showAll = document.getElementById('show-all').checked;

      // View mode
      const selectedView = document.querySelector('.view-btn.selected');
      if (selectedView) game.settings.viewMode = selectedView.dataset.view;

      // Tile design
      const selectedTile = document.querySelector('.tile-option.selected');
      if (selectedTile) game.settings.tileDesign = selectedTile.dataset.tile;

      // Music settings
      const musicEnabled = document.getElementById('music-enabled').checked;
      const musicVol = parseInt(document.getElementById('music-volume').value);
      game.settings.musicEnabled = musicEnabled;
      game.settings.musicVolume = musicVol;
      music.audio.volume = musicVol / 100;
      if (musicEnabled && !music.playing) {
        music.userMuted = false;
        music.toggle(false);
      } else if (!musicEnabled && music.playing) {
        music.toggle(true);
      }

      // SFX settings
      game.settings.sfxEnabled = document.getElementById('sfx-enabled').checked;
      game.settings.sfxVolume = parseInt(document.getElementById('sfx-volume').value);
      sfx.enabled = game.settings.sfxEnabled;
      sfx.volume = game.settings.sfxVolume / 100;

      // Save all settings to localStorage
      localStorage.setItem('stratego-settings', JSON.stringify(game.settings));

      document.getElementById('settings-modal').classList.add('hidden');
      ui.render();
    });

    document.getElementById('btn-settings-cancel').addEventListener('click', () => {
      document.getElementById('settings-modal').classList.add('hidden');
    });

    document.getElementById('btn-help').addEventListener('click', () => {
      document.getElementById('help-modal').classList.remove('hidden');
    });
    document.getElementById('btn-help-close').addEventListener('click', () => {
      document.getElementById('help-modal').classList.add('hidden');
    });
  }
}

// --- Sound Effects ---
const sfx = {
  swordFight: new Audio('sword-fight.mp3'),
  explosion: new Audio('explosion.mp3'),
  victory: new Audio('victory.mp3'),
  enabled: true,
  volume: 0.6,
  play(sound, volumeOverride) {
    if (!this.enabled) return;
    const s = sound.cloneNode();
    s.volume = volumeOverride != null ? volumeOverride : this.volume;
    s.play().catch(() => {});
  },
  combat(record) {
    if (!record || !record.defender) return;
    const isBomb = record.attacker.rank === RANK.BOMB || record.defender.rank === RANK.BOMB;
    if (isBomb) {
      this.play(this.explosion);
    } else {
      this.play(this.swordFight);
    }
  }
};

// --- Music ---
const music = {
  audio: new Audio('march-of-the-banners.mp3'),
  playing: false,
  userMuted: false, // tracks if user manually turned it off
  init() {
    this.audio.loop = true;
    this.audio.volume = 0.15;
    const btn = document.getElementById('btn-music');
    btn.addEventListener('click', () => this.toggle(true));
  },
  toggle(isUserAction) {
    const btn = document.getElementById('btn-music');
    if (this.playing) {
      this.audio.pause();
      this.audio.currentTime = this.audio.currentTime; // force stop
      this.playing = false;
      if (isUserAction) this.userMuted = true;
      btn.innerHTML = '&#x1F507; Music';
      btn.classList.add('muted');
    } else {
      this.audio.play().catch(() => {});
      this.playing = true;
      if (isUserAction) this.userMuted = false;
      btn.innerHTML = '&#x1F50A; Music';
      btn.classList.remove('muted');
    }
  },
  start() {
    // Don't auto-start if user manually muted
    if (!this.playing && !this.userMuted) this.toggle(false);
  }
};

// --- Init ---
let game, ui;
document.addEventListener('DOMContentLoaded', () => {
  game = new Game();
  ui = new UI();
  // Module scope no longer leaks these to global — expose for console debugging.
  window.game = game;
  window.ui = ui;
  ui.render();
  music.init();

  // Apply saved audio settings
  music.audio.volume = game.settings.musicVolume / 100;
  if (!game.settings.musicEnabled) music.userMuted = true;
  sfx.enabled = game.settings.sfxEnabled !== false;
  sfx.volume = (game.settings.sfxVolume || 60) / 100;
  console.log('Audio settings loaded:', { sfxEnabled: sfx.enabled, sfxVolume: sfx.volume, musicVolume: music.audio.volume });
});
