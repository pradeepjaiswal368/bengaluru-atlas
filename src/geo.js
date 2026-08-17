/**
 * Bengaluru AI Atlas — geography.
 *
 * Hand-authored, stylized geography. This is NOT GIS-precise: lakes, parks,
 * the Outer Ring Road, metro lines and district footprints are drawn by hand to
 * read clearly at map scale, the way a transit diagram is drawn rather than
 * surveyed. Everything is stored as WGS84 lat/lng so it stays editable, then
 * projected to a local metre-based plane at load.
 *
 * Bengaluru has no coastline to anchor a map, so the legible skeleton here is:
 * a ring road, a chain of lakes, two green lungs, and three metro lines.
 */

// ── Projection ──────────────────────────────────────────────────────────────

/** Map origin — roughly the centroid of the tech clusters, east of Cubbon Park. */
export const ORIGIN = { lat: 12.9455, lng: 77.6480 };

/** 1 world unit ≈ 150 m, so the ~25 km plateau lands in a ~165-unit board. */
const METRES_PER_UNIT = 150;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** lat/lng → world XZ. +x is east, −z is north (three.js right-handed). */
export function project(lat, lng) {
  return {
    x: ((lng - ORIGIN.lng) * M_PER_DEG_LNG) / METRES_PER_UNIT,
    z: -((lat - ORIGIN.lat) * M_PER_DEG_LAT) / METRES_PER_UNIT,
  };
}

/** Convert a metre distance into world units — for road widths, radii, etc. */
export function metres(m) {
  return m / METRES_PER_UNIT;
}

/** Extent of the drawn board, in world units. Used for ground plane + fog. */
export const BOARD = { halfWidth: 132, halfDepth: 128 };

// ── Water ───────────────────────────────────────────────────────────────────
// Bengaluru's lakes are the map's water. Bellandur and Varthur are genuinely
// huge; the rest are drawn at readable minimum size.

export const LAKES = [
  {
    id: "bellandur",
    name: "Bellandur Lake",
    label: true,
    ring: [
      [12.9412, 77.6512],
      [12.9448, 77.6608],
      [12.9430, 77.6702],
      [12.9366, 77.6768],
      [12.9288, 77.6790],
      [12.9236, 77.6742],
      [12.9228, 77.6650],
      [12.9268, 77.6560],
      [12.9330, 77.6508],
    ],
  },
  {
    id: "varthur",
    name: "Varthur Lake",
    label: true,
    ring: [
      [12.9462, 77.7132],
      [12.9490, 77.7252],
      [12.9440, 77.7360],
      [12.9350, 77.7382],
      [12.9296, 77.7300],
      [12.9312, 77.7180],
      [12.9384, 77.7118],
    ],
  },
  {
    id: "agara",
    name: "Agara Lake",
    ring: [
      [12.9248, 77.6348],
      [12.9268, 77.6420],
      [12.9226, 77.6462],
      [12.9174, 77.6432],
      [12.9178, 77.6362],
    ],
  },
  {
    id: "madiwala",
    name: "Madiwala Lake",
    ring: [
      [12.9222, 77.6118],
      [12.9250, 77.6198],
      [12.9206, 77.6252],
      [12.9146, 77.6222],
      [12.9152, 77.6142],
    ],
  },
  {
    id: "kaikondrahalli",
    name: "Kaikondrahalli Lake",
    ring: [
      [12.9118, 77.6742],
      [12.9138, 77.6820],
      [12.9082, 77.6862],
      [12.9036, 77.6812],
      [12.9058, 77.6740],
    ],
  },
  {
    id: "ulsoor",
    name: "Ulsoor Lake",
    label: true,
    ring: [
      [12.9862, 77.6142],
      [12.9880, 77.6222],
      [12.9812, 77.6268],
      [12.9762, 77.6216],
      [12.9792, 77.6140],
    ],
  },
  {
    id: "sankey",
    name: "Sankey Tank",
    ring: [
      [13.0116, 77.5702],
      [13.0136, 77.5768],
      [13.0072, 77.5798],
      [13.0026, 77.5750],
      [13.0056, 77.5696],
    ],
  },
  {
    id: "hebbal",
    name: "Hebbal Lake",
    label: true,
    ring: [
      [13.0512, 77.5828],
      [13.0554, 77.5918],
      [13.0510, 77.5998],
      [13.0428, 77.5990],
      [13.0396, 77.5900],
      [13.0442, 77.5824],
    ],
  },
  {
    id: "jakkur",
    name: "Jakkur Lake",
    ring: [
      [13.0768, 77.5924],
      [13.0800, 77.6014],
      [13.0742, 77.6062],
      [13.0684, 77.6006],
      [13.0708, 77.5926],
    ],
  },
  {
    id: "lalbagh-lake",
    name: "Lalbagh Lake",
    ring: [
      [12.9466, 77.5866],
      [12.9482, 77.5924],
      [12.9438, 77.5952],
      [12.9402, 77.5910],
      [12.9424, 77.5862],
    ],
  },
  {
    id: "hulimavu",
    name: "Hulimavu Lake",
    ring: [
      [12.8842, 77.5910],
      [12.8866, 77.5988],
      [12.8810, 77.6032],
      [12.8760, 77.5980],
      [12.8784, 77.5910],
    ],
  },
  {
    id: "hoskote-halli",
    name: "Kalkere Lake",
    ring: [
      [13.0242, 77.6712],
      [13.0268, 77.6788],
      [13.0208, 77.6828],
      [13.0158, 77.6772],
      [13.0186, 77.6708],
    ],
  },
];

// ── Green ───────────────────────────────────────────────────────────────────
// Cubbon Park and Lalbagh are the two lungs the city is planned around; the
// institutional campuses (IISc, GKVK, Palace grounds) read as green too.

export const PARKS = [
  {
    id: "cubbon",
    name: "Cubbon Park",
    label: true,
    ring: [
      [12.9812, 77.5862],
      [12.9838, 77.5952],
      [12.9788, 77.6018],
      [12.9718, 77.6008],
      [12.9686, 77.5942],
      [12.9722, 77.5872],
      [12.9772, 77.5844],
    ],
  },
  {
    id: "lalbagh",
    name: "Lalbagh Botanical Garden",
    label: true,
    ring: [
      [12.9552, 77.5822],
      [12.9576, 77.5906],
      [12.9538, 77.5978],
      [12.9452, 77.5988],
      [12.9396, 77.5928],
      [12.9414, 77.5842],
      [12.9482, 77.5798],
    ],
  },
  {
    id: "iisc",
    name: "IISc Campus",
    label: true,
    ring: [
      [13.0292, 77.5588],
      [13.0318, 77.5686],
      [13.0262, 77.5758],
      [13.0164, 77.5748],
      [13.0132, 77.5652],
      [13.0196, 77.5580],
    ],
  },
  {
    id: "palace",
    name: "Palace Grounds",
    ring: [
      [13.0038, 77.5852],
      [13.0062, 77.5928],
      [13.0018, 77.5986],
      [12.9948, 77.5972],
      [12.9932, 77.5896],
      [12.9982, 77.5846],
    ],
  },
  {
    id: "gkvk",
    name: "GKVK Campus",
    ring: [
      [13.0862, 77.5688],
      [13.0898, 77.5806],
      [13.0836, 77.5892],
      [13.0724, 77.5872],
      [13.0692, 77.5754],
      [13.0768, 77.5678],
    ],
  },
  {
    id: "turahalli",
    name: "Turahalli Forest",
    ring: [
      [12.8968, 77.5182],
      [12.8998, 77.5288],
      [12.8938, 77.5362],
      [12.8852, 77.5330],
      [12.8842, 77.5228],
      [12.8902, 77.5168],
    ],
  },
  {
    id: "bannerghatta-edge",
    name: "Bannerghatta Reserve",
    ring: [
      [12.8382, 77.5642],
      [12.8420, 77.5788],
      [12.8340, 77.5892],
      [12.8188, 77.5858],
      [12.8158, 77.5702],
      [12.8258, 77.5612],
    ],
  },
  {
    id: "hal-airfield",
    name: "HAL Airfield",
    kind: "airfield",
    ring: [
      [12.9578, 77.6572],
      [12.9598, 77.6712],
      [12.9542, 77.6742],
      [12.9478, 77.6706],
      [12.9462, 77.6600],
      [12.9518, 77.6562],
    ],
  },
];

// ── Roads ───────────────────────────────────────────────────────────────────
// tier drives width + brightness: "ring" > "arterial" > "street".

export const ROADS = [
  {
    id: "orr",
    name: "Outer Ring Road",
    tier: "ring",
    closed: true,
    label: true,
    labelAt: [12.9802, 77.5232],
    path: [
      [13.0358, 77.5910], // Hebbal flyover
      [13.0432, 77.6212], // Nagawara
      [13.0238, 77.6452], // Banaswadi
      [13.0058, 77.6782], // Tin Factory / KR Puram
      [12.9908, 77.6932], // Mahadevapura
      [12.9562, 77.7012], // Marathahalli
      [12.9432, 77.6932], // Kadubeesanahalli
      [12.9262, 77.6792], // Bellandur
      [12.9196, 77.6456], // Agara
      [12.9176, 77.6232], // Central Silk Board
      [12.9112, 77.5976], // Bannerghatta Road
      [12.9012, 77.5822], // Puttenahalli
      [12.8952, 77.5602], // Konanakunte
      [12.9218, 77.5352], // Kengeri edge
      [12.9376, 77.5288], // Nayandahalli
      [12.9802, 77.5232], // Sumanahalli
      [13.0252, 77.5232], // Peenya
      [13.0432, 77.5482], // Jalahalli
    ],
  },
  {
    id: "hosur-road",
    name: "Hosur Road",
    tier: "arterial",
    label: true,
    labelAt: [12.8792, 77.6382],
    path: [
      [12.9176, 77.6232],
      [12.8988, 77.6212],
      [12.8792, 77.6382],
      [12.8562, 77.6578],
      [12.8452, 77.6622],
      [12.8132, 77.6802],
    ],
  },
  {
    id: "sarjapur-road",
    name: "Sarjapur Road",
    tier: "arterial",
    label: true,
    labelAt: [12.9062, 77.6768],
    path: [
      [12.9352, 77.6142],
      [12.9226, 77.6392],
      [12.9152, 77.6552],
      [12.9062, 77.6768],
      [12.8942, 77.6952],
      [12.8862, 77.7128],
    ],
  },
  {
    id: "old-airport-road",
    name: "Old Airport Road",
    tier: "arterial",
    label: true,
    labelAt: [12.9598, 77.6598],
    path: [
      [12.9742, 77.6152],
      [12.9612, 77.6392],
      [12.9598, 77.6598],
      [12.9578, 77.6812],
      [12.9562, 77.7012],
    ],
  },
  {
    id: "old-madras-road",
    name: "Old Madras Road",
    tier: "arterial",
    path: [
      [12.9822, 77.6272],
      [12.9902, 77.6522],
      [13.0058, 77.6782],
      [13.0122, 77.7042],
    ],
  },
  {
    id: "whitefield-main",
    name: "Whitefield Road",
    tier: "arterial",
    path: [
      [12.9908, 77.6932],
      [12.9902, 77.7132],
      [12.9856, 77.7372],
      [12.9932, 77.7578],
    ],
  },
  {
    id: "varthur-road",
    name: "Varthur Road",
    tier: "street",
    path: [
      [12.9562, 77.7012],
      [12.9498, 77.7182],
      [12.9432, 77.7322],
      [12.9362, 77.7488],
    ],
  },
  {
    id: "bellary-road",
    name: "Bellary Road (NH 44)",
    tier: "arterial",
    label: true,
    labelAt: [13.0712, 77.5942],
    path: [
      [12.9862, 77.5902],
      [13.0042, 77.5898],
      [13.0358, 77.5910],
      [13.0712, 77.5942],
      [13.1042, 77.5962],
    ],
  },
  {
    id: "tumkur-road",
    name: "Tumkur Road",
    tier: "arterial",
    path: [
      [12.9782, 77.5712],
      [13.0022, 77.5562],
      [13.0252, 77.5232],
    ],
  },
  {
    id: "mysore-road",
    name: "Mysore Road",
    tier: "arterial",
    path: [
      [12.9662, 77.5732],
      [12.9552, 77.5502],
      [12.9376, 77.5288],
    ],
  },
  {
    id: "kanakapura-road",
    name: "Kanakapura Road",
    tier: "arterial",
    path: [
      [12.9422, 77.5762],
      [12.9222, 77.5802],
      [12.8952, 77.5602],
      [12.8742, 77.5462],
    ],
  },
  {
    id: "bannerghatta-road",
    name: "Bannerghatta Road",
    tier: "arterial",
    path: [
      [12.9402, 77.5942],
      [12.9112, 77.5976],
      [12.8842, 77.5942],
      [12.8552, 77.5892],
      [12.8322, 77.5772],
    ],
  },
  {
    id: "inner-ring",
    name: "Inner Ring Road",
    tier: "arterial",
    path: [
      [12.9612, 77.6392],
      [12.9482, 77.6312],
      [12.9352, 77.6252],
      [12.9256, 77.6182],
      [12.9176, 77.6232],
    ],
  },
  {
    id: "mg-road",
    name: "MG Road",
    tier: "street",
    label: true,
    labelAt: [12.9748, 77.6122],
    path: [
      [12.9752, 77.6022],
      [12.9748, 77.6122],
      [12.9736, 77.6208],
    ],
  },
  {
    id: "hundred-feet",
    name: "100 Feet Road",
    tier: "street",
    path: [
      [12.9682, 77.6362],
      [12.9748, 77.6402],
      [12.9812, 77.6428],
    ],
  },
  {
    id: "koramangala-80ft",
    name: "80 Feet Road",
    tier: "street",
    path: [
      [12.9442, 77.6178],
      [12.9352, 77.6242],
      [12.9268, 77.6292],
    ],
  },
  {
    id: "hsr-27th",
    name: "27th Main",
    tier: "street",
    path: [
      [12.9202, 77.6382],
      [12.9128, 77.6432],
      [12.9062, 77.6482],
    ],
  },
  {
    id: "jayanagar-4th",
    name: "Jayanagar 4th Block",
    tier: "street",
    path: [
      [12.9352, 77.5822],
      [12.9268, 77.5842],
      [12.9182, 77.5862],
    ],
  },
  {
    id: "malleshwaram-sampige",
    name: "Sampige Road",
    tier: "street",
    path: [
      [13.0102, 77.5688],
      [13.0022, 77.5712],
      [12.9942, 77.5732],
    ],
  },
];

// ── Metro ───────────────────────────────────────────────────────────────────
// Namma Metro's three operating lines. Stations are drawn as small nodes.

export const METRO_LINES = [
  {
    id: "purple",
    name: "Purple Line",
    color: "#a07ce8",
    path: [
      [12.9932, 77.7578], // Whitefield (Kadugodi)
      [12.9856, 77.7372], // ITPL
      [12.9902, 77.7132], // Hoodi
      [13.0058, 77.6782], // KR Puram
      [12.9902, 77.6522], // Baiyappanahalli
      [12.9786, 77.6392], // Indiranagar
      [12.9736, 77.6208], // Trinity
      [12.9752, 77.6022], // MG Road
      [12.9782, 77.5952], // Cubbon Park
      [12.9766, 77.5712], // Majestic
      [12.9702, 77.5392], // Vijayanagar
      [12.9482, 77.5232], // Mysore Road
      [12.9376, 77.5028], // Challaghatta
    ],
    stations: [
      [12.9856, 77.7372, "ITPL"],
      [13.0058, 77.6782, "KR Puram"],
      [12.9786, 77.6392, "Indiranagar"],
      [12.9752, 77.6022, "MG Road"],
      [12.9766, 77.5712, "Majestic"],
    ],
  },
  {
    id: "green",
    name: "Green Line",
    color: "#4fb98a",
    path: [
      [13.0292, 77.5172], // Madavara
      [13.0232, 77.5542], // Yeshwanthpur
      [13.0032, 77.5702], // Malleshwaram
      [12.9766, 77.5712], // Majestic
      [12.9672, 77.5762], // Chickpet
      [12.9502, 77.5732], // National College
      [12.9252, 77.5822], // Jayanagar
      [12.9152, 77.5732], // Banashankari
      [12.9062, 77.5852], // JP Nagar
      [12.8952, 77.5712], // Yelachenahalli
      [12.8792, 77.5562], // Silk Institute
    ],
    stations: [
      [13.0232, 77.5542, "Yeshwanthpur"],
      [13.0032, 77.5702, "Malleshwaram"],
      [12.9252, 77.5822, "Jayanagar"],
      [12.9062, 77.5852, "JP Nagar"],
    ],
  },
  {
    id: "yellow",
    name: "Yellow Line",
    color: "#e3b23c",
    path: [
      [12.9222, 77.5802], // RV Road
      [12.9162, 77.6102], // BTM Layout
      [12.9176, 77.6232], // Central Silk Board
      [12.9112, 77.6392], // HSR Layout
      [12.8988, 77.6212], // Bommanahalli
      [12.8792, 77.6382], // Hosa Road
      [12.8482, 77.6602], // Electronic City
      [12.8132, 77.6802], // Bommasandra
    ],
    stations: [
      [12.9176, 77.6232, "Silk Board"],
      [12.9112, 77.6392, "HSR Layout"],
      [12.8482, 77.6602, "Electronic City"],
    ],
  },
];

// ── Landmarks ───────────────────────────────────────────────────────────────
// Drawn as distinct little structures with permanent labels, to give the map
// orientation cues that aren't startups.

export const LANDMARKS = [
  { id: "vidhana-soudha", name: "Vidhana Soudha", lat: 12.9797, lng: 77.5912, kind: "civic", height: 9 },
  { id: "ub-city", name: "UB City", lat: 12.9718, lng: 77.5960, kind: "tower", height: 15 },
  { id: "bangalore-palace", name: "Bangalore Palace", lat: 12.9987, lng: 77.5921, kind: "civic", height: 6 },
  { id: "majestic", name: "Majestic", lat: 12.9776, lng: 77.5713, kind: "transit", height: 5 },
  { id: "glass-house", name: "Glass House", lat: 12.9507, lng: 77.5848, kind: "civic", height: 4 },
  { id: "itpl", name: "ITPL", lat: 12.9858, lng: 77.7368, kind: "campus", height: 12 },
  { id: "manyata", name: "Manyata Tech Park", lat: 13.0452, lng: 77.6202, kind: "campus", height: 13 },
  { id: "ecoworld", name: "RMZ Ecoworld", lat: 12.9282, lng: 77.6802, kind: "campus", height: 14 },
  { id: "egl", name: "Embassy Golf Links", lat: 12.9602, lng: 77.6472, kind: "campus", height: 10 },
  { id: "bagmane", name: "Bagmane Tech Park", lat: 12.9882, lng: 77.6652, kind: "campus", height: 11 },
  { id: "iisc-main", name: "IISc", lat: 13.0218, lng: 77.5668, kind: "campus", height: 7 },
  { id: "ec-flyover", name: "Electronic City", lat: 12.8562, lng: 77.6578, kind: "campus", height: 9 },
  { id: "kempegowda-airport", name: "→ KIA Airport", lat: 13.1042, lng: 77.5962, kind: "transit", height: 4 },
];

// ── Districts ───────────────────────────────────────────────────────────────
// Procedural building footprints are scattered inside these polygons.
//   density — buildings per square world-unit
//   height  — [min, max] in world units (1 unit ≈ 150 m horizontally, but
//             heights are exaggerated ~4× so the skyline reads at map scale)
//   grid    — true for planned layouts (HSR, Jayanagar), which get aligned
//             rectangular blocks instead of rotated organic ones

export const DISTRICTS = [
  {
    // The connective tissue. Without a low, sparse layer under everything else
    // the named districts read as islands floating in the void — and Bengaluru
    // is the opposite of that: continuous fabric with denser cores in it.
    id: "greater-bengaluru",
    name: "Greater Bengaluru",
    tint: 0x6d7480, // low-rise sprawl: whitewash and weathered concrete
    density: 0.05,
    height: [0.7, 2.1],
    plot: [0.7, 1.5],
    grid: false,
    floor: false,
    ring: [
      [13.0752, 77.5452],
      [13.0702, 77.6402],
      [13.0202, 77.7002],
      [12.9952, 77.7602],
      [12.9602, 77.7752],
      [12.9252, 77.7402],
      [12.9002, 77.7002],
      [12.8602, 77.6802],
      [12.8302, 77.6502],
      [12.8352, 77.5902],
      [12.8702, 77.5452],
      [12.9002, 77.5102],
      [12.9502, 77.5002],
      [13.0102, 77.5052],
      [13.0502, 77.5152],
    ],
  },
  {
    id: "cbd",
    name: "CBD",
    tint: 0x9fb0c8, // commercial glass over colonial stone
    density: 0.42,
    height: [3.5, 11],
    grid: false,
    ring: [
      [12.9902, 77.5852],
      [12.9912, 77.6152],
      [12.9822, 77.6272],
      [12.9682, 77.6222],
      [12.9642, 77.6042],
      [12.9702, 77.5842],
      [12.9822, 77.5802],
    ],
  },
  {
    id: "majestic-oldcity",
    name: "Majestic / Chickpet",
    tint: 0xc99a6a, // old city: terracotta tile and painted plaster
    density: 0.55,
    height: [2.2, 5],
    grid: false,
    ring: [
      [12.9832, 77.5622],
      [12.9842, 77.5802],
      [12.9702, 77.5852],
      [12.9582, 77.5792],
      [12.9612, 77.5642],
      [12.9722, 77.5582],
    ],
  },
  {
    id: "koramangala",
    name: "Koramangala",
    tint: 0xc4a888, // converted bungalows, warm plaster
    density: 0.4,
    height: [2.4, 7],
    grid: true,
    ring: [
      [12.9462, 77.6122],
      [12.9482, 77.6332],
      [12.9372, 77.6392],
      [12.9242, 77.6342],
      [12.9222, 77.6182],
      [12.9332, 77.6092],
    ],
  },
  {
    id: "indiranagar",
    name: "Indiranagar / Domlur",
    tint: 0xc0a98c, // cantonment bungalows
    density: 0.36,
    height: [2.2, 6.5],
    grid: true,
    ring: [
      [12.9852, 77.6282],
      [12.9862, 77.6482],
      [12.9742, 77.6522],
      [12.9582, 77.6462],
      [12.9572, 77.6302],
      [12.9702, 77.6262],
    ],
  },
  {
    id: "hsr",
    name: "HSR Layout",
    tint: 0xb9b3a4, // newer concrete, pale render
    density: 0.38,
    height: [2.2, 6],
    grid: true,
    ring: [
      [12.9242, 77.6322],
      [12.9252, 77.6552],
      [12.9122, 77.6612],
      [12.8992, 77.6532],
      [12.9002, 77.6362],
      [12.9122, 77.6292],
    ],
  },
  {
    id: "sarjapur",
    name: "Sarjapur Road",
    tint: 0xa8b6bd, // gated glass and render
    density: 0.24,
    height: [2.6, 8],
    grid: false,
    ring: [
      [12.9142, 77.6642],
      [12.9152, 77.6892],
      [12.9002, 77.7042],
      [12.8862, 77.6942],
      [12.8892, 77.6712],
      [12.9022, 77.6612],
    ],
  },
  {
    id: "orr-bellandur",
    name: "Bellandur / Kadubeesanahalli",
    tint: 0x7fa6cc, // the glass corridor — bluest massing on the board
    density: 0.3,
    height: [4.5, 16],
    grid: false,
    ring: [
      [12.9482, 77.6822],
      [12.9502, 77.7022],
      [12.9372, 77.7062],
      [12.9222, 77.6942],
      [12.9202, 77.6782],
      [12.9332, 77.6712],
    ],
  },
  {
    id: "marathahalli",
    name: "Marathahalli",
    tint: 0x93aec4, // mixed glass and concrete
    density: 0.32,
    height: [3, 9],
    grid: false,
    ring: [
      [12.9702, 77.6902],
      [12.9722, 77.7112],
      [12.9602, 77.7162],
      [12.9482, 77.7072],
      [12.9492, 77.6912],
      [12.9602, 77.6862],
    ],
  },
  {
    id: "whitefield",
    name: "Whitefield",
    tint: 0x86a8c6, // campus glass
    density: 0.26,
    height: [4, 14],
    grid: false,
    ring: [
      [13.0002, 77.7142],
      [13.0022, 77.7522],
      [12.9862, 77.7622],
      [12.9682, 77.7482],
      [12.9702, 77.7202],
      [12.9852, 77.7102],
    ],
  },
  {
    id: "hebbal-manyata",
    name: "Hebbal / Manyata",
    tint: 0x8aa8c8, // business-park glass
    density: 0.26,
    height: [4, 14],
    grid: false,
    ring: [
      [13.0562, 77.6042],
      [13.0582, 77.6342],
      [13.0442, 77.6402],
      [13.0292, 77.6272],
      [13.0312, 77.6062],
      [13.0442, 77.5992],
    ],
  },
  {
    id: "yeshwanthpur",
    name: "Yeshwanthpur / Malleshwaram",
    tint: 0xbdb09c, // industrial and older residential
    density: 0.34,
    height: [2.4, 7],
    grid: true,
    ring: [
      [13.0342, 77.5402],
      [13.0362, 77.5652],
      [13.0182, 77.5732],
      [13.0022, 77.5632],
      [13.0042, 77.5442],
      [13.0182, 77.5372],
    ],
  },
  {
    id: "jayanagar",
    name: "Jayanagar / JP Nagar",
    tint: 0xc6b294, // planned residential, warm render
    density: 0.4,
    height: [2, 5.5],
    grid: true,
    ring: [
      [12.9422, 77.5682],
      [12.9432, 77.5942],
      [12.9182, 77.6002],
      [12.8962, 77.5922],
      [12.8972, 77.5692],
      [12.9202, 77.5622],
    ],
  },
  {
    id: "banashankari",
    name: "Banashankari",
    tint: 0xc3b498, // planned residential
    density: 0.34,
    height: [2, 5],
    grid: true,
    ring: [
      [12.9322, 77.5442],
      [12.9332, 77.5652],
      [12.9182, 77.5702],
      [12.9022, 77.5622],
      [12.9042, 77.5452],
      [12.9182, 77.5392],
    ],
  },
  {
    id: "electronic-city",
    name: "Electronic City",
    tint: 0x9fb2b8, // tech township: render and glass
    density: 0.28,
    height: [3, 10],
    grid: false,
    ring: [
      [12.8622, 77.6412],
      [12.8642, 77.6742],
      [12.8482, 77.6822],
      [12.8322, 77.6702],
      [12.8342, 77.6462],
      [12.8482, 77.6382],
    ],
  },
  {
    id: "banaswadi",
    name: "Banaswadi / Kalyan Nagar",
    tint: 0xbdb2a0, // dense residential
    density: 0.32,
    height: [2.2, 6],
    grid: false,
    ring: [
      [13.0342, 77.6262],
      [13.0362, 77.6512],
      [13.0202, 77.6572],
      [13.0062, 77.6462],
      [13.0082, 77.6272],
      [13.0222, 77.6212],
    ],
  },
  {
    id: "rajajinagar",
    name: "Rajajinagar / Vijayanagar",
    tint: 0xc4b69c, // planned residential
    density: 0.36,
    height: [2, 5.5],
    grid: true,
    ring: [
      [12.9922, 77.5232],
      [12.9942, 77.5502],
      [12.9782, 77.5572],
      [12.9622, 77.5472],
      [12.9642, 77.5262],
      [12.9782, 77.5182],
    ],
  },
];

/** Every labelled place, for the mini-map + search fallbacks. */
export const PLACE_LABELS = [
  ...LANDMARKS.map((l) => ({ name: l.name, lat: l.lat, lng: l.lng, kind: "landmark" })),
  ...LAKES.filter((l) => l.label).map((l) => ({
    name: l.name,
    ...centroidOf(l.ring),
    kind: "water",
  })),
  ...PARKS.filter((p) => p.label).map((p) => ({
    name: p.name,
    ...centroidOf(p.ring),
    kind: "park",
  })),
];

/** Average of a lat/lng ring — good enough for label anchoring. */
export function centroidOf(ring) {
  let lat = 0;
  let lng = 0;
  for (const [a, b] of ring) {
    lat += a;
    lng += b;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}
