/**
 * Idioma de los mensajes al usuario (es/en).
 *
 * El idioma sale de `creador.json` → `idioma` (contrato compartido de `herramientas/lib/creador.ts`; misma ruta,
 * `rutaCreador()`). Si no hay creador.json, o no dice nada válido, se usa español: así la salida es idéntica
 * a la de siempre.
 *
 * Orden: idioma fijado con `fijarIdioma()` (pruebas) > `creador.json` → `idioma` > 'es'.
 *
 * No usa `leerCreador()` a propósito: si creador.json está mal, leerCreador lanza un fallo, y fallo.ts traduce su
 * mensaje con este módulo (se llamarían en círculo). Aquí solo se lee `idioma`, tolerante a un archivo roto.
 *
 * Solo se traducen prefijos, resúmenes y encabezados (fallo.ts, validar.ts y reporte.ts). El detalle que arma
 * cada herramienta sigue en su idioma.
 */
import {existsSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {ARCHIVO_CREADOR, rutaCreador} from './creador.ts';

export const IDIOMAS = ['es', 'en'] as const;
export type Idioma = (typeof IDIOMAS)[number];

export const esIdioma = (x: unknown): x is Idioma => typeof x === 'string' && (IDIOMAS as readonly string[]).includes(x);

const ES = {
	// fallo.ts
	'fallo.mensaje': 'No pude {que}: {porque}. Siguiente paso: {paso}.',
	'fallo.interno': 'No pude terminar: {motivo}. Siguiente paso: revisa proyectos/_logs/fallos.log y avísame.',
	'fallo.codigo.1': 'fallo interno',
	'fallo.codigo.2': 'entrada inválida o falta algo tuyo',
	'fallo.codigo.3': 'servicio externo, llave, cuota o gasto sin tu sí',
	'fallo.paso.reintentar': 'vuelve a correr el mismo comando',
	'fallo.paso.revisar_ruta': 'revisa la ruta del archivo',
	'fallo.paso.doctor': 'corre npx tsx herramientas/doctor.ts y sigue lo que diga',
	'fallo.paso.llave': 'agrega la llave en ~/.config/claude-editor/.env (la escribes tú) y revisa con npx tsx herramientas/doctor.ts',
	'fallo.paso.si_gasto': 'di cuánto cuesta y, con un sí en el mismo turno, vuelve a correr con --si-gasto=<monto>',
	'fallo.paso.cuota': 'espera a que se renueve la cuota del servicio o revisa tu plan',
	// validar.ts
	'validar.frase': 'cumple {cumple} de {total} reglas ({na} N/A)',
	'validar.problemas': '✖ {ruta}: {n} problema(s)',
	'validar.valida': '✔ {ruta}: válida · {frase}',
	'validar.que': 'validar',
	'validar.que_edicion': 'validar la edición',
	'validar.sin_ruta': 'falta la ruta de la EDL',
	'validar.sin_ruta.paso': 'corre npx tsx herramientas/validar.ts proyectos/<slug>/edicion-vN.json',
	'validar.no_existe': 'no existe {ruta}',
	'validar.no_json': '{ruta} no es JSON válido',
	'validar.no_json.paso': 'corrige el JSON y vuelve a validar',
	'validar.reglas_fallan': '{n} regla(s) no se cumplen',
	'validar.reglas_fallan.paso': 'corrige los puntos de arriba y vuelve a validar',
	// reporte.ts
	'reporte.conteo': 'cumple {cumple} de {total} checks ({na} N/A)',
	'reporte.nivel.bloqueante': 'Lo que impide subir',
	'reporte.nivel.gasto': 'Lo que gasta',
	'reporte.nivel.estetico': 'Lo estético',
	'reporte.estado.PASA': '**PASA**',
	'reporte.estado.FALLA': '**FALLA**',
	'reporte.estado.N/A': 'N/A',
	'reporte.titulo': '# Reporte — {slug}',
	'reporte.actualizado': 'Actualizado: {fecha}. Lo genera `herramientas/lib/reporte.ts` desde `reporte.json`: no lo edites a mano.',
	'reporte.nota': 'Cada número lleva su N y su fuente; lo que no se midió queda N/A con su nota. "Cumple X de Y" cuenta solo los checks medidos.',
	'reporte.sin_resultados': 'Todavía no hay resultados de render ni de QA.',
	'reporte.mas_reciente': ' (la más reciente)',
	'reporte.generado': 'Generado: {fecha}. {conteo}.',
	'reporte.tabla_checks': '| Check | Estado | Valor | Criterio | N | Fuente | Nota |',
	'reporte.tabla_etapa': '| Etapa | Tiempo |',
	'reporte.total': '| **total** | **{tiempo}** |',
	'reporte.tiempos': '## Tiempos por etapa (manifest.json)',
	'reporte.tabla_tiempos': '| Etapa | Tiempo | Detalle |',
} as const;

export type Clave = keyof typeof ES;

const EN: Record<Clave, string> = {
	'fallo.mensaje': "Couldn't {que}: {porque}. Next step: {paso}.",
	'fallo.interno': "Couldn't finish: {motivo}. Next step: check proyectos/_logs/fallos.log and tell me.",
	'fallo.codigo.1': 'internal error',
	'fallo.codigo.2': 'invalid input or something missing from you',
	'fallo.codigo.3': 'external service, key, quota or spending without your yes',
	'fallo.paso.reintentar': 'run the same command again',
	'fallo.paso.revisar_ruta': 'check the file path',
	'fallo.paso.doctor': 'run npx tsx herramientas/doctor.ts and follow what it says',
	'fallo.paso.llave': 'add the key to ~/.config/claude-editor/.env (you write it yourself) and check with npx tsx herramientas/doctor.ts',
	'fallo.paso.si_gasto': 'say how much it costs and, with a yes in the same turn, run it again with --si-gasto=<amount>',
	'fallo.paso.cuota': "wait for the service quota to reset or check your plan",
	'validar.frase': 'passes {cumple} of {total} rules ({na} N/A)',
	'validar.problemas': '✖ {ruta}: {n} problem(s)',
	'validar.valida': '✔ {ruta}: valid · {frase}',
	'validar.que': 'validate',
	'validar.que_edicion': 'validate the edit',
	'validar.sin_ruta': 'the EDL path is missing',
	'validar.sin_ruta.paso': 'run npx tsx herramientas/validar.ts proyectos/<slug>/edicion-vN.json',
	'validar.no_existe': '{ruta} does not exist',
	'validar.no_json': '{ruta} is not valid JSON',
	'validar.no_json.paso': 'fix the JSON and validate again',
	'validar.reglas_fallan': '{n} rule(s) not met',
	'validar.reglas_fallan.paso': 'fix the points above and validate again',
	'reporte.conteo': 'passes {cumple} of {total} checks ({na} N/A)',
	'reporte.nivel.bloqueante': 'What blocks publishing',
	'reporte.nivel.gasto': 'What costs money',
	'reporte.nivel.estetico': 'Look and feel',
	'reporte.estado.PASA': '**PASS**',
	'reporte.estado.FALLA': '**FAIL**',
	'reporte.estado.N/A': 'N/A',
	'reporte.titulo': '# Report — {slug}',
	'reporte.actualizado': 'Updated: {fecha}. Generated by `herramientas/lib/reporte.ts` from `reporte.json`: do not edit it by hand.',
	'reporte.nota': 'Every number carries its N and its source; anything not measured is N/A with a note. "Passes X of Y" counts only measured checks.',
	'reporte.sin_resultados': 'No render or QA results yet.',
	'reporte.mas_reciente': ' (latest)',
	'reporte.generado': 'Generated: {fecha}. {conteo}.',
	'reporte.tabla_checks': '| Check | Status | Value | Criterion | N | Source | Note |',
	'reporte.tabla_etapa': '| Stage | Time |',
	'reporte.total': '| **total** | **{tiempo}** |',
	'reporte.tiempos': '## Time per stage (manifest.json)',
	'reporte.tabla_tiempos': '| Stage | Time | Detail |',
};

const DICCIONARIOS: Record<Idioma, Record<Clave, string>> = {es: ES, en: EN};

// ───────────────────────── de dónde sale el idioma ─────────────────────────

let fijado: Idioma | null = null;

/** Fija el idioma (pruebas o un CLI con --idioma). `null` vuelve a leerlo de creador.json. */
export function fijarIdioma(i: Idioma | null): void {
	fijado = i;
}

let cache: {ruta: string; mtimeMs: number; idioma: Idioma | null} | null = null;

/** Lee `idioma` de un creador.json; null si no existe, no es JSON o no trae un idioma válido. */
export function leerIdiomaDe(ruta: string): Idioma | null {
	try {
		if (!existsSync(ruta)) return null;
		const mtimeMs = statSync(ruta).mtimeMs;
		if (cache && cache.ruta === ruta && cache.mtimeMs === mtimeMs) return cache.idioma;
		const datos = JSON.parse(readFileSync(ruta, 'utf8')) as {idioma?: unknown};
		const idioma = esIdioma(datos?.idioma) ? datos.idioma : null;
		cache = {ruta, mtimeMs, idioma};
		return idioma;
	} catch {
		return null;
	}
}

/** Idioma del creador: 'es' por defecto. `raiz` cambia la carpeta donde se busca creador.json (pruebas). */
export function idioma(raiz?: string): Idioma {
	if (fijado) return fijado;
	return leerIdiomaDe(raiz ? join(raiz, ARCHIVO_CREADOR) : rutaCreador()) ?? 'es';
}

/** Texto de una clave con sus {variables}. Una variable que falta se deja tal cual ({x}). */
export function t(clave: Clave, vars?: Record<string, string | number>, en?: Idioma): string {
	const plantilla = DICCIONARIOS[en ?? idioma()][clave] ?? ES[clave];
	if (!vars) return plantilla;
	return plantilla.replace(/\{([a-z_]+)\}/gi, (todo, nombre: string) => (nombre in vars ? String(vars[nombre]) : todo));
}

/** Todas las claves (para pruebas: ningún idioma se queda sin traducir). */
export const CLAVES = Object.keys(ES) as Clave[];
export const diccionario = (i: Idioma): Readonly<Record<Clave, string>> => DICCIONARIOS[i];
