import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import * as blast from './blast.js';

const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value) || 0;

// ---------- scena ----------
// Wszystko liczymy w układzie lokalnym Z-w-górę (jak w Pix4D). Grupa `world` obraca go do osi Y-w-górę Three.js.
const canvas = $('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(1, 2, 1);
scene.add(sun);

const world = new THREE.Group();
world.rotation.x = -Math.PI / 2;
scene.add(world);
const overlay = new THREE.Group(); // otwory, obrys, spąg
world.add(overlay);

const state = {
  model: null,
  center: new THREE.Vector3(),  // środek modelu w jego oryginalnych współrzędnych
  size: new THREE.Vector3(),
  height: null,                 // raster wysokości terenu
  polygon: [],                  // {x,y,z} lokalne
  closed: false,
  grid: [],                     // wygenerowane punkty {x,y,z}
  manual: [],                   // ręczne punkty {x,y,z}
  holes: [],
  skipped: 0,
  mode: 'orbit',
  markerSize: 0.4,
  markers: null,
};

function resize() {
  const v = $('view');
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(v.clientWidth, v.clientHeight, false);
  camera.aspect = v.clientWidth / v.clientHeight;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('view'));
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

const status = (t) => { $('status').textContent = t; };
const zShift = () => state.center.z + num('offZ'); // lokalne Z -> rzeczywista rzędna

// ---------- wczytywanie modelu ----------
async function loadFiles(fileList) {
  const files = [...fileList];
  const objFile = files.find((f) => /\.obj$/i.test(f.name));
  if (!objFile) return status('Nie znaleziono pliku .obj wśród wybranych.');
  status(`Wczytuję ${objFile.name} (${(objFile.size / 1048576).toFixed(1)} MB)…`);
  await new Promise((r) => setTimeout(r)); // pozwól odświeżyć komunikat

  const urls = new Map(files.map((f) => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => urls.get(decodeURIComponent(url.split(/[\\/]/).pop()).toLowerCase()) ?? url);

  const objLoader = new OBJLoader(manager);
  const mtlFile = files.find((f) => /\.mtl$/i.test(f.name));
  if (mtlFile) {
    const mtl = new MTLLoader(manager).setMaterialOptions({ side: THREE.DoubleSide }).parse(await mtlFile.text(), '');
    mtl.preload();
    objLoader.setMaterials(mtl);
  }

  let obj;
  try { obj = objLoader.parse(await objFile.text()); }
  catch (e) { return status('Błąd odczytu OBJ: ' + e.message); }

  let tris = 0;
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!mtlFile) m.material = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, side: THREE.DoubleSide, flatShading: true });
    for (const mat of [].concat(m.material)) mat.side = THREE.DoubleSide;
  });
  if (!tris) return status('Plik OBJ nie zawiera trójkątów.');

  if (state.model) world.remove(state.model);
  const box = new THREE.Box3().setFromObject(obj);
  box.getCenter(state.center);
  box.getSize(state.size);
  obj.position.sub(state.center);
  world.add(obj);
  state.model = obj;
  world.updateMatrixWorld(true);

  state.height = buildHeightField(obj);
  state.markerSize = THREE.MathUtils.clamp(Math.max(state.size.x, state.size.y) / 250, 0.15, 3);
  resetDesign();
  $('floor').value = (box.min.z + 0.1 * state.size.z).toFixed(1);
  frameModel();
  update();
  status(`Model: ${tris.toLocaleString('pl')} trójkątów, ${state.size.x.toFixed(0)} × ${state.size.y.toFixed(0)} × ${state.size.z.toFixed(0)} m. Ustaw tryb „Rysuj obrys”.`);
}

function frameModel() {
  const r = Math.max(state.size.x, state.size.y, state.size.z);
  controls.target.set(0, 0, 0);
  camera.position.set(r * 0.5, r * 0.9, r * 0.9);
  camera.near = r / 1000; camera.far = r * 50;
  camera.updateProjectionMatrix();
}

// ---------- raster wysokości terenu (szybkie próbkowanie Z dla setek otworów) ----------
function forEachTriangle(model, cb) {
  const inv = new THREE.Matrix4().copy(world.matrixWorld).invert();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((m) => {
    if (!m.isMesh) return;
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mat);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mat);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mat);
      cb(a, b, c);
    }
  });
}

function buildHeightField(model) {
  const bb = new THREE.Box3();
  forEachTriangle(model, (a, b, c) => { bb.expandByPoint(a); bb.expandByPoint(b); bb.expandByPoint(c); });
  const cs = Math.max(0.02, Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) / 1200);
  const nx = Math.ceil((bb.max.x - bb.min.x) / cs) + 1, ny = Math.ceil((bb.max.y - bb.min.y) / cs) + 1;
  const z = new Float32Array(nx * ny).fill(NaN);
  const put = (i, j, v) => { if (i >= 0 && j >= 0 && i < nx && j < ny) { const k = j * nx + i; if (!(z[k] >= v)) z[k] = v; } };
  forEachTriangle(model, (a, b, c) => {
    for (const p of [a, b, c]) put(Math.round((p.x - bb.min.x) / cs), Math.round((p.y - bb.min.y) / cs), p.z);
    const i0 = Math.floor((Math.min(a.x, b.x, c.x) - bb.min.x) / cs), i1 = Math.ceil((Math.max(a.x, b.x, c.x) - bb.min.x) / cs);
    const j0 = Math.floor((Math.min(a.y, b.y, c.y) - bb.min.y) / cs), j1 = Math.ceil((Math.max(a.y, b.y, c.y) - bb.min.y) / cs);
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(det) < 1e-12) return;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = bb.min.x + i * cs, py = bb.min.y + j * cs;
      const l1 = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / det;
      const l2 = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) put(i, j, l1 * a.z + l2 * b.z + l3 * c.z);
    }
  });
  return { bb, cs, nx, ny, z };
}

function sampleZ(x, y) {
  const h = state.height;
  if (!h) return null;
  const i = Math.round((x - h.bb.min.x) / h.cs), j = Math.round((y - h.bb.min.y) / h.cs);
  for (let r = 0; r <= 3; r++) { // brakujące komórki: najbliższa z sąsiedztwa
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= h.nx || jj >= h.ny) continue;
      const v = h.z[jj * h.nx + ii];
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

// ---------- projekt ----------
function resetDesign() {
  state.polygon = []; state.closed = false; state.grid = []; state.manual = [];
}

function readParams() {
  const diameter = num('diameter');
  return {
    diameter,
    kgPerM: blast.linearLoad(num('density'), diameter),
    burden: num('burden'), spacing: num('spacing'),
    rowAz: num('rowAz'), edge: num('edge'), stagger: $('stagger').checked,
    floorZ: num('floor') - zShift(), subdrill: num('subdrill'), stemming: num('stemming'),
    incl: num('incl'), inclAz: num('inclAz'),
  };
}

function generate() {
  if (!state.closed) return status('Najpierw narysuj i zamknij obrys (min. 3 punkty).');
  const p = readParams();
  state.grid = blast.generateGrid(state.polygon, {
    burden: p.burden, spacing: p.spacing, rowAzimuthDeg: p.rowAz, stagger: p.stagger, edgeOffset: p.edge,
  }).flatMap((g) => { const z = sampleZ(g.x, g.y); return z === null ? [] : [{ x: g.x, y: g.y, z, row: g.row, u: g.u }]; });
  update();
}

// Przelicza otwory (geometria + ładunek) z bieżących parametrów i odświeża widok.
function update() {
  const p = readParams();
  const src = [...state.grid, ...state.manual];
  state.skipped = 0;
  state.holes = [];
  for (const s of src) {
    const g = blast.holeGeometry({ x: s.x, y: s.y, collarZ: s.z }, { floorZ: p.floorZ, subdrill: p.subdrill, inclDeg: p.incl, azimuthDeg: p.inclAz });
    if (g.benchHeight < 0.3) { state.skipped++; continue; }
    const c = blast.chargeCalc(g.length, { stemming: p.stemming, kgPerM: p.kgPerM });
    state.holes.push({ ref: s, id: state.holes.length + 1, x: s.x, y: s.y, z: s.z, ...g, ...c, volume: p.burden * p.spacing * g.benchHeight, manual: state.manual.includes(s) });
  }
  drawOverlay();
  renderStats();
  renderTable();
}

// ---------- rysowanie nakładki ----------
const disposeGroup = (g) => {
  for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.dispose?.(); }
};

function drawOverlay() {
  disposeGroup(overlay);
  state.markers = null;
  const ms = state.markerSize;
  const lift = ms * 0.3;

  if (state.polygon.length) {
    const pts = state.polygon.map((q) => new THREE.Vector3(q.x, q.y, q.z + lift));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false });
    const line = state.closed ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
    line.renderOrder = 5; overlay.add(line);
    const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(ms * 0.7, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false }), pts.length);
    pts.forEach((v, i) => dots.setMatrixAt(i, new THREE.Matrix4().setPosition(v)));
    dots.renderOrder = 6; overlay.add(dots);
  }

  if ($('showFloor').checked && state.model) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(state.size.x * 1.05, state.size.y * 1.05),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    plane.position.z = readParams().floorZ;
    overlay.add(plane);
  }

  const n = state.holes.length;
  if (!n) return;
  const pos = new Float32Array(n * 12), col = new Float32Array(n * 12);
  const stem = [0.85, 0.85, 0.85], charge = [1, 0.25, 0.1];
  state.holes.forEach((h, i) => {
    const s = { x: h.x + h.dir.x * h.stemming, y: h.y + h.dir.y * h.stemming, z: h.z + h.dir.z * h.stemming };
    pos.set([h.x, h.y, h.z, s.x, s.y, s.z, s.x, s.y, s.z, h.toe.x, h.toe.y, h.toe.z], i * 12);
    col.set([...stem, ...stem, ...charge, ...charge], i * 12);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
  lines.renderOrder = 3; overlay.add(lines);

  const markers = new THREE.InstancedMesh(new THREE.SphereGeometry(ms * 0.6, 10, 8), new THREE.MeshBasicMaterial({ depthTest: false }), n);
  const m4 = new THREE.Matrix4(), color = new THREE.Color();
  state.holes.forEach((h, i) => {
    markers.setMatrixAt(i, m4.setPosition(h.x, h.y, h.z + lift));
    markers.setColorAt(i, color.set(h.manual ? 0xff9f1c : 0x2ec4f1));
  });
  markers.renderOrder = 4; overlay.add(markers);
  state.markers = markers;
}

// ---------- podsumowanie i tabela ----------
const fmt = (v, d = 1) => v.toLocaleString('pl', { minimumFractionDigits: d, maximumFractionDigits: d });

function renderStats() {
  const s = blast.summarize(state.holes, state.closed ? blast.polygonArea(state.polygon) : 0);
  const rows = [
    ['Liczba otworów', String(s.count)],
    ['Metraż wiercenia', `${fmt(s.totalLength)} m`],
    ['Łączny ładunek MW', `${fmt(s.totalMass, 0)} kg`],
    ['Urabiana objętość (B×S×H)', `${fmt(s.volume, 0)} m³`],
    ['Jednostkowe zużycie MW', s.volume ? `${fmt(s.powderFactor, 2)} kg/m³` : '—'],
    ['Wiercenie jednostkowe', s.volume ? `${fmt(s.specificDrilling, 3)} m/m³` : '—'],
    ['Powierzchnia obrysu', s.areaM2 ? `${fmt(s.areaM2, 0)} m²` : '—'],
  ];
  if (state.skipped) rows.push(['Pominięte (poniżej spągu)', String(state.skipped)]);
  $('stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; return [dt, dd];
  }));
}

function realXYZ(h) {
  const z = h.z + zShift();
  return [h.x + state.center.x + num('offX'), h.y + state.center.y + num('offY'), z];
}

function renderTable() {
  const body = $('holes').tBodies[0];
  body.replaceChildren(...state.holes.slice(0, 500).map((h) => {
    const [x, y, z] = realXYZ(h);
    const tr = document.createElement('tr');
    for (const v of [h.id, fmt(x, 2), fmt(y, 2), fmt(z, 2), fmt(h.length), fmt(h.mass, 0)]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    return tr;
  }));
}

function exportCsv() {
  if (!state.holes.length) return status('Brak otworów do eksportu.');
  const head = ['Nr', 'X_collar', 'Y_collar', 'Z_collar', 'X_toe', 'Y_toe', 'Z_toe', 'Dlugosc_m', 'Nachylenie_deg', 'Azymut_deg', 'Orczyk_m', 'Dlugosc_ladunku_m', 'MW_kg', 'Typ'];
  const p = readParams();
  const ox = state.center.x + num('offX'), oy = state.center.y + num('offY');
  const lines = [head.join(',')];
  for (const h of state.holes) {
    const [x, y, z] = realXYZ(h);
    lines.push([h.id, x, y, z, h.toe.x + ox, h.toe.y + oy, h.toe.z + zShift(), h.length, p.incl, p.inclAz, h.stemming, h.chargeLength, h.mass, h.manual ? 'reczny' : 'siatka']
      .map((v) => (typeof v === 'number' ? +v.toFixed(3) : v)).join(','));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'otwory_strzalowe.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- interakcja ----------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(e, target, recursive = true) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObject(target, recursive)[0];
}

let down = null;
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // przeciągnięcie = obrót kamery
  down = null;
  if (state.mode === 'orbit' || !state.model) return;
  if (state.mode === 'del') {
    const hit = state.markers && pick(e, state.markers, false);
    if (hit) {
      const ref = state.holes[hit.instanceId].ref;
      state.grid = state.grid.filter((g) => g !== ref);
      state.manual = state.manual.filter((g) => g !== ref);
      update();
    }
    return;
  }
  const hit = pick(e, state.model);
  if (!hit) return;
  const pt = world.worldToLocal(hit.point.clone());
  if (state.mode === 'poly') {
    if (state.closed) { state.closed = false; state.polygon = []; state.grid = []; }
    state.polygon.push({ x: pt.x, y: pt.y, z: pt.z });
    status(`Obrys: ${state.polygon.length} pkt. ${state.polygon.length >= 3 ? 'Kliknij „Zamknij obrys”.' : ''}`);
  } else if (state.mode === 'hole') {
    state.manual.push({ x: pt.x, y: pt.y, z: pt.z });
  }
  update();
});

function closePolygon() {
  if (state.polygon.length < 3) return status('Obrys wymaga co najmniej 3 punktów.');
  state.closed = true;
  generate();
  status(`Obrys zamknięty, ${blast.polygonArea(state.polygon).toFixed(0)} m². Wygenerowano ${state.holes.length} otworów.`);
}

function setMode(m) {
  state.mode = m;
  $('view').classList.toggle('tool', m !== 'orbit');
}

document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
$('closePoly').onclick = closePolygon;
$('clearPoly').onclick = () => { state.polygon = []; state.closed = false; state.grid = []; update(); };
$('generate').onclick = generate;
$('clearHoles').onclick = () => { state.grid = []; state.manual = []; update(); };
$('export').onclick = exportCsv;
$('suggest').onclick = () => {
  const s = blast.suggestParameters(num('diameter'));
  for (const k of ['burden', 'spacing', 'subdrill', 'stemming']) $(k).value = s[k];
  state.closed ? generate() : update();
  status('Wstawiono wartości orientacyjne (B≈30·Ø, S≈1,15·B, podwiert≈0,3·B, przybitka≈0,7·B). Zweryfikuj je dla swojej skały i MW.');
};
for (const el of document.querySelectorAll('#panel input[type=number], #panel input[type=checkbox]')) {
  el.addEventListener('input', () => (el.hasAttribute('data-regen') && state.closed ? generate() : update()));
}
$('files').addEventListener('change', (e) => loadFiles(e.target.files));
window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.mode === 'poly' && e.target === document.body) closePolygon(); });

const view = $('view');
view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragging'); });
view.addEventListener('dragleave', () => view.classList.remove('dragging'));
view.addEventListener('drop', (e) => { e.preventDefault(); view.classList.remove('dragging'); loadFiles(e.dataTransfer.files); });

renderStats();

// do testów w przeglądarce
window.__app = { state, loadFiles, generate, closePolygon };
