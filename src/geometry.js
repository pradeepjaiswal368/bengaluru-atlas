/**
 * Pure geometry helpers shared by the city builder and the pin layer.
 * No three.js and no DOM in here — just numbers.
 */

import { DISTRICTS, ROADS, project } from "./geo.js";

/** Deterministic PRNG so the generated skyline never shifts between loads. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash, used to seed a PRNG per district. */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** lat/lng ring → array of {x, z} in world space. */
export function ringToWorld(ring) {
  return ring.map(([lat, lng]) => project(lat, lng));
}

/** Even-odd ray-crossing point-in-polygon test, in world XZ. */
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const zi = ring[i].z;
    const xj = ring[j].x;
    const zj = ring[j].z;
    const crosses = zi > z !== zj > z;
    if (crosses && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBounds(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Shoelace area, so "density" means the same thing in every district. */
export function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  }
  return Math.abs(sum / 2);
}

// District rings in world space, cached — used for pin clearance lookups.
const DISTRICT_RINGS = DISTRICTS.map((d) => ({
  id: d.id,
  ring: ringToWorld(d.ring),
  maxHeight: d.height[1],
}));

/**
 * How high the local massing reaches at a point. Pins sit above this so a
 * company in a Bellandur glass tower isn't swallowed by its own neighbourhood.
 */
export function clearanceAt(x, z) {
  let tallest = 0;
  for (const d of DISTRICT_RINGS) {
    if (d.maxHeight > tallest && pointInRing(x, z, d.ring)) tallest = d.maxHeight;
  }
  return tallest;
}

// ── Road corridors ──────────────────────────────────────────────────────────

/** Half-width of the build-free corridor each road tier keeps around itself. */
const CORRIDOR = { ring: 2.0, arterial: 1.3, street: 0.8 };

// Flattened segment list with a squared radius per segment, built once.
const ROAD_SEGMENTS = (() => {
  const segments = [];
  for (const road of ROADS) {
    const pts = ringToWorld(road.path);
    if (road.closed) pts.push(pts[0]);
    const radius = CORRIDOR[road.tier] ?? CORRIDOR.street;
    const r2 = radius * radius;
    for (let i = 0; i < pts.length - 1; i++) {
      segments.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z, r2 });
    }
  }
  return segments;
})();

/** Squared distance from a point to a line segment, in world XZ. */
function segmentDistanceSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  // Degenerate segment: fall back to the point distance.
  if (lengthSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

/**
 * True when a point falls inside any road's corridor. Buildings are rejected
 * here, which is what keeps the Outer Ring Road and the arterials readable as
 * corridors through the fabric instead of being paved over by it.
 */
export function nearRoad(x, z) {
  for (const s of ROAD_SEGMENTS) {
    if (segmentDistanceSq(x, z, s.ax, s.az, s.bx, s.bz) < s.r2) return true;
  }
  return false;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Framerate-independent exponential smoothing. */
export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
