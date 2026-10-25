// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {EdicionValidada} from '../../src/esquema/edicion';
import {validarEdicion} from '../../herramientas/validar';
import {HAY_FUENTES} from './requisitos.ts';

const valida = JSON.parse(readFileSync(new URL('../edl/f0-3s.json', import.meta.url), 'utf8'));
const clonar = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('contrato de la edición (Zod)', () => {
	it('acepta una EDL válida', () => {
		expect(EdicionValidada.safeParse(valida).success).toBe(true);
	});

	it('rechaza un sticker que termina antes de empezar', () => {
		const e = clonar(valida);
		e.stickers[0].desde = 2.5;
		e.stickers[0].hasta = 1.0;
		expect(EdicionValidada.safeParse(e).success).toBe(false);
	});

	it('rechaza ids repetidos', () => {
		const e = clonar(valida);
		e.stickers[0].id = 's1';
		expect(EdicionValidada.safeParse(e).success).toBe(false);
	});

	it('rechaza un subtítulo de más de 3 palabras', () => {
		const e = clonar(valida);
		e.subtitulos[0].palabras.push({i: 3, t: 'sobra', d: 1.2, h: 1.3});
		expect(EdicionValidada.safeParse(e).success).toBe(false);
	});

	it('EDL de antes del renombre: la mascota en el campo viejo da lo mismo que con `mascota`', () => {
		// El campo viejo tenía otro nombre; cualquier campo extra con forma {pose, ojos, anim} se toma como alias.
		const pose = {pose: 'frente', ojos: 'felices', anim: 'respira'};
		const nueva = clonar(valida);
		nueva.stickers[0].mascota = pose;
		const vieja = clonar(valida);
		delete vieja.stickers[0].mascota;
		vieja.stickers[0].personaje_viejo = pose;
		const a = EdicionValidada.parse(nueva);
		const b = EdicionValidada.parse(vieja);
		expect(b).toEqual(a);
		expect(b.stickers[0].mascota).toEqual(pose);
		// Con el campo viejo en null (logos, PNG sueltos) queda null; y si vienen los dos, manda `mascota`.
		const nula = clonar(valida);
		delete nula.stickers[0].mascota;
		nula.stickers[0].personaje_viejo = null;
		expect(EdicionValidada.parse(nula)).toEqual(EdicionValidada.parse(valida));
		const ambas = clonar(nueva);
		ambas.stickers[0].personaje_viejo = {pose: 'lado', ojos: 'normales', anim: 'ninguna'};
		expect(EdicionValidada.parse(ambas).stickers[0].mascota).toEqual(pose);
		// validar.ts mide textos: solo con las fuentes bajadas.
		if (HAY_FUENTES) expect(validarEdicion(vieja).edicion).toEqual(validarEdicion(nueva).edicion);
	});

	it('rechaza un lienzo que no es 1440×2560', () => {
		const e = clonar(valida);
		e.lienzo.w = 1080;
		expect(EdicionValidada.safeParse(e).success).toBe(false);
	});
});

describe('validar.ts (archivos y alfa)', () => {
	it.runIf(HAY_FUENTES)('la EDL de prueba pasa con sus archivos reales', () => {
		const {hallazgos} = validarEdicion(valida);
		expect(hallazgos).toEqual([]);
	});

	it.runIf(HAY_FUENTES)('marca un archivo que no existe', () => {
		const e = clonar(valida);
		e.stickers[0].asset = 'fx/no-existe.png';
		const {hallazgos} = validarEdicion(e);
		expect(hallazgos.some((h) => h.regla === 'archivo')).toBe(true);
	});

	it.runIf(HAY_FUENTES)('marca un sticker sin transparencia (usa un JPG/MP4 como sticker)', () => {
		const e = clonar(valida);
		e.stickers[0].asset = 'fx/clip-6s.mp4';
		const {hallazgos} = validarEdicion(e);
		expect(hallazgos.some((h) => h.regla === 'alfa')).toBe(true);
	});

	it.runIf(HAY_FUENTES)('rechaza rutas con ".." o absolutas', () => {
		const e = clonar(valida);
		e.base = '../entrada/crudo.mov';
		const {hallazgos} = validarEdicion(e);
		expect(hallazgos.some((h) => h.regla === 'ruta')).toBe(true);
	});
});
