/**
 * Pruebas de la medición de subtítulos (Fase 1), todas puras (sin Vision, sin ffmpeg, sin red):
 * - herramientas/lib/color.ts: sRGB ↔ Lab y ΔE2000 contra los 34 pares de Sharma, Wu y Dalal (2005).
 * - herramientas/lib/ocr.ts: texto, comparación de lecturas, selección de cuadros, rachas y bordes.
 * - herramientas/estilo/medir.ts: cuantiles, franja, color/borde/grosor sobre imágenes sintéticas, resaltado
 *   y resumen; y el arreglo del estilo INVERTIDO (subtítulo blanco con contorno negro sobre playera negra:
 *   lectura fundida, referencia previa y polaridad).
 * Lo que necesita Vision (ocrCuadros, medirSubtitulos) se prueba en pruebas/integracion/f1-ocr-fixture.ts y
 * pruebas/integracion/f1-medir-oscuro.ts.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {deltaE2000, deltaE76, hexARgb, labARgb, medianaLab, rgbAHex, rgbALab, type Lab, type Rgb} from '../../herramientas/lib/color.ts';
import {
	afinarBordes,
	agruparEventos,
	alineacionParcial,
	compactarTexto,
	cuadrosDeSeleccion,
	cuadrosParaAfinar,
	expresionSelect,
	levenshtein,
	lineasDeCajas,
	mismoSubtitulo,
	normalizarTexto,
	rangos,
	recortePar,
	similitud,
	type CajaOcr,
	type CuadroOcr,
	type LecturaCuadro,
	type Rect,
} from '../../herramientas/lib/ocr.ts';
import {
	analizarColores,
	analizarGuiado,
	cargarReferenciaPrevia,
	contarPalabras,
	cuantil,
	detectarResaltado,
	esMayusculas,
	estiloDeReferencia,
	grosorConfiable,
	lineasSubtitulo,
	marcarPalabra,
	motivoFueraDeEstilo,
	recortarPalabras,
	referenciaGuia,
	referenciaPreviaDe,
	referenciaResaltado,
	resumirEventos,
	ubicarFranja,
	type AnalisisColor,
	type EventoSubtitulo,
	type PalabraMedida,
	type ReferenciaPrevia,
} from '../../herramientas/estilo/medir.ts';

// ───────────────────────────── color.ts ─────────────────────────────

describe('color: sRGB → Lab', () => {
	const casos: Array<[Rgb, Lab]> = [
		[[255, 255, 255], [100, 0, 0]],
		[[0, 0, 0], [0, 0, 0]],
		[[255, 0, 0], [53.24, 80.09, 67.2]],
		[[0, 255, 0], [87.73, -86.18, 83.18]],
		[[0, 0, 255], [32.3, 79.19, -107.86]],
		[[128, 128, 128], [53.59, 0, 0]],
	];
	it.each(casos)('%j → %j (±0.05)', (rgb, esperado) => {
		const lab = rgbALab(rgb);
		lab.forEach((v, k) => expect(Math.abs(v - esperado[k])).toBeLessThan(0.05));
	});

	it('Lab → sRGB regresa al mismo color (±1)', () => {
		for (const rgb of [[255, 255, 255], [0, 0, 0], [255, 212, 0], [17, 99, 200], [230, 210, 190], [4, 1, 0]] as Rgb[]) {
			const vuelta = labARgb(rgbALab(rgb));
			vuelta.forEach((v, k) => expect(Math.abs(v - rgb[k])).toBeLessThanOrEqual(1));
		}
	});

	it('hex ↔ rgb', () => {
		expect(rgbAHex([255, 212, 0])).toBe('#FFD400');
		expect(hexARgb('#ffd400')).toEqual([255, 212, 0]);
		expect(hexARgb('0A0B0C')).toEqual([10, 11, 12]);
		expect(() => hexARgb('#fff')).toThrow();
	});

	it('mediana Lab por componente', () => {
		expect(medianaLab([])).toBeNull();
		expect(medianaLab([[10, 0, 0], [20, 5, -5], [90, 1, 1]])).toEqual([20, 1, 0]);
		expect(medianaLab([[10, 0, 0], [20, 2, 2]])).toEqual([15, 1, 1]);
	});
});

describe('color: ΔE2000 (Sharma, Wu y Dalal 2005, 34 pares)', () => {
	// [L1, a1, b1, L2, a2, b2, ΔE00]
	const pares: number[][] = [
		[50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
		[50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
		[50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
		[50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
		[50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
		[50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
		[50, 0, 0, 50, -1, 2, 2.3669],
		[50, -1, 2, 50, 0, 0, 2.3669],
		[50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
		[50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
		[50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
		[50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
		[50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
		[50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
		[50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
		[50, 2.5, 0, 50, 0, -2.5, 4.3065],
		[50, 2.5, 0, 73, 25, -18, 27.1492],
		[50, 2.5, 0, 61, -5, 29, 22.8977],
		[50, 2.5, 0, 56, -27, -3, 31.903],
		[50, 2.5, 0, 58, 24, 15, 19.4535],
		[50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
		[50, 2.5, 0, 50, 3.2972, 0, 1.0],
		[50, 2.5, 0, 50, 1.8634, 0.5757, 1.0],
		[50, 2.5, 0, 50, 3.2592, 0.335, 1.0],
		[60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
		[63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
		[61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
		[35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
		[22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
		[36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
		[90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
		[90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
		[6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
		[2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
	];
	it.each(pares.map((p, i) => [i + 1, p] as const))('par %i', (_, p) => {
		expect(deltaE2000([p[0], p[1], p[2]], [p[3], p[4], p[5]])).toBeCloseTo(p[6], 4);
	});

	it('es simétrica y vale 0 con el mismo color', () => {
		const a = rgbALab([255, 212, 0]);
		const b = rgbALab([250, 250, 250]);
		expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
		expect(deltaE2000(a, a)).toBe(0);
		expect(deltaE76(a, a)).toBe(0);
	});

	it('blanco contra casi blanco ≤ 1; blanco contra amarillo > 12 (umbral de resaltado)', () => {
		expect(deltaE2000(rgbALab([255, 255, 255]), rgbALab([254, 254, 254]))).toBeLessThan(1);
		expect(deltaE2000(rgbALab([255, 255, 255]), rgbALab([255, 212, 0]))).toBeGreaterThan(12);
	});
});

// ───────────────────────────── ocr.ts: texto ─────────────────────────────

describe('ocr: texto', () => {
	it('normaliza y compacta', () => {
		expect(normalizarTexto('¡Está  bien!')).toBe('esta bien');
		expect(normalizarTexto('per:der"')).toBe('per der');
		expect(compactarTexto('per:der"')).toBe('perder');
		expect(compactarTexto('con-Gemini')).toBe(compactarTexto('con Gemini'));
		expect(compactarTexto('...')).toBe('');
	});

	it('Levenshtein y similitud', () => {
		expect(levenshtein('kitten', 'sitting')).toBe(3);
		expect(levenshtein('', 'abc')).toBe(3);
		expect(similitud('minutos', 'miriutos')).toBeCloseTo(1 - 2 / 8, 10);
		expect(similitud('', '')).toBe(1);
	});

	it('alineación parcial: dónde cae la corta dentro de la larga', () => {
		expect(alineacionParcial('perder', 'sinperder')).toEqual({inicio: 3, fin: 9, distancia: 0});
		expect(alineacionParcial('conchat', 'conchatgpt')).toMatchObject({inicio: 0, distancia: 0});
		expect(alineacionParcial('hatgpt', 'conchatgpt').distancia).toBe(0);
	});
});

const caja = (x: number, y: number, w: number, h: number): Rect => ({x, y, w, h});

describe('ocr: mismoSubtitulo', () => {
	const sinPerder = {texto: 'sin perder', caja: caja(0.4, 0.6, 0.235, 0.029)};
	it('igual con ruido de puntuación', () => {
		expect(mismoSubtitulo({texto: "perd'er'", caja: caja(0.46, 0.6, 0.18, 0.03)}, {texto: 'per:der"', caja: caja(0.46, 0.6, 0.18, 0.03)})).toBe(true);
	});
	it('lectura parcial: le falta la primera palabra y comparte la orilla derecha', () => {
		expect(mismoSubtitulo({texto: 'perder', caja: caja(0.4646, 0.6, 0.1704, 0.029)}, sinPerder)).toBe(true);
	});
	it('lectura parcial con la orilla equivocada no cuenta', () => {
		expect(mismoSubtitulo({texto: 'perder', caja: caja(0.42, 0.6, 0.17, 0.029)}, sinPerder)).toBe(false);
	});
	it('"ahora" (subtítulo nuevo, centrado) no es "una hora"', () => {
		const unaHora = {texto: 'una hora', caja: caja(0.37, 0.6, 0.26, 0.026)};
		const ahora = {texto: 'ahora', caja: caja(0.4257, 0.58, 0.1472, 0.026)};
		expect(mismoSubtitulo(ahora, unaHora)).toBe(false);
	});
	it('textos distintos o cajas que no se enciman no son el mismo', () => {
		expect(mismoSubtitulo({texto: 'y escribir', caja: caja(0.4, 0.6, 0.2, 0.03)}, {texto: 'un prompt', caja: caja(0.4, 0.6, 0.2, 0.03)})).toBe(false);
		expect(mismoSubtitulo({texto: 'hola', caja: caja(0.4, 0.2, 0.2, 0.03)}, {texto: 'hola', caja: caja(0.4, 0.6, 0.2, 0.03)})).toBe(false);
		expect(mismoSubtitulo({texto: '', caja: null}, {texto: 'hola', caja: null})).toBe(false);
	});
});

// ───────────────────────────── ocr.ts: selección de cuadros ─────────────────────────────

describe('ocr: selección de cuadros y recorte', () => {
	it('recorte a números pares dentro del cuadro', () => {
		expect(recortePar({x: 0, y: 1801, w: 1440, h: 287}, 1440, 2560)).toEqual({x: 0, y: 1800, w: 1440, h: 288});
		expect(recortePar({x: -5, y: 2550, w: 50, h: 30}, 1440, 2560)).toEqual({x: 0, y: 2550, w: 46, h: 10});
	});
	it('paso y lista', () => {
		expect(cuadrosDeSeleccion({tipo: 'paso', paso: 3}, 10)).toEqual([0, 3, 6, 9]);
		expect(cuadrosDeSeleccion({tipo: 'paso', paso: 3, desde: 4, hasta: 8}, 100)).toEqual([6]);
		expect(cuadrosDeSeleccion({tipo: 'lista', cuadros: [9, 3, 3, 120, -1, 4]}, 100)).toEqual([3, 4, 9]);
	});
	it('rangos y expresión de select', () => {
		expect(rangos([1, 2, 3, 7, 9, 10])).toEqual([[1, 3], [7, 7], [9, 10]]);
		// Una lista pide el tramo continuo (cientos de rangos sumados hacen fallar a ffmpeg); Node filtra los cuadros.
		expect(expresionSelect({tipo: 'lista', cuadros: [7, 1, 2, 3]}, 100)).toBe('between(n,1,7)');
		expect(expresionSelect({tipo: 'paso', paso: 15}, 900)).toBe('not(mod(n,15))*between(n,0,899)');
		expect(expresionSelect({tipo: 'lista', cuadros: []}, 100)).toBe('0');
	});
});

// ───────────────────────────── ocr.ts: rachas y bordes ─────────────────────────────

const CAJA = caja(0.4, 0.6, 0.2, 0.03);
function lecturas(textos: Array<string | null>, paso = 3): LecturaCuadro[] {
	return textos.map((t, k) => ({n: k * paso, t: (k * paso) / 30, texto: t ?? '', caja: t ? CAJA : null}));
}

describe('ocr: agruparEventos', () => {
	it('rachas del mismo texto → eventos con bordes en las lecturas', () => {
		const ev = agruparEventos(lecturas([null, 'hola', 'hola', 'hola', 'mundo', 'mundo', null]), {fps: 30});
		expect(ev.map((e) => [e.texto, e.nDesde, e.nHasta, e.nAntes, e.nDespues])).toEqual([
			['hola', 3, 10, 0, 12],
			['mundo', 12, 16, 9, 18],
		]);
		expect(ev[0].desde).toBeCloseTo(0.1, 10);
		expect(ev[0].hasta).toBeCloseTo(10 / 30, 10);
	});
	it('descarta rachas de una sola lectura', () => {
		const ev = agruparEventos(lecturas(['ruido', 'hola', 'hola', 'otro', null]), {fps: 30});
		expect(ev.map((e) => e.texto)).toEqual(['hola']);
	});
	it('une dos rachas del mismo texto con una lectura vacía en medio', () => {
		const ev = agruparEventos(lecturas(['hola', 'hola', null, 'hola', 'hola']), {fps: 30});
		expect(ev).toHaveLength(1);
		expect([ev[0].nDesde, ev[0].nHasta, ev[0].lecturas]).toEqual([0, 13, 4]);
	});
	it('une A · X · A cuando X es una sola lectura rara (no solo vacía)', () => {
		const ev = agruparEventos(lecturas(['único que', 'unico que*', 'mano', 'único que', 'único que']), {fps: 30});
		expect(ev.map((e) => [e.normalizado, e.nDesde, e.nHasta, e.lecturas])).toEqual([['unico que', 0, 13, 4]]);
	});
	it('no une si el hueco es de 2 lecturas', () => {
		expect(agruparEventos(lecturas(['hola', 'hola', null, null, 'hola', 'hola']), {fps: 30})).toHaveLength(2);
	});
	it('una lectura parcial (orilla derecha igual) no corta la racha', () => {
		const completa = {texto: 'sin perder', caja: caja(0.4, 0.6, 0.235, 0.029)};
		const parcial = {texto: 'perder', caja: caja(0.4646, 0.6, 0.1704, 0.029)};
		const ls: LecturaCuadro[] = [completa, parcial, parcial, completa].map((l, k) => ({n: k * 3, t: k / 10, ...l}));
		const ev = agruparEventos(ls, {fps: 30});
		expect(ev).toHaveLength(1);
		expect(ev[0].lecturas).toBe(4);
	});
});

describe('ocr: afinar bordes a los fps nativos', () => {
	it('pide los cuadros entre muestras y abre la ventana si la muestra vecina salió vacía', () => {
		const ls = lecturas([null, 'hola', 'hola', null]);
		const ev = agruparEventos(ls, {fps: 30});
		// muestras 0,3,6,9; hola en [3, 7). nAntes=0 (vacía) → abre hasta −2…; nDespues=9 (vacía) → hasta 11.
		expect(cuadrosParaAfinar(ev, ls, 3, 100)).toEqual([1, 2, 7, 8, 10, 11]);
	});
	it('extiende inicio y fin con las lecturas intermedias', () => {
		const ls = lecturas([null, 'hola', 'hola', null]);
		const ev = agruparEventos(ls, {fps: 30});
		const intermedias: LecturaCuadro[] = [
			{n: 1, t: 0, texto: '', caja: null},
			{n: 2, t: 0, texto: 'hola', caja: CAJA},
			{n: 7, t: 0, texto: 'hola', caja: CAJA},
			{n: 8, t: 0, texto: '', caja: null},
		];
		const [e] = afinarBordes(ev, [...ls, ...intermedias], {fps: 30});
		expect([e.nDesde, e.nHasta]).toEqual([2, 8]);
		expect(e.desde).toBeCloseTo(2 / 30, 10);
	});
	it('un cuadro vacío suelto no corta el borde si el siguiente coincide', () => {
		const ls = lecturas([null, null, 'hola', 'hola']); // muestras 0,3,6,9
		const ev = agruparEventos(ls, {fps: 30});
		const intermedias: LecturaCuadro[] = [
			{n: 5, t: 0, texto: '', caja: null},
			{n: 4, t: 0, texto: 'hola', caja: CAJA},
			{n: 2, t: 0, texto: '', caja: null},
		];
		const [e] = afinarBordes(ev, [...ls, ...intermedias], {fps: 30});
		expect(e.nDesde).toBe(4);
	});
	it('no se mete en el evento vecino', () => {
		const ls = lecturas(['hola', 'hola', 'adiós', 'adiós']);
		const ev = agruparEventos(ls, {fps: 30});
		const intermedias: LecturaCuadro[] = [
			{n: 4, t: 0, texto: 'hola', caja: CAJA},
			{n: 5, t: 0, texto: 'adiós', caja: CAJA},
		];
		const [a, b] = afinarBordes(ev, [...ls, ...intermedias], {fps: 30});
		expect([a.nHasta, b.nDesde]).toEqual([5, 5]);
	});
});

describe('ocr: líneas de un cuadro', () => {
	it('junta cajas del mismo renglón de izquierda a derecha y ordena renglones', () => {
		const cajas: CajaOcr[] = [
			{texto: 'perder', confianza: 0.9, x: 0.5, y: 0.6, w: 0.15, h: 0.03},
			{texto: 'arriba', confianza: 1, x: 0.4, y: 0.1, w: 0.2, h: 0.03},
			{texto: 'sin', confianza: 0.8, x: 0.4, y: 0.605, w: 0.08, h: 0.022},
		];
		const l = lineasDeCajas(cajas);
		expect(l.map((x) => x.texto)).toEqual(['arriba', 'sin perder']);
		expect(l[1].confianza).toBe(0.8);
		expect(l[1].caja.x).toBeCloseTo(0.4, 10);
		expect(l[1].caja.w).toBeCloseTo(0.25, 10);
	});
});

// ───────────────────────────── medir.ts: utilidades y franja ─────────────────────────────

describe('medir: utilidades', () => {
	it('cuantil tipo 7', () => {
		expect(cuantil([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(cuantil([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4, 10);
		expect(cuantil([5], 0.9)).toBe(5);
		expect(cuantil([], 0.5)).toBeNull();
		expect(cuantil([3, Number.NaN, 1], 0.5)).toBe(2);
	});
	it('palabras y mayúsculas', () => {
		expect(contarPalabras('Opus 5.5 es el mejor')).toBe(5);
		expect(contarPalabras('hablando.p.')).toBe(1);
		expect(contarPalabras(' , ')).toBe(0);
		expect(esMayusculas('SIN PERDER')).toBe(true);
		expect(esMayusculas('Claude Code')).toBe(false);
		expect(esMayusculas('5.5')).toBe(false);
		expect(esMayusculas('Ñ')).toBe(false);
	});
});

/** Cuadros sintéticos a 2 fps: título fijo arriba, @usuario fijo abajo, subtítulos que cambian cada ~0.5–1 s. */
function cuadrosSinteticos(conSubtitulos = true): CuadroOcr[] {
	const subs = ['hoy te', 'hoy te', 'enseño', 'cómo usar', 'Claude', 'Claude', 'Code', 'para', 'editar', 'tus reels', 'sin', 'perder'];
	return subs.map((s, k) => {
		const cajas: CajaOcr[] = [
			{texto: 'Claude Opus 5.5', confianza: 1, x: 0.25, y: 0.12, w: 0.5, h: 0.03},
			{texto: '@creador-demo', confianza: 1, x: 0.35, y: 0.9, w: 0.3, h: 0.015},
		];
		if (conSubtitulos) cajas.push({texto: s, confianza: 1, x: 0.5 - 0.08, y: 0.74 + (k % 3) * 0.004, w: 0.16, h: 0.035});
		return {n: k * 15, t: k / 2, cajas};
	});
}

describe('medir: ubicarFranja', () => {
	it('elige la línea de la mitad inferior que cambia cada 0.3–1.5 s', () => {
		const f = ubicarFranja(cuadrosSinteticos(), {periodo: 0.5});
		expect(f).not.toBeNull();
		expect(f!.centroY).toBeGreaterThan(0.74);
		expect(f!.centroY).toBeLessThan(0.79);
		expect(f!.y0).toBeLessThan(0.74);
		expect(f!.y1).toBeGreaterThan(0.783);
		expect(f!.y1).toBeLessThan(0.9); // no se traga el @usuario
		expect(f!.altoTexto).toBeCloseTo(0.035, 10);
		expect(f!.cobertura).toBe(1);
	});
	it('sin subtítulos (solo textos fijos) no inventa franja', () => {
		expect(ubicarFranja(cuadrosSinteticos(false), {periodo: 0.5})).toBeNull();
		expect(ubicarFranja([], {periodo: 0.5})).toBeNull();
	});
	it('lineasSubtitulo deja solo lo que tiene alto de subtítulo y va centrado', () => {
		const f = ubicarFranja(cuadrosSinteticos(), {periodo: 0.5})!;
		const cuadro: CuadroOcr = {
			n: 0,
			t: 0,
			cajas: [
				{texto: 'sin perder', confianza: 1, x: 0.4, y: 0.745, w: 0.2, h: 0.034},
				{texto: 'chiquito', confianza: 1, x: 0.45, y: 0.76, w: 0.05, h: 0.01},
				{texto: 'de lado', confianza: 1, x: 0.02, y: 0.75, w: 0.15, h: 0.034},
			],
		};
		expect(lineasSubtitulo(cuadro, f).map((l) => l.texto)).toEqual(['sin perder']);
	});
});

// ───────────────────────────── medir.ts: color, borde y grosor sobre imágenes sintéticas ─────────────────────────────

type Rgba = Uint8Array;

/**
 * Imagen sintética de "letras": barras y anillos de relleno con un contorno de `borde` px, sobre un fondo con
 * degradado. Opcionalmente un píxel de mezcla (antialias) entre relleno y borde.
 */
function imagenTexto(op: {relleno: Rgb; contorno: Rgb; fondo: (x: number, y: number) => Rgb; borde: number; tallo: number; mezcla?: boolean}): {px: Rgba; w: number; h: number} {
	const w = 260;
	const h = 90;
	const px = new Uint8Array(w * h * 4);
	// Formas: 5 barras verticales y 2 anillos (con hueco, como la "o").
	const barras = [20, 60, 100, 140, 180].map((x) => ({x0: x, x1: x + op.tallo, y0: 20, y1: 70}));
	const anillos = [{cx: 225, cy: 45, r1: 10, r2: 10 + op.tallo}];
	const distRelleno = (x: number, y: number): number => {
		let d = Number.POSITIVE_INFINITY;
		for (const b of barras) {
			const dx = Math.max(b.x0 - x, 0, x - (b.x1 - 1));
			const dy = Math.max(b.y0 - y, 0, y - (b.y1 - 1));
			d = Math.min(d, Math.max(dx, dy));
		}
		for (const a of anillos) {
			const r = Math.hypot(x - a.cx, y - a.cy);
			d = Math.min(d, r < a.r1 ? a.r1 - r : r > a.r2 ? r - a.r2 : 0);
		}
		return d;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const d = distRelleno(x, y);
			let c: Rgb;
			if (d === 0) c = op.relleno;
			else if (op.mezcla && d <= 1) c = op.relleno.map((v, k) => Math.round((v + op.contorno[k]) / 2)) as Rgb;
			else if (d <= op.borde + (op.mezcla ? 1 : 0)) c = op.contorno;
			else c = op.fondo(x, y);
			const o = (y * w + x) * 4;
			px[o] = c[0];
			px[o + 1] = c[1];
			px[o + 2] = c[2];
			px[o + 3] = 255;
		}
	}
	return {px, w, h};
}

const crema = (x: number, y: number): Rgb => [222 + ((x + y) % 7), 205 + ((x * 3) % 5), 185 + (y % 4)];
const todo = (w: number, h: number) => ({x0: 0, y0: 0, x1: w, y1: h});

describe('medir: analizarColores', () => {
	it('blanco con borde negro de 3 px sobre fondo crema (parecido al relleno)', () => {
		const im = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: crema, borde: 3, tallo: 12});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(a).not.toBeNull();
		expect(rgbAHex(a.relleno)).toBe('#FFFFFF');
		expect(rgbAHex(a.borde)).toBe('#000000');
		expect(a.grosor).toBeGreaterThanOrEqual(3);
		expect(a.grosor).toBeLessThanOrEqual(3.5);
		expect(a.tallo).toBeGreaterThanOrEqual(11);
		expect(a.tallo).toBeLessThanOrEqual(13);
		expect(a.confianza).toBeGreaterThan(0.8);
	});
	it('papeles al revés (relleno oscuro, borde claro) también salen bien', () => {
		const im = imagenTexto({relleno: [20, 20, 120], contorno: [250, 250, 250], fondo: crema, borde: 4, tallo: 12});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(deltaE2000(rgbALab(a.relleno), rgbALab([20, 20, 120]))).toBeLessThan(2);
		expect(deltaE2000(rgbALab(a.borde), rgbALab([250, 250, 250]))).toBeLessThan(2);
		expect(a.grosor).toBeGreaterThanOrEqual(4);
		expect(a.grosor).toBeLessThanOrEqual(4.5);
	});
	it('un píxel de mezcla (antialias gris) entre relleno y borde no se vuelve el borde', () => {
		const im = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: () => [120, 160, 90], borde: 3, tallo: 12, mezcla: true});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(rgbAHex(a.relleno)).toBe('#FFFFFF');
		expect(rgbAHex(a.borde)).toBe('#000000');
		// 3 px de borde + ½ de la mezcla.
		expect(a.grosor).toBeGreaterThanOrEqual(3);
		expect(a.grosor).toBeLessThanOrEqual(4);
	});
	it('relleno amarillo sobre fondo oscuro', () => {
		const im = imagenTexto({relleno: [255, 212, 0], contorno: [0, 0, 0], fondo: (x) => [40 + (x % 9), 30, 35], borde: 3, tallo: 10});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(rgbAHex(a.relleno)).toBe('#FFD400');
		expect(deltaE2000(rgbALab(a.borde), rgbALab([0, 0, 0]))).toBeLessThan(3);
	});
	it('orilla: el relleno de un subtítulo queda encerrado; letras negras en una etiqueta blanca no', () => {
		const sub = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: crema, borde: 3, tallo: 12});
		expect(analizarColores(sub.px, sub.w, sub.h, todo(sub.w, sub.h))!.orillaRelleno).toBeLessThan(0.05);
		// Etiqueta: fondo blanco, letras negras gruesas sin contorno (el "contorno" son las letras).
		const etiqueta = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: () => [255, 255, 255], borde: 6, tallo: 4});
		const a = analizarColores(etiqueta.px, etiqueta.w, etiqueta.h, todo(etiqueta.w, etiqueta.h))!;
		expect(a.orillaRelleno).toBeGreaterThan(0.5);
		expect(a.grosor).toBeNull(); // el "contorno" (las letras) no tiene fondo del otro lado
	});
	it('sin contraste ni forma de texto devuelve null', () => {
		const w = 50;
		const h = 30;
		const px = new Uint8Array(w * h * 4).fill(200);
		expect(analizarColores(px, w, h, todo(w, h))).toBeNull();
		expect(analizarColores(px, w, h, {x0: 0, y0: 0, x1: 3, y1: 3})).toBeNull();
	});
});

describe('medir: palabras ajenas pegadas al subtítulo', () => {
	const ref = {relleno: rgbALab([254, 254, 254]), borde: rgbALab([4, 0, 0]), grosor: 5, tallo: 16, n: 10};
	const sub = {...analisis([254, 254, 254], 16, 5), borde: [4, 0, 0] as Rgb};
	it('marca: contorno del reel = sí (aunque el relleno sea amarillo); otro contorno o sin análisis = no; cortas = ?', () => {
		expect(marcarPalabra('conectores', sub, null, ref)).toBe('si');
		expect(marcarPalabra('reels', {...sub, relleno: [255, 212, 0]}, null, ref)).toBe('si');
		expect(marcarPalabra('Global', {...sub, borde: [60, 60, 70]}, null, ref)).toBe('no');
		expect(marcarPalabra('Global', null, null, ref)).toBe('no');
		expect(marcarPalabra('Global', null, sub, ref)).toBe('si');
		expect(marcarPalabra('a', null, null, ref)).toBe('?');
		expect(marcarPalabra('a', {...sub, confianza: 0.6}, null, ref)).toBe('?');
		expect(marcarPalabra('ur', {...sub, borde: [60, 60, 70]}, null, ref)).toBe('no'); // corta pero clarísima
		expect(marcarPalabra('instalaciones', {...sub, tallo: 4}, null, ref)).toBe('no');
		expect(marcarPalabra('Meta', {...sub, orillaRelleno: 0.8}, null, ref)).toBe('no');
		expect(marcarPalabra('Opus', {...sub, relleno: [175, 172, 187]}, null, ref)).toBe('no'); // gris de un tuit
		expect(marcarPalabra('reels', {...sub, relleno: [255, 212, 0]}, null, ref)).toBe('si'); // amarillo: resaltado
	});
	it('recorta solo las puntas', () => {
		// "a conectores S&P Global" → "a conectores"
		expect(recortarPalabras(['?', 'si', 'no', 'no'])).toEqual({inicio: 0, fin: 2});
		// "iew, and research … muy sencillo" → "muy sencillo"
		expect(recortarPalabras(['no', 'no', 'no', 'si', 'si'])).toEqual({inicio: 3, fin: 5});
		// "ir a conectores ur Tik Tok Ads data in" → "ir a conectores" ("ur" con análisis claro de interfaz = 'no')
		expect(recortarPalabras(['?', '?', 'si', 'no', 'no', 'no', 'no', 'no', '?'])).toEqual({inicio: 0, fin: 3});
		// una corta indecisa entre el subtítulo y la captura se queda (no hay con qué decidir)
		expect(recortarPalabras(['si', '?', 'no'])).toEqual({inicio: 0, fin: 2});
		// en medio no se quita nada
		expect(recortarPalabras(['si', 'no', 'si'])).toEqual({inicio: 0, fin: 3});
		expect(recortarPalabras(['?', '?'])).toEqual({inicio: 0, fin: 2});
		expect(recortarPalabras(['no', '?', 'no'])).toEqual({inicio: 3, fin: 3});
	});
});

describe('medir: revisión guiada (subtítulo sobre fondo oscuro)', () => {
	const ref = {relleno: rgbALab([254, 254, 254]), borde: rgbALab([4, 0, 0]), grosor: 3, tallo: 12, n: 10};
	it('blanco con contorno negro sobre gris oscuro: pasa, sin grosor medible', () => {
		const im = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: () => [30, 30, 32], borde: 3, tallo: 12});
		const a = analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), ref)!;
		expect(a).not.toBeNull();
		expect(a.grosor).toBeNull();
		expect(a.confianza).toBeGreaterThan(0.9);
		expect(a.tallo).toBeGreaterThanOrEqual(11);
		expect(a.tallo).toBeLessThanOrEqual(13);
		expect(rgbAHex(a.relleno)).toBe('#FFFFFF');
	});
	it('texto blanco de interfaz sobre gris (sin contorno negro): no pasa', () => {
		const im = imagenTexto({relleno: [255, 255, 255], contorno: [42, 42, 42], fondo: () => [42, 42, 42], borde: 3, tallo: 12});
		expect(analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), ref)).toBeNull();
	});
	it('letras negras en una burbuja blanca: no pasa (el blanco llega a la orilla)', () => {
		const im = imagenTexto({relleno: [0, 0, 0], contorno: [255, 255, 255], fondo: () => [255, 255, 255], borde: 3, tallo: 12});
		expect(analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), ref)).toBeNull();
	});
	it('trazo muy distinto al de referencia: no pasa', () => {
		const im = imagenTexto({relleno: [255, 255, 255], contorno: [0, 0, 0], fondo: () => [30, 30, 32], borde: 3, tallo: 4});
		expect(analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), ref)).toBeNull();
	});
});

// ───────────────────────────── medir.ts: resaltado y resumen ─────────────────────────────

const analisis = (relleno: Rgb, tallo: number | null, grosor: number | null, confianza = 0.95): AnalisisColor => ({
	relleno,
	borde: [3, 1, 0],
	grosor,
	tallo,
	nRelleno: 1000,
	nBorde: 500,
	nPx: 5000,
	confianza,
	orillaRelleno: 0,
});
const palabra = (texto: string, a: AnalisisColor | null): PalabraMedida => ({texto, analisis: a, bordeRenglon: [4, 0, 0]});

describe('medir: resaltado', () => {
	const normales = ['hoy', 'te', 'enseño', 'cómo', 'usar'].map((t) => palabra(t, analisis([254, 254, 254], 12, 4)));
	const ref = referenciaResaltado(normales)!;
	it('referencia del reel = mediana de palabras confiables', () => {
		expect(ref.n).toBe(5);
		expect(ref.tallo).toBe(12);
		expect(ref.grosor).toBe(4);
		expect(referenciaResaltado(normales.slice(0, 2))).toBeNull();
	});
	it('color, peso y escala contra la referencia', () => {
		const r = detectarResaltado(
			[
				palabra('tus', analisis([254, 254, 254], 12, 4)),
				palabra('reels', analisis([255, 212, 0], 12, 4)),
				palabra('ChatGPT', analisis([254, 254, 254], 18, 4)),
				palabra('resultado', analisis([254, 254, 254], 16.3, 5.4)),
			],
			ref,
		);
		expect(r.map((x) => [x.palabra, x.modo])).toEqual([
			['reels', 'color'],
			['ChatGPT', 'peso'],
			['resultado', 'escala'],
		]);
	});
	it('un gris de interfaz no cuenta como resaltado de color (ni con ΔE > 20: le falta croma); uno amarillo sí', () => {
		const r = detectarResaltado(
			[palabra('tools', analisis([200, 200, 210], 12, 4)), palabra('Opus', analisis([175, 172, 187], 12, 4)), palabra('reels', analisis([255, 212, 0], 12, 4))],
			ref,
		);
		expect(r.map((x) => [x.palabra, x.modo])).toEqual([['reels', 'color']]);
	});
	it('peso y escala solo en palabras de 3 letras o más ("el" con trazo ruidoso no cuenta)', () => {
		expect(detectarResaltado([palabra('el', analisis([254, 254, 254], 21, 4))], ref)).toEqual([]);
		expect(detectarResaltado([palabra('mayor', analisis([254, 254, 254], 21, 4))], ref).map((x) => x.modo)).toEqual(['peso']);
	});
	it('una palabra con su "relleno" en la orilla (letras sobre etiqueta) no cuenta para el resaltado', () => {
		const etiqueta = {...analisis([255, 212, 0], 12, 4), orillaRelleno: 0.6};
		expect(detectarResaltado([palabra('Meta', etiqueta)], ref)).toEqual([]);
	});
	it('ignora palabras poco confiables, sin letras o con borde distinto al del renglón', () => {
		const r = detectarResaltado(
			[
				palabra('amarillo', analisis([255, 212, 0], 12, 4, 0.5)),
				palabra(',', analisis([255, 212, 0], 12, 4)),
				{texto: 'raro', analisis: {...analisis([255, 212, 0], 12, 4), borde: [250, 250, 250]}, bordeRenglon: [4, 0, 0]},
				palabra('nada', null),
			],
			ref,
		);
		expect(r).toEqual([]);
		expect(detectarResaltado([palabra('reels', analisis([255, 212, 0], 12, 4))], null)).toEqual([]);
	});
});

describe('medir: estilo de referencia y filtro de renglones ajenos', () => {
	// Renglones de subtítulo: blanco con contorno negro de 5 px y trazo de 16 px (px del video).
	const subtitulo = (conf = 0.95) => ({...analisis([254, 254, 254], 16, 5, conf), borde: [4, 0, 0] as Rgb});
	const ref = estiloDeReferencia([subtitulo(), subtitulo(), subtitulo(0.9), null, {...analisis([30, 30, 30], 2, 2), borde: [250, 250, 250] as Rgb}])!;
	it('la referencia sale de los renglones con estructura de subtítulo', () => {
		expect(ref.n).toBe(3);
		expect(rgbAHex(labARgb(ref.relleno))).toBe('#FEFEFE');
		expect(ref.grosor).toBe(5);
		expect(ref.tallo).toBe(16);
		expect(estiloDeReferencia([subtitulo(), null])).toBeNull();
	});
	it('acepta el estilo del reel, también con una palabra resaltada que domina el renglón', () => {
		expect(motivoFueraDeEstilo(subtitulo(), [], ref)).toBeNull();
		const dominaAmarillo = {...analisis([255, 212, 0], 16, 5), borde: [4, 0, 0] as Rgb};
		expect(motivoFueraDeEstilo(dominaAmarillo, [subtitulo(), dominaAmarillo], ref)).toBeNull();
		expect(motivoFueraDeEstilo(null, [], null)).toBeNull(); // sin referencia no se filtra
	});
	it('rechaza texto de capturas: sin contorno, contorno de otro color, relleno ajeno o trazo delgado', () => {
		expect(motivoFueraDeEstilo(null, [], ref)).toMatch(/contorno/);
		expect(motivoFueraDeEstilo(subtitulo(0.3), [], ref)).toMatch(/poco claros/);
		expect(motivoFueraDeEstilo({...subtitulo(), borde: [40, 90, 200]}, [], ref)).toMatch(/contorno de otro color/);
		expect(motivoFueraDeEstilo({...analisis([180, 170, 175], 16, 5), borde: [4, 0, 0]}, [], ref)).toMatch(/relleno de otro color/);
		expect(motivoFueraDeEstilo({...analisis([254, 254, 254], 5, 5), borde: [4, 0, 0]}, [], ref)).toMatch(/trazo de otro grosor/);
	});
	it('un contorno que se funde con un fondo oscuro no descarta el renglón, pero su grosor no se usa', () => {
		const sobreFondoOscuro = {...analisis([254, 254, 254], 16, 24), borde: [4, 0, 0] as Rgb};
		expect(motivoFueraDeEstilo(sobreFondoOscuro, [], ref)).toBeNull();
		expect(grosorConfiable(24, ref)).toBeNull();
		expect(grosorConfiable(6, ref)).toBe(6);
		expect(grosorConfiable(6, null)).toBe(6);
		expect(grosorConfiable(null, ref)).toBeNull();
	});
});

function evento(k: number, extra: Partial<EventoSubtitulo> = {}): EventoSubtitulo {
	return {
		id: `e${k}`,
		texto: 'hola mundo',
		palabras: 2,
		lineas: 1,
		mayusculas: false,
		confianza: 1,
		nDesde: k * 20,
		nHasta: k * 20 + 18,
		desde: (k * 20) / 30,
		hasta: (k * 20 + 18) / 30,
		duracion: 0.6,
		x: 540,
		y: 1450 + k,
		ancho: 300 + 10 * k,
		alto_caja: 69,
		alto_mayuscula: 50,
		color_texto: '#FEFEFE',
		color_borde: '#040000',
		grosor_borde: 3,
		confianza_color: 0.95,
		resaltado: [],
		...extra,
	};
}

describe('medir: resumirEventos', () => {
	it('cuantiles, colores por mediana en Lab y n por métrica', () => {
		const ev = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => evento(k));
		ev[9] = evento(9, {color_texto: '#FFD400', mayusculas: true, lineas: 2, resaltado: [{palabra: 'mundo', modo: 'color', detalle: ''}]});
		ev[8] = evento(8, {confianza_color: 0.2, color_texto: '#00FF00'});
		const r = resumirEventos(ev);
		expect(r.y_p50).toBe(1454.5);
		expect(r.y_p10).toBe(1450.9);
		expect(r.ancho_p90).toBe(381);
		expect(r.alto_mayuscula_p50).toBe(50);
		expect(r.color_texto).toBe('#FEFEFE');
		expect(r.color_borde).toBe('#040000');
		expect(r.grosor_borde_p50).toBe(3);
		expect(r.palabras_por_evento).toEqual({p10: 2, p50: 2, p90: 2});
		expect(r.duracion.p50).toBe(0.6);
		expect(r.mayusculas_pct).toBe(10);
		expect(r.una_linea_pct).toBe(90);
		expect(r.resaltado_pct).toBe(10);
		expect(r.resaltado_modos).toEqual({color: 1, peso: 0, escala: 0});
		expect(r.n_por_metrica).toMatchObject({y: 10, color: 9, grosor_borde: 9});
	});
	it('sin eventos todo queda en null (no se inventa)', () => {
		const r = resumirEventos([]);
		expect(r.y_p50).toBeNull();
		expect(r.color_texto).toBeNull();
		expect(r.palabras_por_evento).toEqual({p10: null, p50: null, p90: null});
		expect(r.n_por_metrica).toEqual({});
	});
});

// ───────────────────────────── medir.ts: estilo INVERTIDO sobre fondo oscuro ─────────────────────────────

/**
 * Letras con huecos: 2 palos y 3 "o" (anillos de radio interior 10) de relleno con un contorno de `borde` px.
 * Con el contorno fundido con un fondo negro, los huecos de las "o" pasan del 2 % de la caja y la lectura al revés
 * (negro = relleno, blanco = borde) es válida: es la que ganaba antes del arreglo en DhdcjsxJbi8, Dk5Z144VKLf y
 * DjqwCT3IBgs.
 */
function imagenConHuecos(op: {relleno: Rgb; contorno: Rgb; fondo: (x: number, y: number) => Rgb; borde: number; tallo: number}): {px: Rgba; w: number; h: number} {
	const w = 260;
	const h = 90;
	const px = new Uint8Array(w * h * 4);
	const palos = [20, 60].map((x) => ({x0: x, x1: x + op.tallo, y0: 20, y1: 70}));
	const anillos = [115, 165, 215].map((cx) => ({cx, cy: 45, r1: 10, r2: 10 + op.tallo}));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let d = Number.POSITIVE_INFINITY;
			for (const p of palos) d = Math.min(d, Math.max(Math.max(p.x0 - x, 0, x - (p.x1 - 1)), Math.max(p.y0 - y, 0, y - (p.y1 - 1))));
			for (const a of anillos) {
				const r = Math.hypot(x - a.cx, y - a.cy);
				d = Math.min(d, r < a.r1 ? a.r1 - r : r > a.r2 ? r - a.r2 : 0);
			}
			const c = d === 0 ? op.relleno : d <= op.borde ? op.contorno : op.fondo(x, y);
			const o = (y * w + x) * 4;
			px[o] = c[0];
			px[o + 1] = c[1];
			px[o + 2] = c[2];
			px[o + 3] = 255;
		}
	}
	return {px, w, h};
}

/** Playera negra: casi del color del contorno (en el reel real, #0E080C contra #040001). */
const playeraNegra = (x: number, y: number): Rgb => [8 + ((x + y) % 3), 5, 10];
const gris = (): Rgb => [128, 128, 128];
const BLANCO: Rgb = [255, 255, 255];
const NEGRO: Rgb = [0, 0, 0];

describe('medir: subtítulo blanco con contorno negro sobre playera negra (lectura fundida)', () => {
	const sobreNegro = imagenConHuecos({relleno: BLANCO, contorno: NEGRO, fondo: playeraNegra, borde: 4, tallo: 12});

	it('sobre negro: relleno blanco y contorno oscuro (no al revés), sin grosor y marcado fundido', () => {
		const a = analizarColores(sobreNegro.px, sobreNegro.w, sobreNegro.h, todo(sobreNegro.w, sobreNegro.h))!;
		expect(a).not.toBeNull();
		expect(rgbAHex(a.relleno)).toBe('#FFFFFF');
		expect(rgbALab(a.borde)[0]).toBeLessThan(10);
		expect(a.fundido).toBe(true);
		expect(a.grosor).toBeNull(); // no se ve dónde acaba el contorno
		expect(a.tallo).toBeGreaterThanOrEqual(11);
		expect(a.tallo).toBeLessThanOrEqual(14);
		expect(a.orillaRelleno).toBeLessThan(0.05);
	});

	it('las dos lecturas compiten: la de al revés es válida, pero su "relleno" (el negro) llena la orilla', () => {
		type Diagnostico = {
			pruebas: Array<{borde: number; relleno: number; puntaje: number; fundido: boolean}>;
			picos: Array<{i: number; color: string; orilla: number}>;
			elegida: {borde: number; relleno: number; fundido: boolean} | null;
		};
		const infos: Diagnostico[] = [];
		analizarColores(sobreNegro.px, sobreNegro.w, sobreNegro.h, todo(sobreNegro.w, sobreNegro.h), {diagnostico: (i) => infos.push(i as Diagnostico)});
		expect(infos).toHaveLength(1);
		const d = infos[0];
		const alReves = d.pruebas.find((p) => p.puntaje > 0)!;
		expect(alReves).toBeDefined();
		const oscuro = d.picos.find((p) => p.i === alReves.relleno)!;
		expect(rgbALab(hexARgb(oscuro.color))[0]).toBeLessThan(10); // el relleno de esa lectura es el negro…
		expect(oscuro.orilla).toBeGreaterThan(0.9); // …y llena la orilla de la caja: es la playera
		expect(d.elegida).toEqual({borde: alReves.relleno, relleno: alReves.borde, fundido: true});
	});

	it.each([
		['gris', gris],
		['crema', crema],
	])('sobre %s: la lectura de siempre (contorno visible, grosor medido, sin marca)', (_, fondo) => {
		const im = imagenConHuecos({relleno: BLANCO, contorno: NEGRO, fondo, borde: 4, tallo: 12});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(rgbAHex(a.relleno)).toBe('#FFFFFF');
		expect(rgbAHex(a.borde)).toBe('#000000');
		expect(a.fundido).toBeUndefined();
		expect(a.grosor).toBeGreaterThanOrEqual(4);
		expect(a.grosor).toBeLessThanOrEqual(4.5);
		expect(a.orillaRelleno).toBeLessThan(0.05);
	});

	it('letras oscuras de verdad (relleno encerrado que no llega a la orilla) no se voltean', () => {
		const im = imagenConHuecos({relleno: [20, 20, 120], contorno: [250, 250, 250], fondo: crema, borde: 4, tallo: 12});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h))!;
		expect(deltaE2000(rgbALab(a.relleno), rgbALab([20, 20, 120]))).toBeLessThan(2);
		expect(a.fundido).toBeUndefined();
	});

	it('letras negras en una burbuja blanca tampoco: ahí el relleno claro llena la orilla y no hay fundido', () => {
		const im = imagenConHuecos({relleno: NEGRO, contorno: BLANCO, fondo: () => BLANCO, borde: 3, tallo: 12});
		const a = analizarColores(im.px, im.w, im.h, todo(im.w, im.h));
		expect(a?.fundido).toBeUndefined();
	});
});

describe('medir: lo fundido lo decide la revisión guiada (igual de estricta que antes)', () => {
	const ref = {relleno: rgbALab([254, 251, 255]), borde: rgbALab([4, 0, 1]), grosor: 5.5, tallo: 13, n: 20};
	const subNegro = imagenConHuecos({relleno: BLANCO, contorno: NEGRO, fondo: playeraNegra, borde: 4, tallo: 12});
	// Texto blanco de una interfaz oscura: sin contorno negro, su "contorno" es el gris del fondo.
	const interfaz = imagenConHuecos({relleno: BLANCO, contorno: [30, 30, 32], fondo: () => [30, 30, 32], borde: 4, tallo: 12});
	const caja = (im: {w: number; h: number}) => todo(im.w, im.h);

	it('un renglón fundido no pasa solo el filtro de estilo: va a la revisión guiada', () => {
		const a = analizarColores(subNegro.px, subNegro.w, subNegro.h, caja(subNegro))!;
		expect(motivoFueraDeEstilo(a, [a], ref)).toMatch(/fundido/);
		const ui = analizarColores(interfaz.px, interfaz.w, interfaz.h, caja(interfaz))!;
		expect(ui.fundido).toBe(true);
		expect(motivoFueraDeEstilo(ui, [ui], ref)).toMatch(/fundido/);
	});

	it('la guiada acepta tu subtítulo sobre la playera (sin grosor) y rechaza el texto de la interfaz', () => {
		const g = analizarGuiado(subNegro.px, subNegro.w, subNegro.h, caja(subNegro), ref)!;
		expect(g).not.toBeNull();
		expect(g.grosor).toBeNull();
		expect(rgbAHex(g.relleno)).toBe('#FFFFFF');
		expect(analizarGuiado(interfaz.px, interfaz.w, interfaz.h, caja(interfaz), ref)).toBeNull();
	});

	it('palabras fundidas: "no" para que decida la guiada ("?" si es corta y poco clara); con guiada, "sí"', () => {
		const fundida: AnalisisColor = {...analisis([255, 254, 255], 13, null, 0.95), borde: [15, 9, 14], fundido: true};
		expect(marcarPalabra('mejor', fundida, null, ref)).toBe('no');
		expect(marcarPalabra('es', fundida, null, ref)).toBe('no');
		expect(marcarPalabra('es', {...fundida, confianza: 0.6}, null, ref)).toBe('?');
		expect(marcarPalabra('mejor', fundida, fundida, ref)).toBe('si');
	});

	it('las palabras fundidas no cuentan para la referencia del resaltado (su contorno no se mide)', () => {
		const fundida: AnalisisColor = {...analisis([255, 254, 255], 13, null), borde: [15, 9, 14], fundido: true};
		expect(referenciaResaltado(['cuando', 'te', 'buscan', 'en'].map((t) => palabra(t, fundida)))).toBeNull();
	});
});

/** Mini-estilo como el de estilo/mini-estilo.json (forma {valor, n, fuente} y tallo por reel). */
const MINI_ESTILO = {
	color_texto: {valor: '#FEFBFF', n: 8, fuente: 'medido'},
	color_borde: {valor: '#040001', n: 8, fuente: 'medido'},
	grosor_borde_p50: {valor: 3.94, n: 8, fuente: 'medido'},
	reels: [{estilo_referencia: {tallo: 9}}, {estilo_referencia: {tallo: 8.25}}, {estilo_referencia: {tallo: 8.25}}, {estilo_referencia: null}],
};

describe('medir: referencia previa (tu estilo ya medido)', () => {
	it('del mini-estilo: colores, grosor p50 y la mediana del trazo por reel', () => {
		const p = referenciaPreviaDe(MINI_ESTILO, 'estilo/mini-estilo.json')!;
		expect(rgbAHex(labARgb(p.relleno))).toBe('#FEFBFF');
		expect(rgbAHex(labARgb(p.borde))).toBe('#040001');
		expect(p.grosor).toBe(3.94);
		expect(p.tallo).toBe(8.25);
		expect(p.n).toBe(8);
		expect(p.fuente).toBe('estilo/mini-estilo.json');
	});

	it('de estilo.json (sección subtitulos, fuente "medido: …"): sin trazo', () => {
		const estilo = {
			subtitulos: {
				color_texto: {valor: '#FFFEFF', n: 7, fuente: 'medido: herramientas/estilo/medir.ts (Vision)'},
				color_borde: {valor: '#0B0609', n: 7, fuente: 'medido: herramientas/estilo/medir.ts (Vision)'},
				grosor_borde_p50: {valor: 4.13, n: 7, fuente: 'medido: herramientas/estilo/medir.ts (Vision)'},
			},
		};
		const p = referenciaPreviaDe(estilo, 'estilo/estilo.json')!;
		expect(rgbAHex(labARgb(p.relleno))).toBe('#FFFEFF');
		expect(p.grosor).toBe(4.13);
		expect(p.tallo).toBeNull();
		expect(p.n).toBe(7);
	});

	it('N/A, colores que no dicen "medido" o algo que no es JSON de estilo: null (no inventa)', () => {
		expect(referenciaPreviaDe({...MINI_ESTILO, color_texto: {valor: 'N/A', n: 0, fuente: 'medido'}}, 'x')).toBeNull();
		expect(referenciaPreviaDe({...MINI_ESTILO, color_borde: {valor: '#040001', n: 1, fuente: 'supuesto'}}, 'x')).toBeNull();
		expect(referenciaPreviaDe({...MINI_ESTILO, color_borde: {valor: '#fff', n: 1, fuente: 'medido'}}, 'x')).toBeNull();
		expect(referenciaPreviaDe(null, 'x')).toBeNull();
		expect(referenciaPreviaDe([1, 2], 'x')).toBeNull();
		expect(referenciaPreviaDe({...MINI_ESTILO, grosor_borde_p50: {valor: 'N/A'}, reels: []}, 'x')).toMatchObject({grosor: null, tallo: null});
	});

	it('cargarReferenciaPrevia: primero el mini-estilo; si falta o está roto, estilo.json; sin ninguno, null', () => {
		const raiz = mkdtempSync(join(tmpdir(), 'medir-previa-'));
		try {
			mkdirSync(join(raiz, 'estilo'));
			expect(cargarReferenciaPrevia(raiz)).toBeNull();
			const estiloJson = {subtitulos: {color_texto: {valor: '#FFFEFF', n: 7, fuente: 'medido: x'}, color_borde: {valor: '#0B0609', n: 7, fuente: 'medido: x'}}};
			writeFileSync(join(raiz, 'estilo', 'estilo.json'), JSON.stringify(estiloJson));
			expect(cargarReferenciaPrevia(raiz)?.fuente).toBe('estilo/estilo.json');
			writeFileSync(join(raiz, 'estilo', 'mini-estilo.json'), '{"color_texto": ');
			expect(cargarReferenciaPrevia(raiz)?.fuente).toBe('estilo/estilo.json');
			writeFileSync(join(raiz, 'estilo', 'mini-estilo.json'), JSON.stringify(MINI_ESTILO));
			expect(cargarReferenciaPrevia(raiz)?.fuente).toBe('estilo/mini-estilo.json');
		} finally {
			rmSync(raiz, {recursive: true, force: true});
		}
	});
});

describe('medir: estilo de referencia cuando la lectura al revés domina', () => {
	const previa: ReferenciaPrevia = referenciaPreviaDe(MINI_ESTILO, 'estilo/mini-estilo.json')!;
	const pxPorBase = 2560 / 1920;
	const lectura = (extra: Partial<AnalisisColor>): AnalisisColor => ({relleno: BLANCO, borde: NEGRO, grosor: 5.5, tallo: 11, nRelleno: 3000, nBorde: 2000, nPx: 30000, confianza: 0.95, orillaRelleno: 0, ...extra});
	// Lo que medía el medir.ts viejo sobre la playera negra (DhdcjsxJbi8): negro "encerrado" por el blanco, en la orilla.
	const alReves = () => lectura({relleno: [9, 5, 9], borde: [255, 254, 255], grosor: 11, tallo: 18.75, confianza: 1, orillaRelleno: 0.92});
	const normal = () => lectura({relleno: [254, 251, 255], borde: [4, 0, 1]});
	const fundida = () => lectura({relleno: [255, 254, 255], borde: [15, 9, 14], grosor: null, confianza: 1, fundido: true});
	const oscuraDeVerdad = () => lectura({relleno: [20, 20, 120], borde: [250, 250, 250], grosor: 5, tallo: 12});
	const veces = <T>(n: number, f: () => T): T[] => Array.from({length: n}, f);

	it('41 al revés contra 5 normales: sale blanca con contorno negro, con o sin previa (antes salía al revés)', () => {
		const lecturas = [...veces(41, alReves), ...veces(5, normal)];
		for (const op of [{previa, pxPorBase}, {}]) {
			const ref = estiloDeReferencia(lecturas, op)!;
			expect(rgbAHex(labARgb(ref.relleno))).toBe('#FEFBFF');
			expect(rgbAHex(labARgb(ref.borde))).toBe('#040001');
			expect(ref.grosor).toBe(5.5);
			expect(ref.n).toBe(5);
			expect(ref.origen).toBe('reel');
		}
	});

	it('sin contorno visible en ningún renglón: sale de las lecturas fundidas (sin grosor, con su trazo)', () => {
		const ref = estiloDeReferencia([...veces(40, alReves), ...veces(30, fundida)], {previa, pxPorBase})!;
		expect(ref.relleno[0]).toBeGreaterThan(95);
		expect(ref.borde[0]).toBeLessThan(10);
		expect(ref.grosor).toBeNull();
		expect(ref.tallo).toBe(11);
		expect(ref.n).toBe(30);
		expect(ref.origen).toBe('reel');
	});

	it('si el reel no da con qué, usa la previa (grosor y trazo en px del video); sin previa, null', () => {
		const soloAlReves = veces(40, alReves);
		const ref = estiloDeReferencia(soloAlReves, {previa, pxPorBase})!;
		expect(ref.origen).toBe('previa');
		expect(ref.n).toBe(0);
		expect(rgbAHex(labARgb(ref.relleno))).toBe('#FEFBFF');
		expect(ref.grosor).toBeCloseTo(3.94 * pxPorBase, 9);
		expect(ref.tallo).toBeCloseTo(8.25 * pxPorBase, 9);
		expect(estiloDeReferencia(soloAlReves)).toBeNull();
		expect(estiloDeReferencia([], {previa, pxPorBase})!.origen).toBe('previa');
	});

	it('cuando las dos polaridades compiten (ambas encerradas) gana la de la previa; sin previa, relleno claro', () => {
		const lecturas = [...veces(8, oscuraDeVerdad), ...veces(4, normal)];
		expect(estiloDeReferencia(lecturas)!.relleno[0]).toBeGreaterThan(95);
		expect(estiloDeReferencia(lecturas, {previa, pxPorBase})!.relleno[0]).toBeGreaterThan(95);
		const previaOscura: ReferenciaPrevia = {...previa, relleno: rgbALab([20, 20, 120]), borde: rgbALab([250, 250, 250])};
		expect(estiloDeReferencia(lecturas, {previa: previaOscura, pxPorBase})!.relleno[0]).toBeLessThan(40);
	});

	it('un reel con relleno oscuro de verdad (encerrado) se mide como es aunque la previa sea clara', () => {
		const ref = estiloDeReferencia(veces(8, oscuraDeVerdad), {previa, pxPorBase})!;
		expect(deltaE2000(ref.relleno, rgbALab([20, 20, 120]))).toBeLessThan(1);
		expect(ref.origen).toBe('reel');
	});

	it('la guía usa tu contorno de la previa si se parece al del reel; con otro estilo o sin previa, el del reel', () => {
		// Dk5Z144VKLf: la referencia del reel salió con el contorno mezclado con la playera gris oscuro.
		const refGris = {relleno: rgbALab([252, 250, 255]), borde: rgbALab(hexARgb('#19171E')), grosor: 6.25, tallo: 12.5, n: 6, origen: 'reel' as const};
		const guia = referenciaGuia(refGris, previa)!;
		expect(rgbAHex(labARgb(guia.borde))).toBe('#040001');
		expect(guia.relleno).toEqual(refGris.relleno);
		expect(guia.tallo).toBe(12.5);
		const azul = {...refGris, borde: rgbALab([20, 60, 200])};
		expect(referenciaGuia(azul, previa)).toEqual(azul);
		expect(referenciaGuia(refGris, null)).toEqual(refGris);
		expect(referenciaGuia(null, previa)).toBeNull();
	});

	it('con la guía de tu contorno negro, tu subtítulo sobre una playera gris oscuro pasa; con el gris mezclado, no', () => {
		// Contorno negro de 4 px sobre una playera #1D1B23 (las dos caen en el mismo pico de color).
		const im = imagenConHuecos({relleno: BLANCO, contorno: [3, 1, 4], fondo: () => [29, 27, 35], borde: 4, tallo: 12});
		const refGris = {relleno: rgbALab([252, 250, 255]), borde: rgbALab(hexARgb('#19171E')), grosor: 6.25, tallo: 12.5, n: 6, origen: 'reel' as const};
		expect(analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), refGris)).toBeNull();
		const g = analizarGuiado(im.px, im.w, im.h, todo(im.w, im.h), referenciaGuia(refGris, previa)!)!;
		expect(g).not.toBeNull();
		expect(g.grosor).toBeNull();
	});

	it('con previa prefiere tus colores: 3 renglones blanco/negro ganan a 6 blanco/azul (sin previa, la mayoría)', () => {
		const azul = () => lectura({borde: [20, 60, 200]});
		const lecturas = [...veces(6, azul), ...veces(3, normal)];
		expect(estiloDeReferencia(lecturas, {previa, pxPorBase})!.borde[0]).toBeLessThan(5);
		expect(estiloDeReferencia(lecturas)!.borde[0]).toBeGreaterThan(20);
	});
});
