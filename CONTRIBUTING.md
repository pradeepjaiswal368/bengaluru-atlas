# Contributing

## Add your startup

One record in [`src/data.js`](src/data.js), appended to the `STARTUPS` array
under its cluster's comment banner:

```js
{
  id: "your-startup",            // kebab-case, unique
  name: "Your Startup",
  lat: 12.9345,                  // neighbourhood-level is fine (see below)
  lng: 77.6215,
  area: "koramangala",           // one of the AREAS ids in the same file
  stage: "Early-Stage",          // Early-Stage | Late-Stage | Public | Research
  sector: "AI/Data Infrastructure",
  office: "HQ",                  // HQ | Satellite Office
  website: "https://…",
  founded: 2024,                 // optional
  blurb: "One line on what you actually build.",
},
```

Ground rules:

- **You must be an AI company building in Bengaluru** — an office and a team
  here, not a mailbox.
- **Coordinates are neighbourhood-level.** The map is stylized; put the pin in
  the pocket where the team actually sits. Don't fight over rooftops.
- **The blurb is one sentence about the product**, not a mission statement.
- **Sector** should reuse an existing value where one fits (run
  `node -e "import('./src/data.js').then(m => console.log(m.SECTORS))" --input-type=module`
  to list them) — new sectors are fine when genuinely new.
- Verify `stage`/`founded` against something public (site, filing, press).

Then run `npm run dev`, click your cluster, and confirm the pin and its label
land where you expect.

## Fixing the map

Geography lives in [`src/geo.js`](src/geo.js) as lat/lng rings and polylines —
lakes, parks, roads, metro lines, district massing polygons, landmarks. It is
deliberately hand-drawn (a diagram, not GIS), so edits should optimise for
legibility at map scale, not survey accuracy.

Colours come in pairs: anything you tint on the board must work in **both**
themes. The 3D palettes are `PALETTES.dark` / `PALETTES.light` in
[`src/city.js`](src/city.js) (identical key sets — add your key to both),
scene lighting is `SCENE_THEMES` in [`src/scene.js`](src/scene.js), and HUD
colours are token pairs in [`src/tokens.css`](src/tokens.css). Check a change
in both themes before opening a PR — the toggle is the ☀/☾ button top right.

## Debugging

The app exposes `window.__atlas` in the console:

- `__atlas.rig` — camera state (`distance`, `height`, `rotation`, `target`)
- `__atlas.pins` — every pin with its startup record and animation state
- `__atlas.state` — active cluster / selection
- `__atlas.stage` — renderer, scene, camera
- `__atlas.traffic.stats` — fleet size per vehicle kind

Useful when placing a new company or tuning a cluster's `focus` framing.

## Checks before a PR

```bash
npm run build   # must pass
```

There's no test suite; the dataset has invariants worth eyeballing —
unique `id`s, every `area` matching an `AREAS` entry, counts in the HUD
updating automatically (they're derived, never hard-coded).
