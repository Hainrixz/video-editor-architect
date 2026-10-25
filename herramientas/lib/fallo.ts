// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Formato único de errores del editor (regla 8 de la casa):
 * una frase con qué pasó + el siguiente paso concreto. El detalle crudo va a un log, no al chat.
 *
 * Códigos de salida:
 *   0 bien
 *   1 fallo interno (bug o algo que no cuadra dentro del sistema)
 *   2 entrada inválida o falta algo tuyo (archivo, aprobación, dato)
 *   3 servicio externo, llave, cuota o gasto sin tu sí
 */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {t} from './i18n.ts';

export type CodigoFallo = 1 | 2 | 3;

export class FalloEditor extends Error {
	constructor(
		public readonly que: string,
		public readonly porque: string,
		public readonly siguientePaso: string,
		public readonly codigo: CodigoFallo,
		public readonly detalle?: unknown,
	) {
		super(t('fallo.mensaje', {que, porque, paso: siguientePaso}));
		this.name = 'FalloEditor';
	}
}

export function fallo(
	que: string,
	porque: string,
	siguientePaso: string,
	codigo: CodigoFallo,
	detalle?: unknown,
): FalloEditor {
	return new FalloEditor(que, porque, siguientePaso, codigo, detalle);
}

const RUTA_LOG = join(process.cwd(), 'proyectos', '_logs', 'fallos.log');

/** Escribe el detalle crudo en el log local (nunca en el chat). */
export function registrarDetalle(error: unknown, rutaLog = RUTA_LOG): void {
	try {
		mkdirSync(dirname(rutaLog), {recursive: true});
		const cuerpo =
			error instanceof FalloEditor
				? {mensaje: error.message, codigo: error.codigo, detalle: error.detalle}
				: {mensaje: String(error), pila: error instanceof Error ? error.stack : undefined};
		appendFileSync(rutaLog, `${new Date().toISOString()} ${JSON.stringify(cuerpo)}\n`);
	} catch {
		// Si ni el log se puede escribir, no tapamos el error original.
	}
}

/**
 * Envuelve el `main` de cada CLI: imprime una sola frase (en el idioma de creador.json, español por defecto)
 * y sale con el código correcto.
 * Cualquier error que no sea FalloEditor se trata como fallo interno (código 1).
 */
export async function correr(main: () => Promise<void> | void): Promise<void> {
	try {
		await main();
	} catch (error) {
		registrarDetalle(error);
		if (error instanceof FalloEditor) {
			console.error(error.message);
			process.exitCode = error.codigo;
			return;
		}
		const motivo = error instanceof Error ? error.message.split('\n')[0] : String(error);
		console.error(t('fallo.interno', {motivo}));
		process.exitCode = 1;
	}
}

/**
 * ¿Este módulo es el script que se ejecutó? Robusto a espacios en la ruta
 * ("Claude Editor de Video"), que import.meta.url codifica como %20.
 */
export function esPrincipal(urlModulo: string): boolean {
	if (!process.argv[1]) return false;
	return fileURLToPath(urlModulo) === resolve(process.argv[1]);
}
