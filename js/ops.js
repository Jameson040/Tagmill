// File organization via File System Access API: template rename, move-by-tag, TXT sidecars.
// Every operation is planned first (preview + collision detection), executed in chunks with
// progress + abort, and journalled so it can be undone. Originals are only touched explicitly.

import { sanitizeFilename } from './util.js';

export const OPS_REQUIREMENTS = {
  ok: typeof showDirectoryPicker === 'function' &&
      typeof FileSystemFileHandle !== 'undefined' && 'move' in FileSystemFileHandle.prototype,
  why: 'Renaming/moving files requires the File System Access API with handle.move() (Chrome/Edge). Use Export instead to organize externally.',
};

export async function resolveDir(root, dirPath, create = false) {
  let dir = root;
  if (!dirPath) return dir;
  for (const seg of dirPath.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

export async function resolveFile(root, filePath) {
  const i = filePath.lastIndexOf('/');
  const dirPath = i >= 0 ? filePath.slice(0, i) : '';
  const name = i >= 0 ? filePath.slice(i + 1) : filePath;
  const dir = await resolveDir(root, dirPath, false);
  return { file: await dir.getFileHandle(name), dir, name };
}

async function existsIn(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch {
    try { await dir.getDirectoryHandle(name); return true; } catch { return false; }
  }
}

export async function uniqueName(dir, name) {
  if (!(await existsIn(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!(await existsIn(dir, cand))) return cand;
  }
  throw new Error('cannot find unique name for ' + name);
}

export function sanitizePath(p, fallback = 'untagged') {
  const segs = String(p || '').split(/[\/\\]+/).map(seg => sanitizeFilename(seg.trim(), '')).filter(Boolean);
  return segs.length ? segs.join('/') : fallback;
}

// ---------- templates ----------
export function renderTemplate(tpl, rec, tagsCtx, index = 0) {
  const stem = rec.name.replace(/\.[^.]+$/, '');
  const ext = (rec.name.match(/\.([^.]+)$/) || [])[1] || '';

  let tagsByCat = {};
  let allTags = [];
  if (Array.isArray(tagsCtx)) {
    allTags = tagsCtx;
  } else if (tagsCtx && typeof tagsCtx === 'object') {
    if (tagsCtx.allTags || tagsCtx.tagsByCat) {
      allTags = tagsCtx.allTags || [];
      tagsByCat = tagsCtx.tagsByCat || {};
    } else {
      tagsByCat = tagsCtx;
      allTags = Object.values(tagsByCat).flat().sort((a, b) => (b.p ?? 0) - (a.p ?? 0));
    }
  }

  const cat = (c) => (tagsByCat[c] && tagsByCat[c][0]?.name) || '';
  const chars = (tagsByCat[4] || []).slice(0, 3).map(t => t.name).join('+');

  const t1 = allTags[0]?.name || '';
  const t2 = allTags[1]?.name || '';
  const t3 = allTags[2]?.name || '';
  const t4 = allTags[3]?.name || '';

  const map = {
    name: stem,
    ext,
    tag1: t1 || 'untagged',
    tag2: t2 || 'untagged',
    tag3: t3 || 'untagged',
    tag4: t4 || 'untagged',
    top1: t1 || 'untagged',
    top2: t2 || 'untagged',
    top3: t3 || 'untagged',
    top_tag: t1 || cat(0) || 'untagged',
    'tag1+tag2': (t1 && t2) ? `${t1} + ${t2}` : (t1 || 'untagged'),
    'tag1_tag2': (t1 && t2) ? `${t1}_${t2}` : (t1 || 'untagged'),
    'top2tags': (t1 && t2) ? `${t1} + ${t2}` : (t1 || 'untagged'),
    'top3tags': allTags.slice(0, 3).map(t => t.name).join(' + ') || 'untagged',
    artist: cat(1) || 'unknown_artist',
    copyright: cat(3) || 'unknown_series',
    character: cat(4) || chars || 'unknown_character',
    characters: chars || 'unknown_characters',
    top3: (allTags.length ? allTags.slice(0, 3).map(t => t.name).join('_') : (tagsByCat[0] || []).slice(0, 3).map(t => t.name).join('_')) || 'untagged',
    rating: cat(9) || 'unknown_rating',
    index: String(index).padStart(6, '0'),
    size: String(rec.size),
  };

  return tpl.replace(/\{([^{}]+)\}/g, (m, k) => {
    const trimmed = k.trim();
    if (trimmed in map) return map[trimmed];
    const numMatch = trimmed.match(/^tag(\d+)$/i);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      return allTags[idx]?.name || 'untagged';
    }
    return m;
  });
}

/**
 * Plan rename operations. Returns [{rec, fromPath, toPath, conflict, targetDirPath}]
 */
export async function planRenames(root, records, tpl, tagsFor, { collision = 'suffix' } = {}) {
  const dirCache = new Map();
  const plan = [];
  const taken = new Set(); // names claimed within this run per dir
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const slash = rec.path.lastIndexOf('/');
    const dirPath = slash >= 0 ? rec.path.slice(0, slash) : '';
    const oldName = slash >= 0 ? rec.path.slice(slash + 1) : rec.path;
    const rawNewName = renderTemplate(tpl, rec, tagsFor(rec), i);
    const newName = sanitizeFilename(rawNewName, oldName);
    if (newName === oldName) continue;
    let dir = dirCache.get(dirPath);
    if (!dir) { dir = await resolveDir(root, dirPath, false); dirCache.set(dirPath, dir); }
    const key = dirPath + '/' + newName.toLowerCase();
    let conflict = (await existsIn(dir, newName)) || taken.has(key);
    let finalName = newName;
    if (conflict && collision === 'suffix') {
      finalName = await uniqueName(dir, newName);
      conflict = false;
    }
    if (finalName !== oldName) {
      taken.add(dirPath + '/' + finalName.toLowerCase());
      plan.push({ kind: 'rename', rec, fromPath: rec.path, toPath: dirPath ? dirPath + '/' + finalName : finalName, conflict });
    }
  }
  return plan;
}

/**
 * Plan move-by-tag: target = <root>/<dirPath>/<filename>
 */
export async function planMoves(root, records, targetDirFn, tagsFor, { collision = 'suffix' } = {}) {
  const plan = [];
  const dirCache = new Map();
  const taken = new Set();
  // Different raw metadata values which sanitize to the same path get separate,
  // readable folders instead of being silently merged.
  const rawToDir = new Map();
  const dirToRaw = new Map();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const rawDir = String(targetDirFn(rec, tagsFor, i) || 'untagged');
    const rawKey = rawDir;
    let dirPath = rawToDir.get(rawKey);
    if (!dirPath) {
      const basePath = sanitizePath(rawDir, 'untagged');
      dirPath = basePath;
      const priorRaw = dirToRaw.get(basePath);
      if (priorRaw !== undefined && priorRaw !== rawKey) {
        const parts = basePath.split('/');
        const stem = parts.pop() || 'untagged';
        let n = 2;
        do { dirPath = [...parts, `${stem} (${n++})`].join('/'); } while (dirToRaw.has(dirPath));
      }
      rawToDir.set(rawKey, dirPath);
      dirToRaw.set(dirPath, rawKey);
    }

    const oldName = rec.path.split('/').pop();
    let dir;
    try {
      dir = dirCache.get(dirPath);
      if (!dir) { dir = await resolveDir(root, dirPath, true); dirCache.set(dirPath, dir); }
    } catch (e) {
      // A browser/filesystem can still reject an exotic value. Keep the batch alive.
      dirPath = 'untagged';
      try {
        dir = dirCache.get(dirPath) || await resolveDir(root, dirPath, true);
        dirCache.set(dirPath, dir);
      } catch { failedPlanItem(plan, rec, e); continue; }
    }
    const key = dirPath + '/' + oldName.toLowerCase();
    let conflict = (await existsIn(dir, oldName)) || taken.has(key);
    let finalName = oldName;
    if (conflict && collision === 'suffix') {
      finalName = await uniqueName(dir, oldName);
      conflict = false;
    }
    taken.add(dirPath + '/' + finalName.toLowerCase());
    plan.push({ kind: 'move', rec, fromPath: rec.path, toPath: dirPath + '/' + finalName, targetDirPath: dirPath, conflict });
  }
  return plan;
}

function failedPlanItem(plan, rec, error) {
  plan.push({ kind: 'move', rec, fromPath: rec.path, toPath: null, targetDirPath: 'untagged', conflict: true, error: String(error?.message || error) });
}

/**
 * Execute planned ops. Returns {done, failed, undoEntries, newPaths: Map(recId -> newPath)}
 */
export async function executeOps(root, plan, { onProgress, signal, writeUndo } = {}) {
  let done = 0, failed = 0;
  const undoEntries = [];
  const newPaths = new Map();
  for (const p of plan) {
    if (signal?.aborted) break;
    if (p.conflict || !p.toPath) { failed++; continue; }
    try {
      const { file, dir: fromDir } = await resolveFile(root, p.fromPath);
      if (p.kind === 'rename') {
        const slash = p.toPath.lastIndexOf('/');
        const newName = p.toPath.slice(slash + 1);
        await file.move(newName);
      } else if (p.kind === 'move') {
        const targetDir = await resolveDir(root, p.targetDirPath, true);
        const newName = p.toPath.split('/').pop();
        await file.move(targetDir, newName);
      }
      undoEntries.push({
        id: `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        collectionId: p.rec.collectionId, kind: p.kind, recId: p.rec.id,
        fromPath: p.fromPath, toPath: p.toPath, ts: Date.now(),
      });
      newPaths.set(p.rec.id, p.toPath);
      done++;
    } catch (e) {
      failed++;
      p.error = String(e.message || e);
    }
    onProgress?.(done + failed, plan.length, p);
    if ((done + failed) % 50 === 0) await new Promise(r => setTimeout(r));
  }
  if (writeUndo && undoEntries.length) {
    const { putUndo } = await import('./db.js');
    await putUndo(undoEntries);
  }
  return { done, failed, undoEntries, newPaths };
}

/** Undo a batch of journal entries (inverse renames/moves). */
export async function undoOps(root, entries, { onProgress, signal } = {}) {
  let done = 0, failed = 0;
  for (const e of entries) {
    if (signal?.aborted) break;
    try {
      const cur = await resolveFile(root, e.toPath);
      const slash = e.fromPath.lastIndexOf('/');
      const fromDirPath = slash >= 0 ? e.fromPath.slice(0, slash) : '';
      const fromName = e.fromPath.slice(slash + 1);
      if (fromDirPath) {
        const targetDir = await resolveDir(root, fromDirPath, true);
        await cur.file.move(targetDir, fromName);
      } else {
        await cur.file.move(fromName);
      }
      done++;
    } catch (err) {
      failed++;
      console.warn('undo failed', e.fromPath, err);
    }
    onProgress?.(done + failed, entries.length);
  }
  return { done, failed };
}

/** Write WD14-style .txt sidecars next to images. Undo = delete created files. */
export async function writeSidecars(root, records, tagsFor, { onProgress, signal, writeUndo, overwrite = false } = {}) {
  let done = 0, failed = 0, skipped = 0;
  const undoEntries = [];
  const dirCache = new Map();
  for (const rec of records) {
    if (signal?.aborted) break;
    try {
      const slash = rec.path.lastIndexOf('/');
      const dirPath = slash >= 0 ? rec.path.slice(0, slash) : '';
      const stem = (slash >= 0 ? rec.path.slice(slash + 1) : rec.path).replace(/\.[^.]+$/, '');
      let dir = dirCache.get(dirPath);
      if (!dir) { dir = await resolveDir(root, dirPath, false); dirCache.set(dirPath, dir); }
      const name = stem + '.txt';
      if (!overwrite && await existsIn(dir, name)) { skipped++; continue; }
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(tagsFor(rec));
      await w.close();
      if (writeUndo) undoEntries.push({
        id: `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        collectionId: rec.collectionId, kind: 'txt', recId: rec.id,
        fromPath: null, toPath: dirPath ? dirPath + '/' + name : name, ts: Date.now(),
      });
      done++;
    } catch (e) {
      failed++;
    }
    onProgress?.(done + failed + skipped, records.length);
    if ((done + failed + skipped) % 50 === 0) await new Promise(r => setTimeout(r));
  }
  if (writeUndo && undoEntries.length) {
    const { putUndo } = await import('./db.js');
    await putUndo(undoEntries);
  }
  return { done, failed, skipped, undoEntries };
}

export async function undoSidecars(root, entries, { onProgress, signal } = {}) {
  let done = 0, failed = 0;
  for (const e of entries) {
    if (signal?.aborted) break;
    try {
      const { dir, name } = await resolveFile(root, e.toPath);
      await dir.removeEntry(name);
      done++;
    } catch { failed++; }
    onProgress?.(done + failed, entries.length);
  }
  return { done, failed };
}
