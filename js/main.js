/**
 * main.js — Bootstrap + game loop principal (requestAnimationFrame).
 *
 * Ordem de inicialização:
 *   1. Canvas dimensionado ao mapa isométrico (CANVAS_W × CANVAS_H de iso.js)
 *   2. Tela de entrada com seletor de pelagem (ou auto-join por query string)
 *   3. Após entrar: conecta WebSocket, instancia Player, Chat, etc.
 *   4. Inicia game loop com render isométrico + painter's algorithm
 *
 * Novidades do Estágio 1:
 *   - Layout unificado derivado do servidor (layout.js)
 *   - Câmera com toggle: seguir jogador ↔ mapa inteiro
 *   - Overlay de diagnóstico (Tab ou botão)
 */

import { MAP_W, MAP_H, getZoneAt, injectLayoutModule } from './office.js';
import { CANVAS_W, CANVAS_H, worldToScreen, worldDepthKey } from './iso.js';
import { renderOfficeIso, renderDebugOverlay } from './office-iso.js';
import * as LayoutModule from './layout.js';
import { initEditor, isEditorAtivo, renderEditorOverlay, handlePointerEvent, toggleEditorModo, onEditorToggle } from './editor.js';
import { Player }                   from './player.js';
import { Avatar, ROLE_COLORS, ROLE_ICONS } from './avatar.js';
import { Chat }                     from './chat.js';
import { MeetingManager }           from './meetings.js';
import { DemandasPanel, showToast } from './demandas.js';
import { SprintManager }            from './sprint.js';
import { Net }                      from './net.js';
import { RtcManager }               from './rtc.js';
import { AUDIO_RADIUS, distance, gainForDistance } from './spatial.js';
import { registerPlayerGetter }     from './mobile-controls.js';

// Injeta o módulo de layout no office.js (collidesWithMap e getZoneAt passam a usar o modelo)
injectLayoutModule(LayoutModule);

// ── Canvas setup (viewport-driven) ───────────────────────────────────────────

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('office-canvas'));
const ctx    = canvas.getContext('2d');

/** Wrapper do canvas (div que contém o canvas) */
const canvasWrapper = document.getElementById('canvas-wrapper');

/**
 * Devicepixelratio atual. Capturado uma vez; reavaliado no resize via resizeCanvas.
 * @type {number}
 */
let _dpr = window.devicePixelRatio || 1;

/**
 * Dimensões lógicas do canvas (pontos CSS, sem DPR).
 * Atualizadas por resizeCanvas(); usadas pelo render para cálculos de câmera.
 */
let _logicalW = 0;
let _logicalH = 0;

/**
 * Redimensiona o bitmap do canvas para cobrir o wrapper visível,
 * respeitando o devicePixelRatio para nitidez em telas HiDPI.
 * Deve ser chamado no load e em todo resize/orientationchange.
 */
function resizeCanvas() {
  _dpr = window.devicePixelRatio || 1;
  const lw = canvasWrapper.clientWidth  || window.innerWidth;
  const lh = canvasWrapper.clientHeight || window.innerHeight;
  if (lw === _logicalW && lh === _logicalH) return; // sem mudança
  _logicalW = lw;
  _logicalH = lh;
  canvas.width  = Math.round(lw * _dpr);
  canvas.height = Math.round(lh * _dpr);
  // style é controlado pelo CSS (width:100%; height:100%)
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);
// Orientação e mudanças de teclado virtual no mobile
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

// ── Câmera ────────────────────────────────────────────────────────────────────

/**
 * Modos de câmera:
 *   'follow' — viewport centraliza no jogador; câmera se move via ctx.translate
 *   'full'   — mapa inteiro visível, escalonado para caber na viewport via ctx.scale
 *
 * ┌─ CONSTANTES DE AJUSTE DE CÂMERA ──────────────────────────────────────────┐
 * │  CAMERA_LERP  — suavização da câmera em modo follow (0=imediato, 1=fixo)  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const CAMERA_LERP = 0.1; // suavização da câmera (10% por frame ≈ movimento fluido)

/** Ponto focal da câmera (em coords de tela iso) — para onde ela olha, suavizado */
let camX = CANVAS_W / 2;
let camY = CANVAS_H / 2;

/**
 * Zoom por scroll do mouse / pinça.
 * ┌─ CONSTANTES DE AJUSTE DE ZOOM ────────────────────────────────────────────┐
 * │  ZOOM_MIN / ZOOM_MAX — limites do zoom (1 = tamanho natural).              │
 * │  ZOOM_STEP           — quanto cada "clique" do scroll altera o zoom.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
const ZOOM_STEP = 0.12;
let zoom = (() => {
  try { return parseFloat(localStorage.getItem('enterprise_zoom')) || 1; } catch { return 1; }
})();
zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));

/** Modo de câmera atual */
let cameraMode = (() => {
  try { return localStorage.getItem('enterprise_camera') || 'follow'; } catch { return 'follow'; }
})();

/** Overlay de diagnóstico ligado/desligado */
let debugOverlay = false;

/**
 * Indica se o cliente atual é o host (acesso direto via localhost).
 * Recebido no welcome do servidor. Fail-closed: false por padrão.
 * @type {boolean}
 */
let _isHost = false;

/**
 * Retorna o estado atual da câmera para o editor (picking tela→célula).
 * Exposto como função para que o editor não precise de variáveis globais de main.
 * @returns {{cameraMode:string, camX:number, camY:number, zoom:number, dpr:number, logicalW:number, logicalH:number}}
 */
function getCameraState() {
  return {
    cameraMode,
    camX,
    camY,
    zoom,
    dpr: _dpr,
    logicalW: _logicalW || canvasWrapper.clientWidth  || 800,
    logicalH: _logicalH || canvasWrapper.clientHeight || 600,
  };
}

/**
 * Aplica o modo de câmera.
 * Agora o redimensionamento é feito via bitmap (resizeCanvas); não há mais
 * manipulação de CSS transform no canvas. Esta função sincroniza os itens
 * de câmera dentro do menu de opções.
 */
function applyCameraMode() {
  // Garante que o canvas não tenha transform CSS residual de versão anterior
  canvas.style.transform = '';
  canvas.style.width  = '';
  canvas.style.height = '';
  // Sincroniza o item de câmera dentro do menu de opções
  const itemCam = document.getElementById('opts-cam-item');
  if (itemCam) {
    const isFollow = cameraMode === 'follow';
    itemCam.textContent = isFollow ? '🎥 Seguir jogador' : '🗺️ Mapa inteiro';
    itemCam.classList.toggle('active', isFollow);
    itemCam.setAttribute('aria-pressed', String(isFollow));
  }
}

applyCameraMode();
window.addEventListener('resize', applyCameraMode);

// ── Menu de Opções ────────────────────────────────────────────────────────────

/**
 * Inicializa o menu de opções unificado:
 *   - Botão "⚙️ Opções" já existe no HTML (id="options-btn")
 *   - Cria e injeta o painel dropdown com 3 seções:
 *       1. Mídia & permissões  (mic, câmera, tela)
 *       2. Preferências        (câmera follow/full, zoom +/−, grade/debug)
 *       3. Ambiente            (SÓ HOST — entra/sai do modo edição)
 *
 * O gating host-only é fail-closed: a seção "Ambiente" fica oculta até que
 * `revelarSecaoHost()` seja chamado explicitamente após receber isHost=true.
 */
function initOptionsMenu() {
  const optsBtn = document.getElementById('options-btn');
  if (!optsBtn) return;

  // ── Painel dropdown ──────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'options-panel';
  panel.className = 'options-panel options-panel--hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Opções');

  // ── Cabeçalho do painel ──────────────────────────────────────────────────
  const panelHeader = document.createElement('div');
  panelHeader.className = 'options-panel__header';
  panelHeader.innerHTML = '<span class="options-panel__title">⚙️ Opções</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'options-close-btn';
  closeBtn.title = 'Fechar';
  closeBtn.setAttribute('aria-label', 'Fechar opções');
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', fecharMenu);
  panelHeader.appendChild(closeBtn);
  panel.appendChild(panelHeader);

  // ────────────────────────────────────────────────────────────────────────
  // Seção 1: Mídia & permissões
  // ────────────────────────────────────────────────────────────────────────
  const secMidia = criarSecao('🎙️ Mídia & permissões');

  const itemMic = criarToggleItem('mic-toggle-btn', '🎤', 'Microfone', false);
  itemMic.addEventListener('click', () => rtc.toggleMic());
  secMidia.appendChild(itemMic);

  const itemCam = criarToggleItem('cam-toggle-btn', '📹', 'Câmera', false);
  itemCam.addEventListener('click', () => rtc.toggleCam());
  secMidia.appendChild(itemCam);

  const itemScreen = criarToggleItem('screen-toggle-btn', '🖥️', 'Compartilhar tela', false);
  itemScreen.addEventListener('click', () => rtc.toggleScreen());
  secMidia.appendChild(itemScreen);

  panel.appendChild(secMidia);

  // ────────────────────────────────────────────────────────────────────────
  // Seção 2: Preferências de visualização
  // ────────────────────────────────────────────────────────────────────────
  const secPref = criarSecao('🖼️ Visualização');

  // Câmera: toggle follow ↔ mapa inteiro
  const itemCamMode = document.createElement('button');
  itemCamMode.id = 'opts-cam-item';
  itemCamMode.className = 'options-item options-item--toggle';
  itemCamMode.setAttribute('aria-pressed', String(cameraMode === 'follow'));
  itemCamMode.textContent = cameraMode === 'follow' ? '🎥 Seguir jogador' : '🗺️ Mapa inteiro';
  itemCamMode.addEventListener('click', () => {
    cameraMode = cameraMode === 'follow' ? 'full' : 'follow';
    try { localStorage.setItem('enterprise_camera', cameraMode); } catch {}
    applyCameraMode();
  });
  secPref.appendChild(itemCamMode);

  // Zoom: botões + e −
  const zoomRow = document.createElement('div');
  zoomRow.className = 'options-zoom-row';
  const zoomLbl = document.createElement('span');
  zoomLbl.className = 'options-zoom-lbl';
  zoomLbl.textContent = 'Zoom';
  const zoomNote = document.createElement('span');
  zoomNote.className = 'options-zoom-note';
  zoomNote.textContent = 'scroll/pinça';
  const zoomBtns = document.createElement('div');
  zoomBtns.className = 'options-zoom-btns';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.className = 'options-zoom-btn';
  btnZoomIn.title = 'Aumentar zoom';
  btnZoomIn.textContent = '＋';
  btnZoomIn.addEventListener('click', () => {
    if (cameraMode !== 'follow') {
      cameraMode = 'follow';
      try { localStorage.setItem('enterprise_camera', 'follow'); } catch {}
      applyCameraMode();
    }
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + ZOOM_STEP));
    try { localStorage.setItem('enterprise_zoom', String(zoom)); } catch {}
  });

  const btnZoomOut = document.createElement('button');
  btnZoomOut.className = 'options-zoom-btn';
  btnZoomOut.title = 'Diminuir zoom';
  btnZoomOut.textContent = '−';
  btnZoomOut.addEventListener('click', () => {
    if (cameraMode !== 'follow') {
      cameraMode = 'follow';
      try { localStorage.setItem('enterprise_camera', 'follow'); } catch {}
      applyCameraMode();
    }
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom - ZOOM_STEP));
    try { localStorage.setItem('enterprise_zoom', String(zoom)); } catch {}
  });

  zoomBtns.appendChild(btnZoomOut);
  zoomBtns.appendChild(btnZoomIn);
  zoomRow.appendChild(zoomLbl);
  zoomRow.appendChild(zoomNote);
  zoomRow.appendChild(zoomBtns);
  secPref.appendChild(zoomRow);

  // Grade / diagnóstico
  const itemDebug = document.createElement('button');
  itemDebug.id = 'opts-debug-item';
  itemDebug.className = 'options-item options-item--toggle';
  itemDebug.setAttribute('aria-pressed', String(debugOverlay));
  itemDebug.textContent = debugOverlay ? '🔲 Grade: ligada' : '🔳 Grade / diagnóstico';
  itemDebug.addEventListener('click', () => {
    debugOverlay = !debugOverlay;
    itemDebug.textContent = debugOverlay ? '🔲 Grade: ligada' : '🔳 Grade / diagnóstico';
    itemDebug.setAttribute('aria-pressed', String(debugOverlay));
    itemDebug.classList.toggle('active', debugOverlay);
  });
  secPref.appendChild(itemDebug);

  panel.appendChild(secPref);

  // ────────────────────────────────────────────────────────────────────────
  // Seção 3: Ambiente (SÓ HOST — fail-closed: oculta por padrão)
  // ────────────────────────────────────────────────────────────────────────
  const secHost = document.createElement('div');
  secHost.id = 'opts-section-host';
  secHost.className = 'options-section';
  secHost.style.display = 'none'; // oculto até revelarSecaoHost()

  const hostSectionTitle = document.createElement('div');
  hostSectionTitle.className = 'options-section__title';
  hostSectionTitle.textContent = '🏗️ Ambiente';
  secHost.appendChild(hostSectionTitle);

  const itemEditor = document.createElement('button');
  itemEditor.id = 'opts-editor-item';
  itemEditor.className = 'options-item options-item--toggle';
  itemEditor.setAttribute('aria-pressed', 'false');
  itemEditor.textContent = '🛠 Editar ambiente';
  itemEditor.addEventListener('click', () => {
    toggleEditorModo();
    // Estado visual atualizado via onEditorToggle callback (abaixo)
  });
  secHost.appendChild(itemEditor);
  panel.appendChild(secHost);

  // ── Registra callback de toggle do editor ────────────────────────────────
  onEditorToggle((ativo) => {
    itemEditor.textContent = ativo ? '✕ Sair da edição' : '🛠 Editar ambiente';
    itemEditor.classList.toggle('active', ativo);
    itemEditor.setAttribute('aria-pressed', String(ativo));
  });

  // ── Insere painel no body (posição fixed) ────────────────────────────────
  document.body.appendChild(panel);

  // ── Abrir / fechar ───────────────────────────────────────────────────────
  function abrirMenu() {
    panel.classList.remove('options-panel--hidden');
    optsBtn.setAttribute('aria-expanded', 'true');
    optsBtn.classList.add('active');
    // Posiciona abaixo do botão
    const rect = optsBtn.getBoundingClientRect();
    panel.style.top  = (rect.bottom + 6) + 'px';
    panel.style.right = (window.innerWidth - rect.right) + 'px';
    panel.style.left = '';
  }

  function fecharMenu() {
    panel.classList.add('options-panel--hidden');
    optsBtn.setAttribute('aria-expanded', 'false');
    optsBtn.classList.remove('active');
  }

  optsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('options-panel--hidden')) {
      abrirMenu();
    } else {
      fecharMenu();
    }
  });

  // Fecha ao clicar fora
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== optsBtn) {
      fecharMenu();
    }
  });

  // Fecha com Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharMenu();
  });

  // ── API pública: revela seção host (chamada do onWelcome) ────────────────
  window._optsRevelarHost = () => {
    secHost.style.display = '';
  };
}

/**
 * Cria um container de seção com título.
 * @param {string} titulo
 * @returns {HTMLElement}
 */
function criarSecao(titulo) {
  const sec = document.createElement('div');
  sec.className = 'options-section';
  const t = document.createElement('div');
  t.className = 'options-section__title';
  t.textContent = titulo;
  sec.appendChild(t);
  return sec;
}

/**
 * Cria um item de toggle com id, ícone e rótulo.
 * @param {string} id
 * @param {string} icon
 * @param {string} label
 * @param {boolean} ativo
 * @returns {HTMLButtonElement}
 */
function criarToggleItem(id, icon, label, ativo) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.className = 'options-item options-item--toggle media-btn';
  btn.setAttribute('aria-pressed', String(ativo));
  btn.title = (ativo ? 'Desativar ' : 'Ativar ') + label.toLowerCase();
  btn.textContent = icon + ' ' + label;
  return btn;
}

// initOptionsMenu() é chamado após a criação do rtc (abaixo), pois os
// event handlers dos itens de mídia precisam de rtc.toggleMic/Cam/Screen.

// ── Zoom pelo scroll do mouse ─────────────────────────────────────────────────

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  // Zoom só tem efeito no modo 'follow' (transform via ctx). Se estiver em
  // 'full' (mapa inteiro), rolar o scroll leva de volta ao follow.
  if (cameraMode !== 'follow') {
    cameraMode = 'follow';
    try { localStorage.setItem('enterprise_camera', 'follow'); } catch {}
    applyCameraMode();
  }
  const dir = e.deltaY < 0 ? 1 : -1; // scroll p/ cima = aproxima
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + dir * ZOOM_STEP));
  try { localStorage.setItem('enterprise_zoom', String(zoom)); } catch {}
}, { passive: false });

// ── Pinch-to-zoom (dois toques no canvas) ────────────────────────────────────

/**
 * Distância inicial entre os dois dedos ao começar a pinça.
 * @type {number|null}
 */
let _pinchDist0 = null;
/**
 * Zoom capturado no início da pinça.
 * @type {number}
 */
let _pinchZoom0 = 1;

canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    const t = e.touches;
    _pinchDist0 = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
    _pinchZoom0 = zoom;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && _pinchDist0 !== null) {
    e.preventDefault();
    const t = e.touches;
    const dist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
    const ratio = dist / _pinchDist0;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, _pinchZoom0 * ratio));

    // Muda para follow se estiver em full
    if (cameraMode !== 'follow') {
      cameraMode = 'follow';
      try { localStorage.setItem('enterprise_camera', 'follow'); } catch {}
      applyCameraMode();
    }

    zoom = newZoom;
    try { localStorage.setItem('enterprise_zoom', String(zoom)); } catch {}
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) {
    _pinchDist0 = null;
  }
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  _pinchDist0 = null;
}, { passive: false });

// ── Eventos de ponteiro para o editor ────────────────────────────────────────
// Delegados ao editor apenas quando ele está ativo. Não interferem com o jogo.

canvas.addEventListener('mousedown', (e) => {
  if (isEditorAtivo()) {
    e.preventDefault();
    handlePointerEvent('down', e);
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (isEditorAtivo()) {
    handlePointerEvent('move', e);
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (isEditorAtivo()) {
    handlePointerEvent('up', e);
  }
});

canvas.addEventListener('mouseleave', (e) => {
  if (isEditorAtivo()) {
    handlePointerEvent('leave', e);
  }
});

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

// Registra getter do player para o D-pad virtual (mobile-controls.js)
registerPlayerGetter(() => player);

// ── WebRTC por proximidade ─────────────────────────────────────────────────────

// Referências lazy: os botões de mídia vivem dentro do painel de opções,
// que é criado por initOptionsMenu() após este bloco. Usamos getters para
// resolver os elementos no momento do uso (onStateChange).
const mediaButtons = {
  get mic()    { return document.getElementById('mic-toggle-btn');    },
  get cam()    { return document.getElementById('cam-toggle-btn');    },
  get screen() { return document.getElementById('screen-toggle-btn'); },
};

const rtc = new RtcManager({
  net,
  remotePlayers,
  videoStrip: document.getElementById('video-strip'),
  selfLabel: () => (player ? player.name : 'Você'),
  onStateChange: (kind, active, denied, reason) => {
    const btn = mediaButtons[kind];
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
    const titles = { mic: 'microfone', cam: 'câmera', screen: 'tela' };
    btn.title = (active ? 'Desativar ' : 'Ativar ') + titles[kind];
    if (denied) {
      // Marca por instantes mas NÃO trava: o usuário pode clicar de novo para
      // liberar. Mensagem específica pelo tipo de erro do getUserMedia.
      btn.classList.add('denied');
      const nome = titles[kind];
      let msg;
      switch (reason) {
        case 'NotAllowedError':
        case 'SecurityError':
          msg = `${nome}: acesso bloqueado pelo navegador. Não dá pra re-perguntar daqui — libere no ícone de cadeado/câmera da barra de endereço (ou chrome://settings/content/camera) e recarregue.`;
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          msg = `${nome}: nenhum dispositivo encontrado neste computador.`;
          break;
        case 'NotReadableError':
        case 'TrackStartError':
          msg = `${nome}: em uso por outro app (feche Zoom/Meet/OBS etc.) e tente de novo.`;
          break;
        case 'OverconstrainedError':
          msg = `${nome}: a configuração pedida não é suportada.`;
          break;
        default:
          msg = `${nome} indisponível${reason ? ` (${reason})` : ''}. Toque de novo para tentar.`;
      }
      showToast(msg);
      setTimeout(() => btn.classList.remove('denied'), 4000);
    } else {
      btn.classList.remove('denied');
    }
  },
});

// Os listeners de clique dos botões de mídia são registrados dentro de
// initOptionsMenu() (chamado logo abaixo), que também cria os elementos.
// Não duplicar aqui — os botões existem só no painel de opções.

// Inicializa o menu de opções (precisa de `rtc` já criado acima)
initOptionsMenu();

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
  // Dimensões lógicas do canvas (sem DPR) — usadas para câmera e interface
  const vw = _logicalW || canvasWrapper.clientWidth  || 800;
  const vh = _logicalH || canvasWrapper.clientHeight || 600;
  const dpr = _dpr;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Fundo escuro
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();

  // Aplica escala DPR: todas as coordenadas abaixo usam pontos CSS lógicos
  ctx.scale(dpr, dpr);

  // ── Câmera ──────────────────────────────────────────────────────────────────
  if (cameraMode === 'follow' && player) {
    // Ponto focal: posição do jogador em tela iso
    const { sx: targetX, sy: targetY } = worldToScreen(player.x, player.y);

    // Suaviza o ponto focal (segue o jogador com lerp)
    camX += (targetX - camX) * CAMERA_LERP;
    camY += (targetY - camY) * CAMERA_LERP;

    // Transform: centro da viewport lógica → escala do zoom → desloca para o foco.
    // Usa vw/vh (lógico), que já reflete o tamanho real do canvas no celular.
    ctx.translate(vw / 2, vh / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);
  } else if (cameraMode === 'full') {
    // Mapa inteiro: escala para caber na viewport lógica, centralizado
    const scale = Math.min(vw / CANVAS_W, vh / CANVAS_H, 1);
    const offX = (vw  - CANVAS_W * scale) / 2;
    const offY = (vh - CANVAS_H * scale) / 2;
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
  }
  // Em modo 'follow' sem player: sem translate (mapa estático centralizado)

  // Piso + zonas coloridas iso + objetos do cenário em painter's order
  renderOfficeIso(ctx);

  // Overlay de diagnóstico (Tab) ou overlay do editor (modo edição)
  if (isEditorAtivo()) {
    renderEditorOverlay(ctx);
  } else if (debugOverlay) {
    renderDebugOverlay(ctx);
  }

  // ── Avatares intercalados com objetos (painter's algorithm) ──────────────
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
    const { sx: cx, sy: cy } = worldToScreen(player.x, player.y);
    const screenRadius = PROXIMITY_RADIUS * 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, screenRadius, screenRadius * 0.5, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(99,102,241,0.10)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
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
  // Não sequestrar o teclado quando o usuário está digitando (chat, formulários).
  // Senão o espaço/setas são bloqueados e WASD move o boneco enquanto se digita.
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
    e.preventDefault();
  }

  // Tab: toggle do overlay de diagnóstico
  if (e.key === 'Tab') {
    e.preventDefault();
    debugOverlay = !debugOverlay;
    // Sincroniza o item de grade dentro do menu de opções
    const dbgItem = document.getElementById('opts-debug-item');
    if (dbgItem) {
      dbgItem.textContent = debugOverlay ? '🔲 Grade: ligada' : '🔳 Grade / diagnóstico';
      dbgItem.setAttribute('aria-pressed', String(debugOverlay));
      dbgItem.classList.toggle('active', debugOverlay);
    }
  }
});

// ── Callbacks Net ─────────────────────────────────────────────────────────────

net.onWelcome = (data) => {
  // Aplica layout recebido do servidor
  if (data.layout) {
    LayoutModule.applyLayout(data.layout);
  }

  // Gating host: só inicializa o editor se o servidor confirmar isHost=true
  if (data.isHost === true && !_isHost) {
    _isHost = true;
    initEditor({ net, getCameraState });
    // Revela a seção "Ambiente" no menu de opções (fail-closed: oculta por padrão)
    if (typeof window._optsRevelarHost === 'function') window._optsRevelarHost();
  }

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

// ── Handler de layout recebido do servidor (broadcast após edição) ────────────

net.onLayout = (layout) => {
  LayoutModule.applyLayout(layout);
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
    const imgEl = document.createElement('img');
    imgEl.src = `assets/chars/variants/${sk.id}.png`;
    // Mostra apenas o primeiro frame (32×32 do spritesheet 512×64)
    imgEl.style.cssText = `
      width: 32px; height: 32px;
      object-fit: none;
      object-position: 0 0;
      image-rendering: pixelated;
    `;
    imgEl.alt = sk.label;

    const lbl = document.createElement('span');
    lbl.textContent = sk.label;

    btn.appendChild(imgEl);
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
