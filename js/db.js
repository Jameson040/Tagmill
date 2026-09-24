// IndexedDB layer — all persistent app data (records, thumbs, jobs, handles, undo, kv)
// Designed for tens of thousands of records: bulk cursors, batch writes, small typed-array payloads.

const DB_NAME = 'tagmill';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('collections')) db.createObjectStore('collections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: 'id' });
        s.createIndex('byColPath', ['collectionId', 'path'], { unique: true });
        s.createIndex('byColStatus', ['collectionId', 'status']);
        s.createIndex('byColHash', ['collectionId', 'quickHash']);
      }
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'collectionId' });
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles', { keyPath: 'collectionId' });
      if (!db.objectStoreNames.contains('undo')) {
        const s = db.createObjectStore('undo', { keyPath: 'id' });
        s.createIndex('byCol', 'collectionId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    const done = new Promise(res => { t.oncomplete = res; });
    try { result = fn(t); } catch (e) { reject(e); return; }
    done.then(() => resolve(result && typeof result.then === 'function' ? result : result));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx aborted'));
  }));
}
const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// ---------- collections ----------
export async function putCollection(col) { return tx('collections', 'readwrite', t => t.objectStore('collections').put(col)); }
export async function getCollections() { return tx('collections', 'readonly', t => reqP(t.objectStore('collections').getAll())); }
export async function deleteCollectionCascade(colId) {
  return tx(['collections', 'images', 'thumbs', 'jobs', 'handles', 'undo'], 'readwrite', t => {
    try { t.objectStore('collections').delete(colId); } catch (_) {}
    try { t.objectStore('jobs').delete(colId); } catch (_) {}
    try { t.objectStore('handles').delete(colId); } catch (_) {}

    const images = t.objectStore('images');
    const thumbs = t.objectStore('thumbs');

    if (images.indexNames.contains('byColPath')) {
      try {
        const cur = images.index('byColPath').openCursor(IDBKeyRange.bound([colId, ''], [colId, '\uffff']));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          try { thumbs.delete(c.primaryKey); } catch (_) {}
          try { c.delete(); } catch (_) {}
          c.continue();
        };
      } catch (_) {}
    } else {
      try {
        const cur = images.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          if (c.value?.collectionId === colId) {
            try { thumbs.delete(c.primaryKey); } catch (_) {}
            try { c.delete(); } catch (_) {}
          }
          c.continue();
        };
      } catch (_) {}
    }

    const undoStore = t.objectStore('undo');
    if (undoStore.indexNames.contains('byCol')) {
      try {
        const u = undoStore.index('byCol').openCursor(IDBKeyRange.only(colId));
        u.onsuccess = () => {
          const c = u.result;
          if (!c) return;
          try { c.delete(); } catch (_) {}
          c.continue();
        };
      } catch (_) {}
    }
  });
}

export async function deleteCollectionOnly(colId) {
  return tx('collections', 'readwrite', t => t.objectStore('collections').delete(colId));
}

export async function clearAllCollections() {
  return tx(['collections', 'images', 'thumbs', 'jobs', 'handles', 'undo'], 'readwrite', t => {
    t.objectStore('collections').clear();
    t.objectStore('images').clear();
    t.objectStore('thumbs').clear();
    t.objectStore('jobs').clear();
    t.objectStore('handles').clear();
    t.objectStore('undo').clear();
  });
}

// ---------- images ----------
export async function putImages(records) {
  return tx('images', 'readwrite', t => {
    const s = t.objectStore('images');
    for (const r of records) s.put(r);
  });
}
export async function deleteImages(ids) {
  return tx(['images', 'thumbs'], 'readwrite', t => {
    const s = t.objectStore('images');
    const th = t.objectStore('thumbs');
    for (const id of ids) {
      s.delete(id);
      th.delete(id);
    }
  });
}
export async function getImage(id) { return tx('images', 'readonly', t => reqP(t.objectStore('images').get(id))); }
export async function getImages(ids) {
  return tx('images', 'readonly', async t => {
    const s = t.objectStore('images');
    const out = [];
    for (const id of ids) out.push(await reqP(s.get(id)));
    return out;
  });
}
export async function iterCollectionImages(colId, cb, { batchSize = 1000 } = {}) {
  // stream every image record of a collection through cb(records[]) — memory-flat
  return tx('images', 'readonly', t => new Promise((resolve, reject) => {
    const idx = t.objectStore('images').index('byColPath');
    const range = IDBKeyRange.bound([colId, ''], [colId, '\uffff']);
    const cur = idx.openCursor(range);
    let batch = [];
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) { if (batch.length) { try { cb(batch); } catch (e) { reject(e); return; } } resolve(); return; }
      batch.push(c.value);
      if (batch.length >= batchSize) {
        try { cb(batch); } catch (e) { reject(e); return; }
        batch = [];
      }
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}
export async function countByStatus(colId) {
  const out = { done: 0, failed: 0, skipped: 0, pending: 0, processing: 0, missing: 0, total: 0 };
  await tx('images', 'readonly', t => Promise.all(
    Object.keys(out).map(st => st === 'total' ? null : reqP(
      t.objectStore('images').index('byColStatus').count(IDBKeyRange.bound([colId, st], [colId, st + '\uffff']))
    ).then(n => out[st] = n))
  ));
  out.total = out.done + out.failed + out.skipped + out.pending + out.processing + out.missing;
  return out;
}
export async function resetProcessingStatus(colId) {
  // after a crash: records stuck in processing/queued -> pending
  return tx('images', 'readwrite', t => new Promise((resolve, reject) => {
    const idx = t.objectStore('images').index('byColStatus');
    const cur = idx.openCursor(IDBKeyRange.bound([colId, 'processing'], [colId, 'processing\uffff']));
    const fix = (store) => ({
      success: () => {},
    });
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) {
        const cur2 = idx.openCursor(IDBKeyRange.bound([colId, 'queued'], [colId, 'queued\uffff']));
        cur2.onsuccess = () => {
          const c2 = cur2.result;
          if (!c2) return resolve();
          const v = c2.value; v.status = 'pending'; v.error = null; c2.update(v); c2.continue();
        };
        cur2.onerror = () => reject(cur2.error);
        return;
      }
      const v = c.value; v.status = 'pending'; v.error = null; c.update(v); c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// ---------- thumbs ----------
export async function putThumb(id, blob) { return tx('thumbs', 'readwrite', t => t.objectStore('thumbs').put(blob, id)); }
export async function getThumb(id) { return tx('thumbs', 'readonly', t => reqP(t.objectStore('thumbs').get(id))); }
export async function getThumbs(ids) {
  return tx('thumbs', 'readonly', async t => {
    const s = t.objectStore('thumbs');
    const out = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) out[i] = await reqP(s.get(ids[i]));
    return out;
  });
}
export async function thumbCount() { return tx('thumbs', 'readonly', t => reqP(t.objectStore('thumbs').count())); }
export async function clearThumbs() { return tx('thumbs', 'readwrite', t => t.objectStore('thumbs').clear()); }

// ---------- jobs ----------
export const putJob = (job) => tx('jobs', 'readwrite', t => t.objectStore('jobs').put(job));
export const getJob = (colId) => tx('jobs', 'readonly', t => reqP(t.objectStore('jobs').get(colId)));
export const deleteJob = (colId) => tx('jobs', 'readwrite', t => t.objectStore('jobs').delete(colId));

// ---------- handles ----------
export const putHandle = (colId, handle, kind) => tx('handles', 'readwrite', t => t.objectStore('handles').put({ collectionId: colId, handle, kind }));
export const getHandle = (colId) => tx('handles', 'readonly', t => reqP(t.objectStore('handles').get(colId)));
export const deleteHandle = (colId) => tx('handles', 'readwrite', t => t.objectStore('handles').delete(colId));

// ---------- undo ----------
export const putUndo = (entries) => tx('undo', 'readwrite', t => { for (const e of entries) t.objectStore('undo').put(e); });
export const iterUndo = (colId) => tx('undo', 'readonly', t => reqP(t.objectStore('undo').index('byCol').getAll(IDBKeyRange.only(colId))));
export const deleteUndo = (ids) => tx('undo', 'readwrite', t => { for (const id of ids) t.objectStore('undo').delete(id); });

// ---------- kv ----------
export const kvSet = (key, val) => tx('kv', 'readwrite', t => t.objectStore('kv').put(val, key));
export const kvGet = (key) => tx('kv', 'readonly', t => reqP(t.objectStore('kv').get(key)));
