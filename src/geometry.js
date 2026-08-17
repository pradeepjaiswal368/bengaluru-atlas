/**
 * Pure geometry helpers shared by the city builder and the pin layer.
 * No three.js and no DOM in here — just numbers.
 */

import {
  DISTRICTS,
  LANDMARK_SHAPE,
  LANDMARKS,
  ROAD_WIDTH,
  ROADS,
  project,
} from "./geo.js";

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

/**
 * Half-width of the asphalt itself, plus room for the widest vehicle to pass
 * without clipping a wall. The corridor above is a *centre* setback that keeps
 * roads reading as corridors; this is the hard edge nothing may overlap, and
 * drive mode is what made the difference matter — the ambient fleet was always
 * small enough to get away with it.
 */
const VEHICLE_HALF_WIDTH = 0.34;
const PAVEMENT = Object.fromEntries(
  Object.entries(ROAD_WIDTH).map(([tier, width]) => [tier, width / 2 + VEHICLE_HALF_WIDTH])
);

// Flattened segment list, built once. Each segment carries both radii: the
// corridor (for the centre test) and the pavement (for the footprint test),
// plus its unit tangent — the building placer uses the tangent to line
// buildings up along the street instead of spinning them to global axes.
export const ROAD_SEGMENTS = (() => {
  const segments = [];
  for (const road of ROADS) {
    const pts = ringToWorld(road.path);
    if (road.closed) pts.push(pts[0]);
    const radius = CORRIDOR[road.tier] ?? CORRIDOR.street;
    const pavement = PAVEMENT[road.tier] ?? PAVEMENT.street;
    const r2 = radius * radius;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      const len = Math.hypot(dx, dz) || 1;
      segments.push({
        ax: pts[i].x,
        az: pts[i].z,
        bx: pts[i + 1].x,
        bz: pts[i + 1].z,
        r2,
        pavement,
        corridor: radius,
        tier: road.tier,
        tx: dx / len,
        tz: dz / len,
      });
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

/**
 * Nearest road to a point: its distance, unit tangent, tier and corridor
 * radius. Buildings snap their rotation to the tangent so the massing reads
 * as blocks that follow the actual streets, not a global grid.
 */
export function nearestRoad(x, z) {
  let best = null;
  let bestD2 = Infinity;
  for (const s of ROAD_SEGMENTS) {
    const d2 = segmentDistanceSq(x, z, s.ax, s.az, s.bx, s.bz);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = s;
    }
  }
  return {
    distance: Math.sqrt(bestD2),
    tx: best.tx,
    tz: best.tz,
    tier: best.tier,
    corridor: best.corridor,
  };
}

/**
 * True when a footprint centred on (x, z) reaches onto any road's asphalt.
 * `halfExtent` is the footprint's circumradius, so the answer holds whatever
 * angle the building is rotated to.
 *
 * `nearRoad` only ever tested the centre point, which a 1.1–3.7 unit wide
 * building can pass while still paving over a 0.57-unit street — every road on
 * the board had buildings standing in the drivable lane.
 */
export function onRoadSurface(x, z, halfExtent) {
  for (const s of ROAD_SEGMENTS) {
    const r = s.pavement + halfExtent;
    if (segmentDistanceSq(x, z, s.ax, s.az, s.bx, s.bz) < r * r) return true;
  }
  return false;
}

/**
 * Push a footprint off the asphalt, perpendicular to whichever road it sits
 * deepest in. Procedural buildings can simply be rejected and re-rolled, but
 * landmarks are authored at real coordinates — the Electronic City flyover
 * really is on Hosur Road — so they get moved to the kerb instead of dropped.
 */
export function clearRoadSurface(x, z, halfExtent) {
  let px = x;
  let pz = z;
  // Clearing one road can push the footprint into another; a few passes settle
  // it, and the cap keeps a landmark boxed in by two roads from looping.
  for (let pass = 0; pass < 8; pass++) {
    let worst = null;
    let worstDepth = 0;
    for (const s of ROAD_SEGMENTS) {
      const need = s.pavement + halfExtent;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const lengthSq = dx * dx + dz * dz;
      let t = lengthSq === 0 ? 0 : ((px - s.ax) * dx + (pz - s.az) * dz) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.ax + t * dx;
      const cz = s.az + t * dz;
      const depth = need - Math.hypot(px - cx, pz - cz);
      if (depth > worstDepth) {
        worstDepth = depth;
        worst = { cx, cz, need, dx, dz };
      }
    }
    if (!worst) break;

    // Outward normal from the road; if the footprint is centred exactly on the
    // centreline there is no outward direction, so use the segment's own.
    let nx = px - worst.cx;
    let nz = pz - worst.cz;
    let length = Math.hypot(nx, nz);
    if (length < 1e-4) {
      nx = -worst.dz;
      nz = worst.dx;
      length = Math.hypot(nx, nz) || 1;
    }
    px = worst.cx + (nx / length) * (worst.need + 0.02);
    pz = worst.cz + (nz / length) * (worst.need + 0.02);
  }
  return { x: px, z: pz };
}

/**
 * Where a landmark actually stands, with road clearance applied. Resolved once
 * and shared: the city builder places the mesh and the label layer anchors the
 * name, and a mesh nudged without its label leaves the name over the road.
 */
const LANDMARK_ANCHORS = new Map(
  LANDMARKS.map((landmark) => {
    const p = project(landmark.lat, landmark.lng);
    const shape = LANDMARK_SHAPE[landmark.kind] ?? LANDMARK_SHAPE.transit;
    return [landmark.id, clearRoadSurface(p.x, p.z, shape.radius)];
  })
);

export function landmarkAnchor(landmark) {
  return LANDMARK_ANCHORS.get(landmark.id) ?? project(landmark.lat, landmark.lng);
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
