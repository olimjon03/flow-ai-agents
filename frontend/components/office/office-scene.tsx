"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef, type ComponentRef, type RefObject } from "react";
import {
  BoxGeometry, CircleGeometry, CylinderGeometry, Group, InstancedMesh, MathUtils, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  MOUSE, TOUCH, OrthographicCamera, SphereGeometry, Vector3,
} from "three";
import { handoffPhase, sampleWalk, walkingDistance, type AvatarState, type TaskHandoff } from "../../lib/office/handoff";
import { handoffPath, meetingTable, officeBounds, stationPosition, type Point } from "../../lib/office/navigation";
import type { Agent, AgentStatus } from "../../lib/office/model";

type Triple = [number, number, number];
export type CameraCommand = { action: "in" | "out" | "reset" | "top" | "isometric" };

const statusColors: Record<AgentStatus, string> = {
  idle: "#91a7c8", queued: "#f5bf69", working: "#55ead8", completed: "#c391ff", failed: "#fc879e", cancelled: "#b5a2b9",
};
const wardrobe = ["#9877dd", "#568acc", "#63b7ad", "#ce8c7a", "#bb83b6", "#7084ca"];
const skin = ["#efb89e", "#ac705a", "#d99b77", "#865342"];
const hair = ["#232030", "#30201c", "#514130", "#20283a"];

const cube = new BoxGeometry();
const sphere = new SphereGeometry(1, 10, 8);
const cylinder = new CylinderGeometry(1, 1, 1, 10);
const contactGeometry = new CircleGeometry(1, 12);
const contactMaterial = new MeshBasicMaterial({ color: "#111321", transparent: true, opacity: 0.32, depthWrite: false });
const materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

function material(color: string, lit: boolean, opacity: number) {
  const key = `${lit}:${color}:${opacity}`;
  const existing = materials.get(key);
  if (existing) return existing;

  const value = lit ? new MeshStandardMaterial({ color, roughness: 0.85, opacity, transparent: opacity < 1, depthWrite: opacity === 1 }) : new MeshBasicMaterial({ color });
  materials.set(key, value);
  return value;
}

function Solid({ position, scale, color, shape = "box", lit = true, opacity = 1 }: {
  position: Triple;
  scale: Triple;
  color: string;
  shape?: "box" | "sphere" | "cylinder";
  lit?: boolean;
  opacity?: number;
}) {
  const geometry = shape === "sphere" ? sphere : shape === "cylinder" ? cylinder : cube;
  return <mesh position={position} scale={scale} geometry={geometry} material={material(color, lit, opacity)} />;
}

const homeDirection = new Vector3(9, 15, 20);
const corners = [officeBounds.left, officeBounds.right].flatMap((x) =>
  [-0.55, 2.6].flatMap((y) => [officeBounds.back, officeBounds.front].map((z) => new Vector3(x, y, z))));
const orbitButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
const orbitTouches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

function fitOffice(direction: Vector3, width: number, height: number) {
  const reference = new OrthographicCamera();
  reference.position.copy(direction);
  reference.lookAt(0, 0, 0);
  const right = new Vector3(1, 0, 0).applyQuaternion(reference.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(reference.quaternion);
  const horizontal = corners.map((point) => point.dot(right));
  const vertical = corners.map((point) => point.dot(up));
  const minX = Math.min(...horizontal);
  const maxX = Math.max(...horizontal);
  const minY = Math.min(...vertical);
  const maxY = Math.max(...vertical);
  const target = right.multiplyScalar((minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2);
  const zoom = Math.min(width / (maxX - minX), height / (maxY - minY)) * 0.88;
  return { target, zoom, position: direction.clone().add(target) };
}

function Camera({ command, reducedMotion }: { command: CameraCommand | null; reducedMotion: boolean }) {
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const canvas = useThree((state) => state.gl.domElement);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const home = useRef({ position: homeDirection.clone(), target: new Vector3(), zoom: 1 });
  const destination = useRef<{ zoom: number; preset: typeof home.current | null } | null>(null);
  const offset = useRef(new Vector3());
  const targetOffset = useRef(new Vector3());
  const handled = useRef<CameraCommand | null>(null);

  useEffect(() => {
    const orbit = controls.current;
    if (!orbit) return;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "3D office view. Use arrow keys to pan.");
    function pan(event: KeyboardEvent) {
      if (!orbit || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const directions: Record<string, readonly [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
      };
      const direction = directions[event.key];
      if (!direction || !event.key.startsWith("Arrow")) return;
      event.preventDefault();
      destination.current = null;
      const offset = new Vector3(direction[0], direction[1], 0)
        .applyQuaternion(camera.quaternion).multiplyScalar(24 / camera.zoom);
      camera.position.add(offset);
      orbit.target.add(offset);
      orbit.update();
      invalidate();
    }
    canvas.addEventListener("keydown", pan);
    return () => canvas.removeEventListener("keydown", pan);
  }, [camera, canvas, invalidate]);

  useLayoutEffect(() => {
    const orbit = controls.current;
    if (!orbit || !size.width || !size.height) return;

    home.current = fitOffice(homeDirection, size.width, size.height);
    orbit.target.copy(home.current.target);
    orbit.minZoom = home.current.zoom * 0.55;
    orbit.maxZoom = home.current.zoom * 2.4;
    camera.position.copy(home.current.position);
    camera.zoom = home.current.zoom;
    camera.updateProjectionMatrix();
    orbit.update();
    destination.current = null;
    invalidate();
  }, [camera, size.width, size.height, invalidate]);

  useEffect(() => {
    const orbit = controls.current;
    if (!command || !orbit || handled.current === command) return;
    handled.current = command;
    const preset = command.action === "top"
      ? fitOffice(new Vector3(0, 26, 0.8), size.width, size.height)
      : command.action === "reset" || command.action === "isometric" ? home.current : null;
    const base = destination.current?.zoom ?? camera.zoom;
    const zoom = preset ? preset.zoom
      : MathUtils.clamp(base * (command.action === "in" ? 1.25 : 0.8), orbit.minZoom, orbit.maxZoom);

    if (reducedMotion) {
      if (preset) {
        camera.position.copy(preset.position);
        orbit.target.copy(preset.target);
      }
      destination.current = null;
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      orbit.update();
      invalidate();
    } else {
      destination.current = { zoom, preset };
      invalidate();
    }
  }, [camera, command, invalidate, reducedMotion, size.width, size.height]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    const goal = destination.current;
    if (!orbit || !goal) return;
    const easing = 1 - Math.exp(-delta * 13);
    camera.zoom = MathUtils.lerp(camera.zoom, goal.zoom, easing);
    if (goal.preset) {
      const current = offset.current.copy(camera.position).sub(orbit.target);
      const radius = current.length();
      const desired = targetOffset.current.copy(goal.preset.position).sub(goal.preset.target);
      const targetRadius = desired.length();
      current.normalize().lerp(desired.normalize(), easing).normalize()
        .multiplyScalar(MathUtils.lerp(radius, targetRadius, easing));
      orbit.target.lerp(goal.preset.target, easing);
      camera.position.copy(orbit.target).add(current);
    }
    const zoomReached = Math.abs(camera.zoom - goal.zoom) < 0.03;
    const poseReached = !goal.preset || camera.position.distanceToSquared(goal.preset.position) < 0.01;
    if (zoomReached && poseReached) {
      camera.zoom = goal.zoom;
      if (goal.preset) {
        camera.position.copy(goal.preset.position);
        orbit.target.copy(goal.preset.target);
      }
      destination.current = null;
    } else {
      invalidate();
    }
    camera.updateProjectionMatrix();
    orbit.update();
  });

  function clampPan() {
    const orbit = controls.current;
    if (!orbit) return;
    const { x, y, z } = orbit.target;
    const dx = MathUtils.clamp(x, -7, 4) - x;
    const dy = MathUtils.clamp(y, -0.5, 3) - y;
    const dz = MathUtils.clamp(z, -4, 4) - z;
    if (dx || dy || dz) {
      orbit.target.set(x + dx, y + dy, z + dz);
      camera.position.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
      camera.updateMatrixWorld();
    }
  }

  return <OrbitControls ref={controls} enableDamping={!reducedMotion}
    minPolarAngle={0.025} maxPolarAngle={1.13} dampingFactor={0.13}
    mouseButtons={orbitButtons} touches={orbitTouches} onChange={clampPan}
    onStart={() => { destination.current = null; }} />;
}

type Flight = {
  event: TaskHandoff;
  path: Point[];
  returnPath: Point[];
  length: number;
  elapsed: number;
};
type FlightRef = RefObject<Flight | null>;
const walkingSpeed = 6;

function HandoffDirector({ events, agents, flight, enabled }: {
  events: readonly TaskHandoff[];
  agents: readonly Agent[];
  flight: FlightRef;
  enabled: boolean;
}) {
  // Events already present on mount are history, including after toggling views.
  const seen = useRef(events.at(-1)?.id);
  const pending = useRef<TaskHandoff[]>([]);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const latest = events.at(-1);
    if (!enabled || !latest) {
      flight.current = null;
      pending.current = [];
      seen.current = latest?.id;
      return;
    }
    if (flight.current && flight.current.event.runId !== latest.runId) flight.current = null;
    if (seen.current === latest.id) return;
    const last = events.findIndex(({ id }) => id === seen.current);
    pending.current = [...pending.current, ...events.slice(last + 1)].filter(({ runId }) => runId === latest.runId).slice(-3);
    seen.current = latest.id;
    invalidate();
  }, [enabled, events, flight, invalidate]);

  useFrame((_, delta) => {
    if (!enabled) return;
    if (flight.current) {
      flight.current.elapsed += Math.min(delta, 0.2);
      if (!handoffPhase(flight.current.elapsed, flight.current.length / walkingSpeed)) flight.current = null;
    }
    if (flight.current || pending.current.length) invalidate();
    if (flight.current || !pending.current.length) return;
    const event = pending.current.shift()!;
    const from = agents.findIndex(({ id }) => id === event.fromAgentId);
    const to = agents.findIndex(({ id }) => id === event.toAgentId);
    if (from < 0 || to < 0) return;
    const path = handoffPath(from, to);
    if (!path) return;
    flight.current = { event, path, returnPath: [...path].reverse(), length: walkingDistance(path), elapsed: 0 };
  }, -0.5);
  return null;
}

function Avatar({ agent, index, reducedMotion, lowGraphics, flight, labels }: {
  agent: Agent;
  index: number;
  reducedMotion: boolean;
  lowGraphics: boolean;
  flight: FlightRef;
  labels: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const { status } = agent;
  const root = useRef<Group>(null);
  const legs = useRef<(Group | null)[]>([]);
  const celebration = useRef(0);
  const previousStatus = useRef(status);
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const shirt = wardrobe[index % wardrobe.length];
  const complexion = skin[index % skin.length];
  const hairstyle = hair[index % hair.length];

  useFrame(({ clock }, delta) => {
    if (!root.current || !body.current || !head.current || !leftArm.current || !rightArm.current) return;

    const t = clock.elapsedTime + index * 0.61;
    const ease = reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 0.05) * 12);
    if (status === "completed" && previousStatus.current !== status) celebration.current = 1.1;
    previousStatus.current = status;
    celebration.current = Math.max(0, celebration.current - delta);
    let state: AvatarState = status === "failed" ? "error" : status === "working" ? "typing"
      : status === "completed" && celebration.current > 0 ? "celebrating_completion"
        : status === "queued" ? "sitting" : "idle";
    let x = 0;
    let z = -0.56;
    let yaw = 0;
    const active = reducedMotion ? null : flight.current;
    if (active) {
      const duration = active.length / walkingSpeed;
      const phase = handoffPhase(active.elapsed, duration);
      if (phase && active.event.fromAgentId === agent.id) {
        state = phase;
        const returning = phase === "returning_to_desk";
        const distance = returning ? (active.elapsed - 1 - duration) * walkingSpeed
          : Math.max(0, (active.elapsed - 0.35) * walkingSpeed);
        const sample = sampleWalk(returning ? active.returnPath : active.path, distance);
        const [deskX, , deskZ] = stationPosition(index);
        x = sample.x - deskX;
        z = sample.z - deskZ;
        yaw = phase === "handing_over_task" ? -Math.PI / 2 : sample.yaw;
      } else if (phase === "handing_over_task" && active.event.toAgentId === agent.id) {
        state = "receiving_task";
        yaw = Math.PI / 2;
      }
    }

    const moving = state === "walking" || state === "returning_to_desk";
    const standing = moving || state === "standing_up" || state === "handing_over_task";
    const animate = !reducedMotion && !lowGraphics;
    const gait = moving ? Math.sin(t * 17) : 0;
    const lean = state === "error" ? 0.28 : state === "typing" ? 0.12 : 0;
    const gesture = state === "handing_over_task" || state === "receiving_task" ? -0.92
      : state === "celebrating_completion" ? -0.62 : 0;
    const typing = state === "typing" && animate ? Math.sin(t * 12) * 0.15 : 0;
    root.current.position.set(x, 0, z);
    const turn = Math.atan2(Math.sin(yaw - root.current.rotation.y), Math.cos(yaw - root.current.rotation.y));
    root.current.rotation.y += turn * ease;
    body.current.rotation.x = MathUtils.lerp(body.current.rotation.x, lean, ease);
    body.current.position.y = MathUtils.lerp(body.current.position.y, standing ? 1.03 + Math.abs(gait) * 0.06 : 0.74, ease);
    head.current.rotation.x = state === "error" ? 0.26 : animate ? Math.sin(t * 2) * 0.04 : 0;
    leftArm.current.rotation.x = MathUtils.lerp(leftArm.current.rotation.x, typing + gait * 0.4, ease);
    rightArm.current.rotation.x = MathUtils.lerp(rightArm.current.rotation.x, gesture - typing - gait * 0.4, ease);
    legs.current.forEach((leg, legIndex) => {
      if (!leg) return;
      leg.position.z = standing ? -0.16 + gait * (legIndex ? -0.18 : 0.18) : 0;
      leg.rotation.x = standing ? -0.25 + gait * (legIndex ? -0.45 : 0.45) : 0;
    });
    const label = labels.current.get(agent.id);
    if (label && label.dataset.motion !== state) label.dataset.motion = state;
  });

  return (
    <group ref={root} position={[0, 0, -0.56]}>
      {[-0.15, 0.15].map((x, legIndex) => (
        <group key={x} ref={(leg) => { legs.current[legIndex] = leg; }}>
          <Solid position={[x, 0.53, 0.18]} scale={[0.19, 0.2, 0.5]} color="#26324e" />
          <Solid position={[x, 0.29, 0.4]} scale={[0.18, 0.45, 0.19]} color="#26324e" />
          <Solid position={[x, 0.08, 0.47]} scale={[0.19, 0.13, 0.29]} color="#171b2e" />
        </group>
      ))}
      <group ref={body} position={[0, 0.74, 0]} rotation={[status === "failed" ? 0.24 : 0, 0, 0]}>
        <Solid position={[0, 0.17, 0]} scale={[0.29, 0.37, 0.2]} color={shirt} shape="sphere" />
        <Solid position={[0, 0.46, 0]} scale={[0.085, 0.16, 0.085]} color={complexion} shape="cylinder" />
        <group ref={head} position={[0, 0.63, 0.015]}>
          <Solid position={[0, 0, 0]} scale={[0.205, 0.24, 0.19]} color={complexion} shape="sphere" />
          <Solid position={[0, 0.11, -0.055]} scale={[0.214, 0.18, 0.18]} color={hairstyle} shape="sphere" />
          {index % 3 === 0 && <Solid position={[0, 0.23, -0.14]} scale={[0.095, 0.09, 0.09]} color={hairstyle} shape="sphere" />}
          {[-0.073, 0.073].map((x) =>
            <Solid key={x} position={[x, 0.018, 0.178]} scale={[0.016, 0.023, 0.013]} color="#191525" shape="sphere" />)}
        </group>
        <group ref={leftArm} position={[-0.24, 0.26, 0.04]}>
          <Solid position={[-0.04, -0.09, 0.04]} scale={[0.105, 0.21, 0.105]} color={shirt} shape="sphere" />
          <Solid position={[-0.04, -0.15, 0.21]} scale={[0.075, 0.07, 0.17]} color={complexion} shape="sphere" />
        </group>
        <group ref={rightArm} position={[0.24, 0.26, 0.04]}>
          <Solid position={[0.04, -0.09, 0.04]} scale={[0.105, 0.21, 0.105]} color={shirt} shape="sphere" />
          <Solid position={[0.04, -0.15, 0.21]} scale={[0.075, 0.07, 0.17]} color={complexion} shape="sphere" />
        </group>
      </group>
    </group>
  );
}

function Station({ agent, index, selected, select, reducedMotion, lowGraphics, flight, labels }: {
  agent: Agent; index: number; selected: boolean; select: () => void; reducedMotion: boolean;
  lowGraphics: boolean; flight: FlightRef; labels: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const tone = statusColors[agent.status];
  const monitor = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!monitor.current) return;
    monitor.current.scale.x = !reducedMotion && !lowGraphics && agent.status === "working"
      ? 0.65 + 0.35 * Math.sin(clock.elapsedTime * 3 + index) : 1;
  });
  return (
    <group position={stationPosition(index)}>
      <group onClick={(event) => { event.stopPropagation(); select(); }}>
        <Solid position={[0, 0.018, 0.05]} scale={[2.75, 0.03, 2.27]} color={selected ? "#6550a2" : "#313654"} />
        <Solid position={[0, 0.81, 0.36]} scale={[2.08, 0.14, 0.9]} color="#9da5c7" />
        <Solid position={[0, 0.7, 0.81]} scale={[1.83, 0.065, 0.035]} color={tone} lit={false} />
        {[-0.91, 0.91].map((side) =>
          <Solid key={side} position={[side, 0.4, 0.39]} scale={[0.12, 0.77, 0.72]} color="#515b83" />)}
        <Solid position={[0, 0.49, -0.62]} scale={[0.64, 0.13, 0.6]} color="#262c46" />
        <Solid position={[0, 0.82, -0.88]} scale={[0.64, 0.69, 0.14]} color="#303750" />
        <Solid position={[0, 0.25, -0.62]} scale={[0.08, 0.45, 0.08]} color="#464c68" shape="cylinder" />
        <Solid position={[0, 0.08, -0.62]} scale={[0.34, 0.07, 0.34]} color="#272b41" shape="cylinder" />
        <Avatar agent={agent} index={index} reducedMotion={reducedMotion} lowGraphics={lowGraphics} flight={flight} labels={labels} />
        <group position={[-0.51, 0.89, 0.42]} rotation={[0, -0.27, 0]}>
          <Solid position={[0, 0.06, 0]} scale={[0.33, 0.07, 0.25]} color="#283047" />
          <Solid position={[0, 0.17, 0]} scale={[0.08, 0.25, 0.075]} color="#283047" />
          <Solid position={[0, 0.37, 0]} scale={[0.91, 0.56, 0.08]} color="#242940" />
          <Solid position={[0, 0.37, 0.044]} scale={[0.81, 0.46, 0.012]} color="#2b346a" lit={false} />
          <Solid position={[0, 0.36, -0.044]} scale={[0.81, 0.46, 0.012]} color="#493581" lit={false} />
          <group ref={monitor} position={[-0.15, 0.34, 0.054]}>
            <Solid position={[0, 0, 0]} scale={[0.36, 0.025, 0.013]} color={tone} lit={false} />
          </group>
          <Solid position={[-0.05, 0.23, 0.054]} scale={[0.49, 0.02, 0.013]} color="#7887b2" lit={false} />
        </group>
        <Solid position={[0.06, 0.9, 0.14]} scale={[0.57, 0.04, 0.21]} color="#434e6d" />
        <Solid position={[0.66, 0.93, 0.48]} scale={[0.09, 0.15, 0.09]} color="#9c88cc" shape="cylinder" />
      </group>

    </group>
  );
}

function TransferMarker({ flight }: { flight: FlightRef }) {
  const marker = useRef<Group>(null);
  useFrame(() => {
    if (!marker.current) return;
    const active = flight.current;
    const phase = active ? handoffPhase(active.elapsed, active.length / walkingSpeed) : null;
    marker.current.visible = phase === "handing_over_task";
    if (active && marker.current.visible) {
      const [x, z] = active.path.at(-1)!;
      marker.current.position.set(x - 0.47, 1.55 + Math.sin(active.elapsed * 9) * 0.07, z);
      marker.current.rotation.y = active.elapsed * 4;
    }
  });
  return <group ref={marker} visible={false}>
    <Solid position={[0, 0, 0]} scale={[0.22, 0.12, 0.16]} color="#e3c0ff" lit={false} />
  </group>;
}

function ContactShadows() {
  const instances = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = instances.current;
    if (!mesh) return;
    const shadow = new Object3D();
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(1.44, 1.17, 1);
    for (let index = 0; index < 12; index++) {
      const [x, , z] = stationPosition(index);
      shadow.position.set(x, 0.009, z + 0.05);
      shadow.updateMatrix();
      mesh.setMatrixAt(index, shadow.matrix);
    }
    shadow.position.set(meetingTable.x, 0.009, meetingTable.z);
    shadow.updateMatrix();
    mesh.setMatrixAt(12, shadow.matrix);
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  return <instancedMesh ref={instances} args={[contactGeometry, contactMaterial, 13]} />;
}

function Floor({ glass }: { glass: boolean }) {
  return (
    <group>
      <Solid position={[-2, -0.28, 0]} scale={[20.3, 0.55, 11.1]} color="#34375c" />
      <Solid position={[-2, -0.02, 0]} scale={[20.05, 0.04, 10.85]} color="#292e4c" />
      <gridHelper args={[20, 20, "#41486d", "#353d5c"]} position={[-2, 0.006, 0]} scale={[1, 1, 0.54]} />
      <Solid position={[-2, 0.93, -5.49]} scale={[20.3, 1.9, 0.19]} color="#404466" opacity={glass ? 0.24 : 1} />
      <Solid position={[-12.06, 0.93, 0]} scale={[0.18, 1.9, 11.1]} color="#39436d" opacity={glass ? 0.24 : 1} />
      <Solid position={[-2, 1.91, -5.49]} scale={[20.32, 0.075, 0.24]} color="#7163a7" />
      <Solid position={[-12.06, 1.91, 0]} scale={[0.24, 0.075, 11.1]} color="#555da0" />
      {[-5, 0, 5].map((x) => <Solid key={x} position={[x, 1.39, -5.37]} scale={[2.7, 0.065, 0.03]} color="#9b7cfa" lit={false} />)}
      {[-3.3, 0, 3.3].map((z) => <Solid key={z} position={[-11.95, 1.03, z]} scale={[0.025, 1.36, 0.18]} color="#63b5fc" lit={false} />)}
      <Solid position={[-2, -0.14, 5.57]} scale={[20.2, 0.05, 0.027]} color="#9d7af4" lit={false} />
      <Solid position={[meetingTable.x, 0.74, meetingTable.z]} scale={[meetingTable.width, 0.15, meetingTable.depth]} color="#787fa9" />
      <Solid position={[meetingTable.x, 0.34, meetingTable.z]} scale={[0.45, 0.68, 0.45]} color="#394367" />
      {[-0.9, 0.9].flatMap((z) => [-0.55, 0.55].map((x) => (
        <Solid key={`${x}:${z}`} position={[meetingTable.x + x, 0.26, z]} scale={[0.45, 0.5, 0.42]} color="#545485" />
      )))}
      <Solid position={[8.17, -0.14, 0]} scale={[0.028, 0.05, 11.1]} color="#6792ec" lit={false} />
    </group>
  );
}

function ContextGuard({ onUnavailable }: { onUnavailable: () => void }) {
  const canvas = useThree((state) => state.gl.domElement);
  useEffect(() => {
    canvas.addEventListener("webglcontextlost", onUnavailable);
    return () => canvas.removeEventListener("webglcontextlost", onUnavailable);
  }, [canvas, onUnavailable]);
  return null;
}

function ProjectNameplates({ agents, labels }: {
  agents: readonly Agent[];
  labels: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const point = useRef(new Vector3());
  useFrame(({ camera, size }) => {
    camera.updateMatrixWorld();
    agents.forEach(({ id }, index) => {
      const button = labels.current.get(id);
      if (!button) return;
      const [x, , z] = stationPosition(index);
      point.current.set(x, 1.88, z - 0.36).project(camera);
      const left = Math.round((point.current.x + 1) * size.width / 2);
      const top = Math.round((1 - point.current.y) * size.height / 2);
      const transform = `translate(${left}px, ${top}px) translate(-50%, -50%)`;
      if (button.style.transform !== transform) button.style.transform = transform;
    });
  });

  return null;
}

export default function OfficeScene({ agents, selectedId, onSelect, command, reducedMotion, visible, lowGraphics, glass, handoffs, onUnavailable }: {
  agents: readonly Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  command: CameraCommand | null;
  reducedMotion: boolean;
  visible: boolean;
  lowGraphics: boolean;
  glass: boolean;
  handoffs: readonly TaskHandoff[];
  onUnavailable: () => void;
}) {
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const flight = useRef<Flight | null>(null);
  const animate = visible && !reducedMotion;

  return (
    <div className="office-scene-content">
    <Canvas orthographic dpr={lowGraphics ? 1 : [1, 1.4]} flat
      camera={{ position: [9, 15, 20], near: 0.1, far: 120 }}
      gl={{ alpha: false, antialias: true, powerPreference: "low-power" }}
      frameloop={animate && !lowGraphics ? "always" : "demand"}>
      <color attach="background" args={["#0d1222"]} />
      <ambientLight intensity={0.95} color="#c4ccff" />
      <directionalLight position={[5, 9, 7]} intensity={2} color="#dad4ff" />
      <directionalLight position={[-5, 4, -4]} intensity={1.7} color="#6954ff" />
      {!lowGraphics && <pointLight position={[3, 4, -4]} intensity={27} distance={15} color="#497bff" />}
      <Camera command={command} reducedMotion={!animate} />
      <ContextGuard onUnavailable={onUnavailable} />
      <Floor glass={glass} />
      {!lowGraphics && <ContactShadows />}
      <HandoffDirector events={handoffs} agents={agents} flight={flight} enabled={animate} />
      <TransferMarker flight={flight} />
      <ProjectNameplates agents={agents} labels={labels} />
      {agents.map((agent, index) => (
        <Station key={agent.id} agent={agent} index={index} selected={agent.id === selectedId}
          reducedMotion={!animate} lowGraphics={lowGraphics} flight={flight} labels={labels} select={() => onSelect(agent.id)} />
      ))}
    </Canvas>
      <div className="office-nameplates">
        {agents.map((agent) => (
          <button type="button" key={agent.id} className="office-nameplate"
            ref={(element) => {
              if (element) labels.current.set(agent.id, element);
              else labels.current.delete(agent.id);
            }}
            aria-label={`${agent.name} workstation · ${agent.status}`}
            aria-pressed={agent.id === selectedId} aria-controls="agent-details" onClick={() => onSelect(agent.id)}>
            <i aria-hidden="true" style={{ background: statusColors[agent.status] }} />{agent.name}
          </button>
        ))}
      </div>
    </div>
  );
}
