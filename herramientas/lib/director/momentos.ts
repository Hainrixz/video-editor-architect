// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Momentos del transcript que piden una capa: tarjetas, listas (enumeraciones de 3+ cosas cortas en ≤ 4 s), stickers
 * (logo en la PRIMERA mención de cada marca del catálogo y mascota por conceptos de las palabras) y momentos que piden una
 * demo de pantalla ("te vas a la parte de", "copias la liga", "le pegas", "vas a buscar", "abres"…). Todo puro y
 * determinista.
 *
 * Tarjetas por tipo de palabra, como las eliges tú (estilo/momentos.jsonl: 628 tarjetas de tus reels → 51 % "clave",
 * 27 % "frase", 11 % cifra, 6 % producto, 5 % pregunta):
 *  - cifra: "quince" → "15", "veinte dólares" → "$20" (puntaje 5).
 *  - producto: la primera mención de una marca o nombre propio (4; 3 si tiene logo: ahí va el sticker).
 *  - pregunta: la de tu cierre ("coméntame qué página vas a construir" → "¿Qué página vas a construir?") o una dicha
 *    con signos (4).
 *  - clave: el sustantivo o el verbo clave de cada frase ("la aplicación de Claude" → "Aplicación de Claude",
 *    "activas" → "Activas"), lo que sigue a "la parte de", "se llama", "es…", pasos y "modo X" (2–3.5).
 *  - frase: una cláusula corta tal cual, de 2 a 3 palabras ("No me creas", "Lo lees") (1.8; 3.2 si es verbal).
 *
 * Forma (decisión del estilo, 2026-10-04: resaltados de dos a tres palabras, que no sean muchas): ninguna
 * tarjeta del borrador pasa de MAX_PALABRAS_TARJETA (3) palabras, tampoco frases ni preguntas (en sus reels viejos había
 * frases de 4 y preguntas de cierre de 5–7; ya no se proponen). Se prefieren 2–3: una de 1 palabra pesa
 * PENALIZACION_UNA_PALABRA menos, salvo marcas (si su logo cabe, va el logo y la tarjeta cede) y cifras ("$20", "15").
 * Una clave de 1 palabra precedida de su verbo se dice completa ("mejorar las animaciones" → "Mejorar las animaciones").
 * Las tarjetas "prompt" solo las escribe Claude a mano (notas-director.json) y no tienen este límite.
 */
import {
	capitalizar,
	conMayuscula,
	contarPalabras,
	detectarCifras,
	DETERMINANTES,
	fraseNominal,
	GENERICOS,
	limpiar,
	MAX_CARACTERES_TARJETA,
	MAX_PALABRAS_TARJETA,
	normalizar,
	PARADAS,
	terminaClausula,
	terminaFrase,
	textoDeTarjeta,
	type Palabra,
} from './texto.ts';

export type ItemLista = {texto: string; t: number; i0: number};

/** Lo que pierde una tarjeta de 1 palabra que no es marca ni cifra (así gana su versión de 2–3 si la hay). */
export const PENALIZACION_UNA_PALABRA = 1;

/** Tipo de palabra de una tarjeta (los de medir-capas.ts en tus reels). */
export type TipoPalabra = 'clave' | 'frase' | 'cifra' | 'producto' | 'pregunta' | 'lista';

export type Candidato = {
	/** Estable entre corridas: tipo + índice de su primera palabra. */
	clave: string;
	tipo: 'tarjeta' | 'lista' | 'sticker';
	/** Solo tarjetas y listas: qué tipo de palabra es (para comparar con tus reels). */
	tipo_palabra?: TipoPalabra;
	i0: number;
	i1: number;
	t: number;
	/** Palabra(s) que lo disparan, como se dijeron. */
	palabra: string;
	/** La cláusula donde cae (contexto para direccion.md). */
	frase: string;
	puntaje: number;
	motivo: string;
	texto?: string;
	items?: ItemLista[];
	sticker?: {concepto: string; etiquetas: string[]; marca: string | null; logo: boolean};
	alternativas: string[];
};

export type MomentoDemo = {t: number; i0: number; accion: string; frase: string};

export type Marca = {i0: number; i1: number; texto: string; canon: string; logo: string | null};

export type EntradaLogo = {id: string; marca: string; variante: string; archivo: string};

// ───────────────────────── utilidades ─────────────────────────

const norm = (p: Palabra): string => normalizar(limpiar(p.t));

/** Texto de la cláusula que contiene la palabra k (entre puntuaciones). */
export function clausulaDe(palabras: readonly Palabra[], k: number): string {
	let a = k;
	while (a > 0 && !terminaClausula(palabras[a - 1].t)) a--;
	let b = k;
	while (b < palabras.length - 1 && !terminaClausula(palabras[b].t)) b++;
	return palabras
		.slice(a, b + 1)
		.map((p) => p.t)
		.join(' ');
}

const inicioDeFrase = (palabras: readonly Palabra[], k: number): boolean => k === 0 || terminaFrase(palabras[k - 1].t);

// ───────────────────────── marcas ─────────────────────────

/**
 * Marcas y productos: términos del vocabulario y del catálogo de logos (el más largo primero), extendidos con lo que les
 * siga en mayúscula o con versión ("Claude" + "WebKit", "Opus" + "5.5"), y nombres propios (mayúscula fuera del inicio
 * de frase). `logo` = id del logo (tile) del catálogo si la marca está ahí.
 */
export function detectarMarcas(palabras: readonly Palabra[], op: {terminos: readonly string[]; logos: readonly EntradaLogo[]}): Marca[] {
	const conocidos = [...new Set([...op.terminos, ...op.logos.map((l) => l.marca)])]
		.map((t) => ({texto: t, partes: t.split(/\s+/).map((x) => normalizar(x))}))
		.sort((a, b) => b.partes.length - a.partes.length);
	const logoDe = (canon: string): string | null => {
		const n = normalizar(canon);
		const tile = op.logos.find((l) => normalizar(l.marca) === n && l.variante === 'tile') ?? op.logos.find((l) => normalizar(l.marca) === n);
		return tile ? tile.id : null;
	};
	const salida: Marca[] = [];
	for (let k = 0; k < palabras.length; k++) {
		let i1 = -1;
		let canon: string[] = [];
		for (const c of conocidos) {
			const L = c.partes.length;
			if (k + L > palabras.length) continue;
			let ok = true;
			for (let j = 0; j < L; j++) {
				if (norm(palabras[k + j]) !== c.partes[j] || (j < L - 1 && terminaClausula(palabras[k + j].t))) {
					ok = false;
					break;
				}
			}
			// Palabras comunes del vocabulario ("prompt") solo cuentan como marca si van en mayúscula.
			if (ok && L === 1 && !conMayuscula(palabras[k].t) && c.texto === c.texto.toLowerCase()) ok = false;
			if (ok) {
				i1 = k + L;
				canon = c.texto.split(/\s+/);
				break;
			}
		}
		if (i1 < 0) {
			if (!conMayuscula(palabras[k].t) || inicioDeFrase(palabras, k)) continue;
			if (/^\p{Lu}[\p{Ll}]{0,2}$/u.test(limpiar(palabras[k].t)) && PARADAS.has(norm(palabras[k]))) continue;
			i1 = k + 1;
			canon = [limpiar(palabras[k].t)];
		}
		// Extender con mayúsculas o versión, sin cruzar puntuación.
		while (i1 < palabras.length && !terminaClausula(palabras[i1 - 1].t)) {
			const sig = limpiar(palabras[i1].t);
			if (conMayuscula(palabras[i1].t) || /^\d+([.,]\d+)?$/.test(sig)) {
				canon.push(sig);
				i1++;
			} else break;
		}
		const texto = canon.join(' ');
		salida.push({i0: k, i1, texto, canon: texto, logo: logoDe(texto)});
		k = i1 - 1;
	}
	return salida;
}

// ───────────────────────── tarjetas ─────────────────────────

const PASOS = new Set(['primero', 'segundo', 'tercero', 'despues', 'luego', 'finalmente']);
const LLAMA = new Set(['llama', 'llame', 'llaman', 'llamado', 'llamada', 'llamados', 'llamadas']);

/**
 * Palabras de relleno o muy generales que nunca son "la palabra clave" de una frase (sin acentos). Las de PARADAS y
 * DETERMINANTES tampoco cuentan.
 */
export const RELLENO = new Set(
	[
		'entonces', 'pues', 'bueno', 'verdad', 'mismo', 'misma', 'mismos', 'serio', 'nada', 'algo', 'cosa', 'cosas', 'quieras', 'quieres',
		'tener', 'tienes', 'tenga', 'hacer', 'hace', 'haces', 'haga', 'poner', 'pones', 'decir', 'dices', 'dice', 'vamos', 'puedes', 'puede',
		'necesitas', 'tengo', 'ahora', 'luego', 'despues', 'antes', 'primero', 'aqui', 'alla', 'ahi', 'cuando', 'donde', 'como', 'porque',
		'asi', 'tambien', 'otra', 'otro', 'otras', 'otros', 'mucho', 'mucha', 'muchos', 'muchas', 'cada', 'literalmente', 'realmente',
		'solamente', 'simplemente', 'obviamente', 'nuevamente', 'gusten', 'guste', 'quiera', 'esta', 'este', 'estos', 'estas', 'esto',
		'eso', 'esa', 'ese', 'esos', 'esas', 'creas', 'crees', 'mande', 'mando', 'manda', 'mandas', 'regresa', 'enfrente', 'parte',
		'calalo', 'chido', 'chida', 'nombre', 'unos', 'unas', 'todo', 'toda', 'todos', 'todas', 'mas', 'menos', 'tanto', 'tanta',
	].map(normalizar),
);

/** Pronombres que van antes del verbo ("lo lees", "te regresa", "no me creas"): abren una frase verbal. */
const CLITICOS = new Set(['lo', 'la', 'los', 'las', 'le', 'les', 'me', 'te', 'se', 'nos', 'no']);

/**
 * ¿Parece un verbo dicho a ti? (heurística, sin diccionario): termina en -as/-es de 2.ª persona ("copias", "pones") y no
 * es plural de sustantivo conocido, o lleva el pronombre pegado ("inténtalo", "coméntame", "cálalo").
 */
export function esVerbo(t: string): boolean {
	const w = normalizar(limpiar(t));
	if (w.length < 4 || PARADAS.has(w) || DETERMINANTES.has(w)) return false;
	if (/(ar|er|ir)(lo|la|los|las|le|les|me|te|nos)$/.test(w) || /[aei](lo|la|me|te|nos)$/.test(w) && /[áéí]/.test(limpiar(t).toLowerCase())) return true;
	// Plurales de sustantivo frecuentes que también terminan en -as/-es ("imágenes", "dependencias") no cuentan; "-ias" solo
	// en palabras largas ("copias", "cambias" sí son verbos).
	return /(as|es)$/.test(w) && !/(ones|ades|ores|ales|ares|eres|nes)$/.test(w) && !(w.length >= 8 && /ias$/.test(w));
}

/** ¿Una palabra puede ser la clave de una frase? (≥ 4 letras, ni de función, ni relleno, ni número suelto). */
export function esContenido(t: string): boolean {
	const w = normalizar(limpiar(t));
	return w.length >= 4 && /^\p{L}/u.test(w) && !PARADAS.has(w) && !DETERMINANTES.has(w) && !RELLENO.has(w);
}

/** Cláusulas del transcript: [a, b] (índices, b incluido) entre puntuaciones. */
export function clausulas(palabras: readonly Palabra[]): Array<[number, number]> {
	const salida: Array<[number, number]> = [];
	let a = 0;
	for (let k = 0; k < palabras.length; k++) {
		if (terminaClausula(palabras[k].t) || k === palabras.length - 1) {
			salida.push([a, k]);
			a = k + 1;
		}
	}
	return salida;
}

/** Palabras de un renglón de tarjeta de pregunta: máx. ~24 caracteres por renglón, en 2 renglones parejos. */
function partirPregunta(texto: string): string {
	if (texto.length <= MAX_CARACTERES_TARJETA) return texto;
	const palabras = texto.split(' ');
	let mejor = texto;
	let peor = Infinity;
	for (let k = 1; k < palabras.length; k++) {
		const a = palabras.slice(0, k).join(' ');
		const b = palabras.slice(k).join(' ');
		const d = Math.max(a.length, b.length);
		if (d < peor) {
			peor = d;
			mejor = `${a}\n${b}`;
		}
	}
	return mejor;
}

/** Máximo de caracteres de una pregunta (2 renglones de ~22). */
export const MAX_CARACTERES_PREGUNTA = 44;

const INICIO_PREGUNTA = new Set(['que', 'cual', 'cuales', 'como', 'cuanto', 'cuantos', 'cuanta', 'cuantas', 'para', 'de', 'donde', 'quien', 'quienes', 'por']);
const PIDE_COMENTARIO = /^(comenta|comentame|comentenme|comentalo|comentanos|cuentame|cuentanos|dime|escribeme|escribe)$/;
/** Palabras que abren una cláusula pero no una frase de tarjeta ("y", "que", "entonces"…). */
const NO_ABREN_FRASE = new Set(['y', 'e', 'o', 'u', 'que', 'pero', 'entonces', 'pues', 'porque', 'como', 'si', 'ya', 'de', 'a', 'en', 'con', 'para', 'por']);

/**
 * Candidatos a tarjeta (sin listas), cada uno con su tipo de palabra. `terminos` = términos del vocabulario: los que van
 * en minúscula ("prompt") no son marcas, pero su primera mención es candidata a tarjeta.
 */
export function candidatosTarjetas(palabras: readonly Palabra[], marcas: readonly Marca[], terminos: readonly string[] = []): Candidato[] {
	const salida: Candidato[] = [];
	const agregar = (i0: number, i1: number, texto: string | null, puntaje: number, motivo: string, tipoPedido: TipoPalabra, alternativas: string[] = []) => {
		if (!texto) return;
		// Una "clave" que es un nombre propio (como lo dijiste: "Claude Code", "Dribbble") es producto, y un "producto" sin
		// ninguno ("página web de Claude" → "Página web") es clave.
		const propio = palabras.slice(i0, i1).some((p) => conMayuscula(p.t) && texto.toLowerCase().includes(limpiar(p.t).toLowerCase()) && !(p === palabras[i0] && inicioDeFrase(palabras, i0)));
		const tipo: TipoPalabra = tipoPedido === 'clave' && propio ? 'producto' : tipoPedido === 'producto' && !propio ? 'clave' : tipoPedido;
		const maxCar = tipo === 'pregunta' ? MAX_CARACTERES_PREGUNTA : MAX_CARACTERES_TARJETA;
		const n = contarPalabras(texto);
		if (n > MAX_PALABRAS_TARJETA || texto.replace('\n', ' ').length > maxCar) return;
		if (n === 1 && tipo !== 'producto' && tipo !== 'cifra') {
			puntaje = Math.round((puntaje - PENALIZACION_UNA_PALABRA) * 10) / 10;
			motivo += ' (1 palabra: prefiero 2–3)';
		}
		salida.push({
			clave: `tarjeta:${palabras[i0].i}`,
			tipo: 'tarjeta',
			tipo_palabra: tipo,
			i0,
			i1,
			t: palabras[i0].d,
			palabra: palabras
				.slice(i0, Math.max(i0 + 1, i1))
				.map((p) => p.t)
				.join(' '),
			frase: clausulaDe(palabras, i0),
			puntaje,
			motivo,
			texto,
			alternativas,
		});
	};
	// 1) Cifras.
	for (const c of detectarCifras(palabras)) agregar(c.i0, c.i1, capitalizar(c.texto), 5, c.tipo === 'porcentaje' ? 'porcentaje (en dígitos)' : c.tipo === 'dinero' ? 'dinero (en dígitos)' : 'cifra (en dígitos)', 'cifra');
	// 2) Marcas: la primera mención de cada una (una mención contenida en otra anterior es repetición).
	const vistas: string[] = [];
	/** Palabras donde arranca la primera mención de una marca: ya tienen su candidato, no son la clave de su cláusula. */
	const primeraMarcaEn = new Set<number>();
	for (const m of marcas) {
		const n = normalizar(m.canon);
		if (vistas.some((v) => v === n || v.includes(n))) continue;
		vistas.push(n);
		for (let j = m.i0; j < m.i1; j++) primeraMarcaEn.add(j);
		agregar(m.i0, m.i1, textoDeTarjeta(m.canon.split(/\s+/)), m.logo ? 3 : 4, m.logo ? `marca "${m.canon}" (también tiene logo en el catálogo)` : `marca o producto "${m.canon}" (primera mención)`, 'producto', m.logo ? [`sticker del logo (${m.logo})`] : []);
	}
	// 2b) Términos del vocabulario en minúscula ("prompt"): su primera mención.
	for (const termino of terminos.filter((x) => x === x.toLowerCase())) {
		const partes = termino.split(/\s+/).map((x) => normalizar(x));
		const k = palabras.findIndex((_, j) => partes.every((p, q) => palabras[j + q] && norm(palabras[j + q]) === p));
		if (k >= 0) agregar(k, k + partes.length, textoDeTarjeta(palabras.slice(k, k + partes.length).map((p) => limpiar(p.t))), 2.5, `término de tu vocabulario ("${termino}")`, 'clave');
	}
	for (let k = 0; k < palabras.length; k++) {
		const w = norm(palabras[k]);
		const corta = terminaClausula(palabras[k].t);
		// 3) "la parte de X"
		if (w === 'parte' && !corta && norm(palabras[k + 1] ?? palabras[k]) === 'de') {
			const f = fraseNominal(palabras, k + 2);
			if (f) agregar(f.i0, f.i1, textoDeTarjeta(f.tokens), 3.5, `lo que sigue a "la parte de"`, 'clave');
		}
		// 4) "se llama X", "llamado X"
		if (LLAMA.has(w) && !corta) {
			const f = fraseNominal(palabras, k + 1);
			if (f) agregar(f.i0, f.i1, textoDeTarjeta(f.tokens), 3, `lo que sigue a "${limpiar(palabras[k].t)}"`, f.tokens.some((x) => conMayuscula(x)) ? 'producto' : 'clave');
		}
		// 5) "es X" (adjetivo o sustantivo corto que cierra la cláusula: "es gratis", "es impresionante")
		if ((w === 'es' || w === 'son') && !corta) {
			const sig = palabras[k + 1];
			if (sig && !PARADAS.has(norm(sig)) && !DETERMINANTES.has(norm(sig)) && !['de', 'del'].includes(norm(sig))) {
				const tokens: string[] = [];
				let j = k + 1;
				for (; j < palabras.length && tokens.length < 3; j++) {
					if (PARADAS.has(norm(palabras[j])) || ['de', 'del'].includes(norm(palabras[j]))) break;
					tokens.push(limpiar(palabras[j].t));
					if (terminaClausula(palabras[j].t)) {
						j++;
						break;
					}
				}
				const cierra = j - 1 < palabras.length && terminaClausula(palabras[j - 1].t);
				if (cierra && tokens.length > 0) agregar(k + 1, j, textoDeTarjeta(tokens), 3, `lo que sigue a "${limpiar(palabras[k].t)}"`, 'clave');
			}
		}
		// 6) Pasos: "primero…", "después…", "paso 2…" → la primera frase nominal con artículo de la misma frase.
		const esPaso = PASOS.has(w) || (w === 'por' && norm(palabras[k + 1] ?? palabras[k]) === 'ultimo') || (w === 'paso' && /^\d+$|^(uno|dos|tres|cuatro|cinco)$/.test(norm(palabras[k + 1] ?? palabras[k])));
		if (esPaso) {
			for (let j = k + 1; j < Math.min(palabras.length, k + 11); j++) {
				if (terminaFrase(palabras[j - 1].t)) break;
				if (DETERMINANTES.has(norm(palabras[j])) && !['todo', 'toda', 'todos', 'todas', 'tu', 'tus', 'su', 'sus', 'mi', 'mis'].includes(norm(palabras[j]))) {
					const f = fraseNominal(palabras, j);
					if (f) agregar(f.i0, f.i1, textoDeTarjeta(f.tokens), 3, `paso ("${limpiar(palabras[k].t)}…")`, 'clave');
					break;
				}
			}
		}
		// 7) "modo X" (funciones de una app: "modo plan")
		if (w === 'modo' && !corta && palabras[k + 1] && !PARADAS.has(norm(palabras[k + 1]))) {
			agregar(k, k + 2, textoDeTarjeta([limpiar(palabras[k].t), limpiar(palabras[k + 1].t)]), 3, '"modo X" (una función de la app)', 'clave');
		}
		// 8) Pregunta de tu cierre: "coméntame qué página vas a construir" → "¿Qué página vas a construir?".
		if (PIDE_COMENTARIO.test(w) && !corta && palabras[k + 1] && INICIO_PREGUNTA.has(norm(palabras[k + 1]))) {
			let j = k + 1;
			const tokens: string[] = [];
			for (; j < palabras.length && tokens.length < 8; j++) {
				tokens.push(limpiar(palabras[j].t));
				if (terminaClausula(palabras[j].t)) break;
			}
			const texto = `¿${capitalizar(tokens.join(' '))}?`;
			if (tokens.length >= 2) agregar(k + 1, j + 1, partirPregunta(texto), 4, `la pregunta de tu cierre ("${limpiar(palabras[k].t)} ${tokens.join(' ')}")`, 'pregunta');
		}
		// 8b) Pregunta dicha con signos: "¿Y cómo las usas?".
		if (palabras[k].t.startsWith('¿')) {
			let j = k;
			while (j < palabras.length - 1 && !/\?["'”’»)]*$/u.test(palabras[j].t) && j - k < 8) j++;
			if (/\?["'”’»)]*$/u.test(palabras[j].t)) {
				const tokens = palabras.slice(k, j + 1).map((p) => limpiar(p.t));
				if (NO_ABREN_FRASE.has(normalizar(tokens[0])) && tokens.length > 2) tokens.shift();
				agregar(k, j + 1, partirPregunta(`¿${capitalizar(tokens.join(' '))}?`), 4, 'una pregunta que hiciste', 'pregunta');
			}
		}
	}
	// 9) La palabra clave de cada cláusula (sustantivo o verbo) y 10) las cláusulas cortas tal cual (frase). Una frase
	//    verbal ("lo lees", "no me creas", "copias imágenes", "inténtalo tú mismo") se lee mejor entera que su palabra
	//    suelta, así que pesa más que la clave; una nominal ("el nombre que quieras") queda de respaldo.
	for (const [a, b] of clausulas(palabras)) {
		clavesDeClausula(palabras, a, b);
		const n = b - a + 1;
		if (n >= 2 && n <= MAX_PALABRAS_TARJETA) {
			const tokens = palabras.slice(a, b + 1).map((p) => limpiar(p.t));
			const texto = capitalizar(tokens.join(' '));
			const conContenido = palabras.slice(a, b + 1).some((p) => esContenido(p.t) || esVerbo(p.t));
			if (conContenido && !NO_ABREN_FRASE.has(normalizar(tokens[0])) && texto.length <= MAX_CARACTERES_TARJETA) {
				const verbal = CLITICOS.has(normalizar(tokens[0])) || esVerbo(tokens[0]);
				agregar(a, b + 1, texto, verbal ? 3.2 : 1.8, verbal ? 'frase corta (verbal), tal cual la dijiste' : 'frase corta, tal cual la dijiste', 'frase');
			}
		}
	}
	return deduplicar(salida);

	/** La clave de una cláusula: su frase nominal o verbo más informativo (y una segunda si la cláusula es larga). */
	function clavesDeClausula(p: readonly Palabra[], a: number, b: number): void {
		type Opcion = {i0: number; i1: number; texto: string; puntaje: number};
		const opciones: Opcion[] = [];
		for (let j = a; j <= b; j++) {
			if (!esContenido(p[j].t)) continue;
			// La primera mención de una marca ya es candidata por su cuenta (y gana el empate al deduplicar): si fuera
			// la clave, la cláusula se quedaría sin la suya ("Cómo hacer páginas web profesionales con Claude" → "Páginas web").
			if (primeraMarcaEn.has(j)) continue;
			const previa = j > a ? norm(p[j - 1]) : '';
			const f = fraseNominal(p, j, 4);
			const i1 = f && f.i0 === j ? Math.min(f.i1, b + 1) : j + 1;
			const tokens = f && f.i0 === j ? f.tokens.slice(0, i1 - j) : [limpiar(p[j].t)];
			const recortado = textoDeTarjeta(tokens);
			if (!recortado) continue;
			// Sin relleno al final ("prompt enfrente" → "Prompt"): solo se quitan palabras de relleno o de paro; una corta
			// con contenido ("web", "app") se queda ("Páginas web", no "Páginas").
			const quedan = recortado.split(' ');
			const esRelleno = (w: string): boolean => {
				const n = normalizar(limpiar(w));
				return PARADAS.has(n) || DETERMINANTES.has(n) || RELLENO.has(n);
			};
			while (quedan.length > 1 && esRelleno(quedan.at(-1)!) && !conMayuscula(quedan.at(-1)!) && !/^\d/.test(quedan.at(-1)!)) quedan.pop();
			let texto = capitalizar(quedan.join(' '));
			let i0 = j;
			// Una sola palabra: si la antecede su verbo (con o sin artículo) en la misma cláusula, va completa y tal cual
			// ("mejorar las animaciones" → "Mejorar las animaciones"), porque tus tarjetas van de 2–3 palabras.
			if (quedan.length === 1) {
				const k = j - 1 >= a && DETERMINANTES.has(norm(p[j - 1])) ? j - 2 : j - 1;
				const verbo = k >= a ? normalizar(limpiar(p[k].t)) : '';
				const esInfinitivo = verbo.length >= 4 && /(ar|er|ir)$/.test(verbo) && !PARADAS.has(verbo) && !RELLENO.has(verbo);
				if (k >= a && !terminaClausula(p[k].t) && (esInfinitivo || esVerbo(p[k].t))) {
					const largo = p.slice(k, j + 1).map((x) => limpiar(x.t));
					const completo = capitalizar(largo.join(' '));
					if (largo.length <= MAX_PALABRAS_TARJETA && completo.length <= MAX_CARACTERES_TARJETA && !primeraMarcaEn.has(k)) {
						texto = completo;
						i0 = k;
					}
				}
			}
			const cabeza = normalizar(limpiar(p[j].t));
			let puntaje = 2.5;
			if (i1 - 1 === b) puntaje += 0.4; // cierra la cláusula: ahí cae el énfasis
			if (DETERMINANTES.has(previa) || ['de', 'del'].includes(previa)) puntaje += 0.3; // sustantivo
			if (cabeza.length >= 7) puntaje += 0.2; // palabra larga = más específica
			if (GENERICOS.has(cabeza) && tokens.length === 1) puntaje -= 1;
			opciones.push({i0, i1, texto, puntaje: Math.round(puntaje * 10) / 10});
		}
		opciones.sort((x, y) => y.puntaje - x.puntaje || x.i0 - y.i0);
		const elegidas: Opcion[] = [];
		for (const o of opciones) {
			if (elegidas.some((e) => o.i0 < e.i1 && e.i0 < o.i1)) continue;
			if (elegidas.length > 0 && (b - a + 1 < 8 || elegidas.some((e) => Math.abs(p[e.i0].d - p[o.i0].d) < 1.2))) continue;
			elegidas.push(o);
			if (elegidas.length === 2) break;
		}
		for (const o of elegidas) agregar(o.i0, o.i1, o.texto, o.puntaje, `palabra clave de la frase («${clausulaDe(p, o.i0)}»)`, 'clave');
	}
}

/** Quita repetidos: mismo texto dentro de 30 s, o palabras que se enciman (se queda el de más puntaje). */
function deduplicar(c: Candidato[]): Candidato[] {
	const orden = [...c].sort((a, b) => b.puntaje - a.puntaje || a.t - b.t);
	const aceptados: Candidato[] = [];
	for (const x of orden) {
		const n = normalizar(x.texto ?? '');
		const choca = aceptados.some((y) => (normalizar(y.texto ?? '') === n && Math.abs(y.t - x.t) < 30) || (x.i0 < y.i1 && y.i0 < x.i1));
		if (!choca) aceptados.push(x);
	}
	return aceptados.sort((a, b) => a.t - b.t);
}

// ───────────────────────── listas ─────────────────────────

const NO_EMPIEZAN_ITEM = new Set(['no', 'lo', 'la', 'le', 'les', 'los', 'me', 'te', 'se', 'nos', 'que', 'ya', 'ahi', 'entonces', 'pues', 'bueno', 'si', 'pero', 'porque', 'como', 'cuando', 'es', 'son', 'va', 'vas', 'van', 'fue']);

/**
 * Enumeraciones: 3 o más cosas cortas seguidas (1–3 palabras, ≤ 24 caracteres, distintas, que no empiezan con
 * pronombre, negación ni verbo de enlace), separadas por comas (y la última por "y"/"o"), en ≤ 4 s. Si la primera
 * cosa va pegada al verbo ("le pones precios, nombre, dónde es"), se toma la última palabra de esa cláusula.
 * Cada una aparece en su palabra.
 */
export function candidatosListas(palabras: readonly Palabra[]): Candidato[] {
	type Seg = {i0: number; i1: number; tokens: string[]};
	const segmentos: Seg[] = [];
	let inicio = 0;
	for (let k = 0; k < palabras.length; k++) {
		if (terminaClausula(palabras[k].t) || k === palabras.length - 1) {
			// Partir en "y"/"o" (la última cosa de una lista va con conjunción).
			let a = inicio;
			for (let j = inicio; j <= k; j++) {
				const w = norm(palabras[j]);
				if ((w === 'y' || w === 'o' || w === 'e' || w === 'u') && j > a && j < k) {
					segmentos.push({i0: a, i1: j, tokens: palabras.slice(a, j).map((p) => limpiar(p.t))});
					a = j + 1;
				}
			}
			segmentos.push({i0: a, i1: k + 1, tokens: palabras.slice(a, k + 1).map((p) => limpiar(p.t))});
			inicio = k + 1;
		}
	}
	const esItem = (s: Seg): boolean => {
		if (s.tokens.length === 0 || s.tokens.length > MAX_PALABRAS_TARJETA) return false;
		if (s.tokens.join(' ').length > MAX_CARACTERES_TARJETA) return false;
		if (NO_EMPIEZAN_ITEM.has(normalizar(s.tokens[0]))) return false;
		return true;
	};
	const salida: Candidato[] = [];
	let k = 0;
	while (k < segmentos.length) {
		let j = k;
		const vistos = new Set<string>();
		while (j < segmentos.length && esItem(segmentos[j]) && !vistos.has(normalizar(segmentos[j].tokens.join(' ')))) {
			vistos.add(normalizar(segmentos[j].tokens.join(' ')));
			j++;
		}
		const corrida = segmentos.slice(k, j);
		// La primera cosa puede ir al final de la cláusula anterior ("ahí le pones precios, nombre, dónde es").
		// Solo con cosas de 1–2 palabras y si esa última palabra no parece verbo de "tú" (-as, -es: "creas", "pones").
		if (corrida.length === 2 && k > 0 && !esItem(segmentos[k - 1]) && corrida.every((x) => x.tokens.length <= 2)) {
			const previo = segmentos[k - 1];
			const ultima = previo.tokens.at(-1) ?? '';
			const n = normalizar(ultima);
			if (previo.tokens.length >= 2 && n.length >= 3 && !/(as|es)$/.test(n) && !PARADAS.has(n) && !DETERMINANTES.has(n) && !NO_EMPIEZAN_ITEM.has(n) && !vistos.has(n)) {
				corrida.unshift({i0: previo.i1 - 1, i1: previo.i1, tokens: [ultima]});
			}
		}
		if (corrida.length >= 3) {
			const t0 = palabras[corrida[0].i0].d;
			const tFin = palabras[corrida.at(-1)!.i1 - 1].h;
			if (tFin - t0 <= 4) {
				const items = corrida.map((s) => ({texto: capitalizar(s.tokens.join(' ')), t: palabras[s.i0].d, i0: s.i0}));
				salida.push({
					clave: `lista:${palabras[corrida[0].i0].i}`,
					tipo: 'lista',
					tipo_palabra: 'clave',
					i0: corrida[0].i0,
					i1: corrida.at(-1)!.i1,
					t: t0,
					palabra: palabras
						.slice(corrida[0].i0, corrida.at(-1)!.i1)
						.map((p) => p.t)
						.join(' '),
					frase: clausulaDe(palabras, corrida[0].i0),
					puntaje: 5,
					motivo: `enumeración de ${items.length} cosas cortas en ${(tFin - t0).toFixed(1)} s`,
					items,
					alternativas: ['una tarjeta por cosa, una tras otra'],
				});
			}
		}
		k = Math.max(j, k + 1);
	}
	return salida;
}

// ───────────────────────── stickers ─────────────────────────

/** Conceptos que piden una mascota: palabras (sin acentos) → etiquetas del catálogo voxel. `fuerza` 1–3. */
export const CONCEPTOS_STICKER: ReadonlyArray<{id: string; re: RegExp; etiquetas: string[]; fuerza: number}> = [
	{id: 'gratis', re: /^(gratis|gratuit[oa]s?|free)$/, etiquetas: ['gratis', 'sin costo', 'free'], fuerza: 3},
	{id: 'impresionante', re: /^(impresionantes?|buenisim[oa]s?|increibles?|chulisim[oa]s?|brutal|wow|espectacular|genial|maravilla)$/, etiquetas: ['impresionante', 'increíble', 'wow', 'brillante'], fuerza: 3},
	{id: 'comenta', re: /^(comenta|comentame|comentenme|comentarios?|comentalo)$/, etiquetas: ['comenta', 'comentarios'], fuerza: 3},
	{id: 'rapido', re: /^(rapid[oa]s?|rapidisim[oa]s?|velocidad|instante|segundos)$/, etiquetas: ['rápido', 'velocidad', 'al instante'], fuerza: 2},
	{id: 'idea', re: /^(idea|ideas|tip|tips|truco|trucos)$/, etiquetas: ['idea', 'tip', 'truco'], fuerza: 2},
	{id: 'listo', re: /^(listo|listos|apruebas|aprueba|apruebalo|aprobar|aprobad[oa]s?|hecho|completad[oa]s?|terminad[oa])$/, etiquetas: ['listo', 'aprobado', 'check', 'completado'], fuerza: 2},
	{id: 'trabajar', re: /^(trabajar|trabaja|trabajando|chambear|chambea|chambeando|computadora|laptop|programar|codigo)$/, etiquetas: ['laptop', 'trabajo', 'computadora', 'código'], fuerza: 2},
	{id: 'documentos', re: /^(documentacion|informacion|documentos?|archivos?|papeles|notas|pdf)$/, etiquetas: ['documentos', 'papeles', 'archivos'], fuerza: 2},
	{id: 'dinero', re: /^(dinero|precios?|pagar|pago|cobrar|ventas?|ingresos|billetes|lana)$/, etiquetas: ['dinero', 'billetes', 'precio', 'pago'], fuerza: 2},
	{id: 'construir', re: /^(construir|construye|construyes|instalar|instala|instalada|instalado|dependencias|configurar|configura)$/, etiquetas: ['instalar', 'herramienta', 'configurar', 'plugin', 'paquete'], fuerza: 2},
	{id: 'buscar', re: /^(buscar|busca|buscas|investigar|encontrar|encuentras)$/, etiquetas: ['buscar', 'investigar', 'encontrar'], fuerza: 2},
	{id: 'importante', re: /^(importante|ojo|cuidado|atencion)$/, etiquetas: ['importante', 'ojo', 'atención', 'cuidado'], fuerza: 2},
	{id: 'regalo', re: /^(regalo|bonus)$/, etiquetas: ['regalo', 'bonus'], fuerza: 2},
	{id: 'automatico', re: /^(automatico|automaticamente|automatica)$/, etiquetas: ['automático', 'al instante', 'potente'], fuerza: 2},
	{id: 'tiempo', re: /^(minutos|horas|tiempo)$/, etiquetas: ['tiempo', 'minutos', 'horas'], fuerza: 1},
	{id: 'nuevo', re: /^(nuev[oa]s?|lanzamiento|novedad)$/, etiquetas: ['nuevo', 'lanzamiento', 'novedad'], fuerza: 1},
	{id: 'seguro', re: /^(seguro|segura|seguridad|contrasena|privado)$/, etiquetas: ['seguro', 'seguridad'], fuerza: 1},
	{id: 'video', re: /^(video|videos|youtube|tutorial)$/, etiquetas: ['video', 'tutorial'], fuerza: 1},
	{id: 'celular', re: /^(celular|telefono|movil)$/, etiquetas: ['celular', 'teléfono'], fuerza: 1},
	{id: 'plan', re: /^(plan|mapa|ruta|guia)$/, etiquetas: ['plan', 'guía', 'mapa'], fuerza: 1},
	{id: 'pregunta', re: /^(pregunta|duda|cual)$/, etiquetas: ['pregunta', 'duda'], fuerza: 1},
	{id: 'top', re: /^(top|mejor|mejores|ganar|campeon)$/, etiquetas: ['top', 'mejor', 'ganar'], fuerza: 1},
	{id: 'facil', re: /^(facil|sencill[oa]|simple)$/, etiquetas: ['fácil', 'sencillo', 'simple'], fuerza: 1},
	{id: 'crecer', re: /^(crecer|crece|resultados|metricas)$/, etiquetas: ['crecer', 'resultados', 'métricas'], fuerza: 1},
	{id: 'fuego', re: /^(viral|fuego)$/, etiquetas: ['viral', 'fuego'], fuerza: 1},
	{id: 'hola', re: /^(hola|bienvenid[oa]s?)$/, etiquetas: ['hola', 'bienvenido'], fuerza: 1},
	// Conceptos que cubren tus mascotas (biblioteca/stickers/mascotas/etiquetas.json).
	{id: 'whatsapp', re: /^whatsapp$/, etiquetas: ['whatsapp'], fuerza: 3},
	{id: 'prompt', re: /^prompts?$/, etiquetas: ['prompt'], fuerza: 2},
	{id: 'api', re: /^apis?$/, etiquetas: ['api'], fuerza: 2},
	{id: 'pensar', re: /^(pensar|piensa|piensas|pensando|cerebro|inteligente|inteligencia|razonar|razona)$/, etiquetas: ['pensar', 'cerebro'], fuerza: 2},
	{id: 'peligro', re: /^(peligro|peligros[oa]s?|riesgo|riesgos[oa]s?)$/, etiquetas: ['peligro', 'cuidado'], fuerza: 2},
	{id: 'nivel', re: /^(nivel|level|upgrade|mejorar|mejora|mejoras)$/, etiquetas: ['subir de nivel'], fuerza: 2},
	{id: 'terminal', re: /^(terminal|consola|comandos?)$/, etiquetas: ['terminal', 'comando'], fuerza: 2},
	{id: 'excel', re: /^(excel|spreadsheet)$/, etiquetas: ['excel'], fuerza: 2},
	{id: 'error', re: /^(error|errores|falla|fallas|bug|bugs|roto|rota|rompe)$/, etiquetas: ['error', 'roto'], fuerza: 2},
	{id: 'basura', re: /^(basura|borrar|borra|borras|eliminar|elimina)$/, etiquetas: ['basura', 'borrar'], fuerza: 1},
	{id: 'enojado', re: /^(enojad[oa]s?|frustrante|frustrad[oa]s?|odio|coraje|desesperante)$/, etiquetas: ['enojado', 'frustrante'], fuerza: 2},
	{id: 'secreto', re: /^(secretos?|shh)$/, etiquetas: ['secreto'], fuerza: 2},
	{id: 'opus', re: /^opus$/, etiquetas: ['opus'], fuerza: 2},
	{id: 'sonnet', re: /^sonnet$/, etiquetas: ['sonnet'], fuerza: 2},
	{id: 'haiku', re: /^haiku$/, etiquetas: ['haiku'], fuerza: 2},
	{id: 'fuerte', re: /^(fuerte|fuertes|poderos[oa]s?|potente|potentes)$/, etiquetas: ['fuerte', 'potente'], fuerza: 1},
	{id: 'agente', re: /^(agentes?|subagentes?|robots?)$/, etiquetas: ['agente', 'robot'], fuerza: 1},
	{id: 'web', re: /^(web|internet|sitio|sitios)$/, etiquetas: ['web', 'internet'], fuerza: 1},
	{id: 'aprender', re: /^(aprender|aprende|aprendes|estudiar|leer|lee|lees)$/, etiquetas: ['aprender', 'leer'], fuerza: 1},
	{id: 'vender', re: /^(vender|vendes|vende|vendi|vendido)$/, etiquetas: ['vender', 'ventas'], fuerza: 1},
	{id: 'diseño', re: /^(diseno|disenos|disenar|disena|dibujar)$/, etiquetas: ['diseño', 'dibujar'], fuerza: 1},
	{id: 'nube', re: /^(nube|cloud)$/, etiquetas: ['nube', 'en la nube'], fuerza: 1},
	{id: 'yolo', re: /^yolo$/, etiquetas: ['yolo'], fuerza: 2},
	{id: 'relax', re: /^(relajad[oa]s?|tranquil[oa]s?|descansar|descansa)$/, etiquetas: ['relax', 'tranquilo'], fuerza: 1},
	{id: 'ayuda', re: /^(ayuda|soporte|rescate|salvar|salva)$/, etiquetas: ['ayuda', 'soporte', 'rescate'], fuerza: 1},
	// Conceptos que cubren los emojis animados (biblioteca/stickers/emojis, herramientas/stickers/emojis.ts).
	{id: 'risa', re: /^(ja(ja)+|je(je)+|risa|risas|chistos[oa]s?|gracios[oa]s?)$/, etiquetas: ['risa', 'jaja', 'gracioso'], fuerza: 2},
	{id: 'miedo', re: /^(miedo|terror|aterrador[a]?|asusta|asustad[oa]s?|panico)$/, etiquetas: ['miedo', 'terror'], fuerza: 2},
	{id: 'sorpresa', re: /^(sorpresa|sorprendente|sorprendid[oa]s?)$/, etiquetas: ['sorpresa', 'wow'], fuerza: 1},
	{id: 'fiesta', re: /^(fiesta|celebrar|celebra|celebremos|felicidades)$/, etiquetas: ['fiesta', 'celebrar', 'felicidades'], fuerza: 2},
	{id: 'triste', re: /^(triste|tristeza|llorar|lloro|llorando)$/, etiquetas: ['triste', 'llorar'], fuerza: 1},
	{id: 'objetivo', re: /^(objetivo|objetivos|meta|metas|exacto|exactamente)$/, etiquetas: ['objetivo', 'meta', 'exacto'], fuerza: 1},
	{id: 'cool', re: /^(cool|chid[oa]s?|perron|perrona)$/, etiquetas: ['cool', 'relax'], fuerza: 1},
];

/** Frases de dos o tres palabras que también piden sticker ("te lo paso" → regalo, "me encanta" → corazón). */
const FRASES_STICKER: ReadonlyArray<{id: string; re: RegExp; etiquetas: string[]; fuerza: number}> = [
	// El letrero sigue a lo que dices: "te lo paso" → TE LO PASO, "te la paso" → TE LA PASO (mismo concepto regalo).
	{id: 'regalo', re: /^te (lo|los) (paso|mando)$/, etiquetas: ['regalo', 'te lo paso'], fuerza: 2},
	{id: 'regalo', re: /^te (la|las) (paso|mando)$/, etiquetas: ['regalo', 'te la paso'], fuerza: 2},
	{id: 'me encanta', re: /^me encanta$/, etiquetas: ['me encanta', 'favorito'], fuerza: 2},
	{id: 'seguir', re: /^(sigueme|siguenos)$/, etiquetas: ['seguir', '+ seguir'], fuerza: 2},
];

/** Candidatos a sticker: logos (la primera mención de cada marca del catálogo) y mascota por concepto. */
export function candidatosStickers(palabras: readonly Palabra[], marcas: readonly Marca[]): Candidato[] {
	const salida: Candidato[] = [];
	// Logos: por marca, su PRIMERA mención (como en tus reels: el logo sale cuando la nombras por primera vez).
	const porMarca = new Map<string, Marca[]>();
	for (const m of marcas) if (m.logo) porMarca.set(m.logo, [...(porMarca.get(m.logo) ?? []), m]);
	for (const [logo, lista] of porMarca) {
		const fuerte = lista[0];
		salida.push({
			clave: `sticker:${palabras[fuerte.i0].i}`,
			tipo: 'sticker',
			i0: fuerte.i0,
			i1: fuerte.i1,
			t: palabras[fuerte.i0].d,
			palabra: palabras
				.slice(fuerte.i0, fuerte.i1)
				.map((p) => p.t)
				.join(' '),
			frase: clausulaDe(palabras, fuerte.i0),
			puntaje: 4,
			motivo: `primera mención de ${fuerte.canon} (logo del catálogo)`,
			sticker: {concepto: `logo:${fuerte.canon}`, etiquetas: [], marca: logo, logo: true},
			alternativas: [`tarjeta "${fuerte.canon}"`],
		});
	}
	// Mascota por concepto (una vez por palabra; el mismo concepto repetido pesa menos).
	const veces = new Map<string, number>();
	for (let k = 0; k < palabras.length; k++) {
		const w = norm(palabras[k]);
		const dos = `${w} ${palabras[k + 1] ? norm(palabras[k + 1]) : ''}`.trim();
		const tres = `${dos} ${palabras[k + 2] ? norm(palabras[k + 2]) : ''}`.trim();
		const frase = FRASES_STICKER.find((f) => f.re.test(tres) || f.re.test(dos));
		const concepto = frase ?? CONCEPTOS_STICKER.find((c) => c.re.test(w));
		if (!concepto) continue;
		const n = (veces.get(concepto.id) ?? 0) + 1;
		veces.set(concepto.id, n);
		const enfasis = terminaClausula(palabras[k].t) ? 1 : 0;
		salida.push({
			clave: `sticker:${palabras[k].i}`,
			tipo: 'sticker',
			i0: k,
			i1: k + 1,
			t: palabras[k].d,
			palabra: palabras[k].t,
			frase: clausulaDe(palabras, k),
			puntaje: concepto.fuerza + enfasis - (n - 1),
			motivo: `"${limpiar(palabras[k].t)}" → ${concepto.id}${n > 1 ? ` (vez ${n} de ese concepto: pesa menos)` : ''}`,
			sticker: {concepto: concepto.id, etiquetas: concepto.etiquetas, marca: null, logo: false},
			alternativas: [],
		});
	}
	return salida.sort((a, b) => a.t - b.t);
}

// ───────────────────────── demos ─────────────────────────

const ACCIONES_DEMO: ReadonlyArray<{accion: string; re: RegExp}> = [
	{accion: 'ir a una sección', re: /^(te vas|te vas a ir|vas|vete|ve) a (la|el) (parte|seccion|pestana|pagina|apartado)\b/},
	{accion: 'copiar la liga', re: /^(vas a )?(copiar|copias|copia) (la|el) (liga|link|enlace|url)\b/},
	{accion: 'copiar', re: /^(copias|copia|copiar) \p{L}+/u},
	{accion: 'pegar', re: /^(le )?(pegas|pega|pegar)\b/},
	{accion: 'buscar', re: /^(vas a )?(buscar|busca|buscas)\b/},
	{accion: 'abrir', re: /^(abres|abre|abrir|abrimos)\b/},
	{accion: 'dar clic', re: /^(le )?(das|da|dale|picas|aprietas|presionas) (clic|click|en)\b/},
	{accion: 'entrar', re: /^(entras|entra|te metes|metete) (a|al|en)\b/},
	{accion: 'cambiar de modo', re: /^(cambias|cambia) a\b/},
];

/** Momentos que piden una demo de pantalla (para que Claude decida si graba o inserta una). */
export function momentosDemo(palabras: readonly Palabra[]): MomentoDemo[] {
	const salida: MomentoDemo[] = [];
	let ultimo = -10;
	for (let k = 0; k < palabras.length; k++) {
		const ventana = palabras
			.slice(k, k + 7)
			.map((p) => normalizar(limpiar(p.t)))
			.join(' ');
		const a = ACCIONES_DEMO.find((x) => x.re.test(ventana));
		if (!a) continue;
		if (palabras[k].d - ultimo < 1.5) continue;
		ultimo = palabras[k].d;
		salida.push({t: palabras[k].d, i0: k, accion: a.accion, frase: clausulaDe(palabras, k)});
	}
	return salida;
}

// ───────────────────────── demos grabadas ↔ momentos ─────────────────────────

/** Una demo grabada con el estudio (demos/<nombre>/toma.mp4) que se puede proponer en un momento de acción. */
export type DemoDisponible = {
	/** Ruta relativa a public/ ("demos/<nombre>/toma.mp4"). */
	asset: string;
	eventos: string | null;
	duracion: number;
	usable: boolean;
	motivo: string;
	/** Qué muestra (guion.json → descripcion): con esto se empareja con lo que dices. */
	descripcion: string;
	/** Clics y scrolls de la toma (eventos.json), para elegir el pedazo que se ve. */
	acciones?: Array<{t: number; tipo: string}>;
};

/** Palabras que no sirven para emparejar una demo con lo que dices (además de las de función). */
const COMUNES_DEMO = new Set(['hacer', 'poner', 'tener', 'para', 'sobre', 'entre', 'vas', 'parte', 'aqui', 'ahi', 'todo', 'toda', 'esta', 'este', 'scroll', 'clic', 'click', 'resultados'].map(normalizar));

/** Raíces de las palabras de un texto para emparejar ("Páginas" → "pagina", "botón" → "boton"); marca las que van con mayúscula. */
export function raicesDe(texto: string): Map<string, boolean> {
	const r = new Map<string, boolean>();
	for (const crudo of texto.split(/[^\p{L}\p{N}]+/u)) {
		if (!crudo) continue;
		let w = normalizar(crudo);
		if (w.length < 4 || PARADAS.has(w) || DETERMINANTES.has(w) || COMUNES_DEMO.has(w)) continue;
		if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);
		r.set(w, (r.get(w) ?? false) || /^\p{Lu}/u.test(crudo));
	}
	return r;
}

export type EmparejeDemo = {momento: MomentoDemo; demo: DemoDisponible; comunes: string[]; puntaje: number};

/**
 * Empareja demos grabadas con momentos de acción (modo de cerca): por las palabras que comparten la descripción de la
 * demo y la frase del momento (una palabra con mayúscula en la descripción, como "Dribbble" o "Code", vale 2). Cuenta
 * con al menos 2 palabras en común. Cada demo y cada momento se usan una vez, primero los de más puntaje. Solo demos
 * usables (secretos revisados).
 */
export function emparejarDemos(momentos: readonly MomentoDemo[], demos: readonly DemoDisponible[]): EmparejeDemo[] {
	const opciones: EmparejeDemo[] = [];
	for (const d of demos) {
		if (!d.usable) continue;
		const rd = raicesDe(d.descripcion);
		for (const m of momentos) {
			const rm = raicesDe(m.frase);
			const comunes = [...rm.keys()].filter((w) => rd.has(w)).sort();
			if (comunes.length < 2) continue;
			opciones.push({momento: m, demo: d, comunes, puntaje: comunes.reduce((s, w) => s + (rd.get(w) ? 2 : 1), 0)});
		}
	}
	opciones.sort((a, b) => b.puntaje - a.puntaje || a.momento.t - b.momento.t || a.demo.asset.localeCompare(b.demo.asset));
	const elegidas: EmparejeDemo[] = [];
	for (const o of opciones) {
		if (elegidas.some((e) => e.demo.asset === o.demo.asset || e.momento.t === o.momento.t)) continue;
		elegidas.push(o);
	}
	return elegidas.sort((a, b) => a.momento.t - b.momento.t);
}

/**
 * Qué pedazo de la toma se ve (trim_desde) para que dure `dur`: alrededor del primer clic (el clic cae a ~60 % del
 * pedazo); si no hay clic, desde un poco antes del primer scroll; si no, desde el principio.
 */
export function trimDeDemo(d: Pick<DemoDisponible, 'duracion' | 'acciones'>, dur: number): number {
	const max = Math.max(0, d.duracion - dur);
	const clic = d.acciones?.find((a) => a.tipo === 'clic');
	const scroll = d.acciones?.find((a) => a.tipo === 'scroll');
	const t = clic ? clic.t - 0.6 * dur : scroll ? scroll.t - 0.3 : 0;
	return Math.round(Math.min(max, Math.max(0, t)) * 1000) / 1000;
}
