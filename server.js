// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MC_DIR = require('path').join(require('os').homedir(), 'mc-panel', 'minecraft');
const MC_JAR = 'paper-1.21.1-133.jar';
const MC_START_CMD = `java -Xms2G -Xmx6G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -jar ${MC_JAR} nogui`;
const PANEL_PORT = 3000;
const BACKUP_DIRS = ['world', 'world_nether', 'world_the_end'];
const QUICK_ACCESS = ['plugins', 'config', 'world', 'backups', 'mods'];
const ALLOWED_UPLOAD_EXTENSIONS = [
  '.jar', '.json', '.toml', '.yml', '.yaml', '.cfg', '.properties',
  '.txt', '.log', '.zip', '.png', '.sk', '.js', '.conf', '.xml'
];
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const multer = require('multer');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const PANEL_PASSWORD = '6969';
const sessions = new Map();

function parseCookies(header) {
  const c = {};
  if (!header) return c;
  header.split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    c[k.trim()] = v.join('=');
  });
  return c;
}

function authCheck(req) {
  return sessions.has(parseCookies(req.headers.cookie).session);
}

app.post('/api/login', (req, res) => {
  if (req.body.password !== PANEL_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(parseCookies(req.headers.cookie).session);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') return next();
  if (authCheck(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// ─── STATE ───────────────────────────────────────────────────────────────────
let mcProcess = null;
let serverStatus = 'offline'; // offline | starting | online | crashed
let cleanStop = false;
let crashTimes = [];
let autoRestartEnabled = true;
let currentTps = null;
let onlinePlayers = new Set();
let playitStatus = { connected: false, address: '' };

// Graph data (last 100 points each)
const graphData = { cpu: [], ram: [], tps: [] };

// Config path
const CONFIG_PATH = path.join(__dirname, 'panel-config.json');
let panelConfig = loadConfig();

// Scheduled restart state
let scheduledRestartInterval = null;

// ─── CONFIG HELPERS ──────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      serverName: 'Minecraft Server',
      autoRestart: true,
      autoBackupOnRestart: false,
      scheduledRestartEnabled: false,
      scheduledRestartTime: '04:00',
      commandHistory: [],
      notifications: {
        crash: true, join: true, backup: true,
        restart_warn: true, lag: true, tunnel_down: true
      }
    };
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(panelConfig, null, 2));
}

// ─── WEBSOCKET BROADCAST ─────────────────────────────────────────────────────
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws, req) => {
  if (!authCheck(req)) { ws.close(1008, 'Unauthorized'); return; }
  ws.send(JSON.stringify({ type: 'status', status: serverStatus }));
  ws.send(JSON.stringify({ type: 'players', players: [...onlinePlayers] }));
  if (currentTps !== null) ws.send(JSON.stringify({ type: 'tps', value: currentTps }));
  ws.send(JSON.stringify({ type: 'playit', ...playitStatus }));
});

// ─── PATH SAFETY ─────────────────────────────────────────────────────────────
function safePath(p) {
  const resolved = path.resolve(MC_DIR, p.replace(/^\/+/, ''));
  if (!resolved.startsWith(path.resolve(MC_DIR))) return null;
  return resolved;
}

function safePathFromAbsolute(p) {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(MC_DIR))) return null;
  return resolved;
}

// ─── LOG PARSING ─────────────────────────────────────────────────────────────
const TPS_RE = /TPS from last 1m,\s*5m,\s*15m:\s*([\d.]+)/i;
const JOIN_RE = /(\w+)\[.*\] logged in/;
const LEAVE_RE = /(\w+) left the game/;
const CHAT_RE = /<(\w+)> (.+)/;

function parseLine(line) {
  // TPS
  const tpsMatch = line.match(TPS_RE);
  if (tpsMatch) {
    const tps = parseFloat(tpsMatch[1]);
    currentTps = tps;
    broadcast({ type: 'tps', value: tps });
    pushGraph('tps', tps);
    if (tps < 15) {
      broadcast({ type: 'notification', event: 'lag', message: `Server TPS dropped to ${tps} — possible lag spike.` });
    }
  }

  // Player join
  const joinMatch = line.match(JOIN_RE);
  if (joinMatch) {
    const player = joinMatch[1];
    onlinePlayers.add(player);
    broadcast({ type: 'players', players: [...onlinePlayers] });
    broadcast({ type: 'notification', event: 'join', message: `${player} joined the server.` });
  }

  // Player leave
  const leaveMatch = line.match(LEAVE_RE);
  if (leaveMatch) {
    onlinePlayers.delete(leaveMatch[1]);
    broadcast({ type: 'players', players: [...onlinePlayers] });
  }
}

// ─── SERVER PROCESS ──────────────────────────────────────────────────────────
function setStatus(s) {
  serverStatus = s;
  broadcast({ type: 'status', status: s });
}

function startServer() {
  if (mcProcess) return;
  cleanStop = false;
  setStatus('starting');
  broadcast({ type: 'log', data: '[PANEL] Starting server...\n' });

  const args = MC_START_CMD.split(' ');
  args.shift(); // remove 'java' placeholder

  const javaCandidates = ['/usr/bin/java','/usr/sbin/java','/usr/local/bin/java',
    '/usr/lib/jvm/java-21-openjdk/bin/java','/usr/lib/jvm/java-21/bin/java',
    '/usr/lib/jvm/java-17-openjdk/bin/java','/usr/lib/jvm/java-17/bin/java',
    '/usr/lib/jvm/temurin-21/bin/java'];
  const javaPath = javaCandidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || 'java';
  broadcast({ type: 'log', data: `[PANEL] Using java: ${javaPath}\n` });

  mcProcess = spawn(javaPath, args, { cwd: MC_DIR, env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/sbin:/usr/local/bin' } });

  mcProcess.stdout.on('data', data => {
    const text = data.toString();
    broadcast({ type: 'log', data: text });
    text.split('\n').forEach(line => {
      if (line.trim()) {
        parseLine(line);
        if (line.includes('Done') && line.includes('For help')) setStatus('online');
      }
    });
  });

  mcProcess.stderr.on('data', data => {
    const text = data.toString();
    broadcast({ type: 'log', data: text });
    text.split('\n').forEach(line => {
      if (line.trim()) {
        parseLine(line);
        if (line.includes('Done') && line.includes('For help')) setStatus('online');
      }
    });
  });

  mcProcess.on('error', err => {
    broadcast({ type: 'log', data: `[PANEL] Process error: ${err.message}\n` });
    mcProcess = null;
    setStatus('offline');
  });

  mcProcess.on('exit', (code, signal) => {
    mcProcess = null;
    onlinePlayers.clear();
    broadcast({ type: 'players', players: [] });

    if (cleanStop || code === 0) {
      setStatus('offline');
      broadcast({ type: 'log', data: '[PANEL] Server stopped cleanly.\n' });
      return;
    }

    // Crash
    const now = Date.now();
    crashTimes.push(now);
    crashTimes = crashTimes.filter(t => now - t < 5 * 60 * 1000);

    setStatus('crashed');
    broadcast({ type: 'crashed', exitCode: code, restarting: autoRestartEnabled });
    broadcast({ type: 'log', data: `[PANEL] Server crashed (exit code ${code}). ${autoRestartEnabled ? 'Restarting in 10 seconds...' : 'Auto-restart is disabled.'}\n` });
    broadcast({ type: 'notification', event: 'crash', message: `Server crashed — ${autoRestartEnabled ? 'auto-restarting in 10 seconds.' : 'auto-restart is disabled.'}` });

    if (!autoRestartEnabled) { setStatus('offline'); return; }

    if (crashTimes.length >= 3) {
      broadcast({ type: 'log', data: '[PANEL] Server crashed 3 times in 5 minutes — auto-restart paused. Check your logs.\n' });
      broadcast({ type: 'notification', event: 'crash', message: 'Server crashed 3 times in 5 minutes — auto-restart paused. Check your logs.' });
      setStatus('offline');
      return;
    }

    setTimeout(() => {
      setStatus('starting');
      startServer();
    }, 10000);
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!mcProcess) { resolve(); return; }
    cleanStop = true;
    setStatus('stopping');
    broadcast({ type: 'log', data: '[PANEL] Stopping server...\n' });
    try { mcProcess.stdin.write('stop\n'); } catch {}
    const timer = setTimeout(() => {
      if (mcProcess) { mcProcess.kill('SIGTERM'); }
      resolve();
    }, 10000);
    mcProcess.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function restartServer() {
  broadcast({ type: 'log', data: '[PANEL] Restarting server...\n' });
  if (panelConfig.autoBackupOnRestart) await runBackup();
  await stopServer();
  await new Promise(r => setTimeout(r, 2000));
  startServer();
}

// ─── STATS ───────────────────────────────────────────────────────────────────
function pushGraph(key, val) {
  graphData[key].push({ t: Date.now(), v: val });
  if (graphData[key].length > 100) graphData[key].shift();
}

async function collectStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = ((totalMem - freeMem) / 1e9).toFixed(2);
  const totalMemGB = (totalMem / 1e9).toFixed(2);

  // CPU usage via /proc/stat sampling
  let cpuPercent = 0;
  try {
    const s1 = readCpuStat();
    await new Promise(r => setTimeout(r, 500));
    const s2 = readCpuStat();
    const idle = s2.idle - s1.idle;
    const total = s2.total - s1.total;
    cpuPercent = Math.round(100 * (1 - idle / total));
  } catch { cpuPercent = 0; }

  // Disk usage for MC_DIR
  let diskUsed = 'N/A';
  try {
    const out = await new Promise((res, rej) => exec(`df -h "${MC_DIR}" | tail -1`, (e, o) => e ? rej(e) : res(o)));
    diskUsed = out.trim().split(/\s+/)[2] || 'N/A';
  } catch { diskUsed = 'N/A'; }

  const stats = {
    cpu: `${cpuPercent}%`,
    ram: `${usedMem}GB / ${totalMemGB}GB`,
    disk: diskUsed
  };

  pushGraph('cpu', cpuPercent);
  pushGraph('ram', parseFloat(usedMem));

  broadcast({ type: 'stats', ...stats });
  return stats;
}

function readCpuStat() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.split(/\s+/).slice(1).map(Number);
  const idle = parts[3];
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

setInterval(collectStats, 3000);

// ─── PLAYIT.GG ───────────────────────────────────────────────────────────────
let lastPlayitConnected = null;
let playitProcess = null;

function startPlayit() {
  if (playitProcess) return;
  exec('which playit', (err) => {
    if (err) { broadcast({ type: 'log', data: '[PANEL] playit not found in PATH — skipping.\n' }); return; }
    broadcast({ type: 'log', data: '[PANEL] Starting playit.gg tunnel...\n' });
    playitProcess = spawn('playit', [], { detached: false, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
    // playit is a TUI app — only log plain text lines, strip ANSI
    const stripAnsi = s => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
    const logPlayit = d => {
      const clean = stripAnsi(d.toString()).split('\n').filter(l => l.trim() && /[a-zA-Z]/.test(l)).join('\n');
      if (clean) broadcast({ type: 'log', data: '[playit] ' + clean + '\n' });
    };
    playitProcess.stdout.on('data', logPlayit);
    playitProcess.stderr.on('data', logPlayit);
    playitProcess.on('exit', (code) => {
      broadcast({ type: 'log', data: `[PANEL] playit.gg exited (code ${code}).\n` });
      playitProcess = null;
      // restart after 5s unless panel is shutting down
      setTimeout(() => { if (!playitProcess) startPlayit(); }, 5000);
    });
    playitProcess.on('error', err => {
      broadcast({ type: 'log', data: `[PANEL] playit error: ${err.message}\n` });
      playitProcess = null;
    });
    setTimeout(checkPlayit, 3000);
  });
}

function checkPlayit() {
  exec('playit status', { timeout: 8000 }, (err, stdout) => {
    let connected = false;
    let address = '';

    if (!err && stdout) {
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('tcp') || line.includes('udp') || line.includes('at.playit.gg')) {
          const addrMatch = line.match(/([\w.-]+\.playit\.gg:\d+)/);
          if (addrMatch) { address = addrMatch[1]; connected = true; break; }
        }
      }
      if (!connected) connected = stdout.toLowerCase().includes('connected');
    } else {
      exec('pgrep -x playit', (e2) => {
        connected = !e2;
        finalize(connected, '');
      });
      return;
    }
    finalize(connected, address);
  });

  function finalize(connected, address) {
    playitStatus = { connected, address };
    if (lastPlayitConnected !== null && lastPlayitConnected && !connected) {
      broadcast({ type: 'notification', event: 'tunnel_down', message: 'playit.gg tunnel disconnected — players cannot connect.' });
    }
    lastPlayitConnected = connected;
    broadcast({ type: 'playit', connected, address });
  }
}

// Start playit on panel launch, then check status every 10s
startPlayit();
setInterval(checkPlayit, 10000);
checkPlayit();

// ─── SCHEDULED RESTART ───────────────────────────────────────────────────────
function scheduleRestartCheck() {
  clearInterval(scheduledRestartInterval);
  scheduledRestartInterval = setInterval(() => {
    if (!panelConfig.scheduledRestartEnabled || !panelConfig.scheduledRestartTime) return;
    const [h, m] = panelConfig.scheduledRestartTime.split(':').map(Number);
    const now = new Date();
    const diffMin = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());

    if (diffMin === 5) {
      if (mcProcess) mcProcess.stdin.write('say [Server] Restarting in 5 minutes. Find a safe spot!\n');
      broadcast({ type: 'notification', event: 'restart_warn', message: 'Scheduled restart in 5 minutes.' });
    } else if (diffMin === 1) {
      if (mcProcess) mcProcess.stdin.write('say [Server] Restarting in 1 minute!\n');
    } else if (diffMin === 0) {
      restartServer();
    }
  }, 60000);
}

scheduleRestartCheck();

// ─── BACKUP ──────────────────────────────────────────────────────────────────
async function runBackup() {
  await fsp.mkdir(path.join(MC_DIR, 'backups'), { recursive: true });
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
  const dest = path.join(MC_DIR, 'backups', `${stamp}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    const arc = archiver('zip', { zlib: { level: 6 } });

    arc.on('progress', p => {
      const pct = p.entries.total > 0 ? Math.round(100 * p.entries.processed / p.entries.total) : 0;
      broadcast({ type: 'backup_progress', percent: pct });
    });

    output.on('close', () => {
      broadcast({ type: 'backup_done', filename: path.basename(dest) });
      broadcast({ type: 'notification', event: 'backup', message: `Backup complete: ${path.basename(dest)}` });
      resolve(dest);
    });

    arc.on('error', reject);
    arc.pipe(output);

    for (const dir of BACKUP_DIRS) {
      const full = path.join(MC_DIR, dir);
      if (fs.existsSync(full)) arc.directory(full, dir);
    }

    arc.finalize();
  });
}

// ─── API ROUTES ──────────────────────────────────────────────────────────────

// Server control
app.post('/api/server/start', (req, res) => {
  startServer();
  res.json({ ok: true });
});

app.post('/api/server/stop', async (req, res) => {
  await stopServer();
  res.json({ ok: true });
});

app.post('/api/server/restart', async (req, res) => {
  restartServer();
  res.json({ ok: true });
});

app.get('/api/server/status', (req, res) => res.json({ status: serverStatus }));

app.post('/api/console', (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'No command' });
  if (!mcProcess) return res.status(400).json({ error: 'Server not running' });
  mcProcess.stdin.write(command + '\n');

  // Save to history
  const hist = panelConfig.commandHistory || [];
  if (hist[hist.length - 1] !== command) hist.push(command);
  panelConfig.commandHistory = hist.slice(-50);
  saveConfig();

  res.json({ ok: true });
});

// Stats & TPS
app.get('/api/stats', async (req, res) => res.json(await collectStats()));
app.get('/api/tps', (req, res) => res.json({ tps: currentTps }));
app.get('/api/graph-data', (req, res) => res.json(graphData));
app.get('/api/players', (req, res) => res.json({ players: [...onlinePlayers] }));
app.get('/api/playit', (req, res) => res.json(playitStatus));

// Config
app.get('/api/config', (req, res) => res.json(panelConfig));
app.post('/api/config', (req, res) => {
  panelConfig = { ...panelConfig, ...req.body };
  autoRestartEnabled = panelConfig.autoRestart !== false;
  saveConfig();
  scheduleRestartCheck();
  res.json({ ok: true });
});

// ─── FILE ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/files', async (req, res) => {
  const p = safePath(req.query.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const result = entries.map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      path: path.relative(MC_DIR, path.join(p, e.name))
    }));
    result.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file', async (req, res) => {
  const p = safePath(req.query.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try {
    const content = await fsp.readFile(p, 'utf8');
    res.json({ content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/file', async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  const p = safePath(filePath);
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try {
    await fsp.writeFile(p, content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/file', async (req, res) => {
  const p = safePath(req.query.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try { await fsp.unlink(p); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dir', async (req, res) => {
  const p = safePath(req.query.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try { await fsp.rm(p, { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rename', async (req, res) => {
  const from = safePath(req.body.from || '');
  const to = safePath(req.body.to || '');
  if (!from || !to) return res.status(403).json({ error: 'Path traversal denied' });
  try { await fsp.rename(from, to); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mkdir', async (req, res) => {
  const p = safePath(req.body.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  try { await fsp.mkdir(p, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download', (req, res) => {
  const p = safePath(req.query.path || '');
  if (!p) return res.status(403).json({ error: 'Path traversal denied' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.download(p);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = safePath(req.query.path || '');
    if (!dir) return cb(new Error('Path traversal denied'));
    fsp.mkdir(dir, { recursive: true }).then(() => cb(null, dir)).catch(cb);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_UPLOAD_EXTENSIONS.includes(ext));
  }
});

app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ ok: true, files: (req.files || []).map(f => f.filename) });
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').replace(/[`$;|&<>]/g, '');
  if (!q) return res.json([]);
  exec(`find "${MC_DIR}" -iname "*${q}*" -not -path "*/.*" 2>/dev/null | head -50`, (err, stdout) => {
    const results = (stdout || '').split('\n').filter(Boolean).map(p => path.relative(MC_DIR, p));
    res.json(results);
  });
});

app.post('/api/zip', async (req, res) => {
  const { paths, dest } = req.body;
  const destPath = safePath(dest || '');
  if (!destPath) return res.status(403).json({ error: 'Path traversal denied' });
  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      const arc = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      arc.on('error', reject);
      arc.pipe(output);
      for (const p of paths) {
        const full = safePath(p);
        if (!full) continue;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) arc.directory(full, path.basename(full));
        else arc.file(full, { name: path.basename(full) });
      }
      arc.finalize();
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/unzip', async (req, res) => {
  const src = safePath(req.body.path || '');
  const dest = safePath(req.body.dest || path.dirname(req.body.path || ''));
  if (!src || !dest) return res.status(403).json({ error: 'Path traversal denied' });
  exec(`unzip -o "${src}" -d "${dest}"`, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// Backup routes
app.post('/api/backup', async (req, res) => {
  try {
    const dest = await runBackup();
    res.json({ ok: true, filename: path.basename(dest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backups', async (req, res) => {
  try {
    const dir = path.join(MC_DIR, 'backups');
    await fsp.mkdir(dir, { recursive: true });
    const files = await fsp.readdir(dir);
    const backups = await Promise.all(
      files.filter(f => f.endsWith('.zip')).map(async f => {
        const stat = await fsp.stat(path.join(dir, f));
        return { name: f, size: stat.size, created: stat.birthtime };
      })
    );
    backups.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(backups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/backups/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const p = path.join(MC_DIR, 'backups', name);
  if (!p.startsWith(path.resolve(MC_DIR))) return res.status(403).json({ error: 'Denied' });
  try { await fsp.unlink(p); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve backup files as downloads
app.get('/api/backups/:name/download', (req, res) => {
  const name = path.basename(req.params.name);
  const p = path.join(MC_DIR, 'backups', name);
  if (!p.startsWith(path.resolve(MC_DIR))) return res.status(403).end();
  res.download(p);
});

// Modrinth proxy
app.get('/api/modrinth/search', async (req, res) => {
  const q = encodeURIComponent(req.query.q || '');
  try {
    const r = await fetch(`https://api.modrinth.com/v2/search?query=${q}&facets=[[%22project_type:plugin%22],[%22categories:paper%22]]&limit=20`);
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/modrinth/install', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'No projectId' });
  try {
    const vr = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?loaders=[%22paper%22,%22spigot%22,%22bukkit%22]&game_versions=[%221.21.1%22]`);
    let versions = await vr.json();
    if (!Array.isArray(versions) || !versions.length) {
      // fallback: get all versions and take latest
      const vr2 = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`);
      versions = await vr2.json();
    }
    if (!versions.length) return res.status(404).json({ error: 'No versions found' });

    const latest = versions[0];
    const primaryFile = latest.files.find(f => f.primary && f.filename.endsWith('.jar')) || latest.files.find(f => f.filename.endsWith('.jar'));
    if (!primaryFile) return res.status(404).json({ error: 'No file found' });

    const modsDir = path.join(MC_DIR, 'plugins');
    await fsp.mkdir(modsDir, { recursive: true });
    const dest = path.join(modsDir, primaryFile.filename);

    const fileRes = await fetch(primaryFile.url);
    const fileStream = fs.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      fileRes.body.pipe(fileStream);
      fileRes.body.on('error', reject);
      fileStream.on('finish', resolve);
    });

    res.json({ ok: true, filename: primaryFile.filename });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mods', async (req, res) => {
  try {
    const modsDir = path.join(MC_DIR, 'plugins');
    await fsp.mkdir(modsDir, { recursive: true });
    const files = await fsp.readdir(modsDir);
    const mods = await Promise.all(
      files.filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled')).map(async f => {
        const stat = await fsp.stat(path.join(modsDir, f));
        return { name: f, size: stat.size, added: stat.birthtime, enabled: !f.endsWith('.disabled') };
      })
    );
    res.json(mods);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mods/toggle', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'No name' });
  const modsDir = path.join(MC_DIR, 'plugins');
  const current = path.join(modsDir, name);
  if (!current.startsWith(path.resolve(modsDir))) return res.status(403).json({ error: 'Denied' });
  try {
    const newName = name.endsWith('.disabled') ? name.replace('.disabled', '') : name + '.disabled';
    await fsp.rename(current, path.join(modsDir, newName));
    res.json({ ok: true, newName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TERMINAL ────────────────────────────────────────────────────────────────
app.post('/api/terminal', async (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') return res.status(400).json({ error: 'No command' });
  exec(command, { cwd: os.homedir(), timeout: 30000 }, (err, stdout, stderr) => {
    res.json({ stdout: stdout || '', stderr: stderr || '', exitCode: err ? err.code ?? 1 : 0 });
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PANEL_PORT, () => {
  console.log(`MC Panel running at http://localhost:${PANEL_PORT}`);
});
