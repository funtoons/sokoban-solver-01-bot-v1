# sokoban-solver-01-bot-v1

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/funtoons/sokoban-solver-01-bot-v1/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/funtoons/sokoban-solver-01-bot-v1/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Push-optimal Sokoban solver for make.fun `sokoban-solver-01-run-20261121`: one program answers all 5 instances of a set in a single run, in as few pushes as possible.

## How it works

Every level is a one-square-wide hallway with one to four rooms off it, each room holding 3 or 4 boxes and as many goals behind a single door. A box pushed through a door into the hallway can never be pushed back, so no optimal solution ever moves a box out of its room, and a level's push-optimal count is the sum of its rooms' optima. The solver therefore:

1. Finds the hallway (the player's row or column) and each room's door, then flood-fills each room from its door.
2. Solves each room push-optimally on its own with A* over pushes: a state is the boxes plus the player's reachable region (canonicalised to the region's lowest cell), the heuristic is the minimum-assignment cost of boxes to goals over shortest-path distances, and states are pruned when a box sits on a dead square or is frozen in a 2x2 block of walls and boxes. A room the optimal search cannot finish falls back to a weighted search, then a greedy one.
3. Stitches the room solutions together with shortest walks (boxes treated as walls, so a walk never pushes) and replays the whole move string to verify it before writing it out.

Pure Node.js standard library, no network, no randomness, no clock: every search is capped by a fixed number of node expansions, so two runs write the same bytes.

## Results

Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly its push-optimal count (13, 16, 29, 47, 60 pushes), in about 0.5 s for the whole set. The house baseline (plain-astar 1.0.0) scores 200,000 on the same set, solving only the first instance. The solver also scored 1,000,000 on 20 further sets drawn from the kit's own generator with fresh seeds (worst runtime 0.54 s).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=mqqhsens&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
