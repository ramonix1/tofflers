/**
 * iso.js — Projeção isométrica e helpers de renderização.
 *
 * Coordenadas de MUNDO permanecem em pixels top-down (x,y) exatamente como
 * antes — colisão, zonas, proximidade e rede não mudam.
 * Este módulo só faz a transformação mundo→tela para o render visual.
 *
 * Projeção (col, row) → (sx, sy) em tela:
 *   col = wx / TILE,  row = wy / TILE
 *   sx  = ORIGIN_X + (col - row) * (TW / 2)
 *   sy  = ORIGIN_Y + (col + row) * (TH / 2)
 *
 * ┌─ CONSTANTES DE AJUSTE (afine aqui se quiser mover/redimensionar) ─────────┐
 * │  TW       — largura do losango do sprite de piso Kenney (em px).           │
 * │             Medido: 64 px. Ajuste se trocar o kit de tiles.                │
 * │  TH       — altura do losango (metade de TW para iso clássico 2:1).        │
 * │             Kenney usa tiles 64×64 mas o losango visível é ≈64×32.         │
 * │  ORIGIN_X — X do canto superior (tile 0,0) no canvas. Centraliza o mapa.  │
 * │  ORIGIN_Y — Y do canto superior (tile 0,0) no canvas. Empurra para baixo. │
 * │  TILE_Z_WALL  — altura extra (em px de tela) para paredes desenhadas.      │
 * │  AVATAR_SCALE — fator de escala do sprite do cão (1.0 = 32×32 natural).   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

// ── Dimensões do losango Kenney (assets/iso/floor.png = 64×64, losango visível ≈64×32)
export const TW = 64;  // largura total do losango
export const TH = 32;  // altura do losango (TW/2 para proporção 2:1)

// ── Tamanho do tile de mundo (importado de office.js, mas replicado aqui para clareza)
export const WORLD_TILE = 32; // px no espaço de mundo

// ── Dimensão do mapa em tiles
const COLS = 25;
const ROWS = 18;

/**
 * ORIGIN_X / ORIGIN_Y — ponto de tela que corresponde ao canto (col=0, row=0).
 * A fórmula centraliza o mapa isométrico num canvas de CANVAS_W × CANVAS_H.
 *
 * Canvas isométrico necessário:
 *   largura  = (COLS + ROWS) * (TW/2)  = 43 * 32 = 1376
 *   altura   = (COLS + ROWS) * (TH/2) + margem de paredes
 *            ≈ 43 * 16 + 160 ≈ 848
 */
export const CANVAS_W = (COLS + ROWS) * (TW / 2);  // 1376
export const CANVAS_H = (COLS + ROWS) * (TH / 2) + 200; // 888

// Ponto de origem no canvas (tile col=0, row=0 aparece aqui)
export const ORIGIN_X = ROWS * (TW / 2);  // 288  (desloca para centralizar)
export const ORIGIN_Y = 64;               // margem do topo

// ── Elevação extra para tiles de parede (quanto sobe acima do piso, em px de tela)
export const TILE_Z_WALL = 48;   // altura visual das paredes

// ── Escala do sprite do cão
export const AVATAR_SCALE = 1.5; // 1.5 = 48×48 (cão fica bem visível no iso)

// ─────────────────────────────────────────────────────────────────────────────
// Funções de projeção
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte coordenadas de mundo (wx, wy) em pixel de tela (sx, sy).
 * Aceita qualquer ponto fracionário (não precisa ser múltiplo de TILE).
 *
 * @param {number} wx — coordenada X de mundo em pixels
 * @param {number} wy — coordenada Y de mundo em pixels
 * @returns {{sx: number, sy: number}}
 */
export function worldToScreen(wx, wy) {
  const col = wx / WORLD_TILE;
  const row = wy / WORLD_TILE;
  return {
    sx: ORIGIN_X + (col - row) * (TW / 2),
    sy: ORIGIN_Y + (col + row) * (TH / 2),
  };
}

/**
 * Chave de profundidade para painter's algorithm.
 * Ordena pelo valor (col + row) — tiles mais "fundo" têm maior valor.
 * Desempate por row (Y de mundo): quem está mais abaixo no mundo aparece na frente.
 *
 * @param {number} col
 * @param {number} row
 * @returns {number}
 */
export function depthKey(col, row) {
  return col + row;
}

/**
 * Chave de profundidade para um ponto de mundo (wx, wy).
 * @param {number} wx
 * @param {number} wy
 * @returns {number}
 */
export function worldDepthKey(wx, wy) {
  return depthKey(wx / WORLD_TILE, wy / WORLD_TILE);
}
