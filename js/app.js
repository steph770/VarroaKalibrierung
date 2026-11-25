// Varroa-Kalibrierung - Einstieg, Navigation und einfache Ansichten
import { h, put, toast, confirmDialog, fmtDate, fmtDateTime, loadImage, ZoomView, svgEl, marker, download } from './ui.js';
import { state, openStore, storeSettings, saveSettings, refreshModels, refreshMembers, latestModel, memberName, loadSeed, retrain, STATUS_LABEL, SPLIT_LABEL } from './core.js';
import { uploadView, editView } from './upload.js';
import { reviewView } from './review.js';
import { statsView } from './stats.js';
import { countWithModel } from './model.js';

const main = () => document.getElementById('view');
let cleanup = null;

const routes = [
  [/^#\/?$/, homeView],
  [/^#\/einrichten$/, setupView],
  [/^#\/beitreten(\?.*)?$/, joinView],
  [/^#\/bilder$/, listView],
  [/^#\/bild\/([\w-]+)$/, detailView],
  [/^#\/hochladen$/, uploadView],
  [/^#\/bearbeiten\/([\w-]+)$/, editView],
  [/^#\/pruefen\/([\w-]+)$/, reviewView],
  [/^#\/statistik$/, statsView],
  [/^#\/einstellungen$/, settingsView],
];

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* egal */ } cleanup = null; }
  let hash = location.hash || '#/';
  if (!state.store && !hash.startsWith('#/einrichten')) { location.hash = '#/einrichten'; return; }
  if (state.store && !state.store.session() && !hash.startsWith('#/beitreten') && !hash.startsWith('#/einrichten')) { location.hash = '#/beitreten'; return; }
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      const el = main(); el.innerHTML = ''; el.scrollTop = 0; window.scrollTo(0, 0);
      updateNav(hash);
      try { cleanup = await fn(el, ...m.slice(1)); }
      catch (e) { console.error(e); put(el, h('div', { class: 'card error' }, h('b', {}, 'Fehler: '), e.message || String(e))); }
      return;
    }
  }
  location.hash = '#/';
}

function updateNav(hash) {
  const nav = document.getElementById('nav');
  const show = state.store && state.store.session();
  nav.style.display = show ? '' : 'none';
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === hash || (a.getAttribute('href') === '#/' && hash === '#/')));
  const who = document.getElementById('who');
  const me = state.store && state.store.session();
  who.textContent = me ? `${me.kuerzel}${me.role === 'admin' ? ' · Admin' : ''}${state.store.mode === 'local' ? ' · lokal' : ''}` : '';
}

// --- Einrichtung -------------------------------------------------------------
async function setupView(el) {
  const s = storeSettings();
  const url = h('input', { type: 'url', placeholder: 'https://xyz.supabase.co', value: s.url || '' });
  const key = h('input', { type: 'text', placeholder: 'anon public key', value: s.key || '' });
  put(el, 
    h('h1', {}, 'Einrichtung'),
    h('div', { class: 'card' },
      h('h2', {}, 'Gemeinsam mit anderen'),
      h('p', { class: 'muted' }, 'Fotos und Prüfungen liegen in eurer Supabase-Datenbank. Adresse und öffentlichen Schlüssel findest du im Supabase-Projekt unter „Project Settings → API“.'),
      s.fromConfig ? h('p', {}, 'Die Verbindung ist in der App bereits hinterlegt.') : [h('label', {}, 'Projekt-Adresse', url), h('label', {}, 'Öffentlicher Schlüssel (anon)', key)],
      h('button', {
        class: 'btn primary', onclick: async () => {
          const u = s.fromConfig ? s.url : url.value.trim(), k = s.fromConfig ? s.key : key.value.trim();
          if (!u || !k) { toast('Bitte Adresse und Schlüssel eintragen', 'warn'); return; }
          saveSettings({ mode: 'supabase', url: s.fromConfig ? '' : u, key: s.fromConfig ? '' : k });
          await start(); location.hash = '#/beitreten';
        },
      }, 'Verbinden')),
    h('div', { class: 'card' },
      h('h2', {}, 'Nur auf diesem Gerät'),
      h('p', { class: 'muted' }, 'Zum Ausprobieren oder ohne Internet. Alles bleibt im Browser dieses Geräts; andere können nicht mitmachen. Daten lassen sich exportieren.'),
      h('button', { class: 'btn', onclick: async () => { saveSettings({ ...storeSettings(), mode: 'local', url: s.fromConfig ? '' : s.url, key: s.fromConfig ? '' : s.key }); await start(); location.hash = '#/beitreten'; } }, 'Lokal starten')),
  );
}

async function joinView(el) {
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  const local = state.store.mode === 'local';
  const code = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Einladungscode', value: params.get('code') || '' });
  const kz = h('input', { type: 'text', maxlength: 20, placeholder: 'z. B. ST', value: (state.store.session() || {}).kuerzel || '' });
  const btn = h('button', { class: 'btn primary' }, local ? 'Los geht’s' : 'Beitreten');
  btn.onclick = async () => {
    if (!kz.value.trim()) { toast('Bitte ein Kürzel eintragen', 'warn'); return; }
    if (!local && !code.value.trim()) { toast('Bitte den Einladungscode eintragen', 'warn'); return; }
    btn.disabled = true; btn.textContent = 'Einen Moment …';
    try {
      await state.store.join(code.value, kz.value);
      await Promise.all([refreshModels(), refreshMembers()]);
      toast(`Willkommen, ${state.store.session().kuerzel}!`, 'ok');
      location.hash = '#/';
    } catch (e) { toast(e.message, 'error', 6000); btn.disabled = false; btn.textContent = 'Beitreten'; }
  };
  put(el, 
    h('h1', {}, 'Varroa-Kalibrierung'),
    h('div', { class: 'card' },
      h('p', {}, local ? 'Lokaler Modus: Du bist automatisch Admin.' : 'Zum Mitmachen brauchst du den Einladungscode. Es gibt kein Konto und keine E-Mail-Adresse, nur dein Kürzel.'),
      local ? null : h('label', {}, 'Einladungscode', code),
      h('label', {}, 'Dein Kürzel (für andere sichtbar)', kz),
      btn),
    h('p', { class: 'center' }, h('a', { href: '#/einrichten' }, 'Verbindung ändern')),
  );
}

// --- Start ----------------------------------------------------------------------
async function homeView(el) {
  const me = state.store.session();
  const [imgs] = await Promise.all([state.store.listImages(), refreshModels(), refreshMembers()]);
  const n = s => imgs.filter(i => i.status === s).length;
  const second = imgs.filter(i => i.status === 'geprueft' && i.reviewed_by !== me.id);
  const firstNew = imgs.filter(i => i.status === 'neu').sort((a, b) => (a.split === 'test' ? -1 : 1) - (b.split === 'test' ? -1 : 1))[0];
  const conf = imgs.filter(i => i.status === 'bestaetigt');
  const confTest = conf.filter(i => i.split === 'test').length;
  const lm = latestModel();
  put(el, 
    h('h1', {}, 'Übersicht'),
    h('div', { class: 'kpis' },
      kpi(n('neu'), 'zu prüfen'),
      kpi(second.length, 'Zweitprüfung für dich'),
      kpi(conf.length, `bestätigt (${confTest} Test)`),
    ),
    confTest === 0 && imgs.some(i => i.split === 'test') ? h('div', { class: 'card hint' }, 'Tipp: Prüfe zuerst die Testbilder. Erst wenn Testbilder bestätigt sind, zeigt die Statistik, wie gut die App zählt.') : null,
    h('div', { class: 'actions' },
      h('a', { class: 'btn primary big', href: '#/hochladen' }, '＋ Windelfoto hochladen'),
      firstNew ? h('a', { class: 'btn big', href: `#/pruefen/${firstNew.id}` }, `Nächstes Bild prüfen${firstNew.split === 'test' ? ' (Test)' : ''}`) : null,
      second[0] ? h('a', { class: 'btn big', href: `#/pruefen/${second[0].id}` }, 'Zweitprüfung starten') : null,
      h('a', { class: 'btn big', href: '#/statistik' }, 'Statistik'),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Zählmodell'),
      lm ? h('p', {}, `Aktuell: Version ${lm.id} vom ${fmtDateTime(lm.created_at)} - gelernt aus ${lm.n_images ?? '?'} ${lm.n_images === 1 ? 'Bild' : 'Bildern'} (${lm.n_pos ?? '?'} Milben).`) : h('p', {}, 'Noch kein Modell.'),
      lm && lm.note ? h('p', { class: 'muted' }, lm.note) : null,
      h('p', { class: 'muted' }, 'Jedes bestätigte Trainingsbild erzeugt automatisch eine neue Version. Testbilder werden nie zum Lernen verwendet.')),
  );
}
const kpi = (v, l) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-v' }, v), h('div', { class: 'kpi-l' }, l));

// --- Bilderliste ----------------------------------------------------------------
async function listView(el) {
  const imgs = await state.store.listImages();
  await refreshMembers();
  const filter = h('select', {},
    h('option', { value: 'alle' }, 'Alle'), h('option', { value: 'neu' }, 'Zu prüfen'),
    h('option', { value: 'geprueft' }, 'Wartet auf Zweitprüfung'), h('option', { value: 'bestaetigt' }, 'Bestätigt'));
  const list = h('div', { class: 'list' });
  const render = () => {
    list.innerHTML = '';
    const f = filter.value;
    const sel = imgs.filter(i => f === 'alle' || i.status === f);
    if (!sel.length) put(list, h('p', { class: 'muted center' }, 'Keine Bilder.'));
    for (const i of sel) {
      const th = h('div', { class: 'thumb' });
      state.store.getBlob(i.thumb_path).then(b => { th.style.backgroundImage = `url(${URL.createObjectURL(b)})`; }).catch(() => {});
      put(list, h('a', { class: 'item', href: `#/bild/${i.id}` }, th,
        h('div', { class: 'item-body' },
          h('div', { class: 'item-title' }, i.file_name || 'Foto', ' ', h('span', { class: `chip ${i.split}` }, SPLIT_LABEL[i.split])),
          h('div', { class: 'muted small' }, [fmtDate(i.taken_at || i.created_at), i.colony && `Volk ${i.colony}`, i.site].filter(Boolean).join(' · ')),
          h('div', { class: 'small' }, h('span', { class: `chip st-${i.status}` }, STATUS_LABEL[i.status]),
            i.n_mites !== null && i.n_mites !== undefined && i.status !== 'neu' ? ` ${i.n_mites} Milben geprüft` : ''),
        )));
    }
  };
  filter.onchange = render; render();
  put(el, h('div', { class: 'row between' }, h('h1', {}, 'Bilder'), filter), list);
}

// --- Bilddetails ------------------------------------------------------------------
async function detailView(el, id) {
  const rec = await state.store.getImage(id);
  const me = state.store.session(); const admin = me.role === 'admin';
  await Promise.all([refreshModels(), refreshMembers()]);
  const lm = latestModel();
  const appCount = lm ? countWithModel(lm.model, rec) : null;
  const viewer = h('div', { class: 'viewer' });
  const pts = (rec.annotations && rec.annotations.points) || [];
  const days = rec.inserted_at && rec.removed_at ? (new Date(rec.removed_at) - new Date(rec.inserted_at)) / 864e5 : null;
  const canReview = rec.status === 'neu' || (rec.status === 'geprueft' && (rec.reviewed_by !== me.id || admin)) || admin;
  put(el, 
    h('div', { class: 'row between' }, h('a', { href: '#/bilder', class: 'back' }, '‹ Bilder'), h('span', { class: `chip st-${rec.status}` }, STATUS_LABEL[rec.status])),
    h('h1', {}, rec.file_name || 'Windelfoto'),
    viewer,
    h('div', { class: 'card' },
      table([
        ['Aufnahme', fmtDateTime(rec.taken_at)], ['Gerät', rec.device || '–'],
        ['Volk / Standort', [rec.colony, rec.site].filter(Boolean).join(' · ') || '–'],
        ['Einlage', `${fmtDateTime(rec.inserted_at)} bis ${fmtDateTime(rec.removed_at)}${days ? ` (${days.toFixed(1)} Tage)` : ''}`],
        ['Maßstab', `${(+rec.px_per_mm).toFixed(2)} px/mm${rec.scale_source ? ` (${rec.scale_source})` : ''}`],
        ['Gruppe', SPLIT_LABEL[rec.split]],
        ['Kandidaten', rec.n_candidates ?? '–'],
        ['App-Zählung', appCount === null ? '–' : `${appCount} Milben (Modell v${lm.id})`],
        ['Geprüfte Zählung', rec.status === 'neu' ? 'noch nicht geprüft' : `${rec.n_mites} Milben${days ? ` = ${(rec.n_mites / days).toFixed(1)} pro Tag` : ''}`],
        ['Geprüft von', memberName(rec.reviewed_by)], ['Bestätigt von', memberName(rec.confirmed_by)],
      ])),
    h('div', { class: 'actions' },
      canReview ? h('a', { class: 'btn primary', href: `#/pruefen/${id}` }, rec.status === 'neu' ? 'Prüfen' : rec.status === 'geprueft' ? 'Zweitprüfung' : 'Prüfung ansehen/ändern') : null,
      rec.status === 'neu' || admin ? h('a', { class: 'btn', href: `#/bearbeiten/${id}` }, 'Ecken, Maßstab & Angaben ändern') : null,
      admin ? h('button', { class: 'btn', onclick: async () => {
        const split = rec.split === 'test' ? 'train' : 'test';
        if (!await confirmDialog(`Bild zur Gruppe „${SPLIT_LABEL[split]}“ verschieben?${rec.status === 'bestaetigt' ? ' Die Statistik ändert sich dadurch.' : ''}`)) return;
        await state.store.updateImage(id, { split }); toast('Gespeichert', 'ok'); route();
      } }, 'Test/Training tauschen') : null,
      admin && rec.status !== 'neu' ? h('button', { class: 'btn', onclick: async () => {
        if (!await confirmDialog('Prüfung zurücksetzen? Die Markierungen bleiben erhalten, das Bild muss aber neu geprüft und bestätigt werden.')) return;
        await state.store.updateImage(id, { status: 'neu', reviewed_by: null, confirmed_by: null }); toast('Zurückgesetzt', 'ok'); route();
      } }, 'Zurücksetzen') : null,
      admin ? h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog('Bild und alle Markierungen endgültig löschen? Das lässt sich nicht rückgängig machen.', 'Löschen', true)) return;
        await state.store.deleteImage(rec); toast('Gelöscht', 'ok'); location.hash = '#/bilder';
      } }, 'Löschen') : null,
    ),
  );
  const blob = await state.store.getBlob(rec.file_path);
  const { url } = await loadImage(blob);
  const r = 1.3 * rec.px_per_mm;
  const zv = new ZoomView(viewer, {
    src: url, width: rec.width, height: rec.height,
    renderOverlay: (svg, s) => {
      if (rec.roi) svg.append(svgEl('polygon', { points: rec.roi.map(p => p.join(',')).join(' '), class: 'roi' }));
      for (const p of pts) {
        if (p.l === 'k') continue;
        marker(svg, p.x, p.y, Math.max(r, 9 / s), p.l === 'u' ? 'unsure' : p.o === 'n' ? 'added' : p.p ? 'pre' : 'mite');
      }
    },
  });
  return () => { zv.destroy(); URL.revokeObjectURL(url); };
}

function table(rows) {
  return h('table', { class: 'kv' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
}

// --- Einstellungen --------------------------------------------------------------
async function settingsView(el) {
  const me = state.store.session(); const admin = me.role === 'admin';
  await refreshMembers();
  put(el, 
    h('h1', {}, 'Einstellungen'),
    h('div', { class: 'card' },
      table([['Kürzel', me.kuerzel], ['Rolle', admin ? 'Admin' : 'Mitglied'], ['Speicher', state.store.mode === 'local' ? 'nur dieses Gerät' : 'Supabase (gemeinsam)']]),
      h('div', { class: 'row gap wrap' },
        h('a', { class: 'btn', href: '#/beitreten' }, 'Kürzel ändern'),
        h('button', { class: 'btn ghost', onclick: async () => { if (await confirmDialog('Auf diesem Gerät abmelden?')) { await state.store.leave(); location.hash = '#/beitreten'; } } }, 'Abmelden'),
        h('a', { class: 'btn ghost', href: '#/einrichten' }, 'Verbindung ändern'))),
    state.store.mode === 'supabase' ? h('div', { class: 'card' },
      h('h2', {}, 'Andere einladen'),
      h('p', {}, 'Schicke den Link zur App und den Einladungscode. Mitglieder tragen nur ein Kürzel ein.'),
      h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(location.origin + location.pathname + '#/beitreten').then(() => toast('Link kopiert', 'ok')); } }, 'App-Link kopieren'),
      h('h3', {}, 'Mitglieder'),
      h('ul', {}, state.members.map(m => h('li', {}, `${m.kuerzel}${m.role === 'admin' ? ' (Admin)' : ''}`)))) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Daten'),
      h('p', { class: 'muted' }, 'Der Export enthält alle Angaben, Kandidaten und Prüfergebnisse (ohne Fotos). Damit lässt sich später ein größeres Erkennungsmodell trainieren.'),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', onclick: exportData }, 'Export (JSON)'),
        admin ? h('button', { class: 'btn', onclick: async () => {
          try { const m = await retrain('manuell neu berechnet'); toast(`Modell v${m.id} berechnet`, 'ok'); } catch (e) { toast(e.message, 'error', 6000); }
        } }, 'Modell jetzt neu berechnen') : null)),
    h('p', { class: 'muted small center' }, 'Varroa-Kalibrierung · Kandidatensuche G1'),
  );
}

async function exportData() {
  const [images, models] = await Promise.all([state.store.listImagesFull(), state.store.listModels()]);
  const out = { exported_at: new Date().toISOString(), members: state.members.map(m => ({ id: m.id, kuerzel: m.kuerzel })), models, images };
  download(`varroa-kalibrierung-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out));
}

// --- Start der App ----------------------------------------------------------------
async function start() {
  try {
    await openStore();
    if (state.store && state.store.session()) await Promise.all([refreshModels(), refreshMembers()]);
  } catch (e) {
    console.error(e); toast('Verbindung fehlgeschlagen: ' + e.message, 'error', 8000);
    state.store = null;
  }
}

window.addEventListener('hashchange', route);
(async () => {
  await loadSeed();
  await start();
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

export { route };
