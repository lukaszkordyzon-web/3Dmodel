import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import * as blast from './blast.js';
import { DEFAULT_PRODUCTS, newProductId } from './products.js';
import { buildIredesXml } from './iredes.js';
import { pl2000ToLonLat } from './geo.js';
import { buildProfile, drawProfile } from './profile.js';

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
const TYPE_FIELDS = { diameter: 'diameter', target: 'targetZ', subdrill: 'subdrill', stemming: 'stemming', incl: 'incl', inclAz: 'inclAz' };
const defaultTemplate = () => [{ kind: 'charge', productId: 'emu-bulk', flex: true }];
const defaultType = () => ({ diameter: 95, targetZ: 0, subdrill: 1.1, stemming: 2.4, incl: 0, inclAz: 0, template: defaultTemplate() });

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
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

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
}

const readPattern = () => ({
  burden: num('burden'), spacing: num('spacing'), rowAz: num('rowAz'), edge: num('edge'), stagger: $('stagger').checked,
});

function generate() {
  if (!state.closed) return status('Najpierw narysuj i zamknij obrys (min. 3 punkty).');
  const p = readPattern();
  state.grid = blast.generateGrid(state.polygon, {
    burden: p.burden, spacing: p.spacing, rowAzimuthDeg: p.rowAz, stagger: p.stagger, edgeOffset: p.edge,
  }).flatMap((g) => { const z = sampleZ(g.x, g.y); return z === null ? [] : [{ x: g.x, y: g.y, z, row: g.row, u: g.u, type: 'normal' }]; });
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
    const g = blast.holeGeometry({ x: s.x, y: s.y, collarZ: s.z }, { floorZ: tp.targetZ - zs, subdrill: tp.subdrill, inclDeg: tp.incl, azimuthDeg: tp.inclAz });
    if (g.benchHeight < 0.3) { state.skipped++; continue; }
    const c = blast.loadHole(g.length, tp.template, { stemming: tp.stemming, diameterMm: tp.diameter, products: state.products });
    const id = state.holes.length + 1;
    const manual = state.manual.includes(s);
    state.holes.push({
      ref: s, id, name: `${manual ? 0 : s.row + 1}.${id}`, type, manual,
      x: s.x, y: s.y, z: s.z, ...g, ...c, diameter: tp.diameter, targetZ: tp.targetZ, subdrill: tp.subdrill,
      volume: pat.burden * pat.spacing * g.benchHeight,
    });
  }
  drawOverlay();
  renderStats();
  renderTable();
  renderTplInfo();
  refreshProfileList();
  if (state.profile) renderProfile();
}

// ---------- typ otworu: parametry w panelu ----------
function typeToInputs() {
  const t = state.types[state.editType];
  for (const [id, k] of Object.entries(TYPE_FIELDS)) $(id).value = t[k];
  document.querySelectorAll('#typeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.type === state.editType));
  renderTemplate();
}

function inputsToType() {
  const t = state.types[state.editType];
  for (const [id, k] of Object.entries(TYPE_FIELDS)) t[k] = num(id);
}

// ---------- szablon ładunku ----------
function renderTemplate() {
  const t = state.types[state.editType];
  const box = $('tplRows');
  box.replaceChildren();
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= t.template.length) return; [t.template[i], t.template[j]] = [t.template[j], t.template[i]]; renderTemplate(); update(); };
  t.template.forEach((seg, i) => {
    const row = el('div', 'tplrow');
    row.append(el('span', 'k', seg.kind === 'deck' ? 'Przekładka' : 'Ładunek'));
    if (seg.kind === 'charge') {
      const sel = el('select');
      for (const p of state.products) sel.append(new Option(p.name, p.id, false, p.id === seg.productId));
      sel.onchange = () => { seg.productId = sel.value; update(); };
      row.append(sel);
    }
    const len = el('input');
    len.type = 'number'; len.min = '0'; len.step = '0.1'; len.value = seg.length ?? 0; len.disabled = !!seg.flex;
    len.title = 'Długość [m]';
    len.oninput = () => { seg.length = parseFloat(len.value) || 0; update(); };
    row.append(len, el('span', 'k', 'm'));
    if (seg.kind === 'charge') {
      const lab = el('label', 'flex'), cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!seg.flex;
      cb.onchange = () => { t.template.forEach((s) => { s.flex = false; }); seg.flex = cb.checked; renderTemplate(); update(); };
      lab.append(cb, document.createTextNode('reszta'));
      row.append(lab);
    }
    for (const [txt, fn, ttl] of [['▲', () => move(i, -1), 'W górę'], ['▼', () => move(i, 1), 'W dół'], ['✕', () => { t.template.splice(i, 1); renderTemplate(); update(); }, 'Usuń']]) {
      const b = el('button', 'ghost', txt); b.type = 'button'; b.title = ttl; b.onclick = fn; row.append(b);
    }
    box.append(row);
  });
  if (!t.template.length) box.append(el('p', 'hint', 'Brak ładunku. Dodaj ładunek lub przekładkę.'));
}

function renderTplInfo() {
  const t = state.types[state.editType];
  const hs = state.holes.filter((h) => h.type === state.editType);
  const L = hs.length ? hs.reduce((s, h) => s + h.length, 0) / hs.length : 8;
  const r = blast.loadHole(L, t.template, { stemming: t.stemming, diameterMm: t.diameter, products: state.products });
  $('tplInfo').textContent = `${TYPE_NAME[state.editType]}, otwór ${fmt(L, 1)} m${hs.length ? ' (średnia)' : ''}: przybitka ${fmt(r.stemming, 1)} m, ładunek ${fmt(r.chargeLength, 1)} m, ${fmt(r.mass, 1)} kg. ${r.warnings.join(' ')}`;
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
      d.append(field('Gęstość [g/cm³]', p.density ?? 1, '0.01', (v) => { p.density = v; }, true));
    }
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
  const kindColor = { stemming: new THREE.Color(0xd9d9d9), deck: new THREE.Color(0xa1887f), empty: new THREE.Color(0x475569) };
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
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
  lines.renderOrder = 3; overlay.add(lines);

  const markers = new THREE.InstancedMesh(new THREE.SphereGeometry(ms * 0.6, 10, 8), new THREE.MeshBasicMaterial({ depthTest: false }), n);
  const m4 = new THREE.Matrix4(), color = new THREE.Color();
  state.holes.forEach((h, i) => {
    markers.setMatrixAt(i, m4.setPosition(h.x, h.y, h.z + lift));
    markers.setColorAt(i, color.set(h.type === 'profile' ? 0x7bd88f : 0x2ec4f1));
  });
  markers.renderOrder = 4; overlay.add(markers);
  state.markers = markers;
}

// ---------- podsumowanie i tabela ----------
function renderStats() {
  const s = blast.summarize(state.holes, state.closed ? blast.polygonArea(state.polygon) : 0);
  const nProfile = state.holes.filter((h) => h.type === 'profile').length;
  const kg = {};
  for (const h of state.holes) for (const [id, m] of Object.entries(h.byProduct)) kg[id] = (kg[id] ?? 0) + m;
  const rows = [
    ['Liczba otworów (zwykłe / profilowe)', `${s.count - nProfile} / ${nProfile}`],
    ['Metraż wiercenia', `${fmt(s.totalLength)} m`],
    ['Łączny ładunek MW', `${fmt(s.totalMass, 0)} kg`],
    ...Object.entries(kg).map(([id, m]) => [`  ${state.products.find((p) => p.id === id)?.name ?? id}`, `${fmt(m, 0)} kg`]),
    ['Urabiana objętość (B×S×H)', `${fmt(s.volume, 0)} m³`],
    ['Jednostkowe zużycie MW', s.volume ? `${fmt(s.powderFactor, 2)} kg/m³` : '—'],
    ['Wiercenie jednostkowe', s.volume ? `${fmt(s.specificDrilling, 3)} m/m³` : '—'],
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
    for (const v of [h.name, h.type === 'profile' ? 'P' : 'Z', fmt(x, 2), fmt(y, 2), fmt(z, 2), fmt(h.length), fmt(h.mass, 0)]) {
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
  const head = ['Nr', 'Nazwa', 'Typ', 'E_collar', 'N_collar', 'Z_collar', 'E_toe', 'N_toe', 'Z_toe', 'Dlugosc_m', 'Srednica_mm', 'Rzedna_docelowa', 'Przewiert_m', 'Nachylenie_deg', 'Azymut_deg', 'Przybitka_m', 'Dlugosc_ladunku_m', 'MW_kg', 'Ladunek_opis', 'Zrodlo'];
  const ox = state.center.x + num('offX'), oy = state.center.y + num('offY');
  const lines = [head.join(',')];
  for (const h of state.holes) {
    const [x, y, z] = realXYZ(h);
    const tp = state.types[h.type];
    const desc = h.segments.filter((s) => s.kind !== 'empty').map((s) => {
      const len = fmt(s.to - s.from, 2).replace(',', '.');
      if (s.kind === 'stemming') return `przybitka ${len} m`;
      if (s.kind === 'deck') return `przekladka ${len} m`;
      return `${state.products.find((p) => p.id === s.productId)?.name ?? s.productId} ${len} m ${fmt(s.mass, 1).replace(',', '.')} kg`;
    }).join('; ').replaceAll(',', ' ');
    lines.push([h.id, h.name, h.type === 'profile' ? 'profilowy' : 'zwykly', x, y, z, h.toe.x + ox, h.toe.y + oy, h.toe.z + zShift(), h.length, h.diameter, h.targetZ, h.subdrill, tp.incl, tp.inclAz, h.stemming, h.chargeLength, h.mass, desc, h.manual ? 'reczny' : 'siatka']
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
    planName: $('xmlName').value || 'Plan', project: $('xmlProject').value, comment: $('xmlComment').value,
    coordSystem: $('xmlCrs').value, bearing: rowAz > 180 ? rowAz - 360 : rowAz,
    workOrder: ll ? { ...ll, alt } : null, holes, checksum: $('xmlChk').checked,
  });
  const fname = ($('xmlName').value || 'plan').replace(/[^\w.-]+/g, '_') + '_iredes.xml';
  showData(`Plan wierceń IREDES (${holes.length} otworów, kolejność N, E, H)`, xml, { filename: fname, mime: 'application/xml' });
  status(ll ? 'Plan XML gotowy: pobrano plik albo skopiuj tekst poniżej.' : 'Plan XML gotowy. Współrzędne poza PL-2000: pole WorkOrder zostało puste.');
}

// ---------- zapis i odczyt projektu ----------
const realOf = (p) => [p.x + state.center.x + num('offX'), p.y + state.center.y + num('offY'), p.z + zShift()];
const localOf = (p) => ({ ...p, x: p.x - state.center.x - num('offX'), y: p.y - state.center.y - num('offY'), z: p.z - zShift() });

function projectToJson() {
  const R = (p) => { const [x, y, z] = realOf(p); return { ...p, x, y, z }; };
  return JSON.stringify({
    app: 'projekt-wiercen', version: 1, savedAt: new Date().toISOString(),
    offset: { x: num('offX'), y: num('offY'), z: num('offZ') },
    modelCenter: realOf({ x: 0, y: 0, z: 0 }),
    pattern: readPattern(), types: state.types, editType: state.editType, products: state.products,
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
  for (const k of ['normal', 'profile']) state.types[k] = { ...defaultType(), ...d.types?.[k], template: d.types?.[k]?.template ?? defaultTemplate() };
  state.editType = d.editType === 'profile' ? 'profile' : 'normal';
  if (Array.isArray(d.products) && d.products.length) { state.products = d.products; saveProducts(); }
  for (const [k, v] of Object.entries(d.pattern ?? {})) { const e = $(k === 'stagger' ? 'stagger' : k); if (e) { if (k === 'stagger') e.checked = v; else e.value = v; } }
  for (const [k, v] of Object.entries(d.xml ?? {})) if ($(k)) $(k).value = v;
  state.polygon = (d.polygon ?? []).map(localOf);
  state.closed = !!d.closed;
  state.grid = (d.grid ?? []).map(localOf);
  state.manual = (d.manual ?? []).map(localOf);
  state.profile = null; state.profA = null;
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
  const markerHit = ['del', 'type', 'prof'].includes(state.mode) && state.markers ? pick(e, state.markers, false) : null;
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
  if (state.mode === 'prof' && markerHit) { openProfileForHole(state.holes[markerHit.instanceId]); return; }
  const hit = pick(e, state.model);
  if (!hit) return;
  const pt = world.worldToLocal(hit.point.clone());
  if (state.mode === 'poly') {
    if (state.closed) { state.closed = false; state.polygon = []; state.grid = []; }
    state.polygon.push({ x: pt.x, y: pt.y, z: pt.z });
    status(`Obrys: ${state.polygon.length} pkt. ${state.polygon.length >= 3 ? 'Kliknij „Zamknij obrys”.' : ''}`);
  } else if (state.mode === 'hole') {
    state.manual.push({ x: pt.x, y: pt.y, z: pt.z, type: $('newType').value });
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
}

// Model przykładowy: ława z obrysem i siatką, żeby od razu było widać działanie.
async function loadSample(withDesign = true) {
  try {
    let blob;
    if (window.__SAMPLE_OBJ__) blob = new Blob([window.__SAMPLE_OBJ__]); // wersja osadzona (np. Streamlit)
    else {
      const res = await fetch('samples/lawa-testowa.obj');
      if (!res.ok) throw new Error(res.status);
      blob = await res.blob();
    }
    await loadFiles([new File([blob], 'lawa-testowa.obj')]);
  } catch (e) { return status('Nie udało się wczytać modelu przykładowego.'); }
  if (!withDesign) return;
  const { size } = state;
  const at = (fx, fy) => { const x = (fx - 0.5) * size.x, y = (fy - 0.5) * size.y; return { x, y, z: sampleZ(x, y) ?? 0 }; };
  state.polygon = [at(0.1, 0.15), at(0.5, 0.15), at(0.5, 0.8), at(0.1, 0.8)];
  state.closed = true;
  generate();
  // przykład: rząd od strony skarpy (wschód) jako otwory profilowe, pochylone w stronę skarpy
  const last = Math.max(...state.grid.map((g) => g.row));
  state.grid.forEach((g) => { if (g.row === last) g.type = 'profile'; });
  Object.assign(state.types.profile, { incl: 12, inclAz: 90 });
  typeToInputs();
  update();
  status(`Przykład: syntetyczna ława, ${state.holes.length} otworów, ostatni rząd (zielone) oznaczono jako profilowe. Wczytaj własny model OBJ w kroku 1.`);
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
$('ctrlCompare').onclick = () => showProbe(true);
$('loadSample').onclick = () => loadSample();
$('addCharge').onclick = () => { state.types[state.editType].template.push({ kind: 'charge', productId: state.products[0]?.id ?? '', length: 1 }); renderTemplate(); update(); };
$('addDeck').onclick = () => { state.types[state.editType].template.push({ kind: 'deck', length: 0.3 }); renderTemplate(); update(); };
$('copyTpl').onclick = () => {
  const other = state.editType === 'normal' ? 'profile' : 'normal';
  state.types[other].template = clone(state.types[state.editType].template);
  update();
  status(`Szablon ładunku skopiowano do typu: ${TYPE_NAME[other].toLowerCase()}.`);
};
$('dbAdd').onclick = () => { state.products.push({ id: newProductId(), name: 'Nowy produkt', kind: 'bulk', density: 1, color: '#34d399' }); saveProducts(); renderDb(); renderTemplate(); };
$('dbReset').onclick = () => { state.products = clone(DEFAULT_PRODUCTS); saveProducts(); renderDb(); renderTemplate(); update(); };
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
  if (el.closest('#tplRows, #dbRows, #profile')) continue;
  el.addEventListener('input', () => {
    if (el.hasAttribute('data-type')) inputsToType();
    if (el.hasAttribute('data-regen') && state.closed) generate(); else update();
  });
}
$('files').addEventListener('change', (e) => loadFiles(e.target.files));
window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.mode === 'poly' && e.target === document.body) closePolygon(); });

const view = $('view');
view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragging'); });
view.addEventListener('dragleave', () => view.classList.remove('dragging'));
view.addEventListener('drop', (e) => { e.preventDefault(); view.classList.remove('dragging'); loadFiles(e.dataTransfer.files); });

typeToInputs();
renderDb();
renderStats();
loadSample();

// pomocnik do testów: położenie otworu na ekranie (piksele względem okna)
function holeScreenPos(h) {
  const v = world.localToWorld(new THREE.Vector3(h.x, h.y, h.z + state.markerSize * 0.3)).project(camera);
  const r = canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}

// do testów w przeglądarce
window.__app = { holeScreenPos, state, loadFiles, generate, closePolygon, loadSample, update, exportXml, exportCsv, projectToJson, loadProjectFromText, renderProfile, openProfileForHole };
