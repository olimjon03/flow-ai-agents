export type Point = readonly [x: number, z: number];
type Rectangle = readonly [left: number, right: number, back: number, front: number];

export const officeBounds = { left: -12.15, right: 8.15, back: -5.55, front: 5.55 };
export const meetingTable = { x: -9.65, z: 0, width: 2, depth: 1.25 };
const step = 0.25;

export function stationPosition(index: number): [number, number, number] {
  return [(index % 4 - 1.5) * 3.65, 0, (Math.floor(index / 4) - 1) * 3.25];
}

const obstacles: Rectangle[] = Array.from({ length: 12 }, (_, index) => {
  const [x, , z] = stationPosition(index);
  return [
    [x - 1.27, x + 1.27, z - 0.33, z + 1.05],
    [x - 0.57, x + 0.57, z - 1.18, z - 0.22],
  ] as Rectangle[];
}).flat();

obstacles.push([meetingTable.x - 1.55, meetingTable.x + 1.55, -1.3, 1.3]);

export function walkable(x: number, z: number) {
  return x > officeBounds.left + 0.3 && x < officeBounds.right - 0.3
    && z > officeBounds.back + 0.3 && z < officeBounds.front - 0.3
    && !obstacles.some(([left, right, back, front]) => x >= left && x <= right && z >= back && z <= front);
}

type Cell = { x: number; z: number };
const key = ({ x, z }: Cell) => `${x}:${z}`;
const grid = ([x, z]: Point): Cell => ({ x: Math.round(x / step), z: Math.round(z / step) });
const world = ({ x, z }: Cell): Point => [x * step, z * step];
const distance = (a: Cell, b: Cell) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
const neighbors = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function findPath(start: Point, finish: Point): Point[] | null {
  const from = grid(start);
  const goal = grid(finish);
  if (!walkable(...world(from)) || !walkable(...world(goal))) return null;

  const open = new Map([[key(from), from]]);
  const costs = new Map([[key(from), 0]]);
  const parents = new Map<string, Cell>();
  while (open.size) {
    let current: Cell | undefined;
    let score = Infinity;
    for (const candidate of open.values()) {
      const estimate = costs.get(key(candidate))! + distance(candidate, goal);
      if (estimate < score) {
        score = estimate;
        current = candidate;
      }
    }
    if (!current) return null;
    if (key(current) === key(goal)) {
      const path: Point[] = [];
      for (let cell: Cell | undefined = current; cell; cell = parents.get(key(cell))) path.push(world(cell));
      return path.reverse();
    }
    open.delete(key(current));

    for (const [dx, dz] of neighbors) {
      const next = { x: current.x + dx, z: current.z + dz };
      const cost = costs.get(key(current))! + 1;
      if (!walkable(...world(next)) || cost >= (costs.get(key(next)) ?? Infinity)) continue;
      costs.set(key(next), cost);
      parents.set(key(next), current);
      open.set(key(next), next);
    }
  }
  return null;
}

export function deskAisle(index: number): Point {
  const [x, , z] = stationPosition(index);
  return world(grid([x + 1.4, z - 0.58]));
}

export function handoffPath(from: number, to: number): Point[] | null {
  const path = findPath(deskAisle(from), deskAisle(to));
  if (!path) return null;
  const [x, , z] = stationPosition(from);
  // Exit sideways from the seat, then use collision-checked aisle nodes.
  return [[x, z - 0.56], [x + 0.86, z - 0.56], ...path];
}
