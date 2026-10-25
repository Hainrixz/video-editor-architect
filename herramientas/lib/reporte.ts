// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Reporte de cada proyecto: proyectos/<slug>/reporte.md (lo que lees) y reporte.json (los datos con que se arma).
 *
 * Cada herramienta escribe su SECCIÓN para una versión de la edición (render, borrador, qa, sincronia, ab) con
 * `actualizarReporte()`. El .md se regenera completo desde el .json cada vez, así nunca queda a medias ni con
 * secciones de dos corridas mezcladas.
 *
 * Regla 4 de la casa: cada número lleva su N y su fuente; lo que no se midió es N/A con nota de qué falta.
 * El encabezado de cada versión dice "cumple X de Y checks (Z N/A)": Y cuenta solo los checks medidos
 * (los N/A no cuentan en el total) y X los que pasan.
 * Orden de los checks: lo que impide subir, lo que gasta, lo estético.
 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {z} from 'zod';
import {fallo} from './fallo.ts';
import {idioma, t, type Idioma} from './i18n.ts';
import {DIR_PROYECTOS, dirProyecto, leerManifest, type Manifest} from './manifest.ts';

export const ESTADOS = ['PASA', 'FALLA', 'N/A'] as const;
export type Estado = (typeof ESTADOS)[number];

/** Orden del reporte: lo que impide subir, lo que gasta, lo estético. */
export const NIVELES = ['bloqueante', 'gasto', 'estetico'] as const;
export type Nivel = (typeof NIVELES)[number];

/** Título de cada nivel en el idioma del creador (español por defecto). */
const tituloNivel = (nivel: Nivel, en?: Idioma): string => t(`reporte.nivel.${nivel}`, undefined, en);

export const CheckEsquema = z.object({
	id: z.string().min(1),
	nombre: z.string().min(1),
	nivel: z.enum(NIVELES),
	estado: z.enum(ESTADOS),
	/** Valor medido tal cual (número o texto corto); null si no se midió. */
	valor: z.union([z.number(), z.string()]).nullable(),
	criterio: z.string(),
	/** Tamaño de la muestra; null si no aplica (p. ej. un solo archivo). */
	n: z.number().int().nonnegative().nullable(),
	fuente: z.string(),
	nota: z.string().optional(),
});
export type Check = z.infer<typeof CheckEsquema>;

export const SeccionEsquema = z.looseObject({
	titulo: z.string(),
	generado_en: z.string(),
	checks: z.array(CheckEsquema),
	/** Segundos por etapa, en el orden en que corrieron. */
	tiempos_s: z.record(z.string(), z.number()).optional(),
	/** Líneas de detalle (ya en español) que se muestran debajo de la tabla. */
	detalle: z.array(z.string()).optional(),
	datos: z.record(z.string(), z.unknown()).optional(),
});
export type Seccion = z.infer<typeof SeccionEsquema>;

export const ReporteEsquema = z.looseObject({
	version: z.literal(1),
	slug: z.string(),
	actualizado_en: z.string(),
	versiones: z.record(z.string(), z.looseObject({secciones: z.record(z.string(), SeccionEsquema)})),
});
export type DatosReporte = z.infer<typeof ReporteEsquema>;

/** Orden fijo de las secciones dentro de una versión. */
export const ORDEN_SECCIONES = ['render', 'render-4k', 'borrador', 'qa', 'qa-borrador', 'sincronia', 'ab'];

export type Conteo = {cumple: number; total: number; na: number; fallan: number};

/** "cumple X de Y checks (Z N/A)": Y = checks medidos (sin los N/A). */
export function contarChecks(checks: readonly Check[]): Conteo {
	const cumple = checks.filter((c) => c.estado === 'PASA').length;
	const fallan = checks.filter((c) => c.estado === 'FALLA').length;
	const na = checks.filter((c) => c.estado === 'N/A').length;
	return {cumple, total: cumple + fallan, na, fallan};
}

export function fraseConteo(c: Conteo, en?: Idioma): string {
	return t('reporte.conteo', {cumple: c.cumple, total: c.total, na: c.na}, en);
}

/** Estado a partir de un resultado: true → PASA, false → FALLA, null → N/A. */
export function estadoDe(pasa: boolean | null): Estado {
	return pasa === null ? 'N/A' : pasa ? 'PASA' : 'FALLA';
}

/** Arma un check; `pasa = null` lo deja N/A (y entonces conviene decir en `nota` qué falta). */
export function crearCheck(c: Omit<Check, 'estado'> & {pasa: boolean | null}): Check {
	const {pasa, ...resto} = c;
	return {...resto, estado: estadoDe(pasa)};
}

export function rutaReporteJson(slug: string, proyectos = DIR_PROYECTOS): string {
	return join(dirProyecto(slug, proyectos), 'reporte.json');
}

export function rutaReporteMd(slug: string, proyectos = DIR_PROYECTOS): string {
	return join(dirProyecto(slug, proyectos), 'reporte.md');
}

export function reporteVacio(slug: string): DatosReporte {
	return {version: 1, slug, actualizado_en: new Date().toISOString(), versiones: {}};
}

/** Lee reporte.json; si no existe, uno vacío. Si está dañado, código 1 (lo escribe este sistema). */
export function leerReporte(slug: string, proyectos = DIR_PROYECTOS): DatosReporte {
	const ruta = rutaReporteJson(slug, proyectos);
	if (!existsSync(ruta)) return reporteVacio(slug);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(`leer el reporte de ${slug}`, 'reporte.json no es JSON válido', `bórralo (se regenera con la siguiente corrida de render.ts o qa.ts) o revisa ${ruta}`, 1, error);
	}
	const r = ReporteEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(
			`leer el reporte de ${slug}`,
			`reporte.json no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`,
			`bórralo (se regenera con la siguiente corrida de render.ts o qa.ts) o revisa ${ruta}`,
			1,
			r.error.issues,
		);
	}
	return r.data;
}

function escribirAtomico(ruta: string, contenido: string): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const temporal = `${ruta}.tmp-${process.pid}`;
	writeFileSync(temporal, contenido);
	renameSync(temporal, ruta);
}

export type ResultadoReporte = {rutaMd: string; rutaJson: string; conteo: Conteo};

/**
 * Guarda (o reemplaza) la sección `nombre` de la versión `version` y regenera reporte.md.
 * Devuelve el conteo de checks de esa versión (todas sus secciones).
 */
export function actualizarReporte(
	slug: string,
	version: number,
	nombre: string,
	seccion: Omit<Seccion, 'generado_en'> & {generado_en?: string},
	proyectos = DIR_PROYECTOS,
): ResultadoReporte {
	const datos = leerReporte(slug, proyectos);
	const clave = String(version);
	const completa: Seccion = SeccionEsquema.parse({...seccion, generado_en: seccion.generado_en ?? new Date().toISOString()});
	datos.versiones[clave] ??= {secciones: {}};
	datos.versiones[clave].secciones[nombre] = completa;
	datos.actualizado_en = new Date().toISOString();

	const rutaJson = rutaReporteJson(slug, proyectos);
	const rutaMd = rutaReporteMd(slug, proyectos);
	escribirAtomico(rutaJson, `${JSON.stringify(datos, null, '\t')}\n`);
	escribirAtomico(rutaMd, generarMarkdown(datos, leerManifest(slug, proyectos)));
	return {rutaMd, rutaJson, conteo: contarChecks(checksDeVersion(datos, version))};
}

/** Vuelve a escribir reporte.md desde reporte.json y el manifest actual (p. ej. después de registrar una etapa). */
export function regenerarReporte(slug: string, proyectos = DIR_PROYECTOS): string | null {
	if (!existsSync(rutaReporteJson(slug, proyectos))) return null;
	const rutaMd = rutaReporteMd(slug, proyectos);
	escribirAtomico(rutaMd, generarMarkdown(leerReporte(slug, proyectos), leerManifest(slug, proyectos)));
	return rutaMd;
}

export function checksDeVersion(datos: DatosReporte, version: number): Check[] {
	const v = datos.versiones[String(version)];
	if (!v) return [];
	return ordenarSecciones(Object.keys(v.secciones)).flatMap((s) => v.secciones[s].checks);
}

function ordenarSecciones(nombres: string[]): string[] {
	const pos = (s: string) => {
		const i = ORDEN_SECCIONES.indexOf(s);
		return i < 0 ? ORDEN_SECCIONES.length : i;
	};
	return [...nombres].sort((a, b) => pos(a) - pos(b) || a.localeCompare(b));
}

// ───────────────────────── markdown ─────────────────────────

/** 3.04 → "3.0 s"; 127.4 → "2 min 07 s". */
export function formatoSegundos(s: number): string {
	if (!Number.isFinite(s)) return 'N/A';
	if (s < 60) return `${s.toFixed(1)} s`;
	const total = Math.round(s);
	return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
}

/** Escapa lo que rompería una celda de tabla en markdown. */
function celda(x: unknown): string {
	if (x === null || x === undefined) return '—';
	const texto = typeof x === 'number' ? (Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000)) : String(x);
	return texto.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const marca = (estado: Estado, en: Idioma): string => t(`reporte.estado.${estado}`, undefined, en);

function tablaChecks(checks: Check[], en: Idioma): string[] {
	const lineas: string[] = [];
	for (const nivel of NIVELES) {
		const delNivel = checks.filter((c) => c.nivel === nivel);
		if (delNivel.length === 0) continue;
		lineas.push(`**${tituloNivel(nivel, en)}** (${fraseConteo(contarChecks(delNivel), en)})`, '');
		lineas.push(t('reporte.tabla_checks', undefined, en), '|---|---|---|---|---|---|---|');
		for (const c of delNivel) {
			lineas.push(`| ${celda(c.nombre)} | ${marca(c.estado, en)} | ${celda(c.valor)} | ${celda(c.criterio)} | ${celda(c.n)} | ${celda(c.fuente)} | ${celda(c.nota ?? '')} |`);
		}
		lineas.push('');
	}
	return lineas;
}

/** Tiempos por etapa del proyecto según el manifest (las etapas que registraron cuánto tardaron). */
export function tiemposDelManifest(manifest: Manifest | null): Array<{etapa: string; segundos: number; detalle?: Record<string, number>}> {
	if (!manifest) return [];
	const filas: Array<{etapa: string; segundos: number; detalle?: Record<string, number>}> = [];
	for (const [nombre, etapa] of Object.entries(manifest.etapas)) {
		const e = etapa as Record<string, unknown>;
		const tiempos = e.tiempos_s && typeof e.tiempos_s === 'object' ? (e.tiempos_s as Record<string, number>) : undefined;
		const total = typeof e.duracion_proceso_s === 'number' ? e.duracion_proceso_s : tiempos ? Object.values(tiempos).reduce((a, b) => a + b, 0) : null;
		if (total === null || !Number.isFinite(total)) continue;
		filas.push({etapa: nombre, segundos: total, detalle: tiempos});
	}
	return filas;
}

/** Arma reporte.md completo. Pura: recibe los datos y el manifest (o null). */
export function generarMarkdown(datos: DatosReporte, manifest: Manifest | null, en: Idioma = idioma()): string {
	const versiones = Object.keys(datos.versiones)
		.map(Number)
		.filter((n) => Number.isInteger(n))
		.sort((a, b) => b - a);
	const L: string[] = [];
	L.push(t('reporte.titulo', {slug: datos.slug}, en), '');
	L.push(t('reporte.actualizado', {fecha: datos.actualizado_en}, en), '');
	L.push(t('reporte.nota', undefined, en), '');

	if (versiones.length === 0) L.push(t('reporte.sin_resultados', undefined, en), '');

	for (const [k, version] of versiones.entries()) {
		const v = datos.versiones[String(version)];
		const nombres = ordenarSecciones(Object.keys(v.secciones));
		const checks = nombres.flatMap((s) => v.secciones[s].checks);
		L.push(`## v${version}${k === 0 ? t('reporte.mas_reciente', undefined, en) : ''} · ${fraseConteo(contarChecks(checks), en)}`, '');
		if (checks.length > 0) L.push(...tablaChecks(checks, en));
		for (const nombre of nombres) {
			const s = v.secciones[nombre];
			L.push(`### ${s.titulo}`, '');
			L.push(t('reporte.generado', {fecha: s.generado_en, conteo: fraseConteo(contarChecks(s.checks), en)}, en), '');
			if (s.tiempos_s && Object.keys(s.tiempos_s).length > 0) {
				const total = Object.values(s.tiempos_s).reduce((a, b) => a + b, 0);
				L.push(t('reporte.tabla_etapa', undefined, en), '|---|---|');
				for (const [etapa, seg] of Object.entries(s.tiempos_s)) L.push(`| ${celda(etapa)} | ${formatoSegundos(seg)} |`);
				L.push(t('reporte.total', {tiempo: formatoSegundos(total)}, en), '');
			}
			for (const linea of s.detalle ?? []) L.push(`- ${linea}`);
			if ((s.detalle ?? []).length > 0) L.push('');
		}
	}

	const tiempos = tiemposDelManifest(manifest);
	if (tiempos.length > 0) {
		L.push(t('reporte.tiempos', undefined, en), '');
		L.push(t('reporte.tabla_tiempos', undefined, en), '|---|---|---|');
		for (const t of tiempos) {
			const detalle = t.detalle ? Object.entries(t.detalle).map(([k, s]) => `${k} ${formatoSegundos(s)}`).join(' · ') : '';
			L.push(`| ${celda(t.etapa)} | ${formatoSegundos(t.segundos)} | ${celda(detalle)} |`);
		}
		L.push('');
	}
	return `${L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
