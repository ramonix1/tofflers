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
 * │  TW          — largura do losango do sprite de piso Kenney (em px).        │
 * │               Medido: 64 px. Ajuste se trocar o kit de tiles.              │
 * │  TH          — altura do losango (metade de TW para iso clássico 2:1).     │
 * │               Kenney usa tiles 64×64 mas o losango visível é ≈64×32.       │
 * │  ORIGIN_X    — X do canto superior (tile 0,0) no canvas.                  │
 * │  ORIGIN_Y    — Y do canto superior (tile 0,0) no canvas.                  │
 * │  TILE_Z_WALL — NÃO é mais a elevação visual. É a altura do sprite de       │
 * │               parede em px de tela (usada para o painter's algorithm).     │
 * │               O sprite de parede é ancorado pelo PÉ na célula (WYSIWYG):  │
 * │               base do losango da parede == losango do piso da célula.      │
 * │  WALL_SPRITE_H — altura total do sprite de parede em px (natural = 64).    │
 * │               O pé do sprite (bottom) é alinhado ao centro-baixo do       │
 * │               losango da célula: sy_base = sy + TH/2.                      │
 * │               drawSprite usa: destY = sy_base - WALL_SPRITE_H * scale      │
 * │  AVATAR_SCALE — fator de escala do sprite do cão (1.0 = 32×32 natural).   │
 * │  SPEED        — velocidade base do jogador em pixels/segundo.              │
 * │  SPEED_RUN    — velocidade de corrida (Shift ou CapsLock).                 │
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

// ── Âncora do sprite de parede ────────────────────────────────────────────────
//
// WYSIWYG: o pé (bottom) do sprite de parede assenta no centro-baixo do
// losango do piso da célula. A coordenada de referência (sx, sy) produzida por
// tileScreen() aponta para o TOPO do losango. O centro-baixo fica em sy + TH/2.
//
// drawSprite para paredes usa:
//   destY = (sy + TH/2) - WALL_SPRITE_H * scale
//
// Ou seja: sem nenhuma elevação artificial — o sprite fica encaixado pelo pé.
//
/** Altura natural do sprite de parede Kenney (assets/iso/wall.png = 64×64). */
export const WALL_SPRITE_H = 64;

/**
 * Offset vertical do pé da parede (em px de tela) em relação ao sy do tile.
 * Valor positivo empurra o pé para baixo (útil para ajuste fino visual).
 * 0 = pé alinhado exatamente na ponta inferior do losango do piso.
 *
 * Afine aqui se o sprite de parede flutuar ou enterrar no chão.
 */
export const WALL_FOOT_OFFSET = 0;

// ── Elevação extra para tiles de parede — MANTIDA por compatibilidade ─────────
// Esta constante NÃO é mais usada no cálculo principal de drawSprite para paredes.
// Mantida para não quebrar imports externos que a leiam.
export const TILE_Z_WALL = 0;  // zero: pé ancorado na célula (WYSIWYG)

// ── Velocidades de movimento (px/s) — afine aqui ─────────────────────────────
export const SPEED     = 120; // caminhada normal
export const SPEED_RUN = 210; // corrida (Shift ou CapsLock)

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
