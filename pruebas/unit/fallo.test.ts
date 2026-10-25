// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/lib/fallo.ts: el formato de una sola frase con "Siguiente paso:"
 * y los códigos de salida de correr() (1 interno, 2 entrada, 3 servicio/llave/gasto).
 */
import {spawnSync} from 'node:child_process';
import {appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance} from 'vitest';
import {correr, fallo, FalloEditor, type CodigoFallo} from '../../herramientas/lib/fallo.ts';

// correr() escribe el detalle crudo con appendFileSync/mkdirSync en proyectos/_logs/fallos.log.
// En las pruebas dentro del proceso los simulo para no ensuciar tu log real (el resto de node:fs queda igual).
vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return {...original, appendFileSync: vi.fn(), mkdirSync: vi.fn()};
});

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX = join(RAIZ, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const URL_FALLO = pathToFileURL(join(RAIZ, 'herramientas', 'lib', 'fallo.ts')).href;

/** "No pude <qué>: <por qué>. Siguiente paso: <qué hacer>." en una sola línea. */
const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;

describe('fallo()', () => {
	it('arma el mensaje exacto: qué, por qué y siguiente paso', () => {
		const error = fallo('leer el crudo', 'el archivo no existe', 'revisa la ruta que me diste', 2);
		expect(error.message).toBe('No pude leer el crudo: el archivo no existe. Siguiente paso: revisa la ruta que me diste.');
		expect(error).toBeInstanceOf(FalloEditor);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('FalloEditor');
		expect(error.que).toBe('leer el crudo');
		expect(error.porque).toBe('el archivo no existe');
		expect(error.siguientePaso).toBe('revisa la ruta que me diste');
	});

	it.each([1, 2, 3] as CodigoFallo[])('conserva el código %i y da una sola frase con un solo "Siguiente paso:"', (codigo) => {
		const error = fallo('renderizar el reel', 'Remotion se detuvo', 'vuelve a correr el render', codigo, {interno: 'x'});
		expect(error.codigo).toBe(codigo);
		expect(error.message).toMatch(FORMATO);
		expect(error.message.split('Siguiente paso:')).toHaveLength(2);
		expect(error.message).not.toContain('\n');
		expect(error.detalle).toEqual({interno: 'x'});
	});
});

describe('correr() dentro del proceso', () => {
	let codigoAntes: typeof process.exitCode;
	let consolaError: MockInstance<typeof console.error>;
	let consolaLog: MockInstance<typeof console.log>;

	beforeEach(() => {
		codigoAntes = process.exitCode;
		process.exitCode = undefined;
		consolaError = vi.spyOn(console, 'error').mockImplementation(() => {});
		consolaLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.mocked(appendFileSync).mockClear();
	});

	afterEach(() => {
		process.exitCode = codigoAntes;
		vi.restoreAllMocks();
	});

	it.each([1, 2, 3] as CodigoFallo[])('con un FalloEditor de código %i sale con ese código e imprime solo la frase', async (codigo) => {
		await correr(() => {
			throw fallo('usar Gemini', 'no encontré la llave', 'ponla en tu archivo de llaves', codigo);
		});
		expect(process.exitCode).toBe(codigo);
		expect(consolaError).toHaveBeenCalledTimes(1);
		expect(consolaError).toHaveBeenCalledWith(
			'No pude usar Gemini: no encontré la llave. Siguiente paso: ponla en tu archivo de llaves.',
		);
		expect(consolaLog).not.toHaveBeenCalled();
	});

	it('también atrapa un FalloEditor lanzado después de un await', async () => {
		await correr(async () => {
			await Promise.resolve();
			throw fallo('leer el EDL', 'no es JSON', 'revisa edicion-v1.json', 2);
		});
		expect(process.exitCode).toBe(2);
		expect(consolaError).toHaveBeenCalledWith('No pude leer el EDL: no es JSON. Siguiente paso: revisa edicion-v1.json.');
	});

	it('con un Error genérico sale con 1 y solo muestra su primera línea', async () => {
		await correr(() => {
			throw new Error('se rompió algo\n    at detalleInterno (archivo.ts:10:5)');
		});
		expect(process.exitCode).toBe(1);
		expect(consolaError).toHaveBeenCalledTimes(1);
		const mensaje = String(consolaError.mock.calls[0][0]);
		expect(mensaje).toBe(
			'No pude terminar: se rompió algo. Siguiente paso: revisa proyectos/_logs/fallos.log y avísame.',
		);
		expect(mensaje).toMatch(FORMATO);
		expect(mensaje).not.toContain('detalleInterno');
	});

	it('con algo que no es Error (un texto suelto) también sale con 1', async () => {
		await correr(() => {
			throw 'texto suelto';
		});
		expect(process.exitCode).toBe(1);
		expect(consolaError).toHaveBeenCalledWith(
			'No pude terminar: texto suelto. Siguiente paso: revisa proyectos/_logs/fallos.log y avísame.',
		);
	});

	it('si todo sale bien no toca el código de salida ni imprime nada', async () => {
		await correr(async () => {});
		expect(process.exitCode).toBeUndefined();
		expect(consolaError).not.toHaveBeenCalled();
		expect(appendFileSync).not.toHaveBeenCalled();
	});

	it('el detalle crudo va al log, no al chat', async () => {
		await correr(() => {
			throw fallo('subir el insert', 'el servidor respondió 503', 'espera un minuto y vuelve a intentarlo', 3, {
				respuesta: 'detalle-crudo-del-servidor',
			});
		});
		expect(process.exitCode).toBe(3);
		expect(String(consolaError.mock.calls[0][0])).not.toContain('detalle-crudo-del-servidor');
		expect(appendFileSync).toHaveBeenCalledTimes(1);
		const [ruta, linea] = vi.mocked(appendFileSync).mock.calls[0];
		expect(String(ruta)).toMatch(/proyectos[\\/]_logs[\\/]fallos\.log$/);
		expect(String(linea)).toContain('"codigo":3');
		expect(String(linea)).toContain('detalle-crudo-del-servidor');
	});
});

describe('correr() como proceso real (npx tsx)', () => {
	const carpetas: string[] = [];

	afterAll(() => {
		for (const carpeta of carpetas) rmSync(carpeta, {recursive: true, force: true});
	});

	/** Corre un script .mts con tsx en una carpeta temporal (ahí cae su proyectos/_logs) y con un entorno mínimo. */
	function correrScript(cuerpo: string) {
		const carpeta = mkdtempSync(join(tmpdir(), 'editor-fallo-'));
		carpetas.push(carpeta);
		const script = join(carpeta, 'herramienta.mts');
		writeFileSync(script, `import {correr, fallo} from '${URL_FALLO}';\n${cuerpo}\n`);
		const entorno: Record<string, string> = {};
		for (const nombre of ['PATH', 'HOME', 'TMPDIR']) {
			const valor = process.env[nombre];
			if (valor !== undefined) entorno[nombre] = valor;
		}
		const r = spawnSync(process.execPath, [TSX, script], {cwd: carpeta, env: entorno, encoding: 'utf8', timeout: 30_000});
		return {codigo: r.status, stdout: r.stdout, stderr: r.stderr, carpeta};
	}

	it.each([1, 2, 3] as CodigoFallo[])('un FalloEditor de código %i hace que el proceso salga con ese código', (codigo) => {
		const r = correrScript(
			`void correr(() => { throw fallo('leer el crudo', 'no existe', 'revisa la ruta', ${codigo}); });`,
		);
		expect(r.codigo).toBe(codigo);
		expect(r.stderr).toBe('No pude leer el crudo: no existe. Siguiente paso: revisa la ruta.\n');
		expect(r.stdout).toBe('');
		const log = join(r.carpeta, 'proyectos', '_logs', 'fallos.log');
		expect(existsSync(log)).toBe(true);
		expect(readFileSync(log, 'utf8')).toContain(`"codigo":${codigo}`);
	});

	it('un Error genérico hace que el proceso salga con 1', () => {
		const r = correrScript(`void correr(() => { throw new Error('algo inesperado'); });`);
		expect(r.codigo).toBe(1);
		expect(r.stderr).toBe(
			'No pude terminar: algo inesperado. Siguiente paso: revisa proyectos/_logs/fallos.log y avísame.\n',
		);
	});

	it('si no hay error el proceso sale con 0 y no imprime nada', () => {
		const r = correrScript(`void correr(async () => {});`);
		expect(r.codigo).toBe(0);
		expect(r.stderr).toBe('');
		expect(r.stdout).toBe('');
	});
});
