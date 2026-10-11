import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {fallo} from '../../herramientas/lib/fallo.ts';
import {CLAVES, diccionario, fijarIdioma, idioma, leerIdiomaDe, t} from '../../herramientas/lib/i18n.ts';
import {contarChecks, crearCheck, fraseConteo, generarMarkdown, type DatosReporte} from '../../herramientas/lib/reporte.ts';
import {fraseReglas} from '../../herramientas/validar.ts';

afterEach(() => fijarIdioma(null));

const reglas = [
	{regla: 'R1', nombre: 'a', estado: 'PASA', detalle: ''},
	{regla: 'R2', nombre: 'b', estado: 'FALLA', detalle: ''},
	{regla: 'R3', nombre: 'c', estado: 'N/A', detalle: ''},
] as const;

const checks = [
	crearCheck({id: 'a', nombre: 'Loudness', nivel: 'bloqueante', pasa: true, valor: -14, criterio: '−14 ±1', n: 1, fuente: 'ffmpeg'}),
	crearCheck({id: 'b', nombre: 'A/B', nivel: 'estetico', pasa: null, valor: null, criterio: '—', n: null, fuente: '—', nota: 'sin publicado'}),
];

const datos: DatosReporte = {
	version: 1,
	slug: 'demo',
	actualizado_en: '2026-01-01T00:00:00.000Z',
	versiones: {'1': {secciones: {qa: {titulo: 'QA', generado_en: '2026-01-01T00:00:00.000Z', checks, tiempos_s: {render: 3}}}}},
};

describe('i18n', () => {
	it('sin creador.json habla en español', () => {
		const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
		try {
			expect(idioma(dir)).toBe('es');
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('lee el idioma de creador.json y tolera JSON roto o idiomas que no existen', () => {
		const dir = mkdtempSync(join(tmpdir(), 'i18n-'));
		try {
			const ruta = join(dir, 'creador.json');
			writeFileSync(ruta, JSON.stringify({version: 1, idioma: 'en'}));
			expect(leerIdiomaDe(ruta)).toBe('en');
			writeFileSync(ruta, '{roto');
			expect(leerIdiomaDe(ruta)).toBeNull();
			writeFileSync(ruta, JSON.stringify({idioma: 'fr', relleno: 'x'}));
			expect(leerIdiomaDe(ruta)).toBeNull();
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('los dos diccionarios tienen las mismas claves y las mismas {variables}', () => {
		const vars = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();
		for (const c of CLAVES) {
			expect(diccionario('en')[c], c).toBeTruthy();
			expect(vars(diccionario('en')[c]), c).toEqual(vars(diccionario('es')[c]));
		}
	});

	it('español por defecto: mismas frases de siempre', () => {
		expect(fraseReglas(reglas)).toBe('cumple 1 de 2 reglas (1 N/A)');
		expect(fraseConteo(contarChecks(checks))).toBe('cumple 1 de 1 checks (1 N/A)');
		expect(fallo('leer x', 'no existe', 'revisa la ruta', 2).message).toBe('No pude leer x: no existe. Siguiente paso: revisa la ruta.');
	});

	it('en inglés: validar, reporte y fallo', () => {
		fijarIdioma('en');
		expect(fraseReglas(reglas)).toBe('passes 1 of 2 rules (1 N/A)');
		expect(fraseConteo(contarChecks(checks))).toBe('passes 1 of 1 checks (1 N/A)');
		expect(fallo('read x', 'it does not exist', 'check the path', 2).message).toBe("Couldn't read x: it does not exist. Next step: check the path.");
		expect(t('validar.valida', {ruta: 'e.json', frase: 'ok'})).toBe('✔ e.json: valid · ok');
		const md = generarMarkdown(datos, null);
		expect(md).toContain('# Report — demo');
		expect(md).toContain('## v1 (latest) · passes 1 of 1 checks (1 N/A)');
		expect(md).toContain('**What blocks publishing** (passes 1 of 1 checks (0 N/A))');
		expect(md).toContain('| Check | Status | Value | Criterion | N | Source | Note |');
		expect(md).toContain('| Loudness | **PASS** |');
		expect(md).toContain('| Stage | Time |');
		expect(md).not.toMatch(/cumple|Reporte|Lo que impide/);
	});

	it('el reporte en español no cambia', () => {
		const md = generarMarkdown(datos, null, 'es');
		expect(md).toContain('# Reporte — demo');
		expect(md).toContain('## v1 (la más reciente) · cumple 1 de 1 checks (1 N/A)');
		expect(md).toContain('**Lo que impide subir** (cumple 1 de 1 checks (0 N/A))');
		expect(md).toContain('| Loudness | **PASA** |');
	});

	it('una variable que falta se deja visible', () => {
		expect(t('validar.no_existe', {}, 'en')).toBe('{ruta} does not exist');
	});
});
