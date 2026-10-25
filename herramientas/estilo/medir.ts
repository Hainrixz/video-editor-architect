// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * medir.ts: mide el estilo de los SUBTÍTULOS de un reel publicado (parte de subtítulos de la Fase 1).
 *
 *   npx tsx herramientas/estilo/medir.ts <reel.mp4> [--salida out/medir/x.json] [--hilos 2] [--cpu] [--sin-previa]
 *   (--sin-previa: sin la referencia previa de estilo/mini-estilo.json; solo para diagnóstico)
 *
 * Cómo mide (todo local, sin gastar):
 *   1. Ubicar la franja: OCR `.accurate` a ~2 fps del cuadro completo. La franja es la línea de texto que más
 *      se repite en la mitad inferior y que cambia cada 0.3–1.5 s (un título fijo o un @usuario no cambian).
 *   2. Segmentar: recorte a la franja y OCR a ~10 fps (un cuadro nativo de cada `paso`; `.accurate` por
 *      defecto, ver MODO_SEGMENTAR: el plan decía `.fast`, pero no pasó el fixture). Rachas del
 *      mismo texto (≥2 lecturas) = eventos. Los bordes se afinan a los fps nativos leyendo los cuadros que
 *      quedaron entre dos muestras.
 *   3. Una lectura `.accurate` por evento (cuadro de en medio, con caja por palabra y sus píxeles RGBA).
 *   4. Por evento: palabras, duración, Y del centro de la caja (base 1080×1920), ancho, alto de caja y alto de
 *      mayúscula (alto de caja / FACTOR_ALTO_CAJA), color de relleno y de borde (picos de color dentro de la
 *      caja; el borde es el pico que, como barrera, deja ENCERRADO un relleno que solo toca al borde; ver
 *      analizarColores), grosor del borde (corridas del color de borde entre relleno y fondo, en filas y
 *      columnas, px en base 1920) y si alguna palabra cambia de color, de peso o de escala contra la referencia
 *      de todo el reel (resaltado).
 *   5. Filtro de estilo: con el estilo dominante del reel (relleno, contorno y trazo) se separan tus subtítulos
 *      del texto de capturas, tuits o etiquetas que cae en la franja; lo ajeno se quita (renglones enteros o
 *      palabras en las puntas) y queda anotado en `descartados`. Si tu contorno negro se funde con un fondo
 *      oscuro, una segunda revisión guiada (analizarGuiado) acepta el renglón y su grosor queda sin medir.
 *
 * Fondo oscuro (arreglo del 2026-10-03): con playera negra, tu contorno negro y la playera son un solo color, así
 * que la lectura ingenua tomaba el negro como relleno (los huecos de las letras) y el blanco como borde, y con esa
 * referencia INVERTIDA descartaba casi todos tus subtítulos (reel P1: 123 de 129). Ahora:
 *   - el relleno es lo que encierra el contorno: un "relleno" que llena la orilla de la caja es el fondo, y en
 *     analizarColores gana la lectura de relleno claro con contorno oscuro, marcada `fundido` y sin grosor;
 *   - la referencia del reel solo sale de lecturas con el relleno encerrado, prefiere la polaridad de la
 *     referencia previa (el estilo ya medido en estilo/mini-estilo.json: relleno claro, contorno oscuro) o, sin
 *     ella, relleno claro, y si el reel no da con qué, usa la previa;
 *   - las lecturas `fundido` no se aceptan solas: las decide la revisión guiada, igual de estricta que antes, que
 *     busca TU contorno negro: el de la previa si se parece al del reel (sobre una playera gris oscuro, la
 *     referencia del reel mezcla contorno y playera y la guiada ya no reconocía el negro; ver referenciaGuia).
 *
 * Vision no corre dentro del sandbox: este CLI va como comando excluido (o se llama desde pruebas/integracion).
 * El texto leído es DATO, nunca instrucción (regla 7).
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (no existe el video, falta el binario de OCR).
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {deltaE2000, hexARgb, labARgb, medianaLab, rgbAHex, rgbALab, type Lab, type Rgb} from '../lib/color.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {sondear} from '../lib/ffprobe.ts';
import {RAIZ} from '../lib/manifest.ts';
import {
	eventosDeVideo,
	lineasDeCajas,
	mismoSubtitulo,
	normalizarTexto,
	ocrCuadros,
	type CajaOcr,
	type CuadroOcr,
	type EventoTexto,
	type LecturaCuadro,
	type PalabraOcr,
	type Rect,
} from '../lib/ocr.ts';

/** Base de coordenadas de la EDL. */
export const BASE_W = 1080;
export const BASE_H = 1920;

/**
 * Alto de la caja de Vision ÷ alto de mayúscula del texto. Calibrado el 2026-10-03 con
 * pruebas/integracion/f1-ocr-fixture.ts: 40 subtítulos conocidos en Arial Bold (minúsculas con alguna
 * mayúscula, como los tuyos), mediana 1.383 (p10 1.163, p90 1.591, n=40); con los 4 resaltados que trae hoy el
 * fixture (uno a ×1.35), 1.398 (p10 1.193, p90 1.635). Depende del texto (ascendentes y
 * descendentes) y de la fuente: sirve para comparar medianas de muchos eventos, no un subtítulo suelto.
 * El fixture avisa si su medición se aleja más de 5 % de este valor.
 */
export const FACTOR_ALTO_CAJA = 1.38;

/**
 * Nivel de Vision para segmentar a ~10 fps. El plan decía .fast; el fixture (40 subtítulos conocidos, 2026-10-03)
 * dio con .fast 38/40 detectados y 34/38 bordes a ±1 cuadro (se come palabras, mete puntuación y a veces no lee
 * nada), y con .accurate 40/40 y 40/40 bordes exactos, por el doble de tiempo (16 s contra 8 s por 30 s de video).
 */
export const MODO_SEGMENTAR: 'fast' | 'accurate' = 'accurate';

/** Ventana de "cambia cada 0.3–1.5 s" para reconocer la franja de subtítulos (con margen de un muestreo). */
const RACHA_MIN_S = 0.3;
const RACHA_MAX_S = 1.5;

/**
 * Fracción máxima de la orilla de la caja con el color del relleno para tomar una lectura como de subtítulo: el
 * relleno de un subtítulo queda encerrado por su contorno (≈ 0 de la orilla). La lectura al revés sobre una playera
 * negra da ≈ 0.9 (su "relleno" es la playera). Es el mismo tope que ya usaba el resaltado (palabraConfiable).
 */
export const ORILLA_MAX_RELLENO = 0.3;

/** ΔE2000 máximo contra la referencia previa para contar una lectura como "tu estilo de siempre". */
export const UMBRAL_PREVIA = 20;

/**
 * De dónde sale la referencia previa, en orden: el mini-estilo de la Fase 1 y, si no está, la sección de subtítulos
 * de estilo/estilo.json. Solo se toma si sus colores dicen `fuente: "medido…"` (el estilo sale de tus reels).
 */
export const RUTAS_PREVIA = ['estilo/mini-estilo.json', 'estilo/estilo.json'] as const;

// ───────────────────────────── Utilidades puras ─────────────────────────────

/** Cuantil con interpolación lineal (tipo 7, el de R y numpy). null si no hay datos. */
export function cuantil(valores: number[], p: number): number | null {
	const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const h = (v.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

const redondear = (v: number | null, decimales = 1): number | null => (v === null ? null : Number(v.toFixed(decimales)));

/** Palabras de un texto (tokens con al menos una letra o número). */
export function contarPalabras(texto: string): number {
	return texto.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** ¿El texto va en MAYÚSCULAS? (todas sus letras, con al menos 2 letras). */
export function esMayusculas(texto: string): boolean {
	const letras = [...texto].filter((c) => /\p{L}/u.test(c));
	if (letras.length < 2) return false;
	return letras.every((c) => c === c.toUpperCase() && c !== c.toLowerCase());
}

// ───────────────────────────── Franja de subtítulos (pasada 1) ─────────────────────────────

export type Franja = {
	/** Borde superior e inferior del recorte (normalizados al alto del cuadro). */
	y0: number;
	y1: number;
	/** Alto mediano de la línea de subtítulo (normalizado). */
	altoTexto: number;
	/** Centro vertical mediano de la línea (normalizado). */
	centroY: number;
	/** Fracción de cuadros muestreados con texto en la franja. */
	cobertura: number;
	/** Duración media (s) de un mismo texto en la franja. */
	rachaMedia: number;
	/** Líneas usadas para ubicarla. */
	n: number;
};

type LineaCuadro = {k: number; texto: string; caja: Rect};

/**
 * Ubica la franja de subtítulos con cuadros completos muestreados cada `periodo` segundos (pura).
 * Candidatas: picos del histograma del centro vertical de las líneas de la mitad inferior. Se queda con la
 * de mayor cobertura entre las que cambian de texto cada 0.3–1.5 s y van más o menos centradas.
 */
export function ubicarFranja(cuadros: CuadroOcr[], op: {periodo: number}): Franja | null {
	const lineas: LineaCuadro[] = [];
	cuadros.forEach((c, k) => {
		for (const l of lineasDeCajas(c.cajas)) {
			const cy = l.caja.y + l.caja.h / 2;
			if (cy >= 0.5 && l.caja.h >= 0.006 && normalizarTexto(l.texto)) lineas.push({k, texto: l.texto, caja: l.caja});
		}
	});
	if (lineas.length === 0 || cuadros.length === 0) return null;

	// Histograma del centro vertical (bins de 0.005 ≈ 10 px en base 1920), contando cuadros distintos.
	const BIN = 0.005;
	const nBins = Math.ceil(1 / BIN) + 1;
	const cuadrosPorBin: Array<Set<number>> = Array.from({length: nBins}, () => new Set());
	for (const l of lineas) cuadrosPorBin[Math.min(nBins - 1, Math.floor((l.caja.y + l.caja.h / 2) / BIN))].add(l.k);
	const conteo = cuadrosPorBin.map((s) => s.size);
	const suave = conteo.map((_, i) => {
		let s = 0;
		for (let d = -3; d <= 3; d++) s += conteo[i + d] ?? 0;
		return s;
	});

	// Picos locales separados al menos 0.05.
	const picos: number[] = [];
	const ordenBins = suave.map((v, i) => [v, i] as const).filter(([v]) => v > 0).sort((a, b) => b[0] - a[0]);
	for (const [, i] of ordenBins) {
		if (picos.every((p) => Math.abs(p - i) * BIN >= 0.05)) picos.push(i);
		if (picos.length >= 6) break;
	}

	let mejor: (Franja & {puntaje: number}) | null = null;
	for (const p of picos) {
		const centro = (p + 0.5) * BIN;
		const altos = lineas.filter((l) => Math.abs(l.caja.y + l.caja.h / 2 - centro) <= 0.02).map((l) => l.caja.h);
		const hMed = cuantil(altos, 0.5) ?? 0.02;
		const ventana = Math.max(0.035, 1.5 * hMed);
		const delGrupo = lineas.filter((l) => Math.abs(l.caja.y + l.caja.h / 2 - centro) <= ventana && l.caja.h >= 0.5 * hMed && l.caja.h <= 2 * hMed);
		if (delGrupo.length === 0) continue;

		// Texto por cuadro (líneas del grupo unidas) y rachas por cuadros consecutivos.
		const textoPorCuadro = new Map<number, string>();
		for (const l of [...delGrupo].sort((a, b) => a.caja.y - b.caja.y || a.caja.x - b.caja.x)) {
			textoPorCuadro.set(l.k, `${textoPorCuadro.get(l.k) ?? ''} ${normalizarTexto(l.texto)}`.trim());
		}
		const largos: number[] = [];
		let largo = 0;
		let previo: string | null = null;
		for (let k = 0; k < cuadros.length; k++) {
			const t = textoPorCuadro.get(k) ?? null;
			if (t !== null && t === previo) {
				largo++;
			} else {
				if (largo > 0) largos.push(largo);
				largo = t !== null ? 1 : 0;
			}
			previo = t;
		}
		if (largo > 0) largos.push(largo);
		const rachaMedia = (largos.reduce((a, b) => a + b, 0) / Math.max(1, largos.length)) * op.periodo;
		const cobertura = textoPorCuadro.size / cuadros.length;
		const centrado = cuantil(delGrupo.map((l) => Math.abs(l.caja.x + l.caja.w / 2 - 0.5)), 0.5) ?? 1;

		const cambia = rachaMedia >= RACHA_MIN_S && rachaMedia <= RACHA_MAX_S + op.periodo;
		if (!cambia || cobertura < 0.1 || centrado > 0.2) continue;
		const puntaje = cobertura * (1 - centrado);
		if (mejor && puntaje <= mejor.puntaje) continue;

		const margen = Math.max(0.006, 0.6 * hMed);
		const y0 = Math.max(0, (cuantil(delGrupo.map((l) => l.caja.y), 0.02) ?? centro) - margen);
		const y1 = Math.min(1, (cuantil(delGrupo.map((l) => l.caja.y + l.caja.h), 0.98) ?? centro) + margen);
		mejor = {
			y0,
			y1,
			altoTexto: hMed,
			centroY: cuantil(delGrupo.map((l) => l.caja.y + l.caja.h / 2), 0.5) ?? centro,
			cobertura,
			rachaMedia,
			n: delGrupo.length,
			puntaje,
		};
	}
	if (!mejor) return null;
	const {puntaje: _puntaje, ...franja} = mejor;
	return franja;
}

/**
 * Lectura de un cuadro de la franja (pura): primero se quitan las cajas sin alto de subtítulo (0.55–1.8 × el
 * alto típico) o fuera de la franja; luego se juntan en renglones, cada renglón se parte donde hay un hueco
 * horizontal de más de 1.5 altos de letra (otro elemento al lado) y se queda el grupo más centrado (±0.2).
 * `aspecto` = ancho / alto del cuadro (9/16 en un reel), para comparar huecos horizontales con altos.
 */
export function lineasSubtitulo(cuadro: CuadroOcr, franja: Franja, aspecto = 9 / 16): ReturnType<typeof lineasDeCajas> {
	const cajas = cuadro.cajas.filter((c) => {
		const cy = c.y + c.h / 2;
		return (
			cy >= franja.y0 &&
			cy <= franja.y1 &&
			c.h >= 0.55 * franja.altoTexto &&
			c.h <= 1.8 * franja.altoTexto &&
			normalizarTexto(c.texto).length > 0
		);
	});
	const salida: ReturnType<typeof lineasDeCajas> = [];
	for (const linea of lineasDeCajas(cajas)) {
		const grupos: CajaOcr[][] = [];
		let actual: CajaOcr[] = [];
		for (const c of linea.cajas) {
			const previa = actual[actual.length - 1];
			if (previa && (c.x - (previa.x + previa.w)) * aspecto > 1.5 * Math.max(c.h, previa.h)) {
				grupos.push(actual);
				actual = [];
			}
			actual.push(c);
		}
		if (actual.length) grupos.push(actual);
		const centro = (g: CajaOcr[]) => (Math.min(...g.map((c) => c.x)) + Math.max(...g.map((c) => c.x + c.w))) / 2;
		const mejor = grupos.reduce((a, b) => (Math.abs(centro(b) - 0.5) < Math.abs(centro(a) - 0.5) ? b : a));
		if (Math.abs(centro(mejor) - 0.5) <= 0.2) salida.push(...lineasDeCajas(mejor));
	}
	return salida;
}

function unirLineas(lineas: ReturnType<typeof lineasDeCajas>): {texto: string; caja: Rect | null} {
	if (lineas.length === 0) return {texto: '', caja: null};
	const x0 = Math.min(...lineas.map((l) => l.caja.x));
	const y0 = Math.min(...lineas.map((l) => l.caja.y));
	const x1 = Math.max(...lineas.map((l) => l.caja.x + l.caja.w));
	const y1 = Math.max(...lineas.map((l) => l.caja.y + l.caja.h));
	return {texto: lineas.map((l) => l.texto).join(' '), caja: {x: x0, y: y0, w: x1 - x0, h: y1 - y0}};
}

// ───────────────────────────── Color, borde y peso (puro) ─────────────────────────────

/** Caja en píxeles de la imagen, [x0, x1) × [y0, y1). */
export type CajaPx = {x0: number; y0: number; x1: number; y1: number};

export type AnalisisColor = {
	relleno: Rgb;
	borde: Rgb;
	/** Grosor visible del borde, en px de la imagen (mediana de corridas relleno→borde→fondo). */
	grosor: number | null;
	/** Ancho típico del trazo del relleno (px de la imagen): sirve para comparar peso entre palabras. */
	tallo: number | null;
	nRelleno: number;
	nBorde: number;
	nPx: number;
	/** 0–1: qué tan claro quedó qué color es relleno y cuál es borde. */
	confianza: number;
	/**
	 * Fracción de la orilla de la caja con el color del relleno. Un subtítulo deja su relleno encerrado (cerca de
	 * 0); letras oscuras sobre una etiqueta o burbuja blanca dan un "relleno" (los huecos de las letras) del mismo
	 * color que el fondo, que llena la orilla.
	 */
	orillaRelleno: number;
	/**
	 * true si el contorno oscuro se fundió con un fondo de su mismo color (p. ej. tu contorno negro sobre una playera
	 * negra): relleno claro encerrado por un pico oscuro que llena la orilla. El grosor no se puede medir (null) y
	 * el color del "borde" mezcla contorno y fondo, así que esta lectura no basta para decir que es tu subtítulo.
	 */
	fundido?: boolean;
};

type Pico = {lab: Lab; n: number};

/** Picos de color (modas) en Lab dentro de una lista de píxeles; separados al menos `separacion` (ΔE76). */
export function picosDeColor(labs: Float32Array, nPx: number, op: {separacion?: number; max?: number; minFraccion?: number} = {}): Pico[] {
	const separacion = op.separacion ?? 25;
	const max = op.max ?? 4;
	const minN = Math.max(3, Math.round((op.minFraccion ?? 0.03) * nPx));
	const QL = 26;
	const QA = 43;
	const indiceBin = (qL: number, qa: number, qb: number) => (qL * QA + qa) * QA + qb;
	const cuenta = new Uint32Array(QL * QA * QA);
	const suma = new Float64Array(QL * QA * QA * 3);
	const bins: number[] = [];
	for (let p = 0; p < nPx; p++) {
		const L = labs[p * 3];
		const a = labs[p * 3 + 1];
		const b = labs[p * 3 + 2];
		const k = indiceBin(
			Math.min(QL - 1, Math.max(0, Math.floor(L / 4))),
			Math.min(QA - 1, Math.max(0, Math.floor((a + 128) / 6))),
			Math.min(QA - 1, Math.max(0, Math.floor((b + 128) / 6))),
		);
		if (cuenta[k] === 0) bins.push(k);
		cuenta[k]++;
		suma[k * 3] += L;
		suma[k * 3 + 1] += a;
		suma[k * 3 + 2] += b;
	}
	bins.sort((x, y) => cuenta[y] - cuenta[x]);
	const centro = (k: number): Lab => [suma[k * 3] / cuenta[k], suma[k * 3 + 1] / cuenta[k], suma[k * 3 + 2] / cuenta[k]];
	const picos: Pico[] = [];
	for (const k of bins) {
		if (picos.length >= max) break;
		const c = centro(k);
		if (picos.some((p) => dist76(p.lab, c) < separacion)) continue;
		// Centro refinado: promedio ponderado de los bins vecinos (≤10 de ΔE76).
		const qL = Math.floor(k / (QA * QA));
		const qa = Math.floor(k / QA) % QA;
		const qb = k % QA;
		let n = 0;
		const s = [0, 0, 0];
		for (let dL = -3; dL <= 3; dL++) {
			for (let da = -2; da <= 2; da++) {
				for (let db = -2; db <= 2; db++) {
					const L2 = qL + dL;
					const a2 = qa + da;
					const b2 = qb + db;
					if (L2 < 0 || L2 >= QL || a2 < 0 || a2 >= QA || b2 < 0 || b2 >= QA) continue;
					const j = indiceBin(L2, a2, b2);
					if (cuenta[j] === 0 || dist76(centro(j), c) > 10) continue;
					n += cuenta[j];
					s[0] += suma[j * 3];
					s[1] += suma[j * 3 + 1];
					s[2] += suma[j * 3 + 2];
				}
			}
		}
		if (n < minN) break;
		picos.push({lab: [s[0] / n, s[1] / n, s[2] / n], n});
	}
	return picos;
}

function dist76(a: Lab, b: Lab): number {
	const d0 = a[0] - b[0];
	const d1 = a[1] - b[1];
	const d2 = a[2] - b[2];
	return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

/**
 * Relleno, borde, grosor del borde y tallo del relleno dentro de una caja de texto (pura).
 * 1) Picos de color en Lab; cada píxel toma el pico más cercano (≤ radio) o queda "mezcla".
 * 2) Borde = el pico que más toca a los demás (está entre el relleno y el fondo); con solo dos picos (el fondo
 *    cayó en el mismo pico que el relleno, p. ej. una playera crema detrás de letras blancas), el de corridas
 *    más delgadas.
 * 3) Inundación desde la orilla de la caja por todo lo que no es borde (dilatado 1 px para cerrar huecos de
 *    compresión): lo que no se alcanza está ENCERRADO por el borde. Relleno = el pico con más píxeles
 *    encerrados (los huecos de la "o" también quedan encerrados, pero son poquitos).
 * 3b) Contorno fundido con el fondo: si tu contorno negro y una playera negra caen en el mismo pico, ese pico no
 *    pasa como borde (sus corridas ya no son delgadas) y la única lectura que queda es la de al revés: el negro
 *    como "relleno" (los huecos de las letras, que llenan la orilla de la caja) y el blanco como borde. El relleno
 *    es lo que encierra el contorno, así que entre las dos lecturas se prefiere la de relleno CLARO encerrado por
 *    el pico oscuro que llena la orilla (falla solo por "delgado"); sale con `fundido: true` y grosor null.
 * 4) Grosor = mediana de corridas de borde con relleno encerrado de un lado y algo no-relleno del otro; tallo =
 *    mediana de corridas de relleno entre dos bordes. Las mezclas (un píxel sin pico entre papeles) suman ½.
 * La caja conviene darla con margen (el contorno completo adentro): si la orilla corta una letra, esa letra
 * deja de contar como encerrada.
 */
export function analizarColores(
	pix: Uint8Array,
	anchoImg: number,
	altoImg: number,
	caja: CajaPx,
	op: {radio?: number; diagnostico?: (info: Record<string, unknown>) => void} = {},
): AnalisisColor | null {
	const x0 = Math.max(0, Math.floor(caja.x0));
	const y0 = Math.max(0, Math.floor(caja.y0));
	const x1 = Math.min(anchoImg, Math.ceil(caja.x1));
	const y1 = Math.min(altoImg, Math.ceil(caja.y1));
	const w = x1 - x0;
	const h = y1 - y0;
	if (w < 6 || h < 6) return null;
	const nPx = w * h;
	const labs = new Float32Array(nPx * 3);
	const rgbs = new Uint8Array(nPx * 3);
	const cache = new Map<number, Lab>();
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			const o = ((y0 + yy) * anchoImg + (x0 + xx)) * 4;
			const r = pix[o];
			const g = pix[o + 1];
			const b = pix[o + 2];
			const clave = (r << 16) | (g << 8) | b;
			let lab = cache.get(clave);
			if (!lab) {
				lab = rgbALab([r, g, b]);
				cache.set(clave, lab);
			}
			const p = yy * w + xx;
			labs[p * 3] = lab[0];
			labs[p * 3 + 1] = lab[1];
			labs[p * 3 + 2] = lab[2];
			rgbs[p * 3] = r;
			rgbs[p * 3 + 1] = g;
			rgbs[p * 3 + 2] = b;
		}
	}
	let picos = picosDeColor(labs, nPx, {max: 6, separacion: 15});
	if (picos.length < 2) return null;
	let P = picos.length;

	// 1) Etiquetas: 1..P = pico más cercano dentro del radio; 0 = mezcla u otro.
	const radio = op.radio ?? 18;
	const etiqueta = new Uint8Array(nPx);
	const etiquetar = () => {
		for (let p = 0; p < nPx; p++) {
			const lab: Lab = [labs[p * 3], labs[p * 3 + 1], labs[p * 3 + 2]];
			let mejor = 0;
			let dMin = radio;
			for (let i = 0; i < P; i++) {
				const d = dist76(picos[i].lab, lab);
				if (d <= dMin) {
					dMin = d;
					mejor = i + 1;
				}
			}
			etiqueta[p] = mejor;
		}
	};

	// 2) Corridas por etiqueta (filas y columnas, sin las que tocan la orilla) y vecindad entre picos
	//    (directa o a través de un píxel de mezcla).
	let corridas: number[][] = [];
	let vecindad: Float64Array[] = [];
	const estadisticas = () => {
		corridas = Array.from({length: P + 1}, () => []);
		vecindad = Array.from({length: P + 1}, () => new Float64Array(P + 1));
		const recorrerCorridas = (largo: number, en: (k: number) => number) => {
			let k = 0;
			while (k < largo) {
				const e = etiqueta[en(k)];
				let f = k;
				while (f + 1 < largo && etiqueta[en(f + 1)] === e) f++;
				if (e && k > 0 && f < largo - 1) corridas[e].push(f - k + 1);
				if (e && f + 1 < largo) {
					const sig = etiqueta[en(f + 1)] || (f + 2 < largo ? etiqueta[en(f + 2)] : 0);
					if (sig && sig !== e) {
						vecindad[e][sig]++;
						vecindad[sig][e]++;
					}
				}
				k = f + 1;
			}
		};
		for (let yy = 0; yy < h; yy++) recorrerCorridas(w, (k) => yy * w + k);
		for (let xx = 0; xx < w; xx++) recorrerCorridas(h, (k) => k * w + xx);
	};
	const corridaMediana = (i: number) => (corridas[i]?.length ? cuantil(corridas[i], 0.5)! : Number.POSITIVE_INFINITY);
	etiquetar();
	estadisticas();

	// 2b) Picos de mezcla: el antialias entre relleno y borde (p. ej. gris entre blanco y negro) forma su propio
	//     pico cuando hay mucho contorno. Se reconoce porque sus corridas miden ≤2 px y su color cae en el
	//     segmento entre otros dos picos. Se quita y se vuelve a etiquetar.
	const rgbPicos = picos.map((pk) => labARgb(pk.lab));
	const esMezcla = (k: number) => {
		if (corridaMediana(k + 1) > 2) return false;
		for (let i = 0; i < P; i++) {
			for (let j = i + 1; j < P; j++) {
				if (i === k || j === k) continue;
				const a = rgbPicos[i];
				const b = rgbPicos[j];
				const c = rgbPicos[k];
				const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
				const largo2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
				if (largo2 === 0) continue;
				const t = ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / largo2;
				if (t < 0.15 || t > 0.85) continue;
				const punto: Rgb = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
				if (dist76(rgbALab(punto), picos[k].lab) < 12) return true;
			}
		}
		return false;
	};
	const mezclas = picos.map((_, k) => esMezcla(k));
	if (mezclas.some(Boolean)) {
		picos = picos.filter((_, k) => !mezclas[k]);
		P = picos.length;
		if (P < 2) return null;
		etiquetar();
		estadisticas();
	}

	// 3) Papeles: se prueba cada pico como borde. Barrera = ese pico dilatado 1 px (cierra huecos de
	//    compresión); inundación desde la orilla por lo demás; lo no alcanzado queda ENCERRADO. El relleno de esa
	//    prueba es el pico con más píxeles encerrados. Puntaje = encerrados del relleno × fracción de la orilla
	//    del relleno que toca al borde (el relleno de un subtítulo solo toca a su borde). Se queda la mejor prueba
	//    con contraste (ΔE76 ≥ 25) y borde más delgado que el trazo del relleno.
	const sumaVecindad = (i: number) => {
		let t = 0;
		for (let j = 1; j <= P; j++) t += vecindad[i][j];
		return t;
	};
	const cola = new Int32Array(nPx);
	const inundar = (iB: number) => {
		const barrera = new Uint8Array(nPx);
		for (let yy = 0; yy < h; yy++) {
			for (let xx = 0; xx < w; xx++) {
				if (etiqueta[yy * w + xx] !== iB) continue;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const y2 = yy + dy;
						const x2 = xx + dx;
						if (y2 >= 0 && y2 < h && x2 >= 0 && x2 < w) barrera[y2 * w + x2] = 1;
					}
				}
			}
		}
		const alcanzado = new Uint8Array(nPx);
		let cab = 0;
		let fin = 0;
		const sembrar = (p: number) => {
			if (!alcanzado[p] && !barrera[p]) {
				alcanzado[p] = 1;
				cola[fin++] = p;
			}
		};
		for (let xx = 0; xx < w; xx++) {
			sembrar(xx);
			sembrar((h - 1) * w + xx);
		}
		for (let yy = 0; yy < h; yy++) {
			sembrar(yy * w);
			sembrar(yy * w + w - 1);
		}
		while (cab < fin) {
			const p = cola[cab++];
			const xx = p % w;
			const yy = (p - xx) / w;
			if (xx > 0) sembrar(p - 1);
			if (xx < w - 1) sembrar(p + 1);
			if (yy > 0) sembrar(p - w);
			if (yy < h - 1) sembrar(p + w);
		}
		const encerrados = new Float64Array(P + 1);
		let total = 0;
		for (let p = 0; p < nPx; p++) {
			const e = etiqueta[p];
			if (e && e !== iB && !alcanzado[p] && !barrera[p]) {
				encerrados[e]++;
				total++;
			}
		}
		return {barrera, alcanzado, encerrados, total};
	};
	// Fracción de la orilla de la caja que ocupa cada pico (0 = mezcla): un pico que llena la orilla es el fondo.
	const orillaPico = new Float64Array(P + 1);
	let nOrilla = 0;
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			if (yy !== 0 && yy !== h - 1 && xx !== 0 && xx !== w - 1) continue;
			nOrilla++;
			orillaPico[etiqueta[yy * w + xx]]++;
		}
	}
	for (let i = 0; i <= P; i++) orillaPico[i] /= Math.max(1, nOrilla);
	const masClaro = (i: number, j: number) => picos[i - 1].lab[0] > picos[j - 1].lab[0];

	const diag = op.diagnostico;
	type Prueba = ReturnType<typeof inundar> & {iB: number; iR: number; puntaje: number; fraccion: number};
	let mejor: Prueba | null = null;
	/** 3b) La mejor lectura de relleno claro con su contorno oscuro fundido con el fondo. */
	let fundido: Prueba | null = null;
	const pruebas: Array<Record<string, unknown>> = [];
	for (let iB = 1; iB <= P; iB++) {
		if (corridas[iB].length < 10) continue;
		const prueba = inundar(iB);
		let iR = 0;
		for (let i = 1; i <= P; i++) if (i !== iB && (!iR || prueba.encerrados[i] > prueba.encerrados[iR])) iR = i;
		if (!iR) continue;
		const fraccion = vecindad[iR][iB] / Math.max(1, sumaVecindad(iR));
		const contraste = dist76(picos[iB - 1].lab, picos[iR - 1].lab);
		const delgado = corridaMediana(iB) < corridaMediana(iR);
		const suficiente = prueba.encerrados[iR] >= Math.max(10, 0.02 * nPx);
		const valida = contraste >= 25 && delgado && suficiente;
		const puntaje = valida ? prueba.encerrados[iR] * fraccion : 0;
		// Falla solo por "delgado" porque el pico oscuro (contorno + fondo) llena la orilla, y encierra un relleno
		// claro que no la toca y que solo lo toca a él.
		const esFundido =
			contraste >= 25 && !delgado && suficiente && fraccion >= 0.8 && masClaro(iR, iB) && orillaPico[iB] >= 0.5 && orillaPico[iR] <= ORILLA_MAX_RELLENO;
		const puntajeFundido = esFundido ? prueba.encerrados[iR] * fraccion : 0;
		pruebas.push({borde: iB, relleno: iR, encerrados: prueba.encerrados[iR], fraccion: Number(fraccion.toFixed(3)), contraste: Number(contraste.toFixed(1)), delgado, puntaje, fundido: esFundido});
		if (puntaje > 0 && (!mejor || puntaje > mejor.puntaje)) mejor = {...prueba, iB, iR, puntaje, fraccion};
		if (puntajeFundido > 0 && (!fundido || puntajeFundido > fundido.puntaje)) fundido = {...prueba, iB, iR, puntaje: puntajeFundido, fraccion};
	}
	// 3b) La lectura fundida gana si no hubo otra, o si la ganadora es la de al revés: relleno oscuro que llena la
	//     orilla (es el fondo) y es justo el pico que la fundida toma como contorno.
	const alReves = mejor !== null && masClaro(mejor.iB, mejor.iR) && orillaPico[mejor.iR] > 0.5;
	const usarFundido = fundido !== null && (mejor === null || (alReves && fundido.iB === mejor.iR));
	const elegida = usarFundido ? fundido : mejor;
	diag?.({
		picos: picos.map((pk, i) => ({i: i + 1, color: rgbAHex(labARgb(pk.lab)), n: pk.n, corrida: corridaMediana(i + 1), vecindad: sumaVecindad(i + 1), orilla: Number(orillaPico[i + 1].toFixed(3))})),
		mezclasQuitadas: mezclas.filter(Boolean).length,
		pruebas,
		elegida: elegida ? {borde: elegida.iB, relleno: elegida.iR, fundido: usarFundido} : null,
	});
	if (!elegida) return null;
	const iBorde = elegida.iB;
	const iRelleno = elegida.iR;
	const alcanzado = elegida.alcanzado;
	const esRelleno = (p: number) => etiqueta[p] === iRelleno && !alcanzado[p];
	// Confianza: qué tanto del área encerrada es de un solo color (el relleno) × qué tanto de la orilla del
	// relleno toca al borde.
	const pureza = elegida.encerrados[iRelleno] / Math.max(1, elegida.total);
	const confianza = Math.max(0, Math.min(1, pureza * Math.min(1, elegida.fraccion / 0.8)));
	const encerradosRelleno = elegida.encerrados[iRelleno];

	// 5) Colores: mediana RGB del relleno encerrado y del borde.
	const medianaRgb = (incluir: (p: number) => boolean): Rgb => {
		const canales: number[][] = [[], [], []];
		for (let p = 0; p < nPx; p++) {
			if (!incluir(p)) continue;
			canales[0].push(rgbs[p * 3]);
			canales[1].push(rgbs[p * 3 + 1]);
			canales[2].push(rgbs[p * 3 + 2]);
		}
		return canales.map((c) => Math.round(cuantil(c, 0.5) ?? 0)) as Rgb;
	};

	// 6) Grosor del borde y tallo del relleno (corridas con sus vecinos, saltando como máximo una mezcla).
	const corridasBorde: number[] = [];
	const corridasTallo: number[] = [];
	const recorrer = (largo: number, en: (k: number) => number) => {
		// B = borde, R = relleno encerrado, M = mezcla (sin pico), F = fondo (cualquier otro pico, o relleno alcanzable).
		const papel = (k: number): 'B' | 'R' | 'F' | 'M' => {
			const p = en(k);
			if (etiqueta[p] === iBorde) return 'B';
			if (esRelleno(p)) return 'R';
			return etiqueta[p] === 0 ? 'M' : 'F';
		};
		let k = 0;
		while (k < largo) {
			const tipo = papel(k);
			if (tipo !== 'B' && tipo !== 'R') {
				k++;
				continue;
			}
			let f = k;
			while (f + 1 < largo && papel(f + 1) === tipo) f++;
			const lado = (desde: number, paso: number): {t: string; mezcla: number} | null => {
				const j = desde + paso;
				if (j < 0 || j >= largo) return null;
				const t = papel(j);
				if (t !== 'M') return {t, mezcla: 0};
				const j2 = j + paso;
				if (j2 < 0 || j2 >= largo) return null;
				return {t: papel(j2), mezcla: 0.5};
			};
			const a = lado(k, -1);
			const b = lado(f, 1);
			const run = f - k + 1;
			if (a && b) {
				if (tipo === 'B') {
					const conRelleno = (a.t === 'R' ? 1 : 0) + (b.t === 'R' ? 1 : 0);
					if (conRelleno === 1) corridasBorde.push(run + a.mezcla + b.mezcla);
				} else if (a.t === 'B' && b.t === 'B') {
					corridasTallo.push(run + a.mezcla + b.mezcla);
				}
			}
			k = f + 1;
		}
	};
	for (let yy = 0; yy < h; yy++) recorrer(w, (k) => yy * w + k);
	for (let xx = 0; xx < w; xx++) recorrer(h, (k) => k * w + xx);

	return {
		relleno: medianaRgb(esRelleno),
		borde: medianaRgb((p) => etiqueta[p] === iBorde),
		// Con el contorno fundido no se ve dónde acaba: su grosor no se mide.
		grosor: !usarFundido && corridasBorde.length >= 5 ? cuantil(corridasBorde, 0.5) : null,
		tallo: corridasTallo.length >= 5 ? cuantil(corridasTallo, 0.5) : null,
		nRelleno: encerradosRelleno,
		nBorde: picos[iBorde - 1].n,
		nPx,
		confianza,
		orillaRelleno: orillaPico[iRelleno],
		...(usarFundido ? {fundido: true} : {}),
	};
}

// ───────────────────────────── Medición de un reel ─────────────────────────────

export type ResaltadoPalabra = {palabra: string; modo: 'color' | 'peso' | 'escala'; detalle: string};

export type EventoSubtitulo = {
	id: string;
	texto: string;
	palabras: number;
	lineas: number;
	mayusculas: boolean;
	confianza: number;
	/** [nDesde, nHasta) en cuadros nativos; desde/hasta en s (hasta = primer cuadro ya sin el texto). */
	nDesde: number;
	nHasta: number;
	desde: number;
	hasta: number;
	duracion: number;
	/** Centro de la caja, ancho y alto en base 1080×1920. */
	x: number;
	y: number;
	ancho: number;
	alto_caja: number;
	alto_mayuscula: number;
	color_texto: string | null;
	color_borde: string | null;
	/** px en base 1920. */
	grosor_borde: number | null;
	confianza_color: number;
	resaltado: ResaltadoPalabra[];
};

export type Cuantiles = {p10: number | null; p50: number | null; p90: number | null};

export type ResumenSubtitulos = {
	y_p10: number | null;
	y_p50: number | null;
	y_p90: number | null;
	ancho_p90: number | null;
	alto_mayuscula_p50: number | null;
	color_texto: string | null;
	color_borde: string | null;
	grosor_borde_p50: number | null;
	palabras_por_evento: Cuantiles;
	duracion: Cuantiles;
	/** % de eventos en MAYÚSCULAS. */
	mayusculas_pct: number | null;
	/** % de eventos en una sola línea. */
	una_linea_pct: number | null;
	/** % de eventos con alguna palabra resaltada, y cuántos por modo. */
	resaltado_pct: number | null;
	resaltado_modos: Record<'color' | 'peso' | 'escala', number>;
	/** n de cada métrica (eventos que la aportan). */
	n_por_metrica: Record<string, number>;
};

export type MedicionSubtitulos = {
	video: string;
	ancho: number;
	alto: number;
	fps: number;
	duracion_s: number;
	total_cuadros: number;
	/** Franja en px del video y en base 1920; null si no se encontró. */
	franja: (Franja & {px: {y0: number; y1: number}; base1920: {y0: number; y1: number; centro: number}}) | null;
	eventos: EventoSubtitulo[];
	resumen: ResumenSubtitulos;
	n: number;
	/**
	 * Estilo dominante de los subtítulos del reel (px en base 1920); null si no hubo con qué calcularlo.
	 * origen: 'reel' (de sus renglones) o 'previa' (el reel no dio con qué y se usó `referencia_previa`).
	 * renglones_fundidos: lecturas con tu contorno fundido con el fondo (p. ej. playera negra), que decidió la
	 * revisión guiada.
	 */
	estilo_referencia: {
		color_texto: string;
		color_borde: string;
		grosor_borde: number | null;
		tallo: number | null;
		n: number;
		renglones_guiados: number;
		origen: 'reel' | 'previa';
		renglones_fundidos: number;
	} | null;
	/** Estilo ya medido en otros reels tuyos con que se eligió la polaridad (px en base 1920); null si no había. */
	referencia_previa: {fuente: string; color_texto: string; color_borde: string; grosor_borde: number | null; tallo: number | null; n: number} | null;
	/** Renglones o palabras que cayeron en la franja sin el estilo de subtítulo (capturas, tuits, interfaces…) y se quitaron. */
	descartados: Array<{texto: string; nDesde: number; nHasta: number; motivo: string}>;
	factor_alto_caja: number;
	parametros: {fps_ubicar: number; fps_segmentar: number; paso_ubicar: number; paso_segmentar: number; modo_segmentar: 'fast' | 'accurate'};
	cuadros_leidos: {ubicar: number; segmentar: number; afinar: number; accurate: number};
	tiempos_s: {ubicar: number; segmentar: number; afinar: number; accurate: number; medir: number; total: number};
	/** Eventos con bordes de muestreo (antes de afinar), para diagnóstico. */
	eventos_muestreo: number;
	/**
	 * Solo con `depurar`: lo que leyó Vision en cada cuadro de la franja y, por renglón del cuadro de en medio de
	 * cada evento, su lectura de color (antes del filtro), su motivo de descarte y si lo aceptó la revisión guiada.
	 */
	depuracion?: {lecturas: LecturaCuadro[]; intermedias: LecturaCuadro[]; eventosMuestreo: EventoTexto[]; renglones: RenglonDepurado[]};
};

/** Lectura de color de un renglón, para diagnóstico (px del video). */
export type RenglonDepurado = {
	nDesde: number;
	nHasta: number;
	texto: string;
	relleno: string | null;
	borde: string | null;
	grosor: number | null;
	tallo: number | null;
	confianza: number | null;
	orilla: number | null;
	fundido: boolean;
	motivo: string | null;
	guiado: boolean;
};

export type OpcionesMedir = {
	fpsUbicar?: number;
	fpsSegmentar?: number;
	/** Nivel de Vision para segmentar a ~10 fps (el plan dice .fast; ver MODO_SEGMENTAR). */
	modoSegmentar?: 'fast' | 'accurate';
	hilos?: number;
	cpu?: boolean;
	/** Agrega `depuracion` (lecturas crudas) al resultado. */
	depurar?: boolean;
	alProgreso?: (mensaje: string) => void;
	/**
	 * Estilo ya medido en otros reels tuyos: elige la polaridad de la referencia (relleno claro con contorno oscuro)
	 * y la reemplaza si el reel no da con qué. Por defecto se carga de RUTAS_PREVIA; null = sin previa.
	 */
	previa?: ReferenciaPrevia | null;
};

function resumenVacio(): ResumenSubtitulos {
	return {
		y_p10: null,
		y_p50: null,
		y_p90: null,
		ancho_p90: null,
		alto_mayuscula_p50: null,
		color_texto: null,
		color_borde: null,
		grosor_borde_p50: null,
		palabras_por_evento: {p10: null, p50: null, p90: null},
		duracion: {p10: null, p50: null, p90: null},
		mayusculas_pct: null,
		una_linea_pct: null,
		resaltado_pct: null,
		resaltado_modos: {color: 0, peso: 0, escala: 0},
		n_por_metrica: {},
	};
}

/** Resumen de una lista de eventos (puro). Los colores se agregan con mediana en Lab. */
export function resumirEventos(eventos: EventoSubtitulo[]): ResumenSubtitulos {
	if (eventos.length === 0) return resumenVacio();
	const ys = eventos.map((e) => e.y);
	const anchos = eventos.map((e) => e.ancho);
	const altos = eventos.map((e) => e.alto_mayuscula);
	const conColor = eventos.filter((e) => e.color_texto && e.color_borde && e.confianza_color >= 0.5);
	const conGrosor = eventos.filter((e) => e.grosor_borde !== null && e.confianza_color >= 0.5);
	const hexALab = (hex: string): Lab => {
		const n = Number.parseInt(hex.slice(1), 16);
		return rgbALab([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
	};
	const labTexto = medianaLab(conColor.map((e) => hexALab(e.color_texto!)));
	const labBorde = medianaLab(conColor.map((e) => hexALab(e.color_borde!)));
	const palabras = eventos.map((e) => e.palabras);
	const duraciones = eventos.map((e) => e.duracion);
	const conResaltado = eventos.filter((e) => e.resaltado.length > 0);
	const modos = {color: 0, peso: 0, escala: 0};
	for (const e of conResaltado) for (const m of new Set(e.resaltado.map((r) => r.modo))) modos[m]++;
	const pct = (k: number) => Number(((100 * k) / eventos.length).toFixed(1));
	return {
		y_p10: redondear(cuantil(ys, 0.1)),
		y_p50: redondear(cuantil(ys, 0.5)),
		y_p90: redondear(cuantil(ys, 0.9)),
		ancho_p90: redondear(cuantil(anchos, 0.9)),
		alto_mayuscula_p50: redondear(cuantil(altos, 0.5)),
		color_texto: labTexto ? rgbAHex(labARgb(labTexto)) : null,
		color_borde: labBorde ? rgbAHex(labARgb(labBorde)) : null,
		grosor_borde_p50: redondear(cuantil(conGrosor.map((e) => e.grosor_borde!), 0.5), 2),
		palabras_por_evento: {p10: cuantil(palabras, 0.1), p50: cuantil(palabras, 0.5), p90: cuantil(palabras, 0.9)},
		duracion: {
			p10: redondear(cuantil(duraciones, 0.1), 3),
			p50: redondear(cuantil(duraciones, 0.5), 3),
			p90: redondear(cuantil(duraciones, 0.9), 3),
		},
		mayusculas_pct: pct(eventos.filter((e) => e.mayusculas).length),
		una_linea_pct: pct(eventos.filter((e) => e.lineas === 1).length),
		resaltado_pct: pct(conResaltado.length),
		resaltado_modos: modos,
		n_por_metrica: {
			y: ys.length,
			ancho: anchos.length,
			alto_mayuscula: altos.length,
			color: conColor.length,
			grosor_borde: conGrosor.length,
			palabras: palabras.length,
			duracion: duraciones.length,
		},
	};
}

/** Caja normalizada al cuadro → caja en px del recorte (con margen). */
function aPxRecorte(c: Rect, recorte: Rect, ancho: number, alto: number, margen = 0): CajaPx {
	return {
		x0: c.x * ancho - recorte.x - margen,
		y0: c.y * alto - recorte.y - margen,
		x1: (c.x + c.w) * ancho - recorte.x + margen,
		y1: (c.y + c.h) * alto - recorte.y + margen,
	};
}

/** ΔE2000 mínimo entre el relleno de una palabra y el del reel para llamarlo resaltado de color. */
export const UMBRAL_RESALTADO_COLOR = 20;

/** Croma mínimo (C*ab) de un resaltado de color: amarillo, verde o rojo pasan de 40; el gris de una interfaz no llega a 15. */
export const CROMA_MIN_RESALTADO = 20;

const compactar = (t: string) => normalizarTexto(t).replace(/\s+/g, '');

/** Croma C*ab de un color sRGB. */
export function croma(rgb: Rgb): number {
	const [, a, b] = rgbALab(rgb);
	return Math.hypot(a, b);
}

/** Palabra con su análisis de color, y el borde de su renglón (para saber si el análisis es de fiar). */
export type PalabraMedida = {texto: string; analisis: AnalisisColor | null; bordeRenglon: Rgb | null};

/** Referencia del reel para el resaltado: mediana de todas sus palabras confiables (casi todas van sin resaltar). */
export type ReferenciaResaltado = {relleno: Lab; tallo: number | null; grosor: number | null; n: number};

/**
 * ¿El análisis de la palabra es de fiar? Confianza ≥0.7, relleno encerrado (≤30 % de la orilla de su caja con
 * ese color), contorno visible (no fundido con el fondo), tiene letras y su borde se parece al del renglón.
 */
function palabraConfiable(p: PalabraMedida): boolean {
	return (
		!!p.analisis &&
		!p.analisis.fundido &&
		p.analisis.confianza >= 0.7 &&
		p.analisis.orillaRelleno <= ORILLA_MAX_RELLENO &&
		/[\p{L}\p{N}]/u.test(p.texto) &&
		(!p.bordeRenglon || deltaE2000(rgbALab(p.analisis.borde), rgbALab(p.bordeRenglon)) <= 15)
	);
}

/** Referencia de un reel a partir de todas sus palabras (pura). null si hay menos de 3 confiables. */
export function referenciaResaltado(palabras: PalabraMedida[]): ReferenciaResaltado | null {
	const validas = palabras.filter(palabraConfiable);
	if (validas.length < 3) return null;
	return {
		relleno: medianaLab(validas.map((p) => rgbALab(p.analisis!.relleno)))!,
		tallo: cuantil(validas.map((p) => p.analisis!.tallo).filter((x): x is number => x !== null), 0.5),
		grosor: cuantil(validas.map((p) => p.analisis!.grosor).filter((x): x is number => x !== null), 0.5),
		n: validas.length,
	};
}

/**
 * Palabras resaltadas de un evento contra la referencia del reel (pura). Solo cuentan palabras confiables.
 * - color: su relleno difiere > 20 de ΔE2000 del relleno de referencia, tiene color de verdad (croma ≥ 20) y su
 *   contorno mide lo mismo (0.5–2×). El texto gris de una interfaz o un tuit pegado al renglón queda en
 *   ΔE 14–21 con croma < 15; un resaltado de verdad, como amarillo sobre blanco, pasa de ΔE 25 y croma 80;
 * - escala: su trazo (tallo) Y su borde son ≥20 % más gruesos (al escalar una palabra crecen los dos);
 * - peso: su trazo es ≥25 % más grueso pero su borde no (más negrita, mismo tamaño).
 * Peso y escala solo en palabras de ≥3 letras. El alto de la caja no se usa: cambia con ascendentes y
 * descendentes ("no" contra "estoy").
 */
export function detectarResaltado(palabras: PalabraMedida[], ref: ReferenciaResaltado | null): ResaltadoPalabra[] {
	if (!ref) return [];
	const r: ResaltadoPalabra[] = [];
	for (const p of palabras.filter(palabraConfiable)) {
		const a = p.analisis!;
		const de = deltaE2000(rgbALab(a.relleno), ref.relleno);
		// Un resaltado de color conserva el contorno del subtítulo: su grosor tiene que parecerse al de referencia
		// (texto de una captura pegado al renglón no trae ese contorno).
		const contornoIgual = a.grosor !== null && ref.grosor !== null && ref.grosor > 0 && a.grosor / ref.grosor >= 0.5 && a.grosor / ref.grosor <= 2;
		if (de > UMBRAL_RESALTADO_COLOR && croma(a.relleno) >= CROMA_MIN_RESALTADO && contornoIgual) {
			r.push({palabra: p.texto, modo: 'color', detalle: `${rgbAHex(a.relleno)} (ΔE ${de.toFixed(1)})`});
		}
		// Peso y escala solo en palabras de 3 letras o más: en "el" o "no" el trazo sale de muy pocas corridas.
		if (compactar(p.texto).length < 3) continue;
		if (a.tallo === null || ref.tallo === null || !(ref.tallo > 0)) continue;
		const rTallo = a.tallo / ref.tallo;
		const rBorde = a.grosor !== null && ref.grosor !== null && ref.grosor > 0 ? a.grosor / ref.grosor : null;
		if (rTallo >= 1.2 && rBorde !== null && rBorde >= 1.2) {
			r.push({palabra: p.texto, modo: 'escala', detalle: `trazo ×${rTallo.toFixed(2)}, borde ×${rBorde.toFixed(2)}`});
		} else if (rTallo >= 1.25) {
			r.push({palabra: p.texto, modo: 'peso', detalle: `trazo ×${rTallo.toFixed(2)}${rBorde !== null ? `, borde ×${rBorde.toFixed(2)}` : ''}`});
		}
	}
	return r;
}

/**
 * Estilo dominante de los subtítulos de un reel (de sus renglones con estructura de subtítulo). Grosor y tallo en
 * px del video. `origen`: 'reel' si salió de sus renglones, 'previa' si el reel no dio con qué y se usó la
 * referencia previa.
 */
export type EstiloReferencia = {relleno: Lab; borde: Lab; grosor: number | null; tallo: number | null; n: number; origen?: 'reel' | 'previa'};

/** Estilo de subtítulo ya medido en tus reels (grosor y tallo en px de base 1920; null si no se midió). */
export type ReferenciaPrevia = {relleno: Lab; borde: Lab; grosor: number | null; tallo: number | null; n: number; fuente: string};

/**
 * Referencia previa a partir del JSON de estilo/mini-estilo.json o de estilo/estilo.json (pura). Toma color de
 * texto y de borde (solo si su fuente dice "medido"), el grosor p50 y, si el archivo lo trae por reel
 * (mini-estilo: reels[].estilo_referencia.tallo), la mediana del trazo. null si falta algo de eso.
 */
export function referenciaPreviaDe(json: unknown, fuente: string): ReferenciaPrevia | null {
	if (!json || typeof json !== 'object') return null;
	const raiz = json as Record<string, unknown>;
	const seccion = (raiz.subtitulos && typeof raiz.subtitulos === 'object' ? raiz.subtitulos : raiz) as Record<string, unknown>;
	const metrica = (clave: string) => (seccion[clave] && typeof seccion[clave] === 'object' ? (seccion[clave] as {valor?: unknown; n?: unknown; fuente?: unknown}) : null);
	const hexMedido = (clave: string): string | null => {
		const m = metrica(clave);
		const v = m?.valor;
		return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v) && typeof m?.fuente === 'string' && m.fuente.startsWith('medido') ? v : null;
	};
	const positivo = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
	const texto = hexMedido('color_texto');
	const borde = hexMedido('color_borde');
	if (!texto || !borde) return null;
	const reels = Array.isArray(raiz.reels) ? (raiz.reels as Array<{estilo_referencia?: {tallo?: unknown} | null}>) : [];
	const tallos = reels.map((r) => positivo(r?.estilo_referencia?.tallo)).filter((x): x is number => x !== null);
	return {
		relleno: rgbALab(hexARgb(texto)),
		borde: rgbALab(hexARgb(borde)),
		grosor: positivo(metrica('grosor_borde_p50')?.valor),
		tallo: cuantil(tallos, 0.5),
		n: positivo(metrica('color_texto')?.n) ?? 0,
		fuente,
	};
}

/** Carga la referencia previa (RUTAS_PREVIA, en orden). null si no hay ninguna que sirva (no inventa). */
export function cargarReferenciaPrevia(raiz = RAIZ): ReferenciaPrevia | null {
	for (const ruta of RUTAS_PREVIA) {
		const absoluta = join(raiz, ruta);
		if (!existsSync(absoluta)) continue;
		try {
			const previa = referenciaPreviaDe(JSON.parse(readFileSync(absoluta, 'utf8')), ruta);
			if (previa) return previa;
		} catch {
			// JSON roto o a medio escribir: se prueba la siguiente.
		}
	}
	return null;
}

/** ¿Relleno más claro que el borde? (la polaridad de tus subtítulos: blanco con contorno negro). */
const rellenoClaro = (relleno: Lab, borde: Lab) => relleno[0] > borde[0];

/**
 * Estilo de referencia de un reel (pura): mediana de los renglones con estructura de subtítulo.
 * - Solo cuentan lecturas con el relleno encerrado (≤ 30 % de la orilla de su caja): si el "relleno" llena la
 *   orilla, es el fondo (la lectura al revés de un subtítulo sobre una playera negra).
 * - Las dos polaridades compiten: gana la de la referencia previa (tu estilo medido: relleno claro con contorno
 *   oscuro) o, sin previa, la de relleno claro; la otra solo si la preferida no junta 3 renglones.
 * - Dentro de cada polaridad, por niveles (el primero con ≥ 3): estructura de subtítulo (confianza ≥ 0.7, contorno
 *   visible y trazo del relleno ≥ 1.5× el borde) y cerca de la previa (ΔE2000 ≤ 20 en relleno y borde); confianza
 *   ≥ 0.5 y cerca de la previa; estructura sin la previa; confianza ≥ 0.5 sin la previa.
 * - Si nada junta 3, la referencia es la previa (origen 'previa', n = 0; grosor y tallo pasados a px del video con
 *   `pxPorBase` = alto del video ÷ 1920). null si tampoco hay previa.
 */
export function estiloDeReferencia(renglones: Array<AnalisisColor | null>, op: {previa?: ReferenciaPrevia | null; pxPorBase?: number} = {}): EstiloReferencia | null {
	const previa = op.previa ?? null;
	const validos = renglones.filter((a): a is AnalisisColor => !!a && a.orillaRelleno <= ORILLA_MAX_RELLENO);
	const polaridad = previa ? rellenoClaro(previa.relleno, previa.borde) : true;
	const conPolaridad = (claro: boolean) => validos.filter((a) => rellenoClaro(rgbALab(a.relleno), rgbALab(a.borde)) === claro);
	const cerca = (a: AnalisisColor) => !previa || (deltaE2000(rgbALab(a.relleno), previa.relleno) <= UMBRAL_PREVIA && deltaE2000(rgbALab(a.borde), previa.borde) <= UMBRAL_PREVIA);
	const estructura = (a: AnalisisColor) => !a.fundido && a.confianza >= 0.7 && a.tallo !== null && a.grosor !== null && a.tallo >= 1.5 * a.grosor;
	const relajado = (a: AnalisisColor) => a.confianza >= 0.5;
	const niveles: Array<(a: AnalisisColor) => boolean> = [(a) => estructura(a) && cerca(a), (a) => relajado(a) && cerca(a), estructura, relajado];
	const elegir = (grupo: AnalisisColor[]): AnalisisColor[] | null => {
		for (const nivel of niveles) {
			const base = grupo.filter(nivel);
			if (base.length >= 3) return base;
		}
		return null;
	};
	const base = elegir(conPolaridad(polaridad)) ?? elegir(conPolaridad(!polaridad));
	if (base) {
		return {
			relleno: medianaLab(base.map((a) => rgbALab(a.relleno)))!,
			borde: medianaLab(base.map((a) => rgbALab(a.borde)))!,
			grosor: cuantil(base.map((a) => a.grosor).filter((x): x is number => x !== null), 0.5),
			tallo: cuantil(base.map((a) => a.tallo).filter((x): x is number => x !== null), 0.5),
			n: base.length,
			origen: 'reel',
		};
	}
	if (!previa) return null;
	const px = op.pxPorBase ?? 1;
	return {
		relleno: previa.relleno,
		borde: previa.borde,
		grosor: previa.grosor !== null ? previa.grosor * px : null,
		tallo: previa.tallo !== null ? previa.tallo * px : null,
		n: 0,
		origen: 'previa',
	};
}

/**
 * Segunda revisión, guiada por el estilo del reel (pura): sirve cuando tu subtítulo pasa sobre un fondo oscuro
 * y su contorno negro se funde con el fondo (la revisión normal ya no ve un contorno delgado).
 * Píxeles "relleno" = a ≤18 de ΔE76 del relleno de referencia; "contorno" = a ≤8 del contorno de referencia
 * (estricto: negro puro, no el gris oscuro de una interfaz). Pasa si:
 * - el relleno ocupa ≥2 % de la caja;
 * - ≥70 % de la orilla del relleno toca contorno (directo o a través de un píxel de mezcla); el texto blanco
 *   de una interfaz oscura toca gris, no negro puro;
 * - el relleno casi no toca la orilla de la caja (≤20 %): una burbuja blanca con letras negras sí la toca;
 * - su trazo mide 0.5–2× el de referencia.
 * Devuelve un análisis con grosor null (el contorno no se puede medir) y confianza = fracción de la orilla
 * del relleno que toca contorno; null si no pasa.
 */
export function analizarGuiado(pix: Uint8Array, anchoImg: number, altoImg: number, caja: CajaPx, ref: EstiloReferencia): AnalisisColor | null {
	const x0 = Math.max(0, Math.floor(caja.x0));
	const y0 = Math.max(0, Math.floor(caja.y0));
	const x1 = Math.min(anchoImg, Math.ceil(caja.x1));
	const y1 = Math.min(altoImg, Math.ceil(caja.y1));
	const w = x1 - x0;
	const h = y1 - y0;
	if (w < 6 || h < 6) return null;
	const nPx = w * h;
	const R = 1;
	const B = 2;
	const etiqueta = new Uint8Array(nPx);
	const rgbs = new Uint8Array(nPx * 3);
	const cache = new Map<number, number>();
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			const o = ((y0 + yy) * anchoImg + (x0 + xx)) * 4;
			const p = yy * w + xx;
			rgbs[p * 3] = pix[o];
			rgbs[p * 3 + 1] = pix[o + 1];
			rgbs[p * 3 + 2] = pix[o + 2];
			const clave = (pix[o] << 16) | (pix[o + 1] << 8) | pix[o + 2];
			let e = cache.get(clave);
			if (e === undefined) {
				const lab = rgbALab([pix[o], pix[o + 1], pix[o + 2]]);
				e = dist76(lab, ref.relleno) <= 18 ? R : dist76(lab, ref.borde) <= 8 ? B : 0;
				cache.set(clave, e);
			}
			etiqueta[p] = e;
		}
	}
	let nR = 0;
	let orillaR = 0;
	let nOrilla = 0;
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			const p = yy * w + xx;
			if (etiqueta[p] === R) nR++;
			if (yy === 0 || yy === h - 1 || xx === 0 || xx === w - 1) {
				nOrilla++;
				if (etiqueta[p] === R) orillaR++;
			}
		}
	}
	if (nR < Math.max(10, 0.02 * nPx)) return null;
	if (orillaR / Math.max(1, nOrilla) > 0.2) return null;

	// Orilla del relleno: píxeles R con algún vecino (4) que no es R. ¿Toca contorno, directo o tras una mezcla?
	let frontera = 0;
	let tocan = 0;
	const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			if (etiqueta[yy * w + xx] !== R) continue;
			let esFrontera = false;
			let toca = false;
			for (const [dx, dy] of dirs) {
				const xa = xx + dx;
				const ya = yy + dy;
				if (xa < 0 || xa >= w || ya < 0 || ya >= h) continue;
				const e1 = etiqueta[ya * w + xa];
				if (e1 === R) continue;
				esFrontera = true;
				if (e1 === B) toca = true;
				else {
					const xb = xa + dx;
					const yb = ya + dy;
					if (xb >= 0 && xb < w && yb >= 0 && yb < h && etiqueta[yb * w + xb] === B) toca = true;
				}
			}
			if (esFrontera) {
				frontera++;
				if (toca) tocan++;
			}
		}
	}
	if (frontera < 20) return null;
	const fraccion = tocan / frontera;
	if (fraccion < 0.7) return null;

	// Trazo del relleno: corridas de R con contorno (o mezcla y contorno) de los dos lados.
	const tallos: number[] = [];
	const recorrer = (largo: number, en: (k: number) => number) => {
		let k = 0;
		while (k < largo) {
			if (etiqueta[en(k)] !== R) {
				k++;
				continue;
			}
			let f = k;
			while (f + 1 < largo && etiqueta[en(f + 1)] === R) f++;
			const lado = (desde: number, paso: number): number | null => {
				const j = desde + paso;
				if (j < 0 || j >= largo) return null;
				if (etiqueta[en(j)] === B) return 0;
				const j2 = j + paso;
				return etiqueta[en(j)] === 0 && j2 >= 0 && j2 < largo && etiqueta[en(j2)] === B ? 0.5 : null;
			};
			const a = lado(k, -1);
			const b = lado(f, 1);
			if (a !== null && b !== null) tallos.push(f - k + 1 + a + b);
			k = f + 1;
		}
	};
	for (let yy = 0; yy < h; yy++) recorrer(w, (k) => yy * w + k);
	for (let xx = 0; xx < w; xx++) recorrer(h, (k) => k * w + xx);
	const tallo = tallos.length >= 5 ? cuantil(tallos, 0.5) : null;
	if (tallo === null || ref.tallo === null || !(ref.tallo > 0) || tallo / ref.tallo < 0.5 || tallo / ref.tallo > 2) return null;

	const medianaRgb = (e: number): Rgb => {
		const canales: number[][] = [[], [], []];
		for (let p = 0; p < nPx; p++) {
			if (etiqueta[p] !== e) continue;
			canales[0].push(rgbs[p * 3]);
			canales[1].push(rgbs[p * 3 + 1]);
			canales[2].push(rgbs[p * 3 + 2]);
		}
		return canales.map((c) => Math.round(cuantil(c, 0.5) ?? 0)) as Rgb;
	};
	let nB = 0;
	for (let p = 0; p < nPx; p++) if (etiqueta[p] === B) nB++;
	return {relleno: medianaRgb(R), borde: medianaRgb(B), grosor: null, tallo, nRelleno: nR, nBorde: nB, nPx, confianza: fraccion, orillaRelleno: orillaR / Math.max(1, nOrilla)};
}

/**
 * Referencia para la revisión guiada (pura). La guiada busca TU contorno negro (≤ 8 de ΔE76), pero si la referencia
 * del reel salió de renglones sobre un fondo oscuro, su "borde" mezcla contorno y fondo (reel P2: #19171E, la
 * playera gris oscuro) y ya no reconoce el negro de verdad. Si el contorno de la previa (medido donde se ve) se parece
 * al del reel (ΔE2000 ≤ 20), la guía usa el de la previa; si no (otro estilo), el del reel.
 */
export function referenciaGuia(estilo: EstiloReferencia | null, previa: ReferenciaPrevia | null): EstiloReferencia | null {
	if (!estilo || !previa || deltaE2000(estilo.borde, previa.borde) > UMBRAL_PREVIA) return estilo;
	return {...estilo, borde: previa.borde};
}

export type MarcaPalabra = 'si' | 'no' | '?';

/**
 * ¿Una palabra tiene el contorno del subtítulo? (pura). 'si' si su análisis trae el contorno del reel
 * (ΔE2000 ≤ 12) y un trazo de 0.5–2× el de referencia (el relleno puede ser de otro color con croma: resaltado),
 * o si pasó la revisión guiada; 'no' si no, si su relleno llena la orilla (letras sobre etiqueta) o si es un gris
 * que no es tu relleno (texto de interfaz); '?' si es corta (≤2 letras: "a", "y", "de") y su análisis no es muy
 * claro (confianza < 0.7). Un análisis con el contorno fundido con el fondo da 'no' (que lo decida la revisión
 * guiada: con ese análisis no se distingue tu contorno negro del gris oscuro de una interfaz).
 */
export function marcarPalabra(texto: string, analisis: AnalisisColor | null, guiado: AnalisisColor | null, ref: EstiloReferencia): MarcaPalabra {
	if (guiado) return 'si';
	// Las palabras cortas solo se deciden con un análisis muy claro; si no, quedan en '?'.
	const corta = normalizarTexto(texto).replace(/\s+/g, '').length <= 2;
	if (corta && (!analisis || analisis.confianza < 0.7)) return '?';
	if (!analisis || analisis.confianza < 0.5) return 'no';
	if (analisis.fundido) return 'no';
	if (analisis.orillaRelleno > 0.5) return 'no'; // letras sobre un fondo del color del "relleno" (etiqueta, burbuja)
	if (deltaE2000(rgbALab(analisis.borde), ref.borde) > 12) return 'no';
	// Relleno gris o blancuzco que no es tu blanco (texto de interfaz): ni es tu relleno ni es un resaltado.
	if (deltaE2000(rgbALab(analisis.relleno), ref.relleno) > 15 && croma(analisis.relleno) < CROMA_MIN_RESALTADO) return 'no';
	if (analisis.tallo !== null && ref.tallo !== null && ref.tallo > 0) {
		const r = analisis.tallo / ref.tallo;
		if (r < 0.5 || r > 2) return 'no';
	}
	return 'si';
}

/**
 * Recorta de las puntas de un renglón las palabras sin el contorno del subtítulo (pura): texto de una captura
 * que quedó en el mismo renglón ("a conectores S&P Global" → "a conectores"). Las cortas ('?') se van solo si
 * la primera palabra decidida hacia adentro es 'no'. Las de en medio nunca se quitan. Devuelve [inicio, fin).
 */
export function recortarPalabras(marcas: MarcaPalabra[]): {inicio: number; fin: number} {
	const decididaDesde = (k: number, paso: number): MarcaPalabra | null => {
		for (let j = k; j >= 0 && j < marcas.length; j += paso) if (marcas[j] !== '?') return marcas[j];
		return null;
	};
	let inicio = 0;
	while (inicio < marcas.length && (marcas[inicio] === 'no' || (marcas[inicio] === '?' && decididaDesde(inicio, 1) === 'no'))) inicio++;
	let fin = marcas.length;
	while (fin > inicio && (marcas[fin - 1] === 'no' || (marcas[fin - 1] === '?' && decididaDesde(fin - 1, -1) === 'no'))) fin--;
	return {inicio, fin};
}

/**
 * Grosor del contorno que sí se puede usar (pura): fuera de 0.5–2× el de referencia, el contorno se fundió con
 * un fondo de su mismo color (o se comió con la compresión) y no es medible. Sin referencia, se usa tal cual.
 */
export function grosorConfiable(grosor: number | null, ref: EstiloReferencia | null): number | null {
	if (grosor === null || !ref || ref.grosor === null || !(ref.grosor > 0)) return grosor;
	const r = grosor / ref.grosor;
	return r >= 0.5 && r <= 2 ? grosor : null;
}

/**
 * ¿Un renglón tiene el estilo de los subtítulos del reel? (pura). Devuelve null si sí, o el motivo si no.
 * Así se quedan fuera los textos de capturas de pantalla, tuits o interfaces que caen en la franja: no traen
 * relleno encerrado por un contorno, o el color de su contorno, su relleno o el grosor de su trazo no se
 * parecen a los del reel.
 * El relleno basta con que lo tenga alguna palabra (una palabra resaltada puede dominar el renglón).
 * Un renglón con el contorno fundido con el fondo no pasa aquí: lo decide la revisión guiada (analizarGuiado), que
 * exige contorno negro de verdad y no el gris oscuro de una interfaz.
 */
export function motivoFueraDeEstilo(renglon: AnalisisColor | null, palabras: Array<AnalisisColor | null>, ref: EstiloReferencia | null): string | null {
	if (!ref) return null;
	if (!renglon) return 'no tiene relleno encerrado por un contorno';
	if (renglon.confianza < 0.5) return `colores poco claros (confianza ${renglon.confianza.toFixed(2)})`;
	if (renglon.fundido) return `contorno fundido con el fondo (${rgbAHex(renglon.borde)}): no se ve si es el tuyo`;
	const deBorde = deltaE2000(rgbALab(renglon.borde), ref.borde);
	if (deBorde > 15) return `contorno de otro color (${rgbAHex(renglon.borde)}, ΔE ${deBorde.toFixed(1)})`;
	const rellenoParecido = (a: AnalisisColor) => deltaE2000(rgbALab(a.relleno), ref.relleno) <= 15;
	if (!rellenoParecido(renglon) && !palabras.some((a) => a && a.confianza >= 0.5 && rellenoParecido(a))) {
		return `relleno de otro color (${rgbAHex(renglon.relleno)})`;
	}
	// El grosor del contorno NO se usa para descartar: sobre un fondo oscuro el contorno negro se funde con el
	// fondo y "engorda" aunque sea tu subtítulo (ahí el grosor se marca como no medible, ver grosorConfiable).
	if (renglon.tallo !== null && ref.tallo !== null && ref.tallo > 0) {
		const r = renglon.tallo / ref.tallo;
		if (r < 0.5 || r > 2) return `trazo de otro grosor (×${r.toFixed(2)})`;
	}
	return null;
}

/**
 * Mide los subtítulos de un reel. Devuelve eventos, resumen y n.
 * Si no encuentra franja de subtítulos, devuelve 0 eventos y el resumen en null (no inventa).
 */
export async function medirSubtitulos(mp4: string, op: OpcionesMedir = {}): Promise<MedicionSubtitulos> {
	const tInicio = performance.now();
	const avisar = op.alProgreso ?? (() => {});
	const so = await sondear(mp4);
	const ancho = so.video.anchoVisible;
	const alto = so.video.altoVisible;
	const fps = so.video.fpsNominal > 0 ? so.video.fpsNominal : so.video.fpsReal;
	if (!(fps > 0)) throw fallo(`medir ${basename(mp4)}`, 'ffprobe no reporta sus fps', 'revisa que el video esté completo', 2);
	const totalCuadros = so.video.cuadros ?? Math.round((so.video.duracion ?? so.duracion) * fps);
	const fpsUbicar = op.fpsUbicar ?? 2;
	const fpsSegmentar = op.fpsSegmentar ?? 10;
	const pasoUbicar = Math.max(1, Math.round(fps / fpsUbicar));
	const pasoSegmentar = Math.max(1, Math.round(fps / fpsSegmentar));
	const hilos = op.hilos ?? 2;
	const modoSegmentar = op.modoSegmentar ?? MODO_SEGMENTAR;
	const comun = {video: mp4, ancho, alto, fps, totalCuadros, hilos, cpu: op.cpu};
	// Tu estilo ya medido: decide la polaridad cuando tu contorno se funde con un fondo oscuro.
	const previa = op.previa === undefined ? cargarReferenciaPrevia() : op.previa;
	const referenciaPrevia: MedicionSubtitulos['referencia_previa'] = previa
		? {
				fuente: previa.fuente,
				color_texto: rgbAHex(labARgb(previa.relleno)),
				color_borde: rgbAHex(labARgb(previa.borde)),
				grosor_borde: previa.grosor,
				tallo: previa.tallo,
				n: previa.n,
			}
		: null;

	// 1) Franja.
	avisar(`ubicando la franja (${fpsUbicar} fps, cuadro completo)…`);
	const ubicar = await ocrCuadros({...comun, seleccion: {tipo: 'paso', paso: pasoUbicar}, modo: 'accurate', minAlto: 0.008});
	const franja = ubicarFranja(ubicar.cuadros, {periodo: pasoUbicar / fps});
	const base = {
		video: mp4,
		ancho,
		alto,
		fps,
		duracion_s: so.duracion,
		total_cuadros: totalCuadros,
		factor_alto_caja: FACTOR_ALTO_CAJA,
		parametros: {fps_ubicar: fps / pasoUbicar, fps_segmentar: fps / pasoSegmentar, paso_ubicar: pasoUbicar, paso_segmentar: pasoSegmentar, modo_segmentar: modoSegmentar},
	};
	if (!franja) {
		return {
			...base,
			franja: null,
			eventos: [],
			resumen: resumenVacio(),
			n: 0,
			estilo_referencia: null,
			referencia_previa: referenciaPrevia,
			descartados: [],
			cuadros_leidos: {ubicar: ubicar.cuadros.length, segmentar: 0, afinar: 0, accurate: 0},
			tiempos_s: {ubicar: ubicar.segundos, segmentar: 0, afinar: 0, accurate: 0, medir: 0, total: (performance.now() - tInicio) / 1000},
			eventos_muestreo: 0,
		};
	}
	const recorte: Rect = {x: 0, y: Math.floor(franja.y0 * alto), w: ancho, h: Math.ceil((franja.y1 - franja.y0) * alto)};
	const minAlto = Math.min(0.9, Math.max(0.02, (0.5 * franja.altoTexto * alto) / recorte.h));

	// 2) Segmentar a ~10 fps con .fast y afinar bordes a los fps nativos.
	avisar(`segmentando eventos (${(fps / pasoSegmentar).toFixed(1)} fps, .${modoSegmentar}, franja de ${recorte.h} px)…`);
	const seg = await eventosDeVideo({
		...comun,
		recorte,
		modo: modoSegmentar,
		minAlto,
		paso: pasoSegmentar,
		lectura: (c) => unirLineas(lineasSubtitulo(c, franja, ancho / alto)),
	});

	// 3) Una lectura .accurate por evento, con cajas por palabra y píxeles.
	avisar(`leyendo ${seg.eventos.length} eventos con .accurate…`);
	const medios = seg.eventos.map((e) => Math.floor((e.nDesde + e.nHasta - 1) / 2));
	const precisa = medios.length
		? await ocrCuadros({...comun, recorte, modo: 'accurate', minAlto, palabrasCajas: true, conservarPixeles: true, seleccion: {tipo: 'lista', cuadros: medios}})
		: {cuadros: [] as CuadroOcr[], recorte: recorte, segundos: 0};
	const porCuadro = new Map(precisa.cuadros.map((c) => [c.n, c]));

	// 4) Medir cada renglón de cada evento (color, borde, grosor, trazo) y cada una de sus palabras.
	const tMedir = performance.now();
	const rc = precisa.recorte;
	type Renglon = ReturnType<typeof lineasSubtitulo>[number];
	type RenglonMedido = {linea: Renglon; analisis: AnalisisColor | null; palabras: Array<{texto: string; caja: Rect; analisis: AnalisisColor | null}>};
	const medirRenglon = (cuadro: CuadroOcr, linea: Renglon): RenglonMedido => {
		if (!cuadro.pixeles) return {linea, analisis: null, palabras: []};
		// Margen para que el contorno completo quede adentro (si la orilla corta una letra, esa letra no cuenta).
		const margen = Math.max(3, Math.round(0.2 * linea.caja.h * alto));
		const analisis = analizarColores(cuadro.pixeles, rc.w, rc.h, aPxRecorte(linea.caja, rc, ancho, alto, margen));
		const palabras = linea.cajas
			.flatMap((c) => c.palabras ?? [])
			.map((p: PalabraOcr) => {
				const m = Math.max(3, Math.round(0.2 * p.h * alto));
				const px = aPxRecorte(p, rc, ancho, alto, 0);
				return {texto: p.texto, caja: {x: p.x, y: p.y, w: p.w, h: p.h}, analisis: analizarColores(cuadro.pixeles!, rc.w, rc.h, {x0: px.x0 - m / 2, x1: px.x1 + m / 2, y0: px.y0 - m, y1: px.y1 + m})};
			});
		return {linea, analisis, palabras};
	};
	const crudos = seg.eventos.map((e: EventoTexto, i) => {
		const cuadro = porCuadro.get(medios[i]);
		const renglones = cuadro ? lineasSubtitulo(cuadro, franja, ancho / alto).map((l) => medirRenglon(cuadro, l)) : [];
		return {e, cuadro, renglones, textoMuestreo: e.texto};
	});

	// 5) Estilo de referencia del reel y filtro: fuera los renglones que no tienen el estilo de subtítulo.
	//    La referencia solo sale de lecturas con el relleno encerrado y prefiere la polaridad de la previa.
	const lecturas = crudos.flatMap((c) => c.renglones.map((r) => r.analisis));
	const estilo = estiloDeReferencia(lecturas, {previa, pxPorBase: alto / BASE_H});
	// La revisión guiada busca tu contorno negro: el de la previa si se parece al del reel (ver referenciaGuia).
	const guia = referenciaGuia(estilo, previa);
	const fundidos = lecturas.filter((a) => a?.fundido).length;
	const descartados: Array<{texto: string; nDesde: number; nHasta: number; motivo: string}> = [];
	const filtrados: Array<{e: EventoTexto; renglones: RenglonMedido[]}> = [];
	const depurados: RenglonDepurado[] = [];
	let guiados = 0;
	for (const c of crudos) {
		const motivos: string[] = [];
		const cuadro = c.cuadro;
		const buenos = c.renglones.filter((r) => {
			const motivo = motivoFueraDeEstilo(r.analisis, r.palabras.map((p) => p.analisis), estilo);
			const leido = r.analisis;
			const depurar = (guiado: boolean) => {
				if (!op.depurar) return;
				depurados.push({
					nDesde: c.e.nDesde,
					nHasta: c.e.nHasta,
					texto: r.linea.texto,
					relleno: leido ? rgbAHex(leido.relleno) : null,
					borde: leido ? rgbAHex(leido.borde) : null,
					grosor: leido?.grosor ?? null,
					tallo: leido?.tallo ?? null,
					confianza: leido ? Number(leido.confianza.toFixed(3)) : null,
					orilla: leido ? Number(leido.orillaRelleno.toFixed(3)) : null,
					fundido: !!leido?.fundido,
					motivo,
					guiado,
				});
			};
			if (!motivo) {
				depurar(false);
				return true;
			}
			// Segunda revisión guiada por el estilo del reel (subtítulo sobre fondo oscuro: el contorno se funde).
			if (guia && cuadro?.pixeles) {
				const margen = Math.max(3, Math.round(0.2 * r.linea.caja.h * alto));
				const guiado = analizarGuiado(cuadro.pixeles, rc.w, rc.h, aPxRecorte(r.linea.caja, rc, ancho, alto, margen), guia);
				if (guiado) {
					r.analisis = guiado;
					guiados++;
					depurar(true);
					return true;
				}
			}
			depurar(false);
			motivos.push(`"${r.linea.texto}": ${motivo}`);
			return false;
		});
		if (c.renglones.length === 0 && estilo) {
			// Sin renglón en el cuadro de en medio no hay cómo revisar su estilo: no se cuenta.
			descartados.push({texto: c.textoMuestreo, nDesde: c.e.nDesde, nHasta: c.e.nHasta, motivo: 'la lectura .accurate del cuadro de en medio no encontró el renglón'});
			continue;
		}
		const anotar = () => {
			if (motivos.length) descartados.push({texto: c.renglones.map((r) => r.linea.texto).join(' / ') || c.textoMuestreo, nDesde: c.e.nDesde, nHasta: c.e.nHasta, motivo: motivos.join('; ')});
		};
		if (buenos.length === 0 && c.renglones.length > 0) {
			anotar();
			continue;
		}
		// Palabras de una captura pegadas al subtítulo en el mismo renglón: se recortan de las puntas.
		const recortados: RenglonMedido[] = [];
		for (const r of buenos) {
			if (!estilo || !cuadro?.pixeles || r.palabras.length < 2) {
				recortados.push(r);
				continue;
			}
			const marcas = r.palabras.map((p) => {
				let guiado: AnalisisColor | null = null;
				const sinGuia = marcarPalabra(p.texto, p.analisis, null, estilo);
				if (sinGuia === 'no') {
					const m = Math.max(3, Math.round(0.2 * p.caja.h * alto));
					const px = aPxRecorte(p.caja, rc, ancho, alto, 0);
					guiado = analizarGuiado(cuadro.pixeles!, rc.w, rc.h, {x0: px.x0 - m / 2, x1: px.x1 + m / 2, y0: px.y0 - m, y1: px.y1 + m}, guia ?? estilo);
				}
				return guiado ? 'si' : sinGuia;
			});
			const {inicio, fin} = recortarPalabras(marcas);
			if (inicio === 0 && fin === r.palabras.length) {
				recortados.push(r);
				continue;
			}
			const quitadas = [...r.palabras.slice(0, inicio), ...r.palabras.slice(fin)].map((p) => p.texto).join(' ');
			if (fin <= inicio) {
				motivos.push(`"${r.linea.texto}": ninguna palabra trae el contorno del subtítulo`);
				continue;
			}
			const quedan = r.palabras.slice(inicio, fin);
			const caja = unirLineas(quedan.map((p) => ({texto: p.texto, caja: p.caja, cajas: [], confianza: r.linea.confianza}))).caja!;
			const texto = quedan.map((p) => p.texto).join(' ');
			const linea: Renglon = {
				texto,
				caja,
				cajas: [{texto, confianza: r.linea.confianza, ...caja, palabras: quedan.map((p) => ({texto: p.texto, ...p.caja}))}],
				confianza: r.linea.confianza,
			};
			// Color y contorno otra vez, ya sin la parte ajena.
			const margen = Math.max(3, Math.round(0.2 * caja.h * alto));
			const cajaPx = aPxRecorte(caja, rc, ancho, alto, margen);
			let analisis = analizarColores(cuadro.pixeles, rc.w, rc.h, cajaPx);
			if (motivoFueraDeEstilo(analisis, quedan.map((p) => p.analisis), estilo)) analisis = analizarGuiado(cuadro.pixeles, rc.w, rc.h, cajaPx, guia ?? estilo) ?? r.analisis;
			motivos.push(`"${quitadas}": se quitó del renglón "${r.linea.texto}" (sin el contorno del subtítulo)`);
			recortados.push({linea, analisis, palabras: quedan});
		}
		anotar();
		if (recortados.length === 0) continue;
		filtrados.push({e: c.e, renglones: recortados});
	}

	// 6) Eventos contiguos que, ya sin el texto ajeno, dicen lo mismo, se unen (un tuit que cambió partía el subtítulo).
	const textoDe = (f: {renglones: RenglonMedido[]; e: EventoTexto}) => f.renglones.map((r) => r.linea.texto).join(' ') || f.e.texto;
	const cajaDe = (f: {renglones: RenglonMedido[]; e: EventoTexto}) => unirLineas(f.renglones.map((r) => r.linea)).caja ?? f.e.caja;
	const unidos: typeof filtrados = [];
	for (const f of filtrados) {
		const previo = unidos[unidos.length - 1];
		if (previo && f.e.nDesde - previo.e.nHasta <= 1 && mismoSubtitulo({texto: textoDe(previo), caja: cajaDe(previo)}, {texto: textoDe(f), caja: cajaDe(f)})) {
			previo.e = {...previo.e, nHasta: f.e.nHasta, hasta: f.e.hasta};
			continue;
		}
		unidos.push({e: {...f.e}, renglones: f.renglones});
	}

	// 7) Resaltado contra la referencia del reel (palabras de renglones con estilo, con su contorno igual al del
	//    reel). El color de texto de cada evento es el de sus palabras SIN resaltar.
	const bordeReel: Rgb | null = estilo ? labARgb(estilo.borde) : null;
	const palabrasDe = (f: (typeof unidos)[number]): PalabraMedida[] =>
		f.renglones.flatMap((r) => r.palabras.map((p) => ({texto: p.texto, analisis: p.analisis, bordeRenglon: bordeReel ?? r.analisis?.borde ?? null})));
	const referencia = referenciaResaltado(unidos.flatMap(palabrasDe));
	const eventos: EventoSubtitulo[] = unidos.map((f, i) => {
		const {e, renglones} = f;
		const unidas = unirLineas(renglones.map((r) => r.linea));
		const caja = unidas.caja ?? e.caja;
		const texto = unidas.texto || e.texto;
		const cajasOcr: CajaOcr[] = renglones.flatMap((r) => r.linea.cajas);
		const confianza = cajasOcr.length ? Math.min(...cajasOcr.map((c) => c.confianza)) : 0;
		// El renglón que manda el color, el borde y el grosor: el de mayor confianza.
		const analisis = renglones.map((r) => r.analisis).filter((a): a is AnalisisColor => !!a).sort((a, b) => b.confianza - a.confianza)[0] ?? null;
		const palabras = palabrasDe(f);
		const resaltado = palabras.length >= 2 ? detectarResaltado(palabras, referencia) : [];
		const resaltadas = new Set(resaltado.filter((r) => r.modo === 'color').map((r) => r.palabra));
		const sinResaltar = palabras.filter((p) => palabraConfiable(p) && !resaltadas.has(p.texto));
		const rellenoBase = sinResaltar.length ? medianaLab(sinResaltar.map((p) => rgbALab(p.analisis!.relleno))) : null;
		const colorTexto = rellenoBase ? rgbAHex(labARgb(rellenoBase)) : analisis ? rgbAHex(analisis.relleno) : null;
		const altoCaja = caja.h * BASE_H;
		const grosor = grosorConfiable(analisis?.grosor ?? null, estilo);
		return {
			id: `e${i + 1}`,
			texto,
			palabras: contarPalabras(texto),
			lineas: Math.max(1, renglones.length),
			mayusculas: esMayusculas(texto),
			confianza: Number(confianza.toFixed(3)),
			nDesde: e.nDesde,
			nHasta: e.nHasta,
			desde: Number(e.desde.toFixed(4)),
			hasta: Number(e.hasta.toFixed(4)),
			duracion: Number((e.hasta - e.desde).toFixed(4)),
			x: Number(((caja.x + caja.w / 2) * BASE_W).toFixed(1)),
			y: Number(((caja.y + caja.h / 2) * BASE_H).toFixed(1)),
			ancho: Number((caja.w * BASE_W).toFixed(1)),
			alto_caja: Number(altoCaja.toFixed(1)),
			alto_mayuscula: Number((altoCaja / FACTOR_ALTO_CAJA).toFixed(1)),
			color_texto: analisis ? colorTexto : null,
			color_borde: analisis ? rgbAHex(analisis.borde) : null,
			grosor_borde: grosor !== null ? Number(((grosor * BASE_H) / alto).toFixed(2)) : null,
			confianza_color: analisis ? Number(analisis.confianza.toFixed(2)) : 0,
			resaltado,
		};
	});
	const segundosMedir = (performance.now() - tMedir) / 1000;

	return {
		...base,
		franja: {
			...franja,
			px: {y0: recorte.y, y1: recorte.y + recorte.h},
			base1920: {y0: Number((franja.y0 * BASE_H).toFixed(1)), y1: Number((franja.y1 * BASE_H).toFixed(1)), centro: Number((franja.centroY * BASE_H).toFixed(1))},
		},
		eventos,
		resumen: resumirEventos(eventos),
		n: eventos.length,
		estilo_referencia: estilo
			? {
					color_texto: rgbAHex(labARgb(estilo.relleno)),
					color_borde: rgbAHex(labARgb(estilo.borde)),
					grosor_borde: estilo.grosor !== null ? Number(((estilo.grosor * BASE_H) / alto).toFixed(2)) : null,
					tallo: estilo.tallo !== null ? Number(((estilo.tallo * BASE_H) / alto).toFixed(2)) : null,
					n: estilo.n,
					renglones_guiados: guiados,
					origen: estilo.origen ?? 'reel',
					renglones_fundidos: fundidos,
				}
			: null,
		referencia_previa: referenciaPrevia,
		descartados,
		cuadros_leidos: {ubicar: ubicar.cuadros.length, segmentar: seg.cuadrosLeidos.muestreo, afinar: seg.cuadrosLeidos.afinado, accurate: precisa.cuadros.length},
		tiempos_s: {
			ubicar: Number(ubicar.segundos.toFixed(2)),
			segmentar: Number(seg.segundos.muestreo.toFixed(2)),
			afinar: Number(seg.segundos.afinado.toFixed(2)),
			accurate: Number(precisa.segundos.toFixed(2)),
			medir: Number(segundosMedir.toFixed(2)),
			total: Number(((performance.now() - tInicio) / 1000).toFixed(2)),
		},
		eventos_muestreo: seg.eventosMuestreo.length,
		...(op.depurar ? {depuracion: {lecturas: seg.lecturas, intermedias: seg.lecturasIntermedias, eventosMuestreo: seg.eventosMuestreo, renglones: depurados}} : {}),
	};
}

// ───────────────────────────── CLI ─────────────────────────────

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {
			salida: {type: 'string'},
			hilos: {type: 'string'},
			cpu: {type: 'boolean'},
			'sin-previa': {type: 'boolean'},
		},
	});
	if (positionals.length !== 1) {
		throw fallo('medir los subtítulos', 'falta el video (o sobran argumentos)', 'usa: npx tsx herramientas/estilo/medir.ts <reel.mp4> [--salida x.json]', 2);
	}
	const video = resolve(positionals[0]);
	const salida = resolve(values.salida ?? join(RAIZ, 'out', 'medir', `${basename(video, extname(video))}.json`));
	const m = await medirSubtitulos(video, {
		hilos: values.hilos ? Number(values.hilos) : undefined,
		cpu: values.cpu,
		alProgreso: (msg) => console.log(`· ${msg}`),
		...(values['sin-previa'] ? {previa: null} : {}),
	});
	mkdirSync(dirname(salida), {recursive: true});
	writeFileSync(salida, `${JSON.stringify({fecha: new Date().toISOString(), ...m}, null, '\t')}\n`);
	const r = m.resumen;
	if (m.n === 0) {
		console.log(`No encontré subtítulos en ${basename(video)} (no hay una línea que cambie cada 0.3–1.5 s en la mitad inferior).`);
	} else {
		console.log(`${basename(video)}: ${m.n} eventos en ${m.duracion_s.toFixed(1)} s (${m.fps} fps).`);
		console.log(`  Y (centro, base 1920): p10 ${r.y_p10} · p50 ${r.y_p50} · p90 ${r.y_p90}`);
		console.log(`  ancho p90 ${r.ancho_p90} px · alto de mayúscula p50 ${r.alto_mayuscula_p50} px · borde p50 ${r.grosor_borde_p50} px`);
		console.log(`  texto ${r.color_texto} · borde ${r.color_borde} (n=${r.n_por_metrica.color})`);
		const ref = m.estilo_referencia;
		console.log(
			`  referencia del reel: ${ref ? `${ref.color_texto}/${ref.color_borde} (${ref.origen === 'previa' ? 'de la previa' : `n=${ref.n}`}, ${ref.renglones_guiados} guiados, ${ref.renglones_fundidos} con el contorno fundido)` : 'N/A'}` +
				` · previa: ${m.referencia_previa ? `${m.referencia_previa.fuente} (${m.referencia_previa.color_texto}/${m.referencia_previa.color_borde})` : 'ninguna'} · ${m.descartados.length} descartados`,
		);
		console.log(`  palabras por evento p10/p50/p90: ${r.palabras_por_evento.p10}/${r.palabras_por_evento.p50}/${r.palabras_por_evento.p90}`);
		console.log(`  duración p10/p50/p90: ${r.duracion.p10}/${r.duracion.p50}/${r.duracion.p90} s · MAYÚSCULAS ${r.mayusculas_pct}% · resaltado ${r.resaltado_pct}%`);
	}
	console.log(`Tiempo: ${m.tiempos_s.total} s. Detalle: ${relative(RAIZ, salida)}`);
}

if (esPrincipal(import.meta.url)) void correr(main);
