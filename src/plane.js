/**
 * Bengaluru AI Atlas — a lone airliner circling the city.
 *
 * Sits outside the city group on purpose: the city is rebuilt wholesale on a
 * theme swap, but the plane is scenery that keeps flying through it. A simple
 * orbit around the board, banking gently into the turn, with wingtip nav
 * lights (red/port, green/starboard) and a blinking strobe.
 */

import * as THREE from "three";
import { BOARD } from "./geo.js";

const ORBIT_RADIUS = Math.hypot(BOARD.halfWidth, BOARD.halfDepth) * 0.72;
const ORBIT_HEIGHT = 95;
const ORBIT_PERIOD = 85; // seconds per lap — slow enough to notice, fast enough to feel alive
const BANK = 0.32; // radians of roll into the turn

/** Wingtip nav lights, drawn as tiny glowing spheres. */
function navLight(color, intensity) {
  const material = new THREE.MeshBasicMaterial({ color });
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), material);
  light.userData.intensity = intensity;
  return light;
}

/**
 * Builds the plane. Returns `{ group, update, setTheme, dispose }`.
 * `update(dt)` advances the orbit; `setTheme(theme)` fades the strobe between
 * day (barely visible) and night (a proper beacon).
 */
export function createPlane() {
  const group = new THREE.Group();
  group.name = "plane";

  const body = new THREE.Group();
  group.add(body);

  const metal = new THREE.MeshStandardMaterial({
    color: 0xdfe3ea,
    roughness: 0.45,
    metalness: 0.7,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x2e6db4,
    roughness: 0.5,
    metalness: 0.4,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x242a33,
    roughness: 0.6,
    metalness: 0.3,
  });

  // Fuselage — an elongated capsule shape, nose to tail along +Z.
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 7.2, 10), metal);
  fuselage.rotation.x = Math.PI / 2; // lay it on its side
  fuselage.scale.z = 1.35; // stretch the nose
  body.add(fuselage);

  // Nose cone.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.6, 10), accent);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 4.2;
  body.add(nose);

  // Wings — one wide swept plank across the middle.
  const wings = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.16, 1.7), metal);
  wings.position.z = 0.4;
  body.add(wings);

  // Wingtip nav lights: red on the port (left) side, green on starboard.
  const redLight = navLight(0xff3b30, 1.6);
  redLight.position.set(-4.85, 0.1, 0.4);
  const greenLight = navLight(0x34c759, 1.6);
  greenLight.position.set(4.85, 0.1, 0.4);
  body.add(redLight, greenLight);

  // Strobe beacon on the tail — the blinking white light.
  const strobe = navLight(0xffffff, 2.2);
  strobe.position.set(0, 1.15, -3.5);
  body.add(strobe);

  // Tailplane — horizontal stabiliser + fin.
  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.14, 1.1), metal);
  tailplane.position.set(0, 0.35, -3.5);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.5, 1.1), accent);
  fin.position.set(0, 1.0, -3.5);
  body.add(tailplane, fin);

  // Engines — a pair of nacelles under the wings.
  const engineGeo = new THREE.CylinderGeometry(0.28, 0.3, 1.5, 8);
  for (const side of [-1, 1]) {
    const engine = new THREE.Mesh(engineGeo, dark);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(side * 1.7, -0.45, 0.4);
    body.add(engine);
  }

  // Tilt the whole plane so the nose points up slightly in level flight.
  body.rotation.x = 0.06;

  // Plane's own position object — orbit centre is the board origin.
  const position = new THREE.Vector3(ORBIT_RADIUS, ORBIT_HEIGHT, 0);
  group.position.copy(position);

  let elapsed = 0;
  let strobePhase = 0;

  function update(dt) {
    elapsed += dt;
    // Orbital angle — counter-clockwise as seen from above.
    const angle = (elapsed / ORBIT_PERIOD) * Math.PI * 2;
    position.x = Math.cos(angle) * ORBIT_RADIUS;
    position.z = Math.sin(angle) * ORBIT_RADIUS;
    group.position.copy(position);

    // The fuselage's nose is local +Z; after a yaw θ it points at
    // (sin θ, 0, cos θ). The orbit's velocity at angle a is
    // (−sin a, 0, cos a), so the plane faces its travel direction when
    // θ = −a. (A 90° error here makes the plane crab sideways around the
    // circle — the previous formula had exactly that bug.)
    body.rotation.y = -angle;
    // Constant bank into the turn. For a counter-clockwise orbit the plane
    // turns left the whole way round, so the bank never flips sign. A fixed
    // 0.32 rad lean is what sells the arc at a glance.
    body.rotation.z = BANK;

    // Strobe blinks — a double-pulse like a real beacon.
    strobePhase += dt * 1.4;
    const t = strobePhase % 1;
    const on = t < 0.08 || (t > 0.5 && t < 0.58);
    strobe.material.opacity = on ? 1 : 0.12;
    strobe.material.transparent = true;
  }

  function setTheme(theme) {
    // Day: the strobe is barely there. Night: it reads as a beacon through
    // the bloom. Nav lights keep their colour either way.
    const dim = theme === "light" ? 0.25 : 1;
    redLight.userData.dim = dim;
    greenLight.userData.dim = dim;
    strobe.userData.dim = dim;
    if (strobe.material) {
      strobe.material.opacity = dim;
    }
  }

  function dispose() {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }

  return { group, update, setTheme, dispose };
}
