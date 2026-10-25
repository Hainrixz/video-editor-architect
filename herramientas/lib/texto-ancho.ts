// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Ancho de un texto medido con fontkit sobre el MISMO archivo de fuente que carga el render
 * (src/estilo/fuentes.ts → biblioteca/fuentes/…), a un tamaño dado y con el borde incluido.
 *
 * Qué se mide (todo en px del tamaño pedido):
 * - avance: la suma de avances después de shaping (kerning, ligaduras y calt, como hace el navegador),
 *   más el letter-spacing por carácter. Es el ancho de la caja CSS del texto.
 * - tinta: dónde empieza y acaba el relleno de las letras (cajas de los glifos). Puede salirse de la caja CSS:
 *   la "j" tiene el lado izquierdo negativo, por ejemplo.
 * - trazo: dónde empieza y acaba lo que se pinta CON el borde. El borde sale `borde` px por fuera del contorno.
 *   Subtitulo.tsx dibuja el borde en SVG con uniones REDONDAS (UNION_BORDE = 'redonda'): el contorno engordado
 *   con un disco llega exacto a la caja del glifo ± borde. Con uniones en inglete (-webkit-text-stroke de HTML,
 *   miter límite 4 como Skia) el borde hace picos en las esquinas agudas ("W", "y", "t"); ese modelo se conserva
 *   por si algún día se vuelve a dibujar así.
 * - ancho: lo que ocupa el subtítulo CENTRADO (el navegador centra la caja CSS, no la tinta):
 *     max(avance + 2 × borde, 2 × max(avance/2 − trazoIzq, trazoDer − avance/2))
 *   El primer término es la regla base (ancho de fontkit + 2× el borde); el segundo cubre la tinta y los picos
 *   que se salen de la caja.
 * - anchoTinta: trazoDer − trazoIzq, lo que debería medir la caja de píxeles en un still.
 *
 * "borde" es el grosor VISIBLE por fuera de la letra (con paint-order: stroke fill, el trazo CSS mide el doble).
 */
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fallo} from './fallo.ts';

/** Lo poco de fontkit que se usa aquí (fontkit 2.0.4 no trae tipos). */
type CajaFk = {minX: number | null; minY: number | null; maxX: number | null; maxY: number | null};
type ComandoFk = {command: string; args: number[]};
type GlifoFk = {id: number; advanceWidth: number; bbox: CajaFk; path: {commands: ComandoFk[]}};
type PosicionFk = {xAdvance: number; yAdvance: number; xOffset: number; yOffset: number};
type CorridaFk = {glyphs: GlifoFk[]; positions: PosicionFk[]};
export type FuenteFk = {
	unitsPerEm: number;
	capHeight: number;
	ascent: number;
	descent: number;
	familyName: string;
	layout(texto: string): CorridaFk;
	glyphForCodePoint(codigo: number): GlifoFk;
};
type ModuloFontkit = {openSync(ruta: string): unknown};

/** Límite de inglete del trazo de texto en Chrome (Skia/Blink, como el miter-limit por defecto de SVG). */
export const LIMITE_INGLETE = 4;

/** Cómo une las esquinas el borde que dibuja Subtitulo.tsx (SVG con stroke-linejoin="round"). */
export const UNION_BORDE: 'redonda' | 'inglete' = 'redonda';

const requerir = createRequire(import.meta.url);
let fontkit: ModuloFontkit | null = null;
const abiertas = new Map<string, FuenteFk>();

/** Abre (una sola vez) un archivo de fuente con fontkit. Si falta el archivo: código 2 con el siguiente paso. */
export function abrirFuente(ruta: string): FuenteFk {
	const absoluta = resolve(ruta);
	const yaAbierta = abiertas.get(absoluta);
	if (yaAbierta) return yaAbierta;
	if (!existsSync(absoluta)) {
		throw fallo(
			'medir el ancho del texto',
			`no existe la fuente ${ruta}`,
			'corre `sh biblioteca/fuentes/preparar.sh` desde la raíz del proyecto para bajarla y prepararla',
			2,
		);
	}
	fontkit ??= requerir('fontkit') as ModuloFontkit;
	let fuente: unknown;
	try {
		fuente = fontkit.openSync(absoluta);
	} catch (error) {
		throw fallo('medir el ancho del texto', `fontkit no pudo abrir ${ruta}`, 'vuelve a correr `sh biblioteca/fuentes/preparar.sh`', 2, error);
	}
	if (!esFuenteSimple(fuente)) {
		throw fallo('medir el ancho del texto', `${ruta} es una colección de fuentes y espero una sola`, 'usa el .ttf de un solo peso', 2);
	}
	abiertas.set(absoluta, fuente);
	return fuente;
}

function esFuenteSimple(valor: unknown): valor is FuenteFk {
	return typeof valor === 'object' && valor !== null && typeof (valor as FuenteFk).layout === 'function' && typeof (valor as FuenteFk).unitsPerEm === 'number';
}

// ───────────────────────── borde con esquinas (inglete) ─────────────────────────

type Vec = {x: number; y: number};
type Tramo = {p0: Vec; p1: Vec; t0: Vec; t1: Vec};

const resta = (a: Vec, b: Vec): Vec => ({x: a.x - b.x, y: a.y - b.y});
const largo = (v: Vec): number => Math.hypot(v.x, v.y);

/** Primer vector no nulo de la lista, normalizado (la tangente de una curva con puntos de control repetidos). */
function direccion(...candidatos: Vec[]): Vec | null {
	for (const v of candidatos) {
		const l = largo(v);
		if (l > 1e-9) return {x: v.x / l, y: v.y / l};
	}
	return null;
}

/** Contornos del glifo como tramos con su tangente de salida (t0) y de llegada (t1). */
function contornos(comandos: readonly ComandoFk[]): Tramo[][] {
	const resultado: Tramo[][] = [];
	let actual: Tramo[] = [];
	let inicio: Vec | null = null;
	let punto: Vec | null = null;
	const cerrar = () => {
		if (inicio && punto && largo(resta(inicio, punto)) > 1e-9) {
			const t = direccion(resta(inicio, punto))!;
			actual.push({p0: punto, p1: inicio, t0: t, t1: t});
		}
		if (actual.length > 0) resultado.push(actual);
		actual = [];
		punto = inicio;
	};
	for (const {command, args} of comandos) {
		if (command === 'moveTo') {
			if (actual.length > 0) cerrar();
			inicio = {x: args[0], y: args[1]};
			punto = inicio;
		} else if (command === 'closePath') {
			cerrar();
		} else if (punto) {
			let tramo: Tramo | null = null;
			if (command === 'lineTo') {
				const p1 = {x: args[0], y: args[1]};
				const t = direccion(resta(p1, punto));
				if (t) tramo = {p0: punto, p1, t0: t, t1: t};
			} else if (command === 'quadraticCurveTo') {
				const c = {x: args[0], y: args[1]};
				const p1 = {x: args[2], y: args[3]};
				const t0 = direccion(resta(c, punto), resta(p1, punto));
				const t1 = direccion(resta(p1, c), resta(p1, punto));
				if (t0 && t1) tramo = {p0: punto, p1, t0, t1};
			} else if (command === 'bezierCurveTo') {
				const c1 = {x: args[0], y: args[1]};
				const c2 = {x: args[2], y: args[3]};
				const p1 = {x: args[4], y: args[5]};
				const t0 = direccion(resta(c1, punto), resta(c2, punto), resta(p1, punto));
				const t1 = direccion(resta(p1, c2), resta(p1, c1), resta(p1, punto));
				if (t0 && t1) tramo = {p0: punto, p1, t0, t1};
			}
			if (tramo) {
				actual.push(tramo);
				punto = tramo.p1;
			}
		}
	}
	if (actual.length > 0) cerrar();
	return resultado;
}

/**
 * Picos del inglete: en cada esquina del contorno, el borde de radio r llega hasta
 *   V + (nA + nB) · 2r / |nA + nB|²   (nA, nB = normales del lado de afuera del giro)
 * salvo que 1 / cos(φ/2) > límite (φ = giro), donde Skia corta en bisel (y el bisel no pasa de r).
 * Devuelve las x de los picos, en unidades de la fuente.
 */
function xDePicos(comandos: readonly ComandoFk[], r: number): number[] {
	const xs: number[] = [];
	for (const tramos of contornos(comandos)) {
		for (let k = 0; k < tramos.length; k++) {
			const a = tramos[k].t1;
			const b = tramos[(k + 1) % tramos.length].t0;
			const cruz = a.x * b.y - a.y * b.x;
			const punto = a.x * b.x + a.y * b.y;
			if (punto > 1 - 1e-9) continue; // sin esquina: lo cubre la caja ± r
			// Afuera del giro: a la derecha si gira a la izquierda (cruz > 0) y al revés. Unidades con y hacia arriba.
			const nA = cruz >= 0 ? {x: a.y, y: -a.x} : {x: -a.y, y: a.x};
			const nB = cruz >= 0 ? {x: b.y, y: -b.x} : {x: -b.y, y: b.x};
			const m = {x: nA.x + nB.x, y: nA.y + nB.y};
			const m2 = m.x * m.x + m.y * m.y; // = 4 cos²(φ/2)
			if (m2 < 1e-12 || Math.sqrt(m2) / 2 < 1 / LIMITE_INGLETE) continue; // bisel
			xs.push(tramos[k].p1.x + (m.x * 2 * r) / m2);
		}
	}
	return xs;
}

const extremosCache = new Map<string, {min: number; max: number} | null>();

/** Extremos en x del glifo pintado con borde de radio r (unidades de la fuente). null si el glifo no tiene tinta. */
function extremosConBorde(ruta: string, glifo: GlifoFk, r: number): {min: number; max: number} | null {
	const llave = `${ruta}|${glifo.id}|${r.toFixed(4)}`;
	if (extremosCache.has(llave)) return extremosCache.get(llave)!;
	const caja = glifo.bbox;
	let extremos: {min: number; max: number} | null = null;
	if (caja.minX !== null && caja.maxX !== null && Number.isFinite(caja.minX) && Number.isFinite(caja.maxX) && caja.maxX > caja.minX) {
		extremos = {min: caja.minX - r, max: caja.maxX + r};
		if (r > 0 && UNION_BORDE === 'inglete') {
			for (const x of xDePicos(glifo.path.commands, r)) {
				extremos.min = Math.min(extremos.min, x);
				extremos.max = Math.max(extremos.max, x);
			}
		}
	}
	extremosCache.set(llave, extremos);
	return extremos;
}

// ───────────────────────── medición ─────────────────────────

/** Un pedazo de texto con su fuente y tamaño (una palabra resaltada va en su propia corrida). */
export type CorridaTexto = {texto: string; ruta: string; tamanoPx: number; espaciadoPx?: number};

export type MedidaTexto = {
	avance: number;
	/** Inicio del relleno respecto al inicio de la caja CSS (negativo si se sale por la izquierda). null si no hay tinta. */
	tintaIzq: number | null;
	/** Fin del relleno respecto al inicio de la caja CSS. null si no hay tinta. */
	tintaDer: number | null;
	/** Inicio de lo pintado con borde (picos incluidos). null si no hay tinta. */
	trazoIzq: number | null;
	/** Fin de lo pintado con borde (picos incluidos). null si no hay tinta. */
	trazoDer: number | null;
	/** Ancho que ocupa centrado, con el borde. */
	ancho: number;
	/** Ancho de lo pintado con borde (lo que mide la caja de píxeles). */
	anchoTinta: number;
};

const SEGMENTADOR = new Intl.Segmenter('es', {granularity: 'grapheme'});

function revisarNumero(valor: number, etiqueta: string): void {
	if (!Number.isFinite(valor) || valor < 0) {
		throw fallo('medir el ancho del texto', `${etiqueta} tiene que ser un número ≥ 0 (llegó ${valor})`, 'revisa el estilo de subtítulos', 1);
	}
}

/** Mide varias corridas puestas una tras otra en la misma línea (como los <span> de un subtítulo). */
export function medirCorridas(corridas: readonly CorridaTexto[], bordePx = 0): MedidaTexto {
	revisarNumero(bordePx, 'el borde');
	let pluma = 0;
	let tintaIzq = Infinity;
	let tintaDer = -Infinity;
	let trazoIzq = Infinity;
	let trazoDer = -Infinity;
	for (const corrida of corridas) {
		revisarNumero(corrida.tamanoPx, 'el tamaño de letra');
		const espaciado = corrida.espaciadoPx ?? 0;
		if (!Number.isFinite(espaciado)) {
			throw fallo('medir el ancho del texto', `el espaciado tiene que ser un número (llegó ${espaciado})`, 'revisa el estilo de subtítulos', 1);
		}
		if (corrida.texto.length === 0 || corrida.tamanoPx === 0) continue;
		const fuente = abrirFuente(corrida.ruta);
		const escala = corrida.tamanoPx / fuente.unitsPerEm;
		const radio = bordePx / escala;
		const {glyphs, positions} = fuente.layout(corrida.texto);
		for (let k = 0; k < glyphs.length; k++) {
			const caja = glyphs[k].bbox;
			const x = pluma + positions[k].xOffset * escala;
			if (caja.minX !== null && caja.maxX !== null && Number.isFinite(caja.minX) && Number.isFinite(caja.maxX) && caja.maxX > caja.minX) {
				tintaIzq = Math.min(tintaIzq, x + caja.minX * escala);
				tintaDer = Math.max(tintaDer, x + caja.maxX * escala);
				const extremos = extremosConBorde(corrida.ruta, glyphs[k], radio);
				if (extremos) {
					trazoIzq = Math.min(trazoIzq, x + extremos.min * escala);
					trazoDer = Math.max(trazoDer, x + extremos.max * escala);
				}
			}
			pluma += positions[k].xAdvance * escala;
		}
		// letter-spacing: el navegador lo suma después de cada carácter, también del último.
		if (espaciado !== 0) pluma += espaciado * [...SEGMENTADOR.segment(corrida.texto)].length;
	}
	const avance = pluma;
	const hayTinta = trazoDer > trazoIzq;
	const mitad = avance / 2;
	const centrado = hayTinta ? 2 * Math.max(mitad - trazoIzq, trazoDer - mitad) : 0;
	return {
		avance,
		tintaIzq: hayTinta ? tintaIzq : null,
		tintaDer: hayTinta ? tintaDer : null,
		trazoIzq: hayTinta ? trazoIzq : null,
		trazoDer: hayTinta ? trazoDer : null,
		ancho: Math.max(avance + 2 * bordePx, centrado),
		anchoTinta: hayTinta ? trazoDer - trazoIzq : 0,
	};
}

/** Mide un texto en una sola fuente. */
export function medirTexto(ruta: string, texto: string, tamanoPx: number, bordePx = 0, espaciadoPx = 0): MedidaTexto {
	return medirCorridas([{texto, ruta, tamanoPx, espaciadoPx}], bordePx);
}

/** Ancho centrado con el borde incluido (px del tamaño pedido). */
export function anchoTexto(ruta: string, texto: string, tamanoPx: number, bordePx = 0, espaciadoPx = 0): number {
	return medirTexto(ruta, texto, tamanoPx, bordePx, espaciadoPx).ancho;
}
