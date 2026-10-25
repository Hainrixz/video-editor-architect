// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Anclaje de un motion flotante a tu cabeza: la mediana de la caja de tu cara (cara.json) en el tramo del insert.
 * El director la calcula y la escribe en `motion.ancla` (Remotion no lee cara.json al renderizar).
 *
 * Puro: sin React, sin Remotion y sin Node. Unidades: px base 1080×1920 (las de cara.json) y segundos de la base.
 */

export type CuadroCara = {t: number; cara?: {x: number; y: number; w: number; h: number} | null; coronilla_y?: number; barbilla_y?: number};
export type Ancla = {x: number; y: number; lado: number; coronilla_y: number | null; barbilla_y: number | null; n: number};

const mediana = (xs: number[]): number => {
	const a = [...xs].sort((p, q) => p - q);
	const m = Math.floor(a.length / 2);
	return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/**
 * Centro (x, y) y lado de la cara (mediana en [desde, hasta)), × `factor` para el lado (1.12: la plantilla de Apple
 * abraza la cara con aire). null si no hay cara medida en el tramo.
 */
export function anclaCabeza(cuadros: readonly CuadroCara[], desde: number, hasta: number, factor = 1.12): Ancla | null {
	const q = cuadros.filter((c) => c.t >= desde && c.t < hasta && c.cara && c.cara.w > 0);
	if (!q.length) return null;
	const cs = q.map((c) => c.cara!);
	const coron = q.map((c) => c.coronilla_y).filter((v): v is number => typeof v === 'number');
	const barb = q.map((c) => c.barbilla_y).filter((v): v is number => typeof v === 'number');
	const r = (v: number) => Math.round(v);
	return {
		x: r(mediana(cs.map((c) => c.x + c.w / 2))),
		y: r(mediana(cs.map((c) => c.y + c.h / 2))),
		lado: r(mediana(cs.map((c) => c.w)) * factor),
		coronilla_y: coron.length ? r(Math.min(...coron)) : null,
		barbilla_y: barb.length ? r(Math.max(...barb)) : null,
		n: q.length,
	};
}

// ───────────────────────── pista de la cabeza cuadro por cuadro ─────────────────────────

/**
 * Pista de tu cabeza para un motion libre (rediseño 2 del 2026-10-04, críticas de la v14: "la plantilla se queda fija
 * mientras él se mueve"). Una fila por cuadro de 30 fps desde `inicio` (cuadros relativos al `desde` del insert; puede
 * ser negativo para cubrir la rampa de antes): [centro x, centro y, ancho, alto de la caja de la cara, coronilla_y,
 * barbilla_y, boca_y, centro x y ancho de la caja de la CABEZA (orejas y pelo: la silueta)], en px base, suavizada con una media centrada de `ventana` cuadros. La escribe el director
 * (plan.ts) desde cara.json; Remotion no lee cara.json al renderizar.
 */
export type FilaPista = [number, number, number, number, number, number, number, number, number];
export type PistaCabeza = {inicio: number; c: FilaPista[]};
export type CuadroCaraPista = CuadroCara & {boca_y?: number; cabeza?: {x: number; y: number; w: number; h: number} | null};

export function pistaCabeza(cuadros: readonly CuadroCaraPista[], desde: number, hasta: number, op: {antes?: number; ventana?: number; fps?: number} = {}): PistaCabeza | null {
	const fps = op.fps ?? 30;
	const antes = op.antes ?? 3;
	const ventana = Math.max(1, op.ventana ?? 7);
	const validos = cuadros.filter((c) => c.cara && c.cara.w > 0).sort((a, b) => a.t - b.t);
	if (!validos.length) return null;
	const f0 = Math.round(desde * fps) - antes;
	const f1 = Math.round(hasta * fps);
	const crudas: number[][] = [];
	let j = 0;
	for (let f = f0; f <= f1; f++) {
		const t = f / fps;
		while (j < validos.length - 1 && Math.abs(validos[j + 1].t - t) <= Math.abs(validos[j].t - t)) j++;
		const q = validos[j];
		const c = q.cara!;
		const cor = q.coronilla_y ?? c.y - 0.3 * c.h;
		const bar = q.barbilla_y ?? c.y + c.h;
		const boca = q.boca_y ?? c.y + 0.8 * c.h;
		const cab = q.cabeza && q.cabeza.w > 0 ? q.cabeza : {x: c.x + 0.05 * c.w, w: 0.9 * c.w};
		crudas.push([c.x + c.w / 2, c.y + c.h / 2, c.w, c.h, cor, bar, boca, cab.x + cab.w / 2, cab.w]);
	}
	const m = Math.floor(ventana / 2);
	const c: FilaPista[] = crudas.map((_, i) => {
		const a = Math.max(0, i - m);
		const b = Math.min(crudas.length - 1, i + m);
		const fila = [0, 0, 0, 0, 0, 0, 0, 0, 0];
		for (let k = a; k <= b; k++) for (let z = 0; z < 9; z++) fila[z] += crudas[k][z];
		return fila.map((v) => Math.round(v / (b - a + 1))) as FilaPista;
	});
	return {inicio: f0 - Math.round(desde * fps), c};
}

/** cx…boca: la caja de la cara (Vision); cabCx, cabW: la caja de la cabeza (silueta: orejas y pelo). */
export type Cabeza = {cx: number; cy: number; w: number; h: number; coronilla: number; barbilla: number; boca: number; cabCx: number; cabW: number};

/** Tu cabeza en el cuadro f (relativo al insert, fraccionario: interpola entre filas; fuera de la pista, la orilla). */
export function cabezaEn(p: PistaCabeza, f: number): Cabeza {
	const n = p.c.length;
	const x = Math.min(n - 1, Math.max(0, f - p.inicio));
	const i = Math.floor(x);
	const k = x - i;
	const a = p.c[i];
	const b = p.c[Math.min(n - 1, i + 1)];
	const v = (z: number) => a[z] + (b[z] - a[z]) * k;
	return {cx: v(0), cy: v(1), w: v(2), h: v(3), coronilla: v(4), barbilla: v(5), boca: v(6), cabCx: v(7), cabW: v(8)};
}

/** Cabeza fija (sin pista): la de `ancla` o la mediana del diseño. */
export function cabezaFija(x: number, y: number, lado: number): Cabeza {
	const w = lado / 1.12;
	return {cx: x, cy: y, w, h: w, coronilla: y - 0.82 * w, barbilla: y + 0.55 * w, boca: y + 0.3 * w, cabCx: x - 0.08 * w, cabW: 0.9 * w};
}

/**
 * Lo que NUNCA se tapa (CLAUDE.md: "nada tapa boca, nariz ni ojos"): de las cejas a debajo de la boca y de mejilla a
 * mejilla. Calibrado contra un reel de referencia (cuadro 7.3 s): cejas ≈ caja.y + 0.16·h, boca = boca_y.
 */
export function zonaRostro(c: Cabeza): {x0: number; y0: number; x1: number; y1: number} {
	const y = c.cy - c.h / 2;
	return {x0: c.cx - 0.4 * c.w, x1: c.cx + 0.4 * c.w, y0: y + 0.1 * c.h, y1: c.boca + 0.07 * c.h};
}

/** Elipse de tu cabeza entera (de la coronilla a la barbilla, de oreja a oreja): la máscara del foco de retrato. */
export function elipseCabeza(c: Cabeza): {cx: number; cy: number; rx: number; ry: number} {
	const arriba = c.coronilla - 0.03 * c.h;
	const abajo = c.barbilla + 0.04 * c.h;
	return {cx: c.cabCx, cy: (arriba + abajo) / 2, rx: 0.5 * c.cabW, ry: (abajo - arriba) / 2};
}

/**
 * Elipse de la parte de ARRIBA de tu cabeza (la que recorta lo que va detrás de ti). Medido en un reel de referencia (7.3 s):
 * el ancho de tu cabeza a 60, 140 y 260 px bajo la coronilla es 300, 420 y 490 px; una elipse con rx = 0.475 ×
 * ancho de la silueta y ry = 0.56 × ancho, colgada de la coronilla, da 303, 423 y 494.
 */
export function elipseOclusion(c: Cabeza): {cx: number; cy: number; rx: number; ry: number} {
	const ry = 0.56 * c.cabW;
	return {cx: c.cabCx, cy: c.coronilla - 4 + ry, rx: 0.475 * c.cabW, ry};
}

/**
 * Tu cabeza ENTERA como dos elipses (px base): la de arriba (forma del cráneo, `elipseOclusion`, agrandada 8 % hacia
 * arriba para que el pelo no quede en la orilla) y la de la cara y la barba. Es la máscara del foco de retrato
 * (Flotante.tsx) y la oclusión completa de lo que va detrás de ti (M3).
 */
export function elipsesDeCabeza(c: Cabeza): Array<{cx: number; cy: number; rx: number; ry: number}> {
	const a = elipseOclusion(c);
	const arriba = {cx: a.cx, cy: a.cy - 0.04 * a.ry, rx: a.rx, ry: a.ry * 1.04};
	const y0 = c.coronilla + 0.3 * c.cabW;
	const y1 = c.barbilla + 0.03 * c.h;
	return [arriba, {cx: c.cabCx, cy: (y0 + y1) / 2, rx: 0.46 * c.cabW, ry: (y1 - y0) / 2}];
}

/** Punto de la base → pantalla con el push-in del fondo flotante (escala `s` alrededor de (540, 864), como Flotante.tsx). */
export const ORIGEN_PUSH = {x: 540, y: 864} as const;
export function cabezaEnPantalla(c: Cabeza, s: number): Cabeza {
	const px = (x: number) => ORIGEN_PUSH.x + (x - ORIGEN_PUSH.x) * s;
	const py = (y: number) => ORIGEN_PUSH.y + (y - ORIGEN_PUSH.y) * s;
	return {cx: px(c.cx), cy: py(c.cy), w: c.w * s, h: c.h * s, coronilla: py(c.coronilla), barbilla: py(c.barbilla), boca: py(c.boca), cabCx: px(c.cabCx), cabW: c.cabW * s};
}

/** ¿Se enciman dos cajas? */
export function seEnciman(a: {x0: number; y0: number; x1: number; y1: number}, b: {x0: number; y0: number; x1: number; y1: number}): boolean {
	return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
