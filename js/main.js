/**
 * main.js — Bootstrap + game loop principal (requestAnimationFrame).
 *
 * Ordem de inicialização:
 *   1. Canvas dimensionado ao mapa isométrico (CANVAS_W × CANVAS_H de iso.js)
 *   2. Tela de entrada com seletor de pelagem (ou auto-join por query string)
 *   3. Após entrar: conecta WebSocket, instancia Player, Chat, etc.
 *   4. Inicia game loop com render isométrico + painter's algorithm
 */

import { MAP_W, MAP_H, getZoneAt } from './office.js';
import { CANVAS_W, CANVAS_H, worldToScreen, worldDepthKey } from './iso.js';
import { renderOfficeIso }          from './office-iso.js';
import { Player }                   from './player.js';
import { Avatar, ROLE_COLORS, ROLE_ICONS } from './avatar.js';
import { Chat }                     from './chat.js';
import { MeetingManager }           from './meetings.js';
import { DemandasPanel }            from './demandas.js';
import { SprintManager }            from './sprint.js';
import { Net }                      from './net.js';
import { RtcManager }               from './rtc.js';
import { AUDIO_RADIUS, distance, gainForDistance } from './spatial.js';

// ── Canvas setup (isométrico) ─────────────────────────────────────────────────

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('office-canvas'));
const ctx    = canvas.getContext('2d');

// Canvas maior para acomodar a projeção isométrica do mapa 25×18
canvas.width  = CANVAS_W; // ~1376
canvas.height = CANVAS_H; // ~888

// ── Net ───────────────────────────────────────────────────────────────────────

const net = new Net();

// ── Instâncias ────────────────────────────────────────────────────────────────

const chat     = new Chat(net);
const demandas = new DemandasPanel(chat);
const sprint   = new SprintManager(chat, demandas);
const meeting  = new MeetingManager(chat, sprint);

demandas.setNet(net);
sprint.setNet(net);

// ── Estado dos jogadores remotos ──────────────────────────────────────────────

/** @type {Map<string, Avatar>} */
const remotePlayers = new Map();

/**
 * Cria um Avatar para um jogador remoto.
 * @param {{id:string, name:string, role:string, x:number, y:number, skin?:string}} p
 * @returns {Avatar}
 */
function makeRemoteAvatar(p) {
  return new Avatar({
    id:       p.id,
    name:     p.name,
    role:     p.role || 'Dev',
    skin:     p.skin || 'golden',
    x:        p.x   || MAP_W / 2,
    y:        p.y   || MAP_H / 2,
    isPlayer: false,
  });
}

// ── Jogador local ─────────────────────────────────────────────────────────────

let player = null; // criado após o join para ter nome/papel/skin corretos

// ── WebRTC por proximidade ─────────────────────────────────────────────────────

const mediaButtons = {
  mic:    document.getElementById('mic-toggle-btn'),
  cam:    document.getElementById('cam-toggle-btn'),
  screen: document.getElementById('screen-toggle-btn'),
};

const rtc = new RtcManager({
  net,
  remotePlayers,
  videoStrip: document.getElementById('video-strip'),
  selfLabel: () => (player ? player.name : 'Você'),
  onStateChange: (kind, active, denied) => {
    const btn = mediaButtons[kind];
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.classList.toggle('denied', !!denied);
    btn.setAttribute('aria-pressed', String(active));
    const titles = { mic: 'microfone', cam: 'câmera', screen: 'tela' };
    btn.title = (active ? 'Desativar ' : 'Ativar ') + titles[kind];
  },
});

mediaButtons.mic    && mediaButtons.mic.addEventListener('click', () => rtc.toggleMic());
mediaButtons.cam    && mediaButtons.cam.addEventListener('click', () => rtc.toggleCam());
mediaButtons.screen && mediaButtons.screen.addEventListener('click', () => rtc.toggleScreen());

net.onSignal = (from, data) => rtc.handleSignal(from, data);

// ── Relógio ───────────────────────────────────────────────────────────────────

const clockEl = document.getElementById('clock');
function updateClock() {
  clockEl.textContent = new Date().toLocaleTimeString('pt-BR');
}
updateClock();
setInterval(updateClock, 1000);

// ── Raio de proximidade ───────────────────────────────────────────────────────

const PROXIMITY_RADIUS = AUDIO_RADIUS;

// ── Render (painter's algorithm) ──────────────────────────────────────────────

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Fundo escuro
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Piso (passada separada — sem depth issue)
  // + zonas coloridas iso + objetos do cenário em painter's order
  renderOfficeIso(ctx);

  // ── Avatares intercalados com objetos (painter's algorithm) ──────────────
  // Coletamos todos os avatares e os ordenamos por profundidade.
  // Nota: os objetos do cenário já foram desenhados por renderOfficeIso;
  // aqui só precisamos que os AVATARES sejam desenhados na ordem certa entre si
  // (e sobre o piso/objetos que já estão abaixo deles).
  // Para um painter completo incluindo objetos, seria necessário integrar
  // getSceneObjects() — isso é indicado como melhoria futura na documentação.

  /** @type {Array<Avatar>} */
  const avatarsToDraw = [];
  for (const remote of remotePlayers.values()) {
    avatarsToDraw.push(remote);
  }
  if (player) avatarsToDraw.push(player);

  // Ordena por profundidade (col + row do mundo) crescente → fundo primeiro
  avatarsToDraw.sort((a, b) => a.depthKey - b.depthKey);

  for (const av of avatarsToDraw) {
    av.render(ctx);
  }

  // ── Círculo de proximidade do jogador local ───────────────────────────────
  if (player) {
    // Converte o raio de mundo para uma escala aproximada em tela iso
    // (projeção simplificada: o raio no eixo Y de mundo ≈ raio_tela * cos30)
    const { sx: cx, sy: cy } = worldToScreen(player.x, player.y);
    const screenRadius = PROXIMITY_RADIUS * 0.5; // aproximação visual
    ctx.beginPath();
    ctx.ellipse(cx, cy, screenRadius, screenRadius * 0.5, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(99,102,241,0.10)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ── Interpolação de remotos ───────────────────────────────────────────────────

/** Destinos de interpolação: Map(id → {tx, ty}) */
const remoteTargets = new Map();

/** Posições anteriores para derivar direção de facing dos remotos */
const remotePrev = new Map();

function interpolateRemotes(dt) {
  const LERP = 1 - Math.pow(1 - 0.2, dt / 16);
  for (const [id, avatar] of remotePlayers) {
    const target = remoteTargets.get(id);
    if (!target) continue;

    const prevX = avatar.x;
    const prevY = avatar.y;

    avatar.x += (target.x - avatar.x) * LERP;
    avatar.y += (target.y - avatar.y) * LERP;

    const dist = Math.hypot(target.x - avatar.x, target.y - avatar.y);
    avatar._bobActive = dist > 1;

    // Atualiza facing a partir do vetor de deslocamento
    const dx = avatar.x - prevX;
    const dy = avatar.y - prevY;
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
      avatar.setFacingFromVector(dx, dy);
    }
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────

let lastTime = 0;
let loopStarted = false;

function loop(timestamp) {
  const dt = lastTime === 0 ? 16 : Math.min(timestamp - lastTime, 100);
  lastTime = timestamp;

  if (player) {
    player.update(dt);

    // Envia move se mudou (dir continua como 'move'/'idle' para compatibilidade)
    const dir = player._bobActive ? 'move' : 'idle';
    net.sendMove(player.x, player.y, dir);
  }

  interpolateRemotes(dt);

  // Audibilidade por proximidade/sala → WebRTC
  if (player) {
    const myZone = getZoneAt(player.x, player.y);
    const gains = new Map();
    for (const [id, avatar] of remotePlayers) {
      const remoteZone = getZoneAt(avatar.x, avatar.y);
      const sameZone = myZone && remoteZone && remoteZone.key === myZone.key;
      const g = sameZone ? 1 : gainForDistance(distance(player, avatar));
      gains.set(id, g);
    }
    rtc.updateAudibility(gains);
  }

  // Atualiza timers de bubble de remotos
  for (const remote of remotePlayers.values()) {
    remote.update(dt);
  }

  chat.update(dt);
  meeting.update(dt);

  render();

  requestAnimationFrame(loop);
}

// ── Previne scroll ao pressionar setas ───────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
    e.preventDefault();
  }
});

// ── Callbacks Net ─────────────────────────────────────────────────────────────

net.onWelcome = (data) => {
  const me = (data.players || []).find(p => p.id === net.youId);
  if (me && player) {
    player.x = me.x;
    player.y = me.y;
  }

  for (const p of (data.players || [])) {
    if (p.id === net.youId) continue;
    const avatar = makeRemoteAvatar(p);
    remotePlayers.set(p.id, avatar);
    remoteTargets.set(p.id, { x: p.x || MAP_W / 2, y: p.y || MAP_H / 2 });
    chat.registerRemotePlayer(p);
  }

  const chatState = data.state && data.state.chat;
  if (chatState) {
    for (const msg of (chatState.geral || [])) {
      chat.receiveHistoryMsg('geral', msg);
    }
    for (const [key, msgs] of Object.entries(chatState.dm || {})) {
      const ids = key.split('|');
      if (!ids.includes(net.youId)) continue;
      const otherId = ids.find(id => id !== net.youId);
      for (const msg of msgs) {
        chat.receiveHistoryMsg('dm:' + otherId, msg);
      }
    }
  }
};

net.onPlayerJoin = (p) => {
  if (p.id === net.youId) return;
  const avatar = makeRemoteAvatar(p);
  remotePlayers.set(p.id, avatar);
  remoteTargets.set(p.id, { x: p.x || MAP_W / 2, y: p.y || MAP_H / 2 });
  chat.registerRemotePlayer(p);
  chat.postEvent('geral', `👋 ${p.name} (${p.role}) entrou no escritório`);
};

net.onPlayerMove = (m) => {
  if (m.id === net.youId) return;
  const target = remoteTargets.get(m.id);
  if (target) {
    target.x = m.x;
    target.y = m.y;
  } else {
    remoteTargets.set(m.id, { x: m.x, y: m.y });
  }
  const avatar = remotePlayers.get(m.id);
  if (avatar) {
    avatar._bobActive = m.dir === 'move';
  }
};

net.onPlayerLeave = (id) => {
  const avatar = remotePlayers.get(id);
  if (avatar) {
    chat.postEvent('geral', `👋 ${avatar.name} saiu do escritório`);
  }
  remotePlayers.delete(id);
  remoteTargets.delete(id);
  remotePrev.delete(id);
  chat.unregisterRemotePlayer(id);
  rtc.closePeer(id);
};

net.onChat = (msg) => {
  if (msg.channel === 'local') {
    const isMe = msg.from === net.youId;
    if (isMe && player) {
      player.say(msg.text, 5000);
    } else {
      const remote = remotePlayers.get(msg.from);
      if (remote) remote.say(msg.text, 5000);
    }
  }
  chat.receiveNetMsg(msg, net.youId);
};

// ── Tela de entrada ───────────────────────────────────────────────────────────

/**
 * Sanitiza string de entrada.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return (s || '').trim().replace(/[<>"']/g, '').slice(0, 32);
}

const VALID_ROLES = ['Gestor', 'Líder', 'Dev', 'Testador', 'Analista'];
const VALID_SKINS = ['golden', 'chocolate', 'grey', 'black', 'cream'];

/** Lê a skin salva no localStorage (fallback: 'golden'). */
function getSavedSkin() {
  try {
    const s = localStorage.getItem('enterprise_skin');
    return VALID_SKINS.includes(s) ? s : 'golden';
  } catch { return 'golden'; }
}

/** Salva a skin escolhida no localStorage. */
function saveSkin(skin) {
  try { localStorage.setItem('enterprise_skin', skin); } catch {}
}

/** Skin selecionada na tela de entrada */
let selectedSkin = getSavedSkin();

/**
 * Inicia o escritório com nome, papel e skin definidos.
 * @param {string} name
 * @param {string} role
 * @param {string} skin
 */
function startOffice(name, role, skin) {
  saveSkin(skin);
  player = new Player(name, role, skin);

  // Atualiza header
  const userNameEl   = document.querySelector('.user-name');
  const userRoleEl   = document.querySelector('.user-role');
  const userAvatarEl = document.querySelector('.user-avatar');
  if (userNameEl) userNameEl.textContent = name;
  if (userRoleEl) {
    userRoleEl.textContent = role;
    const roleColors = {
      'Gestor':   'rgba(168,85,247,0.15)',
      'Líder':    'rgba(124,58,237,0.15)',
      'Dev':      'rgba(59,130,246,0.15)',
      'Testador': 'rgba(249,115,22,0.15)',
      'Analista': 'rgba(34,197,94,0.15)',
    };
    const roleTextColors = {
      'Gestor':   '#a855f7',
      'Líder':    '#7c3aed',
      'Dev':      '#3b82f6',
      'Testador': '#f97316',
      'Analista': '#22c55e',
    };
    userRoleEl.style.background = roleColors[role] || 'rgba(99,102,241,0.15)';
    userRoleEl.style.color = roleTextColors[role] || '#6366f1';
  }
  if (userAvatarEl) {
    userAvatarEl.textContent = name.charAt(0).toUpperCase();
    const ROLE_COLORS_MAP = {
      'Gestor':   '#a855f7',
      'Líder':    '#7c3aed',
      'Dev':      '#3b82f6',
      'Testador': '#f97316',
      'Analista': '#22c55e',
    };
    userAvatarEl.style.background = ROLE_COLORS_MAP[role] || '#6366f1';
  }

  net.connect();
  net.join(name, role, skin);

  meeting.registerEntities(player);

  if (!loopStarted) {
    loopStarted = true;
    requestAnimationFrame(loop);
  }
}

function hideEntryScreen() {
  const screen = document.getElementById('entry-screen');
  if (!screen) return;
  screen.classList.add('hidden');
  setTimeout(() => { screen.style.display = 'none'; }, 300);
}

// ── Inicializa seletor de skin na tela de entrada ─────────────────────────────

function initSkinSelector() {
  const container = document.getElementById('skin-selector');
  if (!container) return;

  const skins = [
    { id: 'golden',    label: 'Golden' },
    { id: 'chocolate', label: 'Chocolate' },
    { id: 'grey',      label: 'Cinza' },
    { id: 'black',     label: 'Escuro' },
    { id: 'cream',     label: 'Creme' },
  ];

  for (const sk of skins) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skin-btn' + (sk.id === selectedSkin ? ' selected' : '');
    btn.dataset.skin = sk.id;
    btn.title = sk.label;

    // Miniatura: imagem do spritesheet (frame 0, direção down)
    const img = document.createElement('img');
    img.src = `assets/chars/variants/${sk.id}.png`;
    // Mostra apenas o primeiro frame (32×32 do spritesheet 512×64)
    img.style.cssText = `
      width: 32px; height: 32px;
      object-fit: none;
      object-position: 0 0;
      image-rendering: pixelated;
    `;
    img.alt = sk.label;

    const lbl = document.createElement('span');
    lbl.textContent = sk.label;

    btn.appendChild(img);
    btn.appendChild(lbl);

    btn.addEventListener('click', () => {
      selectedSkin = sk.id;
      // Atualiza estado visual de todos os botões
      container.querySelectorAll('.skin-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.skin === selectedSkin);
      });
    });

    container.appendChild(btn);
  }
}

// ── Auto-join via query string ────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const qName  = sanitize(params.get('name') || '');
const qRole  = sanitize(params.get('role') || '');
const qSkin  = VALID_SKINS.includes(params.get('skin')) ? params.get('skin') : null;

if (qName && VALID_ROLES.includes(qRole)) {
  hideEntryScreen();
  startOffice(qName, qRole, qSkin || getSavedSkin());
} else {
  initSkinSelector();

  const entryBtn  = document.getElementById('entry-btn');
  const entryName = document.getElementById('entry-name');
  const entryRole = document.getElementById('entry-role');

  function doJoin() {
    const name = sanitize(entryName.value);
    const role = entryRole.value;
    if (!name) {
      entryName.focus();
      entryName.style.borderColor = 'var(--accent-danger)';
      setTimeout(() => { entryName.style.borderColor = ''; }, 1500);
      return;
    }
    hideEntryScreen();
    startOffice(name, role, selectedSkin);
  }

  entryBtn.addEventListener('click', doJoin);
  entryName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  entryName.focus();

  // Roda o loop (renderiza mapa vazio enquanto aguarda)
  if (!loopStarted) {
    loopStarted = true;
    requestAnimationFrame(loop);
  }
}
