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
const MAX_INLINE_VALUES = 40;     // values joined with " | " next to a property name
const ATTR = '';                  // internal key for columns without a property set
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

// Pset keys are "origin\u0000name": origin is IfcProject, IfcSite or IfcElement (ordinary objects).
// ATTR as name = the node's own attributes (Name, IFC Type …), not a property set.
const ELEMENT = 'IfcElement';
const psetOrigin = (pset) => (pset.includes('\u0000') ? pset.split('\u0000')[0] : '');
const psetName = (pset) => (pset.includes('\u0000') ? pset.slice(pset.indexOf('\u0000') + 1) : pset);
const isPropertySet = (pset) => psetName(pset) !== ATTR;
const psetLabel = (pset) => (isPropertySet(pset) ? psetName(pset) : 'Attribut');
// IfcProject, IfcSite, then IfcElement; within each, attributes first.
function psetRank(pset) {
  const origin = { IfcProject: 0, IfcSite: 1 }[psetOrigin(pset)] ?? 2;
  return origin * 2 + (isPropertySet(pset) ? 1 : 0);
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// findObjects/searches occasionally reject a valid query with { code: "unknown" }: retry once,
// after a short pause (fair use: back off instead of retrying at once).
async function retryOnce(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.code === 'unknown') {
      await sleep(1000);
      return fn();
    }
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
    let modified = null; // "last-modified" only (not the upload date)
    let labels = [];
    try {
      const doc = await rest(`${base}/documents/${r.id}`);
      const attrs = doc?.data?.attributes || {};
      if (attrs.filename) name = String(attrs.filename);
      const time = Date.parse(attrs['last-modified']);
      if (Number.isFinite(time)) modified = new Date(time);
      const rel = doc?.data?.relationships?.labels?.data;
      if (Array.isArray(rel)) labels = rel.map((l) => String(l && l.id)).filter((id) => /^\d+$/.test(id));
    } catch { /* keep the fallback name */ }
    // "M~E" = assigned to sublayers M and E.
    const layers = r.layer.split('~').map((s) => s.trim()).filter(Boolean);
    return { ...r, name, modified, labels, layers };
  }));
}

// Document labels as in StreamBIM's document panel: id -> { id, name, group }.
// Not essential: on failure the label filter is just left out.
async function loadLabels() {
  const base = `/project-${encodeURIComponent(projectId)}/api/v1/v2`;
  const out = new Map();
  try {
    const res = await rest(`${base}/document-labels`);
    for (const l of Array.isArray(res && res.data) ? res.data : []) {
      if (l && l.id && l.attributes && l.attributes.name) out.set(String(l.id), { id: String(l.id), name: String(l.attributes.name), group: '' });
    }
  } catch (err) {
    console.warn('Kunde inte hämta dokumentetiketter:', err);
    return out;
  }
  try {
    const res = await rest(`${base}/label-groups`);
    for (const g of Array.isArray(res && res.data) ? res.data : []) {
      const groupName = String(g?.attributes?.name ?? '');
      for (const ref of g?.relationships?.labels?.data || []) {
        const label = out.get(String(ref && ref.id));
        if (label) label.group = groupName;
      }
    }
  } catch (err) {
    console.warn('Kunde inte hämta etikettgrupper:', err);
  }
  return out;
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
const CONCURRENCY = 4; // fair use: at most a few requests at a time

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
// fields: optional column names (e.g. ['GUID']); without it every column is returned.
async function exportAll(searchId, onRows, fields) {
  const base = `/project-${encodeURIComponent(projectId)}/api/v1/ifc-searches/export/json`;
  const names = fields ? `&fieldNames=${encodeURIComponent(btoa(fields.join('|')))}` : '';
  let size = EXPORT_PAGE_START;
  let retries = 0;
  for (let skip = 0; ;) {
    let res;
    try {
      res = await withTimeout(
        rest(`${base}?searchId=${encodeURIComponent(searchId)}&fieldUnion=true${names}&page[limit]=${size}&page[skip]=${skip}`),
        EXPORT_TIMEOUT_MS, 'Exporten');
    } catch (err) {
      if (size <= EXPORT_PAGE_MIN) throw err;
      // Back off before retrying with a smaller page: 1 s, 2 s, 4 s, 8 s …
      await sleep(Math.min(8000, 1000 * 2 ** retries++));
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
// { items: [{ guid, info, row }], error }. Neither getObjectInfo nor the search export carries
// their property sets, so each node is read as a REST record:
// GET /v2/ifc-objects/{guid}?building=… -> attributes.properties (own attributes, @Document Id)
// and attributes.groups (property sets: [{ label, content: { properties: [{ key, value }] } }]).
let spatialPromise = null;

// Server-made groups: "Custom" holds created/updated by (user e-mails), "Geometry" is computed.
// Neither is IFC data, and Custom must not be shown.
const SKIP_GROUPS = new Set(['Custom', 'Geometry']);

async function spatialRecord(guid) {
  const path = `/project-${encodeURIComponent(projectId)}/api/v1/v2/ifc-objects/${encodeURIComponent(guid)}`
    + `?building=${encodeURIComponent(buildingId)}`;
  const res = await withTimeout(rest(path), OBJECT_TIMEOUT_MS, `Objekt ${guid}`);
  const attrs = res && res.data && res.data.attributes;
  if (!attrs) throw new Error('oväntat svar');
  return attrs;
}

// REST record attributes -> row keyed like the export ("Pset~Prop", "IFC Type", …).
function rowFromRecord(attrs) {
  const row = rowFromInfo({ properties: attrs.properties });
  for (const group of Array.isArray(attrs.groups) ? attrs.groups : []) {
    const label = String((group && group.label) ?? '').replace(/:\s*$/, '').trim(); // "BaseQuantities:"
    if (!label || SKIP_GROUPS.has(label)) continue;
    const props = group.content && Array.isArray(group.content.properties) ? group.content.properties : [];
    for (const p of props) if (p && p.key !== undefined) row[`${label}~${p.key}`] = p.value;
  }
  return row;
}

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
    let error = null;
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
          const attrs = await spatialRecord(guid);
          out.push({ guid, info: { properties: attrs.properties || {} }, row: rowFromRecord(attrs) });
        } catch (recordErr) {
          // Without the record we still need to know the file, to report it as missing there.
          error = recordErr;
          try {
            const info = await withTimeout(retryOnce(() => api.getObjectInfo(guid)), OBJECT_TIMEOUT_MS, `Objekt ${guid}`);
            out.push({ guid, info, row: null });
          } catch (err) {
            console.warn(`Kunde inte läsa ${kind} ${guid}:`, err);
          }
        }
      });
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
  const column = (key, origin = ELEMENT) => {
    if (IGNORED_COLUMNS.has(key)) return null;
    const cut = key.indexOf('~');
    const name = cut > 0 ? key.slice(0, cut) : ATTR;
    const pset = origin + SEP + name;
    const prop = cut > 0 ? key.slice(cut + 1) : key;
    if (!psets.has(pset)) psets.set(pset, new Map());
    const props = psets.get(pset);
    if (!props.has(prop)) props.set(prop, new Map());
    return props.get(prop);
  };
  const spatialSeen = new Set(); // GUIDs of IfcProject/IfcSite already counted
  const add = (row, guid, forcedOrigin) => {
    if (!row || typeof row !== 'object') return;
    const spatial = forcedOrigin || spatialOrigin(row['IFC Type']);
    if (spatial) {
      const id = guid || row.GUID || row['Global Id'];
      if (id && spatialSeen.has(id)) return;
      if (id) spatialSeen.add(id);
    }
    const origin = spatial || ELEMENT;
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
    if (objects && [...psets.keys()].some(isPropertySet)) {
      const warning = await addSpatial();
      return { objects, psets, skipped: 0, warning, rule };
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
  if (![...psets.keys()].some(isPropertySet)) {
    throw new Error(`Kunde inte läsa property sets för ${file.name}. Exporten: ${errorText(exportError)}`);
  }
  const warning = await addSpatial();
  return { objects: guids.length, psets, skipped, warning, rule };
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
  // Marks are per file selection: drop them (and the highlight in the model) when it changes.
  loadedData = [];
  if (marks.size) {
    marks.clear();
    applyMarks();
  }
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
  loadedData = loaded;
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

// File filters: free text, date range on "last-modified", layers (any of), labels (any of within a
// label group, all groups must match).
let labelsById = new Map();
const fileFilter = { layers: new Set(), labels: new Set() };

// "yyyy-mm-dd" from a date input -> local midnight, or null.
function dayStart(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

const fmtDate = (d) => (d ? d.toLocaleDateString('sv-SE') : '');

function visibleFiles() {
  const q = $('picker-filter').value.trim().toLowerCase();
  const newer = dayStart($('f-newer').value); // modified on or after this day
  const older = dayStart($('f-older').value); // modified before this day

  // Selected labels per group: a file must have at least one of each group's selected labels.
  const byGroup = new Map();
  for (const id of fileFilter.labels) {
    const group = labelsById.get(id)?.group ?? '';
    if (!byGroup.has(group)) byGroup.set(group, new Set());
    byGroup.get(group).add(id);
  }

  return files.filter((f) => {
    if (q && !f.name.toLowerCase().includes(q)) return false;
    if ((newer || older) && !f.modified) return false;
    if (newer && f.modified < newer) return false;
    if (older && f.modified >= older) return false;
    if (fileFilter.layers.size && !f.layers.some((l) => fileFilter.layers.has(l))) return false;
    for (const ids of byGroup.values()) if (!f.labels.some((id) => ids.has(id))) return false;
    return true;
  });
}

function activeFilterCount() {
  return ($('picker-filter').value.trim() ? 1 : 0) + ($('f-newer').value ? 1 : 0) + ($('f-older').value ? 1 : 0)
    + fileFilter.layers.size + fileFilter.labels.size;
}

function chipToggle(text, on, onClick, title) {
  const b = el('button', 'chip-toggle', text);
  b.type = 'button';
  b.setAttribute('aria-pressed', String(on));
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function toggleIn(set, value) {
  if (set.has(value)) set.delete(value); else set.add(value);
  renderFilters();
  renderPicker();
}

// Layer and label chips: only values that occur on the project's IFC files.
function renderFilters() {
  const layers = [...new Set(files.flatMap((f) => f.layers))].sort(collator.compare);
  $('f-layers-row').hidden = !layers.length;
  $('f-layers').replaceChildren(...layers.map((l) =>
    chipToggle(l, fileFilter.layers.has(l), () => toggleIn(fileFilter.layers, l))));

  const used = new Set(files.flatMap((f) => f.labels));
  const groups = new Map(); // group name -> labels
  for (const id of used) {
    const label = labelsById.get(id);
    if (!label) continue;
    if (!groups.has(label.group)) groups.set(label.group, []);
    groups.get(label.group).push(label);
  }
  const groupNames = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || collator.compare(a, b));
  $('f-labels-row').hidden = !groupNames.length;
  $('f-labels').replaceChildren(...groupNames.map((g) => {
    const wrap = el('div', 'label-group');
    wrap.append(el('span', 'label-group-name', g || 'Övriga'));
    const chips = el('div', 'chips');
    chips.append(...groups.get(g).sort((a, b) => collator.compare(a.name, b.name)).map((label) =>
      chipToggle(label.name, fileFilter.labels.has(label.id), () => toggleIn(fileFilter.labels, label.id))));
    wrap.append(chips);
    return wrap;
  }));

  const n = activeFilterCount();
  $('f-reset').hidden = !n;
  $('f-toggle-count').textContent = n ? String(n) : '';
  $('f-toggle-count').hidden = !n;
}

function resetFilters() {
  $('picker-filter').value = '';
  $('f-newer').value = '';
  $('f-older').value = '';
  fileFilter.layers.clear();
  fileFilter.labels.clear();
  renderFilters();
  renderPicker();
}

function pickerOpen(open) {
  $('picker-panel').hidden = !open;
  $('picker-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    renderFilters();
    renderPicker();
    $('picker-filter').focus();
  }
}

function renderPicker() {
  const visible = visibleFiles();
  $('f-count').textContent = visible.length === files.length
    ? `${files.length} filer` : `Visar ${visible.length} av ${files.length} filer`;
  const items = visible.map((file) => {
    const li = el('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(isSelected(file)));
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = isSelected(file);
    box.addEventListener('change', () => toggleFile(file, box.checked));
    const name = el('span', 'file-name', file.name);
    const date = el('span', 'file-date', fmtDate(file.modified));
    const layer = el('span', 'file-layer', file.layer);
    const labelNames = file.labels.map((id) => labelsById.get(id)?.name).filter(Boolean);
    label.title = [file.name, `Senast ändrad: ${fmtDate(file.modified) || 'okänt'}`, `Lager: ${file.layer}`,
      labelNames.length ? `Etiketter: ${labelNames.join(', ')}` : '', `Dokument ${file.id}`].filter(Boolean).join('\n');
    label.append(box, name, date, layer);
    li.append(label);
    return li;
  });
  if (!items.length) items.push(el('li', 'none', files.length ? 'Inga filer matchar filtren.' : 'Inga IFC-filer i projektet.'));
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

// [value, total count] over the selected files, most common first.
function sortedValues(prop) {
  const totals = new Map();
  for (const values of prop.files.values()) {
    for (const [v, c] of values) totals.set(v, (totals.get(v) || 0) + c);
  }
  return [...totals].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]));
}

const ORIGIN_TITLES = {
  IfcProject: 'Ligger på IfcProject',
  IfcSite: 'Ligger på IfcSite',
  IfcElement: 'Ligger på objekt i modellen (byggdelar, rum m.m.)',
};

function originChip(pset) {
  const origin = psetOrigin(pset);
  const chip = el('span', origin === ELEMENT ? 'origin origin-element' : 'origin', origin);
  chip.title = ORIGIN_TITLES[origin] || '';
  return chip;
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
    label.append(originChip(pset), highlight(psetLabel(pset), q));
    btn.append(el('span', 'chev', '▸'), label, fileTags(present),
      el('span', 'meta', propNames.length === 1 ? '1 egenskap' : `${propNames.length} egenskaper`));
    btn.addEventListener('click', () => {
      if (expanded.has(pset)) expanded.delete(pset); else expanded.add(pset);
      renderList();
    });
    li.append(btn);

    if (open) {
      // Two columns: property name (click = mark in the model) and its values joined with " | ".
      const ul = el('ul', 'props');
      for (const name of propNames) {
        const prop = props.get(name);
        const values = sortedValues(prop);
        const pli = el('li', isMarked(pset, name) ? 'prop-row marked' : 'prop-row');

        // Only modelled objects can be marked in the viewer.
        let nameBtn;
        if (canMark(pset)) {
          nameBtn = el('button', 'prop-name');
          nameBtn.type = 'button';
          nameBtn.title = 'Markera alla objekt med egenskapen i de valda filerna (klicka igen för att avmarkera)';
          nameBtn.setAttribute('aria-pressed', String(isMarked(pset, name)));
          nameBtn.addEventListener('click', () => toggleMark(pset, name));
        } else {
          nameBtn = el('span', 'prop-name static');
        }
        nameBtn.append(highlight(name, q));

        const shown = values.slice(0, MAX_INLINE_VALUES).map(([v]) => v);
        const text = shown.join(' | ') + (values.length > shown.length ? ' | …' : '');
        const valuesCell = el('span', 'prop-values', text || '–');
        valuesCell.title = text;

        const countBtn = el('button', 'prop-count', values.length === 1 ? '1 värde ›' : `${nf.format(values.length)} värden ›`);
        countBtn.type = 'button';
        countBtn.title = 'Visa alla värden';
        countBtn.addEventListener('click', () => openValues(pset, name));

        pli.append(nameBtn, valuesCell, fileTags(presentIn(prop)), countBtn);
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
  $('sheet-kicker').textContent = `${psetOrigin(pset)} · ${psetLabel(pset)}`;
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

  const { pset, prop: propName } = openProp;
  const body = rows.slice(0, MAX_VALUE_ROWS).map(([value, counts]) => {
    const marked = isMarked(pset, propName, value);
    const tr = el('tr', marked ? 'marked' : '');
    const td = el('td', 'value');
    if (canMark(pset)) {
      const btn = el('button', 'value-btn');
      btn.type = 'button';
      btn.title = 'Markera objekten med det här värdet i de valda filerna (klicka igen för att avmarkera)';
      btn.setAttribute('aria-pressed', String(marked));
      btn.append(highlight(value, q));
      btn.addEventListener('click', () => toggleMark(pset, propName, value));
      td.append(btn);
    } else {
      td.append(highlight(value, q));
    }
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

/* ---------- marking objects in the model ---------- */

// Each mark is a property (all objects that have it) or a property + value, in the selected files.
// Only modelled objects (IfcElement psets/attributes); IfcProject/IfcSite are not marked.
// Marks are OR-ed. Flow:
// 1. REST search (POST ifc-searches) with the rules: answers with an error instead of hanging,
//    unlike the widget's findObjects/applyObjectSearch on a search the server does not accept.
// 2. Export only the GUID column of that search: the matching objects and their count.
// 3. Show them in StreamBIM: applyObjectSearch (the viewer's own search highlight) with the same
//    rules. If it does not answer, colour the GUIDs with colorCodeObjects (search colour).
const marks = new Map(); // key -> { pset, prop, value }
let loadedData = [];     // FileData of the selected files, same order as `selected`
let markToken = 0;
let colouredByGuid = false; // colorCodeObjects fallback in use: clear it on reset
// colorCodeObjects needs a colour, but in the default flavour it is not drawn: the objects are
// isolated as a search and shown in the search-highlight green (see AGENTS.md, Traps).
const MARK_COLOUR = 'f2921c';
const APPLY_TIMEOUT_MS = 15000;
const MARK_DEBOUNCE_MS = 400; // several quick clicks -> one search

const markKey = (pset, prop, value) => JSON.stringify([pset, prop, value === undefined ? null : value]);
const isMarked = (pset, prop, value) => marks.has(markKey(pset, prop, value));
const canMark = (pset) => psetOrigin(pset) === ELEMENT;

function toggleMark(pset, prop, value) {
  if (!canMark(pset)) return;
  const key = markKey(pset, prop, value);
  if (marks.has(key)) marks.delete(key); else marks.set(key, { pset, prop, value });
  renderList();
  renderValues();
  scheduleMarks();
}

function clearMarks() {
  if (!marks.size) return;
  marks.clear();
  renderList();
  renderValues();
  scheduleMarks();
}

// Fair use: wait for a pause in the clicking, then run one search for all marks.
let markTimer = null;
function scheduleMarks() {
  markToken += 1; // results of a search still running are now outdated
  clearTimeout(markTimer);
  if (marks.size) setMarkBar(`${marks.size === 1 ? '1 markering' : `${marks.size} markeringar`} · …`);
  markTimer = setTimeout(applyMarks, MARK_DEBOUNCE_MS);
}

async function zoomToMarked() {
  try {
    await withTimeout(api.zoomToSearchResult(), OBJECT_TIMEOUT_MS, 'Zoomningen');
  } catch (err) {
    console.warn(err);
  }
}

// Search rule for one mark (without the file part). "hasValue" is sent without propValue, as
// valuesForObjectProperty does.
function propertyRule({ pset, prop, value }) {
  let rule;
  if (isPropertySet(pset)) rule = { psetName: psetName(pset), propKey: prop };
  else rule = { propKey: prop === 'IFC Type' ? '@kind' : prop }; // export column -> search key
  return value === undefined
    ? { ...rule, operator: 'hasValue' }
    : { ...rule, operator: '=', propValue: value };
}

// Rule[][] without buildingId (createSearch adds it).
function markRules() {
  const rules = [];
  for (const mark of marks.values()) {
    for (const data of loadedData) {
      if (data && data.rule) rules.push([data.rule, propertyRule(mark)]);
    }
  }
  return rules;
}

function setMarkBar(text, { canZoom = false } = {}) {
  $('markbar').hidden = !marks.size;
  $('mark-text').textContent = text;
  $('mark-zoom').hidden = !canZoom;
}

async function clearViewer() {
  try { await withTimeout(api.resetObjectSearch(), OBJECT_TIMEOUT_MS, 'Återställningen'); } catch (err) { console.warn(err); }
  if (colouredByGuid) {
    colouredByGuid = false;
    try { await withTimeout(api.colorCodeObjects({}), OBJECT_TIMEOUT_MS, 'Återställningen'); } catch (err) { console.warn(err); }
  }
}

async function applyMarks() {
  const token = ++markToken;
  if (!marks.size) {
    setMarkBar('');
    await clearViewer();
    return;
  }
  const what = marks.size === 1 ? '1 markering' : `${marks.size} markeringar`;
  const started = Date.now();
  const status = (text) => {
    if (token === markToken) setMarkBar(`${what} · ${text} (${Math.round((Date.now() - started) / 1000)} s)`);
  };
  status('söker i modellen');
  const rules = markRules();
  try {
    const searchId = await createSearch(rules);
    const guids = [];
    await exportAll(searchId, (rows, header, n) => {
      for (const row of rows) if (row && row.GUID) guids.push(String(row.GUID));
      status(`hittat ${nf.format(n)} objekt`);
    }, ['GUID']);
    if (token !== markToken) return;

    await clearViewer();
    if (token !== markToken) return;
    if (!guids.length) {
      setMarkBar(`${what} · inga objekt i modellen matchar`);
      return;
    }

    status(`markerar ${nf.format(guids.length)} objekt`);
    let how = 'sökmarkering';
    try {
      const withBuilding = rules.map((and) => and.map((r) => ({ buildingId, ...r })));
      await withTimeout(api.applyObjectSearch({ rules: withBuilding }), APPLY_TIMEOUT_MS, 'applyObjectSearch');
    } catch (err) {
      console.warn('applyObjectSearch svarade inte, färgar objekten i stället:', err);
      if (token !== markToken) return;
      await withTimeout(api.colorCodeObjects(Object.fromEntries(guids.map((g) => [g, MARK_COLOUR]))),
        EXPORT_TIMEOUT_MS, 'Färgningen');
      colouredByGuid = true;
      how = 'färgade';
    }
    if (token === markToken) setMarkBar(`${what} · ${nf.format(guids.length)} objekt markerade (${how})`, { canZoom: how === 'sökmarkering' });
  } catch (err) {
    if (token === markToken) setMarkBar(`${what} · kunde inte markera: ${errorText(err)}`);
  }
}

/* ---------- events ---------- */

$('mark-clear').addEventListener('click', clearMarks);
$('mark-zoom').addEventListener('click', zoomToMarked);

$('picker-btn').addEventListener('click', () => pickerOpen($('picker-panel').hidden));
$('picker-filter').addEventListener('input', () => { renderFilters(); renderPicker(); });
for (const id of ['f-newer', 'f-older']) $(id).addEventListener('change', () => { renderFilters(); renderPicker(); });
$('f-reset').addEventListener('click', resetFilters);
$('f-toggle').addEventListener('click', () => {
  const open = $('f-panel').hidden;
  $('f-panel').hidden = !open;
  $('f-toggle').setAttribute('aria-expanded', String(open));
});
$('pick-all').addEventListener('click', () => setAll(true));
$('pick-none').addEventListener('click', () => setAll(false));
document.addEventListener('click', (e) => {
  // composedPath: the clicked chip may already be re-rendered (detached) when this runs.
  if (!$('picker-panel').hidden && !e.composedPath().includes($('picker'))) pickerOpen(false);
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
  const [fileList, labels] = await Promise.all([loadFileList(), loadLabels()]);
  files = fileList
    .filter((f) => /\.ifc$/i.test(f.name.trim()))
    .sort((a, b) => collator.compare(a.name, b.name));
  labelsById = labels;
  $('picker-btn').disabled = false;
  renderFilters();
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
