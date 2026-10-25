// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Tu estilo aprendido (estilo/estilo.json): lectura con Zod y getters tipados para el director, el layout, el selector
 * de SFX y los subtítulos.
 *
 * Forma de cada número (regla 4 de la casa): una métrica {valor | "N/A", n, fuente, falta}.
 *   - "N/A" siempre dice qué falta (`falta`), y los N/A no cuentan en ningún total.
 *   - n = cuántos reels (o eventos, según diga la unidad) lo sostienen. n = 0 solo con fuente "supuesto…" o "brand-kit…".
 * Aparte de las métricas, cada sección trae un bloque `config` con los valores listos para los componentes
 * (src/estilo/capas.ts → resolverEstilo*, src/estilo/fuentes.ts) y las herramientas. Los config no llevan `valor`.
 *
 * Quien lee estilo.json con otras rutas (subtitulos.ts → leerMiniEstilo, lib/sfx.ts → estiloSfxDesde,
 * lib/director/estilo.ts → buscarNumero) encuentra ahí mismo lo que busca: agregar.ts escribe esas claves y sus alias.
 * Puro salvo leerEstilo / leerMomentos (leen archivos).
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {z} from 'zod';
import {EstiloSubtitulosEdl, type Edicion} from '../../src/esquema/edicion.ts';
import {ESTILO_TARJETA_POR_DEFECTO} from '../../src/estilo/capas.ts';
import {aplicarDecisionTarjetas, type DecisionZona} from '../../src/estilo/zona-segura.ts';
import {fallo} from './fallo.ts';
import {RAIZ} from './manifest.ts';
import {leerPerfilMotor} from './perfil-estilo.ts';

export const RUTA_ESTILO = join(RAIZ, 'estilo', 'estilo.json');
export const RUTA_MOMENTOS = join(RAIZ, 'estilo', 'momentos.jsonl');
export const NA = 'N/A' as const;

// ───────────────────────── métricas ─────────────────────────

const ValorMetrica = z.union([z.literal(NA), z.number(), z.string(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);

/** ¿La fuente declara que es un supuesto (o el brand kit)? Entonces n puede ser 0. */
export const esFuenteSupuesta = (fuente: string): boolean => /^(supuesto|brand-kit)/i.test(fuente.trim());

export const MetricaEsquema = z
	.looseObject({
		valor: ValorMetrica,
		n: z.number().int().nonnegative(),
		fuente: z.string().min(1),
		falta: z.string().min(1).nullable(),
	})
	.superRefine((m, ctx) => {
		if (m.valor === NA && !m.falta) ctx.addIssue({code: 'custom', path: ['falta'], message: 'un N/A tiene que decir qué falta'});
		if (m.valor !== NA && typeof m.valor === 'number' && !Number.isFinite(m.valor)) ctx.addIssue({code: 'custom', path: ['valor'], message: 'el valor no es un número finito'});
		if (m.valor !== NA && m.n === 0 && !esFuenteSupuesta(m.fuente)) {
			ctx.addIssue({code: 'custom', path: ['n'], message: `un valor con n = 0 tiene que ser un supuesto (fuente "${m.fuente}")`});
		}
	});

export type Metrica<T = unknown> = {valor: T | typeof NA; n: number; fuente: string; falta: string | null} & Record<string, unknown>;

export const esNA = (m: {valor: unknown} | null | undefined): boolean => !m || m.valor === NA || m.valor === null;

/** El número de una métrica, o null si es N/A (o no es número). */
export function numero(m: {valor: unknown} | null | undefined): number | null {
	if (!m || typeof m.valor !== 'number' || !Number.isFinite(m.valor)) return null;
	return m.valor;
}

/** Arma una métrica medida. */
export function medida<T>(valor: T, n: number, fuente: string, extra: Record<string, unknown> = {}): Metrica<T> {
	return {valor, n, fuente, falta: null, ...extra};
}

/** Arma un N/A con lo que falta. */
export function sinDato(falta: string, fuente: string, extra: Record<string, unknown> = {}): Metrica<never> {
	return {valor: NA, n: 0, fuente, falta, ...extra};
}

/** Arma un supuesto (n = 0, fuente "supuesto (…)"). */
export function supuesto<T>(valor: T, deDonde: string, falta: string, extra: Record<string, unknown> = {}): Metrica<T> {
	return {valor, n: 0, fuente: `supuesto (${deDonde})`, falta, ...extra};
}

export type ProblemaMetrica = {ruta: string; problema: string};
export type ConteoMetricas = {total: number; medidas: number; na: number; supuestos: number};

/**
 * Recorre un JSON: todo objeto con la clave `valor` es una métrica y tiene que cumplir {valor|"N/A", n, fuente, falta}.
 * Devuelve los problemas (ruta y qué falla) y el conteo (los N/A no cuentan como medidas).
 */
export function revisarMetricas(json: unknown): {problemas: ProblemaMetrica[]; conteo: ConteoMetricas} {
	const problemas: ProblemaMetrica[] = [];
	const conteo: ConteoMetricas = {total: 0, medidas: 0, na: 0, supuestos: 0};
	const visitar = (x: unknown, ruta: string) => {
		if (Array.isArray(x)) {
			x.forEach((y, i) => visitar(y, `${ruta}[${i}]`));
			return;
		}
		if (typeof x !== 'object' || x === null) return;
		const o = x as Record<string, unknown>;
		if (Object.hasOwn(o, 'valor')) {
			conteo.total++;
			const r = MetricaEsquema.safeParse(o);
			if (!r.success) for (const i of r.error.issues) problemas.push({ruta: ruta || '(raíz)', problema: `${i.path.join('.') || 'métrica'}: ${i.message}`});
			else if (o.valor === NA) conteo.na++;
			else if (esFuenteSupuesta(String(o.fuente))) conteo.supuestos++;
			else conteo.medidas++;
			// Lo que cuelga de una métrica (p. ej. por_reel) no son métricas aparte, salvo objetos con su propio `valor`.
			for (const [k, v] of Object.entries(o)) if (k !== 'valor' && typeof v === 'object' && v !== null) visitar(v, `${ruta}.${k}`);
			return;
		}
		for (const [k, v] of Object.entries(o)) visitar(v, ruta ? `${ruta}.${k}` : k);
	};
	visitar(json, '');
	return {problemas, conteo};
}

// ───────────────────────── bloques config ─────────────────────────

const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const Origen = z.record(z.string(), z.string()).optional();
const SombraConfig = z.union([z.boolean(), z.looseObject({activa: z.boolean(), color: Color, opacidad: z.number(), desenfoque_px: z.number(), dy_px: z.number()}).partial()]);

/** Lo que entiende resolverEstiloTitular (src/estilo/capas.ts). */
export const ConfigTitular = z
	.looseObject({
		fuente: z.enum(['tiktok-sans', 'instrument-sans', 'inter']),
		peso: z.number().int().min(100).max(900),
		alto_mayuscula_px: z.number().positive(),
		color: Color,
		borde_px: z.number().min(0),
		color_borde: Color,
		x: z.number(),
		y: z.number(),
		interlineado_px: z.number().positive(),
		ancho_max: z.number().positive(),
		sombra: SombraConfig,
		origen: Origen,
	})
	.partial();

/** Lo que entiende resolverEstiloTarjeta. */
export const ConfigTarjetas = z
	.looseObject({
		fuente: z.enum(['tiktok-sans', 'instrument-sans', 'inter']),
		peso: z.number().int().min(100).max(900),
		alto_mayuscula_px: z.number().positive(),
		color_texto: Color,
		color_fondo: Color,
		pad_arriba_px: z.number().min(0),
		pad_abajo_px: z.number().min(0),
		pad_lados_px: z.number().min(0),
		radio_px: z.number().min(0),
		interlineado_px: z.number().positive(),
		ancho_max: z.number().positive(),
		x: z.number(),
		y: z.number(),
		escala_grande: z.number().positive(),
		escala_lista: z.number().positive(),
		separacion_px: z.number().min(0),
		entrada: z.enum(['corte', 'pop']),
		origen: Origen,
	})
	.partial();

/** Lo que entiende resolverEstiloSticker. */
export const ConfigStickers = z
	.looseObject({
		entrada: z.enum(['pop', 'corte', 'rebote']),
		salida: z.enum(['corte', 'encoger']),
		pop: z.looseObject({escalaInicial: z.number(), cuadros: z.number(), opacidadInicial: z.number(), cuadrosOpacidad: z.number()}).partial(),
		ancho_px: z.number().positive(),
		origen: Origen,
	})
	.partial();

/** Lo que entiende resolverEstiloInsert. */
export const ConfigInserts = z
	.looseObject({
		tarjeta: z.looseObject({x: z.number(), y: z.number(), ancho_px: z.number().positive(), radio_px: z.number().min(0), entrada: z.enum(['pop', 'deslizar', 'corte'])}).partial(),
		pantalla_completa: z.looseObject({ken_burns_desde: z.number(), ken_burns_hasta: z.number()}).partial(),
		origen: Origen,
	})
	.partial();

/** Lo de subtítulos que va a edicion.estilos.subtitulos (mismo contrato de la EDL), más su origen. */
export const ConfigSubtitulos = EstiloSubtitulosEdl.extend({origen: Origen});

// ───────────────────────── estilo.json ─────────────────────────

const Seccion = z.looseObject({});
const SeccionConMetricas = <T extends z.ZodRawShape>(forma: T) => z.looseObject(forma);

export const EstiloEsquema = z.looseObject({
	version: z.string().min(1),
	esquema: z.literal(1),
	generado_en: z.string(),
	generado_por: z.string(),
	aprobado: z.boolean(),
	metodo: Seccion,
	corpus: Seccion,
	muestra: Seccion,
	subtitulos: SeccionConMetricas({config: ConfigSubtitulos, ancho_p90: MetricaEsquema, alto_mayuscula_p50: MetricaEsquema, grosor_borde_p50: MetricaEsquema, color_texto: MetricaEsquema, color_borde: MetricaEsquema}),
	franja_subtitulos: SeccionConMetricas({y_p10: MetricaEsquema, y_p50: MetricaEsquema, y_p90: MetricaEsquema, ancho_p90: MetricaEsquema}),
	titular: SeccionConMetricas({config: ConfigTitular, pct_reels_con_titular: MetricaEsquema}),
	tarjetas: SeccionConMetricas({config: ConfigTarjetas, por_minuto: MetricaEsquema}),
	stickers: SeccionConMetricas({config: ConfigStickers, por_minuto: MetricaEsquema}),
	inserts: SeccionConMetricas({config: ConfigInserts, por_minuto: MetricaEsquema}),
	zooms: SeccionConMetricas({por_minuto: MetricaEsquema}),
	efectos: SeccionConMetricas({desenfoque_por_minuto: MetricaEsquema}),
	sfx: SeccionConMetricas({prob_silencio: MetricaEsquema, offset_cuadros: MetricaEsquema, nivel_lu: MetricaEsquema, ganancia_db: MetricaEsquema, eventos_por_video: MetricaEsquema}),
	cortes: Seccion,
	encuadre: Seccion,
	zona_ui: SeccionConMetricas({arriba: MetricaEsquema, abajo: MetricaEsquema, izquierda: MetricaEsquema, derecha: MetricaEsquema}),
	tapa_cabeza: SeccionConMetricas({p50: MetricaEsquema, p90: MetricaEsquema}),
	cabeza: SeccionConMetricas({margen_barbilla_px: MetricaEsquema}),
	ritmo: SeccionConMetricas({gancho: Seccion, cuerpo: Seccion, cierre: Seccion}),
	densidades: SeccionConMetricas({tarjetas_por_min: MetricaEsquema, stickers_por_min: MetricaEsquema, inserts_por_min: MetricaEsquema}),
	tipografia: Seccion,
	resaltado: Seccion,
	textos: Seccion,
	supuestos: Seccion,
	comparacion_grupos: Seccion,
	resumen: z.looseObject({metricas: z.number().int(), medidas: z.number().int(), na: z.number().int(), supuestos: z.number().int()}),
});

export type Estilo = z.infer<typeof EstiloEsquema>;

export type EstiloLeido = {estilo: Estilo; crudo: unknown; texto: string; hash: string; version: string; ruta: string; conteo: ConteoMetricas};

/** Huella corta del texto de estilo.json (para edicion.estilo_hash). */
export const huellaEstilo = (texto: string): string => `estilo-${createHash('sha256').update(texto).digest('hex').slice(0, 12)}`;

/** Valida un objeto ya parseado (pura). Devuelve los problemas (vacío = bien). */
export function problemasDelEstilo(crudo: unknown): string[] {
	const r = EstiloEsquema.safeParse(crudo);
	const problemas = r.success ? [] : r.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`);
	const {problemas: metricas} = revisarMetricas(crudo);
	return [...problemas, ...metricas.slice(0, 20).map((p) => `${p.ruta}: ${p.problema}`)];
}

/** Lee y valida estilo/estilo.json. Falla con código 2 si no existe, no es JSON o no cumple el esquema. */
export function leerEstilo(ruta = RUTA_ESTILO): EstiloLeido {
	const legible = relative(RAIZ, ruta) || ruta;
	if (!existsSync(ruta)) throw fallo('leer tu estilo', `no existe ${legible}`, 'corre npx tsx herramientas/estilo/aprender.ts --muestra (o agregar.ts si ya mediste)', 2);
	const texto = readFileSync(ruta, 'utf8');
	let crudo: unknown;
	try {
		crudo = JSON.parse(texto);
	} catch (error) {
		throw fallo('leer tu estilo', `${legible} no es JSON válido`, 'vuelve a generarlo con npx tsx herramientas/estilo/agregar.ts', 2, error);
	}
	const problemas = problemasDelEstilo(crudo);
	if (problemas.length) throw fallo('leer tu estilo', `${legible} no cumple el esquema (${problemas[0]})`, 'vuelve a generarlo con npx tsx herramientas/estilo/agregar.ts', 2, problemas);
	const estilo = EstiloEsquema.parse(crudo);
	return {estilo, crudo, texto, hash: huellaEstilo(texto), version: estilo.version, ruta, conteo: revisarMetricas(crudo).conteo};
}

// ───────────────────────── getters ─────────────────────────

/** Valor por ruta con puntos ("tarjetas.duracion_s.p50"). */
export function enRuta(obj: unknown, ruta: string): unknown {
	let actual: unknown = obj;
	for (const llave of ruta.split('.')) {
		if (typeof actual !== 'object' || actual === null) return undefined;
		actual = (actual as Record<string, unknown>)[llave];
	}
	return actual;
}

/** La métrica en una ruta (o null si no hay métrica ahí). */
export function metrica(e: Estilo | unknown, ruta: string): Metrica | null {
	const v = enRuta(e, ruta);
	if (typeof v !== 'object' || v === null || !Object.hasOwn(v, 'valor')) return null;
	return v as Metrica;
}

/** Número en una ruta (null si es N/A o no existe). */
export const numeroEn = (e: Estilo | unknown, ruta: string): number | null => numero(metrica(e, ruta));

const sinOrigen = <T extends Record<string, unknown>>(c: T | undefined): Omit<T, 'origen'> => {
	if (!c) return {} as Omit<T, 'origen'>;
	const {origen: _o, ...resto} = c;
	void _o;
	return resto;
};

/** La zona del estilo activo (perfil.json → motor.zona; sin estilo, la neutra). */
const zonaActiva = (): DecisionZona => leerPerfilMotor().zona;

/**
 * Lo que va en edicion.estilos.subtitulos (contrato EstiloSubtitulosEdl, sin `origen`). La y es la del estilo activo
 * (perfil.json → motor.zona.subtitulos_y) si la decide; si no, la medida.
 */
export function configSubtitulos(e: Estilo, zona: DecisionZona = zonaActiva()): z.infer<typeof EstiloSubtitulosEdl> {
	const medido = sinOrigen(e.subtitulos.config as Record<string, unknown>);
	return EstiloSubtitulosEdl.parse(zona.subtitulos_y === null ? medido : {...medido, y: zona.subtitulos_y});
}

/** Lo que va en edicion.estilos.titular (para resolverEstiloTitular). */
export const configTitular = (e: Estilo): Record<string, unknown> => sinOrigen(e.titular.config as Record<string, unknown>);
/**
 * Lo que va en edicion.estilos.tarjetas (para resolverEstiloTarjeta): lo medido con la zona del estilo activo encima
 * (src/estilo/zona-segura.ts → aplicarDecisionTarjetas: letra, relleno, ancho máximo y bajada).
 */
export const configTarjetas = (e: Estilo, zona: DecisionZona = zonaActiva()): Record<string, unknown> =>
	aplicarDecisionTarjetas(sinOrigen(e.tarjetas.config as Record<string, unknown>), ESTILO_TARJETA_POR_DEFECTO, zona);
/** Lo que va en edicion.estilos.stickers (para resolverEstiloSticker). */
export const configStickers = (e: Estilo): Record<string, unknown> => sinOrigen(e.stickers.config as Record<string, unknown>);
/** Para resolverEstiloInsert (la EDL todavía no tiene estilos.inserts). */
export const configInserts = (e: Estilo): Record<string, unknown> => sinOrigen(e.inserts.config as Record<string, unknown>);

/** El bloque `estilos` de una edición con el estilo medido (armar-edl.ts y el director lo pueden copiar tal cual). */
export function estilosEdl(e: Estilo, zona: DecisionZona = zonaActiva()): Edicion['estilos'] {
	return {subtitulos: configSubtitulos(e, zona), titular: configTitular(e), tarjetas: configTarjetas(e, zona), stickers: configStickers(e)};
}

/** Parámetros del agrupador de subtítulos (null = usa el de por defecto). */
export function parametrosSubtitulos(e: Estilo): {duracion_min_s: number | null; palabras_objetivo: number | null; adelanto_cuadros: number | null} {
	return {
		duracion_min_s: numeroEn(e, 'subtitulos.duracion_evento.p10'),
		palabras_objetivo: numeroEn(e, 'subtitulos.palabras_por_evento.p50'),
		adelanto_cuadros: numeroEn(e, 'subtitulos.adelanto_cuadros'),
	};
}

/** Franja de subtítulos (centro del texto, base 1920) y su ancho máximo. */
export function franjaSubtitulos(e: Estilo): {y_p10: number | null; y_p50: number | null; y_p90: number | null; ancho_p90: number | null} {
	return {
		y_p10: numeroEn(e, 'franja_subtitulos.y_p10'),
		y_p50: numeroEn(e, 'franja_subtitulos.y_p50'),
		y_p90: numeroEn(e, 'franja_subtitulos.y_p90'),
		ancho_p90: numeroEn(e, 'franja_subtitulos.ancho_p90'),
	};
}

/** Zona donde viven tus capas (px base). Lo que sea N/A sale null: el layout usa la guía de Meta. */
export function zonaUi(e: Estilo): {arriba: number | null; abajo: number | null; izquierda: number | null; derecha: number | null} {
	return {arriba: numeroEn(e, 'zona_ui.arriba'), abajo: numeroEn(e, 'zona_ui.abajo'), izquierda: numeroEn(e, 'zona_ui.izquierda'), derecha: numeroEn(e, 'zona_ui.derecha')};
}

/** Densidades (por minuto) ponderadas con el puntaje del corpus. */
export function densidades(e: Estilo): Record<'tarjetas' | 'stickers' | 'inserts' | 'zooms' | 'desenfoque' | 'capas', number | null> {
	return {
		tarjetas: numeroEn(e, 'densidades.tarjetas_por_min'),
		stickers: numeroEn(e, 'densidades.stickers_por_min'),
		inserts: numeroEn(e, 'densidades.inserts_por_min'),
		zooms: numeroEn(e, 'densidades.zooms_por_min'),
		desenfoque: numeroEn(e, 'densidades.desenfoque_por_min'),
		capas: numeroEn(e, 'densidades.capas_por_min'),
	};
}

/** Capas por minuto en el gancho (0–3 s), el cuerpo y el cierre (últimos 5 s): p50 de tus reels. */
export function ritmo(e: Estilo): {gancho: number | null; cuerpo: number | null; cierre: number | null} {
	return {gancho: numeroEn(e, 'ritmo.gancho.capas_por_min'), cuerpo: numeroEn(e, 'ritmo.cuerpo.capas_por_min'), cierre: numeroEn(e, 'ritmo.cierre.capas_por_min')};
}

/** Máximo de capas que tapan la cabeza por reel (p90). Si es N/A, 1 (plan, excepción 2). */
export function tapaCabezaMaxima(e: Estilo): {valor: number; medido: boolean} {
	const v = numeroEn(e, 'tapa_cabeza.p90');
	return v === null ? {valor: 1, medido: false} : {valor: v, medido: true};
}

/** Aire entre tu barbilla y el borde de arriba de una capa: lo que dejas en tus reels (p10) y lo que pide el plan. */
export function margenBarbilla(e: Estilo): {medido_p10: number | null; plan: number} {
	return {medido_p10: numeroEn(e, 'cabeza.margen_barbilla_px'), plan: numeroEn(e, 'cabeza.margen_plan') ?? 60};
}

/** Duraciones típicas (s) de una clase de capa: p10, p50 y p90. */
export function duraciones(e: Estilo, clase: 'tarjetas' | 'stickers' | 'inserts'): {p10: number | null; p50: number | null; p90: number | null} {
	return {p10: numeroEn(e, `${clase}.duracion_s.p10`), p50: numeroEn(e, `${clase}.duracion_s.p50`), p90: numeroEn(e, `${clase}.duracion_s.p90`)};
}

/** La sección sfx tal cual (lib/sfx.ts → estiloSfxDesde la interpreta para el selector). */
export const seccionSfx = (e: Estilo): Record<string, unknown> => e.sfx as Record<string, unknown>;

// ───────────────────────── momentos.jsonl ─────────────────────────

export const MomentoEsquema = z.looseObject({
	reel: z.string().min(1),
	grupo: z.enum(['top', 'recientes', 'resto', 'otros']),
	puntaje: z.number().nullable(),
	t: z.number().nonnegative(),
	hasta: z.number().nonnegative(),
	clase: z.enum(['tarjeta', 'sticker', 'insert']),
	texto: z.string().nullable(),
	tipo_palabra: z.string().nullable(),
	palabras_dichas: z.string(),
	desfase_cuadros: z.number().nullable(),
	con_sfx: z.boolean().nullable(),
	posicion: z.looseObject({x: z.number(), y: z.number(), w: z.number(), h: z.number()}),
});

export type Momento = z.infer<typeof MomentoEsquema>;

/** Lee estilo/momentos.jsonl (una capa por línea). Falla con código 2 si una línea no cumple el esquema. */
export function leerMomentos(ruta = RUTA_MOMENTOS): Momento[] {
	const legible = relative(RAIZ, ruta) || ruta;
	if (!existsSync(ruta)) throw fallo('leer los momentos de tu estilo', `no existe ${legible}`, 'corre npx tsx herramientas/estilo/agregar.ts', 2);
	const salida: Momento[] = [];
	readFileSync(ruta, 'utf8')
		.split('\n')
		.forEach((linea, i) => {
			if (!linea.trim()) return;
			let j: unknown;
			try {
				j = JSON.parse(linea);
			} catch (error) {
				throw fallo('leer los momentos de tu estilo', `la línea ${i + 1} de ${legible} no es JSON`, 'vuelve a generarlo con agregar.ts', 2, error);
			}
			const r = MomentoEsquema.safeParse(j);
			if (!r.success) throw fallo('leer los momentos de tu estilo', `la línea ${i + 1} de ${legible} no cumple el esquema (${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message})`, 'vuelve a generarlo con agregar.ts', 2);
			salida.push(r.data);
		});
	return salida;
}
