// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Tus aires (estilo/aires.json, decisión del estilo del 2026-10-05: "que no haya mucho aire entre palabras"):
 * lector, opción --hueco-minimo y que el archivo del repo sea válido.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {huecoMinimoDeTexto, leerAires, rutaAires} from '../../herramientas/cortes.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {hay} from './requisitos.ts';

const tmp = mkdtempSync(join(tmpdir(), 'aires-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

describe('aires', () => {
	it('leerAires: null si no existe; código 2 si está mal o fuera de 0.1–1 s', () => {
		mkdirSync(join(tmp, 'estilo'), {recursive: true});
		expect(leerAires(join(tmp, 'estilo', 'no-existe.json'))).toBeNull();
		const ruta = join(tmp, 'estilo', 'aires.json');
		writeFileSync(ruta, JSON.stringify({hueco_minimo_s: 0.18, decision: 'el creador'}));
		expect(leerAires(ruta)?.huecoMinimoS).toBe(0.18);
		expect(leerAires(ruta)?.umbralSobrePisoDb).toBeUndefined();
		writeFileSync(ruta, JSON.stringify({hueco_minimo_s: 0.18, umbral_sobre_piso_db: 20, decision: 'el creador'}));
		expect(leerAires(ruta)?.umbralSobrePisoDb).toBe(20);
		writeFileSync(ruta, JSON.stringify({hueco_minimo_s: 0.18, quitar_sueltos_s: 0.6, decision: 'el creador'}));
		expect(leerAires(ruta)?.quitarSueltosS).toBe(0.6);
		for (const malo of ['{', JSON.stringify({hueco_minimo_s: 0.05, decision: 'x'}), JSON.stringify({hueco_minimo_s: 0.2}), JSON.stringify({hueco_minimo_s: 0.2, umbral_sobre_piso_db: 40, decision: 'x'})]) {
			writeFileSync(ruta, malo);
			expect(falloDe(() => leerAires(ruta)).codigo).toBe(2);
		}
	});

	it('--hueco-minimo: de 0.1 a 1 s; lo demás sale con código 2', () => {
		expect(huecoMinimoDeTexto('0.18')).toBe(0.18);
		for (const malo of ['', 'x', '0.05', '1.5']) expect(falloDe(() => huecoMinimoDeTexto(malo)).codigo).toBe(2);
	});

	it.runIf(hay('estilo/aires.json'))('estilo/aires.json del repo es válido', () => {
		const a = leerAires(rutaAires());
		expect(a).not.toBeNull();
		expect(a!.huecoMinimoS).toBeLessThan(0.3);
	});
});
