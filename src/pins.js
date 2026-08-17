/**
 * Bengaluru AI Atlas — company pins.
 *
 * One pin per startup: a ground halo, a stem, and an emissive head. Heads are
 * lifted clear of the local massing so a company inside a Bellandur glass tower
 * isn't swallowed by its own neighbourhood.
 *
 * Picking uses an oversized invisible sphere per pin, so the click target stays
 * comfortable even when the camera is pulled all the way back.
 */

import * as THREE from "three";
import { PIN_KINDS } from "./data.js";
import { project } from "./geo.js";
import { clamp, clearanceAt, damp, hashSeed } from "./geometry.js";

const KIND_COLOR = new Map(PIN_KINDS.map((k) => [k.id, k.color]));
const DEFAULT_COLOR = PIN_KINDS[0].color;

const HEAD_RADIUS = 0.62;
const STEM_RADIUS = 0.085;
const HIT_RADIUS = 2.6;

// Shared geometry — 57 pins, but no reason to build 57 spheres.
const headGeometry = new THREE.SphereGeometry(HEAD_RADIUS, 20, 14);
const stemGeometry = new THREE.CylinderGeometry(STEM_RADIUS, STEM_RADIUS, 1, 6, 1, true);
const haloGeometry = new THREE.RingGeometry(0.85, 1.25, 28);
haloGeometry.rotateX(-Math.PI / 2);
const hitGeometry = new THREE.SphereGeometry(HIT_RADIUS, 8, 6);
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });

/**
 * @param {Array} startups records from data.js
 * @returns {{group: THREE.Group, pins: Array, pickables: THREE.Object3D[]}}
 */
export function createPins(startups) {
  const group = new THREE.Group();
  group.name = "pins";

  const pins = [];
  const pickables = [];

  for (const startup of startups) {
    const p = project(startup.lat, startup.lng);
    const colorHex = KIND_COLOR.get(startup.office) ?? DEFAULT_COLOR;
    const color = new THREE.Color(colorHex);

    // Sit above whatever the district builds to, with a floor for open areas.
    // The per-company stagger matters more than it looks: in a pocket like
    // Koramangala a dozen pins land within a few hundred metres, and at equal
    // height their labels collide and get culled — losing exactly the companies
    // the cluster is known for. Spreading the heads vertically separates the
    // labels physically, so no name has to be dropped.
    const stagger = ((hashSeed(startup.id) % 1000) / 1000) * 3.6;
    const headY = Math.max(5.2, clearanceAt(p.x, p.z) + 3.2) + stagger;

    const pinGroup = new THREE.Group();
    pinGroup.position.set(p.x, 0, p.z);
    pinGroup.name = `pin:${startup.id}`;

    const haloMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.position.y = 0.14;
    pinGroup.add(halo);

    const stemMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.42,
    });
    const stem = new THREE.Mesh(stemGeometry, stemMaterial);
    // Unit cylinder is centred on its origin, so scale then lift by half.
    stem.scale.y = headY;
    stem.position.y = headY / 2;
    pinGroup.add(stem);

    const headMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.85,
      roughness: 0.28,
      metalness: 0.1,
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = headY;
    pinGroup.add(head);

    const hit = new THREE.Mesh(hitGeometry, hitMaterial);
    hit.position.y = headY;
    hit.userData.startupId = startup.id;
    pinGroup.add(hit);

    group.add(pinGroup);

    const pin = {
      startup,
      group: pinGroup,
      head,
      halo,
      stem,
      hit,
      headY,
      color,
      world: new THREE.Vector3(p.x, headY, p.z),
      // animation state
      scale: 1,
      targetScale: 1,
      glow: 0.85,
      targetGlow: 0.85,
      dim: 1,
      targetDim: 1,
      hovered: false,
      selected: false,
      inArea: true,
    };

    pins.push(pin);
    pickables.push(hit);
  }

  return { group, pins, pickables };
}

/**
 * The camera distance at which a pin renders at its authored size. Pins are
 * scaled by (distance / this), which keeps them roughly constant in screen
 * space — otherwise a pin that reads as a neat dot across the whole plateau
 * becomes a beach ball the moment you fly into a cluster.
 */
const REFERENCE_DISTANCE = 176;

/**
 * Theme-level multiplier on head emissive. Glowing orbs are the night look;
 * in daylight the same intensity blows out to white, so light mode runs the
 * pins as mostly-solid colour with a trace of glow.
 */
let glowScale = 1;

export function setPinGlowScale(scale) {
  glowScale = scale;
}

const KIND_BY_ID = new Map(PIN_KINDS.map((k) => [k.id, k]));

/**
 * Recolour every pin for a theme. The saffron/teal that glow on the night
 * board sit at ~1.5:1 against light-mode's paper ground, so daylight runs
 * deeper versions of the same hues (PIN_KINDS.lightColor).
 */
export function setPinTheme(pins, theme) {
  for (const pin of pins) {
    const kind = KIND_BY_ID.get(pin.startup.office) ?? PIN_KINDS[0];
    const hex = theme === "light" ? (kind.lightColor ?? kind.color) : kind.color;
    pin.color.set(hex);
    pin.head.material.color.set(hex);
    pin.head.material.emissive.set(hex);
    pin.stem.material.color.set(hex);
    pin.halo.material.color.set(hex);
  }
}

/**
 * Per-frame pin animation. Targets are set by the interaction layer; this just
 * eases toward them so hover and selection feel physical rather than binary.
 *
 * @param {Array} pins
 * @param {number} dt seconds since last frame
 * @param {THREE.Camera} camera used for screen-space size compensation
 */
export function updatePins(pins, dt, camera) {
  for (const pin of pins) {
    pin.targetScale = pin.selected ? 1.85 : pin.hovered ? 1.42 : 1;
    pin.targetGlow = pin.selected ? 2.1 : pin.hovered ? 1.5 : 0.85;
    pin.targetDim = pin.inArea ? 1 : 0.22;

    pin.scale = damp(pin.scale, pin.targetScale, 14, dt);
    pin.glow = damp(pin.glow, pin.targetGlow, 12, dt);
    pin.dim = damp(pin.dim, pin.targetDim, 8, dt);

    const distance = camera ? camera.position.distanceTo(pin.world) : REFERENCE_DISTANCE;
    const screen = clamp(distance / REFERENCE_DISTANCE, 0.16, 1.5);
    const size = pin.scale * screen;

    pin.head.scale.setScalar(size);
    pin.head.material.emissiveIntensity = pin.glow * pin.dim * glowScale;
    pin.head.material.opacity = pin.dim;
    pin.head.material.transparent = pin.dim < 0.99;

    // Stem keeps its height (that's the pin's real elevation) but thins out.
    pin.stem.scale.set(screen, pin.headY, screen);
    pin.stem.material.opacity = 0.42 * pin.dim;

    pin.halo.scale.setScalar(clamp(size * 0.95, 0.12, 2.4));
    pin.halo.material.opacity = (pin.selected ? 0.5 : 0.22) * pin.dim;
  }
}

/** Dim every pin outside the given area. `"all"` un-dims everything. */
export function setPinArea(pins, areaId) {
  for (const pin of pins) {
    pin.inArea = areaId === "all" || pin.startup.area === areaId;
  }
}

export function clearPinStates(pins, { keepSelected = null } = {}) {
  for (const pin of pins) {
    pin.hovered = false;
    pin.selected = keepSelected != null && pin.startup.id === keepSelected;
  }
}
