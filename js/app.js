(function () {
  "use strict";

  const CLUES = { easy: 44, medium: 34, hard: 26 };

  /* ---------- Scoring & persistent stats ---------- */

  const STORE_KEY = "sudoku.stats.v1";

  // Base reward and per-second time decay per difficulty.
  // Harder puzzles pay more and decay a little slower.
  const SCORING = {
    easy:   { base: 2000, perSecond: 2, perMistake: 100 },
    medium: { base: 4000, perSecond: 3, perMistake: 150 },
    hard:   { base: 6000, perSecond: 4, perMistake: 250 },
  };

  // Default shape; each difficulty tracks its own records.
  function emptyStats() {
    return {
      lastLevel: "easy",
      easy:   { bestScore: 0, bestTime: null, won: 0 },
      medium: { bestScore: 0, bestTime: null, won: 0 },
      hard:   { bestScore: 0, bestTime: null, won: 0 },
    };
  }

  // localStorage can throw (private mode, blocked, quota) — never let it break play.
  function loadStats() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyStats();
      const parsed = JSON.parse(raw);
      const stats = emptyStats();
      for (const lvl of ["easy", "medium", "hard"]) {
        if (parsed && parsed[lvl]) Object.assign(stats[lvl], parsed[lvl]);
      }
      if (parsed && SCORING[parsed.lastLevel]) stats.lastLevel = parsed.lastLevel;
      return stats;
    } catch (e) {
      return emptyStats();
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(stats));
    } catch (e) {
      /* storage unavailable — scores just won't persist this session */
    }
  }

  /* ---------- Settings ---------- */

  const SETTINGS_KEY = "sudoku.settings.v1";
  const DEFAULT_SETTINGS = { saveProgress: true, hideCompleted: true };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...(parsed || {}) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      /* ignore — settings just won't persist this session */
    }
  }

  /* ---------- In-progress game persistence ---------- */

  const PROGRESS_KEY = "sudoku.progress.v1";

  // Snapshot the current game so a reload can pick up where we left off.
  function saveProgress() {
    if (!settings.saveProgress) return;
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify({
        level, puzzle, solution, givens, mistakes, seconds, solved,
      }));
    } catch (e) {
      /* storage unavailable — progress just won't persist */
    }
  }

  function clearProgress() {
    try {
      localStorage.removeItem(PROGRESS_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // Returns a validated snapshot, or null when there's nothing usable to restore.
  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      const ok = p &&
        SCORING[p.level] &&
        Array.isArray(p.puzzle) && p.puzzle.length === 81 &&
        Array.isArray(p.solution) && p.solution.length === 81 &&
        Array.isArray(p.givens) && p.givens.length === 81;
      return ok ? p : null;
    } catch (e) {
      return null;
    }
  }

  function computeScore(lvl, secs, misses) {
    const s = SCORING[lvl];
    const score = s.base - secs * s.perSecond - misses * s.perMistake;
    // Always reward finishing, even a slow / messy solve.
    return Math.max(100, Math.round(score / 10) * 10);
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const r = (secs % 60).toString().padStart(2, "0");
    return `${m}:${r}`;
  }

  function updateBestDisplay() {
    const best = stats[level].bestScore;
    bestEl.textContent = best > 0 ? best.toLocaleString() : "—";
  }

  // Show the score the current solve would earn right now — it ticks down
  // with the timer and drops on each mistake. Frozen once solved.
  function updateScoreDisplay() {
    scoreEl.textContent = computeScore(level, seconds, mistakes).toLocaleString();
  }

  const boardEl = document.getElementById("board");
  const numpadEl = document.getElementById("numpad");
  const highlighterEl = document.getElementById("highlighter");
  const timerEl = document.getElementById("timer");
  const mistakesEl = document.getElementById("mistakes");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const toastEl = document.getElementById("toast");
  const settingsModal = document.getElementById("settingsModal");
  const saveProgressToggle = document.getElementById("saveProgressToggle");
  const hideCompletedToggle = document.getElementById("hideCompletedToggle");

  let solution = [];   // full solved grid (81)
  let puzzle = [];      // current state (81), 0 = empty
  let givens = [];      // boolean[81], true if clue
  let selected = -1;    // selected cell index
  let highlightDigit = 0; // digit lit up via the highlighter bar (0 = none)
  let mistakes = 0;
  let stats = loadStats();
  let settings = loadSettings();
  let level = stats.lastLevel;
  let timerId = null;
  let seconds = 0;
  let solved = false;

  /* ---------- Sudoku generation ---------- */

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function canPlace(grid, idx, val) {
    const row = Math.floor(idx / 9);
    const col = idx % 9;
    for (let c = 0; c < 9; c++) if (grid[row * 9 + c] === val) return false;
    for (let r = 0; r < 9; r++) if (grid[r * 9 + col] === val) return false;
    const br = Math.floor(row / 3) * 3;
    const bc = Math.floor(col / 3) * 3;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        if (grid[(br + r) * 9 + (bc + c)] === val) return false;
    return true;
  }

  // Fill a complete valid grid via randomized backtracking.
  function fillGrid(grid, pos) {
    if (pos === 81) return true;
    if (grid[pos] !== 0) return fillGrid(grid, pos + 1);
    const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const n of nums) {
      if (canPlace(grid, pos, n)) {
        grid[pos] = n;
        if (fillGrid(grid, pos + 1)) return true;
        grid[pos] = 0;
      }
    }
    return false;
  }

  // Count solutions (capped at 2) to check uniqueness.
  function countSolutions(grid, limit) {
    let count = 0;
    function solve(pos) {
      if (count >= limit) return;
      if (pos === 81) { count++; return; }
      if (grid[pos] !== 0) { solve(pos + 1); return; }
      for (let n = 1; n <= 9; n++) {
        if (canPlace(grid, pos, n)) {
          grid[pos] = n;
          solve(pos + 1);
          grid[pos] = 0;
          if (count >= limit) return;
        }
      }
    }
    solve(0);
    return count;
  }

  function generate(targetClues) {
    const full = new Array(81).fill(0);
    fillGrid(full, 0);
    solution = full.slice();

    const puz = full.slice();
    const order = shuffle([...Array(81).keys()]);
    let clues = 81;

    for (const idx of order) {
      if (clues <= targetClues) break;
      const backup = puz[idx];
      puz[idx] = 0;
      // keep the puzzle uniquely solvable
      const test = puz.slice();
      if (countSolutions(test, 2) !== 1) {
        puz[idx] = backup; // revert, removal broke uniqueness
      } else {
        clues--;
      }
    }
    return puz;
  }

  /* ---------- Rendering ---------- */

  function buildBoard() {
    boardEl.innerHTML = "";
    for (let i = 0; i < 81; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = Math.floor(i / 9);
      cell.dataset.col = i % 9;
      cell.dataset.idx = i;
      boardEl.appendChild(cell);
    }
  }

  function render() {
    const cells = boardEl.children;
    const selRow = selected >= 0 ? Math.floor(selected / 9) : -1;
    const selCol = selected >= 0 ? selected % 9 : -1;
    const selVal = selected >= 0 ? puzzle[selected] : 0;

    for (let i = 0; i < 81; i++) {
      const cell = cells[i];
      const val = puzzle[i];
      cell.textContent = val === 0 ? "" : val;
      cell.className = "cell";
      if (givens[i]) cell.classList.add("given");

      const row = Math.floor(i / 9), col = i % 9;

      if (selected >= 0) {
        if (i === selected) cell.classList.add("selected");
        else if (row === selRow || col === selCol ||
                 (Math.floor(row / 3) === Math.floor(selRow / 3) &&
                  Math.floor(col / 3) === Math.floor(selCol / 3)))
          cell.classList.add("highlight");
        if (selVal !== 0 && val === selVal && i !== selected)
          cell.classList.add("same");
      }

      // mark wrong entries (non-givens that disagree with the solution)
      if (val !== 0 && !givens[i] && val !== solution[i])
        cell.classList.add("error");

      // light up every cell holding the digit picked in the highlighter bar
      if (highlightDigit !== 0 && val === highlightDigit)
        cell.classList.add("hl");
    }

    updateNumpad();
    updateHighlighter();
  }

  // A digit is "done" once all nine of it sit in their correct cells.
  function isDigitDone(n) {
    let count = 0;
    for (let i = 0; i < 81; i++)
      if (puzzle[i] === n && solution[i] === n) count++;
    return count >= 9;
  }

  // Disable a digit once all nine of it are correctly placed — there's
  // nowhere left to put it, so swap the key's label for an "✕".
  function updateNumpad() {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 81; i++) {
      const v = puzzle[i];
      if (v !== 0 && v === solution[i]) counts[v]++;
    }
    numpadEl.querySelectorAll("button[data-n]").forEach(btn => {
      const n = Number(btn.dataset.n);
      if (n === 0) return; // the Erase key is never disabled
      const done = counts[n] >= 9;
      btn.disabled = done;
      btn.classList.toggle("done", done);
      btn.textContent = done ? "✕" : String(n);
    });
  }

  // Reflect the highlighter bar: which digit is active, and how many of each
  // are still left to place correctly.
  function updateHighlighter() {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 81; i++) {
      const v = puzzle[i];
      if (v !== 0 && v === solution[i]) counts[v]++;
    }
    // With "hide finished numbers" on, a fully-placed digit drops off the bar;
    // clear its highlight too so no stray cells stay lit after it disappears.
    if (highlightDigit !== 0 && settings.hideCompleted && counts[highlightDigit] >= 9) {
      highlightDigit = 0;
      for (const cell of boardEl.children) cell.classList.remove("hl");
    }
    highlighterEl.querySelectorAll("button[data-h]").forEach(btn => {
      const n = Number(btn.dataset.h);
      const left = Math.max(0, 9 - counts[n]);
      const done = left === 0;
      const hidden = done && settings.hideCompleted;
      btn.hidden = hidden;
      btn.classList.toggle("active", highlightDigit === n);
      btn.classList.toggle("done", done && !hidden);
      const small = btn.querySelector("small");
      if (small) small.textContent = done ? "✓" : `${left} left`;
    });
  }

  /* ---------- Game flow ---------- */

  function startTimer(resumeFrom = 0) {
    stopTimer();
    seconds = resumeFrom;
    timerEl.textContent = formatTime(seconds);
    updateScoreDisplay();
    timerId = setInterval(() => {
      seconds++;
      timerEl.textContent = formatTime(seconds);
      updateScoreDisplay();
    }, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  function syncDifficultyButtons() {
    document.querySelectorAll("#difficulty button")
      .forEach(b => b.classList.toggle("active", b.dataset.level === level));
  }

  function newGame() {
    solved = false;
    mistakes = 0;
    mistakesEl.textContent = "0";
    selected = -1;
    highlightDigit = 0;
    toastEl.classList.remove("show");
    puzzle = generate(CLUES[level]);
    givens = puzzle.map(v => v !== 0);
    updateBestDisplay();
    render();
    startTimer();
    saveProgress();
  }

  // Restore a game saved on a previous visit (see loadProgress for validation).
  function restoreGame(p) {
    level = p.level;
    stats.lastLevel = level;
    solution = p.solution.slice();
    puzzle = p.puzzle.slice();
    givens = p.givens.slice();
    mistakes = p.mistakes || 0;
    seconds = p.seconds || 0;
    solved = !!p.solved;
    selected = -1;
    highlightDigit = 0;
    mistakesEl.textContent = mistakes;
    toastEl.classList.remove("show");
    syncDifficultyButtons();
    updateBestDisplay();
    render();
    if (solved) {
      stopTimer();
      timerEl.textContent = formatTime(seconds);
      updateScoreDisplay();
    } else {
      startTimer(seconds);
    }
  }

  function placeNumber(n) {
    if (solved || selected < 0 || givens[selected]) return;
    // ignore a digit that's already fully placed (keyboard mirrors the disabled key)
    if (n !== 0 && isDigitDone(n)) return;
    const prev = puzzle[selected];
    puzzle[selected] = n;

    // count a mistake only on a fresh wrong entry
    if (n !== 0 && n !== solution[selected] && prev !== n) {
      mistakes++;
      mistakesEl.textContent = mistakes;
      updateScoreDisplay();
    }
    render();
    checkWin();
    saveProgress();
  }

  function checkWin() {
    for (let i = 0; i < 81; i++)
      if (puzzle[i] !== solution[i]) return;
    solved = true;
    stopTimer();
    selected = -1;
    render();
    recordWin();
  }

  function recordWin() {
    const score = computeScore(level, seconds, mistakes);
    const rec = stats[level];

    rec.won++;
    const newBestScore = score > rec.bestScore;
    const newBestTime = rec.bestTime === null || seconds < rec.bestTime;
    if (newBestScore) rec.bestScore = score;
    if (newBestTime) rec.bestTime = seconds;
    saveStats();
    updateBestDisplay();

    let html = `Solved! 🎉<span class="sub">+${score.toLocaleString()} pts` +
               ` &middot; ${formatTime(seconds)} &middot; ${mistakes} mistake${mistakes === 1 ? "" : "s"}</span>`;
    if (newBestScore || newBestTime) {
      const label = newBestScore && newBestTime ? "New best score & time!"
                  : newBestScore ? "New best score!" : "New best time!";
      html += `<span class="newbest">⭐ ${label}</span>`;
    }
    toastEl.innerHTML = html;
    toastEl.classList.add("show");
  }

  /* ---------- Input ---------- */

  boardEl.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    selected = Number(cell.dataset.idx);
    render();
  });

  document.getElementById("numpad").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    placeNumber(Number(btn.dataset.n));
  });

  // Toggle highlighting of a digit across the board; tapping the active one clears it.
  highlighterEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const n = Number(btn.dataset.h);
    highlightDigit = highlightDigit === n ? 0 : n;
    render();
  });

  document.getElementById("difficulty").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    level = btn.dataset.level;
    stats.lastLevel = level;
    saveStats();
    document.querySelectorAll("#difficulty button")
      .forEach(b => b.classList.toggle("active", b === btn));
    newGame();
  });

  document.getElementById("newGame").addEventListener("click", newGame);

  /* ---------- Settings menu ---------- */

  function openSettings() {
    saveProgressToggle.checked = settings.saveProgress;
    hideCompletedToggle.checked = settings.hideCompleted;
    settingsModal.hidden = false;
  }

  function closeSettings() {
    settingsModal.hidden = true;
  }

  document.getElementById("settingsBtn").addEventListener("click", openSettings);
  document.getElementById("closeSettings").addEventListener("click", closeSettings);

  // Click on the dimmed backdrop (but not the card) closes the menu.
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  saveProgressToggle.addEventListener("change", () => {
    settings.saveProgress = saveProgressToggle.checked;
    saveSettings();
    // Honour the new choice right away: persist the live game, or wipe it.
    if (settings.saveProgress) saveProgress();
    else clearProgress();
  });

  hideCompletedToggle.addEventListener("change", () => {
    settings.hideCompleted = hideCompletedToggle.checked;
    saveSettings();
    render(); // re-apply the highlighter bar with the new choice
  });

  // Capture the latest state (including the running timer) before leaving.
  window.addEventListener("pagehide", saveProgress);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveProgress();
  });

  // keyboard support (handy on tablets with a keyboard, and desktop)
  document.addEventListener("keydown", (e) => {
    if (!settingsModal.hidden) {
      if (e.key === "Escape") closeSettings();
      return; // don't drive the board while the menu is open
    }
    if (e.key >= "1" && e.key <= "9") placeNumber(Number(e.key));
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") placeNumber(0);
    else if (selected >= 0 && ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) {
      const row = Math.floor(selected / 9), col = selected % 9;
      if (e.key === "ArrowUp" && row > 0) selected -= 9;
      if (e.key === "ArrowDown" && row < 8) selected += 9;
      if (e.key === "ArrowLeft" && col > 0) selected -= 1;
      if (e.key === "ArrowRight" && col < 8) selected += 1;
      e.preventDefault();
      render();
    }
  });

  /* ---------- Boot ---------- */
  buildBoard();
  const saved = settings.saveProgress ? loadProgress() : null;
  if (saved) {
    restoreGame(saved);
  } else {
    syncDifficultyButtons();
    newGame();
  }
})();
