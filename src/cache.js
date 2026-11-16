// The playback buffer lives in MSE; this cache stores compressed segments in IndexedDB.
export class SegmentCache {
  constructor(session, maxBytes = 512 * 1024 * 1024) {
    this.session = session;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.memory = new Map();
    this.bytes = 0;
    this.mode = 'disk';
    this.chain = Promise.resolve();
  }

  async init() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('vplayer-segments', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('segments', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('segments', 'readwrite');
        const cursor = tx.objectStore('segments').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const record = c.value;
          // Session credentials are never persisted. Old media expires after 24 hours.
          if (record.updated < Date.now() - 86400000) c.delete();
          else if (record.session === this.session) {
            this.entries.set(record.key, { size: record.data.byteLength, updated: record.updated });
            this.bytes += record.data.byteLength;
          }
          c.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { this.mode = 'memory'; }
  }

  has(key) { return this.entries.has(key); }
  get capacity() { return this.mode === 'memory' ? Math.min(this.maxBytes, 32 * 1024 * 1024) : this.maxBytes; }

  async transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('segments', mode);
      const request = operation(tx.objectStore('segments'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('缓存写入失败'));
    });
  }

  async get(key) {
    if (!this.has(key)) return null;
    try {
      const record = this.mode === 'memory' ? this.memory.get(key) : await this.transaction('readonly', store => store.get(`${this.session}|${key}`));
      if (!record) { this.removeMeta(key); return null; }
      const meta = this.entries.get(key);
      if (meta) meta.updated = Date.now();
      return { ...record, data: record.data.slice(0), cached: true };
    } catch { return null; }
  }

  removeMeta(key) {
    this.bytes -= this.entries.get(key)?.size || 0;
    this.entries.delete(key);
    this.memory.delete(key);
  }

  put(key, value) {
    const task = this.chain.catch(() => {}).then(async () => {
      const limit = this.capacity;
      if (value.data.byteLength > limit) return;
      const record = { ...value, id: `${this.session}|${key}`, session: this.session, key, updated: Date.now() };
      while (this.bytes - (this.entries.get(key)?.size || 0) + value.data.byteLength > limit && this.entries.size) {
        const oldest = [...this.entries].sort((a, b) => a[1].updated - b[1].updated)[0][0];
        if (this.mode === 'disk') await this.transaction('readwrite', store => store.delete(`${this.session}|${oldest}`));
        this.removeMeta(oldest);
      }
      try {
        if (this.mode === 'disk') await this.transaction('readwrite', store => store.put(record));
        else this.memory.set(key, record);
        this.bytes += record.data.byteLength - (this.entries.get(key)?.size || 0);
        this.entries.set(key, { size: record.data.byteLength, updated: record.updated });
      } catch {
        this.mode = 'memory';
        this.entries.clear();
        this.bytes = 0;
        // Playback proceeds even when the disk quota has been exhausted.
      }
    });
    this.chain = task;
    return task;
  }

  async clear() {
    await this.chain.catch(() => {});
    if (this.db) {
      await this.transaction('readwrite', store => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          if (cursor.value.session === this.session) cursor.delete();
          cursor.continue();
        };
        return req;
      });
    }
    this.entries.clear();
    this.memory.clear();
    this.bytes = 0;
  }
}
