// Sieć strzałowa nieelektryczna: łączniki powierzchniowe między otworami i opóźnienie w otworze.
// Czas odpalenia otworu = czas dojścia sygnału do otworu (suma łączników od punktu inicjacji) + opóźnienie w otworze.
// links: [{ from, to, ms }] (from/to = HoleId; każdy otwór ma najwyżej jedno połączenie wchodzące), starts: [HoleId].

export function computeTiming(holeIds, links, starts, inholeMs) {
  const signal = new Map();
  const out = new Map();
  for (const l of links) { if (!out.has(l.from)) out.set(l.from, []); out.get(l.from).push(l); }
  const queue = [];
  for (const s of starts) if (holeIds.includes(s) && !signal.has(s)) { signal.set(s, 0); queue.push(s); }
  while (queue.length) {
    const id = queue.shift();
    for (const l of out.get(id) ?? []) {
      if (signal.has(l.to) || !holeIds.includes(l.to)) continue; // jedno połączenie wchodzące: pierwsze wygrywa
      signal.set(l.to, signal.get(id) + l.ms);
      queue.push(l.to);
    }
  }
  const time = new Map();
  for (const [id, s] of signal) time.set(id, s + (typeof inholeMs === 'function' ? inholeMs(id) : inholeMs));
  const unreachable = holeIds.filter((id) => !signal.has(id));
  const totalMs = time.size ? Math.max(...time.values()) : 0;
  return { signal, time, unreachable, totalMs };
}

// Największy ładunek odpalany w oknie windowMs (kryterium „ładunek na opóźnienie”, zwykle 8 ms).
export function maxChargeInWindow(items, windowMs) {
  const s = [...items].sort((a, b) => a.t - b.t);
  let best = 0, sum = 0, lo = 0, at = 0;
  for (let hi = 0; hi < s.length; hi++) {
    sum += s[hi].mass;
    while (s[hi].t - s[lo].t > windowMs) sum -= s[lo++].mass;
    if (sum > best) { best = sum; at = s[lo].t; }
  }
  return { mass: best, at };
}

// Grupy o tym samym czasie odpalenia (tolerancja tolMs) do wykresu ładunku na opóźnienie.
export function groupByTime(items, tolMs = 0.5) {
  const s = [...items].sort((a, b) => a.t - b.t);
  const groups = [];
  for (const it of s) {
    const g = groups.at(-1);
    if (g && it.t - g.t <= tolMs) { g.mass += it.mass; g.count++; } else groups.push({ t: it.t, mass: it.mass, count: 1 });
  }
  return groups;
}

// Automatyczna sieć dla siatki (otwory z polami row i u). pattern:
//   'rows': rząd po rzędzie, w rzędzie kolejno (alongMs), rzędy łączone od początku rzędu (betweenMs); inicjacja na początku pierwszego rzędu;
//   'V': od środka pierwszego rzędu na zewnątrz (alongMs), kolejne rzędy od najbliższego otworu poprzedniego rzędu (betweenMs).
export function autoNetwork(holes, { pattern = 'rows', alongMs = 17, betweenMs = 42 } = {}) {
  const rows = new Map();
  for (const h of holes) { if (h.row == null) continue; if (!rows.has(h.row)) rows.set(h.row, []); rows.get(h.row).push(h); }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  for (const k of keys) rows.get(k).sort((a, b) => a.u - b.u);
  const links = [], starts = [];
  if (!keys.length) return { links, starts };
  const first = rows.get(keys[0]);
  const nearest = (row, u) => row.reduce((b, h) => (Math.abs(h.u - u) < Math.abs(b.u - u) ? h : b));
  if (pattern === 'V') {
    const mid = Math.floor((first.length - 1) / 2);
    starts.push(first[mid].id);
    for (let i = mid; i > 0; i--) links.push({ from: first[i].id, to: first[i - 1].id, ms: alongMs });
    for (let i = mid; i < first.length - 1; i++) links.push({ from: first[i].id, to: first[i + 1].id, ms: alongMs });
    for (let r = 1; r < keys.length; r++) {
      const prev = rows.get(keys[r - 1]);
      for (const h of rows.get(keys[r])) links.push({ from: nearest(prev, h.u).id, to: h.id, ms: betweenMs });
    }
  } else {
    starts.push(first[0].id);
    keys.forEach((k, r) => {
      const row = rows.get(k);
      for (let i = 0; i < row.length - 1; i++) links.push({ from: row[i].id, to: row[i + 1].id, ms: alongMs });
      if (r > 0) links.push({ from: rows.get(keys[r - 1])[0].id, to: row[0].id, ms: betweenMs });
    });
  }
  return { links, starts };
}
