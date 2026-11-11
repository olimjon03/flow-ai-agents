import { type Point } from "./navigation.ts";

export type TaskHandoff = {
  id: string;
  sequence: number;
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  at: string;
};

export type AvatarState = "idle" | "sitting" | "typing" | "standing_up" | "walking"
  | "handing_over_task" | "receiving_task" | "returning_to_desk" | "celebrating_completion" | "error";

export function parseHandoff(data: string): TaskHandoff | null {
  let event: Partial<TaskHandoff> | null;
  try { event = JSON.parse(data); } catch { return null; }
  if (!event || typeof event.id !== "string" || !event.id || typeof event.runId !== "string"
    || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1
    || typeof event.fromAgentId !== "string" || typeof event.toAgentId !== "string"
    || event.fromAgentId === event.toAgentId || typeof event.at !== "string"
    || !Number.isFinite(Date.parse(event.at))) return null;
  return event as TaskHandoff;
}

export function walkingDistance(path: readonly Point[]) {
  return path.slice(1).reduce((sum, next, index) =>
    sum + Math.hypot(next[0] - path[index][0], next[1] - path[index][1]), 0);
}

export function sampleWalk(path: readonly Point[], distance: number) {
  for (let index = 1; index < path.length; index++) {
    const [x, z] = path[index - 1];
    const [nextX, nextZ] = path[index];
    const dx = nextX - x;
    const dz = nextZ - z;
    const length = Math.hypot(dx, dz);
    if (length === 0) continue;
    if (distance <= length || index === path.length - 1) {
      const fraction = Math.min(1, distance / length);
      return { x: x + dx * fraction, z: z + dz * fraction, yaw: Math.atan2(dx, dz) };
    }
    distance -= length;
  }
  return { x: path[0][0], z: path[0][1], yaw: 0 };
}

export function handoffPhase(elapsed: number, walk: number): AvatarState | null {
  if (elapsed < 0.35) return "standing_up";
  if (elapsed < 0.35 + walk) return "walking";
  if (elapsed < 1 + walk) return "handing_over_task";
  if (elapsed < 1 + walk * 2) return "returning_to_desk";
  return null;
}
