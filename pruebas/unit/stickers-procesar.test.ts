// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de las fuentes 2, 3 y 4 de stickers (parte pura; corren dentro del sandbox, sin Vision ni Chrome):
 *   - herramientas/stickers/lib/borde.ts: PNG, recorte a la tinta, borde tipo sticker, sombra y verificación.
 *   - herramientas/stickers/procesar.ts: fondo por color (plan B sin Vision), islas, halo, catálogo.
 *   - herramientas/stickers/ia-post.ts: croma con despill.
 *   - herramientas/stickers/logo.ts: tile y "solo" con un SVG propio (resvg corre en CPU).
 *   - La biblioteca: cada PNG de biblioteca/stickers/{logos,chatgpt,ia}/ con esquinas α = 0 y orilla blanca,
 *     y cada fila de su catálogo apuntando a un archivo con el mismo sha256.
 */
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync, crc32} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {abrirFuente} from '../../herramientas/lib/texto-ancho.ts';
import {
	cajaTinta,
	escribirPng,
	iou,
	leerPng,
	mascaraAlfa,
	nuevaImagen,
	ponerBorde,
	ponerSombra,
	recortarATinta,
	sha256,
	verificarSticker,
	type ImagenRGBA,
} from '../../herramientas/stickers/lib/borde.ts';
import {detectarCroma, quitarCroma} from '../../herramientas/stickers/ia-post.ts';
import {armarSolo, armarTile, conViewBox, LADO_TILE, TILE, tamanoNombre, textoATrazo, viewBoxATinta, viewBoxDe} from '../../herramientas/stickers/logo.ts';
import {
	armarSticker,
	colorDeFondo,
	etiquetasDeNombre,
	guardarCatalogo,
	idParaArchivo,
	leerCatalogo,
	piezasQueVisionDejo,
	ponerFila,
	quitarHalo,
	quitarIslas,
	revisarDestino,
	segmentarPorFondo,
	traeAlfaPropio,
	type FilaCatalogo,
} from '../../herramientas/stickers/procesar.ts';
import {HAY_FUENTES} from './requisitos.ts';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ───────────────────────────── Ayudas ─────────────────────────────

/** Generador determinista (LCG) para el ruido. */
function azar(semilla: number): () => number {
	let s = semilla >>> 0;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return (s & 0x7fffffff) / 0x7fffffff;
	};
}

type Rgb3 = [number, number, number];

/**
 * Dibuja una figura con antialias (supermuestreo 4×4) sobre un fondo. Devuelve la imagen opaca y la máscara
 * conocida (cobertura ≥ 50 %).
 */
function dibujar(ancho: number, alto: number, fondo: (x: number, y: number) => Rgb3, figura: (x: number, y: number) => Rgb3 | null): {img: ImagenRGBA; mascara: Uint8Array} {
	const img = nuevaImagen(ancho, alto);
	const mascara = new Uint8Array(ancho * alto);
	for (let y = 0; y < alto; y++) {
		for (let x = 0; x < ancho; x++) {
			let cubiertos = 0;
			const suma = [0, 0, 0];
			for (let sy = 0; sy < 4; sy++) {
				for (let sx = 0; sx < 4; sx++) {
					const c = figura(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
					if (!c) continue;
					cubiertos++;
					suma[0] += c[0];
					suma[1] += c[1];
					suma[2] += c[2];
				}
			}
			const f = cubiertos / 16;
			const bg = fondo(x, y);
			const o = (y * ancho + x) * 4;
			for (let k = 0; k < 3; k++) img.datos[o + k] = cubiertos ? (suma[k] / cubiertos) * f + bg[k] * (1 - f) : bg[k];
			img.datos[o + 3] = 255;
			mascara[y * ancho + x] = f >= 0.5 ? 1 : 0;
		}
	}
	return {img, mascara};
}

/** Una mascota propia: cuerpo naranja con contorno oscuro, ojos blancos encerrados, mitad gris y un brillo suelto. */
function personaje(cx: number, cy: number, escala = 1): (x: number, y: number) => Rgb3 | null {
	return (x, y) => {
		const u = (x - cx) / escala;
		const v = (y - cy) / escala;
		if (Math.abs(u - 230) + Math.abs(v + 180) <= 26) return [255, 200, 40];
		const contorno = (u / 190) ** 2 + (v / 150) ** 2 <= 1 || (Math.abs(u) < 150 && v > 10 && v < 190);
		if (!contorno) return null;
		const cuerpo = (u / 180) ** 2 + (v / 140) ** 2 <= 1 || (Math.abs(u) < 140 && v > 10 && v < 180);
		if (!cuerpo) return [25, 22, 22];
		if ((u + 60) ** 2 + (v + 40) ** 2 <= 26 ** 2 || (u - 60) ** 2 + (v + 40) ** 2 <= 26 ** 2) return [252, 252, 252];
		return u < 0 ? [217, 119, 87] : [120, 120, 130];
	};
}

function esFallo(fn: () => unknown, codigo: number): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(codigo);
		return;
	}
	throw new Error('esperaba un FalloEditor y no hubo error');
}

/** PNG a mano (para probar el lector con tipos de color que el escritor no produce). */
function pngCrudo(op: {ancho: number; alto: number; tipo: number; profundidad: number; crudo: Uint8Array; plte?: Uint8Array; trns?: Uint8Array; entrelazado?: number}): Buffer {
	const bloque = (tipo: string, datos: Uint8Array) => {
		const cabeza = Buffer.alloc(8);
		cabeza.writeUInt32BE(datos.length, 0);
		cabeza.write(tipo, 4, 'latin1');
		const cola = Buffer.alloc(4);
		cola.writeUInt32BE(crc32(Buffer.concat([cabeza.subarray(4), datos])) >>> 0, 0);
		return Buffer.concat([cabeza, datos, cola]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(op.ancho, 0);
	ihdr.writeUInt32BE(op.alto, 4);
	ihdr[8] = op.profundidad;
	ihdr[9] = op.tipo;
	ihdr[12] = op.entrelazado ?? 0;
	const partes = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloque('IHDR', ihdr)];
	if (op.plte) partes.push(bloque('PLTE', op.plte));
	if (op.trns) partes.push(bloque('tRNS', op.trns));
	partes.push(bloque('IDAT', deflateSync(op.crudo)), bloque('IEND', new Uint8Array(0)));
	return Buffer.concat(partes);
}

/** Filas sin filtrar (filtro 0) a partir de bytes por fila. */
function filas0(filas: number[][]): Uint8Array {
	return Uint8Array.from(filas.flatMap((f) => [0, ...f]));
}

// ───────────────────────────── PNG ─────────────────────────────

describe('PNG (lib/borde.ts)', () => {
	it('escribe y vuelve a leer RGBA exacto, con alfa de 0 a 255', () => {
		const r = azar(1);
		const img = nuevaImagen(37, 23);
		for (let i = 0; i < img.datos.length; i++) img.datos[i] = Math.floor(r() * 256);
		const leida = leerPng(escribirPng(img));
		expect(leida.ancho).toBe(37);
		expect(leida.alto).toBe(23);
		expect(Buffer.from(leida.datos).equals(Buffer.from(img.datos))).toBe(true);
	});

	it('lee paleta con tRNS, gris de 16 bits, gris con alfa, gris de 2 bits y RGB con tRNS', () => {
		// Paleta: 2×1, índices 0 y 1; el 1 es medio transparente.
		const pal = leerPng(pngCrudo({ancho: 2, alto: 1, tipo: 3, profundidad: 8, crudo: filas0([[0, 1]]), plte: Uint8Array.from([255, 0, 0, 0, 0, 255]), trns: Uint8Array.from([255, 128])}));
		expect([...pal.datos]).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
		// Gris de 16 bits: 0xFFFF → 255 y 0x8080 → 128.
		const g16 = leerPng(pngCrudo({ancho: 2, alto: 1, tipo: 0, profundidad: 16, crudo: filas0([[0xff, 0xff, 0x80, 0x80]])}));
		expect([...g16.datos]).toEqual([255, 255, 255, 255, 128, 128, 128, 255]);
		// Gris con alfa (8 bits).
		const ga = leerPng(pngCrudo({ancho: 1, alto: 1, tipo: 4, profundidad: 8, crudo: filas0([[40, 200]])}));
		expect([...ga.datos]).toEqual([40, 40, 40, 200]);
		// Gris de 2 bits: 4 píxeles en un byte (0b00_01_10_11) → 0, 85, 170, 255.
		const g2 = leerPng(pngCrudo({ancho: 4, alto: 1, tipo: 0, profundidad: 2, crudo: filas0([[0b00011011]])}));
		expect([...g2.datos].filter((_, i) => i % 4 === 0)).toEqual([0, 85, 170, 255]);
		// RGB con tRNS: el color (10, 20, 30) es transparente.
		const rgb = leerPng(pngCrudo({ancho: 2, alto: 1, tipo: 2, profundidad: 8, crudo: filas0([[10, 20, 30, 1, 2, 3]]), trns: Uint8Array.from([0, 10, 0, 20, 0, 30])}));
		expect([rgb.datos[3], rgb.datos[7]]).toEqual([0, 255]);
	});

	it('lee PNG entrelazado (Adam7) igual que el normal', () => {
		const ancho = 11;
		const alto = 9;
		const color = (x: number, y: number) => [x * 20, y * 25, (x * 7 + y * 13) % 256, 255 - x * 3];
		const pasadas = [
			[0, 0, 8, 8],
			[4, 0, 8, 8],
			[0, 4, 4, 8],
			[2, 0, 4, 4],
			[0, 2, 2, 4],
			[1, 0, 2, 2],
			[0, 1, 1, 2],
		];
		const bytes: number[] = [];
		for (const [x0, y0, dx, dy] of pasadas) {
			for (let y = y0; y < alto; y += dy) {
				const fila: number[] = [];
				for (let x = x0; x < ancho; x += dx) fila.push(...color(x, y));
				if (fila.length > 0) bytes.push(0, ...fila);
			}
		}
		const img = leerPng(pngCrudo({ancho, alto, tipo: 6, profundidad: 8, crudo: Uint8Array.from(bytes), entrelazado: 1}));
		for (let y = 0; y < alto; y++) {
			for (let x = 0; x < ancho; x++) {
				const o = (y * ancho + x) * 4;
				expect([...img.datos.subarray(o, o + 4)]).toEqual(color(x, y));
			}
		}
	});

	it('rechaza lo que no es PNG con código 2', () => {
		esFallo(() => leerPng(Buffer.from('esto no es un png')), 2);
	});
});

// ───────────────────────────── Recorte y borde ─────────────────────────────

describe('recorte a la tinta', () => {
	it('encuentra la caja exacta (incluye píxeles medio transparentes) y recorta con margen', () => {
		const img = nuevaImagen(100, 80);
		for (let y = 22; y < 39; y++) for (let x = 13; x < 53; x++) img.datos[(y * 100 + x) * 4 + 3] = 255;
		img.datos[(38 * 100 + 52) * 4 + 3] = 3;
		img.datos[(22 * 100 + 13) * 4] = 77;
		const {imagen, caja} = recortarATinta(img);
		expect(caja).toEqual({x: 13, y: 22, w: 40, h: 17});
		expect([imagen.ancho, imagen.alto]).toEqual([40, 17]);
		expect(imagen.datos[0]).toBe(77);
		const conMargen = recortarATinta(img, 1, 2).imagen;
		expect([conMargen.ancho, conMargen.alto]).toEqual([44, 21]);
		expect(cajaTinta(conMargen)).toEqual({x: 2, y: 2, w: 40, h: 17});
	});

	it('una imagen vacía sale con código 2', () => {
		esFallo(() => recortarATinta(nuevaImagen(10, 10)), 2);
	});
});

describe('borde tipo sticker (ponerBorde)', () => {
	const sujeto = (): ImagenRGBA => {
		const {img, mascara} = dibujar(220, 200, () => [0, 0, 0], personaje(110, 105, 0.45));
		for (let i = 0; i < mascara.length; i++) img.datos[i * 4 + 3] = mascara[i] ? 255 : 0;
		return img;
	};

	it('cada píxel opaco de la orilla es blanco y las 4 esquinas quedan con α = 0', () => {
		const r = ponerBorde(sujeto(), {grosor: 8});
		const v = verificarSticker(r.imagen);
		expect(v.alfaEsquinas).toEqual([0, 0, 0, 0]);
		expect(v.orilla.total).toBeGreaterThan(200);
		expect(v.orilla.blancos).toBe(v.orilla.total);
		expect(v.ok).toBe(true);
	});

	it('el borde mide el grosor pedido (±1 px) y el cuerpo es la tinta + 2 × grosor', () => {
		const img = sujeto();
		const tinta = cajaTinta(img, 128)!;
		const r = ponerBorde(img, {grosor: 10, sombra: null});
		expect(r.cuerpo.w).toBeGreaterThanOrEqual(tinta.w + 20 - 2);
		expect(r.cuerpo.w).toBeLessThanOrEqual(tinta.w + 20 + 2);
		// En la fila del centro: de la primera tinta blanca a la primera oscura del contorno.
		const {ancho, datos} = r.imagen;
		const y = r.cuerpo.y + Math.round(r.cuerpo.h * 0.4);
		let x = 0;
		while (datos[(y * ancho + x) * 4 + 3] < 128) x++;
		const inicio = x;
		while (Math.min(datos[(y * ancho + x) * 4], datos[(y * ancho + x) * 4 + 1]) > 128) x++;
		expect(Math.abs(x - inicio - 10)).toBeLessThanOrEqual(1);
	});

	it('rellena de blanco los huecos encerrados (como un sticker troquelado) salvo que se pida lo contrario', () => {
		const anillo = nuevaImagen(120, 120);
		for (let y = 0; y < 120; y++) {
			for (let x = 0; x < 120; x++) {
				const d = Math.hypot(x - 60, y - 60);
				if (d <= 50 && d >= 30) anillo.datos.set([20, 120, 220, 255], (y * 120 + x) * 4);
			}
		}
		const lleno = ponerBorde(anillo, {grosor: 4, sombra: null}).imagen;
		const centro = (img: ImagenRGBA) => (Math.floor(img.alto / 2) * img.ancho + Math.floor(img.ancho / 2)) * 4;
		expect([...lleno.datos.subarray(centro(lleno), centro(lleno) + 4)]).toEqual([255, 255, 255, 255]);
		const hueco = ponerBorde(anillo, {grosor: 4, sombra: null, rellenarHuecos: false}).imagen;
		expect(hueco.datos[centro(hueco) + 3]).toBe(0);
	});

	it('la sombra cae hacia abajo y sin sombra no hay nada fuera del borde', () => {
		const img = sujeto();
		const con = ponerBorde(img, {grosor: 6});
		const {cuerpo, imagen} = con;
		const cx = cuerpo.x + Math.floor(cuerpo.w / 2);
		const alfa = (x: number, y: number) => imagen.datos[(y * imagen.ancho + x) * 4 + 3];
		// La columna del centro: unos px debajo del cuerpo hay más sombra que los mismos px encima.
		let abajo = cuerpo.y + cuerpo.h + 1;
		while (alfa(cx, abajo) === 255) abajo++;
		let arriba = cuerpo.y - 2;
		while (arriba > 0 && alfa(cx, arriba) === 255) arriba--;
		expect(alfa(cx, abajo + 2)).toBeGreaterThan(alfa(cx, arriba - 2));
		expect(con.sombra?.opacidad).toBeCloseTo(0.3);
		const sin = ponerBorde(img, {grosor: 6, sombra: null});
		expect(cajaTinta(sin.imagen, 1)).toEqual(sin.cuerpo);
	});

	it('ponerSombra no agrega borde: respeta la orilla del sticker (un tile blanco)', () => {
		const tile = nuevaImagen(80, 80, [255, 255, 255, 255]);
		const r = ponerSombra(tile);
		expect(r.grosor).toBe(0);
		expect([r.cuerpo.w, r.cuerpo.h]).toEqual([80, 80]);
		expect(verificarSticker(r.imagen).ok).toBe(true);
	});

	it('verificarSticker detecta un PNG sin alfa y una orilla que no es blanca', () => {
		expect(verificarSticker(nuevaImagen(10, 10, [255, 255, 255, 255])).ok).toBe(false);
		const sinBorde = nuevaImagen(20, 20);
		for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) sinBorde.datos.set([200, 30, 30, 255], (y * 20 + x) * 4);
		const v = verificarSticker(sinBorde);
		expect(v.esquinasTransparentes).toBe(true);
		expect(v.orilla.blancos).toBe(0);
		expect(v.ok).toBe(false);
	});
});

// ───────────────────────────── Croma (ia-post.ts) ─────────────────────────────

describe('croma con despill (ia-post.ts)', () => {
	const W = 300;
	const H = 260;
	const conSombra = (base: Rgb3) => (_x: number, y: number): Rgb3 => {
		const f = 1 - 0.25 * Math.max(0, (y - 150) / 110);
		return [base[0] * f, base[1] * f, base[2] * f];
	};

	it('croma sintético verde → alfa correcto con IoU ≥ 0.95 contra la máscara conocida', () => {
		for (const verde of [[0, 177, 64], [0, 255, 0]] as Rgb3[]) {
			const {img, mascara} = dibujar(W, H, conSombra(verde), personaje(150, 135, 0.5));
			const r = quitarCroma(img, 'verde');
			const valor = iou(mascaraAlfa(r.imagen, 128), mascara);
			expect(valor).toBeGreaterThanOrEqual(0.95);
			// Despill: ningún píxel visible queda verdoso.
			let verdosos = 0;
			for (let i = 0; i < W * H; i++) {
				const o = i * 4;
				if (r.imagen.datos[o + 3] > 128 && r.imagen.datos[o + 1] > Math.max(r.imagen.datos[o], r.imagen.datos[o + 2]) + 10) verdosos++;
			}
			expect(verdosos).toBe(0);
		}
	});

	it('también con croma azul, y "auto" reconoce la llave', () => {
		const {img, mascara} = dibujar(W, H, conSombra([20, 60, 230]), personaje(150, 135, 0.5));
		expect(iou(mascaraAlfa(quitarCroma(img, 'azul').imagen, 128), mascara)).toBeGreaterThanOrEqual(0.95);
		expect(quitarCroma(img, 'auto').croma).toBe('azul');
		expect(detectarCroma([0, 177, 64])).toBe('verde');
		expect(detectarCroma([240, 240, 240])).toBeNull();
	});

	it('un fondo que no es croma sale con código 2 (para eso está procesar.ts)', () => {
		const {img} = dibujar(W, H, () => [245, 245, 245], personaje(150, 135, 0.5));
		esFallo(() => quitarCroma(img, 'verde'), 2);
		esFallo(() => quitarCroma(img, 'auto'), 2);
	});

	it('del croma al sticker final: alfa, borde blanco y esquinas transparentes', () => {
		const {img} = dibujar(W, H, conSombra([0, 177, 64]), personaje(150, 135, 0.5));
		const r = quitarCroma(img, 'verde');
		const s = armarSticker(r.imagen, {fondo: r.llave});
		expect(verificarSticker(s.imagen).ok).toBe(true);
	});
});

// ───────────────────────────── Plan B sin Vision (procesar.ts) ─────────────────────────────

describe('fondo por color, islas y halo (procesar.ts)', () => {
	const ruidoso = (semilla: number) => {
		const r = azar(semilla);
		const g = () => Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
		return (): Rgb3 => [242 + g() * 5, 239 + g() * 5, 230 + g() * 5];
	};

	it('fondo claro con ruido → máscara con IoU ≥ 0.95 y los ojos blancos encerrados se quedan', () => {
		const {img, mascara} = dibujar(320, 280, ruidoso(3), personaje(160, 150, 0.6));
		const seg = segmentarPorFondo(img);
		expect(seg.uniforme).toBe(true);
		expect(iou(mascaraAlfa(seg.imagen, 128), mascara)).toBeGreaterThanOrEqual(0.95);
		const ojo = (Math.round(150 - 40 * 0.6) * 320 + Math.round(160 - 60 * 0.6)) * 4;
		expect(seg.imagen.datos[ojo + 3]).toBe(255);
		const fondo = colorDeFondo(img);
		expect(Math.abs(fondo.color[0] - 242)).toBeLessThanOrEqual(2);
	});

	it('quitarIslas borra el ruido suelto y conserva el dibujo y su brillo', () => {
		const img = nuevaImagen(200, 200);
		const pintar = (x0: number, y0: number, w: number, h: number) => {
			for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.datos.set([200, 80, 60, 255], (y * 200 + x) * 4);
		};
		pintar(40, 40, 100, 100);
		pintar(170, 20, 12, 12); // brillo: 144 px, se queda
		pintar(5, 190, 2, 2); // ruido: 4 px, se va
		pintar(190, 190, 3, 1); // ruido: 3 px, se va
		const {imagen, quitadas} = quitarIslas(img);
		expect(quitadas).toBe(2);
		expect(imagen.datos[(25 * 200 + 175) * 4 + 3]).toBe(255);
		expect(imagen.datos[(190 * 200 + 5) * 4 + 3]).toBe(0);
	});

	it('quitarHalo erosiona la orilla y lleva hacia blanco lo que se parece al fondo viejo', () => {
		const crema: Rgb3 = [240, 232, 210];
		const img = nuevaImagen(60, 60);
		for (let y = 10; y < 50; y++) {
			for (let x = 10; x < 50; x++) {
				const orilla = x === 10 || y === 10 || x === 49 || y === 49;
				img.datos.set(orilla ? [crema[0], crema[1], crema[2], 255] : [30, 90, 200, 255], (y * 60 + x) * 4);
			}
		}
		const sin = quitarHalo(img, {radio: 1, fondo: crema});
		expect(cajaTinta(sin, 1)).toEqual({x: 11, y: 11, w: 38, h: 38});
		// La orilla crema que sobrevive a la erosión (las esquinas no, la fila 11 sí era azul) no debe quedar crema.
		const sinFondo = quitarHalo(img, {radio: 0, fondo: crema});
		const o = (10 * 60 + 30) * 4;
		expect(Math.min(sinFondo.datos[o], sinFondo.datos[o + 1], sinFondo.datos[o + 2])).toBeGreaterThanOrEqual(250);
		// El azul de adentro no se toca.
		const adentro = (30 * 60 + 30) * 4;
		expect([...sinFondo.datos.subarray(adentro, adentro + 3)]).toEqual([30, 90, 200]);
	});

	it('detecta las piezas sueltas que Vision dejó fuera (texto o brillos) y no cuenta el sujeto ni el polvo', () => {
		const color = nuevaImagen(200, 200);
		const vision = nuevaImagen(200, 200);
		const pintar = (img: ImagenRGBA, x0: number, y0: number, w: number, h: number) => {
			for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.datos[(y * 200 + x) * 4 + 3] = 255;
		};
		pintar(color, 40, 40, 100, 100); // sujeto
		pintar(vision, 42, 42, 96, 96); // Vision lo toma (un poco más chico)
		pintar(color, 160, 10, 20, 20); // brillo: 400 px ≥ 150, fuera de Vision
		pintar(color, 10, 170, 60, 12); // "texto": 720 px, fuera de Vision
		pintar(color, 190, 190, 5, 5); // polvo: 25 px, no cuenta
		const r = piezasQueVisionDejo(vision, color);
		expect(r.piezas).toBe(2);
		expect(r.fraccion).toBeCloseTo((400 + 720) / 40000, 6);
		pintar(vision, 0, 0, 200, 200);
		expect(piezasQueVisionDejo(vision, color).piezas).toBe(0);
	});

	it('un sticker que ya viene hecho (alfa propio y orilla blanca) se conserva: sin segundo borde ni segunda sombra', () => {
		const {img, mascara} = dibujar(200, 180, () => [0, 0, 0], personaje(100, 95, 0.4));
		for (let i = 0; i < mascara.length; i++) img.datos[i * 4 + 3] = mascara[i] ? 255 : 0;
		const hecho = ponerBorde(img, {grosor: 6}).imagen;
		const r = armarSticker(hecho, {fondo: null, alfaPropio: true});
		expect(r.conservado).toBe(true);
		expect(r.grosor).toBe(0);
		expect(verificarSticker(r.imagen).ok).toBe(true);
		// Mismo contenido que la entrada recortada a su tinta (solo cambia el margen transparente).
		const t = cajaTinta(hecho, 1)!;
		const tr = cajaTinta(r.imagen, 1)!;
		expect([tr.w, tr.h]).toEqual([t.w, t.h]);
		const o1 = ((t.y + 20) * hecho.ancho + t.x + 30) * 4;
		const o2 = ((tr.y + 20) * r.imagen.ancho + tr.x + 30) * 4;
		expect([...r.imagen.datos.subarray(o2, o2 + 4)]).toEqual([...hecho.datos.subarray(o1, o1 + 4)]);
		// Sin alfa propio (vino de Vision o del color) sí lleva su borde.
		expect(armarSticker(hecho, {fondo: null}).conservado).toBe(false);
	});

	it('del fondo ruidoso al sticker final, y una imagen que ya trae alfa se reconoce', () => {
		const {img} = dibujar(320, 280, ruidoso(9), personaje(160, 150, 0.6));
		expect(traeAlfaPropio(img)).toBe(false);
		const seg = segmentarPorFondo(img);
		const s = armarSticker(seg.imagen, {fondo: seg.fondo.color});
		expect(verificarSticker(s.imagen).ok).toBe(true);
		expect(traeAlfaPropio(s.imagen)).toBe(true);
	});
});

// ───────────────────────────── Catálogo y destino ─────────────────────────────

describe('catálogo y nombres', () => {
	it('etiquetas del nombre del archivo sin fechas ni relleno', () => {
		expect(etiquetasDeNombre('ChatGPT Image Sep 26, 2026, 03_10_53 PM.png')).toEqual([]);
		expect(etiquetasDeNombre('mascota-con-laptop_v2.png')).toEqual(['mascota', 'laptop']);
		expect(etiquetasDeNombre('Cohete Rápido.JPG')).toEqual(['cohete', 'rapido']);
	});

	it('ids únicos: misma imagen = mismo id; otra imagen con el mismo nombre = id con sufijo', () => {
		const ocupados = new Map([['chatgpt-cohete', 'aaa']]);
		expect(idParaArchivo('chatgpt', 'cohete.png', ocupados, 'aaa')).toBe('chatgpt-cohete');
		expect(idParaArchivo('chatgpt', 'cohete.png', ocupados, 'bbb')).toBe('chatgpt-cohete-2');
		expect(idParaArchivo('ia', 'hf_2026.png', new Map(), 'x')).toBe('ia-hf-2026');
	});

	it('guarda el catálogo ordenado por id y reemplaza filas por id', () => {
		const dir = mkdtempSync(join(tmpdir(), 'catalogo-'));
		try {
			const ruta = join(dir, 'catalogo.json');
			expect(leerCatalogo(ruta)).toEqual([]);
			const fila = (id: string, sha: string): FilaCatalogo => ({id, fuente: 'chatgpt', archivo: `x/${id}.png`, ancho: 1, alto: 1, caja_tinta: {x: 0, y: 0, w: 1, h: 1}, etiquetas: [], licencia: 'propia', sha256: sha});
			let filas = ponerFila([], fila('b', '1'));
			filas = ponerFila(filas, fila('a', '2'));
			filas = ponerFila(filas, fila('b', '3'));
			guardarCatalogo(ruta, filas);
			const leidas = leerCatalogo(ruta);
			expect(leidas.map((f) => [f.id, f.sha256])).toEqual([
				['a', '2'],
				['b', '3'],
			]);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('el destino no puede caer en entrada/ (solo lectura) ni fuera del proyecto', () => {
		esFallo(() => revisarDestino('entrada/stickers-chatgpt'), 2);
		esFallo(() => revisarDestino('../fuera'), 2);
		expect(revisarDestino('out/f3-logos/procesar')).toBe(join(RAIZ, 'out', 'f3-logos', 'procesar'));
	});
});

// ───────────────────────────── Logos (logo.ts) ─────────────────────────────

describe('logos: tile y solo (logo.ts)', () => {
	// Un logo propio: aro azul con un punto, con aire alrededor dentro de su viewBox.
	const svg =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">' +
		'<path fill="#1E66F5" fill-rule="evenodd" d="M50 10a20 20 0 1 1 0 40a20 20 0 1 1 0-40zm0 8a12 12 0 1 0 0 24a12 12 0 1 0 0-24z"/>' +
		'<circle cx="80" cy="30" r="5" fill="#E64553"/></svg>';
	const fuente = () => abrirFuente(join(RAIZ, 'biblioteca/fuentes/tiktok-sans/TikTokSans-SemiBold.ttf'));

	it('recorta el viewBox a la tinta y no deforma (misma proporción)', () => {
		const vb = viewBoxATinta(svg);
		expect(vb[0]).toBeGreaterThan(28);
		expect(vb[0]).toBeLessThan(31);
		expect(vb[2]).toBeGreaterThan(54);
		expect(vb[2]).toBeLessThan(58);
		expect(viewBoxDe(conViewBox(svg, vb, 200, 100))).toEqual(vb.map((v) => +v.toFixed(4)));
		expect(conViewBox(svg, vb, 200, 100)).toContain('preserveAspectRatio="xMidYMid meet"');
	});

	it.runIf(HAY_FUENTES)('el nombre de Claude mide el alto medido en tus reels (12.2 % del tile)', () => {
		const f = fuente();
		const t = textoATrazo(f, 'Claude', tamanoNombre(f));
		expect(t.tinta.y1 - t.tinta.y0).toBeCloseTo(TILE.nombreAltoClaude * LADO_TILE, 0);
		expect(t.d.startsWith('M')).toBe(true);
	});

	it.runIf(HAY_FUENTES)('tile: cuadro blanco con sombra, logo a color arriba y nombre oscuro abajo; pasa la verificación', () => {
		const r = armarTile(svg, 'Prueba', fuente());
		expect(verificarSticker(r.imagen).ok).toBe(true);
		expect([r.cuerpo.w, r.cuerpo.h]).toEqual([LADO_TILE, LADO_TILE]);
		const {imagen, cuerpo} = r;
		const px = (fx: number, fy: number) => {
			const o = (Math.round(cuerpo.y + fy * LADO_TILE) * imagen.ancho + Math.round(cuerpo.x + fx * LADO_TILE)) * 4;
			return [...imagen.datos.subarray(o, o + 4)];
		};
		// El aro azul pasa por la orilla izquierda de su caja (centrada en x, a 42 % del alto).
		let azules = 0;
		let oscuros = 0;
		for (let fx = 0.2; fx <= 0.8; fx += 0.005) {
			const [r1, , b1] = px(fx, TILE.logoCentroY);
			if (b1 > 200 && r1 < 80) azules++;
			const [r2, g2, b2] = px(fx, TILE.nombreBase - 0.03);
			if (r2 + g2 + b2 < 200) oscuros++;
		}
		expect(azules).toBeGreaterThan(10);
		expect(oscuros).toBeGreaterThan(5);
		expect(px(0.02, 0.5)).toEqual([255, 255, 255, 255]);
	});

	it('solo: el logo con borde blanco tipo sticker', () => {
		const r = armarSolo(svg, 200);
		expect(verificarSticker(r.imagen).ok).toBe(true);
		expect(r.grosor).toBeGreaterThanOrEqual(4);
	});
});

// ───────────────────────────── La biblioteca ─────────────────────────────

describe('biblioteca/stickers: transparencia, borde y catálogo', () => {
	const carpetas = ['logos', 'chatgpt', 'ia'].map((c) => join(RAIZ, 'biblioteca', 'stickers', c));

	// Solo si ya hay stickers procesados (la plantilla no trae ninguno).
	const hayPngs = carpetas.some((d) => existsSync(d) && readdirSync(d).some((n) => n.endsWith('.png')));
	it.runIf(hayPngs)('cada PNG tiene sus 4 esquinas con α = 0 y la orilla opaca blanca', () => {
		let revisados = 0;
		for (const dir of carpetas) {
			if (!existsSync(dir)) continue;
			for (const nombre of readdirSync(dir).filter((n) => n.endsWith('.png'))) {
				const v = verificarSticker(leerPng(readFileSync(join(dir, nombre))));
				expect({nombre, ok: v.ok, esquinas: v.alfaEsquinas, orilla: `${v.orilla.blancos}/${v.orilla.total}`}).toEqual({
					nombre,
					ok: true,
					esquinas: [0, 0, 0, 0],
					orilla: `${v.orilla.total}/${v.orilla.total}`,
				});
				revisados++;
			}
		}
		expect(revisados).toBeGreaterThan(0);
	});

	it('cada fila del catálogo apunta a un PNG que existe, con el mismo sha256 y su caja dentro', () => {
		for (const dir of carpetas) {
			const ruta = join(dir, 'catalogo.json');
			if (!existsSync(ruta)) continue;
			const filas = leerCatalogo(ruta);
			const ids = new Set<string>();
			for (const f of filas) {
				expect(ids.has(f.id)).toBe(false);
				ids.add(f.id);
				const archivo = join(RAIZ, f.archivo);
				expect(existsSync(archivo)).toBe(true);
				const buf = readFileSync(archivo);
				expect(sha256(buf)).toBe(f.sha256);
				const c = f.caja_tinta;
				expect(c.x).toBeGreaterThanOrEqual(0);
				expect(c.y).toBeGreaterThanOrEqual(0);
				expect(c.x + c.w).toBeLessThanOrEqual(f.ancho);
				expect(c.y + c.h).toBeLessThanOrEqual(f.alto);
				if (f.fuente === 'logo') {
					expect(f.uso).toBe('editorial');
					expect(['tile', 'solo']).toContain(f.variante);
					if (f.fuente_repo === 'avatar') {
						// Persona (avatar.ts): cualquier URL de origen anotada y la imagen original guardada con su sha256.
						expect(String(f.fuente_url)).toMatch(/^https:\/\//);
						expect(sha256(readFileSync(join(RAIZ, String(f.original))))).toBe(f.original_sha256);
					} else expect(String(f.fuente_url)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/(simple-icons\/simple-icons|pheralb\/svgl)\/[0-9a-f]{40}\//);
				}
			}
		}
	});
});
