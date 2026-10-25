// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {describe, expect, it} from 'vitest';
import {EdicionValidada, edicionVacia} from '../../src/esquema/edicion';
import {ElementoVivo, cajaElemento, escalaTitular, resorte, textoContador, tramosPersona, vaDetras} from '../../src/estilo/texto-vivo';
import {buscarPalabra, cabezaEnTramo, meterEnZona, reagrupar} from '../../herramientas/vivo';
import {FalloEditor} from '../../herramientas/lib/fallo';

const sub = (id: string, desde: number, hasta: number, ws: Array<[string, number, number]>, i0 = 0) => ({id, desde, hasta, palabras: ws.map(([t, d, h], k) => ({i: i0 + k, t, d, h}))});

describe('texto vivo: geometría y curvas', () => {
	it('achica un titular que no cabe y nunca lo agranda', () => {
		const t = ElementoVivo.parse({id: 'v1', tipo: 'titular', desde: 0, hasta: 1, y: 400, lineas: [{texto: 'Mejora el diseño de tu página web'}]});
		if (t.tipo !== 'titular') throw new Error('tipo');
		expect(escalaTitular(t)).toBeLessThan(1);
		const c = cajaElemento(t);
		expect(c.x1 - c.x0).toBeLessThanOrEqual(t.ancho_max + 1e-6);
		const corto = ElementoVivo.parse({id: 'v2', tipo: 'titular', desde: 0, hasta: 1, y: 400, lineas: [{texto: 'Hola'}]});
		if (corto.tipo !== 'titular') throw new Error('tipo');
		expect(escalaTitular(corto)).toBe(1);
	});

	it('une los tramos de silueta que se tocan y solo cuenta los de detrás', () => {
		const els = [
			ElementoVivo.parse({id: 'a', tipo: 'titular', desde: 0, hasta: 1, y: 400, lineas: [{texto: 'x'}]}),
			ElementoVivo.parse({id: 'b', tipo: 'impacto', desde: 1.01, hasta: 2, texto: 'y', x: 540, y: 400, detras: true}),
			ElementoVivo.parse({id: 'c', tipo: 'impacto', desde: 3, hasta: 4, texto: 'z', x: 540, y: 400}),
			ElementoVivo.parse({id: 'd', tipo: 'pildora', desde: 5, hasta: 6, y: 300, contenido: {clase: 'texto', texto: 'hola'}}),
		];
		expect(els.map(vaDetras)).toEqual([true, true, false, false]);
		expect(tramosPersona(els)).toEqual([{desde: 0, hasta: 2}]);
	});

	it('resorte parte de 0, rebota poco y termina en 1; contador con formato', () => {
		expect(resorte(0)).toBe(0);
		const pico = Math.max(...Array.from({length: 30}, (_, f) => resorte(f)));
		expect(pico).toBeGreaterThan(1);
		expect(pico).toBeLessThan(1.15);
		expect(resorte(40)).toBe(1);
		expect(textoContador(99.6, 'porcentaje')).toBe('100%');
		expect(textoContador(264, 'mm:ss')).toBe('04:24');
	});

	it('la EDL acepta texto_vivo y rechaza ids repetidos con el resto', () => {
		const ok = {...edicionVacia, texto_vivo: {persona: null, elementos: [{id: 'v1', tipo: 'nota', desde: 0, hasta: 1, texto: 'hola', x: 540, y: 400}]}};
		expect(EdicionValidada.safeParse(ok).success).toBe(true);
		const malo = {...ok, subtitulos: [sub('v1', 0, 1, [['hola', 0, 0.5]])]};
		expect(EdicionValidada.safeParse(malo).success).toBe(false);
	});
});

describe('vivo.ts: subtítulos y anclas', () => {
	it('parte en ≤ 2 palabras por la pausa más larga', () => {
		const r = reagrupar([sub('s1', 0, 1.5, [['quiero', 0, 0.4], ['que', 0.42, 0.6], ['analices', 0.9, 1.4]])]);
		expect(r.map((s) => s.palabras.map((p) => p.t))).toEqual([['quiero', 'que'], ['analices']]);
		expect(r.map((s) => s.id)).toEqual(['s1a', 's1b']);
		expect(r[0].hasta).toBe(r[1].desde);
	});

	it('busca la n-ésima vez que dices una palabra (sin acentos ni signos)', () => {
		const ps = reagrupar([sub('s1', 0, 2, [['Diseño,', 0, 0.5], ['diseño', 1, 1.5]])]).flatMap((s) => s.palabras);
		expect(buscarPalabra(ps, 'diseno#2').d).toBe(1);
		expect(() => buscarPalabra(ps, 'Apple')).toThrow(FalloEditor);
	});

	it('mete una caja en la zona y mide tu cabeza en un tramo', () => {
		expect(meterEnZona({x0: 100, x1: 300, y0: 200, y1: 260}, {x0: 135, x1: 945, y0: 220, y1: 1600})).toEqual({dx: 35, dy: 20});
		const k = cabezaEnTramo([{t: 0, cara: {x: 200, y: 600, w: 400, h: 400}, coronilla_y: 500, barbilla_y: 1100}, {t: 1, cara: null}], 0, 2);
		expect(k).toMatchObject({cx: 400, coronilla: 500, barbilla: 1100});
		expect(cabezaEnTramo([], 0, 1)).toBeNull();
	});
});
