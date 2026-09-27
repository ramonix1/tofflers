/**
 * avatar.js — Classe base Avatar.
 * Representa qualquer entidade visível no mapa (jogador ou NPC).
 *
 * Visual: sprite isométrico do cão (Paws & Whiskers, 512×64, 16×2 frames 32×32).
 * Mapeamento de frames (baseado em inspeção visual do spritesheet):
 *
 *   Estrutura do spritesheet: 8 grupos de 2 colunas × 2 linhas = 8 "blocos"
 *   Cada bloco tem 4 frames (2 colunas × 2 linhas) = 1 ciclo de walk de 4 frames.
 *   Ordem dos 8 blocos (col de início 0,2,4,6,8,10,12,14):
 *     bloco 0  (col 0-1,  row 0-1) → frente/south  (cão olhando pra câmera)
 *     bloco 1  (col 2-3,  row 0-1) → SW diagonal
 *     bloco 2  (col 4-5,  row 0-1) → west/left
 *     bloco 3  (col 6-7,  row 0-1) → NW diagonal / up-left
 *     bloco 4  (col 8-9,  row 0-1) → north/up (costas)
 *     bloco 5  (col 10-11,row 0-1) → NE diagonal
 *     bloco 6  (col 12-13,row 0-1) → east/right
 *     bloco 7  (col 14-15,row 0-1) → SE diagonal
 *
 *   Para 4 direções de movimento WASD mapeamos:
 *     down  → bloco 0 (frente, col start 0)
 *     left  → bloco 2 (west,   col start 4)
 *     up    → bloco 4 (costas, col start 8)
 *     right → bloco 6 (east,   col start 12)
 *
 *   Frames dentro de cada bloco (col offset + row):
 *     frame 0 → col+0, row 0
 *     frame 1 → col+1, row 0
 *     frame 2 → col+0, row 1
 *     frame 3 → col+1, row 1
 */

import { worldToScreen, AVATAR_SCALE } from './iso.js';

/**
 * @typedef {'Gestor'|'Líder'|'Dev'|'Testador'|'Analista'} Role
 */

/** Mapa de cor de badge por papel */
export const ROLE_COLORS = {
  Gestor:   '#a855f7',
  Líder:    '#7c3aed',
  Dev:      '#3b82f6',
  'Dev 2':  '#06b6d4',
  Testador: '#f97316',
  Analista: '#22c55e',
};

/** Ícone emoji por papel (exibido como badge) */
export const ROLE_ICONS = {
  Gestor:   '👑',
  Líder:    '⚡',
  Dev:      '💻',
  'Dev 2':  '💻',
  Testador: '🔬',
  Analista: '📊',
};

// ── Spritesheet ───────────────────────────────────────────────────────────────

/** Tamanho de cada frame no spritesheet (px) */
const FRAME_W = 32;
const FRAME_H = 32;

/** Número de frames na animação de walk por direção */
const WALK_FRAMES = 4;

/** Intervalo por frame de walk (ms) */
const FRAME_MS = 140;

/**
 * Mapa direção → coluna inicial no spritesheet.
 * Veja JSDoc acima para o raciocínio do mapeamento.
 */
const DIR_COL = {
  down:  0,
  right: 4,   // col 4: focinho aponta p/ direita (conferido no spritesheet)
  up:    8,
  left:  12,  // col 12: focinho aponta p/ esquerda
};

/** Cache de imagens de skin: Map<skinName, HTMLImageElement> */
const SKIN_CACHE = new Map();

/**
 * Retorna (carregando se necessário) a imagem do spritesheet para uma skin.
 * @param {string} skin — 'golden'|'chocolate'|'grey'|'black'|'cream'
 * @returns {HTMLImageElement}
 */
function getSkinImage(skin) {
  const name = skin || 'golden';
  if (SKIN_CACHE.has(name)) return SKIN_CACHE.get(name);
  const el = new Image();
  el.src = `assets/chars/variants/${name}.png`;
  SKIN_CACHE.set(name, el);
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────

export class Avatar {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {Role}   opts.role
   * @param {number} opts.x   — posição X em pixels de mundo (centro)
   * @param {number} opts.y   — posição Y em pixels de mundo (centro)
   * @param {boolean} [opts.isPlayer]
   * @param {string}  [opts.skin]  — 'golden'|'chocolate'|'grey'|'black'|'cream'
   */
  constructor({ id, name, role, x, y, isPlayer = false, skin = 'golden' }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.x = x;
    this.y = y;
    this.isPlayer = isPlayer;
    this.skin = skin;

    this.color = ROLE_COLORS[role] || '#94a3b8';
    this.icon  = ROLE_ICONS[role]  || '👤';

    // Balão de fala
    this.bubble      = null;  // string ou null
    this.bubbleTimer = 0;     // ms restantes

    // Animação de walk
    this._bobActive  = false;  // true quando em movimento
    this._frameTimer = 0;      // acumulador de tempo (ms)
    this._frameIdx   = 0;      // índice 0-3 do frame atual

    // Fator de velocidade de animação (< 1 = mais rápido; usado ao correr)
    this._walkSpeed  = 1.0;

    // Direção de facing: 'down'|'up'|'left'|'right'
    this._facing = 'down';
  }

  /**
   * Atualiza timers de balão e animação de walk.
   * @param {number} dt — delta em ms
   */
  update(dt) {
    // Timer do balão de fala
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubble      = null;
        this.bubbleTimer = 0;
      }
    }

    // Animação de walk (velocidade ajustável pelo _walkSpeed: < 1 = mais rápido)
    if (this._bobActive) {
      this._frameTimer += dt;
      const frameInterval = FRAME_MS * (this._walkSpeed ?? 1.0);
      if (this._frameTimer >= frameInterval) {
        this._frameTimer -= frameInterval;
        this._frameIdx = (this._frameIdx + 1) % WALK_FRAMES;
      }
    } else {
      this._frameIdx   = 0; // frame parado = primeiro frame da direção
      this._frameTimer = 0;
      this._walkSpeed  = 1.0; // reseta ao parar
    }
  }

  /**
   * Exibe um balão de fala por `durationMs` milissegundos.
   * @param {string} text
   * @param {number} [durationMs=4000]
   */
  say(text, durationMs = 4000) {
    this.bubble      = text;
    this.bubbleTimer = durationMs;
  }

  /**
   * Atualiza a direção de facing a partir de um vetor de movimento.
   * Chamado pelo Player.update() e pela interpolação de remotos.
   * @param {number} dx
   * @param {number} dy
   */
  setFacingFromVector(dx, dy) {
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) >= Math.abs(dy)) {
      this._facing = dx > 0 ? 'right' : 'left';
    } else {
      this._facing = dy > 0 ? 'down' : 'up';
    }
  }

  /**
   * Retorna a chave de profundidade para o painter's algorithm.
   * Usa as coordenadas de mundo para calcular col+row.
   * @returns {number}
   */
  get depthKey() {
    return (this.x + this.y) / 32; // equivale a col + row
  }

  /**
   * Desenha o avatar isométrico no canvas.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    // Converte posição de mundo para tela
    const { sx, sy } = worldToScreen(this.x, this.y);

    // ── Sprite do cão ─────────────────────────────────────────────────────────
    const skinImg = getSkinImage(this.skin);
    if (skinImg.complete && skinImg.naturalWidth > 0) {
      // Calcula qual frame do spritesheet usar
      const dirCol = DIR_COL[this._facing] ?? 0;
      // 4 frames no bloco (2 colunas × 2 linhas):
      //   frame 0 → (dirCol+0, row 0)
      //   frame 1 → (dirCol+1, row 0)
      //   frame 2 → (dirCol+0, row 1)
      //   frame 3 → (dirCol+1, row 1)
      const fi = this._frameIdx;
      const srcCol = dirCol + (fi % 2);
      const srcRow = Math.floor(fi / 2);
      const srcX = srcCol * FRAME_W;
      const srcY = srcRow * FRAME_H;

      const dw = FRAME_W * AVATAR_SCALE;
      const dh = FRAME_H * AVATAR_SCALE;

      // Sombra elíptica sob o cão
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx, sy + 2, dw * 0.35, dh * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Sprite (centralizado horizontalmente, base do sprite alinhada com sy)
      ctx.drawImage(
        skinImg,
        srcX, srcY, FRAME_W, FRAME_H,
        sx - dw / 2,
        sy - dh,       // base do sprite no ponto de tela
        dw, dh
      );

      // Destaque do jogador local (borda branca semi-transparente)
      if (this.isPlayer) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx - dw / 2 - 1, sy - dh - 1, dw + 2, dh + 2);
      }
    } else {
      // Fallback: círculo colorido enquanto a imagem carrega
      ctx.beginPath();
      ctx.arc(sx, sy - 16, 12, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }

    // ── Badge de nome + papel ─────────────────────────────────────────────────
    const dh = FRAME_H * AVATAR_SCALE;
    const labelY = sy - dh - 6;
    const nameText = this.name;

    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const tw = ctx.measureText(nameText).width;
    const padX = 5;
    const badgeW = tw + padX * 2;
    const badgeH = 13;

    ctx.fillStyle = 'rgba(10,12,20,0.82)';
    ctx.beginPath();
    ctx.roundRect(sx - badgeW / 2, labelY - badgeH, badgeW, badgeH, 3);
    ctx.fill();

    ctx.strokeStyle = this.color + '88';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(nameText, sx, labelY);

    // ── Balão de fala ─────────────────────────────────────────────────────────
    if (this.bubble) {
      this._renderBubble(ctx, sx, sy - dh - 20);
    }
  }

  /** Desenha o balão de fala acima do avatar. */
  _renderBubble(ctx, cx, topY) {
    const text = this.bubble;
    const maxW = 140;
    const padX = 8;
    const padY = 5;
    const lineH = 13;

    ctx.font = '10px "Segoe UI", system-ui, sans-serif';

    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW - padX * 2) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);

    const lineCount = lines.length;
    const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2);
    const bh = lineCount * lineH + padY * 2;

    const bx = cx - bw / 2;
    const by = topY - bh;

    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Cauda
    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.moveTo(cx - 5, by + bh);
    ctx.lineTo(cx + 5, by + bh);
    ctx.lineTo(cx, by + bh + 6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + padX, by + padY + i * lineH);
    }
  }
}
