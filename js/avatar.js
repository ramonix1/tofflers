/**
 * avatar.js — Classe base Avatar.
 * Representa qualquer entidade visível no mapa (jogador ou NPC).
 */

/**
 * @typedef {'Gestor'|'Líder'|'Dev'|'Testador'|'Analista'} Role
 */

/** Mapa de cor de corpo por papel */
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

export class Avatar {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {Role}   opts.role
   * @param {number} opts.x   — posição X em pixels (centro)
   * @param {number} opts.y   — posição Y em pixels (centro)
   * @param {boolean} [opts.isPlayer]
   */
  constructor({ id, name, role, x, y, isPlayer = false }) {
    this.id = id;
    this.name = name;
    this.role = role;
    this.x = x;
    this.y = y;
    this.isPlayer = isPlayer;

    this.color = ROLE_COLORS[role] || '#94a3b8';
    this.icon  = ROLE_ICONS[role]  || '👤';

    // Balão de fala
    this.bubble      = null;  // string ou null
    this.bubbleTimer = 0;     // ms restantes

    // Animação de "bounce" ao andar
    this._bobPhase  = Math.random() * Math.PI * 2;
    this._bobActive = false;
  }

  /** Atualiza o timer do balão de fala. */
  update(dt) {
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt;
      if (this.bubbleTimer <= 0) {
        this.bubble      = null;
        this.bubbleTimer = 0;
      }
    }
    if (this._bobActive) {
      this._bobPhase += dt * 0.008;
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
   * Desenha o avatar e, opcionalmente, o balão de fala.
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    const x = Math.round(this.x);
    const y = Math.round(this.y);

    // Bob vertical suave
    const bobY = this._bobActive
      ? Math.sin(this._bobPhase) * 2
      : 0;

    const cx = x;
    const cy = y + bobY;

    // ── Sombra ──
    ctx.beginPath();
    ctx.ellipse(cx, cy + 14, 9, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // ── Corpo (círculo + borda) ──
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();

    // Brilho interno
    ctx.beginPath();
    ctx.arc(cx - 3, cy - 4, 5, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(cx - 3, cy - 4, 0, cx - 3, cy - 4, 5);
    grad.addColorStop(0, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Borda (destaque se for jogador)
    ctx.beginPath();
    ctx.arc(cx, cy, 13, 0, Math.PI * 2);
    ctx.strokeStyle = this.isPlayer
      ? 'rgba(255,255,255,0.7)'
      : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = this.isPlayer ? 2 : 1;
    ctx.stroke();

    // ── Ícone do papel ──
    ctx.font = '10px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.icon, cx, cy);

    // ── Badge do nome + papel (abaixo) ──
    const labelY = cy + 20;
    const nameText = this.name;

    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const tw = ctx.measureText(nameText).width;
    const padX = 5;
    const badgeW = tw + padX * 2;
    const badgeH = 13;

    // Fundo do badge
    ctx.fillStyle = 'rgba(10,12,20,0.82)';
    ctx.beginPath();
    ctx.roundRect(cx - badgeW / 2, labelY, badgeW, badgeH, 3);
    ctx.fill();

    // Borda colorida
    ctx.strokeStyle = this.color + '88';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Texto
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(nameText, cx, labelY + 2);

    // ── Balão de fala (se ativo) ──
    if (this.bubble) {
      this._renderBubble(ctx, cx, cy);
    }
  }

  /** Desenha o balão de fala acima do avatar. */
  _renderBubble(ctx, cx, cy) {
    const text = this.bubble;
    const maxW = 140;
    const padX = 8;
    const padY = 5;
    const lineH = 13;

    ctx.font = '10px "Segoe UI", system-ui, sans-serif';

    // Quebra de linha simples
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
    const by = cy - 13 - bh - 8; // acima do círculo

    // Fundo branco do balão
    ctx.fillStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();

    // Bordinha colorida
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Cauda do balão
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

    // Texto escuro
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + padX, by + padY + i * lineH);
    }
  }
}
