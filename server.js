// Zero-dependency server: dashboard, companion page, Strava OAuth + upload, and a tiny
// state/command relay so the phone companion can mirror and control the ride.
// Requires Node 18+.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

let cfg = {};
const CFG_PATH = path.join(__dirname, 'config.json');
let cfgProblem = null;
try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
catch (e) {
  if (e.code === 'ENOENT') {
    const txt = fs.existsSync(CFG_PATH + '.txt') ? ' (I found "config.json.txt": rename it to remove the ".txt")' : '';
    cfgProblem = `No config.json found in ${__dirname}${txt}`;
  } else cfgProblem = `config.json can't be read as JSON: ${e.message}. Check for curly quotes, a missing comma or brace, or rich-text formatting.`;
}
const CLIENT_ID = process.env.STRAVA_CLIENT_ID || cfg.clientId;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || cfg.clientSecret;

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
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---- Live state relay (main dashboard -> companions) and command relay (companions -> dashboard)
let lastState = null;
const companions = new Set();   // SSE clients watching the ride
const hosts = new Set();        // SSE clients receiving commands (the dashboard on this Mac)
const COMMANDS = new Set(['start', 'pause', 'resume', 'finish', 'upload', 'discard', 'done', 'skip']);

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
}
const send = (set, obj) => { const m = `data: ${JSON.stringify(obj)}\n\n`; for (const c of set) c.write(m); };
setInterval(() => { for (const c of [...companions, ...hosts]) c.write(': ping\n\n'); }, 15000);

// Routes reachable from other devices on your network (phone companion). Everything else is Mac-only.
const LAN_ROUTES = new Set(['/companion', '/api/state-stream', '/api/cmd']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  try {
    if (!LAN_ROUTES.has(url.pathname) && !isLocal(req)) { res.writeHead(403); return res.end('Local access only'); }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (url.pathname === '/qrcode.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'qrcode.js')));
    }
    if (url.pathname === '/companion') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'companion.html')));
    }
    if (url.pathname === '/api/info') {
      return json(res, 200, { companionUrls: lanIps().map(ip => `http://${ip}:${PORT}/companion`) });
    }
    if (url.pathname === '/api/status') {
      const t = loadTokens();
      return json(res, 200, { configured: !!(CLIENT_ID && CLIENT_SECRET), connected: !!t, athlete: t && t.athlete,
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
      const { cmd, name } = JSON.parse(await readBody(req, 2e3));
      if (!COMMANDS.has(cmd)) return json(res, 400, { error: 'Unknown command' });
      send(hosts, { cmd, name: typeof name === 'string' ? name.slice(0, 100) : undefined });
      return json(res, 200, { ok: true, delivered: hosts.size > 0 });
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
      const { tcx, name, description } = JSON.parse(await readBody(req, 20e6));
      const token = await validToken();
      const form = new FormData();
      form.append('file', new Blob([tcx], { type: 'application/xml' }), 'ride.tcx');
      form.append('data_type', 'tcx');
      form.append('sport_type', 'VirtualRide');
      form.append('trainer', '1');
      form.append('name', name || 'Indoor Ride');
      if (description) form.append('description', description);
      const r = await fetch('https://www.strava.com/api/v3/uploads', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      let up = await r.json();
      console.log('Strava upload response:', r.status, JSON.stringify(up));
      if (!r.ok) {
        const missing = r.status === 401 || r.status === 403 || (up.errors || []).some(e => e.code === 'missing' || /activity:write/.test(e.field || ''));
        const detail = (up.errors || []).map(e => `${e.resource || ''} ${e.field || ''} ${e.code || ''}`.trim()).join('; ');
        return json(res, r.status, { error: missing
          ? 'Strava refused the upload because upload permission was not granted. Click "Disconnect Strava", then "Connect Strava" again and make sure "Upload your activities" is ticked.'
          : `Strava said: ${up.message || 'error'}${detail ? ' (' + detail + ')' : ''}` });
      }
      for (let i = 0; i < 10 && !up.activity_id && !up.error; i++) {
        await new Promise(s => setTimeout(s, 2000));
        const p = await fetch(`https://www.strava.com/api/v3/uploads/${up.id}`, { headers: { Authorization: `Bearer ${token}` } });
        up = await p.json();
        console.log('Strava upload status:', JSON.stringify(up));
      }
      if (up.error) return json(res, 422, { error: up.error });
      if (!up.activity_id) return json(res, 200, { activityId: null, status: up.status });
      return json(res, 200, { activityId: up.activity_id, status: up.status });
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

server.listen(PORT, () => {
  console.log(`Hub Rider running → ${BASE}  (open in Google Chrome)`);
  if (cfgProblem) console.log('\n⚠ Strava is NOT set up: ' + cfgProblem + '\n');
  else if (!CLIENT_ID || !CLIENT_SECRET) console.log('\n⚠ Strava is NOT set up: config.json needs both "clientId" and "clientSecret".\n');
  else console.log(`Strava keys loaded (client ID ${CLIENT_ID}).`);
  for (const ip of lanIps()) console.log(`Phone companion   → http://${ip}:${PORT}/companion`);
});
