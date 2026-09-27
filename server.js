/**
 * Enterprise — Servidor Multiplayer
 * HTTP estático + WebSocket (/ws) + Persistência em JSON
 * Porta 8080
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { getZoneAt, MAP, ZONES } from './js/office.js';
import { AUDIO_RADIUS } from './js/spatial.js';
import { generateSeedLayout } from './js/layout.js';

// ─── Caminhos ────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');

// ─── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

// ─── Estado em memória ────────────────────────────────────────────────────────
/** @type {Map<string, {id:string, name:string, role:string, x:number, y:number, dir:string, ws:import('ws').WebSocket}>} */
const players = new Map();

/** Estado persistido */
let state = {
  chat: { geral: [], dm: {} },
  demandas: [],
  sprint: {},
};

/**
 * Layout unificado do escritório (grade + zonas).
 * Carregado de data/layout.json ou gerado como seed inicial a partir do MAP/ZONES.
 * @type {object}
 */
let layout = null;

let demandaCounter = 0; // incrementado ao gerar IDs D-<n>

// ─── Persistência ─────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = parsed;
    // Recalcular contador de demandas a partir dos IDs existentes
    for (const d of (state.demandas || [])) {
      const m = String(d.id || '').match(/^D-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > demandaCounter) demandaCounter = n;
      }
    }
    console.log(`[state] Carregado: ${state.chat.geral.length} msgs geral, ${state.demandas.length} demandas`);
  } catch (err) {
    console.error('[state] JSON corrompido ou inválido — iniciando estado vazio:', err.message);
    state = { chat: { geral: [], dm: {} }, demandas: [], sprint: {} };
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    ensureDataDir();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.error('[state] Erro ao gravar state.json:', err.message);
    }
  }, 500);
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Valida estrutura básica de um objeto de layout.
 * @param {object} lay
 * @returns {boolean}
 */
function validateLayout(lay) {
  if (!lay || !Array.isArray(lay.cells) || !lay.zones) return false;
  if (lay.cells.length !== 18) return false;
  for (const row of lay.cells) {
    if (!Array.isArray(row) || row.length !== 25) return false;
  }
  return true;
}

/**
 * Carrega data/layout.json ou gera o seed inicial a partir do MAP/ZONES.
 */
function loadLayout() {
  ensureDataDir();
  if (fs.existsSync(LAYOUT_FILE)) {
    try {
      const raw = fs.readFileSync(LAYOUT_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (validateLayout(parsed)) {
        layout = parsed;
        console.log('[layout] Carregado de layout.json');
        return;
      }
      console.warn('[layout] layout.json inválido — gerando seed');
    } catch (err) {
      console.warn('[layout] Erro ao ler layout.json:', err.message, '— gerando seed');
    }
  }
  // Gera seed a partir do MAP/ZONES
  layout = generateSeedLayout(MAP, ZONES);
  try {
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf8');
    console.log('[layout] Seed inicial gravado em layout.json');
  } catch (err) {
    console.error('[layout] Erro ao gravar layout.json:', err.message);
  }
}

let layoutSaveTimer = null;
function scheduleLayoutSave() {
  if (layoutSaveTimer) return;
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    ensureDataDir();
    try {
      fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf8');
    } catch (err) {
      console.error('[layout] Erro ao gravar layout.json:', err.message);
    }
  }, 500);
}

// ─── Helpers WS ───────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(obj, exclude = null) {
  const str = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws !== exclude && p.ws.readyState === 1) {
      p.ws.send(str);
    }
  }
}

function broadcastAll(obj) {
  broadcast(obj, null);
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Snapshot de players sem o campo ws */
function playersSnapshot() {
  return [...players.values()].map(({ ws: _ws, ...rest }) => rest);
}

/**
 * Pontos de spawn em piso livre, espalhados pelo centro do escritório.
 * Evita empilhar todos os jogadores no mesmo pixel (senão um fica escondido embaixo do outro).
 */
const SPAWN_POINTS = [
  { x: 176, y: 240 }, { x: 272, y: 240 }, { x: 592, y: 240 },
  { x: 176, y: 368 }, { x: 528, y: 368 }, { x: 272, y: 432 },
  { x: 496, y: 432 }, { x: 208, y: 496 }, { x: 400, y: 496 }, { x: 656, y: 496 },
];
function pickSpawn() {
  const existing = [...players.values()];
  const jitter = () => Math.round((Math.random() - 0.5) * 16);
  if (existing.length === 0) {
    const base = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
    return { x: base.x + jitter(), y: base.y + jitter() };
  }
  // Escolhe o ponto de spawn mais LONGE do jogador mais próximo (menos ocupado).
  let best = SPAWN_POINTS[0];
  let bestDist = -1;
  for (const pt of SPAWN_POINTS) {
    let nearest = Infinity;
    for (const p of existing) {
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d < nearest) nearest = d;
    }
    if (nearest > bestDist) { bestDist = nearest; best = pt; }
  }
  return { x: best.x + jitter(), y: best.y + jitter() };
}

// ─── Handlers de mensagens WS ─────────────────────────────────────────────────
function handleJoin(ws, msg) {
  const id = generateId();
  const VALID_SKINS = ['golden', 'chocolate', 'grey', 'black', 'cream'];
  const skin = VALID_SKINS.includes(msg.skin) ? msg.skin : 'golden';
  const player = {
    id,
    name: String(msg.name || 'Anônimo').slice(0, 40),
    role: String(msg.role || '').slice(0, 40),
    skin,
    ...pickSpawn(),
    dir: 'down',
    ws,
  };
  players.set(id, player);

  // welcome: snapshot de todos players (sem socket) + estado persistido + layout
  send(ws, {
    t: 'welcome',
    youId: id,
    players: playersSnapshot(),
    layout,
    state: {
      chat: state.chat,
      demandas: state.demandas,
      sprint: state.sprint,
    },
  });

  // avisa os demais
  const { ws: _ws, ...playerPublic } = player;
  broadcast({ t: 'player_join', player: playerPublic }, ws);

  console.log(`[join] ${player.name} (${id}). Online: ${players.size}`);
  return id;
}

function handleMove(ws, msg, playerId) {
  const player = players.get(playerId);
  if (!player) return;
  player.x = typeof msg.x === 'number' ? msg.x : player.x;
  player.y = typeof msg.y === 'number' ? msg.y : player.y;
  player.dir = typeof msg.dir === 'string' ? msg.dir : player.dir;
  broadcast({ t: 'player_move', id: playerId, x: player.x, y: player.y, dir: player.dir }, ws);
}

const CHAT_CAP = 500;

function handleChat(ws, msg, playerId) {
  const sender = players.get(playerId);
  if (!sender) return;

  const channel = msg.channel === 'dm' ? 'dm' : msg.channel === 'local' ? 'local' : 'geral';
  const entry = {
    from: playerId,
    name: sender.name,
    role: sender.role,
    channel,
    text: String(msg.text || '').slice(0, 2000),
    ts: Date.now(),
  };

  if (channel === 'geral') {
    state.chat.geral.push(entry);
    if (state.chat.geral.length > CHAT_CAP) state.chat.geral = state.chat.geral.slice(-CHAT_CAP);
    scheduleSave();
    broadcastAll({ t: 'chat', ...entry });

  } else if (channel === 'dm') {
    const toId = String(msg.to || '');
    const target = players.get(toId);
    if (!toId) return;
    entry.to = toId;
    const key = [playerId, toId].sort().join('|');
    if (!state.chat.dm[key]) state.chat.dm[key] = [];
    state.chat.dm[key].push(entry);
    if (state.chat.dm[key].length > CHAT_CAP) state.chat.dm[key] = state.chat.dm[key].slice(-CHAT_CAP);
    scheduleSave();
    // envia ao remetente e ao destinatário (se online)
    send(ws, { t: 'chat', ...entry });
    if (target && target.ws !== ws) send(target.ws, { t: 'chat', ...entry });

  } else if (channel === 'local') {
    // Bolha de proximidade (não persiste): entrega a quem está na MESMA sala
    // OU dentro do raio compartilhado. Mesma regra do áudio (js/spatial.js),
    // então ouvir e "ter acesso aos textos" andam juntos.
    const senderZone = getZoneAt(sender.x, sender.y);
    const str = JSON.stringify({ t: 'chat', ...entry });
    for (const p of players.values()) {
      if (p.ws.readyState !== 1) continue;
      if (isAudible(sender, p, senderZone)) p.ws.send(str);
    }
  }
}

/**
 * Regra de audibilidade/proximidade compartilhada: `a` alcança `b` se estão na
 * mesma zona nomeada, ou dentro do raio da bolha.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {object|null} [aZone] — zona de `a` já computada (otimização opcional)
 */
function isAudible(a, b, aZone = getZoneAt(a.x, a.y)) {
  const bZone = getZoneAt(b.x, b.y);
  if (aZone && bZone && aZone.key === bZone.key) return true;
  return Math.hypot(b.x - a.x, b.y - a.y) <= AUDIO_RADIUS;
}

/**
 * Relay direcionado de sinalização WebRTC (offer/answer/ICE) entre dois peers.
 * O servidor carimba `from` com o id real do remetente (não confia no cliente)
 * e repassa `data` opaca ao destinatário `to`.
 */
function handleRtcSignal(msg, playerId) {
  const toId = String(msg.to || '');
  const target = players.get(toId);
  if (!target || target.ws.readyState !== 1) return;
  send(target.ws, { t: 'rtc_signal', from: playerId, data: msg.data });
}

function handleDemandaAdd(msg) {
  demandaCounter++;
  const demanda = {
    id: `D-${demandaCounter}`,
    assunto: String(msg.assunto || '').slice(0, 200),
    prioridade: String(msg.prioridade || 'normal').slice(0, 40),
    link: String(msg.link || '').slice(0, 500),
    status: 'aberta',
    criadoEm: Date.now(),
  };
  state.demandas.push(demanda);
  scheduleSave();
  broadcastAll({ t: 'demandas', demandas: state.demandas });
}

function handleDemandaUpdate(msg) {
  const d = state.demandas.find(x => x.id === msg.id);
  if (!d) return;
  if (msg.status !== undefined) d.status = String(msg.status).slice(0, 40);
  scheduleSave();
  broadcastAll({ t: 'demandas', demandas: state.demandas });
}

function handleDemandaRemove(msg) {
  const idx = state.demandas.findIndex(x => x.id === msg.id);
  if (idx === -1) return;
  state.demandas.splice(idx, 1);
  scheduleSave();
  broadcastAll({ t: 'demandas', demandas: state.demandas });
}

function handleSprintSet(msg) {
  state.sprint = msg.sprint ?? {};
  scheduleSave();
  broadcastAll({ t: 'sprint', sprint: state.sprint });
}

/**
 * Recebe um novo layout do cliente, valida, persiste e faz broadcast a todos.
 * @param {object} msg — { t: 'layout_set', layout: {...} }
 */
function handleLayoutSet(msg) {
  if (!validateLayout(msg.layout)) {
    console.warn('[layout] layout_set recebido mas inválido — ignorado');
    return;
  }
  layout = msg.layout;
  scheduleLayoutSave();
  broadcastAll({ t: 'layout', layout });
  console.log('[layout] Atualizado e propagado para todos os clientes');
}

// ─── Gerenciador de Túnel Cloudflare ─────────────────────────────────────────

/** @type {{ proc: import('child_process').ChildProcess|null, url: string|null, status: 'off'|'starting'|'ready'|'error', error: string|null }} */
const tunnel = { proc: null, url: null, status: 'off', error: null };

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Garante que o túnel está rodando. Faz spawn se `off`; retorna imediatamente
 * se já está `starting` ou `ready`. O front faz polling em GET /api/invite.
 */
function ensureTunnel() {
  if (tunnel.status === 'ready' || tunnel.status === 'starting') return;

  tunnel.status = 'starting';
  tunnel.url = null;
  tunnel.error = null;

  const extraPaths = [
    process.env.HOME ? `${process.env.HOME}/.local/bin` : '',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);

  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:8080'], {
      env: { ...process.env, PATH: [process.env.PATH, ...extraPaths].join(':') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    tunnel.status = 'error';
    tunnel.error = `Falha ao iniciar cloudflared: ${err.message}`;
    console.error('[tunnel] spawn error:', err.message);
    return;
  }

  tunnel.proc = proc;

  // cloudflared imprime a URL em stderr (quick tunnel)
  function scanForUrl(chunk) {
    if (tunnel.status === 'ready') return;
    const text = chunk.toString();
    const m = text.match(TUNNEL_URL_RE);
    if (m) {
      tunnel.url = m[0];
      tunnel.status = 'ready';
      console.log('[tunnel] URL pronta:', tunnel.url);
    }
  }

  proc.stdout.on('data', scanForUrl);
  proc.stderr.on('data', scanForUrl);

  proc.on('error', (err) => {
    if (tunnel.status === 'ready') return; // já obtivemos a URL — ignorar erros tardios
    tunnel.status = 'error';
    tunnel.proc = null;
    if (err.code === 'ENOENT') {
      tunnel.error = "cloudflared não encontrado — instale ou verifique o PATH. Como alternativa, use ./compartilhar-enterprise.sh";
    } else {
      tunnel.error = `Erro ao iniciar cloudflared: ${err.message}`;
    }
    console.error('[tunnel] error:', err.message);
  });

  proc.on('exit', (code) => {
    if (tunnel.proc !== proc) return; // processo já foi substituído / parado intencionalmente
    if (tunnel.status !== 'ready') {
      tunnel.status = 'error';
      tunnel.error = `cloudflared encerrou (código ${code}) antes de gerar a URL. Verifique se o cloudflared está instalado e tente novamente.`;
    }
    tunnel.proc = null;
    console.log(`[tunnel] processo encerrou, código ${code}`);
  });
}

/**
 * Para o túnel e zera o estado.
 */
function stopTunnel() {
  const proc = tunnel.proc;
  tunnel.proc = null;
  tunnel.url = null;
  tunnel.status = 'off';
  tunnel.error = null;
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* ignorar */ }
    // Fallback: se não encerrar em 3s (shutdown gracioso travado), força SIGKILL
    // para não deixar cloudflared órfão.
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* já morto */ }
    }, 3000);
    proc.once('exit', () => clearTimeout(killTimer));
  }
}

// ─── Roteador das APIs de convite ─────────────────────────────────────────────

/**
 * Tenta tratar rotas /api/invite*. Retorna true se tratou, false se não é rota de API.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
function handleInviteApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;

  if (!pathname.startsWith('/api/invite')) return false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'POST' && pathname === '/api/invite/start') {
    ensureTunnel();
    res.writeHead(200);
    res.end(JSON.stringify({ status: tunnel.status }));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/invite') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: tunnel.status,
      url: tunnel.url ?? undefined,
      error: tunnel.error ?? undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/invite/stop') {
    stopTunnel();
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'off' }));
    return true;
  }

  // Rota /api/invite* desconhecida
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
  return true;
}

// ─── Servidor HTTP (arquivos estáticos) ───────────────────────────────────────
function serveStatic(req, res) {
  // Bloqueia path traversal
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const normalised = path.normalize(urlPath);
  if (normalised.includes('..')) {
    res.writeHead(400); res.end('Bad request'); return;
  }

  let filePath = path.join(STATIC_ROOT, normalised);
  // Diretório → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  // Bloqueia acesso a data/
  if (filePath.startsWith(DATA_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  // no-store: impede que navegador/Cloudflare (túnel de convite) sirvam JS/CSS/HTML
  // em cache. Sem isso, convidados recebiam código antigo mesmo após deploy.
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadState();
loadLayout();

const server = http.createServer((req, res) => {
  try {
    if (handleInviteApi(req, res)) return;
    serveStatic(req, res);
  } catch (err) {
    console.error('[http] Erro:', err.message);
    res.writeHead(500); res.end('Server error');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

// ─── Heartbeat: detecta e remove conexões mortas (fantasmas) ───────────────────
const HEARTBEAT_INTERVAL = 15000;
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      // Não respondeu ao ping anterior → conexão morta. terminate() dispara 'close'
      // → fluxo de disconnect (remove player + broadcast player_leave).
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket já morto; será limpo no próximo ciclo */ }
  }
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

wss.on('connection', (ws) => {
  let playerId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('[ws] Mensagem inválida (não JSON), ignorada');
      return;
    }

    try {
      switch (msg.t) {
        case 'join':
          if (!playerId) playerId = handleJoin(ws, msg);
          break;
        case 'move':
          if (playerId) handleMove(ws, msg, playerId);
          break;
        case 'chat':
          if (playerId) handleChat(ws, msg, playerId);
          break;
        case 'demanda_add':
          handleDemandaAdd(msg);
          break;
        case 'demanda_update':
          handleDemandaUpdate(msg);
          break;
        case 'demanda_remove':
          handleDemandaRemove(msg);
          break;
        case 'sprint_set':
          handleSprintSet(msg);
          break;
        case 'rtc_signal':
          if (playerId) handleRtcSignal(msg, playerId);
          break;
        case 'layout_set':
          if (playerId) handleLayoutSet(msg);
          break;
        default:
          console.warn('[ws] Tipo desconhecido:', msg.t);
      }
    } catch (err) {
      console.error('[ws] Erro ao processar mensagem:', err.message);
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    const player = players.get(playerId);
    players.delete(playerId);
    if (player) {
      broadcast({ t: 'player_leave', id: playerId });
      console.log(`[leave] ${player.name} (${playerId}). Online: ${players.size}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] Erro de socket:', err.message);
  });
});

server.listen(8080, () => {
  console.log('[enterprise] Servidor rodando em http://localhost:8080');
  console.log('[enterprise] WebSocket em ws://localhost:8080/ws');
});

// ─── Encerramento limpo: mata o túnel se estiver rodando ─────────────────────
function shutdown() {
  stopTunnel();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => { stopTunnel(); });
