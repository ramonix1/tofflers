/**
 * player.js — Controle do avatar do jogador local.
 *
 * Controles alinhados à TELA isométrica:
 *   W/↑  → tela cima    → mundo (-1, -1)
 *   S/↓  → tela baixo   → mundo (+1, +1)
 *   A/←  → tela esquerda → mundo (-1, +1)
 *   D/→  → tela direita  → mundo (+1, -1)
 *
 * Derivação: worldToScreen usa sx = OX + (col-row)*(TW/2), sy = OY + (col+row)*(TH/2)
 * Logo, mover na tela para cima (↓sy) com col→-1/row→-1 dá Δsy = -(TH/2)-(TH/2) < 0. ✓
 *
 * Velocidades:
 *   Normal  → SPEED     (120 px/s, importado de iso.js)
 *   Corrida → SPEED_RUN (210 px/s, importado de iso.js)
 *   Corrida: Shift segurado OU CapsLock ativo
 *
 * Facing: mapeado para direção DE TELA (não de mundo):
 *   tela ↑ → up    (sprite costas)
 *   tela ↓ → down  (sprite frente)
 *   tela ← → left
 *   tela → → right
 */

import { Avatar } from './avatar.js';
import { collidesWithMap } from './office.js';
import { SPEED, SPEED_RUN } from './iso.js';

const AVATAR_RADIUS = 10;

export class Player extends Avatar {
  /**
   * @param {string} [name='Você']   — nome do jogador
   * @param {string} [role='Gestor'] — papel do jogador
   * @param {string} [skin='golden'] — pelagem escolhida
   */
  constructor(name = 'Você', role = 'Gestor', skin = 'golden') {
    super({
      id: 'player',
      name,
      role,
      skin,
      x: 4 * 32 + 16, // posição inicial: entrada da recepção
      y: 3 * 32 + 16,
      isPlayer: true,
    });

    // Estado das teclas pressionadas (lógica de tela, não de mundo)
    this._keys = {
      up:    false,
      down:  false,
      left:  false,
      right: false,
      shift: false,
    };

    // CapsLock: detectado nos eventos de teclado via getModifierState
    this._capsLock = false;

    this._bindKeys();
  }

  _bindKeys() {
    const onKey = (e) => {
      // Ignora quando o usuário está digitando (chat/formulários): senão WASD
      // move o boneco e o espaço some enquanto se escreve.
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      const k   = e.key;
      const down = e.type === 'keydown';

      // Direções de tela
      if (k === 'ArrowUp'    || k === 'w' || k === 'W') this._keys.up    = down;
      if (k === 'ArrowDown'  || k === 's' || k === 'S') this._keys.down  = down;
      if (k === 'ArrowLeft'  || k === 'a' || k === 'A') this._keys.left  = down;
      if (k === 'ArrowRight' || k === 'd' || k === 'D') this._keys.right = down;

      // Shift (corrida)
      if (k === 'Shift') this._keys.shift = down;

      // CapsLock: atualiza estado a cada evento de tecla via getModifierState
      // (getModifierState reflete o estado APÓS o evento no keydown do próprio CapsLock)
      try {
        this._capsLock = e.getModifierState('CapsLock');
      } catch { /* ignorar — browser antigo */ }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup',   onKey);
  }

  /**
   * API de input externo para D-pad virtual (e qualquer outro controle).
   * Escreve nas mesmas flags que o teclado — os dois coexistem sem conflito.
   *
   * @param {'up'|'down'|'left'|'right'} dir — direção de TELA
   * @param {boolean} pressed — true = pressionado, false = solto
   */
  setDir(dir, pressed) {
    if (dir in this._keys) {
      this._keys[dir] = pressed;
    }
  }

  /**
   * Aciona/desaciona corrida via controle externo (equivale a Shift segurado).
   * @param {boolean} pressed
   */
  setRun(pressed) {
    this._keys.shift = pressed;
  }

  /**
   * Atualiza posição do jogador.
   * @param {number} dt — delta time em ms
   */
  update(dt) {
    super.update(dt);

    const dtS = dt / 1000;

    // ── Vetores de tela → vetor de mundo ─────────────────────────────────────
    // Cada tecla contribui com seu vetor de mundo:
    //   tela ↑ → mundo (-1, -1)
    //   tela ↓ → mundo (+1, +1)
    //   tela ← → mundo (-1, +1)
    //   tela → → mundo (+1, -1)
    let wx = 0;
    let wy = 0;

    if (this._keys.up)    { wx -= 1; wy -= 1; }
    if (this._keys.down)  { wx += 1; wy += 1; }
    if (this._keys.left)  { wx -= 1; wy += 1; }
    if (this._keys.right) { wx += 1; wy -= 1; }

    const moving = wx !== 0 || wy !== 0;
    this._bobActive = moving;

    if (!moving) return;

    // ── Corrida ───────────────────────────────────────────────────────────────
    const running = this._keys.shift || this._capsLock;
    const speed   = running ? SPEED_RUN : SPEED;

    // Ajusta velocidade de animação ao correr
    this._walkSpeed = running ? 0.6 : 1.0; // fator de tempo por frame (< 1 = mais rápido)

    // ── Facing de tela (não de mundo) ────────────────────────────────────────
    // A tecla de tela mapeada → direção do sprite
    //   ↑ tela → up  |  ↓ tela → down  |  ← tela → left  |  → tela → right
    // Prioridade: vertical > horizontal (como o facing legado, mas em tela)
    if (this._keys.up && !this._keys.down) {
      this._facing = 'up';
    } else if (this._keys.down && !this._keys.up) {
      this._facing = 'down';
    } else if (this._keys.left && !this._keys.right) {
      this._facing = 'left';
    } else if (this._keys.right && !this._keys.left) {
      this._facing = 'right';
    }
    // Diagonais: mantém o facing da tecla dominante
    if (this._keys.up && this._keys.right && !this._keys.left) this._facing = 'up';
    if (this._keys.up && this._keys.left && !this._keys.right) this._facing = 'up';
    if (this._keys.down && this._keys.right && !this._keys.left) this._facing = 'down';
    if (this._keys.down && this._keys.left && !this._keys.right) this._facing = 'down';

    // ── Normaliza diagonal ────────────────────────────────────────────────────
    const len = Math.sqrt(wx * wx + wy * wy);
    if (len > 0) { wx /= len; wy /= len; }

    const moveX = wx * speed * dtS;
    const moveY = wy * speed * dtS;

    // ── Colisão separada em X e Y para deslizamento nas paredes ──────────────
    const nx = this.x + moveX;
    if (!collidesWithMap(nx, this.y, AVATAR_RADIUS)) {
      this.x = nx;
    }

    const ny = this.y + moveY;
    if (!collidesWithMap(this.x, ny, AVATAR_RADIUS)) {
      this.y = ny;
    }
  }
}
