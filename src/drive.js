/**
 * Bengaluru AI Atlas — drive mode.
 *
 * A GTA-lite "drive around" mode: pick a vehicle and steer it along the same
 * road network the ambient traffic uses. W/S throttle and brake, A/D change
 * lanes, X does a U-turn; at junctions the car rolls onto the most natural
 * continuation. A chase camera follows behind and above; Esc or the HUD
 * button hands the camera back to the map.
 */

import * as THREE from "three";
import { VEHICLE_Y, buildDriveVehicle, buildTracks, sampleTrack } from "./traffic.js";
import { clamp, damp } from "./geometry.js";

/** Top speed per kind, in world units/second (exaggerated like the fleet). */
const TOP_SPEED = { car: 3.4, auto: 2.1, scooter: 2.6, truck: 1.9, bus: 1.6 };
const ACCEL = 4.2;
const BRAKE = 8.0;
const REVERSE_MAX = 0.9;
const LANE_STEER = 0.45; // lane-change rate, world units/second
const LANE_SMOOTH = 9; // damping onto the steered lane offset
const CAM_FOV = 62; // wider lens while driving

/**
 * Turning. Road polylines bend up to 67° at a vertex (median 10°, one every few
 * seconds at speed), so reading the heading off the segment the car is standing
 * on snapped it round every corner in a single frame. The heading is taken from
 * a look-ahead point instead — which also starts the turn slightly before the
 * corner, the way a driver does — and then damped, which absorbs what is left at
 * junction hops and turns a U-turn into a sweep rather than a flip.
 */
const HEADING_SMOOTH = 7;

/**
 * Lane changes point the nose along the car's velocity vector, so changing lanes
 * reads as steering instead of the car sliding sideways facing straight ahead.
 * The speed floor keeps the angle finite at a crawl, and the cap keeps a
 * standing-start lane change from looking like a handbrake turn.
 */
const SLIP_SPEED_FLOOR = 0.8;
const MAX_SLIP = 0.3; // ~17°

/** Ceiling on turn rate, rad/s: a 180° reversal sweeps round in about 0.7 s. */
const MAX_TURN_RATE = 4.5;

const TWO_PI = Math.PI * 2;

/**
 * Damp an angle along the shortest arc, with a ceiling on how fast it may turn.
 * Plain damp() would take the long way round, and exponential damping on its own
 * moves fastest at the very start — so a big change (a dead-end U-turn reverses
 * the heading outright) still began with a visible snap before easing out.
 */
function turnToward(current, target, lambda, dt, maxRate) {
  let delta = (target - current) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  const step = delta * (1 - Math.exp(-lambda * dt));
  const limit = maxRate * dt;
  return current + clamp(step, -limit, limit);
}

/**
 * Junction gates. A road end hops onto whatever road passes within
 * JUNCTION_RADIUS of it, and the hop is instant, so the radius is also the
 * worst-case visible jump. In this network the real junctions sit at 0.0 (the
 * radials meeting the ORR) up to 0.93, then nothing until 3.3 — so ~1.1 catches
 * every authored junction while keeping the jump inside a car length. The
 * earlier 8.0 reached 1.3 km across open ground and flung the car between
 * unrelated roads, which is what made the mode feel broken.
 *
 * MIN_CONTINUATION_DOT rejects only roads that double back; a T-junction is a
 * perpendicular tangent (dot ≈ 0) and must stay eligible, or every radial would
 * dead-end at the ORR instead of merging onto it.
 */
const JUNCTION_RADIUS = 1.1;
const MIN_CONTINUATION_DOT = 0;
/** Gap penalty, weighted to beat the heading term: a close turn reads better
 *  than a straight continuation that teleports there. */
const JUNCTION_GAP_COST = 1.2;

/** The picker's ride list, in display order. */
const RIDES = [
  { id: "auto", name: "TAXI CAB", blurb: "Bright yellow, quick off the line" },
  { id: "car", name: "SEDAN", blurb: "The everyday Bengaluru cruiser" },
  { id: "scooter", name: "SCOOTER", blurb: "Threads the traffic like a local" },
  { id: "bus", name: "BMTC BUS", blurb: "The big blue-striped bruiser" },
  { id: "truck", name: "BOX TRUCK", blurb: "Hauls the whole ORR" },
];

function closestOnSegment(px, pz, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = clamp(((px - a.x) * dx + (pz - a.z) * dz) / len2, 0, 1);
  return { d: Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t)), t };
}

/**
 * The drive controller. Call `update(dt)` from the render loop while active,
 * `setTheme` alongside the board's theme swap, and feed keyboard state into
 * `keys`. `minimapToView(x, z)` maps world coordinates into the mini-map's
 * viewBox so the player marker can follow the car.
 */
export function createDriveMode({
  scene,
  camera,
  spawnPoint,
  minimapMarker,
  minimapToView,
  getTheme,
}) {
  const tracks = buildTracks();
  // buildTracks emits each road as a pair — forward, then reversed — so the
  // reverse of track i is always i ^ 1. That makes U-turns a one-liner.
  const keys = { throttle: false, brake: false, left: false, right: false };

  let active = false;
  let vehicle = null;
  let trackIdx = 0;
  let s = 0;
  let lane = 0;
  let laneTarget = 0;
  let speed = 0;
  let cursor = { i: 0 };
  let heading = 0;
  let lookCursor = { i: 0 };
  let lookAhead = 1.4;
  let savedFov = 46;

  // Chase-camera geometry, sized from the ride's own bounding box in enter().
  // A scooter and a BMTC bus differ by ~5x in length, so a single fixed
  // distance either buries the camera in the bus or strands the scooter at the
  // far end of the street.
  let camDist = 2.2;
  let camHeight = 0.9;
  let camLook = 0.25;
  let camAhead = 2.2;

  const camPos = new THREE.Vector3();
  const desiredCam = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  const hudEl = document.getElementById("driveHud");
  const hudSpeedEl = document.getElementById("driveSpeed");
  const hudVehicleEl = document.getElementById("driveVehicle");
  const pickerEl = document.getElementById("drivePicker");
  const pickerListEl = document.getElementById("drivePickerList");
  const pickerCancelEl = document.getElementById("drivePickerCancel");

  function currentTier() {
    return tracks[trackIdx].tier;
  }

  /**
   * How far off the centreline the player may sit on this tier. Bounded by the
   * ambient lanes plus half a lane of shoulder either side: this is a keep-left
   * city, so the inner bound never reaches the centreline (crossing it put the
   * player nose-to-nose with oncoming traffic) and the outer bound stays on the
   * asphalt rather than out in the buildings.
   */
  function laneBounds() {
    const lanes = currentTier().lanes;
    const inner = Math.min(...lanes);
    const outer = Math.max(...lanes);
    const spacing = lanes.length > 1 ? (outer - inner) / (lanes.length - 1) : inner;
    const margin = spacing * 0.5;
    return [Math.max(inner - margin, 0.04), outer + margin];
  }

  /** Closed rings come out of buildTracks with their first point repeated. */
  function isRing(track) {
    const a = track.pts[0];
    const b = track.pts[track.pts.length - 1];
    return Math.hypot(b.x - a.x, b.z - a.z) < 0.5;
  }

  function vehiclePosition() {
    return vehicle.group.position;
  }

  function nearestTrackTo(x, z) {
    let best = { i: 0, s: 0, seg: 0, d: Infinity };
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      for (let k = 0; k < track.pts.length - 1; k++) {
        const hit = closestOnSegment(x, z, track.pts[k], track.pts[k + 1]);
        if (hit.d < best.d) {
          best = { i, s: track.cum[k] + hit.t * (track.cum[k + 1] - track.cum[k]), seg: k, d: hit.d };
        }
      }
    }
    return best;
  }

  /**
   * At one end of a track, find the road to roll onto next. `reversed` means
   * we're arriving at the START of the track (driving backwards), so the
   * heading is the reversed tangent. Returns null when nothing actually
   * connects — the caller treats that as a dead end and turns around.
   */
  function findContinuation(track, ti, reversed = false) {
    const last = track.pts.length - 1;
    const end = reversed ? track.pts[0] : track.pts[last];
    let ax = end.x - (reversed ? track.pts[1] : track.pts[last - 1]).x;
    let az = end.z - (reversed ? track.pts[1] : track.pts[last - 1]).z;
    if (reversed) {
      ax = -ax;
      az = -az;
    }
    const aLen = Math.hypot(ax, az) || 1;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < tracks.length; i++) {
      // Skip this track and its reverse twin: the twin overlaps us exactly, so
      // it always looks like the closest road going nowhere useful. Turning
      // back down it is a U-turn, which the caller handles on its own.
      if (i === ti || i === (ti ^ 1)) continue;
      const cand = tracks[i];
      let bd = Infinity;
      let bs = 0;
      for (let k = 0; k < cand.pts.length - 1; k++) {
        const hit = closestOnSegment(end.x, end.z, cand.pts[k], cand.pts[k + 1]);
        if (hit.d < bd) {
          bd = hit.d;
          bs = cand.cum[k] + hit.t * (cand.cum[k + 1] - cand.cum[k]);
        }
      }
      if (bd > JUNCTION_RADIUS) continue;
      const tangent = sampleTrack(cand, clamp(bs, 0, cand.total - 0.001), { i: 0 });
      const heading = (ax * tangent.tx + az * tangent.tz) / aLen;
      if (heading < MIN_CONTINUATION_DOT) continue; // doubling back, not a continuation
      const score = heading - bd * JUNCTION_GAP_COST;
      if (score > bestScore) {
        bestScore = score;
        best = { i, s: bs };
      }
    }
    return best;
  }

  function setHud() {
    if (!active) return;
    hudVehicleEl.textContent =
      RIDES.find((r) => r.id === vehicle.kind)?.name ?? vehicle.kind.toUpperCase();
    hudSpeedEl.textContent = String(Math.round(Math.abs(speed) * 30));
  }

  function updateMinimapMarker() {
    if (!minimapMarker) return;
    if (!active) {
      minimapMarker.setAttribute("hidden", "");
      return;
    }
    const p = vehiclePosition();
    const v = minimapToView(p.x, p.z);
    if (!v) return; // mini-map transform not built yet
    minimapMarker.removeAttribute("hidden");
    minimapMarker.setAttribute("cx", v.x.toFixed(1));
    minimapMarker.setAttribute("cy", v.y.toFixed(1));
  }

  function renderPicker() {
    pickerListEl.textContent = "";
    for (const ride of RIDES) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ride-row";
      row.innerHTML = `
        <span class="ride-row__name">${ride.name}</span>
        <span class="ride-row__blurb">${ride.blurb}</span>
        <span class="ride-row__go" aria-hidden="true">→</span>
      `;
      row.addEventListener("click", () => {
        pickerEl.close();
        enter(ride.id);
      });
      pickerListEl.appendChild(row);
    }
  }

  function enter(kindId) {
    if (active) return;
    active = true;

    vehicle = buildDriveVehicle(kindId, getTheme());

    // Frame every ride the same way — roughly a third of the viewport tall —
    // by measuring the model instead of guessing. The group is still at the
    // origin here, so the box is the vehicle's own size with its scale applied.
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(vehicle.group).getSize(size);
    const len = Math.max(size.z, 0.3);
    camDist = Math.max(1.5, len * 2.6);
    camHeight = Math.max(0.6, len);
    camLook = Math.max(0.22, len * 0.3);
    camAhead = len * 2.5;
    // Longer vehicles turn in over a longer distance, so they look further on.
    lookAhead = Math.max(1.0, len * 1.4);

    scene.add(vehicle.group);

    const spawn = spawnPoint();
    const near = nearestTrackTo(spawn.x, spawn.z);
    trackIdx = near.i;
    s = near.s;
    cursor = { i: near.seg };
    lookCursor = { i: near.seg };
    lane = laneTarget = clamp(currentTier().lanes[0], ...laneBounds());
    speed = 0;
    keys.throttle = keys.brake = keys.left = keys.right = false;

    // Place the car on its spawn road and park the chase camera exactly
    // behind it so there's no pop-in. The heading starts settled, so spawning
    // doesn't play the smoothing sweep.
    const p = sampleTrack(tracks[trackIdx], s, cursor);
    const theta = targetHeading(tracks[trackIdx], p);
    heading = theta;
    const baseX = p.x + p.tz * lane;
    const baseZ = p.z - p.tx * lane;
    vehicle.group.position.set(baseX, VEHICLE_Y, baseZ);
    vehicle.group.rotation.y = theta;

    savedFov = camera.fov;
    camera.fov = CAM_FOV;
    camera.updateProjectionMatrix();

    camPos.set(baseX - Math.sin(theta) * camDist, camHeight, baseZ - Math.cos(theta) * camDist);
    camera.position.copy(camPos);

    document.body.classList.add("is-driving");
    hudEl.hidden = false;
    updateMinimapMarker();
    setHud();
  }

  /**
   * Hands the camera back to the map. Returns the final world position and the
   * heading the player was facing, so the map rig can take over from where the
   * chase camera was rather than cutting to a different angle.
   */
  function exit() {
    if (!active) return null;
    active = false;
    const pos = vehiclePosition();
    const heading = vehicle.group.rotation.y;
    scene.remove(vehicle.group);
    vehicle.dispose();
    vehicle = null;

    camera.fov = savedFov;
    camera.updateProjectionMatrix();
    document.body.classList.remove("is-driving");
    hudEl.hidden = true;
    if (pickerEl.open) pickerEl.close();
    updateMinimapMarker();
    keys.throttle = keys.brake = keys.left = keys.right = false;
    return { x: pos.x, z: pos.z, heading };
  }

  /**
   * Turn around. buildTracks emits each road as a forward/reverse pair, so the
   * twin is `trackIdx ^ 1` and the same arc length measured from the other end
   * lands on the same spot — with the lane offset automatically landing on the
   * correct side, since "keep left" is relative to the new heading.
   */
  function uturn() {
    if (!active) return;
    const rev = tracks[trackIdx ^ 1];
    s = clamp(rev.total - s, 0, rev.total);
    trackIdx ^= 1;
    cursor = { i: 0 };
    lookCursor = { i: 0 };
    // Scrub most of the speed: a flat-out 180 read as a teleport.
    speed *= 0.25;
    const bounds = laneBounds();
    lane = clamp(lane, ...bounds);
    laneTarget = clamp(laneTarget, ...bounds);
  }

  function openPicker() {
    // showModal() throws InvalidStateError on an already-open dialog, and the
    // `D` shortcut is easy to hit twice.
    if (active || pickerEl.open) return;
    renderPicker();
    pickerEl.showModal();
  }

  function closePicker() {
    if (pickerEl.open) pickerEl.close();
  }

  pickerCancelEl?.addEventListener("click", closePicker);
  pickerEl.addEventListener("click", (event) => {
    if (event.target === pickerEl) closePicker();
  });

  function updateCamera(dt, baseX, baseZ, theta) {
    desiredCam.set(
      baseX - Math.sin(theta) * camDist,
      camHeight,
      baseZ - Math.cos(theta) * camDist
    );
    camPos.x = damp(camPos.x, desiredCam.x, 6, dt);
    camPos.y = damp(camPos.y, desiredCam.y, 9, dt);
    camPos.z = damp(camPos.z, desiredCam.z, 6, dt);
    camera.position.copy(camPos);
    lookTarget.set(baseX + Math.sin(theta) * camAhead, camLook, baseZ + Math.cos(theta) * camAhead);
    camera.lookAt(lookTarget);
  }

  /**
   * Where the road is heading, measured as the chord from the car to a point
   * `lookAhead` further along it rather than as the tangent of the segment the
   * car happens to be on. On a straight this is identical; through a corner it
   * rounds the vertex instead of snapping at it.
   */
  function targetHeading(track, p) {
    const ahead = isRing(track)
      ? (s + lookAhead) % track.total
      : Math.min(s + lookAhead, track.total);
    const a = sampleTrack(track, ahead, lookCursor);
    const dx = a.x - p.x;
    const dz = a.z - p.z;
    // At the end of an open road the look-ahead collapses onto the car; fall
    // back to the segment tangent rather than dividing into noise.
    if (Math.abs(dx) < 1e-5 && Math.abs(dz) < 1e-5) return Math.atan2(p.tx, p.tz);
    return Math.atan2(dx, dz);
  }

  /** Move the current track onto `cont`, keeping the lane offset legal. */
  function hopTo(cont) {
    trackIdx = cont.i;
    s = clamp(cont.s, 0, Math.max(tracks[cont.i].total - 0.001, 0));
    cursor = { i: 0 };
    lookCursor = { i: 0 };
    const bounds = laneBounds();
    lane = clamp(lane, ...bounds);
    laneTarget = clamp(laneTarget, ...bounds);
  }

  /**
   * Advance `s`, rolling onto connecting roads at either end. Loops because a
   * short link can be crossed in a single frame; the guard keeps a pathological
   * network (a chain of near-zero-length tracks) from spinning here.
   */
  function advance(dt) {
    s += speed * dt;
    for (let guard = 0; guard < 4; guard++) {
      const track = tracks[trackIdx];
      if (s >= track.total) {
        if (isRing(track)) {
          s %= track.total;
          continue;
        }
        const cont = findContinuation(track, trackIdx, false);
        if (cont) {
          hopTo(cont);
          continue;
        }
        uturn(); // dead end — roll around and drive back the way we came
        continue;
      }
      if (s < 0) {
        if (isRing(track)) {
          s += track.total;
          continue;
        }
        // Backing into a road's start rolls onto whatever connects there.
        const cont = findContinuation(track, trackIdx, true);
        if (cont) {
          hopTo(cont);
          continue;
        }
        s = 0;
        speed = Math.max(speed, 0); // parked against the kerb
      }
      break;
    }
    s = clamp(s, 0, Math.max(tracks[trackIdx].total - 0.001, 0));
  }

  function update(dt) {
    if (!active || !vehicle) return;

    // Steering: nudge the target lane offset, then ease onto it. Steering
    // straight to `lane` snapped the car across the road, because a street's
    // whole usable width is about a seventh of a second's worth of steering.
    const [low, high] = laneBounds();
    if (keys.left) laneTarget -= LANE_STEER * dt;
    if (keys.right) laneTarget += LANE_STEER * dt;
    laneTarget = clamp(laneTarget, low, high);
    const laneBefore = lane;
    lane = damp(lane, laneTarget, LANE_SMOOTH, dt);
    const laneRate = dt > 0 ? (lane - laneBefore) / dt : 0;

    // Throttle, brake and coast.
    const top = TOP_SPEED[vehicle.kind] ?? 2;
    if (keys.throttle) {
      speed = Math.min(speed + ACCEL * dt, top);
    } else if (keys.brake) {
      speed = Math.max(speed - BRAKE * dt, -REVERSE_MAX);
    } else {
      speed = damp(speed, 0, 3.2, dt);
    }

    advance(dt);

    // Sample the track we ended up on — reading the pre-hop track here warped
    // the car onto a stale road at every junction.
    const track = tracks[trackIdx];
    const p = sampleTrack(track, s, cursor);

    // The vehicle always faces along the road, even in reverse: a car backing
    // up doesn't spin around, and flipping the heading whipped the chase camera
    // through 180° the moment the brake carried speed past zero.
    heading = turnToward(heading, targetHeading(track, p), HEADING_SMOOTH, dt, MAX_TURN_RATE);

    // Lean the nose into a lane change so it reads as steering. The camera
    // tracks `heading`, not the slip, so changing lanes doesn't swing the view.
    const slip = clamp(
      Math.atan2(laneRate, Math.max(Math.abs(speed), SLIP_SPEED_FLOOR)),
      -MAX_SLIP,
      MAX_SLIP
    );

    const baseX = p.x + p.tz * lane;
    const baseZ = p.z - p.tx * lane;
    vehicle.group.position.set(baseX, VEHICLE_Y, baseZ);
    vehicle.group.rotation.y = heading + slip;

    updateCamera(dt, baseX, baseZ, heading);
    updateMinimapMarker();
    setHud();
  }

  function setTheme(theme) {
    if (vehicle) vehicle.setTheme(theme);
  }

  return {
    enter,
    exit,
    uturn,
    openPicker,
    closePicker,
    update,
    setTheme,
    keys,
    get active() {
      return active;
    },
    /** Stand-in for the map rig's pull-back, for traffic fade + label density. */
    get distance() {
      return Math.hypot(camDist, camHeight);
    },
  };
}
