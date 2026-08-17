/**
 * Bengaluru AI Atlas — ambient traffic.
 *
 * Cars, scooters and a sprinkling of auto-rickshaws running along the same
 * road polylines the map draws, keeping left like the city does. Placement,
 * colours and speeds are seeded, so the traffic is identical on every load.
 *
 * Two looks, matching the board:
 *   dark  — vehicles keep their real livery (yellow cab, painted truck box),
 *           shaded by the city lights with hot lamps and roof signs
 *   light — the same instances switch to solid painted bodies under daylight
 *
 * Speeds are exaggerated the same way building heights are: to scale, a car
 * would cross the ORR in twenty real minutes and read as parked.
 *
 * Respects prefers-reduced-motion: the fleet still parks on the roads, it
 * just doesn't move.
 */

import * as THREE from "three";
import { ROADS } from "./geo.js";
import { clamp, hashSeed, mulberry32, ringToWorld } from "./geometry.js";

/** Per-tier traffic behaviour. `lanes` are offsets from the centreline in
 *  world units; `perUnit` is vehicles per unit of track (one track per
 *  direction). Ring roads get two lanes a side, like the real ORR. */
const TIER = {
  ring: { lanes: [0.3, 0.55], speed: [1.5, 2.2], perUnit: 0.26 },
  arterial: { lanes: [0.24], speed: [1.1, 1.7], perUnit: 0.18 },
  street: { lanes: [0.14], speed: [0.7, 1.1], perUnit: 0.12 },
};

/** Hard cap so an edit to the road network can't quietly triple the fleet. */
const MAX_VEHICLES = 280;

/** Vehicles sit just above the highest road surface (roads span y 0.09–0.11). */
export const VEHICLE_Y = 0.12;

/**
 * Vehicle classes. `share` is the probability slice; sizes are [w, h, l] in
 * world units, exaggerated like everything else on the board. Bengaluru's
 * split skews two-wheeler, and the autos are non-negotiable.
 */
const KINDS = [
  {
    id: "car",
    share: 0.4,
    size: [0.3, 0.17, 0.62],
    // Fleet scale: the parts are modelled at a base size; this multiplies the
    // whole vehicle (geometry + part offsets) so the proportions stay intact.
    scale: 2.0,
    speedFactor: 1,
    day: [0xf0efec, 0xc7cbd2, 0x99a0a9, 0x2b333f, 0x8e2f28, 0x2d4a76],
  },
  {
    id: "scooter",
    share: 0.35,
    size: [0.1, 0.15, 0.3],
    scale: 2.0,
    speedFactor: 0.88,
    wobble: true, // two-wheelers thread the lane rather than hold it
    day: [0x23272e, 0x8e2f28, 0x2b5038, 0x5a616b, 0x8a8f96],
  },
  {
    id: "auto",
    share: 0.12,
    size: [0.26, 0.22, 0.46],
    scale: 2.0,
    speedFactor: 0.78,
    // Classic cab livery: bright taxi yellow — the same #f5c518 accent the
    // HUD wears, so the taxis read as part of the brand.
    day: [0xf5c518, 0xffcc00, 0xe7b10a],
  },
  {
    id: "truck",
    share: 0.08,
    size: [0.44, 0.4, 1.2],
    scale: 1.9,
    speedFactor: 0.85,
    trunkOnly: true, // box trucks stick to the ring road and arterials
    // Classic Tata-fleet cab: white/cream up front…
    day: [0xf4f2ec, 0xe8e4d8, 0xdcd8cc],
    // …and the cargo box painted in deep fleet colours, like the painted
    // bodies on Indian highways.
    box: [0x1c4fd6, 0xc1272d, 0x2f6b3a, 0xb08a1e, 0x6d2a45],
  },
  {
    id: "bus",
    share: 0.05,
    size: [0.42, 0.42, 1.5],
    scale: 1.9,
    speedFactor: 0.72,
    trunkOnly: true, // BMTC service runs the majors, not the by-lanes
    day: [0xf4f6f8, 0xe8ecf2, 0xdbe4ee],
  },
];

/** Geometry builders: a box and a wheel cylinder (axle along X). */
function box(w, h, l) {
  return new THREE.BoxGeometry(w, h, l);
}

function wheel(r, width) {
  const g = new THREE.CylinderGeometry(r, r, width, 12);
  g.rotateZ(Math.PI / 2);
  return g;
}

/**
 * NYC-atlas-style silhouettes, one part list per kind. Each part becomes its
 * own instanced mesh so every part gets a real material — glass cabin,
 * emissive lamps, rubber wheels — exactly how the NYC atlas builds its cars.
 *   at      — local positions (vehicle space, road at y = 0); one instance each
 *   tinted  — part wears the vehicle's palette colour (body panels)
 *   shadow  — castShadow (kept off the tiny lamps)
 */
const PARTS = {
  car: [
    { mat: "body", tinted: true, shadow: true, geo: box(0.26, 0.06, 0.62), at: [[0, 0.03, 0]] },
    { mat: "body", tinted: true, shadow: true, geo: box(0.22, 0.04, 0.22), at: [[0, 0.07, 0.18]] },
    { mat: "glass", shadow: true, geo: box(0.18, 0.09, 0.3), at: [[0, 0.095, -0.04]] },
    {
      mat: "wheel",
      shadow: true,
      geo: wheel(0.045, 0.05),
      at: [[-0.14, 0.025, -0.22], [0.14, 0.025, -0.22], [-0.14, 0.025, 0.22], [0.14, 0.025, 0.22]],
    },
    { mat: "light", geo: box(0.07, 0.025, 0.015), at: [[-0.09, 0.055, 0.315], [0.09, 0.055, 0.315]] },
    { mat: "tail", geo: box(0.07, 0.025, 0.015), at: [[-0.09, 0.055, -0.315], [0.09, 0.055, -0.315]] },
  ],
  // The cab: bright yellow body with a hood up front, a black-and-white
  // checker stripe low on each side, a lit roof sign, glass cabin and lamps —
  // the classic bright-yellow-taxi layout.
  auto: [
    { mat: "body", tinted: true, shadow: true, geo: box(0.24, 0.085, 0.46), at: [[0, 0.045, 0]] },
    { mat: "body", tinted: true, shadow: true, geo: box(0.2, 0.03, 0.12), at: [[0, 0.075, 0.19]] },
    { mat: "glass", shadow: true, geo: box(0.2, 0.11, 0.2), at: [[0, 0.115, -0.05]] },
    {
      mat: "checker",
      shadow: true,
      geo: box(0.014, 0.045, 0.44),
      at: [[-0.127, 0.073, 0], [0.127, 0.073, 0]],
    },
    { mat: "sign", shadow: true, geo: box(0.05, 0.04, 0.15), at: [[0, 0.19, 0.02]] },
    {
      mat: "wheel",
      shadow: true,
      geo: wheel(0.045, 0.05),
      at: [[-0.125, 0.025, -0.15], [0.125, 0.025, -0.15], [-0.125, 0.025, 0.15], [0.125, 0.025, 0.15]],
    },
    { mat: "light", geo: box(0.06, 0.025, 0.015), at: [[-0.07, 0.06, 0.235], [0.07, 0.06, 0.235]] },
    { mat: "tail", geo: box(0.06, 0.025, 0.015), at: [[-0.07, 0.06, -0.235], [0.07, 0.06, -0.235]] },
  ],
  scooter: [
    { mat: "body", tinted: true, shadow: true, geo: box(0.08, 0.03, 0.28), at: [[0, 0.015, 0]] },
    { mat: "wheel", shadow: true, geo: box(0.05, 0.1, 0.06), at: [[0, 0.08, -0.06]] },
    { mat: "light", geo: box(0.02, 0.02, 0.02), at: [[0, 0.055, 0.145]] },
  ],
  bus: [
    { mat: "body", tinted: true, shadow: true, geo: box(0.42, 0.32, 1.5), at: [[0, 0.26, 0]] },
    { mat: "stripe", shadow: true, geo: box(0.43, 0.07, 1.5), at: [[0, 0.18, 0]] },
    { mat: "glass", shadow: true, geo: box(0.43, 0.09, 1.3), at: [[0, 0.34, 0]] },
    {
      mat: "wheel",
      shadow: true,
      geo: wheel(0.08, 0.075),
      at: [[-0.22, 0.08, -0.52], [0.22, 0.08, -0.52], [-0.22, 0.08, 0.52], [0.22, 0.08, 0.52]],
    },
  ],
  truck: [
    { mat: "body", tinted: true, shadow: true, geo: box(0.4, 0.26, 0.34), at: [[0, 0.21, 0.5]] },
    // Painted cargo box: tinted per truck from the `box` palette, so each truck
    // wears its own fleet colour.
    { mat: "box", tinted: true, paletteKey: "box", shadow: true, geo: box(0.44, 0.4, 0.86), at: [[0, 0.28, -0.12]] },
    // Hand-painted side art — two thin plaques over the box, one per side. The
    // left panel uses a mirrored texture so the lettering reads correctly from
    // outside (a BoxGeometry mirrors its -x face).
    { mat: "livery", shadow: true, geo: box(0.012, 0.4, 0.86), at: [[0.224, 0.28, -0.12]] },
    { mat: "liveryL", shadow: true, geo: box(0.012, 0.4, 0.86), at: [[-0.224, 0.28, -0.12]] },
    {
      mat: "wheel",
      shadow: true,
      geo: wheel(0.08, 0.075),
      at: [[-0.22, 0.08, -0.4], [0.22, 0.08, -0.4], [-0.22, 0.08, 0.48], [0.22, 0.08, 0.48]],
    },
  ],
};

/**
 * The painted side art of an Indian box truck: a gold border frame, painted
 * corner diamonds, and the fleet name in bold white with a dark outline so it
 * reads on any box colour. Drawn once per side — `flip` mirrors it for the
 * left panel.
 */
function makeLiveryTexture({ flip = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 344;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");

  // Gold painted frame, inset.
  ctx.strokeStyle = "rgba(255, 214, 100, 0.95)";
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, 324, 140);

  // Hand-painted corner diamonds.
  ctx.fillStyle = "rgba(255, 96, 60, 0.92)";
  for (const [cx, cy] of [[46, 26], [298, 26], [46, 134], [298, 134]]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx + 16, cy);
    ctx.lineTo(cx, cy + 16);
    ctx.lineTo(cx - 16, cy);
    ctx.closePath();
    ctx.fill();
  }

  // Fleet name — condensed bold, dark outline over white fill.
  const text = (str, y, size) => {
    ctx.font = `900 ${size}px 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 14;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(10, 10, 12, 0.9)";
    ctx.strokeText(str, 172, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(str, 172, y);
  };
  text("OM SAI", 58, 64);
  text("TRANSPORT", 112, 46);

  if (flip) {
    const mirrored = document.createElement("canvas");
    mirrored.width = 344;
    mirrored.height = 160;
    mirrored.getContext("2d").drawImage(canvas, 344, 0, -344, 160);
    const texture = new THREE.CanvasTexture(mirrored);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The checkerboard band that makes a cab read as a taxi: a tiny canvas of
 * alternating black/white squares, tiled along the stripe's length.
 */
function makeCheckerTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  const cell = 2; // px per checker square
  for (let y = 0; y < canvas.height / cell; y++) {
    for (let x = 0; x < canvas.width / cell; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#0d0d0f" : "#f4f4f0";
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  // Tile the pattern so the squares stay square on the 0.44-long stripe.
  texture.repeat.set(2.2, 1);
  return texture;
}

/**
 * Night materials: standard-shaded so the city lights model the body (the old
 * flat MeshBasicMaterial made every vehicle read as a box), but with a faint
 * NEUTRAL emissive — vehicles keep their real livery at night instead of
 * turning into warm blobs. Only the actual lamps and the taxi sign glow hot.
 */
function makeNightMaterials() {
  const body = { roughness: 0.55, metalness: 0.02, emissive: 0xffffff, emissiveIntensity: 0.12 };
  return {
    body: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9ec6d4,
      roughness: 0.3,
      transparent: true,
      opacity: 0.6,
      emissive: 0xffffff,
      emissiveIntensity: 0.08,
    }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x171a1f, roughness: 0.8 }),
    light: new THREE.MeshStandardMaterial({ color: 0xfff4c8, roughness: 0.4, emissive: 0xffd56f, emissiveIntensity: 1.4 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xe13c36, roughness: 0.4, emissive: 0xff6a3a, emissiveIntensity: 1.1 }),
    stripe: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
    box: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
    checker: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
    sign: new THREE.MeshStandardMaterial({ color: 0xfff3c0, roughness: 0.4, emissive: 0xffe08a, emissiveIntensity: 1.1 }),
    livery: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
    liveryL: new THREE.MeshStandardMaterial({ color: 0xffffff, ...body }),
  };
}

/** Day materials; swapped wholesale for the night glow material per theme. */
function makeDayMaterials() {
  return {
    body: new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05, transparent: true }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9ec6d4,
      roughness: 0.18,
      metalness: 0.04,
      transparent: true,
      opacity: 0.85,
    }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x171a1f, roughness: 0.72, transparent: true }),
    light: new THREE.MeshStandardMaterial({
      color: 0xfff4c8,
      emissive: 0xffd56f,
      emissiveIntensity: 0.7,
      roughness: 0.3,
      transparent: true,
    }),
    tail: new THREE.MeshStandardMaterial({
      color: 0xe13c36,
      emissive: 0xe13c36,
      emissiveIntensity: 0.5,
      roughness: 0.4,
      transparent: true,
    }),
    // Bus livery stripe — fixed colour; the truck box is white so the
    // per-truck painted colour shows through its instance tint.
    stripe: new THREE.MeshStandardMaterial({ color: 0x1c4fd6, roughness: 0.45, transparent: true }),
    box: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true }),
    // Indian truck side art (right panel + mirrored left panel).
    livery: new THREE.MeshStandardMaterial({ map: makeLiveryTexture(), roughness: 0.55, transparent: true }),
    liveryL: new THREE.MeshStandardMaterial({
      map: makeLiveryTexture({ flip: true }),
      roughness: 0.55,
      transparent: true,
    }),
    // Taxi livery: the checker band and the lit roof sign.
    checker: new THREE.MeshStandardMaterial({
      map: makeCheckerTexture(),
      roughness: 0.5,
      transparent: true,
    }),
    sign: new THREE.MeshStandardMaterial({
      color: 0xfff3c0,
      emissive: 0xffe08a,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      transparent: true,
    }),
  };
}

/**
 * One track per road per direction. Reversing the point list for the opposing
 * stream means every vehicle simply moves forward along its track, and the
 * keep-left offset lands on the correct side automatically.
 */
export function buildTracks() {
  const tracks = [];
  for (const road of ROADS) {
    const tier = TIER[road.tier] ?? TIER.street;
    const base = ringToWorld(road.path);
    if (road.closed) base.push({ ...base[0] });

    for (const reverse of [false, true]) {
      const pts = reverse ? [...base].reverse() : base;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      }
      tracks.push({ pts, cum, total: cum[cum.length - 1], tier });
    }
  }
  return tracks;
}

/**
 * Position + tangent at arc-length s. `cursor` caches the segment index per
 * vehicle — vehicles move a fraction of a segment per frame, so the walk is
 * almost always zero or one step.
 */
export function sampleTrack(track, s, cursor) {
  const { pts, cum } = track;
  let i = cursor.i;
  while (i < cum.length - 2 && s > cum[i + 1]) i++;
  while (i > 0 && s < cum[i]) i--;
  cursor.i = i;

  const segLen = cum[i + 1] - cum[i] || 1;
  const t = (s - cum[i]) / segLen;
  const ax = pts[i].x;
  const az = pts[i].z;
  const bx = pts[i + 1].x;
  const bz = pts[i + 1].z;
  return {
    x: ax + (bx - ax) * t,
    z: az + (bz - az) * t,
    tx: (bx - ax) / segLen,
    tz: (bz - az) / segLen,
  };
}

/**
 * A standalone drivable vehicle for drive mode: the same part list as the
 * fleet, built as plain meshes so a single car can move freely under player
 * control. Returns `{ group, kind, setTheme, dispose }`.
 *
 * Geometries are cloned and materials are built fresh, so `dispose()` on exit
 * can't pull anything out from under the ambient fleet — the fleet's instanced
 * meshes share the `PARTS` geometry objects, and disposing those would drop the
 * whole city's traffic.
 */
export function buildDriveVehicle(kindId, theme = "dark") {
  const kind = KINDS.find((k) => k.id === kindId) ?? KINDS[0];
  const day = makeDayMaterials();
  const night = makeNightMaterials();
  // One livery roll for the whole vehicle, like a fleet vehicle's colorRoll.
  // Parts that share a material (a car's two body panels) would otherwise each
  // pick their own colour and fight over the one material's `color`.
  const roll = Math.random();

  const geometries = [];
  const parts = [];
  for (const part of PARTS[kind.id]) {
    const geo = part.geo.clone();
    geometries.push(geo);
    const palette = kind[part.paletteKey ?? "day"] ?? kind.day;
    const colour = new THREE.Color(palette[Math.floor(roll * palette.length)]);
    const dayMat = day[part.mat] ?? day.body;
    const nightMat = night[part.mat] ?? night.body;
    // `at` holds one local position per copy of the part — four wheels, two
    // lamps — so each entry becomes its own mesh, the same way the fleet gives
    // each entry its own instance.
    for (const [x, y, z] of part.at) {
      const mesh = new THREE.Mesh(geo, dayMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = part.shadow === true;
      mesh.frustumCulled = false;
      parts.push({ mesh, dayMat, nightMat, tinted: part.tinted === true, colour });
    }
  }

  const group = new THREE.Group();
  group.name = "drive-vehicle";
  const scale = kind.scale ?? 1;
  group.scale.set(scale, scale, scale);
  for (const p of parts) group.add(p.mesh);

  function setTheme(t) {
    for (const p of parts) {
      p.mesh.material = t === "light" ? p.dayMat : p.nightMat;
      if (p.tinted) p.mesh.material.color.copy(p.colour);
    }
  }
  setTheme(theme);

  return {
    group,
    kind: kind.id,
    setTheme,
    dispose() {
      for (const geo of geometries) geo.dispose();
      // Materials are shared between parts, so dedupe before disposing; the
      // livery and checker canvases are built per call and go with them.
      for (const mat of new Set([...Object.values(day), ...Object.values(night)])) {
        mat.map?.dispose();
        mat.dispose();
      }
    },
  };
}

/**
 * Builds the fleet. Returns `{ group, update, setTheme, dispose, stats }`.
 * Call `update(dt)` once per frame and `setTheme` alongside the rest of the
 * board's theme swap.
 */
export function createTraffic() {
  const rng = mulberry32(hashSeed("bengaluru-traffic"));
  const tracks = buildTracks();

  // Fleet size per track, proportional to length × tier density, capped.
  const quotas = tracks.map((t) => t.total * t.tier.perUnit);
  const wanted = quotas.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, MAX_VEHICLES / wanted);

  const vehicles = [];
  tracks.forEach((track, trackIndex) => {
    const count = Math.round(quotas[trackIndex] * scale);
    for (let i = 0; i < count; i++) {
      // Buses and trucks are trunk-only: streets get the car/scooter/auto mix
      // re-normalised, so the big rigs never crowd the by-lanes.
      const eligible = KINDS.map((k, i) => i).filter(
        (i) => !(KINDS[i].trunkOnly && track.tier === TIER.street)
      );
      const totalShare = eligible.reduce((a, i) => a + KINDS[i].share, 0);
      let roll = rng() * totalShare;
      let kind = eligible[0];
      for (const i of eligible) {
        if (roll < KINDS[i].share) {
          kind = i;
          break;
        }
        roll -= KINDS[i].share;
      }
      const [minSpeed, maxSpeed] = track.tier.speed;
      vehicles.push({
        track: trackIndex,
        kind,
        s: rng() * track.total,
        speed: (minSpeed + rng() * (maxSpeed - minSpeed)) * KINDS[kind].speedFactor,
        lane: track.tier.lanes[Math.floor(rng() * track.tier.lanes.length)],
        cursor: { i: 0 },
        phase: rng() * Math.PI * 2,
        colorRoll: rng(),
        instance: 0, // assigned below, per kind
      });
    }
  });

  // Day materials are transparent so distant traffic can fade out — at
  // whole-plateau zoom the painted bodies read as dust on the paper map.
  // Night lights stay: from that height they're the "city alive" shimmer.
  const dayMaterials = makeDayMaterials();
  // Dedupe: the body material is shared by every tinted part, so the fade pass
  // must touch each unique material only once.
  const dayMaterialList = [...new Set(Object.values(dayMaterials))];
  const nightMaterials = makeNightMaterials();
  const white = new THREE.Color(0xffffff);

  let night = true;

  const group = new THREE.Group();
  group.name = "traffic";

  // One InstancedMesh per part, per kind. Parts carry several local positions
  // each (four wheels, two lamps), so instance counts scale with the fleet.
  const meshes = KINDS.map((kind, kindIndex) => {
    const fleet = vehicles.filter((v) => v.kind === kindIndex);
    fleet.forEach((v, i) => (v.instance = i));

    const partMeshes = PARTS[kind.id].map((part) => {
      const count = fleet.length * part.at.length;
      const mesh = new THREE.InstancedMesh(part.geo, dayMaterials[part.mat], count);
      mesh.name = `traffic:${kind.id}:${part.mat}`;
      // Skip per-mesh culling: the fleet spans the whole board, and a dozen
      // draw calls beat recomputing a moving bounding sphere every frame.
      mesh.frustumCulled = false;
      mesh.castShadow = part.shadow === true;
      group.add(mesh);
      const pm = {
        mesh,
        mat: part.mat,
        dayMaterial: dayMaterials[part.mat],
        local: part.at,
        tinted: part.tinted === true,
        paletteKey: part.paletteKey, // e.g. the truck's painted `box` palette
      };
      return pm;
    });
    return partMeshes;
  });

  function setTheme(theme) {
    night = theme !== "light";
    const colour = new THREE.Color();
    for (const kindMeshes of meshes) {
      for (const pm of kindMeshes) {
        pm.mesh.material = night ? (nightMaterials[pm.mat] ?? nightMaterials.body) : pm.dayMaterial;
      }
    }
    for (const vehicle of vehicles) {
      for (const pm of meshes[vehicle.kind]) {
        // Parts may carry their own palette (the truck's painted box); default
        // is the kind's day colours. Night keeps the SAME livery — only the
        // materials and scene lighting change with the theme.
        const key = pm.paletteKey ?? "day";
        const palette = KINDS[vehicle.kind][key] ?? KINDS[vehicle.kind].day;
        colour.setHex(palette[Math.floor(vehicle.colorRoll * palette.length)]);
        // Tinted parts wear the palette colour; fixed parts (glass, wheels,
        // lamps, livery) wear white so their own material shows through.
        // Each part mesh owns `fleet × local.length` instances, so the index is
        // vehicle.instance × local.length — NOT offset by earlier parts (a
        // leftover from the merged-mesh design that wrote every colour out of
        // bounds and silently dropped them).
        const c = pm.tinted ? colour : white;
        const base = vehicle.instance * pm.local.length;
        for (let k = 0; k < pm.local.length; k++) pm.mesh.setColorAt(base + k, c);
      }
    }
    for (const kindMeshes of meshes) {
      for (const pm of kindMeshes) {
        if (pm.mesh.instanceColor) pm.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  const reducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const localOffset = new THREE.Vector3();
  const vehicleScale = KINDS.map(
    (k) => new THREE.Vector3(k.scale ?? 1, k.scale ?? 1, k.scale ?? 1)
  );
  const up = new THREE.Vector3(0, 1, 0);
  let elapsed = 0;

  function update(dt, viewDistance = 60) {
    if (reducedMotion) dt = 0;
    elapsed += dt;

    // Day traffic eases out as the camera pulls back (fully in by ~90, gone by
    // ~170 world units). Eased, not snapped, so zooming doesn't pop the fleet.
    if (!night) {
      const target = clamp((170 - viewDistance) / 80, 0, 1);
      for (const m of dayMaterialList) {
        m.opacity += (target - m.opacity) * Math.min(1, dt * 6);
      }
    } else {
      for (const m of dayMaterialList) {
        if (m.opacity !== 1) m.opacity = 1; // reset so the next daylight switch starts clean
      }
    }

    for (const vehicle of vehicles) {
      const track = tracks[vehicle.track];
      vehicle.s = (vehicle.s + vehicle.speed * dt) % track.total;
      const p = sampleTrack(track, vehicle.s, vehicle.cursor);

      // Keep-left: left of heading in XZ is (tz, −tx). Scooters weave a little.
      const kind = KINDS[vehicle.kind];
      const weave = kind.wobble ? Math.sin(elapsed * 2.4 + vehicle.phase) * 0.045 : 0;
      const lane = vehicle.lane + weave;

      quaternion.setFromAxisAngle(up, Math.atan2(p.tx, p.tz));
      const baseX = p.x + p.tz * lane;
      const baseZ = p.z - p.tx * lane;

      for (const pm of meshes[vehicle.kind]) {
        const base = vehicle.instance * pm.local.length;
        for (let k = 0; k < pm.local.length; k++) {
          // Part offsets are in vehicle space, so rotate them with the heading.
          localOffset.set(pm.local[k][0], pm.local[k][1], pm.local[k][2]);
          localOffset.applyQuaternion(quaternion);
          position.set(baseX + localOffset.x, VEHICLE_Y + localOffset.y, baseZ + localOffset.z);
          matrix.compose(position, quaternion, vehicleScale[vehicle.kind]);
          pm.mesh.setMatrixAt(base + k, matrix);
        }
      }
    }

    for (const kindMeshes of meshes) {
      for (const pm of kindMeshes) pm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function dispose() {
    const disposedGeometries = new Set();
    for (const kindMeshes of meshes) {
      for (const pm of kindMeshes) {
        pm.mesh.dispose();
        if (!disposedGeometries.has(pm.mesh.geometry)) {
          disposedGeometries.add(pm.mesh.geometry);
          pm.mesh.geometry.dispose();
        }
      }
    }
    for (const m of dayMaterialList) m.dispose();
    for (const m of new Set(Object.values(nightMaterials))) m.dispose();
  }

  setTheme("dark");
  update(0); // place the fleet before the first frame (and permanently, if reduced motion)

  return {
    group,
    update,
    setTheme,
    dispose,
    stats: {
      total: vehicles.length,
      byKind: KINDS.map((k, i) => ({
        kind: k.id,
        count: vehicles.filter((v) => v.kind === i).length,
      })),
    },
  };
}
