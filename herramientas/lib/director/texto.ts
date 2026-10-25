// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Texto del transcript para el director: palabras limpias, cifras en dígitos ("quince" → "15", "veinte dólares" → "$20",
 * "cien por ciento" → "100%"), frases nominales ("la aplicación de Claude instalada" → "aplicación de Claude") y
 * textos de tarjeta (1–3 palabras, ≤ 24 caracteres, mayúscula inicial). Todo puro.
 */

export type Palabra = {i: number; t: string; d: number; h: number; tramo?: number};

export const MAX_CARACTERES_TARJETA = 24;
export const MAX_PALABRAS_TARJETA = 3;

/** Minúsculas y sin acentos (la ñ se queda: "año" ≠ "ano"). */
export function normalizar(texto: string): string {
	return texto
		.normalize('NFD')
		.replace(/(?!̃)\p{M}/gu, '')
		.normalize('NFC')
		.toLowerCase();
}

/** La palabra sin la puntuación de sus orillas ("¿Claude," → "Claude"). */
export function limpiar(t: string): string {
	const x = t.replace(/^[¿¡"'“”‘’«»([{—–-]+/u, '').replace(/[.,;:!?…"'“”‘’«»)\]}—–]+$/u, '');
	return x.length > 0 ? x : t;
}

/** ¿Termina una cláusula (coma, punto, dos puntos…)? */
export const terminaClausula = (t: string): boolean => /[.,;:!?…]["'”’»)]*$/u.test(t);
/** ¿Termina una frase (punto, signo de cierre)? */
export const terminaFrase = (t: string): boolean => /[.!?…]["'”’»)]*$/u.test(t);
/** ¿Empieza con mayúscula (después de signos de apertura)? */
export const conMayuscula = (t: string): boolean => /^\p{Lu}/u.test(limpiar(t));

/** Mayúscula inicial; el resto como venía (respeta "WebKit", "iPhone"). */
export function capitalizar(texto: string): string {
	const t = texto.trim();
	if (!t) return t;
	if (/^\p{Ll}\p{Lu}/u.test(t)) return t; // "iPhone"
	return t.charAt(0).toLocaleUpperCase('es') + t.slice(1);
}

export const contarPalabras = (texto: string): number => texto.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Palabras que cortan una frase nominal (función, pronombres, verbos de enlace). */
export const PARADAS = new Set(
	[
		'que', 'para', 'por', 'en', 'con', 'y', 'e', 'o', 'u', 'a', 'al', 'como', 'si', 'porque', 'cuando', 'donde', 'dónde', 'lo', 'le', 'les',
		'se', 'te', 'me', 'nos', 'ya', 'ahi', 'ahí', 'aqui', 'aquí', 'tambien', 'también', 'pero', 'sino', 'ni', 'es', 'son', 'va', 'vas', 'van',
		'hay', 'solo', 'sólo', 'muy', 'mas', 'más', 'entonces', 'pues', 'bueno', 'no', 'si', 'sí', 'yo', 'tu', 'tú', 'el', 'él', 'ella', 'esto',
		'eso', 'aquello', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'hacia', 'tienes', 'tiene', 'tengo', 'puedes', 'puede', 'vamos', 'voy',
	].map(normalizar),
);
/** Artículos y determinantes que abren una frase nominal (se saltan). */
export const DETERMINANTES = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'su', 'sus', 'tu', 'tus', 'mi', 'mis', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'del', 'nuestro', 'nuestra', 'todo', 'toda', 'todos', 'todas']);
/** Sustantivos genéricos que, solos antes de "de", ceden el lugar a lo que sigue ("herramienta de Claude WebKit" → "Claude WebKit"). */
export const GENERICOS = new Set(['parte', 'herramienta', 'aplicacion', 'seccion', 'boton', 'carpeta', 'folder', 'opcion', 'pestana', 'pestaña', 'menu', 'liga', 'link', 'enlace', 'pagina', 'agente', 'plataforma', 'app', 'modelo', 'cosa']);

// ───────────────────────── cifras ─────────────────────────

const UNIDADES: Record<string, number> = {
	cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
	trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
	veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Record<string, number> = {treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90};
const CENTENAS: Record<string, number> = {
	cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
	quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
	novecientos: 900, novecientas: 900,
};

/** Número escrito con palabras desde `palabras[k]` (normalizadas y limpias). null si no empieza un número. */
export function numeroEnPalabras(palabras: readonly string[], k: number): {valor: number; usadas: number} | null {
	let total = 0;
	let actual = 0;
	let j = k;
	let alguno = false;
	while (j < palabras.length) {
		const w = palabras[j];
		if (w in UNIDADES) {
			if (alguno && actual % 10 !== 0 && actual < 100) break; // "dos tres" no es un número
			actual += UNIDADES[w];
		} else if (w in DECENAS) {
			if (alguno && actual % 100 !== 0) break;
			actual += DECENAS[w];
		} else if (w in CENTENAS) {
			if (alguno && actual !== 0) break;
			actual += CENTENAS[w];
		} else if (w === 'y' && alguno && actual % 100 >= 30 && actual % 10 === 0 && j + 1 < palabras.length && (UNIDADES[palabras[j + 1]] ?? 0) >= 1 && (UNIDADES[palabras[j + 1]] ?? 0) <= 9) {
			j++;
			continue;
		} else if (w === 'mil') {
			total += (alguno ? actual : 1) * 1000;
			actual = 0;
		} else if (w === 'millon' || w === 'millones') {
			total += (alguno ? actual || 1 : 1) * 1_000_000;
			actual = 0;
		} else break;
		alguno = true;
		j++;
	}
	if (!alguno) return null;
	return {valor: total + actual, usadas: j - k};
}

/** "1000" → "1,000" (como se escribe en México). */
export const conMiles = (n: number): string => (Number.isInteger(n) ? n.toLocaleString('en-US') : String(n));

export type Cifra = {i0: number; i1: number; texto: string; valor: number; tipo: 'porcentaje' | 'dinero' | 'cantidad'};

const MONEDAS: Record<string, string> = {dolares: 'dolar', dolar: 'dolar', dls: 'dolar', usd: 'dolar', pesos: 'peso', peso: 'peso', varos: 'peso', euros: 'euro', euro: 'euro'};

/**
 * Cifras del transcript en dígitos: porcentajes ("cien por ciento" → "100%"), dinero ("veinte dólares" → "$20") y
 * cantidades con su sustantivo ("tres prompts" → "3 prompts"). "un/una/uno" solo cuentan con moneda o porcentaje.
 * `i0`/`i1` son posiciones en `palabras` (i1 exclusivo).
 */
export function detectarCifras(palabras: readonly Palabra[]): Cifra[] {
	const norm = palabras.map((p) => normalizar(limpiar(p.t)));
	const salida: Cifra[] = [];
	for (let k = 0; k < palabras.length; k++) {
		let valor: number | null = null;
		let usadas = 0;
		const crudo = limpiar(palabras[k].t);
		const digitos = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:[.,](\d+))?(%?)$/.exec(crudo);
		let pegadoPorciento = false;
		let pegadoDinero = false;
		if (digitos) {
			valor = Number(`${digitos[1].replace(/,/g, '')}${digitos[2] ? `.${digitos[2]}` : ''}`);
			usadas = 1;
			pegadoPorciento = digitos[3] === '%';
			pegadoDinero = crudo.startsWith('$');
		} else {
			const n = numeroEnPalabras(norm, k);
			if (n) {
				valor = n.valor;
				usadas = n.usadas;
			}
		}
		if (valor === null || usadas === 0) continue;
		// Una cifra pegada a una marca ("Opus 5.5", "GPT 5") es parte de la marca: la toma detectarMarcas.
		if (k > 0 && digitos && conMayuscula(palabras[k - 1].t) && !terminaClausula(palabras[k - 1].t)) continue;
		const sig = norm[k + usadas] ?? '';
		const sig2 = norm[k + usadas + 1] ?? '';
		const ultima = palabras[k + usadas - 1];
		const corta = terminaClausula(ultima.t);
		if (pegadoPorciento || (!corta && sig === 'por' && sig2 === 'ciento') || (!corta && (sig === '%' || sig === 'porciento'))) {
			const i1 = k + usadas + (pegadoPorciento ? 0 : sig === 'por' ? 2 : 1);
			salida.push({i0: k, i1, texto: `${conMiles(valor)}%`, valor, tipo: 'porcentaje'});
			k = i1 - 1;
			continue;
		}
		if (pegadoDinero || (!corta && sig in MONEDAS)) {
			const moneda = pegadoDinero ? 'dolar' : MONEDAS[sig];
			const i1 = k + usadas + (pegadoDinero ? 0 : 1);
			const texto = moneda === 'dolar' ? `$${conMiles(valor)}` : moneda === 'peso' ? `$${conMiles(valor)} pesos` : `${conMiles(valor)} euros`;
			salida.push({i0: k, i1, texto, valor, tipo: 'dinero'});
			k = i1 - 1;
			continue;
		}
		if (valor < 2 && !digitos) continue; // "un", "una": casi siempre artículo
		if (!corta && sig && !PARADAS.has(sig) && !DETERMINANTES.has(sig) && /^\p{L}/u.test(sig)) {
			const sustantivo = limpiar(palabras[k + usadas].t);
			salida.push({i0: k, i1: k + usadas + 1, texto: `${conMiles(valor)} ${sustantivo}`, valor, tipo: 'cantidad'});
			k = k + usadas;
		}
	}
	return salida;
}

// ───────────────────────── frases nominales y textos de tarjeta ─────────────────────────

/**
 * Frase nominal desde palabras[k]: salta artículos, junta hasta `max` palabras y se corta en puntuación, en palabras de
 * función y, después de un nombre propio, en la primera minúscula ("la aplicación de Claude instalada" → aplicación de
 * Claude). "de" puede ir en medio pero no al final. Devuelve los índices [i0, i1) y las palabras limpias.
 */
export function fraseNominal(palabras: readonly Palabra[], k: number, max = 5): {i0: number; i1: number; tokens: string[]} | null {
	let j = k;
	while (j < palabras.length && DETERMINANTES.has(normalizar(limpiar(palabras[j].t)))) {
		if (terminaClausula(palabras[j].t)) return null;
		j++;
	}
	const i0 = j;
	const tokens: string[] = [];
	let vioPropio = false;
	while (j < palabras.length && tokens.length < max) {
		const crudo = palabras[j].t;
		const w = normalizar(limpiar(crudo));
		const esDe = w === 'de' || w === 'del';
		if (!esDe && (PARADAS.has(w) || (DETERMINANTES.has(w) && tokens.length > 0 && normalizar(tokens.at(-1) ?? '') !== 'de'))) break;
		if (vioPropio && !conMayuscula(crudo) && !/^\d/.test(limpiar(crudo))) break;
		if (esDe && tokens.length === 0) break;
		if (!esDe && DETERMINANTES.has(w)) {
			j++;
			continue; // "de la página" → página
		}
		tokens.push(limpiar(crudo));
		if (conMayuscula(crudo) && j > 0) vioPropio = true;
		j++;
		if (terminaClausula(crudo)) break;
	}
	while (tokens.length > 0 && ['de', 'del', 'y', 'o'].includes(normalizar(tokens.at(-1)!))) {
		tokens.pop();
		j--;
	}
	if (tokens.length === 0) return null;
	return {i0, i1: j, tokens};
}

/** Recorta una frase a texto de tarjeta: 1–3 palabras, ≤ 24 caracteres, mayúscula inicial. null si no queda nada útil. */
export function textoDeTarjeta(tokens: readonly string[]): string | null {
	let t = tokens.filter((x) => x.length > 0);
	if (t.length === 0) return null;
	const n = t.map((x) => normalizar(x));
	const cabe = (x: readonly string[]) => x.length <= MAX_PALABRAS_TARJETA && x.join(' ').length <= MAX_CARACTERES_TARJETA;
	if (!cabe(t) && n.includes('de')) {
		const primero = n.indexOf('de');
		const ultimo = n.lastIndexOf('de');
		const cabeza = t.slice(0, primero);
		const cola = t.slice(ultimo + 1);
		const colaPropia = cola.some((x) => conMayuscula(x));
		if (cabeza.length === 1 && GENERICOS.has(normalizar(cabeza[0])) && colaPropia && cola.length > 0) t = cola;
		else if (cabeza.length >= 1 && cabeza.length <= MAX_PALABRAS_TARJETA) t = cabeza;
		else if (colaPropia && cola.length > 0) t = cola;
	}
	t = t.slice(0, MAX_PALABRAS_TARJETA);
	while (t.length > 1 && t.join(' ').length > MAX_CARACTERES_TARJETA) t = t.slice(0, -1);
	while (t.length > 1 && ['de', 'del', 'y', 'o', 'a', 'en', 'con'].includes(normalizar(t.at(-1)!))) t = t.slice(0, -1);
	const texto = t.join(' ');
	if (texto.length > MAX_CARACTERES_TARJETA || texto.length < 2) return null;
	return capitalizar(texto);
}
