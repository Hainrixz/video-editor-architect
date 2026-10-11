/**
 * agregar.ts: junta lo medido en tus reels (referencias/reels/<sc>/) en estilo/estilo.json, estilo/momentos.jsonl y
 * estilo/informe.md. Corre dentro del sandbox: solo lee JSON y escribe texto (las hojas y la tipografía las arma
 * aprender.ts, que sí lee los videos).
 *
 *   npx tsx herramientas/estilo/agregar.ts [--sin-informe]
 *
 * Reglas (regla 4 de la casa):
 *   - Cada número es {valor | "N/A", n, fuente, falta}. Los N/A no cuentan en ningún total.
 *   - Primero una cifra por reel (su mediana, su p10, su tasa por minuto) y después entre reels: así un reel con muchos
 *     eventos no pesa más que otro.
 *   - Apariencia y layout (posiciones, tamaños, colores, tipografía, pop, franja de subtítulos, zona UI): SOLO reels
 *     recientes (publicados desde el 1-jun-2026 en 1440×2560) y cada reel pesa igual.
 *   - Densidades, frecuencias y tiempos (por minuto, duraciones, SFX, ritmo, tapa la cabeza): todos los reels medidos,
 *     ponderados con su puntaje del corpus (los que no tienen puntaje pesan la mediana del ranking).
 *   - Top / recientes / resto: medianas simples por grupo; es una HIPÓTESIS (n chico).
 *   - Nada externo se presenta como medido: BRAG, el zoom de las demos y la guía de Meta van como fuente "supuesto".
 * Lo que se lee y no se modifica: estilo/corpus.json, estilo/muestra.json, estilo/encuadre.json y
 * estilo/calibracion-cortes.json (si existen; los escriben otras piezas).
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo (corpus, muestra o mediciones).
 */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {CANDIDATAS, esIdFuente, type IdFuente} from '../../src/estilo/fuentes.ts';
import {MEDICIONES_CAPAS} from '../../src/estilo/capas.ts';
import {barbillaMax, bocaMax, bocaMedida, cajaCabeza, type CaraConsultable} from '../lib/cara.ts';
import {medianaHex} from '../lib/capas.ts';
import {rgbALab} from '../lib/color.ts';
import {medida, NA, revisarMetricas, sinDato, supuesto, type Metrica} from '../lib/estilo.ts';
import {leerCreador} from '../lib/creador.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {ESTILO_SFX_SUPUESTO} from '../lib/sfx.ts';
import {DIR_TRABAJO, dirReel, leerConjunto, type ManifestReel, type NivelEvento, type ReelConjunto} from './aprender.ts';
import type {MedicionCapas, TarjetaMedida} from './medir-capas.ts';
import type {EventoSubtitulo, MedicionSubtitulos} from './medir.ts';
import {coberturaAlAzar, sfxDeAparicion, type EventoCapa, type ReporteOverlays} from './overlays.ts';
import type {ReporteOnsets} from './onsets.ts';

export const RUTA_ESTILO_JSON = join(RAIZ, 'estilo', 'estilo.json');
export const RUTA_MOMENTOS_JSONL = join(RAIZ, 'estilo', 'momentos.jsonl');
export const RUTA_INFORME = join(RAIZ, 'estilo', 'informe.md');
export const DIR_INFORME = join(RAIZ, 'estilo', 'informe');
export const RUTA_TIPOGRAFIA = join(RAIZ, 'referencias', 'tipografia.json');
export const RUTA_REVISION = join(DIR_INFORME, 'revision-virales.json');
export const RUTA_ENCUADRE = join(RAIZ, 'estilo', 'encuadre.json');
export const RUTA_CAL_CORTES = join(RAIZ, 'estilo', 'calibracion-cortes.json');
export const VERSION_ESTILO = '1.0.0';

/** Ventanas del ritmo (plan: cuantiles por gancho, cuerpo y cierre). */
export const GANCHO_S = 3;
export const CIERRE_S = 5;
/** Mínimo de subtítulos medidos para que un reel aporte al estilo de subtítulos. */
export const MIN_SUBTITULOS = 10;
/** Corrección del contorno del titular en el Chrome de Remotion (src/estilo/capas.ts, MEDICIONES_CAPAS.titular_borde). */
export const CORRECCION_BORDE_TITULAR = 0.4;
/** Sangría de las letras a los lados de una tarjeta (24 px de tinta a la orilla = 22 de relleno CSS, src/estilo/capas.ts). */
export const SANGRIA_TARJETA = 2;
/** Regla del plan (Fase 3): cada SFX arranca entre −2 y 0 cuadros de su primer cuadro visible. */
export const REGLA_OFFSET: [number, number] = [-2, 0];
/** Límite conocido del detector de onsets (out/f2-onsets/resultado.json): los "pop" suaves se le escapan. */
export const AVISO_POPS =
	'cota: el detector de onsets encuentra pocos "pop" suaves (f2-onsets: pop 0 de 4 en mezcla mono a −6…−16 LU, 4 de 4 en estéreo), así que las capas con SFX pueden ser más (y el silencio menos) de lo que dice aquí';

// ───────────────────────────── Utilidades puras ─────────────────────────────

/** Cuantil tipo 7 (el de R y numpy). null si no hay datos. */
export function cuantil(valores: readonly number[], p: number): number | null {
	const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const h = (v.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

/**
 * Cuantil ponderado (función de distribución acumulada invertida, como la mediana de siempre): el primer valor cuya
 * suma de pesos pasa p · total; si cae justo en el borde, el promedio de los dos vecinos. Con pesos iguales da la
 * mediana de siempre; si un reel tiene más de la mitad del peso, la mediana es la suya. null si no hay datos con peso.
 */
export function cuantilPonderado(pares: ReadonlyArray<{v: number; w: number}>, p: number): number | null {
	const s = pares.filter((x) => Number.isFinite(x.v) && Number.isFinite(x.w) && x.w > 0).sort((a, b) => a.v - b.v);
	if (s.length === 0) return null;
	const total = s.reduce((t, x) => t + x.w, 0);
	const meta = Math.min(1, Math.max(0, p)) * total;
	const eps = 1e-9 * total;
	let acum = 0;
	for (let i = 0; i < s.length; i++) {
		acum += s[i].w;
		if (acum > meta + eps) return s[i].v;
		if (Math.abs(acum - meta) <= eps) return i + 1 < s.length ? (s[i].v + s[i + 1].v) / 2 : s[i].v;
	}
	return s[s.length - 1].v;
}

export const red = (v: number | null | undefined, d = 1): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const pct = (k: number, total: number): number | null => (total > 0 ? red((100 * k) / total, 1) : null);
const mediana = (v: readonly number[]) => cuantil(v, 0.5);
const finitos = (v: ReadonlyArray<number | null | undefined>): number[] => v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** Texto sin acentos, en minúsculas y sin signos (para comparar palabras). */
export function normalizar(t: string): string {
	return t
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

const luz = (hex: string | null | undefined): number | null => {
	if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
	const n = Number.parseInt(hex.slice(1), 16);
	return rgbALab([(n >> 16) & 255, (n >> 8) & 255, n & 255])[0];
};

// ───────────────────────────── Datos de un reel ─────────────────────────────

export type ZoomsReel = {candidatos: number; confirmados: number; descartados: number; por_veredicto: Record<string, number>; duracion_s: number; cobertura: number; zooms: Array<{t: number; razon: number; tipo: string; fondo: {veredicto: string}}>};
export type NivelSfxReel = {voz: {lufs_integrado: number | null; rms_mediana_dbfs: number | null}; lateral: {usado: boolean; nota: string} | null; eventos: NivelEvento[]};
export type Transcripcion = {palabras: Array<{t: string; d: number; h: number}>};

export type DatosReel = {
	reel: ReelConjunto;
	/** Peso para las densidades: el puntaje del corpus o, sin puntaje, la mediana del ranking. */
	peso: number;
	subtitulos: MedicionSubtitulos | null;
	capas: MedicionCapas | null;
	overlays: ReporteOverlays | null;
	onsets: ReporteOnsets | null;
	zooms: ZoomsReel | null;
	nivel: NivelSfxReel | null;
	transcripcion: Transcripcion | null;
	cara: CaraConsultable | null;
	registro: ManifestReel | null;
};

function leerOpcional<T>(ruta: string): T | null {
	if (!existsSync(ruta)) return null;
	try {
		return JSON.parse(readFileSync(ruta, 'utf8')) as T;
	} catch {
		return null;
	}
}

/** Lee lo medido de cada reel (lo que falte queda null y sale N/A con su motivo). */
export function cargarDatos(reels: readonly ReelConjunto[], medianaPuntaje: number, op: {cara?: boolean} = {}): DatosReel[] {
	return reels.map((r) => {
		const d = dirReel(r.shortCode);
		const cara = op.cara === false ? null : leerOpcional<CaraConsultable>(join(d, 'cara.json'));
		return {
			reel: r,
			peso: r.puntaje ?? medianaPuntaje,
			subtitulos: leerOpcional<MedicionSubtitulos>(join(d, 'subtitulos.json')),
			capas: leerOpcional<MedicionCapas>(join(d, 'capas.json')),
			overlays: leerOpcional<ReporteOverlays>(join(d, 'overlays.json')),
			onsets: leerOpcional<ReporteOnsets>(join(d, 'onsets.json')),
			zooms: leerOpcional<ZoomsReel>(join(d, 'zooms.json')),
			nivel: leerOpcional<NivelSfxReel>(join(d, 'nivel-sfx.json')),
			transcripcion: leerOpcional<Transcripcion>(join(d, 'transcripcion.json')),
			cara: cara && Array.isArray(cara.cuadros) ? {fps: cara.fps ?? 30, cuadros: cara.cuadros} : null,
			registro: leerOpcional<ManifestReel>(join(d, 'aprender.json')),
		};
	});
}

// ───────────────────────────── Capas de un reel (tarjetas + stickers + inserts) ─────────────────────────────

export type Caja = {x0: number; y0: number; x1: number; y1: number};

export type CapaReel = {
	id: string;
	clase: 'tarjeta' | 'sticker' | 'insert';
	subtipo: 'capa' | 'pantalla-completa';
	desde: number;
	hasta: number;
	caja: Caja;
	texto: string | null;
	tipo_palabra: string | null;
	palabras: number | null;
	desfase_cuadros: number | null;
	lista: string | null;
	sfx: {con_sfx: boolean; onset_s: number | null; confiable: boolean; desfase_30: number | null} | null;
	tapa_cabeza: boolean | null;
	/** Borde de arriba − barbilla más baja de su ventana (px base); negativo = sube más que tu barbilla. */
	sobre_barbilla: number | null;
	/** Borde de arriba − boca más baja de su ventana (px base); negativo = tapa la boca (zona protegida del director). */
	sobre_boca: number | null;
};

const cajaDe = (c: {x: number; y: number; w: number; h: number}): Caja => ({x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h});

/**
 * Las tarjetas de capas.json que de verdad son tarjetas: fuera la que repite el texto del titular (un titular en caja
 * blanca, como en algunos reels de abril) y la que dura más del 60 % del video (es el titular, no un resaltado).
 */
export function tarjetasDeReel(d: Pick<DatosReel, 'capas'>): TarjetaMedida[] {
	const c = d.capas;
	if (!c) return [];
	const tit = c.titular.presente ? normalizar(c.titular.texto) : null;
	const quedan = c.tarjetas.filter((t) => !(tit && normalizar(t.texto) === tit) && !(c.duracion_s > 0 && t.duracion > 0.6 * c.duracion_s));
	if (quedan.length === c.tarjetas.length) return quedan;
	// Una "lista" que solo existía por el titular en caja deja de serlo (necesita ≥ 2 tarjetas de verdad).
	const porLista = new Map<string, number>();
	for (const t of quedan) if (t.lista) porLista.set(t.lista, (porLista.get(t.lista) ?? 0) + 1);
	return quedan.map((t) => (t.lista && (porLista.get(t.lista) ?? 0) < 2 ? {...t, lista: null} : t));
}

/** Las listas de capas.json que siguen siendo listas con las tarjetas de verdad (ver tarjetasDeReel). */
export function listasDeReel(d: Pick<DatosReel, 'capas'>): MedicionCapas['listas'] {
	const c = d.capas;
	if (!c) return [];
	const ids = new Set(tarjetasDeReel(d).filter((t) => t.lista).map((t) => t.id));
	return c.listas.filter((l) => l.tarjetas.filter((id) => ids.has(id)).length >= 2);
}

/** ¿El titular de este reel va en caja blanca (estilo tarjeta) en vez de blanco con contorno? */
export function titularEnCaja(d: Pick<DatosReel, 'capas'>): boolean {
	const c = d.capas;
	if (!c || !c.titular.presente) return false;
	const tit = normalizar(c.titular.texto);
	return c.tarjetas.some((t) => normalizar(t.texto) === tit || t.duracion > 0.6 * c.duracion_s);
}

/** Las capas de un reel: tarjetas de capas.json (el detector fino) y stickers e inserts de overlays.json. Pura. */
export function capasDeReel(d: DatosReel): CapaReel[] {
	const fps = d.overlays?.fps ?? d.capas?.fps ?? 30;
	const onsets = d.onsets?.onsets ?? null;
	const sfx = (desde: number): CapaReel['sfx'] => {
		if (!onsets) return null;
		const s = sfxDeAparicion(desde, onsets, fps);
		return {con_sfx: s.con_sfx, onset_s: s.onset_s, confiable: s.confiable, desfase_30: s.onset_s === null ? null : red((s.onset_s - desde) * 30, 2)};
	};
	const salida: CapaReel[] = [];
	for (const t of tarjetasDeReel(d)) {
		salida.push({
			id: t.id,
			clase: 'tarjeta',
			subtipo: 'capa',
			desde: t.desde,
			hasta: t.hasta,
			caja: {...t.orillas},
			texto: t.texto,
			tipo_palabra: t.tipo_palabra,
			palabras: t.palabras,
			desfase_cuadros: t.habla?.desfase_cuadros ?? null,
			lista: t.lista,
			sfx: sfx(t.desde),
			tapa_cabeza: null,
			sobre_barbilla: null,
			sobre_boca: null,
		});
	}
	for (const e of d.overlays?.eventos ?? []) {
		if (e.subtipo === 'desenfoque' || (e.clase !== 'sticker' && e.clase !== 'insert')) continue;
		salida.push({
			id: e.id,
			clase: e.clase,
			subtipo: e.subtipo === 'pantalla-completa' ? 'pantalla-completa' : 'capa',
			desde: e.desde,
			hasta: e.hasta,
			caja: cajaDe(e.caja),
			texto: null,
			tipo_palabra: null,
			palabras: null,
			desfase_cuadros: null,
			lista: null,
			sfx: e.sfx ? {con_sfx: e.sfx.con_sfx, onset_s: e.sfx.onset_s, confiable: e.sfx.confiable, desfase_30: e.sfx.onset_s === null ? null : red((e.sfx.onset_s - e.desde) * 30, 2)} : sfx(e.desde),
			tapa_cabeza: null,
			sobre_barbilla: null,
			sobre_boca: null,
		});
	}
	// Con la cara del reel: ¿la capa tapa la cabeza? (se encima con la caja de la cabeza de su ventana).
	if (d.cara) {
		for (const c of salida) {
			if (c.subtipo === 'pantalla-completa') continue;
			const cab = cajaCabeza(d.cara, c.desde, c.hasta);
			const bar = barbillaMax(d.cara, c.desde, c.hasta);
			if (!cab || bar === null) continue;
			const traslapeX = Math.min(c.caja.x1, cab.x + cab.w) - Math.max(c.caja.x0, cab.x);
			c.tapa_cabeza = c.caja.y0 < bar - 10 && traslapeX >= 0.2 * cab.w;
			c.sobre_barbilla = red(c.caja.y0 - bar, 1);
			const boca = bocaMax(d.cara, c.desde, c.hasta);
			c.sobre_boca = boca === null || traslapeX < 0.2 * cab.w ? null : red(c.caja.y0 - boca, 1);
		}
	}
	return salida.sort((a, b) => a.desde - b.desde || a.caja.y0 - b.caja.y0);
}

// ───────────────────────────── Estadísticas por reel ─────────────────────────────

export type EstadisticasReel = {
	sc: string;
	grupo: ReelConjunto['grupo'];
	en_muestra: boolean;
	reciente: boolean;
	peso: number;
	puntaje: number | null;
	duracion_s: number | null;
	fps: number | null;
	capas: CapaReel[];
	subs: {
		medido: boolean;
		aporta: boolean;
		motivo: string | null;
		n: number;
		y_p10: number | null;
		y_p50: number | null;
		y_p90: number | null;
		ancho_p90: number | null;
		alto_mayuscula_p50: number | null;
		grosor_borde_p50: number | null;
		color_texto: string | null;
		color_borde: string | null;
		palabras: {p10: number | null; p50: number | null; p90: number | null};
		duracion: {p10: number | null; p50: number | null; p90: number | null};
		mayusculas_pct: number | null;
		una_linea_pct: number | null;
		resaltado_pct: number | null;
		resaltado_modos: Record<string, number>;
		puntuacion_pct: number | null;
		adelanto_cuadros: number | null;
		n_adelanto: number;
		caja: Caja | null;
	};
	titular: {
		medido: boolean;
		presente: boolean;
		/** Titular en caja blanca con texto negro (no blanco con contorno). */
		en_caja: boolean;
		texto: string | null;
		n_lineas: number | null;
		y_mayusculas: number | null;
		y_caja: number | null;
		y_abajo: number | null;
		interlineado: number | null;
		alto_mayuscula: number | null;
		ancho_max: number | null;
		color: string | null;
		contorno_color: string | null;
		contorno_grosor: number | null;
		peso: number | null;
		sombra: boolean | null;
		caja: Caja | null;
	};
	tarjetas: {
		medido: boolean;
		n: number;
		por_min: number | null;
		duracion: {p10: number | null; p50: number | null; p90: number | null};
		centro_y: {p10: number | null; p50: number | null; p90: number | null};
		alto_mayuscula: number | null;
		alto_caja_1: number | null;
		ancho_p50: number | null;
		ancho_max: number | null;
		pad_arriba: number | null;
		pad_abajo: number | null;
		pad_lados: number | null;
		radio: number | null;
		peso_trazo: number | null;
		color_caja: string | null;
		color_texto: string | null;
		interlineado: number | null;
		escala_grande: number | null;
		escala_lista: number | null;
		separacion: number | null;
		n_listas: number;
		disposiciones: Record<string, number>;
		pct_en_listas: number | null;
		pct_grande: number | null;
		pct_escritura: number | null;
		pct_emoji: number | null;
		palabras_p50: number | null;
		pct_literal: number | null;
		pct_parafraseo: number | null;
		pct_sin_coincidencia: number | null;
		desfase: {p10: number | null; p50: number | null; p90: number | null};
		n_desfase: number;
		pct_con_digitos: number | null;
		pct_numeros_en_digitos: number | null;
		pct_mayuscula_inicial: number | null;
		pct_entrada_corte: number | null;
		pct_salida_corte: number | null;
		tipos: Record<string, number>;
		min_por_palabra_p10: number | null;
	};
	stickers: {
		medido: boolean;
		n: number;
		por_min: number | null;
		duracion: {p10: number | null; p50: number | null; p90: number | null};
		ancho: {p10: number | null; p50: number | null; p90: number | null};
		centro_y: number | null;
		centro_x: number | null;
		pop_cuadros_30: number | null;
		pop_escala_inicial: number | null;
		pop_sobrepaso: number | null;
		n_pop: number;
	};
	inserts: {
		medido: boolean;
		n: number;
		por_min: number | null;
		n_pantalla_completa: number;
		n_tarjeta: number;
		secuencias_por_min: number | null;
		duracion: {p10: number | null; p50: number | null; p90: number | null};
		duracion_p50: number | null;
		tarjeta_centro_y: number | null;
		tarjeta_ancho: number | null;
	};
	zooms: {medido: boolean; candidatos: number; confirmados: number; por_min: number | null; escalas: number[]};
	desenfoque: {medido: boolean; n: number; por_min: number | null; duracion_p50: number | null};
	sfx: {
		medido: boolean;
		/** ¿El canal lateral (L−R) venía limpio? Ahí el detector de onsets encuentra más SFX. */
		lateral_limpio: boolean;
		capas: number;
		con_sfx: number;
		pct_con_sfx: number | null;
		pct_azar: number | null;
		pct_corregido: number | null;
		prob_silencio: number | null;
		offsets_30: number[];
		offsets_30_confiables: number[];
		eventos_por_video: number | null;
		huecos_p50: number | null;
		fuentes_por_clase: Record<string, Record<string, number>>;
	};
	nivel: {medido: boolean; n: number; lu: {p10: number | null; p50: number | null; p90: number | null}; db_rms_p50: number | null; voz_lufs: number | null; lus: number[]; dbs: number[]};
	ritmo: {gancho: number | null; cuerpo: number | null; cierre: number | null; primera_capa_s: number | null};
	cabeza: {medido: boolean; tapan: Record<string, number>; inserts_tapan: number | null; sobre_barbilla: number[]; sobre_boca: number[]; boca_medida: boolean};
	zona: Caja | null;
};

const cuantiles3 = (v: readonly number[], d = 2) => ({p10: red(cuantil(v, 0.1), d), p50: red(cuantil(v, 0.5), d), p90: red(cuantil(v, 0.9), d)});

/** Adelanto de los subtítulos sobre tu voz (s): inicio de la palabra − inicio del subtítulo, emparejando la 1.ª palabra. */
export function adelantosSubtitulos(eventos: ReadonlyArray<Pick<EventoSubtitulo, 'texto' | 'desde'>>, palabras: ReadonlyArray<{t: string; d: number}>, ventana = 1): number[] {
	const salida: number[] = [];
	const norm = palabras.map((p) => ({k: normalizar(p.t), d: p.d}));
	for (const e of eventos) {
		const primera = normalizar(e.texto.trim().split(/\s+/)[0] ?? '');
		if (!primera) continue;
		let mejor: number | null = null;
		for (const p of norm) {
			if (p.k !== primera || Math.abs(p.d - e.desde) > ventana) continue;
			if (mejor === null || Math.abs(p.d - e.desde) < Math.abs(mejor - e.desde)) mejor = p.d;
		}
		if (mejor !== null) salida.push(mejor - e.desde);
	}
	return salida;
}

/** Todo lo que se necesita de un reel, ya resumido (pura). */
export function estadisticasDeReel(d: DatosReel): EstadisticasReel {
	const r = d.reel;
	const capas = capasDeReel(d);
	const dur = d.overlays?.duracion_s ?? d.capas?.duracion_s ?? d.subtitulos?.duracion_s ?? r.duracion_s ?? null;
	const minutos = dur && dur > 0 ? dur / 60 : null;
	const porMin = (n: number) => (minutos ? red(n / minutos, 2) : null);

	// Subtítulos.
	const s = d.subtitulos;
	const rs = s?.resumen;
	const lt = luz(rs?.color_texto);
	const lb = luz(rs?.color_borde);
	let motivoSubs: string | null = null;
	if (!s) motivoSubs = 'sin medir';
	else if (s.n < MIN_SUBTITULOS && s.franja && Math.abs(s.franja.base1920.centro - 1500) > 150)
		motivoSubs = `medir.ts ubicó la franja en y ≈ ${Math.round(s.franja.base1920.centro)} (otro texto fijo del cuadro, p. ej. un estampado), no en tus subtítulos: midió ${s.n}`;
	else if (s.n < MIN_SUBTITULOS) motivoSubs = `solo ${s.n} subtítulos medidos (mínimo ${MIN_SUBTITULOS})`;
	else if (lt === null || lb === null || lt < 80 || lb > 30) motivoSubs = `no son blancos con borde negro (texto ${rs?.color_texto ?? '—'}, borde ${rs?.color_borde ?? '—'})`;
	const eventosSubs = s?.eventos ?? [];
	const adel = d.transcripcion ? adelantosSubtitulos(eventosSubs, d.transcripcion.palabras) : [];
	const cajasSubs = eventosSubs.map((e) => ({x0: e.x - e.ancho / 2, x1: e.x + e.ancho / 2, y0: e.y - e.alto_caja / 2, y1: e.y + e.alto_caja / 2}));
	const subs: EstadisticasReel['subs'] = {
		medido: !!s,
		aporta: !!s && motivoSubs === null,
		motivo: motivoSubs,
		n: s?.n ?? 0,
		y_p10: rs?.y_p10 ?? null,
		y_p50: rs?.y_p50 ?? null,
		y_p90: rs?.y_p90 ?? null,
		ancho_p90: rs?.ancho_p90 ?? null,
		alto_mayuscula_p50: rs?.alto_mayuscula_p50 ?? null,
		grosor_borde_p50: rs?.grosor_borde_p50 ?? null,
		color_texto: rs?.color_texto ?? null,
		color_borde: rs?.color_borde ?? null,
		palabras: {p10: rs?.palabras_por_evento.p10 ?? null, p50: rs?.palabras_por_evento.p50 ?? null, p90: rs?.palabras_por_evento.p90 ?? null},
		duracion: {p10: rs?.duracion.p10 ?? null, p50: rs?.duracion.p50 ?? null, p90: rs?.duracion.p90 ?? null},
		mayusculas_pct: rs?.mayusculas_pct ?? null,
		una_linea_pct: rs?.una_linea_pct ?? null,
		resaltado_pct: rs?.resaltado_pct ?? null,
		resaltado_modos: rs?.resaltado_modos ?? {color: 0, peso: 0, escala: 0},
		puntuacion_pct: eventosSubs.length ? pct(eventosSubs.filter((e) => /[.,;:!?¡¿…]/.test(e.texto)).length, eventosSubs.length) : null,
		adelanto_cuadros: adel.length >= 5 ? red((mediana(adel) ?? 0) * 30, 2) : null,
		n_adelanto: adel.length,
		caja: cajasSubs.length ? {x0: cuantil(cajasSubs.map((c) => c.x0), 0.05)!, x1: cuantil(cajasSubs.map((c) => c.x1), 0.95)!, y0: cuantil(cajasSubs.map((c) => c.y0), 0.05)!, y1: cuantil(cajasSubs.map((c) => c.y1), 0.95)!} : null,
	};

	// Titular.
	const T = d.capas?.titular;
	const tp = T && T.presente ? T : null;
	const enCaja = titularEnCaja(d);
	const l0 = tp?.lineas[0];
	const tintas = finitos((tp?.lineas ?? []).map((l) => l.alto_mayuscula_tinta));
	const grosores = finitos((tp?.lineas ?? []).map((l) => l.contorno.grosor));
	const pesos = finitos((tp?.lineas ?? []).map((l) => l.peso));
	const titular: EstadisticasReel['titular'] = {
		medido: !!T,
		presente: !!tp,
		en_caja: enCaja,
		texto: tp?.texto ?? null,
		n_lineas: tp?.n_lineas ?? null,
		y_mayusculas: l0 && l0.linea_base !== null && l0.alto_mayuscula_tinta !== null ? red(l0.linea_base - l0.alto_mayuscula_tinta / 2, 1) : null,
		y_caja: tp?.y_primera_linea ?? null,
		y_abajo: tp?.y_abajo ?? null,
		interlineado: tp?.interlineado ?? null,
		alto_mayuscula: tintas.length ? red(mediana(tintas), 1) : null,
		ancho_max: tp ? red(Math.max(...tp.lineas.map((l) => l.ancho)), 1) : null,
		color: l0?.color_texto ?? null,
		contorno_color: l0?.contorno.color ?? null,
		contorno_grosor: grosores.length ? red(mediana(grosores), 2) : null,
		peso: pesos.length ? red(mediana(pesos), 3) : null,
		sombra: tp ? tp.sombra_suave : null,
		caja: tp ? {x0: Math.min(...tp.lineas.map((l) => l.x_centro - l.ancho / 2)), x1: Math.max(...tp.lineas.map((l) => l.x_centro + l.ancho / 2)), y0: Math.min(...tp.lineas.map((l) => l.y_centro - l.alto_caja / 2)), y1: tp.y_abajo} : null,
	};

	// Tarjetas.
	const ts: TarjetaMedida[] = tarjetasDeReel(d);
	const normales = ts.filter((t) => !t.grande && t.lista === null);
	const capNormal = mediana(finitos(normales.map((t) => t.alto_mayuscula)));
	const unRenglon = ts.filter((t) => t.lineas === 1 && !t.grande);
	const dosRenglones = ts.filter((t) => t.lineas === 2 && !t.grande);
	const h1 = mediana(unRenglon.map((t) => t.caja.h));
	const h2 = mediana(dosRenglones.map((t) => t.caja.h));
	const listas = listasDeReel(d);
	const disp: Record<string, number> = {vertical: 0, horizontal: 0, mixta: 0};
	for (const l of listas) disp[l.disposicion] = (disp[l.disposicion] ?? 0) + 1;
	const conHabla = ts.filter((t) => t.habla !== null);
	const desfases = finitos(conHabla.filter((t) => t.habla!.tipo !== 'sin_coincidencia').map((t) => t.habla!.desfase_cuadros));
	const nums = conHabla.filter((t) => t.habla!.numero_en_digitos !== null);
	const tipos: Record<string, number> = {};
	for (const t of ts) tipos[t.tipo_palabra] = (tipos[t.tipo_palabra] ?? 0) + 1;
	const conMayus = ts.filter((t) => t.mayuscula_inicial !== null);
	const tarjetas: EstadisticasReel['tarjetas'] = {
		medido: !!d.capas,
		n: ts.length,
		por_min: d.capas ? porMin(ts.length) : null,
		duracion: cuantiles3(ts.map((t) => t.duracion), 3),
		centro_y: cuantiles3(ts.map((t) => t.caja.y), 1),
		alto_mayuscula: red(capNormal, 1),
		alto_caja_1: red(h1, 1),
		ancho_p50: red(mediana(ts.map((t) => t.caja.w)), 1),
		ancho_max: ts.length ? red(Math.max(...ts.map((t) => t.caja.w)), 1) : null,
		pad_arriba: red(mediana(finitos(unRenglon.map((t) => t.padding_mayuscula.arriba))), 1),
		pad_abajo: red(mediana(finitos(unRenglon.map((t) => t.padding_mayuscula.abajo))), 1),
		pad_lados: red(mediana(finitos(ts.map((t) => t.padding.h))), 1),
		radio: red(mediana(finitos(ts.map((t) => t.radio))), 1),
		peso_trazo: red(mediana(finitos(ts.map((t) => t.peso))), 3),
		color_caja: medianaHex(ts.map((t) => t.color_caja).filter((x): x is string => !!x)),
		color_texto: medianaHex(ts.map((t) => t.color_texto).filter((x): x is string => !!x)),
		interlineado: h1 !== null && h2 !== null ? red(h2 - h1, 1) : null,
		escala_grande: capNormal ? red(mediana(finitos(ts.filter((t) => t.grande).map((t) => (t.alto_mayuscula ?? NaN) / capNormal))), 3) : null,
		escala_lista: capNormal ? red(mediana(finitos(ts.filter((t) => t.lista !== null && !t.grande).map((t) => (t.alto_mayuscula ?? NaN) / capNormal))), 3) : null,
		separacion: red(mediana(listas.flatMap((l) => l.separacion_v)), 1),
		n_listas: listas.length,
		disposiciones: disp,
		pct_en_listas: d.capas ? pct(ts.filter((t) => t.lista !== null).length, ts.length) : null,
		pct_grande: d.capas ? pct(ts.filter((t) => t.grande).length, ts.length) : null,
		pct_escritura: d.capas ? pct(ts.filter((t) => t.escritura).length, ts.length) : null,
		pct_emoji: d.capas ? pct(ts.filter((t) => t.emoji).length, ts.length) : null,
		palabras_p50: red(mediana(ts.map((t) => t.palabras)), 1),
		pct_literal: pct(conHabla.filter((t) => t.habla!.tipo === 'literal').length, conHabla.length),
		pct_parafraseo: pct(conHabla.filter((t) => t.habla!.tipo === 'parafraseo').length, conHabla.length),
		pct_sin_coincidencia: pct(conHabla.filter((t) => t.habla!.tipo === 'sin_coincidencia').length, conHabla.length),
		desfase: cuantiles3(desfases, 1),
		n_desfase: desfases.length,
		pct_con_digitos: d.capas ? pct(ts.filter((t) => t.digitos).length, ts.length) : null,
		pct_numeros_en_digitos: pct(nums.filter((t) => t.habla!.numero_en_digitos).length, nums.length),
		pct_mayuscula_inicial: pct(conMayus.filter((t) => t.mayuscula_inicial).length, conMayus.length),
		pct_entrada_corte: d.capas ? pct(ts.filter((t) => t.entrada === 'corte').length, ts.length) : null,
		pct_salida_corte: d.capas ? pct(ts.filter((t) => t.salida === 'corte').length, ts.length) : null,
		tipos,
		min_por_palabra_p10: red(cuantil(ts.filter((t) => t.palabras > 0).map((t) => t.duracion / t.palabras), 0.1), 3),
	};

	// Stickers e inserts (overlays).
	const ev: EventoCapa[] = d.overlays?.eventos ?? [];
	const fpsOv = d.overlays?.fps ?? 30;
	const sts = ev.filter((e) => e.clase === 'sticker' && e.subtipo === 'capa');
	const conPop = sts.filter((e) => e.entrada !== null);
	const stickers: EstadisticasReel['stickers'] = {
		medido: !!d.overlays,
		n: sts.length,
		por_min: d.overlays ? porMin(sts.length) : null,
		duracion: cuantiles3(sts.map((e) => e.duracion_s), 3),
		ancho: cuantiles3(sts.map((e) => e.caja.w), 0),
		centro_y: red(mediana(sts.map((e) => e.centro.y)), 0),
		centro_x: red(mediana(sts.map((e) => e.centro.x)), 0),
		pop_cuadros_30: red(mediana(conPop.map((e) => (e.entrada!.cuadros * 30) / fpsOv)), 2),
		pop_escala_inicial: red(mediana(conPop.map((e) => e.entrada!.escala_inicial)), 3),
		pop_sobrepaso: red(mediana(conPop.map((e) => e.entrada!.sobrepaso)), 3),
		n_pop: conPop.length,
	};
	const ins = ev.filter((e) => e.clase === 'insert');
	const insTarjeta = ins.filter((e) => e.subtipo === 'capa');
	const secuencias = d.overlays?.resumen.secuencias_de_insert_por_min.valor ?? null;
	const inserts: EstadisticasReel['inserts'] = {
		medido: !!d.overlays,
		n: ins.length,
		por_min: d.overlays ? porMin(ins.length) : null,
		n_pantalla_completa: ins.length - insTarjeta.length,
		n_tarjeta: insTarjeta.length,
		secuencias_por_min: secuencias,
		duracion: cuantiles3(ins.map((e) => e.duracion_s), 3),
		duracion_p50: red(mediana(ins.map((e) => e.duracion_s)), 3),
		tarjeta_centro_y: red(mediana(insTarjeta.map((e) => e.centro.y)), 0),
		tarjeta_ancho: red(mediana(insTarjeta.map((e) => e.caja.w)), 0),
	};
	const des = ev.filter((e) => e.subtipo === 'desenfoque');
	const desenfoque: EstadisticasReel['desenfoque'] = {medido: !!d.overlays, n: des.length, por_min: d.overlays ? porMin(des.length) : null, duracion_p50: red(mediana(des.map((e) => e.duracion_s)), 3)};

	// Zooms.
	const z = d.zooms;
	const confirmados = (z?.zooms ?? []).filter((x) => x.fondo?.veredicto === 'zoom');
	const zooms: EstadisticasReel['zooms'] = {medido: !!z, candidatos: z?.candidatos ?? 0, confirmados: confirmados.length, por_min: z && minutos ? red(confirmados.length / minutos, 2) : null, escalas: confirmados.map((x) => x.razon)};

	// SFX (todas las capas: tarjetas de capas.json + stickers e inserts de overlays.json).
	const conSfxMedido = capas.filter((c) => c.sfx !== null);
	const conSfx = conSfxMedido.filter((c) => c.sfx!.con_sfx);
	const azar = d.onsets && dur ? coberturaAlAzar(d.onsets.onsets, dur, fpsOv) : null;
	const pObs = conSfxMedido.length ? conSfx.length / conSfxMedido.length : null;
	const pCorr = pObs !== null && azar !== null && azar < 1 ? Math.min(1, Math.max(0, (pObs - azar) / (1 - azar))) : null;
	const sonados = conSfx.map((c) => c.desde).sort((a, b) => a - b);
	const huecos = sonados.slice(1).map((t, i) => t - sonados[i]);
	const fuentesPorClase: Record<string, Record<string, number>> = {};
	for (const c of conSfx) {
		const onset = d.onsets?.onsets.find((o) => Math.abs(o.t - (c.sfx!.onset_s ?? -1)) < 1e-3);
		for (const f of onset?.fuentes ?? []) {
			fuentesPorClase[c.clase] ??= {};
			fuentesPorClase[c.clase][f] = (fuentesPorClase[c.clase][f] ?? 0) + 1;
		}
	}
	const sfx: EstadisticasReel['sfx'] = {
		medido: !!d.onsets && conSfxMedido.length > 0,
		lateral_limpio: !!d.onsets?.lateral?.usado,
		capas: conSfxMedido.length,
		con_sfx: conSfx.length,
		pct_con_sfx: pObs === null ? null : red(100 * pObs, 1),
		pct_azar: azar === null ? null : red(100 * azar, 1),
		pct_corregido: pCorr === null ? null : red(100 * pCorr, 1),
		prob_silencio: pCorr === null || conSfxMedido.length < 3 ? null : red(1 - pCorr, 3),
		offsets_30: finitos(conSfx.map((c) => c.sfx!.desfase_30)),
		offsets_30_confiables: finitos(conSfx.filter((c) => c.sfx!.confiable).map((c) => c.sfx!.desfase_30)),
		eventos_por_video: d.overlays && d.capas ? capas.length + zooms.confirmados : null,
		huecos_p50: red(mediana(huecos), 2),
		fuentes_por_clase: fuentesPorClase,
	};

	// Nivel del SFX contra tu voz.
	const niv = d.nivel;
	const lus = finitos((niv?.eventos ?? []).map((e) => e.lu_vs_voz));
	const dbs = finitos((niv?.eventos ?? []).map((e) => e.db_vs_voz_rms));
	const nivel: EstadisticasReel['nivel'] = {
		medido: !!niv && lus.length > 0,
		n: lus.length,
		lu: cuantiles3(lus, 1),
		db_rms_p50: red(mediana(dbs), 1),
		voz_lufs: niv?.voz.lufs_integrado ?? null,
		lus,
		dbs,
	};

	// Ritmo: capas que APARECEN en el gancho (0–3 s), el cuerpo y el cierre (últimos 5 s), por minuto.
	let ritmo: EstadisticasReel['ritmo'] = {gancho: null, cuerpo: null, cierre: null, primera_capa_s: null};
	if (d.overlays && d.capas && dur && dur > GANCHO_S + CIERRE_S) {
		const enRango = (a: number, b: number) => capas.filter((c) => c.desde >= a && c.desde < b).length;
		ritmo = {
			gancho: red((enRango(0, GANCHO_S) / GANCHO_S) * 60, 2),
			cuerpo: red((enRango(GANCHO_S, dur - CIERRE_S) / (dur - CIERRE_S - GANCHO_S)) * 60, 2),
			cierre: red((enRango(dur - CIERRE_S, dur + 1) / CIERRE_S) * 60, 2),
			primera_capa_s: capas.length ? red(Math.min(...capas.map((c) => c.desde)), 2) : null,
		};
	}

	// Cabeza.
	const conCara = capas.filter((c) => c.tapa_cabeza !== null);
	const tapan: Record<string, number> = {tarjeta: 0, sticker: 0, insert: 0};
	for (const c of conCara) if (c.tapa_cabeza) tapan[c.clase]++;
	const cabeza: EstadisticasReel['cabeza'] = {
		medido: !!d.cara && !!d.overlays,
		tapan,
		inserts_tapan: d.cara && d.overlays ? tapan.insert : null,
		sobre_barbilla: finitos(conCara.filter((c) => !c.tapa_cabeza && c.clase !== 'insert').map((c) => c.sobre_barbilla)),
		sobre_boca: finitos(conCara.filter((c) => c.clase !== 'insert').map((c) => c.sobre_boca)),
		boca_medida: !!d.cara && bocaMedida(d.cara),
	};

	// Zona: envolvente de tus capas en este reel (titular, subtítulos, tarjetas, stickers, inserts en tarjeta).
	const cajasZona: Caja[] = [...capas.filter((c) => c.subtipo === 'capa').map((c) => c.caja)];
	if (titular.caja) cajasZona.push(titular.caja);
	if (subs.aporta && subs.caja) cajasZona.push(subs.caja);
	const zona = cajasZona.length ? {x0: red(Math.min(...cajasZona.map((c) => c.x0)), 1)!, y0: red(Math.min(...cajasZona.map((c) => c.y0)), 1)!, x1: red(Math.max(...cajasZona.map((c) => c.x1)), 1)!, y1: red(Math.max(...cajasZona.map((c) => c.y1)), 1)!} : null;

	return {
		sc: r.shortCode,
		grupo: r.grupo,
		en_muestra: r.en_muestra,
		reciente: r.reciente,
		peso: d.peso,
		puntaje: r.puntaje,
		duracion_s: dur === null ? null : red(dur, 3),
		fps: d.overlays?.fps ?? d.capas?.fps ?? r.fps ?? null,
		capas,
		subs,
		titular,
		tarjetas,
		stickers,
		inserts,
		zooms,
		desenfoque,
		sfx,
		nivel,
		ritmo,
		cabeza,
		zona,
	};
}

// ───────────────────────────── Agregar entre reels ─────────────────────────────

export type ValorReel = {sc: string; v: number | null | undefined; w: number; n?: number};

export type OpcionesMetrica = {
	ponderar: boolean;
	fuente: string;
	unidad: string;
	falta: string;
	decimales?: number;
	/** Agrega p10 y p90 ENTRE reels (útil para densidades y rangos por video). */
	entreReels?: boolean;
};

/** Métrica de una cifra por reel: mediana (ponderada o no) entre los reels que la tienen. Los null no cuentan. */
export function metricaPorReel(valores: readonly ValorReel[], op: OpcionesMetrica): Metrica<number> {
	const con = valores.filter((x): x is ValorReel & {v: number} => typeof x.v === 'number' && Number.isFinite(x.v));
	const d = op.decimales ?? 2;
	if (con.length === 0) return sinDato(op.falta, op.fuente, {unidad: op.unidad}) as Metrica<number>;
	const pares = con.map((x) => ({v: x.v, w: op.ponderar ? x.w : 1}));
	const valor = red(cuantilPonderado(pares, 0.5), d)!;
	const extra: Record<string, unknown> = {
		unidad: op.unidad,
		ponderado: op.ponderar,
		...(op.ponderar ? {sin_ponderar: red(mediana(con.map((x) => x.v)), d)} : {}),
		...(op.entreReels ? {p10: red(cuantilPonderado(pares, 0.1), d), p90: red(cuantilPonderado(pares, 0.9), d)} : {}),
		...(con.some((x) => x.n !== undefined) ? {n_eventos: con.reduce((s, x) => s + (x.n ?? 0), 0)} : {}),
		por_reel: Object.fromEntries(con.map((x) => [x.sc, red(x.v, d)])),
	};
	return medida(valor, con.length, op.fuente, extra);
}

/** Color mediano (Lab) de los reels que lo tienen. */
export function metricaColor(valores: ReadonlyArray<{sc: string; v: string | null}>, op: {fuente: string; unidad: string; falta: string}): Metrica<string> {
	const con = valores.filter((x): x is {sc: string; v: string} => typeof x.v === 'string' && /^#[0-9a-f]{6}$/i.test(x.v));
	const hex = medianaHex(con.map((x) => x.v));
	if (!hex) return sinDato(op.falta, op.fuente, {unidad: op.unidad}) as Metrica<string>;
	return medida(hex.toUpperCase(), con.length, op.fuente, {unidad: op.unidad, por_reel: Object.fromEntries(con.map((x) => [x.sc, x.v]))});
}

// ───────────────────────────── Insumos externos ─────────────────────────────

export type Extra = {
	corpus: {
		dueno: {username: string; id: string | null};
		ranking: {mediana_puntaje: number; n: number};
		resumen: Record<string, unknown>;
		reels: Array<{shortCode: string; mp4: string | null; puntaje: number | null}>;
		top10: Array<{rank: number; shortCode: string; mp4: string | null; puntaje: number; falta: string | null}>;
	};
	muestra: {n: Record<string, number>; criterios?: Record<string, string>};
	encuadre: Record<string, unknown> | null;
	calibracionCortes: Record<string, unknown> | null;
	tipografia: Tipografia | null;
	mp4Existe: (ruta: string) => boolean;
	/** Dueño esperado (creador.json → handle e instagram_id). Sin él, se confía en el dueño que trae el corpus. */
	dueno?: {username: string; id: string | null} | null;
	fecha: string;
};

export type RankingTipo = {id: IdFuente; peso: number; parecido_p50: number; ancho_rel_p50: number; tinta_rel_p50: number; n: number};
export type Tipografia = {
	version: 1;
	generado_en: string;
	metodo: string;
	/** Familias con todas las muestras juntas (por muestra, el mejor peso de cada familia). */
	familias?: Array<{id: IdFuente; parecido_p50: number; n: number}>;
	familia?: IdFuente | null;
	capas: Partial<Record<'subtitulos' | 'titular' | 'tarjetas', {n_muestras: number; reels: string[]; ranking: RankingTipo[]; elegida?: RankingTipo; nota?: string}>>;
};

// ───────────────────────────── Estilo completo ─────────────────────────────

const F = {
	subs: 'medido: herramientas/estilo/medir.ts (Vision) en tus reels recientes; mediana de la cifra de cada reel',
	capas: 'medido: herramientas/estilo/medir-capas.ts (titular y tarjetas, Vision + whisper)',
	ov: 'medido: herramientas/estilo/overlays.ts (stickers, inserts y desenfoques por píxeles)',
	onsets: 'medido: herramientas/lib/onsets.ts (arranques de SFX) contra la aparición de cada capa',
	nivel: 'medido: aprender.ts → nivel-sfx.json (ebur128 y RMS de 100 ms del audio publicado)',
	cara: 'medido: Apple Vision a 30 fps (herramientas/cara.ts) + cajas de tus capas',
	zooms: 'medido: lib/cara.ts (salto de tamaño de cara verificado con el fondo, 30 fps)',
};
const POND = 'ponderado con el puntaje del corpus';
const RECIENTES = 'solo reels recientes (jun–sep 2026, 1440p), cada reel pesa igual';

/** Arma estilo.json completo a partir de las estadísticas por reel (pura). */
export function construirEstilo(stats: readonly EstadisticasReel[], extra: Extra): Record<string, unknown> {
	const todos = stats;
	const recientes = stats.filter((s) => s.reciente);
	const vr = (lista: readonly EstadisticasReel[], f: (s: EstadisticasReel) => number | null | undefined, n?: (s: EstadisticasReel) => number): ValorReel[] =>
		lista.map((s) => ({sc: s.sc, v: f(s), w: s.peso, ...(n ? {n: n(s)} : {})}));
	const nRec = recientes.length;
	const faltaRec = `ningún reel reciente (de ${nRec}) trae este dato medido`;

	// ── Subtítulos (solo recientes con tu estilo de subtítulo).
	const subsOk = recientes.filter((s) => s.subs.aporta);
	const fSub = `${F.subs}; ${RECIENTES}`;
	const ms = (f: (s: EstadisticasReel) => number | null, unidad: string, d = 2) =>
		metricaPorReel(vr(subsOk, f, (s) => s.subs.n), {ponderar: false, fuente: fSub, unidad, falta: faltaRec, decimales: d, entreReels: true});
	const subtitulosMetricas = {
		franja: {
			y_p10: ms((s) => s.subs.y_p10, 'px base 1920 (centro de la caja; p10 de cada reel)', 1),
			y_p50: ms((s) => s.subs.y_p50, 'px base 1920 (centro de la caja; p50 de cada reel)', 1),
			y_p90: ms((s) => s.subs.y_p90, 'px base 1920 (centro de la caja; p90 de cada reel)', 1),
		},
		ancho_p90: ms((s) => s.subs.ancho_p90, 'px base 1080 (ancho de la caja; p90 de cada reel)', 1),
		alto_mayuscula_p50: ms((s) => s.subs.alto_mayuscula_p50, 'px base 1920 (caja de Vision ÷ 1.38)', 1),
		grosor_borde_p50: ms((s) => s.subs.grosor_borde_p50, 'px base 1920 (borde visible)', 2),
		color_texto: metricaColor(subsOk.map((s) => ({sc: s.sc, v: s.subs.color_texto})), {fuente: fSub, unidad: 'hex sRGB (mediana en Lab)', falta: faltaRec}),
		color_borde: metricaColor(subsOk.map((s) => ({sc: s.sc, v: s.subs.color_borde})), {fuente: fSub, unidad: 'hex sRGB (mediana en Lab)', falta: faltaRec}),
		palabras_por_evento: {
			p10: ms((s) => s.subs.palabras.p10, 'palabras', 1),
			p50: ms((s) => s.subs.palabras.p50, 'palabras', 1),
			p90: ms((s) => s.subs.palabras.p90, 'palabras', 1),
		},
		duracion_evento: {
			p10: ms((s) => s.subs.duracion.p10, 's', 3),
			p50: ms((s) => s.subs.duracion.p50, 's', 3),
			p90: ms((s) => s.subs.duracion.p90, 's', 3),
		},
		mayusculas: ms((s) => s.subs.mayusculas_pct, '% de subtítulos con todas sus letras en MAYÚSCULAS', 1),
		una_linea: ms((s) => s.subs.una_linea_pct, '% de subtítulos en una sola línea', 1),
		resaltado: ms((s) => s.subs.resaltado_pct, '% de subtítulos con alguna palabra de otro color, peso o escala', 1),
		puntuacion: ms((s) => s.subs.puntuacion_pct, '% de subtítulos con signos de puntuación (.,;:!?¿¡…)', 1),
		adelanto_cuadros: metricaPorReel(vr(subsOk, (s) => s.subs.adelanto_cuadros, (s) => s.subs.n_adelanto), {
			ponderar: false,
			fuente: `${fSub}; contra la transcripción del reel (whisper, misma calibración que tus proyectos)`,
			unidad: 'cuadros de 30 fps que el subtítulo aparece ANTES de que empieces la palabra (inicio de la 1.ª palabra − inicio del subtítulo)',
			falta: 'ningún reel reciente con transcripción y ≥ 5 subtítulos emparejados',
			decimales: 1,
			entreReels: true,
		}),
	};
	const descartadosSubs = recientes.filter((s) => !s.subs.aporta).map((s) => ({reel: s.sc, motivo: s.subs.motivo}));
	const puntPct = numeroDe(subtitulosMetricas.puntuacion);
	const quitarPuntuacion = puntPct === null ? sinDato('sin subtítulos medidos', fSub) : medida(puntPct < 50, subtitulosMetricas.puntuacion.n, fSub, {unidad: '¿quitar la puntuación? (sí si < 50 % de tus subtítulos la traen)', pct_con_puntuacion: puntPct});

	// ── Tipografía.
	const tipografia = seccionTipografia(extra.tipografia);
	const fuenteDe = (capa: 'subtitulos' | 'titular' | 'tarjetas'): {id: IdFuente; peso: number} | null => {
		const t = tipografia[capa] as {candidata?: Metrica; peso?: Metrica} | undefined;
		const id = t?.candidata?.valor;
		const peso = t?.peso?.valor;
		return typeof id === 'string' && esIdFuente(id) && typeof peso === 'number' ? {id, peso} : null;
	};
	const tSubs = fuenteDe('subtitulos');
	const tTit = fuenteDe('titular');
	const tTar = fuenteDe('tarjetas');

	// Config de subtítulos (EstiloSubtitulosEdl).
	const origenSubs: Record<string, string> = {};
	const cfgSubs: Record<string, unknown> = {};
	const pon = (k: string, v: unknown, origen: string) => {
		if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return;
		cfgSubs[k] = v;
		origenSubs[k] = origen;
	};
	const capSubs = numeroDe(subtitulosMetricas.alto_mayuscula_p50);
	if (tSubs) {
		pon('fuente', tSubs.id, 'tipografia.subtitulos.candidata');
		pon('peso', tSubs.peso, 'tipografia.subtitulos.peso');
		if (capSubs !== null) pon('tamano_px', red(capSubs / CANDIDATAS[tSubs.id].altoMayuscula, 2), `subtitulos.alto_mayuscula_p50 ÷ alto de mayúscula de ${CANDIDATAS[tSubs.id].nombre} (${CANDIDATAS[tSubs.id].altoMayuscula})`);
	}
	pon('color', numeroOTexto(subtitulosMetricas.color_texto), 'subtitulos.color_texto');
	pon('borde_px', numeroDe(subtitulosMetricas.grosor_borde_p50), 'subtitulos.grosor_borde_p50');
	pon('color_borde', numeroOTexto(subtitulosMetricas.color_borde), 'subtitulos.color_borde');
	pon('x', 540, 'centro del cuadro (tus subtítulos van centrados)');
	pon('y', numeroDe(subtitulosMetricas.franja.y_p50), 'subtitulos.franja.y_p50');
	pon('ancho_max', numeroDe(subtitulosMetricas.ancho_p90), 'subtitulos.ancho_p90');
	const may = numeroDe(subtitulosMetricas.mayusculas);
	if (may !== null) pon('mayusculas', may >= 50, `subtitulos.mayusculas = ${may} % (≥ 50 % → sí)`);
	if (typeof quitarPuntuacion.valor === 'boolean') pon('quitar_puntuacion', quitarPuntuacion.valor, `subtitulos.puntuacion = ${puntPct} % (< 50 % → quitarla)`);
	const resPct = numeroDe(subtitulosMetricas.resaltado);
	if (resPct !== null) pon('resaltado', {activo: resPct >= 5}, `subtitulos.resaltado = ${resPct} % de tus subtítulos (< 5 % → apagado hasta tu respuesta)`);

	// subtitulos.ts acepta un adelanto de −3 a 6 cuadros: uno medido fuera de ese rango se reporta aparte.
	const adelanto = numeroDe(subtitulosMetricas.adelanto_cuadros);
	if (adelanto !== null && (adelanto < -3 || adelanto > 6)) {
		(subtitulosMetricas as Record<string, unknown>).adelanto_medido_cuadros = subtitulosMetricas.adelanto_cuadros;
		(subtitulosMetricas as Record<string, unknown>).adelanto_cuadros = sinDato(`lo medido (${adelanto} cuadros) cae fuera de lo que acepta subtitulos.ts (−3 a 6): revisa adelanto_medido_cuadros`, fSub);
	}
	const subtitulos = {
		...subtitulosMetricas,
		ancho_max: subtitulosMetricas.ancho_p90,
		y_p50: subtitulosMetricas.franja.y_p50,
		quitar_puntuacion: quitarPuntuacion,
		tipografia: (tipografia.subtitulos as {candidata?: Metrica} | undefined)?.candidata ?? sinDato('falta la comparación de tipografías', 'aprender.ts (tipografía)'),
		peso: (tipografia.subtitulos as {peso?: Metrica} | undefined)?.peso ?? sinDato('falta la comparación de tipografías', 'aprender.ts (tipografía)'),
		reels_descartados: descartadosSubs,
		config: {...cfgSubs, origen: origenSubs},
	};

	const franja_subtitulos = {
		y_p10: subtitulosMetricas.franja.y_p10,
		y_p50: subtitulosMetricas.franja.y_p50,
		y_p90: subtitulosMetricas.franja.y_p90,
		ancho_p90: subtitulosMetricas.ancho_p90,
		alto_mayuscula: subtitulosMetricas.alto_mayuscula_p50,
		borde: subtitulosMetricas.grosor_borde_p50,
	};

	// ── Titular (layout: recientes).
	const fTit = `${F.capas}; ${RECIENTES}`;
	const titRec = recientes.filter((s) => s.titular.presente && !s.titular.en_caja);
	const mt = (f: (s: EstadisticasReel) => number | null, unidad: string, d = 1) =>
		metricaPorReel(vr(titRec, f), {ponderar: false, fuente: fTit, unidad, falta: 'ningún reel reciente con titular medido', decimales: d, entreReels: true});
	const conTitularTodos = todos.filter((s) => s.titular.medido);
	const titularMetricas = {
		pct_reels_con_titular: conTitularTodos.length
			? medida(red((100 * conTitularTodos.filter((s) => s.titular.presente).length) / conTitularTodos.length, 1)!, conTitularTodos.length, `${F.capas}; todos los reels medidos`, {
					unidad: '% de reels con titular fijo (≥ 70 % del video)',
					por_grupo: porGrupo(conTitularTodos, (g) => pct(g.filter((s) => s.titular.presente).length, g.length)),
				})
			: sinDato('ningún reel con capas medidas', F.capas),
		pct_en_caja: conTitularTodos.some((s) => s.titular.presente)
			? medida(red((100 * conTitularTodos.filter((s) => s.titular.en_caja).length) / conTitularTodos.filter((s) => s.titular.presente).length, 1)!, conTitularTodos.filter((s) => s.titular.presente).length, `${F.capas}; todos los reels con titular`, {
					unidad: '% de titulares en caja blanca con texto negro (el resto: blanco con contorno negro)',
					reels: conTitularTodos.filter((s) => s.titular.en_caja).map((s) => s.sc),
				})
			: sinDato('ningún reel con titular', F.capas),
		n_lineas: mt((s) => s.titular.n_lineas, 'líneas', 0),
		y: mt((s) => s.titular.y_mayusculas, 'px base 1920 (centro de las mayúsculas del 1.er renglón: línea base − media mayúscula)'),
		y_caja: mt((s) => s.titular.y_caja, 'px base 1920 (centro de la caja de Vision del 1.er renglón)'),
		y_abajo: mt((s) => s.titular.y_abajo, 'px base 1920 (orilla de abajo del último renglón)'),
		interlineado: mt((s) => s.titular.interlineado, 'px base (centro a centro)'),
		alto_mayuscula: mt((s) => s.titular.alto_mayuscula, 'px base (relleno de la 1.ª mayúscula, sin contorno)'),
		ancho_max: mt((s) => s.titular.ancho_max, 'px base 1080 (renglón más ancho)'),
		contorno_grosor: mt((s) => s.titular.contorno_grosor, 'px base (contorno visible)', 2),
		peso_trazo: mt((s) => s.titular.peso, 'trazo ÷ alto de mayúscula', 3),
		color: metricaColor(titRec.map((s) => ({sc: s.sc, v: s.titular.color})), {fuente: fTit, unidad: 'hex', falta: 'ningún titular reciente medido'}),
		contorno_color: metricaColor(titRec.map((s) => ({sc: s.sc, v: s.titular.contorno_color})), {fuente: fTit, unidad: 'hex', falta: 'ningún titular reciente medido'}),
		sombra: titRec.length ? medida(red((100 * titRec.filter((s) => s.titular.sombra).length) / titRec.length, 1)!, titRec.length, fTit, {unidad: '% de titulares con halo oscuro en todas sus líneas'}) : sinDato('ningún titular reciente medido', fTit),
		ejemplos: titRec.slice(0, 6).map((s) => ({reel: s.sc, texto: s.titular.texto})),
	};
	const cfgTit: Record<string, unknown> = {};
	const origenTit: Record<string, string> = {};
	const ponT = (k: string, v: unknown, o: string) => {
		if (v === null || v === undefined) return;
		cfgTit[k] = v;
		origenTit[k] = o;
	};
	if (tTit) {
		ponT('fuente', tTit.id, 'tipografia.titular.candidata');
		ponT('peso', tTit.peso, 'tipografia.titular.peso');
	}
	ponT('alto_mayuscula_px', numeroDe(titularMetricas.alto_mayuscula), 'titular.alto_mayuscula');
	ponT('color', numeroOTexto(titularMetricas.color), 'titular.color');
	const gros = numeroDe(titularMetricas.contorno_grosor);
	ponT('borde_px', gros === null ? null : red(gros + CORRECCION_BORDE_TITULAR, 2), `titular.contorno_grosor + ${CORRECCION_BORDE_TITULAR} (el Chrome de Remotion lo dibuja más delgado; MEDICIONES_CAPAS.titular_borde)`);
	ponT('color_borde', numeroOTexto(titularMetricas.contorno_color), 'titular.contorno_color');
	ponT('x', 540, 'centro del cuadro');
	ponT('y', numeroDe(titularMetricas.y), 'titular.y');
	ponT('interlineado_px', numeroDe(titularMetricas.interlineado), 'titular.interlineado');
	const anchoTit = titularMetricas.ancho_max as Metrica;
	ponT('ancho_max', typeof anchoTit.p90 === 'number' ? anchoTit.p90 : null, 'titular.ancho_max p90 entre reels (el renglón más ancho que usas; uno más largo se achica)');
	const pctSombra = numeroDe(titularMetricas.sombra);
	if (pctSombra !== null) ponT('sombra', {activa: pctSombra >= 50}, `titular.sombra = ${pctSombra} % (≥ 50 % → con sombra)`);
	const titular = {...titularMetricas, config: {...cfgTit, origen: origenTit}};

	// ── Tarjetas.
	const conTar = todos.filter((s) => s.tarjetas.medido);
	const conTarN = conTar.filter((s) => s.tarjetas.n > 0);
	const recTar = recientes.filter((s) => s.tarjetas.n > 0);
	const fTarP = `${F.capas}; todos los reels medidos, ${POND}`;
	const fTarR = `${F.capas}; ${RECIENTES}`;
	const dens = (lista: readonly EstadisticasReel[], f: (s: EstadisticasReel) => number | null, unidad: string, d = 2, n?: (s: EstadisticasReel) => number) =>
		metricaPorReel(vr(lista, f, n), {ponderar: true, fuente: fTarP, unidad, falta: 'ningún reel con tarjetas medidas', decimales: d, entreReels: true});
	const lay = (f: (s: EstadisticasReel) => number | null, unidad: string, d = 1) =>
		metricaPorReel(vr(recTar, f, (s) => s.tarjetas.n), {ponderar: false, fuente: fTarR, unidad, falta: 'ningún reel reciente con tarjetas', decimales: d, entreReels: true});
	const totT = (f: (s: EstadisticasReel) => number) => conTarN.reduce((a, s) => a + f(s), 0);
	const tiposTotal: Record<string, number> = {};
	for (const s of conTarN) for (const [k, v] of Object.entries(s.tarjetas.tipos)) tiposTotal[k] = (tiposTotal[k] ?? 0) + v;
	const dispTotal: Record<string, number> = {vertical: 0, horizontal: 0, mixta: 0};
	for (const s of conTarN) for (const [k, v] of Object.entries(s.tarjetas.disposiciones)) dispTotal[k] = (dispTotal[k] ?? 0) + v;
	const nTarTotal = totT((s) => s.tarjetas.n);
	const tarjetasPorMin = dens(conTar, (s) => s.tarjetas.por_min, 'tarjetas por minuto (los reels sin tarjetas cuentan como 0)', 2, (s) => s.tarjetas.n);
	const tarjetasMetricas = {
		por_minuto: tarjetasPorMin,
		por_min: tarjetasPorMin,
		duracion_s: {
			p10: dens(conTarN, (s) => s.tarjetas.duracion.p10, 's (p10 de cada reel)', 3),
			p50: dens(conTarN, (s) => s.tarjetas.duracion.p50, 's (p50 de cada reel)', 3),
			p90: dens(conTarN, (s) => s.tarjetas.duracion.p90, 's (p90 de cada reel)', 3),
		},
		centro_y: {
			p10: lay((s) => s.tarjetas.centro_y.p10, 'px base 1920 (centro de la caja)'),
			p50: lay((s) => s.tarjetas.centro_y.p50, 'px base 1920 (centro de la caja)'),
			p90: lay((s) => s.tarjetas.centro_y.p90, 'px base 1920 (centro de la caja)'),
		},
		desfase_habla_cuadros: {
			p10: dens(conTarN, (s) => (s.tarjetas.n_desfase >= 3 ? s.tarjetas.desfase.p10 : null), 'cuadros de 30 fps (aparición − inicio de la palabra que coincide; negativo = antes)', 1),
			p50: dens(conTarN, (s) => (s.tarjetas.n_desfase >= 3 ? s.tarjetas.desfase.p50 : null), 'cuadros de 30 fps (aparición − inicio de la palabra que coincide; negativo = antes)', 1),
			p90: dens(conTarN, (s) => (s.tarjetas.n_desfase >= 3 ? s.tarjetas.desfase.p90 : null), 'cuadros de 30 fps', 1),
		},
		palabras_p50: dens(conTarN, (s) => s.tarjetas.palabras_p50, 'palabras por tarjeta', 1),
		pct_literal: dens(conTarN, (s) => s.tarjetas.pct_literal, '% de tarjetas cuyo texto dijiste tal cual', 1),
		pct_parafraseo: dens(conTarN, (s) => s.tarjetas.pct_parafraseo, '% de tarjetas que parafrasean lo dicho', 1),
		pct_sin_coincidencia: dens(conTarN, (s) => s.tarjetas.pct_sin_coincidencia, '% de tarjetas sin palabra dicha en ±2 s', 1),
		pct_con_digitos: dens(conTarN, (s) => s.tarjetas.pct_con_digitos, '% de tarjetas con dígitos', 1),
		pct_numeros_en_digitos: dens(conTarN, (s) => s.tarjetas.pct_numeros_en_digitos, '% de tarjetas con un número dicho que lo ponen en dígitos', 1),
		pct_en_listas: dens(conTarN, (s) => s.tarjetas.pct_en_listas, '% de tarjetas que van en una lista (varias a la vez)', 1),
		listas_por_reel: dens(conTarN, (s) => s.tarjetas.n_listas, 'listas por reel', 1),
		disposicion_listas: Object.values(dispTotal).reduce((a, b) => a + b, 0) > 0
			? medida(dispTotal, Object.values(dispTotal).reduce((a, b) => a + b, 0), `${F.capas}; todas las listas de todos los reels`, {unidad: 'listas por disposición (vertical = una debajo de otra, horizontal = lado a lado, mixta = árbol: 1 arriba y varias abajo)', reels: conTarN.filter((s) => s.tarjetas.n_listas > 0).length})
			: sinDato('ningún reel con listas de tarjetas', F.capas),
		pct_grande: dens(conTarN, (s) => s.tarjetas.pct_grande, '% de tarjetas grandes (mayúscula ≥ 1.4 × la del reel)', 1),
		pct_escritura: dens(conTarN, (s) => s.tarjetas.pct_escritura, '% que se escriben letra por letra', 1),
		pct_emoji: dens(conTarN, (s) => s.tarjetas.pct_emoji, '% con emoji o ícono de color', 1),
		pct_mayuscula_inicial: dens(conTarN, (s) => s.tarjetas.pct_mayuscula_inicial, '% que empiezan con mayúscula', 1),
		pct_entrada_corte: dens(conTarN, (s) => s.tarjetas.pct_entrada_corte, '% que entran con corte seco', 1),
		pct_salida_corte: dens(conTarN, (s) => s.tarjetas.pct_salida_corte, '% que salen con corte seco', 1),
		tipos_total: nTarTotal ? medida(tiposTotal, nTarTotal, `${F.capas}; todas las tarjetas (heurística de lib/capas.ts → tipoDeTarjeta)`, {unidad: 'tarjetas por tipo de palabra', reels: conTarN.length}) : sinDato('ningún reel con tarjetas', F.capas),
		con_sfx: dens(conTarN, (s) => {
			const ts = s.capas.filter((c) => c.clase === 'tarjeta' && c.sfx);
			return ts.length ? red((100 * ts.filter((c) => c.sfx!.con_sfx).length) / ts.length, 1) : null;
		}, '% de tarjetas con un SFX a ±3 cuadros de su aparición (sin corregir por azar)', 1),
		alto_mayuscula: lay((s) => s.tarjetas.alto_mayuscula, 'px base (tarjetas normales: ni grandes ni en lista)'),
		alto_caja_1_renglon: lay((s) => s.tarjetas.alto_caja_1, 'px base (1 renglón, no grandes)'),
		ancho_p50: lay((s) => s.tarjetas.ancho_p50, 'px base 1080'),
		ancho_max_observado: lay((s) => s.tarjetas.ancho_max, 'px base 1080 (la tarjeta más ancha del reel)'),
		pad_arriba: lay((s) => s.tarjetas.pad_arriba, 'px base (línea de mayúsculas → orilla de arriba, 1 renglón)'),
		pad_abajo: lay((s) => s.tarjetas.pad_abajo, 'px base (línea base → orilla de abajo, 1 renglón)'),
		pad_lados: lay((s) => s.tarjetas.pad_lados, 'px base (tinta → orilla, izquierda/derecha)'),
		radio: lay((s) => s.tarjetas.radio, 'px base'),
		interlineado: lay((s) => s.tarjetas.interlineado, 'px base (alto de 2 renglones − alto de 1)'),
		escala_grande: lay((s) => s.tarjetas.escala_grande, '× la mayúscula de las normales del reel', 3),
		escala_lista: lay((s) => s.tarjetas.escala_lista, '× la mayúscula de las normales del reel', 3),
		separacion_lista: lay((s) => s.tarjetas.separacion, 'px base (hueco entre filas de una lista)'),
		peso_trazo: lay((s) => s.tarjetas.peso_trazo, 'trazo ÷ alto de mayúscula', 3),
		color_caja: metricaColor(recTar.map((s) => ({sc: s.sc, v: s.tarjetas.color_caja})), {fuente: fTarR, unidad: 'hex (mediana en Lab)', falta: 'ningún reel reciente con tarjetas'}),
		color_texto: metricaColor(recTar.map((s) => ({sc: s.sc, v: s.tarjetas.color_texto})), {fuente: fTarR, unidad: 'hex (mediana en Lab)', falta: 'ningún reel reciente con tarjetas'}),
		n_tarjetas: nTarTotal ? medida(nTarTotal, conTarN.length, `${F.capas}; todos los reels medidos`, {unidad: 'tarjetas medidas en total'}) : sinDato('ningún reel con tarjetas', F.capas),
	};
	const cfgTar: Record<string, unknown> = {};
	const origenTar: Record<string, string> = {};
	const ponK = (k: string, v: unknown, o: string) => {
		if (v === null || v === undefined) return;
		cfgTar[k] = v;
		origenTar[k] = o;
	};
	if (tTar) {
		ponK('fuente', tTar.id, 'tipografia.tarjetas.candidata');
		ponK('peso', tTar.peso, 'tipografia.tarjetas.peso');
	}
	ponK('alto_mayuscula_px', numeroDe(tarjetasMetricas.alto_mayuscula), 'tarjetas.alto_mayuscula');
	ponK('color_texto', numeroOTexto(tarjetasMetricas.color_texto), 'tarjetas.color_texto');
	ponK('color_fondo', numeroOTexto(tarjetasMetricas.color_caja), 'tarjetas.color_caja');
	ponK('pad_arriba_px', numeroDe(tarjetasMetricas.pad_arriba), 'tarjetas.pad_arriba');
	ponK('pad_abajo_px', numeroDe(tarjetasMetricas.pad_abajo), 'tarjetas.pad_abajo');
	const padL = numeroDe(tarjetasMetricas.pad_lados);
	ponK('pad_lados_px', padL === null ? null : red(padL - SANGRIA_TARJETA, 1), `tarjetas.pad_lados − ${SANGRIA_TARJETA} (sangría de las letras; src/estilo/capas.ts)`);
	ponK('radio_px', numeroDe(tarjetasMetricas.radio), 'tarjetas.radio');
	ponK('interlineado_px', numeroDe(tarjetasMetricas.interlineado), 'tarjetas.interlineado');
	ponK('x', 540, 'centro del cuadro (tus tarjetas van centradas)');
	ponK('y', numeroDe(tarjetasMetricas.centro_y.p50), 'tarjetas.centro_y.p50');
	ponK('escala_grande', numeroDe(tarjetasMetricas.escala_grande), 'tarjetas.escala_grande');
	ponK('escala_lista', numeroDe(tarjetasMetricas.escala_lista), 'tarjetas.escala_lista');
	ponK('separacion_px', numeroDe(tarjetasMetricas.separacion_lista), 'tarjetas.separacion_lista');
	const corte = numeroDe(tarjetasMetricas.pct_entrada_corte);
	if (corte !== null) ponK('entrada', corte >= 50 ? 'corte' : 'pop', `tarjetas.pct_entrada_corte = ${corte} %`);
	const desP50 = tarjetasMetricas.desfase_habla_cuadros.p50 as Metrica;
	const desfaseS =
		typeof desP50.valor === 'number'
			? medida(red(desP50.valor / 30, 3)!, desP50.n, String(desP50.fuente), {unidad: 's (aparición de la tarjeta − inicio de tu palabra; negativo = antes)', de: 'tarjetas.desfase_habla_cuadros.p50 ÷ 30'})
			: sinDato('sin tarjetas emparejadas con lo dicho', F.capas);
	const tarjetas = {...tarjetasMetricas, y: tarjetasMetricas.centro_y.p50, desfase_s: desfaseS, config: {...cfgTar, origen: origenTar}};

	// ── Stickers.
	const conOv = todos.filter((s) => s.stickers.medido);
	const conSt = conOv.filter((s) => s.stickers.n > 0);
	const recSt = recientes.filter((s) => s.stickers.n > 0);
	const fStP = `${F.ov}; todos los reels medidos, ${POND}`;
	const fStR = `${F.ov}; ${RECIENTES}`;
	const densO = (lista: readonly EstadisticasReel[], f: (s: EstadisticasReel) => number | null, unidad: string, d = 2, n?: (s: EstadisticasReel) => number) =>
		metricaPorReel(vr(lista, f, n), {ponderar: true, fuente: fStP, unidad, falta: 'ningún reel con stickers medidos', decimales: d, entreReels: true});
	const layS = (f: (s: EstadisticasReel) => number | null, unidad: string, d = 1) =>
		metricaPorReel(vr(recSt, f, (s) => s.stickers.n), {ponderar: false, fuente: fStR, unidad, falta: 'ningún reel reciente con stickers', decimales: d, entreReels: true});
	const stickersPorMin = densO(conOv, (s) => s.stickers.por_min, 'stickers por minuto (los reels sin stickers cuentan como 0)', 2, (s) => s.stickers.n);
	const stickersMetricas = {
		por_minuto: stickersPorMin,
		por_min: stickersPorMin,
		duracion_s: {
			p10: densO(conSt, (s) => s.stickers.duracion.p10, 's', 3),
			p50: densO(conSt, (s) => s.stickers.duracion.p50, 's', 3),
			p90: densO(conSt, (s) => s.stickers.duracion.p90, 's', 3),
		},
		ancho_px: {
			p10: layS((s) => s.stickers.ancho.p10, 'px base 1080 (caja visible con su borde)', 0),
			p50: layS((s) => s.stickers.ancho.p50, 'px base 1080 (caja visible con su borde)', 0),
			p90: layS((s) => s.stickers.ancho.p90, 'px base 1080 (caja visible con su borde)', 0),
		},
		centro_y: layS((s) => s.stickers.centro_y, 'px base 1920 (centro de la caja)', 0),
		centro_x: layS((s) => s.stickers.centro_x, 'px base 1080 (centro de la caja)', 0),
		pop: {
			cuadros: layS((s) => (s.stickers.n_pop ? s.stickers.pop_cuadros_30 : null), 'cuadros de 30 fps del primer cuadro visible a escala 1 (medido a los fps nativos)', 2),
			escala_inicial: layS((s) => (s.stickers.n_pop ? s.stickers.pop_escala_inicial : null), 'escala del primer cuadro visible', 3),
			sobrepaso: layS((s) => (s.stickers.n_pop ? s.stickers.pop_sobrepaso : null), 'máximo de escala − 1 durante la entrada', 3),
		},
		con_sfx: densO(conSt, (s) => {
			const ts = s.capas.filter((c) => c.clase === 'sticker' && c.sfx);
			return ts.length ? red((100 * ts.filter((c) => c.sfx!.con_sfx).length) / ts.length, 1) : null;
		}, '% de stickers con un SFX a ±3 cuadros de su aparición (sin corregir por azar; mínimo, ver nota)', 1),
		n_stickers: conSt.length ? medida(conSt.reduce((a, s) => a + s.stickers.n, 0), conSt.length, `${F.ov}; todos los reels medidos`, {unidad: 'stickers medidos en total'}) : sinDato('ningún reel con stickers', F.ov),
	};
	const cfgSt: Record<string, unknown> = {};
	const origenSt: Record<string, string> = {};
	const ponS = (k: string, v: unknown, o: string) => {
		if (v === null || v === undefined) return;
		cfgSt[k] = v;
		origenSt[k] = o;
	};
	const popC = numeroDe(stickersMetricas.pop.cuadros);
	const popE = numeroDe(stickersMetricas.pop.escala_inicial);
	if (popC !== null && popC >= 1) {
		ponS('entrada', 'pop', `stickers.pop.cuadros = ${popC} (≥ 1 cuadro de animación → pop)`);
		const cuadros = Math.round(popC) + 1;
		const escala0 = popE === null ? null : red(Math.max(0, Math.min(0.95, (popE * cuadros - 1) / (cuadros - 1))), 3);
		const op = MEDICIONES_CAPAS.sticker_pop_opacidad;
		ponS(
			'pop',
			{cuadros, ...(escala0 === null ? {} : {escalaInicial: escala0}), opacidadInicial: op.valor, cuadrosOpacidad: 1},
			`stickers.pop: cuadros = ${popC} + 1 (ParamsPop cuenta hasta el cuadro que ya vale 1); escalaInicial despejada de la escala del 1.er cuadro visible (${popE}); opacidad: MEDICIONES_CAPAS.sticker_pop_opacidad (n = ${op.n})`,
		);
	}
	ponS('salida', 'corte', `MEDICIONES_CAPAS.sticker_salida (${MEDICIONES_CAPAS.sticker_salida.valor}, n = ${MEDICIONES_CAPAS.sticker_salida.n})`);
	ponS('ancho_px', numeroDe(stickersMetricas.ancho_px.p50), 'stickers.ancho_px.p50');
	const stickers = {...stickersMetricas, config: {...cfgSt, origen: origenSt}};

	// ── Inserts.
	const fIn = `${F.ov}; todos los reels medidos, ${POND}`;
	const conIns = conOv.filter((s) => s.inserts.n > 0);
	const recInsT = recientes.filter((s) => s.inserts.n_tarjeta > 0);
	const insertsPorMin = metricaPorReel(vr(conOv, (s) => s.inserts.por_min, (s) => s.inserts.n), {ponderar: true, fuente: fIn, unidad: 'inserts por minuto (tarjeta + pantalla completa)', falta: 'ningún reel con overlays medidos', entreReels: true});
	const nInsT = conOv.reduce((a, s) => a + s.inserts.n_tarjeta, 0);
	const nInsPC = conOv.reduce((a, s) => a + s.inserts.n_pantalla_completa, 0);
	const inserts = {
		por_minuto: insertsPorMin,
		por_min: insertsPorMin,
		secuencias_por_minuto: metricaPorReel(vr(conOv, (s) => s.inserts.secuencias_por_min), {ponderar: true, fuente: fIn, unidad: 'secuencias de inserts a pantalla completa por minuto (tomas pegadas = una)', falta: 'ningún reel con overlays medidos', entreReels: true}),
		pct_pantalla_completa: nInsT + nInsPC ? medida(red((100 * nInsPC) / (nInsT + nInsPC), 1)!, conIns.length, `${F.ov}; todos los inserts de todos los reels`, {unidad: '% de inserts a pantalla completa (el resto va en tarjeta)', n_eventos: nInsT + nInsPC, pantalla_completa: nInsPC, tarjeta: nInsT}) : sinDato('ningún insert medido', F.ov),
		duracion_s: {
			p10: metricaPorReel(vr(conIns, (s) => s.inserts.duracion.p10), {ponderar: true, fuente: fIn, unidad: 's (p10 de cada reel)', falta: 'ningún insert medido', decimales: 3, entreReels: true}),
			p50: metricaPorReel(vr(conIns, (s) => s.inserts.duracion.p50), {ponderar: true, fuente: fIn, unidad: 's (p50 de cada reel)', falta: 'ningún insert medido', decimales: 3, entreReels: true}),
			p90: metricaPorReel(vr(conIns, (s) => s.inserts.duracion.p90), {ponderar: true, fuente: fIn, unidad: 's (p90 de cada reel)', falta: 'ningún insert medido', decimales: 3, entreReels: true}),
		},
		tarjeta_centro_y: metricaPorReel(vr(recInsT, (s) => s.inserts.tarjeta_centro_y), {ponderar: false, fuente: `${F.ov}; ${RECIENTES}`, unidad: 'px base 1920 (centro de los inserts en tarjeta)', falta: 'ningún insert en tarjeta en tus reels recientes', decimales: 0, entreReels: true}),
		tarjeta_ancho: metricaPorReel(vr(recInsT, (s) => s.inserts.tarjeta_ancho), {ponderar: false, fuente: `${F.ov}; ${RECIENTES}`, unidad: 'px base 1080 (ancho de los inserts en tarjeta)', falta: 'ningún insert en tarjeta en tus reels recientes', decimales: 0, entreReels: true}),
		config: {} as Record<string, unknown>,
	};
	const yIns = numeroDe(inserts.tarjeta_centro_y);
	const wIns = numeroDe(inserts.tarjeta_ancho);
	if (yIns !== null || wIns !== null) {
		inserts.config = {
			tarjeta: {x: 540, ...(yIns !== null ? {y: yIns} : {}), ...(wIns !== null ? {ancho_px: wIns} : {})},
			origen: {'tarjeta.x': 'centro del cuadro', ...(yIns !== null ? {'tarjeta.y': 'inserts.tarjeta_centro_y'} : {}), ...(wIns !== null ? {'tarjeta.ancho_px': 'inserts.tarjeta_ancho'} : {})},
		};
	}

	// ── Zooms y efectos.
	const conZ = todos.filter((s) => s.zooms.medido);
	const zoomsPorMin = metricaPorReel(vr(conZ, (s) => s.zooms.por_min, (s) => s.zooms.confirmados), {ponderar: true, fuente: `${F.zooms}; todos los reels medidos, ${POND}`, unidad: 'zooms de edición por minuto (confirmados por el fondo)', falta: 'ningún reel con la cara medida a 30 fps', entreReels: true});
	const escalas = conZ.flatMap((s) => s.zooms.escalas);
	const zooms = {
		por_minuto: zoomsPorMin,
		por_min: zoomsPorMin,
		candidatos: conZ.length ? medida(conZ.reduce((a, s) => a + s.zooms.candidatos, 0), conZ.length, F.zooms, {unidad: 'saltos de tamaño de cara > 7 % (zoom o corte entre tomas)'}) : sinDato('ningún reel con la cara medida', F.zooms),
		confirmados: conZ.length ? medida(conZ.reduce((a, s) => a + s.zooms.confirmados, 0), conZ.length, F.zooms, {unidad: 'zooms donde el fondo también crece o se encoge'}) : sinDato('ningún reel con la cara medida', F.zooms),
		escala_p50: escalas.length ? medida(red(mediana(escalas.map((x) => (x >= 1 ? x : 1 / x))), 3)!, escalas.length, F.zooms, {unidad: 'escala del zoom (≥ 1)'}) : sinDato('ningún zoom de edición confirmado por el fondo en tus reels medidos', F.zooms),
	};
	const conDes = todos.filter((s) => s.desenfoque.medido);
	const desPorMin = metricaPorReel(vr(conDes, (s) => s.desenfoque.por_min, (s) => s.desenfoque.n), {ponderar: true, fuente: `${F.ov}; todos los reels medidos, ${POND}`, unidad: 'desenfoques de énfasis por minuto (nitidez < 50 % de su mediana)', falta: 'ningún reel con overlays medidos', entreReels: true});
	const efectos = {
		desenfoque_por_minuto: desPorMin,
		desenfoque_por_min: desPorMin,
		desenfoque_duracion_s: metricaPorReel(vr(conDes.filter((s) => s.desenfoque.n > 0), (s) => s.desenfoque.duracion_p50), {ponderar: true, fuente: `${F.ov}; ${POND}`, unidad: 's', falta: 'ningún desenfoque medido', decimales: 3}),
	};

	// ── SFX.
	const conSfx = todos.filter((s) => s.sfx.medido);
	const fSfx = `${F.onsets}; todos los reels medidos, ${POND}`;
	const probSil = metricaPorReel(vr(conSfx, (s) => s.sfx.prob_silencio, (s) => s.sfx.capas), {
		ponderar: true,
		fuente: `${fSfx}; corregido por azar`,
		unidad: 'probabilidad de que una capa salga SIN sonido: 1 − (con SFX − al azar) / (1 − al azar), por reel',
		falta: 'ningún reel con onsets y ≥ 3 capas',
		decimales: 3,
		entreReels: true,
	});
	(probSil as Record<string, unknown>).nota = AVISO_POPS;
	const probSilLimpio = metricaPorReel(vr(conSfx.filter((s) => s.sfx.lateral_limpio), (s) => s.sfx.prob_silencio, (s) => s.sfx.capas), {
		ponderar: true,
		fuente: `${fSfx}; corregido por azar; solo reels con el canal lateral limpio (tu voz al centro: el detector encuentra ~88 % de los SFX)`,
		unidad: 'probabilidad de que una capa salga SIN sonido (control de calidad del detector)',
		falta: 'ningún reel con el canal lateral limpio',
		decimales: 3,
		entreReels: true,
	});
	const conConfiables = conSfx.flatMap((s) => s.sfx.offsets_30_confiables);
	const offs = conConfiables.length >= 10 ? conConfiables : conSfx.flatMap((s) => s.sfx.offsets_30);
	// Arranque del SFX: [p25, p75] medidos; lo que lee el selector se queda dentro de la regla del plan (Fase 3: cada
	// SFX arranca entre −2 y 0 cuadros de su primer cuadro visible). El rango crudo queda en offset_medido_cuadros.
	const fOff = `${F.onsets}; ${conConfiables.length >= 10 ? 'onsets confiables (clic, tono, golpe o lateral)' : 'todos los onsets'}, eventos juntos`;
	const reelsOff = conSfx.filter((s) => s.sfx.offsets_30.length > 0).length;
	let offsetMedido: Metrica = sinDato('menos de 5 capas con SFX medido', F.onsets);
	let offsetMetrica: Metrica = sinDato('menos de 5 capas con SFX medido', F.onsets);
	if (offs.length >= 5) {
		const a = Math.max(-6, Math.round(cuantil(offs, 0.25)!));
		const b = Math.min(6, Math.max(a, Math.round(cuantil(offs, 0.75)!)));
		const extraOff = {
			n_eventos: offs.length,
			p10: red(cuantil(offs, 0.1), 2),
			p25: red(cuantil(offs, 0.25), 2),
			p50: red(cuantil(offs, 0.5), 2),
			p75: red(cuantil(offs, 0.75), 2),
			p90: red(cuantil(offs, 0.9), 2),
			nota: 'la ventana de emparejamiento es ±3 cuadros a los fps nativos (lo de afuera no se ve); si un mp4 no declara el retraso de su AAC (20–45 ms), el audio sale hasta 1 cuadro tarde: 1 cuadro de diferencia no es concluyente',
		};
		offsetMedido = medida([a, b], reelsOff, fOff, {unidad: 'cuadros de 30 fps que el SFX arranca respecto al primer cuadro visible de la capa: [p25, p75] redondeados (positivo = después)', ...extraOff});
		const lo = Math.max(a, REGLA_OFFSET[0]);
		const hi = Math.min(b, REGLA_OFFSET[1]);
		offsetMetrica =
			lo <= hi
				? medida([lo, hi], reelsOff, fOff, {
						unidad: `cuadros de 30 fps (lo que usa el selector): la parte de tu rango medido [${a}, ${b}] que cumple la regla del plan [${REGLA_OFFSET.join(', ')}]`,
						medido: [a, b],
						...extraOff,
					})
				: sinDato(`tu rango medido [${a}, ${b}] cae fuera de la regla del plan [${REGLA_OFFSET.join(', ')}]: decide tú cuál manda`, fOff, {medido: [a, b], ...extraOff});
	}
	const conNivel = todos.filter((s) => s.nivel.medido);
	const fNiv = `${F.nivel}; todos los reels medidos, ${POND}`;
	const nivelLu = metricaPorReel(vr(conNivel, (s) => s.nivel.lu.p50, (s) => s.nivel.n), {ponderar: true, fuente: fNiv, unidad: 'LU: sonoridad momentánea máx. del SFX (resta de potencias) − LUFS integrado de tu voz; p50 de cada reel', falta: 'ningún reel con SFX y voz medibles', decimales: 1, entreReels: true});
	const todosLu = conNivel.flatMap((s) => s.nivel.lus);
	const nivelRms = metricaPorReel(vr(conNivel, (s) => s.nivel.db_rms_p50, (s) => s.nivel.dbs.length), {ponderar: true, fuente: fNiv, unidad: 'dB: RMS de 100 ms en el SFX (mezcla con tu voz) − mediana del RMS de 100 ms de tu voz; p50 de cada reel', falta: 'ningún reel con SFX y voz medibles', decimales: 1, entreReels: true});
	(nivelRms as Record<string, unknown>).antes = 'la medición previa daba +4.7 y +10.2 dB (RMS de 100 ms, n = 2 SFX): esta la repite en todos tus reels medidos';
	const variacion = cuantil(finitos(conNivel.map((s) => (s.nivel.lu.p90 !== null && s.nivel.lu.p10 !== null ? (s.nivel.lu.p90 - s.nivel.lu.p10) / 2 : null))), 0.5);
	const luM = nivelLu as Metrica;
	const ganancia: Metrica =
		typeof luM.valor === 'number' && typeof luM.p10 === 'number' && typeof luM.p90 === 'number'
			? medida([red(luM.p10, 1), red(luM.p90, 1)], luM.n, fNiv, {
					unidad: 'LU respecto a tu voz (sonoridad momentánea máx. del SFX − LUFS integrado de la voz): [p10, p90] entre reels del centro de cada reel',
					variacion_db: red(variacion ?? 0, 1),
					centro: luM.valor,
					nota: 'positivo = el SFX suena más fuerte que tu voz (así está en tus reels)',
				})
			: sinDato('sin nivel de SFX medido', F.nivel);
	// Rango de eventos por video para la simulación del selector: solo reels con alguna capa (un reel sin capas no
	// tiene eventos que sonorizar).
	const conCapas = todos.filter((s) => (s.sfx.eventos_por_video ?? 0) >= 1);
	const nEv = metricaPorReel(vr(conCapas, (s) => s.sfx.eventos_por_video), {ponderar: true, fuente: `medido: tarjetas (medir-capas) + stickers e inserts (overlays) + zooms confirmados, por reel con alguna capa; ${POND}`, unidad: 'capas por video', falta: 'ningún reel con capas y overlays medidos', decimales: 0, entreReels: true});
	const nEvM = nEv as Metrica;
	const eventosPorVideo: Metrica =
		typeof nEvM.p10 === 'number' && typeof nEvM.p90 === 'number' && nEvM.p10 >= 1
			? medida([Math.round(nEvM.p10), Math.round(nEvM.p90)], nEvM.n, String(nEvM.fuente), {unidad: 'capas por video: [p10, p90] entre reels con alguna capa', p50: nEvM.valor, sin_capas: todos.filter((s) => s.sfx.eventos_por_video === 0).map((s) => s.sc), por_reel: nEvM.por_reel})
			: sinDato('ningún reel con capas medidas', String(nEvM.fuente));
	const fuentesTot: Record<string, Record<string, number>> = {};
	for (const s of conSfx) for (const [clase, m] of Object.entries(s.sfx.fuentes_por_clase)) for (const [f, k] of Object.entries(m)) ((fuentesTot[clase] ??= {})[f] = (fuentesTot[clase][f] ?? 0) + k);
	const sfx = {
		prob_silencio: probSil,
		prob_silencio_lateral_limpio: probSilLimpio,
		pct_capas_con_sfx: metricaPorReel(vr(conSfx, (s) => s.sfx.pct_con_sfx, (s) => s.sfx.capas), {ponderar: true, fuente: fSfx, unidad: '% de capas con un onset a ±3 cuadros de su aparición (sin corregir)', falta: 'ningún reel con onsets', decimales: 1, entreReels: true}),
		pct_esperado_al_azar: metricaPorReel(vr(conSfx, (s) => s.sfx.pct_azar), {ponderar: true, fuente: fSfx, unidad: '% del video a ±3 cuadros de algún onset (lo que coincidiría por azar)', falta: 'ningún reel con onsets', decimales: 1, entreReels: true}),
		pct_capas_con_sfx_corregido: metricaPorReel(vr(conSfx, (s) => s.sfx.pct_corregido), {ponderar: true, fuente: `${fSfx}; corregido por azar`, unidad: '% de capas con SFX después de quitar lo que coincidiría por azar', falta: 'ningún reel con onsets', decimales: 1, entreReels: true}),
		offset_cuadros: offsetMetrica,
		offset_medido_cuadros: offsetMedido,
		nivel_lu: nivelLu,
		nivel_lu_eventos: todosLu.length ? medida(red(mediana(todosLu), 1)!, todosLu.length, `${F.nivel}; todos los SFX juntos`, {unidad: 'LU (cada SFX cuenta igual)', p10: red(cuantil(todosLu, 0.1), 1), p90: red(cuantil(todosLu, 0.9), 1), reels: conNivel.length}) : sinDato('sin SFX medibles', F.nivel),
		nivel_rms_db: nivelRms,
		ganancia_db: ganancia,
		eventos_por_video: eventosPorVideo,
		huecos_entre_sfx_s: metricaPorReel(vr(conSfx, (s) => s.sfx.huecos_p50), {ponderar: true, fuente: fSfx, unidad: 's entre apariciones con sonido (p50 de cada reel)', falta: 'ningún reel con 2 o más capas con sonido', decimales: 2}),
		fuentes_de_onset_por_clase: Object.keys(fuentesTot).length ? medida(fuentesTot, conSfx.length, `${F.onsets}; todos los SFX emparejados`, {unidad: 'cuántos SFX vio cada detector, por clase de capa (pista de qué suena, no la categoría)'}) : sinDato('sin SFX emparejados', F.onsets),
		categorias_por_tipo: sinDato('qué SFX (pop, clic, whoosh…) usas en cada tipo de capa necesita escucharlos o la semántica de Gemini, que cuesta y necesita tu sí: el selector sigue con su mapeo supuesto', 'N/A (semántica)'),
	};

	// ── Cortes y encuadre (de otras piezas).
	const cortes = seccionCortes(extra.calibracionCortes);
	const encuadre = seccionEncuadre(extra.encuadre);

	// ── Zona UI (recientes): envolvente de tus capas por reel → p10 de arriba/izquierda y p90 de abajo/derecha.
	const recZona = recientes.filter((s) => s.zona);
	const fZona = `medido: envolvente de titular, subtítulos, tarjetas, stickers e inserts en tarjeta de cada reel; ${RECIENTES}`;
	const zona = (f: (c: Caja) => number, p: number, unidad: string) => {
		const v = recZona.map((s) => ({sc: s.sc, v: f(s.zona!), w: 1}));
		if (!v.length) return sinDato('ningún reel reciente con capas medidas', fZona);
		return medida(red(cuantil(v.map((x) => x.v), p), 1)!, v.length, fZona, {unidad, mediana: red(mediana(v.map((x) => x.v)), 1), min: red(Math.min(...v.map((x) => x.v)), 1), max: red(Math.max(...v.map((x) => x.v)), 1), por_reel: Object.fromEntries(v.map((x) => [x.sc, x.v]))});
	};
	const zona_ui = {
		arriba: zona((c) => c.y0, 0.1, 'px base 1920: p10 entre reels del borde de arriba de tus capas (el titular)'),
		abajo: zona((c) => c.y1, 0.9, 'px base 1920: p90 entre reels del borde de abajo de tus capas (los subtítulos)'),
		izquierda: zona((c) => c.x0, 0.1, 'px base 1080: p10 entre reels del borde izquierdo de tus capas'),
		derecha: zona((c) => c.x1, 0.9, 'px base 1080: p90 entre reels del borde derecho de tus capas'),
		guia_meta: supuesto({arriba: 268.8, abajo: 1248, izquierda: 64.8, derecha: 1015.2}, 'guía de Meta para Reels: 14 % arriba, 35 % abajo, 6 % a los lados', 'es la guía externa: solo se usa donde lo medido sea N/A'),
	};

	// ── Tapa la cabeza (frecuencia: todos, ponderado).
	const conCab = todos.filter((s) => s.cabeza.medido);
	const fCab = `${F.cara}; todos los reels medidos, ${POND}`;
	const tapaP = (p: number) => {
		const v = conCab.map((s) => ({v: s.cabeza.inserts_tapan ?? NaN, w: s.peso}));
		const ok = v.filter((x) => Number.isFinite(x.v));
		if (!ok.length) return sinDato('ningún reel con cara.json y overlays medidos', F.cara);
		return medida(red(cuantilPonderado(ok, p), 2)!, ok.length, fCab, {unidad: `inserts en tarjeta que tapan tu cabeza por reel (p${Math.round(p * 100)} entre reels)`, sin_ponderar: red(cuantil(ok.map((x) => x.v), p), 2), por_reel: Object.fromEntries(conCab.map((s) => [s.sc, s.cabeza.inserts_tapan]))});
	};
	const tapanTot: Record<string, number> = {tarjeta: 0, sticker: 0, insert: 0};
	for (const s of conCab) for (const [k, v] of Object.entries(s.cabeza.tapan)) tapanTot[k] += v;
	const sobre = recientes.flatMap((s) => s.cabeza.sobre_barbilla);
	const recBoca = recientes.filter((s) => s.cabeza.sobre_boca.length > 0);
	const sobreBoca = recBoca.flatMap((s) => s.cabeza.sobre_boca);
	const tapa_cabeza = {
		p50: tapaP(0.5),
		p90: tapaP(0.9),
		por_clase: conCab.length ? medida(tapanTot, conCab.length, `${F.cara}; todas las capas de todos los reels`, {unidad: 'capas que se enciman con la caja de tu cabeza (borde de arriba sobre la barbilla y ≥ 20 % de traslape horizontal)'}) : sinDato('ningún reel con cara medida', F.cara),
	};
	const cabeza = {
		margen_barbilla_px: sobre.length >= 5 ? medida(red(cuantil(sobre, 0.1), 1)!, recientes.filter((s) => s.cabeza.sobre_barbilla.length).length, `${F.cara}; stickers y tarjetas que NO tapan la cabeza; ${RECIENTES}`, {unidad: 'px base: borde de arriba de la capa − barbilla más baja de su ventana (p10 de todas las capas)', p50: red(cuantil(sobre, 0.5), 1), p90: red(cuantil(sobre, 0.9), 1), n_eventos: sobre.length}) : sinDato('menos de 5 capas con cara medida en tus reels recientes', F.cara),
		margen_plan: supuesto(60, 'plan, Fase 3: borde de arriba ≥ barbilla máx + 60 px', 'compáralo con margen_barbilla_px: es lo que de verdad dejas en tus reels'),
		margen_boca_px: sobreBoca.length >= 5
			? medida(red(cuantil(sobreBoca, 0.1), 1)!, recBoca.length, `${F.cara}; stickers y tarjetas a la altura de tu cabeza; ${RECIENTES}`, {
					unidad: 'px base: borde de arriba de la capa − boca más baja de su ventana (p10 de todas las capas; negativo = tapa la boca)',
					p50: red(cuantil(sobreBoca, 0.5), 1),
					p90: red(cuantil(sobreBoca, 0.9), 1),
					n_eventos: sobreBoca.length,
					boca: `${recBoca.filter((s) => s.cabeza.boca_medida).length} de ${recBoca.length} reels con la boca medida (labios de Vision); en los demás se estima con barbilla − 0.18 × alto de la cara`,
				})
			: sinDato('menos de 5 capas con cara medida en tus reels recientes', F.cara),
		pct_capas_tapan_boca: sobreBoca.length >= 5
			? medida(red((100 * sobreBoca.filter((v) => v < 0).length) / sobreBoca.length, 1)!, recBoca.length, `${F.cara}; ${RECIENTES}`, {unidad: '% de stickers y tarjetas cuyo borde de arriba sube sobre tu boca (la zona protegida del director)', n_eventos: sobreBoca.length})
			: sinDato('menos de 5 capas con cara medida en tus reels recientes', F.cara),
	};

	// ── Ritmo (todos, ponderado).
	const conRitmo = todos.filter((s) => s.ritmo.gancho !== null);
	const fRit = `medido: tarjetas + stickers + inserts que APARECEN en cada tramo, por reel; todos los reels medidos, ${POND}`;
	const rit = (f: (s: EstadisticasReel) => number | null, unidad: string) => metricaPorReel(vr(conRitmo, f), {ponderar: true, fuente: fRit, unidad, falta: 'ningún reel con capas y overlays medidos (y de más de 8 s)', decimales: 2, entreReels: true});
	const ritmo = {
		gancho: {capas_por_min: rit((s) => s.ritmo.gancho, `capas por minuto en 0–${GANCHO_S} s`), desde_s: 0, hasta_s: GANCHO_S},
		cuerpo: {capas_por_min: rit((s) => s.ritmo.cuerpo, `capas por minuto entre ${GANCHO_S} s y el final − ${CIERRE_S} s`)},
		cierre: {capas_por_min: rit((s) => s.ritmo.cierre, `capas por minuto en los últimos ${CIERRE_S} s`)},
		primera_capa_s: rit((s) => s.ritmo.primera_capa_s, 's hasta que aparece la primera capa'),
	};

	// ── Densidades (alias para el director).
	const densidades = {
		tarjetas_por_min: tarjetasMetricas.por_minuto,
		stickers_por_min: stickersMetricas.por_minuto,
		inserts_por_min: insertsPorMin,
		zooms_por_min: zoomsPorMin,
		desenfoque_por_min: desPorMin,
		capas_por_min: metricaPorReel(vr(todos.filter((s) => s.tarjetas.medido && s.stickers.medido), (s) => (s.duracion_s ? red((s.capas.length / s.duracion_s) * 60, 2) : null)), {ponderar: true, fuente: `medido: tarjetas + stickers + inserts por reel; ${POND}`, unidad: 'capas por minuto', falta: 'ningún reel con capas y overlays medidos', entreReels: true}),
		sfx_por_min: metricaPorReel(vr(conSfx, (s) => (s.duracion_s ? red((s.sfx.con_sfx / s.duracion_s) * 60, 2) : null)), {ponderar: true, fuente: fSfx, unidad: 'capas con SFX por minuto (sin corregir por azar)', falta: 'ningún reel con onsets', entreReels: true}),
	};

	// ── Textos: mínimo por palabra (lo medido manda sobre BRAG).
	const textos = {
		min_por_palabra_s: metricaPorReel(vr(conTarN, (s) => s.tarjetas.min_por_palabra_p10, (s) => s.tarjetas.n), {ponderar: true, fuente: `${F.capas}; p10 de (duración ÷ palabras) de las tarjetas de cada reel; ${POND}`, unidad: 's por palabra que dejas un texto en pantalla (lo mínimo que usas)', falta: 'ningún reel con tarjetas', decimales: 3, entreReels: true}),
		min_por_palabra_brag: supuesto(0.3, 'BRAG: ~0.3 s por palabra leída', 'regla externa: solo si tus reels no lo traen medido'),
	};

	// ── Resaltado.
	const modos: Record<string, number> = {color: 0, peso: 0, escala: 0};
	for (const s of subsOk) for (const [k, v] of Object.entries(s.subs.resaltado_modos)) modos[k] = (modos[k] ?? 0) + v;
	const resaltado = {
		pct: subtitulosMetricas.resaltado,
		modos: subsOk.length ? medida(modos, subsOk.length, fSub, {unidad: 'subtítulos con resaltado por modo (color, peso, escala)'}) : sinDato(faltaRec, fSub),
		config: {activo: resPct !== null && resPct >= 5},
		pregunta: resPct !== null && resPct < 5 ? 'En tus reels recientes casi no hay palabras resaltadas en los subtítulos. Tú dijiste "resalto las palabras como con bold": ¿lo enciendo (más peso en la palabra clave) o lo dejo apagado como en tus reels?' : null,
	};

	// ── Supuestos externos (nunca como medidos).
	const supuestos = {
		brag: {
			gancho_s: supuesto(2, 'BRAG: hook en 2 s', 'regla externa para el titular y los inserts de lanzamiento; no se mide en tus reels'),
			por_palabra_s: supuesto(0.3, 'BRAG: ~0.3 s por palabra leída', 'tus tarjetas mandan (textos.min_por_palabra_s)'),
			entrada: supuesto('entra rápido y se queda', 'BRAG', 'regla de estilo externa, solo para sus insertos'),
		},
		zoom_demos: {
			entra_antes_ms: supuesto([400, 500], 'plan, Fase 5: el zoom de las demos entra 400–500 ms antes del evento', 'no hay demos tuyas medidas'),
			se_mantiene_s: supuesto([1, 1.5], 'plan, Fase 5', 'no hay demos tuyas medidas'),
			escala: supuesto('clamp(0.7·min(viewW/boxW, viewH/boxH), 1, 2.5)', 'plan, Fase 5', 'no hay demos tuyas medidas'),
		},
		franja_margen_px: supuesto(20, 'plan, layout: margen entre las capas y la franja de subtítulos', 'no se midió el aire que dejas sobre los subtítulos'),
	};

	// ── Comparación de grupos (hipótesis).
	const grupos = ['top', 'recientes', 'resto'] as const;
	const comparacion: Record<string, unknown> = {
		nota: 'HIPÓTESIS: medianas simples por grupo con n chico; no prueba que algo cause más vistas. "recientes" incluye los reels medidos antes (jul–sep, 1440p) además de los 10 de la muestra.',
	};
	for (const g of grupos) {
		const sg = todos.filter((s) => s.grupo === g);
		const m = (f: (s: EstadisticasReel) => number | null, unidad: string, d = 2) =>
			metricaPorReel(sg.map((s) => ({sc: s.sc, v: f(s), w: 1})), {ponderar: false, fuente: `medido; grupo "${g}" (mediana simple)`, unidad, falta: `ningún reel del grupo ${g} con este dato`, decimales: d});
		comparacion[g] = {
			reels: sg.length,
			tarjetas_por_min: m((s) => s.tarjetas.por_min, 'tarjetas por minuto'),
			stickers_por_min: m((s) => s.stickers.por_min, 'stickers por minuto'),
			inserts_por_min: m((s) => s.inserts.por_min, 'inserts por minuto'),
			capas_por_min: m((s) => (s.duracion_s && s.tarjetas.medido && s.stickers.medido ? red((s.capas.length / s.duracion_s) * 60, 2) : null), 'capas por minuto'),
			pct_capas_con_sfx: m((s) => s.sfx.pct_corregido, '% de capas con SFX (corregido por azar)', 1),
			prob_silencio: m((s) => s.sfx.prob_silencio, 'probabilidad de capa sin SFX', 3),
			nivel_lu: m((s) => s.nivel.lu.p50, 'LU del SFX respecto a tu voz', 1),
			pct_con_titular: sg.some((s) => s.titular.medido)
				? medida(pct(sg.filter((s) => s.titular.presente).length, sg.filter((s) => s.titular.medido).length)!, sg.filter((s) => s.titular.medido).length, `medido; grupo "${g}"`, {unidad: '% de reels con titular'})
				: sinDato(`ningún reel del grupo ${g} con el titular medido`, `medido; grupo "${g}"`),
			puntaje_p50: m((s) => s.puntaje, 'puntaje del corpus', 2),
		};
	}

	// ── Corpus y muestra.
	const c = extra.corpus;
	const scs = c.reels.map((r) => r.shortCode);
	const comp = scs.filter((s) => /^comp_/i.test(s)).length;
	const repetidos = scs.length - new Set(scs).size;
	const esperado = extra.dueno ?? c.dueno;
	const delDueno = c.dueno.username.toLowerCase() === esperado.username.toLowerCase() && (esperado.id === null || c.dueno.id === esperado.id);
	const otraCuenta = delDueno ? c.reels.filter((r) => r.mp4 !== null && /comp_|competid/i.test(r.mp4)).length : c.reels.length;
	const top10 = c.top10.map((t) => ({rank: t.rank, shortCode: t.shortCode, puntaje: t.puntaje, mp4_local: !!t.mp4 && extra.mp4Existe(t.mp4), falta: t.mp4 && extra.mp4Existe(t.mp4) ? null : (t.falta ?? 'sin mp4 local')}));
	const corpus = {
		reels: medida(c.reels.length, c.reels.length, 'estilo/corpus.json (herramientas/estilo/corpus.ts)', {unidad: 'shortCodes tuyos', repetidos}),
		de_otra_cuenta: medida(otraCuenta, c.reels.length, `estilo/corpus.json: dueño ${esperado.username}${esperado.id ? ` / ${esperado.id}` : ''} y rutas de mp4`, {unidad: 'reels de otra cuenta'}),
		comp: medida(comp, c.reels.length, 'estilo/corpus.json', {unidad: 'shortCodes comp_* (videos de competidores)'}),
		en_ranking: medida(c.ranking.n, c.reels.length, 'estilo/corpus.json → ranking', {unidad: 'reels con ≥ 14 días al capturarse y plays', mediana_puntaje: c.ranking.mediana_puntaje}),
		top10_con_mp4: medida(top10.filter((t) => t.mp4_local).length, 10, 'estilo/corpus.json → top10 + archivo local', {unidad: 'de los 10 primeros por puntaje con mp4 local', top10}),
	};
	const porGrupoN: Record<string, number> = {};
	for (const s of todos) porGrupoN[s.grupo] = (porGrupoN[s.grupo] ?? 0) + 1;
	const muestra = {
		n: {...extra.muestra.n, medidos: todos.length, recientes_para_layout: nRec, por_grupo: porGrupoN},
		criterios: extra.muestra.criterios ?? {},
		reels: todos.map((s) => ({shortCode: s.sc, grupo: s.grupo, en_muestra: s.en_muestra, reciente: s.reciente, puntaje: s.puntaje, peso: red(s.peso, 4), duracion_s: s.duracion_s, fps: s.fps})),
	};

	const metodo = {
		reglas: [
			'Cada número es {valor | "N/A", n, fuente, falta}; los N/A no cuentan.',
			'Primero una cifra por reel y luego entre reels (cada reel pesa igual o según su puntaje).',
			'Apariencia y layout: solo reels recientes (desde el 1-jun-2026, 1440×2560), cada reel pesa igual.',
			'Densidades, frecuencias y tiempos: todos los reels medidos, ponderados con su puntaje del corpus (sin puntaje: la mediana del ranking).',
			'Top / recientes / resto: medianas simples; es una hipótesis.',
			'BRAG, el zoom de las demos y la guía de Meta van como "supuesto" (n = 0).',
		],
		cuantil_ponderado: 'el primer valor cuya suma de pesos pasa p × el total (en el borde exacto, el promedio de los dos vecinos): con pesos iguales es la mediana de siempre y, si un reel tiene más de la mitad del peso, la mediana es la suya',
		sfx_por_azar: 'un onset cae cerca de una aparición por casualidad con probabilidad igual a la fracción del video a ±3 cuadros de algún onset; se corrige: (observado − azar) / (1 − azar)',
		tapa_cabeza: 'una capa tapa la cabeza si su borde de arriba sube más de 10 px sobre la barbilla más baja de su ventana y se encima ≥ 20 % del ancho de la cabeza (cara.json a 30 fps)',
		gemini: 'N/A: la semántica (qué stickers, logos, música y categorías de SFX) usa Gemini, que cuesta (≈ US$1.3–1.9 los 25 reels) y necesita tu sí',
	};

	const estilo: Record<string, unknown> = {
		version: VERSION_ESTILO,
		esquema: 1,
		generado_en: extra.fecha,
		generado_por: 'herramientas/estilo/agregar.ts (lo llama herramientas/estilo/aprender.ts)',
		aprobado: false,
		pendiente: 'Tu aprobación del estilo, la fuente y las excepciones (titular arriba de la cabeza, inserts que tapan la cara) en estilo/informe.md',
		metodo,
		corpus,
		muestra,
		subtitulos,
		franja_subtitulos,
		titular,
		tarjetas,
		stickers,
		inserts,
		zooms,
		efectos,
		sfx,
		cortes,
		encuadre,
		zona_ui,
		tapa_cabeza,
		cabeza,
		ritmo,
		densidades,
		tipografia,
		resaltado,
		textos,
		supuestos,
		comparacion_grupos: comparacion,
	};
	const {conteo} = revisarMetricas(estilo);
	estilo.resumen = {metricas: conteo.total, medidas: conteo.medidas, na: conteo.na, supuestos: conteo.supuestos, texto: `${conteo.medidas} métricas medidas, ${conteo.supuestos} supuestos y ${conteo.na} N/A (de ${conteo.total})`};
	return estilo;
}

function numeroDe(m: unknown): number | null {
	const v = (m as {valor?: unknown} | null)?.valor;
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function numeroOTexto(m: unknown): string | null {
	const v = (m as {valor?: unknown} | null)?.valor;
	return typeof v === 'string' && v !== NA ? v : null;
}

function porGrupo(lista: readonly EstadisticasReel[], f: (g: EstadisticasReel[]) => number | null): Record<string, number | null> {
	const salida: Record<string, number | null> = {};
	for (const g of ['top', 'recientes', 'resto', 'otros']) {
		const sg = lista.filter((s) => s.grupo === g);
		if (sg.length) salida[g] = f(sg);
	}
	return salida;
}

/** Sección de tipografía a partir de referencias/tipografia.json (o N/A). */
export function seccionTipografia(t: Tipografia | null): Record<string, unknown> {
	const salida: Record<string, unknown> = {
		candidatas: ['TikTok Sans 600 y 800', 'Instrument Sans 600 y 700', 'Inter 600 y 800'],
		metodo: t?.metodo ?? 'recortes reales de tus reels contra cada candidata dibujada con el mismo texto y el mismo alto de tinta; parecido = IoU de las máscaras',
		regla: 'por capa gana la candidata (familia y peso) con más parecido; si otras quedan a < 0.02 de IoU, de esas la de tinta más cercana a la tuya. "familia" junta todas tus capas como dato. Ninguna candidata es idéntica: tu letra real probablemente es de Meta y no se distribuye; la decisión final es tuya',
		familia: t?.familias?.length
			? medida(t.familia ?? t.familias[0].id, t.familias[0].n, 'medido: aprender.ts (tipografía) → referencias/tipografia.json; todas las muestras juntas', {ranking: t.familias, nombre: CANDIDATAS[(t.familia ?? t.familias[0].id) as IdFuente].nombre})
			: sinDato('falta la comparación de tipografías (corre aprender.ts)', 'aprender.ts (tipografía)'),
	};
	for (const capa of ['subtitulos', 'titular', 'tarjetas'] as const) {
		const c = t?.capas[capa];
		const fuente = `medido: aprender.ts (tipografía) → referencias/tipografia.json; ${c ? `${c.n_muestras} recortes de ${c.reels.length} reels` : ''}`.replace(/; $/, '');
		if (!c || !c.ranking.length || c.n_muestras === 0) {
			salida[capa] = {candidata: sinDato(c?.nota ?? 'falta la comparación de tipografías (corre aprender.ts)', 'aprender.ts (tipografía)'), peso: sinDato('falta la comparación de tipografías', 'aprender.ts (tipografía)'), parecido: sinDato('falta la comparación', 'aprender.ts (tipografía)')};
			continue;
		}
		const mejor = c.elegida ?? c.ranking[0];
		salida[capa] = {
			candidata: medida(mejor.id, c.n_muestras, fuente, {nombre: CANDIDATAS[mejor.id].nombre, reels: c.reels}),
			peso: medida(mejor.peso, c.n_muestras, fuente, {unidad: 'peso de la instancia más parecida'}),
			parecido: medida(mejor.parecido_p50, c.n_muestras, fuente, {unidad: 'IoU p50 de las máscaras (1 = idénticas)', ancho_rel_p50: mejor.ancho_rel_p50, tinta_rel_p50: mejor.tinta_rel_p50}),
			ranking: c.ranking,
			...(c.nota ? {nota: c.nota} : {}),
		};
	}
	return salida;
}

/** Sección de cortes con estilo/calibracion-cortes.json (otra pieza) o N/A. */
export function seccionCortes(cal: Record<string, unknown> | null): Record<string, unknown> {
	const fuente = 'estilo/calibracion-cortes.json (herramientas/estilo/calibrar-cortes.ts)';
	if (!cal) {
		const falta = 'estilo/calibracion-cortes.json todavía no existe (lo escribe la pieza de cortes con tus pares crudo ↔ publicado)';
		return {parametros: sinDato(falta, fuente), cortes_por_min: sinDato(falta, fuente), velocidad: sinDato(falta, fuente), pads: sinDato(falta, fuente)};
	}
	const nPares = typeof cal.n_pares === 'number' ? cal.n_pares : Array.isArray(cal.por_par) ? cal.por_par.length : 0;
	const porPar = Array.isArray(cal.por_par) ? (cal.por_par as Array<Record<string, unknown>>) : [];
	const cpm = finitos(porPar.map((p) => p.cortes_por_min_publicado as number | null));
	const envolver = (k: string) => {
		const v = cal[k];
		if (v === undefined || v === null) return sinDato(`calibracion-cortes.json no trae "${k}"`, fuente);
		if (typeof v === 'object' && v !== null && Object.hasOwn(v, 'valor')) return {...(v as object), fuente: (v as {fuente?: string}).fuente ?? fuente, falta: (v as {falta?: string | null}).falta ?? null, n: (v as {n?: number}).n ?? nPares};
		return nPares > 0 ? medida(v, nPares, fuente) : sinDato('sin pares calibrados', fuente);
	};
	return {
		parametros: cal.parametros && nPares > 0 ? medida(cal.parametros, nPares, fuente, {unidad: 'parámetros de cortes.ts calibrados con tus pares'}) : sinDato('sin parámetros calibrados', fuente),
		cortes_por_min: cpm.length ? medida(red(mediana(cpm), 2)!, cpm.length, fuente, {unidad: 'cortes por minuto en tus reels publicados (pares)'}) : sinDato('sin pares con cortes medidos', fuente),
		velocidad: envolver('velocidad'),
		pads: envolver('pads'),
		pausas: envolver('pausas'),
	};
}

/** Sección de encuadre con estilo/encuadre.json (otra pieza) o N/A. */
export function seccionEncuadre(enc: Record<string, unknown> | null): Record<string, unknown> {
	const fuente = 'estilo/encuadre.json (pruebas/integracion/f6-encuadre.ts, Apple Vision)';
	const salida: Record<string, unknown> = {};
	for (const k of ['barbilla_y', 'alto_cara', 'centro_x', 'coronilla_y']) {
		const v = enc?.[k] as {valor?: unknown; n?: unknown; p10?: unknown; p90?: unknown} | undefined;
		salida[k] =
			v && typeof v.valor === 'number' && typeof v.n === 'number' && v.n > 0
				? medida(v.valor, v.n, fuente, {p10: v.p10 ?? null, p90: v.p90 ?? null, unidad: 'px base (p50 de cada reel, mediana entre reels recientes)'})
				: sinDato(enc ? `estilo/encuadre.json no trae ${k}` : 'estilo/encuadre.json todavía no existe (lo escribe la pieza de encuadre)', fuente);
	}
	return salida;
}

// ───────────────────────────── momentos.jsonl ─────────────────────────────

export type MomentoSalida = {
	reel: string;
	grupo: string;
	puntaje: number | null;
	peso: number;
	t: number;
	hasta: number;
	duracion_s: number;
	segmento: 'gancho' | 'cuerpo' | 'cierre';
	clase: 'tarjeta' | 'sticker' | 'insert';
	subtipo: 'capa' | 'pantalla-completa';
	texto: string | null;
	tipo_palabra: string | null;
	palabras_dichas: string;
	desfase_cuadros: number | null;
	con_sfx: boolean | null;
	sfx_confiable: boolean | null;
	desfase_sfx_cuadros: number | null;
	posicion: {x: number; y: number; w: number; h: number};
	lista: string | null;
	tapa_cabeza: boolean | null;
};

/** Una línea por capa medida, con lo que dijiste alrededor (±1.5 s). Ordenadas por puntaje del reel y tiempo. Pura. */
export function momentosDe(stats: readonly EstadisticasReel[], palabrasDe: (sc: string) => ReadonlyArray<{t: string; d: number; h: number}>): MomentoSalida[] {
	const salida: MomentoSalida[] = [];
	const orden = [...stats].sort((a, b) => b.peso - a.peso || a.sc.localeCompare(b.sc));
	for (const s of orden) {
		const palabras = palabrasDe(s.sc);
		const dur = s.duracion_s ?? Infinity;
		for (const c of s.capas) {
			const dichas = palabras.filter((p) => p.d >= c.desde - 1.5 && p.d <= c.desde + 1.5).map((p) => p.t);
			salida.push({
				reel: s.sc,
				grupo: s.grupo,
				puntaje: s.puntaje,
				peso: red(s.peso, 4)!,
				t: red(c.desde, 3)!,
				hasta: red(c.hasta, 3)!,
				duracion_s: red(c.hasta - c.desde, 3)!,
				segmento: c.desde < GANCHO_S ? 'gancho' : c.desde >= dur - CIERRE_S ? 'cierre' : 'cuerpo',
				clase: c.clase,
				subtipo: c.subtipo,
				texto: c.texto,
				tipo_palabra: c.tipo_palabra,
				palabras_dichas: dichas.join(' '),
				desfase_cuadros: c.desfase_cuadros,
				con_sfx: c.sfx ? c.sfx.con_sfx : null,
				sfx_confiable: c.sfx ? c.sfx.confiable : null,
				desfase_sfx_cuadros: c.sfx?.desfase_30 ?? null,
				posicion: {x: red((c.caja.x0 + c.caja.x1) / 2, 1)!, y: red((c.caja.y0 + c.caja.y1) / 2, 1)!, w: red(c.caja.x1 - c.caja.x0, 1)!, h: red(c.caja.y1 - c.caja.y0, 1)!},
				lista: c.lista,
				tapa_cabeza: c.tapa_cabeza,
			});
		}
	}
	return salida;
}

// ───────────────────────────── Informe ─────────────────────────────

export type RevisionViral = {shortCode: string; rank: number; hoja: string | null; visto: string; discrepancias: string};
export type DatosInforme = {
	hojas: Array<{archivo: string; titulo: string; que_muestra: string}>;
	revision: RevisionViral[];
	/** Lo que se vio a ojo en la hoja de tipografía (estilo/informe/revision-virales.json → tipografia). */
	revisionTipografia: string | null;
	criterios: Array<{criterio: string; estado: 'PASA' | 'FALLA' | 'N/A'; evidencia: string}>;
	fallos: string[];
	/** Tiempo de medición (sin caché) sacado de referencias/reels/<sc>/aprender.json. */
	tiempos: {total_min: number; por_reel_p50_min: number; reels: number} | null;
};

const fmt = (m: unknown, unidad = '', d?: number): string => {
	const o = m as {valor?: unknown; n?: number} | undefined;
	if (!o || o.valor === undefined || o.valor === NA) return 'N/A';
	const v = o.valor;
	if (typeof v === 'number') return `${d === undefined ? v : v.toFixed(d)}${unidad}`;
	if (Array.isArray(v)) return `${v.join(' a ')}${unidad}`;
	if (typeof v === 'boolean') return v ? 'sí' : 'no';
	return `${String(v)}${unidad}`;
};
const nDe = (m: unknown): string => {
	const o = m as {valor?: unknown; n?: number} | undefined;
	return !o || o.valor === NA ? '—' : String(o.n ?? '—');
};
/** Texto seguro dentro de una celda de tabla Markdown (el "|" la partiría). */
const celda = (t: string): string => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fila = (que: string, m: unknown, unidad = '', d?: number, nota = ''): string => `| ${celda(que)} | ${celda(fmt(m, unidad, d))} | ${nDe(m)} | ${celda(nota)} |`;

/** El informe para el creador (español de tú, para leerse en 3 minutos). Puro. */
export function informeMarkdown(estilo: Record<string, unknown>, stats: readonly EstadisticasReel[], datos: DatosInforme): string {
	const E = estilo as Record<string, Record<string, unknown>>;
	const g = (ruta: string): unknown => ruta.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), estilo);
	const nTop = stats.filter((s) => s.grupo === 'top').length;
	const nRec = stats.filter((s) => s.grupo === 'recientes').length;
	const nResto = stats.filter((s) => s.grupo === 'resto').length;
	const nRecLayout = stats.filter((s) => s.reciente).length;
	const resumen = E.resumen as {medidas: number; na: number; supuestos: number; metricas: number};
	const cumple = datos.criterios.filter((c) => c.estado === 'PASA').length;
	const fallan = datos.criterios.filter((c) => c.estado === 'FALLA').length;
	const na = datos.criterios.filter((c) => c.estado === 'N/A').length;
	const L: string[] = [];
	L.push('# Tu estilo, medido en tus reels publicados');
	L.push('');
	const fallidos = datos.criterios.filter((c) => c.estado === 'FALLA').map((c) => c.criterio);
	L.push(`Versión ${String(estilo.version)} · ${String(estilo.generado_en).slice(0, 10)} · **pendiente de tu aprobación**. Cumple ${cumple} de ${cumple + fallan} checks (${na} N/A)${fallidos.length ? `; no cumple: ${fallidos.join('; ')}` : ''}.`);
	L.push('');
	L.push('## En 30 segundos');
	L.push('');
	L.push(`- Medí **${stats.length} reels tuyos**: los ${nTop} más virales, ${nRec} recientes y ${nResto} del resto (la muestra de 25 más los ${stats.filter((s) => !s.en_muestra).length} que ya se habían medido). Todo local y gratis${datos.tiempos ? `: ${datos.tiempos.total_min} min de cómputo (más o menos la mitad de reloj, 2 a la vez), ${datos.tiempos.por_reel_p50_min} min por reel (p50)` : ''}.`);
	L.push(`- Subtítulos y layout salen solo de tus **${nRecLayout} reels recientes** (jun–sep, 1440p). Las densidades (por minuto, SFX, ritmo) usan todos, pesando más los de mejor puntaje.`);
	L.push(`- ${resumen.medidas} números medidos, ${resumen.supuestos} supuestos (BRAG, zoom de demos, guía de Meta) y ${resumen.na} N/A. Cada uno trae su n y su fuente en \`estilo/estilo.json\`.`);
	L.push(`- Lo semántico (qué sticker, qué logo, qué tipo de SFX) queda N/A: necesita Gemini, que cuesta y necesita tu sí.`);
	if (datos.fallos.length) L.push(`- Ojo: ${datos.fallos.length} mediciones fallaron (ver "Lo que no sabemos").`);
	L.push('');
	L.push('## Lo que necesito que apruebes');
	L.push('');
	const letra = (capa: string): string => {
		const c = g(`tipografia.${capa}.candidata`) as {valor?: unknown; nombre?: string} | undefined;
		const p = g(`tipografia.${capa}.peso`) as {valor?: unknown} | undefined;
		if (!c || c.valor === NA || c.valor === undefined) return `${capa}: N/A`;
		const etiqueta = ({subtitulos: 'subtítulos', titular: 'titular', tarjetas: 'tarjetas'} as Record<string, string>)[capa] ?? capa;
		return `${etiqueta}: **${c.nombre ?? String(c.valor)} ${String(p?.valor ?? '')}** (parecido ${fmt(g(`tipografia.${capa}.parecido`))})`;
	};
	L.push(`1. **Fuente** (la más parecida a tus recortes; ninguna es idéntica): ${['subtitulos', 'titular', 'tarjetas'].map(letra).join(' · ')}. Ver la hoja de tipografía.${datos.revisionTipografia ? ` A ojo: ${datos.revisionTipografia}` : ''}`);
	L.push(`2. **Titular arriba de la cabeza:** está en ${fmt(g('titular.pct_reels_con_titular'), ' %')} de tus reels medidos. Es una excepción a "todo debajo de la cabeza": ¿la apruebas?`);
	const porClase = (g('tapa_cabeza.por_clase') as {valor?: Record<string, number>} | undefined)?.valor;
	L.push(`3. **Inserts que tapan la cara:** p50 ${fmt(g('tapa_cabeza.p50'))} y p90 ${fmt(g('tapa_cabeza.p90'))} por reel${porClase ? ` (en todos los reels medidos solo ${porClase.insert ?? 0} inserts en tarjeta te tapan; los stickers suben sobre tu barbilla ${porClase.sticker ?? 0} veces, pero tu boca casi nunca se tapa: ${fmt(g('cabeza.pct_capas_tapan_boca'), ' %')} de stickers y tarjetas)` : ''}. El director usa el p90 como tope de excepciones por reel: ¿lo dejamos así?`);
	const preg = g('resaltado.pregunta');
	L.push(`4. **Resaltado en bold:** ${fmt(g('resaltado.pct'), ' %')} de tus subtítulos recientes traen una palabra resaltada.${typeof preg === 'string' ? ` ${preg}` : ''}`);
	const aire = g('cabeza.margen_barbilla_px') as {valor?: unknown} | undefined;
	if (typeof aire?.valor === 'number' && aire.valor < 60) L.push(`5. **Aire bajo tu barbilla:** el plan pide que una capa empiece ≥ 60 px debajo de tu barbilla; en tus reels recientes el 10 % de tus stickers y tarjetas quedan a ${aire.valor} px o menos. ¿Mantengo los 60 px o me acerco a lo tuyo?`);
	L.push('');
	L.push('## Números clave');
	L.push('');
	L.push('| Qué | Valor | n (reels) | Nota |');
	L.push('|---|---|---|---|');
	L.push(fila('Subtítulos: Y del centro', g('subtitulos.franja.y_p50'), ' px', undefined, 'base 1920'));
	L.push(fila('Subtítulos: alto de mayúscula', g('subtitulos.alto_mayuscula_p50'), ' px'));
	L.push(fila('Subtítulos: ancho máx (p90)', g('subtitulos.ancho_p90'), ' px', undefined, 'base 1080'));
	L.push(fila('Subtítulos: borde', g('subtitulos.grosor_borde_p50'), ' px'));
	L.push(fila('Subtítulos: palabras (p50)', g('subtitulos.palabras_por_evento.p50')));
	L.push(fila('Subtítulos: duración mínima (p10)', g('subtitulos.duracion_evento.p10'), ' s'));
	L.push(fila('Subtítulos: adelanto sobre tu voz', g('subtitulos.adelanto_cuadros'), ' cuadros', undefined, 'positivo = antes de la palabra'));
	L.push(fila('Titular: Y de las mayúsculas', g('titular.y'), ' px'));
	L.push(fila('Titular: alto de mayúscula', g('titular.alto_mayuscula'), ' px'));
	L.push(fila('Titular: contorno visible', g('titular.contorno_grosor'), ' px'));
	L.push(fila('Tarjetas por minuto', g('tarjetas.por_minuto'), '', undefined, 'ponderado por puntaje'));
	L.push(fila('Tarjetas: duración p50', g('tarjetas.duracion_s.p50'), ' s'));
	L.push(fila('Tarjetas: centro Y', g('tarjetas.centro_y.p50'), ' px'));
	L.push(fila('Tarjetas: desfase con tu voz (p50)', g('tarjetas.desfase_habla_cuadros.p50'), ' cuadros', undefined, 'negativo = aparece antes'));
	L.push(fila('Tarjetas: % dicho tal cual', g('tarjetas.pct_literal'), ' %'));
	L.push(fila('Tarjetas: % en listas', g('tarjetas.pct_en_listas'), ' %'));
	L.push(fila('Stickers por minuto', g('stickers.por_minuto'), '', undefined, 'ponderado por puntaje'));
	L.push(fila('Stickers: ancho p50', g('stickers.ancho_px.p50'), ' px'));
	L.push(fila('Stickers: centro Y', g('stickers.centro_y'), ' px'));
	L.push(fila('Stickers: pop', g('stickers.pop.cuadros'), ' cuadros', undefined, `escala inicial ${fmt(g('stickers.pop.escala_inicial'))}`));
	L.push(fila('Inserts por minuto', g('inserts.por_minuto')));
	L.push(fila('Inserts a pantalla completa', g('inserts.pct_pantalla_completa'), ' %'));
	L.push(fila('Zooms de edición por minuto', g('zooms.por_minuto'), '', undefined, `confirmados por el fondo: ${fmt(g('zooms.confirmados'))} de ${fmt(g('zooms.candidatos'))} saltos`));
	L.push(fila('Desenfoques por minuto', g('efectos.desenfoque_por_minuto')));
	L.push(fila('Capas SIN sonido (prob.)', g('sfx.prob_silencio'), '', undefined, 'corregido por azar'));
	L.push(fila('SFX: arranque vs la capa', g('sfx.offset_medido_cuadros'), ' cuadros', undefined, `el selector usa ${fmt(g('sfx.offset_cuadros'), ' cuadros')} (regla del plan: −2 a 0)`));
	L.push(fila('SFX: nivel vs tu voz (LU)', g('sfx.nivel_lu'), ' LU', undefined, 'M máx. del SFX − LUFS de tu voz'));
	L.push(fila('SFX: nivel vs tu voz (RMS 100 ms)', g('sfx.nivel_rms_db'), ' dB'));
	L.push(fila('Ritmo: gancho 0–3 s', g('ritmo.gancho.capas_por_min'), ' capas/min'));
	L.push(fila('Ritmo: cuerpo', g('ritmo.cuerpo.capas_por_min'), ' capas/min'));
	L.push(fila('Ritmo: cierre (últimos 5 s)', g('ritmo.cierre.capas_por_min'), ' capas/min'));
	L.push(fila('Zona UI: arriba / abajo', g('zona_ui.arriba'), ' px', undefined, `abajo ${fmt(g('zona_ui.abajo'), ' px')}`));
	L.push(fila('Zona UI: izquierda / derecha', g('zona_ui.izquierda'), ' px', undefined, `derecha ${fmt(g('zona_ui.derecha'), ' px')}`));
	L.push(fila('Aire bajo tu barbilla (p10)', g('cabeza.margen_barbilla_px'), ' px', undefined, 'el plan supone 60 px'));
	L.push(fila('Aire sobre tu boca (p10)', g('cabeza.margen_boca_px'), ' px', undefined, `capas que tapan tu boca: ${fmt(g('cabeza.pct_capas_tapan_boca'), ' %')}`));
	L.push('');
	L.push('## Contra lo que el editor suponía');
	L.push('');
	L.push('| Qué | Supuesto | Medido en tus reels |');
	L.push('|---|---|---|');
	const sup = ESTILO_SFX_SUPUESTO;
	L.push(`| Nivel del SFX contra tu voz | ${sup.ganancia_db.valor.join(' a ')} LU (lib/sfx.ts) | ${fmt(g('sfx.ganancia_db'), ' LU')} (centro ${fmt(g('sfx.nivel_lu'), ' LU')}) |`);
	L.push(`| Arranque del SFX | ${sup.offset_cuadros.valor.join(' a ')} cuadros | ${fmt(g('sfx.offset_medido_cuadros'), ' cuadros')} (p50 ${String((g('sfx.offset_medido_cuadros') as {p50?: number})?.p50 ?? 'N/A')}) |`);
	L.push(`| Capas sin sonido | ${sup.prob_silencio.valor} (${sup.prob_silencio.p10}–${sup.prob_silencio.p90}) | ${fmt(g('sfx.prob_silencio'))} (${String((g('sfx.prob_silencio') as {p10?: number})?.p10 ?? 'N/A')}–${String((g('sfx.prob_silencio') as {p90?: number})?.p90 ?? 'N/A')}) |`);
	L.push(`| Capas por video | ${sup.eventos_por_video.valor.join(' a ')} | ${fmt(g('sfx.eventos_por_video'))} |`);
	L.push(`| Aire entre tu barbilla y una capa | 60 px (plan) | p10 ${fmt(g('cabeza.margen_barbilla_px'), ' px')} |`);
	L.push(`| Alto de mayúscula del titular | ${String(MEDICIONES_CAPAS.titular_alto_mayuscula.valor)} px (MEDICIONES_CAPAS) | ${fmt(g('titular.alto_mayuscula'), ' px')} |`);
	L.push('');
	if (datos.hojas.length) {
		L.push('## Ejemplos');
		L.push('');
		for (const h of datos.hojas) {
			L.push(`**${h.titulo}.** ${h.que_muestra}`);
			L.push('');
			L.push(`![${h.titulo}](${h.archivo})`);
			L.push('');
		}
	}
	L.push('## Tus 3 virales, cuadro por cuadro');
	L.push('');
	L.push('| Reel | Lo que se ve en sus cuadros | Contra lo medido |');
	L.push('|---|---|---|');
	if (datos.revision.length) for (const r of datos.revision) L.push(`| #${r.rank} ${r.shortCode} | ${celda(r.visto)} | ${celda(r.discrepancias)} |`);
	else L.push('| — | N/A: falta la revisión visual (estilo/informe/revision-virales.json) | — |');
	L.push('');
	L.push('## Top vs recientes vs resto (hipótesis, n chico)');
	L.push('');
	L.push('| Grupo | Reels | Tarjetas/min | Stickers/min | Inserts/min | Capas con SFX | Con titular |');
	L.push('|---|---|---|---|---|---|---|');
	for (const k of ['top', 'recientes', 'resto']) {
		const c = g(`comparacion_grupos.${k}`) as Record<string, unknown> | undefined;
		if (!c) continue;
		L.push(`| ${k} | ${String(c.reels)} | ${fmt(c.tarjetas_por_min)} | ${fmt(c.stickers_por_min)} | ${fmt(c.inserts_por_min)} | ${fmt(c.pct_capas_con_sfx, ' %')} | ${fmt(c.pct_con_titular, ' %')} |`);
	}
	L.push('');
	L.push('Que un grupo tenga más o menos de algo no prueba que eso dé más vistas: son pocos reels y de épocas distintas.');
	L.push('');
	L.push('## Lo que no sabemos');
	L.push('');
	const nas = listarNA(estilo).slice(0, 14);
	L.push('- **Semántica (Gemini): N/A.** Qué stickers, logos, música y qué tipo de SFX (pop, clic, whoosh) usas en cada momento. Cuesta ≈ US$1.3–1.9 por los 25 reels y necesita tu sí.');
	for (const x of nas) L.push(`- \`${x.ruta}\`: ${x.falta}`);
	const descartados = (g('subtitulos.reels_descartados') as Array<{reel: string; motivo: string}> | undefined) ?? [];
	for (const d of descartados) L.push(`- Subtítulos de ${d.reel} fuera del promedio: ${d.motivo}.`);
	L.push('- **Tipografía:** ninguna candidata es idéntica a tu letra (parecido de 0.6–0.7); la final la eliges tú.');
	L.push(`- **SFX:** ${AVISO_POPS.replace(/^cota: /, '')}.`);
	const chicos = listarNChico(estilo, 3).slice(0, 8);
	if (chicos.length) L.push(`- **n chico (≤ 3):** ${chicos.map((x) => `\`${x}\``).join(', ')}.`);
	for (const f of datos.fallos.slice(0, 8)) L.push(`- Falló: ${f}`);
	L.push('');
	L.push('## Checks de la Fase 2');
	L.push('');
	L.push('| Criterio | Estado | Evidencia |');
	L.push('|---|---|---|');
	for (const c of datos.criterios) L.push(`| ${celda(c.criterio)} | ${c.estado} | ${celda(c.evidencia)} |`);
	L.push('');
	L.push('## Cómo se midió');
	L.push('');
	L.push('- Subtítulos: Vision (`medir.ts`). Titular y tarjetas: Vision + whisper (`medir-capas.ts`). Stickers, inserts y desenfoques: diferencias de píxeles (`overlays.ts`). SFX: arranques de sonido (`onsets.ts`) a ±3 cuadros de cada capa, corregidos por azar. Cara y zooms: Vision a 30 fps (`cara.ts`).');
	L.push('- Nivel del SFX: sonoridad momentánea (400 ms) en el ataque menos la de tu voz justo antes (resta de potencias), contra el LUFS integrado de tu voz (bloques dentro de palabras, sin SFX).');
	L.push('- Caché por reel en `referencias/reels/<sc>/` (se reusa si no cambió el video ni el código). Para rehacer: `npx tsx herramientas/estilo/aprender.ts --muestra --rehacer`.');
	L.push('');
	return L.join('\n');
}

/** Rutas de las métricas N/A con su `falta` (para el informe). */
export function listarNA(json: unknown): Array<{ruta: string; falta: string}> {
	const salida: Array<{ruta: string; falta: string}> = [];
	const visitar = (x: unknown, ruta: string) => {
		if (typeof x !== 'object' || x === null || Array.isArray(x)) return;
		const o = x as Record<string, unknown>;
		if (Object.hasOwn(o, 'valor')) {
			if (o.valor === NA && typeof o.falta === 'string' && !ruta.startsWith('comparacion_grupos')) salida.push({ruta, falta: o.falta});
			return;
		}
		for (const [k, v] of Object.entries(o)) visitar(v, ruta ? `${ruta}.${k}` : k);
	};
	visitar(json, '');
	// Una sola vez cada motivo.
	const vistos = new Set<string>();
	return salida.filter((x) => (vistos.has(x.falta) ? false : (vistos.add(x.falta), true)));
}

/** Métricas medidas con n ≤ máx (sin supuestos). */
export function listarNChico(json: unknown, max: number): string[] {
	const salida: string[] = [];
	const visitar = (x: unknown, ruta: string) => {
		if (typeof x !== 'object' || x === null || Array.isArray(x)) return;
		const o = x as Record<string, unknown>;
		if (Object.hasOwn(o, 'valor')) {
			if (o.valor !== NA && typeof o.n === 'number' && o.n > 0 && o.n <= max && !String(o.fuente).startsWith('supuesto') && !ruta.startsWith('comparacion_grupos')) salida.push(ruta);
			return;
		}
		for (const [k, v] of Object.entries(o)) visitar(v, ruta ? `${ruta}.${k}` : k);
	};
	visitar(json, '');
	return salida;
}

// ───────────────────────────── Escribir ─────────────────────────────

function escribirAtomico(ruta: string, texto: string): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const tmp = `${ruta}.tmp-${process.pid}`;
	writeFileSync(tmp, texto);
	renameSync(tmp, ruta);
}

export type ResultadoAgregar = {estilo: Record<string, unknown>; stats: EstadisticasReel[]; momentos: MomentoSalida[]; rutas: string[]; conteo: ReturnType<typeof revisarMetricas>['conteo']};

/** Carga, agrega y escribe estilo.json y momentos.jsonl (y el informe si se pide). */
export function agregarYEscribir(op: {informe?: (estilo: Record<string, unknown>, stats: EstadisticasReel[]) => string; reels?: string[]} = {}): ResultadoAgregar {
	const {reels, corpus, muestra} = leerConjunto({reels: op.reels});
	const c = corpus as unknown as Extra['corpus'];
	const datos = cargarDatos(reels, c.ranking.mediana_puntaje);
	const medidos = datos.filter((d) => d.subtitulos || d.capas || d.overlays);
	if (medidos.length === 0) throw fallo('agregar tu estilo', 'no hay ningún reel medido en referencias/reels/', 'corre primero npx tsx herramientas/estilo/aprender.ts --muestra', 2);
	const stats = medidos.map(estadisticasDeReel);
	const leer = <T>(ruta: string): T | null => (existsSync(ruta) ? (JSON.parse(readFileSync(ruta, 'utf8')) as T) : null);
	const extra: Extra = {
		corpus: c,
		muestra: muestra as unknown as Extra['muestra'],
		encuadre: leer<Record<string, unknown>>(RUTA_ENCUADRE),
		calibracionCortes: leer<Record<string, unknown>>(RUTA_CAL_CORTES),
		tipografia: leer<Tipografia>(RUTA_TIPOGRAFIA),
		mp4Existe: (r) => existsSync(r),
		dueno: ((): Extra['dueno'] => {
			const yo = leerCreador();
			return yo.handle ? {username: yo.handle.toLowerCase(), id: yo.corpus.instagram_id} : null;
		})(),
		fecha: new Date().toISOString(),
	};
	const estilo = construirEstilo(stats, extra);
	const porSc = new Map(medidos.map((d) => [d.reel.shortCode, d]));
	const momentos = momentosDe(stats, (sc) => porSc.get(sc)?.transcripcion?.palabras ?? []);
	escribirAtomico(RUTA_ESTILO_JSON, `${JSON.stringify(estilo, null, '\t')}\n`);
	escribirAtomico(RUTA_MOMENTOS_JSONL, momentos.map((m) => JSON.stringify(m)).join('\n') + '\n');
	const rutas = [RUTA_ESTILO_JSON, RUTA_MOMENTOS_JSONL];
	if (op.informe) {
		escribirAtomico(RUTA_INFORME, op.informe(estilo, stats));
		rutas.push(RUTA_INFORME);
	}
	return {estilo, stats, momentos, rutas, conteo: revisarMetricas(estilo).conteo};
}

/** Datos del informe que no salen de estilo.json: hojas, revisión de virales, criterios y fallos. */
export function datosInforme(estilo: Record<string, unknown>, stats: readonly EstadisticasReel[], reels: readonly ReelConjunto[]): DatosInforme {
	const leer = <T>(ruta: string): T | null => {
		try {
			return existsSync(ruta) ? (JSON.parse(readFileSync(ruta, 'utf8')) as T) : null;
		} catch {
			return null;
		}
	};
	const hojas = leer<{hojas: DatosInforme['hojas']}>(join(DIR_INFORME, 'hojas.json'))?.hojas ?? [];
	const revisionJson = leer<{virales?: RevisionViral[]; tipografia?: string}>(RUTA_REVISION);
	const revision = revisionJson?.virales ?? [];
	const ultima = leer<{reels: Array<{shortCode: string; fallos: string[]; segundos: number}>}>(join(DIR_TRABAJO, 'ultima-corrida.json'));
	const fallos: string[] = [];
	const porReel: number[] = [];
	for (const r of reels) {
		const m = leer<ManifestReel>(join(dirReel(r.shortCode), 'aprender.json'));
		const malas = Object.entries(m?.etapas ?? {}).filter(([, e]) => e?.estado !== 'ok');
		if (malas.length) fallos.push(`${r.shortCode}: ${malas.map(([k, e]) => `${k} (${e?.error ?? 'falló'})`).join(' · ')}`);
		const seg = Object.values(m?.etapas ?? {}).filter((e) => e && !e.adoptado && typeof e.segundos === 'number').reduce((a, e) => a + (e!.segundos ?? 0), 0);
		if (seg > 0) porReel.push(seg / 60);
	}
	if (!fallos.length) for (const r of ultima?.reels ?? []) if (r.fallos.length) fallos.push(`${r.shortCode}: ${r.fallos.join(' · ')}`);
	const tiempos = porReel.length ? {total_min: red(porReel.reduce((a, b) => a + b, 0), 1)!, por_reel_p50_min: red(mediana(porReel), 1)!, reels: porReel.length} : null;
	const g = (ruta: string): Record<string, unknown> | undefined => ruta.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), estilo) as Record<string, unknown> | undefined;
	const v = (ruta: string) => g(ruta)?.valor;
	const {problemas, conteo} = revisarMetricas(estilo);
	const top10 = (g('corpus.top10_con_mp4')?.top10 ?? []) as Array<{shortCode: string; mp4_local: boolean; falta: string | null}>;
	const faltan = top10.filter((t) => !t.mp4_local);
	const onsetsRes = leer<{pasa?: boolean; criterio_mono?: {precision: number; exhaustividad: number}}>(join(RAIZ, 'out', 'f2-onsets', 'resultado.json'));
	const overlaysRes = leer<{pasa?: boolean; criterio?: string; detectados?: number; total?: number}>(join(RAIZ, 'out', 'f2-overlays', 'resultado.json'));
	const criterios: DatosInforme['criterios'] = [
		{criterio: 'Corpus: 449 shortCodes tuyos', estado: v('corpus.reels') === 449 ? 'PASA' : 'FALLA', evidencia: `${String(v('corpus.reels'))} en estilo/corpus.json (${String(g('corpus.reels')?.repetidos ?? 0)} repetidos)`},
		{criterio: 'Corpus: 0 de otra cuenta y 0 comp_*', estado: v('corpus.de_otra_cuenta') === 0 && v('corpus.comp') === 0 ? 'PASA' : 'FALLA', evidencia: `${String(v('corpus.de_otra_cuenta'))} de otra cuenta, ${String(v('corpus.comp'))} comp_*`},
		{criterio: 'Top 10 con sus mp4 en local', estado: faltan.length === 0 ? 'PASA' : 'FALLA', evidencia: faltan.length ? `faltan: ${faltan.map((t) => `${t.shortCode} (${t.falta})`).join(', ')}` : '10 de 10 mp4 locales (2 bajados con yt-dlp sin cookies)'},
		{criterio: 'Cada métrica con {valor|N/A, n, fuente, falta}', estado: problemas.length === 0 ? 'PASA' : 'FALLA', evidencia: problemas.length ? `${problemas.length} problemas, p. ej. ${problemas[0].ruta}: ${problemas[0].problema}` : `${conteo.total} métricas revisadas (${conteo.na} N/A, que no cuentan)`},
		{criterio: 'Gemini: 0 respuestas inválidas y costo ±20 %', estado: 'N/A', evidencia: 'no se corrió: cuesta y necesita tu sí'},
		{criterio: 'onsets.ts: precisión y exhaustividad ≥ 0.8 (otra pieza)', estado: onsetsRes ? (onsetsRes.pasa ? 'PASA' : 'FALLA') : 'N/A', evidencia: onsetsRes?.criterio_mono ? `precisión ${onsetsRes.criterio_mono.precision}, exhaustividad ${onsetsRes.criterio_mono.exhaustividad} (out/f2-onsets/resultado.json)` : 'sin resultado de f2-onsets'},
		{criterio: 'overlays.ts: ≥ 90 % de stickers con IoU ≥ 0.7 (otra pieza)', estado: overlaysRes ? (overlaysRes.pasa === false ? 'FALLA' : overlaysRes.pasa === true ? 'PASA' : 'N/A') : 'N/A', evidencia: overlaysRes ? `${overlaysRes.detectados ?? '?'} de ${overlaysRes.total ?? '?'} stickers conocidos (${overlaysRes.criterio ?? ''}; out/f2-overlays/resultado.json)` : 'sin resultado de f2-overlays'},
		{criterio: '/watch: una fila por cada uno de los 3 virales', estado: revision.length >= 3 ? 'PASA' : 'FALLA', evidencia: `${revision.length} filas (revisión de cuadros con Read, sin whisper)`},
		{criterio: 'Resaltado: fixture con el peso, la escala y el color de estilo.json', estado: 'N/A', evidencia: `0 % de resaltado medido: queda apagado hasta tu respuesta (resaltado.pregunta)`},
		{criterio: 'Aprobación del estilo, la fuente y las excepciones', estado: 'N/A', evidencia: 'pendiente: la das tú leyendo este informe'},
	];
	void stats;
	void reels;
	return {hojas, revision, revisionTipografia: typeof revisionJson?.tipografia === 'string' ? revisionJson.tipografia : null, criterios, fallos, tiempos};
}

// ───────────────────────────── CLI ─────────────────────────────

async function main(): Promise<void> {
	const {values} = parseArgs({options: {'sin-informe': {type: 'boolean', default: false}}});
	const {reels} = leerConjunto();
	const r = agregarYEscribir({informe: values['sin-informe'] ? undefined : (estilo, stats) => informeMarkdown(estilo, stats, datosInforme(estilo, stats, reels))});
	console.log(`Estilo: ${r.stats.length} reels, ${r.conteo.medidas} métricas medidas, ${r.conteo.supuestos} supuestos y ${r.conteo.na} N/A. Momentos: ${r.momentos.length}.`);
	console.log(`Escribí: ${r.rutas.map((x) => relative(RAIZ, x)).join(', ')}`);
}

if (esPrincipal(import.meta.url)) void correr(main);
