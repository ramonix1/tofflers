/**
 * spatial.js — Regras de proximidade espacial COMPARTILHADAS entre o cliente
 * (áudio/vídeo por bolha) e o servidor (filtro do canal de chat "Local").
 *
 * Módulo ESM puro: sem APIs de DOM nem de Node, importável dos dois lados.
 * Manter aqui a fonte única da verdade evita que a bolha de texto e a de
 * áudio saiam de sincronia.
 */

/** Raio da "bolha" de proximidade em pixels. Dentro dele você ouve/lê o peer. */
export const AUDIO_RADIUS = 160; // 5 tiles (TILE = 32)

/**
 * Núcleo de volume cheio: dentro dessa fração do raio, o ganho é 1.0.
 * Fora do núcleo, o volume cai gradualmente até 0 na borda (falloff estilo Gather).
 */
const FULL_CORE = 0.35;

/**
 * Margem de histerese: uma conexão já aberta só é derrubada quando o peer
 * passa deste raio (maior que AUDIO_RADIUS) — evita ligar/desligar no vai-e-vem
 * exatamente na borda da bolha.
 */
export const KEEPALIVE_RADIUS = AUDIO_RADIUS + 48;

/** Distância euclidiana entre dois pontos {x, y}. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Ganho de volume (0..1) para um peer a `dist` pixels, com falloff gradual.
 * Cheio até FULL_CORE*raio; cai linearmente até 0 na borda do raio.
 * @param {number} dist
 * @param {number} [radius=AUDIO_RADIUS]
 * @returns {number}
 */
export function gainForDistance(dist, radius = AUDIO_RADIUS) {
  const core = radius * FULL_CORE;
  if (dist <= core) return 1;
  if (dist >= radius) return 0;
  return 1 - (dist - core) / (radius - core);
}
