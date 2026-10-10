import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import * as blast from './blast.js';
import { DEFAULT_PRODUCTS, newProductId } from './products.js';
import { buildIredesXml, newPlanId } from './iredes.js';
import { pl2000ToLonLat } from './geo.js';
import { buildProfile, drawProfile } from './profile.js';
import { computeTiming, maxChargeInWindow, groupByTime, autoNetwork } from './network.js';
import { lillyA, kuzRam, retained, passing, pWaveKmS, tMaxMs, timingFactor, scatterFactor, reliefDelay } from './fragmentation.js';
import { BlastViz, timeColor, SIZE_STOPS, sizeColor } from './sim.js';
import { sdob, SDOB_SAFE } from './physics.js';
import { MWD_SETS, buildGeology, drillHole, interpretHole, mwdCsv } from './mwd.js';

const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value) || 0;
const clone = (o) => JSON.parse(JSON.stringify(o));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

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
const overlay = new THREE.Group(); // otwory, obrys, poziomy docelowe
world.add(overlay);

// ---------- stan ----------
const TYPE_NAME = { normal: 'Zwykłe', profile: 'Profilowe' };
const TYPE_FIELDS = { diameter: 'diameter', target: 'targetZ', subdrill: 'subdrill', stemming: 'stemming', incl: 'incl', inclAz: 'inclAz', inhole: 'inholeMs' };
const defaultTemplate = () => [{ kind: 'charge', productId: 'emu-bulk', by: 'rest' }];
const defaultType = () => ({ diameter: 95, targetZ: 0, subdrill: 1.1, stemming: 2.4, incl: 0, inclAz: 0, inholeMs: 500, lenMode: 'toe', fixedLength: 8, gassWait: true, template: defaultTemplate() });

// Zapis szablonu z wcześniejszych wersji (flex) -> obecny (by).
function migrateSeg(seg) {
  if (!seg.by) seg.by = seg.flex ? 'rest' : 'length';
  delete seg.flex;
  if (seg.kind === 'deck' && seg.by === 'mass') seg.by = 'length';
  return seg;
}

function loadProducts() {
  try {
    const saved = JSON.parse(localStorage.getItem('wiercenia.products') ?? 'null');
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* brak dostępu do pamięci przeglądarki */ }
  return clone(DEFAULT_PRODUCTS);
}
function saveProducts() {
  try { localStorage.setItem('wiercenia.products', JSON.stringify(state.products)); } catch { /* ignoruj */ }
}

const state = {
  model: null,
  center: new THREE.Vector3(),  // środek modelu w jego oryginalnych współrzędnych
  size: new THREE.Vector3(),
  height: null,                 // raster wysokości terenu
  polygon: [],                  // {x,y,z} lokalne
  closed: false,
  grid: [],                     // wygenerowane punkty {x,y,z,row,u,type}
  manual: [],                   // ręczne punkty {x,y,z,type}
  holes: [],
  skipped: 0,
  mode: 'orbit',
  markerSize: 0.4,
  markers: null,
  types: { normal: defaultType(), profile: { ...defaultType(), subdrill: 0.5 } },
  editType: 'normal',
  products: loadProducts(),
  profile: null,                // { mode: 'hole', ref } albo { mode: 'line', origin, az }
  profA: null,
  planId: newPlanId(),          // stały identyfikator planu: klucz do danych z wiercenia, ładowania i MWD
  nextHid: 1,                   // licznik trwałych numerów otworów (HoleId), nigdy nie przenumerowywany
  net: { starts: [], links: [], pending: null }, // sieć strzałowa: punkty inicjacji i łączniki (HoleId)
  timing: null, tMinFire: 0, frag: null,
  viz: new BlastViz(scene),     // symulacja: bloczki, rozpad, fizyka
  colorMode: 'type',
};

function resize() {
  const v = $('view');
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(v.clientWidth, v.clientHeight, false);
  camera.aspect = v.clientWidth / v.clientHeight;
  camera.updateProjectionMatrix();
  if (state.profile) renderProfile();
}
new ResizeObserver(resize).observe($('view'));
renderer.setAnimationLoop(() => { controls.update(); frame(); renderer.render(scene, camera); });

const status = (t) => { $('status').textContent = t; };
const zShift = () => state.center.z + num('offZ'); // lokalne Z -> rzeczywista rzędna
const fmt = (v, d = 1) => v.toLocaleString('pl', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------- wczytywanie modelu ----------
async function loadFiles(fileList) {
  const files = [...fileList];
  const offFile = files.find((f) => /\.xyz$/i.test(f.name) && f.size < 4096);
  if (offFile) await applyOffsetFile(offFile);
  const objFile = files.find((f) => /\.obj$/i.test(f.name));
  if (!objFile) return offFile ? undefined : status('Nie znaleziono pliku .obj wśród wybranych.');
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
  state.box = box.clone();
  obj.position.sub(state.center);
  world.add(obj);
  state.model = obj;
  world.updateMatrixWorld(true);

  state.height = buildHeightField(obj);
  state.markerSize = THREE.MathUtils.clamp(Math.max(state.size.x, state.size.y) / 250, 0.15, 3);
  resetDesign();
  $('simMode').value = 'off'; state.viz.clear(); state.viz.mode = 'off'; clock.t = 0; clock.playing = false;
  state.probe = null;
  $('probeOut').textContent = 'Kliknij punkt na modelu, aby zobaczyć jego X, Y, Z.';
  $('ctrlOut').textContent = '';
  const target = +(box.min.z + num('offZ') + 0.1 * state.size.z).toFixed(1);
  state.types.normal.targetZ = state.types.profile.targetZ = target;
  typeToInputs();
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
  state.profile = null; state.profA = null;
  state.planId = newPlanId(); state.nextHid = 1;
  state.net = { starts: [], links: [], pending: null };
  $('xmlPlanId').value = state.planId;
}

const readPattern = () => ({
  burden: num('burden'), spacing: num('spacing'), rowAz: num('rowAz'), edge: num('edge'), stagger: $('stagger').checked,
});

function generate() {
  if (!state.closed) return status('Najpierw narysuj i zamknij obrys (min. 3 punkty).');
  const p = readPattern();
  state.grid = blast.generateGrid(state.polygon, {
    burden: p.burden, spacing: p.spacing, rowAzimuthDeg: p.rowAz, stagger: p.stagger, edgeOffset: p.edge,
  }).flatMap((g) => { const z = sampleZ(g.x, g.y); return z === null ? [] : [{ x: g.x, y: g.y, z, row: g.row, u: g.u, type: 'normal', hid: state.nextHid++ }]; });
  update();
}

// Przelicza otwory (geometria + ładunek) z bieżących parametrów i odświeża widok.
function update() {
  updateExtent();
  showProbe(false);
  const pat = readPattern();
  const zs = zShift();
  state.skipped = 0;
  state.holes = [];
  for (const s of [...state.grid, ...state.manual]) {
    const type = s.type === 'profile' ? 'profile' : 'normal';
    const tp = state.types[type];
    const g = blast.holeGeometry({ x: s.x, y: s.y, collarZ: s.z }, { floorZ: tp.targetZ - zs, subdrill: tp.subdrill, inclDeg: tp.incl, azimuthDeg: tp.inclAz, fixedLength: tp.lenMode === 'fixed' ? tp.fixedLength : null });
    if (g.benchHeight < 0.3) { state.skipped++; continue; }
    const cosI = Math.cos((tp.incl * Math.PI) / 180);
    const c = blast.loadHole(g.length, tp.template, { stemming: tp.stemming, diameterMm: tp.diameter, products: state.products, gassWait: tp.gassWait !== false, depthAtElevation: (elev) => (s.z - (elev - zs)) / cosI });
    s.hid ??= state.nextHid++; // zabezpieczenie dla projektów bez numerów
    const id = s.hid;
    const chargeSegs = c.segments.filter((x) => x.kind === 'charge');
    const bcl = chargeSegs.length ? chargeSegs.at(-1).to - chargeSegs.at(-1).from : 0; // ładunek denny (najgłębszy)
    const seq = state.holes.length + 1;
    const manual = state.manual.includes(s);
    state.holes.push({
      ref: s, id, name: `${manual ? 0 : s.row + 1}.${seq}`, type, manual,
      x: s.x, y: s.y, z: s.z, ...g, ...c, diameter: tp.diameter, targetZ: tp.targetZ, subdrill: tp.subdrill,
      volume: pat.burden * pat.spacing * g.benchHeight, inholeMs: tp.inholeMs ?? 500, bcl,
    });
  }
  updateTiming();
  updateFrag();
  drawOverlay();
  renderStats();
  renderTable();
  renderTplInfo();
  renderNetStats();
  refreshProfileList();
  refreshTimeline();
  if (state.profile) renderProfile();
  queueViz();
}

// ---------- typ otworu: parametry w panelu ----------
function typeToInputs() {
  const t = state.types[state.editType];
  for (const [id, k] of Object.entries(TYPE_FIELDS)) $(id).value = t[k];
  $('lenMode').value = t.lenMode ?? 'toe'; $('fixedLen').value = t.fixedLength ?? 8; $('gassWait').checked = t.gassWait !== false;
  renderToeInfo();
  document.querySelectorAll('#typeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.type === state.editType));
  renderTemplate();
}

function inputsToType() {
  const t = state.types[state.editType];
  for (const [id, k] of Object.entries(TYPE_FIELDS)) t[k] = num(id);
  t.lenMode = $('lenMode').value; t.fixedLength = num('fixedLen'); t.gassWait = $('gassWait').checked;
  renderToeInfo();
}

function renderToeInfo() {
  const t = state.types[state.editType];
  $('fixedLenBox').hidden = t.lenMode !== 'fixed';
  $('toeInfo').textContent = t.lenMode === 'fixed'
    ? `Stała długość ${fmt(t.fixedLength, 2)} m: rzędna dna wynika z rzędnej wlotu i nachylenia.`
    : `Rzędna dna otworu: ${fmt(t.targetZ - t.subdrill, 2)} m n.p.m. (rzędna docelowa − przewiert). Długość zależy od rzędnej wlotu.`;
}

// ---------- szablon ładunku ----------
function renderTemplate() {
  const t = state.types[state.editType];
  const box = $('tplRows');
  box.replaceChildren();
  const redo = () => { renderTemplate(); update(); };
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= t.template.length) return; [t.template[i], t.template[j]] = [t.template[j], t.template[i]]; redo(); };
  const select = (opts, value, onchange, title) => {
    const s = el('select');
    for (const [v, label] of opts) s.append(new Option(label, v, false, v === value));
    s.title = title ?? ''; s.onchange = () => onchange(s.value); return s;
  };
  const field = (value, step, title, set) => {
    const i = el('input');
    i.type = 'number'; i.min = '0'; i.step = step; i.value = value ?? 0; i.title = title;
    i.oninput = () => { set(parseFloat(i.value) || 0); update(); }; return i;
  };
  t.template.forEach((seg, i) => {
    migrateSeg(seg);
    const row = el('div', 'tplrow'), head = el('div', 'tplhead'), body = el('div', 'tplbody');
    const isDeck = seg.kind === 'deck';
    const anchored = isDeck && (seg.anchor === 'depth' || seg.anchor === 'elev');
    if (isDeck) head.append(select([['filler', 'Przesypka'], ['air', 'Air deck']], seg.material === 'air' ? 'air' : 'filler', (v) => { seg.material = v; if (v !== 'air') delete seg.plug; redo(); }, 'Rodzaj: przesypka (materiał obojętny) albo air deck (pusty odcinek powietrzny)'));
    else head.append(el('span', 'k', 'Ładunek'));
    if (!isDeck) head.append(select(state.products.map((p) => [p.id, p.name.replace(/ \(przykład\)/, '')]), seg.productId, (v) => { seg.productId = v; update(); }, 'Produkt z bazy MW'));
    const modes = isDeck
      ? [['length', 'długość'], ['rest', 'reszta']].filter((m) => !(anchored && m[0] === 'rest'))
      : [['rest', 'reszta'], ['length', 'długość'], ['mass', 'masa MW']];
    body.append(select(modes, seg.by, (v) => { seg.by = v; redo(); },
      isDeck ? 'Długość przesypki: zadana albo „reszta” (dopasuje się do zadanej masy MW)' : 'Ładunek: „reszta” wypełnia wolne miejsce (masa MW się dolicza), albo zadajesz długość lub masę'));
    if (seg.by === 'length') body.append(field(seg.length, '0.1', 'Długość [m]', (v) => { seg.length = v; }), el('span', 'k', 'm'));
    if (seg.by === 'mass') body.append(field(seg.mass, '0.5', 'Masa MW [kg]', (v) => { seg.mass = v; }), el('span', 'k', 'kg'));
    if (isDeck) {
      body.append(select([['auto', 'po kolei'], ['depth', 'od wlotu'], ['elev', 'na rzędnej']], anchored ? seg.anchor : 'auto', (v) => {
        const prev = seg.anchor;
        if (v === 'auto') delete seg.anchor;
        else {
          seg.anchor = v;
          if (seg.by === 'rest') { seg.by = 'length'; seg.length ??= 0.5; }
          if (seg.at == null || prev !== v) seg.at = v === 'elev' ? +(t.targetZ + 3).toFixed(1) : 5;
        }
        redo();
      }, 'Położenie przesypki: po poprzednim elemencie, na głębokości od wlotu albo na zadanej rzędnej'));
      if (anchored) body.append(field(seg.at, '0.1', seg.anchor === 'depth' ? 'Głębokość od wlotu [m]' : 'Rzędna [m n.p.m.]', (v) => { seg.at = v; }), el('span', 'k', seg.anchor === 'depth' ? 'm' : 'm n.p.m.'));
    }
    if (isDeck && seg.material === 'air') {
      const lab = el('label', 'flex'), cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!seg.plug; cb.title = 'Wkładka otworowa podtrzymuje materiał nad odcinkiem powietrznym';
      cb.onchange = () => { seg.plug = cb.checked; seg.plugLen ??= 0.3; redo(); };
      lab.append(cb, document.createTextNode('wkładka otworowa'));
      body.append(lab);
      if (seg.plug) body.append(field(seg.plugLen ?? 0.3, '0.05', 'Długość wkładki [m]', (v) => { seg.plugLen = v; }), el('span', 'k', 'm'));
    }
    const tools = el('span', 'tools');
    for (const [txt, fn, ttl] of [['▲', () => move(i, -1), 'W górę'], ['▼', () => move(i, 1), 'W dół'], ['✕', () => { t.template.splice(i, 1); redo(); }, 'Usuń']]) {
      const b = el('button', 'ghost', txt); b.type = 'button'; b.title = ttl; b.onclick = fn; tools.append(b);
    }
    body.append(tools);
    row.append(head, body);
    box.append(row);
  });
  if (!t.template.length) box.append(el('p', 'hint', 'Brak ładunku. Dodaj ładunek lub przesypkę.'));
}

// Otwór typowy dla podglądu szablonu: średni z istniejących albo przykładowy.
function typicalHole(type) {
  const t = state.types[type];
  const hs = state.holes.filter((h) => h.type === type);
  const cosI = Math.cos((t.incl * Math.PI) / 180), zs = zShift();
  if (hs.length) return { L: hs.reduce((s, h) => s + h.length, 0) / hs.length, collarZ: hs.reduce((s, h) => s + h.z, 0) / hs.length, cosI, avg: true };
  const L = t.lenMode === 'fixed' ? t.fixedLength : 8;
  return { L, collarZ: t.targetZ - zs - t.subdrill + L * cosI, cosI, avg: false };
}

function renderTplInfo() {
  const t = state.types[state.editType];
  const { L, collarZ, cosI, avg } = typicalHole(state.editType), zs = zShift();
  const r = blast.loadHole(L, t.template, { stemming: t.stemming, diameterMm: t.diameter, products: state.products, gassWait: t.gassWait !== false, depthAtElevation: (elev) => (collarZ - (elev - zs)) / cosI });
  const name = { stemming: 'przybitka', deck: 'przesypka', air: 'air deck', plug: 'wkładka otworowa', charge: 'MW', empty: 'puste' };
  const lines = r.segments.filter((s) => s.to - s.from > 1e-6).map((s) => {
    const label = s.kind === 'charge' ? state.products.find((p) => p.id === s.productId)?.name.replace(/ \(przykład\)/, '') ?? 'MW' : name[s.kind];
    const rise = s.rise > 0 ? ` (załadunek do ${fmt(s.loadLen, 2)} m kolumny, po spęcznieniu +${fmt(s.rise, 2)} m${s.gassMin ? `, odczekaj ${s.gassMin} min` : ''})` : '';
    const air = s.airAtLoad ? ` (przy zakładaniu korka ${fmt(s.airAtLoad, 2)} m)` : '';
    return `${fmt(s.from, 2)}–${fmt(s.to, 2)} m  ${label}${s.mass ? `: ${fmt(s.mass, 1)} kg` : ''}${rise}${air}`;
  });
  $('tplInfo').textContent = `${TYPE_NAME[state.editType]}, otwór ${fmt(L, 1)} m${avg ? ' (średnia)' : ' (przykład)'}, MW razem ${fmt(r.mass, 1)} kg:\n${lines.join('\n')}${r.warnings.length ? '\n⚠ ' + r.warnings.join('\n⚠ ') : ''}`;
}

// ---------- baza materiałów wybuchowych ----------
function renderDb() {
  const box = $('dbRows');
  box.replaceChildren();
  const field = (label, value, step, set, wide) => {
    const l = el('label', '', label), i = el('input');
    i.type = 'number'; i.step = step; i.min = '0'; i.value = value;
    i.oninput = () => { set(parseFloat(i.value) || 0); saveProducts(); update(); };
    if (wide) l.style.flex = '1 1 90px';
    l.append(i); return l;
  };
  state.products.forEach((p, idx) => {
    const d = el('div', 'prod');
    const name = el('input'); name.type = 'text'; name.value = p.name;
    name.onchange = () => { p.name = name.value; saveProducts(); renderTemplate(); update(); };
    d.append(name);
    const kind = el('select');
    kind.append(new Option('sypki / pompowany', 'bulk', false, p.kind === 'bulk'), new Option('nabojowany', 'cartridge', false, p.kind === 'cartridge'));
    kind.onchange = () => {
      p.kind = kind.value;
      if (p.kind === 'cartridge') Object.assign(p, { cartDia: p.cartDia ?? 32, cartLen: p.cartLen ?? 400, cartMass: p.cartMass ?? 0.4 });
      saveProducts(); renderDb(); update();
    };
    d.append(kind);
    if (p.kind === 'cartridge') {
      d.append(field('Ø naboju [mm]', p.cartDia, '1', (v) => { p.cartDia = v; }), field('Długość [mm]', p.cartLen, '1', (v) => { p.cartLen = v; }), field('Masa [kg]', p.cartMass, '0.01', (v) => { p.cartMass = v; }));
    } else {
      d.append(
        field('Gęstość początkowa [g/cm³]', p.density ?? 1, '0.01', (v) => { p.density = v; }, true),
        field('Gęstość docelowa [g/cm³]', p.densityTarget ?? '', '0.01', (v) => { p.densityTarget = v > 0 ? v : undefined; }, true),
        field('Czas spęcznienia [min]', p.gassMin ?? 0, '1', (v) => { p.gassMin = v; }, true),
      );
    }
    d.append(field('RWS (ANFO = 100)', p.rws ?? 100, '1', (v) => { p.rws = v; }, true));
    const color = el('input'); color.type = 'color'; color.value = p.color ?? '#ff6b3d'; color.title = 'Kolor na widoku';
    color.oninput = () => { p.color = color.value; saveProducts(); update(); };
    const del = el('button', 'ghost', '✕'); del.type = 'button'; del.title = 'Usuń produkt';
    del.onclick = () => {
      const rest = state.products.filter((x) => x !== p);
      for (const t of Object.values(state.types)) for (const s of t.template) if (s.productId === p.id) s.productId = rest[0]?.id ?? '';
      state.products = rest; saveProducts(); renderDb(); renderTemplate(); update();
    };
    d.append(color, del);
    box.append(d);
  });
}

// ---------- rysowanie nakładki ----------
const disposeGroup = (g) => {
  for (const o of [...g.children]) { g.remove(o); o.geometry?.dispose(); o.material?.dispose?.(); }
};

function profileSpec() {
  const p = state.profile;
  if (!p) return null;
  const half = num('profHalf') || 12;
  if (p.mode === 'hole') {
    const h = state.holes.find((x) => x.ref === p.ref);
    if (!h) return null;
    const tp = state.types[h.type];
    return { origin: { x: h.x, y: h.y }, az: tp.incl > 0.5 ? tp.inclAz : (num('rowAz') + 90) % 360, half };
  }
  return { origin: p.origin, az: p.az, half };
}

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
    const zs = zShift();
    const levels = [['normal', 0x3b82f6]];
    if (Math.abs(state.types.profile.targetZ - state.types.normal.targetZ) > 1e-6) levels.push(['profile', 0x7bd88f]);
    for (const [k, color] of levels) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(state.size.x * 1.05, state.size.y * 1.05),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      plane.position.z = state.types[k].targetZ - zs;
      overlay.add(plane);
    }
  }

  const spec = profileSpec();
  if (spec) { // linia przekroju na widoku 3D
    const az = (spec.az * Math.PI) / 180, ux = Math.sin(az), uy = Math.cos(az), pts = [];
    for (let s = -spec.half; s <= spec.half + 1e-9; s += Math.max(0.5, spec.half / 24)) {
      const x = spec.origin.x + ux * s, y = spec.origin.y + uy * s, z = sampleZ(x, y);
      if (z !== null) pts.push(new THREE.Vector3(x, y, z + lift));
    }
    if (pts.length > 1) {
      const pl = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: false }));
      pl.renderOrder = 8; overlay.add(pl);
    }
  }
  if (state.profA) {
    const mk = new THREE.Mesh(new THREE.SphereGeometry(ms, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff9f1c, depthTest: false }));
    mk.position.set(state.profA.x, state.profA.y, state.profA.z); mk.renderOrder = 8; overlay.add(mk);
  }

  if (state.probe) {
    const mk = new THREE.Mesh(new THREE.SphereGeometry(ms * 1.1, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff2bd6, depthTest: false }));
    mk.position.set(state.probe.x, state.probe.y, state.probe.z);
    mk.renderOrder = 7; overlay.add(mk);
  }

  const n = state.holes.length;
  if (!n) return;
  const pc = Object.fromEntries(state.products.map((p) => [p.id, new THREE.Color(p.color ?? '#ff6b3d')]));
  const kindColor = { stemming: new THREE.Color(0xd9d9d9), deck: new THREE.Color(0xa1887f), air: new THREE.Color(0x7dd3fc), plug: new THREE.Color(0xffffff), empty: new THREE.Color(0x475569) };
  const pos = [], col = [];
  for (const h of state.holes) {
    for (const sg of h.segments) {
      const c = sg.kind === 'charge' ? pc[sg.productId] ?? new THREE.Color(0xff6b3d) : kindColor[sg.kind];
      pos.push(h.x + h.dir.x * sg.from, h.y + h.dir.y * sg.from, h.z + h.dir.z * sg.from, h.x + h.dir.x * sg.to, h.y + h.dir.y * sg.to, h.z + h.dir.z * sg.to);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  // w trybach symulacji kolumny ładunków są przyciemnione, żeby nie zasłaniały bloczków
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: simActive() ? 0.22 : 1 }));
  lines.renderOrder = 3; overlay.add(lines);

  const markers = new THREE.InstancedMesh(new THREE.SphereGeometry(ms * 0.6, 10, 8), new THREE.MeshBasicMaterial({ depthTest: false }), n);
  const m4 = new THREE.Matrix4(), color = new THREE.Color();
  state.holes.forEach((h, i) => {
    markers.setMatrixAt(i, m4.setPosition(h.x, h.y, h.z + lift));
    markers.setColorAt(i, holeColor(h, color));
  });
  markers.renderOrder = 4; overlay.add(markers);
  state.markers = markers;

  // sieć strzałowa: łączniki (ze strzałkami), punkty inicjacji, otwór wybrany do łączenia
  const byId = new Map(state.holes.map((h) => [h.id, h]));
  const lp = [];
  for (const l of state.net.links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const z0 = a.z + lift * 1.6, z1 = b.z + lift * 1.6, tx = a.x + dx * 0.62, ty = a.y + dy * 0.62, tz = z0 + (z1 - z0) * 0.62, w = ms * 1.4;
    lp.push(a.x, a.y, z0, b.x, b.y, z1);
    for (const sgn of [1, -1]) { // grot strzałki
      const c = Math.cos(0.5), sn = Math.sin(0.5) * sgn;
      lp.push(tx, ty, tz, tx - w * (ux * c - uy * sn), ty - w * (uy * c + ux * sn), tz);
    }
  }
  if (lp.length) {
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
    const nl = new THREE.LineSegments(ng, new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: false }));
    nl.renderOrder = 6; overlay.add(nl);
  }
  const ring = (h, color, k) => {
    const mk = new THREE.Mesh(new THREE.SphereGeometry(ms * k, 12, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
    mk.position.set(h.x, h.y, h.z + lift); mk.renderOrder = 7; overlay.add(mk);
  };
  for (const id of state.net.starts) { const h = byId.get(id); if (h) ring(h, 0xffd400, 1.15); }
  if (state.net.pending != null) { const h = byId.get(state.net.pending); if (h) ring(h, 0xffffff, 1.0); }
}

// ---------- podsumowanie i tabela ----------
function renderStats() {
  const s = blast.summarize(state.holes, state.closed ? blast.polygonArea(state.polygon) : 0);
  const nProfile = state.holes.filter((h) => h.type === 'profile').length;
  const sd = holeSdobs();
  const kg = {};
  for (const h of state.holes) for (const [id, m] of Object.entries(h.byProduct)) kg[id] = (kg[id] ?? 0) + m;
  const rows = [
    ['Liczba otworów (zwykłe / profilowe)', `${s.count - nProfile} / ${nProfile}`],
    ['Metraż wiercenia', `${fmt(s.totalLength)} m`],
    ['Łączny ładunek MW', `${fmt(s.totalMass, 0)} kg`],
    ...Object.entries(kg).map(([id, m]) => [`  ${state.products.find((p) => p.id === id)?.name ?? id}`, `${fmt(m, 0)} kg`]),
    ...(state.holes.some((h) => h.plugs) ? [['Wkładki otworowe', `${state.holes.reduce((s, h) => s + h.plugs, 0)} szt.`]] : []),
    ...(state.holes.some((h) => h.airLength) ? [['Air deck (łączna długość)', `${fmt(state.holes.reduce((s, h) => s + h.airLength, 0), 1)} m`]] : []),
    ...(state.holes.some((h) => h.maxRise > 0) ? [['Największe podniesienie kolumny emulsji', `${fmt(Math.max(...state.holes.map((h) => h.maxRise)), 2)} m`]] : []),
    ...(sd.length ? [['SDoB min (przybitka)', `${fmt(Math.min(...sd), 2)} m/kg^⅓${Math.min(...sd) < 0.92 ? ' ⚠ ryzyko wyrzutu w górę' : ''}`]] : []),
    ['Urabiana objętość (B×S×H)', `${fmt(s.volume, 0)} m³`],
    ['Jednostkowe zużycie MW', s.volume ? `${fmt(s.powderFactor, 2)} kg/m³` : '—'],
    ['Wiercenie jednostkowe', s.volume ? `${fmt(s.specificDrilling, 3)} m/m³` : '—'],
    ...(state.netSummary ? [['Czas całego strzału', `${fmt(state.netSummary.span, 0)} ms`], [`Maks. ładunek w oknie ${state.netSummary.window} ms`, `${fmt(state.netSummary.maxQ, 0)} kg`]] : []),
    ...(state.frag ? [['Fragmentacja X50 / nadgabaryt', `${fmt(state.frag.x50, 0)} cm / ${fmt(state.frag.oversizePct, 1)}%`]] : []),
    ['Powierzchnia obrysu', s.areaM2 ? `${fmt(s.areaM2, 0)} m²` : '—'],
  ];
  const warned = state.holes.filter((h) => h.warnings.length).length;
  if (warned) rows.push(['Otwory z ostrzeżeniem ładunku', String(warned)]);
  if (state.skipped) rows.push(['Pominięte (poniżej rzędnej docelowej)', String(state.skipped)]);
  $('stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; return [dt, dd];
  }));
}

function realXYZ(h) {
  return [h.x + state.center.x + num('offX'), h.y + state.center.y + num('offY'), h.z + zShift()];
}

function renderTable() {
  const body = $('holes').tBodies[0];
  body.replaceChildren(...state.holes.slice(0, 500).map((h) => {
    const [x, y, z] = realXYZ(h);
    const tr = document.createElement('tr');
    for (const v of [h.name, h.type === 'profile' ? 'P' : 'Z', fmt(x, 2), fmt(y, 2), fmt(z, 2), fmt(h.length), fmt(h.mass, 0), h.tFire == null ? '—' : fmt(h.tFire, 0)]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    return tr;
  }));
}

// ---------- okno z danymi (CSV, XML, projekt) ----------
function showData(title, text, { filename, mime = 'text/plain', canLoad = false } = {}) {
  $('dataTitle').textContent = title;
  $('dataText').value = text;
  $('dataText').readOnly = !canLoad;
  $('dataLoad').hidden = !canLoad;
  $('databox').hidden = false;
  if (filename) { // w środowiskach blokujących pobieranie zostaje tekst do skopiowania
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

async function copyData() {
  const t = $('dataText');
  try { await navigator.clipboard.writeText(t.value); status('Skopiowano do schowka.'); }
  catch { t.select(); status('Zaznaczono tekst. Skopiuj go ręcznie.'); }
}

function exportCsv() {
  if (!state.holes.length) return status('Brak otworów do eksportu.');
  const head = ['PlanId', 'HoleId', 'Nazwa', 'Typ', 'E_collar', 'N_collar', 'Z_collar', 'E_toe', 'N_toe', 'Z_toe', 'Dlugosc_m', 'Srednica_mm', 'Rzedna_docelowa', 'Przewiert_m', 'Nachylenie_deg', 'Azymut_deg', 'Przybitka_m', 'Dlugosc_ladunku_m', 'MW_kg', 'Ladunek_opis', 'Zrodlo', 'Opoznienie_w_otworze_ms', 'Czas_odpalenia_ms', 'Sygnal_od_HoleId'];
  const ox = state.center.x + num('offX'), oy = state.center.y + num('offY');
  const lines = [head.join(',')];
  for (const h of state.holes) {
    const [x, y, z] = realXYZ(h);
    const tp = state.types[h.type];
    const desc = h.segments.filter((s) => s.kind !== 'empty').map((s) => {
      const len = fmt(s.to - s.from, 2).replace(',', '.');
      if (s.kind === 'stemming') return `przybitka ${len} m`;
      if (s.kind === 'deck') return `przesypka ${len} m`;
      if (s.kind === 'air') return `air deck ${len} m${s.airAtLoad ? ` (przy korku ${fmt(s.airAtLoad, 2).replace(',', '.')} m)` : ''}`;
      if (s.kind === 'plug') return `wkladka otworowa ${len} m`;
      return `${state.products.find((p) => p.id === s.productId)?.name ?? s.productId} ${len} m ${fmt(s.mass, 1).replace(',', '.')} kg${s.rise > 0 ? ` (zaladunek do ${fmt(s.loadLen, 2).replace(',', '.')} m, wzrost ${fmt(s.rise, 2).replace(',', '.')} m)` : ''}`;
    }).join('; ').replaceAll(',', ' ');
    lines.push([state.planId, h.id, h.name, h.type === 'profile' ? 'profilowy' : 'zwykly', x, y, z, h.toe.x + ox, h.toe.y + oy, h.toe.z + zShift(), h.length, h.diameter, h.targetZ, h.subdrill, tp.incl, tp.inclAz, h.stemming, h.chargeLength, h.mass, desc, h.manual ? 'reczny' : 'siatka', h.inholeMs, h.tFire ?? '', state.net.links.find((l) => l.to === h.id)?.from ?? (state.net.starts.includes(h.id) ? 'start' : '')]
      .map((v) => (typeof v === 'number' ? +v.toFixed(3) : v)).join(','));
  }
  showData('Eksport CSV (E = X, N = Y, układ jak w modelu z offsetem)', lines.join('\n'), { filename: 'otwory_strzalowe.csv', mime: 'text/csv' });
  status('Eksport gotowy: pobrano plik CSV albo skopiuj tekst poniżej.');
}

function exportXml() {
  if (!state.holes.length) return status('Brak otworów do eksportu.');
  const ox = state.center.x + num('offX'), oy = state.center.y + num('offY'), oz = zShift();
  const holes = state.holes.map((h) => ({
    id: h.id, name: h.name,
    start: { n: h.y + oy, e: h.x + ox, z: h.z + oz },
    end: { n: h.toe.y + oy, e: h.toe.x + ox, z: h.toe.z + oz },
    type: $(h.type === 'profile' ? 'xmlTypeProfile' : 'xmlTypeNormal').value,
    dia: h.diameter,
  }));
  const mean = (f) => holes.reduce((s, h) => s + f(h), 0) / holes.length;
  const n = mean((h) => h.start.n), e = mean((h) => h.start.e), alt = mean((h) => h.start.z);
  const ll = pl2000ToLonLat(n, e);
  const rowAz = num('rowAz') % 360;
  const xml = buildIredesXml({
    planId: state.planId, planName: $('xmlName').value || 'Plan', project: $('xmlProject').value, comment: $('xmlComment').value,
    coordSystem: $('xmlCrs').value, bearing: rowAz > 180 ? rowAz - 360 : rowAz,
    workOrder: ll ? { ...ll, alt } : null, holes, checksum: $('xmlChk').checked,
  });
  const fname = ($('xmlName').value || 'plan').replace(/[^\w.-]+/g, '_') + '_iredes.xml';
  showData(`Plan wierceń IREDES, PlanId ${state.planId} (${holes.length} otworów, kolejność N, E, H)`, xml, { filename: fname, mime: 'application/xml' });
  status(ll ? 'Plan XML gotowy: pobrano plik albo skopiuj tekst poniżej.' : 'Plan XML gotowy. Współrzędne poza PL-2000: pole WorkOrder zostało puste.');
}

// ---------- zapis i odczyt projektu ----------
const realOf = (p) => [p.x + state.center.x + num('offX'), p.y + state.center.y + num('offY'), p.z + zShift()];
const localOf = (p) => ({ ...p, x: p.x - state.center.x - num('offX'), y: p.y - state.center.y - num('offY'), z: p.z - zShift() });

const UI_IDS = ['netConn', 'delayWindow', 'autoPattern', 'autoAlong', 'autoBetween', 'surfaceCat', 'inholeCat', 'colorMode', 'blkSize', 'maxBlocks', 'simAz', 'simPower', 'simRelief', 'simCrater', 'volBase', 'surround', 'rmd', 'jps', 'jpa', 'rockRho', 'rockE', 'rockNu', 'rockUcs', 'rockA', 'drillSd', 'oversize', 'detScatter', 'useTiming', 'simKrm', 'mwdWapien', 'mwdZwiezla', 'mwdClay', 'simColor'];

function projectToJson() {
  const R = (p) => { const [x, y, z] = realOf(p); return { ...p, x, y, z }; };
  return JSON.stringify({
    app: 'projekt-wiercen', version: 1, savedAt: new Date().toISOString(), planId: state.planId, nextHid: state.nextHid,
    offset: { x: num('offX'), y: num('offY'), z: num('offZ') },
    modelCenter: realOf({ x: 0, y: 0, z: 0 }),
    pattern: readPattern(), types: state.types, editType: state.editType, products: state.products,
    net: { starts: state.net.starts, links: state.net.links }, ui: Object.fromEntries(UI_IDS.map((k) => [k, $(k).type === 'checkbox' ? $(k).checked : $(k).value])),
    polygon: state.polygon.map(R), closed: state.closed, grid: state.grid.map(R), manual: state.manual.map(R),
    xml: Object.fromEntries(['xmlName', 'xmlProject', 'xmlCrs', 'xmlComment', 'xmlTypeNormal', 'xmlTypeProfile'].map((k) => [k, $(k).value])),
  }, null, 2);
}

function loadProjectFromText(text) {
  let d;
  try { d = JSON.parse(text); } catch { return status('To nie jest poprawny plik projektu (JSON).'); }
  if (d?.app !== 'projekt-wiercen') return status('To nie jest plik projektu z tej aplikacji.');
  if (!state.model) return status('Najpierw wczytaj model OBJ, a potem projekt.');
  $('offX').value = d.offset.x; $('offY').value = d.offset.y; $('offZ').value = d.offset.z;
  prevOffZ = d.offset.z;
  for (const k of ['normal', 'profile']) state.types[k] = { ...defaultType(), ...d.types?.[k], template: (d.types?.[k]?.template ?? defaultTemplate()).map(migrateSeg) };
  state.editType = d.editType === 'profile' ? 'profile' : 'normal';
  if (Array.isArray(d.products) && d.products.length) { state.products = d.products; saveProducts(); }
  for (const [k, v] of Object.entries(d.pattern ?? {})) { const e = $(k === 'stagger' ? 'stagger' : k); if (e) { if (k === 'stagger') e.checked = v; else e.value = v; } }
  for (const [k, v] of Object.entries(d.xml ?? {})) if ($(k)) $(k).value = v;
  state.polygon = (d.polygon ?? []).map(localOf);
  state.closed = !!d.closed;
  state.grid = (d.grid ?? []).map(localOf);
  state.manual = (d.manual ?? []).map(localOf);
  state.profile = null; state.profA = null;
  state.net = { starts: d.net?.starts ?? [], links: d.net?.links ?? [], pending: null };
  for (const [k, v] of Object.entries(d.ui ?? {})) if ($(k) && v != null) { if ($(k).type === 'checkbox') $(k).checked = v === true; else $(k).value = v; }
  state.colorMode = $('colorMode').value; refreshCatalogs();
  state.planId = d.planId || newPlanId();
  state.nextHid = Math.max(d.nextHid ?? 1, 1 + Math.max(0, ...[...state.grid, ...state.manual].map((s) => s.hid ?? 0)));
  $('xmlPlanId').value = state.planId;
  const [cx, cy, cz] = d.modelCenter ?? [];
  const here = realOf({ x: 0, y: 0, z: 0 });
  const dist = Math.hypot(here[0] - cx, here[1] - cy, here[2] - cz);
  typeToInputs(); renderDb(); update();
  $('databox').hidden = true;
  status(dist > 1 ? `Wczytano projekt, ale model różni się od zapisanego o ${fmt(dist, 1)} m. Sprawdź, czy to ten sam OBJ i offset.` : `Wczytano projekt: ${state.holes.length} otworów.`);
}

// ---------- profil ----------
function refreshProfileList() {
  const sel = $('profHole');
  const cur = state.profile?.mode === 'hole' ? state.holes.find((h) => h.ref === state.profile.ref)?.id : null;
  sel.replaceChildren();
  const prof = state.holes.filter((h) => h.type === 'profile');
  if (state.profile?.mode === 'line') sel.append(new Option('Własna linia', '', false, true));
  if (!prof.length && !sel.options.length) sel.append(new Option('Brak otworów profilowych', ''));
  for (const h of prof) sel.append(new Option(`Otwór ${h.name}`, String(h.id), false, h.id === cur));
  if (cur && !prof.some((h) => h.id === cur)) { const h = state.holes.find((x) => x.id === cur); if (h) sel.append(new Option(`Otwór ${h.name}`, String(h.id), false, true)); }
}

function openProfileForHole(h) {
  state.profile = { mode: 'hole', ref: h.ref };
  update();
}

function renderProfile() {
  const spec = profileSpec();
  if (!spec) { $('profile').hidden = true; $('view').classList.remove('hasProfile'); return; }
  $('profile').hidden = false;
  $('view').classList.add('hasProfile');
  const zs = zShift();
  const data = buildProfile({
    origin: spec.origin, azimuthDeg: spec.az, half: spec.half, band: num('profBand') || 1,
    holes: state.holes, sampleZ,
    targets: { normal: state.types.normal.targetZ - zs, profile: state.types.profile.targetZ - zs },
  });
  drawProfile($('profCanvas'), data, { zOffset: zs, colors: Object.fromEntries(state.products.map((p) => [p.id, p.color])) });
  $('profInfo').textContent = `Azymut przekroju ${fmt(spec.az, 0)}°, otworów w paśmie: ${data.holes.length}.` +
    (data.take ? ` Zabiór (w zakresie otworów): szerokość ${fmt(data.take.width, 1)} m, pole przekroju ${fmt(data.take.area, 1)} m² nad rzędną docelową zwykłych.` : '');
  state.profileData = data;
}

function closeProfile() {
  state.profile = null; state.profA = null;
  $('profile').hidden = true; $('view').classList.remove('hasProfile');
  update();
}


// ---------- sieć strzałowa: czasy odpalenia ----------
function updateTiming() {
  const ids = state.holes.map((h) => h.id);
  const byId = new Map(state.holes.map((h) => [h.id, h]));
  state.timing = computeTiming(ids, state.net.links, state.net.starts, (id) => byId.get(id).inholeMs);
  for (const h of state.holes) h.tFire = state.timing.time.get(h.id) ?? null;
  const times = [...state.timing.time.values()];
  state.tMinFire = times.length ? Math.min(...times) : 0;
  state.netSummary = null;
  if (times.length) {
    const windowMs = num('delayWindow') || 0;
    const items = state.holes.filter((h) => h.tFire != null).map((h) => ({ t: h.tFire, mass: h.mass }));
    const mq = maxChargeInWindow(items, windowMs);
    state.netSummary = { span: state.timing.totalMs - state.tMinFire, maxQ: mq.mass, at: mq.at, window: windowMs, groups: groupByTime(items) };
  }
}

function prepCanvas(cv, hPx) {
  const w = cv.clientWidth;
  if (!w) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  cv.style.height = hPx + 'px'; cv.width = Math.round(w * dpr); cv.height = Math.round(hPx * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#14171c'; g.fillRect(0, 0, w, hPx);
  return { g, w, h: hPx };
}

function renderNetStats() {
  const net = state.net, t = state.timing, ns = state.netSummary;
  const rows = [
    ['Połączenia / punkty inicjacji', `${net.links.length} / ${net.starts.length}`],
    ['Otwory z czasem odpalenia', `${t ? t.time.size : 0} z ${state.holes.length}`],
  ];
  if (ns) rows.push(['Czas od pierwszego do ostatniego', `${fmt(ns.span, 0)} ms`], ['Liczba różnych opóźnień', String(ns.groups.length)], [`Maks. ładunek w oknie ${ns.window} ms`, `${fmt(ns.maxQ, 1)} kg (od ${fmt(ns.at, 0)} ms)`]);
  $('netStats').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
  const bad = t ? t.unreachable.length : 0;
  $('netWarn').textContent = !state.holes.length ? '' : !net.starts.length ? 'Ustaw punkt inicjacji (tryb „Punkt inicjacji”) i połącz otwory, albo użyj sieci automatycznej.' : bad ? `⚠ ${bad} otworów nie ma drogi sygnału od punktu inicjacji.` : '';
  drawDelayChart();
}

function drawDelayChart() {
  const c = prepCanvas($('delayChart'), 130);
  if (!c) return;
  const { g, w, h } = c, ns = state.netSummary;
  g.font = '11px system-ui'; g.fillStyle = '#8b95a3';
  if (!ns) { g.fillText('Brak czasów odpalenia. Połącz otwory i ustaw punkt inicjacji.', 10, 24); return; }
  const groups = ns.groups, mL = 44, mR = 8, mT = 8, mB = 22;
  const t0 = groups[0].t, t1 = groups.at(-1).t, span = Math.max(t1 - t0, 1), qMax = Math.max(...groups.map((x) => x.mass)) * 1.1;
  const X = (t) => mL + ((t - t0) / span) * (w - mL - mR - 6) + 3, Y = (q) => h - mB - (q / qMax) * (h - mT - mB);
  g.strokeStyle = '#2c333d'; g.textAlign = 'right';
  for (let k = 0; k <= 3; k++) { const q = (qMax * k) / 3; g.beginPath(); g.moveTo(mL, Y(q)); g.lineTo(w - mR, Y(q)); g.stroke(); g.fillText(fmt(q, 0), mL - 4, Y(q) + 4); }
  g.textAlign = 'center';
  for (let k = 0; k <= 4; k++) g.fillText(fmt(t0 + (span * k) / 4, 0), mL + 3 + ((w - mL - mR - 6) * k) / 4, h - 6);
  const bw = Math.max(2, Math.min(10, (w - mL - mR) / Math.max(groups.length, 1) - 1));
  for (const gr of groups) {
    const inMax = gr.t >= ns.at && gr.t <= ns.at + ns.window;
    g.fillStyle = inMax ? '#ff9f1c' : '#2ec4f1';
    g.fillRect(X(gr.t) - bw / 2, Y(gr.mass), bw, h - mB - Y(gr.mass));
  }
  g.fillStyle = '#8b95a3'; g.textAlign = 'left'; g.fillText('kg na opóźnienie / czas [ms]', mL + 4, 14);
}

// ---------- kolory otworów i odtwarzanie ----------
const clock = { t: 0, playing: false };
const simActive = () => state.viz.ready && state.viz.mode !== 'off';
const tMaxNow = () => (simActive() ? state.viz.tMax : (state.timing?.totalMs ?? 0) + 600);

function holeColor(h, c) {
  if (state.colorMode === 'time' || simActive()) {
    if (h.tFire == null) return c.setRGB(0.4, 0.4, 0.42);
    if ((clock.playing || clock.t > 0) && h.tFire <= clock.t) { // odpalony: rozbłysk, potem „wypalony”
      const fl = Math.max(0, 1 - (clock.t - h.tFire) / 250);
      return c.setRGB(0.3 + 0.7 * fl, 0.16 + 0.64 * fl, 0.1 + 0.4 * fl);
    }
    const total = state.timing?.totalMs ?? 0;
    return timeColor(total > state.tMinFire ? (h.tFire - state.tMinFire) / (total - state.tMinFire) : 0, c);
  }
  return c.set(h.type === 'profile' ? 0x7bd88f : 0x2ec4f1);
}

function applyHoleColors() {
  if (!state.markers) return;
  const c = new THREE.Color();
  state.holes.forEach((h, i) => state.markers.setColorAt(i, holeColor(h, c)));
  if (state.markers.instanceColor) state.markers.instanceColor.needsUpdate = true;
}

function refreshTimeline() {
  const show = simActive() || (state.colorMode === 'time' && state.timing?.time.size > 0);
  $('timeline').hidden = !show;
  $('tlSlider').disabled = simActive() && state.viz.mode === 'phys';
  updateTimelineUi();
}

function updateTimelineUi() {
  const t = simActive() ? state.viz.t : clock.t, tm = Math.max(tMaxNow(), 1);
  $('tlSlider').value = Math.round((t / tm) * 1000);
  $('tlTime').textContent = `${fmt(t, 0)} ms`;
  $('tlPlay').textContent = (simActive() ? state.viz.playing : clock.playing) ? '⏸' : '▶';
}

let lastFrame = performance.now();
function frame() {
  const now = performance.now(), dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  let changed = false;
  if (simActive()) {
    state.viz.speed = parseFloat($('tlSpeed').value);
    changed = state.viz.tick(dt);
    clock.t = state.viz.t; clock.playing = state.viz.playing;
  } else if (clock.playing) {
    clock.t = Math.min(clock.t + dt * 1000 * parseFloat($('tlSpeed').value), tMaxNow());
    if (clock.t >= tMaxNow()) clock.playing = false;
    changed = true;
  }
  if (changed) { applyHoleColors(); updateTimelineUi(); }
}

// ---------- fragmentacja (Kuz-Ram) ----------
// ---------- MWD (syntetyczne) ----------
function mwdSet() { return $('mwdWapien').checked ? 'wapien' : $('mwdZwiezla').checked ? 'zwiezla' : null; }
// Wierci wszystkie otwory przez geologię wybranego zestawu (punkt odniesienia: środek obrysu, żeby warstwy przechodziły przez strzał).
function ensureMwd() {
  const set = mwdSet();
  if (!set || !state.holes.length) { state.mwd = null; return null; }
  const key = set + ($('mwdClay').checked ? '+clay' : '') + '|' + state.holes.map((h) => `${h.id}:${h.x.toFixed(2)},${h.y.toFixed(2)},${h.z.toFixed(2)},${h.length.toFixed(2)}`).join(';');
  if (state.mwd?.key === key) return state.mwd;
  const P = state.polygon.length ? state.polygon : state.holes;
  const origin = { x: P.reduce((s, p) => s + p.x, 0) / P.length, y: P.reduce((s, p) => s + p.y, 0) / P.length, z: state.holes.reduce((s, h) => s + h.z, 0) / state.holes.length };
  const faceAz = state.viz?.az ?? 90;
  // przekładka gliny 2 m w połowie wysokości ściany w trzech skrajnych lewych otworach 1. szeregu (patrząc na ścianę od czoła: lewo = −Y)
  let clayLens = null, clayHoles = [];
  if (set === 'wapien' && $('mwdClay').checked) {
    clayHoles = state.holes.filter((h) => h.ref?.row === 0).sort((p, q) => p.y - q.y).slice(0, 3);
    if (clayHoles.length) {
      const zc = clayHoles.reduce((s, h) => s + (h.z + h.toe.z) / 2, 0) / clayHoles.length;
      clayLens = { pts: clayHoles.map((h) => ({ x: h.x, y: h.y })), zc, half: 1.0, reach: 2.6 };
    }
  }
  const geo = buildGeology(set, { origin, faceAz, clayLens });
  const holes = state.holes.map((h) => {
    const samples = drillHole(geo, h, { seed: h.id });
    return { h, samples, it: interpretHole(samples, { density: geo.density }) };
  });
  const all = holes.flatMap((x) => Array.from(x.it.A)), allU = holes.flatMap((x) => Array.from(x.it.ucs));
  const mean = (v) => v.reduce((s, q) => s + q, 0) / Math.max(1, v.length);
  state.mwd = { key, set, geo, clayLens, clayHoles: clayHoles.map((h) => h.name), holes, meanA: mean(all), minA: Math.min(...all), maxA: Math.max(...all), meanUcs: mean(allU), perM: mean(holes.map((x) => x.it.perM)) };
  return state.mwd;
}
// Właściwości w punkcie z najbliższego otworu (w poziomie) na odpowiadającej głębokości.
function mwdField(x, y, z) {
  const m = state.mwd;
  if (!m) return null;
  let best = null, bd = Infinity;
  for (const o of m.holes) { const d = (o.h.x - x) ** 2 + (o.h.y - y) ** 2; if (d < bd) { bd = d; best = o; } }
  const h = best.h, dir = h.dir ?? { x: 0, y: 0, z: -1 };
  const d = (x - h.x) * dir.x + (y - h.y) * dir.y + (z - h.z) * dir.z;
  const i = Math.min(best.samples.length - 1, Math.max(0, Math.round(d / 0.1)));
  // glina: z interpretacji MWD w najbliższym otworze albo z soczewki (bloczki przy ścianie między otworami)
  const clay = best.it.clay[i] || (m.clayLens && m.geo.props(x, y, z, h.z).type === 'clay');
  // skała do 1 m nad i pod gliną w tym samym otworze: energia ucieka w plastyczną warstwę → gorzej rozdrabnia
  let nearClay = false;
  for (let k = Math.max(0, i - 10); k <= Math.min(best.samples.length - 1, i + 10); k++) if (best.it.clay[k]) { nearClay = true; break; }
  return { A: best.it.A[i], ucs: best.it.ucs[i], fi: best.it.fi[i], clay: !!clay, nearClay: !clay && nearClay, clayHole: best.it.clay.some(Boolean) };
}
function mwdFiles(set = mwdSet()) {
  const m = ensureMwd();
  if (!m || m.set !== set) return {};
  return Object.fromEntries(m.holes.map((o) => [`${o.h.name}.csv`, mwdCsv(o.samples, { planId: state.planId, holeId: o.h.id, holeName: o.h.name, setName: MWD_SETS[set].name })]));
}

function updateFrag() {
  state.frag = null;
  const hs = state.holes.filter((h) => h.type === 'normal' && h.mass > 0 && h.benchHeight > 0);
  const out = $('fragStats');
  if (!hs.length) { out.replaceChildren(); drawFragChart(); return; }
  const mean = (f) => hs.reduce((s, h) => s + f(h), 0) / hs.length;
  const pat = readPattern(), tp = state.types.normal;
  const H = mean((h) => h.benchHeight), Q = mean((h) => h.mass), L = mean((h) => h.chargeLength), BCL = mean((h) => h.bcl);
  const mwdD = ensureMwd();
  const A = mwdD ? mwdD.meanA : $('rockA').value !== '' ? num('rockA') : lillyA({ rmd: $('rmd').value, jps: $('jps').value, jpa: $('jpa').value, density: num('rockRho'), youngGpa: num('rockE'), ucsMpa: num('rockUcs') });
  let mw = 0, mr = 0;
  for (const h of hs) for (const [id, m] of Object.entries(h.byProduct)) { mw += m; mr += m * (state.products.find((p) => p.id === id)?.rws ?? 100); }
  const rws = mw ? mr / mw : 100;
  if (!(A > 0) || !(L > 0) || !(H > 0)) { out.replaceChildren(); drawFragChart(); return; }
  const r0 = kuzRam({ A, Q, V0: pat.burden * pat.spacing * H, rws, B: pat.burden, S: pat.spacing, D: tp.diameter, W: num('drillSd'), L, BCL, CCL: Math.max(0, L - BCL), H });
  // opóźnienia: czynnik czasu A_t (opóźnienie odciążające względem T_max) i rozrzut zapalników (obniża n)
  const rhoR = num('rockRho') || 2.6, cp = pWaveKmS(num('rockE'), rhoR < 100 ? rhoR : rhoR / 1000, $('rockNu').value === '' ? 0.25 : num('rockNu')); // fala P, km/s
  const T = reliefDelay(state.holes, 1.6 * Math.max(pat.burden, pat.spacing)), Tmax = tMaxMs(pat.burden, cp);
  const useT = $('useTiming').checked;
  const At = useT && T != null && cp > 0 ? timingFactor(T, Tmax) : 1;
  const sig = (num('detScatter') / 100) * mean((h) => h.inholeMs ?? 500) * Math.SQRT2; // rozrzut różnicy czasów dwóch sąsiednich otworów
  const Rs = T > 0 ? sig / T : 0, ns = useT && T != null ? scatterFactor(Rs) : 1;
  const x50 = r0.x50 * At, n = Math.min(Math.max(r0.n * ns, 0.3), 3);
  const r = { x50, n, xc: x50 / Math.LN2 ** (1 / n), x50base: r0.x50, nBase: r0.n };
  const xo = num('oversize') || 100;
  state.frag = { ...r, A, rws, xo, T, Tmax, At, Rs, ns, cp, oversizePct: retained(xo, r.x50, r.n) * 100, x80: r.xc * Math.log(5) ** (1 / r.n), pf: Q / (pat.burden * pat.spacing * H), n: r.n };
  const f = state.frag;
  const rows = [
    [mwdD ? 'Współczynnik skały A z MWD (średnia, zakres)' : 'Współczynnik skały A', mwdD ? `${fmt(A, 1)} (${fmt(mwdD.minA, 1)}–${fmt(mwdD.maxA, 1)})` : fmt(A, 1)], ['Średnia siła MW (ANFO = 100)', fmt(rws, 0)], ['Zużycie jednostkowe', `${fmt(f.pf, 2)} kg/m³`],
    ['X50 (rozmiar mediany)', `${fmt(f.x50, 0)} cm`], ['X80', `${fmt(f.x80, 0)} cm`], ['Wskaźnik jednorodności n', fmt(f.n, 2)],
    [`Nadgabaryt > ${fmt(xo, 0)} cm`, `${fmt(f.oversizePct, 1)} %`],
    ...(!$('useTiming').checked ? [['Opóźnienia', 'wpływ wyłączony']] : f.T != null ? [
      ['Opóźnienie odciążające T (mediana)', `${fmt(f.T, 0)} ms`],
      ['T_max = 15,6·B/c_p', `${fmt(f.Tmax, 1)} ms (c_p ${fmt(f.cp, 2)} km/s)`],
      ['Czynnik czasu A_t (mnoży X50, szacunek niekalibrowany)', `${fmt(f.At, 2)} – ${f.T < 0.7 * f.Tmax ? 'opóźnienie za krótkie, grubiej' : f.T <= 1.5 * f.Tmax ? 'blisko optimum' : 'długie opóźnienie, otwory pracują osobno'}`],
      ['Rozrzut zapalników σ/T → n ×', `${fmt(f.Rs, 2)} → ${fmt(f.ns, 2)}`],
      ['X50 / n bez wpływu opóźnień', `${fmt(f.x50base, 0)} cm / ${fmt(f.nBase, 2)}`],
    ] : [['Opóźnienia', 'brak sieci – bez poprawki czasowej']]),
  ];
  out.replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
  $('mwdInfo').textContent = mwdD ? `${MWD_SETS[mwdD.set].name}: ${mwdD.holes.length} otworów, ${mwdD.holes.reduce((s, o) => s + o.samples.length, 0).toLocaleString('pl')} próbek; UCS z MWD średnio ${fmt(mwdD.meanUcs, 0)} MPa, ${fmt(mwdD.perM, 1)} szczelin/m, A ${fmt(mwdD.minA, 1)}–${fmt(mwdD.maxA, 1)}.` + (mwdD.clayHoles?.length ? ` Glina wykryta w otworach ${mwdD.clayHoles.join(', ')} (${mwdD.holes.filter((o) => mwdD.clayHoles.includes(o.h.name)).map((o) => fmt(o.it.clay.filter(Boolean).length * 0.1, 1) + ' m').join(', ')}). Ładunek w glinie pracuje słabo: rozważ przesypkę lub korek na tej głębokości.` : '') : '';
  drawFragChart();
}

function drawFragChart() {
  const c = prepCanvas($('fragChart'), 150);
  if (!c) return;
  const { g, w, h } = c, f = state.frag;
  g.font = '11px system-ui'; g.fillStyle = '#8b95a3';
  if (!f) { g.fillText('Brak danych: wygeneruj otwory z ładunkiem.', 10, 24); return; }
  const mL = 36, mR = 10, mT = 10, mB = 22, lo = Math.log10(1), hi = Math.log10(500);
  const X = (x) => mL + ((Math.log10(Math.max(x, 1)) - lo) / (hi - lo)) * (w - mL - mR), Y = (p) => h - mB - p * (h - mT - mB);
  g.strokeStyle = '#2c333d'; g.textAlign = 'right';
  for (let k = 0; k <= 4; k++) { g.beginPath(); g.moveTo(mL, Y(k / 4)); g.lineTo(w - mR, Y(k / 4)); g.stroke(); g.fillText(`${k * 25}%`, mL - 4, Y(k / 4) + 4); }
  g.textAlign = 'center';
  for (const x of [1, 10, 100]) { g.beginPath(); g.moveTo(X(x), mT); g.lineTo(X(x), h - mB); g.stroke(); g.fillText(`${x} cm`, X(x), h - 6); }
  g.strokeStyle = '#2ec4f1'; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= 120; i++) { const x = 10 ** (lo + ((hi - lo) * i) / 120), p = passing(x, f.x50, f.n); i ? g.lineTo(X(x), Y(p)) : g.moveTo(X(x), Y(p)); }
  g.stroke(); g.lineWidth = 1;
  g.setLineDash([5, 4]); g.strokeStyle = '#ff9f1c'; g.beginPath(); g.moveTo(X(f.xo), mT); g.lineTo(X(f.xo), h - mB); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ff9f1c'; g.textAlign = 'left'; g.fillText(`> ${fmt(f.xo, 0)} cm: ${fmt(f.oversizePct, 1)}%`, Math.min(X(f.xo) + 4, w - 110), mT + 10);
  g.fillStyle = '#e4e8ee'; g.beginPath(); g.arc(X(f.x50), Y(0.5), 3.5, 0, 7); g.fill();
  g.textAlign = 'left'; g.fillStyle = '#8b95a3'; g.fillText('przechodzi przez sito', mL + 4, mT + 10);
}

// ---------- sieć: klikanie, automat ----------
function netClick(h) {
  const net = state.net;
  if (state.mode === 'start') {
    const k = net.starts.indexOf(h.id);
    if (k >= 0) net.starts.splice(k, 1); else net.starts.push(h.id);
    status(k >= 0 ? `Usunięto punkt inicjacji z otworu ${h.name}.` : `Punkt inicjacji: otwór ${h.name}.`);
    return update();
  }
  if (net.pending == null) { net.pending = h.id; status(`Połączenie od otworu ${h.name}: kliknij kolejny otwór.`); return update(); }
  if (net.pending === h.id) { net.pending = null; status('Przerwano łączenie.'); return update(); }
  const from = state.holes.find((x) => x.id === net.pending);
  const ex = net.links.findIndex((l) => l.from === net.pending && l.to === h.id);
  if (ex >= 0) { net.links.splice(ex, 1); status(`Usunięto połączenie ${from?.name} → ${h.name}.`); }
  else {
    net.links = net.links.filter((l) => l.to !== h.id); // do otworu wchodzi jedno połączenie
    net.links.push({ from: net.pending, to: h.id, ms: num('netConn') });
    status(`Połączono ${from?.name} → ${h.name} łącznikiem ${num('netConn')} ms. Kliknij kolejny otwór lub ten sam, aby zakończyć.`);
  }
  net.pending = h.id;
  update();
}

function autoNet() {
  const grid = state.holes.filter((h) => !h.manual).map((h) => ({ id: h.id, row: h.ref.row, u: h.ref.u }));
  if (!grid.length) return status('Brak siatki: najpierw wygeneruj otwory.');
  const r = autoNetwork(grid, { pattern: $('autoPattern').value, alongMs: num('autoAlong'), betweenMs: num('autoBetween') });
  state.net = { starts: r.starts, links: r.links, pending: null };
  status(`Utworzono sieć: ${r.links.length} połączeń, punkt inicjacji w otworze ${state.holes.find((h) => h.id === r.starts[0])?.name}.`);
  update();
}

function readCatalog(id) {
  return $(id).value.split(/[;,\s]+/).map(Number).filter((v) => Number.isFinite(v) && v >= 0);
}
function refreshCatalogs() {
  const fill = (id, vals) => $(id).replaceChildren(...vals.map((v) => { const o = document.createElement('option'); o.value = v; return o; }));
  fill('surfaceList', readCatalog('surfaceCat')); fill('inholeList', readCatalog('inholeCat'));
}

// ---------- symulacja: tryby, przygotowanie, przebudowa ----------
let vizTimer = null;
function queueViz() {
  if (!state.viz.ready && $('simMode').value === 'off') return;
  clearTimeout(vizTimer);
  vizTimer = setTimeout(() => { if ($('simMode').value !== 'off') prepareViz(); }, 300);
}

async function prepareViz() {
  const v = state.viz, mode = $('simMode').value;
  if (mode === 'off' || !state.model) return;
  const zs = zShift(), pat = readPattern();
  v.mode = mode; v.colorBy = $('simColor').value;
  const normals = state.holes.filter((h) => h.type === 'normal');
  const meanToe = normals.length ? normals.reduce((s, h) => s + h.toe.z, 0) / normals.length : state.types.normal.targetZ - zs;
  const target = state.types.normal.targetZ - zs;
  const floorZ = $('volBase').value === 'toe' ? Math.min(target, meanToe) : target;
  // zabiór = szerokość strzału w poprzek rzędów (liczba rzędów × burden); otoczenie = krotność zabioru z każdej strony
  const rows = state.grid.length ? Math.max(...state.grid.map((g) => g.row)) + 1 : 3;
  const take = pat.burden * rows, sur = Math.max(0, num('surround'));
  state.vizBase = { target, meanToe, floorZ, take, surDist: sur * take };
  const info = v.prepare({
    polygon: state.closed ? state.polygon : null, floorZ, sampleZ,
    holes: state.holes.map((h) => {
      const top = h.segments.find((x) => x.kind === 'charge'); // najwyższy ładunek: od niego liczymy przybitkę i SDoB
      const tp = state.types[h.type];
      return { x: h.x, y: h.y, z: h.z, tFire: h.tFire ?? 0, mass: h.mass, volume: h.volume, diameterMm: h.diameter, mPerM: h.chargeLength > 0 ? h.mass / h.chargeLength : 0, incl: tp.incl ?? 0, inclAz: tp.inclAz ?? null,
        stemTop: top ? top.from : null, kgPerM: top ? top.mass / Math.max(1e-6, top.to - top.from) : 0 };
    }),
    mwd: ensureMwd() ? { field: mwdField, meanA: state.mwd.meanA, meanUcs: state.mwd.meanUcs } : null,
    burden: pat.burden, spacing: pat.spacing, frag: state.frag ? { x50: state.frag.x50, n: state.frag.n } : null,
    az: $('simAz').value !== '' ? num('simAz') : null, fallbackAz: state.types.normal.incl > 0.5 ? state.types.normal.inclAz : (pat.rowAz + 90) % 360,
    power: num('simPower') || 1, relief: $('simRelief').value === '' ? 0.8 : Math.max(0, num('simRelief')), crater: $('simCrater').value === '' ? 1 : Math.max(0, num('simCrater')), kRM: $('simKrm').value === '' ? 10 : Math.max(0, num('simKrm')), blockSize: num('blkSize'), maxBlocks: num('maxBlocks') || 2500,
    surround: { dist: sur * take, maxBlocks: window.__surMax ?? 3000 },
  });
  if (!info.ok) { $('simInfo').textContent = info.message; state.model.visible = true; refreshTimeline(); return; }
  state.model.visible = false;
  clock.t = 0; clock.playing = false;
  describeViz(info);
  drawOverlay(); refreshTimeline();
  if (mode === 'phys') { const kind = await v.ensurePhysics(); describeViz(info, kind); }
}

// SDoB każdego otworu (skalowana głębokość ukrycia najwyższego ładunku); < 0,92 – ryzyko wyrzutu w górę, ≥ 1,4 – bez wyrzutu
function holeSdobs() {
  return state.holes.map((h) => {
    const top = h.segments?.find((x) => x.kind === 'charge');
    return top ? sdob({ stemTop: top.from, kgPerM: top.mass / Math.max(1e-6, top.to - top.from), diameterMm: h.diameter }) : Infinity;
  }).filter(Number.isFinite);
}

function describeViz(info, kind) {
  const mode = state.viz.mode, noNet = !state.timing?.time.size;
  const eng = kind === 'rapier' ? 'silnik Rapier' : kind === 'ballistic' ? 'uproszczona balistyka (silnik Rapier niedostępny)' : mode === 'phys' ? 'ładuję silnik fizyki…' : '';
  const vb = state.vizBase, below = vb ? vb.target - vb.meanToe : 0;
  const base = vb ? ` Bryła: od ${fmt(vb.floorZ + zShift(), 1)} m n.p.m. do terenu (do ${fmt(info.height, 1)} m wysokości).` +
    (below > 2 && $('volBase').value === 'target' ? ` ⚠ Otwory sięgają średnio ${fmt(below, 1)} m poniżej rzędnej docelowej, a bryła kończy się na niej: ustaw „Bryła sięga do: dna otworów” albo skoryguj rzędną/długość otworu.` : '') : '';
  const parts = [`${info.blocks.toLocaleString('pl')} bloczków po ${fmt(info.size, 2)} m`, `kierunek ku ścianie ${fmt(info.az, 0)}°`];
  if (mode !== 'time') parts.push(`odłamków ${info.frags.toLocaleString('pl')}`, `nienaruszonych (nadgabaryt) ${fmt((info.whole / info.blocks) * 100, 0)}%`);
  const around = info.rock ? ` Otoczenie skały: ${info.rock.toLocaleString('pl')} bloczków do ${fmt(info.rockDist, 0)} m od obrysu, takie same jak bloczki serii (zadane ${fmt(num("surround"), 1)} × zabiór ${fmt(vb.take, 0)} m).` : '';
  const sd = holeSdobs(), nCr = sd.filter((x) => x < SDOB_SAFE).length;
  const crater = nCr ? ` Krótka przybitka: ${nCr} z ${sd.length} otworów ma SDoB < ${fmt(SDOB_SAFE, 1)} (min ${fmt(Math.min(...sd), 2)}), bloczki nad ładunkiem wylatują w górę.` : '';
  const mwdTxt = info.mwd ? ` MWD: współczynnik skały bloczków ${fmt(info.mwd.aMin, 1)}–${fmt(info.mwd.aMax, 1)} (warstwy i spękania z wiercenia)${info.mwd.nClay ? `, glina: ${info.mwd.nClay} bloczków (brązowe, nie kruszą się, lżejsze i lepkie)` : ''}.` : '';
  $('simInfo').textContent = `${parts.join(', ')}.${base}${around}${crater}${mwdTxt}` + (eng ? ` Fizyka: ${eng}.` : '') + (noNet ? ' Brak sieci: wszystkie bloczki odpalą się naraz, połącz otwory.' : '');
}

function sizeLegend(show) {
  const el = $('sizeLegend'); el.hidden = !show;
  if (show && $('simColor').value === 'rock') { el.innerHTML = 'Rodzaj skały z MWD: <span style="color:#9a541f">■</span> glina, <span style="color:#f26b2e">■</span> strefa spękana, <span style="color:#f5d64d">■</span> słaba / marglista (UCS &lt; 65 MPa), <span style="color:#4d80f2">■</span> zwięzła (65–150 MPa), <span style="color:#944ddb">■</span> bardzo twarda (&gt; 150 MPa). Bez danych MWD kolor wg wielkości.'; el.dataset.ok = ''; return; }
  if (!show || el.dataset.ok) return;
  const css = (d) => { const c = sizeColor(d); return `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`; };
  const lo = SIZE_STOPS[0][0], hi = SIZE_STOPS[SIZE_STOPS.length - 1][0];
  const stops = Array.from({ length: 13 }, (_, i) => { const d = lo * (hi / lo) ** (i / 12); return `${css(d)} ${(i / 12 * 100).toFixed(0)}%`; }).join(',');
  el.innerHTML = `Wielkość odłamków (po rozpadzie):<div style="height:10px;border-radius:5px;margin:4px 0 2px;background:linear-gradient(90deg,${stops})"></div><div style="display:flex;justify-content:space-between"><span>2 cm</span><span>10 cm</span><span>30 cm</span><span>60 cm</span><span>1 m</span><span>≥1,5 m</span></div>`;
  el.dataset.ok = '1';
}

function setSimMode() {
  const mode = $('simMode').value, v = state.viz;
  sizeLegend(mode === 'frag' || mode === 'phys');
  if (mode === 'off') {
    v.clear(); v.mode = 'off'; if (state.model) state.model.visible = true;
    $('simInfo').textContent = 'Włącz tryb i użyj paska czasu na widoku 3D.';
    clock.t = 0; clock.playing = false; drawOverlay(); refreshTimeline();
    return;
  }
  $('tlSpeed').value = mode === 'phys' ? '0.5' : '0.25';
  prepareViz();
}

async function togglePlay() {
  const v = state.viz;
  if (simActive()) {
    if (v.playing) { v.playing = false; return updateTimelineUi(); }
    if (v.t >= v.tMax - 1 || (v.mode === 'phys' && !v.sim)) { v.reset(); if (v.mode === 'phys') await v.ensurePhysics(); }
    v.playing = true;
  } else {
    if (clock.playing) clock.playing = false;
    else { if (clock.t >= tMaxNow() - 1) clock.t = 0; clock.playing = true; }
  }
  updateTimelineUi();
}

function resetClock() {
  if (simActive()) state.viz.reset(); else { clock.t = 0; clock.playing = false; }
  clock.t = 0; clock.playing = false;
  applyHoleColors(); updateTimelineUi();
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
  const markerHit = ['del', 'type', 'prof', 'net', 'start'].includes(state.mode) && state.markers ? pick(e, state.markers, false) : null;
  if (state.mode === 'del') {
    if (markerHit) {
      const ref = state.holes[markerHit.instanceId].ref;
      state.grid = state.grid.filter((g) => g !== ref);
      state.manual = state.manual.filter((g) => g !== ref);
      update();
    }
    return;
  }
  if (state.mode === 'type') {
    if (markerHit) {
      const ref = state.holes[markerHit.instanceId].ref;
      ref.type = ref.type === 'profile' ? 'normal' : 'profile';
      update();
    }
    return;
  }
  if ((state.mode === 'net' || state.mode === 'start')) { if (markerHit) netClick(state.holes[markerHit.instanceId]); return; }
  if (state.mode === 'prof' && markerHit) { openProfileForHole(state.holes[markerHit.instanceId]); return; }
  const hit = pick(e, state.model);
  if (!hit) return;
  const pt = world.worldToLocal(hit.point.clone());
  if (state.mode === 'poly') {
    if (state.closed) { state.closed = false; state.polygon = []; state.grid = []; }
    state.polygon.push({ x: pt.x, y: pt.y, z: pt.z });
    status(`Obrys: ${state.polygon.length} pkt. ${state.polygon.length >= 3 ? 'Kliknij „Zamknij obrys”.' : ''}`);
  } else if (state.mode === 'hole') {
    state.manual.push({ x: pt.x, y: pt.y, z: pt.z, type: $('newType').value, hid: state.nextHid++ });
  } else if (state.mode === 'probe') {
    state.probe = { x: pt.x, y: pt.y, z: pt.z };
  } else if (state.mode === 'prof') {
    if (!state.profA) {
      state.profA = { x: pt.x, y: pt.y, z: pt.z };
      status('Punkt A ustawiony. Kliknij punkt B, aby narysować profil, albo kliknij otwór.');
    } else {
      const A = state.profA, dx = pt.x - A.x, dy = pt.y - A.y, len = Math.hypot(dx, dy);
      state.profA = null;
      if (len < 1) status('Punkty A i B są zbyt blisko siebie.');
      else {
        $('profHalf').value = Math.max(2, Math.round(len / 2));
        const az = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        state.profile = { mode: 'line', origin: { x: A.x + dx / 2, y: A.y + dy / 2 }, az };
        status(`Profil: azymut ${fmt(az, 0)}°, długość ${fmt(len, 1)} m.`);
      }
    }
  }
  update();
});

// Offset z Pix4D (*_offset.xyz): trzy liczby X Y Z. Rzędne docelowe są podawane w m n.p.m., więc przesuwają się razem z offsetem Z.
let prevOffZ = 0;
function setOffset(x, y, z) {
  $('offX').value = x; $('offY').value = y; $('offZ').value = z;
  shiftTargets(z - prevOffZ);
  prevOffZ = z;
}

function shiftTargets(dz) {
  for (const t of Object.values(state.types)) t.targetZ = +(t.targetZ + dz).toFixed(3);
  typeToInputs();
}

async function applyOffsetFile(file) {
  const nums = ((await file.text()).match(/[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map((s) => parseFloat(s.replace(',', '.')));
  if (nums.length < 3) return status('Plik offsetu powinien zawierać trzy liczby: X Y Z.');
  setOffset(nums[0], nums[1], nums[2]);
  document.querySelector('#panel details').open = true;
  update();
  status(`Wczytano offset z pliku ${file.name}: X ${fmt(nums[0], 3)}, Y ${fmt(nums[1], 3)}, Z ${fmt(nums[2], 3)}.`);
}

// ---------- kontrola współrzędnych ----------
function updateExtent() {
  if (!state.box) return;
  const ox = num('offX'), oy = num('offY'), oz = num('offZ'), { min, max } = state.box;
  $('extent').textContent = `Zasięg modelu — X: ${fmt(min.x + ox, 2)} … ${fmt(max.x + ox, 2)}, Y: ${fmt(min.y + oy, 2)} … ${fmt(max.y + oy, 2)}, Z: ${fmt(min.z + oz, 2)} … ${fmt(max.z + oz, 2)} m`;
}

function showProbe(announce = true) {
  const out = $('probeOut'), cmp = $('ctrlOut');
  if (!state.probe) return;
  const [x, y, z] = realOf(state.probe);
  out.textContent = `Punkt: X ${fmt(x, 3)}, Y ${fmt(y, 3)}, Z ${fmt(z, 3)} m`;
  const cx = $('ctrlX').value, cy = $('ctrlY').value, cz = $('ctrlZ').value;
  if (cx === '' || cy === '') { cmp.textContent = announce ? 'Wpisz X i Y punktu kontrolnego (Z opcjonalnie).' : ''; return; }
  const dx = x - parseFloat(cx), dy = y - parseFloat(cy), dh = Math.hypot(dx, dy);
  cmp.textContent = `Różnica ΔX ${fmt(dx, 3)}, ΔY ${fmt(dy, 3)}, w poziomie ${fmt(dh, 3)} m` + (cz === '' ? '' : `, ΔZ ${fmt(z - parseFloat(cz), 3)} m`);
}

function closePolygon() {
  if (state.polygon.length < 3) return status('Obrys wymaga co najmniej 3 punktów.');
  state.closed = true;
  generate();
  status(`Obrys zamknięty, ${blast.polygonArea(state.polygon).toFixed(0)} m². Wygenerowano ${state.holes.length} otworów.`);
}

function setMode(m) {
  state.mode = m;
  $('view').classList.toggle('tool', m !== 'orbit');
  if (m !== 'prof') state.profA = null;
  if (m !== 'net' && state.net.pending != null) { state.net.pending = null; drawOverlay(); }
}

// Przykład na nierównej ścianie: krawędź skarpy faluje, więc zabiór pierwszego szeregu wynosi 2–4 m;
// dalsze szeregi co 4 m, odstęp otworów 4 m (bez szachownicy), Ø102 mm, emulsja, sieć 25/42 ms.
function naturalDesign() {
  const { size } = state;
  const at = (fx, fy) => { const x = (fx - 0.5) * size.x, y = (fy - 0.5) * size.y; return { x, y, z: sampleZ(x, y) ?? 0 }; };
  $('burden').value = 4; $('spacing').value = 4; $('rowAz').value = 180; $('edge').value = 0; $('stagger').checked = false;
  state.types.normal.diameter = state.types.profile.diameter = 102;
  // przód obrysu na najgłębszym miejscu krawędzi (x = 57 m modelu), 12 m w głąb = 3 szeregi
  state.polygon = [at(0.45, 0.25), at(0.57, 0.25), at(0.57, 0.75), at(0.45, 0.75)];
  state.closed = true;
  generate();
  const last = Math.max(...state.grid.map((g) => g.row));
  state.grid.forEach((g) => { if (g.row === last) g.type = 'profile'; });
  Object.assign(state.types.profile, { incl: 12, inclAz: 90 });
  typeToInputs();
  $('autoPattern').value = 'rows'; $('autoAlong').value = 25; $('autoBetween').value = 42; $('netConn').value = 42;
  autoNet();
  // rzeczywisty zabiór pierwszego szeregu: odległość od otworu do miejsca, gdzie teren spada o ponad 1 m (ku ścianie, +X)
  const first = state.holes.filter((h) => h.ref?.row === 0);
  const bs = first.map((h) => { const z0 = sampleZ(h.x, h.y); for (let d = 0; d < 15; d += 0.1) { const z = sampleZ(h.x + d, h.y); if (z == null || z < z0 - 1) return d; } return null; }).filter((d) => d != null);
  state.firstRowBurden = bs.length ? { min: Math.min(...bs), max: Math.max(...bs) } : null;
  const c = state.polygon.reduce((s, p) => ({ x: s.x + p.x / state.polygon.length, y: s.y + p.y / state.polygon.length, z: s.z + p.z / state.polygon.length }), { x: 0, y: 0, z: 0 });
  controls.target.set(c.x, c.z, -c.y); camera.position.set(c.x + 26, c.z + 20, -c.y + 30); controls.update();
  $('simMode').value = 'time';
  setSimMode();
  const b = state.firstRowBurden;
  status(`Ściana naturalna: ${state.holes.length} otworów w ${last + 1} szeregach, odstęp 4 m, Ø102 mm, emulsja. Zabiór 1. szeregu do nierównej ściany ${b ? `${fmt(b.min, 1)}–${fmt(b.max, 1)} m` : '—'}, dalsze szeregi co 4 m. Sieć 25/42 ms.`);
}

// Model przykładowy: ława z obrysem i siatką, żeby od razu było widać działanie.
const SAMPLES = { lawa: 'lawa-testowa.obj', natural: 'sciana-naturalna.obj' };
async function loadSample(withDesign = true) {
  const kind = $('sampleKind')?.value === 'natural' ? 'natural' : 'lawa';
  try {
    let blob;
    const inl = window.__SAMPLE_OBJS__?.[kind] ?? (kind === 'lawa' ? window.__SAMPLE_OBJ__ : null);
    if (inl) blob = new Blob([inl]); // wersja osadzona (np. Streamlit, artifact)
    else {
      const res = await fetch('samples/' + SAMPLES[kind]);
      if (!res.ok) throw new Error(res.status);
      blob = await res.blob();
    }
    await loadFiles([new File([blob], SAMPLES[kind])]);
  } catch (e) { return status('Nie udało się wczytać modelu przykładowego.'); }
  if (!withDesign) return;
  if (kind === 'natural') return naturalDesign();
  const { size } = state;
  const at = (fx, fy) => { const x = (fx - 0.5) * size.x, y = (fy - 0.5) * size.y; return { x, y, z: sampleZ(x, y) ?? 0 }; };
  // Przykład: 3 rzędy po 10 otworów, siatka 4 × 4 m (bez szachownicy), koronka 102 mm, emulsja.
  // Rzędy biegną wzdłuż ściany (kierunek 180°), pierwszy rząd jest najbliżej wolnej ściany; obrys kończy się na krawędzi skarpy.
  $('burden').value = 4; $('spacing').value = 4; $('rowAz').value = 180; $('edge').value = 0; $('stagger').checked = false;
  state.types.normal.diameter = state.types.profile.diameter = 102;
  state.polygon = [at(0.4833, 0.25), at(0.5833, 0.25), at(0.5833, 0.75), at(0.4833, 0.75)];
  state.closed = true;
  generate();
  // ostatni rząd (od strony pozostawianej ściany) jako otwory profilowe, lekko pochylone ku ścianie
  const last = Math.max(...state.grid.map((g) => g.row));
  state.grid.forEach((g) => { if (g.row === last) g.type = 'profile'; });
  Object.assign(state.types.profile, { incl: 12, inclAz: 90 });
  typeToInputs();
  // sieć: 25 ms w rzędzie, 42 ms między rzędami (pierwszy rząd → drugi → trzeci)
  $('autoPattern').value = 'rows'; $('autoAlong').value = 25; $('autoBetween').value = 42; $('netConn').value = 42;
  autoNet();
  // symulacja od razu włączona (bloczki wg czasu odpalenia); fragmentację i fizykę wybierasz w kroku 7
  const c = state.polygon.reduce((s, p) => ({ x: s.x + p.x / state.polygon.length, y: s.y + p.y / state.polygon.length, z: s.z + p.z / state.polygon.length }), { x: 0, y: 0, z: 0 });
  controls.target.set(c.x, c.z, -c.y); camera.position.set(c.x + 26, c.z + 20, -c.y + 30); controls.update();
  $('simMode').value = 'time';
  setSimMode();
  status(`Przykład: ${state.holes.length} otworów w 3 rzędach (siatka 4×4 m, Ø102 mm, emulsja), łączniki 25 ms w rzędzie i 42 ms między rzędami. Naciśnij ▶ na pasku czasu. Wczytaj własny model OBJ w kroku 1.`);
}

// ---------- podpięcie zdarzeń ----------
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));
document.querySelectorAll('#typeTabs button').forEach((b) => b.addEventListener('click', () => { state.editType = b.dataset.type; typeToInputs(); renderTplInfo(); }));
$('closePoly').onclick = closePolygon;
$('clearPoly').onclick = () => { state.polygon = []; state.closed = false; state.grid = []; update(); };
$('generate').onclick = generate;
$('clearHoles').onclick = () => { state.grid = []; state.manual = []; update(); };
$('export').onclick = exportCsv;
$('exportXml').onclick = exportXml;
$('dataCopy').onclick = copyData;
$('dataClose').onclick = () => { $('databox').hidden = true; };
$('dataLoad').onclick = () => loadProjectFromText($('dataText').value);
$('saveProject').onclick = () => { showData('Projekt (JSON): zapisz plik albo skopiuj tekst', projectToJson(), { filename: 'projekt_wiercen.json', mime: 'application/json' }); status('Projekt zapisany.'); };
$('pasteProject').onclick = () => { showData('Wklej tekst projektu (JSON) i kliknij „Wczytaj z tekstu”', '', { canLoad: true }); };
$('projectFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) loadProjectFromText(await f.text()); e.target.value = ''; });
$('offsetFile').addEventListener('change', (e) => e.target.files[0] && applyOffsetFile(e.target.files[0]));
$('offZ').addEventListener('input', () => { // ręczna zmiana Z offsetu przesuwa też rzędne docelowe
  const z = num('offZ');
  shiftTargets(z - prevOffZ);
  prevOffZ = z;
});
$('xmlPlanId').addEventListener('input', () => { state.planId = $('xmlPlanId').value.trim() || state.planId; });
$('xmlNewPlan').onclick = () => { state.planId = newPlanId(); $('xmlPlanId').value = state.planId; status(`Nowy ID planu: ${state.planId}. Dane powiązane ze starym ID zostają przy starym planie.`); };
$('ctrlCompare').onclick = () => showProbe(true);
$('loadSample').onclick = () => loadSample();
$('sampleKind').onchange = () => loadSample();
$('addCharge').onclick = () => { state.types[state.editType].template.push({ kind: 'charge', productId: state.products[0]?.id ?? '', by: 'length', length: 1 }); renderTemplate(); update(); };
$('addDeck').onclick = () => { state.types[state.editType].template.push({ kind: 'deck', by: 'length', length: 0.3 }); renderTemplate(); update(); };
$('lenMode').addEventListener('change', () => { inputsToType(); update(); });
$('copyTpl').onclick = () => {
  const other = state.editType === 'normal' ? 'profile' : 'normal';
  state.types[other].template = clone(state.types[state.editType].template);
  update();
  status(`Szablon ładunku skopiowano do typu: ${TYPE_NAME[other].toLowerCase()}.`);
};
$('dbAdd').onclick = () => { state.products.push({ id: newProductId(), name: 'Nowy produkt', kind: 'bulk', density: 1, color: '#34d399' }); saveProducts(); renderDb(); renderTemplate(); };
$('dbReset').onclick = () => { state.products = clone(DEFAULT_PRODUCTS); saveProducts(); renderDb(); renderTemplate(); update(); };
$('autoNet').onclick = autoNet;
$('netClear').onclick = () => { state.net = { starts: [], links: [], pending: null }; update(); status('Usunięto sieć.'); };
for (const id of ['surfaceCat', 'inholeCat']) $(id).addEventListener('input', refreshCatalogs);
$('colorMode').addEventListener('change', () => { state.colorMode = $('colorMode').value; drawOverlay(); refreshTimeline(); });
$('delayWindow').addEventListener('input', () => update());
$('simMode').addEventListener('change', setSimMode);
for (const id of ['blkSize', 'maxBlocks', 'simAz', 'simPower', 'simRelief', 'simCrater', 'simKrm', 'surround']) $(id).addEventListener('input', queueViz);
$('volBase').addEventListener('change', queueViz);
for (const id of ['rmd', 'jps', 'jpa', 'rockRho', 'rockE', 'rockNu', 'rockUcs', 'rockA', 'drillSd', 'oversize', 'detScatter']) $(id).addEventListener('input', () => update());
$('useTiming').addEventListener('change', () => update());
$('simColor').addEventListener('change', () => { state.viz.colorBy = $('simColor').value; sizeLegend(['frag', 'phys'].includes($('simMode').value)); if (state.viz.ready) state.viz.render(state.viz.t ?? 0, true); });
function mwdAutoColor() { if (mwdSet()) { $('simColor').value = 'rock'; state.viz.colorBy = 'rock'; sizeLegend(['frag', 'phys'].includes($('simMode').value)); } }
$('mwdClay').addEventListener('change', () => { if ($('mwdClay').checked) { $('mwdWapien').checked = true; $('mwdZwiezla').checked = false; } mwdAutoColor(); update(); queueViz(); });
for (const [id, other] of [['mwdWapien', 'mwdZwiezla'], ['mwdZwiezla', 'mwdWapien']]) $(id).addEventListener('change', () => { if ($(id).checked) $(other).checked = false; if (!$('mwdWapien').checked) $('mwdClay').checked = false; mwdAutoColor(); update(); queueViz(); });
$('tlPlay').onclick = togglePlay;
$('tlReset').onclick = resetClock;
$('tlSlider').addEventListener('input', () => {
  const t = ($('tlSlider').value / 1000) * tMaxNow();
  if (simActive()) { if (state.viz.mode !== 'phys') state.viz.seek(t); } else { clock.playing = false; }
  if (!(simActive() && state.viz.mode === 'phys')) clock.t = t;
  applyHoleColors(); updateTimelineUi();
});
$('tlSpeed').addEventListener('change', () => { state.viz.speed = parseFloat($('tlSpeed').value); });
for (const d of document.querySelectorAll('#panel details')) d.addEventListener('toggle', () => { drawFragChart(); drawDelayChart(); });
$('profClose').onclick = closeProfile;
$('profHole').onchange = () => {
  const h = state.holes.find((x) => String(x.id) === $('profHole').value);
  if (h) openProfileForHole(h);
};
for (const id of ['profHalf', 'profBand']) $(id).addEventListener('input', () => { if (state.profile) { drawOverlay(); renderProfile(); } });
$('suggest').onclick = () => {
  const t = state.types[state.editType];
  const s = blast.suggestParameters(t.diameter);
  $('burden').value = s.burden; $('spacing').value = s.spacing;
  t.subdrill = s.subdrill; t.stemming = s.stemming;
  typeToInputs();
  state.closed ? generate() : update();
  status('Wstawiono wartości orientacyjne (B≈30·Ø, S≈1,15·B, przewiert≈0,3·B, przybitka≈0,7·B). Zweryfikuj je dla swojej skały i MW.');
};
for (const el of document.querySelectorAll('#panel input[type=number], #panel input[type=checkbox]')) {
  if (el.closest('#tplRows, #dbRows, #profile, #simSec') || ['netConn', 'delayWindow'].includes(el.id)) continue;
  el.addEventListener('input', () => {
    if (el.hasAttribute('data-type')) inputsToType();
    if (el.hasAttribute('data-regen') && state.closed) generate(); else update();
  });
}
$('files').addEventListener('change', (e) => loadFiles(e.target.files));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && state.mode === 'poly' && e.target === document.body) closePolygon();
  if (e.key === 'Escape' && state.net.pending != null) { state.net.pending = null; status('Przerwano łączenie.'); update(); }
});

const view = $('view');
view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragging'); });
view.addEventListener('dragleave', () => view.classList.remove('dragging'));
view.addEventListener('drop', (e) => { e.preventDefault(); view.classList.remove('dragging'); loadFiles(e.dataTransfer.files); });

typeToInputs();
renderDb();
renderStats();
$('xmlPlanId').value = state.planId;
refreshCatalogs();
loadSample();

// pomocnik do testów: położenie otworu na ekranie (piksele względem okna)
function holeScreenPos(h) {
  const v = world.localToWorld(new THREE.Vector3(h.x, h.y, h.z + state.markerSize * 0.3)).project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}

// do testów w przeglądarce
window.__app = { mwdFiles, mwdField, ensureMwd, camera, controls, clock, prepareViz, setSimMode, autoNet, togglePlay, resetClock, applyHoleColors, holeScreenPos, state, loadFiles, generate, closePolygon, loadSample, update, exportXml, exportCsv, projectToJson, loadProjectFromText, renderProfile, openProfileForHole };
