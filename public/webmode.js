// Freehub web mode: lets the same page run with NO server (GitHub Pages).
// If a Freehub server answers /api/info we do nothing. Otherwise we stand in for the server:
//   - rides, plans, routes, profile are kept in this browser (IndexedDB)
//   - Strava keys + tokens are kept in this browser (localStorage) and Strava is called directly
// Add ?web to the address to force this mode while testing against the local server.
(function () {
  let server = false;
  try {
    const x = new XMLHttpRequest(); x.open('GET', 'api/info', false); x.send();
    server = x.status === 200 && /json/.test(x.getResponseHeader('content-type') || '');
  } catch (e) {}
  if (/[?&]web\b/.test(location.search)) server = false;
  window.FREEHUB_WEB = !server;
  if (server) return;

  const realFetch = window.fetch.bind(window);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

  // ---------- storage: IndexedDB with an in-memory fallback ----------
  const mem = new Map(); let memOnly = false;
  const dbp = new Promise((res, rej) => {
    try { const r = indexedDB.open('freehub', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
    catch (e) { rej(e); }
  }).catch(() => { memOnly = true; window.FREEHUB_MEMONLY = true; return null; });
  const op = (mode, fn) => dbp.then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', mode), r = fn(t.objectStore('kv'));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  const kvGet = async k => { await dbp; if (memOnly) return mem.get(k); const v = await op('readonly', s => s.get(k)); return v === undefined ? undefined : v; };
  const kvSet = async (k, v) => { await dbp; if (memOnly) { mem.set(k, v); return; } await op('readwrite', s => s.put(v, k)); };
  const kvDel = async k => { await dbp; if (memOnly) { mem.delete(k); return; } await op('readwrite', s => s.delete(k)); };
  const kvAll = async prefix => {
    await dbp;
    if (memOnly) return [...mem.entries()].filter(([k]) => k.startsWith(prefix));
    return new Promise((res, rej) => {
      const out = [];
      dbp.then(db => {
        const s = db.transaction('kv', 'readonly').objectStore('kv'), c = s.openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
        c.onsuccess = () => { const cur = c.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else res(out); };
        c.onerror = () => rej(c.error);
      });
    });
  };

  // ---------- Strava (keys + tokens live only in this browser) ----------
  const SK = 'freehub.web.strava';
  const sget = () => { try { return JSON.parse(localStorage.getItem(SK)) || {}; } catch { return {}; } };
  const sset = o => { try { localStorage.setItem(SK, JSON.stringify(o)); } catch (e) { throw new Error('This browser would not let Freehub store the Strava keys (private window?).'); } };
  const BLOCKED = 'Your browser was not allowed to talk to Strava directly from this page. The rest of Freehub works; to get a ride onto Strava, download its .tcx file from History and upload it at strava.com/upload/select.';

  async function tokenRequest(params) {
    const s = sget();
    let r;
    try { r = await realFetch('https://www.strava.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...params }) }); }
    catch (e) { throw new Error(BLOCKED); }
    if (!r.ok) throw new Error('Strava token error: ' + (await r.text()));
    const j = await r.json();
    const old = s.tokens || {};
    s.tokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
      athlete: j.athlete ? `${j.athlete.firstname} ${j.athlete.lastname}` : old.athlete, scope: old.scope };
    sset(s);
    return s.tokens;
  }
  async function validToken() {
    let t = sget().tokens;
    if (!t) throw new Error('Not connected to Strava');
    if (t.expires_at - 60 < Date.now() / 1000) t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return t.access_token;
  }
  async function stravaUpload({ tcx, name, description }) {
    const token = await validToken();
    const form = new FormData();
    form.append('file', new Blob([tcx], { type: 'application/xml' }), 'ride.tcx');
    form.append('data_type', 'tcx'); form.append('sport_type', 'VirtualRide'); form.append('trainer', '1');
    form.append('name', name || 'Indoor Ride'); if (description) form.append('description', description);
    let r, up;
    try { r = await realFetch('https://www.strava.com/api/v3/uploads', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }); up = await r.json(); }
    catch (e) { return { status: 502, body: { error: BLOCKED } }; }
    if (!r.ok) {
      const missing = r.status === 401 || r.status === 403 || (up.errors || []).some(e => e.code === 'missing' || /activity:write/.test(e.field || ''));
      const detail = (up.errors || []).map(e => `${e.resource || ''} ${e.field || ''} ${e.code || ''}`.trim()).join('; ');
      return { status: r.status, body: { error: missing
        ? 'Strava refused the upload because upload permission was not granted. Click "Disconnect Strava", then "Connect Strava" again and make sure "Upload your activities" is ticked.'
        : `Strava said: ${up.message || 'error'}${detail ? ' (' + detail + ')' : ''}` } };
    }
    try {
      for (let i = 0; i < 10 && !up.activity_id && !up.error; i++) {
        await new Promise(s => setTimeout(s, 2000));
        up = await (await realFetch(`https://www.strava.com/api/v3/uploads/${up.id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
      }
    } catch (e) { /* the upload itself was accepted */ }
    if (up.error) return { status: 422, body: { error: up.error } };
    return { status: 200, body: { activityId: up.activity_id || null, status: up.status } };
  }

  // Strava sends the rider back here with ?code=...&scope=...
  const ready = (async () => {
    const q = new URLSearchParams(location.search), code = q.get('code');
    if (!code && !q.get('error')) return;
    try {
      if (code && sget().clientId) { await tokenRequest({ grant_type: 'authorization_code', code }); const s = sget(); s.tokens.scope = q.get('scope') || ''; sset(s); window.FREEHUB_JUST_CONNECTED = true; }
      else if (q.get('error')) window.FREEHUB_AUTH_ERROR = 'Strava authorisation was denied.';
    } catch (e) { window.FREEHUB_AUTH_ERROR = e.message; }
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  })();

  // ---------- the fake server ----------
  window.fetch = async function (input, init = {}) {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    const m = u.origin === location.origin && u.pathname.match(/(\/(?:api|auth)\/.*)$/);
    if (!m) return realFetch(input, init);
    const p = m[1], method = (init.method || 'GET').toUpperCase();
    await ready;
    const body = () => { try { return JSON.parse(init.body); } catch { return {}; } };
    try {
      if (p === '/api/info') return J({ companionUrls: [], web: true });
      if (p === '/api/state') return J({ ok: true });
      if (p === '/api/status') {
        const s = sget(), t = s.tokens;
        return J({ configured: !!(s.clientId && s.clientSecret), connected: !!t, athlete: t && t.athlete, clientId: s.clientId || null, web: true,
          canUpload: t && t.scope ? t.scope.includes('activity:write') : null });
      }
      if (p === '/api/setup/strava' && method === 'POST') {
        const b = body(), id = String(b.clientId || '').trim(), sec = String(b.clientSecret || '').trim();
        if (!/^\d{3,10}$/.test(id)) return J({ error: 'The Client ID should be a number (for example 123456).' }, 400);
        if (!/^[0-9a-f]{20,64}$/i.test(sec)) return J({ error: 'The Client Secret should be a long mix of letters and numbers (about 40 characters).' }, 400);
        const s = sget(); if (s.clientId !== id || s.clientSecret !== sec) delete s.tokens;
        s.clientId = id; s.clientSecret = sec; sset(s); return J({ ok: true });
      }
      if (p === '/api/setup/test') return J(await testKeys(sget()));
      if (p === '/auth/disconnect') { const s = sget(); delete s.tokens; sset(s); return J({ ok: true }); }
      if (p === '/api/upload' && method === 'POST') { const o = await stravaUpload(body()); return J(o.body, o.status); }

      let r = p.match(/^\/api\/store\/([a-z]+)$/);
      if (r) {
        if (!['custom', 'plans', 'profile', 'routes'].includes(r[1])) return J({ error: 'Unknown store' }, 404);
        if (method === 'GET') { const v = await kvGet('store:' + r[1]); return J(v === undefined ? null : v); }
        if (method === 'PUT') { await kvSet('store:' + r[1], body()); return J({ ok: true }); }
      }
      if (p === '/api/rides' && method === 'GET') {
        const list = (await kvAll('ride:')).map(([, v]) => v).filter(Boolean).map(({ series, wkActual, ...rest }) => rest)
          .sort((x, y) => String(y.start).localeCompare(String(x.start)));
        return J(list);
      }
      r = p.match(/^\/api\/rides\/([0-9A-Za-z_-]{1,64})(?:\/(tcx|upload))?$/);
      if (r) {
        const id = r[1], sub = r[2], rec = await kvGet('ride:' + id);
        if (!sub && method === 'GET') return rec ? J(rec) : J({ error: 'Not found' }, 404);
        if (!sub && method === 'PUT') {
          const { record, tcx } = body();
          if (!record || record.id !== id) return J({ error: 'Record id mismatch' }, 400);
          await kvSet('ride:' + id, { ...record, strava: record.strava || (rec && rec.strava) || null, savedAt: new Date().toISOString() });
          if (typeof tcx === 'string' && tcx) await kvSet('tcx:' + id, tcx);
          return J({ ok: true });
        }
        if (!sub && method === 'DELETE') { await kvDel('ride:' + id); await kvDel('tcx:' + id); return J({ ok: true }); }
        if (sub === 'tcx' && method === 'GET') {
          const t = await kvGet('tcx:' + id);
          return t ? new Response(t, { status: 200, headers: { 'Content-Type': 'application/xml' } }) : J({ error: 'No file stored for this ride' }, 404);
        }
        if (sub === 'upload' && method === 'POST') {
          const t = await kvGet('tcx:' + id); if (!rec || !t) return J({ error: 'Ride not found' }, 404);
          const b = body(), name = (b.name || rec.name || 'Indoor Ride').slice(0, 100);
          const o = await stravaUpload({ tcx: t, name, description: b.description || 'Recorded with Freehub' });
          if (o.status === 200) { rec.name = name; rec.strava = { activityId: o.body.activityId, uploadedAt: new Date().toISOString() }; await kvSet('ride:' + id, rec); }
          return J(o.body, o.status);
        }
      }
      return J({ error: 'Not available in the browser version' }, 404);
    } catch (e) { return J({ error: e.message }, 500); }
  };

  // Does Strava recognise these keys, and can this browser reach Strava at all?
  async function testKeys(s) {
    if (!s.clientId || !s.clientSecret) return { ok: false, message: 'Enter and save your keys first.' };
    let r, j = {};
    try { r = await realFetch('https://www.strava.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, grant_type: 'authorization_code', code: 'freehub-key-check' }) }); }
    catch (e) { return { ok: false, blocked: true, message: BLOCKED }; }
    try { j = await r.json(); } catch (e) {}
    const errs = j.errors || [];
    if (errs.some(e => e.resource === 'Application')) return { ok: false, message: 'Strava does not recognise this Client ID / Secret pair. Check you copied both from your Strava API page.' };
    return { ok: true, message: 'This browser can reach Strava and the keys look right. Click Connect Strava to finish.' };
  }

  // ---------- backup / restore ----------
  window.freehubWeb = {
    async exportAll() {
      const kv = {}; for (const [k, v] of await kvAll('')) kv[k] = v;
      const ls = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('freehub.') && k !== SK) ls[k] = localStorage.getItem(k); } } catch (e) {}
      const blob = new Blob([JSON.stringify({ freehubBackup: 1, date: new Date().toISOString(), kv, ls })], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `freehub-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Object.keys(kv).length;
    },
    async importAll(file) {
      let d; try { d = JSON.parse(await file.text()); } catch (e) { throw new Error('That file is not a Freehub backup.'); }
      if (!d || d.freehubBackup !== 1 || typeof d.kv !== 'object') throw new Error('That file is not a Freehub backup.');
      let n = 0; for (const [k, v] of Object.entries(d.kv)) { if (/^(store|ride|tcx):/.test(k)) { await kvSet(k, v); n++; } }
      try { for (const [k, v] of Object.entries(d.ls || {})) if (k.startsWith('freehub.') && k !== SK) localStorage.setItem(k, v); } catch (e) {}
      return n;
    },
  };

  // The TCX download link in History is a plain <a>: serve it from the browser store
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href*="/api/rides/"][href$="/tcx"]'); if (!a) return;
    e.preventDefault();
    const id = decodeURIComponent(a.getAttribute('href').match(/\/api\/rides\/([^/]+)\/tcx/)[1]), t = await kvGet('tcx:' + id);
    if (!t) return alert('No file stored for this ride.');
    const l = document.createElement('a'); l.href = URL.createObjectURL(new Blob([t], { type: 'application/xml' })); l.download = `ride-${id}.tcx`;
    document.body.appendChild(l); l.click(); setTimeout(() => { URL.revokeObjectURL(l.href); l.remove(); }, 1000);
  }, true);

  // Fake the command stream (no phone companion without a server)
  window.EventSource = function () { return { close() {}, onmessage: null, onerror: null, addEventListener() {} }; };
})();
