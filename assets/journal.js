// 本子页面：只读渲染 + 逐字手写抖动 + 简笔画/照片跟着句子。
// 文本一律 textContent；SVG 只从已净化的 entries 取，并按白名单重建 DOM。

const NS = 'http://www.w3.org/2000/svg';
const ALLOWED_TAGS = new Set(['path', 'circle', 'line', 'polyline', 'polygon', 'ellipse']);
const ALLOWED_ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'transform', 'opacity'
]);

const sheet = document.getElementById('sheet');
const dateEl = document.getElementById('date');
const noteEl = document.getElementById('note');
const prevEl = document.getElementById('prev');
const nextEl = document.getElementById('next');
const scopeEl = document.getElementById('scope');
const pickerEl = document.getElementById('picker');

const state = { scope: '', date: '', days: [], allDays: [] };

function seedOf(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(text, seed, strength = 0.72) {
  const random = rng(seed);
  const fragment = document.createDocumentFragment();
  for (const ch of text) {
    if (ch === '\n') {
      fragment.append(document.createElement('br'));
      continue;
    }
    const span = document.createElement('span');
    const rotate = (random() * 14 - 7) * strength;
    const dy = (random() * 7 - 3.5) * strength;
    const scale = 1 + (random() * 0.16 - 0.08) * strength;
    span.style.transform = `rotate(${rotate.toFixed(2)}deg) translateY(${dy.toFixed(2)}px) scale(${scale.toFixed(3)})`;
    span.style.opacity = (0.86 + random() * 0.14).toFixed(2);
    span.textContent = ch;
    fragment.append(span);
  }
  return fragment;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMERIC_ATTRS = new Set(['cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2']);
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;
const POINTS = /^[0-9.,\s-]+$/;
const TRANSFORM = /^(?:translate|rotate|scale)\([0-9.,\s-]+\)(?:\s+(?:translate|rotate|scale)\([0-9.,\s-]+\))*$/;

function attrValueOk(name, value) {
  if (name === 'd') return PATH_DATA.test(value);
  if (name === 'points') return POINTS.test(value);
  if (name === 'fill') return value === 'none' || HEX_COLOR.test(value);
  if (name === 'stroke') return value === 'currentColor' || HEX_COLOR.test(value);
  if (name === 'stroke-width') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0.5 && n <= 3;
  }
  if (name === 'stroke-linecap') return ['butt', 'round', 'square'].includes(value);
  if (name === 'stroke-linejoin') return ['miter', 'round', 'bevel'].includes(value);
  if (name === 'transform') return TRANSFORM.test(value);
  if (name === 'opacity') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1;
  }
  if (NUMERIC_ATTRS.has(name)) return /^-?\d+(?:\.\d+)?$/.test(value);
  return false;
}

function buildDoodle(doodle) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(`<svg xmlns="${NS}">${doodle.svg}</svg>`, 'image/svg+xml');
  } catch {
    return null;
  }
  if (doc.querySelector('parsererror')) return null;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 80');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  for (const child of [...doc.documentElement.children]) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return null;
    const el = document.createElementNS(NS, tag);
    for (const attr of [...child.attributes]) {
      if (!ALLOWED_ATTRS.has(attr.name)) return null;
      if (!attrValueOk(attr.name, attr.value)) return null;
      el.setAttribute(attr.name, attr.value);
    }
    svg.append(el);
  }
  return svg.childElementCount ? svg : null;
}

function doodleNode(doodle) {
  const svg = buildDoodle(doodle);
  if (!svg) return null;
  const span = document.createElement('span');
  span.className = `doodle side-${doodle.side || 'right'}`;
  span.append(svg);
  return span;
}

function photoNode(photo) {
  if (!photo || typeof photo !== 'object') return null;
  const rel = String(photo.file || '').replace(/^media\//, '');
  if (!rel) return null;
  let src;
  try {
    src = `/journal/media/${encodeURI(rel)}`;
  } catch {
    return null;
  }
  const figure = document.createElement('figure');
  figure.className = `photo side-${photo.side || 'right'}`;
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  const captionText = typeof photo.caption === 'string' ? photo.caption : '';
  const caption = document.createElement('figcaption');
  caption.textContent = captionText;
  figure.append(img);
  if (captionText) figure.append(caption);
  return figure;
}

function renderText(entry) {
  const text = typeof entry.text === 'string' ? entry.text : '';
  const seed = seedOf(entry.id || text);
  const paragraph = document.createElement('p');
  paragraph.className = 'text';

  const inserts = [];
  if (typeof entry.doodle?.anchor === 'string' && entry.doodle.anchor) {
    const index = text.indexOf(entry.doodle.anchor);
    if (index >= 0) {
      const node = doodleNode(entry.doodle);
      if (node) {
        const at = entry.doodle.side === 'inline' ? index + entry.doodle.anchor.length : index;
        inserts.push({ at, node });
      }
    }
  }
  for (const photo of Array.isArray(entry.photos) ? entry.photos : []) {
    if (!photo || typeof photo !== 'object') continue;
    const anchor = typeof photo.anchor === 'string' ? photo.anchor : '';
    if (!anchor) continue;
    const index = text.indexOf(anchor);
    if (index < 0) continue;
    const node = photoNode(photo);
    if (!node) continue;
    const at = photo.side === 'inline' ? index + anchor.length : index;
    inserts.push({ at, node });
  }

  inserts.sort((a, b) => a.at - b.at);
  let cursor = 0;
  for (const insert of inserts) {
    if (insert.at > cursor) paragraph.append(jitter(text.slice(cursor, insert.at), seed + cursor));
    paragraph.append(insert.node);
    cursor = insert.at;
  }
  if (cursor < text.length) paragraph.append(jitter(text.slice(cursor), seed + cursor));
  if (paragraph.childNodes.length === 0) paragraph.append(jitter(text, seed));
  return paragraph;
}

function renderEntry(entry) {
  const section = document.createElement('section');
  section.className = 'entry';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${entry.scope}${entry.mood ? ` · ${entry.mood}` : ''}`;
  section.append(meta, renderText(entry));
  return section;
}

function formatDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : date || '';
}

function renderEmpty(message) {
  sheet.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  sheet.append(empty);
  dateEl.textContent = state.date ? formatDate(state.date) : '';
  noteEl.textContent = '';
  if (pickerEl) pickerEl.value = state.date || '';
  document.title = '本子';
}

function updateNav() {
  const index = state.days.findIndex((day) => day.date === state.date);
  const suffix = state.scope ? `&scope=${encodeURIComponent(state.scope)}` : '';
  const prev = index > 0 ? state.days[index - 1].date : '';
  const next = index >= 0 && index < state.days.length - 1 ? state.days[index + 1].date : '';
  prevEl.href = prev ? `?date=${prev}${suffix}` : '#';
  nextEl.href = next ? `?date=${next}${suffix}` : '#';
  prevEl.classList.toggle('disabled', !prev);
  nextEl.classList.toggle('disabled', !next);
}

function fillScopes() {
  const scopes = new Set();
  for (const day of state.allDays) for (const scope of day.scopes || []) scopes.add(scope);
  scopeEl.replaceChildren(new Option('全部', ''));
  for (const scope of [...scopes].sort()) scopeEl.append(new Option(scope, scope));
  scopeEl.value = state.scope;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function postPeek(date) {
  fetch('/journal/api/peek', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date, scope: state.scope || 'all' })
  }).catch(() => {});
}

async function loadDay(date) {
  state.date = date;
  const query = new URLSearchParams({ date });
  if (state.scope) query.set('scope', state.scope);
  const day = await getJson(`/journal/api/day?${query.toString()}`);

  postPeek(date);
  if (pickerEl) pickerEl.value = date;

  sheet.replaceChildren();
  if (!day.entries.length) {
    renderEmpty('这一天没有日记。');
    updateNav();
    return;
  }
  for (const entry of day.entries) {
    try {
      sheet.append(renderEntry(entry));
    } catch {
      const broken = document.createElement('section');
      broken.className = 'entry';
      broken.textContent = '（这条日记读不出来）';
      sheet.append(broken);
    }
  }

  dateEl.textContent = formatDate(date);
  const scopes = [...new Set(day.entries.map((entry) => entry.scope))];
  noteEl.textContent = `${day.entries.length} 条 · ${scopes.join(' / ')}`;
  document.title = `${formatDate(date)} · 本子`;
  updateNav();
}

async function refreshDays() {
  const query = new URLSearchParams({ limit: '365' });
  if (state.scope) query.set('scope', state.scope);
  state.days = (await getJson(`/journal/api/days?${query.toString()}`)).days || [];
}

async function boot() {
  const params = new URLSearchParams(location.search);
  state.scope = params.get('scope') || '';
  state.allDays = (await getJson('/journal/api/days?limit=365')).days || [];
  fillScopes();
  await refreshDays();

  const wanted = params.get('date');
  state.date = wanted || state.days[0]?.date || '';
  if (state.date) await loadDay(state.date);
  else renderEmpty('还没有日记。');
}

prevEl.addEventListener('click', (event) => {
  if (prevEl.classList.contains('disabled')) event.preventDefault();
});

scopeEl.addEventListener('change', async () => {
  state.scope = scopeEl.value;
  await refreshDays();
  state.date = state.days[0]?.date || '';
  const params = new URLSearchParams();
  if (state.date) params.set('date', state.date);
  if (state.scope) params.set('scope', state.scope);
  history.replaceState(null, '', `?${params.toString()}`);
  if (state.date) await loadDay(state.date);
  else renderEmpty('还没有日记。');
});

pickerEl?.addEventListener('change', () => {
  if (!pickerEl.value) return;
  const params = new URLSearchParams({ date: pickerEl.value });
  if (state.scope) params.set('scope', state.scope);
  location.href = `?${params.toString()}`;
});

boot().catch((error) => renderEmpty(`页面加载失败：${error.message}`));
