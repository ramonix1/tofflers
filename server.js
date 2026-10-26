/**
 * Enterprise — Servidor Multiplayer
 * HTTP estático + WebSocket (/ws) + Persistência em JSON
 * Porta 8080 (ou env PORT)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getZoneAt, MAP, ZONES } from './js/office.js';
import { AUDIO_RADIUS } from './js/spatial.js';
import { generateSeedLayout } from './js/layout.js';

// ─── Caminhos ────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
// ENTERPRISE_DATA_DIR: usado pelos testes para não tocar nos dados/link reais.
const DATA_DIR = process.env.ENTERPRISE_DATA_DIR
  ? path.resolve(process.env.ENTERPRISE_DATA_DIR)
  : path.join(__dirname, 'data');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
// Banco (SQLite embutido do Node) — arquivo histórico das sessões de chat.
const DB_FILE     = path.join(DATA_DIR, 'toffies.db');
// O chat é EFÊMERO por sessão (= presença do host, ver "Sessão" abaixo): nasce
// vazio a cada sessão e, ao encerrá-la, é arquivado no SQLite.
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
    // Demandas e sprint PERSISTEM entre sessões. O CHAT NÃO: é efêmero por
    // sessão — sempre começa vazio (a sessão anterior foi arquivada no SQLite).
    state.chat = { geral: [], dm: {} };
    state.demandas = state.demandas || [];
    state.sprint = state.sprint || {};
    // Recalcular contador de demandas a partir dos IDs existentes
    for (const d of (state.demandas || [])) {
      const m = String(d.id || '').match(/^D-(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > demandaCounter) demandaCounter = n;
      }
    }
    console.log(`[state] Carregado: ${state.demandas.length} demandas (chat inicia vazio — efêmero por sessão)`);
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
      // Persiste APENAS demandas + sprint. O chat é efêmero por sessão (não vai
      // para o state.json; é arquivado no SQLite ao encerrar).
      const persistivel = { demandas: state.demandas, sprint: state.sprint };
      fs.writeFileSync(STATE_FILE, JSON.stringify(persistivel, null, 2), 'utf8');
    } catch (err) {
      console.error('[state] Erro ao gravar state.json:', err.message);
    }
  }, 500);
}

// ─── Banco SQLite: arquivo histórico das sessões de chat ─────────────────────
let db = null;
function initDb() {
  try {
    ensureDataDir();
    db = new DatabaseSync(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        dm_key  TEXT,
        from_id TEXT,
        name    TEXT,
        role    TEXT,
        text    TEXT,
        ts      INTEGER
      );
    `);
  } catch (err) {
    console.error('[db] Falha ao abrir/criar o SQLite:', err.message);
    db = null;
  }
}

/**
 * Arquiva a conversa da sessão corrente no SQLite e ZERA o chat em memória.
 * Pode ser chamado várias vezes por processo (fim de sessão, SIGTERM, exit):
 * como o chat é limpo após arquivar, uma 2ª chamada não duplica linhas.
 * Síncrono (DatabaseSync), seguro para rodar em handler de saída.
 */
function archiveSession() {
  try {
    if (!db) initDb();
    if (!db) return;
    const geral = (state.chat && state.chat.geral) || [];
    const dm    = (state.chat && state.chat.dm)    || {};
    const dmMsgs = [];
    for (const [key, arr] of Object.entries(dm)) {
      for (const m of (arr || [])) dmMsgs.push({ ...m, dm_key: key });
    }
    const total = geral.length + dmMsgs.length;
    state.chat = { geral: [], dm: {} }; // limpa já: nunca arquiva a mesma conversa 2x
    if (total === 0) return; // sessão sem conversa — nada a arquivar
    const endedAt = Date.now();
    const sres = db.prepare(
      'INSERT INTO sessions (started_at, ended_at, message_count) VALUES (?,?,?)'
    ).run(session.startedAt, endedAt, total);
    const sessionId = Number(sres.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO messages (session_id, channel, dm_key, from_id, name, role, text, ts) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const m of geral)  ins.run(sessionId, 'geral', null,      m.from || null, m.name || null, m.role || null, m.text || '', m.ts || endedAt);
    for (const m of dmMsgs) ins.run(sessionId, 'dm',    m.dm_key,   m.from || null, m.name || null, m.role || null, m.text || '', m.ts || endedAt);
    console.log(`[archive] Sessão ${sessionId} arquivada no SQLite: ${total} mensagens.`);
  } catch (err) {
    console.error('[archive] Falha ao arquivar sessão:', err.message);
  }
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
// Spawns em células "fundo-aberto" (livres com os 8 vizinhos livres), no salão
// de cima e na faixa aberta de baixo — ninguém nasce colado/atrás de parede.
// (col*32+16, row*32+16). Ver mapa em tools/gen-layout.mjs.
// PONTO ÚNICO de entrada (recepção/salão). Célula (col 12, row 4) → x=400, y=144:
// livre, com os 8 vizinhos livres e paredes distantes — ninguém nasce em parede.
// (Revertido o spawn aleatório, que caía perto de paredes das baias.)
const SPAWN_POINT = { x: 400, y: 144 };
function pickSpawn() {
  // Jitter mínimo só para não empilhar todos exatamente no mesmo pixel — fica
  // dentro da mesma célula aberta.
  const j = () => Math.round((Math.random() - 0.5) * 10);
  return { x: SPAWN_POINT.x + j(), y: SPAWN_POINT.y + j() };
}

// ─── Handlers de mensagens WS ─────────────────────────────────────────────────
function handleJoin(ws, msg) {
  const id = generateId();
  const VALID_SKINS = ['golden', 'caramelo', 'chocolate', 'grey', 'black', 'cream'];
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

  // welcome: snapshot de todos players (sem socket) + estado persistido + layout + isHost
  send(ws, {
    t: 'welcome',
    youId: id,
    players: playersSnapshot(),
    layout,
    isHost: ws._isHost ?? false,
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

// ─── Chave do anfitrião ───────────────────────────────────────────────────────
// Todo mundo entra por link público; o anfitrião é quem apresenta esta chave
// (?h= no WebSocket, X-Host-Key nas rotas /api/invite* e /api/session*).
// Gerada uma vez e persistida; HOST_KEY (env) sobrepõe — usado nos testes.
const HOST_KEY_FILE  = path.join(DATA_DIR, 'host-key');
const HOST_LINK_FILE = path.join(DATA_DIR, 'host-link.txt');

function loadHostKey() {
  if (process.env.HOST_KEY) return process.env.HOST_KEY;
  try {
    const k = fs.readFileSync(HOST_KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch { /* ainda não existe — gera abaixo */ }
  const k = crypto.randomBytes(24).toString('base64url'); // 192 bits
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HOST_KEY_FILE, k + '\n', { mode: 0o600 });
  try { fs.chmodSync(HOST_KEY_FILE, 0o600); } catch { /* ignorar */ }
  return k;
}
const HOST_KEY = loadHostKey();

/** Comparação em tempo constante (hash antes, para igualar tamanhos). */
function hostKeyMatches(given) {
  if (!given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(HOST_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// ─── Gerenciador de Túnel Cloudflare ─────────────────────────────────────────
// O túnel vive enquanto o processo viver (o anfitrião entra por ele). Se o
// cloudflared morrer ou falhar, religa sozinho com backoff.

/** @type {{ proc: import('child_process').ChildProcess|null, url: string|null, status: 'off'|'starting'|'ready'|'error', error: string|null, retryTimer: NodeJS.Timeout|null, backoff: number, stopping: boolean }} */
const tunnel = { proc: null, url: null, status: 'off', error: null, retryTimer: null, backoff: 5000, stopping: false };

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_BACKOFF_MIN = 5000;
const TUNNEL_BACKOFF_MAX = 60000;

function removeHostLink() {
  try { fs.unlinkSync(HOST_LINK_FILE); } catch { /* já não existe */ }
}

/** Túnel pronto: zera o backoff e publica o link do anfitrião (arquivo + log). */
function onTunnelReady() {
  tunnel.backoff = TUNNEL_BACKOFF_MIN;
  const link = `${tunnel.url}/?h=${HOST_KEY}`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HOST_LINK_FILE, link + '\n', { mode: 0o600 });
    fs.chmodSync(HOST_LINK_FILE, 0o600);
  } catch (err) {
    console.error('[tunnel] não consegui gravar host-link.txt:', err.message);
  }
  console.log(`[enterprise] Link do anfitrião: ${link}`);
}

/** Agenda religação do túnel (backoff 5s dobrando até 60s). Idempotente. */
function scheduleTunnelRetry() {
  if (tunnel.stopping || tunnel.retryTimer) return;
  const delay = tunnel.backoff;
  tunnel.backoff = Math.min(tunnel.backoff * 2, TUNNEL_BACKOFF_MAX);
  console.log(`[tunnel] religando em ${Math.round(delay / 1000)}s`);
  tunnel.retryTimer = setTimeout(() => {
    tunnel.retryTimer = null;
    ensureTunnel();
  }, delay);
}

/** Túnel caiu/falhou: limpa estado, apaga o link do anfitrião e agenda religação. */
function onTunnelDown(message) {
  tunnel.proc = null;
  tunnel.url = null;
  tunnel.status = 'error';
  if (message) tunnel.error = message;
  removeHostLink();
  scheduleTunnelRetry();
}

/**
 * Garante que o túnel está rodando. Faz spawn se `off`/`error`; retorna
 * imediatamente se já está `starting` ou `ready`. O front faz polling em GET /api/invite.
 */
function ensureTunnel() {
  if (tunnel.status === 'ready' || tunnel.status === 'starting') return;
  if (tunnel.retryTimer) { clearTimeout(tunnel.retryTimer); tunnel.retryTimer = null; }

  tunnel.stopping = false;
  tunnel.status = 'starting';
  tunnel.url = null;
  tunnel.error = null;

  // Gancho de teste (tools/session-e2e.mjs): simula túnel pronto sem rodar cloudflared.
  if (process.env.TEST_TUNNEL_URL) {
    tunnel.url = process.env.TEST_TUNNEL_URL;
    tunnel.status = 'ready';
    onTunnelReady();
    return;
  }

  const extraPaths = [
    process.env.HOME ? `${process.env.HOME}/.local/bin` : '',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);

  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      env: { ...process.env, PATH: [process.env.PATH, ...extraPaths].join(':') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[tunnel] spawn error:', err.message);
    onTunnelDown(`Falha ao iniciar cloudflared: ${err.message}`);
    return;
  }

  tunnel.proc = proc;

  // cloudflared imprime a URL em stderr (quick tunnel)
  function scanForUrl(chunk) {
    if (tunnel.proc !== proc || tunnel.status === 'ready') return;
    const text = chunk.toString();
    const m = text.match(TUNNEL_URL_RE);
    if (m) {
      tunnel.url = m[0];
      tunnel.status = 'ready';
      console.log('[tunnel] URL pronta:', tunnel.url);
      onTunnelReady();
    }
  }

  proc.stdout.on('data', scanForUrl);
  proc.stderr.on('data', scanForUrl);

  proc.on('error', (err) => {
    if (tunnel.proc !== proc) return; // processo já foi substituído / parado intencionalmente
    console.error('[tunnel] error:', err.message);
    onTunnelDown(err.code === 'ENOENT'
      ? 'cloudflared não encontrado — instale ou verifique o PATH.'
      : `Erro ao iniciar cloudflared: ${err.message}`);
  });

  proc.on('exit', (code) => {
    if (tunnel.proc !== proc) return; // processo já foi substituído / parado intencionalmente
    console.log(`[tunnel] processo encerrou, código ${code}`);
    onTunnelDown(`cloudflared encerrou (código ${code}); religando automaticamente.`);
  });
}

/**
 * Para o túnel e zera o estado. Só no shutdown do processo — a sessão acabar
 * NÃO derruba o túnel (senão o anfitrião fica trancado para fora).
 */
function stopTunnel() {
  const proc = tunnel.proc;
  tunnel.stopping = true;
  if (tunnel.retryTimer) { clearTimeout(tunnel.retryTimer); tunnel.retryTimer = null; }
  tunnel.proc = null;
  tunnel.url = null;
  tunnel.status = 'off';
  tunnel.error = null;
  removeHostLink();
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

  if (!pathname.startsWith('/api/invite') && !pathname.startsWith('/api/session')) return false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // Só o host (quem apresenta a chave no X-Host-Key) controla convite/sessão.
  if (!isHostRequest(req)) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/session/end') {
    endSession('host_ended');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ended' }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/invite/start') {
    if (!session.active) { // sem sessão não há token de convite
      res.writeHead(409);
      res.end(JSON.stringify({ error: 'Sem sessão ativa' }));
      return true;
    }
    ensureTunnel();
    res.writeHead(200);
    res.end(JSON.stringify({ status: tunnel.status }));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/invite') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: tunnel.status,
      // O token da sessão viaja na URL (?k=): é o que autentica o convidado.
      url: (tunnel.url && session.active) ? `${tunnel.url}/?k=${session.token}` : undefined,
      error: tunnel.error ?? undefined,
    }));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/invite/stop') {
    // "Parar de compartilhar": o túnel segue de pé (o host entra por ele); o que
    // muda é o token de convite — o link antigo não vale para novas conexões,
    // quem já está conectado permanece.
    if (session.active) session.token = newToken();
    res.writeHead(200);
    res.end(JSON.stringify({ status: tunnel.status }));
    return true;
  }

  // Rota /api/invite* desconhecida
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
  return true;
}

// ─── Sessão = presença do host ────────────────────────────────────────────────
// O processo e o túnel ficam de pé, mas NÃO guardam sessão: ela começa quando o
// 1º WebSocket do host (com a chave) conecta e termina quando o último host
// sumiu por SESSION_GRACE_MS (F5 do host não derruba), ou por parada explícita
// (POST /api/session/end, SIGTERM/SIGINT). Ao terminar: avisa e derruba os
// convidados, arquiva+limpa o chat e descarta o token de convite — o link
// antigo nunca mais entra, e a próxima sessão gera outro. O túnel permanece.
const SESSION_GRACE_MS = Number(process.env.SESSION_GRACE_MS) || 8000;
const CLOSE_SESSION_END = 4400; // sessão encerrada pelo anfitrião (cliente NÃO reconecta)
const CLOSE_INVALID     = 4401; // token ausente/errado ou sem sessão ativa (cliente NÃO reconecta)

/** @type {{active:boolean, id:string|null, token:string|null, startedAt:number, endTimer:NodeJS.Timeout|null}} */
const session = { active: false, id: null, token: null, startedAt: Date.now(), endTimer: null };
/** WebSockets de host conectados (decidem a vida da sessão). */
const hostSockets = new Set();

/** Token de convite novo (192 bits). */
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Host = quem apresenta a chave do anfitrião: `?h=` na URL do upgrade do
 * WebSocket, ou header `X-Host-Key` nas rotas HTTP. Só isso — origem de rede
 * (loopback ou túnel) não conta; loopback sem chave é convidado comum.
 * @param {http.IncomingMessage} req
 */
function isHostRequest(req) {
  let given = req.headers['x-host-key'];
  if (Array.isArray(given)) given = given[0];
  if (!given) given = new URL(req.url, 'http://x').searchParams.get('h');
  return hostKeyMatches(given);
}

/** Comparação em tempo constante (hash antes, para igualar tamanhos). */
function tokenMatches(given) {
  if (!session.active || !session.token || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(session.token).digest();
  return crypto.timingSafeEqual(a, b);
}

function startSession() {
  session.active = true;
  session.token = newToken();
  session.id = crypto.randomBytes(6).toString('hex');           // id público (não é o token)
  session.startedAt = Date.now();
  state.chat = { geral: [], dm: {} };
  console.log(`[session] Iniciada ${session.id}`);
}

function endSession(reason = 'host_left') {
  if (session.endTimer) { clearTimeout(session.endTimer); session.endTimer = null; }
  if (!session.active) return;
  session.active = false; // já recusa novos convidados daqui em diante
  console.log(`[session] Encerrando ${session.id} (${reason})`);
  // 1) avisa e derruba todos os sockets (convidados; host só em parada explícita)
  const msg = JSON.stringify({ t: 'session_end', reason });
  for (const ws of wss.clients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
      ws.close(CLOSE_SESSION_END, 'session_end');
    } catch { /* socket já morto */ }
  }
  hostSockets.clear();
  players.clear();
  // 2) arquiva e limpa o chat (idempotente) — o túnel NÃO cai aqui
  archiveSession();
  state.chat = { geral: [], dm: {} };
  // 3) descarta o token: sem sessão não há token válido
  session.token = null;
  session.id = null;
}

function hostSocketGone(ws) {
  if (!hostSockets.delete(ws)) return;
  if (hostSockets.size === 0 && session.active && !session.endTimer) {
    session.endTimer = setTimeout(() => endSession('host_left'), SESSION_GRACE_MS);
  }
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
initDb();

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

wss.on('connection', (ws, req) => {
  let playerId = null;

  // ── Detecção de host: quem apresenta a chave do anfitrião (?h=) ──
  const hdrs = req.headers;
  const isHost = isHostRequest(req);

  // ── Autenticação: host (chave válida) inicia/continua a sessão; convidado só
  // com sessão ativa + token correto (?k=). Recusa = fecha com 4401, sem dados.
  if (isHost) {
    if (!session.active) startSession();
    if (session.endTimer) { clearTimeout(session.endTimer); session.endTimer = null; }
    hostSockets.add(ws);
  } else {
    const k = new URL(req.url, 'http://x').searchParams.get('k');
    if (!tokenMatches(k)) {
      ws.close(CLOSE_INVALID, 'invalid');
      return;
    }
  }

  // Log das chaves de headers do upgrade (primeiro connect apenas, para diagnóstico)
  if (!wss._headerLogDone) {
    wss._headerLogDone = true;
    console.log('[ws] Headers do upgrade (primeira conexão):', Object.keys(hdrs).join(', '));
    console.log('[ws] isHost =', isHost, '| cf-ray:', hdrs['cf-ray'], '| cf-connecting-ip:', hdrs['cf-connecting-ip'], '| x-forwarded-for:', hdrs['x-forwarded-for']);
  }

  // Guarda isHost no socket para enforcement nas mensagens de mutação
  ws._isHost = isHost;

  ws.isAlive = true;
  // Id público da sessão: o cliente detecta troca de sessão numa reconexão e recarrega.
  send(ws, { t: 'session', id: session.id });
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
          if (playerId) {
            if (!ws._isHost) {
              console.warn('[ws] layout_set rejeitado: remetente não é host (isHost=false)');
            } else {
              handleLayoutSet(msg);
            }
          }
          break;
        default:
          console.warn('[ws] Tipo desconhecido:', msg.t);
      }
    } catch (err) {
      console.error('[ws] Erro ao processar mensagem:', err.message);
    }
  });

  ws.on('close', () => {
    hostSocketGone(ws);
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

server.listen(PORT, () => {
  console.log(`[enterprise] Servidor rodando em http://localhost:${PORT}`);
  console.log(`[enterprise] WebSocket em ws://localhost:${PORT}/ws`);
  ensureTunnel(); // túnel sempre ligado: o anfitrião também entra por ele
});

// ─── Encerramento limpo: o túnel só cai aqui, junto com o processo ───────────
function shutdown() {
  endSession('server_stop'); // avisa convidados e arquiva o chat
  stopTunnel();
  setTimeout(() => process.exit(0), 300); // dá tempo de os frames de close saírem
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => { archiveSession(); stopTunnel(); });
