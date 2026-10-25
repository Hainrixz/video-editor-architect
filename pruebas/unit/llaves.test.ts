// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/lib/llaves.ts con un HOME temporal y un .env FALSO.
 * os.homedir() está simulado para que ninguna prueba pueda abrir tu ~/.config/claude-editor/.env real,
 * y todos los nombres de variables son inventados (nada de GEMINI_API_KEY ni GOOGLE_API_KEY).
 */
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {fuenteDeLlave, obtenerLlave, rutaArchivoLlaves} from '../../herramientas/lib/llaves.ts';

const simulado = vi.hoisted(() => ({home: ''}));

vi.mock('node:os', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:os')>();
	const homedir = () => simulado.home;
	// También el export por defecto, por si algún día llaves.ts usa `import os from 'node:os'`.
	const porDefecto = (original as unknown as {default: typeof import('node:os')}).default;
	return {...original, homedir, default: {...porDefecto, homedir}};
});

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;

/** Valores falsos y fáciles de reconocer: ninguno debe aparecer jamás en un mensaje de error. */
const VALORES = {
	archivo: 'FALSO-archivo-Q7x2',
	exportada: 'FALSO-export-K9p4',
	doble: 'FALSO doble M3z8',
	simple: 'FALSO simple R5w1',
	iguales: 'FALSOiguales==',
	espacios: 'FALSO-espacios-T6v3',
	gato: 'FALSO#gato-L2n9',
	comentada: 'FALSO-comentada-H4c7',
	repetidaPrimera: 'FALSO-primera-B8d5',
	repetidaSegunda: 'FALSO-segunda-J1f6',
	escape: 'FALSO"escape-W0g2',
	invalida: 'FALSO-invalida-Y3k8',
	entorno: 'FALSO-entorno-P5s1',
};

const CONTENIDO_ENV = [
	'# Llaves de prueba: todas falsas',
	'',
	`CE_LLAVE_ARCHIVO=${VALORES.archivo}`,
	`export CE_LLAVE_EXPORT=${VALORES.exportada}`,
	`CE_LLAVE_DOBLE="${VALORES.doble}" # comentario después de las comillas`,
	`CE_LLAVE_SIMPLE='${VALORES.simple}'`,
	`CE_LLAVE_IGUALES=${VALORES.iguales}`,
	`  CE_LLAVE_ESPACIOS   =   ${VALORES.espacios}   `,
	`CE_LLAVE_GATO=${VALORES.gato}`,
	`CE_LLAVE_COMENTADA=${VALORES.comentada} # esto ya es comentario`,
	`# CE_LLAVE_APAGADA=${VALORES.invalida}`,
	'CE_LLAVE_VACIA=',
	'CE_LLAVE_SOLO_COMENTARIO=   # la pongo después',
	'CE_LLAVE_GATO_INICIO=#pendiente',
	'CE_LLAVE_COMILLAS_VACIAS=""',
	`CE-LLAVE-INVALIDA=${VALORES.invalida}`,
	`1CE_EMPIEZA_CON_NUMERO=${VALORES.invalida}`,
	'una línea sin signo igual',
	`CE_LLAVE_REPETIDA=${VALORES.repetidaPrimera}`,
	`CE_LLAVE_REPETIDA=${VALORES.repetidaSegunda}`,
	'CE_LLAVE_ESCAPE="FALSO\\"escape-W0g2"',
].join('\n');

let home = '';

/** Crea ~/.config/claude-editor/.env dentro del HOME temporal, con permisos 700/600 como en la vida real. */
function escribirEnv(contenido: string, enHome = home): string {
	const ruta = rutaArchivoLlaves(enHome);
	mkdirSync(join(enHome, '.config', 'claude-editor'), {recursive: true, mode: 0o700});
	writeFileSync(ruta, contenido, {mode: 0o600});
	return ruta;
}

function capturar(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no se lanzó nada');
}

/** El error no puede llevar ningún valor: ni en el mensaje, ni en el detalle que va al log, ni en la pila. */
function expectSinValores(error: FalloEditor): void {
	const todo = [error.message, String(error.stack), JSON.stringify(error.detalle ?? null)].join('\n');
	for (const valor of Object.values(VALORES)) expect(todo).not.toContain(valor);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'editor-llaves-'));
	simulado.home = home;
});

afterEach(() => {
	rmSync(home, {recursive: true, force: true});
	vi.restoreAllMocks();
});

describe('rutaArchivoLlaves', () => {
	it('por defecto usa os.homedir() + .config/claude-editor/.env', () => {
		expect(rutaArchivoLlaves()).toBe(join(home, '.config', 'claude-editor', '.env'));
		expect(rutaArchivoLlaves('/otra/casa')).toBe(join('/otra/casa', '.config', 'claude-editor', '.env'));
	});
});

describe('fuenteDeLlave', () => {
	it("con la llave en el .env falso dice 'archivo'", () => {
		escribirEnv(CONTENIDO_ENV);
		expect(fuenteDeLlave('CE_LLAVE_ARCHIVO', {home, entorno: {}})).toBe('archivo');
	});

	it("sin archivo y con la variable en el entorno dice 'entorno'", () => {
		expect(fuenteDeLlave('CE_LLAVE_ENTORNO', {home, entorno: {CE_LLAVE_ENTORNO: VALORES.entorno}})).toBe('entorno');
	});

	it("sin archivo y con la variable en process.env (el entorno por defecto) dice 'entorno'", () => {
		const nombre = `CE_PRUEBA_ENTORNO_${process.pid}`;
		process.env[nombre] = VALORES.entorno;
		try {
			expect(fuenteDeLlave(nombre)).toBe('entorno');
			expect(obtenerLlave(nombre)).toBe(VALORES.entorno);
		} finally {
			delete process.env[nombre];
		}
	});

	it("sin archivo ni variable dice 'falta'", () => {
		expect(fuenteDeLlave('CE_LLAVE_QUE_NO_EXISTE', {home, entorno: {}})).toBe('falta');
		escribirEnv(CONTENIDO_ENV);
		expect(fuenteDeLlave('CE_LLAVE_QUE_NO_EXISTE', {home, entorno: {}})).toBe('falta');
	});

	it('el archivo manda sobre el entorno', () => {
		escribirEnv(CONTENIDO_ENV);
		const entorno = {CE_LLAVE_ARCHIVO: VALORES.entorno};
		expect(fuenteDeLlave('CE_LLAVE_ARCHIVO', {home, entorno})).toBe('archivo');
		expect(obtenerLlave('CE_LLAVE_ARCHIVO', {home, entorno})).toBe(VALORES.archivo);
	});

	it("un valor vacío en el archivo no cuenta: pasa al entorno o queda en 'falta'", () => {
		escribirEnv(CONTENIDO_ENV);
		expect(fuenteDeLlave('CE_LLAVE_VACIA', {home, entorno: {}})).toBe('falta');
		expect(fuenteDeLlave('CE_LLAVE_COMILLAS_VACIAS', {home, entorno: {}})).toBe('falta');
		expect(fuenteDeLlave('CE_LLAVE_VACIA', {home, entorno: {CE_LLAVE_VACIA: VALORES.entorno}})).toBe('entorno');
		expect(fuenteDeLlave('CE_LLAVE_VACIA', {home, entorno: {CE_LLAVE_VACIA: '   '}})).toBe('falta');
	});
});

describe('obtenerLlave: cómo lee el .env', () => {
	beforeEach(() => {
		escribirEnv(CONTENIDO_ENV);
	});

	it.each([
		['KEY=VALUE simple', 'CE_LLAVE_ARCHIVO', VALORES.archivo],
		['con prefijo export', 'CE_LLAVE_EXPORT', VALORES.exportada],
		['entre comillas dobles y con comentario después', 'CE_LLAVE_DOBLE', VALORES.doble],
		['entre comillas simples', 'CE_LLAVE_SIMPLE', VALORES.simple],
		['con signos = dentro del valor', 'CE_LLAVE_IGUALES', VALORES.iguales],
		['con espacios alrededor', 'CE_LLAVE_ESPACIOS', VALORES.espacios],
		['con # pegado dentro del valor', 'CE_LLAVE_GATO', VALORES.gato],
		['con comentario al final', 'CE_LLAVE_COMENTADA', VALORES.comentada],
		['repetida (gana la última)', 'CE_LLAVE_REPETIDA', VALORES.repetidaSegunda],
		['con comilla escapada', 'CE_LLAVE_ESCAPE', VALORES.escape],
	])('%s', (_caso, nombre, esperado) => {
		expect(obtenerLlave(nombre, {home, entorno: {}})).toBe(esperado);
	});

	it('ignora las líneas comentadas y las de nombre inválido', () => {
		expect(fuenteDeLlave('CE_LLAVE_APAGADA', {home, entorno: {}})).toBe('falta');
		expect(fuenteDeLlave('CE_EMPIEZA_CON_NUMERO', {home, entorno: {}})).toBe('falta');
	});

	it('un valor que solo es comentario cuenta como vacío', () => {
		expect(fuenteDeLlave('CE_LLAVE_SOLO_COMENTARIO', {home, entorno: {}})).toBe('falta');
		expect(fuenteDeLlave('CE_LLAVE_GATO_INICIO', {home, entorno: {}})).toBe('falta');
	});

	it('entiende finales de línea de Windows y un BOM al inicio', () => {
		escribirEnv(`\uFEFFCE_LLAVE_CRLF=${VALORES.archivo}\r\nCE_LLAVE_OTRA='${VALORES.simple}'\r\n`);
		expect(obtenerLlave('CE_LLAVE_CRLF', {home, entorno: {}})).toBe(VALORES.archivo);
		expect(obtenerLlave('CE_LLAVE_OTRA', {home, entorno: {}})).toBe(VALORES.simple);
	});
});

describe('errores: dicen el nombre y dónde ponerla, nunca el valor', () => {
	it('si falta, lanza código 3 con el nombre, la ruta con ~ y el formato de una frase', () => {
		escribirEnv(CONTENIDO_ENV);
		const error = capturar(() => obtenerLlave('CE_LLAVE_QUE_NO_EXISTE', {entorno: {CE_OTRA: VALORES.entorno}}));
		expect(error.codigo).toBe(3);
		expect(error.message).toBe(
			'No pude usar CE_LLAVE_QUE_NO_EXISTE: no está en ~/.config/claude-editor/.env ni en tus variables de entorno. ' +
				'Siguiente paso: agrégala tú a ~/.config/claude-editor/.env con la línea CE_LLAVE_QUE_NO_EXISTE=<tu llave> ' +
				'y deja ese archivo con permisos 600.',
		);
		expect(error.message).toMatch(FORMATO);
		expectSinValores(error);
	});

	it('con un HOME inyectado distinto al tuyo, el mensaje lleva la ruta completa', () => {
		const otraCasa = mkdtempSync(join(tmpdir(), 'editor-llaves-otra-'));
		try {
			const error = capturar(() => obtenerLlave('CE_LLAVE_QUE_NO_EXISTE', {home: otraCasa, entorno: {}}));
			expect(error.message).toContain(rutaArchivoLlaves(otraCasa));
		} finally {
			rmSync(otraCasa, {recursive: true, force: true});
		}
	});

	it('si el archivo existe pero no se puede leer, lanza código 3 sin mostrar nada de su contenido', () => {
		if (process.getuid?.() === 0) return; // root lee todo: esta prueba no aplica
		const ruta = escribirEnv(CONTENIDO_ENV);
		chmodSync(ruta, 0o000);
		try {
			const error = capturar(() => obtenerLlave('CE_LLAVE_ARCHIVO', {home, entorno: {CE_LLAVE_ARCHIVO: VALORES.entorno}}));
			expect(error.codigo).toBe(3);
			expect(error.message).toMatch(FORMATO);
			expect(error.message).toContain('no tengo permiso para abrir ~/.config/claude-editor/.env');
			expectSinValores(error);
			expect(capturar(() => fuenteDeLlave('CE_LLAVE_ARCHIVO', {home, entorno: {}})).codigo).toBe(3);
		} finally {
			chmodSync(ruta, 0o600);
		}
	});

	it('si en lugar del archivo hay una carpeta, lanza código 3', () => {
		mkdirSync(rutaArchivoLlaves(home), {recursive: true});
		const error = capturar(() => obtenerLlave('CE_LLAVE_ARCHIVO', {home, entorno: {}}));
		expect(error.codigo).toBe(3);
		expect(error.message).toContain('es una carpeta');
		expect(error.message).toMatch(FORMATO);
	});

	it.each(['CE-LLAVE', '', '1CE', 'CE LLAVE', 'CE_LLAVE\n'])('un nombre inválido (%j) es un error interno, código 1', (nombre) => {
		escribirEnv(CONTENIDO_ENV);
		const error = capturar(() => obtenerLlave(nombre, {home, entorno: {}}));
		expect(error.codigo).toBe(1);
		expect(error.message).toMatch(FORMATO);
		expectSinValores(error);
	});

	it('no escribe nada en la consola en ningún caso', () => {
		const espias = (['log', 'info', 'warn', 'error', 'debug'] as const).map((metodo) =>
			vi.spyOn(console, metodo).mockImplementation(() => {}),
		);
		escribirEnv(CONTENIDO_ENV);
		obtenerLlave('CE_LLAVE_ARCHIVO', {home, entorno: {}});
		fuenteDeLlave('CE_LLAVE_DOBLE', {home, entorno: {}});
		capturar(() => obtenerLlave('CE_LLAVE_QUE_NO_EXISTE', {home, entorno: {}}));
		capturar(() => obtenerLlave('CE-LLAVE', {home, entorno: {}}));
		for (const espia of espias) expect(espia).not.toHaveBeenCalled();
	});
});
