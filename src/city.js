/**
 * Bengaluru AI Atlas — city construction.
 *
 * Turns the hand-authored lat/lng geography in geo.js into three.js meshes:
 * ground, lakes, parks, roads, metro lines, landmark structures, and a few
 * thousand procedural buildings scattered inside the district polygons.
 *
 * Building placement is seeded, so the skyline is identical on every load.
 */

import * as THREE from "three";
import {
  BOARD,
  DISTRICTS,
  LAKES,
  LANDMARKS,
  METRO_LINES,
  PARKS,
  ROADS,
  centroidOf,
  metres,
  project,
} from "./geo.js";
import {
  hashSeed,
  mulberry32,
  nearRoad,
  pointInRing,
  ringArea,
  ringBounds,
  ringToWorld,
} from "./geometry.js";

// ── Palettes ────────────────────────────────────────────────────────────────
// Kept in JS (not CSS) because these drive materials, not layout. One palette
// per theme, identical key sets. Dark is the "city at night" board the HUD was
// designed around; light is a paper map — ink roads darker than the ground, so
// the road hierarchy inverts brightness but keeps its order.

export const PALETTES = {
  dark: {
    ground: 0x11151e,
    districtFloor: 0x222a37,
    water: 0x14526e,
    waterRim: 0x54d8e8,
    park: 0x1c4a2c,
    parkRim: 0x4fae66,
    airfield: 0x222732,
    airfieldRim: 0x4a5262,
    roadRing: 0x6a7789,
    roadArterial: 0x4d5768,
    roadStreet: 0x3a424f,
    building: 0x39414f,
    buildingHi: 0x6b7583,
    landmark: 0x5b6a84,
    landmarkTop: 0xff9a3c,
    metroStation: 0x0d1016,
    // Emissive terms carry the night look; by day they drop to a whisper.
    metroEmissive: 0.42,
    stationEmissive: 0.95,
    landmarkCapEmissive: 0.8,
    // Warm sodium-and-fluorescent window light, and how hot it burns. Above
    // the bloom threshold on purpose, so lit floors bleed into the air.
    windowLight: 0xffcb7a,
    windowIntensity: 1.15,
    /** Share of buildings with their lights on. */
    litShare: 0.62,
  },
  light: {
    ground: 0xe7e3d8,
    districtFloor: 0xd9d2c2,
    water: 0x74bcd8,
    waterRim: 0x2688a6,
    park: 0xaad493,
    parkRim: 0x5aa044,
    airfield: 0xd9d5c9,
    airfieldRim: 0xa9a494,
    roadRing: 0x878e9a,
    roadArterial: 0xa4a9b2,
    roadStreet: 0xbdc0c6,
    // Tall cores go darker on paper, not lighter — that's how depth reads by day.
    building: 0xd8d2c5,
    buildingHi: 0xaba293,
    landmark: 0xa89f8e,
    landmarkTop: 0xe27b12,
    metroStation: 0xf7f4ec,
    metroEmissive: 0.14,
    stationEmissive: 0.2,
    landmarkCapEmissive: 0.1,
    // Daylight windows read as dark glass, not light sources.
    windowLight: 0x5d6b7d,
    windowIntensity: 0.0,
    litShare: 0.5,
  },
};

/**
 * Window grid, generated once into a canvas and used as an emissive map. Rows
 * of lit cells with gaps punched out, so floors read as individually occupied
 * rather than a uniform glow. Sampled on the building box's side faces.
 */
function makeWindowTexture(rng) {
  const cols = 6;
  const rows = 9;
  const cell = 8;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < rows; row++) {
    // Whole dark floors here and there — plant rooms, empty leases.
    const floorLit = rng() > 0.3;
    for (let col = 0; col < cols; col++) {
      if (!floorLit || rng() > 0.55) continue;
      // Vary brightness per window so the grid doesn't read as a decal. Kept
      // mid-range: at full brightness the grid reads as a stack of crates
      // rather than a lit building.
      const v = 96 + Math.floor(rng() * 96);
      ctx.fillStyle = `rgb(${v},${Math.floor(v * 0.85)},${Math.floor(v * 0.63)})`;
      ctx.fillRect(col * cell + 2, row * cell + 2, cell - 4, cell - 3);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Linear, not Nearest: crisp texel edges are exactly what made the grid read
  // as printed-on cargo markings.
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Collapses the top and bottom face UVs onto a black texel, so the window map
 * only lands on the walls. Without this every rooftop wears the same grid —
 * and since the camera looks down at the board, that was the single biggest
 * reason the massing read as stacked crates rather than buildings.
 *
 * BoxGeometry emits faces in the order +X, −X, +Y, −Y, +Z, −Z, four vertices
 * each, so the roof and floor are vertices 8 through 15.
 */
function darkenRoofUVs(geometry) {
  const uv = geometry.attributes.uv;
  for (let i = 8; i < 16; i++) uv.setXY(i, 0.004, 0.004);
  uv.needsUpdate = true;
  return geometry;
}

// The palette the builders read from; buildCity() swaps it per theme.
let PALETTE = PALETTES.dark;

const Y = {
  ground: 0,
  districtFloor: 0.02,
  park: 0.05,
  water: 0.06,
  road: 0.09,
  metro: 0.65,
  building: 0.1,
};

// ── Mesh helpers ────────────────────────────────────────────────────────────

/** Flat filled polygon lying on the XZ plane at height y. */
function polygonMesh(worldRing, color, y, opts = {}) {
  const shape = new THREE.Shape();
  worldRing.forEach((p, i) => {
    // Shape lives in XY; we rotate −90° about X, which maps shape-y → world −z.
    // Feed it −z so the polygon lands the right way round.
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  });
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape, 12);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.92,
    metalness: opts.metalness ?? 0.02,
    side: THREE.DoubleSide,
    transparent: opts.opacity !== undefined,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = y;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** Outline for a polygon — reads as a shoreline or a park edge. */
function polygonOutline(worldRing, color, y, opacity = 0.55) {
  const pts = worldRing.map((p) => new THREE.Vector3(p.x, y, p.z));
  pts.push(pts[0].clone());
  const geometry = new THREE.BufferGeometry().setFromPoints(pts);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const line = new THREE.Line(geometry, material);
  line.matrixAutoUpdate = false;
  line.updateMatrix();
  return line;
}

/**
 * Flat ribbon along a polyline — how every road is drawn. Builds a quad strip,
 * mitring each interior joint along the averaged normal so corners stay closed.
 */
function ribbonGeometry(pts, width, closed = false) {
  const path = closed ? [...pts, pts[0], pts[1]] : pts;
  const half = width / 2;
  const left = [];
  const right = [];

  for (let i = 0; i < path.length; i++) {
    const prev = path[i - 1] ?? path[i];
    const next = path[i + 1] ?? path[i];

    // Averaged tangent at this vertex, then its 2D normal.
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;

    left.push([path[i].x + nx * half, path[i].z + nz * half]);
    right.push([path[i].x - nx * half, path[i].z - nz * half]);
  }

  const positions = [];
  const uvs = [];
  for (let i = 0; i < path.length - 1; i++) {
    const l0 = left[i];
    const r0 = right[i];
    const l1 = left[i + 1];
    const r1 = right[i + 1];
    // two triangles per segment, wound CCW when viewed from +y
    positions.push(l0[0], 0, l0[1], r0[0], 0, r0[1], l1[0], 0, l1[1]);
    positions.push(r0[0], 0, r0[1], r1[0], 0, r1[1], l1[0], 0, l1[1]);
    uvs.push(0, i, 1, i, 0, i + 1, 1, i, 1, i + 1, 0, i + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

// ── Layers ──────────────────────────────────────────────────────────────────

function buildGround() {
  // Far wider than the board: the plane's own edge has to fall well outside the
  // fog's reach, or it reads as a hard horizon line cutting across the sky.
  const geometry = new THREE.PlaneGeometry(BOARD.halfWidth * 12, BOARD.halfDepth * 12);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: PALETTE.ground,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = Y.ground;
  mesh.name = "ground";
  mesh.receiveShadow = true;
  return mesh;
}

function buildDistrictFloors() {
  const group = new THREE.Group();
  group.name = "districtFloors";
  for (const district of DISTRICTS) {
    if (district.floor === false) continue;
    const ring = ringToWorld(district.ring);
    // Kept faint on purpose: enough to hint "denser here", not enough for the
    // polygon's own silhouette to read as a shape on the map.
    group.add(
      polygonMesh(ring, PALETTE.districtFloor, Y.districtFloor, {
        opacity: 0.42,
        depthWrite: false,
      })
    );
  }
  return group;
}

function buildParks() {
  const group = new THREE.Group();
  group.name = "parks";
  for (const park of PARKS) {
    const ring = ringToWorld(park.ring);
    const isAirfield = park.kind === "airfield";
    group.add(
      polygonMesh(ring, isAirfield ? PALETTE.airfield : PALETTE.park, Y.park, {
        roughness: 0.98,
      })
    );
    group.add(
      polygonOutline(ring, isAirfield ? PALETTE.airfieldRim : PALETTE.parkRim, Y.park + 0.01, 0.45)
    );
  }
  return group;
}

function buildLakes() {
  const group = new THREE.Group();
  group.name = "lakes";
  for (const lake of LAKES) {
    const ring = ringToWorld(lake.ring);
    group.add(
      // Low metalness on purpose: there is no environment map in this scene, so
      // a metallic surface has nothing to reflect and renders almost black.
      polygonMesh(ring, PALETTE.water, Y.water, {
        roughness: 0.55,
        metalness: 0.12,
      })
    );
    group.add(polygonOutline(ring, PALETTE.waterRim, Y.water + 0.015, 0.72));
  }
  return group;
}

function buildRoads() {
  const group = new THREE.Group();
  group.name = "roads";

  const spec = {
    ring: { width: metres(230), color: PALETTE.roadRing, y: Y.road + 0.02 },
    arterial: { width: metres(150), color: PALETTE.roadArterial, y: Y.road + 0.01 },
    street: { width: metres(85), color: PALETTE.roadStreet, y: Y.road },
  };

  for (const road of ROADS) {
    const cfg = spec[road.tier] ?? spec.street;
    const pts = ringToWorld(road.path);
    const geometry = ribbonGeometry(pts, cfg.width, Boolean(road.closed));
    const material = new THREE.MeshStandardMaterial({
      color: cfg.color,
      roughness: 0.85,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = cfg.y;
    mesh.name = `road:${road.id}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }
  return group;
}

function buildMetro() {
  const group = new THREE.Group();
  group.name = "metro";

  for (const line of METRO_LINES) {
    const pts = ringToWorld(line.path).map((p) => new THREE.Vector3(p.x, Y.metro, p.z));

    // A gently curved tube reads better than a hard polyline at this scale.
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.25);
    const geometry = new THREE.TubeGeometry(curve, pts.length * 8, metres(28), 6, false);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(line.color),
      roughness: 0.45,
      metalness: 0.15,
      emissive: new THREE.Color(line.color),
      emissiveIntensity: PALETTE.metroEmissive,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `metro:${line.id}`;
    group.add(mesh);

    // Station nodes: small rings pinned to the line.
    const stationGeo = new THREE.CylinderGeometry(metres(90), metres(90), metres(18), 12);
    const stationMat = new THREE.MeshStandardMaterial({
      color: PALETTE.metroStation,
      roughness: 0.6,
      emissive: new THREE.Color(line.color),
      emissiveIntensity: PALETTE.stationEmissive,
    });
    const stations = new THREE.InstancedMesh(stationGeo, stationMat, line.stations.length);
    const m = new THREE.Matrix4();
    line.stations.forEach(([lat, lng], i) => {
      const p = project(lat, lng);
      m.makeTranslation(p.x, Y.metro, p.z);
      stations.setMatrixAt(i, m);
    });
    stations.name = `metroStations:${line.id}`;
    group.add(stations);
  }
  return group;
}

/**
 * Procedural buildings. One InstancedMesh for the whole city, with per-instance
 * colour so the massing has some tonal variation. Heights are biased toward the
 * district centroid, which gives each cluster a readable peak.
 */
function buildBuildings() {
  const exclusions = [
    ...LAKES.map((l) => ringToWorld(l.ring)),
    ...PARKS.map((p) => ringToWorld(p.ring)),
  ];

  const instances = [];

  for (const district of DISTRICTS) {
    const ring = ringToWorld(district.ring);
    const bounds = ringBounds(ring);
    const area = ringArea(ring);
    const target = Math.round(area * district.density);
    const rng = mulberry32(hashSeed(district.id));
    const centre = centroidOf(district.ring);
    const centreWorld = project(centre.lat, centre.lng);
    const spanX = bounds.maxX - bounds.minX;
    const spanZ = bounds.maxZ - bounds.minZ;
    const maxRadius = Math.hypot(spanX, spanZ) / 2 || 1;

    let placed = 0;
    let attempts = 0;
    const attemptCap = target * 40;

    // Spatial hash of placed footprints (keyed by cell) so a candidate is
    // rejected when it would touch an existing building. Overlapping boxes
    // were the biggest single source of the board's clutter — no real city
    // lets towers share a footprint. The hash uses a conservative circle per
    // building (its axis-aligned half-extent), so it stays cheap and works
    // for any rotation.
    const CELL = 1.6;
    const MIN_GAP = 0.4;
    const occupied = new Map();

    while (placed < target && attempts < attemptCap) {
      attempts++;
      const x = bounds.minX + rng() * spanX;
      const z = bounds.minZ + rng() * spanZ;
      if (!pointInRing(x, z, ring)) continue;
      if (exclusions.some((ex) => pointInRing(x, z, ex))) continue;
      if (nearRoad(x, z)) continue;

      // The sparse fabric layer uses smaller plots, so it reads as low-rise
      // surroundings rather than competing with the named cores.
      const [plotMin, plotRange] = district.plot ?? (district.grid ? [1.3, 1.9] : [1.1, 2.6]);
      const w = plotMin + rng() * plotRange;
      const d = plotMin + rng() * plotRange;
      const half = Math.max(w, d) / 2;

      // Reject candidates that would collide with an already-placed neighbour.
      const cx = Math.floor(x / CELL);
      const cz = Math.floor(z / CELL);
      let blocked = false;
      scan: for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const cell = occupied.get(`${gx}:${gz}`);
          if (!cell) continue;
          for (const n of cell) {
            const dx = n.x - x;
            const dz = n.z - z;
            const rr = n.half + half + MIN_GAP;
            if (dx * dx + dz * dz < rr * rr) {
              blocked = true;
              break scan;
            }
          }
        }
      }
      if (blocked) continue;

      // Closer to the middle of the district ⇒ taller, with noise on top.
      const distance = Math.hypot(x - centreWorld.x, z - centreWorld.z) / maxRadius;
      const coreBias = Math.max(0, 1 - distance * 1.15);
      const [minH, maxH] = district.height;
      // rng()**2.2 keeps most buildings low and lets a few spike.
      const roll = Math.pow(rng(), 2.2);
      const height = minH + (maxH - minH) * (roll * 0.62 + coreBias * 0.55);

      // Street-aligned massing: boxes snap to a block direction with a little
      // noise instead of spinning freely — freely-rotated crates were the
      // other big clutter source. Organic districts keep occasional diagonal
      // pockets so the fabric doesn't read as a grid it isn't.
      const jitter = (rng() - 0.5) * 0.12;
      const rotation = district.grid
        ? (rng() < 0.5 ? 0 : Math.PI / 2) + jitter
        : rng() < 0.78
          ? (rng() < 0.5 ? 0 : Math.PI / 2) + jitter
          : Math.PI / 4 + (rng() < 0.5 ? 0 : Math.PI / 2) + jitter;

      instances.push({ x, z, height, w, d, rotation, coreBias, tint: district.tint });

      const key = `${cx}:${cz}`;
      let cell = occupied.get(key);
      if (!cell) occupied.set(key, (cell = []));
      cell.push({ x, z, half });
      placed++;
    }
  }

  const geometry = darkenRoofUVs(new THREE.BoxGeometry(1, 1, 1));
  // Shift the box so scaling grows it upward from the ground plane.
  geometry.translate(0, 0.5, 0);

  /**
   * Buildings are bucketed by height, because a unit box's UVs are fixed at
   * [0,1] and InstancedMesh can't vary them per instance without a custom
   * shader. One texture repeat per band keeps the storeys roughly the same
   * real size everywhere — otherwise a one-storey shed wears sixteen floors of
   * glass and the whole fabric layer reads as stacked crates.
   *
   * The lowest band gets no window grid at all: at map scale its windows would
   * be sub-pixel, and a faint flat glow reads better than mush.
   */
  const BANDS = [
    // Low-rise is residential fabric: a few windows on, no grid, and kept dim.
    // Give this band real glow and the whole backdrop turns into sugar cubes
    // that out-shout the towers they're supposed to sit behind.
    { id: "low", max: 3.2, repeat: null, emissive: 0.16, litScale: 0.35 },
    { id: "mid", max: 7.5, repeat: [1.4, 1.9], emissive: 0.8, litScale: 1 },
    { id: "tall", max: Infinity, repeat: [1.6, 3.8], emissive: 1, litScale: 1.15 },
  ];

  const litRng = mulberry32(hashSeed("window-lights"));
  // buckets[bandIndex] = [darkInstances, litInstances]
  const buckets = BANDS.map(() => [[], []]);
  for (const instance of instances) {
    const bandIndex = BANDS.findIndex((b) => instance.height <= b.max);
    // Taller buildings are likelier to be offices with floors still working.
    const chance =
      PALETTE.litShare *
      BANDS[bandIndex].litScale *
      (0.7 + Math.min(0.55, instance.height / 14));
    buckets[bandIndex][litRng() < chance ? 1 : 0].push(instance);
  }

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const low = new THREE.Color(PALETTE.building);
  const high = new THREE.Color(PALETTE.buildingHi);
  const tint = new THREE.Color();
  const colour = new THREE.Color();

  const meshes = [];
  let litCount = 0;

  BANDS.forEach((band, bandIndex) => {
    band.repeatTexture = null;

    buckets[bandIndex].forEach((set, isLit) => {
      if (!set.length) return;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.22 });
      if (isLit && PALETTE.windowIntensity > 0) {
        material.emissive = new THREE.Color(PALETTE.windowLight);
        material.emissiveIntensity = PALETTE.windowIntensity * band.emissive;
        if (band.repeat) {
          // One texture per band: repeat lives on the texture, not the material.
          const texture = makeWindowTexture(mulberry32(hashSeed(`window-${band.id}`)));
          texture.repeat.set(band.repeat[0], band.repeat[1]);
          material.emissiveMap = texture;
        }
        litCount += set.length;
      }

      const mesh = new THREE.InstancedMesh(geometry, material, set.length);
      mesh.name = `buildings:${band.id}${isLit ? ":lit" : ""}`;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      set.forEach((b, i) => {
        position.set(b.x, Y.building, b.z);
        quaternion.setFromAxisAngle(up, b.rotation);
        scale.set(b.w, b.height, b.d);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);

        // Taller cores read lighter, so the skyline has depth…
        colour.copy(low).lerp(high, Math.min(1, b.coreBias * 0.3 + b.height / 11));
        // …then the district's own hue is mixed in, which is what stops the
        // whole board reading as one grey mass: glass-blue on the ORR,
        // terracotta in the old city (see DISTRICTS[].tint in geo.js).
        if (b.tint !== undefined) {
          tint.setHex(b.tint);
          colour.lerp(tint, 0.38);
        }
        mesh.setColorAt(i, colour);
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      meshes.push(mesh);
    });
  });

  return { meshes, count: instances.length, litCount };
}

/** Landmarks get their own silhouettes plus a warm cap, so they stand out. */
function buildLandmarks() {
  const group = new THREE.Group();
  group.name = "landmarks";

  const body = new THREE.MeshStandardMaterial({
    color: PALETTE.landmark,
    roughness: 0.55,
    metalness: 0.28,
  });
  const cap = new THREE.MeshStandardMaterial({
    color: PALETTE.landmarkTop,
    roughness: 0.4,
    emissive: new THREE.Color(PALETTE.landmarkTop),
    emissiveIntensity: PALETTE.landmarkCapEmissive,
  });

  for (const landmark of LANDMARKS) {
    const p = project(landmark.lat, landmark.lng);
    const h = landmark.height;
    let geometry;

    switch (landmark.kind) {
      case "tower":
        geometry = new THREE.CylinderGeometry(1.05, 1.45, h, 8);
        break;
      case "civic":
        geometry = new THREE.BoxGeometry(3.6, h, 2.4);
        break;
      case "campus":
        geometry = new THREE.BoxGeometry(2.8, h, 2.8);
        break;
      case "transit":
      default:
        geometry = new THREE.CylinderGeometry(1.5, 1.5, h, 6);
        break;
    }

    const mesh = new THREE.Mesh(geometry, body);
    mesh.position.set(p.x, h / 2 + Y.building, p.z);
    mesh.name = `landmark:${landmark.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const capMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), cap);
    capMesh.position.set(p.x, h + Y.building + 0.3, p.z);
    group.add(capMesh);
  }

  return group;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Builds the whole city into a single group. Returns the group plus a few
 * stats the HUD reports, and the layer handles the renderer wants to tweak.
 *
 * Theme switching rebuilds rather than retints: the build is deterministic and
 * takes tens of milliseconds, so a rebuild is simpler and safer than keeping a
 * registry of every material ↔ palette-key pairing in sync. Callers must
 * disposeCity() the old group first.
 *
 * @param {"dark"|"light"} theme
 */
export function buildCity(theme = "dark") {
  PALETTE = PALETTES[theme] ?? PALETTES.dark;

  const city = new THREE.Group();
  city.name = "city";

  const ground = buildGround();
  const districtFloors = buildDistrictFloors();
  const parks = buildParks();
  const lakes = buildLakes();
  const roads = buildRoads();
  const metro = buildMetro();
  const landmarks = buildLandmarks();
  const { meshes: buildings, count: buildingCount, litCount } = buildBuildings();

  city.add(ground, districtFloors, parks, lakes, roads, metro, ...buildings, landmarks);

  return {
    city,
    layers: { ground, districtFloors, parks, lakes, roads, metro, buildings, landmarks },
    stats: { buildingCount, litCount },
  };
}

/**
 * Frees GPU resources of a city group built by buildCity(). Every mesh here
 * owns its geometry and material (nothing is shared with the pins), so a plain
 * traverse-and-dispose is safe.
 */
export function disposeCity(group) {
  group.traverse((obj) => {
    // InstancedMesh keeps instanceMatrix/instanceColor on the mesh, not the
    // geometry — its own dispose() is what evicts them from the renderer's
    // attribute cache. Without this, every theme toggle leaks the previous
    // skyline's instance buffers.
    if (obj.isInstancedMesh) obj.dispose();
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) material.dispose();
    }
  });
}
