/**
 * office-iso.js — Render isométrico do escritório.
 *
 * Importa o layout unificado (layout.js) ou faz fallback ao MAP/ZONES de
 * office.js caso o layout ainda não tenha chegado do servidor.
 *
 * Paredes são auto-orientadas pela vizinhança de células sólidas:
 *   - Parede reta eixo X → wall.png (espelhado)
 *   - Parede reta eixo Y → wall.png (normal)
 *   - Canto             → wall-corner.png + flips por quadrante
 *   - Pillar isolado    → wall-pillar.png
 *
 * Âncora WYSIWYG: o pé do sprite de parede (bottom) assenta exatamente na
 * ponta inferior do losango do piso da célula → colisão == visual.
 */

import { MAP, ZONES, TILE, COLS, ROWS } from './office.js';
import { getLayout } from './layout.js';
import {
  TW, TH, ORIGIN_X, ORIGIN_Y,
  WALL_SPRITE_H, WALL_FOOT_OFFSET,
  worldToScreen, depthKey,
} from './iso.js';

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
  'floor', 'floor-corner', 'floor-detail', 'floor-panel',
  'wall', 'wall-corner', 'wall-corner-round', 'wall-pillar',
  'table', 'table-large', 'chair', 'chair-armrest',
  'computer', 'computer-screen',
  'container', 'structure',
  'door-single', 'door-single-closed',
];
PRELOAD.forEach(img);

// ─── Helpers de acesso ao modelo de layout ────────────────────────────────────

/**
 * Retorna true se a célula (col, row) for sólida.
 * Usa o modelo de layout quando disponível; fallback para MAP legado.
 */
function isCellSolid(col, row) {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return false;
  const layout = getLayout();
  if (layout) {
    const cell = layout.cells[row]?.[col];
    return cell ? cell.solid : false;
  }
  // Fallback: MAP legado (tipos sólidos: W=1, M=2, P=7, S=8)
  const t = MAP[row]?.[col] ?? 0;
  return t === 1 || t === 2 || t === 7 || t === 8;
}

/**
 * Retorna o sprite e metadados de uma célula (col, row).
 * Usa o modelo de layout quando disponível; fallback para MAP legado.
 */
function getCellSprite(col, row) {
  const layout = getLayout();
  if (layout) {
    const cell = layout.cells[row]?.[col];
    if (!cell) return { floor: 'floor', object: null, solid: false };
    return { floor: cell.floor || 'floor', object: cell.object || null, solid: cell.solid };
  }
  // Fallback: MAP legado
  const t = MAP[row]?.[col] ?? 0;
  return tileSpriteLegacy(t);
}

/**
 * Conversão legado MAP → sprites (usado apenas quando layout.json não está carregado).
 * @param {number} tileType
 */
function tileSpriteLegacy(tileType) {
  const W = 1, M = 2, C = 3, K = 4, R = 5, E = 6, P = 7, S = 8;
  switch (tileType) {
    case 0: return { floor: 'floor',        object: null,        solid: false };
    case K: return { floor: 'floor-detail', object: null,        solid: false };
    case R: return { floor: 'floor-panel',  object: null,        solid: false };
    case E: return { floor: 'floor-corner', object: null,        solid: false };
    case W: return { floor: 'floor',        object: 'wall',      solid: true  };
    case M: return { floor: 'floor',        object: 'table',     solid: true  };
    case C: return { floor: 'floor',        object: 'chair',     solid: false };
    case P: return { floor: 'floor',        object: 'structure', solid: true  };
    case S: return { floor: 'floor',        object: 'container', solid: true  };
    default: return { floor: 'floor',       object: null,        solid: false };
  }
}

// ─── Auto-orientação de paredes ───────────────────────────────────────────────

/**
 * Determina o sprite e transformação de uma célula de parede de acordo com
 * a vizinhança de células sólidas.
 *
 * Vizinhos considerados (4-conectividade):
 *   N = (col, row-1)  S = (col, row+1)
 *   W = (col-1, row)  E = (col+1, row)
 *
 * Lógica de orientação (perspectiva isométrica, câmera NE):
 *   - Ambos E e S sólidos → canto SE  (wall-corner, flip nenhum)
 *   - E sólido, W sólido  → parede eixo X (wall, normal)
 *   - N sólido, S sólido  → parede eixo Y (wall, flip horizontal)
 *   - Só E sólido         → wall, normal
 *   - Só S sólido         → wall, flip horizontal
 *   - Canto com N e W     → wall-corner, flipX+flipY
 *   - etc.
 *
 * Retorna: { spriteName, flipX, flipY }
 *
 * @param {number} col
 * @param {number} row
 * @returns {{ spriteName: string, flipX: boolean, flipY: boolean }}
 */
function wallOrientation(col, row) {
  const N = isCellSolid(col,     row - 1);
  const S = isCellSolid(col,     row + 1);
  const Wn = isCellSolid(col - 1, row);
  const E = isCellSolid(col + 1, row);

  const hWall = Wn || E;   // vizinhos no eixo horizontal
  const vWall = N  || S;   // vizinhos no eixo vertical
  const corner = hWall && vWall;

  if (corner) {
    // Canto: escolhe o sprite de canto e o flip pelo quadrante
    // Em isométrico 2:1 a câmera fica acima-direita:
    //   canto SE (E+S) → normal
    //   canto SW (W+S) → flipX
    //   canto NE (E+N) → flipY
    //   canto NW (W+N) → flipX+flipY
    const flipX = Wn && !E;
    const flipY = N  && !S;
    return { spriteName: 'wall-corner', flipX, flipY };
  }

  if (hWall) {
    // Parede horizontal (eixo X de mundo → eixo "esquerda-direita" em tela)
    return { spriteName: 'wall', flipX: false, flipY: false };
  }

  if (vWall) {
    // Parede vertical (eixo Y de mundo → eixo "frente-trás" em tela)
    // Espelhamos horizontalmente para dar a face correta
    return { spriteName: 'wall', flipX: true, flipY: false };
  }

  // Célula sólida isolada (pillar decorativo)
  return { spriteName: 'wall-pillar', flipX: false, flipY: false };
}

// ─── Helpers de desenho ───────────────────────────────────────────────────────

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

/**
 * Desenha um sprite de PISO isométrico centrado no ponto de tela (sx, sy).
 * O piso Kenney é 64×64; o topo do losango coincide com sy.
 * A ponta inferior do losango fica em sy + TH.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} spriteName
 * @param {number} sx  — centro-X de tela do tile
 * @param {number} sy  — topo do losango em tela
 * @param {number} [scale=1]
 */
function drawFloorSprite(ctx, spriteName, sx, sy, scale = 1) {
  const image = img(spriteName);
  if (!image.complete || image.naturalWidth === 0) return;
  const w = image.naturalWidth  * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, sx - w / 2, sy - h + TH / 2, w, h);
}

/**
 * Desenha um sprite de OBJETO isométrico ancorado pelo PÉ na célula.
 *
 * WYSIWYG: a base do sprite (bottom) assenta no centro-baixo do losango do piso,
 * ou seja, em sy + TH/2 + WALL_FOOT_OFFSET.
 * Isso garante que o "pé" visual coincide com a célula de colisão.
 *
 * Para objetos de altura variável (cadeiras, mesas) usamos a mesma âncora de pé.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} spriteName
 * @param {number} sx       — centro-X do tile em tela
 * @param {number} sy       — topo do losango em tela
 * @param {number} [scale=1]
 * @param {boolean} [flipX=false] — espelha horizontalmente
 * @param {boolean} [flipY=false] — espelha verticalmente
 */
function drawObjectSprite(ctx, spriteName, sx, sy, scale = 1, flipX = false, flipY = false) {
  const image = img(spriteName);
  if (!image.complete || image.naturalWidth === 0) return;
  const w = image.naturalWidth  * scale;
  const h = image.naturalHeight * scale;

  // Pé do sprite = centro-baixo do losango = sy + TH/2 + WALL_FOOT_OFFSET
  const footY = sy + TH / 2 + WALL_FOOT_OFFSET;
  const destY = footY - h;  // topo do destino = pé - altura do sprite
  const destX = sx - w / 2; // centralizado horizontalmente

  if (!flipX && !flipY) {
    ctx.drawImage(image, destX, destY, w, h);
    return;
  }

  ctx.save();
  ctx.translate(sx, footY - h / 2); // pivot no centro do sprite
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// ─── Render principal ─────────────────────────────────────────────────────────

/**
 * Renderiza o escritório em projeção isométrica no contexto 2D.
 *
 * Estratégia de duas passadas:
 *   1. Piso  — varredura row-major (de cima p/ baixo, esquerda p/ direita).
 *   2. Objetos (paredes, móveis) — painter's algorithm por (col + row) crescente.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderOfficeIso(ctx) {
  // ── Passada 1: piso ─────────────────────────────────────────────────────────
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { floor } = getCellSprite(col, row);
      if (!floor) continue;
      const { sx, sy } = tileScreen(col, row);
      drawFloorSprite(ctx, floor, sx, sy);
    }
  }

  // ── Passada 2: objetos ordenados por profundidade ───────────────────────────
  /** @type {Array<{depth:number, col:number, row:number, sprite:string, flipX:boolean, flipY:boolean, scaleObj:number}>} */
  const objects = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { object } = getCellSprite(col, row);
      if (!object) continue;

      let spriteName = object;
      let flipX = false;
      let flipY = false;

      // Paredes: auto-orientação por vizinhança
      if (object === 'wall') {
        const ori = wallOrientation(col, row);
        spriteName = ori.spriteName;
        flipX      = ori.flipX;
        flipY      = ori.flipY;
      }

      objects.push({
        depth: depthKey(col, row),
        col, row,
        sprite: spriteName,
        flipX, flipY,
        scaleObj: 1,
      });
    }
  }

  // Ordena por profundidade crescente (fundo primeiro), desempate por row
  objects.sort((a, b) => a.depth - b.depth || a.row - b.row);

  for (const { col, row, sprite, flipX, flipY, scaleObj } of objects) {
    const { sx, sy } = tileScreen(col, row);
    drawObjectSprite(ctx, sprite, sx, sy, scaleObj, flipX, flipY);
  }

  // ── Passada 3: zonas coloridas + labels ─────────────────────────────────────
  _renderZones(ctx);
}

/**
 * Converte um retângulo de mundo (px) em 4 vértices de tela isométricos
 * e pinta um polígono translúcido + label.
 * @param {CanvasRenderingContext2D} ctx
 */
function _renderZones(ctx) {
  const zones = getLayout() ? getLayout().zones : ZONES;
  ctx.save();
  for (const [, z] of Object.entries(zones)) {
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

// ─── Overlay de diagnóstico / edição ─────────────────────────────────────────

/**
 * Desenha o overlay de diagnóstico sobre o mapa:
 *   - Grade isométrica de todas as células
 *   - Realce das células sólidas (vermelho translúcido)
 *   - Limites e rótulos das zonas (amarelo)
 *
 * Ativado por main.js via toggle (tecla Tab ou botão).
 * Também é a base do editor visual do Estágio 2.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderDebugOverlay(ctx) {
  ctx.save();

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { sx, sy } = tileScreen(col, row);

      // Losango da grade
      //   topo    = (sx, sy)
      //   direita = (sx + TW/2, sy + TH/2)
      //   baixo   = (sx,        sy + TH)
      //   esquerda= (sx - TW/2, sy + TH/2)
      const lx = sx - TW / 2, cx = sx, rx = sx + TW / 2;
      const ty = sy, my = sy + TH / 2, by = sy + TH;

      // Realce das células sólidas
      const { solid } = getCellSprite(col, row);
      if (solid) {
        ctx.beginPath();
        ctx.moveTo(cx, ty);
        ctx.lineTo(rx, my);
        ctx.lineTo(cx, by);
        ctx.lineTo(lx, my);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 60, 60, 0.22)';
        ctx.fill();
      }

      // Borda do losango
      ctx.beginPath();
      ctx.moveTo(cx, ty);
      ctx.lineTo(rx, my);
      ctx.lineTo(cx, by);
      ctx.lineTo(lx, my);
      ctx.closePath();
      ctx.strokeStyle = solid
        ? 'rgba(255,100,100,0.5)'
        : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  // Limites das zonas (amarelo)
  const zones = getLayout() ? getLayout().zones : ZONES;
  for (const [key, z] of Object.entries(zones)) {
    const x0 = z.x / TILE, y0 = z.y / TILE;
    const x1 = (z.x + z.w) / TILE, y1 = (z.y + z.h) / TILE;

    const tl = tileScreen(x0, y0);
    const tr = tileScreen(x1, y0);
    const br = tileScreen(x1, y1);
    const bl = tileScreen(x0, y1);

    const half = TH / 2;
    const pts = [tl, tr, br, bl].map(p => ({ x: p.sx, y: p.sy + half }));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 220, 50, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Rótulo da sala
    const cx2 = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy2 = pts.reduce((s, p) => s + p.y, 0) / 4;
    ctx.fillStyle = 'rgba(255,220,50,0.85)';
    ctx.font = 'bold 10px "Segoe UI", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(key.toUpperCase(), cx2, cy2);
  }

  ctx.restore();
}

/**
 * Retorna a lista de objetos (tiles com object) para intercalar com avatares
 * no painter's algorithm do main.js.
 * Cada item: { depth, sx, sy, sprite, scaleObj }
 *
 * @returns {Array<{depth:number, sx:number, sy:number, sprite:string, scaleObj:number}>}
 */
export function getSceneObjects() {
  const objects = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { object } = getCellSprite(col, row);
      if (!object) continue;
      const { sx, sy } = tileScreen(col, row);
      objects.push({
        depth: depthKey(col, row),
        sx, sy,
        sprite: object,
        scaleObj: 1,
      });
    }
  }
  return objects;
}
