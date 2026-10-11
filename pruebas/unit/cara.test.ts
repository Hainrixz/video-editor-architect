/**
 * Pruebas de la parte pura de la cara (herramientas/lib/cara.ts y los ayudantes de herramientas/cara.ts):
 * elección de la cara principal, interpolación, suavizado que se reinicia en los cortes, coronilla y lados
 * (silueta o fórmula), la BOCA (labios de Vision o la fórmula barbilla − k × alto, nunca arriba de la nariz),
 * barbillaMax/bocaMax/coronillaMin/cajaCabeza con zoom, detectarZooms y la verificación con el fondo, todo con datos
 * sintéticos. No llaman a Vision (no funciona dentro del sandbox) ni tocan proyectos/.
 */
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {avisosCara, cortesDelProyecto, parsearCortes, resumenZooms} from '../../herramientas/cara.ts';
import {
	barbillaMax,
	bocaCreible,
	bocaDeCuadro,
	bocaMax,
	bocaMedida,
	cajaCabeza,
	caraABase,
	cobertura,
	compararFondo,
	construirCara,
	coronillaMin,
	cortesDeTramos,
	cuantil,
	detectarZooms,
	dispersion,
	elegirBordeBarbilla,
	elegirCaras,
	emaIdaVuelta,
	estimarBoca,
	indiceTramo,
	interpolarSerie,
	leerCara,
	medianaMovil,
	normalizarCortes,
	pasoMuestreo,
	rectABase,
	rellenarHuecos,
	seleccionFfmpeg,
	SUPUESTOS,
	transformacionBase,
	type Cara,
	type CaraBase,
	type CaraConsultable,
	type CaraVision,
	type CuadroVision,
	type ImagenGris,
	type MetaVideo,
	type MuestraCara,
} from '../../herramientas/lib/cara.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';

const W = 1080;
const H = 1920;

/** Cara de Vision sintética (normalizada) con contorno, ojos y nariz alrededor de su caja. */
function caraVision(op: {x: number; y: number; w: number; h?: number; confianza?: number; barbilla?: number | null; boca?: number | null; silueta?: CaraVision['silueta']; bordes?: Array<[number, number]>}): CaraVision {
	const h = op.h ?? op.w * (W / H); // cuadrada en pixeles
	const cx = op.x + op.w / 2;
	const barbillaY = op.barbilla === undefined ? op.y + h : op.barbilla;
	// Contorno: 17 puntos en semicírculo de oreja a oreja; el más bajo en la barbilla.
	const contorno: Array<[number, number]> = [];
	for (let i = 0; i < 17; i++) {
		const a = Math.PI * (i / 16);
		contorno.push([cx - (op.w / 2) * 0.9 * Math.cos(a), op.y + h * 0.35 + ((barbillaY ?? op.y + h) - (op.y + h * 0.35)) * Math.sin(a)]);
	}
	const ojo = (dx: number): Array<[number, number]> =>
		Array.from({length: 6}, (_, i) => [cx + dx + 0.04 * op.w * Math.cos((i / 6) * 2 * Math.PI), op.y + 0.3 * h + 0.02 * h * Math.sin((i / 6) * 2 * Math.PI)]);
	const nariz: Array<[number, number]> = Array.from({length: 8}, (_, i) => [cx - 0.08 * op.w + (0.16 * op.w * i) / 7, op.y + 0.45 * h + 0.15 * h * Math.sin((i / 7) * Math.PI)]);
	return {
		x: op.x,
		y: op.y,
		w: op.w,
		h,
		confianza: op.confianza ?? 1,
		confianza_puntos: 0.9,
		roll: 0,
		yaw: 0,
		pitch: null,
		barbilla: barbillaY === null ? null : {x: cx, y: barbillaY},
		contorno: barbillaY === null ? [] : contorno,
		ojo_izq: ojo(-0.18 * op.w),
		ojo_der: ojo(0.18 * op.w),
		nariz,
		bordes_barbilla: op.bordes ?? [],
		silueta: op.silueta,
		// Sin `boca` en op: una lectura de antes de medir la boca (el campo no existe).
		...(op.boca !== undefined ? {boca: op.boca === null ? null : {x: cx, y: op.boca}} : {}),
	};
}

/** Lecturas de Vision cada `paso` cuadros de un video de 30 fps. */
function lineas(totalCuadros: number, paso: number, cara: (n: number) => CaraVision[]): CuadroVision[] {
	const r: CuadroVision[] = [];
	for (let n = 0; n < totalCuadros; n += paso) r.push({n, t: n / 30, caras: cara(n)});
	return r;
}

const meta = (cuadros: number, paso = 3, silueta = false): MetaVideo => ({
	fuente: 'sintetico.mp4',
	ancho: 720,
	alto: 1280,
	fpsVideo: 30,
	cuadrosVideo: cuadros,
	paso,
	anchoAnalisis: 720,
	altoAnalisis: 1280,
	silueta,
});

describe('utilidades', () => {
	it('cortesDeTramos: bordes de tramo del crudo → cortes en la base (s)', () => {
		const tramos: Array<[number, number]> = [
			[13, 460],
			[466, 820],
			[828, 1807],
			[1812, 2191],
		];
		expect(cortesDeTramos(tramos)).toEqual([447 / 30, 801 / 30, 1780 / 30]);
		// Dos tramos pegados son el mismo plano: no hay corte entre ellos.
		expect(cortesDeTramos([[0, 30], [30, 60], [90, 120]])).toEqual([60 / 30]);
		expect(cortesDeTramos([[0, 30]])).toEqual([]);
		expect(cortesDelProyecto(tramos)).toEqual([447 / 30, 801 / 30, 1780 / 30]);
		expect(cortesDelProyecto('basura')).toEqual([]);
	});

	it('indiceTramo: el cuadro justo en el corte ya es del tramo nuevo', () => {
		const cortes = [447 / 30, 801 / 30];
		expect(indiceTramo(446 / 30, cortes)).toBe(0);
		expect(indiceTramo(447 / 30, cortes)).toBe(1);
		expect(indiceTramo(800 / 30, cortes)).toBe(1);
		expect(indiceTramo(801 / 30, cortes)).toBe(2);
		expect(indiceTramo(0, [])).toBe(0);
	});

	it('normalizarCortes: ordena, quita repetidos y lo que cae fuera del video', () => {
		expect(normalizarCortes([3, 1, 1, 0, -2, 10, 12], 10)).toEqual([1, 3]);
	});

	it('pasoMuestreo: 30 fps → 3 (10 fps), 60 → 6, 30 a 30 fps → 1', () => {
		expect(pasoMuestreo(30)).toBe(3);
		expect(pasoMuestreo(60)).toBe(6);
		expect(pasoMuestreo(30, 30)).toBe(1);
		expect(pasoMuestreo(0)).toBe(1);
	});

	it('transformacionBase: 9:16 escala directo y otros formatos se recortan como cover', () => {
		const t = transformacionBase(720, 1280);
		expect(t.escala).toBeCloseTo(1.5);
		expect(rectABase({x: 0.5, y: 0.25, w: 0.1, h: 0.1}, t)).toEqual({x: 540, y: 480, w: 108, h: 192});
		const t45 = transformacionBase(1080, 1350); // 4:5 → se escala para cubrir 1920 de alto
		expect(t45.escala).toBeCloseTo(1920 / 1350);
		const c = rectABase({x: 0.5, y: 0.5, w: 0, h: 0}, t45);
		expect(c.x).toBeCloseTo(540);
		expect(c.y).toBeCloseTo(960);
	});

	it('cuantil y dispersion', () => {
		expect(cuantil([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(cuantil([], 0.5)).toBeNull();
		const d = dispersion([{x: 0, y: 0}, {x: 2, y: 0}, {x: 0, y: 2}, {x: 2, y: 2}])!;
		expect(d.centro).toEqual({x: 1, y: 1});
		expect(d.escala).toBeCloseTo(Math.SQRT2);
	});

	it('seleccionFfmpeg: paso y lista de cuadros', () => {
		const p = seleccionFfmpeg({tipo: 'paso', paso: 3});
		expect(p.expresion).toBe('not(mod(n,3))');
		expect(p.cuadro(4)).toBe(12);
		const l = seleccionFfmpeg({tipo: 'lista', cuadros: [40, 10, 10, 25]});
		expect(l.expresion).toBe('eq(n,10)+eq(n,25)+eq(n,40)');
		expect(l.cuadro(1)).toBe(25);
		expect(l.esperados).toBe(3);
		expect(() => seleccionFfmpeg({tipo: 'lista', cuadros: []})).toThrow(FalloEditor);
	});

	it('parsearCortes (CLI)', () => {
		expect(parsearCortes('14.9, 26.7')).toEqual([14.9, 26.7]);
		expect(parsearCortes(undefined)).toBeUndefined();
		expect(() => parsearCortes('1,abc')).toThrow(FalloEditor);
	});
});

describe('elegirCaras: la más grande y estable', () => {
	const cb = (x: number, w: number, confianza = 1): CaraBase => ({
		caja: {x, y: 500, w, h: w},
		barbilla: {x: x + w / 2, y: 500 + w},
		boca: null,
		ojos_y: 500 + 0.3 * w,
		nariz_y: null,
		bordes_barbilla: [],
		confianza,
		escala_puntos: null,
		centro_puntos: null,
		contorno_x: null,
		silueta: null,
	});

	it('elige la más grande y descarta la de baja confianza', () => {
		const r = elegirCaras([{tramo: 0, caras: [cb(100, 120), cb(400, 400), cb(50, 600, 0.3)]}]);
		expect(r[0]!.caja.w).toBe(400);
	});

	it('se queda con la que sigue (×2) aunque aparezca otra un poco más grande', () => {
		const muestras = [
			{tramo: 0, caras: [cb(100, 400)]},
			{tramo: 0, caras: [cb(105, 400), cb(600, 420)]}, // la nueva es 10 % más grande en área: no cambia
			{tramo: 0, caras: [cb(110, 400), cb(600, 700)]}, // la nueva es 3× en área: cambia
		];
		const r = elegirCaras(muestras);
		expect(r[1]!.caja.x).toBe(105);
		expect(r[2]!.caja.x).toBe(600);
	});

	it('tras un corte no hay continuidad: gana la más grande', () => {
		const r = elegirCaras([
			{tramo: 0, caras: [cb(100, 400)]},
			{tramo: 1, caras: [cb(105, 400), cb(600, 420)]},
		]);
		expect(r[1]!.caja.x).toBe(600);
	});

	it('una cara chica sola (captura, fondo) no cuenta como la principal', () => {
		const muestras = [...Array.from({length: 5}, () => ({tramo: 0, caras: [cb(100, 400)]})), {tramo: 0, caras: [cb(500, 100)]}];
		const r = elegirCaras(muestras);
		expect(r[5]).toBeNull();
		expect(r[0]).not.toBeNull();
	});
});

describe('elegirBordeBarbilla: la orilla de abajo de la barba', () => {
	// Ojos en 700 y barbilla del contorno en 1100: F = 400 px; rango aceptado de −12 a +60 px.
	it('baja la barbilla al primer borde claro dentro del rango', () => {
		expect(elegirBordeBarbilla(1100, 700, [{y: 1130, fuerza: 30}])).toBe(1130);
		expect(elegirBordeBarbilla(1100, 700, [{y: 1110, fuerza: 8}, {y: 1140, fuerza: 25}])).toBe(1140); // el débil no cuenta
		expect(elegirBordeBarbilla(1100, 700, [{y: 1095, fuerza: 20}])).toBe(1100); // arriba del contorno: nunca sube
	});

	it('si el primer borde claro cae muy abajo (brazo, mano, tarjeta), se queda el contorno', () => {
		expect(elegirBordeBarbilla(1100, 700, [{y: 1180, fuerza: 40}])).toBeNull();
		expect(elegirBordeBarbilla(1100, 700, [{y: 1180, fuerza: 40}, {y: 1130, fuerza: 30}])).toBe(1130); // se ordenan de arriba abajo
		expect(elegirBordeBarbilla(1100, 700, [{y: 1050, fuerza: 40}])).toBeNull(); // muy arriba: fuera del rango
		expect(elegirBordeBarbilla(1100, null, [{y: 1130, fuerza: 30}])).toBeNull();
		expect(elegirBordeBarbilla(1100, 700, [])).toBeNull();
	});

	it('construirCara usa el borde y guarda la barbilla del contorno', () => {
		// Barbilla del contorno en y=0.5 (960 px); ojos ≈ y 0.3+0.3·h; borde 12 px más abajo.
		const l = lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4, barbilla: 0.5, bordes: [[(960 + 12) / H, 30]]})]);
		const c = construirCara(l, meta(30));
		expect(c.muestras[0].barbilla_contorno_y).toBeCloseTo(960, 0);
		expect(c.muestras[0].barbilla_y).toBeCloseTo(972, 0);
		expect(c.muestras[0].barbilla_borde).toBe(true);
		expect(c.cuadros[10].barbilla_y).toBeCloseTo(972, 0);
		expect(c.resumen.barbillas_borde).toBe(10);
		expect(c.resumen.barbilla_borde_px.p50).toBeCloseTo(12, 0);
	});
});

describe('series: relleno, mediana, EMA e interpolación', () => {
	it('rellenarHuecos: rellena ≤ max en el mismo segmento, nunca a través de un corte', () => {
		const s = [[0], null, null, [3], null, [5], null, null, null, null, [10]];
		const segs = [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
		const r = rellenarHuecos(s, segs, 3);
		expect(r.serie[1]).toEqual([1]);
		expect(r.serie[2]).toEqual([2]);
		expect(r.serie[4]).toBeNull(); // entre [3] (seg 0) y [5] (seg 1): cruza un corte
		expect(r.serie[6]).toBeNull(); // hueco de 4 > 3
		expect(r.rellenadas.filter(Boolean)).toHaveLength(2);
		const noMisma = rellenarHuecos([[0], null, [100]], [0, 0, 0], 3, () => false);
		expect(noMisma.serie[1]).toBeNull();
	});

	it('medianaMovil: quita una lectura suelta y no mezcla segmentos', () => {
		const s = [[10], [10], [90], [10], [10], [50], [50]];
		const segs = [0, 0, 0, 0, 0, 1, 1];
		const r = medianaMovil(s, segs, 3);
		expect(r[2]).toEqual([10]);
		expect(r[4]).toEqual([10]); // su vecino del otro segmento (50) no entra
		expect(r[5]).toEqual([50]);
	});

	it('emaIdaVuelta: suaviza un escalón dentro de un tramo, sin retraso (simétrico)', () => {
		const s = Array.from({length: 20}, (_, i) => [i < 10 ? 0 : 100]);
		const r = emaIdaVuelta(s, s.map(() => 0), 0.4);
		expect(r[9]![0]).toBeGreaterThan(5);
		expect(r[10]![0]).toBeLessThan(95);
		// Fase cero: el escalón suavizado queda centrado entre los cuadros 9 y 10.
		expect(r[9]![0] + r[10]![0]).toBeCloseTo(100, 0);
		expect(r[0]![0]).toBeCloseTo(0, 0);
		expect(r[19]![0]).toBeGreaterThan(99); // la orilla de la racha queda a <1 % (la EMA de ida aún no llega del todo)
	});

	it('emaIdaVuelta: se REINICIA en cada corte (el escalón en el corte queda seco)', () => {
		const s = Array.from({length: 20}, (_, i) => [i < 10 ? 0 : 100]);
		const segs = s.map((_, i) => (i < 10 ? 0 : 1));
		const r = emaIdaVuelta(s, segs, 0.4);
		expect(r[9]).toEqual([0]);
		expect(r[10]).toEqual([100]);
	});

	it('interpolarSerie: línea recta, orillas sostenidas y nunca a través de un corte', () => {
		const muestras = [
			{t: 0, seg: 0, v: [0]},
			{t: 0.1, seg: 0, v: [30]},
			{t: 0.2, seg: 1, v: [90]},
			{t: 0.3, seg: 1, v: null},
			{t: 0.4, seg: 1, v: null},
		];
		const salida = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((j) => ({t: j / 30, seg: j / 30 < 0.15 ? 0 : 1}));
		const r = interpolarSerie(muestras, salida, 0.1);
		expect(r[0]).toEqual([0]);
		expect(r[1]![0]).toBeCloseTo(10);
		expect(r[3]).toEqual([30]);
		expect(r[4]).toEqual([30]); // después de la última del tramo 0: se sostiene (≤ 0.1 s)
		expect(r[5]).toEqual([90]); // ya es del tramo 1: antes de su primera muestra, se sostiene
		expect(r[6]).toEqual([90]);
		expect(r[7]).toEqual([90]); // 0.233: la más cercana es la de 0.2 (con valor)
		expect(r[8]).toBeNull(); // 0.267: la más cercana es la nula de 0.3
		expect(r[12]).toBeNull();
	});
});

describe('construirCara (de lecturas de Vision a cara.json)', () => {
	it('interpola a 30 fps y el suavizado se reinicia en el corte', () => {
		// 3 s (90 cuadros), corte en 1.5 s: antes la barbilla en y=0.5 (960 px), después en y=0.6 (1152 px).
		const l = lineas(90, 3, (n) => [caraVision(n < 45 ? {x: 0.3, y: 0.3, w: 0.4, barbilla: 0.5} : {x: 0.3, y: 0.4, w: 0.4, barbilla: 0.6})]);
		const c = construirCara(l, meta(90), {cortes: [1.5]});
		expect(c.cuadros).toHaveLength(90);
		expect(c.fps_muestreo).toBe(10);
		expect(c.resumen.cobertura).toBe(1);
		expect(c.cortes_s).toEqual([1.5]);
		expect(c.cuadros[44].barbilla_y).toBeCloseTo(960, 0);
		expect(c.cuadros[45].barbilla_y).toBeCloseTo(1152, 0);
		expect(c.cuadros[46].barbilla_y).toBeCloseTo(1152, 0);
		// Sin el corte, el mismo salto se suaviza (hay valores intermedios).
		const sinCorte = construirCara(l, meta(90));
		const intermedios = sinCorte.cuadros.filter((q) => q.barbilla_y! > 965 && q.barbilla_y! < 1147);
		expect(intermedios.length).toBeGreaterThan(0);
		expect(c.resumen.barbilla_y.max).toBeCloseTo(1152, 0);
		expect(c.resumen.cuadros_sin_cara).toBe(0);
	});

	it('rellena huecos cortos y deja sin cara los largos', () => {
		const l = lineas(90, 3, (n) => ((n >= 30 && n < 36) || (n >= 60 && n < 81) ? [] : [caraVision({x: 0.3, y: 0.3, w: 0.4})]));
		const c = construirCara(l, meta(90));
		expect(c.resumen.muestras_rellenadas).toBe(2); // 30 y 33
		expect(c.cuadros[31].cara).not.toBeNull();
		expect(c.cuadros[31].confianza).toBe(0); // rellenado: sin detección directa
		expect(c.cuadros[70].cara).toBeNull(); // hueco de 7 muestras: no se rellena
		expect(c.resumen.cobertura).toBeLessThan(1);
		expect(c.resumen.cuadros_sin_cara).toBe(c.cuadros.filter((q) => q.cara === null).length);
	});

	it('coronilla y lados: medidos con la silueta si es creíble; si no, la fórmula', () => {
		const silueta = {tope: 0.25, izq: 0.28, der: 0.72};
		const l = lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4, silueta})]);
		const c = construirCara(l, meta(30, 3, true));
		const q = c.cuadros[15];
		expect(q.coronilla_y).toBeCloseTo(0.25 * H, 0);
		expect(q.cabeza!.x).toBeCloseTo(0.28 * W, 0);
		expect(q.cabeza!.x + q.cabeza!.w).toBeCloseTo(0.72 * W, 0);
		expect(c.resumen.coronillas_medidas).toBe(10);
		expect(c.resumen.factores.coronilla.fuente).toBe('silueta (este video)');

		// Sin silueta: coronilla = tope de la caja − 0.30 × alto (supuesto).
		const sin = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4})]), meta(30));
		const caja = sin.cuadros[15].cara!;
		expect(sin.cuadros[15].coronilla_y).toBeCloseTo(caja.y - SUPUESTOS.coronilla_factor * caja.h, 0);
		expect(sin.resumen.factores.coronilla).toEqual({valor: SUPUESTOS.coronilla_factor, n: 0, fuente: 'supuesto'});

		// Una silueta absurda (una mano arriba de la cabeza) no se cree: se usa la fórmula con el factor del video.
		const l2 = lineas(60, 3, (n) => [caraVision({x: 0.3, y: 0.3, w: 0.4, silueta: n === 30 ? {tope: 0.02, izq: 0.28, der: 0.72} : silueta})]);
		const c2 = construirCara(l2, meta(60, 3, true));
		const m30 = c2.muestras.find((m) => m.n === 30)!;
		expect(m30.coronilla_medida).toBe(false);
		expect(m30.coronilla_y).toBeCloseTo(c2.muestras[0].coronilla_y!, 0);
	});

	it('sin contorno, la barbilla se estima con la caja', () => {
		const c = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4, barbilla: null})]), meta(30));
		expect(c.resumen.barbillas_estimadas).toBe(10);
		const caja = c.cuadros[0].cara!;
		expect(c.cuadros[0].barbilla_y).toBeCloseTo(caja.y + SUPUESTOS.barbilla_sin_contorno * caja.h, 0);
	});

	it('una cara de fondo chica no cambia la principal', () => {
		const l = lineas(30, 3, (n) => [caraVision({x: 0.3, y: 0.3, w: 0.4}), ...(n === 15 ? [caraVision({x: 0.8, y: 0.1, w: 0.08})] : [])]);
		const c = construirCara(l, meta(30));
		expect(c.resumen.muestras_varias_caras).toBe(1);
		expect(c.cuadros[15].cara!.x).toBeCloseTo(0.3 * W, 0);
	});

	// Boca (zona protegida, director v2). Con x 0.3, y 0.3, w 0.4 en 720×1280 → base: caja y 576, alto 432; barbilla
	// 1008; ojos 705.6; punta de la nariz 835.2. Labios en y 0.48 → 921.6 px (k = (1008 − 921.6) / 432 = 0.2).
	it('boca: el punto más bajo de los labios, por muestra y a 30 fps, con su factor medido en el video', () => {
		const c = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4, boca: 0.48})]), meta(30));
		expect(c.muestras[0].boca_y).toBeCloseTo(921.6, 0);
		expect(c.muestras[0].boca_medida).toBe(true);
		expect(c.cuadros[10].boca_y).toBeCloseTo(921.6, 0);
		expect(c.resumen.bocas_medidas).toBe(10);
		expect(c.resumen.factores.boca).toEqual({valor: 0.2, n: 10, fuente: 'labios (este video)'});
		expect(c.resumen.boca_y!.p50).toBeCloseTo(921.6, 0);
		for (const q of c.cuadros) expect(q.boca_y!).toBeLessThan(q.barbilla_y!);
	});

	it('boca: el suavizado se reinicia en el corte, igual que la barbilla', () => {
		const l = lineas(90, 3, (n) => [caraVision(n < 45 ? {x: 0.3, y: 0.3, w: 0.4, boca: 0.48} : {x: 0.3, y: 0.4, w: 0.4, barbilla: 0.625, boca: 0.58})]);
		const c = construirCara(l, meta(90), {cortes: [1.5]});
		expect(c.cuadros[44].boca_y).toBeCloseTo(921.6, 0);
		expect(c.cuadros[45].boca_y).toBeCloseTo(0.58 * H, 0);
		const sinCorte = construirCara(l, meta(90));
		expect(sinCorte.cuadros.some((q) => q.boca_y! > 925 && q.boca_y! < 0.58 * H - 4)).toBe(true);
	});

	it('boca: unos labios arriba de la nariz no se creen (fórmula con el factor del video) y nunca queda arriba de la nariz', () => {
		// 9 muestras creíbles y una absurda (labios en 768 px, arriba de la punta de la nariz en 835.2).
		const l = lineas(30, 3, (n) => [caraVision({x: 0.3, y: 0.3, w: 0.4, boca: n === 15 ? 0.4 : 0.48})]);
		const c = construirCara(l, meta(30));
		const m15 = c.muestras.find((m) => m.n === 15)!;
		expect(m15.boca_medida).toBe(false);
		expect(m15.boca_y).toBeCloseTo(1008 - 0.2 * 432, 0);
		// Todas absurdas: no hay factor del video, va el supuesto (0.18), y la boca queda abajo de la nariz.
		const todas = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4, boca: 0.4})]), meta(30));
		expect(todas.resumen.factores.boca).toMatchObject({valor: SUPUESTOS.boca_factor, fuente: 'supuesto'});
		expect(todas.muestras[0].boca_y).toBeCloseTo(1008 - 0.18 * 432, 0);
		expect(todas.muestras[0].boca_y!).toBeGreaterThan(835.2);
	});

	it('boca: lecturas de antes (sin labios) usan barbilla − 0.18 × alto de la caja', () => {
		const c = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4})]), meta(30));
		expect(c.resumen.bocas_medidas).toBe(0);
		expect(c.resumen.factores.boca!.fuente).toBe('supuesto');
		expect(c.cuadros[0].boca_y).toBeCloseTo(1008 - 0.18 * 432, 0);
	});

	it('caraABase pasa los puntos y la silueta a px base', () => {
		const cb = caraABase(caraVision({x: 0.25, y: 0.25, w: 0.5, silueta: {tope: 0.1, izq: null, der: 0.8}}), transformacionBase(720, 1280));
		expect(cb.caja.x).toBeCloseTo(270);
		expect(cb.silueta).toEqual({tope: 192, izq: null, der: 864});
		expect(cb.escala_puntos).toBeGreaterThan(0);
		expect(cb.contorno_x![0]).toBeLessThan(cb.contorno_x![1]);
	});
});

describe('consultas por ventana con zoom', () => {
	// 3 s a 30 fps; barbilla 1000 px, coronilla 400, cabeza de 300 a 700; en 2.0–2.5 s la barbilla baja a 1100.
	const cuadros: CaraConsultable['cuadros'] = Array.from({length: 90}, (_, j) => {
		const barbilla = j >= 60 && j < 75 ? 1100 : 1000;
		return {t: j / 30, cara: {x: 340, y: 450, w: 320, h: 320}, barbilla_y: barbilla, coronilla_y: 400, cabeza: {x: 300, y: 400, w: 400, h: barbilla - 400}};
	});
	const cara: CaraConsultable = {fps: 30, cuadros};

	it('barbillaMax usa la ventana t0 − 0.2 … t1 + 0.2', () => {
		expect(barbillaMax(cara, 0.5, 1.0)).toBe(1000);
		expect(barbillaMax(cara, 1.0, 1.8)).toBe(1100); // 1.8 + 0.2 = 2.0 → toca el cuadro 60
		expect(barbillaMax(cara, 1.0, 1.75)).toBe(1000); // hasta 1.95: no lo toca
		expect(barbillaMax(cara, 2.6, 2.8)).toBe(1100); // desde 2.4: toca los cuadros 72–74
		expect(barbillaMax(cara, 2.7, 2.8)).toBe(1000); // desde 2.5 (cuadro 75): ya pasó
		expect(barbillaMax(cara, 1.0, 1.8, null, {margen_s: 0})).toBe(1000); // sin margen
	});

	it('barbillaMax aplica el zoom alrededor de su origen', () => {
		const z = {escala: 1.2, origen: {x: 540, y: 600}};
		// y' = 600 + (1000 − 600) × 1.2 = 1080
		expect(barbillaMax(cara, 0.5, 1.0, z)).toBeCloseTo(1080);
		// Zoom con tiempos: fuera de su rango no aplica.
		expect(barbillaMax(cara, 0.5, 1.0, {...z, desde: 2.6, hasta: 3, transicion: 'corte'})).toBe(1000);
		expect(barbillaMax(cara, 2.75, 2.9, {...z, desde: 2.6, hasta: 3, transicion: 'corte'})).toBeCloseTo(1080);
		// Con origen abajo de la barbilla, el zoom la SUBE; con "suave" cuenta también la escala 1 (sin zoom).
		const abajo = {escala: 1.5, origen: {x: 540, y: 1600}, desde: 0, hasta: 3};
		expect(barbillaMax(cara, 0.5, 1.0, {...abajo, transicion: 'corte'})).toBeCloseTo(1600 + (1000 - 1600) * 1.5);
		expect(barbillaMax(cara, 0.5, 1.0, {...abajo, transicion: 'suave'})).toBe(1000);
	});

	it('coronillaMin y cajaCabeza con zoom', () => {
		const z = {escala: 1.25, origen: {x: 500, y: 800}};
		expect(coronillaMin(cara, 0, 3)).toBe(400);
		expect(coronillaMin(cara, 0, 3, z)).toBeCloseTo(800 + (400 - 800) * 1.25); // 300
		expect(cajaCabeza(cara, 0.5, 1)).toEqual({x: 300, y: 400, w: 400, h: 600});
		const k = cajaCabeza(cara, 0.5, 1, z)!;
		expect(k.x).toBeCloseTo(500 + (300 - 500) * 1.25);
		expect(k.w).toBeCloseTo(400 * 1.25);
		expect(k.y).toBeCloseTo(300);
		expect(k.h).toBeCloseTo(600 * 1.25);
	});

	it('bocaMax: ventana ±0.2 s y zoom como la barbilla; un cara.json sin boca la estima (barbilla − 0.18 × alto)', () => {
		// Boca 880 px; en 2.0–2.5 s baja a 960 (la cabeza bajó).
		const conBoca: CaraConsultable = {fps: 30, cuadros: cuadros.map((c, j) => ({...c, boca_y: j >= 60 && j < 75 ? 960 : 880}))};
		expect(bocaMedida(conBoca)).toBe(true);
		expect(bocaMax(conBoca, 0.5, 1.0)).toBe(880);
		expect(bocaMax(conBoca, 1.0, 1.8)).toBe(960);
		expect(bocaMax(conBoca, 1.0, 1.75)).toBe(880);
		expect(bocaMax(conBoca, 0.5, 1.0, {escala: 1.2, origen: {x: 540, y: 600}})).toBeCloseTo(600 + (880 - 600) * 1.2);
		expect(bocaDeCuadro(conBoca.cuadros[0])).toEqual({y: 880, estimada: false});
		// cara.json viejo: sin boca_y → barbilla − 0.18 × alto de la caja (320).
		expect(bocaMedida(cara)).toBe(false);
		expect(bocaMax(cara, 0.5, 1.0)).toBeCloseTo(1000 - 0.18 * 320, 1);
		expect(bocaDeCuadro(cara.cuadros[0])).toEqual({y: 1000 - 0.18 * 320, estimada: true});
		expect(estimarBoca(1000, 320)).toBeCloseTo(942.4, 6);
	});

	it('bocaCreible: abajo de la nariz y de los ojos y arriba de la barbilla', () => {
		const base = {boca: {x: 0, y: 900}, barbilla: {x: 0, y: 1000}, nariz_y: 850, ojos_y: 700};
		expect(bocaCreible(base)).toBe(true);
		expect(bocaCreible({...base, boca: {x: 0, y: 840}})).toBe(false);
		expect(bocaCreible({...base, boca: {x: 0, y: 1010}})).toBe(false);
		expect(bocaCreible({...base, boca: null})).toBe(false);
		expect(bocaCreible({...base, nariz_y: null, ojos_y: null})).toBe(true);
	});

	it('sin cara en la ventana devuelve null; cobertura cuenta cuadros con cara', () => {
		const vacia: CaraConsultable = {fps: 30, cuadros: Array.from({length: 30}, (_, j) => ({t: j / 30, cara: null, barbilla_y: null, coronilla_y: null}))};
		expect(barbillaMax(vacia, 0, 1)).toBeNull();
		expect(bocaMax(vacia, 0, 1)).toBeNull();
		expect(coronillaMin(vacia, 0, 1)).toBeNull();
		expect(cajaCabeza(vacia, 0, 1)).toBeNull();
		expect(cobertura(vacia)).toBe(0);
		expect(cobertura(cara)).toBe(1);
	});
});

describe('detectarZooms (muestras a los fps nativos)', () => {
	/** Muestras a 30 fps de una cara con escala dada por cuadro (el zoom escala caja, puntos y centro alrededor de o). */
	function muestras(escala: (n: number) => number, op: {o?: {x: number; y: number}; tramo?: (n: number) => number; cajaFija?: (n: number) => boolean; total?: number} = {}): Pick<Cara, 'muestras' | 'fps_muestreo'> {
		const o = op.o ?? {x: 540, y: 700};
		const m: MuestraCara[] = Array.from({length: op.total ?? 120}, (_, n) => {
			const s = escala(n);
			const sc = op.cajaFija?.(n) ? 1 : s;
			const caja = {x: o.x + (300 - o.x) * sc, y: o.y + (500 - o.y) * sc, w: 400 * sc, h: 400 * sc};
			return {
				n,
				t: n / 30,
				tramo: op.tramo?.(n) ?? 0,
				cara: caja,
				barbilla_y: caja.y + caja.h,
				barbilla_contorno_y: caja.y + caja.h,
				barbilla_borde: false,
				barbilla_estimada: false,
				boca_y: caja.y + 0.8 * caja.h,
				boca_medida: true,
				coronilla_y: caja.y - 120,
				coronilla_medida: true,
				lados: [caja.x, caja.x + caja.w],
				lados_medidos: true,
				escala_puntos: 140 * s,
				centro_puntos: {x: o.x + (500 - o.x) * s, y: o.y + (720 - o.y) * s},
				confianza: 1,
				caras: 1,
			};
		});
		return {muestras: m, fps_muestreo: 30};
	}

	it('un zoom de edición ×1.2 entre los cuadros 40 y 80: acercar y alejar, con su origen', () => {
		const z = detectarZooms(muestras((n) => (n >= 40 && n < 80 ? 1.2 : 1)));
		expect(z).toHaveLength(2);
		expect(z[0]).toMatchObject({n: 40, n_antes: 39, tipo: 'acercar', confirmado: true, descarte: null, origen_plausible: true});
		expect(z[0].razon).toBeCloseTo(1.2, 3);
		expect(z[0].origen!.x).toBeCloseTo(540, 0);
		expect(z[0].origen!.y).toBeCloseTo(700, 0);
		expect(z[1]).toMatchObject({n: 80, tipo: 'alejar'});
		expect(z[1].razon).toBeCloseTo(1 / 1.2, 3);
	});

	it('un pico de un cuadro, el ruido y un salto en un corte no cuentan', () => {
		expect(detectarZooms(muestras((n) => (n === 50 ? 1.12 : 1)))).toHaveLength(0);
		const todos = detectarZooms(muestras((n) => (n === 50 ? 1.12 : 1)), {todos: true});
		expect(todos.map((x) => x.descarte)).toEqual(['pico', 'pico']);
		expect(detectarZooms(muestras((n) => 1 + 0.02 * Math.sin(n)))).toHaveLength(0);
		expect(detectarZooms(muestras((n) => (n >= 60 ? 1.3 : 1), {tramo: (n) => (n >= 60 ? 1 : 0)}))).toHaveLength(0);
	});

	it('si la caja no acompaña (una mano desacomoda el contorno), no es zoom', () => {
		const t = detectarZooms(muestras((n) => (n >= 40 ? 1.1 : 1), {cajaFija: () => true}), {todos: true});
		expect(t).toHaveLength(1);
		expect(t[0].descarte).toBe('caja-no-acompana');
	});

	it('un salto en la última muestra no se puede confirmar', () => {
		const t = detectarZooms(muestras((n) => (n >= 119 ? 1.2 : 1)), {todos: true});
		expect(t[0].descarte).toBe('sin-confirmar');
		expect(detectarZooms(muestras((n) => (n >= 119 ? 1.2 : 1)))).toHaveLength(0);
	});
});

describe('compararFondo (¿el fondo también se escaló?)', () => {
	const ancho = 270;
	const alto = 480;
	/** Fondo con textura (función continua: se puede "acercar" sin errores de remuestreo). */
	const g = (x: number, y: number) => 128 + 50 * Math.sin(x / 6) + 40 * Math.cos(y / 8) + 25 * Math.sin((x + 2 * y) / 11);
	const imagen = (f: (x: number, y: number) => number): ImagenGris => {
		const datos = new Uint8Array(ancho * alto);
		for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) datos[y * ancho + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
		return {ancho, alto, datos};
	};
	const zona = {cabeza: {izq: 380, der: 700, arriba: 500, abajo: 1100}, razon: 1.15, origen: {x: 540, y: 800}};
	const antes = imagen(g);

	it('un zoom digital ×1.15 se confirma y se recupera su escala', () => {
		const k = 270 / 1080;
		const ox = 540 * k;
		const oy = 800 * k;
		const despues = imagen((x, y) => g(ox + (x - ox) / 1.15, oy + (y - oy) / 1.15));
		const v = compararFondo(antes, despues, zona);
		expect(v.veredicto).toBe('zoom');
		expect(v.escala).toBeCloseTo(1.15, 2);
		expect(v.dif_zoom).toBeLessThan(v.dif_igual * 0.6);
	});

	it('un titular fijo encima (el zoom no lo escala) no tapa el zoom', () => {
		const k = 270 / 1080;
		const ox = 540 * k;
		const oy = 800 * k;
		const titular = (x: number, y: number) => y >= 60 && y < 110 && x > 40 && x < 230;
		const antesConTitular = imagen((x, y) => (titular(x, y) ? 240 : g(x, y)));
		const despues = imagen((x, y) => (titular(x, y) ? 240 : g(ox + (x - ox) / 1.15, oy + (y - oy) / 1.15)));
		expect(compararFondo(antesConTitular, despues, zona).veredicto).toBe('zoom');
	});

	it('si el fondo solo cambia como el ruido de la misma toma, no es zoom', () => {
		let semilla = 7;
		const azar = () => {
			semilla = (semilla * 1103515245 + 12345) % 2147483648;
			return semilla / 2147483648;
		};
		const ruidoso = () => imagen((x, y) => g(x, y) + (azar() - 0.5) * 8);
		const v = compararFondo(ruidoso(), ruidoso(), zona, ruidoso());
		expect(v.dif_ruido).not.toBeNull();
		expect(v.veredicto).toBe('sin-zoom');
	});

	it('un corte con la cámara fija (fondo igual) no es zoom', () => {
		const v = compararFondo(antes, imagen(g), zona);
		expect(v.veredicto).toBe('sin-zoom');
		expect(v.dif_igual).toBe(0);
	});

	it('un fondo liso no deja decidir', () => {
		const liso = imagen(() => 128);
		expect(compararFondo(liso, liso, zona).veredicto).toBe('dudoso');
	});
});

describe('archivo cara.json y mensajes de la CLI', () => {
	const dir = mkdtempSync(join(tmpdir(), 'cara-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it('leerCara valida el archivo y falla con el código correcto', () => {
		const c = construirCara(lineas(30, 3, () => [caraVision({x: 0.3, y: 0.3, w: 0.4})]), meta(30));
		const ruta = join(dir, 'cara.json');
		writeFileSync(ruta, JSON.stringify(c));
		const leida = leerCara(ruta);
		expect(leida.cuadros).toHaveLength(30);
		expect(leida.resumen.cobertura).toBe(1);
		const mala = join(dir, 'mala.json');
		writeFileSync(mala, JSON.stringify({version: 1, fuente: 'x'}));
		const capturar = (f: () => unknown): FalloEditor | null => {
			try {
				f();
				return null;
			} catch (e) {
				return e as FalloEditor;
			}
		};
		expect(capturar(() => leerCara(mala))).toBeInstanceOf(FalloEditor);
		expect(capturar(() => leerCara(mala))?.codigo).toBe(1);
		expect(capturar(() => leerCara(join(dir, 'no-existe.json')))?.codigo).toBe(2);
	});

	it('avisa si hay cara en menos del 80 % de los cuadros (sin fallar)', () => {
		const c = construirCara(lineas(90, 3, (n) => (n < 45 ? [caraVision({x: 0.3, y: 0.3, w: 0.4})] : [])), meta(90));
		expect(c.resumen.cobertura).toBeLessThan(0.8);
		expect(avisosCara(c).some((a) => a.includes('solo hay cara en el'))).toBe(true);
		const vacia = construirCara(lineas(30, 3, () => []), meta(30));
		expect(avisosCara(vacia).some((a) => a.includes('sandbox'))).toBe(true);
		expect(resumenZooms(vacia, [])).toContain('ninguno');
	});
});
