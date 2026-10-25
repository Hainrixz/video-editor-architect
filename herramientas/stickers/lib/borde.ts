// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Borde tipo sticker y sombra, más lo mínimo de imagen que comparten las 4 fuentes de stickers
 * (voxel, logos, tus PNG de ChatGPT y los de Higgsfield). Todo es puro y determinista: corre dentro del
 * sandbox y en las pruebas unitarias (sin Vision, sin Chrome, sin dependencias nuevas: solo node:zlib).
 *
 * Imagen: RGBA de 8 bits con alfa RECTO (no premultiplicado), igual que en un PNG.
 *
 * Borde (ponerBorde):
 *   1. Silueta = alfa ≥ 50 %. Los huecos encerrados (el triángulo de YouTube, la "N" de Notion, el hueco entre
 *      un brazo y el cuerpo) se rellenan, como en un sticker troquelado: solo se corta por el contorno de afuera.
 *   2. La silueta se engorda `grosor` px con la transformada de distancia euclidiana exacta (un disco): las
 *      esquinas de afuera salen redondas y las de adentro en punta. 1 px de antialias en la orilla.
 *   3. El borde se pinta de blanco y el sujeto va encima. Lo que el sujeto tenga más allá del borde (polvo de
 *      antialias o ruido de la máscara) se descarta, así la orilla opaca del sticker siempre es blanca.
 *   4. Sombra: el cuerpo (sujeto + borde) desenfocado con una gaussiana, corrido hacia abajo y con poca opacidad,
 *      DEBAJO del cuerpo. El margen transparente alrededor deja las 4 esquinas con α = 0.
 *
 * Medidas por defecto (ajustables por opción):
 *   - grosor: 2.2 % del lado mayor de la tinta, mín. 4 px. Fuentes: en un reel publicado del creador (mascota con
 *     llave inglesa, t≈6.3 s) el blanco mide ~12 px en un sticker de ~455 px a 1440p = 2.6 % (n = 1, a ojo sobre un
 *     recorte ×4). En un pack de íconos de referencia (solo diseño) el blanco
 *     mide 16 px en los 31: 1.47 / 1.75 / 2.22 % del lado mayor (p10 / p50 / p90, n = 31, medido con
 *     distanciaA desde el 50 % de alfa hasta el primer píxel no blanco). 2.2 % queda entre las dos.
 *   - sombra: en ese pack la sombra cae hacia abajo (alcance 11 px arriba y 30 px abajo → corrimiento ≈ 9.5 px,
 *     desenfoque ≈ 20 px) con alfa máximo 74/255 ≈ 29 % (n = 3 íconos de ~800–900 px). Por defecto: caída 1.1 %,
 *     σ = 0.8 % del lado mayor y opacidad 30 %. En tus reels se ve igual de suave (el tile de Claude en
 *     reel P9 t≈1.3 s, reel P1 t≈2 s y reel P10 t≈0.5 s); ahí no se midió su opacidad (N/A).
 *
 * Verificación (verificarSticker): las 4 esquinas con α = 0 y cada píxel opaco de la orilla (α ≥ 250 con un
 * vecino de α < 250) blanco (r, g y b ≥ 235). Es la definición de "borde tipo sticker" que usan las pruebas.
 */
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {crc32, deflateSync, inflateSync} from 'node:zlib';
import {fallo} from '../../lib/fallo.ts';

export type ImagenRGBA = {ancho: number; alto: number; datos: Uint8ClampedArray};
export type Caja = {x: number; y: number; w: number; h: number};
export type Rgb = readonly [number, number, number];

export const BLANCO: Rgb = [255, 255, 255];
export const NEGRO: Rgb = [0, 0, 0];

/** Fracción del lado mayor de la tinta que mide el borde blanco por defecto (ver arriba). */
export const FRACCION_GROSOR = 0.022;
export const GROSOR_MINIMO = 4;
/** Sombra por defecto, como fracción del lado mayor del cuerpo (sujeto + borde). */
export const SOMBRA_POR_DEFECTO = {caida: 0.011, desenfoque: 0.008, opacidad: 0.3} as const;

// ───────────────────────────── Básicos ─────────────────────────────

export function nuevaImagen(ancho: number, alto: number, color?: readonly [number, number, number, number]): ImagenRGBA {
	if (!(Number.isInteger(ancho) && Number.isInteger(alto) && ancho > 0 && alto > 0)) {
		throw fallo('crear la imagen', `el tamaño ${ancho}×${alto} no es válido`, 'revisa el ancho y el alto (enteros mayores que 0)', 1);
	}
	const datos = new Uint8ClampedArray(ancho * alto * 4);
	if (color) {
		for (let i = 0; i < datos.length; i += 4) {
			datos[i] = color[0];
			datos[i + 1] = color[1];
			datos[i + 2] = color[2];
			datos[i + 3] = color[3];
		}
	}
	return {ancho, alto, datos};
}

export function copiarImagen(img: ImagenRGBA): ImagenRGBA {
	return {ancho: img.ancho, alto: img.alto, datos: new Uint8ClampedArray(img.datos)};
}

export function sha256(datos: Uint8Array | string): string {
	return createHash('sha256').update(datos).digest('hex');
}

/** Caja de los píxeles con α ≥ umbral. null si no hay ninguno. */
export function cajaTinta(img: ImagenRGBA, umbral = 1): Caja | null {
	const {ancho, alto, datos} = img;
	let x0 = ancho;
	let y0 = alto;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < alto; y++) {
		let fila = y * ancho * 4 + 3;
		for (let x = 0; x < ancho; x++, fila += 4) {
			if (datos[fila] >= umbral) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				y1 = y;
			}
		}
	}
	if (x1 < 0) return null;
	return {x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1};
}

/** Copia una región (lo que cae fuera de la imagen queda transparente). */
export function recortar(img: ImagenRGBA, caja: Caja): ImagenRGBA {
	const salida = nuevaImagen(caja.w, caja.h);
	for (let y = 0; y < caja.h; y++) {
		const ys = caja.y + y;
		if (ys < 0 || ys >= img.alto) continue;
		const x0 = Math.max(0, -caja.x);
		const x1 = Math.min(caja.w, img.ancho - caja.x);
		if (x1 <= x0) continue;
		const desde = (ys * img.ancho + caja.x + x0) * 4;
		salida.datos.set(img.datos.subarray(desde, desde + (x1 - x0) * 4), (y * caja.w + x0) * 4);
	}
	return salida;
}

/** Recorta a la tinta (α ≥ umbral) con `margen` px transparentes alrededor. */
export function recortarATinta(img: ImagenRGBA, umbral = 1, margen = 0): {imagen: ImagenRGBA; caja: Caja} {
	const caja = cajaTinta(img, umbral);
	if (!caja) {
		throw fallo('recortar a la tinta', 'la imagen quedó vacía (ningún píxel visible)', 'revisa que el sticker tenga algo además del fondo', 2);
	}
	const conMargen = {x: caja.x - margen, y: caja.y - margen, w: caja.w + 2 * margen, h: caja.h + 2 * margen};
	return {imagen: recortar(img, conMargen), caja};
}

/** Agrega `margen` px transparentes a cada lado. */
export function conMargen(img: ImagenRGBA, margen: number): ImagenRGBA {
	return recortar(img, {x: -margen, y: -margen, w: img.ancho + 2 * margen, h: img.alto + 2 * margen});
}

/** Máscara binaria (1 = α ≥ umbral). */
export function mascaraAlfa(img: ImagenRGBA, umbral = 128): Uint8Array {
	const n = img.ancho * img.alto;
	const m = new Uint8Array(n);
	for (let i = 0; i < n; i++) m[i] = img.datos[i * 4 + 3] >= umbral ? 1 : 0;
	return m;
}

/** Intersección sobre unión de dos máscaras binarias del mismo tamaño. */
export function iou(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) throw fallo('comparar máscaras', `miden distinto (${a.length} y ${b.length})`, 'compara máscaras del mismo tamaño', 1);
	let inter = 0;
	let union = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] > 0;
		const y = b[i] > 0;
		if (x && y) inter++;
		if (x || y) union++;
	}
	return union === 0 ? 1 : inter / union;
}

/** Pone `frente` sobre `fondo` (operador "over" con alfa recto) en (x, y). Devuelve una imagen nueva. */
export function componer(fondo: ImagenRGBA, frente: ImagenRGBA, x: number, y: number): ImagenRGBA {
	const salida = copiarImagen(fondo);
	const d = salida.datos;
	const f = frente.datos;
	for (let fy = 0; fy < frente.alto; fy++) {
		const sy = y + fy;
		if (sy < 0 || sy >= fondo.alto) continue;
		for (let fx = 0; fx < frente.ancho; fx++) {
			const sx = x + fx;
			if (sx < 0 || sx >= fondo.ancho) continue;
			const i = (fy * frente.ancho + fx) * 4;
			const af = f[i + 3] / 255;
			if (af <= 0) continue;
			const j = (sy * fondo.ancho + sx) * 4;
			const ab = d[j + 3] / 255;
			const a = af + ab * (1 - af);
			for (let c = 0; c < 3; c++) d[j + c] = Math.round((f[i + c] * af + d[j + c] * ab * (1 - af)) / a);
			d[j + 3] = Math.round(a * 255);
		}
	}
	return salida;
}

// ───────────────────────────── PNG ─────────────────────────────

const FIRMA_PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const CANALES: Readonly<Record<number, number>> = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const PROFUNDIDADES: Readonly<Record<number, readonly number[]>> = {
	0: [1, 2, 4, 8, 16],
	2: [8, 16],
	3: [1, 2, 4, 8],
	4: [8, 16],
	6: [8, 16],
};
/** Pasadas de Adam7: [x0, y0, dx, dy]. */
const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2],
] as const;

export function esPng(buf: Uint8Array): boolean {
	return buf.length >= 8 && FIRMA_PNG.every((b, i) => buf[i] === b);
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

const errorPng = (porque: string) => fallo('leer el PNG', porque, 'vuelve a exportar la imagen como PNG normal', 2);

/** Deshace los filtros de una pasada. Devuelve las filas crudas y dónde acabó. */
function desfiltrar(crudo: Uint8Array, desde: number, w: number, h: number, bitsPixel: number): {filas: Uint8Array; bytesFila: number; fin: number} {
	const bytesFila = Math.ceil((w * bitsPixel) / 8);
	const bpp = Math.max(1, bitsPixel >> 3);
	const filas = new Uint8Array(bytesFila * h);
	let p = desde;
	if (p + (bytesFila + 1) * h > crudo.length) throw errorPng('los datos de imagen están incompletos');
	for (let y = 0; y < h; y++) {
		const filtro = crudo[p++];
		const o = y * bytesFila;
		const arriba = o - bytesFila;
		for (let x = 0; x < bytesFila; x++) {
			const v = crudo[p + x];
			const a = x >= bpp ? filas[o + x - bpp] : 0;
			const b = y > 0 ? filas[arriba + x] : 0;
			const c = y > 0 && x >= bpp ? filas[arriba + x - bpp] : 0;
			let r: number;
			switch (filtro) {
				case 0:
					r = v;
					break;
				case 1:
					r = v + a;
					break;
				case 2:
					r = v + b;
					break;
				case 3:
					r = v + ((a + b) >> 1);
					break;
				case 4:
					r = v + paeth(a, b, c);
					break;
				default:
					throw errorPng(`la fila ${y} trae un filtro desconocido (${filtro})`);
			}
			filas[o + x] = r & 255;
		}
		p += bytesFila;
	}
	return {filas, bytesFila, fin: p};
}

/** Lee un PNG (todos los tipos de color, 1–16 bits, con o sin entrelazado) a RGBA de 8 bits con alfa recto. */
export function leerPng(buf: Uint8Array): ImagenRGBA {
	if (!esPng(buf)) throw errorPng('el archivo no es un PNG (la firma no cuadra)');
	const vista = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let pos = 8;
	let ancho = 0;
	let alto = 0;
	let profundidad = 0;
	let tipoColor = -1;
	let entrelazado = 0;
	let paleta: Uint8Array | null = null;
	let trns: Uint8Array | null = null;
	const idat: Uint8Array[] = [];
	while (pos + 8 <= buf.length) {
		const largo = vista.getUint32(pos);
		const tipo = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
		const ini = pos + 8;
		const fin = ini + largo;
		if (fin + 4 > buf.length) throw errorPng(`el bloque ${tipo} está cortado`);
		const datos = buf.subarray(ini, fin);
		if (tipo === 'IHDR') {
			ancho = vista.getUint32(ini);
			alto = vista.getUint32(ini + 4);
			profundidad = buf[ini + 8];
			tipoColor = buf[ini + 9];
			if (buf[ini + 10] !== 0 || buf[ini + 11] !== 0) throw errorPng('usa una compresión o un filtro que no son los estándar');
			entrelazado = buf[ini + 12];
		} else if (tipo === 'PLTE') {
			paleta = datos;
		} else if (tipo === 'tRNS') {
			trns = datos;
		} else if (tipo === 'IDAT') {
			idat.push(datos);
		} else if (tipo === 'IEND') {
			break;
		}
		pos = fin + 4;
	}
	if (!(ancho > 0 && alto > 0)) throw errorPng('no trae encabezado (IHDR) válido');
	const canales = CANALES[tipoColor];
	if (!canales || !PROFUNDIDADES[tipoColor].includes(profundidad)) {
		throw errorPng(`tipo de color ${tipoColor} con ${profundidad} bits no es válido`);
	}
	if (tipoColor === 3 && !paleta) throw errorPng('es de paleta y no trae paleta (PLTE)');
	if (entrelazado > 1) throw errorPng(`entrelazado desconocido (${entrelazado})`);
	if (idat.length === 0) throw errorPng('no trae datos de imagen (IDAT)');
	let crudo: Uint8Array;
	try {
		crudo = inflateSync(Buffer.concat(idat));
	} catch (error) {
		throw fallo('leer el PNG', 'los datos comprimidos están dañados', 'vuelve a exportar la imagen', 2, error);
	}

	const salida = nuevaImagen(ancho, alto);
	const d = salida.datos;
	const bitsPixel = canales * profundidad;
	const maximo = (1 << profundidad) - 1;
	const a8 = (v: number) => (profundidad === 16 ? Math.round(v / 257) : profundidad === 8 ? v : Math.round((v * 255) / maximo));
	const trnsGris = trns && tipoColor === 0 && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
	const trnsRgb =
		trns && tipoColor === 2 && trns.length >= 6 ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;

	const muestra = (filas: Uint8Array, o: number, k: number): number => {
		if (profundidad === 8) return filas[o + k];
		if (profundidad === 16) return (filas[o + 2 * k] << 8) | filas[o + 2 * k + 1];
		const porByte = 8 / profundidad;
		const byte = filas[o + Math.floor(k / porByte)];
		const corrimiento = 8 - profundidad * ((k % porByte) + 1);
		return (byte >> corrimiento) & maximo;
	};

	const pasadas = entrelazado === 1 ? ADAM7 : ([[0, 0, 1, 1]] as const);
	let p = 0;
	for (const [x0, y0, dx, dy] of pasadas) {
		const w = Math.ceil((ancho - x0) / dx);
		const h = Math.ceil((alto - y0) / dy);
		if (w <= 0 || h <= 0) continue;
		const {filas, bytesFila, fin} = desfiltrar(crudo, p, w, h, bitsPixel);
		p = fin;
		for (let j = 0; j < h; j++) {
			const o = j * bytesFila;
			const y = y0 + j * dy;
			for (let i = 0; i < w; i++) {
				const x = x0 + i * dx;
				const s = (y * ancho + x) * 4;
				const base = i * canales;
				if (tipoColor === 3) {
					const idx = muestra(filas, o, i);
					if (3 * idx + 2 >= paleta!.length) throw errorPng(`un píxel usa el color ${idx}, que no está en la paleta`);
					d[s] = paleta![3 * idx];
					d[s + 1] = paleta![3 * idx + 1];
					d[s + 2] = paleta![3 * idx + 2];
					d[s + 3] = trns && idx < trns.length ? trns[idx] : 255;
				} else if (tipoColor === 0) {
					const g = muestra(filas, o, base);
					const v = a8(g);
					d[s] = v;
					d[s + 1] = v;
					d[s + 2] = v;
					d[s + 3] = g === trnsGris ? 0 : 255;
				} else if (tipoColor === 4) {
					const v = a8(muestra(filas, o, base));
					d[s] = v;
					d[s + 1] = v;
					d[s + 2] = v;
					d[s + 3] = a8(muestra(filas, o, base + 1));
				} else {
					const r = muestra(filas, o, base);
					const g = muestra(filas, o, base + 1);
					const b = muestra(filas, o, base + 2);
					d[s] = a8(r);
					d[s + 1] = a8(g);
					d[s + 2] = a8(b);
					if (tipoColor === 6) d[s + 3] = a8(muestra(filas, o, base + 3));
					else d[s + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
				}
			}
		}
	}
	return salida;
}

function bloquePng(tipo: string, datos: Uint8Array): Buffer {
	const cabeza = Buffer.alloc(8);
	cabeza.writeUInt32BE(datos.length, 0);
	cabeza.write(tipo, 4, 'latin1');
	const cola = Buffer.alloc(4);
	cola.writeUInt32BE(crc32(Buffer.concat([cabeza.subarray(4), datos])) >>> 0, 0);
	return Buffer.concat([cabeza, datos, cola]);
}

/** Escribe RGBA de 8 bits (alfa recto) como PNG; elige el filtro de cada fila con la heurística de suma mínima. */
export function escribirPng(img: ImagenRGBA, nivel = 9): Buffer {
	const {ancho, alto, datos} = img;
	const bytesFila = ancho * 4;
	const crudo = Buffer.alloc((bytesFila + 1) * alto);
	const prueba = [0, 1, 2, 3, 4].map(() => new Uint8Array(bytesFila));
	for (let y = 0; y < alto; y++) {
		const o = y * bytesFila;
		let mejor = 0;
		let mejorSuma = Infinity;
		for (let f = 0; f < 5; f++) {
			const fila = prueba[f];
			let suma = 0;
			for (let x = 0; x < bytesFila; x++) {
				const v = datos[o + x];
				const a = x >= 4 ? datos[o + x - 4] : 0;
				const b = y > 0 ? datos[o - bytesFila + x] : 0;
				const c = y > 0 && x >= 4 ? datos[o - bytesFila + x - 4] : 0;
				let r: number;
				if (f === 0) r = v;
				else if (f === 1) r = v - a;
				else if (f === 2) r = v - b;
				else if (f === 3) r = v - ((a + b) >> 1);
				else r = v - paeth(a, b, c);
				r &= 255;
				fila[x] = r;
				suma += r < 128 ? r : 256 - r;
				if (suma >= mejorSuma) break;
			}
			if (suma < mejorSuma) {
				mejorSuma = suma;
				mejor = f;
			}
		}
		// La fila ganadora se recalcula completa (el corte temprano pudo dejarla a medias).
		const destino = y * (bytesFila + 1);
		crudo[destino] = mejor;
		for (let x = 0; x < bytesFila; x++) {
			const v = datos[o + x];
			const a = x >= 4 ? datos[o + x - 4] : 0;
			const b = y > 0 ? datos[o - bytesFila + x] : 0;
			const c = y > 0 && x >= 4 ? datos[o - bytesFila + x - 4] : 0;
			let r: number;
			if (mejor === 0) r = v;
			else if (mejor === 1) r = v - a;
			else if (mejor === 2) r = v - b;
			else if (mejor === 3) r = v - ((a + b) >> 1);
			else r = v - paeth(a, b, c);
			crudo[destino + 1 + x] = r & 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(ancho, 0);
	ihdr.writeUInt32BE(alto, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from(FIRMA_PNG),
		bloquePng('IHDR', ihdr),
		bloquePng('IDAT', deflateSync(crudo, {level: nivel, memLevel: 9})),
		bloquePng('IEND', new Uint8Array(0)),
	]);
}

export function leerPngArchivo(ruta: string): ImagenRGBA {
	let buf: Buffer;
	try {
		buf = readFileSync(ruta);
	} catch (error) {
		throw fallo('leer el PNG', `no pude abrir ${ruta}`, 'revisa la ruta', 2, error);
	}
	return leerPng(buf);
}

/** Guarda el PNG de forma atómica (archivo temporal + rename). Devuelve su sha256 y su tamaño. */
export function guardarPng(ruta: string, img: ImagenRGBA): {sha256: string; bytes: number} {
	const buf = escribirPng(img);
	mkdirSync(dirname(ruta), {recursive: true});
	const temporal = `${ruta}.${process.pid}.tmp`;
	writeFileSync(temporal, buf);
	renameSync(temporal, ruta);
	return {sha256: sha256(buf), bytes: buf.length};
}

// ───────────────────────────── Distancia, desenfoque, escala ─────────────────────────────

const MUY_LEJOS = 1e20;

/** Transformada de distancia 1D al cuadrado (Felzenszwalb y Huttenlocher, 2012). */
function distancia1D(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
	let k = 0;
	v[0] = 0;
	z[0] = -Infinity;
	z[1] = Infinity;
	for (let q = 1; q < n; q++) {
		let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) {
			k--;
			s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		}
		k++;
		v[k] = q;
		z[k] = s;
		z[k + 1] = Infinity;
	}
	k = 0;
	for (let q = 0; q < n; q++) {
		while (z[k + 1] < q) k++;
		const dq = q - v[k];
		d[q] = dq * dq + f[v[k]];
	}
}

/**
 * Distancia euclidiana exacta de cada píxel al píxel más cercano con `objetivo[i] = 1`
 * (0 sobre el objetivo). Si no hay objetivo, todo queda en Infinity.
 */
export function distanciaA(objetivo: ArrayLike<number>, ancho: number, alto: number): Float32Array {
	const n = Math.max(ancho, alto);
	const f = new Float64Array(n);
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	const tmp = new Float64Array(ancho * alto);
	let hay = false;
	for (let x = 0; x < ancho; x++) {
		for (let y = 0; y < alto; y++) {
			const o = objetivo[y * ancho + x] > 0;
			if (o) hay = true;
			f[y] = o ? 0 : MUY_LEJOS;
		}
		distancia1D(f, alto, d, v, z);
		for (let y = 0; y < alto; y++) tmp[y * ancho + x] = d[y];
	}
	const salida = new Float32Array(ancho * alto);
	if (!hay) return salida.fill(Infinity);
	for (let y = 0; y < alto; y++) {
		for (let x = 0; x < ancho; x++) f[x] = tmp[y * ancho + x];
		distancia1D(f, ancho, d, v, z);
		for (let x = 0; x < ancho; x++) salida[y * ancho + x] = Math.sqrt(d[x]);
	}
	return salida;
}

/** Desenfoque gaussiano separable de un canal (fuera de la imagen cuenta como 0, transparente). */
export function desenfocar(canal: Float32Array, ancho: number, alto: number, sigma: number): Float32Array {
	if (!(sigma > 0)) return canal.slice();
	const r = Math.max(1, Math.ceil(3 * sigma));
	const k = new Float32Array(2 * r + 1);
	let suma = 0;
	for (let i = -r; i <= r; i++) {
		k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
		suma += k[i + r];
	}
	for (let i = 0; i < k.length; i++) k[i] /= suma;
	const medio = new Float32Array(ancho * alto);
	for (let y = 0; y < alto; y++) {
		const o = y * ancho;
		for (let x = 0; x < ancho; x++) {
			let acc = 0;
			const i0 = Math.max(-r, -x);
			const i1 = Math.min(r, ancho - 1 - x);
			for (let i = i0; i <= i1; i++) acc += canal[o + x + i] * k[i + r];
			medio[o + x] = acc;
		}
	}
	const salida = new Float32Array(ancho * alto);
	for (let y = 0; y < alto; y++) {
		const i0 = Math.max(-r, -y);
		const i1 = Math.min(r, alto - 1 - y);
		for (let x = 0; x < ancho; x++) {
			let acc = 0;
			for (let i = i0; i <= i1; i++) acc += medio[(y + i) * ancho + x] * k[i + r];
			salida[y * ancho + x] = acc;
		}
	}
	return salida;
}

/** Pesos de remuestreo 1D: promedio de área al reducir, bilineal al ampliar. */
function pesos1D(origen: number, destino: number): {ini: Int32Array; fin: Int32Array; w: Float32Array[]} {
	const ini = new Int32Array(destino);
	const fin = new Int32Array(destino);
	const w: Float32Array[] = [];
	const escala = origen / destino;
	for (let i = 0; i < destino; i++) {
		if (escala >= 1) {
			const a = i * escala;
			const b = (i + 1) * escala;
			const s0 = Math.floor(a);
			const s1 = Math.min(origen - 1, Math.ceil(b) - 1);
			const pesos = new Float32Array(s1 - s0 + 1);
			for (let s = s0; s <= s1; s++) pesos[s - s0] = Math.max(0, Math.min(b, s + 1) - Math.max(a, s));
			const total = pesos.reduce((x, y) => x + y, 0) || 1;
			for (let j = 0; j < pesos.length; j++) pesos[j] /= total;
			ini[i] = s0;
			fin[i] = s1;
			w.push(pesos);
		} else {
			const c = (i + 0.5) * escala - 0.5;
			const s0 = Math.max(0, Math.floor(c));
			const s1 = Math.min(origen - 1, s0 + 1);
			const t = Math.min(1, Math.max(0, c - s0));
			ini[i] = s0;
			fin[i] = s1;
			w.push(s1 === s0 ? new Float32Array([1]) : new Float32Array([1 - t, t]));
		}
	}
	return {ini, fin, w};
}

/** Cambia el tamaño en espacio premultiplicado (sin halos oscuros en la orilla). */
export function escalar(img: ImagenRGBA, ancho: number, alto: number): ImagenRGBA {
	ancho = Math.max(1, Math.round(ancho));
	alto = Math.max(1, Math.round(alto));
	if (ancho === img.ancho && alto === img.alto) return copiarImagen(img);
	const n = img.ancho * img.alto;
	const pre = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) {
		const a = img.datos[i * 4 + 3] / 255;
		pre[i * 4] = img.datos[i * 4] * a;
		pre[i * 4 + 1] = img.datos[i * 4 + 1] * a;
		pre[i * 4 + 2] = img.datos[i * 4 + 2] * a;
		pre[i * 4 + 3] = a;
	}
	const px = pesos1D(img.ancho, ancho);
	const py = pesos1D(img.alto, alto);
	const medio = new Float32Array(ancho * img.alto * 4);
	for (let y = 0; y < img.alto; y++) {
		for (let x = 0; x < ancho; x++) {
			const pesos = px.w[x];
			for (let c = 0; c < 4; c++) {
				let acc = 0;
				for (let j = 0; j < pesos.length; j++) acc += pre[(y * img.ancho + px.ini[x] + j) * 4 + c] * pesos[j];
				medio[(y * ancho + x) * 4 + c] = acc;
			}
		}
	}
	const salida = nuevaImagen(ancho, alto);
	for (let y = 0; y < alto; y++) {
		const pesos = py.w[y];
		for (let x = 0; x < ancho; x++) {
			const acc = [0, 0, 0, 0];
			for (let j = 0; j < pesos.length; j++) {
				const o = ((py.ini[y] + j) * ancho + x) * 4;
				for (let c = 0; c < 4; c++) acc[c] += medio[o + c] * pesos[j];
			}
			const o = (y * ancho + x) * 4;
			const a = acc[3];
			if (a > 1e-6) {
				salida.datos[o] = Math.round(acc[0] / a);
				salida.datos[o + 1] = Math.round(acc[1] / a);
				salida.datos[o + 2] = Math.round(acc[2] / a);
			}
			salida.datos[o + 3] = Math.round(a * 255);
		}
	}
	return salida;
}

/** Si el lado mayor pasa de `ladoMax`, reduce manteniendo la proporción. */
export function limitarLado(img: ImagenRGBA, ladoMax: number): ImagenRGBA {
	const mayor = Math.max(img.ancho, img.alto);
	if (mayor <= ladoMax) return img;
	const f = ladoMax / mayor;
	return escalar(img, img.ancho * f, img.alto * f);
}

/** Erosión en escala de grises del alfa con un disco de `radio` px (quita la orilla contaminada). */
export function erosionarAlfa(img: ImagenRGBA, radio: number): ImagenRGBA {
	const salida = copiarImagen(img);
	if (radio <= 0) return salida;
	const {ancho, alto, datos} = img;
	const desplazamientos: [number, number][] = [];
	const r = Math.ceil(radio);
	for (let dy = -r; dy <= r; dy++) {
		for (let dx = -r; dx <= r; dx++) {
			if (dx * dx + dy * dy <= radio * radio + 0.25) desplazamientos.push([dx, dy]);
		}
	}
	for (let y = 0; y < alto; y++) {
		for (let x = 0; x < ancho; x++) {
			const i = (y * ancho + x) * 4 + 3;
			if (datos[i] === 0) continue;
			let minimo = datos[i];
			for (const [dx, dy] of desplazamientos) {
				const xx = x + dx;
				const yy = y + dy;
				const a = xx < 0 || yy < 0 || xx >= ancho || yy >= alto ? 0 : datos[(yy * ancho + xx) * 4 + 3];
				if (a < minimo) {
					minimo = a;
					if (minimo === 0) break;
				}
			}
			salida.datos[i] = minimo;
		}
	}
	return salida;
}

/**
 * Marca lo que NO es exterior: todo lo que no se alcanza desde la orilla del lienzo caminando (4 vecinos)
 * por píxeles con `solido[i] = 0`. Rellena los huecos encerrados.
 */
export function rellenarHuecos(solido: Uint8Array, ancho: number, alto: number): Uint8Array {
	const exterior = new Uint8Array(ancho * alto);
	const pila = new Int32Array(ancho * alto);
	let tope = 0;
	const sembrar = (i: number) => {
		if (!solido[i] && !exterior[i]) {
			exterior[i] = 1;
			pila[tope++] = i;
		}
	};
	for (let x = 0; x < ancho; x++) {
		sembrar(x);
		sembrar((alto - 1) * ancho + x);
	}
	for (let y = 0; y < alto; y++) {
		sembrar(y * ancho);
		sembrar(y * ancho + ancho - 1);
	}
	while (tope > 0) {
		const i = pila[--tope];
		const x = i % ancho;
		if (x > 0) sembrar(i - 1);
		if (x < ancho - 1) sembrar(i + 1);
		if (i >= ancho) sembrar(i - ancho);
		if (i < ancho * (alto - 1)) sembrar(i + ancho);
	}
	const lleno = new Uint8Array(ancho * alto);
	for (let i = 0; i < lleno.length; i++) lleno[i] = exterior[i] ? 0 : 1;
	return lleno;
}

// ───────────────────────────── Borde y sombra ─────────────────────────────

export type OpcionesSombra = {
	/** Corrimiento en px (positivo = abajo / derecha). */
	dx: number;
	dy: number;
	/** σ de la gaussiana en px. */
	desenfoque: number;
	/** 0–1. */
	opacidad: number;
	color?: Rgb;
};

export type OpcionesBorde = {
	/** Grosor del borde en px. Por defecto, 2.2 % del lado mayor de la tinta (mín. 4). 0 = sin borde (solo sombra). */
	grosor?: number;
	color?: Rgb;
	/** Qué cuenta como "dentro" del sujeto (0–255). Por defecto 128 (50 %). */
	umbral?: number;
	/** Rellenar los huecos encerrados con el color del borde (por defecto sí, como un sticker troquelado). */
	rellenarHuecos?: boolean;
	/** null = sin sombra; undefined = la de por defecto (proporcional al tamaño). */
	sombra?: OpcionesSombra | null;
};

export type ResultadoBorde = {
	imagen: ImagenRGBA;
	/** Caja del cuerpo visible (sujeto + borde, sin la sombra) dentro de `imagen`. */
	cuerpo: Caja;
	grosor: number;
	sombra: OpcionesSombra | null;
};

/** Sombra por defecto para un cuerpo de lado mayor `lado`. */
export function sombraPorDefecto(lado: number): OpcionesSombra {
	return {
		dx: 0,
		dy: Math.max(1, Math.round(lado * SOMBRA_POR_DEFECTO.caida)),
		desenfoque: Math.max(1, lado * SOMBRA_POR_DEFECTO.desenfoque),
		opacidad: SOMBRA_POR_DEFECTO.opacidad,
	};
}

/** Grosor por defecto para una tinta de lado mayor `lado`. */
export function grosorPorDefecto(lado: number): number {
	return Math.max(GROSOR_MINIMO, Math.round(lado * FRACCION_GROSOR));
}

/**
 * Pone el borde blanco tipo sticker y la sombra. La entrada puede traer margen transparente: se recorta a la tinta.
 * La salida trae el margen justo para que la sombra quepa y las esquinas queden en α = 0.
 */
export function ponerBorde(img: ImagenRGBA, op: OpcionesBorde = {}): ResultadoBorde {
	const {imagen: sujeto} = recortarATinta(img, 1);
	const lado = Math.max(sujeto.ancho, sujeto.alto);
	const grosor = Math.max(0, Math.round(op.grosor ?? grosorPorDefecto(lado)));
	const color = op.color ?? BLANCO;
	const ladoCuerpo = lado + 2 * grosor;
	const sombra = op.sombra === undefined ? sombraPorDefecto(ladoCuerpo) : op.sombra;
	const alcanceSombra = sombra ? Math.ceil(3 * sombra.desenfoque) + Math.ceil(Math.max(Math.abs(sombra.dx), Math.abs(sombra.dy))) : 0;
	const margen = grosor + alcanceSombra + 3;
	const lienzo = conMargen(sujeto, margen);
	const {ancho, alto} = lienzo;
	const n = ancho * alto;
	const s = lienzo.datos;

	// 1. Silueta del sujeto (α ≥ umbral). Si nada llega al umbral (sujeto muy tenue), se usa la mitad del máximo.
	let umbral = op.umbral ?? 128;
	let maximo = 0;
	for (let i = 0; i < n; i++) maximo = Math.max(maximo, s[i * 4 + 3]);
	if (maximo < umbral) umbral = Math.max(1, Math.round(maximo / 2));
	let silueta: Uint8Array = new Uint8Array(n);
	for (let i = 0; i < n; i++) silueta[i] = s[i * 4 + 3] >= umbral ? 1 : 0;
	if (op.rellenarHuecos !== false) silueta = rellenarHuecos(silueta, ancho, alto);

	// 2. Cuerpo = sujeto sobre el borde engordado.
	const cuerpo = nuevaImagen(ancho, alto);
	const c = cuerpo.datos;
	if (grosor === 0) {
		c.set(s);
	} else {
		const dist = distanciaA(silueta, ancho, alto);
		const limiteSujeto = grosor >= 3 ? grosor - 1.5 : Infinity;
		for (let i = 0; i < n; i++) {
			const d = dist[i];
			const cb = Math.min(1, Math.max(0, grosor + 0.5 - d));
			let as = s[i * 4 + 3] / 255;
			if (d > limiteSujeto) as = 0;
			const a = as + cb * (1 - as);
			if (a <= 0) continue;
			const o = i * 4;
			c[o] = Math.round((s[o] * as + color[0] * cb * (1 - as)) / a);
			c[o + 1] = Math.round((s[o + 1] * as + color[1] * cb * (1 - as)) / a);
			c[o + 2] = Math.round((s[o + 2] * as + color[2] * cb * (1 - as)) / a);
			c[o + 3] = Math.round(a * 255);
		}
	}
	const cajaCuerpo = cajaTinta(cuerpo, 1);
	if (!cajaCuerpo) throw fallo('poner el borde', 'el sticker quedó vacío', 'revisa la máscara de entrada', 1);
	if (!sombra) return {imagen: cuerpo, cuerpo: cajaCuerpo, grosor, sombra: null};

	// 3. Sombra debajo del cuerpo.
	const alfaCuerpo = new Float32Array(n);
	for (let i = 0; i < n; i++) alfaCuerpo[i] = c[i * 4 + 3] / 255;
	const borrosa = desenfocar(alfaCuerpo, ancho, alto, sombra.desenfoque);
	const dx = Math.round(sombra.dx);
	const dy = Math.round(sombra.dy);
	const colorSombra = sombra.color ?? NEGRO;
	const salida = nuevaImagen(ancho, alto);
	const o2 = salida.datos;
	for (let y = 0; y < alto; y++) {
		for (let x = 0; x < ancho; x++) {
			const i = y * ancho + x;
			const xs = x - dx;
			const ys = y - dy;
			const sh = xs >= 0 && ys >= 0 && xs < ancho && ys < alto ? borrosa[ys * ancho + xs] * sombra.opacidad : 0;
			const ab = alfaCuerpo[i];
			const a = ab + sh * (1 - ab);
			if (a <= 0) continue;
			const o = i * 4;
			o2[o] = Math.round((c[o] * ab + colorSombra[0] * sh * (1 - ab)) / a);
			o2[o + 1] = Math.round((c[o + 1] * ab + colorSombra[1] * sh * (1 - ab)) / a);
			o2[o + 2] = Math.round((c[o + 2] * ab + colorSombra[2] * sh * (1 - ab)) / a);
			o2[o + 3] = Math.round(a * 255);
		}
	}
	return {imagen: salida, cuerpo: cajaCuerpo, grosor, sombra};
}

/** Solo la sombra (para un sticker que ya trae su propia orilla blanca, como el tile de un logo). */
export function ponerSombra(img: ImagenRGBA, sombra?: OpcionesSombra | null): ResultadoBorde {
	return ponerBorde(img, {grosor: 0, sombra, rellenarHuecos: false});
}

// ───────────────────────────── Verificación ─────────────────────────────

export type VerificacionSticker = {
	ancho: number;
	alto: number;
	alfaEsquinas: [number, number, number, number];
	esquinasTransparentes: boolean;
	/** Píxeles opacos (α ≥ umbralOpaco) que tocan a uno no opaco o a la orilla del lienzo. */
	orilla: {total: number; blancos: number; fraccion: number; peor: {x: number; y: number; rgb: [number, number, number]} | null};
	/** Hay al menos un píxel con α < 255. */
	tieneAlfa: boolean;
	ok: boolean;
};

/** Revisa la transparencia y el borde tipo sticker (ver el encabezado del archivo). */
export function verificarSticker(img: ImagenRGBA, umbralOpaco = 250, umbralBlanco = 235): VerificacionSticker {
	const {ancho, alto, datos} = img;
	const alfa = (x: number, y: number) => datos[(y * ancho + x) * 4 + 3];
	const alfaEsquinas: [number, number, number, number] = [alfa(0, 0), alfa(ancho - 1, 0), alfa(0, alto - 1), alfa(ancho - 1, alto - 1)];
	let total = 0;
	let blancos = 0;
	let tieneAlfa = false;
	let peor: VerificacionSticker['orilla']['peor'] = null;
	let peorMin = 256;
	for (let y = 0; y < alto; y++) {
		for (let x = 0; x < ancho; x++) {
			const o = (y * ancho + x) * 4;
			const a = datos[o + 3];
			if (a < 255) tieneAlfa = true;
			if (a < umbralOpaco) continue;
			const borde =
				x === 0 ||
				y === 0 ||
				x === ancho - 1 ||
				y === alto - 1 ||
				alfa(x - 1, y) < umbralOpaco ||
				alfa(x + 1, y) < umbralOpaco ||
				alfa(x, y - 1) < umbralOpaco ||
				alfa(x, y + 1) < umbralOpaco;
			if (!borde) continue;
			total++;
			const minimo = Math.min(datos[o], datos[o + 1], datos[o + 2]);
			if (minimo >= umbralBlanco) blancos++;
			else if (minimo < peorMin) {
				peorMin = minimo;
				peor = {x, y, rgb: [datos[o], datos[o + 1], datos[o + 2]]};
			}
		}
	}
	const esquinasTransparentes = alfaEsquinas.every((a) => a === 0);
	const fraccion = total === 0 ? 0 : blancos / total;
	return {
		ancho,
		alto,
		alfaEsquinas,
		esquinasTransparentes,
		orilla: {total, blancos, fraccion, peor},
		tieneAlfa,
		ok: esquinasTransparentes && tieneAlfa && total > 0 && blancos === total,
	};
}
