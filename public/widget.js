'use strict';

// IFC-egenskaper: pick IFC files, list their property sets and properties, and show the
// unique values of a property per file.
//
// Files: REST ifc-files (document id + layer) for the current building, names from documents/{id}.
// Data: getObjectInfoForSearch with a rule on "@Document Id" (one search per file) and
// fieldUnion: true, which returns every "Pset~Property" column for the matching objects.
// All data from StreamBIM is treated as untrusted and only ever rendered as text.

const PAGE_SIZE = 1000;           // getObjectInfoForSearch default; larger pages with all columns can fail
const MAX_VALUE_ROWS = 1000;      // rows rendered in the values table
const ATTR = '';                  // internal key for columns without a property set
const ATTR_LABEL = 'Objektattribut (utan property set)';
const IGNORED_COLUMNS = new Set(['Link']); // synthetic viewer URL, not an IFC property
const FILE_COLORS = ['#4077ce', '#f2921c', '#2f8f4e', '#9b4dca', '#d14343', '#0e8a96', '#8a6d3b', '#c2417f', '#5e677b', '#6b8e23'];

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('sv-SE');
const collator = new Intl.Collator('sv', { numeric: true, sensitivity: 'base' });

let api = null;
let projectId = null;
let buildingId = null;
let layerNames = new Set(); // viewer layers, for the fallback search
let files = [];             // { id: documentId, name: filename, layer } in the building
let selected = [];          // file objects, in the order they were picked
const cache = new Map();    // document id -> Promise<FileData>
const expanded = new Set(); // open pset names
let loadToken = 0;
let merged = null;          // Map pset -> Map prop -> { files: Map fileIdx -> Map value -> count }
let openProp = null;        // { pset, prop } shown in the sheet

/* ---------- helpers ---------- */

function errorText(err) {
  if (!err) return 'Okänt fel';
  if (err.message) return err.message;
  if (typeof err === 'object') return err.debug || err.detail || JSON.stringify(err);
  return String(err);
}

function showError(err) {
  $('error').hidden = false;
  $('error').textContent = 'Fel: ' + errorText(err);
}
window.addEventListener('unhandledrejection', (e) => showError(e.reason));

function setStatus(text, mode) {
  $('status').textContent = text;
  $('status').dataset.mode = mode;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fileTag(idx, on = true) {
  const tag = el('span', on ? 'tag' : 'tag off', String(idx + 1));
  tag.style.setProperty('--c', FILE_COLORS[idx % FILE_COLORS.length]);
  tag.title = (on ? 'Finns i ' : 'Saknas i ') + selected[idx].name;
  return tag;
}

function fileTags(present) {
  const wrap = el('span', 'tags');
  if (selected.length < 2) return wrap; // tags only matter when comparing files
  selected.forEach((_, idx) => wrap.append(fileTag(idx, present.has(idx))));
  return wrap;
}

// Pset keys are "name" or "origin\u0000name" (IfcProject/IfcSite, see SEP).
const psetOrigin = (pset) => (pset.includes('\u0000') ? pset.split('\u0000')[0] : '');
const psetName = (pset) => (pset.includes('\u0000') ? pset.slice(pset.indexOf('\u0000') + 1) : pset);
function psetLabel(pset) {
  const name = psetName(pset);
  if (name !== ATTR) return name;
  return psetOrigin(pset) ? 'Attribut' : ATTR_LABEL;
}
// IfcProject first, then IfcSite, then object attributes, then the rest alphabetically.
function psetRank(pset) {
  const origin = psetOrigin(pset);
  if (origin === 'IfcProject') return 0;
  if (origin === 'IfcSite') return 1;
  return pset === ATTR ? 2 : 3;
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

// findObjects/searches occasionally reject a valid query with { code: "unknown" }: retry once.
async function retryOnce(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code === 'unknown') return fn();
    throw err;
  }
}

// REST through the StreamBIM page (signed in as the current user). Responses come back as text.
async function rest(path, { method = 'GET', body, contentType } = {}) {
  const opts = { url: path, method };
  if (body !== undefined) opts.body = body;
  if (contentType) opts.contentType = contentType;
  let text;
  try {
    text = await api.makeApiRequest(opts);
  } catch (err) {
    if (/could not be cloned/i.test(errorText(err))) throw new Error(`${method} ${path} misslyckades (HTTP-fel)`);
    throw err;
  }
  return typeof text === 'string' ? JSON.parse(text) : text;
}

/* ---------- files ---------- */

const stem = (filename) => filename.replace(/\.ifc(zip|xml)?$/i, '');

async function loadFileList() {
  const base = `/project-${encodeURIComponent(projectId)}/api/v1/v2`;
  const res = await rest(`${base}/ifc-files?filter[building]=${encodeURIComponent(buildingId)}`);
  const records = (Array.isArray(res && res.data) ? res.data : [])
    .filter((r) => r && r.attributes && !r.attributes['marked-for-deletion'])
    .map((r) => ({
      id: String(r.relationships?.document?.data?.id ?? ''),
      layer: String(r.attributes.layer ?? ''),
    }))
    .filter((r) => /^\d+$/.test(r.id));

  const unique = [...new Map(records.map((r) => [r.id, r])).values()];
  return Promise.all(unique.map(async (r) => {
    let name = `Dokument ${r.id}`;
    try {
      const doc = await rest(`${base}/documents/${r.id}`);
      if (doc?.data?.attributes?.filename) name = String(doc.data.attributes.filename);
    } catch { /* keep the fallback name */ }
    return { ...r, name };
  }));
}

/* ---------- loading ---------- */

// How the properties are read (complete: every property of every object):
// 1. REST: POST ifc-searches, then GET ifc-searches/export/json?fieldUnion=true WITHOUT fieldNames.
//    That is what getObjectInfoForSearch does in the host, and it returns every column. The page
//    size is halved when a page fails or times out.
// 2. Fallback: getObjectInfo for every object, CONCURRENCY at a time.
const EXPORT_PAGE_START = 1000;
const EXPORT_PAGE_MIN = 50;
const EXPORT_TIMEOUT_MS = 90000;
const OBJECT_TIMEOUT_MS = 20000;
const CONCURRENCY = 16;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: inget svar på ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// rules: Rule[][] (outer = OR, inner = AND); buildingId is added to every rule.
async function createSearch(rules) {
  const created = await withTimeout(rest(`/project-${encodeURIComponent(projectId)}/api/v1/ifc-searches`, {
    method: 'POST',
    contentType: 'application/json',
    body: { rules: rules.map((and) => and.map((rule) => ({ buildingId, ...rule }))) },
  }), EXPORT_TIMEOUT_MS, 'Sökningen');
  if (!created || !created.searchId) throw new Error('Sökningen gav inget searchId');
  return String(created.searchId);
}

// Calls onRows(rows, header, objectsSoFar) for every page. Halves the page size on failure.
async function exportAll(searchId, onRows) {
  const base = `/project-${encodeURIComponent(projectId)}/api/v1/ifc-searches/export/json`;
  let size = EXPORT_PAGE_START;
  for (let skip = 0; ;) {
    let res;
    try {
      res = await withTimeout(
        rest(`${base}?searchId=${encodeURIComponent(searchId)}&fieldUnion=true&page[limit]=${size}&page[skip]=${skip}`),
        EXPORT_TIMEOUT_MS, 'Exporten');
    } catch (err) {
      if (size <= EXPORT_PAGE_MIN) throw err;
      size = Math.max(EXPORT_PAGE_MIN, Math.floor(size / 2));
      continue;
    }
    const rows = Array.isArray(res && res.data) ? res.data : [];
    const header = Array.isArray(res && res.header) ? res.header : [];
    onRows(rows, header, skip + rows.length);
    if (rows.length < size) return;
    skip += rows.length;
  }
}

// Viewer bookkeeping in getObjectInfo().properties that is not an IFC property.
const SKIP_INFO_KEYS = new Set(['groups', 'BaseType', 'uri', 'Timestamp']);

async function objectRow(guid) {
  return rowFromInfo(await withTimeout(retryOnce(() => api.getObjectInfo(guid)), OBJECT_TIMEOUT_MS, `Objekt ${guid}`));
}

// getObjectInfo record -> row keyed like the export ("Pset~Prop", "IFC Type", …).
function rowFromInfo(info) {
  const row = {};
  for (const [key, value] of Object.entries((info && info.properties) || {})) {
    if (key === '@kind') row['IFC Type'] = value;
    else if (!key.startsWith('@') && !SKIP_INFO_KEYS.has(key)) row[key] = value;
  }
  return row;
}

// Runs fn over items, `limit` at a time. onDone(count) after each item.
async function mapLimit(items, limit, fn, onDone) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
      done += 1;
      if (onDone) onDone(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Ways to select the objects of one file, tried in order with a cheap findObjects probe.
// "@Document Id" is per file. A viewer layer is only used when no other file shares it.
function ruleCandidates(file) {
  const out = [
    { propKey: '@Document Id', propValue: file.id },
    { propKey: '@Document Id', propValue: Number(file.id) },
  ];
  const layerUsers = (name) => files.filter((f) => f.layer === name || stem(f.name) === name).length;
  for (const layer of new Set([stem(file.name), file.layer])) {
    if (layer && layerNames.has(layer) && layerUsers(layer) === 1) out.push({ propKey: '@Group Layer', propValue: layer });
  }
  return out;
}

async function fileRule(file) {
  const tried = [];
  for (const rule of ruleCandidates(file)) {
    const label = `${rule.propKey} = ${JSON.stringify(rule.propValue)}`;
    try {
      const hits = await withTimeout(retryOnce(() => api.findObjects({ rules: [[{ buildingId, ...rule }]], limit: 1 })),
        OBJECT_TIMEOUT_MS, 'Sökningen');
      if (Array.isArray(hits) && hits.length) return rule;
      tried.push(`${label}: 0 objekt`);
    } catch (err) {
      tried.push(`${label}: ${errorText(err)}`);
    }
  }
  throw new Error(`Hittade inga objekt för ${file.name}.\nProvade:\n- ${tried.join('\n- ')}`);
}

/* ---------- IfcProject / IfcSite ---------- */

// Their property sets are not on ordinary objects. They are kept apart under an origin, as
// "origin\u0000psetName" keys, so the list can label them.
const SEP = '\u0000';

function spatialOrigin(kind) {
  const k = String(kind ?? '').trim();
  if (/^(ifc)?\s*project$/i.test(k)) return 'IfcProject';
  if (/^(ifc)?\s*site$/i.test(k)) return 'IfcSite';
  return '';
}

// All IfcProject/IfcSite objects in the building, loaded once:
// { items: [{ guid, info, row }], error }. getObjectInfo (info) only has the node's own
// attributes and tells which file it belongs to. The property sets (row) come from the REST
// export, searched by GUID, like for ordinary objects.
let spatialPromise = null;

function loadSpatial() {
  if (spatialPromise) return spatialPromise;
  spatialPromise = (async () => {
    let kinds = [];
    try {
      const counts = await withTimeout(api.valuesForObjectProperty('@kind'), EXPORT_TIMEOUT_MS, 'IFC-klasserna');
      kinds = Object.keys(counts || {}).filter(spatialOrigin);
    } catch (err) {
      console.warn('valuesForObjectProperty(@kind) misslyckades:', err);
    }
    if (!kinds.length) kinds = ['Project', 'Site'];

    const out = [];
    for (const kind of kinds) {
      let guids = [];
      try {
        guids = await withTimeout(retryOnce(() => api.findObjects({
          rules: [[{ buildingId, propKey: '@kind', propValue: kind }]], limit: 10000,
        })), OBJECT_TIMEOUT_MS, `Sökningen efter ${kind}`);
      } catch (err) {
        console.warn(`Sökningen efter ${kind} misslyckades:`, err);
      }
      await mapLimit(Array.isArray(guids) ? guids : [], CONCURRENCY, async (guid) => {
        try {
          const info = await withTimeout(retryOnce(() => api.getObjectInfo(guid)), OBJECT_TIMEOUT_MS, `Objekt ${guid}`);
          out.push({ guid, info });
        } catch (err) {
          console.warn(`Kunde inte läsa ${kind} ${guid}:`, err);
        }
      });
    }
    if (!out.length) return { items: out, error: null };

    // Property sets of these nodes: one search (GUID = a OR GUID = b …), all columns.
    let error = null;
    try {
      const byGuid = new Map();
      const searchId = await createSearch(out.map(({ guid }) => [{ propKey: 'GUID', propValue: guid }]));
      await exportAll(searchId, (rows) => {
        for (const row of rows) if (row && row.GUID) byGuid.set(row.GUID, row);
      });
      for (const item of out) item.row = byGuid.get(item.guid) || null;
      if (out.every((item) => !item.row)) error = new Error('exporten gav inga rader för dem');
    } catch (err) {
      error = err;
    }
    return { items: out, error };
  })();
  // Try again next time if nothing could be read.
  spatialPromise.then(({ items, error }) => { if (!items.length || error) spatialPromise = null; });
  return spatialPromise;
}

function belongsToFile(info, file) {
  const props = (info && info.properties) || {};
  if (props['@Document Id'] !== undefined && props['@Document Id'] !== null) return String(props['@Document Id']) === file.id;
  const layer = props['@Group Layer'];
  return Boolean(layer) && (layer === file.layer || layer === stem(file.name))
    && files.filter((f) => f.layer === layer || stem(f.name) === layer).length === 1;
}

// FileData: { objects, psets: Map pset -> Map prop -> Map value -> count, skipped }
async function fetchFile(file, onProgress) {
  const psets = new Map();
  const column = (key, origin = '') => {
    if (IGNORED_COLUMNS.has(key)) return null;
    const cut = key.indexOf('~');
    const name = cut > 0 ? key.slice(0, cut) : ATTR;
    const pset = origin ? origin + SEP + name : name;
    const prop = cut > 0 ? key.slice(cut + 1) : key;
    if (!psets.has(pset)) psets.set(pset, new Map());
    const props = psets.get(pset);
    if (!props.has(prop)) props.set(prop, new Map());
    return props.get(prop);
  };
  const spatialSeen = new Set(); // GUIDs of IfcProject/IfcSite already counted
  const add = (row, guid, forcedOrigin) => {
    if (!row || typeof row !== 'object') return;
    const origin = forcedOrigin || spatialOrigin(row['IFC Type']);
    if (origin) {
      const id = guid || row.GUID || row['Global Id'];
      if (id && spatialSeen.has(id)) return;
      if (id) spatialSeen.add(id);
    }
    for (const [key, raw] of Object.entries(row)) {
      const values = column(key, origin);
      const value = valueText(raw);
      if (!values || value === '') continue;
      values.set(value, (values.get(value) || 0) + 1);
    }
  };
  // Returns a warning text when this file's IfcProject/IfcSite property sets could not be read.
  const addSpatial = async () => {
    progress('hämtar IfcProject och IfcSite');
    const { items, error } = await loadSpatial();
    let missing = 0;
    for (const { guid, info, row } of items) {
      if (!belongsToFile(info, file)) continue;
      if (row) add(row, guid, spatialOrigin(info.properties && info.properties['@kind']));
      else missing += 1;
    }
    return missing ? `Property sets för IfcProject/IfcSite i ${file.name} kunde inte läsas: ${errorText(error)}` : '';
  };

  const started = Date.now();
  const progress = (text) => onProgress(`${text} (${Math.round((Date.now() - started) / 1000)} s)`);

  progress('söker objekt');
  const rule = await fileRule(file);

  // 1. REST export of all columns.
  let exportError;
  try {
    const searchId = await createSearch([[rule]]);
    let objects = 0;
    await exportAll(searchId, (rows, header, n) => {
      for (const h of header) if (h && typeof h.id === 'string') column(h.id);
      for (const row of rows) add(row);
      objects = n;
      progress(`läst ${nf.format(n)} objekt`);
    });
    if (objects && [...psets.keys()].some((p) => p !== ATTR)) {
      const warning = await addSpatial();
      return { objects, psets, skipped: 0, warning };
    }
    exportError = new Error(objects ? 'exporten gav inga property sets' : 'exporten gav inga objekt');
  } catch (err) {
    exportError = err;
  }
  console.warn('REST-exporten räckte inte, läser objekt för objekt:', exportError);

  // 2. Every object with getObjectInfo.
  psets.clear();
  spatialSeen.clear();
  progress('hämtar objektlista');
  const guids = await withTimeout(
    retryOnce(() => api.findObjects({ rules: [[{ buildingId, ...rule }]], limit: 1000000 })),
    EXPORT_TIMEOUT_MS, 'Objektlistan');
  if (!Array.isArray(guids) || !guids.length) throw new Error(`Hittade inga objekt för ${file.name}. Filen kanske inte är konverterad än.`);
  let skipped = 0;
  await mapLimit(guids, CONCURRENCY, async (guid) => {
    try {
      add(await objectRow(guid), guid);
    } catch {
      skipped += 1;
    }
  }, (n) => progress(`läser objekt ${nf.format(n)} av ${nf.format(guids.length)}`));
  if (skipped === guids.length) throw new Error(`Kunde inte läsa några objekt i ${file.name}. Exporten: ${errorText(exportError)}`);
  // getObjectInfo only has the objects' own attributes. Without property sets the result is not
  // what the widget promises, so say so instead of showing a partial list.
  if (![...psets.keys()].some((p) => p !== ATTR)) {
    throw new Error(`Kunde inte läsa property sets för ${file.name}. Exporten: ${errorText(exportError)}`);
  }
  const warning = await addSpatial();
  return { objects: guids.length, psets, skipped, warning };
}

function loadFile(file, onProgress) {
  if (!cache.has(file.id)) {
    const p = fetchFile(file, onProgress);
    // Allow a retry on the next selection change when the read failed or was incomplete.
    p.then((data) => { if (data.skipped || data.warning) cache.delete(file.id); }, () => cache.delete(file.id));
    cache.set(file.id, p);
  }
  return cache.get(file.id);
}

async function refresh() {
  const token = ++loadToken;
  $('error').hidden = true;
  renderFiles(null);
  if (!selected.length) {
    merged = null;
    $('result').hidden = true;
    $('progress').hidden = true;
    $('empty').hidden = false;
    return;
  }
  $('empty').hidden = true;

  const loaded = [];
  try {
    for (const [i, file] of selected.entries()) {
      const label = `Läser ${file.name} (${i + 1}/${selected.length})`;
      if (token === loadToken) {
        $('progress').hidden = false;
        $('progress').textContent = label + '…';
      }
      loaded.push(await loadFile(file, (text) => {
        if (token === loadToken) $('progress').textContent = `${label}: ${text}…`;
      }));
    }
  } catch (err) {
    if (token === loadToken) {
      $('progress').hidden = true;
      showError(err);
    }
    return;
  }
  if (token !== loadToken) return; // the selection changed while loading

  $('progress').hidden = true;
  merged = mergeFiles(loaded);
  renderFiles(loaded);
  renderList();
  $('result').hidden = false;
  const warnings = loaded.map((data) => data.warning).filter(Boolean);
  if (warnings.length) {
    $('error').hidden = false;
    $('error').textContent = warnings.join('\n');
  }
}

function mergeFiles(loaded) {
  const out = new Map();
  loaded.forEach((file, idx) => {
    for (const [pset, props] of file.psets) {
      if (!out.has(pset)) out.set(pset, new Map());
      const target = out.get(pset);
      for (const [prop, values] of props) {
        if (!target.has(prop)) target.set(prop, { files: new Map() });
        target.get(prop).files.set(idx, values);
      }
    }
  });
  return out;
}

/* ---------- file picker ---------- */

const isSelected = (file) => selected.some((f) => f.id === file.id);

function visibleFiles() {
  const q = $('picker-filter').value.trim().toLowerCase();
  return files.filter((f) => f.name.toLowerCase().includes(q));
}

function pickerOpen(open) {
  $('picker-panel').hidden = !open;
  $('picker-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('picker-filter').value = '';
    renderPicker();
    $('picker-filter').focus();
  }
}

function renderPicker() {
  const items = visibleFiles().map((file) => {
    const li = el('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(isSelected(file)));
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = isSelected(file);
    box.addEventListener('change', () => toggleFile(file, box.checked));
    const name = el('span', 'file-name', file.name);
    const layer = el('span', 'file-layer', file.layer);
    label.title = `${file.name}\nLager: ${file.layer} · dokument ${file.id}`;
    label.append(box, name, layer);
    li.append(label);
    return li;
  });
  if (!items.length) items.push(el('li', 'none', files.length ? 'Inga filer matchar.' : 'Inga IFC-filer i projektet.'));
  $('picker-list').replaceChildren(...items);
}

function renderPickerLabel() {
  const label = $('picker-label');
  label.classList.toggle('placeholder', !selected.length);
  if (!selected.length) label.textContent = 'Välj IFC-filer…';
  else if (selected.length === 1) label.textContent = selected[0].name;
  else label.textContent = `${selected.length} filer valda`;
}

function toggleFile(file, on) {
  selected = selected.filter((f) => f.id !== file.id);
  if (on) selected.push(file);
  renderPickerLabel();
  refresh();
}

function setAll(on) {
  const visible = visibleFiles();
  if (on) visible.forEach((file) => { if (!isSelected(file)) selected.push(file); });
  else selected = selected.filter((f) => !visible.some((v) => v.id === f.id));
  renderPicker();
  renderPickerLabel();
  refresh();
}

/* ---------- rendering ---------- */

function renderFiles(loaded) {
  const list = $('files');
  list.hidden = !selected.length;
  list.replaceChildren(...selected.map((file, idx) => {
    const li = el('li');
    const data = loaded && loaded[idx];
    const tag = fileTag(idx);
    tag.title = file.name;
    const name = el('span', 'name', file.name);
    name.title = `${file.name}\nLager: ${file.layer}`;
    li.append(tag, name, el('span', 'count', data ? `${nf.format(data.objects)} objekt` : '…'));
    if (data && data.skipped) {
      const warn = el('span', 'warn', `${nf.format(data.skipped)} kunde inte läsas`);
      warn.title = 'Objekten svarade inte i tid. Välj filen igen för att försöka på nytt.';
      li.append(warn);
    }
    return li;
  }));
}

function highlight(text, q) {
  const frag = document.createDocumentFragment();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) {
    frag.append(text);
    return frag;
  }
  frag.append(text.slice(0, i), el('mark', '', text.slice(i, i + q.length)), text.slice(i + q.length));
  return frag;
}

function presentIn(prop) {
  return new Set(prop.files.keys());
}

function uniqueCount(prop) {
  const all = new Set();
  for (const values of prop.files.values()) for (const v of values.keys()) all.add(v);
  return all.size;
}

function renderList() {
  if (!merged) return;
  const q = $('search').value.trim().toLowerCase();
  const psetNames = [...merged.keys()].sort((a, b) => psetRank(a) - psetRank(b)
    || collator.compare(psetLabel(a), psetLabel(b)));

  let shownPsets = 0;
  let shownProps = 0;
  const rows = [];
  for (const pset of psetNames) {
    const props = merged.get(pset);
    const psetHit = !q || psetLabel(pset).toLowerCase().includes(q) || psetOrigin(pset).toLowerCase().includes(q);
    const propNames = [...props.keys()]
      .filter((name) => psetHit || name.toLowerCase().includes(q))
      .sort(collator.compare);
    if (!propNames.length) continue;
    shownPsets += 1;
    shownProps += propNames.length;

    const present = new Set();
    for (const prop of props.values()) for (const idx of prop.files.keys()) present.add(idx);

    const open = expanded.has(pset) || (q && !psetHit);
    const li = el('li', open ? 'pset open' : 'pset');
    const btn = el('button', 'row-btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(Boolean(open)));
    const label = el('span', 'label');
    if (psetOrigin(pset)) {
      const chip = el('span', 'origin', psetOrigin(pset));
      chip.title = `Property set kopplat till ${psetOrigin(pset)}, inte till byggdelar`;
      label.append(chip);
    }
    label.append(highlight(psetLabel(pset), q));
    btn.append(el('span', 'chev', '▸'), label, fileTags(present),
      el('span', 'meta', propNames.length === 1 ? '1 egenskap' : `${propNames.length} egenskaper`));
    btn.addEventListener('click', () => {
      if (expanded.has(pset)) expanded.delete(pset); else expanded.add(pset);
      renderList();
    });
    li.append(btn);

    if (open) {
      const ul = el('ul', 'props');
      for (const name of propNames) {
        const prop = props.get(name);
        const n = uniqueCount(prop);
        const pbtn = el('button', 'prop-btn');
        pbtn.type = 'button';
        pbtn.title = 'Visa unika värden';
        const plabel = el('span', 'label');
        plabel.append(highlight(name, q));
        pbtn.append(plabel, fileTags(presentIn(prop)), el('span', 'meta', n === 1 ? '1 värde' : `${nf.format(n)} värden`), el('span', 'open-hint', '›'));
        pbtn.addEventListener('click', () => openValues(pset, name));
        const pli = el('li');
        pli.append(pbtn);
        ul.append(pli);
      }
      li.append(ul);
    }
    rows.push(li);
  }

  if (!rows.length) rows.push(el('li', 'empty', q ? 'Inget matchar sökningen.' : 'Inga property sets hittades i de valda filerna.'));
  $('psets').replaceChildren(...rows);
  $('summary').textContent = `${nf.format(shownPsets)} property sets · ${nf.format(shownProps)} egenskaper`;}

/* ---------- values sheet ---------- */

function openValues(pset, prop) {
  openProp = { pset, prop };
  $('sheet-kicker').textContent = [psetOrigin(pset), psetLabel(pset)].filter(Boolean).join(' · ');
  $('sheet-title').textContent = prop;
  $('value-search').value = '';
  renderValues();
  $('sheet').hidden = false;
  $('value-search').focus();
}

function closeValues() {
  openProp = null;
  $('sheet').hidden = true;
}

function renderValues() {
  if (!openProp || !merged) return;
  const prop = merged.get(openProp.pset)?.get(openProp.prop);
  if (!prop) return closeValues();
  const multi = selected.length > 1;
  const q = $('value-search').value.trim().toLowerCase();

  // value -> counts per file index
  const table = new Map();
  for (const [idx, values] of prop.files) {
    for (const [value, count] of values) {
      if (!table.has(value)) table.set(value, new Array(selected.length).fill(0));
      table.get(value)[idx] = count;
    }
  }
  const total = (counts) => counts.reduce((a, b) => a + b, 0);
  const rows = [...table.entries()]
    .filter(([value]) => !q || value.toLowerCase().includes(q))
    .sort((a, b) => total(b[1]) - total(a[1]) || collator.compare(a[0], b[0]));

  const head = el('tr');
  head.append(el('th', '', 'Värde'));
  if (multi) {
    selected.forEach((file, idx) => {
      const th = el('th', 'num');
      th.append(fileTag(idx));
      th.title = file.name;
      head.append(th);
    });
  }
  head.append(el('th', 'num', multi ? 'Totalt' : 'Antal objekt'));
  $('values-head').replaceChildren(head);

  const body = rows.slice(0, MAX_VALUE_ROWS).map(([value, counts]) => {
    const tr = el('tr');
    const td = el('td', 'value');
    td.append(highlight(value, q));
    tr.append(td);
    if (multi) {
      counts.forEach((c, idx) => {
        const cell = el('td', c ? 'num' : 'num zero', c ? nf.format(c) : '–');
        cell.title = `${selected[idx].name}: ${nf.format(c)} objekt`;
        tr.append(cell);
      });
    }
    tr.append(el('td', 'num', nf.format(total(counts))));
    return tr;
  });
  if (!body.length) {
    const tr = el('tr');
    const td = el('td', 'muted', table.size ? 'Inga värden matchar.' : 'Egenskapen har inga ifyllda värden.');
    td.colSpan = multi ? selected.length + 2 : 2;
    tr.append(td);
    body.push(tr);
  }
  $('values-body').replaceChildren(...body);

  $('value-summary').textContent = `${nf.format(table.size)} unika värden`;
  const note = $('value-note');
  note.hidden = rows.length <= MAX_VALUE_ROWS;
  note.textContent = `Visar de ${nf.format(MAX_VALUE_ROWS)} vanligaste av ${nf.format(rows.length)} värden. Filtrera för att hitta fler.`;
}

/* ---------- events ---------- */

$('picker-btn').addEventListener('click', () => pickerOpen($('picker-panel').hidden));
$('picker-filter').addEventListener('input', renderPicker);
$('pick-all').addEventListener('click', () => setAll(true));
$('pick-none').addEventListener('click', () => setAll(false));
document.addEventListener('click', (e) => {
  if (!$('picker-panel').hidden && !$('picker').contains(e.target)) pickerOpen(false);
});
$('search').addEventListener('input', renderList);
$('value-search').addEventListener('input', renderValues);
$('sheet-close').addEventListener('click', closeValues);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeValues(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('sheet').hidden) closeValues();
  else if (!$('picker-panel').hidden) { pickerOpen(false); $('picker-btn').focus(); }
});

/* ---------- connection ---------- */

async function start(remote, mode) {
  api = remote;
  const [pId, bId, layerMap] = await Promise.all([api.getProjectId(), api.getBuildingId(), api.getLayers()]);
  projectId = String(pId);
  buildingId = String(bId);
  layerNames = new Set(Object.keys(layerMap || {}));
  setStatus(mode === 'mock' ? 'Testdata' : `Projekt ${projectId}`, mode);
  $('picker-label').textContent = 'Hämtar filer…';
  // Only .ifc files (the building can also hold point clouds, DWG, XML …).
  files = (await loadFileList())
    .filter((f) => /\.ifc$/i.test(f.name.trim()))
    .sort((a, b) => collator.compare(a.name, b.name));
  $('picker-btn').disabled = false;
  renderPickerLabel();
}

function fail(err) {
  setStatus('Ej ansluten', 'error');
  showError(err);
}

if (window.self === window.top) {
  // Opened directly in a browser: run against fake data so the UI can be tried out.
  start(window.IfcMock.createApi(), 'mock').catch(fail);
} else {
  // Connect to the StreamBIM page this widget is embedded in (penpal v7, verified pattern).
  const messenger = new Penpal.WindowMessenger({
    remoteWindow: window.parent,
    allowedOrigins: [location.ancestorOrigins?.[0] || /^https:\/\/([a-z0-9-]+\.)?streambim\.com$/],
  });
  Penpal.connect({ messenger, methods: {}, timeout: 20000 }).promise
    .then((remote) => start(remote, 'live'))
    .catch((err) => fail(new Error('Öppna sidan som widget i StreamBIM. (' + errorText(err) + ')')));
}
