// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/grabador/eventos.ts (y de las partes puras de captura.ts):
 * - compresión de tiempos muertos > 400 ms → keep[] en cuadros de 30 fps, válido para remapear.ts
 * - remapear(t) sobre la toma comprimida (eventos que caen después de un hueco se adelantan lo recortado)
 * - VFR → CFR repitiendo el último cuadro
 * - cuadros únicos por segundo (criterio del piloto)
 * - eventos.json: esquema estricto (sin campos de más: el texto de una tecla no cabe)
 */
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {duracionBase, remapear, validarKeep} from '../../herramientas/lib/remapear.ts';
import {
	aPixelesCuadro,
	COMPRESION,
	cuadrosConservados,
	EventosDemo,
	estadisticaCuadros,
	eventosDeToma,
	leerEventos,
	mapaCfr,
	planCompresion,
	remapearTiempo,
	resumenCompresion,
	unirActividad,
	type EventoCrudo,
} from '../../herramientas/grabador/eventos.ts';
import {dimensionesImagen} from '../../herramientas/grabador/captura.ts';

const enCuadro = (t: number) => Math.abs(t * 30 - Math.round(t * 30)) < 1e-9;
/** Actividad continua a 30 fps entre a y b (como un scroll que repinta cada cuadro). */
const continua = (a: number, b: number) => Array.from({length: Math.round((b - a) * 30) + 1}, (_, i) => ({desde: a + i / 30, hasta: a + i / 30}));

describe('compresión de tiempos muertos', () => {
	it('recorta un hueco de 3 s a 0.4 s y deja la actividad completa', () => {
		// Actividad de 0 a 2 s, nada hasta 5 s, actividad de 5 a 6 s; la toma dura 8 s.
		const keep = planCompresion([...continua(0, 2), ...continua(5, 6)], 8);
		expect(() => validarKeep(keep)).not.toThrow();
		expect(keep.every((tr) => enCuadro(tr.desde) && enCuadro(tr.hasta))).toBe(true);
		expect(keep).toHaveLength(2);
		expect(keep[0]).toEqual({desde: 0, hasta: 2.2});
		expect(keep[1].desde).toBeCloseTo(4.8, 9);
		// Cola: 1.5 s después de la última actividad (6 s) → 7.5 s.
		expect(keep[1].hasta).toBeCloseTo(7.5, 9);
		// Lo que queda del hueco: 0.2 + 0.2 = 0.4 s.
		expect(keep[1].desde - keep[0].hasta).toBeCloseTo(3 - COMPRESION.conservar_s, 9);
		expect(duracionBase(keep)).toBeCloseTo(2.2 + 2.7, 9);
	});

	it('no corta huecos de 400 ms o menos', () => {
		const keep = planCompresion([...continua(0, 1), ...continua(1.4, 2)], 3);
		expect(keep).toHaveLength(1);
		expect(keep[0].desde).toBe(0);
	});

	it('un evento con duración (escribir, desplazar) cuenta como actividad continua', () => {
		// Un cuadro en 0 s y un scroll de 3 s a 6 s: el hueco de 0 a 3 s se recorta…
		const keep = planCompresion([{desde: 0, hasta: 0}, {desde: 3, hasta: 6}], 7);
		expect(keep).toHaveLength(2);
		expect(keep[1].desde).toBeCloseTo(2.8, 9);
		// …pero nada dentro de [3, 6] queda fuera, aunque no haya cuadros nuevos ahí.
		for (let t = 3; t < 6; t += 0.05) expect(remapear(keep, t)).not.toBeNull();
	});

	it('sin actividad deja solo la cola', () => {
		expect(planCompresion([], 10)).toEqual([{desde: 0, hasta: 1.5}]);
	});

	it('une tramos que quedarían pegados (remapear.ts exige un cuadro de corte entre tramos)', () => {
		// Hueco de 0.42 s: 0.42 − 0.4 = 0.02 s < 1 cuadro → no hay corte real.
		const keep = planCompresion([...continua(0, 1), ...continua(1.42, 2)], 3);
		expect(() => validarKeep(keep)).not.toThrow();
		expect(keep).toHaveLength(1);
	});

	it('unirActividad junta intervalos que se enciman o están pegados', () => {
		expect(unirActividad([{desde: 2, hasta: 3}, {desde: 0, hasta: 1}, {desde: 1.2, hasta: 1.5}], 0.3)).toEqual([
			{desde: 0, hasta: 1.5},
			{desde: 2, hasta: 3},
		]);
	});

	it('resumen: cruda, comprimida y recortada', () => {
		const keep = planCompresion([...continua(0, 2), ...continua(5, 6)], 8);
		expect(resumenCompresion(keep, 8)).toEqual({cruda_s: 8, comprimida_s: 4.9, recortado_s: 3.1, cortes: 1});
	});

	it('una duración rota es un fallo interno (código 1)', () => {
		expect(() => planCompresion([], 0)).toThrow(FalloEditor);
	});
});

describe('remapear(t) sobre la toma comprimida', () => {
	const keep = planCompresion([...continua(0, 2), ...continua(5, 6)], 8);
	const recorte = keep[1].desde - keep[0].hasta;

	it('antes del hueco queda igual; después se adelanta lo recortado', () => {
		expect(remapear(keep, 1)).toBeCloseTo(1, 9);
		expect(remapear(keep, 5.5)).toBeCloseTo(5.5 - recorte, 9);
		expect(remapear(keep, 5)).toBeCloseTo(5 - recorte, 9);
	});

	it('un tiempo que cayó en el recorte se pega al borde más cercano', () => {
		expect(remapear(keep, 3.5)).toBeNull();
		// Candidatos: último cuadro del tramo 1 (2.167 s, a 1.33 s) y primero del tramo 2 (4.8 s, a 1.3 s) → el segundo,
		// que en la toma cae justo donde acaba el tramo 1 (2.2 s).
		expect(remapearTiempo(keep, 3.5)).toBeCloseTo(2.2, 9);
		expect(remapearTiempo(keep, 2.5)).toBeCloseTo(2.2 - 1 / 30, 9);
	});

	it('eventosDeToma: reloj → tiempo de la toma, caja CSS → px del cuadro (×2), y descarta lo anterior a t0', () => {
		const t0 = 1_000;
		const crudos: EventoCrudo[] = [
			{reloj: t0 - 0.5, tipo: 'navegacion', caja: {x: 0, y: 0, w: 1280, h: 800}, escala: 2},
			{reloj: t0 + 1, tipo: 'clic', caja: {x: 1100.25, y: 260, w: 90, h: 32}, escala: 2},
			{reloj: t0 + 5.5, tipo: 'tecla', caja: {x: 10, y: 20, w: 300, h: 40}, escala: 2, dur: 0.4},
		];
		const ev = eventosDeToma(crudos, t0, keep);
		expect(ev).toHaveLength(2);
		expect(ev[0]).toEqual({t: 1, tipo: 'clic', caja: {x: 2200.5, y: 520, w: 180, h: 64}});
		expect(ev[1].t).toBeCloseTo(5.5 - recorte, 3);
		expect(ev[1].dur).toBeCloseTo(0.4, 3);
		expect(EventosDemo.safeParse(ev).success).toBe(true);
	});

	it('aPixelesCuadro redondea a 0.1 px', () => {
		expect(aPixelesCuadro({x: 1.234, y: 2, w: 3.333, h: 4}, 2)).toEqual({x: 2.5, y: 4, w: 6.7, h: 8});
	});
});

describe('VFR → CFR 30', () => {
	it('cada cuadro de salida repite el último cuadro crudo con tiempo ≤ k/30', () => {
		// Cuadros crudos en 0, 0.010, 0.050, 0.200 y 0.205 s.
		const mapa = mapaCfr([0, 0.01, 0.05, 0.2, 0.205], 8);
		// k/30: 0, .033, .067, .1, .133, .167, .2, .233
		expect(mapa).toEqual([0, 1, 2, 2, 2, 2, 3, 4]);
	});

	it('un cuadro justo en k/30 cuenta para ese k (sin error de punto flotante)', () => {
		expect(mapaCfr([0, 1 / 30, 2 / 30], 3)).toEqual([0, 1, 2]);
	});

	it('antes del primer cuadro se usa el primero; sin cuadros es un fallo interno', () => {
		expect(mapaCfr([0.1, 0.2], 3)).toEqual([0, 0, 0]);
		expect(() => mapaCfr([], 3)).toThrow(FalloEditor);
	});

	it('cuadrosConservados recorre keep[] en cuadros de salida', () => {
		expect(cuadrosConservados([{desde: 0, hasta: 0.1}, {desde: 1, hasta: 1.1}])).toEqual([0, 1, 2, 30, 31, 32]);
	});
});

describe('cuadros únicos por segundo (piloto)', () => {
	it('cuenta por timestamp y por contenido, por segundo', () => {
		const cuadros = [
			{t: 0.0, hash: 'a'},
			{t: 0.5, hash: 'b'},
			{t: 0.5, hash: 'b'}, // mismo timestamp: no es único
			{t: 1.2, hash: 'b'}, // mismo contenido: único por tiempo, no por contenido
			{t: 1.4, hash: 'c'},
			{t: 2.5, hash: 'd'}, // fuera del tramo [0, 2)
		];
		const e = estadisticaCuadros(cuadros, 0, 2);
		expect(e).toMatchObject({cuadros: 5, unicos_por_tiempo: 4, unicos_por_contenido: 3, fps_efectivos: 2, por_segundo: [2, 2], fps_min_por_segundo: 2});
	});
});

describe('eventos.json', () => {
	const dir = mkdtempSync(join(tmpdir(), 'eventos-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it('lee y valida el formato', () => {
		const ruta = join(dir, 'eventos.json');
		writeFileSync(ruta, JSON.stringify([{t: 1.2, tipo: 'clic', caja: {x: 1, y: 2, w: 3, h: 4}}]));
		expect(leerEventos(ruta)).toHaveLength(1);
	});

	it('rechaza (código 2) un evento con texto, un tipo desconocido o un tiempo negativo', () => {
		for (const malo of [
			[{t: 1, tipo: 'tecla', caja: {x: 0, y: 0, w: 1, h: 1}, texto: 'hola'}],
			[{t: 1, tipo: 'arrastrar', caja: {x: 0, y: 0, w: 1, h: 1}}],
			[{t: -1, tipo: 'clic', caja: {x: 0, y: 0, w: 1, h: 1}}],
		]) {
			const ruta = join(dir, 'malo.json');
			writeFileSync(ruta, JSON.stringify(malo));
			let codigo = 0;
			try {
				leerEventos(ruta);
			} catch (e) {
				codigo = (e as FalloEditor).codigo;
			}
			expect(codigo).toBe(2);
		}
	});
});

describe('cabeceras de imagen (captura.ts)', () => {
	it('lee ancho y alto de un PNG', () => {
		const png = Buffer.alloc(33);
		png.writeUInt32BE(0x89504e47, 0);
		png.writeUInt32BE(0x0d0a1a0a, 4);
		png.writeUInt32BE(13, 8);
		png.write('IHDR', 12, 'ascii');
		png.writeUInt32BE(2560, 16);
		png.writeUInt32BE(1600, 20);
		expect(dimensionesImagen(png)).toEqual({ancho: 2560, alto: 1600, formato: 'png'});
	});

	it('lee ancho y alto de un JPEG (salta APP0 hasta SOF0)', () => {
		const jpg = Buffer.from([
			0xff, 0xd8, // SOI
			0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0 (16 bytes)
			0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0x40, 0x0a, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, // SOF0: 1600×2560
			0xff, 0xd9,
		]);
		expect(dimensionesImagen(jpg)).toEqual({ancho: 2560, alto: 1600, formato: 'jpeg'});
	});

	it('otra cosa es un fallo interno', () => {
		expect(() => dimensionesImagen(Buffer.from('no soy imagen'))).toThrow(FalloEditor);
	});
});
