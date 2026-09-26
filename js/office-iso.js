/**
 * office-iso.js — Render isométrico do escritório.
 *
 * Importa o MAP e zonas de office.js (lógica de mundo intacta) e re-renderiza
 * usando sprites Kenney 64×64 com painter's algorithm.
 *
 * O módulo office.js NÃO é modificado — colisão, zonas e getZoneAt continuam
 * funcionando com coordenadas de mundo (pixels top-down).
 */

import { MAP, ZONES, TILE, COLS, ROWS } from './office.js';
import { TW, TH, ORIGIN_X, ORIGIN_Y, TILE_Z_WALL, worldToScreen, depthKey } from './iso.js';

// ─── Cache de imagens ─────────────────────────────────────────────────────────

/** @type {Map<string, HTMLImageElement>} */
const IMG = new Map();

/**
 * Carrega uma imagem de assets/iso/<name>.png e guarda em cache.
 * Retorna a imagem (pode ainda estar carregando — canvas a ignora com graça).
 * @param {string} name
 * @returns {HTMLImageElement}
 */
function img(name) {
  if (IMG.has(name)) return IMG.get(name);
  const el = new Image();
  el.src = `assets/iso/${name}.png`;
  IMG.set(name, el);
  return el;
}

// Pré-carrega os sprites mais usados
const PRELOAD = [
  'floor', 'floor-corner', 'floor-detail',
  'wall', 'wall-corner', 'wall-corner-round', 'wall-pillar',
  'table', 'table-large', 'chair', 'chair-armrest',
  'computer', 'computer-screen',
  'container', 'structure',
  'door-single', 'door-single-closed',
];
PRELOAD.forEach(img);

// ─── Mapeamento tile → sprite ─────────────────────────────────────────────────

// Tipos de tile (replicados aqui para legibilidade; valores idênticos a office.js)
const W = 1; // parede
const _ = 0; // piso livre
const M = 2; // mesa
const C = 3; // cadeira
const K = 4; // copa
const R = 5; // sala de reunião
const E = 6; // recepção
const P = 7; // planta
const S = 8; // sofá/balcão

/**
 * Retorna o(s) sprite(s) a desenhar para um tile.
 * Cada entrada é { floor, object } onde:
 *   floor  = nome do sprite de piso (desenhado na passada de fundo)
 *   object = nome do sprite de objeto sobreposto (ou null)
 *   zObj   = elevação extra do objeto em px de tela (default 0)
 *   scaleObj = fator de escala do objeto (default 1)
 *
 * @param {number} tileType
 * @param {number} col
 * @param {number} row
 * @returns {{ floor: string|null, object: string|null, zObj?: number, scaleObj?: number }}
 */
function tileSprite(tileType, col, row) {
  switch (tileType) {
    case _: return { floor: 'floor', object: null };
    case K: return { floor: 'floor-detail', object: null };
    case R: return { floor: 'floor-panel', object: null };
    case E: return { floor: 'floor-corner', object: null };
    case W: return { floor: 'floor', object: 'wall', zObj: TILE_Z_WALL };
    case M: return { floor: 'floor', object: 'table', zObj: 0 };
    case C: return { floor: 'floor', object: 'chair', zObj: 0 };
    case P: return { floor: 'floor', object: 'structure', zObj: 0 };
    case S: return { floor: 'floor', object: 'container', zObj: 0 };
    default: return { floor: 'floor', object: null };
  }
}

// ─── Helpers de desenho ───────────────────────────────────────────────────────

/**
 * Desenha um sprite isométrico centrado no ponto de tela (sx, sy).
 * O sprite Kenney é 64×64; o losango de piso ocupa toda a largura.
 * Para alinhamento: a ponta inferior do losango fica em (sx, sy + TH/2).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} spriteName
 * @param {number} sx  — centro-X de tela do tile
 * @param {number} sy  — topo do losango em tela
 * @param {number} [elevate=0]  — quantos px a subir (para objetos sobre o piso)
 * @param {number} [scale=1]   — fator de escala
 */
function drawSprite(ctx, spriteName, sx, sy, elevate = 0, scale = 1) {
  const image = img(spriteName);
  if (!image.complete || image.naturalWidth === 0) return; // ainda carregando
  const w = image.naturalWidth  * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, sx - w / 2, sy - h + TH / 2 - elevate, w, h);
}

/**
 * Calcula o ponto de tela (topo-centro do losango) para o tile (col, row).
 * @param {number} col
 * @param {number} row
 * @returns {{sx: number, sy: number}}
 */
function tileScreen(col, row) {
  return {
    sx: ORIGIN_X + (col - row) * (TW / 2),
    sy: ORIGIN_Y + (col + row) * (TH / 2),
  };
}

// ─── Render principal ─────────────────────────────────────────────────────────

/**
 * Renderiza o escritório em projeção isométrica no contexto 2D.
 *
 * Estratégia de duas passadas:
 *   1. Piso  — varredura row-major (de cima p/ baixo, esquerda p/ direita).
 *              Não tem depth issues, é o mais simples.
 *   2. Objetos (paredes, móveis) — painter's algorithm por (col + row) crescente.
 *              Objetos mais "ao fundo" (menor depth) são desenhados primeiro.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderOfficeIso(ctx) {
  // ── Passada 1: piso ─────────────────────────────────────────────────────────
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      const { floor } = tileSprite(tile, col, row);
      if (!floor) continue;
      const { sx, sy } = tileScreen(col, row);
      drawSprite(ctx, floor, sx, sy);
    }
  }

  // ── Passada 2: objetos ordenados por profundidade ───────────────────────────
  /** @type {Array<{depth: number, col: number, row: number, sprite: string, zObj: number, scaleObj: number}>} */
  const objects = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      const { object, zObj = 0, scaleObj = 1 } = tileSprite(tile, col, row);
      if (!object) continue;
      objects.push({
        depth: depthKey(col, row),
        col, row,
        sprite: object,
        zObj,
        scaleObj,
      });
    }
  }

  // Ordena por profundidade crescente (fundo primeiro)
  objects.sort((a, b) => a.depth - b.depth || a.row - b.row);

  for (const { col, row, sprite, zObj, scaleObj } of objects) {
    const { sx, sy } = tileScreen(col, row);
    drawSprite(ctx, sprite, sx, sy, zObj, scaleObj);
  }

  // ── Passada 3: zonas coloridas + labels ─────────────────────────────────────
  // Desenhamos as zonas sobre os tiles, convertendo os retângulos de mundo
  // para polígonos isométricos aproximados (losango do retângulo).
  _renderZones(ctx);
}

/**
 * Converte um retângulo de mundo (px) em 4 vértices de tela isométricos
 * e pinta um polígono translúcido + label.
 * @param {CanvasRenderingContext2D} ctx
 */
function _renderZones(ctx) {
  ctx.save();
  for (const [, z] of Object.entries(ZONES)) {
    // 4 cantos do retângulo de mundo em tiles
    const x0 = z.x / TILE;
    const y0 = z.y / TILE;
    const x1 = (z.x + z.w) / TILE;
    const y1 = (z.y + z.h) / TILE;

    // 4 vértices em tela
    const tl = tileScreen(x0, y0); // top-left
    const tr = tileScreen(x1, y0); // top-right
    const br = tileScreen(x1, y1); // bottom-right
    const bl = tileScreen(x0, y1); // bottom-left

    // Ajuste: os pontos ficam no topo do losango; queremos o centro
    const half = TH / 2;
    const adjust = (p) => ({ x: p.sx, y: p.sy + half });
    const [vtl, vtr, vbr, vbl] = [tl, tr, br, bl].map(adjust);

    ctx.beginPath();
    ctx.moveTo(vtl.x, vtl.y);
    ctx.lineTo(vtr.x, vtr.y);
    ctx.lineTo(vbr.x, vbr.y);
    ctx.lineTo(vbl.x, vbl.y);
    ctx.closePath();

    ctx.fillStyle = z.color;
    ctx.fill();

    // Borda tracejada
    ctx.strokeStyle = z.color.replace(/[\d.]+\)$/, '0.4)');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Label no centro isométrico da zona
    const cx = (vtl.x + vtr.x + vbr.x + vbl.x) / 4;
    const cy = (vtl.y + vtr.y + vbr.y + vbl.y) / 4;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(z.label.toUpperCase(), cx, cy);
  }
  ctx.restore();
}

/**
 * Retorna a lista de objetos (tiles sólidos) para intercalar com avatares
 * no painter's algorithm do main.js.
 * Cada item: { depth, sx, sy, sprite, zObj, scaleObj }
 *
 * @returns {Array<{depth:number, sx:number, sy:number, sprite:string, zObj:number, scaleObj:number}>}
 */
export function getSceneObjects() {
  const objects = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      const { object, zObj = 0, scaleObj = 1 } = tileSprite(tile, col, row);
      if (!object) continue;
      const { sx, sy } = tileScreen(col, row);
      objects.push({
        depth: depthKey(col, row),
        sx, sy,
        sprite: object,
        zObj,
        scaleObj,
      });
    }
  }
  return objects;
}
