/**
 * player.js — Controle do avatar do jogador local.
 * WASD + teclas de seta, colisão com o mapa, movimento suave.
 */

import { Avatar } from './avatar.js';
import { collidesWithMap } from './office.js';

const SPEED = 120; // pixels por segundo
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

    // Estado das teclas pressionadas
    this._keys = {
      up:    false,
      down:  false,
      left:  false,
      right: false,
    };

    this._bindKeys();
  }

  _bindKeys() {
    const map = (e) => {
      const k = e.key;
      const down = e.type === 'keydown';
      if (k === 'ArrowUp'    || k === 'w' || k === 'W') this._keys.up    = down;
      if (k === 'ArrowDown'  || k === 's' || k === 'S') this._keys.down  = down;
      if (k === 'ArrowLeft'  || k === 'a' || k === 'A') this._keys.left  = down;
      if (k === 'ArrowRight' || k === 'd' || k === 'D') this._keys.right = down;
    };
    window.addEventListener('keydown', map);
    window.addEventListener('keyup',   map);
  }

  /**
   * Atualiza posição do jogador.
   * @param {number} dt — delta time em ms
   */
  update(dt) {
    super.update(dt);

    const dtS = dt / 1000;
    let dx = 0;
    let dy = 0;

    if (this._keys.up)    dy -= 1;
    if (this._keys.down)  dy += 1;
    if (this._keys.left)  dx -= 1;
    if (this._keys.right) dx += 1;

    const moving = dx !== 0 || dy !== 0;
    this._bobActive = moving;

    if (!moving) return;

    // Atualiza direção de facing a partir do vetor de movimento
    this.setFacingFromVector(dx, dy);

    // Normaliza diagonal
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.SQRT2;
      dx *= inv;
      dy *= inv;
    }

    const moveX = dx * SPEED * dtS;
    const moveY = dy * SPEED * dtS;

    // Colisão separada em X e Y para deslizamento nas paredes
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
