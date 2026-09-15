(function () {
  "use strict";

  // -------------------------- layout --------------------------
  // Play area is 3:4 (width:height) - the final pick. No loss
  // condition yet; this build is for feeling out the physics.
  const PLAY_W_RATIO = 3;
  const PLAY_H_RATIO = 4;

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");

  let width = 0;
  let height = 0;
  let playHeight = 0;

  function layout() {
    height = window.innerHeight;
    // The play area (3:4) and the control strip both need real room.
    // Cap play-area height to 70% of the window, and derive width from
    // that - rather than sizing width first and letting height fall
    // wherever the ratio lands, which can exceed the window entirely.
    const maxW = Math.min(window.innerWidth, 480);
    let w = maxW;
    let pH = w * (PLAY_H_RATIO / PLAY_W_RATIO);
    const maxPlayHeight = height * 0.7;
    if (pH > maxPlayHeight) {
      pH = maxPlayHeight;
      w = pH * (PLAY_W_RATIO / PLAY_H_RATIO);
    }
    width = w;
    playHeight = pH;
    canvas.width = width;
    canvas.height = height;
  }
  layout();
  window.addEventListener("resize", layout);

  // -------------------------- tile values --------------------------
  // Hand-picked, same source as hex2-core.js's TILE_HSL - borrowed
  // palette so both games read as part of the same family.
  const TILE_HSL = {
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
  };
  const TOP_SOLID = 2048;

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
    return { fill: fill, text: lum > 0.45 ? "#171a1f" : "#ffffff" };
  }

  // Linear size growth, exponential value labels.
  const BASE_RADIUS = 16;
  const RADIUS_STEP = 6;

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
  window.addEventListener("resize", buildWalls);

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
    return Math.random() < 0.8 ? 2 : 4;
  }

  // Grabbability is purely positional: any tile that hasn't crossed
  // into the play area yet (body.crossedIntoPlay is falsy) is fair
  // game to pick up, whatever it's doing. dragTarget is just whichever
  // one a finger currently has hold of, if any.
  let dragTarget = null;

  function spawnTile() {
    const x = width / 2;
    const y = playHeight + (height - playHeight) * 0.7;
    return makeTile(x, y, randomStartValue());
  }
  spawnTile();

  // -------------------------- score --------------------------
  let score = 0;
  function addScore(v) {
    score += v;
    scoreEl.textContent = String(score);
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

  // -------------------------- semi-permeable boundary --------------------------
  // The play-area/control-strip line: freely crossable on the way up,
  // sealed shut once a tile is fully inside the play area. Not tied to
  // any loss condition - this is the table itself.
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

    // Keep the control strip stocked - spawn a fresh tile only once
    // it's completely empty of un-launched ones.
    if (!anyInControl) {
      spawnTile();
    }
  });

  // -------------------------- dragging (pointer events) --------------------------
  let dragging = false;
  let history = [];

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (dragging) return;
    const p = pointerPos(e);
    if (p.y <= playHeight) return;
    // Any tap anywhere in the control area snaps the nearest tile
    // still down there straight to the finger - no need to land the
    // tap precisely on the tile itself.
    const bodies = Matter.Composite.allBodies(engine.world);
    let best = null;
    let bestDist = Infinity;
    for (const body of bodies) {
      if (body.isStatic || !body.value || body.merging) continue;
      if (body.crossedIntoPlay) continue;
      const dx = p.x - body.position.x;
      const dy = p.y - body.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        best = body;
        bestDist = dist;
      }
    }
    if (!best) return;
    dragTarget = best;
    dragging = true;
    const r = radiusFor(best.value);
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
    // Dragging is confined to the control strip - crossing into the
    // play area only happens on release, via velocity, never by hand.
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
    ctx.strokeStyle = "#3c4b66";
    ctx.beginPath();
    ctx.moveTo(0, playHeight);
    ctx.lineTo(width, playHeight);
    ctx.stroke();
    ctx.setLineDash([]);

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
      ctx.font = "600 " + Math.max(10, r * 0.55) + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(body.value), body.position.x, body.position.y);
    }

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
