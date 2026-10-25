// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * El borrador del director: junta los momentos del transcript, los acomoda en el tiempo (ritmo medido, separación
 * mínima, una capa a la vez en la zona libre debajo de tu boca) y los coloca con el layout. Lo que Claude decide a
 * mano (notas-director.json) va primero y manda. Puro y determinista: la misma entrada y la misma semilla dan lo mismo.
 *
 * Modo de cerca: si tu cara sale más grande que el p90 de tus reels (estilo/encuadre.json → alto_cara), el plan lo
 * anota y primero reserva las demos grabadas que emparejan con los momentos de acción (pantalla completa, lo que
 * duran tus inserts); las tarjetas y los stickers siguen a su ritmo, encima de tu barba si no caben debajo de la
 * barbilla (como en tus tomas de cerca).
 */
import {z} from 'zod';
import type {Edicion} from '../../../src/esquema/edicion.ts';
import {esMeme, MEME} from '../../../src/estilo/memes.ts';
import {ESCENA, MotionEsquema, TARJETA_MOTION, duracionMinimaMotion, esMotionLibre} from '../../../src/estilo/motion.ts';
import {pistaCabeza} from '../../../src/estilo/anclaje.ts';
import {anchoMinimoLogo, colocarInsert, colocarLista, colocarSticker, colocarTarjeta, colocarTitular, escalaMaxSticker, type CajaVisible, type ContextoLayout} from '../../layout.ts';
import type {EstiloDirector} from './estilo.ts';
import {
	candidatosListas,
	candidatosStickers,
	candidatosTarjetas,
	detectarMarcas,
	emparejarDemos,
	momentosDemo,
	trimDeDemo,
	type Candidato,
	type DemoDisponible,
	type EmparejeDemo,
	type MomentoDemo,
	type TipoPalabra,
} from './momentos.ts';
import {opcionesSticker, type EntradaMascota, type EntradaLogo, type OpcionSticker} from './stickers.ts';
import {alinearPrompt, horarioDeParte, LECTURA_PROMPT_S, partirPrompt, rangosDePartes, tiempoDeCaracter, tiempoPrompt, type AlineacionPrompt} from './tecleo.ts';
import {contarPalabras, limpiar, MAX_PALABRAS_TARJETA, normalizar, type Palabra} from './texto.ts';
import {borradorTitular, revisarTitular, type RevisionTitular} from './titular.ts';
import type {ReglaVoz} from './voz.ts';

// ───────────────────────── notas-director.json ─────────────────────────

const Desde = z.union([z.number().int().nonnegative(), z.string().min(1)]);
const Momento = {desde_palabra: Desde.optional(), desde: z.number().nonnegative().optional(), hasta: z.number().positive().optional()};

export const NotasEsquema = z.object({
	titular: z.union([z.string().min(1), z.object({texto: z.string().min(1), caja: z.object({x: z.number(), y: z.number(), escala: z.number().positive().optional()}).optional()})]).nullable().optional(),
	tarjetas_forzadas: z
		.array(
			z
				.object({
					/** Un prompt largo (> ~120 caracteres) se parte solo en tarjetas seguidas de ≤ 4 renglones (tecleo.ts). */
					texto: z.string().min(1).max(480),
					grupo: z.string().min(1).optional(),
					variante: z.enum(['normal', 'grande', 'prompt']).optional(),
					entrada: z.enum(['corte', 'pop', 'escritura']).optional(),
					...Momento,
				})
				.refine((t) => t.variante === 'prompt' || t.texto.length <= 48, {message: 'solo las tarjetas "prompt" pasan de 48 caracteres'})
				.refine((t) => t.variante !== 'prompt' || !t.grupo, {message: 'un prompt no va en grupo (las listas son de tarjetas normales); si es largo se parte solo en tarjetas seguidas'}),
		)
		.default([]),
	stickers_forzados: z.array(z.object({asset: z.string().min(1).optional(), id_catalogo: z.string().min(1).optional(), ancho: z.number().positive().optional(), ...Momento})).default([]),
	inserts: z
		.array(
			z.object({
				asset: z.string().min(1),
				tipo: z.enum(['video', 'imagen', 'demo', 'brag', 'motion']).optional(),
				/** "flotante": solo motion graphics; flotan encima de ti con tu toma desenfocada (src/estilo/flotante.ts). */
				layout: z.enum(['tarjeta', 'pantalla-completa', 'flotante']),
				/** Solo motion graphics (asset "motion:<nombre>"): cuál y con qué textos (src/estilo/motion.ts). */
				motion: MotionEsquema.optional(),
				duracion: z.number().positive().optional(),
				trim_desde: z.number().nonnegative().optional(),
				texto: z.string().min(1).nullable().optional(),
				encuadre: z.enum(['horizontal', 'vertical']).optional(),
				eventos: z.string().min(1).nullable().optional(),
				audio: z.object({modo: z.enum(['mute', 'duck']), ganancia_db: z.number().max(0)}).optional(),
				ancho: z.number().positive().optional(),
				...Momento,
			}),
		)
		.default([]),
	quitar: z.array(z.string().min(1)).default([]),
	sin_tarjetas: z.boolean().optional(),
	sin_stickers: z.boolean().optional(),
	/** Fuente de SFX que se prefiere (p. ej. la de tus Foleys propios, biblioteca/sfx/seleccion.json → fuente); las reglas del selector no cambian. */
	sfx_preferir_fuente: z.string().min(1).optional(),
});
export type Notas = z.infer<typeof NotasEsquema>;

/** Valida notas-director.json. Devuelve las notas o la lista de problemas en español. */
export function leerNotas(datos: unknown): {notas: Notas | null; problemas: string[]; avisos: string[]} {
	const r = NotasEsquema.safeParse(datos);
	if (!r.success) return {notas: null, problemas: r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`), avisos: []};
	const conocidas = new Set(Object.keys(NotasEsquema.shape));
	const avisos =
		typeof datos === 'object' && datos !== null
			? Object.keys(datos)
					.filter((k) => !conocidas.has(k) && !k.startsWith('_'))
					.map((k) => `notas-director.json trae "${k}", que no conozco: lo ignoro (los comentarios van en llaves que empiezan con "_")`)
			: [];
	for (const f of r.data.tarjetas_forzadas) {
		const aviso = avisoPalabrasForzada(f);
		if (aviso) avisos.push(aviso);
	}
	return {notas: r.data, problemas: [], avisos};
}

/**
 * Una tarjeta forzada de más de MAX_PALABRAS_TARJETA palabras que no es "prompt": entra igual (las notas mandan), pero
 * con aviso, porque tus tarjetas de palabra clave van de 2–3 palabras (decisión del estilo, 2026-10-04: que no sean muchas palabras).
 */
export function avisoPalabrasForzada(f: {texto: string; variante?: string}): string | null {
	if (f.variante === 'prompt') return null;
	const n = contarPalabras(f.texto);
	if (n <= MAX_PALABRAS_TARJETA) return null;
	return `tarjeta forzada "${f.texto.replace(/\n/g, ' ')}": tiene ${n} palabras y tus tarjetas van de 2 a ${MAX_PALABRAS_TARJETA} (solo las "prompt" pasan de ${MAX_PALABRAS_TARJETA}); acórtala en notas-director.json o ponle "variante": "prompt" si es un prompt`;
}

// ───────────────────────── tipos del plan ─────────────────────────

export type Medio = {ancho: number; alto: number; duracion: number | null};

export type EntradasPlan = {
	slug: string;
	semilla: string;
	palabras: Palabra[];
	duracion: number;
	ctx: ContextoLayout;
	estilo: EstiloDirector;
	/** ia: stickers de Higgsfield (biblioteca/stickers/ia); solo entran forzados. */
	catalogos: {mascotas: EntradaMascota[]; logos: EntradaLogo[]; ia?: EntradaMascota[]};
	terminos: string[];
	notas: Notas | null;
	voz: ReglaVoz[] | null;
	/** Dimensiones de un medio (ruta relativa a public/), para los inserts de las notas. */
	medio?: (asset: string) => Medio | null;
	/** Demo grabada para este proyecto (demos/<slug>/toma.mp4), si existe. */
	demo?: {asset: string; eventos: string | null; duracion: number; usable: boolean; motivo: string} | null;
	/** Demos grabadas con el estudio (demos/*), para emparejarlas con los momentos de acción en el modo de cerca. */
	demosDisponibles?: DemoDisponible[];
	/** Objetivo de ritmo (por minuto) que manda sobre estilo.ritmo; el director pasa el de sus reels recientes. */
	ritmo?: {tarjetas_por_min: number; stickers_por_min: number};
	/** Opciones del CLI (las de las notas también cuentan). */
	sinTarjetas?: boolean;
	sinStickers?: boolean;
};

/** Modo de cerca: tu cara más grande que el p90 de tus reels. */
export type ModoCerca = {
	activo: boolean;
	/** p50 del alto de la caja de tu cara (px base) en los cuadros con cara. */
	alto_cara_p50: number | null;
	/** El umbral: p90 del alto de cara de tus reels (null si no se midió). */
	umbral: number | null;
	n_cuadros: number;
	fuente: string;
	/** Demos grabadas propuestas en momentos de acción (solo en el modo de cerca). */
	demos: Array<{t: number; accion: string; frase: string; asset: string; comunes: string[]; id: string | null}>;
	/** Momentos de acción sin demo grabada que les quede. */
	sin_demo: MomentoDemo[];
};

export type Decision = {
	id: string;
	tipo: 'tarjeta' | 'sticker' | 'insert';
	/** Solo tarjetas: el tipo de palabra (clave, frase, cifra, producto, pregunta). */
	tipo_palabra?: TipoPalabra;
	t: number;
	hasta: number;
	palabra: string;
	frase: string;
	que: string;
	motivo: string;
	alternativas: string[];
	avisos: string[];
	origen: 'borrador' | 'notas';
};

export type Descarte = {t: number; palabra: string; que: string; motivo: string};

export type InfoTitular = {texto: string | null; borrador: boolean; origen: string; revision: RevisionTitular | null; avisos: string[]};

export type Plan = {
	titular: Edicion['titular'];
	tarjetas: Edicion['tarjetas'];
	stickers: Edicion['stickers'];
	inserts: Edicion['inserts'];
	efectos: Edicion['efectos'];
	decisiones: Decision[];
	descartes: Descarte[];
	demos: MomentoDemo[];
	titularInfo: InfoTitular;
	avisos: string[];
	cerca: ModoCerca;
	ritmo: {
		duracion_s: number;
		tarjetas: number;
		stickers: number;
		inserts: number;
		tarjetas_por_min: number;
		stickers_por_min: number;
		objetivo_tarjetas: number;
		objetivo_stickers: number;
		/** Cuántas tarjetas de cada tipo de palabra (para comparar con tus reels). */
		tipos_tarjeta: Record<string, number>;
	};
};

/**
 * ¿Toma de cerca? (puro) El alto de tu cara (p50 de la caja de Vision en los cuadros con cara) contra el p90 del alto de
 * cara de tus reels recientes (estilo/encuadre.json). Sin cara o sin medida: no.
 */
export function modoDeCerca(cara: ContextoLayout['cara'], estilo: EstiloDirector): Omit<ModoCerca, 'demos' | 'sin_demo'> {
	const m = estilo.encuadre.alto_cara;
	const umbral = m.valor !== null && m.p90 !== undefined ? m.p90 : null;
	const fuente = m.valor === null ? m.nota : `p90 del alto de cara de tus reels (${m.fuente}; n = ${m.n})`;
	const altos = (cara?.cuadros ?? [])
		.map((c) => c.cara?.h)
		.filter((h): h is number => typeof h === 'number' && h > 0)
		.sort((a, b) => a - b);
	const p50 = altos.length ? altos[Math.floor((altos.length - 1) / 2)] : null;
	return {activo: umbral !== null && p50 !== null && p50 > umbral, alto_cara_p50: p50, umbral, n_cuadros: altos.length, fuente};
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
/** Centro x del cuadro (base 1080): ahí se centran las tarjetas y cada renglón de una lista. */
const BASE_X = 540;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

// ───────────────────────── tiempos ─────────────────────────

/** Segundo en que arranca un momento de las notas: `desde` (s) o `desde_palabra` (índice i del transcript o texto a buscar). */
export function resolverDesde(palabras: readonly Palabra[], p: {desde_palabra?: number | string; desde?: number}): {t: number; i0: number | null} | null {
	if (typeof p.desde === 'number') return {t: p.desde, i0: palabras.findIndex((x) => x.d >= p.desde! - 1e-6)};
	if (typeof p.desde_palabra === 'number') {
		const k = palabras.findIndex((x) => x.i === p.desde_palabra);
		return k >= 0 ? {t: palabras[k].d, i0: k} : null;
	}
	if (typeof p.desde_palabra === 'string') {
		// "Apple#2": la 2.ª vez que dices "Apple" (estable aunque se vuelva a cortar, a diferencia del índice i).
		const nth = /^(.*\S)\s*#(\d+)$/.exec(p.desde_palabra.trim());
		const texto = nth ? nth[1] : p.desde_palabra;
		const vez = nth ? Math.max(1, Number(nth[2])) : 1;
		const buscadas = texto.split(/\s+/).map((x) => normalizar(limpiar(x)));
		let n = 0;
		const k = palabras.findIndex((_, j) => buscadas.every((b, q) => palabras[j + q] && normalizar(limpiar(palabras[j + q].t)) === b) && ++n === vez);
		return k >= 0 ? {t: palabras[k].d, i0: k} : null;
	}
	return null;
}

/** Un bloque de la agenda: arranca en `s`, necesita al menos `dmin` y quiere durar hasta `edes`. */
type Bloque = {clave: string; s: number; dmin: number; edes: number; tipo: 'tarjeta' | 'lista' | 'sticker' | 'insert'};

/** ¿Cabe `nuevo` sin pisar a nadie? (cada uno dura al menos su mínimo y arranca ≥ `sep` después del anterior). */
export function cabeEnAgenda(agenda: readonly Bloque[], nuevo: Pick<Bloque, 's' | 'dmin'>, sep: number): string | null {
	for (const b of agenda) {
		if (b.s <= nuevo.s + 1e-9) {
			if (nuevo.s < b.s + Math.max(sep, b.dmin) - 1e-6) return b.clave;
		} else if (b.s < nuevo.s + Math.max(sep, nuevo.dmin) - 1e-6) return b.clave;
	}
	return null;
}

/** Un hueco de esto o menos (3 cuadros) entre dos capas seguidas se cierra: la primera se queda hasta que entra la otra. */
export const HUECO_PARPADEO_S = 0.1;

/** Lo que suma a su prioridad un candidato del gancho (antes del p90 de tu primera capa) mientras el arranque esté vacío. */
export const BONO_GANCHO = 10;

/** Una entrada de "quitar" que es un id del borrador (t3, k2, b1); lo demás es texto. */
export const ID_DEL_BORRADOR = /^[tkb]\d+$/;
/** Una entrada de "quitar" que es la ruta de un asset (una demo propuesta: "demos/img4874-github/toma.mp4" o su carpeta). */
export const ES_ASSET = /^(demos|p|biblioteca|proyectos)\//;

/** ¿"quitar" pide quitar este asset (la ruta exacta o su carpeta)? Devuelve la entrada que lo pide. */
export function assetQuitado(asset: string, quitar: readonly string[]): string | null {
	for (const q of quitar) {
		if (!ES_ASSET.test(q)) continue;
		const carpeta = q.replace(/\/+$/, '');
		if (asset === carpeta || asset.startsWith(`${carpeta}/`)) return q;
	}
	return null;
}

/** Texto comparable de una tarjeta o de lo que pide "quitar": sin acentos, mayúsculas, signos ni saltos de renglón. */
const comparable = (s: string): string =>
	normalizar(s)
		.replace(/[¿?¡!.,;:"'«»“”]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * Lo que "quitar" pide por texto ("Minutos", "sticker:dinero") sale de los candidatos ANTES de elegir, así su lugar lo
 * puede tomar otro. Los ids (t3, k2) cambian cuando cambia el borrador (otro estilo, una tarjeta forzada nueva), así que
 * el texto es lo estable: tarjeta = su texto completo; un elemento de lista = su texto (la lista sigue si le quedan 2);
 * sticker = "sticker:<concepto>" (el de direccion.md, p. ej. "dinero").
 */
export function quitarPorTexto(candidatos: readonly Candidato[], quitar: readonly string[], descartes: Descarte[], avisos: string[]): Candidato[] {
	const textos = quitar.filter((q) => !ID_DEL_BORRADOR.test(q) && !ES_ASSET.test(q));
	if (textos.length === 0) return [...candidatos];
	const usados = new Set<string>();
	const pide = (texto: string, esSticker: boolean): string | null => {
		for (const q of textos) {
			const sticker = /^sticker:/i.test(q);
			if (sticker !== esSticker) continue;
			if (comparable(sticker ? q.slice(8) : q) === comparable(texto)) return q;
		}
		return null;
	};
	const salida: Candidato[] = [];
	for (const c of candidatos) {
		if (c.tipo === 'sticker') {
			const q = c.sticker ? pide(c.sticker.concepto, true) : null;
			if (q) {
				usados.add(q);
				descartes.push({t: r2(c.t), palabra: c.palabra, que: `sticker (${c.sticker!.concepto})`, motivo: `quitado por notas-director.json ("${q}")`});
			} else salida.push(c);
			continue;
		}
		if (c.tipo === 'lista' && c.items) {
			const quedan = c.items.filter((it) => {
				const q = pide(it.texto, false);
				if (q) usados.add(q);
				return !q;
			});
			if (quedan.length === c.items.length) salida.push(c);
			else {
				const fuera = c.items.filter((it) => !quedan.includes(it)).map((it) => `"${it.texto}"`);
				descartes.push({t: r2(c.t), palabra: c.palabra, que: `de la lista: ${fuera.join(', ')}`, motivo: 'quitado por notas-director.json'});
				if (quedan.length >= 2) salida.push({...c, items: quedan, i0: quedan[0].i0, t: quedan[0].t});
			}
			continue;
		}
		const q = c.texto ? pide(c.texto, false) : null;
		if (q) {
			usados.add(q);
			descartes.push({t: r2(c.t), palabra: c.palabra, que: `tarjeta "${c.texto!.replace(/\n/g, ' / ')}"`, motivo: `quitado por notas-director.json ("${q}")`});
		} else salida.push(c);
	}
	for (const q of textos) if (!usados.has(q)) avisos.push(`notas-director.json pide quitar "${q}", pero ningún candidato de este borrador dice eso`);
	return salida;
}

// ───────────────────────── el plan ─────────────────────────

type Elegido = {
	bloque: Bloque;
	cand: Candidato | null;
	/** Tarjeta sola o cosas de una lista: texto y momento de cada una. */
	tarjetas?: Array<{
		texto: string;
		t: number;
		variante?: 'normal' | 'grande' | 'prompt';
		entrada?: 'corte' | 'pop' | 'escritura';
		/** Prompt al compás de tu voz: su alineación y el rango de grafemas [A, B) de esta parte (tecleo.ts). */
		alineacion?: {al: AlineacionPrompt; A: number; B: number};
	}>;
	modoLista?: 'columna' | 'arbol' | 'fila' | 'secuencial' | null;
	opciones?: OpcionSticker[];
	anchoSticker?: number;
	/** Piso de ancho del sticker (logos de marca: anchoMinimoLogo; los demás, el p10 medido). */
	anchoMinSticker?: {valor: number; nota: string};
	insert?: Edicion['inserts'][number] & {origenAvisos: string[]};
	origen: 'borrador' | 'notas';
	motivo: string;
	alternativas: string[];
	palabra: string;
	frase: string;
};

export function planear(e: EntradasPlan): Plan {
	const {palabras, ctx, estilo} = e;
	// Fin del video redondeado hacia abajo al milésimo: ningún `hasta` puede pasarse de la duración.
	const duracion = Math.floor(e.duracion * 1000) / 1000;
	const avisos: string[] = [];
	const descartes: Descarte[] = [];
	const notas = e.notas;
	const sep = estilo.separacion_min_s.valor;
	const porPalabra = estilo.min_por_palabra_s.valor;
	const tP10 = estilo.duracion.tarjeta.p10.valor;
	const tP50 = estilo.duracion.tarjeta.p50.valor;
	const sP10 = estilo.duracion.sticker.p10.valor;
	const sP50 = estilo.duracion.sticker.p50.valor;
	const desfase = estilo.desfase_aparicion_s.valor ?? 0;
	const dminTarjeta = (texto: string) => Math.max(tP10, contarPalabras(texto) * porPalabra);
	// El director pasa el ritmo de sus reels recientes (src/estilo/ritmo-reciente.ts); sin él, el de estilo.json.
	const objetivoT = Math.round(((e.ritmo?.tarjetas_por_min ?? estilo.ritmo.tarjetas_por_min.valor) * duracion) / 60);
	const objetivoS = Math.round(((e.ritmo?.stickers_por_min ?? estilo.ritmo.stickers_por_min.valor) * duracion) / 60);
	const sinTarjetas = Boolean(e.sinTarjetas || notas?.sin_tarjetas);
	const sinStickers = Boolean(e.sinStickers || notas?.sin_stickers);

	// ── Titular (va primero: los inserts que tapan la cabeza lo esquivan) ──
	const titularInfo: InfoTitular = {texto: null, borrador: false, origen: '', revision: null, avisos: []};
	let titular: Edicion['titular'] = null;
	let cajaTitular: CajaVisible | null = null;
	{
		const forzado = notas?.titular;
		const borrador = forzado === undefined ? borradorTitular(palabras) : null;
		const intentos: Array<{texto: string; nota: string}> = [];
		if (forzado === null) titularInfo.origen = 'notas-director.json pide no llevar titular';
		else if (forzado !== undefined) {
			const texto = typeof forzado === 'string' ? forzado : forzado.texto;
			intentos.push({texto, nota: 'notas-director.json'});
			titularInfo.origen = 'notas-director.json';
		} else if (borrador) {
			intentos.push({texto: borrador.texto, nota: `borrador del gancho (${r2(borrador.origen.t0)}–${r2(borrador.origen.t1)} s: «${borrador.origen.frase}»)`});
			if (borrador.un_renglon) intentos.push({texto: borrador.un_renglon, nota: 'borrador de un renglón (2 no caben arriba de tu cabeza)'});
			titularInfo.borrador = true;
			titularInfo.origen = intentos[0].nota;
		}
		for (const intento of intentos) {
			const rev = e.voz ? revisarTitular(intento.texto, e.voz) : null;
			if (rev && rev.prohibidas.length > 0) {
				titularInfo.avisos.push(`"${intento.texto.replace('\n', ' / ')}" trae ${rev.prohibidas.map((x) => x.descripcion).join(', ')} (voice.md): no lo uso`);
				continue;
			}
			const c = colocarTitular({texto: intento.texto, t0: 0, t1: duracion}, ctx);
			titularInfo.avisos.push(...c.avisos);
			if (!c.cabe) continue;
			if (typeof forzado === 'object' && forzado?.caja) {
				titularInfo.avisos.push('notas-director.json trae caja para el titular: se usa tal cual (validar.ts revisa que no toque tu cabeza)');
			}
			titular = {texto: intento.texto, desde: 0, hasta: duracion, caja: typeof forzado === 'object' && forzado?.caja ? forzado.caja : c.caja, tapaCabeza: true};
			cajaTitular = c.visible;
			titularInfo.texto = intento.texto;
			titularInfo.origen = intento.nota;
			titularInfo.revision = rev;
			break;
		}
		if (intentos.length > 0 && !titular) avisos.push('el titular no cabe arriba de tu cabeza ni en un renglón: va sin titular (escríbelo más corto en notas-director.json)');
	}

	// ── Agenda: inserts y capas forzadas primero ──
	const agenda: Bloque[] = [];
	const elegidos: Elegido[] = [];
	const reservar = (x: Elegido) => {
		agenda.push(x.bloque);
		elegidos.push(x);
	};

	// Modo de cerca: tu cara más grande que el p90 de tus reels.
	const cercaBase = modoDeCerca(ctx.cara, estilo);
	const cerca: ModoCerca = {...cercaBase, demos: [], sin_demo: []};
	if (cerca.activo) {
		avisos.push(
			`modo de cerca: tu cara mide ${cerca.alto_cara_p50} px de alto (p50 de ${cerca.n_cuadros} cuadros) y el p90 de tus reels es ${cerca.umbral} px. Priorizo las demos en los momentos de acción; tarjetas y stickers siguen a su ritmo, encima de tu barba cuando no caben debajo de la barbilla`,
		);
	}

	// Inserts de las notas (y las demos grabadas que se proponen: en el modo de cerca, las que emparejan con un momento de
	// acción; si no, la del proyecto en el primer momento de acción).
	const pedidosInsert = [...(notas?.inserts ?? [])];
	const propuestas = new Map<string, string>();
	const durDemo = (d: {duracion: number}) => Math.max(0.5, Math.min(d.duracion, estilo.insert.duracion_p90.valor));
	if (cerca.activo) {
		const quitadas = (e.demosDisponibles ?? []).filter((d) => assetQuitado(d.asset, notas?.quitar ?? []));
		for (const d of quitadas) descartes.push({t: 0, palabra: '', que: `demo ${d.asset}`, motivo: `quitada por notas-director.json ("${assetQuitado(d.asset, notas?.quitar ?? [])}"): no se propone ni reserva lugar`});
		const libres = (e.demosDisponibles ?? []).filter((d) => !pedidosInsert.some((x) => x.asset === d.asset) && !quitadas.includes(d));
		for (const d of (e.demosDisponibles ?? []).filter((x) => !x.usable)) avisos.push(`hay una demo en ${d.asset} pero no se puede usar: ${d.motivo}`);
		const momentos = momentosDemo(palabras);
		const pares: EmparejeDemo[] = emparejarDemos(momentos, libres);
		for (const par of pares) {
			const dur = durDemo(par.demo);
			pedidosInsert.push({asset: par.demo.asset, tipo: 'demo', layout: 'pantalla-completa', desde: par.momento.t, duracion: dur, eventos: par.demo.eventos, trim_desde: trimDeDemo(par.demo, dur)});
			propuestas.set(par.demo.asset, `modo de cerca: demo grabada que empareja con «${par.momento.frase}» (${par.momento.accion}; en común: ${par.comunes.join(', ')})`);
			cerca.demos.push({t: r2(par.momento.t), accion: par.momento.accion, frase: par.momento.frase, asset: par.demo.asset, comunes: par.comunes, id: null});
		}
		cerca.sin_demo = momentos.filter((m) => !pares.some((p) => p.momento.t === m.t));
		if (pares.length) avisos.push(`modo de cerca: propongo ${pares.length} demo(s) a pantalla completa (${pares.map((p) => `${p.demo.asset} en ${r2(p.momento.t)} s`).join('; ')}), ${r2(estilo.insert.duracion_p90.valor)} s como máximo (p90 de tus inserts): decide tú en notas-director.json`);
	} else if (e.demo && !pedidosInsert.some((x) => x.asset === e.demo!.asset) && !assetQuitado(e.demo.asset, notas?.quitar ?? [])) {
		if (!e.demo.usable) avisos.push(`hay una demo en ${e.demo.asset} pero no se puede usar: ${e.demo.motivo}`);
		else {
			const momento = momentosDemo(palabras)[0];
			if (momento) {
				pedidosInsert.push({asset: e.demo.asset, tipo: 'demo', layout: 'pantalla-completa', desde: momento.t, duracion: Math.min(e.demo.duracion, 4), eventos: e.demo.eventos, trim_desde: 0});
				propuestas.set(e.demo.asset, 'demo grabada para este proyecto (propuesta)');
				avisos.push(`propongo la demo ${e.demo.asset} en ${r2(momento.t)} s («${momento.frase}», ${momento.accion}) a pantalla completa, 4 s como máximo: decide tú en notas-director.json`);
			}
		}
	}
	// Motions libres: la pista de tu cabeza cuadro por cuadro (cara.json suavizada), para el foco de retrato, la
	// oclusión detrás de tu cabeza y la plantilla que te sigue. Si las notas ya traen una, manda la de las notas.
	const conPista = <M extends {nombre: string; pista?: unknown}>(m: M, s: number, hasta: number): M => {
		if (!esMotionLibre(m.nombre) || m.pista || !ctx.cara) return m;
		const pista = pistaCabeza(
			ctx.cara.cuadros.map((c) => ({t: c.t, cara: c.cara, coronilla_y: c.coronilla_y ?? undefined, barbilla_y: c.barbilla_y ?? undefined, boca_y: c.boca_y ?? undefined, cabeza: c.cabeza ?? null})),
			s,
			hasta,
		);
		return pista ? {...m, pista} : m;
	};
	pedidosInsert.forEach((p, n) => {
		const desde = resolverDesde(palabras, p);
		if (!desde) {
			avisos.push(`insert ${p.asset}: no encontré su momento (${p.desde_palabra ?? p.desde}); no entra`);
			return;
		}
		const s = desde.t;
		const tipo = p.tipo ?? (p.motion || p.asset.startsWith('motion:') ? 'motion' : p.asset.endsWith('.terminal.json') || p.asset.startsWith('demos/') ? 'demo' : /\.(png|jpe?g|webp)$/i.test(p.asset) ? 'imagen' : 'video');
		if (p.layout === 'flotante' && tipo !== 'motion') {
			avisos.push(`insert ${p.asset}: el layout "flotante" es solo para motion graphics (asset "motion:<nombre>"); no entra`);
			return;
		}
		const medio = e.medio?.(p.asset) ?? null;
		let hasta = p.hasta ?? (p.duracion ? s + p.duracion : null);
		if (hasta === null) {
			// Terminal: lo que pide su guion. Toma o video: lo que dure (máx. 6 s). Imagen: 3 s. (Supuestos, dichos.)
			if (tipo === 'motion' && p.motion) hasta = s + duracionMinimaMotion(p.motion);
			else if (p.asset.endsWith('.terminal.json') && medio?.duracion) hasta = s + medio.duracion;
			else if (esMeme(p.asset)) hasta = s + MEME.duracion;
			else if (tipo === 'imagen') hasta = s + 3;
			else if (medio?.duracion) hasta = s + Math.min(medio.duracion - (p.trim_desde ?? 0), 6);
			else hasta = s + 3;
			avisos.push(`insert ${p.asset}: sin hasta ni duración; uso ${r2(hasta - s)} s (${p.asset.endsWith('.terminal.json') ? 'lo que pide su guion' : 'supuesto'})`);
		}
		hasta = Math.min(hasta, duracion);
		if (!(hasta > s)) {
			avisos.push(`insert ${p.asset}: termina antes de empezar; no entra`);
			return;
		}
		const origenAvisos: string[] = [];
		let aspecto: number;
		const esTerminal = p.asset.endsWith('.terminal.json');
		// Terminal: la proporción de su ventana ajustada al guion (medioDe); sin medio, la de por defecto (960×1100).
		if (tipo === 'motion') aspecto = ESCENA.alto / ESCENA.ancho;
		else if (esTerminal) aspecto = medio && medio.ancho > 0 ? medio.alto / medio.ancho : 1100 / 960;
		else if (tipo === 'demo') aspecto = (p.encuadre ?? 'horizontal') === 'horizontal' ? 625 / 1000 : 1125 / 900;
		else if (medio && medio.ancho > 0) aspecto = medio.alto / medio.ancho;
		else {
			aspecto = 9 / 16;
			origenAvisos.push('no pude leer su proporción: supongo 16:9');
		}
		// Ancho por defecto: el de cada componente (terminal 960, demo 1000 horizontal o 900 vertical; Reel.tsx) o el medido (770).
		const anchoPorTipo = tipo === 'motion' ? TARJETA_MOTION.ancho : esTerminal ? 960 : tipo === 'demo' ? ((p.encuadre ?? 'horizontal') === 'horizontal' ? 1000 : 900) : undefined;
		const c = colocarInsert({t0: s, t1: hasta, layout: p.layout, aspecto, anchoDeseado: p.ancho ?? anchoPorTipo, evitar: cajaTitular ? [cajaTitular] : [], meme: p.layout === 'tarjeta' && esMeme(p.asset)}, ctx);
		origenAvisos.push(...c.avisos);
		let texto = p.texto ?? null;
		if (texto && p.layout === 'tarjeta' && !c.tapaCabeza) {
			origenAvisos.push(`su texto ("${texto}") iría encima de tu cara (Insert.tsx lo pone a la altura de las tarjetas): lo quito; ponlo como tarjeta antes o después`);
			texto = null;
		}
		const caja = c.caja ? (tipo === 'demo' ? {x: c.caja.x, y: c.caja.y, w: c.caja.w, h: c.caja.h} : {x: c.caja.x, y: c.caja.y, w: c.caja.w}) : undefined;
		const insert: Edicion['inserts'][number] = {
			id: `b${n + 1}`,
			tipo,
			desde: r3(s),
			hasta: r3(hasta),
			asset: p.asset,
			trim_desde: p.trim_desde ?? 0,
			layout: p.layout,
			...(p.encuadre ? {encuadre: p.encuadre} : {}),
			...(caja ? {caja} : {}),
			tapaCabeza: c.tapaCabeza,
			texto,
			eventos: p.eventos ?? (tipo === 'demo' && !esTerminal ? p.asset.replace(/toma\.mp4$/, 'eventos.json') : null),
			audio: p.audio ?? {modo: 'mute', ganancia_db: 0},
			sfx: null,
			...(tipo === 'motion' && p.motion ? {motion: conPista(p.motion, s, hasta)} : {}),
		};
		const choca = cabeEnAgenda(agenda, {s, dmin: hasta - s}, 0);
		if (choca) avisos.push(`insert ${p.asset} se encima con otro insert (${choca}): lo dejo, pero revísalo`);
		reservar({
			bloque: {clave: insert.id, s, dmin: hasta - s, edes: hasta, tipo: 'insert'},
			cand: null,
			insert: {...insert, origenAvisos},
			origen: propuestas.has(p.asset) ? 'borrador' : 'notas',
			motivo: propuestas.get(p.asset) ?? 'notas-director.json',
			alternativas: [],
			palabra: typeof p.desde_palabra === 'string' ? p.desde_palabra : desde.i0 !== null && desde.i0 >= 0 && palabras[desde.i0] ? palabras[desde.i0].t : `${r2(s)} s`,
			frase: '',
		});
	});

	// Tarjetas y stickers forzados. Las forzadas con el mismo `grupo` van juntas como lista (aparecen en su momento y
	// se van juntas); el layout decide si van en columna, en árbol o en fila.
	const gruposForzados = new Map<string, Array<{f: Notas['tarjetas_forzadas'][number]; d: NonNullable<ReturnType<typeof resolverDesde>>}>>();
	for (const f of notas?.tarjetas_forzadas ?? []) {
		const d = resolverDesde(palabras, f);
		if (!d) {
			avisos.push(`tarjeta forzada "${f.texto}": no encontré su momento; no entra`);
			continue;
		}
		if (f.grupo) {
			const g = gruposForzados.get(f.grupo) ?? [];
			g.push({f, d});
			gruposForzados.set(f.grupo, g);
			continue;
		}
		const palabraF = typeof f.desde_palabra === 'string' ? f.desde_palabra : d.i0 !== null && d.i0 >= 0 ? palabras[d.i0].t : `${r2(d.t)} s`;
		if (f.variante === 'prompt') {
			// Prompt (tecleo.ts): si es largo, va en tarjetas seguidas de ≤ 4 renglones; cada una se queda lo que tarda en
			// escribirse más un respiro para leerla. Con "hasta" en las notas, ese tiempo se reparte en proporción.
			const partes = partirPrompt(f.texto);
			// Al compás de tu voz: si encuentro el prompt en lo que dices (desde su palabra), cada palabra se escribe
			// cuando la dices y cada parte arranca cuando empiezas a decir su primera palabra.
			const al = d.i0 !== null && d.i0 >= 0 && f.entrada !== 'corte' && f.entrada !== 'pop' ? alinearPrompt(f.texto, palabras, d.i0, f.hasta) : null;
			if (al) {
				const rangos = rangosDePartes(partes);
				const vacia = ctx.estiloTarjeta.escritura.cuadros_vacia_prompt / 30;
				const inicios = rangos.map((r, k) => {
					const tLetra = tiempoDeCaracter(al.puntos, r.A);
					// La 1.ª: la caja sale sus cuadros vacía antes de la primera letra (nunca antes de su palabra de las notas).
					// Las demás: el corte cae cuando empiezas a decir su primera palabra.
					return k === 0 ? Math.max(d.t, tLetra - vacia) : Math.max(d.t, tLetra);
				});
				const tFinVoz = tiempoDeCaracter(al.puntos, rangos.at(-1)!.B);
				const fin = f.hasta ?? Math.min(duracion, tFinVoz + LECTURA_PROMPT_S);
				if (f.hasta !== undefined && f.hasta - tFinVoz < LECTURA_PROMPT_S - 1e-9)
					avisos.push(`prompt "${f.texto.slice(0, 40)}…": terminas de dictarlo en ${r2(tFinVoz)} s y la tarjeta se va en ${r2(f.hasta)} s, así que queda completo ${r2(Math.max(0, f.hasta - tFinVoz))} s (para leerlo pide ${LECTURA_PROMPT_S} s): alarga su "hasta" en notas-director.json si cabe`);
				if (al.emparejadas < al.palabras.length) avisos.push(`prompt "${f.texto.slice(0, 40)}…": ${al.palabras.length - al.emparejadas} de ${al.palabras.length} palabras no están en tu voz (${al.palabras.filter((p) => p.d === null).map((p) => `"${p.w}"`).join(', ')}); se escriben parejo entre sus vecinas`);
				partes.forEach((texto, k) => {
					const s = r3(inicios[k]);
					const edes = k === partes.length - 1 ? fin : inicios[k + 1];
					reservar({
						bloque: {clave: `forzada:${f.texto}#${k}`, s, dmin: edes - s, edes, tipo: 'tarjeta'},
						cand: null,
						tarjetas: [{texto, t: s, variante: 'prompt', entrada: f.entrada, alineacion: {al, A: rangos[k].A, B: rangos[k].B}}],
						origen: 'notas',
						motivo: `${partes.length > 1 ? `notas-director.json (prompt largo, parte ${k + 1} de ${partes.length})` : 'notas-director.json (tarjeta forzada)'}, escrito al compás de tu voz (${al.emparejadas} de ${al.palabras.length} palabras)`,
						alternativas: [],
						palabra: partes.length > 1 && k > 0 ? `${palabraF} (parte ${k + 1})` : palabraF,
						frase: '',
					});
				});
				continue;
			}
			const tiempos = partes.map((p) => tiempoPrompt(p, ctx.estiloTarjeta));
			const total = tiempos.reduce((a, b) => a + b, 0);
			const fin = f.hasta ?? (partes.length > 1 ? d.t + total : d.t + Math.max(tP50, dminTarjeta(f.texto), total));
			const escala = partes.length > 1 ? (fin - d.t) / total : 1;
			if (partes.length > 1 && f.hasta !== undefined && escala < 1 - 1e-9) avisos.push(`prompt "${f.texto.slice(0, 40)}…": en ${r2(fin - d.t)} s no alcanza a escribirse y leerse en ${partes.length} tarjetas (pide ${r2(total)} s); se escribe más rápido`);
			let s0 = d.t;
			partes.forEach((texto, k) => {
				const edes = k === partes.length - 1 ? fin : s0 + tiempos[k] * escala;
				reservar({
					bloque: {clave: `forzada:${f.texto}#${k}`, s: s0, dmin: edes - s0, edes, tipo: 'tarjeta'},
					cand: null,
					tarjetas: [{texto, t: s0, variante: 'prompt', entrada: f.entrada}],
					origen: 'notas',
					motivo: partes.length > 1 ? `notas-director.json (prompt largo, parte ${k + 1} de ${partes.length})` : 'notas-director.json (tarjeta forzada)',
					alternativas: [],
					palabra: partes.length > 1 && k > 0 ? `${palabraF} (parte ${k + 1})` : palabraF,
					frase: '',
				});
				s0 = edes;
			});
			continue;
		}
		const dmin = dminTarjeta(f.texto);
		const edes = f.hasta ?? d.t + Math.max(tP50, dmin);
		reservar({
			bloque: {clave: `forzada:${f.texto}`, s: d.t, dmin: Math.min(dmin, edes - d.t), edes, tipo: 'tarjeta'},
			cand: null,
			tarjetas: [{texto: f.texto, t: d.t, variante: f.variante, entrada: f.entrada}],
			origen: 'notas',
			motivo: 'notas-director.json (tarjeta forzada)',
			alternativas: [],
			palabra: palabraF,
			frase: '',
		});
	}
	for (const [grupo, miembros] of gruposForzados) {
		miembros.sort((a, b) => a.d.t - b.d.t);
		const s0 = miembros[0].d.t;
		const ultimo = miembros.at(-1)!;
		const edes = Math.max(...miembros.map((m) => m.f.hasta ?? m.d.t + Math.max(tP50, dminTarjeta(m.f.texto))));
		reservar({
			bloque: {clave: `forzada-lista:${grupo}`, s: s0, dmin: Math.min(ultimo.d.t - s0 + dminTarjeta(ultimo.f.texto), edes - s0), edes, tipo: 'lista'},
			cand: null,
			tarjetas: miembros.map((m) => ({texto: m.f.texto, t: m.d.t, variante: m.f.variante, entrada: m.f.entrada})),
			origen: 'notas',
			motivo: `notas-director.json (lista forzada "${grupo}")`,
			alternativas: [],
			palabra: miembros.map((m) => m.f.texto).join(' / '),
			frase: '',
		});
	}
	for (const f of notas?.stickers_forzados ?? []) {
		const d = resolverDesde(palabras, f);
		const entrada = e.catalogos.mascotas.find((c) => c.id === f.id_catalogo || c.archivo === f.asset) ?? e.catalogos.logos.find((c) => c.id === f.id_catalogo || c.archivo === f.asset) ?? e.catalogos.ia?.find((c) => c.id === f.id_catalogo || c.archivo === f.asset);
		if (!d || !entrada) {
			avisos.push(`sticker forzado ${f.id_catalogo ?? f.asset}: ${!d ? 'no encontré su momento' : 'no está en los catálogos'}; no entra`);
			continue;
		}
		const edes = f.hasta ?? d.t + sP50;
		const esLogo = e.catalogos.logos.some((l) => l.id === entrada.id);
		const opcion: OpcionSticker = {id: entrada.id, archivo: entrada.archivo, png: {ancho: entrada.ancho, alto: entrada.alto, tinta: entrada.caja_tinta}, pose: 'pose' in entrada ? entrada.pose : null, ojos: 'ojos' in entrada ? entrada.ojos : null, coincidencias: 1, nota: 'notas-director.json'};
		reservar({
			bloque: {clave: `forzado:${entrada.id}`, s: d.t, dmin: Math.min(sP10, edes - d.t), edes, tipo: 'sticker'},
			cand: null,
			opciones: [opcion],
			anchoSticker: f.ancho,
			// Un logo forzado sin ancho puede achicarse hasta el piso de logos (en tomas de cerca, la zona libre es chica).
			anchoMinSticker: esLogo ? anchoMinimoLogo(estilo) : undefined,
			origen: 'notas',
			motivo: 'notas-director.json (sticker forzado)',
			alternativas: [],
			palabra: typeof f.desde_palabra === 'string' ? f.desde_palabra : d.i0 !== null && d.i0 >= 0 ? palabras[d.i0].t : `${r2(d.t)} s`,
			frase: '',
		});
	}

	// ── Candidatos del borrador ──
	const marcas = detectarMarcas(palabras, {terminos: e.terminos, logos: e.catalogos.logos});
	const candidatos: Candidato[] = quitarPorTexto(
		[...(sinTarjetas ? [] : [...candidatosTarjetas(palabras, marcas, e.terminos), ...candidatosListas(palabras)]), ...(sinStickers ? [] : candidatosStickers(palabras, marcas))],
		notas?.quitar ?? [],
		descartes,
		avisos,
	).sort((a, b) => b.puntaje - a.puntaje || a.t - b.t || a.clave.localeCompare(b.clave));
	let nTarjetas = elegidos.reduce((s, x) => s + (x.tarjetas?.length ?? 0), 0);
	let nStickers = elegidos.filter((x) => x.opciones).length;

	// Se elige de uno en uno: primero el de más puntaje; si empatan (± 0.5), gana el tipo que va más atrás de su
	// ritmo objetivo (así los stickers no se comen a las tarjetas: en tus reels hay ~2.8 tarjetas por sticker).
	const pendientes = [...candidatos];
	// Gancho: en tus reels la primera capa aparece a los ~0.7 s (p90 ~1.3 s, ritmo.primera_capa_s). Mientras nada
	// arranque antes de ese p90, lo que cae ahí va primero (BONO_GANCHO), así el arranque no se queda vacío.
	const primera = estilo.ritmo.primera_capa_s;
	const finGancho = primera.valor === null ? null : (primera.p90 ?? primera.valor);
	const ganchoCubierto = (): boolean => finGancho === null || elegidos.some((x) => x.bloque.s <= finGancho + 1e-9);
	const siguienteCandidato = (): Candidato | undefined => {
		const llenoT = objetivoT > 0 ? nTarjetas / objetivoT : 1;
		const llenoS = objetivoS > 0 ? nStickers / objetivoS : 1;
		const conGancho = !ganchoCubierto();
		let mejor = -1;
		let mejorPrioridad = -Infinity;
		pendientes.forEach((c, k) => {
			const esSticker = c.tipo === 'sticker';
			const atrasado = esSticker ? llenoS < llenoT : llenoT < llenoS;
			const prioridad = c.puntaje + (atrasado ? 0.5 : 0) + (conGancho && c.t <= finGancho! + 1e-9 ? BONO_GANCHO : 0);
			if (prioridad > mejorPrioridad + 1e-9 || (Math.abs(prioridad - mejorPrioridad) <= 1e-9 && c.t < pendientes[mejor].t)) {
				mejor = k;
				mejorPrioridad = prioridad;
			}
		});
		return mejor >= 0 ? pendientes.splice(mejor, 1)[0] : undefined;
	};
	/** Lo que ya ocupa ese lugar de la agenda, en palabras ("sticker «gratis,» (19.39 s)"). */
	const quien = (clave: string): string => {
		const x = elegidos.find((y) => y.bloque.clave === clave);
		if (!x) return clave;
		const que = x.insert ? `insert ${x.insert.asset}` : x.opciones ? 'sticker' : x.tarjetas && x.tarjetas.length > 1 ? 'lista' : `tarjeta "${x.tarjetas?.[0]?.texto ?? ''}"`;
		return `${que} «${x.palabra}» (${r2(x.bloque.s)} s)`;
	};
	for (let c = siguienteCandidato(); c; c = siguienteCandidato()) {
		const s = c.t + desfase;
		const que = c.tipo === 'sticker' ? `sticker (${c.sticker!.concepto})` : c.tipo === 'lista' ? `lista: ${c.items!.map((i) => i.texto).join(' / ')}` : `tarjeta "${c.texto}"`;
		const descartar = (motivo: string) => descartes.push({t: r2(c.t), palabra: c.palabra, que, motivo});
		if (c.puntaje <= 0) {
			descartar('pesa 0 (concepto muy repetido)');
			continue;
		}
		if (c.tipo === 'sticker') {
			if (nStickers >= objetivoS) {
				descartar(`ya hay ${nStickers} stickers (ritmo objetivo ${objetivoS} en ${r2(duracion)} s)`);
				continue;
			}
			const dmin = sP10;
			const edes = Math.min(duracion, s + sP50);
			if (s + dmin > duracion) {
				descartar('no alcanza a durar antes del final');
				continue;
			}
			const choca = cabeEnAgenda(agenda, {s, dmin}, sep);
			if (choca) {
				descartar(`choca con ${quien(choca)}: van en la misma banda, una a la vez, ≥ ${sep} s entre inicios`);
				continue;
			}
			// Contexto: lo que dijiste en ±1.5 s (sin palabras de función) también cuenta para elegir la mascota.
			const contexto = palabras.filter((p) => Math.abs(p.d - c.t) <= 1.5).map((p) => normalizar(limpiar(p.t))).filter((w) => w.length > 2);
			const opciones = opcionesSticker(c.sticker!, e.catalogos, e.semilla, contexto);
			if (opciones.length === 0) {
				descartar('no hay sticker en el catálogo con esas etiquetas');
				continue;
			}
			// Logo de marca (su primera mención): puede achicarse hasta el piso de logos antes de quitarse; si cabe, la
			// tarjeta con el nombre de la marca (mismo momento, menos puntaje) choca con él y cede su lugar.
			const anchoMin = c.sticker!.logo ? anchoMinimoLogo(estilo) : undefined;
			const caben = opciones.filter((o) => colocarSticker({id: c.clave, t0: s, t1: edes, png: o.png, escalaMax: escalaMaxSticker('pop', null, ctx.estiloSticker), anchoMinimo: anchoMin}, ctx).caja);
			if (caben.length === 0) {
				const prueba = colocarSticker({id: c.clave, t0: s, t1: edes, png: opciones[0].png, anchoMinimo: anchoMin}, ctx);
				descartar(`ninguna de sus ${opciones.length} opciones cabe: ${prueba.avisos.join('; ')}`);
				continue;
			}
			reservar({
				bloque: {clave: c.clave, s, dmin, edes, tipo: 'sticker'},
				cand: c,
				opciones: caben,
				anchoMinSticker: anchoMin,
				origen: 'borrador',
				motivo: c.motivo,
				alternativas: [...c.alternativas, ...caben.slice(1, 4).map((o) => o.id)],
				palabra: c.palabra,
				frase: c.frase,
			});
			nStickers++;
			continue;
		}
		// Tarjeta o lista
		const items = c.tipo === 'lista' ? c.items!.map((i) => ({texto: i.texto, t: i.t + desfase})) : [{texto: c.texto!, t: s}];
		if (nTarjetas + items.length > objetivoT) {
			descartar(`ya hay ${nTarjetas} tarjetas (ritmo objetivo ${objetivoT} en ${r2(duracion)} s)`);
			continue;
		}
		const ultimo = items.at(-1)!;
		const dmin = ultimo.t - s + dminTarjeta(ultimo.texto);
		const edes = Math.min(duracion, ultimo.t + Math.max(tP50, dminTarjeta(ultimo.texto)));
		if (s + dmin > duracion) {
			descartar('no alcanza a durar antes del final');
			continue;
		}
		const choca = cabeEnAgenda(agenda, {s, dmin}, sep);
		if (choca) {
			descartar(`choca con ${quien(choca)}: van en la misma banda, una a la vez, ≥ ${sep} s entre inicios`);
			continue;
		}
		let modoLista: Elegido['modoLista'] = null;
		if (c.tipo === 'lista') {
			const l = colocarLista({id: c.clave, t0: s, t1: edes, textos: items.map((i) => i.texto)}, ctx);
			if (l.modo === 'secuencial') {
				descartar(`la lista no cabe debajo de tu barbilla ni apilada ni en fila (${l.avisos.join('; ')})`);
				continue;
			}
			modoLista = l.modo;
		} else {
			const t = colocarTarjeta({id: c.clave, t0: s, t1: edes, texto: c.texto!}, ctx);
			if (!t.caja) {
				descartar(t.avisos.join('; '));
				continue;
			}
		}
		reservar({bloque: {clave: c.clave, s, dmin, edes, tipo: c.tipo === 'lista' ? 'lista' : 'tarjeta'}, cand: c, tarjetas: items, modoLista, origen: 'borrador', motivo: c.motivo, alternativas: c.alternativas, palabra: c.palabra, frase: c.frase});
		nTarjetas += items.length;
	}

	// ── Ids en orden de tiempo (estables: "quitar" de las notas se refiere a ellos) ──
	elegidos.sort((a, b) => a.bloque.s - b.bloque.s || a.bloque.clave.localeCompare(b.bloque.clave));
	let nt = 0;
	let nk = 0;
	let ng = 0;
	const ids = elegidos.map((x) => {
		if (x.insert) return [x.insert.id];
		if (x.opciones) return [`k${++nk}`];
		return (x.tarjetas ?? []).map(() => `t${++nt}`);
	});
	const quitar = new Set((notas?.quitar ?? []).filter((q) => ID_DEL_BORRADOR.test(q)));
	const existentes = new Set(ids.flat());
	for (const id of quitar) if (!existentes.has(id)) avisos.push(`notas-director.json pide quitar "${id}", pero no existe en este borrador`);
	if (quitar.size > 0) avisos.push(`notas-director.json quita por id (${[...quitar].join(', ')}): los ids se recorren si cambia el borrador; quitar por texto ("Minutos", "sticker:dinero") es estable`);
	const vivos: Array<{x: Elegido; ids: string[]}> = [];
	elegidos.forEach((x, k) => {
		const quedan = ids[k].filter((id) => !quitar.has(id));
		if (quedan.length < ids[k].length) descartes.push({t: r2(x.bloque.s), palabra: x.palabra, que: ids[k].filter((id) => quitar.has(id)).join(', '), motivo: 'quitado por notas-director.json'});
		if (quedan.length === 0) return;
		if (x.tarjetas && quedan.length < ids[k].length) {
			const tarjetasQuedan = x.tarjetas.filter((_, q) => !quitar.has(ids[k][q]));
			vivos.push({x: {...x, tarjetas: tarjetasQuedan, bloque: {...x.bloque, s: tarjetasQuedan[0].t}}, ids: quedan});
		} else vivos.push({x, ids: quedan});
	});

	// ── Pasada final en orden de tiempo: duraciones, cajas y poses ──
	const inicios = vivos.map((v) => v.x.bloque.s);
	const tarjetas: Edicion['tarjetas'] = [];
	const stickers: Edicion['stickers'] = [];
	const inserts: Edicion['inserts'] = [];
	const decisiones: Decision[] = [];
	let poseAnterior: string | null = null;
	const usados = new Set<string>();
	/** El último sticker puesto: sus opciones (para cambiarlo si el siguiente solo puede repetir su pose). */
	let ultimoSticker: {k: number; d: number; x: Elegido; t0: number; fin: number; poseAntes: string | null} | null = null;
	vivos.forEach(({x, ids: misIds}, idx) => {
		const siguiente = inicios.slice(idx + 1).find((s) => s > x.bloque.s + 1e-9) ?? Infinity;
		// Si lo que sigue entra a 3 cuadros o menos de que esto acabe, esto se queda hasta que entre: 2–3 cuadros de
		// tu cara sola entre dos capas se ven como un parpadeo (en tus reels pasan de una a otra en corte).
		const hasta = Math.min(x.bloque.edes, siguiente, duracion);
		const fin = r3(siguiente < Infinity && siguiente - hasta > 0 && siguiente - hasta <= HUECO_PARPADEO_S + 1e-9 ? Math.min(siguiente, duracion) : hasta);
		if (x.insert) {
			const {origenAvisos, ...ins} = x.insert;
			// Mismo criterio que arriba: si lo que sigue entra a 3 cuadros o menos, el insert se queda hasta que entre
			// (siempre que su toma alcance: trim + duración ≤ lo que dura).
			const hueco = siguiente - ins.hasta;
			const largo = e.medio?.(ins.asset)?.duracion ?? null;
			const alcanza = largo === null || (ins.trim_desde ?? 0) + (siguiente - ins.desde) <= largo - 1 / 30 + 1e-9;
			if (siguiente < Infinity && hueco > 1e-6 && hueco <= HUECO_PARPADEO_S + 1e-9 && alcanza) ins.hasta = r3(Math.min(siguiente, duracion));
			inserts.push(ins);
			decisiones.push({id: ins.id, tipo: 'insert', t: ins.desde, hasta: ins.hasta, palabra: x.palabra, frase: x.frase, que: `${ins.tipo} ${ins.asset} (${ins.layout}${ins.tapaCabeza ? ', tapa la cabeza' : ''})`, motivo: x.motivo, alternativas: [], avisos: origenAvisos, origen: x.origen});
			return;
		}
		if (x.opciones) {
			const id = misIds[0];
			const t0 = x.bloque.s;
			let elegido: {o: OpcionSticker; caja: {x: number; y: number; w: number}; avisos: string[]} | null = null;
			const avisosK: string[] = [];
			// Variedad: lo que ya salió en este video va al final de la fila (sin dejar de ser opción).
			const enOrden = [...x.opciones.filter((o) => !usados.has(o.id)), ...x.opciones.filter((o) => usados.has(o.id))];
			for (const o of enOrden) {
				if (o.pose && poseAnterior && o.pose === poseAnterior) {
					avisosK.push(`${o.id} repetiría la pose "${o.pose}" del sticker anterior`);
					continue;
				}
				const c = colocarSticker({id, t0, t1: fin, png: o.png, anchoDeseado: x.anchoSticker, anchoMinimo: x.anchoMinSticker}, ctx);
				if (c.caja) {
					elegido = {o, caja: c.caja, avisos: c.avisos};
					break;
				}
				avisosK.push(`${o.id}: ${c.avisos.join('; ')}`);
			}
			// Si lo único que lo impide es repetir la pose del sticker anterior, se cambia el anterior por otra de sus
			// opciones (con otra pose, que tampoco repita la del suyo) y se vuelve a intentar.
			if (!elegido && ultimoSticker && x.opciones.some((o) => o.pose === poseAnterior)) {
				const u = ultimoSticker;
				const posesAqui = new Set(x.opciones.map((o) => o.pose));
				for (const o of u.x.opciones ?? []) {
					if (o.id === stickers[u.k].asset || o.archivo === stickers[u.k].asset) continue;
					if (o.pose && (o.pose === u.poseAntes || posesAqui.has(o.pose))) continue;
					const c = colocarSticker({id: stickers[u.k].id, t0: u.t0, t1: u.fin, png: o.png, anchoDeseado: u.x.anchoSticker, anchoMinimo: u.x.anchoMinSticker}, ctx);
					if (!c.caja) continue;
					stickers[u.k] = {...stickers[u.k], asset: o.archivo, mascota: o.pose ? {pose: o.pose, ojos: o.ojos ?? 'normales', anim: 'ninguna'} : null, caja: c.caja};
					decisiones[u.d] = {...decisiones[u.d], que: `${o.id} (${o.nota})`, avisos: [`cambiado para que ${id} no repita pose`, ...c.avisos]};
					poseAnterior = o.pose ?? null;
					usados.add(o.id);
					break;
				}
				for (const o of enOrden) {
					if (o.pose && poseAnterior && o.pose === poseAnterior) continue;
					const c = colocarSticker({id, t0, t1: fin, png: o.png, anchoDeseado: x.anchoSticker, anchoMinimo: x.anchoMinSticker}, ctx);
					if (c.caja) {
						elegido = {o, caja: c.caja, avisos: c.avisos};
						break;
					}
				}
			}
			if (!elegido) {
				descartes.push({t: r2(t0), palabra: x.palabra, que: `sticker ${id}`, motivo: `al acomodarlo ya no hubo opción: ${avisosK.join('; ')}`});
				return;
			}
			stickers.push({
				id,
				desde: r3(t0),
				hasta: fin,
				asset: elegido.o.archivo,
				mascota: elegido.o.pose ? {pose: elegido.o.pose, ojos: elegido.o.ojos ?? 'normales', anim: 'ninguna'} : null,
				caja: elegido.caja,
				entrada: 'pop',
				salida: 'corte',
				tapaCabeza: false,
				sfx: null,
			});
			const poseAntes = poseAnterior;
			poseAnterior = elegido.o.pose ?? null;
			usados.add(elegido.o.id);
			const final = elegido;
			decisiones.push({id, tipo: 'sticker', t: r3(t0), hasta: fin, palabra: x.palabra, frase: x.frase, que: `${final.o.id} (${final.o.nota})`, motivo: x.motivo, alternativas: x.alternativas.filter((a) => a !== final.o.id), avisos: [...avisosK.filter((a) => a.includes('repetiría')), ...final.avisos], origen: x.origen});
			ultimoSticker = {k: stickers.length - 1, d: decisiones.length - 1, x, t0, fin, poseAntes};
			return;
		}
		const items = x.tarjetas ?? [];
		if (items.length === 1) {
			const id = misIds[0];
			const t = colocarTarjeta({t0: items[0].t, t1: fin, texto: items[0].texto, variante: items[0].variante}, ctx);
			if (!t.caja) {
				descartes.push({t: r2(items[0].t), palabra: x.palabra, que: `tarjeta "${items[0].texto}"`, motivo: t.avisos.join('; ')});
				return;
			}
			const entrada = items[0].entrada ?? (items[0].variante === 'prompt' ? 'escritura' : 'corte');
			const ali = items[0].alineacion;
			// Horario de escritura al compás de tu voz (acotado a lo que de verdad dura la tarjeta).
			const escritura = ali && entrada === 'escritura' ? horarioDeParte(ali.al, ali.A, ali.B, r3(items[0].t), fin) : undefined;
			tarjetas.push({id, desde: r3(items[0].t), hasta: fin, texto: items[0].texto, caja: t.caja, grupo: null, variante: items[0].variante ?? 'normal', entrada, ...(escritura ? {escritura} : {}), tapaCabeza: false, sfx: null});
			decisiones.push({id, tipo: 'tarjeta', tipo_palabra: x.cand?.tipo_palabra, t: r3(items[0].t), hasta: fin, palabra: x.palabra, frase: x.frase, que: `tarjeta "${items[0].texto.replace(/\n/g, ' / ')}"${t.renglones > 1 ? ` (${t.renglones} renglones)` : ''}`, motivo: x.motivo, alternativas: x.alternativas, avisos: t.avisos, origen: x.origen});
			return;
		}
		if (items.length === 0) return;
		const l = colocarLista({t0: items[0].t, t1: fin, textos: items.map((i) => i.texto)}, ctx);
		if (l.modo === null || l.modo === 'secuencial') {
			descartes.push({t: r2(items[0].t), palabra: x.palabra, que: `lista: ${items.map((i) => i.texto).join(' / ')}`, motivo: l.avisos.join('; ')});
			return;
		}
		ng++;
		// Todas las de una lista van en un grupo (aparecen en su palabra y se van juntas). En columna se apilan solas; en
		// árbol o en fila llevan su `fila` y caja.x = 540: Tarjeta.tsx centra cada renglón en el promedio de sus caja.x.
		const grupo = `g${ng}`;
		const conFila = l.modo === 'arbol' || l.modo === 'fila';
		items.forEach((it, k) => {
			const c = l.cajas[k];
			tarjetas.push({id: misIds[k], desde: r3(it.t), hasta: fin, texto: it.texto, caja: {x: conFila ? BASE_X : c.x, y: c.y, escala: c.escala}, grupo, ...(conFila ? {fila: c.fila} : {}), variante: 'normal', entrada: it.entrada ?? 'corte', tapaCabeza: false, sfx: null});
		});
		const modoTexto = l.modo === 'arbol' ? 'en árbol (1 arriba y las demás lado a lado)' : l.modo === 'fila' ? 'en fila, lado a lado' : 'en columna';
		decisiones.push({id: misIds.join(', '), tipo: 'tarjeta', tipo_palabra: 'lista', t: r3(items[0].t), hasta: fin, palabra: x.palabra, frase: x.frase, que: `lista ${modoTexto} (${grupo}): ${items.map((i) => `"${i.texto}"`).join(', ')}`, motivo: x.motivo, alternativas: x.alternativas, avisos: l.avisos, origen: x.origen});
	});

	// Alternativas para Claude: lo que se descartó en ese mismo momento ("también se pudo: tarjeta "Gratis"").
	for (const d of decisiones) {
		// Solo lo que sí se podía poner (lo que chocó con esta capa o no entró por el ritmo), no lo que no cabe.
		const mismas = descartes.filter((x) => x.t >= d.t - 0.3 && x.t < d.hasta && /^choca con|ritmo objetivo/.test(x.motivo)).map((x) => x.que);
		for (const que of [...new Set(mismas)].slice(0, 3)) if (!d.alternativas.includes(que)) d.alternativas.push(`también se pudo: ${que}`);
	}
	const tarjetasF = tarjetas;
	const stickersF = stickers;
	const insertsF = inserts;
	const efectos = desenfoques(tarjetasF, estilo, duracion, avisos);
	// Modo de cerca: el id de cada demo propuesta que sí entró.
	for (const d of cerca.demos) d.id = insertsF.find((i) => i.asset === d.asset)?.id ?? null;
	// Tipos de palabra de las tarjetas que entraron (las de una lista cuentan como "clave", como en tus reels).
	const tiposTarjeta: Record<string, number> = {};
	for (const d of decisiones.filter((x) => x.tipo === 'tarjeta')) {
		const n = d.id.split(', ').length;
		const tipo = d.tipo_palabra === 'lista' ? 'clave' : (d.tipo_palabra ?? (d.origen === 'notas' ? 'notas' : 'clave'));
		tiposTarjeta[tipo] = (tiposTarjeta[tipo] ?? 0) + n;
	}
	return {
		titular,
		tarjetas: tarjetasF,
		stickers: stickersF,
		inserts: insertsF,
		efectos,
		decisiones,
		descartes: descartes.sort((a, b) => a.t - b.t),
		demos: momentosDemo(palabras),
		titularInfo,
		avisos,
		cerca,
		ritmo: {
			duracion_s: r2(duracion),
			tarjetas: tarjetasF.length,
			stickers: stickersF.length,
			inserts: insertsF.length,
			tarjetas_por_min: r2((tarjetasF.length * 60) / duracion),
			stickers_por_min: r2((stickersF.length * 60) / duracion),
			objetivo_tarjetas: objetivoT,
			objetivo_stickers: objetivoS,
			tipos_tarjeta: tiposTarjeta,
		},
	};
}

/** Radio del desenfoque de énfasis (px base). SUPUESTO: en tus reels solo se midió la rampa (MEDICIONES_CAPAS.desenfoque_rampa, n = 1). */
export const INTENSIDAD_DESENFOQUE = 14;

/**
 * Desenfoque de énfasis: solo si tu estilo mide que lo usas (frecuencia > 0). Máximo 1 cada 30 s y siempre debajo de
 * tarjetas (las listas primero): dura lo que se ven esas tarjetas. Sin medida → ninguno.
 */
export function desenfoques(tarjetas: Edicion['tarjetas'], estilo: EstiloDirector, duracion: number, avisos: string[]): Edicion['efectos'] {
	const f = estilo.desenfoque_por_min;
	if (f.valor === null || !(f.valor > 0)) return [];
	const cuantos = Math.min(Math.round((f.valor * duracion) / 60), Math.floor(duracion / 30));
	if (cuantos <= 0) return [];
	// Bloques de tarjetas que se ven juntas (grupo o fila que se va al mismo tiempo), las listas primero.
	const bloques = new Map<string, {desde: number; hasta: number; n: number}>();
	for (const t of tarjetas) {
		const clave = t.grupo ?? `hasta:${t.hasta}`;
		const b = bloques.get(clave);
		bloques.set(clave, b ? {desde: Math.min(b.desde, t.desde), hasta: Math.max(b.hasta, t.hasta), n: b.n + 1} : {desde: t.desde, hasta: t.hasta, n: 1});
	}
	const orden = [...bloques.values()].sort((a, b) => b.n - a.n || a.desde - b.desde);
	const elegidos: Array<{desde: number; hasta: number}> = [];
	for (const b of orden) {
		if (elegidos.length >= cuantos) break;
		if (elegidos.some((x) => Math.abs(x.desde - b.desde) < 30)) continue;
		elegidos.push(b);
	}
	if (elegidos.length) avisos.push(`desenfoque de énfasis en ${elegidos.length} momento(s) con tarjetas (tu estilo: ${f.valor}/min; radio ${INTENSIDAD_DESENFOQUE} px, supuesto)`);
	return elegidos
		.sort((a, b) => a.desde - b.desde)
		.map((x, k) => ({id: `e${k + 1}`, tipo: 'desenfoque' as const, desde: x.desde, hasta: x.hasta, intensidad: INTENSIDAD_DESENFOQUE}));
}
