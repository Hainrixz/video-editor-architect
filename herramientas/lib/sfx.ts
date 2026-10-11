/**
 * SFX del editor: lo que comparten el catálogo (herramientas/sfx/catalogar.ts), la síntesis
 * (herramientas/sfx/sintesis.ts) y el selector (herramientas/sfx/elegir.ts).
 *
 * - Esquemas del catálogo (biblioteca/sfx/catalogo.json), del historial entre videos
 *   (estilo/historial-sfx.json) y de las aprobaciones (biblioteca/sfx/aprobaciones.json).
 * - Conteo de fuentes por categoría con las reglas del plan: ≥ 5 fuentes distintas, la síntesis cuenta
 *   como máx. 2, las variantes de tono no cuentan y lo pendiente de aprobar tampoco. Sin salida de escape:
 *   una categoría que no llega no entra al mapeo de eventos.
 * - Audio: decodificar con ffmpeg, recortar el silencio inicial (el ataque queda en la muestra 0), medir
 *   pico real y sonoridad con ebur128, huella espectro-temporal para detectar archivos casi iguales,
 *   escribir WAV de 48 kHz.
 * - Semilla: generador pseudoaleatorio determinista (mismo texto de semilla → mismos números).
 * - Estilo del selector: sale de estilo/estilo.json → `sfx` cuando exista; si no, va como supuesto (n = 0).
 *
 * Todo corre dentro del sandbox: ffmpeg sí, nada de Chrome, GPU ni Vision.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {z} from 'zod';
import {fallo} from './fallo.ts';
import {fuentesSfxDe, leerCreador} from './creador.ts';
import {RAIZ} from './manifest.ts';

// ───────────────────────────── Constantes ─────────────────────────────

export const TASA_SFX = 48000;
export const CANALES_SFX = 2;
export const FPS_SFX = 30;
/** Pico real al que se normaliza cada archivo de la biblioteca. */
export const PICO_OBJETIVO_DBTP = -1;

export const RUTA_CATALOGO = join(RAIZ, 'biblioteca', 'sfx', 'catalogo.json');
export const RUTA_APROBACIONES = join(RAIZ, 'biblioteca', 'sfx', 'aprobaciones.json');
export const RUTA_HISTORIAL = join(RAIZ, 'estilo', 'historial-sfx.json');
/**
 * Fuentes que el selector puede usar: creador.json → sfx.solo_fuentes (p. ej. solo los Foleys propios del creador).
 * null = todas (lista vacía o sin creador.json). `raiz` es para pruebas.
 */
export function leerFuentesPermitidas(opciones: {raiz?: string} = {}): string[] | null {
	return fuentesSfxDe(leerCreador(opciones));
}
export const RUTA_ESTILO = join(RAIZ, 'estilo', 'estilo.json');

/** Reglas duras del plan (Fase 3, "SFX: variados y a veces en silencio"). */
export const REGLAS_SFX = {
	/** Ningún archivo (ni sus variantes ni un casi igual) se repite en los últimos 5 eventos CON sonido. */
	ventana_sin_repetir: 5,
	/** Ninguna categoría va más de 2 veces seguidas (los eventos en silencio no cuentan). */
	max_racha_categoria: 2,
	/** Fuentes distintas que necesita una categoría para entrar al mapeo de eventos. */
	min_fuentes: 5,
	/** La síntesis propia cuenta como máximo 2 de esas 5. */
	max_sintesis_que_cuentan: 2,
	/**
	 * Similitud (0–1) a partir de la cual dos originales se tratan como la MISMA fuente (otra toma casi
	 * idéntica, el mismo sonido con otro volumen o EQ). Calibrada en el catálogo real: ver catalogar.ts.
	 */
	umbral_casi_igual: 0.95,
	/** El ataque empieza en la primera muestra a −40 dB del pico… */
	umbral_inicio_db: -40,
	/** …y esa muestra debe caer en los primeros 2 ms del archivo. */
	max_inicio_ms: 2,
} as const;

export const TIPOS_EVENTO = ['sticker', 'tarjeta', 'insert', 'zoom', 'titular'] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/** Qué es cada categoría (para el informe y para quien dirige). */
export const CATEGORIAS_SFX: Record<string, string> = {
	pop: 'pop corto (aparece un sticker)',
	burbuja: 'burbuja con el tono que sube',
	pluck: 'cuerda pulsada corta',
	brillo: 'tintineo, campanita o destello brillante',
	blip: 'blip tonal de interfaz (uno o dos tonos)',
	clic: 'clic de botón o mouse',
	toque: 'golpecito suave (madera, ficha, golpe sordo corto)',
	whoosh: 'whoosh o swoosh de aire o de interfaz',
	impacto: 'golpe grave de énfasis',
	tecla: 'tecla o tecleo',
	glitch: 'glitch digital',
	especial: 'efectos largos o de gag que se ponen a mano en sfx_extra (error, notificación, vibración); el tecleo largo lo pone el director solo en las tarjetas prompt (lib/director/tecleo.ts)',
};

/**
 * Mapeo de eventos SUPUESTO (hasta que la Fase 2 lo aprenda de tus reels), en orden de preferencia.
 * El catálogo deja en `eventos` solo las categorías que cumplen ≥ 5 fuentes.
 */
export const MAPEO_SUPUESTO: Record<TipoEvento, string[]> = {
	sticker: ['pop', 'burbuja', 'pluck', 'clic', 'brillo', 'blip'],
	tarjeta: ['clic', 'toque', 'blip', 'brillo', 'tecla'],
	insert: ['whoosh'],
	zoom: ['whoosh', 'impacto'],
	titular: [],
};

/** Respaldo cuando la no-repetición deja a un tipo sin opción ("la no-repetición manda sobre el tipo"). */
export const TIPOS_COMPATIBLES: Record<TipoEvento, TipoEvento[]> = {
	sticker: ['tarjeta'],
	tarjeta: ['sticker'],
	insert: ['zoom'],
	zoom: ['insert'],
	titular: [],
};

// ───────────────────────────── Esquemas ─────────────────────────────

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** pixabay, kenney, sintesis o el id de los SFX propios del creador (biblioteca/sfx/seleccion.json → fuente). */
export const FuenteSfxEsquema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type FuenteSfx = z.infer<typeof FuenteSfxEsquema>;

export const AprobacionEsquema = z.enum(['no-requiere', 'pendiente', 'aprobada', 'rechazada']);
export type Aprobacion = z.infer<typeof AprobacionEsquema>;

export const ArchivoSfxEsquema = z.object({
	id: Id,
	/** Ruta relativa a public/ (public/biblioteca → ../biblioteca): es lo que va en `sfx.asset` de la EDL. */
	archivo: z.string().regex(/^biblioteca\/sfx\/[a-z0-9-]+\/[a-z0-9-]+\.wav$/),
	categoria: Id,
	fuente: FuenteSfxEsquema,
	/** Para contar fuentes distintas: el original, sus variantes de tono y sus casi iguales comparten fuente_id. */
	fuente_id: z.string().min(1),
	licencia: z.string().min(1),
	url: z.string().nullable(),
	duracion_s: z.number().positive(),
	/** Pico real (ebur128, sobremuestreo ×4) del WAV final. */
	pico_dbtp: z.number(),
	/** Sonoridad momentánea máxima (ventana de 400 ms, ebur128) del WAV final, en LUFS. */
	lufs: z.number(),
	/** Del inicio del archivo a la primera muestra a −6 dB del pico (mitad de amplitud), en ms. */
	ataque_ms: z.number().nonnegative(),
	variante_de: Id.nullable(),
	semitonos: z.number().int().min(-1).max(1),
	/** sha256 de los bytes del WAV final. */
	sha256: Sha256,
	// Trazabilidad
	/** Ruta del original, "zip#ruta" o "receta:<id>". */
	origen: z.string().min(1),
	/** sha256 de los bytes del original (null en la síntesis). */
	sha256_origen: Sha256.nullable(),
	/** sha256 del audio decodificado del original (así se detectan los pares idénticos). */
	sha256_audio_origen: Sha256.nullable(),
	/** Familia de origen (p. ej. "kenney/interface-sounds/drop"), solo informativa. */
	familia: z.string().min(1),
	aprobacion: AprobacionEsquema,
	/** Primera muestra a −40 dB del pico, en ms desde el inicio del archivo (debe ser ≤ 2). */
	inicio_ms: z.number().nonnegative(),
	/** Recorte manual del original antes de normalizar (segundos del original), o null. */
	recorte: z.object({desde_s: z.number().nonnegative(), hasta_s: z.number().positive().nullable()}).nullable(),
	rasgos: z.object({centroide_hz: z.number().nonnegative(), planitud: z.number().nonnegative()}),
	nota: z.string().nullable(),
});
export type ArchivoSfx = z.infer<typeof ArchivoSfxEsquema>;

export const ConteoCategoriaEsquema = z.object({
	descripcion: z.string(),
	/** Fuentes reales distintas (Pixabay + Kenney), sin variantes ni pendientes. */
	reales: z.number().int().nonnegative(),
	/** Recetas de síntesis distintas. */
	sintesis: z.number().int().nonnegative(),
	/** reales + min(síntesis, 2). */
	cuentan: z.number().int().nonnegative(),
	/** Familias de origen distintas entre las reales (informativo: varias tomas de un mismo paquete). */
	familias: z.number().int().nonnegative(),
	cumple: z.boolean(),
	/** Archivos usables por el selector (originales + variantes, aprobados o sin aprobación requerida). */
	archivos: z.number().int().nonnegative(),
	pendientes: z.number().int().nonnegative(),
	en_eventos: z.array(z.enum(TIPOS_EVENTO)),
	nota: z.string().nullable(),
});
export type ConteoCategoria = z.infer<typeof ConteoCategoriaEsquema>;

export const PendienteEsquema = z.object({
	que: z.string(),
	categoria: z.string(),
	hoja: z.string(),
	candidatos: z.array(z.object({n: z.number().int().positive(), id: Id, t_s: z.number().nonnegative()})),
	como_aprobar: z.string(),
});

export const EventosCatalogoEsquema = z.object({
	sticker: z.array(Id),
	tarjeta: z.array(Id),
	insert: z.array(Id),
	zoom: z.array(Id),
	titular: z.array(Id),
});

export const CatalogoEsquema = z.object({
	version: z.literal(1),
	generado_en: z.string(),
	generado_por: z.string(),
	normalizacion: z.record(z.string(), z.unknown()),
	reglas: z.record(z.string(), z.unknown()),
	eventos: EventosCatalogoEsquema,
	categorias: z.record(z.string(), ConteoCategoriaEsquema),
	inventario: z.record(z.string(), z.unknown()),
	pendientes: z.array(PendienteEsquema),
	casi_iguales: z.array(z.object({a: Id, b: Id, similitud: z.number()})),
	descartados: z.array(z.object({origen: z.string(), motivo: z.string()})),
	archivos: z.array(ArchivoSfxEsquema),
});
export type Catalogo = z.infer<typeof CatalogoEsquema>;

export const AprobacionesEsquema = z.object({
	version: z.literal(1),
	pop: z.object({
		estado: z.enum(['pendiente', 'respondida']),
		/** ids aprobados como "pop" por el creador al escuchar la hoja. */
		aprobados: z.array(Id),
		rechazados: z.array(Id),
		fecha: z.string().nullable(),
		nota: z.string().nullable(),
	}),
});
export type Aprobaciones = z.infer<typeof AprobacionesEsquema>;

export const APROBACIONES_INICIALES: Aprobaciones = {
	version: 1,
	pop: {estado: 'pendiente', aprobados: [], rechazados: [], fecha: null, nota: null},
};

export const UsoHistorialEsquema = z.object({
	t: z.number(),
	tipo: z.enum(TIPOS_EVENTO),
	categoria: z.string(),
	fuente_id: z.string(),
	archivo_id: z.string(),
});
export const HistorialSfxEsquema = z.object({
	version: z.literal(1),
	nota: z.string().optional(),
	videos: z.array(
		z.object({
			slug: z.string().min(1),
			fecha: z.string(),
			semilla: z.string(),
			/** Solo los eventos CON sonido, en orden de tiempo. */
			usados: z.array(UsoHistorialEsquema),
		}),
	),
});
export type HistorialSfx = z.infer<typeof HistorialSfxEsquema>;
export const HISTORIAL_VACIO: HistorialSfx = {
	version: 1,
	nota: 'Lo escribe herramientas/sfx/elegir.ts --guardar-historial: qué SFX sonaron en cada video, para no repetir entre videos.',
	videos: [],
};

// ───────────────────────────── Conteo de fuentes ─────────────────────────────

/** ¿El archivo lo puede usar el selector? (lo pendiente o rechazado no). */
export const usable = (a: Pick<ArchivoSfx, 'aprobacion'>): boolean => a.aprobacion === 'no-requiere' || a.aprobacion === 'aprobada';

/** Cuenta fuentes distintas de una categoría con las reglas del plan. Pura. */
export function contarFuentes(archivos: ArchivoSfx[], categoria: string): Omit<ConteoCategoria, 'descripcion' | 'en_eventos' | 'nota'> {
	const deLaCategoria = archivos.filter((a) => a.categoria === categoria);
	const originalesUsables = deLaCategoria.filter((a) => a.variante_de === null && usable(a));
	const reales = new Set(originalesUsables.filter((a) => a.fuente !== 'sintesis').map((a) => a.fuente_id));
	const sintesis = new Set(originalesUsables.filter((a) => a.fuente === 'sintesis').map((a) => a.fuente_id));
	const familias = new Set(originalesUsables.filter((a) => a.fuente !== 'sintesis').map((a) => a.familia));
	const cuentan = reales.size + Math.min(sintesis.size, REGLAS_SFX.max_sintesis_que_cuentan);
	return {
		reales: reales.size,
		sintesis: sintesis.size,
		cuentan,
		familias: familias.size,
		cumple: cuentan >= REGLAS_SFX.min_fuentes,
		archivos: deLaCategoria.filter(usable).length,
		pendientes: deLaCategoria.filter((a) => a.variante_de === null && a.aprobacion === 'pendiente').length,
	};
}

/**
 * Mapeo de eventos: deja, por tipo y en orden de preferencia, solo las categorías que cumplen.
 * Sin salida de escape: si un tipo se queda sin categorías, se queda vacío (y el selector lo deja en silencio).
 */
export function mapearEventos(archivos: ArchivoSfx[], preferido: Record<TipoEvento, string[]> = MAPEO_SUPUESTO): Catalogo['eventos'] {
	const salida = {sticker: [], tarjeta: [], insert: [], zoom: [], titular: []} as Catalogo['eventos'];
	for (const tipo of TIPOS_EVENTO) {
		salida[tipo] = preferido[tipo].filter((c) => contarFuentes(archivos, c).cumple);
	}
	return salida;
}

/**
 * Revisa que el catálogo se pueda usar: esquema, archivos únicos, y que TODA categoría del mapeo cumpla
 * ≥ 5 fuentes recontadas aquí (no se confía en el número guardado). Devuelve la lista de problemas.
 */
export function problemasDelCatalogo(cat: Catalogo): string[] {
	const problemas: string[] = [];
	const ids = new Set<string>();
	for (const a of cat.archivos) {
		if (ids.has(a.id)) problemas.push(`id repetido: ${a.id}`);
		ids.add(a.id);
		if (a.variante_de !== null && a.semitonos === 0) problemas.push(`${a.id} es variante pero tiene 0 semitonos`);
		if (a.variante_de === null && a.semitonos !== 0) problemas.push(`${a.id} es original pero tiene ${a.semitonos} semitonos`);
	}
	for (const a of cat.archivos) {
		if (a.variante_de !== null && !ids.has(a.variante_de)) problemas.push(`${a.id} es variante de ${a.variante_de}, que no está en el catálogo`);
	}
	for (const tipo of TIPOS_EVENTO) {
		for (const c of cat.eventos[tipo]) {
			const conteo = contarFuentes(cat.archivos, c);
			if (!conteo.cumple) {
				problemas.push(`la categoría "${c}" está en el mapeo de ${tipo} con ${conteo.cuentan} fuentes que cuentan (mínimo ${REGLAS_SFX.min_fuentes})`);
			}
		}
	}
	return problemas;
}

/** Lee y valida el catálogo (código 2 si falta o no cuadra). */
export function leerCatalogo(ruta = RUTA_CATALOGO): Catalogo {
	if (!existsSync(ruta)) {
		throw fallo('leer el catálogo de SFX', `no existe ${ruta}`, 'genera la biblioteca con npx tsx herramientas/sfx/catalogar.ts', 2);
	}
	let crudo: unknown;
	try {
		crudo = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo('leer el catálogo de SFX', 'el JSON no se puede leer', 'vuelve a generarlo con npx tsx herramientas/sfx/catalogar.ts', 2, error);
	}
	const r = CatalogoEsquema.safeParse(crudo);
	if (!r.success) {
		throw fallo('leer el catálogo de SFX', `no cumple el esquema (${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message})`, 'vuelve a generarlo con npx tsx herramientas/sfx/catalogar.ts', 2, r.error.issues);
	}
	const problemas = problemasDelCatalogo(r.data);
	if (problemas.length > 0) {
		throw fallo('usar el catálogo de SFX', problemas[0], 'vuelve a generarlo con npx tsx herramientas/sfx/catalogar.ts (no se usa una categoría con menos de 5 fuentes)', 2, problemas);
	}
	return r.data;
}

/** Escribe JSON con tabs, de forma atómica (archivo temporal + rename). */
export function escribirJson(ruta: string, datos: unknown): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const tmp = `${ruta}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(datos, null, '\t')}\n`);
	renameSync(tmp, ruta);
}

// ───────────────────────────── Semilla ─────────────────────────────

/** Hash de 32 bits (FNV-1a) de un texto: convierte cualquier semilla en un entero. */
export function hash32(texto: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < texto.length; i++) {
		h ^= texto.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Generador determinista (mulberry32): misma semilla → misma secuencia en [0, 1). */
export function crearAleatorio(semilla: number | string): () => number {
	let a = typeof semilla === 'number' ? semilla >>> 0 : hash32(semilla);
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Entero uniforme en [a, b] (ambos incluidos). */
export const enteroEntre = (rnd: () => number, a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

/** Elige con pesos (todos ≥ 0; si todos son 0, uniforme). */
export function elegirConPeso<T>(rnd: () => number, opciones: T[], peso: (x: T) => number): T {
	if (opciones.length === 0) throw new Error('elegirConPeso: no hay opciones');
	const pesos = opciones.map((o) => Math.max(0, peso(o)));
	const total = pesos.reduce((s, p) => s + p, 0);
	if (!(total > 0)) return opciones[Math.floor(rnd() * opciones.length)];
	let r = rnd() * total;
	for (let i = 0; i < opciones.length; i++) {
		r -= pesos[i];
		if (r < 0) return opciones[i];
	}
	return opciones[opciones.length - 1];
}

// ───────────────────────────── Estilo del selector ─────────────────────────────

export type Metrica<T> = {valor: T; n: number; fuente: string; falta: string | null};

export type EstiloSfx = {
	/** Probabilidad de que un evento quede en silencio; p10–p90 = rango permitido por video. */
	prob_silencio: Metrica<number> & {p10: number; p90: number};
	/** Cuadros (30 fps) que el SFX arranca respecto al evento: [mín, máx], p. ej. [−2, 0]. */
	offset_cuadros: Metrica<[number, number]>;
	/** Nivel del SFX respecto a tu voz (dB, negativo = bajo la voz): rango [mín, máx] y variación ± por evento. */
	ganancia_db: Metrica<[number, number]> & {variacion_db: number};
	/** Eventos por video que usa la simulación: [mín, máx]. */
	eventos_por_video: Metrica<[number, number]>;
};

const FALTA_ESTILO = 'falta estilo/estilo.json → sfx (Fase 2)';

export const ESTILO_SFX_SUPUESTO: EstiloSfx = {
	prob_silencio: {valor: 0.2, p10: 0.1, p90: 0.3, n: 0, fuente: 'supuesto', falta: `${FALTA_ESTILO}: % de eventos sin SFX en tus reels (onsets)`},
	offset_cuadros: {valor: [-2, 0], n: 0, fuente: 'supuesto', falta: `${FALTA_ESTILO}: arranque del SFX contra el primer cuadro visible`},
	ganancia_db: {valor: [-14, -8], variacion_db: 2, n: 0, fuente: 'supuesto', falta: `${FALTA_ESTILO}: nivel del SFX contra tu voz`},
	eventos_por_video: {valor: [12, 30], n: 0, fuente: 'supuesto', falta: `${FALTA_ESTILO}: stickers + tarjetas + inserts + zooms por video`},
};

const numeroFinito = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const parFinito = (x: unknown): x is [number, number] => Array.isArray(x) && x.length === 2 && numeroFinito(x[0]) && numeroFinito(x[1]) && x[0] <= x[1];
const textoFuente = (m: Record<string, unknown>): string => (typeof m.fuente === 'string' && m.fuente ? m.fuente : 'estilo.json');
const enteroN = (m: Record<string, unknown>): number => (numeroFinito(m.n) && m.n >= 0 ? Math.round(m.n) : 0);

/**
 * Toma los parámetros del selector desde el objeto de estilo/estilo.json (clave `sfx`). Cada métrica se
 * acepta con la forma {valor, n, fuente, falta} del plan; lo que falte o venga "N/A" queda como supuesto y
 * se anota. Forma esperada:
 *   sfx: { prob_silencio: {valor, p10, p90, n, fuente}, offset_cuadros: {valor: [a, b], n, fuente},
 *          ganancia_db: {valor: [a, b], variacion_db, n, fuente}, eventos_por_video: {valor: [a, b], n, fuente} }
 */
export function estiloSfxDesde(estilo: unknown): {estilo: EstiloSfx; notas: string[]} {
	const notas: string[] = [];
	const salida: EstiloSfx = JSON.parse(JSON.stringify(ESTILO_SFX_SUPUESTO));
	const sfx = estilo && typeof estilo === 'object' ? (estilo as Record<string, unknown>).sfx : undefined;
	if (!sfx || typeof sfx !== 'object') {
		notas.push('estilo.json no trae `sfx`: uso los supuestos (n = 0)');
		return {estilo: salida, notas};
	}
	const s = sfx as Record<string, Record<string, unknown> | undefined>;

	const ps = s.prob_silencio;
	if (ps && numeroFinito(ps.valor) && ps.valor >= 0 && ps.valor < 1) {
		// p10–p90 de estilo.json describe cuánto varía ENTRE tus reels (0.25–0.92). Un video se sortea cerca de tu
		// mediana (± 0.1, sin salir de p10–p90): con el rango completo, un reel podía salir con 70 % de capas mudas.
		const p10 = Math.max(numeroFinito(ps.p10) ? ps.p10 : 0, ps.valor - 0.1, 0);
		const p90 = Math.min(numeroFinito(ps.p90) ? ps.p90 : 0.95, ps.valor + 0.1, 0.95);
		if (p10 <= ps.valor && ps.valor <= p90) {
			salida.prob_silencio = {valor: ps.valor, p10, p90, n: enteroN(ps), fuente: textoFuente(ps), falta: null};
			if (!numeroFinito(ps.p10) || !numeroFinito(ps.p90)) notas.push('prob_silencio sin p10/p90 medidos: uso valor ± 0.1');
		} else {
			notas.push(`prob_silencio incoherente (p10 ${p10}, valor ${ps.valor}, p90 ${p90}): uso el supuesto`);
		}
	} else {
		notas.push('prob_silencio sin valor medido (N/A): uso el supuesto 0.2 [0.1, 0.3]; pregúntale al creador una vez');
	}

	const oc = s.offset_cuadros;
	if (oc && parFinito(oc.valor) && Number.isInteger(oc.valor[0]) && Number.isInteger(oc.valor[1]) && oc.valor[0] >= -6 && oc.valor[1] <= 6) {
		salida.offset_cuadros = {valor: [oc.valor[0], oc.valor[1]], n: enteroN(oc), fuente: textoFuente(oc), falta: null};
	} else {
		notas.push('offset_cuadros sin valor medido: uso el supuesto [−2, 0]');
	}

	const g = s.ganancia_db;
	if (g && parFinito(g.valor) && g.valor[1] <= 0) {
		const variacion = numeroFinito(g.variacion_db) && g.variacion_db >= 0 ? g.variacion_db : ESTILO_SFX_SUPUESTO.ganancia_db.variacion_db;
		salida.ganancia_db = {valor: [g.valor[0], g.valor[1]], variacion_db: variacion, n: enteroN(g), fuente: textoFuente(g), falta: null};
	} else {
		notas.push('ganancia_db sin valor medido: uso el supuesto [−14, −8] ±2 dB bajo la voz');
	}

	const ev = s.eventos_por_video;
	if (ev && parFinito(ev.valor) && ev.valor[0] >= 1) {
		salida.eventos_por_video = {valor: [Math.round(ev.valor[0]), Math.round(ev.valor[1])], n: enteroN(ev), fuente: textoFuente(ev), falta: null};
	} else {
		notas.push('eventos_por_video sin valor medido: la simulación usa el supuesto 12–30');
	}
	return {estilo: salida, notas};
}

/**
 * Mapeo de categorías por tipo de evento aprendido en la Fase 2 (estilo.json → sfx.mapeo), en orden de
 * preferencia: {sticker: [...], tarjeta: [...], insert: [...], zoom: [...], titular: [...]}. Lo que falte
 * o no sea una lista de textos se toma del supuesto. Devuelve null si estilo.json no trae mapeo.
 */
export function mapeoDesdeEstilo(estilo: unknown): Record<TipoEvento, string[]> | null {
	const sfx = estilo && typeof estilo === 'object' ? (estilo as Record<string, unknown>).sfx : undefined;
	const crudo = sfx && typeof sfx === 'object' ? (sfx as Record<string, unknown>).mapeo : undefined;
	if (!crudo || typeof crudo !== 'object') return null;
	const m = crudo as Record<string, unknown>;
	const salida = {} as Record<TipoEvento, string[]>;
	for (const tipo of TIPOS_EVENTO) {
		const lista = m[tipo];
		salida[tipo] = Array.isArray(lista) && lista.every((c) => typeof c === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c)) ? [...(lista as string[])] : [...MAPEO_SUPUESTO[tipo]];
	}
	return salida;
}

/** Lee estilo/estilo.json si existe; si no, los supuestos. */
export function leerEstiloSfx(ruta = RUTA_ESTILO): {estilo: EstiloSfx; notas: string[]} {
	if (!existsSync(ruta)) return {estilo: JSON.parse(JSON.stringify(ESTILO_SFX_SUPUESTO)), notas: [`no existe ${basename(ruta)}: uso los supuestos (n = 0)`]};
	try {
		return estiloSfxDesde(JSON.parse(readFileSync(ruta, 'utf8')));
	} catch (error) {
		throw fallo('leer el estilo para los SFX', `${basename(ruta)} no es un JSON válido`, 'revisa estilo/estilo.json o vuelve a generarlo', 2, error);
	}
}

// ───────────────────────────── Historial entre videos ─────────────────────────────

export function leerHistorial(ruta = RUTA_HISTORIAL): HistorialSfx {
	if (!existsSync(ruta)) return JSON.parse(JSON.stringify(HISTORIAL_VACIO));
	let crudo: unknown;
	try {
		crudo = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo('leer el historial de SFX', `${basename(ruta)} no es un JSON válido`, 'revisa estilo/historial-sfx.json (o bórralo para empezar de cero)', 2, error);
	}
	const r = HistorialSfxEsquema.safeParse(crudo);
	if (!r.success) {
		throw fallo('leer el historial de SFX', `${basename(ruta)} no cumple el esquema`, 'revisa estilo/historial-sfx.json (o bórralo para empezar de cero)', 2, r.error.issues);
	}
	return r.data;
}

/** Peso de cada video reciente en `usosRecientes`: el anterior pesa más (×3), luego ×1 y ×0.5. */
export const PESOS_HISTORIAL = [3, 1, 0.5] as const;

/**
 * Lo que el selector toma del historial para un video: la ventana inicial (las últimas fuentes que sonaron en
 * el video anterior, para no arrancar repitiendo) y cuántas veces sonó cada fuente en los videos recientes,
 * ponderado por cercanía (para preferir las que menos sonaron). El mismo slug se ignora, así re-elegir un
 * video da lo mismo.
 */
export function contextoHistorial(h: HistorialSfx | null, slug: string | null): {ventanaInicial: string[]; usosRecientes: Map<string, number>} {
	const usosRecientes = new Map<string, number>();
	if (!h) return {ventanaInicial: [], usosRecientes};
	const otros = h.videos.filter((v) => v.slug !== slug);
	PESOS_HISTORIAL.forEach((peso, i) => {
		const v = otros[otros.length - 1 - i];
		if (!v) return;
		for (const u of v.usados) usosRecientes.set(u.fuente_id, (usosRecientes.get(u.fuente_id) ?? 0) + peso);
	});
	const ultimo = otros.at(-1);
	const ventanaInicial = ultimo ? ultimo.usados.slice(-REGLAS_SFX.ventana_sin_repetir).map((u) => u.fuente_id) : [];
	return {ventanaInicial, usosRecientes};
}

/** Reemplaza (o agrega al final) la entrada del video y deja solo los últimos `maximo` videos. Pura. */
export function registrarVideo(
	h: HistorialSfx,
	video: {slug: string; semilla: string; fecha: string; usados: z.infer<typeof UsoHistorialEsquema>[]},
	maximo = 50,
): HistorialSfx {
	const videos = h.videos.filter((v) => v.slug !== video.slug);
	videos.push({slug: video.slug, fecha: video.fecha, semilla: video.semilla, usados: video.usados});
	return {version: 1, nota: h.nota ?? HISTORIAL_VACIO.nota, videos: videos.slice(-maximo)};
}

// ───────────────────────────── Audio ─────────────────────────────

/** Audio en memoria: un Float32Array por canal, misma longitud. */
export type Audio = {tasa: number; canales: Float32Array[]};

export const muestrasDe = (a: Audio): number => a.canales[0]?.length ?? 0;
export const duracionDe = (a: Audio): number => muestrasDe(a) / a.tasa;
export const dbALineal = (db: number): number => Math.pow(10, db / 20);
export const linealADb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const redondear = (x: number, decimales = 1): number => {
	const f = Math.pow(10, decimales);
	return Math.round(x * f) / f;
};

function ffmpegBinario(args: string[], que: string): Buffer {
	const r = spawnSync('ffmpeg', args, {maxBuffer: 1 << 30});
	if (r.error) {
		const e = r.error as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') throw fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2, e);
		throw fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e);
	}
	if (r.status !== 0) {
		const ultima = r.stderr?.toString().trim().split('\n').pop() ?? `código ${r.status}`;
		throw fallo(que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.toString().slice(-4000)});
	}
	return r.stdout as Buffer;
}

function ffmpegTexto(args: string[], que: string): string {
	const r = spawnSync('ffmpeg', args, {maxBuffer: 1 << 28, encoding: 'utf8'});
	if (r.error) {
		const e = r.error as NodeJS.ErrnoException;
		if (e.code === 'ENOENT') throw fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2, e);
		throw fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e);
	}
	if (r.status !== 0) {
		const ultima = r.stderr?.trim().split('\n').pop() ?? `código ${r.status}`;
		throw fallo(que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.slice(-4000)});
	}
	return r.stderr;
}

/** Separa muestras intercaladas f32le en canales. */
export function desintercalar(bytes: Buffer, canales: number, tasa: number): Audio {
	const total = Math.floor(bytes.length / 4);
	const n = Math.floor(total / canales);
	const salida: Float32Array[] = Array.from({length: canales}, () => new Float32Array(n));
	for (let i = 0; i < n; i++) {
		for (let c = 0; c < canales; c++) salida[c][i] = bytes.readFloatLE(4 * (i * canales + c));
	}
	return {tasa, canales: salida};
}

export type OpcionesDecodificar = {
	/** Hz de salida (por defecto 48 000). null = la del archivo. */
	tasa?: number | null;
	/** Canales de salida (por defecto 2). null = los del archivo. */
	canales?: number | null;
	/** Filtros de ffmpeg (-af) antes de convertir. */
	filtros?: string;
};

/** Canales y tasa nativos del primer stream de audio (ffprobe). */
export function formatoNativo(ruta: string): {canales: number; tasa: number} {
	const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate', '-of', 'json', ruta], {encoding: 'utf8'});
	if (r.status !== 0) throw fallo(`leer ${basename(ruta)}`, `ffprobe no lo pudo abrir (${r.stderr?.trim().split('\n').pop() ?? r.status})`, 'revisa que sea un audio completo', 2, r.stderr);
	const s = (JSON.parse(r.stdout) as {streams?: {channels?: number; sample_rate?: string}[]}).streams?.[0];
	if (!s?.channels || !s.sample_rate) throw fallo(`leer ${basename(ruta)}`, 'no trae pista de audio', 'usa un archivo de audio (wav, mp3, ogg)', 2);
	return {canales: s.channels, tasa: Number(s.sample_rate)};
}

/** Decodifica cualquier audio a float32 con ffmpeg (sin shell). */
export function decodificar(ruta: string, op: OpcionesDecodificar = {}): Audio {
	if (!existsSync(ruta)) throw fallo(`leer ${basename(ruta)}`, `no existe ${ruta}`, 'revisa la ruta', 2);
	const nativo = op.tasa === null || op.canales === null ? formatoNativo(ruta) : null;
	const tasa = op.tasa === null ? nativo!.tasa : (op.tasa ?? TASA_SFX);
	const canales = op.canales === null ? nativo!.canales : (op.canales ?? CANALES_SFX);
	const args = ['-nostdin', '-v', 'error', '-i', ruta];
	if (op.filtros) args.push('-af', op.filtros);
	args.push('-ac', String(canales), '-ar', String(tasa), '-f', 'f32le', '-');
	return desintercalar(ffmpegBinario(args, `decodificar ${basename(ruta)}`), canales, tasa);
}

/** sha256 del audio decodificado tal cual (canales y tasa nativos, float32): dos archivos con el mismo audio dan lo mismo. */
export function sha256AudioDecodificado(ruta: string): string {
	const {canales, tasa} = formatoNativo(ruta);
	const bytes = ffmpegBinario(['-nostdin', '-v', 'error', '-i', ruta, '-ac', String(canales), '-ar', String(tasa), '-f', 'f32le', '-'], `decodificar ${basename(ruta)}`);
	return createHash('sha256').update(bytes).digest('hex');
}

export const sha256Bytes = (b: Buffer | Uint8Array): string => createHash('sha256').update(b).digest('hex');
export const sha256DeArchivo = (ruta: string): string => sha256Bytes(readFileSync(ruta));

/** Pico de muestra (lineal, máx. |x| entre canales). */
export function picoMuestra(a: Audio): number {
	let pico = 0;
	for (const c of a.canales) for (let i = 0; i < c.length; i++) pico = Math.max(pico, Math.abs(c[i]));
	return pico;
}

/** |x| máximo entre canales en la muestra i. */
const absEn = (a: Audio, i: number): number => {
	let m = 0;
	for (const c of a.canales) m = Math.max(m, Math.abs(c[i]));
	return m;
};

/** Índice de la primera muestra a `umbralDb` del pico (o −1 si está en silencio). */
export function primeraSobre(a: Audio, umbralDb: number): number {
	const pico = picoMuestra(a);
	if (!(pico > 0)) return -1;
	const u = pico * dbALineal(umbralDb);
	const n = muestrasDe(a);
	for (let i = 0; i < n; i++) if (absEn(a, i) >= u) return i;
	return -1;
}

/** Índice de la última muestra a `umbralDb` del pico (o −1). */
export function ultimaSobre(a: Audio, umbralDb: number): number {
	const pico = picoMuestra(a);
	if (!(pico > 0)) return -1;
	const u = pico * dbALineal(umbralDb);
	for (let i = muestrasDe(a) - 1; i >= 0; i--) if (absEn(a, i) >= u) return i;
	return -1;
}

/** ms de la primera muestra a −40 dB del pico (debe ser ≤ 2 en la biblioteca). */
export const inicioMs = (a: Audio): number => (Math.max(0, primeraSobre(a, REGLAS_SFX.umbral_inicio_db)) / a.tasa) * 1000;
/** ms del inicio a la primera muestra a −6 dB del pico (la mitad de su amplitud). */
export const ataqueMs = (a: Audio): number => (Math.max(0, primeraSobre(a, -6.0206)) / a.tasa) * 1000;

export function recortarMuestras(a: Audio, desde: number, hasta: number): Audio {
	const d = Math.max(0, Math.min(desde, muestrasDe(a)));
	const h = Math.max(d, Math.min(hasta, muestrasDe(a)));
	return {tasa: a.tasa, canales: a.canales.map((c) => c.slice(d, h))};
}

/** Fundidos lineales de entrada y de salida (en muestras), en una copia. */
export function fundidos(a: Audio, entrada: number, salida: number): Audio {
	const n = muestrasDe(a);
	const canales = a.canales.map((c) => {
		const x = c.slice();
		const fe = Math.min(entrada, n);
		for (let i = 0; i < fe; i++) x[i] *= i / fe;
		const fs = Math.min(salida, n);
		for (let i = 0; i < fs; i++) x[n - 1 - i] *= i / fs;
		return x;
	});
	return {tasa: a.tasa, canales};
}

export function aplicarGanancia(a: Audio, db: number): Audio {
	const g = dbALineal(db);
	return {tasa: a.tasa, canales: a.canales.map((c) => c.map((v) => v * g))};
}

/** Lleva a 2 canales (mono → los dos iguales; más de 2 → se quedan los primeros 2). */
export function aEstereo(a: Audio): Audio {
	if (a.canales.length === 2) return a;
	if (a.canales.length === 1) return {tasa: a.tasa, canales: [a.canales[0].slice(), a.canales[0].slice()]};
	return {tasa: a.tasa, canales: a.canales.slice(0, 2)};
}

export function aMono(a: Audio): Float32Array {
	const n = muestrasDe(a);
	const m = new Float32Array(n);
	for (const c of a.canales) for (let i = 0; i < n; i++) m[i] += c[i] / a.canales.length;
	return m;
}

export type OpcionesPreparar = {
	/** Recorte manual del original (segundos), antes de todo lo demás. */
	recorte?: {desde_s: number; hasta_s: number | null} | null;
	/** Duración máxima; si se pasa, se corta con un fundido de salida de 80 ms. */
	maxDuracionS?: number;
};

/**
 * Deja un SFX listo para la biblioteca (sin normalizar todavía):
 *  1. recorte manual opcional;
 *  2. quita el silencio inicial: arranca en la primera muestra a −40 dB del pico, retrocediendo como mucho
 *     2 ms hasta el último cruce por cero para no meter un chasquido (el ataque queda en la muestra 0);
 *  3. quita la cola por debajo de −60 dB del pico (deja 5 ms de aire con fundido);
 *  4. si pasa de `maxDuracionS`, corta con un fundido de salida de 80 ms.
 */
export function prepararSfx(a: Audio, op: OpcionesPreparar = {}): {audio: Audio; inicio_original_s: number; recortado_por_duracion: boolean} {
	let x = a;
	let desplazamiento = 0;
	if (op.recorte) {
		const d = Math.round(op.recorte.desde_s * a.tasa);
		const h = op.recorte.hasta_s === null ? muestrasDe(a) : Math.round(op.recorte.hasta_s * a.tasa);
		x = recortarMuestras(x, d, h);
		desplazamiento = d;
	}
	const inicio = primeraSobre(x, REGLAS_SFX.umbral_inicio_db);
	if (inicio < 0) throw fallo('preparar el SFX', 'el audio está en silencio', 'revisa el archivo de origen', 2);
	// Retrocede hasta el último cruce por cero (o muestra casi nula) dentro de 2 ms; si no hay, arranca en el
	// umbral mismo (ahí la muestra vale −40 dB del pico: el salto desde 0 no se oye).
	const maxAtras = Math.round((REGLAS_SFX.max_inicio_ms / 1000) * x.tasa) - 1;
	const casiNulo = picoMuestra(x) * dbALineal(-60);
	let arranque = inicio;
	for (let i = inicio; i >= Math.max(1, inicio - maxAtras); i--) {
		const cruza = x.canales.every((c) => Math.sign(c[i]) !== Math.sign(c[i - 1]) || Math.abs(c[i]) <= casiNulo);
		if (cruza) {
			arranque = i;
			break;
		}
	}
	const fin = ultimaSobre(x, -60);
	const cola = Math.round(0.005 * x.tasa);
	let y = recortarMuestras(x, arranque, Math.min(muestrasDe(x), fin + 1 + cola));
	let recortado = false;
	if (op.maxDuracionS && duracionDe(y) > op.maxDuracionS) {
		y = recortarMuestras(y, 0, Math.round(op.maxDuracionS * y.tasa));
		y = fundidos(y, 0, Math.round(0.08 * y.tasa));
		recortado = true;
	} else {
		y = fundidos(y, 0, cola);
	}
	return {audio: y, inicio_original_s: (desplazamiento + arranque) / a.tasa, recortado_por_duracion: recortado};
}

/** Escribe WAV PCM s16le (con recorte a ±1). */
export function escribirWav(ruta: string, a: Audio): void {
	const n = muestrasDe(a);
	const ch = a.canales.length;
	const datos = Buffer.alloc(n * ch * 2);
	for (let i = 0; i < n; i++) {
		for (let c = 0; c < ch; c++) {
			const v = Math.max(-1, Math.min(1, a.canales[c][i]));
			datos.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 2 * (i * ch + c));
		}
	}
	const cabecera = Buffer.alloc(44);
	cabecera.write('RIFF', 0, 'ascii');
	cabecera.writeUInt32LE(36 + datos.length, 4);
	cabecera.write('WAVE', 8, 'ascii');
	cabecera.write('fmt ', 12, 'ascii');
	cabecera.writeUInt32LE(16, 16);
	cabecera.writeUInt16LE(1, 20);
	cabecera.writeUInt16LE(ch, 22);
	cabecera.writeUInt32LE(a.tasa, 24);
	cabecera.writeUInt32LE(a.tasa * ch * 2, 28);
	cabecera.writeUInt16LE(ch * 2, 32);
	cabecera.writeUInt16LE(16, 34);
	cabecera.write('data', 36, 'ascii');
	cabecera.writeUInt32LE(datos.length, 40);
	mkdirSync(dirname(ruta), {recursive: true});
	writeFileSync(ruta, Buffer.concat([cabecera, datos]));
}

export type Sonoridad = {
	/** Sonoridad momentánea máxima (400 ms), LUFS. */
	m_max: number;
	/** Tiempo (s) del final de la ventana de 400 ms con la M máxima. */
	t_m_max: number;
	/** Pico real (dBTP). */
	tp_dbtp: number;
	/** Sonoridad integrada (LUFS) o null si no hubo bloques sobre el umbral. */
	i_lufs: number | null;
	/** M de cada ventana: [fin de la ventana (s), LUFS]. */
	m: [number, number][];
};

/** Lee lo que imprime `ebur128=peak=true:metadata=1,ametadata=mode=print`. Pura. */
export function parsearMetadatosEbur128(stderr: string): Sonoridad {
	const m: [number, number][] = [];
	let tp = 0;
	let iLufs: number | null = null;
	let pts = 0;
	const num = (s: string): number => (s === '-inf' ? -Infinity : s === 'inf' ? Infinity : Number(s));
	for (const linea of stderr.split('\n')) {
		const mt = /pts_time:\s*(-?[\d.]+)/.exec(linea);
		if (mt) {
			pts = Number(mt[1]);
			continue;
		}
		const mm = /lavfi\.r128\.M=(-?[\d.]+|-?inf)/.exec(linea);
		if (mm) {
			m.push([redondear(pts + 0.1, 3), num(mm[1])]);
			continue;
		}
		const mp = /lavfi\.r128\.true_peak=(-?[\d.]+)/.exec(linea);
		if (mp) {
			tp = Math.max(tp, Number(mp[1]));
			continue;
		}
		const mi = /lavfi\.r128\.I=(-?[\d.]+|-?inf)/.exec(linea);
		if (mi) iLufs = num(mi[1]);
	}
	if (m.length === 0) throw fallo('medir la sonoridad', 'ffmpeg ebur128 no imprimió sus mediciones', 'revisa proyectos/_logs/fallos.log y avísame', 1, {stderr: stderr.slice(-2000)});
	let mejor = 0;
	for (let i = 1; i < m.length; i++) if (m[i][1] > m[mejor][1]) mejor = i;
	return {
		m_max: m[mejor][1],
		t_m_max: m[mejor][0],
		tp_dbtp: linealADb(tp),
		i_lufs: iLufs !== null && Number.isFinite(iLufs) && iLufs > -69.9 ? iLufs : null,
		m,
	};
}

/**
 * Mide con ffmpeg ebur128 (peak=true): M por ventana de 400 ms cada 100 ms, M máx., pico real e integrada.
 * Agrega `relleno_s` de silencio al final para que las ventanas pasen completas sobre sonidos cortos.
 */
export function medirSonoridad(ruta: string, relleno_s = 0.5): Sonoridad {
	const filtros = `${relleno_s > 0 ? `apad=pad_dur=${relleno_s},` : ''}ebur128=peak=true:metadata=1,ametadata=mode=print`;
	const stderr = ffmpegTexto(['-nostdin', '-hide_banner', '-nostats', '-i', ruta, '-af', filtros, '-f', 'null', '-'], `medir la sonoridad de ${basename(ruta)}`);
	return parsearMetadatosEbur128(stderr);
}

// ───────────────────────────── Espectro ─────────────────────────────

function fftInSitu(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i];
			re[i] = re[j];
			re[j] = t;
			t = im[i];
			im[i] = im[j];
			im[j] = t;
		}
	}
	for (let largo = 2; largo <= n; largo <<= 1) {
		const ang = (-2 * Math.PI) / largo;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		const mitad = largo >> 1;
		for (let i = 0; i < n; i += largo) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < mitad; k++) {
				const a = i + k;
				const b = a + mitad;
				const xr = re[b] * cr - im[b] * ci;
				const xi = re[b] * ci + im[b] * cr;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
				const nr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = nr;
			}
		}
	}
}

/** Potencia por bin de un marco con ventana de Hann que empieza en `inicio` (fuera del audio cuenta como 0). */
function potenciaMarco(x: Float32Array, inicio: number, n: number): Float64Array {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		const i = inicio + k;
		if (i >= 0 && i < x.length) re[k] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)));
	}
	fftInSitu(re, im);
	const p = new Float64Array(n / 2);
	for (let k = 0; k < n / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
	return p;
}

/** Centroide espectral (Hz) y planitud (0 tonal … 1 ruido) de los primeros 300 ms. */
export function rasgosEspectrales(a: Audio): {centroide_hz: number; planitud: number} {
	const x = aMono(a);
	const N = 2048;
	const salto = 512;
	const fin = Math.min(x.length, Math.round(0.3 * a.tasa));
	const P = new Float64Array(N / 2);
	for (let s = 0; s === 0 || s + N <= fin; s += salto) {
		const p = potenciaMarco(x, s, N);
		for (let k = 0; k < P.length; k++) P[k] += p[k];
	}
	let num = 0;
	let den = 0;
	let logs = 0;
	let suma = 0;
	let cuenta = 0;
	for (let k = 1; k < P.length; k++) {
		const f = (k * a.tasa) / N;
		num += f * P[k];
		den += P[k];
		if (f >= 100 && f <= 16000) {
			logs += Math.log(P[k] + 1e-24);
			suma += P[k];
			cuenta++;
		}
	}
	return {
		centroide_hz: den > 0 ? Math.round(num / den) : 0,
		planitud: cuenta > 0 && suma > 0 ? redondear(Math.exp(logs / cuenta) / (suma / cuenta), 3) : 0,
	};
}

/** Parámetros de la huella espectro-temporal (para detectar archivos casi iguales). */
export const HUELLA = {marco: 4096, salto: 480, marcos: 64, bandasPorOctava: 6, fMin: 100, fMax: 16000, pisoDb: 60} as const;
const BANDAS = Math.floor(Math.log2(HUELLA.fMax / HUELLA.fMin) * HUELLA.bandasPorOctava);

/**
 * Huella: espectrograma de 1/6 de octava (100 Hz–16 kHz) de los primeros 640 ms desde el ataque, en dB
 * relativos a su máximo con piso de −60 dB. Robusta al volumen; la comparación tolera ±3 cuadros y ±1 banda.
 */
export function huella(a: Audio): Float64Array {
	const x = aMono(a);
	let inicio = primeraSobre(a, REGLAS_SFX.umbral_inicio_db);
	if (inicio < 0) inicio = 0;
	const H = new Float64Array(HUELLA.marcos * BANDAS);
	const fBin = a.tasa / HUELLA.marco;
	for (let m = 0; m < HUELLA.marcos; m++) {
		const p = potenciaMarco(x, inicio + m * HUELLA.salto - HUELLA.marco / 2, HUELLA.marco);
		for (let k = 1; k < p.length; k++) {
			const f = k * fBin;
			if (f < HUELLA.fMin || f >= HUELLA.fMax) continue;
			const b = Math.min(BANDAS - 1, Math.floor(Math.log2(f / HUELLA.fMin) * HUELLA.bandasPorOctava));
			H[m * BANDAS + b] += p[k];
		}
	}
	let max = 0;
	for (const v of H) max = Math.max(max, v);
	for (let i = 0; i < H.length; i++) H[i] = max > 0 ? Math.max(0, 10 * Math.log10((H[i] + 1e-30) / max) + HUELLA.pisoDb) : 0;
	return H;
}

/** Similitud coseno máxima entre dos huellas, moviendo ±3 cuadros (30 ms) y ±1 banda. 1 = iguales. */
export function similitudHuellas(a: Float64Array, b: Float64Array, maxCuadros = 3, maxBandas = 1): number {
	let ta = 0;
	let tb = 0;
	for (const v of a) ta += v * v;
	for (const v of b) tb += v * v;
	const norma = Math.sqrt(ta * tb);
	if (!(norma > 0)) return 0;
	let mejor = 0;
	for (let dm = -maxCuadros; dm <= maxCuadros; dm++) {
		for (let db = -maxBandas; db <= maxBandas; db++) {
			let ab = 0;
			for (let m = Math.max(0, -dm); m < HUELLA.marcos && m + dm < HUELLA.marcos; m++) {
				const fa = m * BANDAS;
				const fb = (m + dm) * BANDAS;
				for (let k = Math.max(0, -db); k < BANDAS && k + db < BANDAS; k++) ab += a[fa + k] * b[fb + k + db];
			}
			mejor = Math.max(mejor, ab / norma);
		}
	}
	return mejor;
}

/** Agrupa (unión-búsqueda) los pares con similitud ≥ umbral. Devuelve el representante de cada id. Pura. */
export function agruparCasiIguales(ids: string[], pares: {a: string; b: string; similitud: number}[], umbral: number): Map<string, string> {
	const padre = new Map(ids.map((id) => [id, id]));
	const raiz = (x: string): string => {
		let r = x;
		while (padre.get(r) !== r) r = padre.get(r)!;
		return r;
	};
	for (const p of pares) {
		if (p.similitud < umbral) continue;
		const ra = raiz(p.a);
		const rb = raiz(p.b);
		if (ra === rb) continue;
		// El representante es el menor en orden alfabético: estable entre corridas.
		if (ra < rb) padre.set(rb, ra);
		else padre.set(ra, rb);
	}
	return new Map(ids.map((id) => [id, raiz(id)]));
}
