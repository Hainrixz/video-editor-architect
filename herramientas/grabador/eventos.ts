/**
 * Eventos de una demo de pantalla y compresión de tiempos muertos (Fase 5).
 *
 * eventos.json = [{t, tipo: "clic"|"tecla"|"scroll"|"navegacion", caja: {x, y, w, h}, dur?}]
 *   - t: segundos sobre toma.mp4 (la toma YA comprimida).
 *   - caja: px del cuadro grabado (con viewport 1280×800 y DPR 2, el cuadro mide 2560×1600).
 *   - Las teclas se guardan solo como {tipo: "tecla"} con la caja del campo: nunca el texto.
 * El esquema vive en src/estilo/demo.ts (lo comparte DemoPantalla).
 *
 * Línea de tiempo:
 *   1. La grabación cruda llega como cuadros VFR con su timestamp (CDP screencast) y eventos con su reloj.
 *      Todo se pasa a "tiempo crudo": segundos desde el primer cuadro.
 *   2. CFR 30: el cuadro de salida k (k/30 s) repite el último cuadro crudo con timestamp ≤ k/30 (`mapaCfr`).
 *   3. Compresión: los tramos sin actividad de más de 400 ms (sin cuadros nuevos ni eventos) se recortan y quedan
 *      en 400 ms (200 ms al salir de la actividad y 200 ms antes de la siguiente). El resultado es keep[] en
 *      cuadros de 30 fps, el mismo formato que usan los cortes del reel, así que el mapa de compresión es
 *      herramientas/lib/remapear.ts: `remapear(keep, t)` lleva un tiempo crudo a la toma comprimida.
 */
import {existsSync, readFileSync} from 'node:fs';
import {fallo} from '../lib/fallo.ts';
import {cuantizar, duracionBase, FPS, remapear, validarKeep, type Tramo} from '../lib/remapear.ts';
import {EventosDemo, TIPOS_EVENTO, type CajaPx, type EventoDemo, type TipoEvento} from '../../src/estilo/demo.ts';

export {EventosDemo, TIPOS_EVENTO, type CajaPx, type EventoDemo, type TipoEvento};
export {FPS, type Tramo};

/** Parámetros de la compresión de tiempos muertos. */
export const COMPRESION = {
	/** Un hueco sin actividad de más de esto se recorta. */
	umbral_s: 0.4,
	/** Lo que queda de cada hueco recortado (la mitad al salir de la actividad, la mitad antes de la siguiente). */
	conservar_s: 0.4,
	/** Lo que se deja después de la última actividad (el zoom necesita 1–1.5 s para sostenerse y salir). */
	cola_s: 1.5,
} as const;

export type OpcionesCompresion = Partial<{-readonly [K in keyof typeof COMPRESION]: number}>;

/** Intervalo con actividad, en tiempo crudo (s). Un punto es [t, t]. */
export type Actividad = {desde: number; hasta: number};

/** Evento como lo registra el estudio: reloj de pared (s desde 1970) y caja en px CSS del viewport. */
export type EventoCrudo = {
	reloj: number;
	tipo: TipoEvento;
	/** Caja en px CSS del viewport (la del elemento). */
	caja: CajaPx;
	/** px del cuadro por cada px CSS en ese momento (DPR × tope del screencast). */
	escala: number;
	dur?: number;
};

const redondo = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Caja en px CSS → px del cuadro (redondeada a 0.1 px). */
export function aPixelesCuadro(caja: CajaPx, escala: number): CajaPx {
	return {x: redondo(caja.x * escala, 1), y: redondo(caja.y * escala, 1), w: redondo(caja.w * escala, 1), h: redondo(caja.h * escala, 1)};
}

/** Une intervalos de actividad que se enciman o están a ≤ `pegados` s (ordena primero). */
export function unirActividad(actividad: readonly Actividad[], pegados = 0): Actividad[] {
	const orden = actividad
		.filter((a) => Number.isFinite(a.desde) && Number.isFinite(a.hasta))
		.map((a) => ({desde: Math.min(a.desde, a.hasta), hasta: Math.max(a.desde, a.hasta)}))
		.sort((a, b) => a.desde - b.desde);
	const unidos: Actividad[] = [];
	for (const a of orden) {
		const ultimo = unidos[unidos.length - 1];
		if (ultimo && a.desde - ultimo.hasta <= pegados) ultimo.hasta = Math.max(ultimo.hasta, a.hasta);
		else unidos.push({...a});
	}
	return unidos;
}

/**
 * keep[] de la compresión (tiempo crudo, en cuadros de 30 fps, listo para remapear.ts).
 * `actividad`: cada cuadro nuevo es un punto y cada evento es [t, t + dur]. `duracion`: largo de la toma cruda (s).
 * Los huecos de más de `umbral_s` se recortan a `conservar_s`; después de la última actividad quedan `cola_s`.
 */
export function planCompresion(actividad: readonly Actividad[], duracion: number, op: OpcionesCompresion = {}): Tramo[] {
	const p = {...COMPRESION, ...op};
	if (!(Number.isFinite(duracion) && duracion > 0)) {
		throw fallo('comprimir los tiempos muertos', `la toma cruda dura ${duracion} s`, 'revisa que la grabación haya recibido cuadros', 1);
	}
	if (!(p.conservar_s <= p.umbral_s)) {
		throw fallo('comprimir los tiempos muertos', `conservar_s (${p.conservar_s}) es mayor que umbral_s (${p.umbral_s})`, 'usa conservar_s ≤ umbral_s', 1);
	}
	const fin = Math.round(duracion * FPS) / FPS;
	const bloques = unirActividad(
		actividad.map((a) => ({desde: Math.max(0, Math.min(fin, a.desde)), hasta: Math.max(0, Math.min(fin, a.hasta))})),
		p.umbral_s,
	);
	if (bloques.length === 0) return [{desde: 0, hasta: Math.max(1 / FPS, Math.min(fin, cuantizar(p.cola_s)))}];

	// Cada bloque se amplía medio "conservar" a cada lado; el último se queda con su cola; el primero arranca en 0
	// si su hueco inicial no pasa del umbral.
	const medio = p.conservar_s / 2;
	const crudos: Tramo[] = bloques.map((b, i) => ({
		desde: i === 0 && b.desde <= p.umbral_s ? 0 : Math.max(0, b.desde - medio),
		hasta: i === bloques.length - 1 ? Math.min(fin, b.hasta + p.cola_s) : Math.min(fin, b.hasta + medio),
	}));

	// A cuadros: hacia afuera (no se pierde ningún cuadro con actividad) y uniendo lo que quede pegado.
	const keep: Tramo[] = [];
	for (const tr of crudos) {
		const desde = Math.floor(tr.desde * FPS + 1e-9) / FPS;
		let hasta = Math.ceil(tr.hasta * FPS - 1e-9) / FPS;
		if (hasta <= desde) hasta = desde + 1 / FPS;
		const ultimo = keep[keep.length - 1];
		// remapear.ts exige al menos un cuadro de corte entre tramos: si no lo hay, son el mismo tramo.
		if (ultimo && Math.round(desde * FPS) <= Math.round(ultimo.hasta * FPS)) ultimo.hasta = Math.max(ultimo.hasta, hasta);
		else keep.push({desde, hasta});
	}
	const finCuadros = Math.max(1, Math.round(fin * FPS));
	const recortados = keep
		.map((tr) => ({desde: Math.round(tr.desde * FPS), hasta: Math.min(finCuadros, Math.round(tr.hasta * FPS))}))
		.filter((tr) => tr.hasta > tr.desde)
		.map((tr) => ({desde: tr.desde / FPS, hasta: tr.hasta / FPS}));
	validarKeep(recortados);
	return recortados;
}

/** Cuánto se quitó: duración cruda, comprimida y lo recortado (s). */
export function resumenCompresion(keep: readonly Tramo[], duracionCruda: number): {cruda_s: number; comprimida_s: number; recortado_s: number; cortes: number} {
	const comprimida = duracionBase(keep);
	return {cruda_s: redondo(duracionCruda), comprimida_s: redondo(comprimida), recortado_s: redondo(Math.max(0, duracionCruda - comprimida)), cortes: Math.max(0, keep.length - 1)};
}

/**
 * Tiempo crudo → tiempo de la toma comprimida. Si cae en un recorte (no debería: los eventos son actividad), se
 * pega al borde de tramo más cercano.
 */
export function remapearTiempo(keep: readonly Tramo[], t: number): number {
	const r = remapear(keep, t);
	if (r !== null) return r;
	// Primer o último cuadro de cada tramo: el más cercano a t.
	const candidatos = keep.flatMap((tr) => [tr.desde, Math.max(tr.desde, tr.hasta - 1 / FPS)]);
	const cercano = candidatos.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
	return remapear(keep, cercano) ?? 0;
}

/**
 * Eventos crudos → eventos de la toma comprimida: reloj → tiempo crudo (restando `t0`, el timestamp del primer
 * cuadro), luego remapear(keep, t); caja de px CSS a px del cuadro. Los que caen antes de la toma se descartan.
 * La duración se remapea también (fin remapeado − inicio remapeado).
 */
export function eventosDeToma(crudos: readonly EventoCrudo[], t0: number, keep: readonly Tramo[]): EventoDemo[] {
	const durBase = duracionBase(keep);
	const salida: EventoDemo[] = [];
	for (const e of [...crudos].sort((a, b) => a.reloj - b.reloj)) {
		const t = e.reloj - t0;
		if (t < -1e-6) continue;
		const tb = remapearTiempo(keep, Math.max(0, t));
		const evento: EventoDemo = {t: redondo(Math.min(tb, durBase)), tipo: e.tipo, caja: aPixelesCuadro(e.caja, e.escala)};
		if (e.dur !== undefined && e.dur > 0) {
			const fin = remapearTiempo(keep, Math.max(0, t + e.dur));
			evento.dur = redondo(Math.max(0, fin - tb));
		}
		salida.push(evento);
	}
	return salida;
}

/**
 * Cuadros VFR → CFR: para cada cuadro de salida k (k / fps s), el índice del último cuadro crudo con
 * tiempo ≤ k / fps (repite el último cuadro). Antes del primer cuadro se usa el primero.
 * `tiempos` va en segundos crudos, en orden no decreciente.
 */
export function mapaCfr(tiempos: readonly number[], totalCuadros: number, fps = FPS): number[] {
	if (tiempos.length === 0) throw fallo('pasar la toma a 30 fps', 'no llegó ningún cuadro', 'revisa que la página se haya pintado mientras grababa', 1);
	const mapa: number[] = new Array(Math.max(0, totalCuadros));
	let i = 0;
	for (let k = 0; k < totalCuadros; k++) {
		const tk = k / fps + 1e-6;
		while (i + 1 < tiempos.length && tiempos[i + 1] <= tk) i++;
		mapa[k] = i;
	}
	return mapa;
}

/** Índices de los cuadros de salida (CFR) que se quedan con keep[], en orden. */
export function cuadrosConservados(keep: readonly Tramo[]): number[] {
	const salida: number[] = [];
	for (const tr of keep) {
		for (let k = Math.round(tr.desde * FPS); k < Math.round(tr.hasta * FPS); k++) salida.push(k);
	}
	return salida;
}

export type EstadisticaCuadros = {
	/** Cuadros que llegaron en el tramo. */
	cuadros: number;
	/** Con timestamp distinto al anterior (criterio del piloto). */
	unicos_por_tiempo: number;
	/** Con contenido distinto al anterior (hash). */
	unicos_por_contenido: number;
	duracion_s: number;
	/** Únicos por tiempo / duración. */
	fps_efectivos: number;
	/** Por cada segundo completo del tramo: únicos por tiempo. */
	por_segundo: number[];
	fps_min_por_segundo: number | null;
};

/**
 * Cuadros únicos por segundo en [desde, hasta) (tiempo crudo). Un cuadro es único por tiempo si su timestamp es
 * mayor que el del anterior; por contenido, si su hash cambia.
 */
export function estadisticaCuadros(cuadros: ReadonlyArray<{t: number; hash?: string}>, desde: number, hasta: number): EstadisticaCuadros {
	const dentro = cuadros.filter((c) => c.t >= desde && c.t < hasta);
	let unicosT = 0;
	let unicosC = 0;
	let tAnt = Number.NEGATIVE_INFINITY;
	let hAnt: string | undefined;
	const porSegundo = new Array(Math.max(0, Math.floor(hasta - desde + 1e-9))).fill(0);
	for (const c of dentro) {
		if (c.t > tAnt) {
			unicosT++;
			const s = Math.floor(c.t - desde);
			if (s < porSegundo.length) porSegundo[s]++;
		}
		if (c.hash === undefined || c.hash !== hAnt) unicosC++;
		tAnt = Math.max(tAnt, c.t);
		hAnt = c.hash;
	}
	const duracion = Math.max(1e-9, hasta - desde);
	return {
		cuadros: dentro.length,
		unicos_por_tiempo: unicosT,
		unicos_por_contenido: unicosC,
		duracion_s: redondo(hasta - desde),
		fps_efectivos: redondo(unicosT / duracion, 2),
		por_segundo: porSegundo,
		fps_min_por_segundo: porSegundo.length ? Math.min(...porSegundo) : null,
	};
}

/** Lee y valida demos/<slug>/eventos.json. */
export function leerEventos(ruta: string): EventoDemo[] {
	if (!existsSync(ruta)) throw fallo('leer los eventos de la demo', `no existe ${ruta}`, 'graba la demo con estudio.ts grabar', 2);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo('leer los eventos de la demo', `${ruta} no es JSON válido`, 'vuelve a grabar la demo', 2, error);
	}
	const r = EventosDemo.safeParse(datos);
	if (!r.success) {
		const p = r.error.issues[0];
		throw fallo('leer los eventos de la demo', `${ruta} no cumple el formato (${p.path.join('.') || 'raíz'}: ${p.message})`, 'vuelve a grabar la demo', 2, r.error.issues);
	}
	return r.data;
}
