// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Subtítulos (etapa 9 de /editar): agrupa las palabras de la base en subtítulos de una línea de 2–3 palabras.
 *
 *   npx tsx herramientas/subtitulos.ts <slug> [--estilo estilo/mini-estilo.json] [--fuente tiktok-sans|instrument-sans|inter]
 *                                             [--resaltar 3,17,25] [--adelanto-cuadros 1]
 *                                             [--min-palabras 2] [--max-palabras 3] [--escala-min 0.91]
 *
 * Entra: proyectos/<slug>/transcripcion-base.json, las palabras ya remapeadas a la base:
 *   {"palabras": [{"i", "t", "d", "h", "tramo"}, …], "velocidad"?}   (también acepta el arreglo solo)
 *   - d/h en segundos de la base (ya acelerada); "tramo" = índice del tramo de keep[] del que salió la palabra.
 *   - Los bordes de los tramos salen de "keep" (si viene en ese archivo) o de proyectos/<slug>/cortes.json
 *     ({"keep": [{"desde", "hasta"}]} en segundos del ORIGINAL, lo mismo que lee base.ts). Sin cortes: un solo tramo.
 *   - "velocidad" F (la escribe cortes.ts; sin el dato, ×1): los bordes de los tramos en la base se dividen entre F,
 *     igual que los tiempos de las palabras. Si la base del manifest se hizo a otra velocidad, sale con 2.
 * Sale: proyectos/<slug>/subtitulos.json → `subtitulos` es el arreglo listo para edicion.subtitulos
 *   ({id: "s1", desde, hasta, palabras: [{i, t, d, h}], caja: {x, y, w, escala?}}) y `estilo` es el estilo con el
 *   que se midió (el render tiene que dibujar con ese mismo estilo para que el ancho medido valga).
 *
 * Reglas:
 * - Siempre parte en los bordes de los tramos de keep (ningún subtítulo cruza un corte, ni en tiempo),
 *   en puntuación final (. ! ? …) y en pausas de más de 250 ms.
 * - Cada frase se parte en grupos de min–max palabras (por defecto 2–3: decisión del estilo del 2026-10-04; el p50 de los
 *   reels medidos es 2 y el p90 es 3) que caben en UNA línea: el ancho se mide con fontkit sobre el mismo archivo de fuente
 *   (más 2× el borde y los picos del borde en esquinas agudas). De preferencia ≤ ancho máximo − 1.5 px de antialias;
 *   un grupo puede llegar al tope a tamaño completo: el mayor entre lo medido (franja_subtitulos.ancho_p90.p90) y la
 *   zona segura de subtítulos (810 px, src/estilo/zona-segura.ts). Si ni así cabe, se achica hasta escalaMin (nunca
 *   menos de 0.95) y, si tampoco, se parte (2 + 1 / 2 + 2, sin bajar del mínimo). Una palabra sola que no cabe en el
 *   tope se queda sola y lleva caja.escala < 1 (y un aviso).
 * - Nunca junta palabras a los dos lados de un fin de oración (". ? ! …" o "¿ ¡"), salvo que sea la única forma de no
 *   dejar una palabra suelta; y castiga terminar en artículo, preposición o conjunción ("las", "de", "y"…) si la
 *   frase sigue (revisión de la v11 de un reel de prueba, 2026-10-04).
 * - Una frase de una sola palabra (entre pausas de > 250 ms o tras un punto) se une a la vecina del mismo tramo si la
 *   pausa es ≤ 0.46 s; un subtítulo de 1 palabra solo queda si está aislada entre pausas largas o cortes.
 * - Tiempos en cuadros de 30 fps: entra con un adelanto de 1 cuadro (configurable); si la pausa con el siguiente
 *   es ≤ 250 ms se queda hasta que entra el siguiente; dura al menos 0.3 s (o el p10 del mini-estilo) si hay lugar,
 *   sin encimarse con el siguiente ni pasar el final de su tramo.
 * - Valores que salen del mini-estilo (si existe estilo/mini-estilo.json o --estilo): ancho máximo, Y, tamaño o alto
 *   de mayúscula, borde, colores, duración mínima (p10), palabras por subtítulo (p50) y adelanto. Lo que falta usa
 *   el valor por defecto y queda marcado como supuesto en `origen`.
 */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {Subtitulo as SubtituloEsquema} from '../src/esquema/edicion.ts';
import {ZONA_SEGURA} from '../src/estilo/zona-segura.ts';
import {
	BASE_ALTO,
	BASE_ANCHO,
	archivoFuente,
	candidata,
	esIdFuente,
	IDS_FUENTE,
	pesoDisponible,
	resolverEstilo,
	textoVisible,
	type EstiloSubtitulo,
	type EstiloSubtituloParcial,
} from '../src/estilo/fuentes.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, hashearArchivo, leerManifest, registrarEtapa, validarSlug, type ArchivoHash} from './lib/manifest.ts';
import {cuantizar, duracionBase, esVelocidadValida, validarKeep, VELOCIDAD_MAX, VELOCIDAD_MIN, type Tramo} from './lib/remapear.ts';
import {leerPerfilMotor} from './lib/perfil-estilo.ts';
import {abrirFuente, medirCorridas, type CorridaTexto, type MedidaTexto} from './lib/texto-ancho.ts';

export const FPS = 30;
export const NOMBRE_ENTRADA = 'transcripcion-base.json';
export const NOMBRE_SALIDA = 'subtitulos.json';
export const MINI_ESTILO_POR_DEFECTO = join(RAIZ, 'estilo', 'mini-estilo.json');
export const ESTILO_COMPLETO = join(RAIZ, 'estilo', 'estilo.json');

const USO =
	'npx tsx herramientas/subtitulos.ts <slug> [--estilo estilo/mini-estilo.json] [--fuente tiktok-sans|instrument-sans|inter] [--resaltar 3,17] [--adelanto-cuadros 1] [--min-palabras 2] [--max-palabras 3] [--escala-min 0.91]';

export type SubtituloEdl = z.infer<typeof SubtituloEsquema>;

/** Palabra en la línea de tiempo de la base. */
export type PalabraBase = {i: number; t: string; d: number; h: number; tramo: number};

/** Tramo de keep[] ya en la línea de tiempo de la base (segundos). */
export type TramoBase = {desde: number; hasta: number};

export type ParametrosAgrupador = {
	/** Pausa (s) a partir de la cual se parte sí o sí (estrictamente mayor). */
	pausaS: number;
	duracionMinS: number;
	adelantoCuadros: number;
	/** Palabras por subtítulo que se buscan (el costo crece con la distancia a este número). */
	palabrasObjetivo: number;
	/** Si la pausa con el subtítulo siguiente es ≤ esto, el actual se queda hasta que entra el siguiente. */
	rellenarHuecoS: number;
	/** Nombres de varias palabras que se prefiere no partir ("Claude Code"); salen de biblioteca/vocabulario.json. */
	terminos: readonly string[];
	/**
	 * Palabras mínimas por subtítulo (decisión del estilo, 2026-10-04: monolíneas de dos a tres palabras). Un subtítulo de menos
	 * solo sale si es imposible: una palabra aislada entre pausas largas o cortes, o que no cabe con nadie a lo ancho.
	 */
	minPalabras: number;
	/** Palabras máximas por subtítulo: p90 de tus reels = 3 (estilo.json → subtitulos.palabras_por_evento.p90, n = 21 reels, 2531 eventos); el contrato de la EDL no pasa de 3. */
	maxPalabras: number;
	/**
	 * Una frase de menos de minPalabras se une a la vecina (mismo tramo) si la pausa entre ellas es ≤ esto. 0.46 s es la
	 * pausa a partir de la cual cortas (supuesto: 0.46 s; estilo/calibracion-cortes.json → pausas.umbral_s): más que eso, la
	 * palabra está aislada y va sola.
	 */
	pausaSueltaS: number;
	/**
	 * Ancho (px base) hasta el que un grupo de 2–3 palabras va a tamaño completo aunque pase de ancho_max (que es el p90
	 * de cada reel). null = ancho_max. De tu estilo: franja_subtitulos.ancho_p90.p90 = 503.1 px (n = 21 reels).
	 */
	anchoTopePx: number | null;
	/**
	 * Lo más que se achica un grupo de 2–3 palabras para caber en una línea en vez de partirse en sueltas (1 = nunca).
	 * 0.91 = p10 ÷ p50 del alto de mayúscula de tus subtítulos entre reels (39.1 ÷ 42.7, estilo.json →
	 * franja_subtitulos.alto_mayuscula, n = 21): tus propios reels varían así de tamaño.
	 */
	escalaMin: number;
};

export const PARAMETROS_POR_DEFECTO: ParametrosAgrupador = {
	pausaS: 0.25,
	duracionMinS: 0.3,
	// 0: entra con su palabra. Es lo que cumple la sincronía acordada (p50 ≤ 25 ms y p95 ≤ 45 ms): con 1 cuadro, IMG_5199
	// daba p50 34.9 ms. Tus reels adelantan ~2 cuadros (−54 ms, n = 214); se cambia con adelanto_cuadros en el estilo.
	adelantoCuadros: 0,
	palabrasObjetivo: 2.5,
	rellenarHuecoS: 0.25,
	terminos: [],
	minPalabras: 2,
	maxPalabras: 3,
	pausaSueltaS: 0.46,
	anchoTopePx: null,
	escalaMin: 0.91,
};

/** Forma que se le pide a cada subtítulo (lo que usa el partidor de ParametrosAgrupador). */
export type FormaSubtitulo = Pick<ParametrosAgrupador, 'minPalabras' | 'maxPalabras' | 'escalaMin'> & {
	/** Ancho util (px) hasta el que un grupo de varias palabras va a tamaño completo (≥ anchoMax). */
	anchoTope: number;
};

/** Forma sin las reglas nuevas (1–3 palabras, sin achicar): la de antes del 2026-10-04. */
export const FORMA_LIBRE = {minPalabras: 1, maxPalabras: 3, escalaMin: 1, anchoTope: 0} as const;

/**
 * Lo menos que se achica un subtítulo, pida lo que pida el estilo (revisión de la v11 de un reel de prueba, 2026-10-04:
 * «mejorar las animaciones?» salió a 0.7 y se nota más chico que los demás). Si un grupo no cabe ni así, se parte.
 */
export const ESCALA_MIN_ABSOLUTA = 0.95;

/**
 * Ancho (px base) que la zona segura de Reels deja a un subtítulo centrado en `x` (src/estilo/zona-segura.ts →
 * ZONA_SEGURA.subtitulos, x 135–945: 810 px con el centro en 540). No es medido en sus reels: es el límite de la guía.
 */
export function anchoZonaSubtitulos(x: number): number {
	const z = ZONA_SEGURA.subtitulos;
	return Math.max(0, 2 * Math.min(x - z.x0, z.x1 - x));
}

/**
 * Forma del partidor para un estilo y unos parámetros. El tope de una línea (sin achicar) es el mayor entre lo medido
 * en sus reels (anchoTopePx, el p90 de 503 px) y lo que deja la zona segura de subtítulos (810 px): una línea que cabe
 * en la zona no se parte ni se achica. Nunca es menor que el ancho útil. La escala mínima nunca baja de
 * ESCALA_MIN_ABSOLUTA.
 */
export function formaDe(estilo: Pick<EstiloSubtitulo, 'ancho_max'> & Partial<Pick<EstiloSubtitulo, 'x'>>, p: ParametrosAgrupador): FormaSubtitulo {
	const util = anchoUtil(estilo);
	const zona = anchoZonaSubtitulos(estilo.x ?? BASE_ANCHO / 2);
	return {
		minPalabras: p.minPalabras,
		maxPalabras: p.maxPalabras,
		escalaMin: Math.min(1, Math.max(p.escalaMin, ESCALA_MIN_ABSOLUTA)),
		anchoTope: Math.max(util, (p.anchoTopePx ?? estilo.ancho_max) - MARGEN_ANTIALIAS_PX, zona - MARGEN_ANTIALIAS_PX),
	};
}

/**
 * Escala con la que un grupo de varias palabras cabe en una línea: 1 si cabe en el tope a tamaño completo,
 * < 1 si hay que achicarlo (nunca menos que escalaMin), null si ni así cabe.
 */
export function escalaGrupo(ancho: number, forma: Pick<FormaSubtitulo, 'anchoTope' | 'escalaMin'>, anchoMax: number): number | null {
	const tope = Math.max(anchoMax, forma.anchoTope);
	if (ancho <= tope + 1e-9) return 1;
	const escala = Math.floor((tope / ancho) * 1000) / 1000;
	return escala >= forma.escalaMin - 1e-9 ? escala : null;
}

/**
 * El render pinta en 1440×2560 (×4/3) y el antialias puede tocar 1 px de lienzo de más a cada lado: 2 px de lienzo
 * = 1.5 px de la base. El agrupador lo reserva para que la caja de píxeles del still quede ≤ ancho máximo.
 */
export const MARGEN_ANTIALIAS_PX = 1.5;

/** Ancho que de verdad puede ocupar el texto medido: el máximo del estilo menos el margen de antialias. */
export function anchoUtil(estilo: Pick<EstiloSubtitulo, 'ancho_max'>): number {
	return estilo.ancho_max - MARGEN_ANTIALIAS_PX;
}

/** Costos del partidor (pesos relativos; ver costoGrupo). */
export const COSTOS = {
	/** Una palabra sola que no cabe: se acepta porque no hay de otra, pero nunca se prefiere. */
	palabraQueNoCabe: 100,
	/** Cualquier subtítulo de una sola palabra (el plan pide de preferencia 2–3), aunque el objetivo sea 2. */
	palabraSuelta: 2,
	/** Coma, punto y coma o dos puntos DENTRO del grupo (se prefiere partir ahí). */
	puntuacionInterna: 0.8,
	/** El grupo termina en una palabra de función ("de", "la", "que"…) y la frase sigue. */
	terminaEnFuncion: 0.5,
	/**
	 * El corte entre dos subtítulos cae dentro de un nombre del vocabulario ("Claude | Code"). Pesa más que agrandar el
	 * grupo hasta el tope (tamaño + anchoDeMas ≈ 1.6): "en Claude Code | muy sencillo" gana a "en Claude | Code muy".
	 */
	parteNombre: 3,
	/** El grupo duraría menos de DESTELLO_CUADROS antes de que entre el siguiente: se ve como un parpadeo. */
	destello: 6,
	/** Grupo con menos de minPalabras (el estilo los pide de 2–3): solo si no hay otra partición posible. */
	bajoMinimo: 20,
	/** Grupo de varias palabras más ancho que ancho_max (el p90 de cada reel) pero dentro del tope, a tamaño completo. */
	anchoDeMas: 0.6,
	/** Grupo de varias palabras que hay que achicar para que quepa (más 10 por cada unidad de escala que pierde). */
	escalado: 1.5,
	/**
	 * El grupo junta palabras a los dos lados de un fin de oración ("tu página. Y"; también "esto ¿Cómo"). Solo pasa
	 * cuando una palabra suelta se unió a la frase vecina, y pesa casi como dejarla sola: se acepta solo si no queda
	 * otra forma de evitar un subtítulo de una palabra (bajoMinimo + palabraSuelta = 22 > 12).
	 */
	cruzaFinal: 12,
	/**
	 * El grupo termina en artículo, preposición o conjunción (ARTICULOS_Y_NEXOS: "agregarle las", "reglas de") y la
	 * frase sigue: la palabra se apoya en la siguiente. Pesa más que hacer un grupo de 3 en vez de 2 (1) para que
	 * "las reglas | de diseño" gane a "agregarle las | reglas de".
	 */
	terminaEnNexo: 2.5,
} as const;

const PUNTUACION_FINAL = /[.!?…]["'”’»)\]]*$/u;
/** Una palabra que abre oración con signo (¿ ¡): lo que va antes es de otra oración. */
const APERTURA = /^["'“‘«(\[]*[¿¡]/u;

/** Hay un fin de oración entre la palabra k y la k+1 del grupo (punto/cierre en k o ¿/¡ en k+1). */
export function cruzaOracion(a: Pick<PalabraBase, 't'>, b: Pick<PalabraBase, 't'>): boolean {
	return PUNTUACION_FINAL.test(a.t) || APERTURA.test(b.t);
}

/** Cuántas veces el grupo cruza un fin de oración. */
export function crucesDeOracion(grupo: readonly Pick<PalabraBase, 't'>[]): number {
	let n = 0;
	for (let k = 0; k + 1 < grupo.length; k++) if (cruzaOracion(grupo[k], grupo[k + 1])) n++;
	return n;
}
const PUNTUACION_SUAVE = /[,;:]["'”’»)\]]*$/u;

/** Palabras que leen mal al final de un subtítulo porque se apoyan en la siguiente. */
const PALABRAS_FUNCION = new Set([
	'a', 'al', 'con', 'de', 'del', 'desde', 'e', 'el', 'en', 'entre', 'hacia', 'hasta', 'la', 'las', 'le', 'les', 'lo', 'los',
	'me', 'mi', 'mis', 'muy', 'ni', 'no', 'nos', 'o', 'para', 'pero', 'por', 'que', 'se', 'si', 'sin', 'sobre', 'su', 'sus',
	'te', 'tu', 'tus', 'u', 'un', 'una', 'unos', 'unas', 'y', 'cuando', 'como', 'donde', 'porque', 'más', 'tan',
	'the', 'an', 'of', 'to', 'and', 'in', 'for', 'with', 'my', 'your',
]);

/** Artículos, preposiciones y conjunciones que nunca deberían cerrar un subtítulo si la frase sigue (revisión v11). */
export const ARTICULOS_Y_NEXOS: ReadonlySet<string> = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'a', 'al', 'en', 'con', 'por', 'para', 'que', 'y', 'o']);

const normal = (t: string): string => t.toLocaleLowerCase('es').replace(/^[\p{P}]+|[\p{P}]+$/gu, '');

export function terminaEnFuncion(t: string): boolean {
	return PALABRAS_FUNCION.has(normal(t));
}

/** La palabra es artículo, preposición o conjunción de ARTICULOS_Y_NEXOS (sin puntuación: "y," cierra una idea y no cuenta). */
export function esNexo(t: string): boolean {
	return !/[\p{P}]$/u.test(t) && ARTICULOS_Y_NEXOS.has(normal(t));
}

/**
 * pegadas[k] = true si las palabras k y k+1 de la frase son parte de un mismo nombre del vocabulario
 * (p. ej. "Claude Code"): partir ahí cuesta COSTOS.parteNombre.
 */
export function pegadasEnFrase(frase: readonly PalabraBase[], terminos: readonly string[]): boolean[] {
	const pegadas = new Array<boolean>(Math.max(0, frase.length - 1)).fill(false);
	const palabras = frase.map((p) => normal(p.t));
	for (const termino of terminos) {
		const partes = termino.split(/\s+/).map(normal).filter(Boolean);
		if (partes.length < 2) continue;
		for (let k = 0; k + partes.length <= palabras.length; k++) {
			if (partes.every((parte, j) => palabras[k + j] === parte)) for (let j = 0; j < partes.length - 1; j++) pegadas[k + j] = true;
		}
	}
	return pegadas;
}

// ───────────────────────── medición ─────────────────────────

export type Medidor = (grupo: readonly PalabraBase[]) => MedidaTexto;

/**
 * Mide un grupo tal como lo dibuja src/reel/Subtitulo.tsx: palabras separadas por un espacio en la fuente base y,
 * si el resaltado está activo, cada palabra resaltada en su peso y escala.
 */
export function crearMedidor(estilo: EstiloSubtitulo, resaltar: readonly number[] = [], raiz = RAIZ): Medidor {
	const rutaBase = join(raiz, archivoFuente(estilo.fuente, estilo.peso).ruta);
	const rutaResaltado = join(raiz, archivoFuente(estilo.fuente, estilo.resaltado.peso).ruta);
	const marcadas = new Set(estilo.resaltado.activo ? resaltar : []);
	const cache = new Map<string, MedidaTexto>();
	return (grupo) => {
		const llave = grupo.map((p) => `${p.i}:${p.t}`).join('\u0000');
		const guardada = cache.get(llave);
		if (guardada) return guardada;
		const base = {ruta: rutaBase, tamanoPx: estilo.tamano_px, espaciadoPx: estilo.espaciado_px};
		let corridas: CorridaTexto[];
		if (!grupo.some((p) => marcadas.has(p.i))) {
			corridas = [{...base, texto: grupo.map((p) => textoVisible(p.t, estilo)).join(' ')}];
		} else {
			corridas = [];
			grupo.forEach((p, k) => {
				if (k > 0) corridas.push({...base, texto: ' '});
				corridas.push(
					marcadas.has(p.i)
						? {ruta: rutaResaltado, tamanoPx: estilo.tamano_px * estilo.resaltado.escala, espaciadoPx: estilo.espaciado_px, texto: textoVisible(p.t, estilo)}
						: {...base, texto: textoVisible(p.t, estilo)},
				);
			});
		}
		const medida = medirCorridas(corridas, estilo.borde_px);
		cache.set(llave, medida);
		return medida;
	};
}

// ───────────────────────── agrupador ─────────────────────────

/** Parte en frases: cambio de tramo de keep, puntuación final o pausa > pausaS. Dentro de una frase no hay cortes obligados. */
export function partirEnFrases(palabras: readonly PalabraBase[], pausaS: number): PalabraBase[][] {
	const frases: PalabraBase[][] = [];
	let actual: PalabraBase[] = [];
	for (const p of palabras) {
		const anterior = actual.at(-1);
		if (anterior && (p.tramo !== anterior.tramo || cruzaOracion(anterior, p) || p.d - anterior.h > pausaS + 1e-6)) {
			frases.push(actual);
			actual = [];
		}
		actual.push(p);
	}
	if (actual.length > 0) frases.push(actual);
	return frases;
}

/**
 * Una frase que duraría menos de DESTELLO_CUADROS antes de la siguiente (una palabra casi muda entre una pausa y un
 * punto: "web.") se pega a la frase anterior del mismo tramo, para que la partición pueda repartirla ("hacer" /
 * "páginas web." en vez de "hacer páginas" / "web.").
 */
export function unirFrasesDestello(frases: readonly PalabraBase[][]): PalabraBase[][] {
	const salida: PalabraBase[][] = [];
	/** Frase-destello que no pudo ir con la anterior (otro tramo: justo después de un corte): va con la siguiente. */
	let pendiente: PalabraBase[] | null = null;
	frases.forEach((f, k) => {
		const actual = pendiente ? [...pendiente, ...f] : [...f];
		pendiente = null;
		const sig = frases[k + 1]?.[0];
		const fin = sig && sig.tramo === actual[0].tramo ? sig.d : null;
		const anterior = salida.at(-1);
		const destello = fin !== null && Math.round(fin * FPS) - Math.round(actual[0].d * FPS) < DESTELLO_CUADROS;
		if (destello && anterior && anterior[0].tramo === actual[0].tramo) anterior.push(...actual);
		else if (destello) pendiente = actual; // fin !== null: la siguiente es del mismo tramo
		else salida.push(actual);
	});
	if (pendiente) salida.push(pendiente);
	return salida;
}

/**
 * Una frase de menos de `minPalabras` (una palabra entre dos pausas de > pausaS, o tras un punto: "importante." /
 * "Dale") se une a la frase vecina del mismo tramo si la pausa entre ellas es ≤ pausaMaxS, para que la partición pueda
 * hacer subtítulos de 2–3 palabras. Prefiere: la anterior si la palabra cierra oración ("muy | importante."), la
 * siguiente si la anterior ya cerró ("importante. | Dale"), y si no, la de la pausa más corta. Sin vecina posible
 * (cortes o pausas largas a los dos lados) se queda sola: es el caso imposible.
 */
/** Cuánto más pausa se le acepta a la frase siguiente cuando la anterior cerraría oración (ver unirFrasesSueltas). */
export const PAUSA_SUELTA_SIN_CRUCE = 2;

export function unirFrasesSueltas(frases: readonly PalabraBase[][], minPalabras: number, pausaMaxS: number): PalabraBase[][] {
	const salida = frases.map((f) => [...f]);
	let k = 0;
	while (k < salida.length) {
		const f = salida[k];
		if (f.length >= minPalabras) {
			k++;
			continue;
		}
		const anterior = k > 0 ? salida[k - 1] : null;
		const siguiente = k + 1 < salida.length ? salida[k + 1] : null;
		const huecoAnt = anterior && anterior.at(-1)!.tramo === f[0].tramo ? f[0].d - anterior.at(-1)!.h : Infinity;
		const huecoSig = siguiente && siguiente[0].tramo === f[0].tramo ? siguiente[0].d - f.at(-1)!.h : Infinity;
		const cruzaAnt = anterior !== null && cruzaOracion(anterior.at(-1)!, f[0]);
		const cruzaSig = siguiente !== null && cruzaOracion(f.at(-1)!, siguiente[0]);
		const okAnt = huecoAnt <= pausaMaxS + 1e-6;
		// Si irse con la anterior junta dos oraciones ("página. | Y"), la siguiente se acepta con una pausa de hasta
		// PAUSA_SUELTA_SIN_CRUCE × pausaMaxS ("Y inténtalo," con 0.46 s de pausa en un reel de prueba).
		const okSig = huecoSig <= pausaMaxS * (cruzaAnt && !cruzaSig ? PAUSA_SUELTA_SIN_CRUCE : 1) + 1e-6;
		let haciaAtras: boolean;
		if (okAnt && okSig) {
			if (cruzaSig && !cruzaAnt) haciaAtras = true;
			else if (cruzaAnt && !cruzaSig) haciaAtras = false;
			else haciaAtras = huecoAnt <= huecoSig;
		} else if (okAnt || okSig) haciaAtras = okAnt;
		else {
			k++;
			continue;
		}
		if (haciaAtras) {
			anterior!.push(...f);
			salida.splice(k, 1);
		} else {
			salida[k] = [...f, ...siguiente!];
			salida.splice(k + 1, 1);
		}
	}
	return salida;
}

/**
 * Costo de un grupo (menor = mejor). Infinity si no se puede: más de una palabra que no cabe en el ancho.
 * (n − objetivo)² más un castigo a la palabra suelta favorecen 2–3 palabras; la puntuación interna y terminar
 * en palabra de función suman.
 */
export function costoGrupo(
	grupo: readonly PalabraBase[],
	finDeFrase: boolean,
	medir: Medidor,
	anchoMax: number,
	palabrasObjetivo: number,
	forma: Omit<FormaSubtitulo, 'maxPalabras'> = FORMA_LIBRE,
): number {
	const n = grupo.length;
	let costo = (n - palabrasObjetivo) ** 2 + (n === 1 ? COSTOS.palabraSuelta : 0) + (n < forma.minPalabras ? COSTOS.bajoMinimo : 0);
	const ancho = medir(grupo).ancho;
	if (ancho > anchoMax + 1e-9) {
		// Una palabra sola va a tamaño completo hasta el tope (la zona segura); más allá, sola y achicada.
		if (n === 1) costo += ancho > Math.max(anchoMax, forma.anchoTope) + 1e-9 ? COSTOS.palabraQueNoCabe : COSTOS.anchoDeMas;
		else {
			const escala = escalaGrupo(ancho, forma, anchoMax);
			if (escala === null) return Infinity;
			costo += COSTOS.anchoDeMas + (escala < 1 ? COSTOS.escalado + 10 * (1 - escala) : 0);
		}
	}
	for (let k = 0; k < n - 1; k++) {
		if (PUNTUACION_SUAVE.test(grupo[k].t)) costo += COSTOS.puntuacionInterna;
		if (cruzaOracion(grupo[k], grupo[k + 1])) costo += COSTOS.cruzaFinal;
	}
	if (!finDeFrase) {
		const ultima = grupo[n - 1].t;
		if (esNexo(ultima)) costo += COSTOS.terminaEnNexo;
		else if (terminaEnFuncion(ultima)) costo += COSTOS.terminaEnFuncion;
	}
	return costo;
}

/** Partición óptima de una frase en grupos de 1–maxPalabras palabras (programación dinámica; determinista). */
export function partirFrase(
	frase: readonly PalabraBase[],
	medir: Medidor,
	anchoMax: number,
	palabrasObjetivo: number,
	terminos: readonly string[] = [],
	/** Inicio (s) de la palabra que sigue a la frase, si es del mismo tramo: así el último grupo sabe cuánto dura. */
	siguienteD: number | null = null,
	forma: FormaSubtitulo = FORMA_LIBRE,
): PalabraBase[][] {
	const tamanos = Array.from({length: forma.maxPalabras}, (_, k) => forma.maxPalabras - k);
	const m = frase.length;
	const pegadas = pegadasEnFrase(frase, terminos);
	/** Cuadros que dura el grupo frase[j..k) antes de que entre el siguiente (Infinity si no se sabe). */
	const dura = (j: number, k: number): number => {
		const fin = k < m ? frase[k].d : siguienteD;
		return fin === null ? Infinity : Math.round(fin * FPS) - Math.round(frase[j].d * FPS);
	};
	const costo = new Array<number>(m + 1).fill(Infinity);
	const ultimo = new Array<number>(m + 1).fill(0);
	costo[0] = 0;
	for (let k = 1; k <= m; k++) {
		for (const n of tamanos) {
			if (n > k) continue;
			let c = costoGrupo(frase.slice(k - n, k), k === m, medir, anchoMax, palabrasObjetivo, forma);
			if (!Number.isFinite(c)) continue;
			if (k < m && pegadas[k - 1]) c += COSTOS.parteNombre;
			if (dura(k - n, k) < DESTELLO_CUADROS) c += COSTOS.destello;
			if (costo[k - n] + c < costo[k] - 1e-9) {
				costo[k] = costo[k - n] + c;
				ultimo[k] = n;
			}
		}
	}
	const grupos: PalabraBase[][] = [];
	for (let k = m; k > 0; k -= ultimo[k]) grupos.unshift(frase.slice(k - ultimo[k], k));
	return grupos;
}

/** Ventana de un subtítulo en cuadros de 30 fps: [ini, fin). */
export type VentanaCuadros = {ini: number; fin: number};

/** Menos de esto (4 cuadros = 133 ms) no se alcanza a leer: es un parpadeo. */
export const DESTELLO_CUADROS = 4;
/** Lo más que un subtítulo cede de su inicio para que el anterior no parpadee (2 cuadros = 67 ms). */
export const CESION_MAX_CUADROS = 2;

/**
 * Último recurso contra el parpadeo, cuando no se pudo unir (no cabe a lo ancho, o queda entre un corte y la palabra
 * que sigue: "web." justo después de un corte y pegada a "Chulísimas,"): el siguiente subtítulo del mismo tramo, si
 * entra pegado (habla continua, sin pausa), cede hasta CESION_MAX_CUADROS de su inicio. La sincronía acordada se mide
 * en los arranques tras una pausa, que nunca ceden. Modifica `ventanas` y devuelve los avisos.
 */
export function estirarDestellos(grupos: readonly (readonly PalabraBase[])[], ventanas: VentanaCuadros[]): string[] {
	const avisos: string[] = [];
	for (let k = 0; k + 1 < ventanas.length; k++) {
		const v = ventanas[k];
		const s = ventanas[k + 1];
		const falta = DESTELLO_CUADROS - (v.fin - v.ini);
		if (falta <= 0 || s.ini !== v.fin || grupos[k + 1][0].tramo !== grupos[k][0].tramo) continue;
		const cede = Math.min(falta, CESION_MAX_CUADROS, s.fin - s.ini - DESTELLO_CUADROS);
		if (cede <= 0) continue;
		v.fin += cede;
		s.ini += cede;
		avisos.push(`"${grupos[k].map((p) => p.t).join(' ')}" (palabra ${grupos[k][0].i}) duraba ${v.fin - v.ini - cede} cuadros: el siguiente entra ${cede} cuadro${cede === 1 ? '' : 's'} después para que no parpadee`);
	}
	return avisos;
}

/**
 * El primer subtítulo que dura menos de DESTELLO_CUADROS y se puede unir (mismo tramo, maxPalabras como máximo y que
 * quepa a lo ancho, achicado hasta escalaMin si hace falta) al de antes —o, si no, al de después—. null si no queda ninguno que se pueda unir.
 */
export function unirDestellos(
	grupos: readonly (readonly PalabraBase[])[],
	ventanas: readonly VentanaCuadros[],
	medir: Medidor,
	anchoMax: number,
	forma: Pick<FormaSubtitulo, 'maxPalabras' | 'anchoTope' | 'escalaMin'> = FORMA_LIBRE,
): {grupos: PalabraBase[][]; aviso: string} | null {
	const cabe = (a: readonly PalabraBase[], b: readonly PalabraBase[]) =>
		a[0].tramo === b[0].tramo && a.length + b.length <= forma.maxPalabras && escalaGrupo(medir([...a, ...b]).ancho, forma, anchoMax) !== null;
	for (let k = 0; k < grupos.length; k++) {
		const v = ventanas[k];
		if (v.fin - v.ini >= DESTELLO_CUADROS) continue;
		const g = grupos[k];
		const texto = (x: readonly PalabraBase[]) => x.map((p) => p.t).join(' ');
		const dura = `${v.fin - v.ini} cuadro${v.fin - v.ini === 1 ? '' : 's'}`;
		const atras = k > 0 && cabe(grupos[k - 1], g);
		const adelante = k + 1 < grupos.length && cabe(g, grupos[k + 1]);
		// Primero el lado que no junta dos oraciones ("eso. | Y" va con lo que sigue); si los dos cruzan, el de antes.
		const cruzaAtras = atras && cruzaOracion(grupos[k - 1].at(-1)!, g[0]);
		const cruzaAdelante = adelante && cruzaOracion(g.at(-1)!, grupos[k + 1][0]);
		const haciaAtras = atras && (!adelante || !cruzaAtras || cruzaAdelante);
		if (haciaAtras) {
			const unido = [...grupos[k - 1], ...g];
			return {
				grupos: [...grupos.slice(0, k - 1).map((x) => [...x]), unido, ...grupos.slice(k + 1).map((x) => [...x])],
				aviso: `"${texto(g)}" (palabra ${g[0].i}) duraba ${dura}: va con el anterior («${texto(unido)}»)`,
			};
		}
		if (adelante) {
			const unido = [...g, ...grupos[k + 1]];
			return {
				grupos: [...grupos.slice(0, k).map((x) => [...x]), unido, ...grupos.slice(k + 2).map((x) => [...x])],
				aviso: `"${texto(g)}" (palabra ${g[0].i}) duraba ${dura}: va con el siguiente («${texto(unido)}»)`,
			};
		}
	}
	return null;
}

/**
 * Tiempos de cada grupo, en cuadros enteros (así el render no redondea distinto).
 * Garantías: ini ≥ inicio de su tramo, fin ≤ final de su tramo, fin > ini y nunca se encima con el siguiente.
 */
export function calcularTiempos(grupos: readonly (readonly PalabraBase[])[], tramos: readonly TramoBase[], p: ParametrosAgrupador): VentanaCuadros[] {
	const minimo = Math.max(1, Math.ceil(p.duracionMinS * FPS - 1e-9));
	const bordes = tramos.map((t) => ({ini: Math.round(t.desde * FPS), fin: Number.isFinite(t.hasta) ? Math.round(t.hasta * FPS) : Infinity}));
	const ventanas: VentanaCuadros[] = [];
	let iniAnterior = -Infinity;
	for (const g of grupos) {
		const tramo = bordes[g[0].tramo];
		const ini = Math.max(Math.round(g[0].d * FPS) - p.adelantoCuadros, tramo.ini, iniAnterior + 1);
		if (ini > tramo.fin - 1) {
			throw fallo(
				'calcular los tiempos de los subtítulos',
				`el subtítulo que empieza con "${g[0].t}" (palabra ${g[0].i}) ya no cabe antes del final de su tramo (${(tramo.fin / FPS).toFixed(3)} s)`,
				'revisa los tiempos de transcripcion-base.json cerca de ese corte',
				1,
			);
		}
		ventanas.push({ini, fin: Math.max(Math.round(g[g.length - 1].h * FPS), ini + 1)});
		iniAnterior = ini;
	}
	grupos.forEach((g, k) => {
		const siguiente = grupos[k + 1];
		const tramo = bordes[g[0].tramo];
		const v = ventanas[k];
		const limite = Math.min(siguiente ? ventanas[k + 1].ini : Infinity, tramo.fin);
		let fin = v.fin;
		const mismoTramo = siguiente !== undefined && siguiente[0].tramo === g[0].tramo;
		if (mismoTramo && siguiente[0].d - g[g.length - 1].h <= p.rellenarHuecoS + 1e-6) fin = Math.max(fin, ventanas[k + 1].ini);
		if (fin - v.ini < minimo) fin = v.ini + minimo;
		v.fin = Math.max(v.ini + 1, Math.min(fin, limite));
	});
	return ventanas;
}

export type ResumenSubtitulos = {
	palabras: number;
	subtitulos: number;
	por_tamano: {1: number; 2: number; 3: number};
	frases: number;
	tramos_con_palabras: number;
	ancho_max_medido_px: number;
	escalados: number;
	bajo_duracion_minima: number;
};

export type ResultadoAgrupador = {subtitulos: SubtituloEdl[]; resumen: ResumenSubtitulos; avisos: string[]};

/**
 * Agrupa las palabras (ya validadas y en orden) en subtítulos para la EDL.
 * `tramos` son los tramos de keep[] en la base; cada palabra trae el índice de su tramo.
 */
export function agruparSubtitulos(
	palabras: readonly PalabraBase[],
	tramos: readonly TramoBase[],
	estilo: EstiloSubtitulo,
	parametros: ParametrosAgrupador = PARAMETROS_POR_DEFECTO,
	medir: Medidor = crearMedidor(estilo),
): ResultadoAgrupador {
	const avisos: string[] = [];
	if (!(parametros.maxPalabras >= 1 && parametros.maxPalabras <= 3 && parametros.minPalabras >= 1 && parametros.minPalabras <= parametros.maxPalabras)) {
		throw fallo('agrupar los subtítulos', `pediste de ${parametros.minPalabras} a ${parametros.maxPalabras} palabras por subtítulo`, 'usa un mínimo de 1 a 3 y un máximo de 1 a 3 (el mínimo no pasa del máximo)', 2);
	}
	const frases = unirFrasesSueltas(unirFrasesDestello(partirEnFrases(palabras, parametros.pausaS)), parametros.minPalabras, parametros.pausaSueltaS);
	const util = anchoUtil(estilo);
	const forma = formaDe(estilo, parametros);
	let grupos = frases.flatMap((f, k) => {
		const sig = frases[k + 1]?.[0];
		return partirFrase(f, medir, util, parametros.palabrasObjetivo, parametros.terminos, sig && sig.tramo === f[0].tramo ? sig.d : null, forma);
	});
	let ventanas = calcularTiempos(grupos, tramos, parametros);
	// Un subtítulo que dura menos de DESTELLO_CUADROS se ve como un parpadeo (una palabra casi muda pegada a la
	// siguiente, p. ej. "web." de 1 cuadro): se une al de antes o al de después si cabe, y se recalculan los tiempos.
	for (let vuelta = 0; vuelta < grupos.length; vuelta++) {
		const unidos = unirDestellos(grupos, ventanas, medir, util, forma);
		if (!unidos) break;
		avisos.push(unidos.aviso);
		grupos = unidos.grupos;
		ventanas = calcularTiempos(grupos, tramos, parametros);
	}
	avisos.push(...estirarDestellos(grupos, ventanas));
	const minimo = Math.max(1, Math.ceil(parametros.duracionMinS * FPS - 1e-9));
	let anchoMaxMedido = 0;
	let escalados = 0;
	let bajoMinimo = 0;
	const subtitulos: SubtituloEdl[] = grupos.map((g, k) => {
		const medida = medir(g);
		anchoMaxMedido = Math.max(anchoMaxMedido, medida.ancho);
		const caja: SubtituloEdl['caja'] = {x: estilo.x, y: estilo.y, w: Math.max(1, Math.ceil(medida.ancho))};
		if (g.length === 1 && medida.ancho > forma.anchoTope + 1e-9) {
			caja.escala = Math.floor((forma.anchoTope / medida.ancho) * 1000) / 1000;
			escalados++;
			avisos.push(
				`"${g[0].t}" (palabra ${g[0].i}) mide ${medida.ancho.toFixed(0)} px y el máximo es ${(forma.anchoTope + MARGEN_ANTIALIAS_PX).toFixed(0)} px: va sola y escalada a ${caja.escala}`,
			);
		} else if (g.length > 1 && medida.ancho > forma.anchoTope + 1e-9) {
			// El partidor solo deja grupos que caben achicados hasta escalaMin.
			caja.escala = escalaGrupo(medida.ancho, forma, util) ?? forma.escalaMin;
			escalados++;
			avisos.push(`"${g.map((p) => p.t).join(' ')}" (palabra ${g[0].i}) mide ${medida.ancho.toFixed(0)} px: va en una línea achicada a ${caja.escala} para no partirla en sueltas`);
		}
		const v = ventanas[k];
		if (v.fin - v.ini < minimo) bajoMinimo++;
		return {
			id: `s${k + 1}`,
			desde: v.ini / FPS,
			hasta: v.fin / FPS,
			palabras: g.map((p) => ({i: p.i, t: p.t, d: p.d, h: p.h})),
			caja,
		};
	});
	revisarResultado(palabras, grupos, ventanas, tramos, subtitulos, parametros.maxPalabras);
	const porTamano = {1: 0, 2: 0, 3: 0};
	for (const g of grupos) porTamano[g.length as 1 | 2 | 3]++;
	return {
		subtitulos,
		avisos,
		resumen: {
			palabras: palabras.length,
			subtitulos: subtitulos.length,
			por_tamano: porTamano,
			frases: frases.length,
			tramos_con_palabras: new Set(palabras.map((p) => p.tramo)).size,
			ancho_max_medido_px: Math.round(anchoMaxMedido * 10) / 10,
			escalados,
			bajo_duracion_minima: bajoMinimo,
		},
	};
}

/** Revisión final (si falla es un bug del agrupador: código 1). */
function revisarResultado(
	palabras: readonly PalabraBase[],
	grupos: readonly (readonly PalabraBase[])[],
	ventanas: readonly VentanaCuadros[],
	tramos: readonly TramoBase[],
	subtitulos: readonly SubtituloEdl[],
	maxPalabras = 3,
): void {
	const problemas: string[] = [];
	const indices = grupos.flat().map((p) => p.i);
	if (indices.length !== palabras.length || indices.some((i, k) => i !== palabras[k].i)) problemas.push('se perdió o se repitió una palabra');
	grupos.forEach((g, k) => {
		const v = ventanas[k];
		const tramo = tramos[g[0].tramo];
		if (g.length < 1 || g.length > maxPalabras) problemas.push(`s${k + 1} tiene ${g.length} palabras`);
		if (g.some((p) => p.tramo !== g[0].tramo)) problemas.push(`s${k + 1} mezcla palabras de dos tramos`);
		if (!(v.fin > v.ini)) problemas.push(`s${k + 1} no dura ni un cuadro`);
		if (v.ini < Math.round(tramo.desde * FPS)) problemas.push(`s${k + 1} empieza antes de su tramo`);
		if (Number.isFinite(tramo.hasta) && v.fin > Math.round(tramo.hasta * FPS)) problemas.push(`s${k + 1} acaba después de su tramo`);
		if (k > 0 && v.ini < ventanas[k - 1].fin) problemas.push(`s${k + 1} se encima con s${k}`);
	});
	const r = SubtituloEsquema.array().safeParse(subtitulos);
	if (!r.success) problemas.push(`no cumple el contrato de la EDL (${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message})`);
	if (problemas.length > 0) {
		throw fallo('agrupar los subtítulos', problemas.slice(0, 3).join('; '), 'revisa proyectos/_logs/fallos.log y avísame', 1, problemas);
	}
}

// ───────────────────────── entradas ─────────────────────────

const PalabraEntrada = z.looseObject({
	i: z.number().int().nonnegative(),
	t: z.string().min(1),
	d: z.number().nonnegative(),
	h: z.number().nonnegative(),
	tramo: z.number().int().nonnegative().optional(),
});
const TramoEntrada = z.looseObject({desde: z.number().nonnegative(), hasta: z.number().positive()});
const TranscripcionBaseEsquema = z.union([
	z.array(PalabraEntrada),
	z.looseObject({
		palabras: z.array(PalabraEntrada),
		keep: z.array(TramoEntrada).min(1).optional(),
		duracion_s: z.number().positive().optional(),
		velocidad: z.number().min(VELOCIDAD_MIN).max(VELOCIDAD_MAX).optional(),
	}),
]);

export type TranscripcionBase = {palabras: z.infer<typeof PalabraEntrada>[]; keep?: Tramo[]; duracionS?: number; velocidad?: number};

/** Ruta para mensajes: relativa a la raíz si cae dentro del proyecto; si no, absoluta. */
function rutaLegible(ruta: string): string {
	const relativa = relative(RAIZ, resolve(ruta));
	return relativa && !relativa.startsWith('..') ? relativa : resolve(ruta);
}

function leerJson(ruta: string, que: string, siguiente: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw fallo(que, `no existe ${rutaLegible(ruta)}`, siguiente, 2);
		throw fallo(que, `${rutaLegible(ruta)} no es JSON válido`, `revisa ${rutaLegible(ruta)}`, 2, error);
	}
}

function problemaZod(error: z.ZodError): string {
	const primero = error.issues[0];
	return `${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'}`;
}

export function leerTranscripcionBase(ruta: string): TranscripcionBase {
	const datos = leerJson(ruta, 'leer la transcripción de la base', 'genera transcripcion-base.json con la etapa de cortes (remapeo del texto aprobado)');
	const r = TranscripcionBaseEsquema.safeParse(datos);
	if (!r.success) {
		throw fallo(
			'leer la transcripción de la base',
			`no trae "palabras": [{i, t, d, h, tramo}] (${problemaZod(r.error)})`,
			`revisa ${ruta}`,
			2,
			r.error.issues,
		);
	}
	if (Array.isArray(r.data)) return {palabras: r.data};
	return {
		palabras: r.data.palabras,
		keep: r.data.keep?.map(({desde, hasta}) => ({desde, hasta})),
		duracionS: r.data.duracion_s,
		...(r.data.velocidad !== undefined ? {velocidad: r.data.velocidad} : {}),
	};
}

/**
 * Tramos de keep[] en segundos de la base, a partir de keep[] en segundos del original (cuantizado como base.ts).
 * Con velocidad F (la de la base), cada borde se divide entre F (lib/remapear.ts: duracionBase(keep, F)).
 */
export function tramosEnBase(keep: readonly Tramo[], velocidad = 1): TramoBase[] {
	const cuantizados = keep.map((t) => ({desde: cuantizar(t.desde), hasta: cuantizar(t.hasta)}));
	try {
		validarKeep(cuantizados);
	} catch (error) {
		const motivo = error instanceof Error ? error.message : String(error);
		throw fallo('leer los cortes', `keep[] no sirve para la base (${motivo})`, 'revisa cortes.json: tramos en orden, sin encimarse y con al menos un cuadro entre uno y otro', 2, error);
	}
	// Los bordes se le piden a remapear.ts (cuadros enteros), no se suman segundos.
	return cuantizados.map((_, k) => ({desde: k === 0 ? 0 : duracionBase(cuantizados.slice(0, k), velocidad), hasta: duracionBase(cuantizados.slice(0, k + 1), velocidad)}));
}

/**
 * Normaliza las palabras: orden, tramo (si no viene, se deduce del tiempo) y que cada una caiga dentro de su tramo.
 * Entrada inválida → código 2.
 */
export function normalizarPalabras(entrada: readonly z.infer<typeof PalabraEntrada>[], tramos: readonly TramoBase[]): PalabraBase[] {
	const que = 'revisar las palabras de transcripcion-base.json';
	const siguiente = 'vuelve a generar transcripcion-base.json con la etapa de cortes';
	const tolerancia = 0.5 / FPS;
	const palabras: PalabraBase[] = [];
	entrada.forEach((p, k) => {
		const anterior = palabras[k - 1];
		if (anterior && p.i <= anterior.i) throw fallo(que, `la palabra ${k} ("${p.t}") trae i=${p.i}, que no es mayor que la anterior (${anterior.i})`, siguiente, 2);
		if (anterior && p.d < anterior.d - 1e-6) throw fallo(que, `"${p.t}" (i=${p.i}) empieza en ${p.d} s, antes que la palabra anterior (${anterior.d} s)`, siguiente, 2);
		let tramo = p.tramo;
		if (tramo === undefined) {
			tramo = tramos.findIndex((t) => p.d >= t.desde - tolerancia && p.d < t.hasta);
			if (tramo < 0) throw fallo(que, `"${p.t}" (i=${p.i}, ${p.d} s) no cae en ningún tramo de keep`, siguiente, 2);
		}
		const t = tramos[tramo];
		if (!t) throw fallo(que, `"${p.t}" (i=${p.i}) dice tramo ${tramo}, pero keep[] solo tiene ${tramos.length}`, siguiente, 2);
		if (p.d < t.desde - tolerancia || p.d > t.hasta + tolerancia) {
			throw fallo(que, `"${p.t}" (i=${p.i}) empieza en ${p.d} s, fuera de su tramo ${tramo} (${t.desde.toFixed(3)}–${t.hasta.toFixed(3)} s de la base)`, siguiente, 2);
		}
		if (anterior && tramo < anterior.tramo) throw fallo(que, `"${p.t}" (i=${p.i}) va en el tramo ${tramo}, antes que la palabra anterior (tramo ${anterior.tramo})`, siguiente, 2);
		palabras.push({i: p.i, t: p.t, d: p.d, h: Math.max(p.h, p.d), tramo});
	});
	return palabras;
}

/** Nombres de varias palabras del vocabulario (biblioteca/vocabulario.json → terminos), para no partirlos. */
export function leerTerminos(ruta: string): {terminos: string[]; aviso: string | null} {
	if (!existsSync(ruta)) return {terminos: [], aviso: null};
	try {
		const datos = JSON.parse(readFileSync(ruta, 'utf8')) as {terminos?: unknown};
		const terminos = Array.isArray(datos.terminos) ? datos.terminos.filter((t): t is string => typeof t === 'string' && /\S\s+\S/.test(t.trim())) : [];
		return {terminos, aviso: null};
	} catch {
		return {terminos: [], aviso: `${rutaLegible(ruta)} no es JSON válido: no protejo nombres como "Claude Code" al partir`};
	}
}

// ───────────────────────── mini-estilo ─────────────────────────

export type MiniEstilo = {
	estilo: EstiloSubtituloParcial;
	parametros: Partial<ParametrosAgrupador>;
	/** De dónde salió cada valor (ruta dentro del JSON). */
	origen: Record<string, string>;
	/** Campos que venían como N/A. */
	na: string[];
	/** Alto de mayúscula medido (px base); se convierte a tamaño de letra con la fuente elegida. */
	altoMayusculaPx?: number;
	/**
	 * Adelanto MEDIDO en tus reels ({valor, n, fuente}): queda como dato y no se aplica, porque la sincronía acordada
	 * (p50 ≤ 25 ms contra tu voz) pide entrar con la palabra. Un número suelto en el estilo (un ajuste tuyo) sí se aplica.
	 */
	adelantoMedido?: {cuadros: number; donde: string};
};

type Numero = {campo: string; rutas: string[]; min: number; max: number};

const NUMEROS: Numero[] = [
	{campo: 'ancho_max', rutas: ['ancho_max', 'ancho_max_px', 'ancho_p90', 'ancho.p90', '@franja_subtitulos.ancho_p90'], min: 100, max: BASE_ANCHO},
	{campo: 'y', rutas: ['y', 'y_px', 'y_p50', 'y.p50', 'y_centro', 'franja.y_p50', '@franja_subtitulos.y_p50'], min: 0, max: BASE_ALTO},
	{campo: 'tamano_px', rutas: ['tamano_px', 'tamano', 'tamano.p50'], min: 10, max: 400},
	{campo: 'alto_mayuscula_px', rutas: ['alto_mayuscula_px', 'alto_mayuscula', 'alto_mayuscula_p50', 'alto_mayuscula.p50'], min: 5, max: 300},
	{campo: 'borde_px', rutas: ['borde_px', 'grosor_borde_px', 'grosor_borde', 'grosor_borde_p50', 'borde', 'borde.p50'], min: 0, max: 40},
	{campo: 'peso', rutas: ['peso'], min: 100, max: 900},
	{campo: 'espaciado_px', rutas: ['espaciado_px'], min: -20, max: 40},
	{campo: 'duracion_min_s', rutas: ['duracion_min_s', 'duracion_p10', 'duracion_s.p10', 'duracion.p10', 'duracion_evento.p10'], min: 0.05, max: 3},
	{campo: 'palabras_objetivo', rutas: ['palabras_p50', 'palabras.p50', 'palabras_por_evento.p50', 'palabras_media', 'palabras_por_subtitulo'], min: 1, max: 3},
	{campo: 'adelanto_cuadros', rutas: ['adelanto_cuadros'], min: -3, max: 6},
	{campo: 'min_palabras', rutas: ['min_palabras'], min: 1, max: 3},
	// El p90 de palabras por subtítulo de tus reels es el máximo; si pasa de 3 se queda en 3 (contrato de la EDL).
	{campo: 'max_palabras', rutas: ['max_palabras', 'palabras_por_evento.p90'], min: 1, max: 50},
	{campo: 'ancho_tope', rutas: ['ancho_tope', '@franja_subtitulos.ancho_p90.p90'], min: 100, max: BASE_ANCHO},
	{campo: 'escala_min', rutas: ['escala_min'], min: 0.5, max: 1},
];

const COLOR = /^(#[0-9a-f]{6}|#[0-9a-f]{3}|rgba?\([\d.,\s%]+\))$/i;

/** Lee una ruta con puntos; "@x.y" busca desde la raíz del JSON y no desde la sección de subtítulos. */
function enRuta(raiz: unknown, seccion: unknown, ruta: string, desenvolver = true): unknown {
	const [desde, camino] = ruta.startsWith('@') ? [raiz, ruta.slice(1)] : [seccion, ruta];
	let actual: unknown = desde;
	for (const llave of camino.split('.')) {
		if (typeof actual !== 'object' || actual === null) return undefined;
		actual = (actual as Record<string, unknown>)[llave];
	}
	// Métrica con el formato del plan: {valor, n, fuente, falta}.
	if (desenvolver && typeof actual === 'object' && actual !== null && 'valor' in actual) return (actual as {valor: unknown}).valor;
	return actual;
}

const esNA = (v: unknown): boolean => v === 'N/A' || v === null;

/**
 * Lee el mini-estilo (lo arma medir.ts). Busca la sección `subtitulos`, si no `resumen` (el formato de salida de
 * medir.ts), si no la raíz. Acepta números sueltos o métricas {valor, n, fuente, falta}; los "N/A" y los null se
 * ignoran. Un valor fuera de rango → código 2.
 */
export function leerMiniEstilo(ruta: string): MiniEstilo {
	const datos = leerJson(ruta, 'leer el mini-estilo', `revisa la ruta de --estilo (${USO})`);
	if (typeof datos !== 'object' || datos === null) throw fallo('leer el mini-estilo', `${ruta} no es un objeto JSON`, 'revisa el archivo', 2);
	const raizJson = datos as Record<string, unknown>;
	const llaveSeccion = ['subtitulos', 'resumen'].find((k) => typeof raizJson[k] === 'object' && raizJson[k] !== null);
	const seccion = llaveSeccion ? raizJson[llaveSeccion] : datos;
	const nombre = rutaLegible(ruta);
	const prefijo = llaveSeccion ? `${llaveSeccion}.` : '';
	/** Ruta completa dentro del JSON ("subtitulos.y.p50"), para `origen` y los mensajes. */
	const enJson = (rutaCampo: string): string => (rutaCampo.startsWith('@') ? rutaCampo.slice(1) : prefijo + rutaCampo);
	const donde = (rutaCampo: string): string => `${nombre}: ${enJson(rutaCampo)}`;
	const r: MiniEstilo = {estilo: {}, parametros: {}, origen: {}, na: []};
	const fuera = (campo: string, ruta: string, valor: unknown, rango: string) =>
		fallo('leer el mini-estilo', `${nombre} trae ${enJson(ruta)} = ${JSON.stringify(valor)} para ${campo}, fuera de ${rango}`, 'corrige el mini-estilo o vuelve a correr medir.ts', 2);

	for (const n of NUMEROS) {
		for (const rutaCampo of n.rutas) {
			const valor = enRuta(datos, seccion, rutaCampo);
			// Un objeto sin "valor" (p. ej. {p10, p50, p90}) se lee con la ruta siguiente ("y.p50").
			if (valor === undefined || (typeof valor === 'object' && valor !== null)) continue;
			if (esNA(valor)) {
				r.na.push(`${n.campo} (${donde(rutaCampo)})`);
				break;
			}
			if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < n.min || valor > n.max) throw fuera(n.campo, rutaCampo, valor, `${n.min}–${n.max}`);
			const crudo = enRuta(datos, seccion, rutaCampo, false);
			if (n.campo === 'adelanto_cuadros' && typeof crudo === 'object' && crudo !== null) {
				r.adelantoMedido = {cuadros: valor, donde: donde(rutaCampo)};
				break;
			}
			r.origen[n.campo] = donde(rutaCampo);
			if (n.campo === 'duracion_min_s') r.parametros.duracionMinS = valor;
			else if (n.campo === 'palabras_objetivo') r.parametros.palabrasObjetivo = valor;
			else if (n.campo === 'adelanto_cuadros') r.parametros.adelantoCuadros = Math.round(valor);
			else if (n.campo === 'min_palabras') r.parametros.minPalabras = Math.round(valor);
			else if (n.campo === 'max_palabras') {
				r.parametros.maxPalabras = Math.min(3, Math.max(1, Math.round(valor)));
				if (r.parametros.maxPalabras !== valor) r.origen.max_palabras += ` (${valor} → ${r.parametros.maxPalabras})`;
			} else if (n.campo === 'ancho_tope') r.parametros.anchoTopePx = valor;
			else if (n.campo === 'escala_min') r.parametros.escalaMin = valor;
			else if (n.campo === 'alto_mayuscula_px') r.altoMayusculaPx = valor;
			else (r.estilo as Record<string, number>)[n.campo] = valor;
			break;
		}
	}
	// Cuánto se puede achicar un grupo: lo que varía el alto de mayúscula de tus subtítulos entre reels (p10 ÷ p50).
	if (r.parametros.escalaMin === undefined) {
		const alto = enRuta(datos, seccion, '@franja_subtitulos.alto_mayuscula', false) as {valor?: unknown; p10?: unknown} | undefined;
		if (alto && typeof alto.valor === 'number' && typeof alto.p10 === 'number' && alto.valor > 0 && alto.p10 > 0 && alto.p10 <= alto.valor) {
			r.parametros.escalaMin = Math.max(0.5, Math.floor((alto.p10 / alto.valor) * 100) / 100);
			r.origen.escala_min = `${nombre}: franja_subtitulos.alto_mayuscula p10 ÷ valor (${alto.p10} ÷ ${alto.valor})`;
		}
	}
	for (const [campo, rutas] of [
		['color', ['color', 'color_texto']],
		['color_borde', ['color_borde']],
	] as const) {
		for (const rutaCampo of rutas) {
			const valor = enRuta(datos, seccion, rutaCampo);
			if (valor === undefined || (typeof valor === 'object' && valor !== null)) continue;
			if (esNA(valor)) {
				r.na.push(`${campo} (${donde(rutaCampo)})`);
				break;
			}
			if (typeof valor !== 'string' || !COLOR.test(valor.trim())) throw fuera(campo, rutaCampo, valor, 'un color #RRGGBB');
			r.estilo[campo] = valor.trim();
			r.origen[campo] = donde(rutaCampo);
			break;
		}
	}
	// La tipografía va en "tipografia". En el mini-estilo de medir.ts, "fuente" es de dónde salió el dato
	// ("medido"), así que "fuente" solo cuenta si nombra una candidata.
	const idDeFuente = (valor: unknown) =>
		IDS_FUENTE.find((x) => typeof valor === 'string' && (x === valor || candidata(x).nombre.toLowerCase() === valor.trim().toLowerCase()));
	const tipografia = enRuta(datos, seccion, 'tipografia');
	if (tipografia !== undefined && !esNA(tipografia)) {
		const id = idDeFuente(tipografia);
		if (!id) throw fuera('tipografia', 'tipografia', tipografia, `las candidatas (${IDS_FUENTE.join(', ')})`);
		r.estilo.fuente = id;
		r.origen.fuente = donde('tipografia');
	} else {
		const fuente = enRuta(datos, seccion, 'fuente');
		const id = idDeFuente(fuente);
		if (id) {
			r.estilo.fuente = id;
			r.origen.fuente = donde('fuente');
		}
	}
	for (const campo of ['mayusculas', 'quitar_puntuacion'] as const) {
		const valor = enRuta(datos, seccion, campo);
		if (valor === undefined || esNA(valor)) continue;
		// medir.ts guarda "mayusculas" como métrica: % de eventos en MAYÚSCULAS (la mayoría decide).
		if (campo === 'mayusculas' && typeof valor === 'number' && Number.isFinite(valor)) {
			if (valor < 0 || valor > 100) throw fuera(campo, campo, valor, '0–100');
			r.estilo.mayusculas = valor >= 50;
			r.origen.mayusculas = `${donde(campo)} (${valor} % ≥ 50 → ${r.estilo.mayusculas})`;
			continue;
		}
		if (typeof valor !== 'boolean') throw fuera(campo, campo, valor, 'true o false');
		r.estilo[campo] = valor;
		r.origen[campo] = donde(campo);
	}
	// medir.ts da el % de subtítulos en MAYÚSCULAS: si es la mayoría, se dibujan en mayúsculas.
	const pctMayusculas = enRuta(datos, seccion, 'mayusculas_pct');
	if (r.estilo.mayusculas === undefined && typeof pctMayusculas === 'number' && Number.isFinite(pctMayusculas)) {
		if (pctMayusculas < 0 || pctMayusculas > 100) throw fuera('mayusculas', 'mayusculas_pct', pctMayusculas, '0–100');
		r.estilo.mayusculas = pctMayusculas >= 50;
		r.origen.mayusculas = `${donde('mayusculas_pct')} (${pctMayusculas} % ≥ 50 → ${r.estilo.mayusculas})`;
	}
	// En medir.ts, "resaltado" es una métrica (% de eventos con resaltado), no la configuración: se ignora aquí.
	const resaltado = enRuta(datos, seccion, 'resaltado');
	if (typeof resaltado === 'object' && resaltado !== null) {
		const rs = resaltado as Record<string, unknown>;
		const parcial: Partial<EstiloSubtitulo['resaltado']> = {};
		if (typeof rs.activo === 'boolean') parcial.activo = rs.activo;
		if (typeof rs.peso === 'number' && rs.peso >= 100 && rs.peso <= 900) parcial.peso = rs.peso;
		if (rs.color === null || (typeof rs.color === 'string' && COLOR.test(rs.color))) parcial.color = rs.color as string | null;
		if (typeof rs.escala === 'number' && rs.escala >= 0.5 && rs.escala <= 2) parcial.escala = rs.escala;
		if (Object.keys(parcial).length > 0) {
			r.estilo.resaltado = parcial;
			r.origen.resaltado = donde('resaltado');
		}
	}
	return r;
}

// ───────────────────────── etapa completa ─────────────────────────

export type OpcionesSubtitulos = {
	slug: string;
	/** Ruta del mini-estilo. Sin ella se usa estilo/mini-estilo.json si existe; `null` = ninguno. */
	estilo?: string | null;
	fuente?: string;
	resaltar?: readonly number[];
	adelantoCuadros?: number;
	/** Palabras mínimas y máximas por subtítulo (--min-palabras / --max-palabras). */
	minPalabras?: number;
	maxPalabras?: number;
	/** Lo más que se achica un grupo para caber en una línea (--escala-min; 1 = nunca). */
	escalaMin?: number;
	proyectos?: string;
	/** Raíz donde están biblioteca/fuentes (para pruebas). */
	raiz?: string;
};

export type ResultadoSubtitulos = ResultadoAgrupador & {
	salida: string;
	estilo: EstiloSubtitulo;
	parametros: ParametrosAgrupador;
	origen: Record<string, string>;
	segundos: number;
};

export async function generarSubtitulos(opciones: OpcionesSubtitulos): Promise<ResultadoSubtitulos> {
	const t0 = performance.now();
	const proyectos = opciones.proyectos ?? DIR_PROYECTOS;
	const raiz = opciones.raiz ?? RAIZ;
	const slug = validarSlug(opciones.slug);
	const dir = dirProyecto(slug, proyectos);
	const rutaEntrada = join(dir, NOMBRE_ENTRADA);
	const transcripcion = leerTranscripcionBase(rutaEntrada);
	const entradas: ArchivoHash[] = [await hashearArchivo(rutaEntrada)];
	const avisos: string[] = [];

	// Bordes de los tramos de keep[] en la base.
	let keep = transcripcion.keep;
	let origenKeep = keep ? `${NOMBRE_ENTRADA}: keep` : '';
	const rutaCortes = join(dir, 'cortes.json');
	if (!keep && existsSync(rutaCortes)) {
		const cortes = leerJson(rutaCortes, 'leer los cortes', 'revisa cortes.json') as {keep?: unknown};
		const r = z.array(TramoEntrada).min(1).safeParse(cortes?.keep);
		if (!r.success) throw fallo('leer los cortes', `cortes.json no trae "keep": [{desde, hasta}] (${problemaZod(r.error)})`, `revisa ${rutaCortes}`, 2);
		keep = r.data.map(({desde, hasta}) => ({desde, hasta}));
		origenKeep = 'cortes.json';
		entradas.push(await hashearArchivo(rutaCortes));
	}
	const etapaBase = leerManifest(slug, proyectos)?.etapas.base;
	const duracionBaseS = (etapaBase?.verificacion as {duracion_video_s?: number} | undefined)?.duracion_video_s;
	// Velocidad: la de transcripcion-base.json (cortes.ts ya dividió los tiempos entre ella). La base del manifest
	// tiene que ser de esa misma velocidad; si no, los subtítulos se irían desfasando a lo largo del video.
	const velocidad = transcripcion.velocidad ?? 1;
	const velocidadBase = etapaBase?.parametros?.velocidad ?? 1;
	if (etapaBase && (!esVelocidadValida(velocidadBase) || Math.abs(velocidadBase - velocidad) > 1e-9)) {
		throw fallo(
			'agrupar los subtítulos',
			`la base del manifest se hizo a ×${String(velocidadBase)} y ${NOMBRE_ENTRADA} va a ×${velocidad}: los subtítulos no caerían con la voz`,
			`vuelve a correr npx tsx herramientas/base.ts ${slug} --cortes proyectos/${slug}/cortes.json (toma la velocidad de cortes.json)`,
			2,
		);
	}
	let tramos: TramoBase[];
	if (keep) {
		tramos = tramosEnBase(keep, velocidad);
		if (velocidad !== 1) origenKeep += ` (base a ×${velocidad})`;
	} else {
		const fin = duracionBaseS ?? transcripcion.duracionS ?? Infinity;
		tramos = [{desde: 0, hasta: fin}];
		origenKeep = 'sin cortes: un solo tramo';
		if (!Number.isFinite(fin)) avisos.push('no sé cuánto dura la base (sin cortes.json ni base en el manifest): el último subtítulo no se recorta al final');
	}
	// base.ts recorta el último tramo a lo que de verdad dura el clip.
	const ultimo = tramos[tramos.length - 1];
	if (duracionBaseS !== undefined && duracionBaseS < ultimo.hasta && duracionBaseS > ultimo.desde) ultimo.hasta = duracionBaseS;

	const palabras = normalizarPalabras(transcripcion.palabras, tramos);

	// Estilo: por defecto ← mini-estilo ← argumentos.
	// Por defecto, tu estilo completo (estilo/estilo.json: tipografía elegida comparando con tus reels); si no existe, el mini-estilo de la Fase 1.
	const rutaMini = opciones.estilo === null ? null : opciones.estilo ? resolve(opciones.estilo) : existsSync(ESTILO_COMPLETO) ? ESTILO_COMPLETO : existsSync(MINI_ESTILO_POR_DEFECTO) ? MINI_ESTILO_POR_DEFECTO : null;
	const mini = rutaMini ? leerMiniEstilo(rutaMini) : null;
	if (rutaMini) entradas.push(await hashearArchivo(rutaMini));
	const parcial: EstiloSubtituloParcial = {...(mini?.estilo ?? {})};
	const origen: Record<string, string> = {...(mini?.origen ?? {})};
	if (opciones.fuente !== undefined) {
		if (!esIdFuente(opciones.fuente)) throw fallo('leer los argumentos', `no conozco la fuente "${opciones.fuente}"`, `usa una de: ${IDS_FUENTE.join(', ')}`, 2);
		parcial.fuente = opciones.fuente;
		origen.fuente = '--fuente';
	}
	// Zona del estilo activo (perfil.json → motor.zona.subtitulos_y): con el estilo por defecto, la y de los subtítulos
	// es la que decide el estilo (dentro de la zona segura de Reels) en vez de la medida. Con un --estilo explícito
	// manda ese archivo.
	const zona = leerPerfilMotor().zona;
	if (opciones.estilo === undefined && rutaMini === ESTILO_COMPLETO && zona.subtitulos_y !== null) {
		const medido = parcial.y;
		parcial.y = zona.subtitulos_y;
		origen.y = `${zona.nota} (perfil del estilo → motor.zona.subtitulos_y) sobre lo medido${medido !== undefined ? ` (${origen.y ?? 'estilo.json'} = ${medido})` : ''}`;
	}
	const estiloPrevio = resolverEstilo(parcial);
	if (mini?.altoMayusculaPx !== undefined && mini.estilo.tamano_px === undefined) {
		// El alto de mayúscula medido se vuelve tamaño de letra con la fuente elegida.
		parcial.tamano_px = Math.round((mini.altoMayusculaPx / candidata(estiloPrevio.fuente).altoMayuscula) * 10) / 10;
		origen.tamano_px = `${origen.alto_mayuscula_px} ÷ alto de mayúscula de ${candidata(estiloPrevio.fuente).nombre}`;
	}
	const estilo = resolverEstilo(parcial);
	estilo.peso = pesoDisponible(estilo.fuente, estilo.peso);
	estilo.resaltado.peso = pesoDisponible(estilo.fuente, estilo.resaltado.peso);
	const vocabulario = leerTerminos(join(raiz, 'biblioteca', 'vocabulario.json'));
	if (vocabulario.aviso) avisos.push(vocabulario.aviso);
	const parametros: ParametrosAgrupador = {...PARAMETROS_POR_DEFECTO, ...(mini?.parametros ?? {}), terminos: vocabulario.terminos};
	if (opciones.adelantoCuadros !== undefined) {
		parametros.adelantoCuadros = opciones.adelantoCuadros;
		origen.adelanto_cuadros = '--adelanto-cuadros';
	}
	if (opciones.minPalabras !== undefined) {
		parametros.minPalabras = opciones.minPalabras;
		origen.min_palabras = '--min-palabras';
	}
	if (opciones.maxPalabras !== undefined) {
		parametros.maxPalabras = opciones.maxPalabras;
		origen.max_palabras = '--max-palabras';
	}
	if (opciones.escalaMin !== undefined) {
		parametros.escalaMin = opciones.escalaMin;
		origen.escala_min = '--escala-min';
	}
	origen.min_palabras ??= 'por defecto 2: el estilo pide subtítulos de 2–3 palabras (2026-10-04); el p50 de tus reels es 2 (estilo.json → subtitulos.palabras_por_evento.p50)';
	origen.max_palabras ??= 'por defecto 3 (contrato de la EDL; p90 de tus reels = 3)';
	origen.ancho_tope ??= 'por defecto = ancho_max (sin franja_subtitulos.ancho_p90 en el estilo)';
	origen.escala_min ??= 'por defecto 0.91 (p10 ÷ p50 del alto de mayúscula de tus subtítulos en estilo.json del 2026-10)';
	origen.escala_min += ` · nunca menos de ${ESCALA_MIN_ABSOLUTA} (revisión v11 de un reel de prueba, 2026-10-04)`;
	origen.ancho_tope += ' · o la zona segura de subtítulos si es mayor (src/estilo/zona-segura.ts, 810 px)';
	origen.pausa_suelta_s = 'por defecto 0.46 s (supuesto; la calibración de cortes, estilo/calibracion-cortes.json → pausas.umbral_s, dice la pausa que cortas)';
	for (const campo of ['ancho_max', 'y', 'tamano_px', 'borde_px', 'color', 'color_borde', 'fuente']) {
		origen[campo] ??= 'por defecto (supuesto hasta medirlo)';
	}
	origen.duracion_min_s ??= 'por defecto (0.3 s, supuesto)';
	origen.palabras_objetivo ??= 'por defecto (2.5, supuesto)';
	origen.adelanto_cuadros ??= mini?.adelantoMedido
		? `por defecto 0 (la sincronía acordada pide entrar con la palabra: p50 ≤ 25 ms); tus reels adelantan ${mini.adelantoMedido.cuadros} cuadros (${mini.adelantoMedido.donde}): para igualarlos, --adelanto-cuadros ${Math.max(0, Math.round(mini.adelantoMedido.cuadros))}`
		: 'por defecto (0 cuadros: entra con su palabra)';
	if (mini?.adelantoMedido && opciones.adelantoCuadros === undefined && parametros.adelantoCuadros === 0) {
		avisos.push(`tus reels adelantan los subtítulos ${mini.adelantoMedido.cuadros} cuadros; uso 0 para cumplir la sincronía acordada (decisión pendiente tuya: --adelanto-cuadros ${Math.max(0, Math.round(mini.adelantoMedido.cuadros))} para igualarlos)`);
	}
	origen.keep = origenKeep;
	if (!rutaMini) avisos.push('sin mini-estilo: ancho máximo, Y, tamaño, borde y colores son supuestos hasta medir tus reels (ver "origen" en subtitulos.json)');
	if (mini?.na.length) avisos.push(`el mini-estilo trae N/A en: ${mini.na.join(', ')} (uso el valor por defecto)`);

	const resaltar = [...(opciones.resaltar ?? [])];
	if (resaltar.length > 0 && !estilo.resaltado.activo) avisos.push('pediste --resaltar, pero el resaltado está apagado en el estilo: se mide sin resaltar');
	const fuenteUsada = archivoFuente(estilo.fuente, estilo.peso);
	const pesosUsados = estilo.resaltado.activo ? [estilo.peso, estilo.resaltado.peso] : [estilo.peso];
	for (const peso of new Set(pesosUsados)) {
		const archivo = archivoFuente(estilo.fuente, peso);
		abrirFuente(join(raiz, archivo.ruta)); // si falta: código 2 con el siguiente paso
		const hash = await hashearArchivo(join(raiz, archivo.ruta));
		entradas.push(hash);
		if (hash.sha256 !== archivo.sha256) {
			avisos.push(`${archivo.ruta} no es la instancia registrada (sha256 distinto): los anchos valen igual porque el render usa ese mismo archivo, pero vuelve a correr biblioteca/fuentes/preparar.sh`);
		}
	}

	const resultado = agruparSubtitulos(palabras, tramos, estilo, parametros, crearMedidor(estilo, resaltar, raiz));
	resultado.avisos.unshift(...avisos);

	const salida = join(dir, NOMBRE_SALIDA);
	const contenido = {
		version: 1,
		generado: new Date().toISOString(),
		slug,
		entrada: NOMBRE_ENTRADA,
		fuente: {id: estilo.fuente, nombre: candidata(estilo.fuente).nombre, peso: estilo.peso, archivo: fuenteUsada.ruta, sha256: fuenteUsada.sha256},
		estilo,
		parametros: {
			fps: FPS,
			pausa_s: parametros.pausaS,
			duracion_min_s: parametros.duracionMinS,
			adelanto_cuadros: parametros.adelantoCuadros,
			palabras_objetivo: parametros.palabrasObjetivo,
			rellenar_hueco_s: parametros.rellenarHuecoS,
			min_palabras: parametros.minPalabras,
			max_palabras: parametros.maxPalabras,
			pausa_suelta_s: parametros.pausaSueltaS,
			ancho_tope_px: formaDe(estilo, parametros).anchoTope + MARGEN_ANTIALIAS_PX,
			escala_min: formaDe(estilo, parametros).escalaMin,
			terminos_sin_partir: parametros.terminos,
			resaltar,
		},
		origen,
		tramos_base: tramos.map((t) => ({desde: t.desde, hasta: Number.isFinite(t.hasta) ? t.hasta : null})),
		resumen: resultado.resumen,
		avisos: resultado.avisos,
		subtitulos: resultado.subtitulos,
	};
	const temporal = `${salida}.tmp-${process.pid}`;
	writeFileSync(temporal, `${JSON.stringify(contenido, null, '\t')}\n`);
	renameSync(temporal, salida);

	const segundos = (performance.now() - t0) / 1000;
	registrarEtapa(
		slug,
		'subtitulos',
		{
			estado: 'terminada',
			entradas,
			parametros: {version: 1, estilo, ...contenido.parametros},
			salidas: [await hashearArchivo(salida, dir)],
			extra: {resumen: resultado.resumen, duracion_proceso_s: Number(segundos.toFixed(3))},
		},
		proyectos,
	);
	return {...resultado, salida, estilo, parametros, origen, segundos};
}

export function resumenTexto(r: ResultadoSubtitulos): string {
	const {resumen: s, estilo: e} = r;
	const lineas = [
		`Listo: ${s.subtitulos} subtítulos de ${s.palabras} palabras (${s.por_tamano[1]} de 1, ${s.por_tamano[2]} de 2 y ${s.por_tamano[3]} de 3) en ${s.tramos_con_palabras} tramo${s.tramos_con_palabras === 1 ? '' : 's'} → ${relative(RAIZ, r.salida) || r.salida}`,
		`  ${candidata(e.fuente).nombre} ${e.peso}, ${e.tamano_px} px, borde ${e.borde_px} px · ancho máximo medido ${s.ancho_max_medido_px} de ${e.ancho_max} px · ${s.escalados} escalado${s.escalados === 1 ? '' : 's'} · ${s.bajo_duracion_minima} bajo la duración mínima por falta de lugar`,
	];
	for (const aviso of r.avisos) lineas.push(`  Aviso: ${aviso}.`);
	return lineas.join('\n');
}

function enteroDeArgumento(nombre: string, valor: string | undefined): number | undefined {
	if (valor === undefined) return undefined;
	const n = Number(valor);
	if (valor.trim() === '' || !Number.isInteger(n)) throw fallo('leer los argumentos', `${nombre} tiene que ser un número entero (llegó "${valor}")`, `usa ${USO}`, 2);
	return n;
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				estilo: {type: 'string'},
				fuente: {type: 'string'},
				resaltar: {type: 'string'},
				'adelanto-cuadros': {type: 'string'},
				'min-palabras': {type: 'string'},
				'max-palabras': {type: 'string'},
				'escala-min': {type: 'string'},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error);
		const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
		throw fallo('leer los argumentos', desconocida ? `no conozco la opción ${desconocida[1]}` : 'los argumentos no tienen la forma esperada', `usa ${USO}`, 2, mensaje);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	if (posicionales.length !== 1) {
		throw fallo('armar los subtítulos', posicionales.length === 0 ? 'falta el slug del proyecto' : 'me pasaste más de un slug', `usa ${USO}`, 2);
	}
	const resaltar = valores.resaltar
		? valores.resaltar.split(',').map((x) => {
				const n = Number(x.trim());
				if (x.trim() === '' || !Number.isInteger(n) || n < 0) throw fallo('leer los argumentos', `--resaltar lleva índices de palabra separados por coma (llegó "${x}")`, `usa ${USO}`, 2);
				return n;
			})
		: [];
	const adelanto = enteroDeArgumento('--adelanto-cuadros', valores['adelanto-cuadros']);
	if (adelanto !== undefined && (adelanto < 0 || adelanto > 6)) throw fallo('leer los argumentos', '--adelanto-cuadros va de 0 a 6', `usa ${USO}`, 2);
	const minPalabras = enteroDeArgumento('--min-palabras', valores['min-palabras']);
	const maxPalabras = enteroDeArgumento('--max-palabras', valores['max-palabras']);
	for (const [nombre, n] of [['--min-palabras', minPalabras], ['--max-palabras', maxPalabras]] as const) {
		if (n !== undefined && (n < 1 || n > 3)) throw fallo('leer los argumentos', `${nombre} va de 1 a 3`, `usa ${USO}`, 2);
	}
	let escalaMin: number | undefined;
	if (valores['escala-min'] !== undefined) {
		escalaMin = Number(valores['escala-min']);
		if (valores['escala-min'].trim() === '' || !(escalaMin >= 0.5 && escalaMin <= 1)) throw fallo('leer los argumentos', `--escala-min va de 0.5 a 1 (llegó "${valores['escala-min']}")`, `usa ${USO}`, 2);
	}
	const r = await generarSubtitulos({slug: posicionales[0], estilo: valores.estilo, fuente: valores.fuente, resaltar, adelantoCuadros: adelanto, minPalabras, maxPalabras, escalaMin});
	console.log(resumenTexto(r));
}

if (esPrincipal(import.meta.url)) await correr(main);
