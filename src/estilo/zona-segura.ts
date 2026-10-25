// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Zona segura de Instagram Reels y la forma de las decisiones de un estilo sobre ella. Todo en px de la base 1080×1920.
 *
 * Fuente: la guía pública "Instagram Reels Safe Zone Guide 2025" (1080×1920):
 *   - arriba se pierden 220 px (y < 220) y abajo 320 px (y > 1600: usuario, caption y música);
 *   - caja magenta 1010×1440 (x 35–1045, y 240–1680); miniatura 4:5 1080×1350 (y 285–1635);
 *   - zona cian de texto y miniatura 810×1080 (x 135–945, y 420–1500);
 *   - columna de íconos (likes, comentarios, compartir, ⋮, audio) a la derecha, x ≈ 960–1050, y ≈ 1280–1860.
 *
 * Las decisiones de cada estilo (bajar subtítulos y capas, achicar tarjetas, dejar que las capas tapen la cara) NO
 * viven aquí: van en estilo/estilos/<id>/perfil.json → motor.zona (herramientas/lib/perfil-estilo.ts las lee y
 * MOTOR_NEUTRO trae la zona neutra). Se aplican encima de lo medido en herramientas/lib/estilo.ts y
 * lib/director/estilo.ts, y llegan al render escritas en la EDL (edicion.estilos.*).
 * Puro: sin React, sin Remotion y sin Node.
 */

export const FUENTE_ZONA_SEGURA = 'guía pública de zona segura de Instagram Reels 2025 (Instagram Reels Safe Zone Guide, 1080×1920)';

/** Caja en px base: [x0, x1] × [y0, y1]. */
export type CajaZona = {x0: number; y0: number; x1: number; y1: number};

/** Las zonas de la guía, tal cual. */
export const GUIA_REELS = {
	/** Lo que se pierde arriba (y < 220) y abajo (y > 1600). */
	arriba: 220,
	abajo: 1600,
	magenta: {x0: 35, x1: 1045, y0: 240, y1: 1680},
	miniatura: {x0: 0, x1: 1080, y0: 285, y1: 1635},
	cian: {x0: 135, x1: 945, y0: 420, y1: 1500},
	iconos: {x0: 960, x1: 1050, y0: 1280, y1: 1860},
} as const;

/**
 * Límites que usan el layout, el director y validar.ts (R12):
 *  - capas: tarjetas, stickers, logos, emojis y prompts. Horizontal la zona cian (x 135–945); vertical los límites
 *    duros de la guía (y 220–1600).
 *  - subtitulos: pueden bajar más que la zona cian ("más cerca del usuario") mientras su borde de abajo quede
 *    ≤ 1590 (10 px de aire sobre el nombre de usuario); a lo ancho, la zona cian.
 *  - amplias: titular e inserts en tarjeta. Dentro de la caja magenta a lo ancho y de los límites duros a lo alto,
 *    y sin tocar la columna de íconos (x > 945 entre y 1280 y 1600).
 * Los inserts a pantalla completa y el video base no aplican.
 */
export const ZONA_SEGURA = {
	capas: {x0: GUIA_REELS.cian.x0, x1: GUIA_REELS.cian.x1, y0: GUIA_REELS.arriba, y1: GUIA_REELS.abajo},
	subtitulos: {x0: GUIA_REELS.cian.x0, x1: GUIA_REELS.cian.x1, y0: GUIA_REELS.arriba, y1: 1590},
	amplias: {x0: GUIA_REELS.magenta.x0, x1: GUIA_REELS.magenta.x1, y0: GUIA_REELS.arriba, y1: GUIA_REELS.abajo},
	/** Columna de íconos que nada puede tocar (con 15 px de aire a la izquierda: desde x = 945). */
	iconos: {x0: GUIA_REELS.cian.x1, x1: 1080, y0: GUIA_REELS.iconos.y0, y1: GUIA_REELS.abajo},
} as const satisfies Record<string, CajaZona>;

export type ClaseZona = 'capa' | 'subtitulo' | 'amplia';

const r1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Qué se sale de la zona segura (vacío = cabe). `caja` es lo que SE VE de la capa (como la miden layout.ts y validar.ts).
 * Tolerancia de 0.5 px por redondeos.
 */
export function fueraDeZona(caja: CajaZona, clase: ClaseZona): string[] {
	const z = clase === 'capa' ? ZONA_SEGURA.capas : clase === 'subtitulo' ? ZONA_SEGURA.subtitulos : ZONA_SEGURA.amplias;
	const tol = 0.5;
	const fuera: string[] = [];
	if (caja.y0 < z.y0 - tol) fuera.push(`sube a y=${r1(caja.y0)} (límite de arriba ${z.y0}: lo tapa la interfaz de arriba)`);
	if (caja.y1 > z.y1 + tol) fuera.push(`baja a y=${r1(caja.y1)} (límite de abajo ${z.y1}: ${clase === 'subtitulo' ? 'aire sobre tu nombre de usuario' : 'lo tapan tu nombre, el caption y la música'})`);
	if (caja.x0 < z.x0 - tol) fuera.push(`se sale a la izquierda hasta x=${r1(caja.x0)} (límite ${z.x0})`);
	if (caja.x1 > z.x1 + tol) fuera.push(`se sale a la derecha hasta x=${r1(caja.x1)} (límite ${z.x1})`);
	const ic = ZONA_SEGURA.iconos;
	if (clase === 'amplia' && caja.x1 > ic.x0 + tol && caja.y1 > ic.y0 + tol && caja.y0 < ic.y1 - tol) {
		fuera.push(`toca la columna de íconos (x > ${ic.x0} entre y ${ic.y0}–${ic.y1}; ocupa x hasta ${r1(caja.x1)}, y ${r1(caja.y0)}–${r1(caja.y1)})`);
	}
	return fuera;
}

// ───────────────────────── decisiones del estilo ─────────────────────────

/**
 * Lo que un estilo decide sobre lo medido (perfil.json → motor.zona; no es medición: manda sobre estilo.json).
 *  - subtitulos_y: centro de las mayúsculas de los subtítulos (null = el medido). Con letra de ~59 px y borde de ~4 px,
 *    1545 deja el borde de abajo de una "g" en ≈ 1585 (≤ 1590).
 *  - bajada_capas_px: lo que bajan tarjetas, prompts y stickers (su centro y su rango). Si es lo mismo que bajan los
 *    subtítulos, el aire entre tarjeta y subtítulo queda como en lo medido.
 *  - tarjeta_letra: escala del alto de mayúscula de las tarjetas (y de su interlineado y radio).
 *  - tarjeta_relleno: escala del relleno blanco alrededor del texto (arriba, abajo y a los lados).
 *  - prompt_letra: escala de la letra de la variante prompt (se achica menos para que se siga leyendo).
 *  - ancho_max: ancho máximo de tarjetas y prompts (la zona cian mide 810 px): si no cabe, se parte en renglones.
 *  - puede_tapar_cara / margen_boca_px: con true, las tarjetas, listas y stickers van en su lugar medido aunque tapen
 *    boca o barba; el margen que usan el director y validar.ts (R1) es margen_boca_px (−1920 = sin límite). Con false
 *    (o margen null) el borde de arriba queda ≥ boca + el margen supuesto del director.
 *  - nota / nota_cara: de dónde sale la decisión (va a la EDL y a direccion.md).
 */
export type DecisionZona = {
	subtitulos_y: number | null;
	bajada_capas_px: number;
	tarjeta_letra: number;
	tarjeta_relleno: number;
	prompt_letra: number;
	ancho_max: number;
	nota: string;
	puede_tapar_cara: boolean;
	margen_boca_px: number | null;
	nota_cara: string;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Aplica la decisión de zona de un estilo a un estilo PARCIAL de tarjetas (lo de estilo.json → tarjetas.config, o el
 * de una edición): letra × tarjeta_letra, relleno × tarjeta_relleno, centro y + bajada_capas_px, ancho máximo =
 * ancho_max, y lo mismo al prompt (con su propia letra). Solo toca los campos que trae o los que tienen valor por defecto
 * conocido en `porDefecto` (src/estilo/capas.ts → ESTILO_TARJETA_POR_DEFECTO). Pura.
 */
export function aplicarDecisionTarjetas(
	parcial: Record<string, unknown>,
	porDefecto: {alto_mayuscula_px: number; pad_arriba_px: number; pad_abajo_px: number; pad_lados_px: number; radio_px: number; interlineado_px: number; y: number; prompt: {alto_mayuscula_px: number; interlineado_px: number; pad_arriba_px: number; pad_abajo_px: number; pad_lados_px: number; y: number}},
	d: DecisionZona,
): Record<string, unknown> {
	const v = (k: keyof typeof porDefecto & string): number => num(parcial[k]) ?? (porDefecto[k] as number);
	const promptPrevio = typeof parcial.prompt === 'object' && parcial.prompt !== null ? (parcial.prompt as Record<string, unknown>) : {};
	const p = (k: keyof typeof porDefecto.prompt): number => num(promptPrevio[k]) ?? porDefecto.prompt[k];
	return {
		...parcial,
		alto_mayuscula_px: r2(v('alto_mayuscula_px') * d.tarjeta_letra),
		interlineado_px: r2(v('interlineado_px') * d.tarjeta_letra),
		radio_px: r2(v('radio_px') * d.tarjeta_letra),
		pad_arriba_px: r2(v('pad_arriba_px') * d.tarjeta_relleno),
		pad_abajo_px: r2(v('pad_abajo_px') * d.tarjeta_relleno),
		pad_lados_px: r2(v('pad_lados_px') * d.tarjeta_relleno),
		ancho_max: d.ancho_max,
		y: r2(v('y') + d.bajada_capas_px),
		prompt: {
			...promptPrevio,
			alto_mayuscula_px: r2(p('alto_mayuscula_px') * d.prompt_letra),
			interlineado_px: r2(p('interlineado_px') * d.prompt_letra),
			pad_arriba_px: r2(p('pad_arriba_px') * d.tarjeta_relleno),
			pad_abajo_px: r2(p('pad_abajo_px') * d.tarjeta_relleno),
			pad_lados_px: r2(p('pad_lados_px') * d.tarjeta_relleno),
			ancho_max: d.ancho_max,
			y: r2(p('y') + d.bajada_capas_px),
		},
		decision: d.nota,
	};
}
