// Speicher-Anbindung an Supabase (gemeinsame Datenbank für alle Mitwirkenden)

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const LIGHT_COLS = 'id,created_at,created_by,updated_at,file_name,file_path,thumb_path,width,height,taken_at,device,colony,site,inserted_at,removed_at,windel_w_mm,windel_l_mm,width_dir,roi,px_per_mm,scale_source,split,status,reviewed_by,confirmed_by,n_candidates,n_mites,note';

export class SupabaseStore {
  constructor(url, anonKey) {
    this.mode = 'supabase';
    this.url = url; this.key = anonKey;
    this.client = null; this.me = null;
    this.blobCache = new Map();
  }

  async init() {
    const { createClient } = await import(SUPABASE_JS);
    this.client = createClient(this.url, this.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'varroa-kalib-auth' } });
    const { data } = await this.client.auth.getSession();
    if (data.session) await this.loadMe();
  }

  async loadMe() {
    const { data: u } = await this.client.auth.getUser();
    if (!u || !u.user) { this.me = null; return null; }
    const { data, error } = await this.client.from('members').select('id,kuerzel,role').eq('id', u.user.id).maybeSingle();
    if (error) throw error;
    this.me = data ? { id: data.id, kuerzel: data.kuerzel, role: data.role } : null;
    return this.me;
  }

  session() { return this.me; }

  async join(code, kuerzel) {
    let { data } = await this.client.auth.getSession();
    if (!data.session) {
      const r = await this.client.auth.signInAnonymously();
      if (r.error) throw new Error('Anmeldung fehlgeschlagen: ' + r.error.message + ' (Ist „Anonymous sign-ins“ in Supabase aktiviert?)');
    }
    const { error } = await this.client.rpc('join_project', { p_code: code.trim(), p_kuerzel: kuerzel.trim() });
    if (error) throw new Error(error.message);
    return this.loadMe();
  }

  async leave() { await this.client.auth.signOut(); this.me = null; }

  async listMembers() {
    const { data, error } = await this.client.from('members').select('id,kuerzel,role,joined_at');
    if (error) throw error; return data;
  }

  async listImages() {
    const { data, error } = await this.client.from('images').select(LIGHT_COLS).order('created_at', { ascending: false });
    if (error) throw error; return data;
  }

  // Bilder inklusive Kandidaten und Prüfergebnissen (für Statistik und Training)
  async listImagesFull(filter = {}) {
    let q = this.client.from('images').select('*');
    if (filter.status) q = q.eq('status', filter.status);
    const { data, error } = await q;
    if (error) throw error; return data;
  }

  async getImage(id) {
    const { data, error } = await this.client.from('images').select('*').eq('id', id).single();
    if (error) throw error; return data;
  }

  async createImage(rec, original, thumb) {
    const id = crypto.randomUUID();
    const file_path = `${id}/original.jpg`, thumb_path = `${id}/thumb.jpg`;
    let r = await this.client.storage.from('windeln').upload(file_path, original, { contentType: original.type || 'image/jpeg' });
    if (r.error) throw new Error('Foto-Upload fehlgeschlagen: ' + r.error.message);
    r = await this.client.storage.from('windeln').upload(thumb_path, thumb, { contentType: 'image/jpeg' });
    if (r.error) throw new Error('Vorschau-Upload fehlgeschlagen: ' + r.error.message);
    const row = { ...rec, id, file_path, thumb_path, created_by: this.me.id, status: 'neu' };
    const { data, error } = await this.client.from('images').insert(row).select(LIGHT_COLS).single();
    if (error) throw new Error(error.message);
    return data;
  }

  // Optimistische Sperre: nur speichern, wenn niemand zwischendurch geändert hat
  async updateImage(id, patch, expectedUpdatedAt) {
    let q = this.client.from('images').update(patch).eq('id', id);
    if (expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt);
    const { data, error } = await q.select('*');
    if (error) throw new Error(error.message);
    if (!data || !data.length) throw new Error('Das Bild wurde inzwischen von jemand anderem geändert. Bitte neu laden.');
    return data[0];
  }

  async deleteImage(rec) {
    await this.client.storage.from('windeln').remove([rec.file_path, rec.thumb_path].filter(Boolean));
    const { error } = await this.client.from('images').delete().eq('id', rec.id);
    if (error) throw new Error(error.message);
  }

  async getBlob(path) {
    if (this.blobCache.has(path)) return this.blobCache.get(path);
    const { data, error } = await this.client.storage.from('windeln').download(path);
    if (error) throw new Error('Download fehlgeschlagen: ' + error.message);
    this.blobCache.set(path, data);
    return data;
  }

  async listModels() {
    const { data, error } = await this.client.from('model_versions').select('*').order('id');
    if (error) throw error; return data;
  }

  async createModel(m) {
    const { data, error } = await this.client.from('model_versions').insert(m).select('*').single();
    if (error) throw new Error(error.message);
    return data;
  }
}
