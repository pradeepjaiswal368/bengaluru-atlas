/**
 * Bengaluru AI Atlas — stage and camera rig.
 *
 * The rig is a simple orbital frame described by the same four numbers the
 * dataset uses for each area — target, horizontal distance, height, rotation —
 * so "fly to Whitefield" is just easing four scalars. Everything is damped, so
 * dragging has weight and area changes read as a flight rather than a cut.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { BOARD } from "./geo.js";
import { clamp, damp, easeInOutCubic } from "./geometry.js";
import { project } from "./geo.js";

const LIMITS = {
  distance: [14, 300],
  height: [8, 220],
};

/**
 * Everything about the stage that changes with the theme. Geometry never
 * changes — only what the sky, air and light are doing above it.
 * The fog colour tracks the middle background stop so the board dissolves into
 * the sky instead of into a visible seam.
 */
const SCENE_THEMES = {
  dark: {
    // Dusk, not midnight: indigo zenith through violet to a warm sodium band
    // right where the skyline meets it. A flat near-black sky was the single
    // biggest reason the board read dull — there was no light for the city to
    // sit against.
    background: [
      [0, "#070c1c"],
      [0.14, "#101a3c"],
      [0.26, "#212f60"],
      [0.36, "#4a3a68"],
      [0.46, "#8a5254"],
      [0.6, "#4a2f36"],
      [1, "#1d1a22"],
    ],
    fog: { color: 0x2a2740, density: 0.0019 },
    exposure: 1.24,
    hemi: { sky: 0x54688c, ground: 0x120f1a, intensity: 1.05 },
    key: { color: 0xffd9a8, intensity: 2.1 },
    rim: { color: 0x6f8ee0, intensity: 0.75 },
    warm: { intensity: 1.1 },
    bloom: { strength: 0.58, radius: 0.8, threshold: 0.68 },
  },
  light: {
    // Clear morning with real sky colour, not a grey wash. Same reasoning as
    // dark: the blue has to live in the top quarter of the frame.
    background: [
      [0, "#3f86c8"],
      [0.14, "#69a6d8"],
      [0.26, "#9cc6e6"],
      [0.4, "#cfe0ea"],
      [0.55, "#ece7da"],
      [1, "#f4eee0"],
    ],
    fog: { color: 0xdfe7ec, density: 0.0015 },
    exposure: 1.14,
    hemi: { sky: 0xcfe2f5, ground: 0x8f8878, intensity: 1.15 },
    key: { color: 0xfff4e0, intensity: 2.3 },
    rim: { color: 0x8fb4e8, intensity: 0.35 },
    // The saffron ground glow is a night-time effect; daylight has no use for it.
    warm: { intensity: 0 },
    // Daylight needs only a whisper of bloom — enough to lift the highlights.
    bloom: { strength: 0.16, radius: 0.5, threshold: 0.9 },
  },
};

/**
 * Vertical sky gradient, drawn once into a texture. Stops are explicit
 * `[position, colour]` pairs rather than evenly spaced, because the camera
 * looks *down* at the board: only the top ~25% of the frame is ever sky, so
 * that band has to carry the colour. Spread evenly, all the dusk hues land
 * behind the ground plane and the sky reads black.
 */
function makeBackground(stops) {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  for (const [position, colour] of stops) gradient.addColorStop(position, colour);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 512);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export class CameraRig {
  /** Scratch vector for the reframed look-at point. */
  #look = new THREE.Vector3();

  constructor(camera) {
    this.camera = camera;

    // Live state.
    this.target = new THREE.Vector3(0, 0, 0);
    this.distance = 208;
    this.height = 152;
    this.rotation = 0.52;

    // Where the user (or a nav click) wants us to be.
    this.desired = {
      target: new THREE.Vector3(0, 0, 0),
      distance: 208,
      height: 152,
      rotation: 0.52,
    };

    /** Active flight, or null when the rig is following user input. */
    this.flight = null;
    this.onFlightEnd = null;

    /**
     * Horizontal reframe, as a multiple of `distance`. The left rail covers the
     * first ~320px of the viewport, so aiming the camera slightly left of the
     * target pushes the subject into the clear part of the frame. 0 disables it
     * (mobile, where the rail sits along the bottom instead).
     */
    this.frameOffset = 0;
  }

  /**
   * Recompute the reframe for a viewport. `railPx` is the width the HUD steals
   * from the left edge; pass 0 when the HUD isn't beside the map.
   */
  setFraming({ width, height, railPx }) {
    if (!railPx || width <= 0) {
      this.frameOffset = 0;
      return;
    }
    // Nudge the subject to the centre of the space the rail leaves behind.
    const shiftFraction = railPx / (2 * width);
    const aspect = width / height;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    // Visible width at the target's depth is 2·d·tan(fov/2)·aspect, so the
    // world offset for a given screen fraction is linear in distance.
    this.frameOffset = shiftFraction * 2 * Math.tan(halfFov) * aspect;
  }

  /** Apply an area focus immediately, with no animation. */
  jumpTo(focus) {
    const p = project(focus.lat, focus.lng);
    this.target.set(p.x, 0, p.z);
    this.desired.target.copy(this.target);
    this.distance = this.desired.distance = focus.distance;
    this.height = this.desired.height = focus.height;
    this.rotation = this.desired.rotation = focus.rotation;
    this.flight = null;
    this.#apply();
  }

  /**
   * Ease to an area focus. The flight lifts a little past the straight-line
   * interpolation at its midpoint, which reads as pulling up and settling.
   */
  flyTo(focus, duration = 1500) {
    const p = project(focus.lat, focus.lng);

    // Take the shorter way round the compass.
    let toRotation = focus.rotation;
    const twoPi = Math.PI * 2;
    while (toRotation - this.rotation > Math.PI) toRotation -= twoPi;
    while (toRotation - this.rotation < -Math.PI) toRotation += twoPi;

    this.flight = {
      elapsed: 0,
      duration: duration / 1000,
      from: {
        target: this.target.clone(),
        distance: this.distance,
        height: this.height,
        rotation: this.rotation,
      },
      to: {
        target: new THREE.Vector3(p.x, 0, p.z),
        distance: focus.distance,
        height: focus.height,
        rotation: toRotation,
      },
      // Bigger jumps get a bigger arc.
      lift: clamp(this.target.distanceTo(new THREE.Vector3(p.x, 0, p.z)) * 0.22, 6, 60),
    };
  }

  /** User input: nudge the orbit. Cancels any flight in progress. */
  orbit(dxRadians, dyHeight) {
    this.flight = null;
    this.desired.rotation += dxRadians;
    this.desired.height = clamp(this.desired.height + dyHeight, ...LIMITS.height);
  }

  /** User input: zoom. `factor` is multiplicative, so 1.1 pulls back 10%. */
  zoom(factor) {
    this.flight = null;
    // Capture the pitch from the CURRENT height and distance, BEFORE the
    // distance moves. Recomputing it against the post-zoom distance held the
    // height fixed while the distance shrank, so every zoom-in tick steepened
    // the pitch until it saturated at the top-down clamp — zooming in from a
    // side view always ended up looking straight down.
    const ratio = clamp(this.desired.height / this.desired.distance, 0.35, 1.4);
    this.desired.distance = clamp(this.desired.distance * factor, ...LIMITS.distance);
    this.desired.height = clamp(this.desired.distance * ratio, ...LIMITS.height);
  }

  /**
   * User input: slide the look-at point across the board by a world-space
   * delta. Applied straight to the live target (not just `desired`), so
   * panning tracks the cursor with no chase lag — the map is grabbed, not
   * pushed. Damping only smooths flights and keyboard navigation; a held drag
   * stays glued to the pointer.
   */
  pan(dxWorld, dzWorld) {
    this.flight = null;
    this.target.x = clamp(this.target.x + dxWorld, -BOARD.halfWidth, BOARD.halfWidth);
    this.target.z = clamp(this.target.z + dzWorld, -BOARD.halfDepth, BOARD.halfDepth);
    this.desired.target.copy(this.target);
  }

  /**
   * User input: pan by screen pixels, so the map sticks to the cursor 1:1 at
   * any zoom, window size and pitch. The old `distance * 0.0022` factor
   * over-panned 2–4× depending on the viewport; and a later draft moved the
   * target along the view axis for vertical drags, which made the map slide
   * sideways instead of following the cursor.
   */
  panPixels(dxPx, dyPx, viewportWidth) {
    if (!viewportWidth) return;
    const cam = this.camera;
    const viewportHeight = viewportWidth / cam.aspect;

    // The camera's true basis in world space (rotation columns of its world
    // matrix). The rig aims at a point `frameOffset · distance` off the target,
    // so the analytic yaw-only basis is slightly rotated and drags pick up a
    // sideways component — read the axes the camera actually renders with.
    const e = cam.matrix.elements;
    const rightX = e[0];
    const rightZ = e[2];
    const upX = e[4];
    const upZ = e[6];

    // The target's depth along the view axis. The target sits off the view
    // axis (by the frame offset), so its screen plane is √(L² − shift²) away;
    // that is the depth the per-pixel scale must be measured at.
    const depth = Math.hypot(this.distance, this.height);
    const shift = this.frameOffset * this.distance;
    const axisDepth = Math.sqrt(Math.max(depth * depth - shift * shift, 1));
    // World units per screen pixel at the target's depth. The vertical FOV
    // spans the viewport height, so this one scale serves both axes (square
    // pixels).
    const worldPerPx = (2 * axisDepth * Math.tan((cam.fov * Math.PI) / 360)) / viewportHeight;

    // Screen-up on the ground: the horizontal part of the camera's up axis,
    // renormalised. For a pitched-down camera this is the direction toward the
    // horizon — and a vertical drag covers `depth / height` times more ground
    // the shallower the pitch.
    const gUpLen = Math.hypot(upX, upZ) || 1;
    const gUpX = upX / gUpLen;
    const gUpZ = upZ / gUpLen;

    // Drags follow the cursor: a right drag moves the map right, so the target
    // slides the opposite way along camera-right (exact 1:1, that axis is
    // perpendicular to the view). An up drag moves the map up, which needs the
    // target to slide *toward* the camera along the ground-up direction.
    this.pan(
      -dxPx * worldPerPx * rightX + dyPx * worldPerPx * (depth / this.height) * gUpX,
      -dxPx * worldPerPx * rightZ + dyPx * worldPerPx * (depth / this.height) * gUpZ
    );
  }

  /**
   * @param {number} dt   smoothing step, clamped by the caller — a long stall
   *                      must not make damping jump.
   * @param {number} [rawDt] true elapsed time. Flights advance on this so a
   *                      slow device finishes the flight in its stated duration
   *                      with fewer frames, instead of playing it in slow motion.
   */
  update(dt, rawDt = dt) {
    if (this.flight) {
      const f = this.flight;
      f.elapsed += Math.min(rawDt, 0.4);
      const t = clamp(f.elapsed / f.duration, 0, 1);
      const e = easeInOutCubic(t);
      // sin(πt) peaks at the midpoint and is zero at both ends.
      const arc = Math.sin(Math.PI * t) * f.lift;

      this.target.lerpVectors(f.from.target, f.to.target, e);
      this.distance = f.from.distance + (f.to.distance - f.from.distance) * e + arc * 0.5;
      this.height = f.from.height + (f.to.height - f.from.height) * e + arc;
      this.rotation = f.from.rotation + (f.to.rotation - f.from.rotation) * e;

      if (t >= 1) {
        // Hand control back to the damped path from exactly where we landed.
        this.desired.target.copy(f.to.target);
        this.desired.distance = f.to.distance;
        this.desired.height = f.to.height;
        this.desired.rotation = f.to.rotation;
        this.flight = null;
        if (this.onFlightEnd) this.onFlightEnd();
      }
    } else {
      this.target.x = damp(this.target.x, this.desired.target.x, 9, dt);
      this.target.y = damp(this.target.y, this.desired.target.y, 9, dt);
      this.target.z = damp(this.target.z, this.desired.target.z, 9, dt);
      this.distance = damp(this.distance, this.desired.distance, 9, dt);
      this.height = damp(this.height, this.desired.height, 9, dt);
      this.rotation = damp(this.rotation, this.desired.rotation, 9, dt);
    }

    this.#apply();
  }

  #apply() {
    const x = this.target.x + Math.sin(this.rotation) * this.distance;
    const z = this.target.z + Math.cos(this.rotation) * this.distance;
    this.camera.position.set(x, this.height, z);

    if (this.frameOffset === 0) {
      this.camera.lookAt(this.target);
      return;
    }

    // Camera-right in world XZ for a +y orbit: (cos r, 0, −sin r). Aiming left
    // of the target by this much makes the target sit right of screen centre,
    // clear of the rail.
    const shift = this.frameOffset * this.distance;
    this.#look.set(
      this.target.x - Math.cos(this.rotation) * shift,
      this.target.y,
      this.target.z + Math.sin(this.rotation) * shift
    );
    this.camera.lookAt(this.#look);
  }
}

/**
 * Builds renderer, scene, camera and rig for a canvas.
 * @param {HTMLCanvasElement} canvas
 */
export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Soft shadows: the massing was reading as a flat grey field without them.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.002);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 2600);

  // The key sits on the camera's side of the board, high and to the right. This
  // matters more than it sounds: light it from behind the city and every tall
  // tower turns its shadowed face to the viewer, so the dense cores read darker
  // than the low-rise fabric around them — exactly backwards.
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(115, 170, 145);
  key.castShadow = true;
  // Orthographic shadow frustum sized to the whole board — the light is
  // directional, so one camera has to cover everything that casts.
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 40;
  key.shadow.camera.far = 620;
  key.shadow.camera.left = -175;
  key.shadow.camera.right = 175;
  key.shadow.camera.top = 175;
  key.shadow.camera.bottom = -175;
  key.shadow.bias = -0.0022;
  key.shadow.normalBias = 0.05;
  scene.add(key);

  // Cool rim from the far side, to keep silhouettes from going flat.
  const rim = new THREE.DirectionalLight(0xffffff, 0.55);
  rim.position.set(-130, 70, -110);
  scene.add(rim);

  const warm = new THREE.PointLight(0xff9a3c, 0.7, 300, 2);
  warm.position.set(0, 30, 0);
  scene.add(warm);

  // ── Post-processing ───────────────────────────────────────────────────────
  // Bloom is what makes the emissive layers actually read as light: pin heads,
  // metro lines and lit windows bleed into the air instead of sitting flat.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.58, 0.8, 0.68);
  composer.addPass(bloom);
  // EffectComposer works in linear space, so tone mapping + sRGB conversion
  // move to the end of the chain rather than happening in the render pass.
  composer.addPass(new OutputPass());

  /** Apply a theme's sky, fog and lighting. Colour values live in SCENE_THEMES. */
  function setTheme(theme) {
    const config = SCENE_THEMES[theme] ?? SCENE_THEMES.dark;

    bloom.strength = config.bloom.strength;
    bloom.radius = config.bloom.radius;
    bloom.threshold = config.bloom.threshold;

    const oldBackground = scene.background;
    scene.background = makeBackground(config.background);
    if (oldBackground?.dispose) oldBackground.dispose();

    scene.fog.color.setHex(config.fog.color);
    scene.fog.density = config.fog.density;
    renderer.toneMappingExposure = config.exposure;

    hemi.color.setHex(config.hemi.sky);
    hemi.groundColor.setHex(config.hemi.ground);
    hemi.intensity = config.hemi.intensity;
    key.color.setHex(config.key.color);
    key.intensity = config.key.intensity;
    rim.color.setHex(config.rim.color);
    rim.intensity = config.rim.intensity;
    warm.intensity = config.warm.intensity;
  }

  setTheme("dark");

  const rig = new CameraRig(camera);

  const size = { width: 1, height: 1 };

  function resize() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    size.width = width;
    size.height = height;
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();

  /** Draw a frame through the post-processing chain. */
  function render() {
    composer.render();
  }

  return { renderer, scene, camera, rig, resize, size, setTheme, render, composer, bloom };
}
