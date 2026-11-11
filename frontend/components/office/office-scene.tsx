"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef, type ComponentRef, type RefObject } from "react";
import {
  BoxGeometry, CylinderGeometry, Group, MathUtils, MeshBasicMaterial, MeshStandardMaterial,
  MOUSE, OrthographicCamera, SphereGeometry, Vector3,
} from "three";
import type { Agent, AgentStatus } from "../../lib/office/model";

type Triple = [number, number, number];
export type CameraCommand = { action: "in" | "out" | "reset" };

const statusColors: Record<AgentStatus, string> = {
  idle: "#91a7c8", queued: "#f5bf69", working: "#55ead8", completed: "#c391ff", failed: "#fc879e",
};
const wardrobe = ["#9877dd", "#568acc", "#63b7ad", "#ce8c7a", "#bb83b6", "#7084ca"];
const skin = ["#efb89e", "#ac705a", "#d99b77", "#865342"];
const hair = ["#232030", "#30201c", "#514130", "#20283a"];

const cube = new BoxGeometry();
const sphere = new SphereGeometry(1, 10, 8);
const cylinder = new CylinderGeometry(1, 1, 1, 10);
const materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();

function material(color: string, lit: boolean) {
  const key = `${lit}:${color}`;
  const existing = materials.get(key);
  if (existing) return existing;

  const value = lit ? new MeshStandardMaterial({ color, roughness: 0.85 }) : new MeshBasicMaterial({ color });
  materials.set(key, value);
  return value;
}

function Solid({ position, scale, color, shape = "box", lit = true }: {
  position: Triple;
  scale: Triple;
  color: string;
  shape?: "box" | "sphere" | "cylinder";
  lit?: boolean;
}) {
  const geometry = shape === "sphere" ? sphere : shape === "cylinder" ? cylinder : cube;
  return <mesh position={position} scale={scale} geometry={geometry} material={material(color, lit)} />;
}

const homeDirection = new Vector3(9, 15, 20);
const corners = [-8.2, 8.2].flatMap((x) =>
  [-0.55, 2.6].flatMap((y) => [-5.6, 5.6].map((z) => new Vector3(x, y, z))));
const panButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };

function Camera({ command, reducedMotion }: { command: CameraCommand | null; reducedMotion: boolean }) {
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const home = useRef({ position: homeDirection.clone(), target: new Vector3(), zoom: 1 });
  const destination = useRef<{ zoom: number; reset: boolean } | null>(null);

  useLayoutEffect(() => {
    const orbit = controls.current;
    if (!orbit || !size.width || !size.height) return;

    camera.position.copy(homeDirection);
    camera.lookAt(0, 0, 0);
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const horizontal = corners.map((point) => point.dot(right));
    const vertical = corners.map((point) => point.dot(up));
    const minX = Math.min(...horizontal);
    const maxX = Math.max(...horizontal);
    const minY = Math.min(...vertical);
    const maxY = Math.max(...vertical);
    const target = right.multiplyScalar((minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2);
    const zoom = Math.min(size.width / (maxX - minX), size.height / (maxY - minY)) * 0.88;

    home.current = { target, zoom, position: homeDirection.clone().add(target) };
    orbit.target.copy(target);
    orbit.minZoom = zoom * 0.65;
    orbit.maxZoom = zoom * 2.2;
    camera.position.copy(home.current.position);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    orbit.update();
    destination.current = null;
    invalidate();
  }, [camera, size.width, size.height, invalidate]);

  useEffect(() => {
    const orbit = controls.current;
    if (!command || !orbit) return;
    const reset = command.action === "reset";
    const base = destination.current?.zoom ?? camera.zoom;
    const zoom = reset ? home.current.zoom
      : MathUtils.clamp(base * (command.action === "in" ? 1.25 : 0.8), orbit.minZoom, orbit.maxZoom);

    if (reducedMotion) {
      if (reset) {
        camera.position.copy(home.current.position);
        orbit.target.copy(home.current.target);
      }
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
      orbit.update();
      invalidate();
    } else {
      destination.current = { zoom, reset };
    }
  }, [camera, command, invalidate, reducedMotion]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    const goal = destination.current;
    if (!orbit || !goal) return;
    const easing = 1 - Math.exp(-delta * 13);
    camera.zoom = MathUtils.lerp(camera.zoom, goal.zoom, easing);
    if (goal.reset) {
      camera.position.lerp(home.current.position, easing);
      orbit.target.lerp(home.current.target, easing);
    }
    const zoomReached = Math.abs(camera.zoom - goal.zoom) < 0.03;
    const positionReached = !goal.reset || camera.position.distanceToSquared(home.current.position) < 0.0001;
    if (zoomReached && positionReached) {
      camera.zoom = goal.zoom;
      if (goal.reset) {
        camera.position.copy(home.current.position);
        orbit.target.copy(home.current.target);
      }
      destination.current = null;
    }
    camera.updateProjectionMatrix();
    orbit.update();
  });

  return <OrbitControls ref={controls} enableRotate={false} enableDamping={!reducedMotion}
    dampingFactor={0.13} mouseButtons={panButtons} onStart={() => { destination.current = null; }} />;
}

function Avatar({ index, status, reducedMotion }: { index: number; status: AgentStatus; reducedMotion: boolean }) {
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const shirt = wardrobe[index % wardrobe.length];
  const complexion = skin[index % skin.length];
  const hairstyle = hair[index % hair.length];

  useFrame(({ clock }, delta) => {
    if (reducedMotion || !body.current || !head.current || !leftArm.current || !rightArm.current) return;

    const t = clock.elapsedTime + index * 0.61;
    const ease = 1 - Math.exp(-Math.min(delta, 0.05) * 10);
    const lean = status === "failed" ? 0.24 : status === "working" ? 0.09 : 0;
    const nod = status === "queued" ? Math.sin(t * 1.5) * 0.1
      : status === "failed" ? 0.26 : Math.sin(t * 2) * 0.04;
    const lift = status === "completed" ? -0.6 + Math.sin(t * 2.6) * 0.13 : 0;
    const typing = status === "working" ? Math.sin(t * 12) * 0.15 : 0;
    body.current.rotation.x = MathUtils.lerp(body.current.rotation.x, lean, ease);
    body.current.position.y = 0.74 + Math.sin(t * 2) * 0.018;
    head.current.rotation.x = MathUtils.lerp(head.current.rotation.x, nod, ease);
    leftArm.current.rotation.x = MathUtils.lerp(leftArm.current.rotation.x, typing, ease);
    rightArm.current.rotation.x = MathUtils.lerp(rightArm.current.rotation.x, lift - typing, ease);
  });

  return (
    <group position={[0, 0, -0.56]}>
      {[-0.15, 0.15].map((x) => (
        <group key={x}>
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

function stationPosition(index: number): Triple {
  return [(index % 4 - 1.5) * 3.65, 0, (Math.floor(index / 4) - 1) * 3.25];
}

function Station({ agent, index, selected, select, reducedMotion }: {
  agent: Agent; index: number; selected: boolean; select: () => void; reducedMotion: boolean;
}) {
  const tone = statusColors[agent.status];
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
        <Avatar index={index} status={agent.status} reducedMotion={reducedMotion} />
        <group position={[-0.51, 0.89, 0.42]} rotation={[0, -0.27, 0]}>
          <Solid position={[0, 0.06, 0]} scale={[0.33, 0.07, 0.25]} color="#283047" />
          <Solid position={[0, 0.17, 0]} scale={[0.08, 0.25, 0.075]} color="#283047" />
          <Solid position={[0, 0.37, 0]} scale={[0.91, 0.56, 0.08]} color="#242940" />
          <Solid position={[0, 0.37, 0.044]} scale={[0.81, 0.46, 0.012]} color="#2b346a" lit={false} />
          <Solid position={[0, 0.36, -0.044]} scale={[0.81, 0.46, 0.012]} color="#493581" lit={false} />
          <Solid position={[-0.15, 0.34, 0.054]} scale={[0.36, 0.025, 0.013]} color={tone} lit={false} />
          <Solid position={[-0.05, 0.23, 0.054]} scale={[0.49, 0.02, 0.013]} color="#7887b2" lit={false} />
        </group>
        <Solid position={[0.06, 0.9, 0.14]} scale={[0.57, 0.04, 0.21]} color="#434e6d" />
        <Solid position={[0.66, 0.93, 0.48]} scale={[0.09, 0.15, 0.09]} color="#9c88cc" shape="cylinder" />
      </group>

    </group>
  );
}

function Floor() {
  return (
    <group>
      <Solid position={[0, -0.28, 0]} scale={[16.3, 0.55, 11.1]} color="#34375c" />
      <Solid position={[0, -0.02, 0]} scale={[16.05, 0.04, 10.85]} color="#292e4c" />
      <gridHelper args={[16, 16, "#41486d", "#353d5c"]} position={[0, 0.006, 0]} scale={[1, 1, 0.674]} />
      <Solid position={[0, 0.93, -5.49]} scale={[16.3, 1.9, 0.19]} color="#404466" />
      <Solid position={[-8.06, 0.93, 0]} scale={[0.18, 1.9, 11.1]} color="#39436d" />
      <Solid position={[0, 1.91, -5.49]} scale={[16.32, 0.075, 0.24]} color="#7163a7" />
      <Solid position={[-8.06, 1.91, 0]} scale={[0.24, 0.075, 11.1]} color="#555da0" />
      {[-5, 0, 5].map((x) => <Solid key={x} position={[x, 1.39, -5.37]} scale={[2.7, 0.065, 0.03]} color="#9b7cfa" lit={false} />)}
      {[-3.3, 0, 3.3].map((z) => <Solid key={z} position={[-7.95, 1.03, z]} scale={[0.025, 1.36, 0.18]} color="#63b5fc" lit={false} />)}
      <Solid position={[0, -0.14, 5.57]} scale={[16.2, 0.05, 0.027]} color="#9d7af4" lit={false} />
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

export default function OfficeScene({ agents, selectedId, onSelect, command, reducedMotion, onUnavailable }: {
  agents: readonly Agent[];
  selectedId?: string;
  onSelect: (id: string) => void;
  command: CameraCommand | null;
  reducedMotion: boolean;
  onUnavailable: () => void;
}) {
  const labels = useRef(new Map<string, HTMLButtonElement>());

  return (
    <div className="office-scene-content">
    <Canvas orthographic dpr={[1, 1.4]} flat
      camera={{ position: [9, 15, 20], near: 0.1, far: 120 }}
      gl={{ alpha: false, antialias: true, powerPreference: "low-power" }}
      frameloop={reducedMotion ? "demand" : "always"}>
      <color attach="background" args={["#0d1222"]} />
      <ambientLight intensity={0.95} color="#c4ccff" />
      <directionalLight position={[5, 9, 7]} intensity={2} color="#dad4ff" />
      <directionalLight position={[-5, 4, -4]} intensity={1.7} color="#6954ff" />
      <pointLight position={[3, 4, -4]} intensity={27} distance={15} color="#497bff" />
      <Camera command={command} reducedMotion={reducedMotion} />
      <ContextGuard onUnavailable={onUnavailable} />
      <Floor />
      <ProjectNameplates agents={agents} labels={labels} />
      {agents.map((agent, index) => (
        <Station key={agent.id} agent={agent} index={index} selected={agent.id === selectedId}
          reducedMotion={reducedMotion} select={() => onSelect(agent.id)} />
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
