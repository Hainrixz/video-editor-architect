/**
 * Pruebas de herramientas/lib/capas.ts (Fase 2: titular y tarjetas), todas puras: imágenes sintéticas en memoria,
 * sin Vision, sin ffmpeg y sin red (corren dentro del sandbox).
 * Lo que necesita Vision o whisper (medir-capas.ts sobre un video) se prueba en pruebas/integracion/f2-capas.ts.
 */
import {describe, expect, it} from 'vitest';
import {
	agruparListas,
	ajustarRadio,
	bandasRectas,
	formaDeBandas,
	renglones,
	compararTipografia,
	contarPalabras,
	cruceDesdeAdentro,
	cruceHaciaBlanco,
	cruceOrilla,
	DetectorTarjetas,
	emparejarHabla,
	indiceTabla,
	insercionEsquina,
	limpiarTextoOcr,
	lineasFijas,
	mayusculaInicial,
	medirCajaBlanca,
	medirGlifos,
	medirHalo,
	mascaraRelleno,
	numeroDePalabras,
	OPCIONES_TARJETAS,
	primeraEsMayusculaMedible,
	RastreadorTarjetas,
	resumirTarjetas,
	tablaClases,
	textoQuitado,
	tipoDeTarjeta,
	tokenizar,
	tokenizarHabla,
	unirAnimaciones,
	unirEscritura,
	CLASE,
	type Candidato,
	type PalabraHabla,
	type Pista,
	type TarjetaResumible,
} from '../../herramientas/lib/capas.ts';
import type {CajaOcr} from '../../herramientas/lib/ocr.ts';

// ───────────────────────────── Ayudas: imágenes sintéticas ─────────────────────────────

type Img = {px: Uint8Array; w: number; h: number; c: 3 | 4};

function lienzo(w: number, h: number, color: [number, number, number], c: 3 | 4 = 3): Img {
	const px = new Uint8Array(w * h * c);
	for (let p = 0; p < w * h; p++) {
		px[p * c] = color[0];
		px[p * c + 1] = color[1];
		px[p * c + 2] = color[2];
		if (c === 4) px[p * c + 3] = 255;
	}
	return {px, w, h, c};
}

/** Pinta un rectángulo de esquinas redondeadas con antialias (cobertura por supermuestreo 4×4). Coordenadas de orilla. */
function rectRedondeado(img: Img, x0: number, y0: number, x1: number, y1: number, r: number, color: [number, number, number]): void {
	const cx = (x0 + x1) / 2;
	const cy = (y0 + y1) / 2;
	const hw = (x1 - x0) / 2;
	const hh = (y1 - y0) / 2;
	const dentro = (x: number, y: number) => {
		const qx = Math.abs(x - cx) - (hw - r);
		const qy = Math.abs(y - cy) - (hh - r);
		return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
	};
	for (let y = Math.max(0, Math.floor(y0) - 1); y < Math.min(img.h, Math.ceil(y1) + 1); y++) {
		for (let x = Math.max(0, Math.floor(x0) - 1); x < Math.min(img.w, Math.ceil(x1) + 1); x++) {
			let cubre = 0;
			for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (dentro(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) cubre++;
			if (!cubre) continue;
			const a = cubre / 16;
			const o = (y * img.w + x) * img.c;
			for (let k = 0; k < 3; k++) img.px[o + k] = Math.round(img.px[o + k] * (1 - a) + color[k] * a);
		}
	}
}

function rect(img: Img, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
	rectRedondeado(img, x0, y0, x1, y1, 0, color);
}

const BLANCO: [number, number, number] = [255, 255, 255];
const NEGRO: [number, number, number] = [10, 10, 10];
const FONDO: [number, number, number] = [96, 80, 72];

/** "Texto" de barras negras dentro de una caja (como letras). */
function barras(img: Img, x0: number, y0: number, x1: number, y1: number, ancho: number, hueco: number): void {
	for (let x = x0; x + ancho <= x1; x += ancho + hueco) rect(img, x, y0, x + ancho, y1, NEGRO);
}

const escala = 360 / 1080;

function detector(img: Img) {
	return new DetectorTarjetas(img.w, img.h, tablaClases(), {...OPCIONES_TARJETAS, escala});
}

/** Candidato armado a mano (para el rastreador). */
function cand(x0: number, y0: number, x1: number, y1: number, tinta: Array<[number, number]> = []): Candidato {
	const w = x1 - x0;
	const mascara = new Uint8Array(w * (y1 - y0));
	for (const [x, y] of tinta) mascara[(y - y0) * w + (x - x0)] = 1;
	return {x0, y0, x1, y1, area: w * (y1 - y0), relleno: 1, cobertura: 1, huecos: 0.2, oscuro: 0.5, croma: 0, puro: 1, mascara, bandas: [{x0, y0, x1, y1}]};
}

/** Tinta de una "palabra": puntos en una rejilla dentro de [xa, xb). */
function tintaEntre(xa: number, xb: number, y0: number, y1: number): Array<[number, number]> {
	const r: Array<[number, number]> = [];
	for (let x = xa; x < xb; x += 2) for (let y = y0; y < y1; y++) r.push([x, y]);
	return r;
}

// ───────────────────────────── 1. Clases de color ─────────────────────────────

describe('tablaClases', () => {
	const t = tablaClases();
	const clase = (r: number, g: number, b: number) => t[indiceTabla(r, g, b)];
	it('blanco puro y casi blanco cuentan como blanco; un gris medio no', () => {
		expect(clase(255, 255, 255) & CLASE.blanco).toBeTruthy();
		expect(clase(232, 232, 232) & CLASE.blanco).toBeTruthy(); // L* ≈ 92
		expect(clase(200, 200, 200) & CLASE.blanco).toBeFalsy(); // L* ≈ 81
	});
	it('un crema con croma no es blanco y el negro es oscuro', () => {
		expect(clase(255, 214, 160) & CLASE.blanco).toBeFalsy();
		expect(clase(255, 214, 160) & CLASE.croma).toBeTruthy();
		expect(clase(10, 10, 10) & CLASE.oscuro).toBeTruthy();
		expect(clase(217, 119, 87) & CLASE.croma).toBeTruthy(); // naranja de Claude
	});
});

// ───────────────────────────── 2. Detector ─────────────────────────────

describe('DetectorTarjetas', () => {
	it('encuentra una tarjeta blanca con texto negro y descarta logo cuadrado, inserto al borde, mancha y caja vacía', () => {
		const img = lienzo(360, 640, FONDO);
		// Tarjeta: 160×34 px (≈ 480×102 base) con radio 4 y "texto".
		rectRedondeado(img, 100, 380, 260, 414, 4, BLANCO);
		barras(img, 112, 388, 248, 406, 3, 3);
		// Logo en "app tile": cuadro blanco con un círculo naranja.
		rectRedondeado(img, 40, 100, 100, 160, 8, BLANCO);
		rectRedondeado(img, 55, 115, 85, 145, 15, [217, 119, 87]);
		// Inserto pegado al borde izquierdo con texto.
		rect(img, 0, 200, 120, 260, BLANCO);
		barras(img, 10, 220, 100, 240, 3, 3);
		// Caja blanca sin texto.
		rectRedondeado(img, 200, 520, 330, 560, 4, BLANCO);
		// Mancha blanca no rectangular (círculo) con algo oscuro adentro.
		rectRedondeado(img, 220, 60, 300, 140, 40, BLANCO);
		rect(img, 250, 95, 270, 105, NEGRO);

		const {candidatos, descartados} = detector(img).detectar(img.px, 3, true);
		expect(candidatos).toHaveLength(1);
		const c = candidatos[0];
		expect([c.x0, c.y0, c.x1, c.y1]).toEqual([100, 380, 260, 414]);
		expect(c.relleno).toBeGreaterThan(0.97);
		expect(c.oscuro).toBeGreaterThan(0.9);
		const motivos = descartados.map((d) => d.motivo).join(' | ');
		expect(motivos).toMatch(/casi cuadrada/);
		expect(motivos).toMatch(/toca el borde/);
		expect(motivos).toMatch(/sin texto/);
	});

	it('descarta una caja de blanco no puro (pared o ropa clara) y una con mucho color adentro', () => {
		const img = lienzo(360, 640, FONDO);
		rectRedondeado(img, 60, 300, 200, 340, 3, [236, 236, 236]); // L* ≈ 93 pero no #FFFFFF
		barras(img, 70, 310, 190, 330, 3, 3);
		rectRedondeado(img, 60, 400, 300, 470, 3, BLANCO);
		rect(img, 70, 410, 290, 460, [40, 160, 70]); // imagen verde dentro
		rect(img, 80, 430, 120, 440, NEGRO);
		const {candidatos, descartados} = detector(img).detectar(img.px, 3, true);
		expect(candidatos).toHaveLength(0);
		const motivos = descartados.map((d) => d.motivo).join(' | ');
		expect(motivos).toMatch(/no es puro/);
		expect(motivos).toMatch(/no es texto oscuro|color|casi vacía/);
	});

	it('acepta una tarjeta de 2 renglones (una caja por renglón, el de abajo más angosto) y da sus 2 bandas', () => {
		const img = lienzo(360, 640, FONDO);
		rectRedondeado(img, 90, 380, 270, 404, 5, BLANCO); // "Como si fuera"
		rectRedondeado(img, 110, 400, 250, 424, 5, BLANCO); // "el de $100" (se encima 4 filas con el de arriba)
		barras(img, 100, 386, 260, 399, 3, 3);
		barras(img, 120, 407, 240, 419, 3, 3);
		const {candidatos, descartados} = detector(img).detectar(img.px, 3, true);
		expect(descartados.filter((d) => !d.motivo.startsWith('tamaño')).map((d) => d.motivo)).toEqual([]);
		expect(candidatos).toHaveLength(1);
		expect(candidatos[0].bandas).toHaveLength(2);
		expect(candidatos[0].bandas[0]).toMatchObject({x0: 90, x1: 270});
		expect(candidatos[0].bandas[1]).toMatchObject({x0: 110, x1: 250});
	});

	it('una tarjeta pegada a algo claro (crema) se rescata partiendo con blanco puro', () => {
		const img = lienzo(360, 640, [217, 119, 87]);
		rect(img, 240, 300, 330, 430, [244, 238, 228]); // dibujo color crema (L* ≈ 94, no es #FFFFFF)
		rectRedondeado(img, 80, 380, 262, 412, 4, BLANCO); // la tarjeta lo toca por la derecha
		barras(img, 92, 388, 250, 404, 3, 3);
		const {candidatos} = detector(img).detectar(img.px, 3, true);
		expect(candidatos.map((c) => [c.x0, c.y0, c.x1, c.y1])).toEqual([[80, 380, 262, 412]]);
		const sin = new DetectorTarjetas(img.w, img.h, tablaClases(), {...OPCIONES_TARJETAS, escala, reintentoPuro: false});
		expect(sin.detectar(img.px, 3).candidatos).toHaveLength(0);
	});

	it('acepta RGBA igual que RGB', () => {
		const img = lienzo(360, 640, FONDO, 4);
		rectRedondeado(img, 100, 380, 260, 414, 4, BLANCO);
		barras(img, 112, 388, 248, 406, 3, 3);
		expect(detector(img).detectar(img.px, 4).candidatos).toHaveLength(1);
	});
});

describe('bandasRectas y formaDeBandas', () => {
	it('una caja redondeada da 1 banda; dos renglones centrados dan 2; un círculo no da bandas largas', () => {
		const caja = {izq: [3, 1, 0, 0, 0, 0, 0, 0, 1, 3], der: [97, 99, 100, 100, 100, 100, 100, 100, 99, 97]};
		expect(bandasRectas(caja.izq, caja.der)).toEqual([{k0: 1, k1: 9, x0: 0, x1: 101, x0max: 1, x1min: 100}]);
		const dos = {izq: [2, 0, 0, 0, 0, 5, 10, 10, 10, 10, 12], der: [98, 100, 100, 100, 100, 95, 90, 90, 90, 90, 88]};
		expect(bandasRectas(dos.izq, dos.der).map((b) => [b.k0, b.k1, b.x0, b.x1])).toEqual([
			[1, 5, 0, 101],
			[6, 10, 10, 91],
		]);
		const circulo = Array.from({length: 40}, (_, k) => Math.round(20 - Math.sqrt(400 - (k - 19.5) ** 2)));
		const cob = renglones(bandasRectas(circulo, circulo.map((x) => 40 - x))).reduce((s, b) => s + b.k1 - b.k0, 0) / 40;
		expect(cob).toBeLessThan(0.55);
		// Una elipse ancha (2:1) tampoco.
		const elipse = Array.from({length: 40}, (_, k) => Math.round(40 - 2 * Math.sqrt(400 - (k - 19.5) ** 2)));
		const cobE = renglones(bandasRectas(elipse, elipse.map((x) => 80 - x))).reduce((s, b) => s + b.k1 - b.k0, 0) / 40;
		expect(cobE).toBeLessThan(0.55);
	});
	it('renglones desalineados o muy separados no son una tarjeta', () => {
		expect(formaDeBandas([{x0: 0, x1: 100, y0: 0, y1: 10}, {x0: 10, x1: 90, y0: 12, y1: 22}])).toBeNull();
		expect(formaDeBandas([{x0: 0, x1: 100, y0: 0, y1: 10}, {x0: 0, x1: 60, y0: 12, y1: 22}])).toBeNull(); // alineada a la izquierda
		expect(formaDeBandas([{x0: 0, x1: 100, y0: 0, y1: 10}, {x0: 50, x1: 90, y0: 12, y1: 22}])).toMatch(/desalineados/);
		expect(formaDeBandas([{x0: 0, x1: 100, y0: 0, y1: 10}, {x0: 10, x1: 90, y0: 30, y1: 40}])).toMatch(/unión/);
	});
});

// ───────────────────────────── 3. Rastreador ─────────────────────────────

describe('RastreadorTarjetas', () => {
	it('una tarjeta quieta con un cuadro perdido es una sola pista', () => {
		const r = new RastreadorTarjetas();
		for (let n = 0; n < 12; n++) if (n !== 5) r.agregar(n, [cand(100, 380, 260, 414, tintaEntre(110, 250, 390, 404))]);
		r.agregar(12, []);
		r.agregar(13, []);
		r.agregar(14, []);
		const pistas = r.terminar();
		expect(pistas).toHaveLength(1);
		expect(pistas[0].detecciones[0].n).toBe(0);
		expect(pistas[0].detecciones.at(-1)!.n).toBe(11);
	});

	it('otra tarjeta en el mismo lugar (el texto de antes desaparece) abre otra pista', () => {
		const r = new RastreadorTarjetas();
		for (let n = 0; n < 10; n++) r.agregar(n, [cand(100, 380, 260, 414, tintaEntre(110, 180, 390, 404))]);
		for (let n = 10; n < 20; n++) r.agregar(n, [cand(100, 380, 260, 414, tintaEntre(191, 250, 390, 404))]);
		const pistas = r.terminar();
		expect(pistas.map((p) => [p.detecciones[0].n, p.detecciones.at(-1)!.n])).toEqual([
			[0, 9],
			[10, 19],
		]);
	});

	it('una tarjeta que se escribe (el texto solo crece) sigue en la misma pista', () => {
		const r = new RastreadorTarjetas();
		for (let n = 0; n < 15; n++) r.agregar(n, [cand(100, 380, 260, 414, tintaEntre(110, 120 + n * 8, 390, 404))]);
		expect(r.terminar()).toHaveLength(1);
	});

	it('textoQuitado: 0 si solo se agrega texto, ~1 si cambia', () => {
		const a = cand(10, 10, 100, 30, tintaEntre(12, 40, 15, 25));
		const b = cand(10, 10, 100, 30, tintaEntre(12, 70, 15, 25));
		const c = cand(10, 10, 100, 30, tintaEntre(60, 98, 15, 25));
		expect(textoQuitado(a, b)).toBe(0);
		expect(textoQuitado(a, c)).toBeGreaterThan(0.9);
	});

	it('unirAnimaciones pega los cuadros de un pop de escala a la tarjeta', () => {
		const pista = (id: number, n0: number, n1: number, caja: [number, number, number, number]): Pista => ({
			id,
			detecciones: Array.from({length: n1 - n0}, (_, k) => ({n: n0 + k, x0: caja[0], y0: caja[1], x1: caja[2], y1: caja[3]})),
		});
		const unidas = unirAnimaciones([
			pista(1, 10, 11, [140, 388, 220, 406]),
			pista(2, 11, 12, [120, 384, 240, 410]),
			pista(3, 12, 40, [100, 380, 260, 414]),
			pista(4, 80, 82, [10, 10, 60, 30]),
		]);
		expect(unidas).toHaveLength(2);
		expect(unidas[0].detecciones[0].n).toBe(10);
		expect(unidas[0].animEntrada).toBe(2);
		expect(unidas[1].animEntrada).toBe(0);
	});

	it('unirEscritura junta los pedazos de una tarjeta que crece línea por línea', () => {
		const grupos = unirEscritura([
			{nDesde: 0, nHasta: 10, caja: {x0: 100, y0: 300, x1: 900, y1: 360}, texto: 'En base a'},
			{nDesde: 10, nHasta: 25, caja: {x0: 100, y0: 300, x1: 900, y1: 420}, texto: 'En base a todo lo que sabes'},
			{nDesde: 25, nHasta: 40, caja: {x0: 100, y0: 300, x1: 900, y1: 480}, texto: 'En base a todo lo que sabes de mi tienda'},
			{nDesde: 41, nHasta: 60, caja: {x0: 300, y0: 300, x1: 700, y1: 360}, texto: 'Otra cosa'},
		]);
		expect(grupos).toEqual([[0, 1, 2], [3]]);
	});
});

// ───────────────────────────── 4. Medición fina ─────────────────────────────

describe('medirCajaBlanca', () => {
	it('orillas con subpíxel (±0.5 px) y radio de esquina (±1.5 px)', () => {
		const img = lienzo(560, 220, FONDO, 4);
		rectRedondeado(img, 60.3, 40.6, 480.7, 160.2, 18, BLANCO);
		barras(img, 90, 80, 450, 125, 8, 6);
		const m = medirCajaBlanca(img.px, img.w, img.h, {x0: 57, y0: 43, x1: 484, y1: 158}, {margen: 8})!;
		expect(m).not.toBeNull();
		expect(m.caja.x0).toBeCloseTo(60.3, 0);
		expect(Math.abs(m.caja.x0 - 60.3)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.caja.x1 - 480.7)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.caja.y0 - 40.6)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.caja.y1 - 160.2)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.radio! - 18)).toBeLessThanOrEqual(1.5);
		expect(m.colorCaja).toEqual([255, 255, 255]);
		expect(m.colorTexto).toEqual([10, 10, 10]);
		// Contenido = las barras de texto.
		expect(m.contenido).toEqual({x0: 90, y0: 80, x1: 448, y1: 125}); // última barra: [440, 448)
	});

	it('tarjeta de 2 renglones: caja que envuelve, una banda por renglón y padding de abajo sin las orillas del renglón angosto', () => {
		const img = lienzo(600, 260, FONDO, 4);
		rectRedondeado(img, 60, 40, 540, 120, 16, BLANCO);
		rectRedondeado(img, 120, 104, 480, 184, 16, BLANCO);
		barras(img, 90, 60, 510, 100, 8, 6);
		barras(img, 150, 124, 450, 164, 8, 6);
		const m = medirCajaBlanca(img.px, img.w, img.h, {x0: 58, y0: 42, x1: 542, y1: 182}, {
			margen: 8,
			bandas: [
				{x0: 58, y0: 42, x1: 542, y1: 118},
				{x0: 118, y0: 106, x1: 482, y1: 182},
			],
		})!;
		expect(m).not.toBeNull();
		expect(m.caja.x0).toBeCloseTo(60, 0);
		expect(m.caja.x1).toBeCloseTo(540, 0);
		expect(m.caja.y0).toBeCloseTo(40, 0);
		expect(m.caja.y1).toBeCloseTo(184, 0);
		expect(m.bandas[1].x0).toBeCloseTo(120, 0);
		expect(m.bandas[1].x1).toBeCloseTo(480, 0);
		expect(Math.abs(m.radio! - 16)).toBeLessThanOrEqual(1.5);
		// Contenido: de la primera barra a la última del renglón de abajo (no llega a la orilla de abajo).
		expect(m.contenido).toMatchObject({y0: 60, y1: 164});
	});

	it('sobre un fondo claro (silla azul clarito) con algo oscuro más lejos: orillas exactas y contenido sin fondo', () => {
		const img = lienzo(400, 200, [60, 50, 50], 4); // brazo oscuro
		rect(img, 0, 30, 400, 200, [196, 214, 214]); // silla clara (luma ≈ 210)
		rectRedondeado(img, 50.4, 60.2, 350.6, 150.5, 14, BLANCO);
		barras(img, 80, 85, 320, 125, 8, 6);
		const m = medirCajaBlanca(img.px, img.w, img.h, {x0: 47, y0: 57, x1: 354, y1: 153}, {margen: 12})!;
		expect(Math.abs(m.caja.y0 - 60.2)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.caja.x0 - 50.4)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.caja.y1 - 150.5)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(m.radio! - 14)).toBeLessThanOrEqual(1.5);
		expect(m.contenido).toEqual({x0: 80, y0: 85, x1: 312, y1: 125}); // última barra: [304, 312)
		// Empieza sobre una letra (10): la cruza, sigue por el blanco y corta donde deja de ser blanco (230 → 210 del fondo).
		expect(cruceDesdeAdentro((k) => [20, 20, 210, 210, 230, 255, 255, 10, 255][k], 7, 0, 255)).toBeCloseTo(4.1, 5);
		// Desde afuera: se detiene en el primer blanco (no llega a la letra de más adentro).
		expect(cruceHaciaBlanco((k) => [20, 20, 210, 210, 230, 255, 255, 10, 255][k], 0, 8, 255)).toBeCloseTo(4.1, 5);
	});

	it('radio bien medido aunque el texto quede más cerca de la orilla que el radio buscado', () => {
		const img = lienzo(420, 140, [200, 214, 214], 4);
		rectRedondeado(img, 40.5, 30.5, 380.5, 110.5, 11, BLANCO);
		barras(img, 58, 44, 362, 104, 7, 5); // texto a 17 px de la orilla, más cerca que el radio máximo
		const m = medirCajaBlanca(img.px, img.w, img.h, {x0: 38, y0: 28, x1: 383, y1: 113}, {margen: 6, rMax: 40})!;
		expect(Math.abs(m.radio! - 11)).toBeLessThanOrEqual(1.5);
	});

	it('una caja de esquinas rectas da radio ≈ 0', () => {
		const img = lienzo(400, 160, FONDO, 4);
		rect(img, 40, 30, 360, 120, BLANCO);
		barras(img, 60, 60, 340, 90, 6, 5);
		const m = medirCajaBlanca(img.px, img.w, img.h, {x0: 42, y0: 28, x1: 358, y1: 122})!;
		expect(m.radio!).toBeLessThanOrEqual(1);
		expect(m.caja).toEqual({x0: 40, y0: 30, x1: 360, y1: 120});
	});

	it('cruceOrilla, insercionEsquina y ajustarRadio', () => {
		const valores = [20, 20, 20, 137.5, 255, 255, 255];
		expect(cruceOrilla((k) => valores[k], 0, 6)).toBeCloseTo(3, 5);
		expect(cruceOrilla(() => 100, 0, 6)).toBeNull();
		expect(insercionEsquina(10, 10)).toBe(0);
		expect(insercionEsquina(10, 0)).toBeCloseTo(10, 5);
		const muestras: Array<[number, number]> = [];
		for (let t = 0.5; t < 14; t += 1) muestras.push([t, insercionEsquina(9, t)]);
		expect(ajustarRadio(muestras, 20)).toBeCloseTo(9, 1);
	});
});

describe('medirGlifos', () => {
	// Máscara 200×80: una "T" de 40 px de alto (mayúscula) y minúsculas de 28 px, trazo de 6 px, base en la fila 59.
	const w = 200;
	const h = 80;
	const m = new Uint8Array(w * h);
	const pinta = (x0: number, y0: number, x1: number, y1: number) => {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
	};
	pinta(10, 20, 34, 26); // barra de la T
	pinta(19, 20, 25, 60); // tallo de la T
	for (let x = 40; x < 190; x += 14) pinta(x, 32, x + 6, 60); // minúsculas (tallos de 6 px)
	for (let x = 40; x < 190; x += 28) pinta(x, 32, x + 20, 37); // panzas para la banda densa

	it('alto de mayúscula, altura de x, base y trazo', () => {
		const g = medirGlifos(m, w, {x0: 5, y0: 10, x1: 195, y1: 70}, 'Tu cuenta')!;
		expect(g.base).toBe(59);
		expect(g.altoMayuscula).toBe(40);
		expect(g.xAltura).toBe(28);
		expect(g.tallo).toBe(6);
		expect(g.altoAltas).toBe(40);
	});

	it('"$20": el alto de las altas no lo pone el "$" (que baja de la base)', () => {
		const w2 = 200;
		const m2 = new Uint8Array(w2 * 90);
		const p2 = (x0: number, y0: number, x1: number, y1: number) => {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m2[y * w2 + x] = 1;
		};
		p2(10, 10, 24, 75); // "$": de arriba de la mayúscula a debajo de la base
		p2(30, 20, 50, 66); // "2" (alto 46, base en 65)
		p2(56, 19, 78, 67); // "0" (con sobrepaso de 1 px arriba y abajo)
		const g = medirGlifos(m2, w2, {x0: 0, y0: 0, x1: 200, y1: 90}, '$20')!;
		expect(g.altoMayuscula).toBeNull();
		expect(g.altoAltas).toBeGreaterThanOrEqual(46);
		expect(g.altoAltas).toBeLessThanOrEqual(48);
	});

	it('sin mayúscula medible no inventa el alto', () => {
		expect(medirGlifos(m, w, {x0: 5, y0: 10, x1: 195, y1: 70}, '¿Qué?')!.altoMayuscula).toBeNull();
		expect(primeraEsMayusculaMedible('Gratis')).toBe(true);
		expect(primeraEsMayusculaMedible('$20')).toBe(false);
		expect(primeraEsMayusculaMedible('15 empleados')).toBe(true);
		expect(primeraEsMayusculaMedible('Ángel')).toBe(false);
	});
});

// ───────────────────────────── 5. Titular ─────────────────────────────

describe('mascaraRelleno', () => {
	it('con contorno negro: solo lo encerrado, aunque el fondo claro se parezca al blanco', () => {
		const img = lienzo(120, 60, [236, 230, 222], 4); // fondo crema claro (ΔE ≈ 8 del blanco)
		rect(img, 20, 10, 60, 50, [0, 0, 0]);
		rect(img, 24, 14, 56, 46, BLANCO);
		const m = mascaraRelleno(img.px, img.w, img.h, {x0: 0, y0: 0, x1: 120, y1: 60}, [255, 255, 255], [0, 0, 0]);
		let dentro = 0;
		let fuera = 0;
		for (let y = 0; y < 60; y++) for (let x = 0; x < 120; x++) if (m[y * 120 + x]) (x >= 24 && x < 56 && y >= 14 && y < 46 ? dentro++ : fuera++);
		expect(dentro).toBe(32 * 32);
		expect(fuera).toBe(0);
	});
});

describe('lineasFijas', () => {
	const caja = (texto: string, x: number, y: number, w: number, h: number): CajaOcr => ({texto, confianza: 0.95, x, y, w, h});
	it('se queda con las líneas que están en ≥ 70 % de las lecturas, centradas, de arriba abajo', () => {
		const lecturas = Array.from({length: 10}, (_, n) => ({
			n: n * 30,
			cajas: [
				...(n === 3 ? [] : [caja('Tu Claude $20', 0.27, 0.147 + (n % 2) * 0.001, 0.46, 0.035)]),
				caja('ahora aguanta más', 0.2, 0.19, 0.6, 0.035),
				caja(['hola a todos', 'esto cambia', 'cada cuadro', 'otra frase'][n % 4] + ` ${n}`, 0.35, 0.3, 0.3, 0.02),
				caja(`Paso ${n} de 10`, 0.35, 0.36, 0.3, 0.02),
				...(n < 5 ? [caja('Gratis', 0.4, 0.6, 0.2, 0.03)] : []),
				caja('@creador-demo', 0.02, 0.05, 0.3, 0.02),
			],
		}));
		const lineas = lineasFijas(lecturas);
		expect(lineas.map((l) => l.texto)).toEqual(['Tu Claude $20', 'ahora aguanta más']);
		expect(lineas[0].presencia).toBeCloseTo(0.9, 5);
		expect(lineas[1].presencia).toBe(1);
	});
});

describe('medirHalo', () => {
	/** Letras blancas con contorno negro de 3 px sobre fondo gris; con sombra opcional desplazada hacia abajo. */
	function titulo(conSombra: boolean): Img {
		const img = lienzo(300, 120, [150, 140, 130], 4);
		const letras: Array<[number, number, number, number]> = [];
		for (let x = 30; x < 270; x += 30) letras.push([x, 40, x + 14, 80]);
		if (conSombra) {
			// Sombra negra al 60 %, desplazada 5 px abajo, borde suave de ~4 px (caja difuminada).
			for (let y = 0; y < img.h; y++) {
				for (let x = 0; x < img.w; x++) {
					let a = 0;
					for (const [x0, y0, x1, y1] of letras) {
						const dx = Math.max(x0 - 3 - (x + 0.5), 0, x + 0.5 - (x1 + 3));
						const dy = Math.max(y0 - 3 + 5 - (y + 0.5), 0, y + 0.5 - (y1 + 3 + 5));
						const d = Math.hypot(dx, dy);
						a = Math.max(a, d <= 0 ? 0.6 : Math.max(0, 0.6 * (1 - d / 5)));
					}
					const o = (y * img.w + x) * 4;
					for (let k = 0; k < 3; k++) img.px[o + k] = Math.round(img.px[o + k] * (1 - a));
				}
			}
		}
		for (const [x0, y0, x1, y1] of letras) {
			rect(img, x0 - 3, y0 - 3, x1 + 3, y1 + 3, [0, 0, 0]);
			rect(img, x0, y0, x1, y1, BLANCO);
		}
		return img;
	}
	const esLetra = (r: number, g: number, b: number) => (r > 230 && g > 230 && b > 230) || (r < 20 && g < 20 && b < 20);

	it('sin sombra: el contorno no cuenta como sombra', () => {
		const img = titulo(false);
		const halo = medirHalo(img.px, img.w, img.h, {x0: 20, y0: 30, x1: 280, y1: 90}, esLetra, {dMax: 12})!;
		expect(halo.sombra).toBe(false);
		expect(halo.oscurecimiento).toBeLessThan(0.03);
	});

	it('un objeto oscuro del fondo junto a algunas letras no es sombra (no es parejo)', () => {
		const img = titulo(false);
		rect(img, 20, 83, 110, 120, [40, 30, 30]); // marco oscuro debajo de las 3 primeras letras
		const halo = medirHalo(img.px, img.w, img.h, {x0: 20, y0: 30, x1: 280, y1: 90}, esLetra, {dMax: 12})!;
		expect(halo.sombra).toBe(false);
		expect(halo.consistencia).toBeLessThan(0.6);
	});

	it('con sombra abajo: la detecta, desplazada hacia abajo y casi negra', () => {
		const img = titulo(true);
		const halo = medirHalo(img.px, img.w, img.h, {x0: 20, y0: 30, x1: 280, y1: 95}, (r, g, b) => (r > 230 && g > 230 && b > 230) || (r < 3 && g < 3 && b < 3), {dMax: 12})!;
		expect(halo.sombra).toBe(true);
		expect(halo.consistencia).toBeGreaterThanOrEqual(0.6);
		expect(halo.alcance.abajo!).toBeGreaterThan(halo.alcance.arriba ?? 0);
		expect(halo.desplazamiento!.y).toBeGreaterThan(1.5);
		expect(halo.opacidad!).toBeGreaterThan(0.3);
	});
});

describe('compararTipografia', () => {
	it('misma familia, distinta y N/A', () => {
		expect(compararTipografia({peso: 0.2, ancho: 0.62, contorno: 0.09}, {peso: 0.19, ancho: 0.6, contorno: 0.09}).veredicto).toBe('misma familia (probable)');
		expect(compararTipografia({peso: 0.3, ancho: 0.62, contorno: 0.09}, {peso: 0.19, ancho: 0.6, contorno: 0.09}).veredicto).toBe('distinta');
		expect(compararTipografia({peso: 0.2, ancho: 0.62, contorno: 0.09}, null).veredicto).toBe('N/A');
	});
});

// ───────────────────────────── 6. Habla ─────────────────────────────

describe('números con palabras', () => {
	const n = (texto: string) => numeroDePalabras(texto.split(' '), 0);
	it('lee números del español', () => {
		expect(n('quince')).toEqual({valor: 15, usadas: 1});
		expect(n('veinte')).toEqual({valor: 20, usadas: 1});
		expect(n('treinta y cinco')).toEqual({valor: 35, usadas: 3});
		expect(n('cien')).toEqual({valor: 100, usadas: 1});
		expect(n('ciento veinte')).toEqual({valor: 120, usadas: 2});
		expect(n('dos mil quinientos')).toEqual({valor: 2500, usadas: 3});
		expect(n('un millon')).toEqual({valor: 1_000_000, usadas: 2});
		expect(n('cinco punto cinco')).toEqual({valor: 5.5, usadas: 3});
		expect(n('cinco a diez')).toEqual({valor: 5, usadas: 1});
	});
	it('"un", "una" y "uno" solos son artículos', () => {
		expect(n('una guia')).toBeNull();
		expect(n('un sistema')).toBeNull();
		expect(n('hola')).toBeNull();
	});
	it('tokeniza tarjetas y habla con números canónicos', () => {
		expect(tokenizar('$20').map((t) => [t.t, t.moneda, t.escrito])).toEqual([['20', true, 'digitos']]);
		expect(tokenizar('Entre 5 a 10').map((t) => t.t)).toEqual(['entre', '5', 'a', '10']);
		expect(tokenizar('Opus 5.5').map((t) => t.t)).toEqual(['opus', '5.5']);
		const habla: PalabraHabla[] = ['veinte', 'dólares,', 'al', 'mes'].map((t, i) => ({i, t, d: i, h: i + 0.5}));
		const toks = tokenizarHabla(habla);
		expect(toks.map((t) => [t.t, t.moneda, t.opcional])).toEqual([
			['20', true, false],
			['dolares', false, true],
			['al', false, false],
			['mes', false, false],
		]);
	});
});

describe('emparejarHabla', () => {
	/** Transcripción falsa: cada palabra dura 0.3 s, empezando en t0. */
	const decir = (texto: string, t0: number, i0 = 0): PalabraHabla[] => texto.split(' ').map((t, k) => ({i: i0 + k, t, d: t0 + 0.3 * k, h: t0 + 0.3 * k + 0.28}));

	it('literal con número en palabras → dígitos, y desfase en cuadros de 30 fps', () => {
		const habla = decir('Claude tiene quince empleados nuevos', 9.4);
		const c = emparejarHabla('15 empleados', 10.0, 11.2, habla);
		expect(c.tipo).toBe('literal');
		expect(c.texto_dicho).toBe('quince empleados');
		expect(c.inicio_habla).toBeCloseTo(10.0, 5);
		expect(c.desfase_cuadros).toBe(0);
		expect(c.numero_en_digitos).toBe(true);
	});

	it('"$20" = "veinte dólares" (literal) y "Tu plan de $20" ← "de veinte" (parafraseo)', () => {
		const habla = decir('ahora pagas veinte dólares al mes', 4.0);
		expect(emparejarHabla('$20', 4.7, 5.5, habla).tipo).toBe('literal');
		const p = emparejarHabla('Tu plan de $20', 30.2, 31.0, decir('el plan de veinte', 30.0));
		expect(p.tipo).toBe('parafraseo');
		expect(p.cobertura).toBeCloseTo(0.75, 2);
	});

	it('palabras partidas o juntas: "adetalle" = "a detalle" y "Hyper Frame" = "hyperframe"', () => {
		expect(emparejarHabla('Más adetalle', 2.0, 3.0, decir('más a detalle', 2.0)).tipo).toBe('literal');
		expect(emparejarHabla('Hyper Frame', 5.0, 6.0, decir('usa hyperframe', 4.7)).tipo).toBe('literal');
	});

	it('abreviaturas: "En PC" ← "en computadora" y "De IA" ← "de inteligencia artificial" (parafraseo)', () => {
		const c = emparejarHabla('En PC', 58.0, 59.0, decir('la aplicación en computadora entonces', 57.5));
		expect(c.tipo).toBe('parafraseo');
		expect(c.texto_dicho).toBe('en computadora');
		const d = emparejarHabla('De IA', 3.0, 4.0, decir('de inteligencia artificial', 3.0));
		expect(d.tipo).toBe('parafraseo');
		expect(d.cobertura).toBe(1);
	});

	it('lo dicho más de 2 s antes de la tarjeta ya no cuenta', () => {
		expect(emparejarHabla('Hyperframes', 22.6, 23.4, decir('salió Hyperframes lo instalas directamente en Claude Design con este comando', 20.0)).tipo).toBe('sin_coincidencia');
	});

	it('sin coincidencia de contenido → sin_coincidencia; con dos "solo", gana el más cercano', () => {
		expect(emparejarHabla('Grafo', 3.0, 4.0, decir('de todo lo que tienes', 2.5)).tipo).toBe('sin_coincidencia');
		const habla = [...decir('lo hace solo y rápido', 2.0, 0), ...decir('trabaja solo', 9.7, 5)];
		const c = emparejarHabla('Solo', 10.0, 11.0, habla, {antes: 10});
		expect(c.tipo).toBe('literal');
		expect(c.inicio_habla).toBeCloseTo(10.0, 5);
		expect(c.desfase_cuadros).toBe(0);
	});
});

describe('clasificación de tarjetas', () => {
	it('tipo de palabra', () => {
		expect(tipoDeTarjeta('¿Qué tipo de negocio tienes?')).toBe('pregunta');
		expect(tipoDeTarjeta('/loop')).toBe('comando');
		expect(tipoDeTarjeta('$ npx hyperframes render')).toBe('comando');
		expect(tipoDeTarjeta('$20')).toBe('cifra');
		expect(tipoDeTarjeta('15 empleados')).toBe('cifra');
		expect(tipoDeTarjeta('Claude Design')).toBe('producto');
		expect(tipoDeTarjeta('Siguiente sesión')).toBe('clave');
		expect(tipoDeTarjeta('Como esta armando')).toBe('frase');
	});
	it('limpia lo que Vision lee de íconos', () => {
		expect(limpiarTextoOcr('*** de tu empresa')).toBe('de tu empresa');
		expect(limpiarTextoOcr('La* Instrucciones\n•')).toBe('La Instrucciones');
	});
	it('mayúscula inicial y palabras', () => {
		expect(mayusculaInicial('Gratis')).toBe(true);
		expect(mayusculaInicial('revisas')).toBe(false);
		expect(mayusculaInicial('¿Cómo las usas?')).toBe(true);
		expect(mayusculaInicial('$20')).toBeNull();
		expect(mayusculaInicial('15 flujos')).toBeNull();
		expect(contarPalabras('Como si fuera el de $100')).toBe(6);
	});
});

// ───────────────────────────── 7. Listas y resumen ─────────────────────────────

describe('agruparListas', () => {
	it('lista vertical que aparece una por una, y una mixta (dos arriba, una abajo)', () => {
		const listas = agruparListas([
			{id: 't1', nDesde: 100, nHasta: 160, cx: 540, cy: 1150, w: 200, h: 60},
			{id: 't2', nDesde: 115, nHasta: 160, cx: 540, cy: 1225, w: 260, h: 60},
			{id: 't3', nDesde: 130, nHasta: 160, cx: 540, cy: 1300, w: 320, h: 60},
			{id: 't4', nDesde: 300, nHasta: 340, cx: 440, cy: 1200, w: 180, h: 50},
			{id: 't5', nDesde: 300, nHasta: 340, cx: 640, cy: 1200, w: 180, h: 50},
			{id: 't6', nDesde: 301, nHasta: 340, cx: 540, cy: 1270, w: 300, h: 50},
			{id: 't7', nDesde: 500, nHasta: 520, cx: 540, cy: 1200, w: 200, h: 60},
		]);
		expect(listas).toHaveLength(2);
		expect(listas[0]).toMatchObject({tarjetas: ['t1', 't2', 't3'], n: 3, disposicion: 'vertical', orden: 'lectura', retrasos: [15, 15], separacion_v: [15, 15]});
		expect(listas[1]).toMatchObject({tarjetas: ['t4', 't5', 't6'], disposicion: 'mixta', orden: 'simultanea', separacion_h: [20], separacion_v: [20]});
	});
});

describe('resumirTarjetas', () => {
	const base: TarjetaResumible = {
		id: 't1', texto: 'Gratis', duracion: 1, caja: {x: 540, y: 1200, w: 300, h: 90}, radio: 13, padding: {h: 30, v: 20}, alto_mayuscula: 40,
		peso: 0.2, color_caja: '#FFFFFF', color_texto: '#000000', grande: false, escritura: false, lista: null, palabras: 1,
		mayuscula_inicial: true, digitos: false, tipo_palabra: 'clave', entrada: 'corte', salida: 'corte', habla: null,
	};
	it('por minuto, cuantiles, porcentajes y habla', () => {
		const habla = {tipo: 'literal' as const, cobertura: 1, cobertura_contenido: 1, palabras: [3], texto_dicho: 'gratis', inicio_habla: 1, desfase_s: 0.1, desfase_cuadros: 3, numero_en_digitos: null};
		const r = resumirTarjetas(
			[
				{...base, habla},
				{...base, id: 't2', duracion: 2, texto: '$20', digitos: true, mayuscula_inicial: null, tipo_palabra: 'cifra', grande: true, habla: {...habla, desfase_cuadros: -3, numero_en_digitos: true}},
				{...base, id: 't3', duracion: 3, lista: 'l1', habla: {...habla, tipo: 'sin_coincidencia', desfase_cuadros: null}},
			],
			[],
			60,
			true,
		);
		expect(r.n).toBe(3);
		expect(r.por_minuto).toBe(3);
		expect(r.duracion_s.p50).toBe(2);
		expect(r.pct_grande).toBeCloseTo(33.3, 1);
		expect(r.pct_en_listas).toBeCloseTo(33.3, 1);
		expect(r.pct_mayuscula_inicial).toBe(100);
		expect(r.tipos.cifra).toBe(1);
		expect(r.habla!.n_coinciden).toBe(2);
		expect(r.habla!.desfase_cuadros.p50).toBe(0);
		expect(r.habla!.pct_literal).toBeCloseTo(66.7, 1);
		expect(r.habla!.pct_numeros_en_digitos).toBe(100);
		expect(r.color_caja).toBe('#FFFFFF');
	});
	it('sin habla → habla null', () => {
		expect(resumirTarjetas([base], [], 30, false).habla).toBeNull();
	});
});
