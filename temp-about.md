# Yeetable — everything so far

Written 2026-09-12. Temporary holding doc, made before a compaction so nothing is lost. Three sections: what the user decided, what is open, and what Claude suggested. **Claude's suggestions are not decisions** and are kept separate on purpose.

## Decided by the user

**The name.** Yeetable. Works two ways — *yeetable* (able to be yeeted) and *yeet-table* (the table you yeet things on). Chosen over throwslide, sliptoss, slideythrow, aeromerge, airboard and airmerge. Checked for product collisions: nothing found beyond a hobby site at `yeetable.web.app` and Urban Dictionary entries. "YEET" alone is a registered trademark (26 Gaming, LLC, for game programs and mobile apps); *yeetable* is not.

**The genre.** A merge game — like 2048 / watermelon game — played on a low-friction sliding table. The user's own comparison: "watermelon game plus those stupid fake ads with the slide drinks across a table, plus a slight original twist because the trajectory is totally controllable, not just straight down like all the others."

**The screen.** Top portion is the play area: a top-down view of a box. Not a side view. The user notes it may still be rendered in 3D — "top down" describes the camera, not the dimensionality.

**The play area's shape.** A rectangle that isn't too rectangular. 3x4 and 5x3 both floated. These are **proportions, not a grid** — there are no cells.

**The control.** Near the bottom of the screen is a section where the player slides the next tile around. While the tile is under their finger it follows the touch. On release it keeps whatever velocity and direction it had. **No slingshot, no gravity.**

**The table.** Very low friction. The point is that every new tile sent in jostles everything already there.

**Commercial intent.** The user wants to sell this. Plan, in their words: keep deploying fixes at any hour until there's a build worth selling, *then* consider making the repo private, and still put it on the Play Store because the traffic is there.

**Its relationship to Falsedge.** The user was unsure whether it should be attached to Falsedge at all, and raised "am I making too many games on Falsedge?" They decided it gets its own repo.

## Undecided

- **When a merge fires.** Never chosen. The whole feel of the game hangs on this.
- **The exact play-area proportions.** "I'll have to test."
- **Engine.** The user raised Unity for the 3D aspect. Not settled.
- **Loss condition.** Never discussed.
- **What the tiles are** — numbers, or something else. Never discussed.
- **Scoring.** Never discussed.

## Claude's suggestions — NOT decisions

Recorded so the reasoning isn't lost, but the user has agreed to none of it.

- **The sport is shuffleboard.** The user asked "what is that low friction slide pucks around game idk". Shuffleboard is the waxed-table one; curling is the ice cousin. (USER: NO IT'S AIR HOCKEY THAT'S THE WORD I WAS LOOKING FOR)
- **2D physics, not 3D.** Top-down with no gravity means nothing moves on a third axis, so the simulation is 2D even if the rendering is 3D. Matter.js does zero-gravity rigid bodies with `frictionAir` for the table.
- **Web over Unity.** Unity's WebGL export is multi-megabyte with a slow first load, which breaks the open-it-instantly model and gets rejected by portals. Capacitor wraps a web app into a signed Play Store package, so web doesn't foreclose selling it.
- **HTML5 portals as the revenue route.** Poki and CrazyGames license casual web games for fees plus revenue share and want web builds. The App Store merge market runs on user-acquisition spend that solo devs can't outbid.
- **No build tooling needed.** Matter.js ships a UMD build that loads from a plain `<script src>`, the same way `hex2-core.js` does. A bundler only becomes necessary for three.js ES modules or TypeScript. (Claude initially claimed tooling *was* needed and then withdrew it.)
- **Falsedge needs exactly one bait game.** Hex 2^ works because it is the door you open Falsedge to reach. A second game doesn't add a second door.
- **Three options for the merge trigger**, none chosen: any contact at any speed; only above an impact threshold; or only once both tiles come to rest.

## Repo state

```
mobile1sts\yeetable\
  cbb4af0   Seed the repo        on main
  .gitignore   CLAUDE.md, .vscode/, old/
  .nojekyll
  index.html   bare stub, mobile viewport, no Apple tags
```

**No GitHub remote.** The GitHub CLI is not installed on this machine, so the remote has to be created in the browser and added by hand. Nothing is pushed anywhere.
