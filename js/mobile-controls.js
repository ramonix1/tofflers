/**
 * mobile-controls.js — D-pad virtual + drawers mobile.
 *
 * D-pad:
 *   Usa Pointer Events (pointerdown/pointerup/pointercancel/pointerleave) com
 *   preventDefault e touch-action: none para multi-toque (diagonais) sem scroll.
 *
 *   Cada botão direcional chama player.setDir(dir, pressed) quando disponível.
 *   A referência ao player é obtida via getter (playerGetter) para lidar com o
 *   fato de que player só existe após o join.
 *
 * Visibilidade do D-pad:
 *   Mostrado quando: dispositivo touch (pointer: coarse) OU tela ≤ 820px.
 *   Oculto em desktop com mouse (pointer: fine e tela > 820px).
 *
 * Drawers mobile:
 *   Em telas ≤ 820px, os painéis laterais viram overlays/drawers.
 *   Botões no header (📋 / 💬) abrem cada drawer.
 *   Botões X nos painéis e toque no backdrop fecham.
 */

// ── Detecção de touch/tela estreita ──────────────────────────────────────────

const MOBILE_BP = 820; // breakpoint em px

/** Retorna true se o dispositivo usa toque (pointer: coarse) */
function isCoarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return 'ontouchstart' in window;
  }
}

/** Retorna true se a tela é estreita (≤ MOBILE_BP) */
function isNarrowScreen() {
  return window.innerWidth <= MOBILE_BP;
}

/** Retorna true se deve mostrar o D-pad */
function shouldShowDpad() {
  return isCoarsePointer() || isNarrowScreen();
}

// ── D-pad ─────────────────────────────────────────────────────────────────────

const dpad   = document.getElementById('dpad');
const runBtn = document.getElementById('run-btn');

/**
 * Referência ao player local — preenchida externamente.
 * Usa uma closure/getter para acessar o player após o join.
 * @type {{ get: () => import('./player.js').Player|null }}
 */
const playerRef = { get: () => null };

/**
 * Registra o getter do player local para que o D-pad tenha acesso.
 * Chamado de main.js após o join.
 * @param {() => import('./player.js').Player|null} getter
 */
export function registerPlayerGetter(getter) {
  playerRef.get = getter;
}

/**
 * Atualiza visibilidade do D-pad e classe mobile no body.
 * Chamado na inicialização e no resize.
 */
function updateDpadVisibility() {
  const show = shouldShowDpad();
  if (dpad)   dpad.setAttribute('aria-hidden', String(!show));
  if (runBtn) runBtn.setAttribute('aria-hidden', String(!show));
  // Classe no body para facilitar ajustes CSS adicionais
  document.body.classList.toggle('is-touch', show);
}

// ── Pointer Events nos botões direcionais ─────────────────────────────────────

if (dpad) {
  const dpadBtns = dpad.querySelectorAll('.dpad-btn[data-dir]');

  for (const btn of dpadBtns) {
    const dir = btn.dataset.dir;

    /** Pressiona direção */
    const press = (e) => {
      e.preventDefault();
      const p = playerRef.get();
      if (p) p.setDir(dir, true);
    };

    /** Solta direção */
    const release = (e) => {
      e.preventDefault();
      const p = playerRef.get();
      if (p) p.setDir(dir, false);
    };

    btn.addEventListener('pointerdown',   press,   { passive: false });
    btn.addEventListener('pointerup',     release, { passive: false });
    btn.addEventListener('pointercancel', release, { passive: false });
    btn.addEventListener('pointerleave',  release, { passive: false });

    // Garante que o botão capture o ponteiro (multi-toque)
    btn.addEventListener('pointerdown', (e) => {
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignorar */ }
    });
  }
}

// ── Botão Correr ──────────────────────────────────────────────────────────────

if (runBtn) {
  const pressRun = (e) => {
    e.preventDefault();
    const p = playerRef.get();
    if (p) p.setRun(true);
  };
  const releaseRun = (e) => {
    e.preventDefault();
    const p = playerRef.get();
    if (p) p.setRun(false);
  };

  runBtn.addEventListener('pointerdown',   pressRun,   { passive: false });
  runBtn.addEventListener('pointerup',     releaseRun, { passive: false });
  runBtn.addEventListener('pointercancel', releaseRun, { passive: false });
  runBtn.addEventListener('pointerleave',  releaseRun, { passive: false });

  runBtn.addEventListener('pointerdown', (e) => {
    try { runBtn.setPointerCapture(e.pointerId); } catch { /* ignorar */ }
  });
}

// ── Drawers mobile ────────────────────────────────────────────────────────────

const demandasPanel    = document.getElementById('demandas-panel');
const chatPanel        = document.getElementById('chat-panel-wrap');
const drawerBackdrop   = document.getElementById('drawer-backdrop');
const demandasDrawerBtn = document.getElementById('demandas-drawer-btn');
const chatDrawerBtn     = document.getElementById('chat-drawer-btn');
const demandasCloseBtn  = document.getElementById('demandas-close-btn');
const chatCloseBtn      = document.getElementById('chat-close-btn');

/**
 * Fecha todos os drawers.
 */
function closeAllDrawers() {
  demandasPanel && demandasPanel.classList.remove('drawer-open');
  chatPanel     && chatPanel.classList.remove('drawer-open');
  drawerBackdrop && drawerBackdrop.classList.remove('visible');
}

/**
 * Abre um drawer pelo elemento.
 * @param {HTMLElement} panel
 */
function openDrawer(panel) {
  closeAllDrawers();
  panel.classList.add('drawer-open');
  drawerBackdrop && drawerBackdrop.classList.add('visible');
}

// Botões no header
demandasDrawerBtn && demandasDrawerBtn.addEventListener('click', () => {
  if (demandasPanel.classList.contains('drawer-open')) {
    closeAllDrawers();
  } else {
    openDrawer(demandasPanel);
  }
});

chatDrawerBtn && chatDrawerBtn.addEventListener('click', () => {
  if (chatPanel.classList.contains('drawer-open')) {
    closeAllDrawers();
  } else {
    openDrawer(chatPanel);
  }
});

// Botões X dentro dos painéis
demandasCloseBtn && demandasCloseBtn.addEventListener('click', closeAllDrawers);
chatCloseBtn     && chatCloseBtn.addEventListener('click', closeAllDrawers);

// Toque no backdrop fecha o drawer
drawerBackdrop && drawerBackdrop.addEventListener('click', closeAllDrawers);

// ── Inicialização e resize ────────────────────────────────────────────────────

updateDpadVisibility();
window.addEventListener('resize', updateDpadVisibility);

// Garante que ao soltar todos os botões ao perder foco da janela
// o avatar não fique "andando sozinho"
window.addEventListener('blur', () => {
  const p = playerRef.get();
  if (!p) return;
  p.setDir('up',    false);
  p.setDir('down',  false);
  p.setDir('left',  false);
  p.setDir('right', false);
  p.setRun(false);
});
