(function () {
  "use strict";

  // -------------------------- boards --------------------------
  // A board is a virtual coordinate space, not a screen size. The canvas
  // always fills the same rectangle; picking a smaller board just means
  // fewer units span it, so the fixed-unit tiles are drawn larger and the
  // table effectively holds less. Nothing about the layout moves.
  const BOARDS = [
    { key: "300", label: "300 × 400", w: 300, h: 400 },
    { key: "360", label: "360 × 480", w: 360, h: 480 },
    { key: "450", label: "450 × 600", w: 450, h: 600 },
  ];
  const DEFAULT_BOARD = "450";
  const BOARD_KEY = "yeetable.board";

  function boardSpec(key) {
    return BOARDS.find(function (b) {
      return b.key === key;
    });
  }

  let board = null;
  try {
    board = boardSpec(localStorage.getItem(BOARD_KEY));
  } catch (e) {
    // storage blocked; fall through to the default
  }
  if (!board) {
    board = boardSpec(DEFAULT_BOARD);
  }

  // -------------------------- layout --------------------------
  // Table is 3:4 (width:height) - the final pick. No loss condition yet;
  // this build is for feeling out the physics.
  const PLAY_W_RATIO = 3;
  const PLAY_H_RATIO = 4;
  // The control strip never gets shorter than this fraction of the table's
  // width, measured off a real phone screenshot and rounded to 250/450.
  const CONTROL_MIN_RATIO = 5 / 9;
  const MAX_CANVAS_W = 480;

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const hud = document.getElementById("hud");
  const autoWrap = document.getElementById("autowrap");
  const eyeWrap = document.getElementById("eyewrap");

  // Everything below this line is in board units, never pixels. `scale` is
  // the only bridge between the two, and only layout, drawing and pointer
  // input ever touch it.
  let width = 0;
  let height = 0;
  let playHeight = 0;
  let scale = 1;

  function layout() {
    const winH = window.innerHeight;
    // Table height plus the control minimum, both expressed as multiples
    // of the canvas width, gives the widest canvas the window can hold.
    const stack = PLAY_H_RATIO / PLAY_W_RATIO + CONTROL_MIN_RATIO;
    const wPx = Math.min(window.innerWidth, MAX_CANVAS_W, winH / stack);

    scale = wPx / board.w;
    width = board.w;
    playHeight = board.h;
    height = winH / scale;

    // Match the canvas's raster resolution to the display's real pixel
    // density, or fine detail (tile numbers especially) gets upscaled and
    // blurred on any HiDPI phone screen.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wPx * dpr;
    canvas.height = winH * dpr;
    canvas.style.width = wPx + "px";
    canvas.style.height = winH + "px";
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);

    // The HUD sits over the table, not the browser window - it needs to
    // match the canvas's actual footprint, not the viewport's.
    hud.style.left = "50%";
    hud.style.width = wPx + "px";
    hud.style.transform = "translateX(-50%)";
    autoWrap.style.left = "50%";
    autoWrap.style.width = wPx + "px";
    autoWrap.style.transform = "translateX(-50%)";
    eyeWrap.style.left = "50%";
    eyeWrap.style.width = wPx + "px";
    eyeWrap.style.transform = "translateX(-50%)";
  }
  layout();

  // -------------------------- tile values --------------------------
  // Borrowed wholesale from hex2-core.js's TILE_HSL so both games read as part
  // of the same family. This is hex2^'s full solid ladder; its two gradient
  // tiers above 262144 are not ported.
  const TILE_HSL = {
    1: [0, 66, 84],
    2: [0, 66, 66],
    4: [0, 69, 55],
    8: [23, 78, 52],
    16: [41, 92, 49],
    32: [56, 88, 56],
    64: [80, 78, 52],
    128: [128, 88, 43],
    256: [152, 66, 60],
    512: [189, 66, 59],
    1024: [211, 80, 54],
    2048: [224, 79, 51],
    4096: [228, 92, 35],
    8192: [246, 66, 58],
    16384: [269, 66, 60],
    32768: [286, 68, 70],
    65536: [305, 66, 54],
    131072: [328, 81, 50],
    262144: [348, 55, 48],
  };
  const TOP_SOLID = 262144;

  function hslToRgb(h, s, l) {
    const hh = h / 360;
    const a = s * Math.min(l, 1 - l);
    function channel(n) {
      const k = (n + hh * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [channel(0), channel(8), channel(4)];
  }

  function tileColours(value) {
    const hsl = TILE_HSL[value] || TILE_HSL[TOP_SOLID];
    const fill = "hsl(" + hsl[0] + ", " + hsl[1] + "%, " + hsl[2] + "%)";
    const rgb = hslToRgb(hsl[0], hsl[1] / 100, hsl[2] / 100);
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    let text = "#ffffff";
    if (lum > 0.45) {
      text = "#171a1f";
    }
    return { fill: fill, text: text };
  }

  // Linear size growth, exponential value labels. Units, so a tile is the
  // same fraction of a given board on every device.
  const BASE_RADIUS = 16;
  const RADIUS_STEP = 4;

  function radiusFor(value) {
    const level = Math.round(Math.log2(value)) - 1;
    return BASE_RADIUS + level * RADIUS_STEP;
  }

  // -------------------------- physics world --------------------------
  const Engine = Matter.Engine;
  const World = Matter.World;
  const Bodies = Matter.Bodies;
  const Body = Matter.Body;
  const Events = Matter.Events;

  const engine = Engine.create();
  engine.gravity.x = 0;
  engine.gravity.y = 0;

  const WALL_T = 400;
  let walls = [];

  function buildWalls() {
    if (walls.length) {
      World.remove(engine.world, walls);
    }
    walls = [
      Bodies.rectangle(width / 2, -WALL_T / 2, width + WALL_T * 2, WALL_T,
        { isStatic: true, restitution: 1 }),
      Bodies.rectangle(width / 2, height + WALL_T / 2, width + WALL_T * 2,
        WALL_T, { isStatic: true, restitution: 1 }),
      Bodies.rectangle(-WALL_T / 2, height / 2, WALL_T, height + WALL_T * 2,
        { isStatic: true, restitution: 1 }),
      Bodies.rectangle(width + WALL_T / 2, height / 2, WALL_T,
        height + WALL_T * 2, { isStatic: true, restitution: 1 }),
    ];
    World.add(engine.world, walls);
  }
  buildWalls();

  // Only the canvas height in units moves on resize, so the tiles keep
  // their coordinates and just the south wall shifts.
  window.addEventListener("resize", function () {
    layout();
    buildWalls();
  });

  // No air drag at all - the only things that bleed energy now are the solver's
  // contact losses and merges averaging two velocities into one.
  const FRICTION_AIR = 0;
  // Shared by the thrown release and the Auto button, so both cap at one
  // number rather than drifting apart.
  const MAX_SPEED = 60;
  let nextId = 1;

  function makeTile(x, y, value) {
    const r = radiusFor(value);
    const body = Bodies.circle(x, y, r, {
      frictionAir: FRICTION_AIR,
      restitution: 1,
      friction: 0,
    });
    body.tileId = nextId++;
    body.value = value;
    body.merging = false;
    World.add(engine.world, body);
    return body;
  }

  function randomStartValue() {
    if (Math.random() < 0.8) {
      return 1;
    }
    return 2;
  }

  // Grabbability is purely positional: any tile that hasn't crossed into
  // the play area yet (body.crossedIntoPlay is falsy) is fair game to pick
  // up, whatever it's doing. dragTarget is just whichever one a finger
  // currently has hold of, if any.
  let dragTarget = null;
  let dragging = false;

  // The effective pause - derived from the button and the window's focus,
  // and read by the runner, the pointer handler and the save timer. Nothing
  // is torn down when it flips, so a stuck pause is visible rather than
  // silently killing autosave.
  let paused = false;

  function spawnPoint() {
    return {
      x: width / 2,
      y: playHeight + (height - playHeight) * 0.7,
    };
  }

  function spawnTile() {
    const p = spawnPoint();
    return makeTile(p.x, p.y, randomStartValue());
  }

  function clearTiles() {
    for (const body of Matter.Composite.allBodies(engine.world)) {
      if (body.isStatic || !body.value) continue;
      World.remove(engine.world, body);
    }
    // A removed tile can never cross, so a stale pending would block Auto
    // for good.
    autoPending = null;
  }

  // -------------------------- score --------------------------
  // Best is shared across every board; only the save is per-board.
  const BEST_KEY = "yeetable.best";
  const bestEl = document.getElementById("best");
  let score = 0;
  let best = 0;
  try {
    best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
  } catch (e) {}
  bestEl.textContent = String(best);

  function setScore(v) {
    score = v;
    scoreEl.textContent = String(score);
  }

  function addScore(v) {
    setScore(score + v);
    if (score > best) {
      best = score;
      bestEl.textContent = String(best);
      try {
        localStorage.setItem(BEST_KEY, String(best));
      } catch (e) {}
    }
  }

  // -------------------------- save / restore --------------------------
  // Raw snapshot, mid-motion and all - no "wait until it settles" logic,
  // just every tile's exact position/velocity/value dumped as-is. Board
  // units, so a save means the same thing on any screen.
  const SAVE_PREFIX = "yeetable.save.";
  const SAVE_INTERVAL = 30000;

  function saveKey() {
    return SAVE_PREFIX + board.key;
  }

  function saveState() {
    const tiles = [];
    for (const body of Matter.Composite.allBodies(engine.world)) {
      if (body.isStatic || !body.value) continue;
      tiles.push({
        x: body.position.x,
        y: body.position.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        value: body.value,
        crossedIntoPlay: !!body.crossedIntoPlay,
      });
    }
    const payload = { tiles: tiles, score: score };
    try {
      localStorage.setItem(saveKey(), JSON.stringify(payload));
    } catch (e) {}
  }
  // Guarded here rather than inside saveState, so Save Now still works
  // while paused instead of becoming a dead button.
  setInterval(function () {
    if (paused) return;
    saveState();
  }, SAVE_INTERVAL);
  document.getElementById("savenow").addEventListener("click", saveState);

  function loadState() {
    let data = null;
    try {
      const raw = localStorage.getItem(saveKey());
      if (raw) data = JSON.parse(raw);
    } catch (e) {}
    if (!data || !Array.isArray(data.tiles) || !data.tiles.length) {
      return false;
    }
    for (const t of data.tiles) {
      const body = makeTile(t.x, t.y, t.value);
      Body.setVelocity(body, { x: t.vx, y: t.vy });
      body.crossedIntoPlay = !!t.crossedIntoPlay;
    }
    if (typeof data.score === "number") {
      setScore(data.score);
    }
    return true;
  }

  // -------------------------- new game --------------------------
  function newGame() {
    clearTiles();
    dragTarget = null;
    dragging = false;
    setScore(0);
    try {
      localStorage.removeItem(saveKey());
    } catch (e) {}
    spawnTile();
  }
  document.getElementById("newgame").addEventListener("click", newGame);

  // -------------------------- board switching --------------------------
  // Each board keeps its own save, so switching parks the current one and
  // resumes the other exactly where it was left. No reload: the board only
  // feeds layout and the wall positions.
  function switchBoard(key) {
    const next = boardSpec(key);
    if (!next || next.key === board.key) {
      return;
    }
    saveState();
    clearTiles();
    dragTarget = null;
    dragging = false;
    board = next;
    try {
      localStorage.setItem(BOARD_KEY, board.key);
    } catch (e) {}
    layout();
    buildWalls();
    setScore(0);
    if (!loadState()) {
      spawnTile();
    }
  }

  const boardSel = document.getElementById("boardsel");
  for (const b of BOARDS) {
    const opt = document.createElement("option");
    opt.value = b.key;
    opt.textContent = b.label;
    boardSel.appendChild(opt);
  }
  boardSel.value = board.key;
  boardSel.addEventListener("change", function () {
    switchBoard(boardSel.value);
  });

  if (!loadState()) {
    spawnTile();
  }

  // -------------------------- merging --------------------------
  Events.on(engine, "collisionStart", function (evt) {
    for (const pair of evt.pairs) {
      const a = pair.bodyA;
      const b = pair.bodyB;
      if (!a.value || !b.value) continue;
      if (a.merging || b.merging) continue;
      if (a.value !== b.value) continue;
      if (a === dragTarget || b === dragTarget) continue;
      // Merging is the table's job. Two tiles loose in the control strip
      // just bounce off each other - otherwise Infinite Balls turns the
      // strip into a second board you never have to throw from.
      if (!a.crossedIntoPlay && !b.crossedIntoPlay) continue;

      a.merging = true;
      b.merging = true;

      const midX = (a.position.x + b.position.x) / 2;
      const midY = (a.position.y + b.position.y) / 2;
      const vx = (a.velocity.x + b.velocity.x) / 2;
      const vy = (a.velocity.y + b.velocity.y) / 2;
      const newValue = a.value * 2;

      // Auto's gate waits on a specific body crossing the line. A merged
      // parent is out of the world and never will, so stop waiting on it.
      if (a === autoPending || b === autoPending) {
        autoPending = null;
      }

      World.remove(engine.world, [a, b]);
      const merged = makeTile(midX, midY, newValue);
      Body.setVelocity(merged, { x: vx, y: vy });
      // A merge shouldn't un-earn passage either parent already had.
      if (a.crossedIntoPlay || b.crossedIntoPlay) {
        merged.crossedIntoPlay = true;
      }

      addScore(newValue);
    }
  });

  // ------------------- semi-permeable boundary -------------------
  // The play-area/control-strip line: freely crossable on the way up,
  // sealed shut once a tile is fully inside the play area. Not tied to any
  // loss condition - this is the table itself.
  Events.on(engine, "afterUpdate", function () {
    const bodies = Matter.Composite.allBodies(engine.world);
    let anyInControl = false;
    for (const body of bodies) {
      if (body.isStatic || !body.value) continue;
      const r = body.circleRadius;
      if (!body.crossedIntoPlay) {
        if (body.position.y + r <= playHeight) {
          body.crossedIntoPlay = true;
        } else {
          anyInControl = true;
        }
        continue;
      }
      if (body.position.y + r > playHeight) {
        Body.setPosition(body, { x: body.position.x, y: playHeight - r });
        if (body.velocity.y > 0) {
          // Bounce back into the play area instead of freezing dead -
          // it's a wall, not flypaper.
          Body.setVelocity(body, {
            x: body.velocity.x,
            y: -body.velocity.y,
          });
        }
      }
    }

    // Keep the control strip stocked - spawn a fresh tile only once it's
    // completely empty of un-launched ones.
    if (!anyInControl) {
      spawnTile();
    }
  });

  // ------------------ dragging (pointer events) ------------------
  let history = [];

  // Client pixels in, board units out.
  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (dragging || paused) return;
    const p = pointerPos(e);
    if (p.y <= playHeight) return;
    // Any tap anywhere in the control area snaps the nearest tile still
    // down there straight to the finger - no need to land the tap
    // precisely on the tile itself.
    const bodies = Matter.Composite.allBodies(engine.world);
    let pick = null;
    let pickDist = Infinity;
    for (const body of bodies) {
      if (body.isStatic || !body.value || body.merging) continue;
      if (body.crossedIntoPlay) continue;
      const dx = p.x - body.position.x;
      const dy = p.y - body.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < pickDist) {
        pick = body;
        pickDist = dist;
      }
    }
    if (!pick) return;
    dragTarget = pick;
    dragging = true;
    const r = radiusFor(pick.value);
    const x = Math.min(Math.max(p.x, r), width - r);
    const y = Math.min(Math.max(p.y, playHeight + r), height - r);
    Body.setPosition(dragTarget, { x: x, y: y });
    Body.setVelocity(dragTarget, { x: 0, y: 0 });
    history = [{ x: x, y: y, t: performance.now() }];
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", function (e) {
    if (!dragging || !dragTarget) return;
    const p = pointerPos(e);
    const r = radiusFor(dragTarget.value);
    // Dragging is confined to the control strip - crossing into the play
    // area only happens on release, via velocity, never by hand.
    const x = Math.min(Math.max(p.x, r), width - r);
    const y = Math.min(Math.max(p.y, playHeight + r), height - r);
    Body.setPosition(dragTarget, { x: x, y: y });
    Body.setVelocity(dragTarget, { x: 0, y: 0 });
    history.push({ x: x, y: y, t: performance.now() });
    if (history.length > 5) history.shift();
  });

  function releaseDrag() {
    if (!dragging || !dragTarget) return;
    dragging = false;

    const last = history[history.length - 1];
    const first = history[0];
    let vx = 0;
    let vy = 0;
    if (last && first && last.t !== first.t) {
      const dt = last.t - first.t;
      vx = ((last.x - first.x) / dt) * (1000 / 60);
      vy = ((last.y - first.y) / dt) * (1000 / 60);
    }
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > MAX_SPEED) {
      vx = (vx / speed) * MAX_SPEED;
      vy = (vy / speed) * MAX_SPEED;
    }

    Body.setVelocity(dragTarget, { x: vx, y: vy });
    dragTarget = null;
  }

  canvas.addEventListener("pointerup", releaseDrag);
  canvas.addEventListener("pointercancel", releaseDrag);

  // -------------------------- auto launch --------------------------
  // A throw without a swipe. Direction is uniform over the circle minus a
  // band either side of the horizontal - with no air drag, a shallow shot
  // just rattles wall to wall forever without ever climbing to the table.
  const SHALLOW_BAND = 10 * (Math.PI / 180);

  function randomLaunchAngle() {
    const arc = Math.PI - SHALLOW_BAND * 2;
    const pick = Math.random() * arc * 2;
    if (pick < arc) {
      return SHALLOW_BAND + pick;
    }
    return Math.PI + SHALLOW_BAND + (pick - arc);
  }

  // A fresh ball's own footprint at the spawn point; anything overlapping
  // that counts as sitting in the spawn area.
  const SPAWN_AREA = BASE_RADIUS;

  function tileInSpawnArea() {
    const p = spawnPoint();
    let pick = null;
    let pickDist = Infinity;
    for (const body of Matter.Composite.allBodies(engine.world)) {
      if (body.isStatic || !body.value || body.merging) continue;
      if (body.crossedIntoPlay) continue;
      const dx = body.position.x - p.x;
      const dy = body.position.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > body.circleRadius + SPAWN_AREA) continue;
      if (dist < pickDist) {
        pick = body;
        pickDist = dist;
      }
    }
    return pick;
  }

  function findUnlaunched() {
    for (const body of Matter.Composite.allBodies(engine.world)) {
      if (body.isStatic || !body.value || body.merging) continue;
      if (body.crossedIntoPlay) continue;
      return body;
    }
    return null;
  }

  // The tile this button last fired, held until it clears the boundary.
  // Gating on "any un-launched tile exists" would disable Auto forever,
  // since afterUpdate restocks the strip the moment it empties.
  let autoPending = null;

  function autoBlocked() {
    if (!autoOpts.disableUntilOut) {
      return false;
    }
    if (!autoPending) {
      return false;
    }
    if (autoPending.crossedIntoPlay) {
      autoPending = null;
      return false;
    }
    return true;
  }

  function autoLaunch() {
    if (paused) return;
    if (autoBlocked()) return;

    let tile = null;
    if (autoOpts.infiniteBalls) {
      // Throw whoever is standing on the spawn point, and only make a new
      // ball when nobody is. Creating one on top of another would have
      // Matter resolve the overlap with a separation impulse landing on
      // top of the launch velocity, well past MAX_SPEED. Fired in place,
      // since it is already where it needs to be.
      tile = tileInSpawnArea();
      if (!tile) {
        tile = spawnTile();
      }
      if (tile === dragTarget) {
        dragging = false;
        dragTarget = null;
      }
    } else {
      tile = findUnlaunched();
      if (!tile) return;
      // Takes over a tile already loose down there, finger or not.
      if (tile === dragTarget) {
        dragging = false;
        dragTarget = null;
      }
      const p = spawnPoint();
      Body.setPosition(tile, { x: p.x, y: p.y });
    }

    const angle = randomLaunchAngle();
    const lo = autoOpts.speedMin / 100;
    const hi = autoOpts.speedMax / 100;
    // Thumbs together collapses this to a constant, which is the fixed
    // speed case falling out for free.
    const speed = MAX_SPEED * (lo + Math.random() * (hi - lo));
    Body.setVelocity(tile, {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    });
    autoPending = tile;
  }

  // ------------------------ auto options ------------------------
  // Long-press or right-click Auto. Wording never changes; the leading
  // mark carries the state. All three combine freely.
  const AUTO_OPTS_KEY = "yeetable.autoopts";
  const LONG_PRESS_MS = 450;
  const autoBtn = document.getElementById("auto");
  const autoMenu = document.getElementById("automenu");

  // Percentages of MAX_SPEED, which is in board units - so a given percent
  // is the same fraction of the table on every board. Zero would never
  // arrive, but with no air drag any non-zero speed eventually does.
  const SPEED_FLOOR = 1;
  const IDLE_MIN = 1;
  const IDLE_MAX = 20;
  const AUTO_FLAGS = [
    "disableUntilOut",
    "showWhenHidden",
    "infiniteBalls",
    "idleOn",
  ];

  const autoOpts = {
    disableUntilOut: false,
    showWhenHidden: false,
    infiniteBalls: false,
    speedMin: 50,
    speedMax: 100,
    idleOn: false,
    idleSeconds: 4,
  };

  function clampPct(n) {
    return Math.min(Math.max(Math.round(n), SPEED_FLOOR), 100);
  }

  function clampIdle(n) {
    return Math.min(Math.max(Math.round(n), IDLE_MIN), IDLE_MAX);
  }

  try {
    const raw = localStorage.getItem(AUTO_OPTS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const key of AUTO_FLAGS) {
        autoOpts[key] = !!saved[key];
      }
      if (typeof saved.speedMin === "number") {
        autoOpts.speedMin = clampPct(saved.speedMin);
      }
      if (typeof saved.speedMax === "number") {
        autoOpts.speedMax = clampPct(saved.speedMax);
      }
      if (autoOpts.speedMin > autoOpts.speedMax) {
        autoOpts.speedMin = autoOpts.speedMax;
      }
      if (typeof saved.idleSeconds === "number") {
        autoOpts.idleSeconds = clampIdle(saved.idleSeconds);
      }
    }
  } catch (e) {}

  function saveAutoOpts() {
    try {
      localStorage.setItem(AUTO_OPTS_KEY, JSON.stringify(autoOpts));
    } catch (e) {}
  }

  function renderAutoOpts() {
    for (const row of autoMenu.querySelectorAll(".opt")) {
      const on = autoOpts[row.dataset.opt];
      row.classList.toggle("on", on);
      let mark = "✗";
      if (on) {
        mark = "✓";
      }
      row.querySelector(".mark").textContent = mark;
    }
    document.body.classList.toggle("auto-always", autoOpts.showWhenHidden);
    renderSpeed();
  }

  // ------------------------ speed slider ------------------------
  const speedTrack = document.getElementById("speedtrack");
  const speedFill = document.getElementById("speedfill");
  const thumbMin = document.getElementById("thumbmin");
  const thumbMax = document.getElementById("thumbmax");
  const speedOut = document.getElementById("speedout");
  let dragThumb = null;

  function pctToTrack(pct) {
    return ((pct - SPEED_FLOOR) / (100 - SPEED_FLOOR)) * 100;
  }

  function renderSpeed() {
    const lo = pctToTrack(autoOpts.speedMin);
    const hi = pctToTrack(autoOpts.speedMax);
    thumbMin.style.left = lo + "%";
    thumbMax.style.left = hi + "%";
    speedFill.style.left = lo + "%";
    speedFill.style.right = 100 - hi + "%";
    let label = autoOpts.speedMin + "–" + autoOpts.speedMax + "%";
    if (autoOpts.speedMin === autoOpts.speedMax) {
      label = autoOpts.speedMin + "%";
    }
    speedOut.textContent = label;
  }

  function pctFromEvent(e) {
    const rect = speedTrack.getBoundingClientRect();
    let t = (e.clientX - rect.left) / rect.width;
    t = Math.min(Math.max(t, 0), 1);
    return clampPct(SPEED_FLOOR + t * (100 - SPEED_FLOOR));
  }

  // Each thumb clamps against the other, so they can never swap places.
  function moveThumb(pct) {
    if (dragThumb === "min") {
      autoOpts.speedMin = Math.min(pct, autoOpts.speedMax);
    } else {
      autoOpts.speedMax = Math.max(pct, autoOpts.speedMin);
    }
    renderSpeed();
  }

  speedTrack.addEventListener("pointerdown", function (e) {
    const pct = pctFromEvent(e);
    const dMin = Math.abs(pct - autoOpts.speedMin);
    const dMax = Math.abs(pct - autoOpts.speedMax);
    if (dMin < dMax) {
      dragThumb = "min";
    } else if (dMax < dMin) {
      dragThumb = "max";
    } else if (pct > autoOpts.speedMin) {
      // Sitting on top of each other; let the direction of the grab pick.
      dragThumb = "max";
    } else {
      dragThumb = "min";
    }
    // Capture, so straying off the track mid-drag neither loses the thumb
    // nor reaches the handler that closes the menu.
    speedTrack.setPointerCapture(e.pointerId);
    moveThumb(pct);
  });

  speedTrack.addEventListener("pointermove", function (e) {
    if (!dragThumb) return;
    moveThumb(pctFromEvent(e));
  });

  function endThumb() {
    if (!dragThumb) return;
    dragThumb = null;
    saveAutoOpts();
  }

  speedTrack.addEventListener("pointerup", endThumb);
  speedTrack.addEventListener("pointercancel", endThumb);

  // -------------------------- idle --------------------------
  // Auto on a timer. Every tick runs the same autoLaunch as a press, so
  // pause, the speed range, the angle band and the three options all
  // apply unchanged - a tick that lands on a closed gate simply does
  // nothing and the next one tries again.
  const idleBtn = document.getElementById("idle");
  const idleMenu = document.getElementById("idlemenu");
  const idleTrack = document.getElementById("idletrack");
  const idleFill = document.getElementById("idlefill");
  const idleThumb = document.getElementById("thumbidle");
  const idleOut = document.getElementById("idleout");
  let idleTimer = null;
  let idleDragging = false;

  function renderIdle() {
    const span = IDLE_MAX - IDLE_MIN;
    const t = ((autoOpts.idleSeconds - IDLE_MIN) / span) * 100;
    idleThumb.style.left = t + "%";
    idleFill.style.right = 100 - t + "%";
    idleOut.textContent = autoOpts.idleSeconds + "s";
    idleBtn.classList.toggle("on", autoOpts.idleOn);
  }

  function stopIdle() {
    if (idleTimer === null) {
      return;
    }
    window.clearInterval(idleTimer);
    idleTimer = null;
  }

  function startIdle() {
    stopIdle();
    idleTimer = window.setInterval(autoLaunch, autoOpts.idleSeconds * 1000);
  }

  function applyIdle() {
    if (autoOpts.idleOn) {
      startIdle();
    } else {
      stopIdle();
    }
    renderIdle();
  }

  function idleFromEvent(e) {
    const rect = idleTrack.getBoundingClientRect();
    let t = (e.clientX - rect.left) / rect.width;
    t = Math.min(Math.max(t, 0), 1);
    return clampIdle(IDLE_MIN + t * (IDLE_MAX - IDLE_MIN));
  }

  idleTrack.addEventListener("pointerdown", function (e) {
    idleDragging = true;
    idleTrack.setPointerCapture(e.pointerId);
    autoOpts.idleSeconds = idleFromEvent(e);
    renderIdle();
  });

  idleTrack.addEventListener("pointermove", function (e) {
    if (!idleDragging) return;
    autoOpts.idleSeconds = idleFromEvent(e);
    renderIdle();
  });

  function endIdleDrag() {
    if (!idleDragging) return;
    idleDragging = false;
    saveAutoOpts();
    // Restart on the new period rather than finishing the old one.
    if (autoOpts.idleOn) {
      startIdle();
    }
  }

  idleTrack.addEventListener("pointerup", endIdleDrag);
  idleTrack.addEventListener("pointercancel", endIdleDrag);

  function toggleIdle() {
    autoOpts.idleOn = !autoOpts.idleOn;
    saveAutoOpts();
    applyIdle();
  }

  // Nothing in a control panel should ever start a native drag. Left
  // alone, the browser sometimes decides a grab in here is one and hands
  // back a floating ghost that fights the thumb you are actually moving.
  for (const menu of [autoMenu, idleMenu]) {
    menu.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });
  }

  function toggleAutoOpt(key) {
    autoOpts[key] = !autoOpts[key];
    saveAutoOpts();
    renderAutoOpts();
  }

  for (const row of autoMenu.querySelectorAll(".opt")) {
    row.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleAutoOpt(row.dataset.opt);
    });
  }

  function closeMenus() {
    autoMenu.hidden = true;
    idleMenu.hidden = true;
  }

  function openMenu(menu) {
    closeMenus();
    menu.hidden = false;
  }

  // Long press or right-click opens the button's menu; a plain tap runs
  // its action. The press has to swallow the click that follows it, or
  // opening a menu would also trigger the button underneath.
  function wirePressMenu(btn, menu, onTap) {
    let timer = null;
    let swallow = false;

    function cancel() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    btn.addEventListener("pointerdown", function () {
      swallow = false;
      timer = window.setTimeout(function () {
        timer = null;
        swallow = true;
        openMenu(menu);
      }, LONG_PRESS_MS);
    });

    btn.addEventListener("pointerup", cancel);
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("pointerleave", cancel);

    btn.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      cancel();
      swallow = true;
      openMenu(menu);
    });

    btn.addEventListener("click", function () {
      if (swallow) {
        swallow = false;
        return;
      }
      if (!menu.hidden) {
        closeMenus();
        return;
      }
      onTap();
    });
  }

  wirePressMenu(autoBtn, autoMenu, autoLaunch);
  wirePressMenu(idleBtn, idleMenu, toggleIdle);

  let autoWasBlocked = false;

  // Cheap enough to ask every frame, but only touch the DOM on a change.
  function refreshAutoBlocked() {
    const blocked = autoBlocked();
    if (blocked === autoWasBlocked) {
      return;
    }
    autoWasBlocked = blocked;
    autoBtn.classList.toggle("cant", blocked);
  }

  document.addEventListener("pointerdown", function (e) {
    if (autoMenu.hidden && idleMenu.hidden) return;
    if (autoMenu.contains(e.target)) return;
    if (idleMenu.contains(e.target)) return;
    if (e.target === autoBtn || e.target === idleBtn) return;
    closeMenus();
  });

  renderAutoOpts();
  applyIdle();

  // -------------------------- hide the ui --------------------------
  // One flag, two jobs: a class that drops the DOM overlays, and a check
  // in draw() for the painted labels. Deliberately not persisted - a
  // reload always comes back with the interface showing.
  let uiHidden = false;
  const eyeBtn = document.getElementById("eye");

  eyeBtn.addEventListener("click", function () {
    uiHidden = !uiHidden;
    document.body.classList.toggle("ui-hidden", uiHidden);
    if (uiHidden) {
      eyeBtn.setAttribute("aria-label", "Show interface");
    } else {
      eyeBtn.setAttribute("aria-label", "Hide interface");
    }
  });

  // Background label colours - the table label sits behind moving tiles so it
  // stays faint; the control strip's sits on empty space and can take more
  // contrast. Separate so each tunes on its own.
  const TABLE_LABEL = "rgba(255, 255, 255, 0.18)";
  const CONTROL_LABEL = "rgba(255, 255, 255, 0.4)";

  // -------------------------- render loop --------------------------
  const runner = Matter.Runner.create();
  Matter.Runner.run(runner, engine);

  // -------------------------- pause --------------------------
  // Runner.enabled skips the engine update but leaves the loop running.
  // Runner.stop/run would hand the engine the entire paused span as a
  // single delta on resume and teleport every tile across the table.
  const pauseBtn = document.getElementById("pause");

  // Two independent reasons to be paused. Keeping them apart is what stops
  // clicking back into the window from cancelling a pause you asked for.
  let manualPause = false;
  let blurPause = false;

  function applyPause() {
    const next = manualPause || blurPause;
    const changed = next !== paused;
    paused = next;
    runner.enabled = !paused;
    // The label tracks the button's own state; an auto-pause happens while
    // you aren't looking and undoes itself, so it shouldn't relabel it.
    if (manualPause) {
      pauseBtn.textContent = "Resume";
    } else {
      pauseBtn.textContent = "Pause";
    }
    if (paused && changed) {
      // Drop any in-flight drag in place rather than throwing it.
      dragging = false;
      dragTarget = null;
      saveState();
    }
  }

  pauseBtn.addEventListener("click", function () {
    manualPause = !manualPause;
    applyPause();
  });

  // Asked fresh off the DOM rather than tracked per event, so the three
  // listeners can't drift out of sync with each other. visibilitychange
  // alone misses a window that is still visible but no longer focused.
  function refreshFocus() {
    blurPause = document.hidden || !document.hasFocus();
    applyPause();
  }

  window.addEventListener("blur", refreshFocus);
  window.addEventListener("focus", refreshFocus);
  document.addEventListener("visibilitychange", refreshFocus);
  refreshFocus();

  function draw() {
    refreshAutoBlocked();
    ctx.clearRect(0, 0, width, height);

    // table surface
    ctx.fillStyle = "#1c1f27";
    ctx.fillRect(0, 0, width, playHeight);
    ctx.fillStyle = "#232833";
    ctx.fillRect(0, playHeight, width, height - playHeight);

    // divider between play area and control strip
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = "#3c4b66";
    ctx.beginPath();
    ctx.moveTo(0, playHeight);
    ctx.lineTo(width, playHeight);
    ctx.stroke();
    ctx.setLineDash([]);

    // background tutorial labels, sitting behind the tiles
    if (!uiHidden) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.fillStyle = TABLE_LABEL;
      ctx.font = "700 " + width * 0.12 + "px system-ui, sans-serif";
      ctx.fillText("table", width / 2, playHeight / 2);

      const controlMidY = playHeight + (height - playHeight) / 2;
      const controlFontSize = width * 0.06;
      ctx.fillStyle = CONTROL_LABEL;
      ctx.font = "600 " + controlFontSize + "px system-ui, sans-serif";
      ctx.fillText("control area", width / 2,
        controlMidY - controlFontSize * 0.7);
      ctx.font = "500 " + controlFontSize * 0.7 + "px system-ui, sans-serif";
      ctx.fillText("(throw with mouse or touch)", width / 2,
        controlMidY + controlFontSize * 0.3);
    }

    const bodies = Matter.Composite.allBodies(engine.world);
    for (const body of bodies) {
      if (body.isStatic || !body.value) continue;
      const colours = tileColours(body.value);
      const r = body.circleRadius;
      ctx.beginPath();
      ctx.arc(body.position.x, body.position.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colours.fill;
      ctx.fill();

      ctx.fillStyle = colours.text;
      ctx.font = "600 " + r * 0.55 + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(body.value), body.position.x, body.position.y);
    }

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
