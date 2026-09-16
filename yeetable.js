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

  const FRICTION_AIR = 0.0008;
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

  function spawnTile() {
    const x = width / 2;
    const y = playHeight + (height - playHeight) * 0.7;
    return makeTile(x, y, randomStartValue());
  }

  function clearTiles() {
    for (const body of Matter.Composite.allBodies(engine.world)) {
      if (body.isStatic || !body.value) continue;
      World.remove(engine.world, body);
    }
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
  setInterval(saveState, SAVE_INTERVAL);
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

      a.merging = true;
      b.merging = true;

      const midX = (a.position.x + b.position.x) / 2;
      const midY = (a.position.y + b.position.y) / 2;
      const vx = (a.velocity.x + b.velocity.x) / 2;
      const vy = (a.velocity.y + b.velocity.y) / 2;
      const newValue = a.value * 2;

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
    if (dragging) return;
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
    const MAX_SPEED = 60;
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

  // -------------------------- render loop --------------------------
  const runner = Matter.Runner.create();
  Matter.Runner.run(runner, engine);

  function draw() {
    ctx.clearRect(0, 0, width, height);

    // table surface
    ctx.fillStyle = "#1c1f27";
    ctx.fillRect(0, 0, width, playHeight);
    ctx.fillStyle = "#14161b";
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
    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = "700 " + width * 0.12 + "px system-ui, sans-serif";
    ctx.fillText("table", width / 2, playHeight / 2);

    const controlMidY = playHeight + (height - playHeight) / 2;
    const controlFontSize = width * 0.06;
    ctx.font = "600 " + controlFontSize + "px system-ui, sans-serif";
    ctx.fillText("control area", width / 2,
      controlMidY - controlFontSize * 0.7);
    ctx.font = "500 " + controlFontSize * 0.7 + "px system-ui, sans-serif";
    ctx.fillText("(throw with mouse or touch)", width / 2,
      controlMidY + controlFontSize * 0.3);

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
