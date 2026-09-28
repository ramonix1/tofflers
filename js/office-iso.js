/**
 * office-iso.js — Render isométrico PROCEDURAL do escritório.
 *
 * Não usa sprites de ambiente (piso/parede): tudo é desenhado com formas de
 * canvas para garantir encaixe perfeito na grade isométrica sem vãos, sem
 * objetos flutuando e com o clique do editor coincidindo com o visual.
 *
 * Geometria de uma célula (col, row):
 *   WT = WORLD_TILE = 32 px de mundo
 *   N (topo)    = worldToScreen(col*WT,     row*WT)
 *   E (direita) = worldToScreen((col+1)*WT, row*WT)
 *   S (baixo)   = worldToScreen((col+1)*WT, (row+1)*WT)
 *   W (esq.)    = worldToScreen(col*WT,     (row+1)*WT)
 *
 * Os 4 pontos tesselam perfeitamente com os vizinhos.
 * O "topo" do losango (N) coincide com o sy calculado por tileScreen(col,row)
 * — mesma referência usada pelo _desenharDestaque do editor.
 *
 * ┌─ CONSTANTES DE COR (afine aqui) ──────────────────────────────────────────┐
 * │  FLOOR_BASE      — piso genérico (azul-acinzentado escuro)                 │
 * │  FLOOR_GRID      — linha de grade do piso (bem sutil)                      │
 * │  WALL_TOP        — face superior do prisma de parede (claro)               │
 * │  WALL_SIDE_SW    — face frontal SW (sombra mais escura)                    │
 * │  WALL_SIDE_SE    — face frontal SE (sombra intermediária)                  │
 * │  FURNITURE_*     — cores dos móveis                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

import { MAP, ZONES, TILE, COLS, ROWS } from './office.js';
import { getLayout } from './layout.js';
import {
  TW, TH, ORIGIN_X, ORIGIN_Y, WORLD_TILE,
  WALL_H,
  worldToScreen, depthKey,
  // importados mas não mais usados ativamente — mantidos para não quebrar
  // qualquer import externo que reexporte daqui
  WALL_SPRITE_H, WALL_FOOT_OFFSET, FLOOR_FILL_SCALE, FLOOR_TOP_ADJUST,
} from './iso.js';

// ─── Paleta de cores (constantes — ajuste fino aqui) ─────────────────────────

/** Piso padrão: azul-acinzentado CLARO (bem mais claro que o tema, boa leitura) */
const FLOOR_BASE       = '#5a6291';
/** Piso com detalhe (ex.: floor-detail, floor-panel) */
const FLOOR_DETAIL     = '#69719e';
/** Piso de varanda / canto */
const FLOOR_CORNER     = '#525a86';
/** Linha de grade do piso (sutil) */
const FLOOR_GRID       = 'rgba(255,255,255,0.10)';

/** Topo do prisma de parede (face mais clara) */
const WALL_TOP         = '#aab0d6';
/** Face frontal SW da parede (sombra mais escura) */
const WALL_SIDE_SW     = '#6b719c';
/** Face frontal SE da parede (sombra intermediária) */
const WALL_SIDE_SE     = '#8288b5';

/** Topo do prisma de porta — mais baixo, tom diferente */
const DOOR_TOP         = '#8f96bd';
/** Lateral da porta */
const DOOR_SIDE        = '#646a90';
/** Altura do sill da porta (px de tela) — menor que WALL_H */
const DOOR_H           = 8;

/** Mesa: superfície e lateral */
const TABLE_TOP        = '#a9764a';
const TABLE_SIDE_SW    = '#6f4c2d';
const TABLE_SIDE_SE    = '#8a5f3a';
/** Altura da mesa (px de tela) */
const TABLE_H          = 10;

/** Cadeira: assento e lateral */
const CHAIR_TOP        = '#4f7ab5';
const CHAIR_SIDE       = '#38567f';
/** Altura da cadeira */
const CHAIR_H          = 7;

/** Computador */
const COMPUTER_TOP     = '#3f5f7e';
const COMPUTER_SIDE    = '#2a3f54';
const COMPUTER_H       = 14;

/** Container/balcão */
const CONTAINER_TOP    = '#7a7a95';
const CONTAINER_SIDE_SW = '#4e4e64';
const CONTAINER_SIDE_SE = '#616178';
const CONTAINER_H      = 14;

/** Estrutura / planta decorativa */
const STRUCTURE_TOP    = '#4fa64f';
const STRUCTURE_SIDE   = '#357935';
const STRUCTURE_H      = 18;

/** Janela: tom levemente azulado translúcido no topo */
const WINDOW_TOP       = '#7d97c8';
const WINDOW_SIDE      = '#5a78ad';
const WINDOW_H         = WALL_H;

// ─── Helpers de acesso ao modelo de layout ────────────────────────────────────

/**
 * Retorna true se a célula (col, row) for sólida.
 */
function isCellSolid(col, row) {
  if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return false;
  const layout = getLayout();
  if (layout) {
    const cell = layout.cells[row]?.[col];
    return cell ? cell.solid : false;
  }
  const t = MAP[row]?.[col] ?? 0;
  return t === 1 || t === 2 || t === 7 || t === 8;
}

/**
 * Retorna os dados da célula (col, row).
 */
function getCellData(col, row) {
  const layout = getLayout();
  if (layout) {
    const cell = layout.cells[row]?.[col];
    if (!cell) return { floor: 'floor', object: null, solid: false };
    return { floor: cell.floor || 'floor', object: cell.object || null, solid: cell.solid };
  }
  return tileDataLegacy(MAP[row]?.[col] ?? 0);
}

function tileDataLegacy(t) {
  const W=1,M=2,C=3,K=4,R=5,E=6,P=7,S=8;
  switch (t) {
    case 0: return { floor:'floor',        object:null,        solid:false };
    case K: return { floor:'floor-detail', object:null,        solid:false };
    case R: return { floor:'floor-panel',  object:null,        solid:false };
    case E: return { floor:'floor-corner', object:null,        solid:false };
    case W: return { floor:'floor',        object:'wall',      solid:true  };
    case M: return { floor:'floor',        object:'table',     solid:true  };
    case C: return { floor:'floor',        object:'chair',     solid:false };
    case P: return { floor:'floor',        object:'structure', solid:true  };
    case S: return { floor:'floor',        object:'container', solid:true  };
    default:return { floor:'floor',        object:null,        solid:false };
  }
}

// ─── Cálculo dos 4 cantos do losango de uma célula ────────────────────────────

/**
 * Retorna os 4 vértices de tela do losango da célula (col, row).
 * N = topo, E = direita, S = baixo, W = esquerda.
 * Tesselam perfeitamente com vizinhos.
 * OBS: tileScreen(col,row) retorna (sx,sy) = N (topo do losango), o que garante
 * compatibilidade total com o highlight do editor (_desenharDestaque).
 */
function cellCorners(col, row) {
  const WT = WORLD_TILE;
  const N = worldToScreen(col * WT,       row * WT);
  const E = worldToScreen((col + 1) * WT, row * WT);
  const S = worldToScreen((col + 1) * WT, (row + 1) * WT);
  const W = worldToScreen(col * WT,       (row + 1) * WT);
  return { N, E, S, W };
}

/**
 * Retorna os vértices do topo do prisma (elevados por dH px).
 */
function topCorners(corners, dH) {
  return {
    N: { sx: corners.N.sx, sy: corners.N.sy - dH },
    E: { sx: corners.E.sx, sy: corners.E.sy - dH },
    S: { sx: corners.S.sx, sy: corners.S.sy - dH },
    W: { sx: corners.W.sx, sy: corners.W.sy - dH },
  };
}

// ─── Helpers de path ─────────────────────────────────────────────────────────

/** Preenche um losango (N,E,S,W) */
function fillDiamond(ctx, N, E, S, W, color) {
  ctx.beginPath();
  ctx.moveTo(N.sx, N.sy);
  ctx.lineTo(E.sx, E.sy);
  ctx.lineTo(S.sx, S.sy);
  ctx.lineTo(W.sx, W.sy);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Preenche um quad com 4 pontos {sx,sy} */
function fillQuad(ctx, a, b, c, d, color) {
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy);
  ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.lineTo(d.sx, d.sy);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Desenho de piso ──────────────────────────────────────────────────────────

/**
 * Cor do piso com base no tipo de tile e na zona.
 * A zona tinge levemente o piso com sua cor de overlay.
 */
function floorColor(floorType, zoneColor) {
  let base;
  switch (floorType) {
    case 'floor-detail': base = FLOOR_DETAIL; break;
    case 'floor-panel':  base = FLOOR_DETAIL; break;
    case 'floor-corner': base = FLOOR_CORNER; break;
    case 'balcony-floor':base = FLOOR_CORNER; break;
    default:             base = FLOOR_BASE;   break;
  }
  return base; // zona é aplicada como overlay separado nos tiles de zona
}

/**
 * Desenha o piso de uma célula (losango preenchido + linha de grade sutil).
 */
function drawFloorCell(ctx, col, row, floorType, zoneColor) {
  const { N, E, S, W } = cellCorners(col, row);
  fillDiamond(ctx, N, E, S, W, floorColor(floorType, zoneColor));

  // Linha de grade sutil nas 4 bordas
  ctx.beginPath();
  ctx.moveTo(N.sx, N.sy);
  ctx.lineTo(E.sx, E.sy);
  ctx.lineTo(S.sx, S.sy);
  ctx.lineTo(W.sx, W.sy);
  ctx.closePath();
  ctx.strokeStyle = FLOOR_GRID;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

// ─── Desenho de prismas (paredes, móveis) ────────────────────────────────────

/**
 * Desenha um prisma extrudado sobre a célula (col, row) com altura dH.
 * Faces visíveis (câmera vinda de NW/NE):
 *   - Face SW: [W, S, S_top, W_top]
 *   - Face SE: [S, E, E_top, S_top]
 *   - Topo:    losango N_top,E_top,S_top,W_top
 */
function drawPrism(ctx, col, row, dH, colorTop, colorSW, colorSE) {
  const base = cellCorners(col, row);
  const top  = topCorners(base, dH);

  // Face SW (lado esquerdo-frontal)
  fillQuad(ctx, base.W, base.S, top.S, top.W, colorSW);
  // Face SE (lado direito-frontal)
  fillQuad(ctx, base.S, base.E, top.E, top.S, colorSE);
  // Topo do prisma
  fillDiamond(ctx, top.N, top.E, top.S, top.W, colorTop);
}

// ─── Render de objetos por tipo ───────────────────────────────────────────────

/**
 * Desenha um objeto na célula (col, row) de acordo com seu tipo.
 * Cada tipo é um prisma ou forma simples coerente com o estilo.
 */
function drawObject(ctx, col, row, objectType) {
  switch (objectType) {
    case 'wall':
      drawPrism(ctx, col, row, WALL_H, WALL_TOP, WALL_SIDE_SW, WALL_SIDE_SE);
      break;

    case 'wall-door':
      // Porta: sill baixo + vão — mostra um prisma bem baixo para indicar passagem
      drawPrism(ctx, col, row, DOOR_H, DOOR_TOP, DOOR_SIDE, DOOR_SIDE);
      break;

    case 'wall-window':
      // Janela: parede cheia de altura normal, tom azulado
      drawPrism(ctx, col, row, WINDOW_H, WINDOW_TOP, WINDOW_SIDE, WINDOW_SIDE);
      break;

    case 'table':
      drawPrism(ctx, col, row, TABLE_H, TABLE_TOP, TABLE_SIDE_SW, TABLE_SIDE_SE);
      break;

    case 'chair': {
      // Cadeira: prisma menor, deslocado levemente para o centro
      // Desenhamos na mesma célula mas com altura reduzida
      drawPrism(ctx, col, row, CHAIR_H, CHAIR_TOP, CHAIR_SIDE, CHAIR_SIDE);
      break;
    }

    case 'computer':
      // Computador: prisma alto e estreito — desenha um sub-losango centrado
      _drawSubPrism(ctx, col, row, COMPUTER_H, 0.5, COMPUTER_TOP, COMPUTER_SIDE, COMPUTER_SIDE);
      break;

    case 'container':
      drawPrism(ctx, col, row, CONTAINER_H, CONTAINER_TOP, CONTAINER_SIDE_SW, CONTAINER_SIDE_SE);
      break;

    case 'structure':
      // Planta: sub-prisma ligeiramente mais estreito, mais alto, verde
      _drawSubPrism(ctx, col, row, STRUCTURE_H, 0.55, STRUCTURE_TOP, STRUCTURE_SIDE, STRUCTURE_SIDE);
      break;

    case 'bed-single':
      // Cama: prisma baixo, tom claro
      drawPrism(ctx, col, row, 8, '#3a3550', '#252038', '#2e2844');
      break;

    default:
      // Objeto desconhecido: prisma genérico pequeno
      drawPrism(ctx, col, row, 8, '#303550', '#1e2238', '#282e48');
      break;
  }
}

/**
 * Desenha um sub-prisma centralizado na célula — para objetos menores que
 * ocupam só parte da área da célula (computador, planta, etc.).
 * @param {number} frac — fração do losango usada (0..1), ex: 0.5 = metade
 */
function _drawSubPrism(ctx, col, row, dH, frac, colorTop, colorSW, colorSE) {
  const { N, E, S, W } = cellCorners(col, row);
  // Centro do losango
  const cx = (N.sx + E.sx + S.sx + W.sx) / 4;
  const cy = (N.sy + E.sy + S.sy + W.sy) / 4;

  // Sub-losango: lerp entre centro e cada canto por frac
  function lerp(a, f) {
    return { sx: cx + (a.sx - cx) * f, sy: cy + (a.sy - cy) * f };
  }

  const sN = lerp(N, frac);
  const sE = lerp(E, frac);
  const sS = lerp(S, frac);
  const sW = lerp(W, frac);

  // Faces SW e SE do sub-prisma
  const tN = { sx: sN.sx, sy: sN.sy - dH };
  const tE = { sx: sE.sx, sy: sE.sy - dH };
  const tS = { sx: sS.sx, sy: sS.sy - dH };
  const tW = { sx: sW.sx, sy: sW.sy - dH };

  fillQuad(ctx, sW, sS, tS, tW, colorSW);
  fillQuad(ctx, sS, sE, tE, tS, colorSE);
  fillDiamond(ctx, tN, tE, tS, tW, colorTop);
}

// ─── Render principal ─────────────────────────────────────────────────────────

/**
 * Renderiza o escritório em projeção isométrica no contexto 2D.
 *
 * Estratégia de passadas:
 *   1. Piso  — varredura row-major (de cima p/ baixo, esquerda p/ direita).
 *   2. Zonas coloridas (overlay translúcido sobre o piso).
 *   3. Objetos (paredes, móveis) — painter's algorithm por depthKey crescente.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderOfficeIso(ctx) {
  // ── Passada 1: piso ─────────────────────────────────────────────────────────
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { floor } = getCellData(col, row);
      if (!floor) continue;
      drawFloorCell(ctx, col, row, floor, null);
    }
  }

  // ── Passada 2: zonas coloridas ──────────────────────────────────────────────
  _renderZones(ctx);

  // ── Passada 3: objetos ordenados por profundidade ───────────────────────────
  /** @type {Array<{depth:number, col:number, row:number, object:string}>} */
  const objects = [];

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { object } = getCellData(col, row);
      if (!object) continue;
      objects.push({
        depth: depthKey(col, row),
        col, row,
        object,
      });
    }
  }

  // Ordena por profundidade crescente (fundo primeiro), desempate por row
  objects.sort((a, b) => a.depth - b.depth || a.row - b.row);

  for (const { col, row, object } of objects) {
    drawObject(ctx, col, row, object);
  }
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

    // 4 vértices em tela (usando worldToScreen para consistência)
    const tl = worldToScreen(z.x,         z.y);
    const tr = worldToScreen(z.x + z.w,   z.y);
    const br = worldToScreen(z.x + z.w,   z.y + z.h);
    const bl = worldToScreen(z.x,         z.y + z.h);

    ctx.beginPath();
    ctx.moveTo(tl.sx, tl.sy);
    ctx.lineTo(tr.sx, tr.sy);
    ctx.lineTo(br.sx, br.sy);
    ctx.lineTo(bl.sx, bl.sy);
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
    const cx = (tl.sx + tr.sx + br.sx + bl.sx) / 4;
    const cy = (tl.sy + tr.sy + br.sy + bl.sy) / 4;
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
 * Usa os 4 cantos exatos (cellCorners) — mesma geometria do piso procedural.
 * O highlight do editor (_desenharDestaque) usa tileScreen(col,row) = ponto N,
 * que é worldToScreen(col*WT, row*WT) = N de cellCorners → coincidência exata.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function renderDebugOverlay(ctx) {
  ctx.save();

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { N, E, S, W } = cellCorners(col, row);
      const { solid } = getCellData(col, row);

      // Realce das células sólidas
      if (solid) {
        ctx.beginPath();
        ctx.moveTo(N.sx, N.sy);
        ctx.lineTo(E.sx, E.sy);
        ctx.lineTo(S.sx, S.sy);
        ctx.lineTo(W.sx, W.sy);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 60, 60, 0.22)';
        ctx.fill();
      }

      // Borda do losango
      ctx.beginPath();
      ctx.moveTo(N.sx, N.sy);
      ctx.lineTo(E.sx, E.sy);
      ctx.lineTo(S.sx, S.sy);
      ctx.lineTo(W.sx, W.sy);
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
    const tl = worldToScreen(z.x,         z.y);
    const tr = worldToScreen(z.x + z.w,   z.y);
    const br = worldToScreen(z.x + z.w,   z.y + z.h);
    const bl = worldToScreen(z.x,         z.y + z.h);

    ctx.beginPath();
    ctx.moveTo(tl.sx, tl.sy);
    ctx.lineTo(tr.sx, tr.sy);
    ctx.lineTo(br.sx, br.sy);
    ctx.lineTo(bl.sx, bl.sy);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255, 220, 50, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Rótulo da sala
    const cx2 = (tl.sx + tr.sx + br.sx + bl.sx) / 4;
    const cy2 = (tl.sy + tr.sy + br.sy + bl.sy) / 4;
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
 * Cada item: { depth, sx, sy, object }
 * (campo 'sprite' mantido como alias de 'object' para compatibilidade com
 *  qualquer código que leia getSceneObjects().sprite)
 *
 * @returns {Array<{depth:number, sx:number, sy:number, sprite:string, object:string, scaleObj:number}>}
 */
export function getSceneObjects() {
  const objects = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const { object } = getCellData(col, row);
      if (!object) continue;
      // sx/sy = ponto N (topo do losango) — mesma referência de tileScreen
      const { sx: sx0, sy: sy0 } = worldToScreen(col * WORLD_TILE, row * WORLD_TILE);
      objects.push({
        depth: depthKey(col, row),
        sx: sx0,
        sy: sy0,
        sprite: object,   // alias para compatibilidade
        object,
        scaleObj: 1,
      });
    }
  }
  return objects;
}
