// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/grabador/zoom-plan.ts:
 * - Escala = clamp(0.7 · min(vistaW/cajaW, vistaH/cajaH), 1, 2.5).
 * - Entra 400–500 ms antes del clic, se mantiene 1–1.5 s, paneo si el siguiente evento llega pronto.
 * - Cajas en orillas y esquinas (encuadre horizontal y vertical): en el clic la caja cruza la vista y su centro
 *   cae dentro (salvo vista limitada en la orilla), y la vista nunca sale del cuadro.
 * - Resorte críticamente amortiguado: sin rebote. Cálculo determinista (cualquier orden de cuadros).
 * - Cursor sintético y onda de clic.
 */
import {describe, expect, it} from 'vitest';
import {
	aspectoDeEncuadre,
	escalaParaCaja,
	evaluarCamara,
	limitarCentro,
	ondasActivas,
	planDeZoom,
	posicionCursor,
	revisarClic,
	vistaBase,
	ZOOM,
	type PlanZoom,
} from '../../herramientas/grabador/zoom-plan.ts';
import {ESTILO_DEMO, type EventoDemo} from '../../src/estilo/demo.ts';

const ANCHO = 2560;
const ALTO = 1600;
const ENCUADRES = [
	{nombre: 'horizontal 16:10', aspecto: aspectoDeEncuadre('horizontal', ANCHO, ALTO)},
	{nombre: 'vertical 9:16', aspecto: aspectoDeEncuadre('vertical', ANCHO, ALTO)},
	{nombre: 'tarjeta vertical 4:5', aspecto: aspectoDeEncuadre('vertical', ANCHO, ALTO, {ancho: 900, alto: 1125})},
];

const clic = (t: number, x: number, y: number, w = 120, h = 40): EventoDemo => ({t, tipo: 'clic', caja: {x, y, w, h}});
const plan = (eventos: EventoDemo[], aspecto = ANCHO / ALTO): PlanZoom => planDeZoom(eventos, {ancho: ANCHO, alto: ALTO, aspecto});
const motivos = (p: PlanZoom) => p.objetivos.map((o) => o.motivo);
const tiempos = (p: PlanZoom) => p.objetivos.map((o) => Math.round(o.t * 1000) / 1000);

/** Generador con semilla fija (mulberry32). */
function azar(semilla: number): () => number {
	let a = semilla >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function vistaDentroDelCuadro(p: PlanZoom, desde: number, hasta: number): void {
	for (let t = desde; t <= hasta; t += 1 / 30) {
		const c = evaluarCamara(p, t);
		expect(c.x).toBeGreaterThanOrEqual(-1e-6);
		expect(c.y).toBeGreaterThanOrEqual(-1e-6);
		expect(c.x + c.w).toBeLessThanOrEqual(ANCHO + 1e-6);
		expect(c.y + c.h).toBeLessThanOrEqual(ALTO + 1e-6);
		expect(c.escala).toBeGreaterThanOrEqual(1);
		expect(c.escala).toBeLessThanOrEqual(ZOOM.escala_max + 1e-9);
	}
}

describe('escala y vista base', () => {
	it('la vista base es el rectángulo más grande con el aspecto pedido', () => {
		expect(vistaBase(ANCHO, ALTO, 1.6)).toEqual({w: 2560, h: 1600});
		expect(vistaBase(ANCHO, ALTO, 9 / 16)).toEqual({w: 900, h: 1600});
		expect(vistaBase(ANCHO, ALTO, 0.8)).toEqual({w: 1280, h: 1600});
		expect(vistaBase(ANCHO, ALTO, 2)).toEqual({w: 2560, h: 1280});
	});

	it('escala = clamp(0.7 · min(vistaW/cajaW, vistaH/cajaH), 1, 2.5)', () => {
		const base = {w: 2560, h: 1600};
		expect(escalaParaCaja({x: 0, y: 0, w: 120, h: 40}, base)).toBe(2.5);
		expect(escalaParaCaja({x: 0, y: 0, w: 1200, h: 400}, base)).toBeCloseTo(0.7 * (2560 / 1200), 9);
		expect(escalaParaCaja({x: 0, y: 0, w: 2400, h: 1500}, base)).toBe(1);
		expect(escalaParaCaja({x: 0, y: 0, w: 0, h: 0}, base)).toBe(2.5);
	});

	it('limitarCentro lleva la vista adentro del cuadro y avisa', () => {
		expect(limitarCentro(10, 10, 1024, 640, ANCHO, ALTO)).toEqual({cx: 512, cy: 320, limitada: true});
		expect(limitarCentro(1280, 800, 1024, 640, ANCHO, ALTO)).toEqual({cx: 1280, cy: 800, limitada: false});
	});

	it('opciones rotas fallan con un mensaje en español', () => {
		expect(() => planDeZoom([], {ancho: 0, alto: ALTO, aspecto: 1})).toThrow(/No pude planear el zoom/);
	});
});

describe('tiempos del zoom', () => {
	it('entra 400–500 ms antes del clic y se mantiene 1–1.5 s', () => {
		const p = plan([clic(2, 1000, 500)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida']);
		const [, entra, sale] = p.objetivos;
		expect(2 - entra.t).toBeGreaterThanOrEqual(0.4);
		expect(2 - entra.t).toBeLessThanOrEqual(0.5);
		expect(sale.t - 2).toBeGreaterThanOrEqual(1);
		expect(sale.t - 2).toBeLessThanOrEqual(1.5);
		expect(entra.escala).toBe(2.5);
		expect(sale.escala).toBe(1);
	});

	it('si el siguiente clic llega en menos de 1.2 s, paneo (sin alejarse)', () => {
		const p = plan([clic(2, 300, 300), clic(2.8, 2000, 1200)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'paneo', 'salida']);
		expect(tiempos(p)).toEqual([0, 1.55, 2.35, 4]);
	});

	it('si el siguiente clic llega lejos, se aleja entre los dos', () => {
		const p = plan([clic(2, 300, 300), clic(6, 2000, 1200)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida', 'clic', 'salida']);
		expect(tiempos(p)).toEqual([0, 1.55, 3.2, 5.55, 7.2]);
	});

	it('si no caben 1 s de sostén + 0.3 s en la vista completa + la entrada, también hace paneo (1.5 s)', () => {
		expect(motivos(plan([clic(2, 300, 300), clic(3.5, 2000, 1200)]))).toEqual(['inicio', 'clic', 'paneo', 'salida']);
		// Con 1.8 s sí cabe: sale y vuelve a entrar, con la salida antes de la siguiente entrada.
		const p = plan([clic(2, 300, 300), clic(3.8, 2000, 1200)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida', 'clic', 'salida']);
		expect(p.objetivos[2].t).toBeLessThanOrEqual(p.objetivos[3].t - ZOOM.estancia_min_s + 1e-9);
		expect(p.objetivos[2].t - 2).toBeGreaterThanOrEqual(1);
	});

	it('un scroll o una navegación después del clic sacan el zoom en ese momento', () => {
		const s = plan([clic(2, 300, 300), {t: 2.5, tipo: 'scroll', caja: {x: 0, y: 0, w: ANCHO, h: ALTO}, dur: 1}]);
		expect(motivos(s)).toEqual(['inicio', 'clic', 'scroll']);
		expect(s.objetivos[2].t).toBe(2.5);
		const n = plan([clic(2, 300, 300), {t: 2.1, tipo: 'navegacion', caja: {x: 0, y: 0, w: ANCHO, h: ALTO}}]);
		expect(motivos(n)).toEqual(['inicio', 'clic', 'navegacion']);
	});

	it('el scroll que acerca el botón justo antes del clic no cancela el zoom', () => {
		const p = plan([{t: 1.7, tipo: 'scroll', caja: {x: 0, y: 0, w: ANCHO, h: ALTO}, dur: 0.25}, clic(2, 300, 300)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida']);
	});

	it('mientras escribes se sostiene; sale 1.2 s después de la última tecla', () => {
		const p = plan([{t: 3, tipo: 'tecla', caja: {x: 400, y: 600, w: 700, h: 60}, dur: 2}]);
		expect(motivos(p)).toEqual(['inicio', 'tecla', 'salida']);
		expect(p.objetivos[2].t).toBeCloseTo(6.2, 9);
	});

	it('un evento 0.4 s después del clic no le quita la cámara al clic (se miran juntos)', () => {
		const eventos = [clic(2.168, 1490, 94, 297, 29), {t: 2.544, tipo: 'tecla' as const, caja: {x: 1253, y: 964, w: 430, h: 288}, dur: 0.77}];
		const p = plan(eventos);
		expect(revisarClic(p, eventos[0]).pasa).toBe(true);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida']);
	});

	it('el paneo hacia el siguiente evento arranca después del clic actual', () => {
		const p = plan([clic(2, 300, 300), clic(2.7, 2000, 1200)]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'paneo', 'salida']);
		expect(p.objetivos[2].t).toBeGreaterThan(2);
		expect(revisarClic(p, clic(2, 300, 300)).pasa).toBe(true);
		expect(revisarClic(p, clic(2.7, 2000, 1200)).pasa).toBe(true);
	});

	it('clic y teclas casi al mismo tiempo se miran juntos (caja unida)', () => {
		const p = plan([clic(2, 400, 600, 100, 50), {t: 2.2, tipo: 'tecla', caja: {x: 400, y: 600, w: 700, h: 60}, dur: 1}]);
		expect(motivos(p)).toEqual(['inicio', 'clic', 'salida']);
		expect(p.objetivos[1].eventos).toEqual([0, 1]);
		expect(p.objetivos[1].escala).toBeCloseTo(escalaParaCaja({x: 400, y: 600, w: 700, h: 60}, p.base), 9);
	});

	it('un evento sin caja (tecla sin campo) no hace zoom', () => {
		expect(motivos(plan([{t: 2, tipo: 'tecla', caja: {x: 0, y: 0, w: 0, h: 0}}]))).toEqual(['inicio']);
	});
});

describe('cajas en orillas y esquinas', () => {
	const pos = (w: number, h: number) => [
		[0, 0],
		[ANCHO - w, 0],
		[0, ALTO - h],
		[ANCHO - w, ALTO - h],
		[(ANCHO - w) / 2, 0],
		[(ANCHO - w) / 2, ALTO - h],
		[0, (ALTO - h) / 2],
		[ANCHO - w, (ALTO - h) / 2],
		[(ANCHO - w) / 2, (ALTO - h) / 2],
	];
	for (const enc of ENCUADRES) {
		for (const [w, h] of [
			[60, 30],
			[300, 80],
			[1400, 900],
		]) {
			it(`${enc.nombre}, caja ${w}×${h}: en el clic la caja cruza la vista con su centro adentro, y la vista no sale del cuadro`, () => {
				for (const [x, y] of pos(w, h)) {
					const p = plan([clic(2, x, y, w, h)], enc.aspecto);
					const r = revisarClic(p, {t: 2, caja: {x, y, w, h}});
					expect(r.cruza, `caja en ${x},${y}`).toBe(true);
					expect(r.centroDentro, `caja en ${x},${y}`).toBe(true);
					expect(r.pasa).toBe(true);
					vistaDentroDelCuadro(p, 0, 5);
				}
			});
		}
	}

	it('una caja medio fuera del cuadro: la vista se limita en la orilla y el criterio usa la excepción', () => {
		const caja = {x: -90, y: 700, w: 100, h: 40}; // centro en x = −40: fuera del cuadro
		for (const enc of ENCUADRES) {
			const p = plan([{t: 2, tipo: 'clic', caja}], enc.aspecto);
			const r = revisarClic(p, {t: 2, caja});
			expect(r.cruza).toBe(true);
			expect(r.centroDentro).toBe(false);
			expect(r.limitada).toBe(true);
			expect(r.pasa).toBe(true);
			vistaDentroDelCuadro(p, 0, 5);
		}
	});

	it('propiedad: 200 demos al azar (clics, teclas, scrolls) pasan el criterio en cada clic', () => {
		const r = azar(20261003);
		for (let n = 0; n < 200; n++) {
			const enc = ENCUADRES[n % ENCUADRES.length];
			const eventos: EventoDemo[] = [];
			let t = 0.3 + r() * 1.5;
			const total = 2 + Math.floor(r() * 6);
			for (let k = 0; k < total; k++) {
				const w = 20 + r() * 600;
				const h = 16 + r() * 300;
				const x = r() * (ANCHO - w);
				const y = r() * (ALTO - h);
				const tipo = r() < 0.15 ? 'scroll' : r() < 0.2 ? 'tecla' : 'clic';
				eventos.push(tipo === 'scroll' ? {t, tipo, caja: {x: 0, y: 0, w: ANCHO, h: ALTO}, dur: 0.6} : tipo === 'tecla' ? {t, tipo, caja: {x, y, w, h}, dur: r()} : {t, tipo, caja: {x, y, w, h}});
				t += 0.2 + r() * 3;
			}
			const p = plan(eventos, enc.aspecto);
			for (const e of eventos.filter((x) => x.tipo === 'clic')) {
				// Dos eventos a menos de 0.6 s se miran juntos (caja unida): el criterio se revisa igual para cada uno.
				const rev = revisarClic(p, e);
				expect(rev.pasa, `demo ${n}, clic en t=${e.t.toFixed(2)}`).toBe(true);
			}
			vistaDentroDelCuadro(p, 0, t + 2);
		}
	});
	it('propiedad agresiva: 1,000 demos con eventos a 0.05 s y cajas en la orilla; solo fallan los casos imposibles', () => {
		// Imposibles (no los puede mostrar ninguna cámara): la caja está entera fuera del cuadro, u otro evento con zoom
		// en otra parte sigue hasta menos de 1 cuadro antes del clic. El grabador no produce ninguno de los dos.
		const r = azar(7);
		let reales = 0;
		let imposibles = 0;
		for (let n = 0; n < 1000; n++) {
			const enc = ENCUADRES[n % ENCUADRES.length];
			const eventos: EventoDemo[] = [];
			let t = 0.3 + r() * 1.5;
			const total = 2 + Math.floor(r() * 8);
			for (let k = 0; k < total; k++) {
				const w = 10 + r() * 900;
				const h = 10 + r() * 500;
				const x = -50 + r() * (ANCHO - w + 100);
				const y = -30 + r() * (ALTO - h + 60);
				const u = r();
				if (u < 0.15) eventos.push({t, tipo: 'scroll', caja: {x: 0, y: 0, w: ANCHO, h: ALTO}, dur: 0.6});
				else if (u < 0.2) eventos.push({t, tipo: 'navegacion', caja: {x: 0, y: 0, w: ANCHO, h: ALTO}});
				else if (u < 0.35) eventos.push({t, tipo: 'tecla', caja: {x, y, w, h}, dur: r() * 2});
				else eventos.push({t, tipo: 'clic', caja: {x, y, w, h}});
				t += 0.05 + r() * 3;
			}
			const p = plan(eventos, enc.aspecto);
			for (const e of eventos.filter((x) => x.tipo === 'clic')) {
				if (revisarClic(p, e).pasa) continue;
				const fuera = e.caja.x + e.caja.w <= 0 || e.caja.y + e.caja.h <= 0 || e.caja.x >= ANCHO || e.caja.y >= ALTO;
				const pegado = eventos.some((o) => o !== e && (o.tipo === 'clic' || o.tipo === 'tecla') && o.t < e.t && o.t + (o.dur ?? 0) > e.t - 1 / 30);
				if (fuera || pegado) imposibles++;
				else reales++;
			}
			for (let tt = 0; tt < t + 2; tt += 0.25) {
				const c = evaluarCamara(p, tt);
				expect(c.x >= -1e-6 && c.y >= -1e-6 && c.x + c.w <= ANCHO + 1e-6 && c.y + c.h <= ALTO + 1e-6).toBe(true);
			}
		}
		expect(reales).toBe(0);
		expect(imposibles).toBeLessThan(20);
	});
});

describe('resorte', () => {
	it('no rebota: al entrar la escala sube sin pasarse y llega a ≥ 97 % en el clic', () => {
		const p = plan([clic(2, 1200, 700)]);
		let anterior = 1;
		for (let t = 1.55; t <= 3.2; t += 1 / 120) {
			const e = evaluarCamara(p, t).escala;
			expect(e).toBeGreaterThanOrEqual(anterior - 1e-12);
			expect(e).toBeLessThanOrEqual(2.5 + 1e-9);
			anterior = e;
		}
		const enClic = evaluarCamara(p, 2).escala;
		expect(Math.log(enClic) / Math.log(2.5)).toBeGreaterThanOrEqual(0.97);
	});

	it('al salir baja sin pasarse de 1', () => {
		const p = plan([clic(2, 1200, 700)]);
		let anterior = Number.POSITIVE_INFINITY;
		for (let t = 3.2; t <= 5; t += 1 / 120) {
			const e = evaluarCamara(p, t).escala;
			expect(e).toBeLessThanOrEqual(anterior + 1e-12);
			expect(e).toBeGreaterThanOrEqual(1);
			anterior = e;
		}
	});

	it('es determinista: el mismo t da lo mismo, en cualquier orden', () => {
		const p = plan([clic(2, 300, 300), clic(2.8, 2000, 1200), clic(7, 100, 1500)]);
		const ts = Array.from({length: 300}, (_, i) => i / 30);
		const ida = ts.map((t) => evaluarCamara(p, t));
		const vuelta = [...ts].reverse().map((t) => evaluarCamara(p, t)).reverse();
		expect(vuelta).toEqual(ida);
	});
});

describe('cursor sintético y onda', () => {
	const eventos = [clic(2, 1000, 500, 120, 40), clic(4, 200, 1300, 80, 30)];

	it('descansa antes de moverse, llega al centro de la caja en el clic y viaja con curva suave', () => {
		const reposo = {x: ESTILO_DEMO.cursor.reposo.x * ANCHO, y: ESTILO_DEMO.cursor.reposo.y * ALTO};
		expect(posicionCursor(eventos, 0, {ancho: ANCHO, alto: ALTO})).toMatchObject(reposo);
		const enClic = posicionCursor(eventos, 2, {ancho: ANCHO, alto: ALTO});
		expect([enClic.x, enClic.y]).toEqual([1060, 520]);
		const segundo = posicionCursor(eventos, 4, {ancho: ANCHO, alto: ALTO});
		expect([segundo.x, segundo.y]).toEqual([240, 1315]);
		// A medio viaje está entre los dos puntos.
		const medio = posicionCursor(eventos, 4 - ESTILO_DEMO.cursor.viaje_max_s / 2, {ancho: ANCHO, alto: ALTO});
		expect(medio.x).toBeLessThan(1060);
		expect(medio.x).toBeGreaterThan(240);
		// Entre clics (antes de empezar el viaje) se queda quieto.
		expect(posicionCursor(eventos, 2.5, {ancho: ANCHO, alto: ALTO})).toMatchObject({x: 1060, y: 520});
	});

	it('se encoge justo en el clic y regresa a su tamaño', () => {
		expect(posicionCursor(eventos, 2, {ancho: ANCHO, alto: ALTO}).escala).toBeCloseTo(ESTILO_DEMO.cursor.escala_clic, 9);
		expect(posicionCursor(eventos, 2.5, {ancho: ANCHO, alto: ALTO}).escala).toBe(1);
	});

	it('la onda nace en el clic, crece, se desvanece y desaparece', () => {
		const o0 = ondasActivas(eventos, 2, {alto: ALTO});
		expect(o0).toHaveLength(1);
		expect(o0[0].radio).toBeCloseTo(ESTILO_DEMO.onda.radio_ini_rel * ALTO, 9);
		const o1 = ondasActivas(eventos, 2.3, {alto: ALTO});
		expect(o1[0].radio).toBeGreaterThan(o0[0].radio);
		expect(o1[0].opacidad).toBeLessThan(o0[0].opacidad);
		expect(ondasActivas(eventos, 2 + ESTILO_DEMO.onda.duracion_s + 0.01, {alto: ALTO})).toHaveLength(0);
		expect(ondasActivas(eventos, 1.99, {alto: ALTO})).toHaveLength(0);
	});
});
