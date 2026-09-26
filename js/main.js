/**
 * main.js — Bootstrap + game loop principal (requestAnimationFrame).
 *
 * Ordem de inicialização:
 *   1. Canvas dimensionado ao mapa
 *   2. Tela de entrada (ou auto-join por query string)
 *   3. Após entrar: conecta WebSocket, instancia Player, Chat, etc.
 *   4. Inicia game loop
 */

import { MAP_W, MAP_H, renderOffice, getZoneAt } from './office.js';
import { Player }         from './player.js';
import { Avatar, ROLE_COLORS, ROLE_ICONS } from './avatar.js';
import { Chat }           from './chat.js';
import { MeetingManager } from './meetings.js';
import { DemandasPanel }  from './demandas.js';
import { SprintManager }  from './sprint.js';
import { Net }            from './net.js';
import { RtcManager }     from './rtc.js';
import { AUDIO_RADIUS, distance, gainForDistance } from './spatial.js';

// ── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('office-canvas'));
const ctx    = canvas.getContext('2d');

canvas.width  = MAP_W; // 800
canvas.height = MAP_H; // 576

// ── Net (instanciado antes de qualquer coisa) ─────────────────────────────────

const net = new Net();

// ── Instâncias (criadas antes do join pois o DOM já está pronto) ──────────────

const chat     = new Chat(net);
const demandas = new DemandasPanel(chat);
const sprint   = new SprintManager(chat, demandas);
const meeting  = new MeetingManager(chat, sprint);

// Injeta net nas instâncias que precisam sincronizar via servidor
demandas.setNet(net);
sprint.setNet(net);

// ── Estado dos jogadores remotos ─────────────────────────────────────────────

/** @type {Map<string, Avatar>} */
const remotePlayers = new Map();

/**
 * Cria um Avatar para um jogador remoto.
 * @param {{id:string, name:string, role:string, x:number, y:number}} p
 * @returns {Avatar}
 */
function makeRemoteAvatar(p) {
  return new Avatar({
    id:       p.id,
    name:     p.name,
    role:     p.role || 'Dev',
    x:        p.x   || MAP_W / 2,
    y:        p.y   || MAP_H / 2,
    isPlayer: false,
  });
}

// ── Jogador local (criado com placeholder; nome/papel atualizados no join) ────

let player = null; // criado após o join para ter nome/papel corretos

// ── Áudio/vídeo/tela por proximidade (WebRTC) ─────────────────────────────────

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

// ── Relógio ──────────────────────────────────────────────────────────────────

const clockEl = document.getElementById('clock');
function updateClock() {
  clockEl.textContent = new Date().toLocaleTimeString('pt-BR');
}
updateClock();
setInterval(updateClock, 1000);

// ── Raio de proximidade ──────────────────────────────────────────────────────

// Raio visual da bolha = mesmo raio do áudio/chat Local (js/spatial.js).
const PROXIMITY_RADIUS = AUDIO_RADIUS;

// ── Render ───────────────────────────────────────────────────────────────────

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  renderOffice(ctx);

  if (player) {
    // Círculo de proximidade ao redor do jogador (alcance do canal Local)
    ctx.beginPath();
    ctx.arc(player.x, player.y, PROXIMITY_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(99,102,241,0.08)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Jogadores remotos
  for (const remote of remotePlayers.values()) {
    remote.render(ctx);
  }

  // Jogador local (por cima)
  if (player) {
    player.render(ctx);
  }
}

// ── Interpolação de remotos ──────────────────────────────────────────────────

/** Destinos de interpolação: Map(id → {tx, ty}) */
const remoteTargets = new Map();

function interpolateRemotes(dt) {
  const LERP = 1 - Math.pow(1 - 0.2, dt / 16); // ~0.2 a 60fps
  for (const [id, avatar] of remotePlayers) {
    const target = remoteTargets.get(id);
    if (!target) continue;
    avatar.x += (target.x - avatar.x) * LERP;
    avatar.y += (target.y - avatar.y) * LERP;
    const dist = Math.hypot(target.x - avatar.x, target.y - avatar.y);
    avatar._bobActive = dist > 1;
  }
}

// ── Game loop ────────────────────────────────────────────────────────────────

let lastTime = 0;
let loopStarted = false;

function loop(timestamp) {
  const dt = lastTime === 0 ? 16 : Math.min(timestamp - lastTime, 100);
  lastTime = timestamp;

  if (player) {
    player.update(dt);

    // Envia move se mudou
    const dir = player._bobActive ? 'move' : 'idle';
    net.sendMove(player.x, player.y, dir);
  }

  interpolateRemotes(dt);

  // Audibilidade por proximidade/sala → volume espacial + conexões WebRTC.
  // Mesma sala = volume cheio; senão, falloff gradual pela distância (bolha).
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
  // Posiciona o jogador LOCAL no spawn que o servidor atribuiu (espalhado),
  // senão todos os locais nascem no mesmo ponto padrão e ficam empilhados.
  const me = (data.players || []).find(p => p.id === net.youId);
  if (me && player) {
    player.x = me.x;
    player.y = me.y;
  }

  // Popula remotePlayers com jogadores já online (exceto eu)
  for (const p of (data.players || [])) {
    if (p.id === net.youId) continue;
    const avatar = makeRemoteAvatar(p);
    remotePlayers.set(p.id, avatar);
    remoteTargets.set(p.id, { x: p.x || MAP_W / 2, y: p.y || MAP_H / 2 });
    chat.registerRemotePlayer(p);
  }

  // Carrega histórico de chat
  const chatState = data.state && data.state.chat;
  if (chatState) {
    // Histórico geral
    for (const msg of (chatState.geral || [])) {
      chat.receiveHistoryMsg('geral', msg);
    }
    // DMs
    for (const [key, msgs] of Object.entries(chatState.dm || {})) {
      // key = 'idA|idB' — só renderiza se diz respeito a mim
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
  chat.unregisterRemotePlayer(id);
  rtc.closePeer(id);
};

net.onChat = (msg) => {
  // Balão de fala no canal Local — mostra acima do avatar do remetente
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
 * Sanitiza string de entrada: trim + strip tags básico.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return (s || '').trim().replace(/[<>"']/g, '').slice(0, 32);
}

/**
 * Papéis válidos aceitos pelo servidor.
 */
const VALID_ROLES = ['Gestor', 'Líder', 'Dev', 'Testador', 'Analista'];

/**
 * Inicia o escritório com nome e papel definidos.
 * @param {string} name
 * @param {string} role
 */
function startOffice(name, role) {
  // Cria o jogador local com nome/papel
  player = new Player(name, role);

  // Atualiza header
  const userNameEl = document.querySelector('.user-name');
  const userRoleEl = document.querySelector('.user-role');
  const userAvatarEl = document.querySelector('.user-avatar');
  if (userNameEl) userNameEl.textContent = name;
  if (userRoleEl) {
    userRoleEl.textContent = role;
    // Aplica cor do papel ao badge
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

  // Conecta WebSocket e entra
  net.connect();
  net.join(name, role);

  // Registra meeting com player (sem NPCs)
  meeting.registerEntities(player);

  // Inicia o game loop (apenas uma vez)
  if (!loopStarted) {
    loopStarted = true;
    requestAnimationFrame(loop);
  }
}

/**
 * Esconde a tela de entrada.
 */
function hideEntryScreen() {
  const screen = document.getElementById('entry-screen');
  if (!screen) return;
  screen.classList.add('hidden');
  setTimeout(() => { screen.style.display = 'none'; }, 300);
}

// ── Auto-join via query string ────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
const qName = sanitize(params.get('name') || '');
const qRole = sanitize(params.get('role') || '');

if (qName && VALID_ROLES.includes(qRole)) {
  // Pula o overlay
  hideEntryScreen();
  startOffice(qName, qRole);
} else {
  // Mostra o overlay e espera o usuário preencher
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
    startOffice(name, role);
  }

  entryBtn.addEventListener('click', doJoin);
  entryName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  // Foco automático no campo de nome
  entryName.focus();

  // Roda o loop mas sem player (renderiza o mapa vazio aguardando)
  if (!loopStarted) {
    loopStarted = true;
    requestAnimationFrame(loop);
  }
}
