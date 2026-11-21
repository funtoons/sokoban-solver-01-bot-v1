// Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Design (from the competition RULES and the shape of its levels, worked out here,
// not copied from any solver): every level is a one-square-wide hallway with one
// to four rooms off it, each room holding 3 or 4 boxes and as many goals, opening
// onto the hallway through a single door. A box pushed through a door into the
// hallway can never be pushed back, so no optimal solution ever moves a box out
// of its room, and a level's push-optimal count is the sum of its rooms' optima.
// The level therefore splits into independent per-room problems:
//
//   1. Find the hallway (the player's row or column: the one with no interior
//      wall) and each room's door (the floor cell just off the hallway), then
//      flood-fill each room from its door.
//   2. Solve each room push-optimally on its own: A* over pushes. A state is
//      the boxes plus the player's reachable region (canonicalised to the
//      region's lowest cell, so the player can stand anywhere in it for free).
//      The heuristic is the minimum-assignment (Hungarian) cost of boxes to
//      goals over shortest-path distances, which is admissible for pushes.
//      States are pruned when a box sits on a dead square (no goal reachable
//      from it by pushes, ignoring other boxes) or is frozen in a 2x2 block
//      of walls and boxes.
//   3. Stitch the room solutions together with shortest walks (boxes treated
//      as walls, so a walk never pushes) and replay the whole move string to
//      check it before writing it out.
//
// Deterministic by construction: no clock, no randomness, no network, no
// environment input beyond the two MAKEFUN_* directories. Every search is
// capped by a fixed number of node expansions, so the same input always costs
// the same work and two runs write the same bytes. A room the optimal search
// cannot finish falls back to a weighted search, then a greedy one; a room
// whose optimal solution traps the player inside (its door blocked in the
// final state) is solved last instead.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const STATS = process.argv.includes('--stats');

// Work budgets in node expansions (never the wall clock): the same input always
// costs the same work, so two runs write the same bytes.
const CAP_OPTIMAL = 800000;
const CAP_WEIGHTED = 300000;
const CAP_GREEDY = 300000;
const EXTRA_AFTER_FALLBACK = 100000;
// Safety valve for the whole run: 5 levels, at most 11 rooms.
let workLeft = 4000000;

// Directions in fixed order: up, down, left, right. Every search and every
// walk uses this order, so nothing depends on hash order or timing.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// All cells reachable from `from` over cells where `open` is 1.
function flood(w: number, h: number, open: Uint8Array, from: number): Uint8Array {
  const seen = new Uint8Array(open.length);
  if (!open[from]) return seen;
  const q: number[] = [from];
  seen[from] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nb = ny * w + nx;
      if (!open[nb] || seen[nb]) continue;
      seen[nb] = 1;
      q.push(nb);
    }
  }
  return seen;
}

// Shortest walk from `from` to `to` over floor cells (`wall`), treating
// `blocked` cells as walls. Returns the move letters, or null if unreachable.
function walkPath(
  w: number,
  h: number,
  wall: Uint8Array,
  blocked: Uint8Array | null,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const n = w * h;
  const prev = new Int32Array(n).fill(-1);
  const prevDir = new Int8Array(n).fill(-1);
  const q: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nb = ny * w + nx;
      if (wall[nb] || (blocked !== null && blocked[nb])) continue;
      if (prev[nb] !== -1) continue;
      prev[nb] = c;
      prevDir[nb] = d;
      if (nb === to) {
        let s = '';
        let cur = to;
        while (cur !== from) {
          s = LETTER[prevDir[cur]!]! + s;
          cur = prev[cur]!;
        }
        return s;
      }
      q.push(nb);
    }
  }
  return null;
}

type Hallway = { horizontal: boolean; line: number };

// The hallway is the player's row or column: the one with no interior wall,
// a straight corridor across the board.
function findHallway(level: Level): Hallway | null {
  const { w, h, wall, player } = level;
  const px = player % w;
  const py = (player / w) | 0;
  let rowOpen = true;
  for (let x = 1; x < w - 1; x++) {
    if (wall[py * w + x]) {
      rowOpen = false;
      break;
    }
  }
  if (rowOpen) return { horizontal: true, line: py };
  let colOpen = true;
  for (let y = 1; y < h - 1; y++) {
    if (wall[y * w + px]) {
      colOpen = false;
      break;
    }
  }
  if (colOpen) return { horizontal: false, line: px };
  return null;
}

type Room = {
  door: number;
  entry: number; // hallway cell adjacent to the door; the player enters from here
  cells: number[]; // interior cells (including the door), never the entry
  cellSet: Uint8Array; // mask of the interior cells
  boxes: number[];
  goals: number[];
};

// Doors are the floor cells just off the hallway, each adjacent to a hallway
// floor cell; a room is the flood-fill from its door over non-hallway floor.
function findRooms(level: Level, hall: Hallway): Room[] {
  const { w, h, wall, boxes, goals } = level;
  const isHallCell = (c: number): boolean =>
    hall.horizontal ? ((c / w) | 0) === hall.line : c % w === hall.line;
  const rooms: Room[] = [];
  const claimed = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = y * w + x;
      if (wall[c] || claimed[c]) continue;
      if (hall.horizontal) {
        if (y !== hall.line - 1 && y !== hall.line + 1) continue;
        if (wall[hall.line * w + x]) continue;
      } else {
        if (x !== hall.line - 1 && x !== hall.line + 1) continue;
        if (wall[y * w + hall.line]) continue;
      }
      const open = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) open[i] = !wall[i] && !isHallCell(i) ? 1 : 0;
      const region = flood(w, h, open, c);
      const cells: number[] = [];
      for (let i = 0; i < w * h; i++) {
        if (region[i]) {
          cells.push(i);
          claimed[i] = 1;
        }
      }
      const rBoxes = boxes.filter((b) => region[b]);
      const rGoals = goals.filter((g) => region[g]);
      if (rBoxes.length === 0) continue;
      if (rBoxes.length !== rGoals.length) continue;
      const entry = hall.horizontal
        ? hall.line * w + (c % w)
        : ((c / w) | 0) * w + hall.line;
      rooms.push({ door: c, entry, cells, cellSet: region, boxes: rBoxes, goals: rGoals });
    }
  }
  rooms.sort((a, b) =>
    hall.horizontal
      ? a.door % w - (b.door % w)
      : ((a.door / w) | 0) - ((b.door / w) | 0),
  );
  return rooms;
}

type RoomCtx = {
  w: number;
  h: number;
  interior: Uint8Array; // room cells (including the door); boxes may stand here
  standable: Uint8Array; // interior plus the entry cell; the player may stand here
  entry: number;
  door: number;
  goals: number[];
  goalSet: Uint8Array;
  distToGoal: number[][]; // per goal: BFS distance over interior cells
  dead: Uint8Array; // interior cells from which no goal is reachable by pushes
};

function buildRoomCtx(level: Level, room: Room): RoomCtx {
  const { w, h } = level;
  const interior = room.cellSet;
  const standable = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) standable[i] = interior[i];
  standable[room.entry] = 1;
  const goalSet = new Uint8Array(w * h);
  for (const g of room.goals) goalSet[g] = 1;
  // Shortest box travel from each goal over interior cells.
  const distToGoal: number[][] = [];
  for (const g of room.goals) {
    const dist = new Float64Array(w * h).fill(Infinity);
    const q: number[] = [g];
    dist[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nb = ny * w + nx;
        if (!interior[nb] || dist[nb] !== Infinity) continue;
        dist[nb] = dist[c]! + 1;
        q.push(nb);
      }
    }
    distToGoal.push(Array.from(dist));
  }
  // Dead squares: reverse push-reachability from the goals, ignoring other
  // boxes. A box at y came from x = y - d with the player standing at y - 2d.
  // Any interior cell this never reaches cannot hold a box on the way to a goal.
  const live = new Uint8Array(w * h);
  const rq: number[] = [];
  for (const g of room.goals) {
    live[g] = 1;
    rq.push(g);
  }
  for (let qi = 0; qi < rq.length; qi++) {
    const y = rq[qi]!;
    const yx = y % w;
    const yy = (y / w) | 0;
    for (let d = 0; d < 4; d++) {
      const xx = yx - DX[d]!;
      const xy = yy - DY[d]!;
      const px = yx - 2 * DX[d]!;
      const py = yy - 2 * DY[d]!;
      if (xx < 0 || xx >= w || xy < 0 || xy >= h) continue;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const x = xy * w + xx;
      const p = py * w + px;
      if (!interior[x] || live[x]) continue;
      if (!standable[p]) continue;
      live[x] = 1;
      rq.push(x);
    }
  }
  const dead = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (interior[i] && !live[i]) dead[i] = 1;
  return { w, h, interior, standable, entry: room.entry, door: room.door, goals: room.goals, goalSet, distToGoal, dead };
}

// Minimum-assignment cost of boxes to goals over the shortest-path distances
// (n <= 4, so all permutations). Admissible for pushes: every push moves one
// box one cell, and the assignment is the cheapest way to cover the distances.
function hungarian(ctx: RoomCtx, boxes: number[]): number {
  const n = boxes.length;
  const perm = ctx.goals.map((_, i) => i);
  let best = Infinity;
  const rec = (k: number, cost: number): void => {
    if (cost >= best) return;
    if (k === n) {
      best = cost;
      return;
    }
    for (let i = k; i < n; i++) {
      const t = perm[k]!;
      perm[k] = perm[i]!;
      perm[i] = t;
      const d = ctx.distToGoal[perm[k]!]![boxes[k]!]!;
      if (d !== Infinity) rec(k + 1, cost + d);
      const t2 = perm[k]!;
      perm[k] = perm[i]!;
      perm[i] = t2;
    }
  };
  rec(0, 0);
  return best;
}

// A box is frozen when it sits in a 2x2 block of cells that are walls or boxes
// (and no goal): it cannot move first in any direction, because the two
// in-block neighbours block the destination and the two out-of-block moves
// need the player to stand on an in-block cell. A cell counts as solid only
// when neither a box nor the player can ever use it.
function frozen2x2(ctx: RoomCtx, boxMask: Uint8Array, boxes: number[]): boolean {
  const { w, h, interior, goalSet, entry } = ctx;
  const solid = (c: number): boolean => !interior[c] && c !== entry;
  for (const b of boxes) {
    if (goalSet[b]) continue;
    const bx = b % w;
    const by = (b / w) | 0;
    for (let cx = 0; cx <= 1; cx++) {
      for (let cy = 0; cy <= 1; cy++) {
        const ox = bx - cx;
        const oy = by - cy;
        let full = true;
        for (let dx = 0; dx <= 1 && full; dx++) {
          for (let dy = 0; dy <= 1 && full; dy++) {
            const nx = ox + dx;
            const ny = oy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue; // outside the board is a wall
            const c = ny * w + nx;
            if (!solid(c) && !boxMask[c]) full = false;
          }
        }
        if (full) return true;
      }
    }
  }
  return false;
}

// Binary heap on [f, h, g, seq, state], compared lexicographically.
type HeapEntry = [number, number, number, number, number];
function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  for (let k = 0; k < 4; k++) if (a[k] !== b[k]) return a[k]! < b[k]!;
  return false;
}
function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i]!, heap[p]!)) break;
    const t = heap[i]!;
    heap[i] = heap[p]!;
    heap[p] = t;
    i = p;
  }
}
function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
      if (!heapLess(heap[c]!, heap[i]!)) break;
      const t = heap[i]!;
      heap[i] = heap[c]!;
      heap[c] = t;
      i = c;
    }
  }
  return top;
}

type Push = { box: number; dir: number };
type RoomSolution = { pushes: Push[]; expansions: number; optimal: boolean };

function solveRoom(
  ctx: RoomCtx,
  startBoxes: number[],
  weight: number,
  cap: number,
  mode: 'astar' | 'greedy',
  requireExit: boolean,
): RoomSolution | null {
  const { w, h, interior, standable, entry, door, goalSet, dead } = ctx;
  const n = startBoxes.length;
  const sBoxes: number[][] = [];
  const sPlayer: number[] = [];
  const sRep: number[] = [];
  const sParent: number[] = [];
  const sPushBox: number[] = [];
  const sPushDir: number[] = [];
  const sG: number[] = [];
  const sH: number[] = [];
  const best = new Map<string, number>();
  const heap: HeapEntry[] = [];
  let seq = 0;

  // The player's reachable region with these boxes, and its lowest cell,
  // which canonicalises the player position inside the region.
  const regionOf = (player: number, boxes: number[]): { mask: Uint8Array; rep: number } => {
    const open = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) open[i] = standable[i];
    for (const b of boxes) open[b] = 0;
    const mask = flood(w, h, open, player);
    let rep = -1;
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) {
        rep = i;
        break;
      }
    }
    return { mask, rep };
  };
  const keyOf = (boxes: number[], rep: number): string => boxes.join(',') + '|' + rep;

  const start = startBoxes.slice().sort((a, b) => a - b);
  const h0 = hungarian(ctx, start);
  if (h0 === Infinity) return null;
  const r0 = regionOf(entry, start);
  sBoxes.push(start);
  sPlayer.push(entry);
  sRep.push(r0.rep);
  sParent.push(-1);
  sPushBox.push(-1);
  sPushDir.push(-1);
  sG.push(0);
  sH.push(h0);
  best.set(keyOf(start, r0.rep), 0);
  const f0 = mode === 'greedy' ? h0 : weight * h0;
  heapPush(heap, [f0, h0, 0, seq++, 0]);

  const finish = (s: number): RoomSolution => {
    const pushes: Push[] = [];
    for (let t = s; t > 0; t = sParent[t]!) pushes.push({ box: sPushBox[t]!, dir: sPushDir[t]! });
    pushes.reverse();
    return { pushes, expansions, optimal: mode === 'astar' && weight === 1 };
  };

  let expansions = 0;
  let fallbackIdx = -1;
  let fallbackG = Infinity;
  let extraLeft = EXTRA_AFTER_FALLBACK;
  while (heap.length > 0) {
    const top = heap[0]!;
    if (fallbackIdx >= 0 && top[0] > fallbackG) break;
    if (fallbackIdx >= 0 && extraLeft <= 0) break;
    const s = heapPop(heap)[4]!;
    if (best.get(keyOf(sBoxes[s]!, sRep[s]!)) !== s) continue; // superseded
    const g = sG[s]!;
    const hh = sH[s]!;
    if (hh === 0) {
      // Every box is on a goal. Keep the first such state as a fallback in
      // case no optimal solution lets the player leave the room.
      if (fallbackIdx < 0) {
        fallbackIdx = s;
        fallbackG = g;
      }
      if (!requireExit) return finish(s);
      const open = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) open[i] = standable[i];
      for (const b of sBoxes[s]!) open[b] = 0;
      if (flood(w, h, open, sPlayer[s]!)[door]) return finish(s);
      continue;
    }
    if (expansions >= cap || workLeft <= 0) break;
    expansions++;
    workLeft--;
    if (fallbackIdx >= 0) extraLeft--;
    const boxes = sBoxes[s]!;
    const region = regionOf(sPlayer[s]!, boxes).mask;
    const occupied = new Uint8Array(w * h);
    for (const b of boxes) occupied[b] = 1;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const dx = bx + DX[d]!;
        const dy = by + DY[d]!;
        if (dx < 0 || dx >= w || dy < 0 || dy >= h) continue;
        const dest = dy * w + dx;
        if (!interior[dest] || occupied[dest]) continue;
        const px = bx - DX[d]!;
        const py = by - DY[d]!;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const pushPos = py * w + px;
        if (!region[pushPos]) continue;
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        let deadState = false;
        for (const x of nb) {
          if (dead[x] && !goalSet[x]) {
            deadState = true;
            break;
          }
        }
        if (deadState) continue;
        const nbMask = new Uint8Array(w * h);
        for (const x of nb) nbMask[x] = 1;
        if (frozen2x2(ctx, nbMask, nb)) continue;
        const nh = hungarian(ctx, nb);
        if (nh === Infinity) continue;
        const nPlayer = b; // the player ends up where the box was
        const nRep = regionOf(nPlayer, nb).rep;
        const nk = keyOf(nb, nRep);
        const ng = g + 1;
        const prev = best.get(nk);
        if (prev !== undefined && sG[prev]! <= ng) continue;
        const idx = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(nPlayer);
        sRep.push(nRep);
        sParent.push(s);
        sPushBox.push(b);
        sPushDir.push(d);
        sG.push(ng);
        sH.push(nh);
        best.set(nk, idx);
        const nf = mode === 'greedy' ? nh : ng + weight * nh;
        heapPush(heap, [nf, nh, ng, seq++, idx]);
      }
    }
  }
  if (fallbackIdx >= 0) return finish(fallbackIdx);
  return null;
}

// Solve one room, hardest search first. Returns null only when no search
// finds a solution. needsLast means the player cannot leave the room after
// the optimal solution, so this room must be solved last.
function solveRoomAll(ctx: RoomCtx, startBoxes: number[]): (RoomSolution & { needsLast: boolean }) | null {
  let r = solveRoom(ctx, startBoxes, 1, CAP_OPTIMAL, 'astar', true);
  if (r) return { ...r, needsLast: false };
  r = solveRoom(ctx, startBoxes, 1, CAP_OPTIMAL, 'astar', false);
  if (r) return { ...r, needsLast: true };
  r = solveRoom(ctx, startBoxes, 3, CAP_WEIGHTED, 'astar', false);
  if (r) return { ...r, needsLast: true };
  r = solveRoom(ctx, startBoxes, 1, CAP_GREEDY, 'greedy', false);
  if (r) return { ...r, needsLast: true };
  return null;
}

// Replay a move string on the level; true only when every box ends on a goal
// and no step is illegal. The final safety net before writing an answer.
function replaySolves(level: Level, moves: string): boolean {
  const { w, h, wall, goals } = level;
  const box = new Uint8Array(w * h);
  for (const b of level.boxes) box[b] = 1;
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;
  let player = level.player;
  for (const ch of moves) {
    const d = LETTER.indexOf(ch);
    if (d < 0) return false;
    const nx = (player % w) + DX[d]!;
    const ny = ((player / w) | 0) + DY[d]!;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return false;
    const next = ny * w + nx;
    if (wall[next]) return false;
    if (box[next]) {
      const bx = nx + DX[d]!;
      const by = ny + DY[d]!;
      if (bx < 0 || bx >= w || by < 0 || by >= h) return false;
      const beyond = by * w + bx;
      if (wall[beyond] || box[beyond]) return false;
      box[next] = 0;
      box[beyond] = 1;
    }
    player = next;
  }
  for (let i = 0; i < w * h; i++) if (box[i] && !goalSet[i]) return false;
  return true;
}

type SolvedRoom = {
  room: Room;
  sol: RoomSolution & { needsLast: boolean };
};

// Walk to each room's entry in turn and play its pushes, walking between
// pushes. Walks treat boxes as walls, so they never push. Returns null when
// a walk has no path.
function stitch(level: Level, order: SolvedRoom[]): string | null {
  const { w, h, wall } = level;
  let boxes = level.boxes.slice();
  let player = level.player;
  let out = '';
  const boxMask = (): Uint8Array => {
    const m = new Uint8Array(w * h);
    for (const b of boxes) m[b] = 1;
    return m;
  };
  for (const { room, sol } of order) {
    const walk = walkPath(w, h, wall, boxMask(), player, room.entry);
    if (walk === null) return null;
    out += walk;
    player = room.entry;
    for (const p of sol.pushes) {
      const pushPos = p.box - DY[p.dir]! * w - DX[p.dir]!;
      const w2 = walkPath(w, h, wall, boxMask(), player, pushPos);
      if (w2 === null) return null;
      out += w2;
      out += LETTER[p.dir]!;
      const dest = p.box + DY[p.dir]! * w + DX[p.dir]!;
      const i = boxes.indexOf(p.box);
      if (i < 0) return null;
      boxes[i] = dest;
      boxes.sort((a, b) => a - b);
      player = p.box;
    }
  }
  return out;
}

function solveLevel(text: string, id: string): string {
  const level = parseLevel(text);
  const hall = findHallway(level);
  if (!hall) return '';
  const rooms = findRooms(level, hall);
  if (rooms.length === 0) return '';
  // Every box must belong to a room; a box in the hallway could never be solved.
  const inRoom = new Uint8Array(level.w * level.h);
  for (const r of rooms) for (const c of r.cells) inRoom[c] = 1;
  for (const b of level.boxes) if (!inRoom[b]) return '';
  const solved: SolvedRoom[] = [];
  for (const room of rooms) {
    const ctx = buildRoomCtx(level, room);
    const sol = solveRoomAll(ctx, room.boxes);
    if (!sol) return '';
    if (STATS) {
      console.error(
        `${id} room@${room.door} boxes=${room.boxes.length} pushes=${sol.pushes.length} ` +
          `optimal=${sol.optimal} needsLast=${sol.needsLast} expansions=${sol.expansions}`,
      );
    }
    solved.push({ room, sol });
  }
  // Try room orders until one stitches into a verified solution: hallway
  // order, its reverse, and the orders that put a room the player cannot
  // leave until last.
  const byHall = solved.slice();
  const nonLast = byHall.filter((s) => !s.sol.needsLast);
  const last = byHall.filter((s) => s.sol.needsLast);
  const orders: SolvedRoom[][] = [
    byHall,
    byHall.slice().reverse(),
    [...nonLast, ...last],
    [...last, ...nonLast].reverse(),
  ];
  const seen = new Set<string>();
  for (const order of orders) {
    const key = order.map((s) => s.room.door).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const moves = stitch(level, order);
    if (moves !== null && replaySolves(level, moves)) return moves;
  }
  return '';
}

function solve(text: string, id: string): string {
  return solveLevel(text, id);
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'), id);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
