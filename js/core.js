// Gemeinsamer Zustand: Speicher, Modelle, Startdaten, automatisches Neutraining
import { CONFIG } from '../config.js';
import { LocalStore } from './store-local.js';
import { SupabaseStore } from './store-supabase.js';
import { GEN_VERSION } from './detect.js';
import { train, samplesForImage } from './model.js';

export const state = { store: null, models: [], seed: null, members: [] };

export function storeSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('vk-settings') || '{}'); } catch { /* leer */ }
  // Adresse bereinigen: ohne /rest/v1/ am Ende und ohne Schrägstrich
  const url = (CONFIG.supabaseUrl || saved.url || '').trim().replace(/\/(rest|auth|storage)\/v1\/?$/, '').replace(/\/+$/, '');
  const key = CONFIG.supabaseAnonKey || saved.key || '';
  const mode = saved.mode || (url && key ? 'supabase' : null);
  return { mode, url, key, fromConfig: !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) };
}

export function saveSettings(s) {
  try { localStorage.setItem('vk-settings', JSON.stringify(s)); } catch { /* privat */ }
}

export async function openStore() {
  const s = storeSettings();
  if (!s.mode) return null;
  const st = s.mode === 'supabase' ? new SupabaseStore(s.url, s.key) : new LocalStore();
  await st.init();
  state.store = st;
  return st;
}

export async function loadSeed() {
  if (state.seed) return state.seed;
  try { state.seed = await (await fetch('seed/seed.json')).json(); } catch { state.seed = { images: {} }; }
  return state.seed;
}

export async function refreshModels() {
  state.models = await state.store.listModels();
  if (!state.models.length && state.store.session()) {
    try {
      const m = await (await fetch('seed/model_v1.json')).json();
      const { note, ...model } = m;
      await state.store.createModel({ gen: model.gen, model, n_images: 4, n_pos: model.nPos, n_neg: model.nNeg, train_ids: [], note });
      state.models = await state.store.listModels();
    } catch (e) { console.warn('Startmodell nicht geladen', e); }
  }
  return state.models;
}

export function latestModel() {
  const ms = state.models.filter(m => m.gen === GEN_VERSION);
  return ms.length ? ms[ms.length - 1] : null;
}

export async function refreshMembers() {
  try { state.members = await state.store.listMembers(); } catch { state.members = []; }
  return state.members;
}
export const memberName = id => (state.members.find(m => m.id === id) || {}).kuerzel || (id ? '?' : '–');

// Neues Modell aus allen bestätigten Trainingsbildern berechnen
export async function retrain(note = 'automatisch nach Bestätigung') {
  const imgs = (await state.store.listImagesFull({ status: 'bestaetigt' }))
    .filter(i => i.split === 'train' && i.candidates && i.candidates.gen === GEN_VERSION && i.annotations);
  const samples = imgs.flatMap(samplesForImage);
  const model = train(samples);
  const row = await state.store.createModel({ gen: GEN_VERSION, model, n_images: imgs.length, n_pos: model.nPos, n_neg: model.nNeg, train_ids: imgs.map(i => i.id), note });
  await refreshModels();
  return row;
}

export function seedFor(fileName, exif, w, h) {
  const imgs = (state.seed && state.seed.images) || {};
  if (fileName && imgs[fileName] && imgs[fileName].width === w && imgs[fileName].height === h) return imgs[fileName];
  if (exif && exif.dateTimeOriginal) {
    for (const s of Object.values(imgs)) if (s.taken === exif.dateTimeOriginal && s.width === w && s.height === h) return s;
  }
  return null;
}

export const STATUS_LABEL = { neu: 'neu', geprueft: 'wartet auf Zweitprüfung', bestaetigt: 'bestätigt' };
export const SPLIT_LABEL = { train: 'Training', test: 'Test' };
