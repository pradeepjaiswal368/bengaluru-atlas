/**
 * Bengaluru AI Atlas — application entry.
 *
 * Wires the stage, the city, the pins and the HUD together:
 *   · left rail  — cluster navigation, keyboard-driven, flies the camera
 *   · detail card — the selected company
 *   · ⌘K search  — fuzzy-ish match over name, sector and cluster
 *   · mini-map   — the ORR ring, drawn from the same geography as the 3D board
 */

import * as THREE from "three";
import "./tokens.css";
import "./styles.css";

import {
  AREAS,
  DATA_SOURCES,
  PIN_KINDS,
  STARTUPS,
  areaById,
  sectorColor,
  startupsByArea,
} from "./data.js";
import { LAKES, LANDMARKS, METRO_LINES, PARKS, ROADS, centroidOf, project } from "./geo.js";
import { landmarkAnchor } from "./geometry.js";
import { buildCity, disposeCity } from "./city.js";
import { LabelLayer } from "./labels.js";
import { createPins, setPinArea, setPinGlowScale, setPinTheme, updatePins } from "./pins.js";
import { createStage } from "./scene.js";
import { createTraffic } from "./traffic.js";
import { createPlane } from "./plane.js";
import { createDriveMode } from "./drive.js";

// ── DOM handles ─────────────────────────────────────────────────────────────

const canvas = document.getElementById("scene");
const labelsLayer = document.getElementById("labelsLayer");
const areaListEl = document.getElementById("areaList");
const detailCardEl = document.getElementById("detailCard");
const pinLegendEl = document.getElementById("pinLegend");
const brandSubEl = document.getElementById("brandSub");
const railCreditEl = document.getElementById("railCredit");
const contributeLinkEl = document.getElementById("contributeLink");
const repoLinkEl = document.getElementById("repoLink");
const searchTriggerEl = document.getElementById("searchTrigger");
const searchModalEl = document.getElementById("searchModal");
const searchInputEl = document.getElementById("companySearch");
const searchResultsEl = document.getElementById("searchResults");
const loaderEl = document.getElementById("loader");
const areaBannerEl = document.getElementById("areaBanner");

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  areaId: "all",
  selectedId: null,
  hoveredId: null,
  searchIndex: 0,
  searchMatches: [],
};

const startupById = new Map(STARTUPS.map((s) => [s.id, s]));
const areaLabelById = new Map(AREAS.map((a) => [a.id, a.shortLabel]));

// ── Stage ───────────────────────────────────────────────────────────────────

const stage = createStage(canvas);
const { renderer, scene, camera, rig } = stage;

// The lone airliner — scenery that orbits high above the city, kept out of
// the city group so a theme rebuild doesn't replace it mid-flight.
const plane = createPlane();
scene.add(plane.group);

// ── Theme ───────────────────────────────────────────────────────────────────
// The bootstrap script in index.html has already stamped data-theme on <html>
// before first paint; here we keep the 3D board in lockstep with the CSS.

const THEME_STORAGE_KEY = "atlas-theme";
/** Emissive pins are a night effect; by day they run nearly solid. */
const LIGHT_GLOW_SCALE = 0.3;

let cityGroup = null;

function mountCity(theme) {
  if (cityGroup) {
    scene.remove(cityGroup);
    disposeCity(cityGroup);
  }
  cityGroup = buildCity(theme).city;
  scene.add(cityGroup);
}

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme, { persist = false } = {}) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* storage blocked — the choice just won't survive a reload */
    }
  }

  mountCity(theme);
  stage.setTheme(theme);
  setPinGlowScale(theme === "light" ? LIGHT_GLOW_SCALE : 1);
  setPinTheme(pins, theme);
  traffic.setTheme(theme);
  drive.setTheme(theme);
  plane.setTheme(theme);

  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
    );
  }
}

const { group: pinGroup, pins, pickables } = createPins(STARTUPS);
scene.add(pinGroup);

const traffic = createTraffic();
scene.add(traffic.group);

const drive = createDriveMode({
  scene,
  camera,
  // Spawn the ride on the road nearest the current map centre.
  spawnPoint: () => rig.target,
  minimapMarker: document.getElementById("miniMapDrive"),
  // The mini-map is built later in this module; the closure runs only while
  // driving, long after buildMiniMap has set its transform.
  minimapToView: (x, z) => miniMap.toView?.(x, z),
  getTheme: currentTheme,
});

const pinById = new Map(pins.map((p) => [p.startup.id, p]));
const labels = new LabelLayer(labelsLayer);

rig.jumpTo(AREAS[0].focus);

// ── Labels ──────────────────────────────────────────────────────────────────

/**
 * Rebuilds the label set for the active area. Company labels in the active
 * cluster get priority so they survive collision culling; landmarks and water
 * stay on the board at low priority for orientation.
 */
function refreshLabels() {
  const entries = [];

  for (const pin of pins) {
    const active = state.areaId === "all" || pin.startup.area === state.areaId;
    const selected = state.selectedId === pin.startup.id;
    entries.push({
      id: `c:${pin.startup.id}`,
      text: pin.startup.name,
      sub: pin.startup.sector,
      kind: "company",
      world: pin.world,
      priority: selected ? 4 : active ? 2 : 0,
    });
  }

  for (const landmark of LANDMARKS) {
    // Same anchor the city builder places the silhouette on — some landmarks are
    // nudged off the road, and the name has to travel with them.
    const p = landmarkAnchor(landmark);
    entries.push({
      id: `l:${landmark.id}`,
      text: landmark.name,
      kind: "landmark",
      world: new THREE.Vector3(p.x, landmark.height + 1.4, p.z),
      priority: 1,
    });
  }

  for (const feature of [...LAKES, ...PARKS, ...ROADS].filter((f) => f.label)) {
    // Roads carry an explicit anchor — a closed ring's centroid is the city
    // centre, which is the one place its label must not sit.
    const anchor = feature.labelAt
      ? { lat: feature.labelAt[0], lng: feature.labelAt[1] }
      : centroidOf(feature.ring ?? feature.path);
    const p = project(anchor.lat, anchor.lng);
    entries.push({
      id: `p:${feature.id}`,
      text: feature.name,
      kind: "place",
      world: new THREE.Vector3(p.x, 0.8, p.z),
      priority: 0,
    });
  }

  labels.set(entries);
  labels.setEmphasis(state.selectedId ? `c:${state.selectedId}` : null);
}

// ── Left rail ───────────────────────────────────────────────────────────────

function renderRail() {
  areaListEl.textContent = "";

  for (const area of AREAS) {
    const count = startupsByArea(area.id).length;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "area";
    button.dataset.areaId = area.id;
    button.setAttribute("aria-pressed", String(area.id === state.areaId));

    button.innerHTML = `
      <span class="area__number">${area.number}</span>
      <span class="area__body">
        <span class="area__label">${area.shortLabel}</span>
        <span class="area__count">${count} ${count === 1 ? "company" : "companies"}</span>
      </span>
      <span class="area__chev" aria-hidden="true">→</span>
    `;

    button.addEventListener("click", () => selectArea(area.id));
    areaListEl.appendChild(button);
  }

  updateRailSelection();
}

function updateRailSelection() {
  for (const button of areaListEl.querySelectorAll(".area")) {
    const active = button.dataset.areaId === state.areaId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderLegend() {
  pinLegendEl.textContent = "";
  for (const kind of PIN_KINDS) {
    const row = document.createElement("span");
    row.className = "pin-legend__row";
    // var(--pin-*) rather than the raw hex, so the dots re-tint with the theme.
    row.innerHTML = `<i style="--dot:var(${kind.cssVar})"></i>${kind.label}`;
    pinLegendEl.appendChild(row);
  }

  // The three metro lines are drawn on the board in their real colours, so the
  // legend may as well say which is which.
  const metro = document.createElement("span");
  metro.className = "pin-legend__metro";
  metro.innerHTML = METRO_LINES.map(
    (line) => `<i style="--line:${line.color}"></i>${line.name.replace(" Line", "")}`
  ).join("");
  pinLegendEl.appendChild(metro);
}

function renderChrome() {
  const clusters = AREAS.length - 1;
  brandSubEl.textContent = `${STARTUPS.length} startups · ${clusters} clusters`;
  searchInputEl.placeholder = `Search ${STARTUPS.length} AI companies by name, sector, or cluster…`;
  railCreditEl.innerHTML = `Data: ${DATA_SOURCES.label} · ${DATA_SOURCES.updated}`;
  contributeLinkEl.href = DATA_SOURCES.contribute;
  repoLinkEl.href = DATA_SOURCES.repo;
}

// ── Deep links ──────────────────────────────────────────────────────────────
// #/area/:id and #/company/:id routes with browser back/forward support, so
// every view is shareable as a URL (the NYC AI Atlas pattern).

let suppressHashEvent = false;

function writeHash(hash) {
  if (location.hash === hash) return;
  suppressHashEvent = true;
  location.hash = hash;
}

function applyHashFromLocation() {
  const hash = location.hash || "#/";
  const company = hash.match(/^#\/company\/([\w-]+)$/);
  if (company && startupById.has(company[1])) {
    selectCompany(company[1]);
    return;
  }
  const area = hash.match(/^#\/area\/([\w-]+)$/);
  if (area && areaById(area[1])) {
    selectArea(area[1]);
    return;
  }
  if (hash === "#/" || hash === "#" || hash === "") {
    clearSelection();
    selectArea("all");
  }
}

window.addEventListener("hashchange", () => {
  if (suppressHashEvent) {
    suppressHashEvent = false;
    return;
  }
  applyHashFromLocation();
});

// ── Area banner ─────────────────────────────────────────────────────────────
// GTA-style location text: heavy condensed type slams in top-centre when the
// camera crosses into a cluster (or zooms onto a company), then clears away.

let bannerTimer = null;

function showAreaBanner(area, startup = null) {
  areaBannerEl.classList.remove("is-showing");
  // Force a reflow so a re-trigger restarts the entrance transition.
  void areaBannerEl.offsetWidth;

  areaBannerEl.innerHTML = startup
    ? `<span class="area-banner__sub">${startup.sector}</span>
       <span class="area-banner__title">${startup.name}</span>`
    : `<span class="area-banner__sub">Cluster ${area.number} · ${startupsByArea(area.id).length} companies</span>
       <span class="area-banner__title">${area.shortLabel}</span>`;

  areaBannerEl.classList.add("is-showing");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => areaBannerEl.classList.remove("is-showing"), 1900);
}

// ── Area selection ──────────────────────────────────────────────────────────

function selectArea(areaId, { fly = true } = {}) {
  const area = areaById(areaId);
  state.areaId = area.id;

  setPinArea(pins, area.id);
  updateRailSelection();
  refreshLabels();
  updateMiniMapFocus();

  if (fly) rig.flyTo(area.focus, area.id === "all" ? 1800 : 1400);

  showAreaBanner(area);
  writeHash(area.id === "all" ? "#/" : `#/area/${area.id}`);

  // Selecting a cluster clears a company selection that no longer belongs.
  if (state.selectedId) {
    const selected = startupById.get(state.selectedId);
    if (area.id !== "all" && selected && selected.area !== area.id) clearSelection();
  }

  if (!state.selectedId) showAreaCard(area);
}

function stepArea(delta) {
  const index = AREAS.findIndex((a) => a.id === state.areaId);
  const next = AREAS[(index + delta + AREAS.length) % AREAS.length];
  selectArea(next.id);
}

// ── Detail card ─────────────────────────────────────────────────────────────

function showAreaCard(area) {
  const list = startupsByArea(area.id);
  const sectors = [...new Set(list.map((s) => s.sector))];
  const hq = list.filter((s) => s.office === "HQ").length;

  detailCardEl.classList.remove("is-hidden");
  detailCardEl.classList.remove("has-accent");
  detailCardEl.innerHTML = `
    <p class="detail__eyebrow">Cluster ${area.number}</p>
    <h2 class="detail__title">${area.label}</h2>
    <p class="detail__body">${area.description}</p>
    <dl class="detail__stats">
      <div><dt>Companies</dt><dd>${list.length}</dd></div>
      <div><dt>Headquarters</dt><dd>${hq}</dd></div>
      <div><dt>Sectors</dt><dd>${sectors.length}</dd></div>
    </dl>
  `;
}

function showCompanyCard(startup) {
  const areaLabel = areaLabelById.get(startup.area) ?? startup.area;
  const host = startup.website ? new URL(startup.website).host.replace(/^www\./, "") : null;

  const rows = [
    ["Cluster", areaLabel],
    ["Stage", startup.stage],
    ["Office", startup.office],
    startup.founded ? ["Founded", String(startup.founded)] : null,
  ].filter(Boolean);

  detailCardEl.classList.remove("is-hidden");
  detailCardEl.style.setProperty("--card-accent", sectorColor(startup.sector));
  detailCardEl.classList.add("has-accent");
  detailCardEl.innerHTML = `
    <button class="detail__close" type="button" aria-label="Close company details">×</button>
    <p class="detail__eyebrow detail__eyebrow--sector">${startup.sector}</p>
    <h2 class="detail__title">${startup.name}</h2>
    ${startup.blurb ? `<p class="detail__body">${startup.blurb}</p>` : ""}
    <dl class="detail__meta">
      ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}
    </dl>
    ${
      host
        ? `<a class="detail__link" href="${startup.website}" target="_blank" rel="noreferrer noopener">${host} <span aria-hidden="true">↗</span></a>`
        : ""
    }
  `;

  detailCardEl.querySelector(".detail__close")?.addEventListener("click", () => {
    clearSelection();
    showAreaCard(areaById(state.areaId));
  });
}

function selectCompany(id, { fly = true } = {}) {
  const startup = startupById.get(id);
  if (!startup) return;

  state.selectedId = id;
  document.body.classList.add("is-focused");
  for (const pin of pins) pin.selected = pin.startup.id === id;

  // Reveal the pin's cluster if we're looking somewhere else entirely.
  if (state.areaId !== "all" && startup.area !== state.areaId) {
    state.areaId = startup.area;
    setPinArea(pins, state.areaId);
    updateRailSelection();
  }

  showCompanyCard(startup);
  refreshLabels();
  updateMiniMapFocus();

  if (fly) {
    // Close enough to read the block, far and high enough to stay a map — dive
    // in much past this and the stylized massing just becomes a grey canyon.
    rig.flyTo(
      {
        lat: startup.lat,
        lng: startup.lng,
        distance: 38,
        height: 36,
        rotation: rig.rotation,
      },
      1100
    );
  }

  showAreaBanner(areaById(startup.area), startup);
  writeHash(`#/company/${startup.id}`);
}

function clearSelection() {
  state.selectedId = null;
  document.body.classList.remove("is-focused");
  for (const pin of pins) pin.selected = false;
  detailCardEl.classList.add("is-hidden");
  refreshLabels();
  writeHash(state.areaId === "all" ? "#/" : `#/area/${state.areaId}`);
}

// ── Pointer interaction ─────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const drag = {
  active: false,
  moved: false,
  mode: "orbit",
  lastX: 0,
  lastY: 0,
  pointerId: null,
};

function setPointerFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickPin() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) return null;
  return hits[0].object.userData.startupId ?? null;
}

canvas.addEventListener("pointerdown", (event) => {
  if (drive.active) return; // the chase camera owns the view while driving
  canvas.setPointerCapture(event.pointerId);
  drag.active = true;
  drag.moved = false;
  drag.pointerId = event.pointerId;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  drag.mode = event.shiftKey || event.button === 1 || event.button === 2 ? "pan" : "orbit";
  canvas.classList.add("is-grabbing");
});

canvas.addEventListener("pointermove", (event) => {
  if (drive.active) return;
  if (drag.active) {
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;

    if (drag.mode === "pan") {
      // Pan by screen pixels so the map tracks the cursor 1:1 at every zoom.
      rig.panPixels(dx, dy, stage.size.width);
    } else {
      rig.orbit(-dx * 0.005, -dy * 0.35);
    }
    return;
  }

  setPointerFromEvent(event);
  const id = pickPin();
  if (id !== state.hoveredId) {
    state.hoveredId = id;
    for (const pin of pins) pin.hovered = pin.startup.id === id;
    labels.setEmphasis(id ? `c:${id}` : state.selectedId ? `c:${state.selectedId}` : null);
    canvas.classList.toggle("is-pointing", Boolean(id));
  }
});

function endDrag(event) {
  if (!drag.active) return;
  if (drag.pointerId != null && canvas.hasPointerCapture(drag.pointerId)) {
    canvas.releasePointerCapture(drag.pointerId);
  }
  const wasDrag = drag.moved;
  drag.active = false;
  drag.pointerId = null;
  canvas.classList.remove("is-grabbing");

  // A drag that ended is a camera move, not a click.
  if (wasDrag || !event) return;

  setPointerFromEvent(event);
  const id = pickPin();
  if (id) {
    selectCompany(id);
  } else if (state.selectedId) {
    clearSelection();
    showAreaCard(areaById(state.areaId));
  }
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", () => endDrag(null));
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener(
  "wheel",
  (event) => {
    if (drive.active) return; // no map zooming mid-drive
    event.preventDefault();
    // Normalise line-vs-pixel deltas, then clamp so trackpads don't teleport.
    const unit = event.deltaMode === 1 ? 16 : 1;
    const delta = Math.max(-120, Math.min(120, event.deltaY * unit));
    rig.zoom(Math.exp(delta * 0.0016));
  },
  { passive: false }
);

// Two-finger pinch on touch devices.
const touches = new Map();
canvas.addEventListener("touchstart", (event) => {
  for (const touch of event.changedTouches) {
    touches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
  }
});
canvas.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    const [a, b] = event.touches;
    const prevA = touches.get(a.identifier);
    const prevB = touches.get(b.identifier);
    if (!prevA || !prevB) return;

    const prevSpread = Math.hypot(prevA.x - prevB.x, prevA.y - prevB.y);
    const spread = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (prevSpread > 0 && spread > 0) rig.zoom(prevSpread / spread);

    touches.set(a.identifier, { x: a.clientX, y: a.clientY });
    touches.set(b.identifier, { x: b.clientX, y: b.clientY });
  },
  { passive: false }
);
canvas.addEventListener("touchend", (event) => {
  for (const touch of event.changedTouches) touches.delete(touch.identifier);
});

// ── Search ──────────────────────────────────────────────────────────────────

function scoreMatch(startup, query) {
  const name = startup.name.toLowerCase();
  const sector = startup.sector.toLowerCase();
  const area = (areaLabelById.get(startup.area) ?? "").toLowerCase();

  if (name.startsWith(query)) return 100 - name.length * 0.1;
  if (name.includes(query)) return 70;
  if (sector.startsWith(query)) return 50;
  if (sector.includes(query)) return 40;
  if (area.includes(query)) return 30;
  if ((startup.blurb ?? "").toLowerCase().includes(query)) return 15;
  return -1;
}

function runSearch(rawQuery) {
  const query = rawQuery.trim().toLowerCase();

  // A few notable companies keep the empty modal from feeling random (the NYC
  // atlas pattern) — typing still browses the full list.
  const FEATURED = ["sarvam-ai", "krutrim", "dashtoon", "toplyne", "karya", "composio"];

  const matches = query
    ? STARTUPS.map((s) => ({ startup: s, score: scoreMatch(s, query) }))
        .filter((m) => m.score >= 0)
        .sort((a, b) => b.score - a.score || a.startup.name.localeCompare(b.startup.name))
        .slice(0, 40)
        .map((m) => m.startup)
    : FEATURED.map((id) => startupById.get(id)).filter(Boolean);

  state.searchMatches = matches;
  state.searchIndex = 0;
  renderSearchResults();
}

function renderSearchResults() {
  searchResultsEl.textContent = "";

  if (!state.searchMatches.length) {
    const empty = document.createElement("p");
    empty.className = "search-empty";
    empty.textContent = "No companies match that. Try a sector, or a cluster name.";
    searchResultsEl.appendChild(empty);
    return;
  }

  state.searchMatches.forEach((startup, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === state.searchIndex));
    row.classList.toggle("is-active", index === state.searchIndex);
    row.dataset.index = String(index);

    const dot = startup.office === "HQ" ? PIN_KINDS[0].cssVar : PIN_KINDS[1].cssVar;
    row.innerHTML = `
      <i class="search-row__dot" style="--dot:var(${dot})"></i>
      <span class="search-row__name">${startup.name}</span>
      <span class="search-row__meta" style="--sector:${sectorColor(startup.sector)}">${startup.sector}</span>
      <span class="search-row__area">${areaLabelById.get(startup.area) ?? ""}</span>
    `;

    row.addEventListener("click", () => commitSearch(index));
    row.addEventListener("pointerenter", () => {
      state.searchIndex = index;
      syncSearchActive();
    });
    searchResultsEl.appendChild(row);
  });
}

function syncSearchActive() {
  for (const row of searchResultsEl.querySelectorAll(".search-row")) {
    const active = Number(row.dataset.index) === state.searchIndex;
    row.classList.toggle("is-active", active);
    row.setAttribute("aria-selected", String(active));
    if (active) row.scrollIntoView({ block: "nearest" });
  }
}

function commitSearch(index) {
  const startup = state.searchMatches[index];
  if (!startup) return;
  closeSearch();
  selectCompany(startup.id);
}

function openSearch() {
  if (searchModalEl.open) return;
  searchModalEl.showModal();
  searchInputEl.value = "";
  runSearch("");
  searchInputEl.focus();
}

function closeSearch() {
  if (searchModalEl.open) searchModalEl.close();
}

searchTriggerEl.addEventListener("click", openSearch);
searchInputEl.addEventListener("input", () => runSearch(searchInputEl.value));

searchModalEl.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.searchIndex = Math.min(state.searchIndex + 1, state.searchMatches.length - 1);
    syncSearchActive();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.searchIndex = Math.max(state.searchIndex - 1, 0);
    syncSearchActive();
  } else if (event.key === "Enter") {
    event.preventDefault();
    commitSearch(state.searchIndex);
  }
});

// Clicking the dialog backdrop closes it.
searchModalEl.addEventListener("click", (event) => {
  if (event.target === searchModalEl) closeSearch();
});

// ── Global keyboard ─────────────────────────────────────────────────────────

// ── Drive controls ──────────────────────────────────────────────────────────
// While driving, the keyboard belongs to the car: WASD/arrows drive, X
// U-turns, V/Tab swaps the ride, Esc exits. Everything else is swallowed.

const drivePickerEl = document.getElementById("drivePicker");

document.getElementById("driveTrigger").addEventListener("click", () => drive.openPicker());
document.getElementById("driveExit").addEventListener("click", () => {
  const pos = drive.exit();
  if (pos) landRigOn(pos);
});
document.getElementById("driveUturn").addEventListener("click", () => drive.uturn());

// Window blur can strand a held key — clear the pedals.
window.addEventListener("blur", () => {
  drive.keys.throttle = drive.keys.brake = drive.keys.left = drive.keys.right = false;
});

/**
 * Land the map camera over a world position (used when exiting drive mode).
 * Starts tight and low on the player's own heading, then lets the rig's damping
 * pull back to the map view — handing control over reads as a lift-off instead
 * of a cut to an unrelated angle.
 */
function landRigOn(pos) {
  rig.flight = null;
  rig.target.set(pos.x, 0, pos.z);
  rig.desired.target.copy(rig.target);
  // The rig orbits to `target + (sin r, ·, cos r) · distance`; the chase camera
  // sat *behind* the car, so the matching orbit angle is the heading plus π.
  rig.rotation = rig.desired.rotation = pos.heading + Math.PI;
  rig.distance = 12;
  rig.height = 7;
  rig.desired.distance = 40;
  rig.desired.height = 32;
}

window.addEventListener("keydown", (event) => {
  if (drive.active) {
    const key = event.key;
    if (key === "w" || key === "W" || key === "ArrowUp") {
      drive.keys.throttle = true;
      event.preventDefault();
    } else if (key === "s" || key === "S" || key === "ArrowDown") {
      drive.keys.brake = true;
      event.preventDefault();
    } else if (key === "a" || key === "A" || key === "ArrowLeft") {
      drive.keys.left = true;
      event.preventDefault();
    } else if (key === "d" || key === "D" || key === "ArrowRight") {
      drive.keys.right = true;
      event.preventDefault();
    } else if (key === "Escape") {
      const pos = drive.exit();
      if (pos) landRigOn(pos);
    } else if (key === "x" || key === "X") {
      drive.uturn();
    } else if (key === "v" || key === "V" || key === "Tab") {
      event.preventDefault();
      const pos = drive.exit();
      if (pos) landRigOn(pos);
      drive.openPicker();
    }
    return;
  }

  const typing =
    event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
    return;
  }

  // The ride picker is modal: the map shortcuts behind it must stay inert.
  if (searchModalEl.open || drivePickerEl.open || typing) return;

  switch (event.key) {
    case "d":
    case "D":
      drive.openPicker();
      break;
    case "ArrowDown":
      event.preventDefault();
      stepArea(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      stepArea(-1);
      break;
    case "ArrowLeft":
      rig.orbit(0.28, 0);
      break;
    case "ArrowRight":
      rig.orbit(-0.28, 0);
      break;
    case "Escape":
      if (state.selectedId) {
        clearSelection();
        showAreaCard(areaById(state.areaId));
      }
      break;
    case "/":
      event.preventDefault();
      openSearch();
      break;
    default:
      break;
  }
});

window.addEventListener("keyup", (event) => {
  if (!drive.active) return;
  const key = event.key;
  if (key === "w" || key === "W" || key === "ArrowUp") drive.keys.throttle = false;
  else if (key === "s" || key === "S" || key === "ArrowDown") drive.keys.brake = false;
  else if (key === "a" || key === "A" || key === "ArrowLeft") drive.keys.left = false;
  else if (key === "d" || key === "D" || key === "ArrowRight") drive.keys.right = false;
});

// ── Mini-map ────────────────────────────────────────────────────────────────

const miniMap = {
  ring: document.getElementById("miniMapRing"),
  water: document.getElementById("miniMapWater"),
  metro: document.getElementById("miniMapMetro"),
  points: document.getElementById("miniMapPoints"),
  focus: document.getElementById("miniMapFocus"),
  toView: null,
};

/**
 * Fit the world-space board into the mini-map viewBox. Built from the ORR
 * outline plus every pin, so nothing on the board falls outside the frame.
 */
function buildMiniMap() {
  const orr = ROADS.find((r) => r.id === "orr");
  const worldPoints = [
    ...orr.path.map(([lat, lng]) => project(lat, lng)),
    ...STARTUPS.map((s) => project(s.lat, s.lng)),
  ];

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of worldPoints) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const size = 132;
  const pad = 12;
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = (size - pad * 2) / span;
  // Centre the content inside the square viewBox.
  const offsetX = pad + ((size - pad * 2) - (maxX - minX) * scale) / 2;
  const offsetZ = pad + ((size - pad * 2) - (maxZ - minZ) * scale) / 2;

  miniMap.toView = (x, z) => ({
    x: (x - minX) * scale + offsetX,
    y: (z - minZ) * scale + offsetZ,
  });

  const toPath = (latlngs, close) => {
    const d = latlngs
      .map(([lat, lng], i) => {
        const p = project(lat, lng);
        const v = miniMap.toView(p.x, p.z);
        return `${i === 0 ? "M" : "L"}${v.x.toFixed(1)} ${v.y.toFixed(1)}`;
      })
      .join(" ");
    return close ? `${d} Z` : d;
  };

  miniMap.ring.setAttribute("d", toPath(orr.path, true));

  // Only the lakes big enough to read at 132px.
  miniMap.water.textContent = "";
  for (const lake of LAKES.filter((l) => l.label)) {
    const centre = centroidOf(lake.ring);
    const p = project(centre.lat, centre.lng);
    const v = miniMap.toView(p.x, p.z);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "mini-map__water");
    circle.setAttribute("cx", v.x.toFixed(1));
    circle.setAttribute("cy", v.y.toFixed(1));
    circle.setAttribute("r", "3.2");
    miniMap.water.appendChild(circle);
  }

  miniMap.metro.textContent = "";
  for (const line of METRO_LINES) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "mini-map__metro");
    path.setAttribute("d", toPath(line.path, false));
    path.setAttribute("stroke", line.color);
    miniMap.metro.appendChild(path);
  }

  miniMap.points.textContent = "";
  for (const startup of STARTUPS) {
    const p = project(startup.lat, startup.lng);
    const v = miniMap.toView(p.x, p.z);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "mini-map__point");
    dot.dataset.area = startup.area;
    dot.setAttribute("cx", v.x.toFixed(1));
    dot.setAttribute("cy", v.y.toFixed(1));
    dot.setAttribute("r", "1.35");
    miniMap.points.appendChild(dot);
  }

  updateMiniMapFocus();
}

function updateMiniMapFocus() {
  if (!miniMap.toView) return;

  for (const dot of miniMap.points.children) {
    const active = state.areaId === "all" || dot.dataset.area === state.areaId;
    dot.classList.toggle("is-dim", !active);
  }

  const area = areaById(state.areaId);
  const p = project(area.focus.lat, area.focus.lng);
  const v = miniMap.toView(p.x, p.z);
  miniMap.focus.setAttribute("cx", v.x.toFixed(1));
  miniMap.focus.setAttribute("cy", v.y.toFixed(1));
  // Radius tracks how wide the camera framing is for this cluster.
  miniMap.focus.setAttribute("r", String(state.areaId === "all" ? 0 : 9));
}

// ── Render loop ─────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function frame() {
  // Damping uses a clamped step so a stalled tab doesn't snap the camera;
  // flights get the true delta so they always land in their stated duration.
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);

  if (drive.active) {
    // The drive controller moves the camera itself (chase rig).
    drive.update(dt);
  } else {
    rig.update(dt, rawDt);
  }
  updatePins(pins, dt, camera);
  const viewDistance = drive.active ? drive.distance : rig.distance;
  traffic.update(dt, viewDistance);
  plane.update(dt);
  labels.update(camera, stage.size, viewDistance);
  stage.render();

  requestAnimationFrame(frame);
}

// ── Boot ────────────────────────────────────────────────────────────────────

/** Matches the `--rail-w` + `--hud-pad` breakpoint in tokens.css. */
const RAIL_BREAKPOINT = 900;

function handleResize() {
  stage.resize();
  // Below the breakpoint the rail moves to the bottom, so it no longer steals
  // horizontal room and the reframe must switch off.
  const beside = window.innerWidth > RAIL_BREAKPOINT;
  rig.setFraming({
    width: stage.size.width,
    height: stage.size.height,
    // --rail-w (348px) + --hud-pad (24px); keeps the board framing clear of the rail.
    railPx: beside ? 372 : 0,
  });
}

window.addEventListener("resize", handleResize);

// Build the board in whichever theme the bootstrap script resolved.
applyTheme(currentTheme());

document.getElementById("themeToggle").addEventListener("click", () => {
  applyTheme(currentTheme() === "dark" ? "light" : "dark", { persist: true });
});

// Track the OS preference live — but only while the user hasn't overridden it.
const lightQuery = window.matchMedia("(prefers-color-scheme: light)");
lightQuery.addEventListener?.("change", (event) => {
  if (!storedTheme()) applyTheme(event.matches ? "light" : "dark");
});

renderChrome();
renderRail();
renderLegend();
buildMiniMap();
refreshLabels();
setPinArea(pins, state.areaId);
showAreaCard(AREAS[0]);
showAreaBanner(AREAS[0]);
handleResize();

// Land on whatever view the URL asks for (deep link or refresh).
applyHashFromLocation();

frame();

// The brand is the map's home button — back to the whole board, no selection.
document.querySelector(".brand")?.addEventListener("click", (event) => {
  event.preventDefault();
  clearSelection();
  selectArea("all");
});

// Debug handle. Deliberate and documented in CONTRIBUTING: lets you inspect
// camera state or pin placement from the console (`__atlas.rig.distance`, …).
window.__atlas = { rig, state, stage, pins, traffic, labels, drive, plane };

// Fade the loader once the first real frame is on screen.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    loaderEl.classList.add("is-done");
    setTimeout(() => loaderEl.remove(), 600);
  });
});
