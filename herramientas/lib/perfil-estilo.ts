// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Lo que el MOTOR toma del estilo activo: `estilo/estilos/<id>/perfil.json` → clave `motor`. Son las decisiones del
 * estilo que mandan sobre lo medido (velocidad, aires, zona de subtítulos y capas, ritmo) y que antes vivían fijas en
 * el código o en JSON globales.
 *
 * De dónde sale el id: `opciones.estilo`; si no, `creador.json` → `estilo_activo`; si no, ninguno (MOTOR_NEUTRO).
 * Lo que el perfil no trae sale de MOTOR_NEUTRO (campo por campo en `zona`). `origen.claves` dice qué secciones trajo
 * el perfil de verdad: cortes.ts solo usa `velocidad` y `aires` del perfil si vienen ahí (si no, sus archivos de
 * respaldo estilo/velocidad.json y estilo/aires.json, y luego la calibración).
 *
 * Remotion (src/) no lee esto: lo que cambia el dibujo (y de los subtítulos, tamaño y relleno de las tarjetas) lo
 * escriben las herramientas en la EDL (`edicion.estilos.*`) al armarla.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {z} from 'zod';
import {GUIA_REELS, type DecisionZona} from '../../src/estilo/zona-segura.ts';
import {leerCreador, RAIZ_CREADOR} from './creador.ts';
import {fallo} from './fallo.ts';

export const PATRON_ID_ESTILO = /^[a-z0-9][a-z0-9_-]*$/;

const Decision = z.string().min(1);

export const VelocidadMotorEsquema = z.looseObject({factor: z.number().min(0.5).max(2), decision: Decision});
export const AiresMotorEsquema = z.looseObject({
	hueco_minimo_s: z.number().min(0.1).max(1),
	umbral_sobre_piso_db: z.number().min(6).max(30).optional(),
	quitar_sueltos_s: z.number().min(0).max(2).optional(),
	decision: Decision,
});
export const ZonaMotorEsquema = z.looseObject({
	subtitulos_y: z.number().min(0).max(1920).nullable(),
	bajada_capas_px: z.number().min(-400).max(400),
	tarjeta_letra: z.number().positive().max(3),
	tarjeta_relleno: z.number().min(0).max(3),
	prompt_letra: z.number().positive().max(3),
	ancho_max: z.number().positive().max(1080),
	nota: Decision,
	puede_tapar_cara: z.boolean(),
	margen_boca_px: z.number().nullable(),
	nota_cara: Decision,
});
export const RitmoMotorEsquema = z.looseObject({
	tarjetas_por_min: z.number().nonnegative(),
	stickers_por_min: z.number().nonnegative(),
	tarjetas_con_emoji: z.number().min(0).max(1).optional(),
	fuente: Decision,
});
/** Una decisión fechada del estilo (cita y contexto): solo documenta, el motor no la lee. */
export const DecisionFechadaEsquema = z.looseObject({fecha: z.string(), tema: z.string(), cita: z.string().optional(), nota: z.string().optional()});

export const PerfilMotorEsquema = z.looseObject({
	version: z.literal(1),
	/** Velocidad fija de la base (null: estilo/velocidad.json → calibración → ×1). */
	velocidad: VelocidadMotorEsquema.nullable(),
	/** Aires de cortes.ts (null: estilo/aires.json → calibración → valores por defecto). */
	aires: AiresMotorEsquema.nullable(),
	/** Zona de subtítulos y capas encima de lo medido (src/estilo/zona-segura.ts → aplicarDecisionTarjetas). */
	zona: ZonaMotorEsquema,
	/** Ritmo objetivo del director (null: el medido en estilo/estilo.json → ritmo). */
	ritmo: RitmoMotorEsquema.nullable(),
	decisiones: z.array(DecisionFechadaEsquema),
});

export type PerfilMotor = z.infer<typeof PerfilMotorEsquema> & {
	/** De dónde salió (no viene del archivo). */
	origen: {estilo: string | null; archivo: string | null; claves: string[]};
};

/** Parcial: lo que puede traer `perfil.json → motor` (todo opcional; `zona` campo por campo). */
export const PerfilMotorParcialEsquema = PerfilMotorEsquema.extend({
	version: z.literal(1).optional(),
	velocidad: VelocidadMotorEsquema.nullable().optional(),
	aires: AiresMotorEsquema.nullable().optional(),
	zona: ZonaMotorEsquema.partial().optional(),
	ritmo: RitmoMotorEsquema.nullable().optional(),
	decisiones: z.array(DecisionFechadaEsquema).optional(),
});

/** La zona neutra: lo medido tal cual (sin bajar nada ni achicar), dentro de la zona segura y con la boca protegida. */
export const ZONA_NEUTRA: DecisionZona = {
	subtitulos_y: null,
	bajada_capas_px: 0,
	tarjeta_letra: 1,
	tarjeta_relleno: 1,
	prompt_letra: 1,
	ancho_max: GUIA_REELS.cian.x1 - GUIA_REELS.cian.x0,
	nota: 'motor neutro: lo medido del estilo, dentro de la zona segura de Reels',
	puede_tapar_cara: false,
	margen_boca_px: null,
	nota_cara: 'motor neutro: las capas no tapan la boca',
};

/**
 * El motor sin estilo: sin acelerar (×1), aires y cortes con los valores por defecto de cortes.ts sin calibración
 * (pausas de más de 0.3 s, voz a 12 dB sobre el piso, sin quitar tramos sueltos), zona neutra y el ritmo medido.
 * `velocidad` y `aires` van como referencia: cortes.ts solo los usa del perfil si el perfil los trae.
 */
export const MOTOR_NEUTRO: PerfilMotor = Object.freeze({
	version: 1 as const,
	velocidad: {factor: 1, decision: 'motor neutro: sin acelerar'},
	aires: {hueco_minimo_s: 0.3, umbral_sobre_piso_db: 12, quitar_sueltos_s: 0, decision: 'motor neutro: valores por defecto de cortes.ts sin calibración'},
	zona: ZONA_NEUTRA,
	ritmo: null,
	decisiones: [],
	origen: {estilo: null, archivo: null, claves: []},
}) as PerfilMotor;

const rel = (raiz: string, ruta: string): string => relative(raiz, ruta) || ruta;

/** Ruta del perfil de un estilo. */
export const rutaPerfil = (id: string, raiz: string = RAIZ_CREADOR): string => join(raiz, 'estilo', 'estilos', id, 'perfil.json');

/**
 * El motor del estilo activo (o de `opciones.estilo`) mezclado sobre MOTOR_NEUTRO. Sin creador.json ni estilo: el
 * neutro. Un estilo que no existe, un perfil que no es JSON o un `motor` con forma mala: código 2.
 */
export function leerPerfilMotor(opciones: {raiz?: string; estilo?: string} = {}): PerfilMotor {
	const raiz = opciones.raiz ?? RAIZ_CREADOR;
	const id = opciones.estilo ?? leerCreador({raiz}).estilo_activo;
	if (!id) return structuredClone(MOTOR_NEUTRO);
	if (!PATRON_ID_ESTILO.test(id)) throw fallo('leer el perfil del estilo', `"${id}" no es un id de estilo válido`, 'usa minúsculas, números y guiones (la carpeta de estilo/estilos/)', 2);
	const ruta = rutaPerfil(id, raiz);
	if (!existsSync(ruta)) {
		throw fallo('leer el perfil del estilo', `no existe ${rel(raiz, ruta)} (estilo "${id}")`, 'revisa estilo_activo en creador.json o crea el estilo', 2);
	}
	let perfil: unknown;
	try {
		perfil = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer el perfil del estilo', `${rel(raiz, ruta)} no es JSON válido`, 'corrígelo', 2);
	}
	const crudo = typeof perfil === 'object' && perfil !== null ? (perfil as {motor?: unknown}).motor : undefined;
	const base = structuredClone(MOTOR_NEUTRO);
	base.origen = {estilo: id, archivo: rel(raiz, ruta), claves: []};
	if (crudo === undefined || crudo === null) return base;
	const r = PerfilMotorParcialEsquema.safeParse(crudo);
	if (!r.success) {
		const detalle = r.error.issues.map((i) => `motor.${i.path.join('.')}: ${i.message}`).join('; ');
		throw fallo('leer el perfil del estilo', `${rel(raiz, ruta)} trae un "motor" con forma mala (${detalle})`, 'corrígelo (forma en herramientas/lib/perfil-estilo.ts)', 2, r.error.issues);
	}
	const p = r.data;
	const claves = (['velocidad', 'aires', 'zona', 'ritmo', 'decisiones'] as const).filter((k) => p[k] !== undefined);
	return {
		...base,
		...(p.velocidad !== undefined ? {velocidad: p.velocidad} : {}),
		...(p.aires !== undefined ? {aires: p.aires} : {}),
		...(p.ritmo !== undefined ? {ritmo: p.ritmo} : {}),
		...(p.decisiones !== undefined ? {decisiones: p.decisiones} : {}),
		zona: {...base.zona, ...(p.zona ?? {})} as DecisionZona,
		origen: {...base.origen, claves},
	};
}
