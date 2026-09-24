// Model registry — Camie Tagger v2 variants (all GPL-3.0, see About).
// Sizes/hashes verified from the HuggingFace repos; tags.json is the shared 70,527-entry vocabulary.

export const CATEGORY_NAMES = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta', 6: 'year', 9: 'rating' };
export const CATEGORY_ORDER = ['character', 'copyright', 'artist', 'general', 'meta', 'rating', 'year'];
export const CATEGORY_IDS_BY_PRIORITY = [4, 3, 1, 0, 5, 9, 6];
export const CATEGORY_LABELS = {
  character: 'Characters',
  copyright: 'Series / Copyright',
  artist: 'Artists',
  general: 'General',
  meta: 'Meta',
  rating: 'Rating',
  year: 'Year',
  manual: 'Manual',
};
export const CATEGORY_ID_LABELS = {
  4: 'Characters',
  3: 'Series / Copyright',
  1: 'Artists',
  0: 'General',
  5: 'Meta',
  9: 'Rating',
  6: 'Year',
  [-1]: 'Manual',
};

const HF_MOBILE = 'https://huggingface.co/Smashinfries/camie-tagger-v2-onnx-mobile/resolve/main/';
const HF_OFFICIAL = 'https://huggingface.co/Camais03/camie-tagger-v2/resolve/main/';
const TAGS_URL = HF_MOBILE + 'tags.json';

export const DEFAULT_REGISTRY = [
  {
    id: 'camie-v2-int8',
    label: 'Camie Tagger v2 · INT8 (WASM)',
    file: 'camie-tagger-v2-quint8.onnx',
    url: HF_MOBILE + 'camie-tagger-v2-quint8.onnx',
    size: 205799397,
    sha256: 'ecb986b2079a53423f7b36a4a59b8e17af87eaa2dd5ce5c163ee0d9f18a06ea7',
    eps: ['wasm'],
    note: 'Dynamic-quantized ONNX model running on multithreaded WASM (SIMD + SharedArrayBuffer). Complete accuracy with character and series recognition.',
  },
];

export const TAGS_META = {
  url: TAGS_URL,
  size: 3919438,
  sha256: 'e945dbdd287f55d8f3320b727bcb1ccbef928d964eeb004f0a6f53b2da164d57',
};

// A registry can be overridden (?models=<url>) — used for offline/testing scenarios.
let tagsMetaOverride = null;
export function getTagsMeta() { return tagsMetaOverride || TAGS_META; }

export async function loadRegistry() {
  const override = new URLSearchParams(location.search).get('models');
  if (!override) return DEFAULT_REGISTRY;
  try {
    const res = await fetch(override);
    if (!res.ok) throw new Error(`registry fetch ${res.status}`);
    let list = await res.json();
    if (list && Array.isArray(list.models)) {
      // {models: [...], tagsUrl...} wrapper shape
      list.models.tags = list.tags;
      list.models.tagsUrl = list.tagsUrl;
      list.models.tagsSize = list.tagsSize;
      list.models.tagsSha256 = list.tagsSha256;
      list = list.models;
    }
    if (!Array.isArray(list) || !list.length) throw new Error('registry is empty');
    for (const m of list) {
      m.url ??= (override.replace(/[^/]*$/, '') + m.file);
      m.eps ??= ['wasm'];
    }
    if (list.tags) tagsMetaOverride = list.tags;
    // tags may be embedded in the registry JSON root or a sibling file
    if (!list.tags && list.tagsUrl) {
      tagsMetaOverride = { url: new URL(list.tagsUrl, location.href).href, size: list.tagsSize || 0, sha256: list.tagsSha256 || null };
    }
    return list;
  } catch (e) {
    console.warn('registry override failed, using default', e);
    return DEFAULT_REGISTRY;
  }
}

// ---- tags vocabulary ----
// Normalizes either tags.json ({ "123": [name, catId, count] }) or the official
// camie-tagger-v2-metadata.json (tag_mapping.idx_to_tag + tag_to_category) into:
//   { names: string[], catOf: Uint8Array, count: Uint32Array, index: Map<name, idx> }
export function parseTagVocab(raw) {
  const names = [];
  const cats = [];
  const counts = [];
  const index = new Map();
  const catNameToId = { general: 0, artist: 1, copyright: 3, character: 4, meta: 5, year: 6, rating: 9 };

  const addTag = (id, name, cat, count) => {
    const i = Number(id);
    if (!Number.isInteger(i) || i < 0) throw new Error(`bad tag index ${id}`);
    if (typeof name !== 'string' || !name) throw new Error(`bad tag name at ${id}`);
    names[i] = name;
    cats[i] = typeof cat === 'number' ? cat : (catNameToId[cat] ?? 0);
    counts[i] = count >>> 0;
    index.set(name, i);
  };

  if (raw && raw.dataset_info?.tag_mapping) {
    const { idx_to_tag, tag_to_category } = raw.dataset_info.tag_mapping;
    for (const [id, name] of Object.entries(idx_to_tag)) addTag(id, name, tag_to_category[name] ?? 'general', 0);
  } else if (raw && typeof raw === 'object') {
    for (const [id, entry] of Object.entries(raw)) {
      if (!Array.isArray(entry) || entry.length < 2) throw new Error(`bad tags.json entry ${id}`);
      addTag(id, entry[0], entry[1], entry[2] ?? 0);
    }
  } else {
    throw new Error('Unrecognized tag vocabulary file');
  }
  const n = names.length;
  for (let i = 0; i < n; i++) {
    if (names[i] === undefined) throw new Error(`gap in tag indices at ${i}`);
  }
  return { size: n, names, catOf: Uint8Array.from(cats), count: Uint32Array.from(counts), index };
}

// ---- thresholds ----
export const THRESHOLD_PROFILES = {
  balanced: {
    label: 'Balanced (Characters/Series 0.45, General 0.60)',
    values: { character: 0.45, copyright: 0.45, artist: 0.55, general: 0.60, meta: 0.60, rating: 0.50, year: 0.50 },
  },
  micro: {
    label: 'Micro-F1 official (0.614)',
    values: { character: 0.614, copyright: 0.614, artist: 0.614, general: 0.614, meta: 0.614, rating: 0.50, year: 0.50 },
  },
  macro: {
    label: 'Macro-F1 official (0.492)',
    values: { character: 0.492, copyright: 0.492, artist: 0.492, general: 0.492, meta: 0.492, rating: 0.50, year: 0.50 },
  },
  lenient: {
    label: 'Lenient / High Recall (0.30 - 0.40)',
    values: { character: 0.30, copyright: 0.30, artist: 0.40, general: 0.40, meta: 0.40, rating: 0.35, year: 0.35 },
  },
};

export const DEFAULT_CAT_ENABLED = {
  character: true,
  copyright: true,
  artist: true,
  general: true,
  meta: true,
  rating: true,
  year: false,
};
