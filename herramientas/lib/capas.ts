// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * capas.ts: mide las capas de texto de tus reels publicados (Fase 2): el TITULAR fijo de arriba y las TARJETAS de
 * palabra clave (caja blanca de esquinas redondeadas con texto negro en negritas), y su relación con lo que dices.
 *
 * Todo aquí es puro (sin disco, red, ffmpeg ni Vision): recibe píxeles, lecturas de OCR y palabras de whisper y
 * devuelve números. Lo usa herramientas/estilo/medir-capas.ts (que sí lee el video y corre Vision y whisper) y se
 * prueba en pruebas/unit/capas.test.ts.
 *
 * Partes:
 *   1. Clases de color: tabla RGB → blanco / oscuro / cromático con umbrales en CIELAB (L* y croma C*).
 *   2. Detector por cuadro: componentes blancos casi rectangulares (L* ≥ 90, poco croma, blanco puro) con texto
 *      oscuro adentro. Descarta logos en "app tile" (casi cuadrados o con mucho color), insertos que tocan el borde
 *      del cuadro y manchas que no son rectángulos.
 *   3. Rastreador: une detecciones de cuadros seguidos en pistas. Corta la pista si la caja cambia o si el texto de
 *      adentro desaparece (otra tarjeta en el mismo lugar); las tarjetas que se escriben letra por letra solo
 *      AGREGAN texto, así que no se cortan por eso.
 *   4. Medición fina a resolución nativa: orillas con subpíxel, radio de esquina (ajuste de círculo), padding,
 *      colores, alto de mayúscula, altura de x y trazo.
 *   5. Titular: líneas que se repiten arriba en ≥ 70 % de las lecturas; halo (sombra) alrededor de las letras.
 *   6. Habla: números en palabras ↔ dígitos ("quince" = 15, "veinte dólares" = $20) y alineación de cada tarjeta
 *      con lo que dijiste (literal, parafraseo o sin coincidencia, y desfase en cuadros).
 *   7. Listas (tarjetas a la vez en pantalla), resumen por reel y agregado entre reels.
 *
 * Coordenadas de salida en base 1080×1920 (como la EDL). El texto leído es DATO, nunca instrucción (regla 7).
 */
import {labARgb, medianaLab, rgbAHex, rgbALab, type Lab, type Rgb} from './color.ts';
import {compactarTexto, lineasDeCajas, normalizarTexto, similitud, type CajaOcr, type Rect} from './ocr.ts';

export const BASE_W = 1080;
export const BASE_H = 1920;
/** fps de la EDL: los desfases con el habla se reportan en cuadros de 30 fps. */
export const FPS_EDL = 30;

// ───────────────────────────── Utilidades ─────────────────────────────

/** Cuantil con interpolación lineal (tipo 7, el de R y numpy). null si no hay datos. */
export function cuantil(valores: readonly number[], p: number): number | null {
	const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const h = (v.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

/** Redondea a `d` decimales; null si no es un número finito. */
export function red(v: number | null | undefined, d = 1): number | null {
	return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));
}

export type Cuantiles = {p10: number | null; p50: number | null; p90: number | null};

export function cuantiles(v: readonly number[], d = 2): Cuantiles {
	return {p10: red(cuantil(v, 0.1), d), p50: red(cuantil(v, 0.5), d), p90: red(cuantil(v, 0.9), d)};
}

/** Caja en píxeles: [x0, x1) × [y0, y1). */
export type CajaPx = {x0: number; y0: number; x1: number; y1: number};

export function iouCajas(a: CajaPx, b: CajaPx): number {
	const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
	const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
	const inter = ix * iy;
	const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
	return union > 0 ? inter / union : 0;
}

/** Luma (Rec. 709 sobre valores sRGB de 0–255; sirve para orillas, no para color). */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function medianaRgb(r: number[], g: number[], b: number[]): Rgb | null {
	if (r.length === 0) return null;
	return [Math.round(cuantil(r, 0.5)!), Math.round(cuantil(g, 0.5)!), Math.round(cuantil(b, 0.5)!)];
}

// ───────────────────────────── 1. Clases de color ─────────────────────────────

export const CLASE = {blanco: 1, oscuro: 2, croma: 4} as const;

export type UmbralesColor = {
	/** L* mínimo del blanco de la tarjeta. */
	lBlanco: number;
	/** Croma C*ab máximo del blanco. */
	cBlanco: number;
	/** L* máximo del texto oscuro. */
	lOscuro: number;
	/** Croma desde el que un píxel cuenta como "con color". */
	cCroma: number;
};

export const UMBRALES_COLOR: UmbralesColor = {lBlanco: 90, cBlanco: 12, lOscuro: 45, cCroma: 25};

/** Índice de la tabla de clases: 6 bits por canal. */
export const indiceTabla = (r: number, g: number, b: number) => ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);

/** Tabla RGB (64³, 6 bits por canal) → bits de CLASE, calculada en CIELAB con el centro de cada celda. */
export function tablaClases(u: UmbralesColor = UMBRALES_COLOR): Uint8Array {
	const t = new Uint8Array(1 << 18);
	for (let r = 0; r < 64; r++) {
		for (let g = 0; g < 64; g++) {
			for (let b = 0; b < 64; b++) {
				const lab = rgbALab([r * 4 + 1.5, g * 4 + 1.5, b * 4 + 1.5]);
				const c = Math.hypot(lab[1], lab[2]);
				let k = 0;
				if (lab[0] >= u.lBlanco && c <= u.cBlanco) k |= CLASE.blanco;
				if (lab[0] <= u.lOscuro) k |= CLASE.oscuro;
				if (c >= u.cCroma) k |= CLASE.croma;
				t[(r << 12) | (g << 6) | b] = k;
			}
		}
	}
	return t;
}

// ───────────────────────────── 2. Detector de tarjetas por cuadro ─────────────────────────────

export type OpcionesTarjetas = {
	/** px de la imagen de análisis por px base 1080 (p. ej. 360 / 1080). */
	escala: number;
	altoMinBase: number;
	altoMaxBase: number;
	anchoMinBase: number;
	anchoMaxBase: number;
	/** ancho / alto mínimo: una caja casi cuadrada es un logo en "app tile", no una tarjeta. */
	aspectoMin: number;
	/** (blanco + huecos) / área de la caja; solo descarta manchas (las tarjetas de 2 renglones de distinto ancho bajan a ~0.7). */
	rellenoMin: number;
	/** Fracción de filas que caen en renglones de lados rectos (bandas de alto ≥ 40 % de la más alta). */
	coberturaMin: number;
	/** Máximo de bandas (renglones) de una tarjeta. */
	bandasMax: number;
	/** Huecos (texto) / área rellena. */
	huecosMin: number;
	huecosMax: number;
	/** Fracción de los huecos que es oscura (texto negro). */
	oscuroMin: number;
	/** Fracción de los huecos con color (un logo naranja llena más que esto). */
	cromaMax: number;
	/** Fracción del blanco que es blanco puro (los tres canales ≥ 245): tus tarjetas son #FFFFFF. */
	puroMin: number;
	/**
	 * Segunda oportunidad: si un componente blanco no tiene forma de tarjeta (se pegó a otra cosa clara, como el
	 * dibujo de una tienda), se vuelve a partir usando solo el blanco puro (≥ 245) dentro de su caja.
	 */
	reintentoPuro: boolean;
};

export const OPCIONES_TARJETAS: Omit<OpcionesTarjetas, 'escala'> = {
	altoMinBase: 22,
	altoMaxBase: 700,
	anchoMinBase: 40,
	anchoMaxBase: 1040,
	aspectoMin: 1.2,
	rellenoMin: 0.55,
	coberturaMin: 0.55,
	bandasMax: 6,
	huecosMin: 0.015,
	huecosMax: 0.7,
	oscuroMin: 0.12,
	cromaMax: 0.5,
	puroMin: 0.5,
	reintentoPuro: true,
};

export type MedidasCandidato = CajaPx & {
	/** Píxeles blancos del componente. */
	area: number;
	relleno: number;
	/** Fracción de filas en bandas rectas. */
	cobertura: number;
	huecos: number;
	oscuro: number;
	croma: number;
	puro: number;
};

export type Candidato = MedidasCandidato & {
	/** Huecos de la caja (1 = hueco: texto, emoji), fila por fila, de (x1 − x0) × (y1 − y0). */
	mascara: Uint8Array;
	/** Bandas rectas de arriba abajo (un renglón cada una), en px de la imagen de análisis. */
	bandas: CajaPx[];
};

export type CandidatoDescartado = MedidasCandidato & {motivo: string};

/**
 * Detector de tarjetas en una imagen de análisis (RGB o RGBA, ya reducida). Guarda sus búferes para no pedir
 * memoria en cada cuadro.
 * 1) Clases por píxel (tabla), 2) componentes 4-conexos de blanco, 3) por componente: caja, huecos (lo que no
 * es blanco y no se alcanza desde la orilla de la caja), forma por filas (cada fila llena de corrido y las filas
 * agrupadas en bandas rectas: una tarjeta de 2 renglones es una caja redondeada por renglón, unidas, y el de
 * abajo puede ser más angosto), color de los huecos y pureza del blanco.
 */
export class DetectorTarjetas {
	private readonly clases: Uint8Array;
	private readonly puros: Uint8Array;
	private readonly etiquetas: Int32Array;
	private readonly pila: Int32Array;
	private readonly marca: Int32Array;
	private generacion = 0;
	/** Última etiqueta usada en el cuadro (las del reintento con blanco puro siguen de aquí, sin chocar). */
	private etiqueta = 0;

	constructor(
		readonly ancho: number,
		readonly alto: number,
		private readonly tabla: Uint8Array,
		private readonly op: OpcionesTarjetas,
	) {
		const n = ancho * alto;
		this.clases = new Uint8Array(n);
		this.puros = new Uint8Array(n);
		this.etiquetas = new Int32Array(n);
		this.pila = new Int32Array(n);
		this.marca = new Int32Array(n);
	}

	detectar(img: Uint8Array, canales: 3 | 4, conDescartados = false): {candidatos: Candidato[]; descartados: CandidatoDescartado[]} {
		const w = this.ancho;
		const h = this.alto;
		const n = w * h;
		if (img.length < n * canales) throw new Error(`imagen corta: ${img.length} bytes para ${w}×${h}×${canales}`);
		const cl = this.clases;
		const pu = this.puros;
		const t = this.tabla;
		for (let p = 0, o = 0; p < n; p++, o += canales) {
			const r = img[o];
			const g = img[o + 1];
			const b = img[o + 2];
			cl[p] = t[((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)];
			pu[p] = r >= 245 && g >= 245 && b >= 245 ? 1 : 0;
		}
		const et = this.etiquetas;
		et.fill(0);
		const pila = this.pila;
		const e = this.op.escala;
		const areaMin = Math.max(20, Math.floor(0.5 * this.op.anchoMinBase * e * this.op.altoMinBase * e));
		const componentes: Array<{id: number; area: number; x0: number; y0: number; x1: number; y1: number}> = [];
		let id = 0;
		for (let p = 0; p < n; p++) {
			if (et[p] !== 0 || !(cl[p] & CLASE.blanco)) continue;
			id++;
			let tope = 0;
			pila[tope++] = p;
			et[p] = id;
			let area = 0;
			let x0 = w;
			let y0 = h;
			let x1 = -1;
			let y1 = -1;
			while (tope > 0) {
				const q = pila[--tope];
				area++;
				const x = q % w;
				const y = (q - x) / w;
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
				if (x > 0 && et[q - 1] === 0 && cl[q - 1] & CLASE.blanco) {
					et[q - 1] = id;
					pila[tope++] = q - 1;
				}
				if (x < w - 1 && et[q + 1] === 0 && cl[q + 1] & CLASE.blanco) {
					et[q + 1] = id;
					pila[tope++] = q + 1;
				}
				if (y > 0 && et[q - w] === 0 && cl[q - w] & CLASE.blanco) {
					et[q - w] = id;
					pila[tope++] = q - w;
				}
				if (y < h - 1 && et[q + w] === 0 && cl[q + w] & CLASE.blanco) {
					et[q + w] = id;
					pila[tope++] = q + w;
				}
			}
			if (area >= areaMin) componentes.push({id, area, x0, y0, x1: x1 + 1, y1: y1 + 1});
		}

		this.etiqueta = id;
		const candidatos: Candidato[] = [];
		const descartados: CandidatoDescartado[] = [];
		const deForma = /^(no es una caja|filas con huecos|lados no rectos|demasiadas bandas|renglones desalineados|unión de)/;
		for (const c of componentes) {
			const r = this.evaluar(c);
			if (!('motivo' in r)) {
				candidatos.push(r);
				continue;
			}
			// Segunda oportunidad con blanco puro dentro de su caja (si su blanco no era todo puro).
			const rescatados = this.op.reintentoPuro && deForma.test(r.motivo) && r.puro < 0.97 ? this.reintentarPuro(c) : [];
			if (rescatados.length) {
				candidatos.push(...rescatados);
			} else if (conDescartados) {
				descartados.push(r);
			}
		}
		return {candidatos, descartados};
	}

	/**
	 * Vuelve a partir la caja de un componente usando solo el blanco puro (≥ 245) y evalúa las piezas que salen. Las
	 * etiquetas nuevas siguen de la última usada en el cuadro (no chocan con nada).
	 */
	private reintentarPuro(c: {id: number; x0: number; y0: number; x1: number; y1: number}): Candidato[] {
		const w = this.ancho;
		const et = this.etiquetas;
		const pila = this.pila;
		const e = this.op.escala;
		const areaMin = Math.max(20, Math.floor(0.5 * this.op.anchoMinBase * e * this.op.altoMinBase * e));
		// Se re-etiquetan solo los píxeles del componente original que son blanco puro.
		const piezas: Array<{id: number; area: number; x0: number; y0: number; x1: number; y1: number}> = [];
		for (let y = c.y0; y < c.y1; y++) {
			for (let x = c.x0; x < c.x1; x++) {
				const p = y * w + x;
				if (et[p] !== c.id || !this.puros[p]) continue;
				const id = ++this.etiqueta;
				let tope = 0;
				pila[tope++] = p;
				et[p] = id;
				let area = 0;
				let x0 = w;
				let y0 = this.alto;
				let x1 = -1;
				let y1 = -1;
				while (tope > 0) {
					const q = pila[--tope];
					area++;
					const qx = q % w;
					const qy = (q - qx) / w;
					if (qx < x0) x0 = qx;
					if (qx > x1) x1 = qx;
					if (qy < y0) y0 = qy;
					if (qy > y1) y1 = qy;
					for (const v of [q - 1, q + 1, q - w, q + w]) {
						if (v < 0 || v >= et.length) continue;
						if ((v === q - 1 && qx === 0) || (v === q + 1 && qx === w - 1)) continue;
						if (et[v] === c.id && this.puros[v]) {
							et[v] = id;
							pila[tope++] = v;
						}
					}
				}
				if (area >= areaMin) piezas.push({id, area, x0, y0, x1: x1 + 1, y1: y1 + 1});
			}
		}
		const salida: Candidato[] = [];
		for (const pieza of piezas) {
			const r = this.evaluar(pieza);
			if (!('motivo' in r)) salida.push(r);
		}
		return salida;
	}

	private evaluar(c: {id: number; area: number; x0: number; y0: number; x1: number; y1: number}): Candidato | CandidatoDescartado {
		const w = this.ancho;
		const op = this.op;
		const {id, x0, y0, x1, y1} = c;
		const bw = x1 - x0;
		const bh = y1 - y0;
		const base: MedidasCandidato = {x0, y0, x1, y1, area: c.area, relleno: 0, cobertura: 0, huecos: 0, oscuro: 0, croma: 0, puro: 0};
		const fuera = (motivo: string, m: Partial<MedidasCandidato> = {}): CandidatoDescartado => ({...base, ...m, motivo});
		if (x0 === 0 || y0 === 0 || x1 === w || y1 === this.alto) return fuera('toca el borde del cuadro (inserto o fondo)');
		const altoBase = bh / op.escala;
		const anchoBase = bw / op.escala;
		if (altoBase < op.altoMinBase || altoBase > op.altoMaxBase || anchoBase < op.anchoMinBase || anchoBase > op.anchoMaxBase) {
			return fuera(`tamaño fuera de rango (${anchoBase.toFixed(0)}×${altoBase.toFixed(0)} px base)`);
		}
		const aspecto = bw / bh;
		if (aspecto < op.aspectoMin) return fuera(`casi cuadrada (aspecto ${aspecto.toFixed(2)}): logo o ícono`);

		// Inundación desde la orilla de la caja por lo que no es el componente: lo que no se alcanza son huecos.
		const et = this.etiquetas;
		const marca = this.marca;
		const pila = this.pila;
		const gen = ++this.generacion;
		let tope = 0;
		const sembrar = (q: number) => {
			if (et[q] !== id && marca[q] !== gen) {
				marca[q] = gen;
				pila[tope++] = q;
			}
		};
		for (let x = x0; x < x1; x++) {
			sembrar(y0 * w + x);
			sembrar((y1 - 1) * w + x);
		}
		for (let y = y0; y < y1; y++) {
			sembrar(y * w + x0);
			sembrar(y * w + x1 - 1);
		}
		while (tope > 0) {
			const q = pila[--tope];
			const x = q % w;
			const y = (q - x) / w;
			if (x > x0) sembrar(q - 1);
			if (x < x1 - 1) sembrar(q + 1);
			if (y > y0) sembrar(q - w);
			if (y < y1 - 1) sembrar(q + w);
		}
		const mascara = new Uint8Array(bw * bh);
		let huecos = 0;
		let oscuros = 0;
		let cromas = 0;
		let puros = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const q = y * w + x;
				if (et[q] === id) {
					if (this.puros[q]) puros++;
				} else if (marca[q] !== gen) {
					huecos++;
					mascara[(y - y0) * bw + (x - x0)] = 1;
					if (this.clases[q] & CLASE.oscuro) oscuros++;
					if (this.clases[q] & CLASE.croma) cromas++;
				}
			}
		}
		const lleno = c.area + huecos;
		const relleno = lleno / (bw * bh);
		// Forma por filas: primera y última columna llena, y que la fila esté llena de corrido.
		const izq = new Int32Array(bh).fill(-1);
		const der = new Int32Array(bh).fill(-1);
		let tramo = 0;
		for (let k = 0; k < bh; k++) {
			const fila = (y0 + k) * w;
			for (let x = x0; x < x1; x++) {
				const q = fila + x;
				if (et[q] === id || marca[q] !== gen) {
					if (izq[k] < 0) izq[k] = x;
					der[k] = x;
				}
			}
			if (izq[k] >= 0) tramo += der[k] - izq[k] + 1;
		}
		const corrido = lleno / Math.max(1, tramo);
		const bandasRel = renglones(bandasRectas(izq, der));
		const bandas = bandasRel.map((b) => ({x0: b.x0, x1: b.x1, y0: y0 + b.k0, y1: y0 + b.k1}));
		const cobertura = bandasRel.reduce((s, b) => s + b.k1 - b.k0, 0) / bh;
		const m: MedidasCandidato = {
			...base,
			relleno,
			cobertura,
			huecos: huecos / Math.max(1, lleno),
			oscuro: huecos ? oscuros / huecos : 0,
			croma: huecos ? cromas / huecos : 0,
			puro: puros / Math.max(1, c.area),
		};
		if (m.relleno < op.rellenoMin) return {...m, motivo: `no es una caja (relleno ${m.relleno.toFixed(2)})`};
		if (corrido < 0.97) return {...m, motivo: `filas con huecos (${corrido.toFixed(2)}): no es una caja`};
		if (m.cobertura < op.coberturaMin) return {...m, motivo: `lados no rectos (cobertura ${m.cobertura.toFixed(2)})`};
		if (bandas.length > op.bandasMax) return {...m, motivo: `demasiadas bandas (${bandas.length})`};
		const forma = formaDeBandas(bandas);
		if (forma) return {...m, motivo: forma};
		if (m.huecos < op.huecosMin) return {...m, motivo: `sin texto adentro (huecos ${m.huecos.toFixed(3)})`};
		if (m.huecos > op.huecosMax) return {...m, motivo: `casi vacía de blanco (huecos ${m.huecos.toFixed(2)})`};
		if (m.oscuro < op.oscuroMin) return {...m, motivo: `lo de adentro no es texto oscuro (oscuro ${m.oscuro.toFixed(2)})`};
		if (m.croma > op.cromaMax) return {...m, motivo: `adentro hay mucho color (croma ${m.croma.toFixed(2)}): logo o imagen`};
		if (m.puro < op.puroMin) return {...m, motivo: `el blanco no es puro (puro ${m.puro.toFixed(2)}): pared, ropa o captura`};
		return {...m, mascara, bandas};
	}
}

/**
 * Bandas rectas de una forma por filas (pura): `izq[k]` / `der[k]` = primera y última columna llena de la fila k
 * (−1 si está vacía). Una banda = filas seguidas (≥ `minFilas`) cuyos extremos no se mueven más de 1 px; lo que
 * queda entre bandas son esquinas redondeadas o la unión entre dos renglones. Devuelve filas [k0, k1) y columnas
 * [x0, x1).
 */
export type BandaFilas = {k0: number; k1: number; x0: number; x1: number; /** Orilla izquierda más adentro y derecha más adentro (deriva). */ x0max: number; x1min: number};

export function bandasRectas(izq: ArrayLike<number>, der: ArrayLike<number>, minFilas = 3): BandaFilas[] {
	const bandas: BandaFilas[] = [];
	const n = izq.length;
	let k = 0;
	while (k < n) {
		if (izq[k] < 0) {
			k++;
			continue;
		}
		let f = k;
		let lmin = izq[k];
		let lmax = izq[k];
		let rmin = der[k];
		let rmax = der[k];
		while (f + 1 < n && izq[f + 1] >= 0) {
			const l = izq[f + 1];
			const r = der[f + 1];
			if (Math.max(lmax, l) - Math.min(lmin, l) > 1 || Math.max(rmax, r) - Math.min(rmin, r) > 1) break;
			lmin = Math.min(lmin, l);
			lmax = Math.max(lmax, l);
			rmin = Math.min(rmin, r);
			rmax = Math.max(rmax, r);
			f++;
		}
		if (f - k + 1 >= minFilas) {
			bandas.push({k0: k, k1: f + 1, x0: lmin, x1: rmax + 1, x0max: lmax, x1min: rmin + 1});
			k = f + 1;
		} else {
			k++;
		}
	}
	return bandas;
}

/**
 * Renglones (pura): de las bandas rectas, las de alto ≥ 40 % de la más alta. Las bandas cortas que quedan son
 * transiciones (la curva de una esquina o la unión entre renglones) y no cuentan como renglón ni como lado recto.
 */
export function renglones<T extends BandaFilas>(bandas: T[]): T[] {
	// Bandas seguidas con ≤ 2 filas entre ellas cuyas orillas, juntas, no se mueven más de 2 px son el mismo renglón
	// (una deriva de 1 px por la compresión); una orilla que se sigue moviendo (círculo, elipse) no se une.
	const unidas: T[] = [];
	for (const b of bandas) {
		const a = unidas[unidas.length - 1];
		const x0 = a ? Math.min(a.x0, b.x0) : 0;
		const x0max = a ? Math.max(a.x0max, b.x0max) : 0;
		const x1 = a ? Math.max(a.x1, b.x1) : 0;
		const x1min = a ? Math.min(a.x1min, b.x1min) : 0;
		if (a && b.k0 - a.k1 <= 2 && x0max - x0 <= 2 && x1 - x1min <= 2) {
			unidas[unidas.length - 1] = {...a, k1: b.k1, x0, x0max, x1, x1min};
		} else {
			unidas.push({...b});
		}
	}
	const max = Math.max(0, ...unidas.map((b) => b.k1 - b.k0));
	return unidas.filter((b) => b.k1 - b.k0 >= 0.4 * max);
}

/**
 * ¿Las bandas forman una tarjeta? (pura). null si sí; si no, el motivo. Los renglones de una tarjeta comparten
 * centro (o orilla izquierda o derecha, si va alineada) y entre uno y otro solo cabe la curva de sus esquinas.
 */
export function formaDeBandas(bandas: readonly CajaPx[]): string | null {
	if (bandas.length === 0) return 'sin bandas rectas';
	const ancho = Math.max(...bandas.map((b) => b.x1 - b.x0));
	for (let i = 1; i < bandas.length; i++) {
		const a = bandas[i - 1];
		const b = bandas[i];
		const mismoCentro = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) <= Math.max(2, 0.06 * ancho);
		const mismaIzq = Math.abs(a.x0 - b.x0) <= 2;
		const mismaDer = Math.abs(a.x1 - b.x1) <= 2;
		if (!mismoCentro && !mismaIzq && !mismaDer) return 'renglones desalineados (no es una tarjeta)';
		const hueco = b.y0 - a.y1;
		if (hueco > Math.max(4, 0.8 * Math.min(a.y1 - a.y0, b.y1 - b.y0))) return `unión de ${hueco} filas entre renglones (no es una tarjeta)`;
	}
	return null;
}

// ───────────────────────────── 3. Rastreador ─────────────────────────────

export type Deteccion = CajaPx & {n: number; bandas?: CajaPx[]};
export type Pista = {id: number; detecciones: Deteccion[]};

export type OpcionesRastreo = {
	/** Cuadros seguidos sin ver una pista antes de cerrarla. */
	huecoMax: number;
	/** Cambio de orilla tolerado (px de análisis) … */
	tolerancia: number;
	/** … o como fracción del lado. */
	toleranciaRel: number;
	/** Fracción del texto anterior que puede desaparecer sin que sea otra tarjeta. */
	quitadoMax: number;
};

export const OPCIONES_RASTREO: OpcionesRastreo = {huecoMax: 2, tolerancia: 2, toleranciaRel: 0.03, quitadoMax: 0.4};

/** ¿Misma caja? Cada orilla cambia a lo más max(tolerancia, toleranciaRel × lado). */
export function mismaGeometria(a: CajaPx, b: CajaPx, op: OpcionesRastreo = OPCIONES_RASTREO): boolean {
	const tx = Math.max(op.tolerancia, op.toleranciaRel * (a.x1 - a.x0));
	const ty = Math.max(op.tolerancia, op.toleranciaRel * (a.y1 - a.y0));
	return Math.abs(a.x0 - b.x0) <= tx && Math.abs(a.x1 - b.x1) <= tx && Math.abs(a.y0 - b.y0) <= ty && Math.abs(a.y1 - b.y1) <= ty;
}

/**
 * Fracción de los huecos (texto) de `previo` que ya no están en `actual` (en coordenadas absolutas, con ±1 px de
 * tolerancia). Una tarjeta que se escribe letra por letra solo agrega texto (≈ 0); otra tarjeta en el mismo
 * lugar quita casi todo.
 */
export function textoQuitado(previo: Candidato, actual: Candidato): number {
	const pw = previo.x1 - previo.x0;
	const cw = actual.x1 - actual.x0;
	const ch = actual.y1 - actual.y0;
	let total = 0;
	let quitados = 0;
	for (let i = 0; i < previo.mascara.length; i++) {
		if (!previo.mascara[i]) continue;
		total++;
		const x = previo.x0 + (i % pw);
		const y = previo.y0 + Math.floor(i / pw);
		let sigue = false;
		for (let dy = -1; dy <= 1 && !sigue; dy++) {
			for (let dx = -1; dx <= 1 && !sigue; dx++) {
				const cx = x + dx - actual.x0;
				const cy = y + dy - actual.y0;
				if (cx >= 0 && cy >= 0 && cx < cw && cy < ch && actual.mascara[cy * cw + cx]) sigue = true;
			}
		}
		if (!sigue) quitados++;
	}
	return total < 10 ? 0 : quitados / total;
}

/**
 * Une las detecciones cuadro a cuadro en pistas (una pista = una tarjeta quieta en pantalla).
 * Corta cuando la caja cambia (otra tarjeta, una línea nueva que agranda la caja o un cuadro de animación) o
 * cuando desaparece el texto de adentro. Los pedazos se vuelven a unir después: `unirAnimaciones` (cuadros sueltos
 * de una entrada o salida animada) y `unirEscritura` (tarjeta que crece al escribirse, con el OCR).
 */
export class RastreadorTarjetas {
	private activas: Array<{pista: Pista; ultima: Candidato}> = [];
	private cerradas: Pista[] = [];
	private siguiente = 1;

	constructor(private readonly op: OpcionesRastreo = OPCIONES_RASTREO) {}

	agregar(n: number, candidatos: Candidato[]): void {
		this.activas = this.activas.filter((a) => {
			const ultimaN = a.pista.detecciones[a.pista.detecciones.length - 1].n;
			if (n - ultimaN - 1 > this.op.huecoMax) {
				this.cerradas.push(a.pista);
				return false;
			}
			return true;
		});
		const pares: Array<{ci: number; ai: number; iou: number}> = [];
		candidatos.forEach((c, ci) =>
			this.activas.forEach((a, ai) => {
				const iou = iouCajas(c, a.ultima);
				if (iou >= 0.3) pares.push({ci, ai, iou});
			}),
		);
		pares.sort((x, y) => y.iou - x.iou);
		const usadosC = new Set<number>();
		const usadosA = new Set<number>();
		const cerrar = new Set<number>();
		for (const par of pares) {
			if (usadosC.has(par.ci) || usadosA.has(par.ai)) continue;
			const a = this.activas[par.ai];
			const c = candidatos[par.ci];
			usadosA.add(par.ai);
			if (mismaGeometria(a.ultima, c, this.op) && textoQuitado(a.ultima, c) <= this.op.quitadoMax) {
				usadosC.add(par.ci);
				a.pista.detecciones.push({n, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, bandas: c.bandas});
				a.ultima = c;
			} else {
				// Otra tarjeta (o la misma con otra caja) ocupa su lugar: se cierra y el candidato abre otra pista.
				cerrar.add(par.ai);
			}
		}
		if (cerrar.size) {
			this.activas = this.activas.filter((a, ai) => {
				if (!cerrar.has(ai)) return true;
				this.cerradas.push(a.pista);
				return false;
			});
		}
		candidatos.forEach((c, ci) => {
			if (usadosC.has(ci)) return;
			this.activas.push({pista: {id: this.siguiente++, detecciones: [{n, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, bandas: c.bandas}]}, ultima: c});
		});
	}

	terminar(): Pista[] {
		const todas = [...this.cerradas, ...this.activas.map((a) => a.pista)];
		this.activas = [];
		this.cerradas = [];
		return todas.sort((a, b) => a.detecciones[0].n - b.detecciones[0].n || a.id - b.id);
	}
}

export const inicioPista = (p: Pista) => p.detecciones[0].n;
/** Primer cuadro sin la pista (exclusivo). */
export const finPista = (p: Pista) => p.detecciones[p.detecciones.length - 1].n + 1;

/** Caja mediana (por orilla) de las detecciones de una pista. */
export function cajaPista(p: Pista): CajaPx {
	const d = p.detecciones;
	const med = (f: (x: Deteccion) => number) => cuantil(d.map(f), 0.5)!;
	return {x0: med((x) => x.x0), y0: med((x) => x.y0), x1: med((x) => x.x1), y1: med((x) => x.y1)};
}

/** Bandas (renglones) de la detección de en medio con el número de bandas más común de la pista. */
export function bandasPista(p: Pista): CajaPx[] {
	const conteo = new Map<number, number>();
	for (const d of p.detecciones) conteo.set(d.bandas?.length ?? 0, (conteo.get(d.bandas?.length ?? 0) ?? 0) + 1);
	const moda = [...conteo.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
	const con = p.detecciones.filter((d) => (d.bandas?.length ?? 0) === moda && d.bandas);
	return con.length ? con[Math.floor(con.length / 2)].bandas! : [];
}

const centro = (c: CajaPx) => ({x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2});

/** ¿Dos cajas comparten centro (dentro del 20 % del ancho mayor)? */
export function concentricas(a: CajaPx, b: CajaPx): boolean {
	const ca = centro(a);
	const cb = centro(b);
	const lado = Math.max(a.x1 - a.x0, b.x1 - b.x0);
	return Math.abs(ca.x - cb.x) <= 0.2 * lado && Math.abs(ca.y - cb.y) <= 0.2 * Math.max(a.y1 - a.y0, b.y1 - b.y0, 0.2 * lado);
}

/**
 * Une a una pista larga los pedazos cortos (≤ `maxCuadros` detecciones) pegados a ella (≤ 1 cuadro de hueco) y con
 * el mismo centro: son cuadros de una entrada o salida animada (pop de escala). Devuelve las pistas unidas y, por
 * pista, cuántos cuadros de animación tuvo al entrar y al salir.
 */
export function unirAnimaciones(pistas: Pista[], maxCuadros = 3): Array<Pista & {animEntrada: number; animSalida: number}> {
	const orden = [...pistas].sort((a, b) => inicioPista(a) - inicioPista(b));
	const largas = orden.filter((p) => p.detecciones.length > maxCuadros).map((p) => ({...p, detecciones: [...p.detecciones], animEntrada: 0, animSalida: 0}));
	const cortas = orden.filter((p) => p.detecciones.length <= maxCuadros);
	const sobran: Pista[] = [];
	// Entradas: cadenas de pedazos cortos que terminan justo antes de una larga concéntrica (de atrás hacia adelante).
	for (const corta of [...cortas].sort((a, b) => finPista(b) - finPista(a))) {
		const cc = cajaPista(corta);
		const destino =
			largas.find((l) => inicioPista(l) - finPista(corta) >= 0 && inicioPista(l) - finPista(corta) <= 1 && concentricas(cc, cajaPista(l))) ??
			largas.find((l) => inicioPista(corta) - finPista(l) >= 0 && inicioPista(corta) - finPista(l) <= 1 && concentricas(cc, cajaPista(l)));
		if (!destino) {
			sobran.push(corta);
			continue;
		}
		if (finPista(corta) <= inicioPista(destino)) {
			destino.detecciones.unshift(...corta.detecciones);
			destino.animEntrada += corta.detecciones.length;
		} else {
			destino.detecciones.push(...corta.detecciones);
			destino.animSalida += corta.detecciones.length;
		}
	}
	return [...largas, ...sobran.map((p) => ({...p, animEntrada: 0, animSalida: 0}))].sort((a, b) => inicioPista(a) - inicioPista(b));
}

/**
 * Une pedazos seguidos de una tarjeta que se escribe letra por letra (pura): B empieza ≤ 2 cuadros después de que
 * termina A, sus cajas comparten orilla izquierda y derecha (o centro) y el texto de A es el principio del de B (o
 * B contiene a A). Devuelve grupos de índices en el orden recibido.
 */
export function unirEscritura(
	pedazos: Array<{nDesde: number; nHasta: number; caja: CajaPx; texto: string}>,
	op: {huecoMax?: number; tolerancia?: number} = {},
): number[][] {
	const huecoMax = op.huecoMax ?? 2;
	const grupos: number[][] = [];
	const orden = pedazos.map((_, i) => i).sort((a, b) => pedazos[a].nDesde - pedazos[b].nDesde);
	const asignado = new Map<number, number[]>();
	for (const i of orden) {
		const b = pedazos[i];
		let unido = false;
		for (const g of grupos) {
			const a = pedazos[g[g.length - 1]];
			if (b.nDesde - a.nHasta < 0 || b.nDesde - a.nHasta > huecoMax) continue;
			const tol = Math.max(op.tolerancia ?? 3, 0.03 * (a.caja.x1 - a.caja.x0));
			const mismasOrillas = Math.abs(a.caja.x0 - b.caja.x0) <= tol && Math.abs(a.caja.x1 - b.caja.x1) <= tol;
			const ta = compactarTexto(a.texto);
			const tb = compactarTexto(b.texto);
			if (!ta || !tb) continue;
			const crece = tb.length >= ta.length && (tb.startsWith(ta) || tb.includes(ta) || similitud(ta, tb.slice(0, ta.length)) >= 0.85);
			if (mismasOrillas && crece) {
				g.push(i);
				asignado.set(i, g);
				unido = true;
				break;
			}
		}
		if (!unido) {
			const g = [i];
			grupos.push(g);
			asignado.set(i, g);
		}
	}
	return grupos;
}

// ───────────────────────────── 4. Medición fina de una caja blanca ─────────────────────────────

export type CajaSub = {x0: number; y0: number; x1: number; y1: number};

export type MedidaCaja = {
	/** Caja exacta en px de la imagen (orillas de píxel, con subpíxel): envuelve todas las bandas. */
	caja: CajaSub;
	/** Una caja por renglón (las tarjetas de varios renglones son una caja redondeada por renglón, unidas). */
	bandas: CajaSub[];
	/** Cuántas filas o columnas dieron cada orilla. */
	nOrillas: {izq: number; der: number; arriba: number; abajo: number};
	/** Luma del blanco de la caja y del fondo junto a sus orillas (medianas). */
	blanco: number;
	fondo: number;
	/** Radio de esquina (px de la imagen): mediana de las 4 esquinas; null si ninguna se pudo ajustar. */
	radio: number | null;
	radios: Array<number | null>;
	/** Caja de lo que no es blanco adentro (texto, emoji), px de la imagen. */
	contenido: CajaPx | null;
	colorCaja: Rgb;
	colorTexto: Rgb | null;
	/** Píxeles con color adentro (croma alto: emoji o íconos), lejos del fondo. */
	pixelesColor: number;
	/** Máscara de tinta oscura (texto) de toda la imagen: 1 = tinta. */
	tinta: Uint8Array;
};

/**
 * Cruce de una orilla a lo largo de una línea de píxeles (pura): recorre de afuera (`desde`) hacia adentro (`hasta`)
 * y devuelve la posición (índice con subpíxel) donde la luma cruza la mitad entre el fondo (lo de afuera) y el
 * blanco (lo de adentro). null si no hay contraste (< `contrasteMin`) o no cruza.
 */
export function cruceOrilla(valor: (k: number) => number, desde: number, hasta: number, contrasteMin = 25, blancoFijo?: number): number | null {
	const paso = hasta > desde ? 1 : -1;
	const fondo = Math.min(valor(desde), valor(desde + paso));
	const blanco = blancoFijo ?? Math.max(valor(hasta), valor(hasta - paso));
	if (blanco - fondo < contrasteMin) return null;
	const mitad = (fondo + blanco) / 2;
	for (let k = desde; k !== hasta; k += paso) {
		const a = valor(k);
		const b = valor(k + paso);
		if (a < mitad && b >= mitad) return k + (paso * (mitad - a)) / (b - a);
	}
	return null;
}

/**
 * Cruce de una orilla buscándola DESDE ADENTRO (pura): de `adentro` hacia `afuera`, primero llega al blanco de la
 * caja (≥ blanco − 12; si empezó sobre una letra, la cruza) y luego avanza hasta donde deja de ser blanco. El fondo
 * local es el mínimo de los 3 píxeles siguientes (pasando el antialias); el cruce es donde la luma pasa por la mitad
 * entre el blanco y ese fondo. Así no la engaña un fondo claro (una silla, una pared) ni lo que haya más lejos.
 * Devuelve el índice con subpíxel, o null si no hay contraste (< `contrasteMin`).
 */
export function cruceDesdeAdentro(valor: (k: number) => number, adentro: number, afuera: number, blanco: number, contrasteMin = 15): number | null {
	const paso = afuera > adentro ? 1 : -1;
	const casiBlanco = blanco - 12;
	let k = adentro;
	while (k !== afuera && valor(k) < casiBlanco) k += paso;
	while (k !== afuera && valor(k) >= casiBlanco) k += paso;
	if (k === afuera) return null;
	const fondo = Math.min(valor(k), valor(k + paso), valor(k + 2 * paso));
	if (blanco - fondo < contrasteMin) return null;
	const mitad = (blanco + fondo) / 2;
	for (let j = k - paso; j !== k + 2 * paso; j += paso) {
		const a = valor(j);
		const b = valor(j + paso);
		if (a >= mitad && b < mitad) return j + (paso * (a - mitad)) / (a - b);
	}
	return null;
}

/**
 * Cruce de una orilla buscándola DESDE AFUERA hasta el primer blanco casi puro (pura): de `afuera` hacia `adentro`
 * avanza hasta dos píxeles seguidos ≥ blanco − 12 (un fondo claro o un brillo suelto no los da); el fondo local es el
 * mínimo de los 3 píxeles de antes y el cruce es donde la luma pasa por la mitad entre ese fondo y el blanco. Sirve
 * para las esquinas: ahí lo de adentro puede ser texto, pero lo que hay antes del primer blanco es solo fondo.
 */
export function cruceHaciaBlanco(valor: (k: number) => number, afuera: number, adentro: number, blanco: number, contrasteMin = 15): number | null {
	const paso = adentro > afuera ? 1 : -1;
	const casiBlanco = blanco - 12;
	let k = afuera;
	while (k !== adentro && !(valor(k) >= casiBlanco && valor(k + paso) >= casiBlanco)) k += paso;
	if (k === adentro) return null;
	const fondo = Math.min(valor(k - paso), valor(k - 2 * paso), valor(k - 3 * paso));
	if (blanco - fondo < contrasteMin) return null;
	const mitad = (blanco + fondo) / 2;
	for (let j = k - 3 * paso; j !== k + paso; j += paso) {
		const a = valor(j);
		const b = valor(j + paso);
		if (a < mitad && b >= mitad) return j + (paso * (mitad - a)) / (b - a);
	}
	return null;
}

/** Inserción de la orilla en una fila a distancia `t` (centro de la fila) de la orilla de arriba, para radio r. */
export function insercionEsquina(r: number, t: number): number {
	const d = r - t;
	if (d <= 0) return 0;
	return r - Math.sqrt(Math.max(0, r * r - d * d));
}

/**
 * Ajusta el radio de una esquina redondeada (pura): `muestras` = [distancia a la orilla perpendicular (centro de la
 * fila o columna), inserción medida]. Búsqueda en rejilla de 0 a rMax cada 0.25 px, mínimos cuadrados.
 */
export function ajustarRadio(muestras: Array<[number, number]>, rMax: number): number | null {
	if (muestras.length < 3) return null;
	let mejor = 0;
	let error = Number.POSITIVE_INFINITY;
	for (let r = 0; r <= rMax + 1e-9; r += 0.25) {
		let e = 0;
		for (const [t, i] of muestras) {
			const d = i - insercionEsquina(r, t);
			e += d * d;
		}
		if (e < error - 1e-9) {
			error = e;
			mejor = r;
		}
	}
	return mejor;
}

/**
 * Mide una caja blanca a resolución nativa (pura). `aprox` y `bandas` (una por renglón) vienen del detector (px de
 * esta imagen, con error de unos píxeles).
 * - Orillas: buscadas desde adentro (cruceDesdeAdentro) en el 50 % central de cada lado (izquierda y derecha por
 *   banda; arriba en la primera banda y abajo en la última); mediana. Caja = la que envuelve las bandas.
 * - Radio: inserción de la orilla (cruceHaciaBlanco) en las filas y columnas de las 4 esquinas de afuera contra un
 *   cuarto de círculo.
 * - Adentro = lo que no se alcanza desde la orilla de la imagen pasando por lo que no es blanco; contenido = lo no
 *   blanco de adentro a ≥ 2 px del fondo (texto y emoji); tinta = lo oscuro de eso. Colores: medianas.
 */
export function medirCajaBlanca(
	pix: Uint8Array,
	w: number,
	h: number,
	aprox: CajaPx,
	op: {margen?: number; rMax?: number; bandas?: CajaPx[]} = {},
): MedidaCaja | null {
	const margen = Math.max(3, Math.round(op.margen ?? 8));
	const Yimg = new Float32Array(w * h);
	for (let q = 0; q < w * h; q++) Yimg[q] = luma(pix[q * 4], pix[q * 4 + 1], pix[q * 4 + 2]);
	const L = (x: number, y: number) => Yimg[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
	if (aprox.x1 - aprox.x0 < 8 || aprox.y1 - aprox.y0 < 6) return null;
	const bandas = (op.bandas && op.bandas.length ? [...op.bandas] : [aprox]).sort((a, b) => a.y0 - b.y0);
	// Blanco de la caja: percentil 90 de la luma adentro (el texto ocupa menos de la mitad).
	const interior: number[] = [];
	for (const b of bandas) {
		for (let y = Math.round(b.y0 + 2); y < Math.round(b.y1 - 2); y += 2) {
			for (let x = Math.round(b.x0 + 2); x < Math.round(b.x1 - 2); x += 2) interior.push(L(x, y));
		}
	}
	const blanco = cuantil(interior, 0.9);
	if (blanco === null) return null;
	const fondos: number[] = [];
	/**
	 * Orilla de un lado: en cada fila (izq/der) o columna (arriba/abajo) del centro de la banda `b`, la busca desde
	 * `adentro` hacia `afuera` (coordenada de la fila o columna). Mediana.
	 */
	const orilla = (lado: 'izq' | 'der' | 'arriba' | 'abajo', b: CajaPx, adentro: number, afuera: number): {pos: number | null; n: number} => {
		const pos: number[] = [];
		const bw = b.x1 - b.x0;
		const bh = b.y1 - b.y0;
		const horizontal = lado === 'izq' || lado === 'der';
		const a = horizontal ? Math.round(b.y0 + 0.25 * bh) : Math.round(b.x0 + 0.3 * bw);
		const z = horizontal ? Math.round(b.y1 - 0.25 * bh) : Math.round(b.x1 - 0.3 * bw);
		for (let k = a; k < Math.max(a + 1, z); k++) {
			const v = horizontal ? (i: number) => L(i, k) : (i: number) => L(k, i);
			const c = cruceDesdeAdentro(v, Math.round(adentro), Math.round(afuera), blanco);
			if (c === null) continue;
			pos.push(c + 0.5);
			fondos.push(Math.min(v(Math.round(afuera)), v(Math.round(afuera) + (afuera > adentro ? -1 : 1))));
		}
		return {pos: cuantil(pos, 0.5), n: pos.length};
	};
	const lados = bandas.map((b) => ({
		izq: orilla('izq', b, b.x0 + margen, b.x0 - margen),
		der: orilla('der', b, b.x1 - 1 - margen, b.x1 - 1 + margen),
	}));
	// Arriba y abajo: columnas de la primera y la última banda. Se busca desde adentro de la banda (sus filas rectas
	// empiezan pasando la curva de las esquinas) hasta más allá de la caja aproximada (que puede venir más alta si algo
	// blanco se le pegaba por fuera).
	const b0 = bandas[0];
	const bN = bandas[bandas.length - 1];
	const ar = orilla('arriba', b0, b0.y0 + margen, Math.min(aprox.y0, b0.y0) - margen);
	const ab = orilla('abajo', bN, bN.y1 - 1 - margen, Math.max(aprox.y1, bN.y1) - 1 + margen);
	if (ar.pos === null || ab.pos === null || lados.some((l) => l.izq.pos === null || l.der.pos === null)) return null;
	const exactas: CajaSub[] = bandas.map((b, i) => ({
		x0: lados[i].izq.pos!,
		x1: lados[i].der.pos!,
		y0: i === 0 ? ar.pos! : b.y0,
		y1: i === bandas.length - 1 ? ab.pos! : b.y1,
	}));
	const caja: CajaSub = {x0: Math.min(...exactas.map((b) => b.x0)), x1: Math.max(...exactas.map((b) => b.x1)), y0: ar.pos, y1: ab.pos};
	if (!(caja.x1 - caja.x0 > 4 && caja.y1 - caja.y0 > 4)) return null;
	const fondo = cuantil(fondos, 0.5)!;

	// Radio en las 4 esquinas de afuera (las de arriba son de la primera banda y las de abajo de la última).
	const radios: Array<number | null> = [];
	for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
		const b = sy < 0 ? exactas[0] : exactas[exactas.length - 1];
		const rMax = Math.max(1, Math.min(0.48 * (b.x1 - b.x0), 0.48 * (b.y1 - b.y0), op.rMax ?? 60));
		const xOrilla = sx < 0 ? b.x0 : b.x1;
		const yOrilla = sy < 0 ? caja.y0 : caja.y1;
		const muestras: Array<[number, number]> = [];
		// Filas: a distancia t de la orilla horizontal, dónde cae la orilla vertical.
		for (let j = 0; j < Math.ceil(rMax) + 2; j++) {
			const yc = sy < 0 ? Math.floor(caja.y0) + j + 0.5 : Math.ceil(caja.y1) - j - 0.5;
			const t = Math.abs(yc - yOrilla);
			if (t < 0.75 || t > rMax + 1) continue;
			const fila = Math.floor(yc);
			const desde = sx < 0 ? Math.floor(b.x0) - 3 : Math.ceil(b.x1) + 2;
			const hasta = sx < 0 ? Math.ceil(b.x0 + rMax) + 2 : Math.floor(b.x1 - rMax) - 3;
			const c = cruceHaciaBlanco((i) => L(i, fila), desde, hasta, blanco);
			if (c === null) continue;
			muestras.push([t, Math.abs(c + 0.5 - xOrilla)]);
		}
		// Columnas: a distancia t de la orilla vertical, dónde cae la orilla horizontal.
		for (let j = 0; j < Math.ceil(rMax) + 2; j++) {
			const xc = sx < 0 ? Math.floor(b.x0) + j + 0.5 : Math.ceil(b.x1) - j - 0.5;
			const t = Math.abs(xc - xOrilla);
			if (t < 0.75 || t > rMax + 1) continue;
			const col = Math.floor(xc);
			const desde = sy < 0 ? Math.floor(caja.y0) - 3 : Math.ceil(caja.y1) + 2;
			const hasta = sy < 0 ? Math.ceil(caja.y0 + rMax) + 2 : Math.floor(caja.y1 - rMax) - 3;
			const c = cruceHaciaBlanco((i) => L(col, i), desde, hasta, blanco);
			if (c === null) continue;
			muestras.push([t, Math.abs(c + 0.5 - yOrilla)]);
		}
		radios.push(ajustarRadio(muestras, rMax));
	}
	const radio = cuantil(radios.filter((r): r is number => r !== null), 0.5);

	// Afuera: lo que se alcanza desde la orilla de la imagen pasando por lo que no es blanco casi puro (≥ blanco − 12):
	// el antialias de la orilla y un fondo claro (silla, pared) quedan afuera; el texto, encerrado por el padding, no.
	const umbralBlanco = blanco - 12;
	const fuera = new Uint8Array(w * h);
	const cola = new Int32Array(w * h);
	let cab = 0;
	let fin = 0;
	const sembrar = (q: number) => {
		if (!fuera[q] && Yimg[q] < umbralBlanco) {
			fuera[q] = 1;
			cola[fin++] = q;
		}
	};
	for (let x = 0; x < w; x++) {
		sembrar(x);
		sembrar((h - 1) * w + x);
	}
	for (let y = 0; y < h; y++) {
		sembrar(y * w);
		sembrar(y * w + w - 1);
	}
	while (cab < fin) {
		const q = cola[cab++];
		const x = q % w;
		if (x > 0) sembrar(q - 1);
		if (x < w - 1) sembrar(q + 1);
		if (q >= w) sembrar(q - w);
		if (q < (h - 1) * w) sembrar(q + w);
	}
	// Cerca del fondo: afuera dilatado 2 px (Chebyshev), solo en la caja.
	const bx0 = Math.max(0, Math.floor(caja.x0) - 3);
	const by0 = Math.max(0, Math.floor(caja.y0) - 3);
	const bx1 = Math.min(w, Math.ceil(caja.x1) + 3);
	const by1 = Math.min(h, Math.ceil(caja.y1) + 3);
	const cerca = new Uint8Array(w * h);
	for (let y = by0; y < by1; y++) {
		for (let x = bx0; x < bx1; x++) {
			if (!fuera[y * w + x]) continue;
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					const yy = y + dy;
					const xx = x + dx;
					if (yy >= 0 && yy < h && xx >= 0 && xx < w) cerca[yy * w + xx] = 1;
				}
			}
		}
	}
	const tinta = new Uint8Array(w * h);
	let cx0 = w;
	let cy0 = h;
	let cx1 = -1;
	let cy1 = -1;
	const rc: number[] = [];
	const gc: number[] = [];
	const bc: number[] = [];
	const rt: number[] = [];
	const gt: number[] = [];
	const bt: number[] = [];
	// Columnas permitidas por fila: las de su banda (o, entre dos bandas, las de la más ancha), 2 px adentro. Así no
	// entra nada blanco del fondo que toque la tarjeta por fuera (un logo de playera, otro texto).
	const rangoFila = (yc: number): [number, number] | null => {
		if (yc < caja.y0 + 2 || yc > caja.y1 - 2) return null;
		const b = exactas.find((x) => yc >= x.y0 && yc < x.y1);
		if (b) return [b.x0 + 2, b.x1 - 2];
		const k = exactas.findIndex((x) => x.y0 > yc);
		const vecinas = k > 0 ? [exactas[k - 1], exactas[k]] : exactas;
		return [Math.min(...vecinas.map((x) => x.x0)) + 2, Math.max(...vecinas.map((x) => x.x1)) - 2];
	};
	let pixelesColor = 0;
	for (let y = Math.max(0, Math.floor(caja.y0)); y < Math.min(h, Math.ceil(caja.y1)); y++) {
		const rango = rangoFila(y + 0.5);
		if (!rango) continue;
		for (let x = Math.max(0, Math.floor(caja.x0)); x < Math.min(w, Math.ceil(caja.x1)); x++) {
			const q = y * w + x;
			if (cerca[q] || x + 0.5 < rango[0] || x + 0.5 > rango[1]) continue;
			const R = pix[q * 4];
			const G = pix[q * 4 + 1];
			const B = pix[q * 4 + 2];
			const Y = Yimg[q];
			const conColor = Math.max(R, G, B) - Math.min(R, G, B) > 40;
			if (conColor) pixelesColor++;
			if (Y < 0.85 * blanco || conColor) {
				if (x < cx0) cx0 = x;
				if (x > cx1) cx1 = x;
				if (y < cy0) cy0 = y;
				if (y > cy1) cy1 = y;
			}
			if (Y < 0.5 * blanco && !conColor) {
				tinta[q] = 1;
				if (Y < 0.3 * blanco) {
					rt.push(R);
					gt.push(G);
					bt.push(B);
				}
			} else if (Y >= 0.93 * blanco && !conColor) {
				rc.push(R);
				gc.push(G);
				bc.push(B);
			}
		}
	}
	return {
		caja,
		bandas: exactas,
		nOrillas: {
			izq: Math.min(...lados.map((l) => l.izq.n)),
			der: Math.min(...lados.map((l) => l.der.n)),
			arriba: ar.n,
			abajo: ab.n,
		},
		blanco,
		fondo,
		radio,
		radios,
		contenido: cx1 >= 0 ? {x0: cx0, y0: cy0, x1: cx1 + 1, y1: cy1 + 1} : null,
		colorCaja: medianaRgb(rc, gc, bc) ?? [255, 255, 255],
		colorTexto: medianaRgb(rt, gt, bt),
		pixelesColor,
		tinta,
	};
}

// ───────────────────────────── Glifos: alto de mayúscula, altura de x y trazo ─────────────────────────────

export type MedidaGlifos = {
	/** Fila de la línea base (última fila del cuerpo de las letras), px de la imagen. */
	base: number;
	/** Primera fila con tinta (mayúsculas, ascendentes o acentos). */
	arriba: number;
	/** Altura de x (cuerpo de las minúsculas), px; null si la línea no da una banda clara. */
	xAltura: number | null;
	/** Alto de la primera letra si es mayúscula sin acento o dígito (px); null si no. */
	altoMayuscula: number | null;
	/**
	 * Alto mediano de las componentes altas que se apoyan en la base (mayúsculas, dígitos y ascendentes), px; sirve
	 * cuando la línea no empieza con una mayúscula medible ("$20", "¿Qué…"). Las ascendentes pueden pasar la altura
	 * de mayúscula unos puntos.
	 */
	altoAltas: number | null;
	/** Ancho típico del trazo vertical (mediana de corridas horizontales de tinta en el cuerpo), px. */
	tallo: number | null;
};

/** ¿El texto empieza con una mayúscula sin acento ni descendente, o con un dígito? (sirve para medir el alto). */
export function primeraEsMayusculaMedible(texto: string): boolean {
	const c = texto.trim()[0] ?? '';
	return /^[A-IK-PR-Z0-9]$/.test(c);
}

/**
 * Mide los glifos de una línea de texto sobre una máscara de tinta (1 = tinta) (pura), con sus componentes conexas:
 * - línea base = la fila de abajo más común entre las componentes altas (las letras sin descendente);
 * - altura de x = de la línea base a la fila de arriba más común entre las componentes que se apoyan en la base y
 *   no llegan a la altura de mayúscula (a, c, e, m, n, o, r, s, u…); null si la línea no trae ≥ 2 de esas;
 * - alto de mayúscula = la primera componente (de izquierda a derecha) si el texto empieza con una mayúscula
 *   medible o un dígito, de su fila de arriba a la línea base;
 * - trazo = mediana de las corridas horizontales de tinta (con no-tinta a los dos lados) entre el 25 % y el 60 % de
 *   la altura de x sobre la base (o del alto de mayúscula, si no hay altura de x).
 */
export function medirGlifos(mascara: Uint8Array, w: number, linea: CajaPx, texto: string | null): MedidaGlifos | null {
	const x0 = Math.max(0, Math.floor(linea.x0));
	const x1 = Math.min(w, Math.ceil(linea.x1));
	const y0 = Math.max(0, Math.floor(linea.y0));
	const y1 = Math.min(Math.floor(mascara.length / w), Math.ceil(linea.y1));
	const lw = x1 - x0;
	const lh = y1 - y0;
	if (lw < 3 || lh < 3) return null;
	// Componentes 4-conexas dentro de la línea.
	const visto = new Uint8Array(lw * lh);
	const comps: Array<{x0: number; y0: number; x1: number; y1: number; n: number}> = [];
	const pila: number[] = [];
	for (let x = 0; x < lw; x++) {
		for (let y = 0; y < lh; y++) {
			const k = y * lw + x;
			if (visto[k] || !mascara[(y + y0) * w + (x + x0)]) continue;
			visto[k] = 1;
			pila.push(k);
			const c = {x0: x, y0: y, x1: x, y1: y, n: 0};
			while (pila.length) {
				const q = pila.pop()!;
				const qx = q % lw;
				const qy = (q - qx) / lw;
				c.n++;
				if (qx < c.x0) c.x0 = qx;
				if (qx > c.x1) c.x1 = qx;
				if (qy < c.y0) c.y0 = qy;
				if (qy > c.y1) c.y1 = qy;
				if (qx > 0 && !visto[q - 1] && mascara[(qy + y0) * w + (qx - 1 + x0)]) {
					visto[q - 1] = 1;
					pila.push(q - 1);
				}
				if (qx < lw - 1 && !visto[q + 1] && mascara[(qy + y0) * w + (qx + 1 + x0)]) {
					visto[q + 1] = 1;
					pila.push(q + 1);
				}
				if (qy > 0 && !visto[q - lw] && mascara[(qy - 1 + y0) * w + (qx + x0)]) {
					visto[q - lw] = 1;
					pila.push(q - lw);
				}
				if (qy < lh - 1 && !visto[q + lw] && mascara[(qy + 1 + y0) * w + (qx + x0)]) {
					visto[q + lw] = 1;
					pila.push(q + lw);
				}
			}
			comps.push(c);
		}
	}
	if (comps.length === 0) return null;
	const altoMax = Math.max(...comps.map((c) => c.y1 - c.y0 + 1));
	const moda = (valores: number[], tol = 1): number | null => {
		if (!valores.length) return null;
		let mejor: number | null = null;
		let cuenta = 0;
		for (const v of valores) {
			const k = valores.filter((u) => Math.abs(u - v) <= tol).length;
			if (k > cuenta || (k === cuenta && mejor !== null && v > mejor)) {
				cuenta = k;
				mejor = v;
			}
		}
		return mejor;
	};
	const altas = comps.filter((c) => c.y1 - c.y0 + 1 >= 0.3 * altoMax);
	const baseRel = moda(altas.map((c) => c.y1));
	if (baseRel === null) return null;
	const sobreBase = altas.filter((c) => Math.abs(c.y1 - baseRel) <= Math.max(1, 0.04 * altoMax));
	// Tope de mayúsculas y ascendentes: el de arriba de TODAS las altas (una "Q" o un "¿" que bajan de la base también
	// llegan a la altura de mayúscula); las que se apoyan en la base y quedan claramente más abajo son minúsculas.
	const topeMayus = Math.min(...altas.map((c) => c.y0));
	const cortas = sobreBase.filter((c) => c.y0 - topeMayus >= Math.max(2, 0.12 * (baseRel - topeMayus + 1)));
	const xLineaRel = cortas.length >= 2 ? moda(cortas.map((c) => c.y0)) : null;
	const apoyo = xLineaRel !== null ? cortas.filter((c) => Math.abs(c.y0 - xLineaRel) <= 1).length : 0;
	const xAltura = xLineaRel !== null && apoyo >= 2 ? baseRel - xLineaRel + 1 : null;
	const base = y0 + baseRel;
	const arriba = y0 + Math.min(...comps.map((c) => c.y0));

	let altoMayuscula: number | null = null;
	if (texto && primeraEsMayusculaMedible(texto)) {
		const primera = [...altas].sort((a, b) => a.x0 - b.x0)[0];
		if (primera && Math.abs(primera.y1 - baseRel) <= Math.max(2, 0.06 * altoMax)) altoMayuscula = baseRel - primera.y0 + 1;
	}

	// Altas apoyadas en la base: las que miden ≥ 85 % de la más alta de ESAS (un "$" o un "¿" que bajan de la base no
	// cuentan ni ponen el tope).
	const altoMaxBase = Math.max(0, ...sobreBase.map((c) => baseRel - c.y0 + 1));
	const altasBase = sobreBase.filter((c) => baseRel - c.y0 + 1 >= 0.85 * altoMaxBase).map((c) => baseRel - c.y0 + 1);
	// Mediana (no moda): con pocas componentes, un "$" que pasa la altura de mayúscula no debe ganar el empate.
	const altoAltas = altasBase.length ? cuantil(altasBase, 0.5) : null;

	let tallo: number | null = null;
	const ref = xAltura ?? (altoMayuscula ? 0.72 * altoMayuscula : null);
	if (ref) {
		const corridas: number[] = [];
		for (let y = Math.max(y0, Math.round(base - 0.6 * ref)); y <= Math.min(y1 - 1, Math.round(base - 0.25 * ref)); y++) {
			let x = x0;
			while (x < x1) {
				if (!mascara[y * w + x]) {
					x++;
					continue;
				}
				let f = x;
				while (f + 1 < x1 && mascara[y * w + f + 1]) f++;
				if (x > x0 && f < x1 - 1) corridas.push(f - x + 1);
				x = f + 1;
			}
		}
		tallo = corridas.length >= 5 ? cuantil(corridas, 0.5) : null;
	}
	return {base, arriba, xAltura, altoMayuscula, altoAltas, tallo};
}

/**
 * Máscara del RELLENO de unas letras con contorno (pura): si el contorno es oscuro (L* < 40), es lo que queda
 * encerrado por él (no se alcanza desde la orilla de la zona sin cruzar un píxel oscuro) y se parece al relleno
 * (ΔE76 ≤ 20). Así no se cuela un fondo claro aunque se parezca al blanco. Sin contorno oscuro: solo por color
 * (ΔE76 ≤ 12). Devuelve una máscara del tamaño de la imagen (1 = relleno).
 */
export function mascaraRelleno(pix: Uint8Array, w: number, h: number, zona: CajaPx, relleno: Rgb, borde: Rgb | null): Uint8Array {
	const x0 = Math.max(0, Math.floor(zona.x0));
	const y0 = Math.max(0, Math.floor(zona.y0));
	const x1 = Math.min(w, Math.ceil(zona.x1));
	const y1 = Math.min(h, Math.ceil(zona.y1));
	const salida = new Uint8Array(w * h);
	if (x1 - x0 < 3 || y1 - y0 < 3) return salida;
	const labR = rgbALab(relleno);
	const cache = new Map<number, Lab>();
	const lab = (q: number): Lab => {
		const k = (pix[q * 4] << 16) | (pix[q * 4 + 1] << 8) | pix[q * 4 + 2];
		let v = cache.get(k);
		if (!v) {
			v = rgbALab([pix[q * 4], pix[q * 4 + 1], pix[q * 4 + 2]]);
			cache.set(k, v);
		}
		return v;
	};
	const dist = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const contornoOscuro = borde !== null && rgbALab(borde)[0] < 40;
	if (!contornoOscuro) {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (dist(lab(y * w + x), labR) <= 12) salida[y * w + x] = 1;
		return salida;
	}
	const zw = x1 - x0;
	const zh = y1 - y0;
	const fuera = new Uint8Array(zw * zh);
	const barrera = (q: number) => lab(q)[0] < 40;
	const cola: number[] = [];
	const sembrar = (x: number, y: number) => {
		const k = (y - y0) * zw + (x - x0);
		if (fuera[k] || barrera(y * w + x)) return;
		fuera[k] = 1;
		cola.push(k);
	};
	for (let x = x0; x < x1; x++) {
		sembrar(x, y0);
		sembrar(x, y1 - 1);
	}
	for (let y = y0; y < y1; y++) {
		sembrar(x0, y);
		sembrar(x1 - 1, y);
	}
	while (cola.length) {
		const k = cola.pop()!;
		const x = (k % zw) + x0;
		const y = Math.floor(k / zw) + y0;
		if (x > x0) sembrar(x - 1, y);
		if (x < x1 - 1) sembrar(x + 1, y);
		if (y > y0) sembrar(x, y - 1);
		if (y < y1 - 1) sembrar(x, y + 1);
	}
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const q = y * w + x;
			if (!fuera[(y - y0) * zw + (x - x0)] && !barrera(q) && dist(lab(q), labR) <= 20) salida[q] = 1;
		}
	}
	return salida;
}

// ───────────────────────────── 5. Titular ─────────────────────────────

export type LecturaBanda = {n: number; cajas: CajaOcr[]};

export type LineaFija = {
	texto: string;
	normalizado: string;
	/** Caja mediana normalizada al cuadro completo. */
	caja: Rect;
	/** Fracción de las lecturas en que aparece. */
	presencia: number;
	/** Cuadros nativos donde se leyó. */
	cuadros: number[];
	confianza: number;
};

export type OpcionesLineasFijas = {
	presenciaMin: number;
	toleranciaY: number;
	similitudMin: number;
	centradoMax: number;
	letrasMin: number;
	/** Fracción de lecturas del grupo con el texto más frecuente (similitud ≥ 0.9). */
	estabilidadMin: number;
};

export const OPCIONES_LINEAS_FIJAS: OpcionesLineasFijas = {presenciaMin: 0.7, toleranciaY: 0.012, similitudMin: 0.75, centradoMax: 0.15, letrasMin: 2, estabilidadMin: 0.6};

/**
 * Líneas de texto fijas (pura): las que se leen en el mismo lugar y con el mismo texto en ≥ presenciaMin de las
 * lecturas, más o menos centradas. Así se separa el titular (todo el video) de las tarjetas y subtítulos que
 * cambian. Devuelve de arriba abajo.
 */
export function lineasFijas(lecturas: LecturaBanda[], op: OpcionesLineasFijas = OPCIONES_LINEAS_FIJAS): LineaFija[] {
	type Grupo = {cy: number; ref: string; items: Array<{n: number; texto: string; caja: Rect; confianza: number}>};
	const grupos: Grupo[] = [];
	for (const l of lecturas) {
		for (const linea of lineasDeCajas(l.cajas)) {
			const comp = compactarTexto(linea.texto);
			if ((comp.match(/\p{L}/gu) ?? []).length < op.letrasMin) continue;
			const cy = linea.caja.y + linea.caja.h / 2;
			const g = grupos.find((x) => Math.abs(x.cy - cy) <= op.toleranciaY && similitud(x.ref, comp) >= op.similitudMin);
			const item = {n: l.n, texto: linea.texto, caja: linea.caja, confianza: linea.confianza};
			if (g) {
				g.items.push(item);
				g.cy += (cy - g.cy) / g.items.length;
			} else {
				grupos.push({cy, ref: comp, items: [item]});
			}
		}
	}
	const total = new Set(lecturas.map((l) => l.n)).size;
	if (total === 0) return [];
	const salida: LineaFija[] = [];
	for (const g of grupos) {
		const cuadros = [...new Set(g.items.map((i) => i.n))].sort((a, b) => a - b);
		const presencia = cuadros.length / total;
		if (presencia < op.presenciaMin) continue;
		const cuenta = new Map<string, {k: number; texto: string}>();
		for (const i of g.items) {
			const c = compactarTexto(i.texto);
			const previo = cuenta.get(c);
			if (previo) previo.k++;
			else cuenta.set(c, {k: 1, texto: i.texto});
		}
		const texto = [...cuenta.values()].sort((a, b) => b.k - a.k || b.texto.length - a.texto.length)[0].texto.trim();
		// Un titular dice lo mismo en casi todas las lecturas; una línea que cambia (contador, subtítulo) no.
		const top = compactarTexto(texto);
		const estables = g.items.filter((i) => similitud(compactarTexto(i.texto), top) >= 0.9).length;
		if (estables / g.items.length < op.estabilidadMin) continue;
		const med = (f: (r: Rect) => number) => cuantil(g.items.map((i) => f(i.caja)), 0.5)!;
		const caja = {x: med((r) => r.x), y: med((r) => r.y), w: med((r) => r.w), h: med((r) => r.h)};
		if (Math.abs(caja.x + caja.w / 2 - 0.5) > op.centradoMax) continue;
		salida.push({texto, normalizado: normalizarTexto(texto), caja, presencia, cuadros, confianza: cuantil(g.items.map((i) => i.confianza), 0.5)!});
	}
	return salida.sort((a, b) => a.caja.y - b.caja.y);
}

export type Halo = {
	/**
	 * Oscurecimiento junto a las letras (1 − luma / luma del fondo local), 0–1: el máximo entre direcciones de la
	 * mediana a 3–5 px de la orilla (los primeros 2 px son el antialias del contorno y no cuentan).
	 */
	oscurecimiento: number;
	/** En la dirección más oscura, fracción de orillas de letra con oscurecimiento ≥ 0.06 a 3 px (una sombra es pareja). */
	consistencia: number;
	/** ¿Hay sombra suave más allá de las letras (y de su contorno)? (oscurecimiento ≥ 0.06 y consistencia ≥ 0.6). */
	sombra: boolean;
	/** Hasta dónde llega el oscurecimiento en cada dirección (px de la imagen; null si no hay). */
	alcance: {abajo: number | null; arriba: number | null; izq: number | null; der: number | null};
	/** Desplazamiento aproximado de la sombra (px; + = abajo / derecha). */
	desplazamiento: {x: number; y: number} | null;
	/** Radio aproximado (alcance medio arriba/abajo, px). */
	radio: number | null;
	/** Color aparente junto a las letras (sombra mezclada con el fondo) y color del fondo. */
	colorAparente: Rgb | null;
	colorFondo: Rgb | null;
	/** Opacidad aproximada si la sombra es negra (1 − cociente de canales). */
	opacidad: number | null;
	/** Oscurecimiento mediano por distancia (d = 1, 2, …) en cada dirección. */
	perfiles: {abajo: number[]; arriba: number[]; izq: number[]; der: number[]};
	n: number;
};

/**
 * Halo oscuro alrededor de unas letras (pura). `glifo(r,g,b)` dice qué píxeles son letra (relleno o contorno).
 * Por cada columna (para abajo/arriba) o fila (para izq/der), desde cada orilla de letra se miden los píxeles a
 * distancia d = 1…dMax hasta toparse con otra letra; su referencia es la luma media a dRef de esa misma línea (el
 * fondo local, así no estorba un degradado). Oscurecimiento(d) = 1 − luma(d) / referencia; mediana por d.
 * Sombra = oscurecimiento a 3–5 px ≥ 0.06 y parejo (≥ 60 % de las orillas en esa dirección): el antialias del
 * contorno (1–2 px) y un objeto oscuro del fondo junto a algunas letras no cuentan.
 */
export function medirHalo(
	pix: Uint8Array,
	w: number,
	h: number,
	zona: CajaPx,
	glifo: (r: number, g: number, b: number) => boolean,
	op: {dMax?: number; dRef?: [number, number]} = {},
): Halo | null {
	const dMax = op.dMax ?? 16;
	const [ra, rb] = op.dRef ?? [dMax + 2, dMax + 8];
	const x0 = Math.max(0, Math.floor(zona.x0));
	const y0 = Math.max(0, Math.floor(zona.y0));
	const x1 = Math.min(w, Math.ceil(zona.x1));
	const y1 = Math.min(h, Math.ceil(zona.y1));
	if (x1 - x0 < 4 || y1 - y0 < 4) return null;
	const G = new Uint8Array(w * h);
	const Y = new Float32Array(w * h);
	// Solo hace falta la zona más lo que se mira hacia afuera (rb px).
	for (let y = Math.max(0, y0 - rb - 1); y < Math.min(h, y1 + rb + 1); y++) {
		for (let x = Math.max(0, x0 - rb - 1); x < Math.min(w, x1 + rb + 1); x++) {
			const o = (y * w + x) * 4;
			G[y * w + x] = glifo(pix[o], pix[o + 1], pix[o + 2]) ? 1 : 0;
			Y[y * w + x] = luma(pix[o], pix[o + 1], pix[o + 2]);
		}
	}
	const porD = {abajo: [] as number[][], arriba: [] as number[][], izq: [] as number[][], der: [] as number[][]};
	for (const k of Object.keys(porD) as Array<keyof typeof porD>) for (let d = 0; d <= dMax; d++) porD[k].push([]);
	const cercanos = {r: [] as number[], g: [] as number[], b: [] as number[]};
	const fondos = {r: [] as number[], g: [] as number[], b: [] as number[]};
	let n = 0;
	const muestrear = (dir: keyof typeof porD, en: (i: number) => number, largo: number, inicio: number, fin: number, paso: 1 | -1) => {
		// en(i) = índice del píxel i-ésimo de la línea; inicio/fin = rango de la zona en esa línea.
		for (let i = inicio; i !== fin; i += paso) {
			const q = en(i);
			const sig = i + paso;
			if (sig < 0 || sig >= largo) break;
			if (!(G[q] && !G[en(sig)])) continue;
			// Orilla de letra en i; mira hacia afuera.
			let topa = false;
			const valores: number[] = [];
			for (let d = 1; d <= rb; d++) {
				const j = i + paso * d;
				if (j < 0 || j >= largo) {
					topa = true;
					break;
				}
				if (G[en(j)]) {
					topa = true;
					break;
				}
				valores.push(Y[en(j)]);
			}
			if (topa || valores.length < rb) continue;
			const ref = valores.slice(ra - 1, rb).reduce((s, v) => s + v, 0) / (rb - ra + 1);
			if (ref < 8) continue;
			n++;
			for (let d = 1; d <= dMax; d++) porD[dir][d].push(1 - valores[d - 1] / ref);
			const qa = en(i + paso);
			const qr = en(i + paso * Math.round((ra + rb) / 2));
			cercanos.r.push(pix[qa * 4]);
			cercanos.g.push(pix[qa * 4 + 1]);
			cercanos.b.push(pix[qa * 4 + 2]);
			fondos.r.push(pix[qr * 4]);
			fondos.g.push(pix[qr * 4 + 1]);
			fondos.b.push(pix[qr * 4 + 2]);
		}
	};
	for (let x = x0; x < x1; x++) {
		muestrear('abajo', (i) => i * w + x, h, y0, y1, 1);
		muestrear('arriba', (i) => i * w + x, h, y1 - 1, y0 - 1, -1);
	}
	for (let y = y0; y < y1; y++) {
		muestrear('der', (i) => y * w + i, w, x0, x1, 1);
		muestrear('izq', (i) => y * w + i, w, x1 - 1, x0 - 1, -1);
	}
	if (n < 20) return null;
	const perfiles = {abajo: [] as number[], arriba: [] as number[], izq: [] as number[], der: [] as number[]};
	for (const k of Object.keys(perfiles) as Array<keyof typeof perfiles>) {
		for (let d = 1; d <= dMax; d++) perfiles[k].push(Number((cuantil(porD[k][d], 0.5) ?? 0).toFixed(4)));
	}
	// perfiles[k][i] es la distancia d = i + 1; d = 1–2 es antialias del contorno: se mira de d = 3 a 5.
	const cerca = (p: number[]) => Math.max(...p.slice(2, 5));
	const direcciones = ['abajo', 'arriba', 'izq', 'der'] as const;
	const oscuraDir = direcciones.reduce((a, b) => (cerca(perfiles[b]) > cerca(perfiles[a]) ? b : a));
	const oscurecimiento = Math.max(0, cerca(perfiles[oscuraDir]));
	const muestras3 = porD[oscuraDir][3] ?? [];
	const consistencia = muestras3.length ? muestras3.filter((v) => v >= 0.06).length / muestras3.length : 0;
	const sombra = oscurecimiento >= 0.06 && consistencia >= 0.6;
	const alcanceDe = (p: number[]): number | null => {
		const tope = Math.max(...p.slice(2, 5));
		if (tope < 0.03) return null;
		const umbral = Math.max(0.03, 0.25 * tope);
		let d = 0;
		for (let k = 2; k < p.length; k++) {
			if (p[k] >= umbral) d = k + 1;
			else break;
		}
		return d || null;
	};
	const alcance = {abajo: alcanceDe(perfiles.abajo), arriba: alcanceDe(perfiles.arriba), izq: alcanceDe(perfiles.izq), der: alcanceDe(perfiles.der)};
	const desplazamiento = sombra ? {x: ((alcance.der ?? 0) - (alcance.izq ?? 0)) / 2, y: ((alcance.abajo ?? 0) - (alcance.arriba ?? 0)) / 2} : null;
	const radio = sombra ? ((alcance.abajo ?? 0) + (alcance.arriba ?? 0)) / 2 : null;
	const colorAparente = medianaRgb(cercanos.r, cercanos.g, cercanos.b);
	const colorFondo = medianaRgb(fondos.r, fondos.g, fondos.b);
	let opacidad: number | null = null;
	if (sombra && colorAparente && colorFondo) {
		const cocientes = [0, 1, 2].map((c) => (colorFondo[c] > 10 ? colorAparente[c] / colorFondo[c] : null)).filter((x): x is number => x !== null);
		if (cocientes.length === 3 && Math.max(...cocientes) - Math.min(...cocientes) <= 0.12) opacidad = 1 - cocientes.reduce((s, v) => s + v, 0) / 3;
	}
	return {oscurecimiento, consistencia, sombra, alcance, desplazamiento, radio, colorAparente, colorFondo, opacidad, perfiles, n};
}

export type ComparacionTipografia = {
	veredicto: 'misma familia (probable)' | 'distinta' | 'no concluyente' | 'N/A';
	/** Trazo / alto de mayúscula del titular y de los subtítulos. */
	peso_titular: number | null;
	peso_subtitulos: number | null;
	/** Ancho medio por carácter / alto de mayúscula. */
	ancho_titular: number | null;
	ancho_subtitulos: number | null;
	/** Grosor del contorno / alto de mayúscula. */
	contorno_titular: number | null;
	contorno_subtitulos: number | null;
	diferencias: {peso: number | null; ancho: number | null; contorno: number | null};
	nota: string;
};

/**
 * ¿El titular usa la misma tipografía que los subtítulos? (pura). Compara tres firmas normalizadas por el alto de
 * mayúscula: trazo (peso), ancho medio por carácter y grosor del contorno. "misma familia (probable)" si el peso
 * difiere ≤ 15 % y el ancho ≤ 12 %; "distinta" si el peso difiere > 25 % o el ancho > 20 %; si no, "no concluyente".
 * No identifica la fuente: para eso están los recortes.
 */
export function compararTipografia(
	titular: {peso: number | null; ancho: number | null; contorno: number | null},
	subtitulos: {peso: number | null; ancho: number | null; contorno: number | null} | null,
): ComparacionTipografia {
	const dif = (a: number | null, b: number | null) => (a !== null && b !== null && b > 0 ? Number((a / b - 1).toFixed(3)) : null);
	if (!subtitulos) {
		return {
			veredicto: 'N/A',
			peso_titular: red(titular.peso, 3),
			peso_subtitulos: null,
			ancho_titular: red(titular.ancho, 3),
			ancho_subtitulos: null,
			contorno_titular: red(titular.contorno, 3),
			contorno_subtitulos: null,
			diferencias: {peso: null, ancho: null, contorno: null},
			nota: 'falta la medición de los subtítulos de este reel',
		};
	}
	const d = {peso: dif(titular.peso, subtitulos.peso), ancho: dif(titular.ancho, subtitulos.ancho), contorno: dif(titular.contorno, subtitulos.contorno)};
	let veredicto: ComparacionTipografia['veredicto'] = 'no concluyente';
	if (d.peso !== null && d.ancho !== null) {
		if (Math.abs(d.peso) <= 0.15 && Math.abs(d.ancho) <= 0.12) veredicto = 'misma familia (probable)';
		else if (Math.abs(d.peso) > 0.25 || Math.abs(d.ancho) > 0.2) veredicto = 'distinta';
	} else {
		veredicto = 'N/A';
	}
	return {
		veredicto,
		peso_titular: red(titular.peso, 3),
		peso_subtitulos: red(subtitulos.peso, 3),
		ancho_titular: red(titular.ancho, 3),
		ancho_subtitulos: red(subtitulos.ancho, 3),
		contorno_titular: red(titular.contorno, 3),
		contorno_subtitulos: red(subtitulos.contorno, 3),
		diferencias: d,
		nota: 'firmas: trazo ÷ alto de mayúscula, ancho por carácter ÷ alto de mayúscula y contorno ÷ alto de mayúscula (alto = caja de Vision ÷ 1.38 en los dos)',
	};
}

// ───────────────────────────── 6. Habla ─────────────────────────────

export type PalabraHabla = {i: number; t: string; d: number; h: number};

export type Token = {
	/** Texto normalizado (minúsculas, sin acentos); los números van en dígitos ("15", "5.5"). */
	t: string;
	num: number | null;
	moneda: boolean;
	porciento: boolean;
	/** Palabras de moneda ("dólares", "pesos") que acompañan a un número: no cuentan como palabra de más. */
	opcional: boolean;
	/** Cómo venía escrito un número: con dígitos ("15") o con palabras ("quince"); null si no es número. */
	escrito: 'digitos' | 'palabras' | null;
	/** Índice de la primera y última palabra de origen (en el habla) o del token (en la tarjeta). */
	desde: number;
	hasta: number;
};

const UNIDADES: Record<string, number> = {cero: 0, uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9};
const DIEZ_A_29: Record<string, number> = {
	diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
	veinte: 20, veintiuno: 21, veintiun: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
	veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Record<string, number> = {treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90};
const CENTENAS: Record<string, number> = {
	cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
	quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800,
	ochocientas: 800, novecientos: 900, novecientas: 900,
};
const PALABRAS_MONEDA = new Set(['dolares', 'dolar', 'pesos', 'peso', 'usd', 'euros', 'euro', 'bucks']);
const ARTICULOS_UNO = new Set(['un', 'uno', 'una']);

/** Minúsculas y sin acentos (deja dígitos, $, %, punto y coma para los números). */
function plano(texto: string): string {
	return texto.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Lee un número escrito con palabras desde `i` (pura): "treinta y cinco" → 35, "dos mil quinientos" → 2500,
 * "cinco punto cinco" → 5.5. Devuelve el valor y cuántas palabras usó; null si ahí no empieza un número. Un "un",
 * "uno" o "una" solo no cuenta (es artículo), salvo antes de "mil" o "millón".
 */
export function numeroDePalabras(palabras: readonly string[], i: number): {valor: number; usadas: number} | null {
	let total = 0;
	let actual = 0;
	let tipo: '' | 'unidad' | 'diez' | 'decena' | 'centena' | 'mil' | 'millon' = '';
	let j = i;
	let algo = false;
	for (; j < palabras.length; j++) {
		const p = palabras[j];
		if (p in UNIDADES) {
			if (tipo === 'unidad' || tipo === 'diez') break;
			actual += UNIDADES[p];
			tipo = 'unidad';
		} else if (p in DIEZ_A_29) {
			if (tipo === 'unidad' || tipo === 'diez' || tipo === 'decena') break;
			actual += DIEZ_A_29[p];
			tipo = 'diez';
		} else if (p in DECENAS) {
			if (tipo === 'unidad' || tipo === 'diez' || tipo === 'decena') break;
			actual += DECENAS[p];
			tipo = 'decena';
		} else if (p === 'y' && tipo === 'decena' && palabras[j + 1] !== undefined && palabras[j + 1] in UNIDADES) {
			continue;
		} else if (p in CENTENAS) {
			if (tipo !== '' && tipo !== 'mil' && tipo !== 'millon') break;
			actual += CENTENAS[p];
			tipo = 'centena';
		} else if (p === 'mil') {
			actual = (actual || 1) * 1000;
			total += actual;
			actual = 0;
			tipo = 'mil';
		} else if (p === 'millon' || p === 'millones') {
			total = (total + (actual || 1)) * 1_000_000;
			actual = 0;
			tipo = 'millon';
		} else {
			break;
		}
		algo = true;
	}
	if (!algo) return null;
	const usadas = j - i;
	// "un", "una", "uno" solos son artículos.
	if (usadas === 1 && ARTICULOS_UNO.has(palabras[i])) return null;
	let valor = total + actual;
	let k = j;
	// Decimales: "cinco punto cinco".
	if (palabras[k] === 'punto' && palabras[k + 1] !== undefined) {
		const dec = numeroDePalabras(palabras, k + 1);
		if (dec && dec.valor < 100) {
			const digitos = String(dec.valor).length;
			valor = Number((valor + dec.valor / 10 ** digitos).toFixed(digitos));
			k += 1 + dec.usadas;
		}
	}
	return {valor, usadas: k - i};
}

/** Número escrito con dígitos: "1,000" → 1000; "5.5" → 5.5; "1.500" → 1500. */
function numeroDeDigitos(s: string): number {
	if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
	return Number(s.replace(',', '.'));
}

/** Tokens canónicos de un texto suelto (tarjeta): números en dígitos, "$20" → 20 con moneda. */
export function tokenizar(texto: string): Token[] {
	const crudos = plano(texto).match(/\$?\s?\d+(?:[.,]\d+)*\s?%?|\p{L}+|\$|%/gu) ?? [];
	const palabras = crudos.map((c) => c.replace(/\s+/g, ''));
	return tokensDePalabras(palabras.map((p, k) => ({p, desde: k, hasta: k})));
}

/** Tokens del habla, con el índice de palabra de origen. */
export function tokenizarHabla(palabras: readonly PalabraHabla[]): Token[] {
	const piezas: Array<{p: string; desde: number; hasta: number}> = [];
	palabras.forEach((w, k) => {
		for (const c of plano(w.t).match(/\$?\d+(?:[.,]\d+)*%?|\p{L}+|\$|%/gu) ?? []) piezas.push({p: c, desde: k, hasta: k});
	});
	return tokensDePalabras(piezas);
}

function tokensDePalabras(piezas: Array<{p: string; desde: number; hasta: number}>): Token[] {
	const salida: Token[] = [];
	const ps = piezas.map((x) => x.p);
	for (let k = 0; k < piezas.length; ) {
		const p = ps[k];
		const dig = /^(\$)?(\d+(?:[.,]\d+)*)(%)?$/.exec(p);
		if (dig) {
			const tok: Token = {t: String(numeroDeDigitos(dig[2])), num: numeroDeDigitos(dig[2]), moneda: !!dig[1], porciento: !!dig[3], opcional: false, escrito: 'digitos', desde: piezas[k].desde, hasta: piezas[k].hasta};
			salida.push(tok);
			k++;
			continue;
		}
		if (p === '$') {
			// "$ 20" ya se juntó; un "$" suelto (comando de terminal) se ignora.
			k++;
			continue;
		}
		if (p === '%') {
			const previo = salida[salida.length - 1];
			if (previo && previo.num !== null) previo.porciento = true;
			k++;
			continue;
		}
		const num = numeroDePalabras(ps, k);
		if (num) {
			let fin = k + num.usadas;
			const tok: Token = {t: String(num.valor), num: num.valor, moneda: false, porciento: false, opcional: false, escrito: 'palabras', desde: piezas[k].desde, hasta: piezas[fin - 1].hasta};
			if (ps[fin] === 'por' && ps[fin + 1] === 'ciento') {
				tok.porciento = true;
				tok.hasta = piezas[fin + 1].hasta;
				fin += 2;
			}
			salida.push(tok);
			k = fin;
			if (ps[k] !== undefined && PALABRAS_MONEDA.has(ps[k])) {
				tok.moneda = true;
				salida.push({t: ps[k], num: null, moneda: false, porciento: false, opcional: true, escrito: null, desde: piezas[k].desde, hasta: piezas[k].hasta});
				k++;
			}
			continue;
		}
		salida.push({t: p, num: null, moneda: false, porciento: false, opcional: false, escrito: null, desde: piezas[k].desde, hasta: piezas[k].hasta});
		k++;
	}
	return salida;
}

/** ¿Dos tokens dicen lo mismo? Números por valor ("1" = "un"), palabras iguales o casi (≥ 0.8, 4+ letras). */
export function tokensIguales(a: Token | {t: string; num: number | null}, b: Token | {t: string; num: number | null}): boolean {
	if (a.num !== null && b.num !== null) return Math.abs(a.num - b.num) < 1e-9;
	if (a.num === 1 && ARTICULOS_UNO.has(b.t)) return true;
	if (b.num === 1 && ARTICULOS_UNO.has(a.t)) return true;
	if (a.num !== null || b.num !== null) return false;
	if (a.t === b.t) return true;
	return a.t.length >= 4 && b.t.length >= 4 && similitud(a.t, b.t) >= 0.8;
}

/**
 * ¿Una palabra es dos juntas? ("adetalle" = "a" + "detalle", "hyperframe" = "hyper" + "frame"). Más estricto que
 * tokensIguales: sin números, idénticas o casi (≥ 0.9 con 6+ letras).
 */
function igualesUnidos(sola: Token, a: Token, b: Token): boolean {
	if (sola.num !== null || a.num !== null || b.num !== null) return false;
	const junta = a.t + b.t;
	if (sola.t === junta) return true;
	return sola.t.length >= 6 && junta.length >= 6 && similitud(sola.t, junta) >= 0.9;
}

/**
 * Abreviaturas o sinónimos que una tarjeta pone en lugar de lo dicho ("En PC" ← "en computadora"). Una coincidencia
 * así cuenta como palabra dicha, pero la tarjeta queda como parafraseo (no literal).
 */
export const SINONIMOS: Record<string, string[]> = {
	pc: ['computadora', 'compu', 'computador', 'ordenador'],
	ia: ['inteligencia artificial'],
	insta: ['instagram'],
	app: ['aplicacion'],
	apps: ['aplicaciones'],
	ok: ['okay', 'esta bien'],
	tiktok: ['tik tok'],
	youtube: ['you tube'],
	whatsapp: ['whats app', 'wasap'],
};

/** Palabras vacías: no cuentan como coincidencia de contenido. */
export const PALABRAS_VACIAS = new Set([
	'de', 'del', 'la', 'el', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'y', 'o', 'a', 'al', 'en', 'que', 'tu', 'tus', 'te', 'se', 'su', 'sus',
	'con', 'por', 'para', 'mi', 'mis', 'me', 'es', 'le', 'les', 'ya', 'si', 'no', 'mas', 'muy', 'como', 'esta', 'este', 'eso', 'esto', 'yo',
]);

export type Coincidencia = {
	tipo: 'literal' | 'parafraseo' | 'sin_coincidencia';
	/** Tokens de la tarjeta que se dijeron / total de tokens de la tarjeta. */
	cobertura: number;
	/** Tokens de contenido (no vacíos) que se dijeron / total de contenido. */
	cobertura_contenido: number;
	/** Palabras dichas que coinciden (índices en la transcripción) y su texto. */
	palabras: number[];
	texto_dicho: string;
	/** Inicio de la primera palabra que coincide (s) y desfase tarjeta − palabra (s y cuadros de 30 fps). */
	inicio_habla: number | null;
	desfase_s: number | null;
	desfase_cuadros: number | null;
	/** ¿La tarjeta pone en dígitos un número que dijiste con palabras? null si no hay número dicho. */
	numero_en_digitos: boolean | null;
};

/**
 * Busca lo que dijiste que corresponde a una tarjeta (pura). Alineación semi-global: todos los tokens de la tarjeta
 * contra un tramo libre del habla entre `desde − antes` (2 s) y `hasta + despues` (1.5 s): +2 por token que coincide (también
 * 1 tarjeta ↔ 2 dichos, "adetalle" = "a detalle", y 2 ↔ 1, que valen apenas menos para que con empate gane la
 * alineación palabra por palabra), −1 por token de la tarjeta que no se dijo y −0.5 por
 * palabra dicha de más dentro del tramo (las de moneda no cuentan). Entre alineaciones empatadas gana la que empieza
 * más cerca de la tarjeta.
 * Un token también coincide con su sinónimo de SINONIMOS ("PC" = "computadora"), pero entonces no es literal.
 * - literal: se dijeron todos los tokens, seguidos y en orden;
 * - parafraseo: se dijo al menos una palabra de contenido;
 * - sin_coincidencia: ninguna de contenido.
 */
export function emparejarHabla(texto: string, desde: number, hasta: number, palabras: readonly PalabraHabla[], op: {antes?: number; despues?: number} = {}): Coincidencia {
	const vacia: Coincidencia = {tipo: 'sin_coincidencia', cobertura: 0, cobertura_contenido: 0, palabras: [], texto_dicho: '', inicio_habla: null, desfase_s: null, desfase_cuadros: null, numero_en_digitos: null};
	const C = tokenizar(texto);
	if (C.length === 0) return vacia;
	const ventana = palabras.filter((p) => p.h >= desde - (op.antes ?? 2) && p.d <= hasta + (op.despues ?? 1.5));
	const S = tokenizarHabla(ventana);
	if (S.length === 0) return vacia;
	const L = C.length;
	const M = S.length;
	const MENOS = -1e9;
	// dp[i][j]: mejor puntaje con C[0..i) alineado y el tramo del habla terminando en j (inicio libre).
	const dp = Array.from({length: L + 1}, () => new Float64Array(M + 1).fill(MENOS));
	type Paso = {pi: number; pj: number; tipo: 'm11' | 'm12' | 'm21' | 'sin' | 'saltaC' | 'saltaS' | 'inicio'; largo?: number};
	// Sinónimos de cada token de la tarjeta, como listas de tokens.
	const sinonimos = C.map((c) => (SINONIMOS[c.t] ?? []).map((f) => f.split(/\s+/)));
	const de: Paso[][] = Array.from({length: L + 1}, () => new Array<Paso>(M + 1));
	for (let j = 0; j <= M; j++) {
		dp[0][j] = 0;
		de[0][j] = {pi: 0, pj: j, tipo: 'inicio'};
	}
	const relajar = (i: number, j: number, v: number, paso: Paso) => {
		if (v > dp[i][j] + 1e-12) {
			dp[i][j] = v;
			de[i][j] = paso;
		}
	};
	for (let i = 0; i <= L; i++) {
		for (let j = 0; j <= M; j++) {
			const v = dp[i][j];
			if (v === MENOS) continue;
			if (i < L) relajar(i + 1, j, v - 1, {pi: i, pj: j, tipo: 'saltaC'});
			if (i > 0 && j < M) relajar(i, j + 1, v - (S[j].opcional ? 0 : 0.5), {pi: i, pj: j, tipo: 'saltaS'});
			if (i < L && j < M && tokensIguales(C[i], S[j])) relajar(i + 1, j + 1, v + 2, {pi: i, pj: j, tipo: 'm11'});
			// Las uniones valen un poco menos: con empate gana la alineación palabra por palabra.
			if (i < L && j + 1 < M && igualesUnidos(C[i], S[j], S[j + 1])) relajar(i + 1, j + 2, v + 1.95, {pi: i, pj: j, tipo: 'm12'});
			if (i + 1 < L && j < M && igualesUnidos(S[j], C[i], C[i + 1])) relajar(i + 2, j + 1, v + 3.9, {pi: i, pj: j, tipo: 'm21'});
			if (i < L) {
				for (const frase of sinonimos[i]) {
					if (j + frase.length > M) continue;
					if (frase.every((f, k) => S[j + k].num === null && (S[j + k].t === f || (f.length >= 4 && similitud(S[j + k].t, f) >= 0.8)))) {
						relajar(i + 1, j + frase.length, v + 1.9, {pi: i, pj: j, tipo: 'sin', largo: frase.length});
					}
				}
			}
		}
	}
	let mejorV = MENOS;
	for (let j = 0; j <= M; j++) mejorV = Math.max(mejorV, dp[L][j]);
	type Alin = {pares: Array<{c: number[]; s: number[]; sinonimo?: boolean}>; extras: number};
	const reconstruir = (jFin: number): Alin => {
		const pares: Alin['pares'] = [];
		let extras = 0;
		let i = L;
		let j = jFin;
		while (i > 0) {
			const p = de[i][j];
			if (!p || p.tipo === 'inicio') break;
			if (p.tipo === 'm11') pares.unshift({c: [p.pi], s: [p.pj]});
			else if (p.tipo === 'm12') pares.unshift({c: [p.pi], s: [p.pj, p.pj + 1]});
			else if (p.tipo === 'm21') pares.unshift({c: [p.pi, p.pi + 1], s: [p.pj]});
			else if (p.tipo === 'sin') pares.unshift({c: [p.pi], s: Array.from({length: p.largo ?? 1}, (_, k) => p.pj + k), sinonimo: true});
			else if (p.tipo === 'saltaS' && !S[p.pj].opcional) extras++;
			i = p.pi;
			j = p.pj;
		}
		// Las palabras de más ANTES del primer par no son parte del tramo.
		return {pares, extras};
	};
	let mejor: Alin | null = null;
	let mejorDist = Number.POSITIVE_INFINITY;
	for (let j = 0; j <= M; j++) {
		if (Math.abs(dp[L][j] - mejorV) > 1e-9) continue;
		const a = reconstruir(j);
		if (a.pares.length === 0) continue;
		const primera = ventana[S[a.pares[0].s[0]].desde];
		const dist = Math.abs(primera.d - desde);
		if (dist < mejorDist) {
			mejorDist = dist;
			mejor = a;
		}
	}
	if (!mejor) return vacia;
	const tokensC = new Set(mejor.pares.flatMap((p) => p.c));
	const contenido = C.map((t, k) => ({t, k})).filter(({t}) => t.num !== null || !PALABRAS_VACIAS.has(t.t));
	const contenidoDicho = contenido.filter(({k}) => tokensC.has(k)).length;
	const cobertura = tokensC.size / L;
	const coberturaContenido = contenido.length ? contenidoDicho / contenido.length : 0;
	// Extras ENTRE el primer y el último par (no cuentan los del principio).
	const sIdx = mejor.pares.flatMap((p) => p.s);
	const sMin = Math.min(...sIdx);
	const sMax = Math.max(...sIdx);
	let extrasDentro = 0;
	for (let j = sMin; j <= sMax; j++) if (!sIdx.includes(j) && !S[j].opcional) extrasDentro++;
	const literal = tokensC.size === L && extrasDentro === 0 && !mejor.pares.some((p) => p.sinonimo);
	const tipo: Coincidencia['tipo'] = literal ? 'literal' : contenidoDicho >= 1 ? 'parafraseo' : 'sin_coincidencia';
	if (tipo === 'sin_coincidencia') return vacia;
	const palabrasIdx = [...new Set(sIdx.flatMap((j) => {
		const r: number[] = [];
		for (let k = S[j].desde; k <= S[j].hasta; k++) r.push(k);
		return r;
	}))].sort((a, b) => a - b);
	const primera = ventana[palabrasIdx[0]];
	const desfase = desde - primera.d;
	// Número dicho (en voz siempre va con palabras; whisper a veces lo escribe con dígitos): ¿la tarjeta lo pone en dígitos?
	const paresNum = mejor.pares.filter((p) => p.s.some((j) => S[j].num !== null) && p.c.some((k) => C[k].num !== null));
	const numeroEnDigitos: boolean | null = paresNum.length ? paresNum.every((p) => p.c.every((k) => C[k].num === null || C[k].escrito === 'digitos')) : null;
	return {
		tipo,
		cobertura: Number(cobertura.toFixed(3)),
		cobertura_contenido: Number(coberturaContenido.toFixed(3)),
		palabras: palabrasIdx.map((k) => ventana[k].i),
		texto_dicho: palabrasIdx.map((k) => ventana[k].t).join(' '),
		inicio_habla: Number(primera.d.toFixed(3)),
		desfase_s: Number(desfase.toFixed(3)),
		desfase_cuadros: Math.round(desfase * FPS_EDL),
		numero_en_digitos: numeroEnDigitos,
	};
}

/** Marcas y productos (para clasificar tarjetas); se suman los términos de biblioteca/vocabulario.json. */
export const MARCAS_BASE = [
	'claude', 'code', 'cowork', 'design', 'opus', 'sonnet', 'haiku', 'anthropic', 'gemini', 'chatgpt', 'gpt', 'openai', 'codex', 'apify',
	'higgsfield', 'remotion', 'github', 'api', 'hyperframes', 'hyperframe', 'heygen', 'premier', 'premiere', 'after', 'effects',
	'instagram', 'insta', 'meta', 'tiktok', 'facebook', 'google', 'gmail', 'youtube', 'graphify', 'composio', 'canva', 'figma', 'notion',
	'pc', 'mac', 'windows', 'iphone', 'android', 'mcp', 'n8n', 'zapier', 'cursor', 'excel', 'whatsapp', 'slack', 'chrome',
];

export type TipoTarjeta = 'pregunta' | 'comando' | 'cifra' | 'producto' | 'frase' | 'clave';

/**
 * Qué tipo de palabra elige la tarjeta (heurística documentada, pura): pregunta (¿…?), comando ("/loop", "$ npx…"),
 * cifra (dígitos, $ o %), producto (nombra una marca o herramienta), frase (≥ 3 palabras) o clave (1–2 palabras).
 */
export function tipoDeTarjeta(texto: string, marcas: readonly string[] = MARCAS_BASE): TipoTarjeta {
	const t = texto.trim();
	if (/[¿?]/.test(t)) return 'pregunta';
	if (/^(\/\p{L}|\$\s+\p{L})/u.test(t)) return 'comando';
	if (/\d|\$|%/.test(t)) return 'cifra';
	const tokens = normalizarTexto(t).split(/\s+/).filter(Boolean);
	const conjunto = new Set(marcas.map((m) => normalizarTexto(m)).flatMap((m) => m.split(/\s+/)));
	if (tokens.some((x) => conjunto.has(x))) return 'producto';
	return tokens.length >= 3 ? 'frase' : 'clave';
}

/**
 * Limpia lo que Vision lee en una tarjeta (pura): quita "palabras" sin letras ni números (un ícono leído como "***") y
 * los asteriscos o viñetas pegados a las puntas. Respeta los saltos de renglón.
 */
export function limpiarTextoOcr(texto: string): string {
	return texto
		.split('\n')
		.map((l) =>
			l
				.split(/\s+/)
				.map((w) => w.replace(/^[*•·]+|[*•·]+$/g, ''))
				.filter((w) => /[\p{L}\p{N}]/u.test(w))
				.join(' '),
		)
		.filter((l) => l.length > 0)
		.join('\n');
}

/** Palabras de un texto (tokens con letra o número). */
export function contarPalabras(texto: string): number {
	return texto.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** ¿La primera letra del texto va en mayúscula? null si empieza con dígito o no trae letras ("$20", "15 flujos"). */
export function mayusculaInicial(texto: string): boolean | null {
	const s = texto.trim().replace(/^[^\p{L}\p{N}]+/u, '');
	const c = s[0];
	if (!c || /\p{N}/u.test(c)) return null;
	return c !== c.toLowerCase();
}

// ───────────────────────────── 7. Listas ─────────────────────────────

export type TarjetaParaLista = {id: string; nDesde: number; nHasta: number; cx: number; cy: number; w: number; h: number};

export type Lista = {
	id: string;
	tarjetas: string[];
	n: number;
	/** vertical: una debajo de otra; horizontal: lado a lado; mixta: varias filas con más de una. */
	disposicion: 'vertical' | 'horizontal' | 'mixta';
	/** Filas de arriba abajo (ids). */
	filas: string[][];
	/** Hueco vertical entre filas seguidas (px base): orilla de arriba de la de abajo − orilla de abajo de la de arriba. */
	separacion_v: number[];
	/** Hueco horizontal entre tarjetas de una misma fila (px base). */
	separacion_h: number[];
	/** lectura: aparecen en orden de lectura (arriba→abajo, izquierda→derecha); simultanea: todas en ≤ 2 cuadros. */
	orden: 'lectura' | 'simultanea' | 'otro';
	/** Cuadros (nativos) entre una aparición y la siguiente. */
	retrasos: number[];
};

/**
 * Listas (pura): tarjetas que están a la vez en pantalla (se enciman ≥ `solapeMin` cuadros) forman un grupo.
 * Filas por centro vertical (dentro de ½ alto). Coordenadas en px base.
 */
export function agruparListas(tarjetas: TarjetaParaLista[], solapeMin = 3): Lista[] {
	const padre = tarjetas.map((_, i) => i);
	const raiz = (i: number): number => (padre[i] === i ? i : (padre[i] = raiz(padre[i])));
	for (let a = 0; a < tarjetas.length; a++) {
		for (let b = a + 1; b < tarjetas.length; b++) {
			const s = Math.min(tarjetas[a].nHasta, tarjetas[b].nHasta) - Math.max(tarjetas[a].nDesde, tarjetas[b].nDesde);
			if (s >= solapeMin) padre[raiz(a)] = raiz(b);
		}
	}
	const grupos = new Map<number, TarjetaParaLista[]>();
	tarjetas.forEach((t, i) => {
		const r = raiz(i);
		grupos.set(r, [...(grupos.get(r) ?? []), t]);
	});
	const listas: Lista[] = [];
	for (const g of grupos.values()) {
		if (g.length < 2) continue;
		const porY = [...g].sort((a, b) => a.cy - b.cy);
		const filas: TarjetaParaLista[][] = [];
		for (const t of porY) {
			const fila = filas.find((f) => Math.abs(f[0].cy - t.cy) <= 0.5 * Math.min(f[0].h, t.h));
			if (fila) fila.push(t);
			else filas.push([t]);
		}
		filas.forEach((f) => f.sort((a, b) => a.cx - b.cx));
		const disposicion: Lista['disposicion'] = filas.length === 1 ? 'horizontal' : filas.every((f) => f.length === 1) ? 'vertical' : 'mixta';
		const separacion_v: number[] = [];
		for (let k = 0; k + 1 < filas.length; k++) {
			const abajo = Math.max(...filas[k].map((t) => t.cy + t.h / 2));
			const arriba = Math.min(...filas[k + 1].map((t) => t.cy - t.h / 2));
			separacion_v.push(Number((arriba - abajo).toFixed(1)));
		}
		const separacion_h: number[] = [];
		for (const f of filas) for (let k = 0; k + 1 < f.length; k++) separacion_h.push(Number((f[k + 1].cx - f[k + 1].w / 2 - (f[k].cx + f[k].w / 2)).toFixed(1)));
		const lectura = filas.flat();
		const porTiempo = [...g].sort((a, b) => a.nDesde - b.nDesde);
		const retrasos = porTiempo.slice(1).map((t, k) => t.nDesde - porTiempo[k].nDesde);
		let orden: Lista['orden'] = 'otro';
		if (retrasos.every((r) => r <= 2)) orden = 'simultanea';
		else if (lectura.every((t, k) => k === 0 || t.nDesde >= lectura[k - 1].nDesde)) orden = 'lectura';
		listas.push({
			id: '',
			tarjetas: lectura.map((t) => t.id),
			n: g.length,
			disposicion,
			filas: filas.map((f) => f.map((t) => t.id)),
			separacion_v,
			separacion_h,
			orden,
			retrasos,
		});
	}
	listas.sort((a, b) => a.tarjetas[0].localeCompare(b.tarjetas[0], undefined, {numeric: true}));
	listas.forEach((l, k) => (l.id = `l${k + 1}`));
	return listas;
}

// ───────────────────────────── Resumen por reel y agregado ─────────────────────────────

/** Lo que el resumen necesita de cada tarjeta (lo escribe medir-capas.ts). */
export type TarjetaResumible = {
	id: string;
	texto: string;
	duracion: number;
	caja: {x: number; y: number; w: number; h: number};
	radio: number | null;
	padding: {h: number | null; v: number | null};
	alto_mayuscula: number | null;
	peso: number | null;
	color_caja: string | null;
	color_texto: string | null;
	grande: boolean;
	escritura: boolean;
	lista: string | null;
	palabras: number;
	mayuscula_inicial: boolean | null;
	digitos: boolean;
	tipo_palabra: TipoTarjeta;
	entrada: 'corte' | 'animada';
	salida: 'corte' | 'animada';
	habla: Coincidencia | null;
};

export type ResumenTarjetas = {
	n: number;
	por_minuto: number | null;
	duracion_s: Cuantiles;
	centro_x_p50: number | null;
	centro_y: Cuantiles;
	ancho_p50: number | null;
	alto_p50: number | null;
	alto_mayuscula_p50: number | null;
	padding_h_p50: number | null;
	padding_v_p50: number | null;
	radio_p50: number | null;
	peso_p50: number | null;
	color_caja: string | null;
	color_texto: string | null;
	pct_en_listas: number | null;
	n_listas: number;
	separacion_lista_p50: number | null;
	pct_grande: number | null;
	pct_escritura: number | null;
	palabras_p50: number | null;
	pct_mayuscula_inicial: number | null;
	pct_con_digitos: number | null;
	tipos: Record<TipoTarjeta, number>;
	entrada: {corte: number; animada: number};
	salida: {corte: number; animada: number};
	habla: {
		n_con_habla: number;
		n_coinciden: number;
		desfase_cuadros: Cuantiles;
		pct_literal: number | null;
		pct_parafraseo: number | null;
		pct_sin_coincidencia: number | null;
		/** De las tarjetas con un número dicho con palabras, % que lo pone en dígitos. */
		pct_numeros_en_digitos: number | null;
		n_numeros: number;
	} | null;
	n_por_metrica: Record<string, number>;
};

const pctDe = (k: number, total: number) => (total > 0 ? Number(((100 * k) / total).toFixed(1)) : null);

const hexALab = (hex: string): Lab => {
	const n = Number.parseInt(hex.replace('#', ''), 16);
	return rgbALab([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
};

export function medianaHex(hexes: readonly string[]): string | null {
	const lab = medianaLab(hexes.map(hexALab));
	return lab ? rgbAHex(labARgb(lab)) : null;
}

/** Resumen de las tarjetas de un reel (puro). `conHabla` = se transcribió el audio. */
export function resumirTarjetas(
	tarjetas: readonly TarjetaResumible[],
	listas: readonly Lista[],
	duracionS: number,
	conHabla: boolean,
): ResumenTarjetas {
	const n = tarjetas.length;
	const num = (f: (t: TarjetaResumible) => number | null) => tarjetas.map(f).filter((x): x is number => x !== null && Number.isFinite(x));
	const tipos: Record<TipoTarjeta, number> = {pregunta: 0, comando: 0, cifra: 0, producto: 0, frase: 0, clave: 0};
	for (const t of tarjetas) tipos[t.tipo_palabra]++;
	const conMayus = tarjetas.filter((t) => t.mayuscula_inicial !== null);
	let habla: ResumenTarjetas['habla'] = null;
	if (conHabla) {
		const con = tarjetas.filter((t) => t.habla !== null);
		const coinciden = con.filter((t) => t.habla!.tipo !== 'sin_coincidencia');
		const nums = con.filter((t) => t.habla!.numero_en_digitos !== null);
		habla = {
			n_con_habla: con.length,
			n_coinciden: coinciden.length,
			desfase_cuadros: cuantiles(coinciden.map((t) => t.habla!.desfase_cuadros!).filter((x) => x !== null), 1),
			pct_literal: pctDe(con.filter((t) => t.habla!.tipo === 'literal').length, con.length),
			pct_parafraseo: pctDe(con.filter((t) => t.habla!.tipo === 'parafraseo').length, con.length),
			pct_sin_coincidencia: pctDe(con.filter((t) => t.habla!.tipo === 'sin_coincidencia').length, con.length),
			pct_numeros_en_digitos: pctDe(nums.filter((t) => t.habla!.numero_en_digitos).length, nums.length),
			n_numeros: nums.length,
		};
	}
	const colorCaja = medianaHex(tarjetas.map((t) => t.color_caja).filter((x): x is string => !!x));
	const colorTexto = medianaHex(tarjetas.map((t) => t.color_texto).filter((x): x is string => !!x));
	const enLista = tarjetas.filter((t) => t.lista !== null).length;
	return {
		n,
		por_minuto: duracionS > 0 ? Number(((60 * n) / duracionS).toFixed(2)) : null,
		duracion_s: cuantiles(num((t) => t.duracion), 3),
		centro_x_p50: red(cuantil(num((t) => t.caja.x), 0.5)),
		centro_y: cuantiles(num((t) => t.caja.y), 1),
		ancho_p50: red(cuantil(num((t) => t.caja.w), 0.5)),
		alto_p50: red(cuantil(num((t) => t.caja.h), 0.5)),
		alto_mayuscula_p50: red(cuantil(num((t) => t.alto_mayuscula), 0.5)),
		padding_h_p50: red(cuantil(num((t) => t.padding.h), 0.5)),
		padding_v_p50: red(cuantil(num((t) => t.padding.v), 0.5)),
		radio_p50: red(cuantil(num((t) => t.radio), 0.5)),
		peso_p50: red(cuantil(num((t) => t.peso), 0.5), 3),
		color_caja: colorCaja,
		color_texto: colorTexto,
		pct_en_listas: pctDe(enLista, n),
		n_listas: listas.length,
		separacion_lista_p50: red(cuantil(listas.flatMap((l) => l.separacion_v), 0.5)),
		pct_grande: pctDe(tarjetas.filter((t) => t.grande).length, n),
		pct_escritura: pctDe(tarjetas.filter((t) => t.escritura).length, n),
		palabras_p50: red(cuantil(num((t) => t.palabras), 0.5)),
		pct_mayuscula_inicial: pctDe(conMayus.filter((t) => t.mayuscula_inicial).length, conMayus.length),
		pct_con_digitos: pctDe(tarjetas.filter((t) => t.digitos).length, n),
		tipos,
		entrada: {corte: tarjetas.filter((t) => t.entrada === 'corte').length, animada: tarjetas.filter((t) => t.entrada === 'animada').length},
		salida: {corte: tarjetas.filter((t) => t.salida === 'corte').length, animada: tarjetas.filter((t) => t.salida === 'animada').length},
		habla,
		n_por_metrica: {
			caja: n,
			radio: num((t) => t.radio).length,
			padding: num((t) => t.padding.h).length,
			alto_mayuscula: num((t) => t.alto_mayuscula).length,
			peso: num((t) => t.peso).length,
			mayuscula_inicial: conMayus.length,
		},
	};
}

/** Métrica agregada entre reels: {valor | "N/A", n (reels), n_eventos, fuente, falta, por_reel}. */
export type Metrica<T> = {
	valor: T | 'N/A';
	n: number;
	n_eventos: number;
	fuente: 'medido';
	unidad: string;
	falta?: string;
	por_reel: Record<string, T | null>;
};

export function metrica<T>(porReel: Record<string, T | null>, nEventos: number, unidad: string, agregar: (v: T[]) => T | null): Metrica<T> {
	const validos = Object.values(porReel).filter((v): v is T => v !== null && v !== undefined);
	const valor = validos.length ? agregar(validos) : null;
	return {
		valor: valor ?? 'N/A',
		n: validos.length,
		n_eventos: nEventos,
		fuente: 'medido',
		unidad,
		...(valor === null ? {falta: 'ningún reel dio este dato'} : {}),
		por_reel: porReel,
	};
}

export const medianaNum = (v: number[]): number | null => red(cuantil(v, 0.5), 2);

/** Hex → Lab → mediana → hex (para agregar colores). */
export const medianaColores = (v: string[]): string | null => medianaHex(v);

/** ¿Un número cae entre los cuantiles de una lista? (para revisar que lo agregado sea coherente). */
export function dentroDe(v: number, lista: readonly number[], pBajo = 0.1, pAlto = 0.9): boolean {
	const a = cuantil(lista, pBajo);
	const b = cuantil(lista, pAlto);
	return a !== null && b !== null && v >= a && v <= b;
}

/** Diferencia de color perceptual entre dos hex (ΔE76 en Lab; barata, para avisos). */
export function distanciaHex(a: string, b: string): number {
	const la = hexALab(a);
	const lb = hexALab(b);
	return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
