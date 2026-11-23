/* Infinity Timetable - Windows program (Electron shell).
   The timetable page is the same one used everywhere; this shell gives it its own window and
   serves it from a small built-in server with the same API the earlier Windows program had
   (open, read, save, save as, updates), plus daily backups and Wi-Fi sync for phones. */
const { app, BrowserWindow, dialog, shell, Menu, screen } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const PKG = require('./package.json');
const NAME = 'Infinity Timetable', VERSION = PKG.version, AUMID = 'zm.infinitytimetable.app';
const REPO = 'infinitytimetable/infinite-timetable';
const PORT = 47851, LAN_PORT = 47860;

app.setName(NAME);
if (process.platform === 'win32') app.setAppUserModelId(AUMID);
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const FLAG = f => argv.includes(f);
const isKeygen = FLAG('--keygen');
// The updater (--update) runs while the old copy is still closing, so it must not be stopped by the single-instance lock.
if (!FLAG('--uninstall') && !FLAG('--update') && !app.requestSingleInstanceLock({ keygen: isKeygen })) { app.quit(); }

/* ---------- places ---------- */
const LAD = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dataDir = () => path.join(LAD(), 'InfinityTimetable');            /* same folder the earlier program used */
const installDir = () => path.join(LAD(), 'Programs', NAME);
const exeDir = () => path.dirname(process.execPath);
const isInstalled = () => process.platform === 'win32' && exeDir().toLowerCase() === installDir().toLowerCase();
const backupDir = () => path.join(app.getPath('documents'), NAME, 'Backups');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function getCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { return {}; } }
function setCfg(p) { const c = { ...getCfg(), ...p }; fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 1)); return c; }
const pad = n => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function writeSafe(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- daily backups ---------- */
function safeBase(name) { return String(name || 'School').replace(/\.(stt|json)$/i, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'School'; }
function listBackups() {
  try { return fs.readdirSync(backupDir()).filter(f => /\.stt$/i.test(f)).map(f => { const st = fs.statSync(path.join(backupDir(), f)); return { file: f, size: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime); } catch (e) { return []; }
}
function backupText(name, text) {
  try {
    const f = path.join(backupDir(), `${safeBase(name)} ${today()}.stt`); writeSafe(f, text);
    listBackups().slice(30).forEach(x => { try { fs.unlinkSync(path.join(backupDir(), x.file)); } catch (e) {} });
    return f;
  } catch (e) { return null; }
}

/* ---------- install, update, uninstall (Windows) ---------- */
const shortcutDirs = () => [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
function makeShortcut(dir, label, exe, args, desc) {
  try { fs.mkdirSync(dir, { recursive: true }); shell.writeShortcutLink(path.join(dir, label + '.lnk'), 'create', { target: exe, args: args || '', cwd: path.dirname(exe), icon: path.join(path.dirname(exe), 'resources', 'app', 'icon.ico'), iconIndex: 0, description: desc || NAME, appUserModelId: AUMID }); } catch (e) {}
}
function reg(args) { return new Promise(res => execFile('reg.exe', args, { windowsHide: true }, () => res())); }
async function registerWindows(exe) {
  const U = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityTimetable';
  await reg(['add', U, '/v', 'DisplayName', '/d', NAME, '/f']);
  await reg(['add', U, '/v', 'DisplayVersion', '/d', VERSION, '/f']);
  await reg(['add', U, '/v', 'Publisher', '/d', NAME, '/f']);
  await reg(['add', U, '/v', 'DisplayIcon', '/d', exe + ',0', '/f']);
  await reg(['add', U, '/v', 'InstallLocation', '/d', path.dirname(exe), '/f']);
  await reg(['add', U, '/v', 'UninstallString', '/d', `"${exe}" --uninstall`, '/f']);
  await reg(['add', U, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await reg(['add', U, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await reg(['add', 'HKCU\\Software\\Classes\\.stt', '/ve', '/d', 'InfinityTimetable.File', '/f']);
  await reg(['add', 'HKCU\\Software\\Classes\\InfinityTimetable.File', '/ve', '/d', 'Infinity Timetable file', '/f']);
  await reg(['add', 'HKCU\\Software\\Classes\\InfinityTimetable.File\\DefaultIcon', '/ve', '/d', exe + ',0', '/f']);
  await reg(['add', 'HKCU\\Software\\Classes\\InfinityTimetable.File\\shell\\open\\command', '/ve', '/d', `"${exe}" "%1"`, '/f']);
}
function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(installDir(), 'resources', 'app', 'package.json'), 'utf8')).version || ''; } catch (e) { return ''; }
}
async function copyWithRetry(from, to) {
  for (let i = 0; i < 20; i++) { try { fs.cpSync(from, to, { recursive: true, force: true }); return true; } catch (e) { if (i === 19) throw e; await sleep(700); } }
}
async function stopOldProgram() {
  /* the earlier Windows program (and an older copy of this one) answer on PORT */
  for (const p of ['/api/quit']) { try { await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1500) }); } catch (e) {} }
  await sleep(1200);
}
async function install(quiet) {
  if (process.platform !== 'win32') return false;
  if (isInstalled()) { const exe = process.execPath; shortcutDirs().forEach(d => makeShortcut(d, NAME, exe)); await registerWindows(exe); return true; }
  try {
    await stopOldProgram();
    const target = installDir(); fs.mkdirSync(target, { recursive: true });
    await copyWithRetry(exeDir(), target);
    const exe = path.join(target, path.basename(process.execPath));
    shortcutDirs().forEach(d => makeShortcut(d, NAME, exe));
    if (fs.existsSync(path.join(target, 'KeyGenerator.html'))) shortcutDirs().forEach(d => makeShortcut(d, 'Infinity Key Generator', exe, '--keygen', 'Make licence keys for Infinity Timetable (password protected)'));
    await registerWindows(exe);
    setCfg({ installedAt: new Date().toISOString() });
    if (!quiet) await dialog.showMessageBox({ type: 'info', title: NAME, message: `${NAME} ${VERSION} is installed.`, detail: 'You will find it on your desktop and in the Start menu, and .stt school files open in it. You can delete the folder you downloaded.' });
    try { app.releaseSingleInstanceLock(); } catch (e) {}
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); app.exit(0); return true;
  } catch (e) { dialog.showErrorBox(NAME, 'Could not install: ' + e.message + '\n\nClose Infinity Timetable if it is open, then try again.'); return false; }
}
async function uninstall() {
  const ok = dialog.showMessageBoxSync({ type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, title: NAME, message: `Remove ${NAME} from this computer?`, detail: `Your school files and backups are kept (Documents\\${NAME}).` });
  if (ok !== 0) return app.exit(0);
  shortcutDirs().forEach(d => { for (const n of [NAME, 'Infinity Key Generator']) { try { fs.unlinkSync(path.join(d, n + '.lnk')); } catch (e) {} } });
  await reg(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InfinityTimetable', '/f']);
  await reg(['delete', 'HKCU\\Software\\Classes\\InfinityTimetable.File', '/f']);
  spawn('cmd.exe', ['/c', `timeout /t 3 /nobreak > nul & rmdir /s /q "${installDir()}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  dialog.showMessageBoxSync({ type: 'info', title: NAME, message: `${NAME} has been removed.` });
  app.exit(0);
}

/* ---------- updates: download the new zip, unpack it, let the new copy install itself ---------- */
async function updateCheck(repo) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/latest.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: r.status === 404 ? `No updates have been published yet. You have the latest version (${VERSION}).` : 'The update site answered ' + r.status };
    const m = await r.json(), w = m.windows || {};
    const latest = String(w.version || m.version || '').replace(/^v/, '');
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.%-]+\.zip$/.test(w.zip || '') ? w.zip : '';
    return { current: VERSION, latest, name: m.name || '', notes: m.notes || '', url };
  } catch (e) { return { error: 'Could not check for updates. Check the internet connection.' }; }
}
async function updateInstall(repo, url) {
  if (!url || !url.startsWith(`https://github.com/${repo}/releases/download/`) || !/\.zip$/i.test(url)) return { ok: false, error: 'That download address is not allowed' };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!r.ok) return { ok: false, error: 'The download failed. Try again later.' };
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 20 * 1024 * 1024) return { ok: false, error: 'The download was incomplete. Try again.' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinity-update-')), zip = path.join(dir, 'update.zip'); fs.writeFileSync(zip, buf);
    await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { windowsHide: true }, e => e ? rej(e) : res()));
    const find = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { const x = find(p); if (x) return x; } else if (f === 'Infinity Timetable.exe') return p; } return null; };
    const exe = find(dir); if (!exe) return { ok: false, error: 'The update did not contain the program.' };
    spawn(exe, ['--update'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.exit(0), 1200);
    return { ok: true };
  } catch (e) { return { ok: false, error: 'Update failed: ' + (e.message || e) }; }
}

/* ---------- bringing over work kept by the earlier Windows program ----------
   It stored unsaved work inside its own Edge profile (dataDir\Browser) for http://127.0.0.1:47851.
   We open that profile once, invisibly, on the same address, read the stored work and copy it here. */
let MIGRATE = null, migrateDone = null;
function findEdge() {
  const c = [];
  for (const e of ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']) if (process.env[e]) c.push(path.join(process.env[e], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const e of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) if (process.env[e]) c.push(path.join(process.env[e], 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || '';
}
async function migrateOld() {
  const prof = path.join(dataDir(), 'Browser');
  if (getCfg().migrated || process.platform !== 'win32' || !fs.existsSync(prof)) return null;
  const edge = findEdge(); if (!edge) { setCfg({ migrated: 'no-browser' }); return null; }
  const got = new Promise(res => { migrateDone = res; setTimeout(() => res(null), 30000); });
  const p = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, `http://127.0.0.1:${PORT}/__migrate`], { stdio: 'ignore', windowsHide: true });
  const data = await got; try { p.kill(); } catch (e) {}
  setCfg({ migrated: data ? 'yes' : 'nothing' });
  if (data && Object.keys(data).length) { backupText('Before the new program', JSON.stringify(data)); return data; }
  return null;
}
const MIGRATE_PAGE = '<!doctype html><meta charset="utf-8"><script>var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}fetch("/__migrate/data",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});</script>';

/* ---------- Wi-Fi sync for phones ---------- */
const LAN = { on: false, code: '', srv: null, port: LAN_PORT, snapshot: null, inbox: [], fails: 0, last: null, devices: {} };
function lanIPs() {
  const out = []; const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const a of ifs[k] || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
  return out.sort((a, b) => (/^192\.168\./.test(b) - /^192\.168\./.test(a)));
}
function lanSend(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Code, X-Device', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Private-Network': 'true' });
  res.end(JSON.stringify(obj));
}
function lanStart() {
  if (LAN.on) return Promise.resolve(lanStatus());
  LAN.code = String(crypto.randomInt(100000, 1000000)); LAN.fails = 0;
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') return lanSend(res, 204, {});
      const u = (req.url || '').split('?')[0];
      if (u === '/lan/hello') return lanSend(res, 200, { app: 'Infinity Timetable', version: VERSION, school: LAN.snapshot && LAN.snapshot.school || '' });
      if (LAN.fails >= 20) return lanSend(res, 423, { error: 'Too many wrong codes. Turn phone sync off and on again on the PC.' });
      if (req.headers['x-sync-code'] !== LAN.code) { LAN.fails++; return lanSend(res, 403, { error: 'Wrong code' }); }
      const dev = String(req.headers['x-device'] || 'A phone').slice(0, 60);
      LAN.devices[dev] = Date.now();
      if (u === '/lan/pull' && req.method === 'GET') {
        if (!LAN.snapshot) return lanSend(res, 503, { error: 'The PC has not shared its timetable yet. Try again in a moment.' });
        LAN.last = { dev, what: 'pull', at: Date.now() };
        return lanSend(res, 200, { text: LAN.snapshot.text, at: LAN.snapshot.at, school: LAN.snapshot.school });
      }
      if (u === '/lan/push' && req.method === 'POST') {
        let body = ''; req.on('data', c => { body += c; if (body.length > 80e6) req.destroy(); });
        req.on('end', () => { try { const j = JSON.parse(body); if (!j.text) throw new Error('empty'); LAN.inbox.push({ id: crypto.randomUUID(), dev, text: j.text, base: j.base || null, at: Date.now() }); LAN.last = { dev, what: 'push', at: Date.now() }; lanSend(res, 200, { ok: true }); } catch (e) { lanSend(res, 400, { error: 'Bad data' }); } });
        return;
      }
      lanSend(res, 404, { error: 'Not found' });
    });
    const go = port => srv.listen(port, '0.0.0.0', () => { LAN.srv = srv; LAN.port = srv.address().port; LAN.on = true; resolve(lanStatus()); });
    srv.on('error', () => { srv.removeAllListeners('error'); go(0); });
    go(LAN_PORT);
  });
}
function lanStop() { try { LAN.srv && LAN.srv.close(); } catch (e) {} LAN.on = false; LAN.srv = null; LAN.inbox = []; return lanStatus(); }
function lanStatus() { return { on: LAN.on, code: LAN.code, port: LAN.port, ips: lanIPs(), last: LAN.last, devices: Object.keys(LAN.devices).filter(d => Date.now() - LAN.devices[d] < 7 * 864e5) }; }

/* ---------- the page's server and API ---------- */
const TOKEN = crypto.randomBytes(24).toString('hex');
let BASE = '', pendingOpen = '', win = null, kgWin = null;
const indexFile = () => path.join(__dirname, 'index.html');
function keygenFile() { for (const p of [path.join(exeDir(), 'KeyGenerator.html'), path.join(installDir(), 'KeyGenerator.html'), path.join(__dirname, 'KeyGenerator.html')]) if (fs.existsSync(p)) return p; return ''; }
function json(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readOut(p) {
  try { const st = fs.statSync(p); if (st.size > 150 * 1024 * 1024) return { error: 'That file is too large' }; return { text: fs.readFileSync(p, 'utf8'), path: p, name: path.basename(p), mtime: Math.round(st.mtimeMs) }; }
  catch (e) { return { error: 'The file ' + path.basename(p || '') + ' could not be found' }; }
}
async function api(name, inp) {
  switch (name) {
    case 'start': { const a = pendingOpen ? [pendingOpen] : []; pendingOpen = ''; return { args: a, version: VERSION, portable: false, dataDir: dataDir(), electron: true, backups: backupDir() }; }
    case 'beat': { const p = pendingOpen; pendingOpen = ''; return { open: p, lanIn: LAN.inbox.length }; }
    case 'open': {
      const r = await dialog.showOpenDialog(win, { title: 'Open a school file', filters: [{ name: 'Infinity Timetable files', extensions: ['stt', 'json'] }, { name: 'All files', extensions: ['*'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return { cancel: true }; return readOut(r.filePaths[0]);
    }
    case 'read': return readOut(inp.path);
    case 'save': {
      if (!inp.path) return { ok: false, error: 'No file chosen' };
      try { writeSafe(inp.path, inp.text); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
      backupText(path.basename(inp.path), inp.text);
      return { ok: true, path: inp.path, name: path.basename(inp.path), mtime: Math.round(fs.statSync(inp.path).mtimeMs) };
    }
    case 'stat': try { const st = fs.statSync(inp.path); return { mtime: Math.round(st.mtimeMs), size: st.size }; } catch (e) { return { error: 'missing' }; }
    case 'saveas': {
      const r = await dialog.showSaveDialog(win, { title: 'Save the school file', defaultPath: path.join(app.getPath('documents'), inp.name || 'School.stt'), filters: [{ name: 'Infinity Timetable files', extensions: ['stt'] }] });
      if (r.canceled || !r.filePath) return { ok: false, cancel: true };
      let p = r.filePath; if (!/\.(stt|json)$/i.test(p)) p += '.stt';
      try { writeSafe(p, inp.text); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
      backupText(path.basename(p), inp.text); return { ok: true, path: p, name: path.basename(p) };
    }
    case 'update-check': return updateCheck(/^[\w.-]+\/[\w.-]+$/.test(inp.repo || '') ? inp.repo : REPO);
    case 'update-install': return updateInstall(/^[\w.-]+\/[\w.-]+$/.test(inp.repo || '') ? inp.repo : REPO, inp.url);
    case 'quit': setTimeout(() => app.exit(0), 200); return { ok: true };
    case 'backups': return { dir: backupDir(), list: listBackups() };
    case 'backup-read': { const f = path.join(backupDir(), path.basename(inp.name || '')); return readOut(f); }
    case 'backup-text': { const f = backupText(inp.name || 'Work in this program', inp.text || ''); return { ok: !!f, file: f }; }
    case 'backup-folder': fs.mkdirSync(backupDir(), { recursive: true }); shell.openPath(backupDir()); return { ok: true };
    case 'lan-start': return lanStart();
    case 'lan-stop': return lanStop();
    case 'lan-status': return lanStatus();
    case 'lan-publish': LAN.snapshot = { text: inp.text || '', at: Date.now(), school: inp.school || '' }; return { ok: true };
    case 'lan-take': { const x = LAN.inbox.splice(0, LAN.inbox.length); return { items: x }; }
    default: return null;
  }
}
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      if (req.method === 'GET' && (u === '/' || u === '/index.html')) {
        let html = fs.readFileSync(indexFile(), 'utf8').replace('{{STT_TOKEN}}', TOKEN);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html);
      }
      if (req.method === 'GET' && u === '/keygen') { const k = keygenFile(); if (!k) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(k).pipe(res); }
      if (req.method === 'GET' && u === '/__blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>.</title>'); }
      if (req.method === 'GET' && u === '/__migrate') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(MIGRATE_PAGE); }
      if (req.method === 'POST' && u === '/__migrate/data') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { const d = JSON.parse(b); migrateDone && migrateDone(d); } catch (e) { migrateDone && migrateDone(null); } res.end('ok'); }); return; }
      if (req.method === 'POST' && u === '/api/quit') { json(res, { ok: true }); return setTimeout(() => app.exit(0), 200); }
      if (req.method === 'GET' && u === '/api/ping') return json(res, { app: 'stt', version: VERSION, beatAge: 0, electron: true });
      if (u.startsWith('/api/')) {
        if (req.method !== 'POST' || req.headers['x-stt-token'] !== TOKEN) return json(res, { error: 'forbidden' }, 403);
        let b = ''; req.on('data', c => { b += c; if (b.length > 200e6) req.destroy(); });
        req.on('end', async () => { let inp = {}; try { inp = JSON.parse(b || '{}'); } catch (e) {} const out = await api(u.slice(5), inp).catch(e => ({ error: String(e.message || e) })); if (out === null) return json(res, { error: 'not found' }, 404); json(res, out); });
        return;
      }
      res.writeHead(404); res.end();
    });
    let tries = 0;
    const go = () => srv.listen(PORT, '127.0.0.1', () => { BASE = `http://127.0.0.1:${PORT}/`; resolve(true); });
    srv.on('error', async () => { srv.removeAllListeners('listening'); if (++tries === 1) await stopOldProgram(); if (tries < 8) { await sleep(1000); go(); } else { dialog.showErrorBox(NAME, `${NAME} could not start because another program is using port ${PORT}. Close other copies of Infinity Timetable and try again.`); app.exit(1); } });
    go();
  });
}

/* ---------- windows ---------- */
function fileArg(list) { return (list || []).find(a => /\.(stt|json)$/i.test(a) && fs.existsSync(a)) || ''; }
function createWindow() {
  const wsFile = path.join(app.getPath('userData'), 'window.json'); let ws = {}; try { ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch (e) {}
  const wa = screen.getPrimaryDisplay().workAreaSize, ok = ws.width && ws.height && ws.width <= wa.width + 50 && ws.height <= wa.height + 50;
  win = new BrowserWindow({ width: ok ? ws.width : Math.min(1440, wa.width), height: ok ? ws.height : Math.min(920, wa.height), ...(ok && ws.x != null ? { x: ws.x, y: ws.y } : {}),
    minWidth: 360, minHeight: 520, title: NAME, icon: path.join(__dirname, 'icon.png'), backgroundColor: '#ffffff', show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: true, sandbox: true } });
  win.once('ready-to-show', () => { if (!ok || ws.maximized !== false) win.maximize(); win.show(); });
  win.on('close', () => { try { const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds(); fs.writeFileSync(wsFile, JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch (e) {} });
  /* the page always asks before closing; show its own Save / Don't save / Cancel box */
  win.webContents.on('will-prevent-unload', () => { win.webContents.executeJavaScript('window.ITDesktopClose&&ITDesktopClose()').catch(() => {}); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?|mailto|tel|whatsapp):/i.test(url) && !url.startsWith(BASE)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.session.on('will-download', (e, item) => { item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) }); });
  win.on('page-title-updated', e => e.preventDefault());
  return win;
}
async function loadMain() {
  createWindow();
  if (MIGRATE) {
    /* put the earlier program's stored work into this program's storage, then open the app */
    await win.loadURL(BASE + '__blank');
    const empty = await win.webContents.executeJavaScript('localStorage.length===0').catch(() => false);
    if (empty) await win.webContents.executeJavaScript(`(function(o){for(var k in o){try{localStorage.setItem(k,o[k]);}catch(e){}}return true;})(${JSON.stringify(MIGRATE)})`).catch(() => {});
  }
  win.loadURL(BASE + 'index.html');
}
function openKeygen() {
  if (!keygenFile()) { dialog.showErrorBox('Infinity Key Generator', 'The key generator is not installed on this computer. Install it with the seller setup.'); return app.exit(0); }
  kgWin = new BrowserWindow({ width: 1100, height: 860, title: 'Infinity Key Generator', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
  kgWin.on('page-title-updated', e => e.preventDefault());
  kgWin.loadURL(BASE + 'keygen');
}
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Open backups folder', click: () => api('backup-folder', {}) }, { type: 'separator' }, { label: 'Exit', click: () => win && win.close() }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(process.env.IT_DEV ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : [])] },
    { label: 'Help', submenu: [{ label: `About ${NAME}`, click: () => dialog.showMessageBox(win, { title: NAME, message: `${NAME} ${VERSION}`, detail: `Backups: ${backupDir()}` }) }] }
  ]));
}

app.on('second-instance', (e, args, cwd, extra) => {
  if (extra && extra.keygen) { if (kgWin) kgWin.focus(); else if (BASE) openKeygen(); return; }
  const f = fileArg(args); if (f) pendingOpen = f;
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.whenReady().then(async () => {
  if (FLAG('--uninstall')) return uninstall();
  menu();
  if (process.platform === 'win32' && !isInstalled() && !process.env.IT_NO_INSTALL) {
    if (FLAG('--update')) { await install(true); return; }
    const iv = installedVersion(), newer = !iv || cmpVer(VERSION, iv) > 0, c = getCfg();
    if (newer && (!c.askedInstall || iv)) {
      setCfg({ askedInstall: true });
      const a = await dialog.showMessageBox(iv
        ? { type: 'question', title: NAME, buttons: ['Update', 'Just open it'], defaultId: 0, message: `Update ${NAME} from ${iv} to ${VERSION}?`, detail: 'Your timetables are kept. This replaces the old program and puts the icons on your desktop and Start menu again.' }
        : { type: 'question', title: NAME, buttons: ['Install', 'Just open it'], defaultId: 0, message: `Install ${NAME} on this computer?`, detail: 'It installs for you only (no administrator password). Icons are added to the desktop and Start menu, and .stt school files open in it.' });
      if (a.response === 0 && await install(false)) return;
    }
  }
  pendingOpen = fileArg(argv);
  await startServer();
  if (isKeygen) return openKeygen();
  MIGRATE = await migrateOld().catch(() => null);
  await loadMain();
});
app.on('window-all-closed', () => app.quit());
