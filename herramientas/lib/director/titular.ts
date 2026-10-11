/**
 * Titular BORRADOR: 2 renglones (≤ 24 caracteres cada uno) sacados del gancho (la primera cláusula). Claude lo reescribe
 * con tu voz (voice.md: hooks con número, "tú/tu" o tensión; nada de la lista "Prohibido") y lo deja en
 * notas-director.json. También da una versión de 1 renglón por si 2 no caben arriba de tu cabeza. Puro.
 */
import {capitalizar, limpiar, normalizar, terminaClausula, type Palabra} from './texto.ts';
import {revisarVoz, type CoincidenciaVoz, type ReglaVoz} from './voz.ts';

export const MAX_RENGLON_TITULAR = 24;

export type Borrador = {
	/** Con "\n" entre renglones. */
	texto: string;
	/** Versión de un renglón (o null si no se pudo armar una con sentido). */
	un_renglon: string | null;
	/** De dónde salió (tiempos de la base). */
	origen: {t0: number; t1: number; frase: string};
};

/** Parte un texto en 2 renglones de ≤ max caracteres lo más parejos posible. null si no hay corte que quepa. */
export function partirTitular(texto: string, max = MAX_RENGLON_TITULAR): [string, string] | null {
	const palabras = texto.trim().split(/\s+/);
	let mejor: [string, string] | null = null;
	let peor = Infinity;
	for (let k = 1; k < palabras.length; k++) {
		const a = palabras.slice(0, k).join(' ');
		const b = palabras.slice(k).join(' ');
		if (a.length > max || b.length > max) continue;
		const m = Math.max(a.length, b.length);
		if (m < peor) {
			peor = m;
			mejor = [a, b];
		}
	}
	return mejor;
}

/** El gancho: la primera cláusula (si tiene menos de 3 palabras, también la siguiente). */
export function gancho(palabras: readonly Palabra[]): {i0: number; i1: number} | null {
	if (palabras.length === 0) return null;
	let i1 = 0;
	while (i1 < palabras.length && !terminaClausula(palabras[i1].t)) i1++;
	i1 = Math.min(palabras.length, i1 + 1);
	if (i1 < 3 && i1 < palabras.length) {
		let j = i1;
		while (j < palabras.length && !terminaClausula(palabras[j].t)) j++;
		i1 = Math.min(palabras.length, j + 1);
	}
	return {i0: 0, i1};
}

/** Borrador de titular a partir del transcript. null si no hay palabras. */
export function borradorTitular(palabras: readonly Palabra[]): Borrador | null {
	const g = gancho(palabras);
	if (!g) return null;
	let tokens = palabras.slice(g.i0, g.i1).map((p) => limpiar(p.t));
	let partes: [string, string] | null = null;
	while (tokens.length >= 2) {
		partes = partirTitular(capitalizar(tokens.join(' ')));
		if (partes) break;
		tokens = tokens.slice(0, -1);
	}
	const completo = capitalizar(tokens.join(' '));
	const texto = partes ? `${partes[0]}\n${partes[1]}` : completo.slice(0, MAX_RENGLON_TITULAR);
	// Un renglón: el prefijo más largo que quepa (sin cortar palabras ni terminar en palabra de función).
	let una = tokens.slice();
	while (una.length > 1 && capitalizar(una.join(' ')).length > MAX_RENGLON_TITULAR - 2) una = una.slice(0, -1);
	while (una.length > 1 && ['de', 'del', 'con', 'y', 'o', 'a', 'en', 'para', 'que', 'el', 'la', 'los', 'las'].includes(normalizar(una.at(-1)!))) una = una.slice(0, -1);
	const unRenglon = una.length >= 2 ? capitalizar(una.join(' ')) : null;
	return {
		texto,
		un_renglon: unRenglon && unRenglon !== texto.replace('\n', ' ') ? unRenglon : null,
		origen: {
			t0: palabras[g.i0].d,
			t1: palabras[g.i1 - 1].h,
			frase: palabras
				.slice(g.i0, g.i1)
				.map((p) => p.t)
				.join(' '),
		},
	};
}

export type RevisionTitular = {prohibidas: CoincidenciaVoz[]; avisos: CoincidenciaVoz[]; hook: {numero: boolean; tu: boolean; tension: boolean; cumple: boolean}};

const TENSION = /\b(nadie|error|errores|pierdes|perdiendo|deja de|no sabes|casi todos|el \d+ ?%|sin |antes de|nunca|peor|mejor que|secreto)\b/;

/** Revisa un titular contra voice.md: lo prohibido (falla), avisos y si el hook lleva número, "tú/tu" o tensión. */
export function revisarTitular(texto: string, reglas: readonly ReglaVoz[]): RevisionTitular {
	const r = revisarVoz(texto, reglas);
	const n = normalizar(texto);
	const numero = /\d/.test(texto);
	const tu = /(^|[^\p{L}])(tu|tus|te|ti|contigo)(?=$|[^\p{L}])/u.test(n);
	const tension = TENSION.test(n);
	return {prohibidas: r.filter((x) => x.nivel === 'falla'), avisos: r.filter((x) => x.nivel === 'aviso'), hook: {numero, tu, tension, cumple: numero || tu || tension}};
}
