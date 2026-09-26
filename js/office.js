/**
 * office.js — Mapa 2D do escritório, tiles, zonas e render do cenário.
 *
 * Coordenadas: pixels no canvas (sem scroll).
 * Tile size: 32×32 px  →  mapa 25×18 tiles = 800×576 px
 */

export const TILE = 32;
export const COLS = 25;
export const ROWS = 18;
export const MAP_W = COLS * TILE; // 800
export const MAP_H = ROWS * TILE; // 576

/**
 * Tipos de tile:
 *   0 = piso livre
 *   1 = parede externa
 *   2 = mesa/obstáculo
 *   3 = cadeira (passável, só visual)
 *   4 = piso copa (textura diferente)
 *   5 = piso sala de reunião
 *   6 = piso recepção
 *   7 = planta (obstáculo decorativo)
 *   8 = balcão/sofá (obstáculo)
 */
const W = 1; // parede
const _ = 0; // piso livre
const M = 2; // mesa
const C = 3; // cadeira
const K = 4; // copa
const R = 5; // sala de reunião
const E = 6; // recepção
const P = 7; // planta
const S = 8; // sofá/balcão

// prettier-ignore
export const MAP = [
//  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24
  [ W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W ], // 0
  [ W, E, E, E, E, E, E, E, W, _, _, _, _, _, _, _, W, K, K, K, K, K, K, K, W ], // 1
  [ W, E, S, S, E, S, S, E, W, _, _, M, _, M, _, _, W, K, K, P, K, K, P, K, W ], // 2
  [ W, E, E, E, E, E, E, E, W, _, _, C, _, C, _, _, W, K, K, K, K, K, K, K, W ], // 3
  [ W, E, P, E, E, E, P, E, W, M, _, _, _, _, _, M, W, K, S, S, S, K, K, K, W ], // 4
  [ W, E, E, E, E, E, E, E, W, C, _, _, _, _, _, C, W, K, K, K, K, K, K, K, W ], // 5
  [ W, W, W, E, W, W, W, W, W, _, _, _, _, _, _, _, W, W, W, K, W, W, W, W, W ], // 6
  [ W, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, K, _, _, _, _, W ], // 7
  [ W, _, M, C, M, _, _, _, _, _, R, R, R, R, R, _, _, _, _, K, _, M, C, M, W ], // 8
  [ W, _, C, _, C, _, _, _, _, _, R, R, R, R, R, _, _, _, _, K, _, C, _, C, W ], // 9
  [ W, _, M, C, M, _, _, _, _, _, R, M, M, M, R, _, _, _, _, _, _, M, C, M, W ], // 10
  [ W, _, _, _, _, _, _, _, _, _, R, C, C, C, R, _, _, _, _, _, _, _, _, _, W ], // 11
  [ W, _, M, C, M, _, _, _, _, _, R, R, R, R, R, _, _, _, _, _, _, M, C, M, W ], // 12
  [ W, _, C, _, C, _, _, _, _, _, R, R, R, R, R, _, _, _, _, _, _, C, _, C, W ], // 13
  [ W, _, M, C, M, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, M, C, M, W ], // 14
  [ W, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _, W ], // 15
  [ W, P, _, _, _, _, P, _, _, _, _, P, _, _, _, P, _, _, _, _, P, _, _, _, W ], // 16
  [ W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W, W ], // 17
];

/**
 * Zonas nomeadas — retângulos em pixels (x, y, w, h).
 * Usadas para UI e detecção de presença.
 */
export const ZONES = {
  recepcao:      { label: 'Recepção',          x: 1*TILE,  y: 1*TILE,  w: 7*TILE,  h: 6*TILE,  color: 'rgba(99,102,241,0.06)' },
  copa:          { label: 'Copa / Lounge',      x: 17*TILE, y: 1*TILE,  w: 7*TILE,  h: 7*TILE,  color: 'rgba(34,197,94,0.06)'  },
  devA:          { label: 'Estações Dev',       x: 1*TILE,  y: 7*TILE,  w: 7*TILE,  h: 8*TILE,  color: 'rgba(59,130,246,0.06)' },
  devB:          { label: 'Estações Dev',       x: 21*TILE, y: 7*TILE,  w: 3*TILE,  h: 8*TILE,  color: 'rgba(59,130,246,0.06)' },
  reuniao:       { label: 'Sala de Reunião',    x: 10*TILE, y: 8*TILE,  w: 5*TILE,  h: 6*TILE,  color: 'rgba(168,85,247,0.10)' },
};

/** Retorna true se a posição (cx, cy) — centro do avatar — colide com tile sólido. */
export function isSolid(tileType) {
  return tileType === W || tileType === M || tileType === P || tileType === S;
}

/** Checa colisão de uma entidade (px, py) com raio r contra todos os tiles sólidos. */
export function collidesWithMap(px, py, r = 10) {
  // Checa os 4 cantos do bounding box quadrado
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
    if (isSolid(MAP[row][col])) return true;
  }
  return false;
}

/** Retorna a zona em que o ponto (px, py) se encontra, ou null. */
export function getZoneAt(px, py) {
  for (const [key, z] of Object.entries(ZONES)) {
    if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) {
      return { key, ...z };
    }
  }
  return null;
}

// ── Paleta de cores dos tiles ──────────────────────────────────────────────

const TILE_COLORS = {
  [W]: { fill: '#151a2b', stroke: '#0e1220' },   // parede (mais escura p/ contraste com o piso)
  [_]: { fill: '#333c5c', stroke: null },         // piso padrão (mais claro)
  [M]: { fill: '#3d2e1e', stroke: '#2a1e10' },   // mesa
  [C]: { fill: '#333c5c', stroke: null },         // base da cadeira = cor do piso
  [K]: { fill: '#2b4a39', stroke: null },         // piso copa (mais claro)
  [R]: { fill: '#332c58', stroke: null },         // piso reunião (mais claro)
  [E]: { fill: '#3a4574', stroke: null },         // piso recepção (bem mais claro que a parede — saída visível)
  [P]: { fill: '#1a2a1a', stroke: null },         // planta base
  [S]: { fill: '#2a2040', stroke: '#1a1430' },   // sofá/balcão
};

/**
 * Desenha o mapa inteiro no contexto 2D.
 * Chamado uma vez por frame (o canvas é limpo antes).
 */
export function renderOffice(ctx) {
  // 1. Tiles base
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      const x = col * TILE;
      const y = row * TILE;
      const tc = TILE_COLORS[tile] || TILE_COLORS[_];

      ctx.fillStyle = tc.fill;
      ctx.fillRect(x, y, TILE, TILE);

      if (tc.stroke) {
        ctx.strokeStyle = tc.stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      }
    }
  }

  // 2. Grade suave sobre piso livre
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 0.5;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      if (tile === _ || tile === K || tile === R || tile === E || tile === C) {
        ctx.strokeRect(col * TILE + 0.5, row * TILE + 0.5, TILE - 1, TILE - 1);
      }
    }
  }

  // 3. Detalhes visuais dos tiles especiais
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tile = MAP[row][col];
      const x = col * TILE;
      const y = row * TILE;

      if (tile === M) {
        // Mesa — superfície arredondada
        ctx.fillStyle = '#5c3d1e';
        ctx.beginPath();
        ctx.roundRect(x + 3, y + 3, TILE - 6, TILE - 6, 4);
        ctx.fill();
        // Reflexo
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 5, y + 5, TILE - 10, 4);
      }

      if (tile === C) {
        // Cadeira — quadradinho centralizado
        ctx.fillStyle = '#2e3860';
        ctx.beginPath();
        ctx.roundRect(x + 7, y + 7, TILE - 14, TILE - 14, 4);
        ctx.fill();
      }

      if (tile === P) {
        // Planta — círculo verde
        ctx.fillStyle = '#14532d';
        ctx.beginPath();
        ctx.arc(x + TILE / 2, y + TILE / 2, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#16a34a';
        ctx.beginPath();
        ctx.arc(x + TILE / 2 - 3, y + TILE / 2 - 3, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(x + TILE / 2 + 2, y + TILE / 2 - 4, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (tile === S) {
        // Sofá/balcão
        ctx.fillStyle = '#312060';
        ctx.beginPath();
        ctx.roundRect(x + 3, y + 4, TILE - 6, TILE - 8, 5);
        ctx.fill();
        // almofada
        ctx.fillStyle = '#3d2880';
        ctx.fillRect(x + 6, y + 8, TILE - 12, 8);
      }

      if (tile === W) {
        // Parede — borda interna
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
      }
    }
  }

  // 4. Zonas coloridas + labels
  ctx.save();
  for (const [, z] of Object.entries(ZONES)) {
    // fill suave
    ctx.fillStyle = z.color;
    ctx.fillRect(z.x, z.y, z.w, z.h);

    // borda tracejada
    ctx.strokeStyle = z.color.replace(/[\d.]+\)$/, '0.3)');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.w - 1, z.h - 1);
    ctx.setLineDash([]);

    // label centralizado
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(z.label.toUpperCase(), z.x + z.w / 2, z.y + 4);
  }
  ctx.restore();
}
