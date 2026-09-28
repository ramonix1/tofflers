/**
 * editor.js — Modo de edição do ambiente (somente para o host).
 *
 * Gating fail-closed: o editor fica totalmente oculto/inerte se isHost não for
 * explicitamente true no welcome. Mesmo com o código carregado no browser de um
 * convidado, nenhum elemento de UI aparece e nenhum layout_set é enviado.
 *
 * Picking tela→célula:
 *   O render aplica, nesta ordem:
 *     1. ctx.scale(dpr, dpr)                         — DPR
 *     2. ctx.translate(vw/2, vh/2)                   — centro da viewport
 *     3. ctx.scale(zoom, zoom)                        — zoom
 *     4. ctx.translate(-camX, -camY)                 — câmera seguindo player
 *   Inverso (clique CSS → mundo):
 *     cx = (clientX / dpr - vw/2) / zoom + camX       (coord de tela iso)
 *     cy = (clientY / dpr - vh/2) / zoom + camY
 *   Projeção isométrica inversa (sx,sy → col,row):
 *     col = ((cx - ORIGIN_X) / (TW/2) + (cy - ORIGIN_Y) / (TH/2)) / 2
 *     row = ((cy - ORIGIN_Y) / (TH/2) - (cx - ORIGIN_X) / (TW/2)) / 2
 *   Em modo 'full' (mapa inteiro):
 *     scale = Math.min(vw/CANVAS_W, vh/CANVAS_H, 1)
 *     offX  = (vw - CANVAS_W*scale)/2
 *     offY  = (vh - CANVAS_H*scale)/2
 *     sx = (clientX/dpr - offX) / scale
 *     sy = (clientY/dpr - offY) / scale
 *     (depois aplica inverso iso como acima)
 */

import { TILE, COLS, ROWS } from './office.js';
import { getLayout, applyLayout } from './layout.js';
import { CANVAS_W, CANVAS_H, ORIGIN_X, ORIGIN_Y, TW, TH } from './iso.js';
import { renderDebugOverlay } from './office-iso.js';

// ── Paleta de peças disponíveis ───────────────────────────────────────────────

/**
 * Cada peça define como ela modifica a célula:
 *   floor   — sprite de piso (string|null)
 *   object  — sprite de objeto (string|null) → null = limpa objeto
 *   solid   — se a célula passa a ser sólida
 *   erase   — modo apagar: volta a piso básico livre
 *
 * @typedef {{id:string, label:string, icon:string, floor:string|null, object:string|null, solid:boolean, erase?:boolean}} Peca
 */

/** @type {Array<{cat:string, pecas:Peca[]}>} */
const PALETTE = [
  {
    cat: 'Piso',
    pecas: [
      { id: 'floor',        label: 'Piso',          icon: '🟫', floor: 'floor',        object: null, solid: false },
      { id: 'floor-detail', label: 'Detalhe',       icon: '🟧', floor: 'floor-detail', object: null, solid: false },
      { id: 'floor-panel',  label: 'Painel',        icon: '🟨', floor: 'floor-panel',  object: null, solid: false },
      { id: 'floor-corner', label: 'Canto',         icon: '🟦', floor: 'floor-corner', object: null, solid: false },
      { id: 'balcony-floor',label: 'Varanda',       icon: '🟩', floor: 'balcony-floor',object: null, solid: false },
    ],
  },
  {
    cat: 'Parede / Porta / Janela',
    pecas: [
      { id: 'wall',         label: 'Parede',        icon: '🧱', floor: 'floor', object: 'wall',        solid: true  },
      { id: 'wall-door',    label: 'Porta',         icon: '🚪', floor: 'floor', object: 'wall-door',   solid: false },
      { id: 'wall-window',  label: 'Janela',        icon: '🪟', floor: 'floor', object: 'wall-window', solid: true  },
    ],
  },
  {
    cat: 'Móveis / Objetos',
    pecas: [
      { id: 'table',     label: 'Mesa',       icon: '🗄', floor: 'floor', object: 'table',     solid: true  },
      { id: 'chair',     label: 'Cadeira',    icon: '🪑', floor: 'floor', object: 'chair',     solid: false },
      { id: 'computer',  label: 'Computador', icon: '💻', floor: 'floor', object: 'computer',  solid: true  },
      { id: 'bed-single',label: 'Cama',       icon: '🛏', floor: 'floor', object: 'bed-single',solid: true  },
      { id: 'container', label: 'Contêiner',  icon: '📦', floor: 'floor', object: 'container', solid: true  },
      { id: 'structure', label: 'Planta',     icon: '🌿', floor: 'floor', object: 'structure', solid: true  },
    ],
  },
  {
    cat: 'Ferramentas',
    pecas: [
      { id: 'erase', label: 'Apagar', icon: '🗑', floor: 'floor', object: null, solid: false, erase: true },
    ],
  },
];

// ── Estado interno do editor ──────────────────────────────────────────────────

/** O editor está ativo? (modo edição ligado) */
let _ativo = false;

/** Peça selecionada na paleta */
let _pecaSelecionada = PALETTE[0].pecas[0];

/** Callback para solicitar o estado da câmera ao main.js */
let _getCameraState = null;

/** Referência ao Net para enviar layout_set */
let _net = null;

/** Célula sendo destacada (hover) */
let _hoverCell = { col: -1, row: -1 };

/** Arrastar: pintar ao mover o mouse com botão pressionado */
let _dragging = false;

/** Estado de salvamento */
let _unsaved = false;

/** Timer de auto-save (debounce 1.5s) */
let _saveTimer = null;

/** Elemento do painel lateral do editor */
let _panelEl = null;

/**
 * Botão de edição no header (legado — não é mais criado; mantido para
 * compatibilidade com o bloco _toggleEditor, que verifica if (_btnEl)).
 */
let _btnEl = null;

/** Indicador de "não salvo" */
let _unsavedIndicatorEl = null;

/**
 * Callback chamado quando o estado ativo/inativo muda.
 * Assinado pelo menu de opções em main.js para atualizar o item de menu.
 * @type {((ativo: boolean) => void)|null}
 */
let _onToggleCb = null;

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Inicializa o editor. Chamado do main.js após receber welcome com isHost=true.
 *
 * @param {{net: object, getCameraState: function}} opts
 *   getCameraState() → { cameraMode, camX, camY, zoom, dpr, logicalW, logicalH }
 */
export function initEditor({ net, getCameraState }) {
  _net = net;
  _getCameraState = getCameraState;
  _criarUI();
}

/**
 * Retorna true se o modo edição está ativo.
 * Consultado pelo main.js para saber se deve ligar o overlay de debug e
 * delegar eventos de clique/mouse ao editor.
 * @returns {boolean}
 */
export function isEditorAtivo() {
  return _ativo;
}

/**
 * Alterna o modo de edição do ambiente (liga/desliga).
 * Chamado pelo menu de opções em main.js em vez do botão de header interno.
 * Fail-closed: só funciona se o editor tiver sido inicializado via initEditor()
 * com isHost=true. Se não inicializado, não faz nada.
 */
export function toggleEditorModo() {
  if (!_net) return; // não foi inicializado = não é host
  _toggleEditor();
}

/**
 * Registra callback para ser notificado quando o estado ativo/inativo muda.
 * Usado pelo menu de opções em main.js para manter o item de menu sincronizado.
 * @param {(ativo: boolean) => void} cb
 */
export function onEditorToggle(cb) {
  _onToggleCb = cb;
}

/**
 * Renderiza o overlay do editor: grade de diagnóstico + destaque da célula hover +
 * indicador da peça selecionada na célula hover.
 * Deve ser chamado pelo game loop do main.js em vez de renderDebugOverlay
 * quando o editor estiver ativo.
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderEditorOverlay(ctx) {
  // Grade + células sólidas (reaproveita o debug overlay existente)
  renderDebugOverlay(ctx);

  // Destaque da célula hover
  if (_hoverCell.col >= 0 && _hoverCell.row >= 0) {
    _desenharDestaque(ctx, _hoverCell.col, _hoverCell.row);
  }
}

/**
 * Processa evento de ponteiro (mousedown/mousemove/mouseup/mouseleave) do canvas.
 * Chamado pelo main.js quando o editor está ativo.
 * @param {'down'|'move'|'up'|'leave'} tipo
 * @param {MouseEvent} e
 */
export function handlePointerEvent(tipo, e) {
  if (!_ativo) return;

  const cell = _screenToCell(e.clientX, e.clientY);

  if (tipo === 'down' && e.button === 0) {
    _dragging = true;
    if (cell) _aplicarPeca(cell.col, cell.row);
  } else if (tipo === 'move') {
    _hoverCell = cell ? { col: cell.col, row: cell.row } : { col: -1, row: -1 };
    if (_dragging && cell) _aplicarPeca(cell.col, cell.row);
  } else if (tipo === 'up' || tipo === 'leave') {
    _dragging = false;
  }
}

// ── Criação da UI ─────────────────────────────────────────────────────────────

function _criarUI() {
  // Nota: o botão de header foi movido para o menu de opções em main.js.
  // O editor apenas cria o painel de paleta flutuante.
  _criarPainel();
}

/**
 * Cria o botão "🛠 Editar ambiente" no header, antes do botão de câmera.
 */
function _criarBotaoHeader() {
  const header = document.getElementById('header');
  if (!header || document.getElementById('editor-toggle-btn')) return;

  _btnEl = document.createElement('button');
  _btnEl.id = 'editor-toggle-btn';
  _btnEl.className = 'header-sprint-btn';
  _btnEl.title = 'Entrar/sair do modo de edição do ambiente';
  _btnEl.textContent = '🛠 Editar ambiente';

  _btnEl.addEventListener('click', () => _toggleEditor());

  // Insere antes do botão de câmera (ou de sprint como fallback)
  const camBtn = document.getElementById('camera-toggle-btn');
  const sprintBtn = document.getElementById('sprint-toggle-btn');
  const ref = camBtn || sprintBtn;
  if (ref) {
    header.insertBefore(_btnEl, ref);
  } else {
    header.appendChild(_btnEl);
  }
}

/**
 * Cria o painel lateral flutuante de paleta (oculto por padrão).
 */
function _criarPainel() {
  if (document.getElementById('editor-panel')) return;

  _panelEl = document.createElement('div');
  _panelEl.id = 'editor-panel';
  _panelEl.className = 'editor-panel editor-panel--hidden';

  // Cabeçalho do painel
  const header = document.createElement('div');
  header.className = 'editor-panel__header';
  header.innerHTML = '<span class="editor-panel__title">🛠 Editar ambiente</span>';

  // Indicador não salvo
  _unsavedIndicatorEl = document.createElement('span');
  _unsavedIndicatorEl.className = 'editor-unsaved-dot editor-unsaved-dot--hidden';
  _unsavedIndicatorEl.title = 'Alterações não salvas';
  _unsavedIndicatorEl.textContent = '● não salvo';
  header.appendChild(_unsavedIndicatorEl);

  // Botão salvar
  const btnSalvar = document.createElement('button');
  btnSalvar.className = 'editor-btn editor-btn--primary';
  btnSalvar.textContent = '💾 Salvar';
  btnSalvar.addEventListener('click', () => _salvar());
  header.appendChild(btnSalvar);

  // Sair do modo edição direto pelo painel (sem precisar reabrir o menu de opções)
  const btnSair = document.createElement('button');
  btnSair.className = 'editor-btn';
  btnSair.textContent = '✕ Sair';
  btnSair.title = 'Sair do modo edição';
  btnSair.addEventListener('click', () => { if (_ativo) _toggleEditor(); });
  header.appendChild(btnSair);

  _panelEl.appendChild(header);

  // Categorias de paleta
  for (const { cat, pecas } of PALETTE) {
    const secao = document.createElement('div');
    secao.className = 'editor-palette-section';

    const titulo = document.createElement('div');
    titulo.className = 'editor-palette-cat';
    titulo.textContent = cat;
    secao.appendChild(titulo);

    const grid = document.createElement('div');
    grid.className = 'editor-palette-grid';

    for (const peca of pecas) {
      const btn = document.createElement('button');
      btn.className = 'editor-palette-btn' + (peca.id === _pecaSelecionada.id ? ' editor-palette-btn--sel' : '');
      btn.dataset.pecaId = peca.id;
      btn.title = peca.label;

      // Miniatura via img (tenta carregar o sprite da peça)
      const imgEl = document.createElement('img');
      imgEl.src = `assets/iso/${peca.id === 'erase' ? 'floor' : peca.object || peca.floor}.png`;
      imgEl.width = 24;
      imgEl.height = 24;
      imgEl.style.cssText = 'object-fit:contain;image-rendering:pixelated;';
      imgEl.alt = peca.label;

      // Fallback: mostra ícone emoji se imagem falhar
      imgEl.onerror = () => { imgEl.style.display = 'none'; };

      const icon = document.createElement('span');
      icon.className = 'editor-palette-icon';
      icon.textContent = peca.icon;

      const lbl = document.createElement('span');
      lbl.className = 'editor-palette-lbl';
      lbl.textContent = peca.label;

      btn.appendChild(imgEl);
      btn.appendChild(icon);
      btn.appendChild(lbl);

      btn.addEventListener('click', () => {
        _pecaSelecionada = peca;
        // Atualiza seleção visual
        _panelEl.querySelectorAll('.editor-palette-btn').forEach(b => {
          b.classList.toggle('editor-palette-btn--sel', b.dataset.pecaId === peca.id);
        });
      });

      grid.appendChild(btn);
    }

    secao.appendChild(grid);
    _panelEl.appendChild(secao);
  }

  // Dica de uso
  const dica = document.createElement('p');
  dica.className = 'editor-dica';
  dica.textContent = 'Clique ou arraste no mapa para pintar. Salvar envia para todos.';
  _panelEl.appendChild(dica);

  // Insere no canvas-wrapper para ficar posicionado sobre o mapa
  const wrapper = document.getElementById('canvas-wrapper');
  if (wrapper) {
    wrapper.appendChild(_panelEl);
  } else {
    document.body.appendChild(_panelEl);
  }
}

// ── Toggle do editor ──────────────────────────────────────────────────────────

function _toggleEditor() {
  _ativo = !_ativo;
  // _btnEl sempre null desde que _criarBotaoHeader foi desabilitado; o guard
  // abaixo não faz nada mas preserva a intenção original caso seja reativado.
  if (_btnEl) {
    _btnEl.classList.toggle('active', _ativo);
    _btnEl.textContent = _ativo ? '✕ Sair da edição' : '🛠 Editar ambiente';
  }
  if (_panelEl) {
    _panelEl.classList.toggle('editor-panel--hidden', !_ativo);
  }
  if (!_ativo) {
    _hoverCell = { col: -1, row: -1 };
    _dragging = false;
  }
  // Notifica o menu de opções para atualizar o item de "Editar ambiente"
  if (_onToggleCb) _onToggleCb(_ativo);
}

// ── Picking: tela CSS → célula (col, row) ─────────────────────────────────────

/**
 * Converte um ponto de clique CSS (clientX, clientY) na célula (col, row) do mapa.
 * Inverte a transformação completa: DPR → câmera → zoom → projeção iso.
 *
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{col:number, row:number}|null} null se fora do mapa
 */
function _screenToCell(clientX, clientY) {
  if (!_getCameraState) return null;
  const { cameraMode, camX, camY, zoom, dpr, logicalW, logicalH } = _getCameraState();

  // Ponto relativo ao canvas-wrapper (elemento pai do canvas)
  const wrapper = document.getElementById('canvas-wrapper');
  const rect = wrapper ? wrapper.getBoundingClientRect() : { left: 0, top: 0 };
  const cx = clientX - rect.left; // coord CSS dentro do wrapper
  const cy = clientY - rect.top;

  let sx, sy; // coordenadas no espaço isométrico (antes de ORIGIN_X/Y)

  if (cameraMode === 'follow') {
    // Inverso de: translate(vw/2, vh/2) → scale(zoom) → translate(-camX, -camY)
    // Ponto CSS → lógico (DPR já aplicado pelo CSS, não precisa dividir por dpr aqui
    // pois clientX/clientY são CSS pixels e a transform ctx usa coords lógicas)
    sx = (cx - logicalW / 2) / zoom + camX;
    sy = (cy - logicalH / 2) / zoom + camY;
  } else {
    // Modo 'full': scale = min(vw/CANVAS_W, vh/CANVAS_H, 1)
    const scale = Math.min(logicalW / CANVAS_W, logicalH / CANVAS_H, 1);
    const offX = (logicalW  - CANVAS_W * scale) / 2;
    const offY = (logicalH - CANVAS_H * scale) / 2;
    sx = (cx - offX) / scale;
    sy = (cy - offY) / scale;
  }

  // Projeção iso inversa: (sx, sy) → (col, row)
  // sx = ORIGIN_X + (col - row) * (TW/2)   →  (sx - ORIGIN_X) / (TW/2) = col - row
  // sy = ORIGIN_Y + (col + row) * (TH/2)   →  (sy - ORIGIN_Y) / (TH/2) = col + row
  const u = (sx - ORIGIN_X) / (TW / 2); // col - row
  const v = (sy - ORIGIN_Y) / (TH / 2); // col + row
  const col = Math.floor((u + v) / 2);
  const row = Math.floor((v - u) / 2);

  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return { col, row };
}

// ── Aplicação de peças ────────────────────────────────────────────────────────

/**
 * Aplica a peça selecionada na célula (col, row).
 * Modifica o layout em memória e agenda auto-save.
 * @param {number} col
 * @param {number} row
 */
function _aplicarPeca(col, row) {
  const layout = getLayout();
  if (!layout) return;

  const peca = _pecaSelecionada;
  const cell = layout.cells[row][col];

  if (peca.erase) {
    // Apagar: volta a piso básico livre
    cell.floor  = 'floor';
    cell.object = null;
    cell.solid  = false;
  } else {
    if (peca.floor  !== undefined) cell.floor  = peca.floor;
    if (peca.object !== undefined) cell.object = peca.object;
    cell.solid = peca.solid;
  }

  _marcarNaoSalvo();
}

// ── Destaque de hover ─────────────────────────────────────────────────────────

/**
 * Desenha o losango de destaque sobre a célula (col, row) no canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} col
 * @param {number} row
 */
function _desenharDestaque(ctx, col, row) {
  const sx = ORIGIN_X + (col - row) * (TW / 2);
  const sy = ORIGIN_Y + (col + row) * (TH / 2);

  const lx = sx - TW / 2, cx = sx, rx = sx + TW / 2;
  const ty = sy, my = sy + TH / 2, by = sy + TH;

  ctx.save();

  // Preenchimento amarelo translúcido
  ctx.beginPath();
  ctx.moveTo(cx, ty);
  ctx.lineTo(rx, my);
  ctx.lineTo(cx, by);
  ctx.lineTo(lx, my);
  ctx.closePath();

  // Cor baseada na peça selecionada
  const cor = _pecaSelecionada.erase ? 'rgba(239,68,68,0.35)' : 'rgba(99,255,99,0.30)';
  ctx.fillStyle = cor;
  ctx.fill();

  // Borda
  ctx.strokeStyle = _pecaSelecionada.erase ? 'rgba(239,68,68,0.85)' : 'rgba(99,255,99,0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ícone da peça no centro do losango
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(_pecaSelecionada.icon, cx, my);

  ctx.restore();
}

// ── Salvar ────────────────────────────────────────────────────────────────────

/**
 * Marca o layout como não salvo e agenda auto-save com debounce.
 */
function _marcarNaoSalvo() {
  _unsaved = true;
  if (_unsavedIndicatorEl) {
    _unsavedIndicatorEl.classList.remove('editor-unsaved-dot--hidden');
  }
  // Auto-save com debounce de 1.5s
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => _salvar(), 1500);
}

/**
 * Envia o layout atual ao servidor e marca como salvo.
 */
function _salvar() {
  clearTimeout(_saveTimer);
  const layout = getLayout();
  if (!layout || !_net) return;
  _net.sendLayoutSet(layout);
  _unsaved = false;
  if (_unsavedIndicatorEl) {
    _unsavedIndicatorEl.classList.add('editor-unsaved-dot--hidden');
  }
}
