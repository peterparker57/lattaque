# L'Attaque

A browser-based reimplementation of *L'Attaque*, the 1908 French wargame by Hermance Edan that became the basis for many later hidden-rank strategy games.

Two armies of forty pieces each face off across a board with two impassable lakes. Each piece holds a hidden rank; reveal them only by moving onto an enemy. Capture the enemy flag — or eliminate every piece they can move — to win.

## Play

Open `index.html` in any modern browser, or visit the hosted version. No install, no server.

The AI runs in a Web Worker so it doesn't lock the UI. Difficulty maps to think time: difficulty² × 10 ms (10 = 1 s, 20 = 4 s, 30 = 9 s).

## Features

- 2D top-down or 3D perspective board
- Adjustable AI difficulty (1–30)
- Six tile-back designs
- Save and reload your own setup layouts
- Two-Squares rule toggle
- Music and SFX with independent volume

## Credits

AI ported from [braathwaate/stratego](https://github.com/braathwaate/stratego) (Java). Minimax with alpha-beta pruning, iterative deepening, transposition tables, killer-move heuristic, and quiescent search.
