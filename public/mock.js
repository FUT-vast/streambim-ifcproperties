'use strict';

// Fake widget API, used only when the page is opened directly (not inside StreamBIM).
// Implements the calls widget.js needs, with the same shapes as the live API.
window.IfcMock = (() => {
  // document id -> file. Two files share layer "A" to show that the list is per file, not per layer.
  const FILES = {
    1001: { name: 'A-40-V-0001_Hus A.ifc', layer: 'A', count: 1800, kinds: ['Wall', 'Door', 'Window', 'Slab', 'Space'], modified: '2026-10-28T09:12:00Z', uploaded: '2026-03-01T08:00:00Z', labels: ['1', '4'] },
    1002: { name: 'A-40-V-0002_Hus B.ifc', layer: 'A', count: 1200, kinds: ['Wall', 'Door', 'Window', 'Space'], modified: '2026-09-15T14:30:00Z', uploaded: '2026-03-01T08:00:00Z', labels: ['1', '5'] },
    1003: { name: 'K-50-V-0001_Konstruktion.ifc', layer: 'K~A', count: 900, kinds: ['Beam', 'Column', 'Slab', 'Wall'], modified: '2026-11-05T07:45:00Z', uploaded: '2026-04-10T08:00:00Z', labels: ['2', '4'] },
    1004: { name: 'V-57-V-0001_Ventilation.ifc', layer: 'V', count: 4200, kinds: ['Duct segment', 'Duct fitting', 'Air terminal', 'Damper'], modified: '2026-06-02T11:00:00Z', uploaded: '2026-06-02T11:00:00Z', labels: ['3', '5'] },
    1005: { name: 'Punktmoln_Fasad.e57', layer: 'P', count: 10, kinds: ['Point cloud'], modified: '2026-01-01T00:00:00Z', labels: [] }, // filtered out: not .ifc
  };
  // Document labels and label groups, as in StreamBIM's document panel.
  const LABELS = { 1: 'ARK', 2: 'K', 3: 'V', 4: 'Bygghandling', 5: 'Systemhandling', 6: 'Granskning' };
  const LABEL_GROUPS = { 10: { name: 'Disciplin', labels: ['1', '2', '3'] }, 11: { name: 'Skede', labels: ['4', '5'] } };

  const pick = (list, i) => list[i % list.length];
  const guid = (docId, i) => String(docId) + String(i).padStart(18, '0'); // 4 + 18 = 22 chars

  function row(docId, i) {
    const file = FILES[docId];
    const kind = pick(file.kinds, i);
    const r = {
      GUID: guid(docId, i),
      Name: `${kind}:${pick(['Typ A', 'Typ B', 'Typ C'], i * 7)}:${100000 + i}`,
      'IFC Type': kind,
      'Type Name': `${kind}:${pick(['Typ A', 'Typ B', 'Typ C'], i * 7)}`,
      'Location~Floor by position': pick(['Plan 1', 'Plan 2', 'Plan 3', 'Källare'], i * 3),
      'Identity Data~Mark': i % 5 ? `M-${i % 40}` : null,
      'Identity Data~Comments': i % 9 === 0 ? 'Kontrollera' : '',
      'Pset_ManufacturerTypeInformation~Manufacturer': pick(['Acme', 'Bygg AB', 'Nordform'], i),
      Link: 'https://app.streambim.com/…',
    };
    if (file.layer === 'A') {
      r['Pset_WallCommon~FireRating'] = kind === 'Wall' ? pick(docId === 1001 ? ['EI30', 'EI60', 'REI90'] : ['EI30', 'EI120'], i) : null;
      r['Pset_WallCommon~IsExternal'] = kind === 'Wall' ? i % 4 === 0 : null;
      r['BaseQuantities~Height'] = 2400 + (i % 4) * 300;
      r['BSAB~Kod'] = pick(['43.B', '43.C', '44.B'], i);
      if (docId === 1001) r['Pset_DoorCommon~AcousticRating'] = kind === 'Door' ? pick(['R\'w 30 dB', 'R\'w 35 dB'], i) : null;
      if (docId === 1002) r['Hus B~Etapp'] = pick(['Etapp 1', 'Etapp 2'], i);
    }
    if (file.layer === 'K') {
      r['Pset_BeamCommon~LoadBearing'] = kind === 'Beam' ? true : null;
      r['Structural~Material'] = pick(['C30/37', 'S355', 'GL30c'], i);
      r['BaseQuantities~Height'] = 300 + (i % 6) * 100;
      r['BSAB~Kod'] = pick(['27.B', '27.C'], i);
    }
    if (file.layer === 'V') {
      r['Mechanical~System Name'] = pick(['LB01', 'LB02', 'LB03', 'TA01'], i);
      r['Mechanical~Flow'] = (i % 12) * 25;
      r['Pset_DuctSegmentTypeCommon~Shape'] = kind === 'Duct segment' ? pick(['Round', 'Rectangular'], i) : null;
    }
    return r;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // IfcProject / IfcSite objects (not returned by the per-file search, like in the live viewer).
  const SPATIAL = {};
  for (const docId of [1001, 1002, 1003]) {
    SPATIAL[`P${docId}`.padEnd(22, '0')] = { '@kind': 'Project', '@Document Id': docId, Name: 'Projekt Hus A/B', 'Pset_ProjectCommon~ProjectNumber': 'P-0001', 'Projektinfo~Beställare': 'Exempel AB', 'Projektinfo~Skede': docId === 1003 ? 'Bygghandling' : 'Systemhandling' };
    SPATIAL[`S${docId}`.padEnd(22, '0')] = { '@kind': 'Site', '@Document Id': docId, Name: 'Tomt', 'Pset_SiteCommon~BuildableArea': 5400, 'Fastighet~Fastighetsbeteckning': 'Exempelstad 1:1' };
  }

  // ?fail=rest,gis makes the REST export and/or getObjectInfoForSearch reject, to test fallbacks.
  const failing = new Set((new URLSearchParams(location.search).get('fail') || '').split(','));
  const unknown = () => Promise.reject({ code: 'unknown', debug: null });
  const searches = new Map(); // searchId -> document id, or { guids } for a GUID search

  // GUID search (OR of GUID rules) -> the matching IfcProject/IfcSite nodes as export rows.
  function guidSearch(rules) {
    const guids = (rules || []).map((and) => and && and[0]).filter((r) => r && r.propKey === 'GUID').map((r) => r.propValue);
    return guids.length ? { guids } : null;
  }
  function spatialRow(id) {
    const s = SPATIAL[id];
    const r = { GUID: id, 'IFC Type': s['@kind'], Name: s.Name };
    for (const [k, v] of Object.entries(s)) if (k.includes('~')) r[k] = v;
    return r;
  }
  // Evaluates rules like the live search: outer array OR, inner AND. Returns GUIDs.
  function evaluate(rules, limit) {
    const found = new Set();
    for (const and of rules || []) {
      const docRule = and.find((r) => r.propKey === '@Document Id');
      const others = and.filter((r) => r !== docRule);
      const docs = docRule ? [Number(docRule.propValue)].filter((d) => FILES[d]) : Object.keys(FILES).map(Number);
      const candidates = [];
      for (const d of docs) {
        if (others.length || docRule) for (let i = 0; i < FILES[d].count; i++) candidates.push([guid(d, i), row(d, i)]);
        for (const id of Object.keys(SPATIAL)) if (SPATIAL[id]['@Document Id'] === d) candidates.push([id, spatialRow(id)]);
      }
      for (const [id, r] of candidates) {
        if (others.every((rule) => matches(r, rule))) found.add(id);
        if (found.size >= limit) return [...found];
      }
    }
    return [...found];
  }

  // One search rule against an export-style row.
  function matches(r, rule) {
    const key = rule.psetName ? `${rule.psetName}~${rule.propKey}` : rule.propKey === '@kind' ? 'IFC Type' : rule.propKey;
    const v = r[key];
    const text = v === null || v === undefined ? '' : String(v).trim();
    if (rule.operator === 'hasValue') return text !== '';
    return text === String(rule.propValue);
  }

  // Like the live getObjectInfo: the node's own attributes only, no property sets.
  const attributesOnly = (props) => Object.fromEntries(Object.entries(props).filter(([k]) => !k.includes('~')));

  function docOf(rules) {
    const rule = rules && rules[0] && rules[0][0];
    const docId = rule && rule.propKey === '@Document Id' ? Number(rule.propValue) : null;
    return FILES[docId] ? docId : null;
  }

  function exportPage(docId, skip, limit, fieldUnion) {
    const data = [];
    if (docId) for (let i = skip; i < Math.min(FILES[docId].count, skip + limit); i++) data.push(row(docId, i));
    const keys = docId && fieldUnion ? Object.keys(row(docId, 0)) : ['GUID', 'Name'];
    return { header: keys.map((id) => ({ id, name: id, datatype: 'string' })), data };
  }

  function createApi() {
    return {
      getProjectId: async () => 'mock',
      getBuildingId: async () => '1000',
      async getLayers() {
        const out = { grids: true };
        for (const f of Object.values(FILES)) out[f.layer] = true;
        return out;
      },
      async makeApiRequest({ url, method = 'GET', body }) {
        await sleep(50);
        if (/\/ifc-searches(\/export\/json)?(\?|$)/.test(url)) {
          if (failing.has('rest')) throw new Error('DataCloneError: could not be cloned');
          if (method === 'POST') {
            const searchId = String(searches.size + 1);
            const rules = body && body.rules;
            const plainFile = rules && rules.length === 1 && rules[0].length === 1;
            if (!plainFile && !guidSearch(rules)) window.__markSearches = (window.__markSearches || 0) + 1; // for tests
            // Rules for a whole file -> document id (full export); anything else -> evaluated rules.
            searches.set(searchId, guidSearch(rules) || (plainFile ? docOf(rules) : { rules }));
            return JSON.stringify({ searchId });
          }
          const q = new URLSearchParams(url.split('?')[1]);
          const evaluated = searches.get(q.get('searchId'));
          if (evaluated && evaluated.rules) {
            const skip = Number(q.get('page[skip]'));
            const ids = evaluate(evaluated.rules, Infinity).slice(skip, skip + Number(q.get('page[limit]')));
            return JSON.stringify({ data: ids.map((GUID) => ({ GUID })) });
          }
          const search = searches.get(q.get('searchId'));
          if (search && search.guids) {
            const rows = search.guids.filter((g) => SPATIAL[g]).map(spatialRow);
            return JSON.stringify({ data: Number(q.get('page[skip]')) ? [] : rows });
          }
          const limit = Number(q.get('page[limit]'));
          if (failing.has('bigpage') && limit > 250) throw new Error('DataCloneError: could not be cloned');
          const page = exportPage(searches.get(q.get('searchId')), Number(q.get('page[skip]')), limit, true);
          await sleep(100);
          // ?fail=columns: the export only returns the default columns (as if fieldUnion were ignored).
          const fields = q.get('fieldNames')
            ? new TextDecoder().decode(Uint8Array.from(atob(q.get('fieldNames')), (c) => c.charCodeAt(0))).split('|')
            : failing.has('columns') ? ['GUID', 'Name', 'IFC Type', 'Type Name'] : null;
          if (!fields) return JSON.stringify(page);
          return JSON.stringify({ data: page.data.map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null]))) });
        }
        if (/\/ifc-files\?/.test(url)) {
          return JSON.stringify({
            data: Object.entries(FILES).map(([id, f]) => ({
              id: `1000-${id}`,
              type: 'ifc-files',
              attributes: { layer: f.layer, 'marked-for-deletion': false, 'currently-active': true },
              relationships: { document: { data: { id, type: 'documents' } } },
            })),
          });
        }
        const doc = url.match(/\/documents\/(\d+)$/);
        if (doc && FILES[doc[1]]) {
          const f = FILES[doc[1]];
          return JSON.stringify({
            data: {
              id: doc[1],
              type: 'documents',
              attributes: { filename: f.name, 'last-modified': f.modified, 'uploaded-date': f.uploaded || f.modified },
              relationships: { labels: { data: f.labels.map((id) => ({ id, type: 'document-labels' })) } },
            },
          });
        }
        // REST record of an object: own attributes in properties, property sets in groups.
        const rec = url.match(/\/v2\/ifc-objects\/([^/?]+)\?building=/);
        if (rec) {
          const id = decodeURIComponent(rec[1]);
          const s = SPATIAL[id];
          if (!s) throw new Error('DataCloneError: could not be cloned');
          const groups = new Map();
          for (const [k, v] of Object.entries(s)) {
            if (!k.includes('~')) continue;
            const [label, key] = k.split('~');
            const name = label === 'Pset_SiteCommon' ? 'Pset_SiteCommon:' : label; // StreamBIM may add ":"
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push({ key, value: String(v), valueType: typeof v === 'number' ? 'float8' : 'str', measure: '', unit: '', valueItem: '' });
          }
          groups.set('Custom', [{ key: 'Created By', value: 'someone@example.com', valueType: 'str' }]);
          return JSON.stringify({
            data: {
              id, type: 'ifc-objects',
              attributes: {
                properties: { ...attributesOnly(s), 'Global Id': id, groups: null, BaseType: 'ifcspatialelement' },
                groups: [...groups].map(([label, properties]) => ({ label, content: { properties } })),
              },
            },
          });
        }
        if (/\/document-labels$/.test(url)) {
          return JSON.stringify({
            data: Object.entries(LABELS).map(([id, name]) => ({ id, type: 'document-labels', attributes: { name } })),
          });
        }
        if (/\/label-groups$/.test(url)) {
          return JSON.stringify({
            data: Object.entries(LABEL_GROUPS).map(([id, g]) => ({
              id, type: 'label-groups', attributes: { name: g.name },
              relationships: { labels: { data: g.labels.map((l) => ({ id: l, type: 'document-labels' })) } },
            })),
          });
        }
        throw new Error('DataCloneError: could not be cloned');
      },
      async valuesForObjectProperty(prop) {
        await sleep(50);
        if (prop !== '@kind') return {};
        const out = { Project: 3, Site: 3 };
        for (const f of Object.values(FILES)) for (const k of f.kinds) out[k] = (out[k] || 0) + 1;
        return out;
      },
      async findObjects({ rules, limit = 1000 }) {
        await sleep(50);
        return evaluate(rules, limit);
      },
      // ?fail=apply: never answers, like the live call on a search it does not accept.
      async applyObjectSearch(query) {
        if (failing.has('apply')) return new Promise(() => {});
        await sleep(30);
        window.__lastSearch = query; // for tests
        return true;
      },
      async resetObjectSearch() {
        window.__lastSearch = null;
        return true;
      },
      async colorCodeObjects(map) {
        window.__lastColours = map; // for tests
        return true;
      },
      async zoomToSearchResult() {
        window.__zooms = (window.__zooms || 0) + 1; // for tests
        return true;
      },
      async getObjectInfoForSearch({ filter, page = {}, fieldUnion }) {
        await sleep(250);
        if (failing.has('gis')) return unknown();
        return exportPage(docOf(filter && filter.rules), page.skip || 0, Math.min(page.limit || 1000, 10000), fieldUnion);
      },
      async getObjectInfo(id) {
        await sleep(2);
        if (SPATIAL[id]) return { properties: attributesOnly(SPATIAL[id]) };
        const docId = Number(id.slice(0, 4));
        const i = Number(id.slice(4));
        const r = row(docId, i);
        delete r.Link;
        const props = { '@kind': r['IFC Type'], '@Group Layer': FILES[docId].layer, '@Document Id': docId, Timestamp: 'x' };
        for (const [k, v] of Object.entries(r)) if (k !== 'IFC Type' && v !== null) props[k] = v;
        return { layer: FILES[docId].layer, properties: attributesOnly(props) };
      },
    };
  }

  return { createApi };
})();
