// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * creador.json (herramientas/lib/creador.ts): valores neutros sin archivo, código 2 con un archivo malo, rutas con ~,
 * el handle que piden el corpus y emparejar, y las fuentes de SFX que salen de ahí (lib/sfx.ts).
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {CREADOR_NEUTRO, expandirRuta, fuentesSfxDe, hayCreador, leerCreador, requerirHandle} from '../../herramientas/lib/creador.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {leerFuentesPermitidas} from '../../herramientas/lib/sfx.ts';

const tmp = mkdtempSync(join(tmpdir(), 'creador-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

let n = 0;
/** Una raíz temporal con (o sin) creador.json. */
function raizCon(contenido?: unknown): string {
	const raiz = join(tmp, `r${n++}`);
	mkdirSync(raiz, {recursive: true});
	if (contenido !== undefined) writeFileSync(join(raiz, 'creador.json'), typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
	return raiz;
}

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor');
}

const DEMO = {
	version: 1,
	nombre: 'Creador Demo',
	handle: '@creador-demo',
	plataforma: 'instagram',
	idioma: 'en',
	estilo_activo: 'demo-estilo',
	corpus: {instagram_id: '1234567890', carpetas_apify: ['~/datos/apify'], carpetas_ytdlp: [], carpetas_extra: [], crudos: ['/videos/crudos']},
	sfx: {solo_fuentes: ['propios']},
};

describe('leerCreador', () => {
	it('sin creador.json: valores neutros (sin handle, español, sin estilo, corpus vacío, todas las fuentes de SFX)', () => {
		const raiz = raizCon();
		expect(hayCreador({raiz})).toBe(false);
		const c = leerCreador({raiz});
		expect(c).toEqual(CREADOR_NEUTRO);
		expect(c).toMatchObject({nombre: '', handle: '', idioma: 'es', estilo_activo: null, corpus: {instagram_id: null, carpetas_apify: [], crudos: []}, sfx: {solo_fuentes: []}});
		expect(fuentesSfxDe(c)).toBeNull();
		expect(leerFuentesPermitidas({raiz})).toBeNull();
	});

	it('lee el contrato completo; el handle sin @; las fuentes de SFX salen de sfx.solo_fuentes', () => {
		const raiz = raizCon(DEMO);
		const c = leerCreador({raiz});
		expect(c.handle).toBe('creador-demo');
		expect(c.idioma).toBe('en');
		expect(c.estilo_activo).toBe('demo-estilo');
		expect(c.corpus.instagram_id).toBe('1234567890');
		expect(c.voz).toBeNull();
		expect(leerFuentesPermitidas({raiz})).toEqual(['propios']);
	});

	it('campos que faltan toman su valor neutro; campos extra se conservan', () => {
		const c = leerCreador({raiz: raizCon({handle: 'creador-demo', extra: 1})});
		expect(c.idioma).toBe('es');
		expect(c.corpus.carpetas_ytdlp).toEqual([]);
		expect((c as Record<string, unknown>).extra).toBe(1);
	});

	it('un creador.json que no es JSON o no cumple la forma sale con código 2', () => {
		expect(falloDe(() => leerCreador({raiz: raizCon('{')})).codigo).toBe(2);
		expect(falloDe(() => leerCreador({raiz: raizCon({idioma: 'fr'})})).codigo).toBe(2);
		expect(falloDe(() => leerCreador({raiz: raizCon({corpus: {carpetas_apify: 'no-es-lista'}})})).codigo).toBe(2);
	});
});

describe('requerirHandle y expandirRuta', () => {
	it('sin handle: código 2 que pide llenar creador.json', () => {
		const e = falloDe(() => requerirHandle(CREADOR_NEUTRO, 'armar el corpus'));
		expect(e.codigo).toBe(2);
		expect(e.message).toMatch(/creador\.json/);
		expect(requerirHandle(leerCreador({raiz: raizCon(DEMO)}), 'x')).toBe('creador-demo');
	});

	it('~ se expande con el home; lo relativo, contra la base', () => {
		expect(expandirRuta('~')).toBe(homedir());
		expect(expandirRuta('~/datos/apify')).toBe(join(homedir(), 'datos', 'apify'));
		expect(expandirRuta('/abs/x')).toBe('/abs/x');
		expect(expandirRuta('biblioteca/sfx', '/base')).toBe('/base/biblioteca/sfx');
	});
});
