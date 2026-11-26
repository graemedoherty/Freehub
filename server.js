// Zero-dependency server: dashboard, companion page, Strava OAuth + upload, and a tiny
// state/command relay so the phone companion can mirror and control the ride.
// Requires Node 18+.
if (typeof fetch !== 'function' || typeof FormData === 'undefined') {
  console.error(`\nFreehub needs Node.js 18 or newer, but this is ${process.version}.\nUpdate it (macOS: "brew upgrade node", or download the LTS installer from https://nodejs.org), then run "node server.js" again.\n`);
  process.exit(1);
}
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
// Packaged app: Electron points FREEHUB_DATA at the user's app-data folder (config.json, tokens.json and data/ live there).
const HOME_DIR = process.env.FREEHUB_DATA || __dirname;
const TOKEN_FILE = path.join(HOME_DIR, 'tokens.json');

let cfg = {};
const CFG_PATH = path.join(HOME_DIR, 'config.json');
let cfgProblem = null;
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
catch (e) {
  if (e.code === 'ENOENT') {
    const txt = fs.existsSync(CFG_PATH + '.txt') ? ' (I found "config.json.txt": rename it to remove the ".txt")' : '';
    cfgProblem = `No config.json found in ${HOME_DIR}${txt}`;
  } else cfgProblem = `config.json can't be read as JSON: ${e.message}. Check for curly quotes, a missing comma or brace, or rich-text formatting.`;
}
let CLIENT_ID = process.env.STRAVA_CLIENT_ID || cfg.clientId;
let CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || cfg.clientSecret;

const loadTokens = () => { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } };
const saveTokens = (t) => fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));

async function tokenRequest(params) {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  if (!r.ok) throw new Error('Strava token error: ' + (await r.text()));
  const j = await r.json();
  const t = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
              athlete: j.athlete ? `${j.athlete.firstname} ${j.athlete.lastname}` : (loadTokens() || {}).athlete,
              scope: (loadTokens() || {}).scope };
  saveTokens(t);
  return t;
}

async function validToken() {
  let t = loadTokens();
  if (!t) throw new Error('Not connected to Strava');
  if (t.expires_at - 60 < Date.now() / 1000) t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  return t.access_token;
}

const readBody = (req, limit = 1e6) => new Promise((res, rej) => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > limit) { rej(new Error('Body too large')); req.destroy(); } });
  req.on('end', () => res(d)); req.on('error', rej);
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// ---- Persistent data (rides, custom sessions, plans) in ./data ----
const DATA_DIR = path.join(HOME_DIR, 'data'), RIDES_DIR = path.join(DATA_DIR, 'rides');
fs.mkdirSync(RIDES_DIR, { recursive: true });
const okId = (id) => /^[0-9A-Za-z_-]{1,64}$/.test(id);
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, f); };
const STORES = new Set(['custom', 'plans', 'profile', 'routes']);   // profile: FTP history + measured Zone 2; routes: imported GPX rides
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

async function stravaUpload({ tcx, name, description }) {
  const token = await validToken();
  const form = new FormData();
  form.append('file', new Blob([tcx], { type: 'application/xml' }), 'ride.tcx');
  form.append('data_type', 'tcx');
  form.append('sport_type', 'VirtualRide');
  form.append('trainer', '1');
  form.append('name', name || 'Indoor Ride');
  if (description) form.append('description', description);
  const r = await fetch('https://www.strava.com/api/v3/uploads', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  let up = await r.json();
  console.log('Strava upload response:', r.status, JSON.stringify(up));
  if (!r.ok) {
    const missing = r.status === 401 || r.status === 403 || (up.errors || []).some(e => e.code === 'missing' || /activity:write/.test(e.field || ''));
    const detail = (up.errors || []).map(e => `${e.resource || ''} ${e.field || ''} ${e.code || ''}`.trim()).join('; ');
    return { status: r.status, body: { error: missing
      ? 'Strava refused the upload because upload permission was not granted. Click "Disconnect Strava", then "Connect Strava" again and make sure "Upload your activities" is ticked.'
      : `Strava said: ${up.message || 'error'}${detail ? ' (' + detail + ')' : ''}` } };
  }
  for (let i = 0; i < 10 && !up.activity_id && !up.error; i++) {
    await new Promise(s => setTimeout(s, 2000));
    const p = await fetch(`https://www.strava.com/api/v3/uploads/${up.id}`, { headers: { Authorization: `Bearer ${token}` } });
    up = await p.json();
    console.log('Strava upload status:', JSON.stringify(up));
  }
  if (up.error) return { status: 422, body: { error: up.error } };
  return { status: 200, body: { activityId: up.activity_id || null, status: up.status } };
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---- Live state relay (main dashboard -> companions) and command relay (companions -> dashboard)
let lastState = null;
const companions = new Set();   // SSE clients watching the ride
const hosts = new Set();        // SSE clients receiving commands (the dashboard on this Mac)
const COMMANDS = new Set(['start', 'pause', 'resume', 'finish', 'upload', 'discard', 'done', 'skip',
  'yt-open', 'yt-toggle', 'yt-mute', 'yt-hud', 'yt-size', 'yt-exit']);   // yt-* control YouTube mode on the dashboard

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
}
const send = (set, obj) => { const m = `data: ${JSON.stringify(obj)}\n\n`; for (const c of set) c.write(m); };
setInterval(() => { for (const c of [...companions, ...hosts]) c.write(': ping\n\n'); }, 15000);

// Routes reachable from other devices on your network (phone companion). Everything else is Mac-only.
const LAN_ROUTES = new Set(['/companion', '/api/state-stream', '/api/cmd']);

// Never let one bad request take the whole server (and the phone companion) down
process.on('uncaughtException', e => console.error('Freehub error (still running):', e && e.stack || e));
process.on('unhandledRejection', e => console.error('Freehub error (still running):', e && e.stack || e));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    if (!LAN_ROUTES.has(url.pathname) && !url.pathname.startsWith('/images/') && !url.pathname.startsWith('/fonts/') && !isLocal(req)) { res.writeHead(403); return res.end('Local access only'); }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (url.pathname === '/webmode.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'webmode.js')));
    }
    if (url.pathname === '/qrcode.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'qrcode.js')));
    }
    if (url.pathname === '/companion') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'companion.html')));
    }
    if (url.pathname === '/api/info') {
      return json(res, 200, { companionUrls: lanIps().map(ip => `http://${ip}:${PORT}/companion`) });
    }
    if (url.pathname === '/api/status') {
      const t = loadTokens();
      return json(res, 200, { configured: !!(CLIENT_ID && CLIENT_SECRET), connected: !!t, athlete: t && t.athlete, clientId: CLIENT_ID || null,
        canUpload: t && t.scope ? t.scope.includes('activity:write') : null });
    }

    // Dashboard publishes state
    if (url.pathname === '/api/state' && req.method === 'POST') {
      lastState = JSON.parse(await readBody(req, 50e3));
      send(companions, lastState);
      return json(res, 200, { ok: true });
    }
    // Companion subscribes to state
    if (url.pathname === '/api/state-stream') {
      sse(res);
      if (lastState) res.write(`data: ${JSON.stringify(lastState)}\n\n`);
      companions.add(res); req.on('close', () => companions.delete(res));
      return;
    }
    // Dashboard subscribes to commands
    if (url.pathname === '/api/cmd-stream') {
      sse(res); hosts.add(res); req.on('close', () => hosts.delete(res));
      return;
    }
    // Companion sends a command
    if (url.pathname === '/api/cmd' && req.method === 'POST') {
      const { cmd, name, url: link } = JSON.parse(await readBody(req, 2e3));
      if (!COMMANDS.has(cmd)) return json(res, 400, { error: 'Unknown command' });
      send(hosts, { cmd, name: typeof name === 'string' ? name.slice(0, 100) : undefined, url: typeof link === 'string' ? link.slice(0, 300) : undefined });
      return json(res, 200, { ok: true, delivered: hosts.size > 0 });
    }

    // Guided Strava setup: the page sends the two keys, we write them to config.json (this computer only: see the isLocal check above).
    // The secret is never sent back to the page.
    if (url.pathname === '/api/setup/strava' && req.method === 'POST') {
      const origin = req.headers.origin;   // refuse requests triggered by other websites
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: 'Not allowed from this site' });
      const b = JSON.parse(await readBody(req, 5e3));
      const id = String(b.clientId || '').trim(), sec = String(b.clientSecret || '').trim();
      if (!/^\d{3,10}$/.test(id)) return json(res, 400, { error: 'The Client ID should be a number (for example 123456).' });
      if (!/^[0-9a-f]{20,64}$/i.test(sec)) return json(res, 400, { error: 'The Client Secret should be a long mix of letters and numbers (about 40 characters).' });
      if (cfgProblem && fs.existsSync(CFG_PATH)) { try { fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak'); } catch {} cfg = {}; }   // unreadable file: keep a copy, start fresh
      const changed = id !== CLIENT_ID || sec !== CLIENT_SECRET;
      cfg = { ...cfg, clientId: id, clientSecret: sec };
      const tmp = CFG_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, CFG_PATH);
      CLIENT_ID = id; CLIENT_SECRET = sec; cfgProblem = null;
      if (changed) { try { fs.unlinkSync(TOKEN_FILE); } catch {} }   // tokens belonged to the old app
      console.log(`Strava keys saved to ${CFG_PATH} (client ID ${id}).`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/setup/test') {
      if (!CLIENT_ID || !CLIENT_SECRET) return json(res, 200, { ok: false, message: 'Enter and save your keys first.' });
      let j = {};
      try { const r = await fetch('https://www.strava.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code: 'freehub-key-check' }) }); j = await r.json(); }
      catch (e) { return json(res, 200, { ok: false, message: 'Could not reach Strava from this computer. Check your internet connection.' }); }
      if ((j.errors || []).some(e => e.resource === 'Application')) return json(res, 200, { ok: false, message: 'Strava does not recognise this Client ID / Secret pair. Check you copied both from your Strava API page.' });
      return json(res, 200, { ok: true, message: 'Strava recognised the keys. Click Connect Strava to finish.' });
    }

    if (url.pathname === '/auth/strava') {
      if (!CLIENT_ID) { res.writeHead(500); return res.end('Set Strava client ID/secret first (see README).'); }
      const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: `${BASE}/auth/callback`,
        approval_prompt: 'force', scope: 'activity:write,read' });
      res.writeHead(302, { Location: 'https://www.strava.com/oauth/authorize?' + q });
      return res.end();
    }
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); return res.end('Authorisation was denied.'); }
      const scope = url.searchParams.get('scope') || '';
      const t = await tokenRequest({ grant_type: 'authorization_code', code });
      saveTokens({ ...t, scope });
      console.log('Strava connected. Permissions granted:', scope || '(none reported)');
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    if (url.pathname === '/auth/disconnect') {
      try { fs.unlinkSync(TOKEN_FILE); } catch {}
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const out = await stravaUpload(JSON.parse(await readBody(req, 20e6)));
      return json(res, out.status, out.body);
    }

    // ---- static images (logo etc.) ----
    if (url.pathname.startsWith('/images/')) {
      const full = path.join(__dirname, 'public', 'images', path.basename(url.pathname));
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(full));
    }

    // ---- bundled font (served to the phone companion too) ----
    if (url.pathname.startsWith('/fonts/')) {
      const full = path.join(__dirname, 'public', 'fonts', path.basename(url.pathname));
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(full));
    }

    // ---- small JSON stores: custom sessions, training plans ----
    let m = url.pathname.match(/^\/api\/store\/([a-z]+)$/);
    if (m) {
      if (!STORES.has(m[1])) return json(res, 404, { error: 'Unknown store' });
      const file = path.join(DATA_DIR, m[1] + '.json');
      if (req.method === 'GET') return json(res, 200, readJson(file, null));
      if (req.method === 'PUT') { writeJson(file, JSON.parse(await readBody(req, 5e6))); return json(res, 200, { ok: true }); }
    }

    // ---- ride history ----
    if (url.pathname === '/api/rides' && req.method === 'GET') {
      const list = fs.readdirSync(RIDES_DIR).filter(n => n.endsWith('.json')).map(n => readJson(path.join(RIDES_DIR, n), null)).filter(Boolean)
        .map(({ series, wkActual, ...rest }) => rest).sort((x, y) => String(y.start).localeCompare(String(x.start)));
      return json(res, 200, list);
    }
    m = url.pathname.match(/^\/api\/rides\/([^/]+)(?:\/(tcx|upload))?$/);
    if (m) {
      const id = m[1], sub = m[2];
      if (!okId(id)) return json(res, 400, { error: 'Bad ride id' });
      const jf = path.join(RIDES_DIR, id + '.json'), tf = path.join(RIDES_DIR, id + '.tcx');
      if (!sub && req.method === 'GET') { const r = readJson(jf, null); return r ? json(res, 200, r) : json(res, 404, { error: 'Not found' }); }
      if (!sub && req.method === 'PUT') {
        const { record, tcx } = JSON.parse(await readBody(req, 30e6));
        if (!record || record.id !== id) return json(res, 400, { error: 'Record id mismatch' });
        const prev = readJson(jf, {});
        writeJson(jf, { ...record, strava: record.strava || prev.strava || null, savedAt: new Date().toISOString() });
        if (typeof tcx === 'string' && tcx) fs.writeFileSync(tf, tcx);
        return json(res, 200, { ok: true });
      }
      if (!sub && req.method === 'DELETE') { for (const f of [jf, tf]) { try { fs.unlinkSync(f); } catch {} } return json(res, 200, { ok: true }); }
      if (sub === 'tcx' && req.method === 'GET') {
        if (!fs.existsSync(tf)) return json(res, 404, { error: 'No file stored for this ride' });
        res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Disposition': `attachment; filename="ride-${id}.tcx"` });
        return res.end(fs.readFileSync(tf));
      }
      if (sub === 'upload' && req.method === 'POST') {
        const rec = readJson(jf, null); if (!rec || !fs.existsSync(tf)) return json(res, 404, { error: 'Ride not found' });
        const body = JSON.parse(await readBody(req, 5e4));
        const name = (body.name || rec.name || 'Indoor Ride').slice(0, 100);
        const out = await stravaUpload({ tcx: fs.readFileSync(tf, 'utf8'), name, description: body.description || 'Recorded with Freehub' });
        if (out.status === 200) { rec.name = name; rec.strava = { activityId: out.body.activityId, uploadedAt: new Date().toISOString() }; writeJson(jf, rec); }
        return json(res, out.status, out.body);
      }
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use — is Freehub already running?` : e.message); if (process.env.FREEHUB_DATA) process.exit(1); });
server.listen(PORT, () => {
  console.log(`Freehub running → ${BASE}  (open in Google Chrome)`);
  if (cfgProblem) console.log('\n⚠ Strava is NOT set up: ' + cfgProblem + '\n');
  else if (!CLIENT_ID || !CLIENT_SECRET) console.log('\n⚠ Strava is NOT set up: config.json needs both "clientId" and "clientSecret".\n');
  else console.log(`Strava keys loaded (client ID ${CLIENT_ID}).`);
  console.log(`Your rides and plans are saved in ${DATA_DIR}`);
  for (const ip of lanIps()) console.log(`Phone companion   → http://${ip}:${PORT}/companion`);
});
