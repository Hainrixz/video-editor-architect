// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Tomas repetidas en la transcripción (parte de texto de la etapa 4 de /editar, "Cortes").
 *
 * Es una PROPUESTA: el creador aprueba el texto final (punto de control) y puede recuperar cualquier frase
 * descartada con `cortes.ts --aplicar-texto`.
 *
 * 1. Frases. Se corta una frase:
 *    - después de una palabra que termina en . ? ! … o ; (con comillas o paréntesis de cierre detrás);
 *    - antes de una palabra que empieza con ¿ o ¡;
 *    - donde hay una pausa de más de `pausaFraseS` (0.6 s) entre el fin de una palabra y el inicio de la otra.
 *    Las comas NO cortan: "No me creas, la verdad, no me creas" es una sola frase y su repetición es retórica.
 *
 * 2. Tomas repetidas ("se queda la última"). Cada frase A se compara con las que empiezan a menos de
 *    `cercaniaS` (10 s) de su final. A se descarta si alguna frase posterior B cumple:
 *    - arranque en falso: A tiene 1–3 palabras, B es la frase que sigue y B la repite completa al inicio
 *      (o después de una palabra, p. ej. "y"): "Vas a." + "Vas a ir a la parte de Code.";
 *    - parecido: similitud ≥ 0.6 con al menos 3 palabras en común. Similitud = 2·LCS / (|A| + |B|), con LCS la
 *      subsecuencia común más larga de palabras normalizadas;
 *    - mismo arranque: las primeras 3 palabras iguales (2 si A solo tiene 2), con B de al menos 3 palabras y no
 *      menos de la mitad de larga que A (un fragmento abandonado después no tumba a una frase completa).
 *    Si A ~ B ~ C, se descartan A y B y queda C.
 *
 * Normalización para comparar: minúsculas, sin acentos ni puntuación, y además b = v, z = s y sin h muda
 * (whisper escribe "BAS..." donde dijiste "Vas..."). El texto original de cada palabra no se toca.
 *
 * Todo es local, determinista y sin dependencias.
 */

export interface PalabraTomas {
	/** Texto tal cual (con su puntuación). */
	t: string;
	/** Inicio y fin en segundos (de preferencia ya refinados con la energía: whisper alarga los finales). */
	d: number;
	h: number;
}

export type TipoDescarte = 'arranque-en-falso' | 'parecido' | 'mismo-arranque';

export interface Frase {
	/** Índices (en el arreglo de palabras) de la primera y la última palabra de la frase, ambos incluidos. */
	i0: number;
	i1: number;
	texto: string;
	/** Inicio de su primera palabra y fin de la última (s). */
	d: number;
	h: number;
	descartada: boolean;
	/** Por qué se descartó, en una frase para el creador; null si se queda. */
	motivo: string | null;
	tipo: TipoDescarte | null;
	/** Índice de la frase posterior que la reemplaza; null si se queda. */
	por: number | null;
	/** Similitud con esa frase (0–1); null si se queda. */
	similitud: number | null;
	/** Termina en "...", "…" o guion: parece que se cortó a media frase. */
	cortada: boolean;
}

export interface ResultadoTomas {
	frases: Frase[];
}

export interface OpcionesTomas {
	/** Una pausa de más de esto (s) entre dos palabras corta la frase. */
	pausaFraseS: number;
	/** Solo se comparan frases cuyo inicio queda a menos de esto (s) del final de la anterior. */
	cercaniaS: number;
	/** Similitud mínima (2·LCS / (|A|+|B|)) para llamarlas la misma toma. */
	similitudMinima: number;
	/** …y con al menos tantas palabras en común (dos frases de 2 palabras no bastan). */
	comunesMinimas: number;
	/** Palabras del arranque que se comparan. */
	arranquePalabras: number;
	/** Mínimo de palabras iguales al arranque (cuando la frase anterior es más corta que arranquePalabras). */
	arranqueMinimo: number;
	/** La frase posterior tiene que tener al menos tantas palabras para tumbar a la anterior por su arranque. */
	arranquePosteriorMinimo: number;
	/** …y al menos esta fracción del largo de la anterior. */
	arranqueProporcionMinima: number;
	/** Una frase de hasta tantas palabras puede ser un arranque en falso. */
	falsoArranqueMax: number;
	/** Palabras de la frase siguiente que se pueden saltar antes de la repetición ("y vas a…"). */
	falsoArranqueDesfase: number;
}

export const OPCIONES_TOMAS: Readonly<OpcionesTomas> = Object.freeze({
	pausaFraseS: 0.6,
	cercaniaS: 10,
	similitudMinima: 0.6,
	comunesMinimas: 3,
	arranquePalabras: 3,
	arranqueMinimo: 2,
	arranquePosteriorMinimo: 3,
	arranqueProporcionMinima: 0.5,
	falsoArranqueMax: 3,
	falsoArranqueDesfase: 1,
});

const FIN_DE_FRASE = /[.?!…;]["'”’»)\]]*$/u;
const INICIO_DE_PREGUNTA = /^["'“‘«(\[]*[¿¡]/u;
const CORTADA = /(\.\.\.|…|[-–—])["'”’»)\]]*$/u;

/** Minúsculas, sin acentos ni puntuación ("¿Cómo" → "como", "5.5" → "55"). Vacía si no trae letras ni números. */
export function normalizarPalabra(t: string): string {
	return t
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Clave para comparar tomas: la palabra normalizada con b = v, z = s y sin h muda (la "ch" se respeta).
 * Solo sirve para decidir si dos frases dicen lo mismo; nunca se muestra.
 */
export function claveDeToma(t: string): string {
	return normalizarPalabra(t)
		.replace(/v/g, 'b')
		.replace(/z/g, 's')
		.replace(/(^|[^c])h/g, '$1');
}

/** Largo de la subsecuencia común más larga entre dos listas de claves. */
export function lcs(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	let previa = new Array<number>(b.length + 1).fill(0);
	let actual = new Array<number>(b.length + 1).fill(0);
	for (let x = 1; x <= a.length; x++) {
		for (let y = 1; y <= b.length; y++) {
			actual[y] = a[x - 1] === b[y - 1] ? previa[y - 1] + 1 : Math.max(previa[y], actual[y - 1]);
		}
		[previa, actual] = [actual, previa];
	}
	return previa[b.length];
}

/** Similitud por palabras: 2·LCS / (|a| + |b|), entre 0 y 1, y cuántas palabras tienen en común. */
export function similitud(a: readonly string[], b: readonly string[]): {valor: number; comunes: number} {
	const total = a.length + b.length;
	if (total === 0) return {valor: 0, comunes: 0};
	const comunes = lcs(a, b);
	return {valor: (2 * comunes) / total, comunes};
}

/** Parte las palabras en frases: [i0, i1] con i1 incluido. */
export function dividirEnFrases(palabras: readonly PalabraTomas[], opciones: Partial<OpcionesTomas> = {}): Array<{i0: number; i1: number}> {
	const o = {...OPCIONES_TOMAS, ...opciones};
	const frases: Array<{i0: number; i1: number}> = [];
	let i0 = 0;
	for (let j = 0; j < palabras.length; j++) {
		const siguiente = palabras[j + 1];
		const corta =
			siguiente === undefined ||
			FIN_DE_FRASE.test(palabras[j].t.trim()) ||
			INICIO_DE_PREGUNTA.test(siguiente.t.trim()) ||
			siguiente.d - palabras[j].h > o.pausaFraseS;
		if (corta) {
			frases.push({i0, i1: j});
			i0 = j + 1;
		}
	}
	return frases;
}

const recortar = (texto: string, max = 60): string => (texto.length <= max ? texto : `${texto.slice(0, max - 1).trimEnd()}…`);
const segundos = (t: number): string => `${t.toFixed(1)} s`;

/** ¿`corta` aparece completa al inicio de `larga` (o después de `desfase` palabras)? */
function repiteAlInicio(corta: readonly string[], larga: readonly string[], desfase: number): boolean {
	if (corta.length === 0 || larga.length < corta.length) return false;
	for (let inicio = 0; inicio <= desfase && inicio + corta.length <= larga.length; inicio++) {
		if (corta.every((c, k) => larga[inicio + k] === c)) return true;
	}
	return false;
}

/**
 * Divide en frases y marca las tomas repetidas y los arranques en falso (ver encabezado).
 * Las palabras van en orden de tiempo; la salida trae todas las frases, descartadas o no, en orden.
 */
export function detectarTomas(palabras: readonly PalabraTomas[], opciones: Partial<OpcionesTomas> = {}): ResultadoTomas {
	const o = {...OPCIONES_TOMAS, ...opciones};
	const rangos = dividirEnFrases(palabras, o);
	const claves = rangos.map(({i0, i1}) =>
		palabras
			.slice(i0, i1 + 1)
			.map((p) => claveDeToma(p.t))
			.filter((c) => c !== ''),
	);
	const frases: Frase[] = rangos.map(({i0, i1}) => {
		const texto = palabras
			.slice(i0, i1 + 1)
			.map((p) => p.t.trim())
			.join(' ');
		return {
			i0,
			i1,
			texto,
			d: palabras[i0].d,
			h: palabras[i1].h,
			descartada: false,
			motivo: null,
			tipo: null,
			por: null,
			similitud: null,
			cortada: CORTADA.test(palabras[i1].t.trim()),
		};
	});

	for (let a = 0; a < frases.length; a++) {
		const A = claves[a];
		if (A.length === 0) continue;
		for (let b = a + 1; b < frases.length && frases[b].d - frases[a].h < o.cercaniaS; b++) {
			const B = claves[b];
			if (B.length === 0) continue;
			const sim = similitud(A, B);
			const ref = `la frase ${b + 1} («${recortar(frases[b].texto, 40)}», ${segundos(frases[b].d)})`;

			if (b === a + 1 && A.length <= o.falsoArranqueMax && repiteAlInicio(A, B, o.falsoArranqueDesfase)) {
				marcar(frases[a], 'arranque-en-falso', b, sim.valor, `arranque en falso: «${frases[a].texto}» se repite completo al inicio de ${ref}`);
				break;
			}
			if (sim.valor >= o.similitudMinima && sim.comunes >= o.comunesMinimas) {
				marcar(frases[a], 'parecido', b, sim.valor, `toma repetida: se parece ${Math.round(sim.valor * 100)} % a ${ref}; se queda la última`);
				break;
			}
			const k = Math.min(o.arranquePalabras, A.length);
			const mismoArranque =
				k >= o.arranqueMinimo &&
				B.length >= Math.max(o.arranquePosteriorMinimo, k) &&
				B.length >= o.arranqueProporcionMinima * A.length &&
				A.slice(0, k).every((c, x) => B[x] === c);
			if (mismoArranque) {
				const arranque = palabrasConClave(palabras, frases[a], k);
				marcar(frases[a], 'mismo-arranque', b, sim.valor, `toma repetida: arranca igual que ${ref} («${arranque}»); se queda la última`);
				break;
			}
		}
	}
	return {frases};
}

function marcar(frase: Frase, tipo: TipoDescarte, por: number, valor: number, motivo: string): void {
	frase.descartada = true;
	frase.tipo = tipo;
	frase.por = por;
	frase.similitud = Math.round(valor * 1000) / 1000;
	frase.motivo = motivo;
}

/** Las primeras k palabras con letras de la frase, tal como se dijeron (para el motivo). */
function palabrasConClave(palabras: readonly PalabraTomas[], frase: Frase, k: number): string {
	const salida: string[] = [];
	for (let j = frase.i0; j <= frase.i1 && salida.length < k; j++) {
		if (claveDeToma(palabras[j].t) !== '') salida.push(normalizarPalabra(palabras[j].t));
	}
	return salida.join(' ');
}
