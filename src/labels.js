/**
 * Bengaluru AI Atlas — label layer.
 *
 * Labels are HTML, not sprites: crisper text, real fonts, and they inherit the
 * page's theme for free. Each frame we project every label's world position to
 * screen space, then place them greedily nearest-first, skipping any that would
 * collide with one already placed. That keeps dense pockets like Koramangala
 * readable instead of turning into a wall of overlapping type.
 */

import * as THREE from "three";
import { clamp } from "./geometry.js";

const projected = new THREE.Vector3();

/**
 * Where a label may sit when its own anchor is already taken. Vertical rungs are
 * tried outward from the anchor, upward first (a name above its pin is the
 * conventional reading); at each rung the label may also fan sideways.
 * The pin's stem still points at the owner, so a nudged label stays unambiguous.
 */
const LADDER = [0, -24, -48, 22, 44, -72, 64, -96, 84, -120, 104];
const RUNGS_X = [0, -48, 48, -92, 92];

/** Rough on-screen footprint per label kind, used for collision boxes. */
const BOX = {
  company: { w: 152, h: 46 },
  landmark: { w: 134, h: 30 },
  place: { w: 146, h: 28 },
};

export class LabelLayer {
  /** @param {HTMLElement} container the absolutely-positioned overlay div */
  constructor(container) {
    this.container = container;
    /** @type {Map<string, {entry: object, el: HTMLElement, visible: boolean, slot: {dx:number,dy:number}|null}>} */
    this.items = new Map();
    /** Density mode, derived from camera distance in update(). */
    this.mode = "near";
  }

  /**
   * Replace the label set. Entries are `{id, text, sub, kind, world}` where
   * `world` is a THREE.Vector3. Nodes are reused across calls by id.
   */
  set(entries) {
    const seen = new Set();

    for (const entry of entries) {
      seen.add(entry.id);
      let item = this.items.get(entry.id);

      if (!item) {
        const el = document.createElement("div");
        el.className = `map-label map-label--${entry.kind}`;
        el.dataset.kind = entry.kind;
        el.setAttribute("aria-hidden", "true");
        this.container.appendChild(el);
        item = { entry, el, visible: false, slot: null };
        this.items.set(entry.id, item);
      }

      item.entry = entry;
      const { el } = item;

      // Swap only the kind modifier. Assigning el.className wholesale would
      // silently drop `is-visible` / `is-emphasis` while `item.visible` stayed
      // true, so update() would never re-add them and the label would be stuck
      // invisible for the rest of the session.
      if (el.dataset.kind !== entry.kind) {
        el.classList.remove(`map-label--${el.dataset.kind}`);
        el.classList.add(`map-label--${entry.kind}`);
        el.dataset.kind = entry.kind;
      }
      // Only touch the DOM when the text actually changed.
      if (el.dataset.text !== entry.text || el.dataset.sub !== (entry.sub ?? "")) {
        el.dataset.text = entry.text;
        el.dataset.sub = entry.sub ?? "";
        el.textContent = "";
        const name = document.createElement("span");
        name.className = "map-label__name";
        name.textContent = entry.text;
        el.appendChild(name);
        if (entry.sub) {
          const sub = document.createElement("span");
          sub.className = "map-label__sub";
          sub.textContent = entry.sub;
          el.appendChild(sub);
        }
      }
    }

    for (const [id, item] of this.items) {
      if (!seen.has(id)) {
        item.el.remove();
        this.items.delete(id);
      }
    }
  }

  /** Mark one label as emphasised (hover or selection). */
  setEmphasis(id) {
    for (const [key, item] of this.items) {
      item.el.classList.toggle("is-emphasis", key === id);
    }
  }

  /**
   * Project and place. Call once per frame after the camera has moved.
   * @param {THREE.Camera} camera
   * @param {{width: number, height: number}} size renderer size in CSS pixels
   * @param {number} viewDistance camera pull-back, used to pick a density mode:
   *   far (whole plateau) shows fewer, name-only labels; near shows the works.
   */
  update(camera, size, viewDistance = 60) {
    const mode = viewDistance > 120 ? "far" : viewDistance > 70 ? "mid" : "near";
    if (mode !== this.mode) {
      this.mode = mode;
      this.container.classList.toggle("is-far", mode === "far");
    }
    // A hard cap instead of the old per-priority bonus: the sort already puts
    // what matters first, so the budget only has to say how busy the screen is
    // allowed to get at this altitude.
    const budget = mode === "far" ? 18 : mode === "mid" ? 30 : 40;

    const placed = [];
    const candidates = [];

    for (const item of this.items.values()) {
      projected.copy(item.entry.world).project(camera);

      // Behind the camera, or outside the frustum with a small margin.
      if (projected.z > 1 || projected.z < -1) {
        this.#hide(item);
        continue;
      }

      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (-projected.y * 0.5 + 0.5) * size.height;
      const margin = 80;
      if (x < -margin || x > size.width + margin || y < -margin || y > size.height + margin) {
        this.#hide(item);
        continue;
      }

      candidates.push({
        item,
        x,
        y,
        depth: projected.z,
        priority: item.entry.priority ?? 0,
        emphasis: item.el.classList.contains("is-emphasis"),
      });
    }

    // Emphasis first, then priority, then nearest — and finally the id, so the
    // order is STABLE: two labels at near-identical depth must not swap ranks
    // between frames, or they trade places on screen while the camera drifts.
    candidates.sort(
      (a, b) =>
        Number(b.emphasis) - Number(a.emphasis) ||
        b.priority - a.priority ||
        a.depth - b.depth ||
        (a.item.entry.id < b.item.entry.id ? -1 : 1)
    );

    // At far zoom, nearest-first would spend the whole budget on the camera-near
    // half of the board and leave the far clusters mute. One label per coarse
    // screen cell spreads the survivors across the view; within a cell the sort
    // order still decides who wins.
    let pool = candidates;
    if (mode === "far") {
      const cells = new Set();
      pool = [];
      for (const candidate of candidates) {
        const cell = `${Math.floor(candidate.x / 150)}:${Math.floor(candidate.y / 105)}`;
        if (cells.has(cell) && !candidate.emphasis) {
          this.#hide(candidate.item);
          continue;
        }
        cells.add(cell);
        pool.push(candidate);
      }
    }

    let shown = 0;
    for (const candidate of pool) {
      const { item, x, y, depth, emphasis } = candidate;

      if (shown >= budget && !emphasis) {
        this.#hide(item);
        continue;
      }

      const box = BOX[item.entry.kind] ?? BOX.company;
      // Sub-labels are hidden at far zoom (CSS), so the collision box shrinks
      // with them — otherwise labels reserve space for text they aren't showing.
      const boxH = mode === "far" && item.entry.kind === "company" ? 26 : box.h;
      const boxFor = (dx, dy) => ({
        left: x + dx - box.w / 2,
        right: x + dx + box.w / 2,
        top: y + dy - boxH,
        bottom: y + dy + 6,
      });
      const hits = (r) =>
        placed.some(
          (p) => r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top
        );

      // Hysteresis first: if the slot this label used last frame is still free,
      // keep it. Without this, the greedy solver re-derives placements from
      // scratch every frame and labels visibly hop between rungs while the
      // camera moves — the single biggest source of "the UI feels jittery".
      let offset = null;
      let rect = null;
      if (item.slot) {
        const test = boxFor(item.slot.dx, item.slot.dy);
        if (!hits(test)) {
          offset = item.slot;
          rect = test;
        }
      }

      // Otherwise walk the ladder: up first, then down, fanning sideways at
      // each rung. The pin's stem keeps a nudged label unambiguous.
      if (!offset) {
        search: for (const candidateDy of LADDER) {
          for (const candidateDx of RUNGS_X) {
            const test = boxFor(candidateDx, candidateDy);
            if (!hits(test)) {
              offset = { dx: candidateDx, dy: candidateDy };
              rect = test;
              break search;
            }
          }
        }
      }

      if (offset === null) {
        // Nothing free. Emphasised labels overlap rather than disappear.
        if (!emphasis) {
          this.#hide(item);
          continue;
        }
        offset = { dx: 0, dy: 0 };
        rect = boxFor(0, 0);
      }

      item.slot = offset;
      placed.push(rect);
      shown++;

      // Fade with depth so the far side recedes — but keep a readable floor;
      // a label worth showing is worth showing legibly, and at far zoom the
      // whole board compresses into a narrow depth band anyway.
      const fade = clamp(1 - (depth - 0.9) * 6, mode === "far" ? 0.66 : 0.48, 1);
      // Sub-pixel positions on purpose: rounding to whole pixels makes slow
      // camera drift read as stepping.
      item.el.style.transform = `translate3d(${(x + offset.dx).toFixed(1)}px, ${(y + offset.dy).toFixed(1)}px, 0)`;
      item.el.style.opacity = fade.toFixed(3);
      if (!item.visible) {
        item.el.classList.add("is-visible");
        item.visible = true;
      }
    }
  }

  #hide(item) {
    if (item.visible) {
      item.el.classList.remove("is-visible");
      item.el.style.opacity = "0";
      item.visible = false;
    }
  }

  clear() {
    for (const item of this.items.values()) item.el.remove();
    this.items.clear();
  }
}
