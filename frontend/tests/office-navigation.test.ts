import assert from "node:assert/strict";
import test from "node:test";
import { handoffPhase, parseHandoff, sampleWalk, walkingDistance } from "../lib/office/handoff.ts";
import { deskAisle, findPath, handoffPath, meetingTable, stationPosition, walkable } from "../lib/office/navigation.ts";

test("every desk has a collision-free aisle route around desks and the meeting table", () => {
  assert.equal(walkable(meetingTable.x, meetingTable.z), false);
  const [deskX, , deskZ] = stationPosition(0);
  assert.equal(walkable(deskX, deskZ + 0.35), false);
  assert.equal(findPath([100, 0], deskAisle(1)), null);
  for (let from = 0; from < 12; from++) {
    for (let to = 0; to < 12; to++) {
      const aisle = findPath(deskAisle(from), deskAisle(to));
      assert.ok(aisle, `${from} to ${to}`);
      assert.deepEqual(aisle[0], deskAisle(from));
      assert.deepEqual(aisle.at(-1), deskAisle(to));
      for (let distance = 0; distance <= walkingDistance(aisle); distance += 0.05) {
        const { x, z } = sampleWalk(aisle, distance);
        assert.ok(walkable(x, z), `Blocked step ${x}, ${z}`);
      }
    }
  }
});

test("handoff phases end at the destination and return to the original seat", () => {
  const path = handoffPath(10, 2)!;
  const length = walkingDistance(path);
  assert.ok(length > 0);
  assert.equal(handoffPhase(0, 2), "standing_up");
  assert.equal(handoffPhase(1, 2), "walking");
  assert.equal(handoffPhase(2.5, 2), "handing_over_task");
  assert.equal(handoffPhase(3.5, 2), "returning_to_desk");
  assert.equal(handoffPhase(5, 2), null);
  const end = sampleWalk(path, length);
  assert.deepEqual([end.x, end.z], path.at(-1));
  const home = sampleWalk([...path].reverse(), length);
  assert.ok(Math.hypot(home.x - path[0][0], home.z - path[0][1]) < 1e-8);
});

test("handoff parser rejects malformed and self-directed events", () => {
  const event = { id: "handoff", sequence: 1, runId: "run", fromAgentId: "scout", toAgentId: "quill", at: "2026-11-12T01:02:03Z" };
  assert.deepEqual(parseHandoff(JSON.stringify(event)), event);
  assert.equal(parseHandoff("null"), null);
  assert.equal(parseHandoff(JSON.stringify({ ...event, toAgentId: "scout" })), null);
  assert.equal(parseHandoff(JSON.stringify({ ...event, sequence: 0 })), null);
});
