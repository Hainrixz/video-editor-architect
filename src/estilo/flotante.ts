/**
 * Modo FLOTANTE de los motion graphics (inserts tipo "motion" con layout "flotante").
 *
 * Decisión del estilo (2026-10-04): las animaciones no sacan al creador de cuadro; aparecen encima de él, con su video
 * un poco desenfocado. NO es medido en los reels (ahí los inserts van a pantalla completa en corte).
 *
 * Qué hace mientras dura el insert:
 *  - Tu toma (el video base, con su zoom) se desenfoca un poco, se oscurece un poco y se acerca apenas (push-in),
 *    con rampas cortas de ease-out fuerte: nunca corte a negro. Tú sigues en pantalla.
 *  - La escena del motion (810 × 980) se dibuja encima SIN fondo de pantalla completa: solo una sombra suave
 *    (velo radial) detrás de ella para que se lea, y entra flotando (sube, crece de 0.94 y aparece).
 *  - Tarjetas, stickers, titular y subtítulos siguen encima de todo (Reel.tsx).
 *
 * Puro: sin React, sin Remotion y sin Node. Lo usan src/reel/Flotante.tsx, src/reel/motion/MotionInsert.tsx,
 * herramientas/layout.ts, herramientas/validar.ts y las pruebas. Unidades: cuadros a 30 fps y px BASE 1080×1920.
 */
import {CURVAS, ESCENA} from './motion';
import {ANTES_LIBRE, CAJA_LIBRE, ENTRADA_FONDO_LIBRE, FOCO_SALIDA, FONDO_DISENO, esLibre} from './motion-libre';
import {cabezaEn, cabezaEnPantalla, elipsesDeCabeza, type PistaCabeza} from './anclaje';

export const FUENTE_FLOTANTE = 'decisión del estilo del 2026-10-04 (los motions flotan encima del creador, con el video en blur), no medido';

/**
 * Parámetros del fondo y de la escena (supuestos de diseño, ajustables).
 *  - blur_px: desenfoque de tu toma en px base (×4/3 en el lienzo). 14: se te reconoce, pero ya no compite.
 *  - oscurecer: cuánto baja el brillo de tu toma (0.16 = 16 %).
 *  - escala: push-in de tu toma (1.045 = 4.5 %). También tapa las orillas del desenfoque.
 *  - entrada / salida: cuadros de las rampas (8 y 7: ~0.25 s, ease-out fuerte cubic-bezier(0.23, 1, 0.32, 1)).
 *  - escena_*: cómo entra y sale la escena (sube 28 px y crece de 0.94 en 9 cuadros; sale bajando a 0.97 en 6).
 *  - velo: sombra radial detrás de la escena (opacidad en el centro) para que el texto blanco se lea sobre tu toma.
 */
export const FLOTANTE = {
	blur_px: 14,
	oscurecer: 0.16,
	escala: 1.045,
	entrada: 8,
	salida: 7,
	escena_entrada: 9,
	escena_salida: 6,
	escena_dy: 28,
	escena_desde: 0.94,
	escena_hasta: 0.97,
	velo: 0.42,
} as const;

/** Centro por defecto de la escena flotante: y 250–1230 (arriba de tarjetas y stickers del pecho y de los subtítulos). */
export const CENTRO_FLOTANTE = {x: 540, y: 740} as const;

/** Fondo de un tramo: el de FLOTANTE o el que pida su motion (motion.fondo o el de diseño de un motion libre). */
export type FondoTramo = {blur_px: number; oscurecer: number; escala: number};
/**
 * Retrato: con la pista de tu cabeza (motions libres), tu cabeza queda NÍTIDA y solo tu cuarto se desenfoca. `f0` es
 * el cuadro absoluto en que entra el insert (la pista va relativa a él).
 */
export type RetratoTramo = {f0: number; pista: PistaCabeza};
export type TramoFlotante = {desde: number; hasta: number; fondo?: FondoTramo; entrada?: number; salida?: number; retratos?: RetratoTramo[]};

type InsertFlotante = {layout: string; desde: number; hasta: number; motion?: {nombre: string; fondo?: Partial<FondoTramo>; pista?: PistaCabeza}};

/** Fondo que pide un insert flotante (undefined = el de FLOTANTE). */
export function fondoDeInsert(i: InsertFlotante): FondoTramo | undefined {
	const n = i.motion?.nombre;
	const base = n && esLibre(n) ? FONDO_DISENO[n] : undefined;
	const pedido = i.motion?.fondo;
	if (!base && !pedido) return undefined;
	const elegir = (k: keyof FondoTramo): number => pedido?.[k] ?? base?.[k] ?? FLOTANTE[k];
	return {blur_px: elegir('blur_px'), oscurecer: elegir('oscurecer'), escala: elegir('escala')};
}

/**
 * Tramos (en cuadros) de los inserts flotantes. Los que se tocan (≤ 1 cuadro entre uno y otro) se unen: así dos
 * motions seguidos no destapan tu toma un cuadro entre los dos.
 */
export function tramosFlotante(inserts: ReadonlyArray<InsertFlotante>, fps = 30): TramoFlotante[] {
	const t = inserts
		.filter((i) => i.layout === 'flotante')
		.map((i): TramoFlotante => {
			const fondo = fondoDeInsert(i);
			const f0 = Math.round(i.desde * fps);
			const libre = !!i.motion && esLibre(i.motion.nombre);
			// Los libres: tu cuarto empieza a desenfocarse ANTES_LIBRE cuadros antes (rack focus) y se enfoca al final.
			return {
				desde: libre ? f0 - ANTES_LIBRE : f0,
				hasta: Math.round(i.hasta * fps),
				...(fondo ? {fondo} : {}),
				...(libre ? {entrada: ENTRADA_FONDO_LIBRE, salida: FOCO_SALIDA} : {}),
				...(libre && i.motion?.pista ? {retratos: [{f0, pista: i.motion.pista}]} : {}),
			};
		})
		.filter((x) => x.hasta > x.desde)
		.sort((a, b) => a.desde - b.desde);
	const unidos: TramoFlotante[] = [];
	for (const x of t) {
		const u = unidos[unidos.length - 1];
		if (u && x.desde <= u.hasta + 1) {
			u.hasta = Math.max(u.hasta, x.hasta);
			if (x.retratos) u.retratos = [...(u.retratos ?? []), ...x.retratos];
		} else unidos.push({...x});
	}
	return unidos;
}

/**
 * Intensidad 0 → 1 del fondo flotante en el cuadro absoluto f. Sube en `entrada` cuadros desde `desde` (en el primer
 * cuadro ya se nota) y baja en `salida` cuadros de modo que en `hasta` ya vale 0. Si el tramo dura poco, cada rampa se
 * recorta a un tercio.
 */
export function intensidadFlotante(f: number, tramos: readonly TramoFlotante[], entrada: number = FLOTANTE.entrada, salida: number = FLOTANTE.salida): number {
	let max = 0;
	for (const t of tramos) {
		const dur = t.hasta - t.desde;
		if (dur <= 0 || f < t.desde || f >= t.hasta) continue;
		const tope = Math.max(1, Math.floor(dur / 3));
		const rEnt = Math.min(Math.max(0, Math.round(t.entrada ?? entrada)), tope);
		const rSal = Math.min(Math.max(0, Math.round(t.salida ?? salida)), tope);
		const local = f - t.desde; // 0 en el primer cuadro
		const faltan = t.hasta - f; // 1 en el último cuadro
		let k = 1;
		if (rEnt > 0 && local < rEnt) k = Math.min(k, CURVAS.salida((local + 1) / rEnt));
		// Salida = rack focus: tu toma se enfoca con ease-in-out (arranca suave, sin brinco de foco, y llega nítida en `hasta`).
		if (rSal > 0 && faltan <= rSal) k = Math.min(k, 1 - CURVAS.mover((rSal - faltan + 1) / rSal));
		max = Math.max(max, k);
	}
	return Math.min(1, Math.max(0, max));
}

/** El fondo (parámetros) del tramo que manda en el cuadro f: el de mayor intensidad; FLOTANTE si no pide otro. */
export function fondoEnCuadro(f: number, tramos: readonly TramoFlotante[]): FondoTramo {
	let mejor: TramoFlotante | null = null;
	let kMax = -1;
	for (const t of tramos) {
		if (f < t.desde || f >= t.hasta) continue;
		const k = intensidadFlotante(f, [t]);
		if (k > kMax) {
			kMax = k;
			mejor = t;
		}
	}
	return mejor?.fondo ?? {blur_px: FLOTANTE.blur_px, oscurecer: FLOTANTE.oscurecer, escala: FLOTANTE.escala};
}

/** Cómo se ve tu toma con intensidad k: desenfoque (px base), brillo (1 = igual) y escala. */
export function fondoFlotante(k: number, p: {blur_px: number; oscurecer: number; escala: number} = FLOTANTE): {blur: number; brillo: number; escala: number} {
	const c = Math.min(1, Math.max(0, k));
	return {blur: p.blur_px * c, brillo: 1 - p.oscurecer * c, escala: 1 + (p.escala - 1) * c};
}

/**
 * La escena dentro de su Sequence: f = cuadros desde que entra el insert, dur = cuadros que dura.
 * Entra con ease-out fuerte (nunca desde escala 0) y sale rápido hacia abajo; el velo sigue a la opacidad.
 */
export function escenaFlotante(f: number, dur: number): {opacidad: number; escala: number; dy: number} {
	const tope = Math.max(1, Math.floor(dur / 3));
	const ent = Math.min(FLOTANTE.escena_entrada, tope);
	const sal = Math.min(FLOTANTE.escena_salida, tope);
	const p = CURVAS.salida((f + 1) / ent);
	const faltan = dur - f; // 1 en el último cuadro
	const q = faltan <= sal ? CURVAS.salida((faltan - 1) / sal) : 1;
	return {
		opacidad: Math.min(1, p * 1.25) * q,
		escala: (FLOTANTE.escena_desde + (1 - FLOTANTE.escena_desde) * p) * (FLOTANTE.escena_hasta + (1 - FLOTANTE.escena_hasta) * q),
		dy: (1 - p) * FLOTANTE.escena_dy,
	};
}

/**
 * Caja (px base) donde se dibuja la escena flotante: 810 × 980 × caja.escala centrada en (caja.x, caja.y), por
 * defecto (540, 740) → x 135–945, y 250–1230. Es también su "caja visible" para layout.ts y validar.ts (R2, R12).
 */
export function cajaFlotante(caja?: {x?: number; y?: number; escala?: number}, nombre?: string): {x0: number; y0: number; x1: number; y1: number; escala: number} {
	// Los motions libres (src/estilo/motion-libre.ts) no tienen escena: lo legible vive en CAJA_LIBRE, anclado a ti.
	if (nombre && esLibre(nombre)) return {...CAJA_LIBRE, escala: 1};
	const escala = caja?.escala ?? 1;
	const w = ESCENA.ancho * escala;
	const h = ESCENA.alto * escala;
	const cx = caja?.x ?? CENTRO_FLOTANTE.x;
	const cy = caja?.y ?? CENTRO_FLOTANTE.y;
	return {x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, escala};
}

/**
 * Tu cabeza (px base, en pantalla con el push-in `escala`) que queda nítida en el cuadro absoluto f, o null si el
 * tramo no trae pista: dos elipses (la de arriba, ajustada a la forma de tu cráneo, y la de la cara y la barba) que
 * Flotante.tsx intersecta como máscara del desenfoque (foco de retrato).
 */
export function elipsesRetrato(f: number, tramos: readonly TramoFlotante[], escala: number): Array<{cx: number; cy: number; rx: number; ry: number}> | null {
	for (const t of tramos) {
		if (f < t.desde || f >= t.hasta || !t.retratos?.length) continue;
		// La pista del insert que ya entró más recientemente (o la primera, en la rampa de antes).
		const r = [...t.retratos].reverse().find((x) => f >= x.f0 - ANTES_LIBRE) ?? t.retratos[0];
		return elipsesDeCabeza(cabezaEnPantalla(cabezaEn(r.pista, f - r.f0), escala));
	}
	return null;
}
