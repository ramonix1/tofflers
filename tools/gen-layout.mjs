/**
 * gen-layout.mjs — Gerador reproduzível do layout do escritório virtual.
 *
 * Grade: 25 colunas (0-24) × 18 linhas (0-17), tile = 32px de mundo.
 *
 * Salas:
 *   recepcao  — cols 1-7,  rows 1-5   (paredes externas do quadrado)
 *   copa      — cols 17-23, rows 1-5  (paredes externas do quadrado)
 *   reuniao   — cols 10-14, rows 8-13 (paredes externas do quadrado)
 *   devA      — cols 1-7,  rows 8-16  (baias dev esquerda)
 *   devB      — cols 17-23, rows 8-16 (baias dev direita)
 *
 * Corredores: rows 6-7 (horizontal central) + cols 8-9 e 15-16 (laterais)
 *
 * Spawns (devem ficar LIVRES):
 *   (5,7)  (8,7)  (18,7)
 *   (5,11) (16,11)
 *   (8,13) (15,13)
 *   (6,15) (12,15) (20,15)
 *
 * Execute: node tools/gen-layout.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COLS = 25;
const ROWS = 18;
const TILE = 32;

// ── Células base ──────────────────────────────────────────────────────────────

function floor(type = 'floor')   { return { floor: type, solid: false, object: null }; }
function wall()                   { return { floor: 'floor', solid: true,  object: 'wall' }; }
function door()                   { return { floor: 'floor', solid: false, object: 'wall-door' }; }
function wallWindow()             { return { floor: 'floor', solid: true,  object: 'wall-window' }; }
function table(fl = 'floor')      { return { floor: fl,     solid: true,  object: 'table' }; }
function chair(fl = 'floor')      { return { floor: fl,     solid: false, object: 'chair' }; }
function computer(fl = 'floor')   { return { floor: fl,     solid: true,  object: 'computer' }; }
function container(fl = 'floor')  { return { floor: fl,     solid: true,  object: 'container' }; }
function structure(fl = 'floor')  { return { floor: fl,     solid: true,  object: 'structure' }; }
function bedSingle(fl = 'floor')  { return { floor: fl,     solid: true,  object: 'bed-single' }; }

// ── Inicializa grid com piso livre ────────────────────────────────────────────

const cells = [];
for (let r = 0; r < ROWS; r++) {
  cells.push(Array.from({ length: COLS }, () => floor('floor')));
}

// ── Utilitários de desenho ────────────────────────────────────────────────────

function set(col, row, cell) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return;
  cells[row][col] = cell;
}

function get(col, row) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return null;
  return cells[row][col];
}

/** Preenche um retângulo de células com a célula dada. */
function fillRect(c0, r0, w, h, cellFn) {
  for (let r = r0; r < r0 + h; r++) {
    for (let c = c0; c < c0 + w; c++) {
      set(c, r, cellFn());
    }
  }
}

/**
 * Desenha o perímetro (borda) de um retângulo com paredes.
 * cellFn(col, row) → célula — permite portas em posições específicas.
 */
function drawPerimeter(c0, r0, w, h, cellFn) {
  for (let c = c0; c < c0 + w; c++) {
    set(c, r0,         cellFn(c, r0));
    set(c, r0 + h - 1, cellFn(c, r0 + h - 1));
  }
  for (let r = r0 + 1; r < r0 + h - 1; r++) {
    set(c0,         r, cellFn(c0, r));
    set(c0 + w - 1, r, cellFn(c0 + w - 1, r));
  }
}

// ── 1. PERÍMETRO EXTERNO ──────────────────────────────────────────────────────
// Toda a borda do mapa é parede sólida.
// Porta de entrada: col 12, row 0 (sul do mapa seria row 17; entrada no topo é pouco usada)
// Fazemos a entrada principal no corredor: porta no perímetro externo em col 4, row 0
// (ligando ao espaço interno)

for (let c = 0; c < COLS; c++) {
  set(c, 0,        wall());
  set(c, ROWS - 1, wall());
}
for (let r = 0; r < ROWS; r++) {
  set(0,        r, wall());
  set(COLS - 1, r, wall());
}

// Porta de entrada na parede norte (para o mundo exterior simbólico) — col 12, row 0
set(12, 0, door());

// Janelas na parede sul (decorativas)
set(4,  ROWS - 1, wallWindow());
set(5,  ROWS - 1, wallWindow());
set(10, ROWS - 1, wallWindow());
set(11, ROWS - 1, wallWindow());
set(13, ROWS - 1, wallWindow());
set(14, ROWS - 1, wallWindow());
set(19, ROWS - 1, wallWindow());
set(20, ROWS - 1, wallWindow());

// ── 2. PISO POR ÁREA ─────────────────────────────────────────────────────────

// Área interna toda como piso base primeiro (já está, mas definimos por zonas)
// Corredor central (rows 6-7, cols 1-23)
for (let r = 6; r <= 7; r++) {
  for (let c = 1; c < COLS - 1; c++) {
    set(c, r, floor('floor'));
  }
}

// Corredor lateral esquerdo (cols 8-9, rows 1-16)
for (let r = 1; r <= 16; r++) {
  for (let c = 8; c <= 9; c++) {
    set(c, r, floor('floor'));
  }
}

// Corredor lateral direito (cols 15-16, rows 1-16)
for (let r = 1; r <= 16; r++) {
  for (let c = 15; c <= 16; c++) {
    set(c, r, floor('floor'));
  }
}

// Recepção — piso floor-corner
for (let r = 1; r <= 5; r++) {
  for (let c = 1; c <= 7; c++) {
    set(c, r, floor('floor-corner'));
  }
}

// Copa — piso floor-detail
for (let r = 1; r <= 5; r++) {
  for (let c = 17; c <= 23; c++) {
    set(c, r, floor('floor-detail'));
  }
}

// Reunião — piso floor-panel
for (let r = 8; r <= 13; r++) {
  for (let c = 10; c <= 14; c++) {
    set(c, r, floor('floor-panel'));
  }
}

// Dev A — piso floor (cols 1-7, rows 8-16)
for (let r = 8; r <= 16; r++) {
  for (let c = 1; c <= 7; c++) {
    set(c, r, floor('floor'));
  }
}

// Dev B — piso floor (cols 17-23, rows 8-16)
for (let r = 8; r <= 16; r++) {
  for (let c = 17; c <= 23; c++) {
    set(c, r, floor('floor'));
  }
}

// Corredor central baixo (rows 8-16, cols 10-14 ja sera reunião + laterais cols 8-9, 15-16)
// Zona livre no centro (cols 10-14, rows 6-7, e rows 14-16)
for (let r = 14; r <= 16; r++) {
  for (let c = 10; c <= 14; c++) {
    set(c, r, floor('floor'));
  }
}

// ── 3. PAREDES DAS SALAS ──────────────────────────────────────────────────────

// === RECEPÇÃO (cols 1-7, rows 1-5) ===
// Paredes do perímetro da sala. Porta na parede sul (row 5) em col 4
// (saída para o corredor row 6).
{
  const doors = new Set(['4,5']); // col 4, row 5 = porta sul
  drawPerimeter(1, 1, 7, 5, (c, r) => {
    if (doors.has(`${c},${r}`)) return door();
    return wall();
  });
  // Piso interno da recepção (interior da sala = dentro das paredes)
  for (let r = 2; r <= 4; r++) {
    for (let c = 2; c <= 6; c++) {
      set(c, r, floor('floor-corner'));
    }
  }
}

// === COPA (cols 17-23, rows 1-5) ===
// Porta na parede sul (row 5) em col 20
{
  const doors = new Set(['20,5']); // col 20, row 5 = porta sul
  drawPerimeter(17, 1, 7, 5, (c, r) => {
    if (doors.has(`${c},${r}`)) return door();
    return wall();
  });
  // Piso interno copa
  for (let r = 2; r <= 4; r++) {
    for (let c = 18; c <= 22; c++) {
      set(c, r, floor('floor-detail'));
    }
  }
}

// === SALA DE REUNIÃO (cols 10-14, rows 8-13) ===
// Porta na parede norte (row 8) em col 12
{
  const doors = new Set(['12,8']); // col 12, row 8 = porta norte
  drawPerimeter(10, 8, 5, 6, (c, r) => {
    if (doors.has(`${c},${r}`)) return door();
    return wall();
  });
  // Piso interno reunião
  for (let r = 9; r <= 12; r++) {
    for (let c = 11; c <= 13; c++) {
      set(c, r, floor('floor-panel'));
    }
  }
}

// === DEV A (cols 1-7, rows 8-16) ===
// Porta na parede norte (row 8) em col 4
// Porta na parede sul (row 16) em col 4 (ligação ao corredor row 16 livre)
// Nota: row 16 é parede sul da sala devA, mas a parede externa (row 17) fecha
{
  const doors = new Set(['4,8', '4,16']);
  drawPerimeter(1, 8, 7, 9, (c, r) => {
    if (doors.has(`${c},${r}`)) return door();
    return wall();
  });
  // Piso interno devA
  for (let r = 9; r <= 15; r++) {
    for (let c = 2; c <= 6; c++) {
      set(c, r, floor('floor'));
    }
  }
}

// === DEV B (cols 17-23, rows 8-16) ===
// Porta na parede norte (row 8) em col 20
// Porta na parede sul (row 16) em col 20
{
  const doors = new Set(['20,8', '20,16']);
  drawPerimeter(17, 8, 7, 9, (c, r) => {
    if (doors.has(`${c},${r}`)) return door();
    return wall();
  });
  // Piso interno devB
  for (let r = 9; r <= 15; r++) {
    for (let c = 18; c <= 22; c++) {
      set(c, r, floor('floor'));
    }
  }
}

// ── 4. MÓVEIS ─────────────────────────────────────────────────────────────────

// === RECEPÇÃO: balcão de atendimento + cadeiras ===
// Balcão (container) na parede norte interior
set(2, 2, container('floor-corner'));
set(3, 2, container('floor-corner'));
set(5, 2, container('floor-corner'));
set(6, 2, container('floor-corner'));
// Planta decorativa nos cantos
set(2, 4, structure('floor-corner'));
set(6, 4, structure('floor-corner'));
// Cadeiras para visitantes
set(3, 4, chair('floor-corner'));
set(5, 4, chair('floor-corner'));

// === COPA: balcão + sofá lounge + cadeiras ===
// Balcão (container) na parede norte interior
set(18, 2, container('floor-detail'));
set(19, 2, container('floor-detail'));
set(21, 2, container('floor-detail'));
set(22, 2, container('floor-detail'));
// Sofá/lounge
set(18, 4, bedSingle('floor-detail'));
// Cadeiras de lounge
set(20, 4, chair('floor-detail'));
set(22, 4, chair('floor-detail'));
// Planta decorativa
set(22, 3, structure('floor-detail'));

// === SALA DE REUNIÃO: mesa grande central + cadeiras ===
// Mesa grande: 3 posições no meio
set(11, 10, table('floor-panel'));
set(12, 10, table('floor-panel'));
set(13, 10, table('floor-panel'));
// Cadeiras ao redor
set(11, 9,  chair('floor-panel'));  // norte
set(12, 9,  chair('floor-panel'));
set(13, 9,  chair('floor-panel'));
set(11, 11, chair('floor-panel'));  // sul
set(12, 11, chair('floor-panel'));
set(13, 11, chair('floor-panel'));

// === DEV A: baias com mesa + computador + cadeira ===
// Baia 1 (row 9-10, cols 2-3)
set(2, 9,  table('floor'));
set(3, 9,  table('floor'));
set(2, 10, computer('floor'));
set(3, 10, chair('floor'));
// Baia 2 (row 9-10, cols 5-6)
set(5, 9,  table('floor'));
set(6, 9,  table('floor'));
set(5, 10, computer('floor'));
set(6, 10, chair('floor'));
// Baia 3 (row 12-13, cols 2-3)
set(2, 12, table('floor'));
set(3, 12, table('floor'));
set(2, 13, computer('floor'));
set(3, 13, chair('floor'));
// Baia 4 (row 12-13, cols 5-6)
set(5, 12, table('floor'));
set(6, 12, table('floor'));
set(5, 13, computer('floor'));
set(6, 13, chair('floor'));
// Baia 5 (row 14-15, cols 2-3)
set(2, 14, table('floor'));
set(3, 14, table('floor'));
set(2, 15, computer('floor'));
set(3, 15, chair('floor'));
// Baia 6 (row 14-15, cols 5-6)
set(5, 14, table('floor'));
set(6, 14, table('floor'));
set(5, 15, computer('floor'));
set(6, 15, chair('floor'));  // spawn (6,15) = chair (passável, solid:false) — OK

// === DEV B: baias simétricas ===
// Baia 1 (row 9-10, cols 18-19)
set(18, 9,  table('floor'));
set(19, 9,  table('floor'));
set(18, 10, computer('floor'));
set(19, 10, chair('floor'));
// Baia 2 (row 9-10, cols 21-22)
set(21, 9,  table('floor'));
set(22, 9,  table('floor'));
set(21, 10, computer('floor'));
set(22, 10, chair('floor'));
// Baia 3 (row 12-13, cols 18-19)
set(18, 12, table('floor'));
set(19, 12, table('floor'));
set(18, 13, computer('floor'));
set(19, 13, chair('floor'));
// Baia 4 (row 12-13, cols 21-22)
set(21, 12, table('floor'));
set(22, 12, table('floor'));
set(21, 13, computer('floor'));
set(22, 13, chair('floor'));
// Baia 5 (row 14-15, cols 18-19)
set(18, 14, table('floor'));
set(19, 14, table('floor'));
set(18, 15, computer('floor'));
set(19, 15, chair('floor'));
// Baia 6 (row 14-15, cols 21-22)
set(21, 14, table('floor'));
set(22, 14, table('floor'));
set(21, 15, computer('floor'));
set(22, 15, chair('floor'));

// Plantas decorativas nos corredores
set(9,  6, structure('floor'));   // corredor horizontal
set(15, 6, structure('floor'));
set(9,  7, structure('floor'));
set(15, 7, structure('floor'));

// ── 5. VERIFICAÇÃO DOS SPAWNS ─────────────────────────────────────────────────

const SPAWN_POINTS = [
  { x: 176, y: 240 }, { x: 272, y: 240 }, { x: 592, y: 240 },
  { x: 176, y: 368 }, { x: 528, y: 368 }, { x: 272, y: 432 },
  { x: 496, y: 432 }, { x: 208, y: 496 }, { x: 400, y: 496 }, { x: 656, y: 496 },
];

console.log('\n=== Verificação dos SPAWN_POINTS ===');
let spawnOk = true;
for (const p of SPAWN_POINTS) {
  const col = Math.floor(p.x / TILE);
  const row = Math.floor(p.y / TILE);
  const cell = cells[row][col];
  const ok = !cell.solid;
  if (!ok) spawnOk = false;
  console.log(`  px(${p.x},${p.y}) -> cel(${col},${row}): solid=${cell.solid}, object=${cell.object} ${ok ? '✓' : '✗ BLOQUEADO!'}`);
}
if (!spawnOk) {
  console.error('\n⚠️  Há spawns em células sólidas! Corrija o mapa antes de usar.');
  process.exit(1);
}
console.log('  Todos os spawns estão livres ✓\n');

// ── 6. ZONAS ──────────────────────────────────────────────────────────────────

const zones = {
  recepcao: {
    label: 'Recepção',
    x:  1 * TILE, y:  1 * TILE,
    w:  7 * TILE, h:  5 * TILE,
    color: 'rgba(99,102,241,0.06)',
  },
  copa: {
    label: 'Copa / Lounge',
    x: 17 * TILE, y:  1 * TILE,
    w:  7 * TILE, h:  5 * TILE,
    color: 'rgba(34,197,94,0.06)',
  },
  reuniao: {
    label: 'Sala de Reunião',
    x: 10 * TILE, y:  8 * TILE,
    w:  5 * TILE, h:  6 * TILE,
    color: 'rgba(168,85,247,0.10)',
  },
  devA: {
    label: 'Estações Dev A',
    x:  1 * TILE, y:  8 * TILE,
    w:  7 * TILE, h:  9 * TILE,
    color: 'rgba(59,130,246,0.06)',
  },
  devB: {
    label: 'Estações Dev B',
    x: 17 * TILE, y:  8 * TILE,
    w:  7 * TILE, h:  9 * TILE,
    color: 'rgba(59,130,246,0.06)',
  },
};

// ── 7. ESCREVE O ARQUIVO ──────────────────────────────────────────────────────

const layout = { cells, zones };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outPath   = path.resolve(scriptDir, '../data/layout.json');

writeFileSync(outPath, JSON.stringify(layout, null, 2), 'utf8');
console.log(`Layout escrito em: ${outPath}`);

// ── 8. RESUMO ─────────────────────────────────────────────────────────────────

const flat   = cells.flat();
const solids = flat.filter(c => c.solid).length;
const doors2  = flat.filter(c => c.object === 'wall-door').length;
const walls2  = flat.filter(c => c.object === 'wall').length;

console.log(`Linhas: ${cells.length}  Colunas: ${cells[0].length}`);
console.log(`Zonas: ${Object.keys(zones).length}`);
console.log(`Sólidos: ${solids}   Paredes: ${walls2}   Portas: ${doors2}`);
console.log('Geração concluída com sucesso!');
