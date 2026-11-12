'use strict';

// Fake widget API, used only when the page is opened directly (not inside StreamBIM).
// Implements the calls widget.js needs, with the same shapes as the live API.
window.IfcMock = (() => {
  // document id -> file. Two files share layer "A" to show that the list is per file, not per layer.
  const FILES = {
    1001: { name: 'A-40-V-0001_Hus A.ifc', layer: 'A', count: 1800, kinds: ['Wall', 'Door', 'Window', 'Slab', 'Space'] },
    1002: { name: 'A-40-V-0002_Hus B.ifc', layer: 'A', count: 1200, kinds: ['Wall', 'Door', 'Window', 'Space'] },
    1003: { name: 'K-50-V-0001_Konstruktion.ifc', layer: 'K', count: 900, kinds: ['Beam', 'Column', 'Slab', 'Wall'] },
    1004: { name: 'V-57-V-0001_Ventilation.ifc', layer: 'V', count: 4200, kinds: ['Duct segment', 'Duct fitting', 'Air terminal', 'Damper'] },
    1005: { name: 'Punktmoln_Fasad.e57', layer: 'P', count: 10, kinds: ['Point cloud'] }, // filtered out: not .ifc
  };

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
            searches.set(searchId, guidSearch(body && body.rules) || docOf(body && body.rules));
            return JSON.stringify({ searchId });
          }
          const q = new URLSearchParams(url.split('?')[1]);
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
          return JSON.stringify({ data: { id: doc[1], type: 'documents', attributes: { filename: FILES[doc[1]].name } } });
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
        const r0 = rules && rules[0] && rules[0][0];
        if (r0 && r0.propKey === '@kind') {
          return Object.keys(SPATIAL).filter((g) => SPATIAL[g]['@kind'] === r0.propValue).slice(0, limit);
        }
        const docId = docOf(rules);
        if (!docId) return [];
        return Array.from({ length: Math.min(limit, FILES[docId].count) }, (_, i) => guid(docId, i));
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
