// Lokaler Speicher (IndexedDB) - für den Start ohne Server, zum Testen und offline.
// Eine Person, volle Rechte. Datenaustausch über Export.

const DB = 'varroa-kalibrierung', VER = 1;

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export class LocalStore {
  constructor() { this.mode = 'local'; this.db = null; this.me = null; }

  async init() {
    this.db = await new Promise((res, rej) => {
      const o = indexedDB.open(DB, VER);
      o.onupgradeneeded = () => {
        const db = o.result;
        db.createObjectStore('images', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('models', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('meta');
      };
      o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
    });
    this.me = await this.get('meta', 'me');
  }

  tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); }
  get(store, key) { return req(this.tx(store).get(key)); }
  put(store, val, key) { return req(this.tx(store, 'readwrite').put(val, key)); }
  all(store) { return req(this.tx(store).getAll()); }

  session() { return this.me; }

  async join(_code, kuerzel) {
    this.me = { id: 'lokal', kuerzel: kuerzel.trim() || 'Ich', role: 'admin' };
    await this.put('meta', this.me, 'me');
    return this.me;
  }

  async leave() { this.me = null; await req(this.tx('meta', 'readwrite').delete('me')); }

  async listMembers() { return this.me ? [{ ...this.me, joined_at: null }] : []; }

  async listImages() {
    const all = await this.all('images');
    return all.map(({ candidates, annotations, ...rest }) => rest).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async listImagesFull(filter = {}) {
    const all = await this.all('images');
    return filter.status ? all.filter(i => i.status === filter.status) : all;
  }

  async getImage(id) {
    const r = await this.get('images', id);
    if (!r) throw new Error('Bild nicht gefunden');
    return r;
  }

  async createImage(rec, original, thumb) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    const row = { ...rec, id, file_path: `${id}/original`, thumb_path: `${id}/thumb`, created_by: this.me.id, created_at: now, updated_at: now, status: 'neu' };
    await this.put('blobs', original, row.file_path);
    await this.put('blobs', thumb, row.thumb_path);
    await this.put('images', row);
    const { candidates, annotations, ...light } = row;
    return light;
  }

  async updateImage(id, patch, expectedUpdatedAt) {
    const cur = await this.getImage(id);
    if (expectedUpdatedAt && cur.updated_at !== expectedUpdatedAt) throw new Error('Das Bild wurde inzwischen geändert. Bitte neu laden.');
    const row = { ...cur, ...patch, updated_at: new Date().toISOString() };
    await this.put('images', row);
    return row;
  }

  async deleteImage(rec) {
    const t = this.db.transaction(['images', 'blobs'], 'readwrite');
    t.objectStore('images').delete(rec.id);
    t.objectStore('blobs').delete(rec.file_path);
    t.objectStore('blobs').delete(rec.thumb_path);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  async getBlob(path) {
    const b = await this.get('blobs', path);
    if (!b) throw new Error('Foto nicht gefunden');
    return b;
  }

  async listModels() { return (await this.all('models')).sort((a, b) => a.id - b.id); }

  async createModel(m) {
    const row = { ...m, created_at: new Date().toISOString(), created_by: this.me.id };
    const id = await req(this.tx('models', 'readwrite').add(row));
    return { ...row, id };
  }
}
