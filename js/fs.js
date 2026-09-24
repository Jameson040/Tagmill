// Collection sources: File System Access API (primary), directory/file input (fallback),
// OPFS directory handle (test/offline path). Produces lightweight image records — never bulk data.

import { IMAGE_EXTS, extOf, sleep } from './util.js';

export const supportsFSA = 'showDirectoryPicker' in window;
export const supportsFsaMove = typeof FileSystemFileHandle !== 'undefined' && 'move' in FileSystemFileHandle.prototype;

export async function pickDirectory(mode = 'read') {
  // must be called from a user gesture
  const handle = await window.showDirectoryPicker({ mode, startIn: 'pictures' });
  return handle;
}

export function permissionFor(handle, mode = 'read') {
  return handle.queryPermission ? handle.queryPermission({ mode }) : Promise.resolve('granted');
}
export async function requestPermission(handle, mode = 'read') {
  if (!handle.requestPermission) return 'granted';
  const q = await handle.queryPermission?.({ mode });
  if (q === mode) return mode;
  return handle.requestPermission({ mode });
}

function looksLikeImage(name, type) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return true;
  if (!ext && typeof type === 'string' && type.startsWith('image/')) return true; // extension-less but browser knows the MIME
  return false;
}

export function makeRecord(collectionId, path, name, size, mtime, ext) {
  return {
    id: `${collectionId}|${path}`,
    collectionId, path, name,
    ext: ext || extOf(name),
    size, mtime,
    status: 'pending',
    error: null, errorMsg: null,
    quickHash: null, dupOf: null,
    tagIdx: null, tagP: null, tagStamp: 0,
    modelVariant: null,
    manualAdd: null, manualRemove: null,
    width: 0, height: 0,
    addedAt: Date.now(),
  };
}

/**
 * Scan a FileSystemDirectoryHandle recursively.
 * onProgress(scanned, filesFound, currentPath) — called periodically.
 * Returns {records, scanErrors: [{path, message}], aborted}
 */
export async function scanDirectoryHandle(dirHandle, collectionId, { onProgress, signal, maxFiles = Infinity } = {}) {
  const records = [];
  const scanErrors = [];
  let scanned = 0, found = 0, lastYield = performance.now();
  let aborted = false;

  async function walk(handle, prefix) {
    if (aborted || records.length >= maxFiles) return;
    let iterator;
    try {
      iterator = handle.entries();
    } catch (e) {
      scanErrors.push({ path: prefix, message: `Cannot list directory: ${e.message}` });
      return;
    }
    for (;;) {
      let name, entry;
      try {
        const r = await iterator.next();
        if (r.done) break;
        [name, entry] = r.value;
      } catch (e) {
        // some environments/enumerations fail on hostile or exotic entries — isolate the damage
        scanErrors.push({ path: prefix, message: `Listing interrupted: ${e.message}` });
        break;
      }
      if (aborted || records.length >= maxFiles) { aborted = true; return; }
      if (signal?.aborted) { aborted = true; return; }
      try {
        if (entry.kind === 'directory') {
          await walk(entry, prefix + name + '/');
        } else {
          scanned++;
          if (name.startsWith('.')) continue;
          if (!looksLikeImage(name, '')) continue;
          const file = await entry.getFile();
          found++;
          records.push(makeRecord(collectionId, prefix + name, name, file.size, file.lastModified));
          if (records.length >= maxFiles) { aborted = true; return; }
        }
      } catch (e) {
        scanErrors.push({ path: prefix + name, message: String(e.message || e) });
      }
      const now = performance.now();
      if (now - lastYield > 12) {
        lastYield = now;
        onProgress?.({ scanned, found, path: prefix + name, records: records.length });
        await sleep(0);
      }
    }
  }
  await walk(dirHandle, '');
  onProgress?.({ scanned, found, path: '', records: records.length, final: true });
  return { records, scanErrors, aborted };
}

/**
 * Build records from a FileList (input[webkitdirectory] or multiple files).
 * Files are kept in a live Map so the pipeline can read them later.
 */
export function recordsFromFileList(fileList, collectionId, fileMap, rootName) {
  const records = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath || f.name;
    const path = rootName && rel.startsWith(rootName + '/') ? rel.slice(rootName.length + 1) : rel;
    if (path.split('/').pop().startsWith('.')) continue;
    if (!looksLikeImage(f.name, f.type)) continue;
    const rec = makeRecord(collectionId, path, f.name, f.size, f.lastModified);
    records.push(rec);
    fileMap.set(rec.id, f);
  }
  return records;
}

/**
 * Diff a fresh scan against existing records.
 * - same path + size + mtime → keep existing record untouched
 * - same path, changed size/mtime → reset to pending (file changed; stale tags dropped)
 * - new path → pending
 * - missing path → status 'missing'
 * Returns records to write and ids to delete.
 */
export function diffScan(existingByPath, freshRecords) {
  const toWrite = [];
  const toDelete = [];
  const seen = new Set();
  for (const fresh of freshRecords) {
    seen.add(fresh.path);
    const old = existingByPath.get(fresh.path);
    if (!old) { toWrite.push(fresh); continue; }
    if (old.size === fresh.size && Math.abs((old.mtime || 0) - (fresh.mtime || 0)) < 1000) {
      seen.add(fresh.path);
      continue; // unchanged
    }
    // changed on disk — reset
    const rec = { ...old, size: fresh.size, mtime: fresh.mtime, status: 'pending', error: null, errorMsg: null, tagIdx: null, tagP: null, tagStamp: 0, modelVariant: null, dupOf: null };
    toWrite.push(rec);
  }
  for (const [path, old] of existingByPath) {
    if (!seen.has(path)) {
      toDelete.push(old.id);
    }
  }
  return { toWrite, toDelete };
}

/** Quick SHA-256 based identity for a folder re-pick (path+size+mtime already covers it). */
export function identityKey(rec) { return `${rec.path}?${rec.size}?${rec.mtime}`; }
