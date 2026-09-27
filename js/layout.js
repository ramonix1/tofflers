/**
 * layout.js — Modelo unificado do escritório (fonte única da verdade).
 *
 * Cada célula do grid 25×18 (COLS×ROWS, tile de 32px de mundo) é:
 *   { floor: <spriteName|null>, solid: <bool>, object: <spriteName|null>, orient: <0-3 opcional> }
 *
 * Tipos especiais de objeto:
 *   'wall'        → parede sólida (auto-orientada pelo render)
 *   'wall-door'   → parede com porta (não sólida, flag doorway)
 *   'table'       → mesa (sólida)
 *   'chair'       → cadeira (passável)
 *   'structure'   → planta decorativa (sólida)
 *   'container'   → sofá/balcão (sólido)
 *
 * Zonas: retângulos nomeados em pixels de mundo, compatíveis com o formato
 * legado de office.js — mesma estrutura usada por getZoneAt e pelo servidor.
 *
 * Persistência: data/layout.json
 * Seed inicial: derivado do MAP/ZONES históricos de office.js.
 */

import { TILE, COLS, ROWS } from './office.js';

// ── Modelo vivo (atualizado por applyLayout) ──────────────────────────────────

/** @type {{ cells: Array<Array<{floor:string|null, solid:boolean, object:string|null, orient?:number}>>, zones: Record<string, {label:string, x:number, y:number, w:number, h:number, color:string}> }} */
let _layout = null;

/** Retorna o layout atual (pode ser null antes de ser carregado). */
export function getLayout() { return _layout; }

/**
 * Aplica (ou re-aplica) um layout recebido do servidor.
 * Valida estrutura mínima antes de aceitar.
 * @param {object} layout
 * @returns {boolean} true se aceito
 */
export function applyLayout(layout) {
  if (!layout || !Array.isArray(layout.cells) || !layout.zones) return false;
  if (layout.cells.length !== ROWS) return false;
  for (const row of layout.cells) {
    if (!Array.isArray(row) || row.length !== COLS) return false;
  }
  _layout = layout;
  return true;
}

// ── Consultas derivadas do modelo ─────────────────────────────────────────────

/**
 * Retorna a célula em (col, row), ou null se fora dos limites.
 * @param {number} col
 * @param {number} row
 * @returns {{floor:string|null, solid:boolean, object:string|null, orient?:number}|null}
 */
export function getCell(col, row) {
  if (!_layout) return null;
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return null;
  return _layout.cells[row][col];
}

/**
 * Checa colisão de uma entidade (px, py) com raio r contra o modelo de layout.
 * Substitui collidesWithMap de office.js derivando de cell.solid.
 * Mantém a mesma assinatura para compatibilidade com player.js.
 *
 * @param {number} px — posição X do centro em pixels de mundo
 * @param {number} py — posição Y do centro em pixels de mundo
 * @param {number} [r=10] — raio de colisão
 * @returns {boolean}
 */
export function collidesWithLayout(px, py, r = 10) {
  if (!_layout) return false;
  const points = [
    [px - r, py - r],
    [px + r, py - r],
    [px - r, py + r],
    [px + r, py + r],
  ];
  for (const [x, y] of points) {
    const col = Math.floor(x / TILE);
    const row = Math.floor(y / TILE);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return true;
    const cell = _layout.cells[row][col];
    if (cell && cell.solid) return true;
  }
  return false;
}

/**
 * Retorna a zona em que o ponto (px, py) se encontra, ou null.
 * Mesma assinatura de getZoneAt em office.js.
 *
 * @param {number} px
 * @param {number} py
 * @returns {{key:string, label:string, x:number, y:number, w:number, h:number, color:string}|null}
 */
export function getZoneFromLayout(px, py) {
  if (!_layout) return null;
  for (const [key, z] of Object.entries(_layout.zones)) {
    if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) {
      return { key, ...z };
    }
  }
  return null;
}

// ── Geração do seed inicial a partir do MAP legado ────────────────────────────

/**
 * Tipos de tile legado → descrição de célula.
 * Garante que o visual de partida seja idêntico ao anterior.
 */
function tileToCell(tileType) {
  // W=1, _=0, M=2, C=3, K=4, R=5, E=6, P=7, S=8
  switch (tileType) {
    case 0: return { floor: 'floor',        solid: false, object: null };
    case 1: return { floor: 'floor',        solid: true,  object: 'wall' };
    case 2: return { floor: 'floor',        solid: true,  object: 'table' };
    case 3: return { floor: 'floor',        solid: false, object: 'chair' };
    case 4: return { floor: 'floor-detail', solid: false, object: null };
    case 5: return { floor: 'floor-panel',  solid: false, object: null };
    case 6: return { floor: 'floor-corner', solid: false, object: null };
    case 7: return { floor: 'floor',        solid: true,  object: 'structure' };
    case 8: return { floor: 'floor',        solid: true,  object: 'container' };
    default: return { floor: 'floor',       solid: false, object: null };
  }
}

/**
 * Gera o layout seed a partir do MAP e ZONES de office.js.
 * Chamado apenas se data/layout.json não existir ainda.
 *
 * @param {number[][]} MAP
 * @param {Record<string, object>} ZONES
 * @returns {object} layout compatível com applyLayout()
 */
export function generateSeedLayout(MAP, ZONES) {
  const cells = [];
  for (let row = 0; row < ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < COLS; col++) {
      rowArr.push(tileToCell(MAP[row][col]));
    }
    cells.push(rowArr);
  }
  return { cells, zones: ZONES };
}
