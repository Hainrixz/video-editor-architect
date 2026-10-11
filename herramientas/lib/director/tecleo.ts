/**
 * La regla del prompt (decisión del estilo, 2026-10-04): cuando dices "le dices a Claude", va el cuadrito blanco (tarjeta variante
 * "prompt") escribiéndose letra por letra, con el sonido de las teclas, para que la gente lo pueda copiar.
 *
 *  - momentosPrompt: encuentra en el transcript "le dices / decirle / le pides / pedirle / le escribes / escribirle a
 *    Claude" y el tramo que sigue hasta el final de la oración o pregunta. El texto literal lo decide Claude en
 *    notas-director.json (tarjetas_forzadas con variante "prompt"); esto solo lo sugiere en direccion.md.
 *  - partirPrompt: un prompt largo (> ~120 caracteres o más de 4 renglones de ≤ 33) se parte en tarjetas consecutivas.
 *  - alinearPrompt / horarioDeParte: el prompt al compás de tu voz. Empareja sus palabras con las que dices y arma el
 *    horario de escritura de cada tarjeta (tarjeta.escritura en la EDL): cada palabra aparece cuando la dices, letra por
 *    letra, y la 2.ª parte de un prompt partido entra cuando empiezas su primera palabra. Si no lo encuentra en tu voz
 *    (< 50 % de sus palabras), va a la velocidad medida como antes.
 *  - tecleoDeTarjetas: a cada tarjeta "prompt" que se escribe le toca su tecleo (el Foley "Typing on the keyboard" propio
 *    del creador), que arranca con la primera letra y dura exactamente lo que tarda en escribirse (sfx.duracion_frames).
 * Puro y determinista.
 */
import type {Edicion} from '../../../src/esquema/edicion.ts';
import {cuadroTextoCompleto} from '../../../src/estilo/animaciones.ts';
import {agruparTarjetas, cuadrosDeHorario, entradaDeTarjeta, escrituraDeTarjeta, grafemas, type EstiloTarjeta, type PuntoEscritura} from '../../../src/estilo/capas.ts';
import type {ArchivoSfx, Catalogo} from '../sfx.ts';
import {limpiar, normalizar, terminaFrase, type Palabra} from './texto.ts';

// ───────────────────────── frases que dictan un prompt ─────────────────────────

/** Verbos que, seguidos de "a Claude", dictan un prompt ("le dices a Claude", "decirle a Claude"…). */
const VERBOS_PROMPT = new Set(['dices', 'decirle', 'dile', 'digas', 'pides', 'pedirle', 'pidele', 'pidas', 'escribes', 'escribirle', 'escribele', 'escribas', 'dictas', 'dictarle', 'preguntas', 'preguntarle']);

/** Palabras máximas del tramo sugerido (si no aparece un punto antes). */
export const MAX_PALABRAS_TRAMO_PROMPT = 60;

export type MomentoPrompt = {
	/** Índice (en el arreglo) de la primera palabra del disparo ("le" o el verbo). */
	k0: number;
	/** La frase que lo dispara, tal cual ("vas a decirle a Claude,"). */
	disparo: string;
	/** Tiempo en que termina "Claude" (el prompt entra en la palabra siguiente). */
	t: number;
	/** Primera palabra del tramo (para desde_palabra, con #n si se repite). */
	desde_palabra: string;
	/** Tiempos del tramo dictado. */
	desde: number;
	hasta: number;
	/** El tramo, tal como lo transcribió whisper (base para escribir el prompt literal). */
	texto: string;
};

const norm = (t: string): string => normalizar(limpiar(t));

/** ¿"…" o "..." al final? En el habla es una pausa a media frase, no su final. */
const terminaEnPuntos = (t: string): boolean => /(\.\.\.|…)["'”’»)]*$/u.test(t);

/**
 * Momentos en que dictas un prompt: "(le) dices / pides / escribes a Claude", "decirle / pedirle / escribirle a Claude".
 * El tramo va de la palabra que sigue a "Claude" hasta el final de la oración o pregunta (los puntos suspensivos no
 * cuentan como final), con un tope de MAX_PALABRAS_TRAMO_PROMPT palabras.
 */
export function momentosPrompt(palabras: readonly Palabra[]): MomentoPrompt[] {
	const res: MomentoPrompt[] = [];
	const vistas = new Map<string, number>();
	const conteo = (k: number): string => {
		// "#n" si la palabra ya salió antes (desde_palabra toma la 1.ª vez si no).
		const w = norm(palabras[k].t);
		let n = 0;
		for (let j = 0; j <= k; j++) if (norm(palabras[j].t) === w) n++;
		return n > 1 ? `${limpiar(palabras[k].t)}#${n}` : limpiar(palabras[k].t);
	};
	for (let k = 0; k + 2 < palabras.length; k++) {
		if (!VERBOS_PROMPT.has(norm(palabras[k].t))) continue;
		if (norm(palabras[k + 1].t) !== 'a' || norm(palabras[k + 2].t) !== 'claude') continue;
		const k0 = k > 0 && norm(palabras[k - 1].t) === 'le' ? k - 1 : k;
		const kClaude = k + 2;
		const i0 = kClaude + 1;
		if (i0 >= palabras.length) continue;
		let i1 = i0;
		while (i1 < palabras.length - 1 && i1 - i0 + 1 < MAX_PALABRAS_TRAMO_PROMPT && !(terminaFrase(palabras[i1].t) && !terminaEnPuntos(palabras[i1].t))) i1++;
		const clave = `${i0}`;
		if (vistas.has(clave)) continue;
		vistas.set(clave, i1);
		res.push({
			k0,
			disparo: palabras
				.slice(Math.max(0, k0 - 2), kClaude + 1)
				.map((p) => p.t)
				.join(' '),
			t: palabras[kClaude].h,
			desde_palabra: conteo(i0),
			desde: palabras[i0].d,
			hasta: palabras[i1].h,
			texto: palabras
				.slice(i0, i1 + 1)
				.map((p) => p.t)
				.join(' '),
		});
	}
	return res;
}

// ───────────────────────── prompts largos en varias tarjetas ─────────────────────────

/** Caracteres por renglón de un prompt (≈ lo que cabe en los 900 px de su caja con la mayúscula medida). */
export const CARACTERES_RENGLON_PROMPT = 33;
/** Renglones por tarjeta "prompt" (en tus reels: 3–4). */
export const RENGLONES_PROMPT = 4;
/** De aquí para arriba un prompt se parte en dos tarjetas seguidas. */
export const MAX_CARACTERES_PROMPT = 120;

/** Renglones de un texto partido por palabras a `ancho` caracteres (respeta los "\n" que ya traiga). */
export function renglonesPrompt(texto: string, ancho = CARACTERES_RENGLON_PROMPT): string[] {
	const out: string[] = [];
	for (const parrafo of texto.split(/\r?\n/)) {
		let linea = '';
		for (const w of parrafo.split(/\s+/).filter(Boolean)) {
			if (!linea) linea = w;
			else if (linea.length + 1 + w.length <= ancho) linea += ` ${w}`;
			else {
				out.push(linea);
				linea = w;
			}
		}
		out.push(linea);
	}
	return out;
}

/** ¿Este prompt necesita partirse? (más de MAX_CARACTERES_PROMPT o de RENGLONES_PROMPT renglones). */
export const promptLargo = (texto: string): boolean => texto.replace(/\s+/g, ' ').trim().length > MAX_CARACTERES_PROMPT || renglonesPrompt(texto).length > RENGLONES_PROMPT;

/**
 * Parte un prompt en tarjetas de ≤ RENGLONES_PROMPT renglones de ≤ CARACTERES_RENGLON_PROMPT caracteres. Si van dos,
 * el corte va en un fin de frase (. ? ! :) si alguno deja las dos partes en ≤ 4 renglones, si no en una coma y
 * si no en cualquier palabra; dentro de cada nivel, el más cercano a la mitad. Un prompt corto sale entero (un solo elemento).
 */
export function partirPrompt(texto: string): string[] {
	const limpio = texto.replace(/[ \t]+/g, ' ').trim();
	if (!promptLargo(limpio)) return [limpio];
	const palabras = limpio.split(/\s+/);
	const cabe = (ws: string[]): boolean => renglonesPrompt(ws.join(' ')).length <= RENGLONES_PROMPT;
	const partes = Math.max(2, Math.ceil(renglonesPrompt(limpio).length / RENGLONES_PROMPT), Math.ceil(limpio.length / MAX_CARACTERES_PROMPT));
	if (partes === 2) {
		// Cortes donde ambas partes caben, por nivel: fin de frase, luego coma, luego cualquier palabra; dentro del
		// nivel, el más cercano a la mitad.
		const mitad = limpio.length / 2;
		const cortes: Array<{j: number; nivel: number; distancia: number}> = [];
		let acum = 0;
		for (let j = 1; j < palabras.length; j++) {
			acum += palabras[j - 1].length + 1;
			if (!cabe(palabras.slice(0, j)) || !cabe(palabras.slice(j))) continue;
			const nivel = /[.?!…:]["'”’»)]*$/u.test(palabras[j - 1]) ? 0 : /[,;]$/u.test(palabras[j - 1]) ? 1 : 2;
			cortes.push({j, nivel, distancia: Math.abs(acum - mitad)});
		}
		cortes.sort((a, b) => a.nivel - b.nivel || a.distancia - b.distancia);
		if (cortes[0]) return [palabras.slice(0, cortes[0].j).join(' '), palabras.slice(cortes[0].j).join(' ')];
	}
	// Más de dos (o sin corte que deje ambas en 4 renglones): llena cada tarjeta hasta su tope.
	const res: string[] = [];
	let actual: string[] = [];
	for (const w of palabras) {
		if (actual.length && !cabe([...actual, w])) {
			res.push(actual.join(' '));
			actual = [w];
		} else actual.push(w);
	}
	if (actual.length) res.push(actual.join(' '));
	return res;
}

/** Cuadros que tarda en escribirse (completo) un texto con la escritura medida de los prompts, sin tope de pantalla. */
export function cuadrosEscrituraPrompt(texto: string, estilo: EstiloTarjeta): number {
	const {total, params} = escrituraDeTarjeta({texto, variante: 'prompt'}, estilo, Number.MAX_SAFE_INTEGER);
	return cuadroTextoCompleto(total, params);
}

/** Segundos que un prompt se queda completo en pantalla para leerlo (supuesto 2026-10-04, no medido en tus reels). */
export const LECTURA_PROMPT_S = 1.2;

/**
 * Segundos en pantalla de una tarjeta prompt: lo que tarda en escribirse más LECTURA_PROMPT_S, y nunca menos de lo
 * que pide ESCRITURA_TERMINA_MAX (en tus reels el texto queda completo, a más tardar, al 87 % de su tiempo en pantalla).
 */
export function tiempoPrompt(texto: string, estilo: EstiloTarjeta): number {
	const escribir = cuadrosEscrituraPrompt(texto, estilo) / 30;
	return Math.round(Math.max(escribir + LECTURA_PROMPT_S, escribir / estilo.escritura.termina_max) * 1000) / 1000;
}

// ───────────────────────── al compás de tu voz ─────────────────────────

/**
 * Velocidad con que se extrapola el horario fuera de las palabras dichas (car/s): la medida en tus prompts (30.7).
 * Solo se usa en las orillas (una palabra del prompt que no dijiste al principio o al final).
 */
const CAR_S_EXTRAPOLAR = 30.7;

/** De aquí para abajo (fracción de palabras del prompt que encontré en tu voz) no se alinea: va a la velocidad medida. */
export const MIN_EMPAREJADAS_PROMPT = 0.5;

export type AlineacionPrompt = {
	/** Palabras del prompt en orden (como las parte partirPrompt), con su rango de grafemas [a, b) en el texto unido con espacios. */
	palabras: Array<{w: string; a: number; b: number; d: number | null; h: number | null}>;
	/** Puntos del horario de todo el prompt (grafemas del texto unido, segundos): inicio y final de cada palabra dicha. */
	puntos: PuntoEscritura[];
	emparejadas: number;
};

/**
 * Empareja las palabras de un prompt con las que dices desde `i0` (alineación por la subsecuencia común más larga,
 * sin acentos ni signos) y arma su horario: cada palabra dicha se escribe de su inicio a su final, letra por letra;
 * lo que no dijiste (o whisper no oyó) se escribe parejo entre las palabras vecinas. Busca hasta `hastaS` (si viene) o
 * hasta 2× las palabras del prompt + 10. null si encontró menos de MIN_EMPAREJADAS_PROMPT de las palabras (o < 2).
 */
export function alinearPrompt(texto: string, voz: readonly Palabra[], i0: number, hastaS?: number): AlineacionPrompt | null {
	const ws = texto.replace(/[ \t]+/g, ' ').trim().split(/\s+/).filter(Boolean);
	if (ws.length === 0 || i0 < 0 || i0 >= voz.length) return null;
	const tope = Math.min(voz.length, i0 + 2 * ws.length + 10);
	const ventana: Palabra[] = [];
	for (let j = i0; j < tope; j++) {
		if (hastaS !== undefined && voz[j].d > hastaS + 1e-6) break;
		ventana.push(voz[j]);
	}
	const A = ws.map(norm);
	const B = ventana.map((p) => norm(p.t));
	// Subsecuencia común más larga (n × m pequeño: ≤ ~60 × 130).
	const n = A.length;
	const m = B.length;
	const L: number[][] = Array.from({length: n + 1}, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
	const pareja = new Array<number | null>(n).fill(null);
	for (let i = 0, j = 0; i < n && j < m; ) {
		if (A[i] && A[i] === B[j] && L[i][j] === L[i + 1][j + 1] + 1) {
			pareja[i] = j;
			i++;
			j++;
		} else if (L[i + 1][j] >= L[i][j + 1]) i++;
		else j++;
	}
	const emparejadas = pareja.filter((x) => x !== null).length;
	if (emparejadas < Math.max(2, Math.ceil(MIN_EMPAREJADAS_PROMPT * n))) return null;
	const palabras: AlineacionPrompt['palabras'] = [];
	const puntos: PuntoEscritura[] = [];
	let a = 0;
	let tPrev = -Infinity;
	ws.forEach((w, i) => {
		const b = a + grafemas(w).length;
		const j = pareja[i];
		let d: number | null = null;
		let h: number | null = null;
		if (j !== null) {
			// Nunca hacia atrás (whisper a veces encima una palabra con la anterior).
			d = Math.max(ventana[j].d, tPrev);
			h = Math.max(ventana[j].h, d);
			tPrev = h;
			puntos.push({car: a, t: d}, {car: b, t: h});
		}
		palabras.push({w, a, b, d, h});
		a = b + 1;
	});
	return {palabras, puntos, emparejadas};
}

/** Segundo en que el horario llega al grafema `c` (lineal entre puntos; en las orillas, a la velocidad medida). */
export function tiempoDeCaracter(puntos: readonly PuntoEscritura[], c: number): number {
	const p0 = puntos[0];
	const pn = puntos[puntos.length - 1];
	if (c <= p0.car) return p0.t - (p0.car - c) / CAR_S_EXTRAPOLAR;
	if (c >= pn.car) return pn.t + (c - pn.car) / CAR_S_EXTRAPOLAR;
	let k = 0;
	while (k + 1 < puntos.length && puntos[k + 1].car < c) k++;
	const x = puntos[k];
	const y = puntos[k + 1];
	return y.car === x.car ? y.t : x.t + ((y.t - x.t) * (c - x.car)) / (y.car - x.car);
}

/**
 * Horario de una parte del prompt (sus grafemas [A, B) del texto unido), en segundos absolutos y grafemas de la parte:
 * empieza en su primera letra y acaba en la última, con los puntos de las palabras dichas en medio. Los tiempos se
 * acotan a [desde, hasta − 1 cuadro] de su tarjeta, para que el texto quede completo antes de que se vaya.
 */
export function horarioDeParte(al: AlineacionPrompt, A: number, B: number, desde: number, hasta: number): PuntoEscritura[] {
	const acotar = (t: number): number => Math.round(Math.min(Math.max(t, desde), Math.max(desde, hasta - 1 / 30)) * 1000) / 1000;
	const res: PuntoEscritura[] = [{car: 0, t: acotar(tiempoDeCaracter(al.puntos, A))}];
	for (const p of al.puntos) if (p.car > A && p.car < B) res.push({car: p.car - A, t: acotar(p.t)});
	res.push({car: B - A, t: acotar(tiempoDeCaracter(al.puntos, B))});
	// Orden garantizado (acotar no lo rompe); se quitan los repetidos exactos.
	return res.filter((p, i) => i === 0 || p.car !== res[i - 1].car || p.t !== res[i - 1].t).map((p, i, arr) => (i > 0 && p.t < arr[i - 1].t ? {...p, t: arr[i - 1].t} : p));
}

/** Rangos de grafemas [A, B) de cada parte de partirPrompt dentro del texto unido con espacios (las partes van por palabras). */
export function rangosDePartes(partes: readonly string[]): Array<{A: number; B: number}> {
	let A = 0;
	return partes.map((p) => {
		const B = A + grafemas(p).length;
		const r = {A, B};
		A = B + 1;
		return r;
	});
}

// ───────────────────────── tecleo ─────────────────────────

/** Un archivo de tecleo: categoría "especial" con "typing", "keyboard" o "tecleo" en su id. */
export const PATRON_TECLEO = /typing|keyboard|tecle|teclado/i;

/**
 * El tecleo del catálogo (el original antes que sus variantes de tono), solo de las fuentes permitidas
 * (creador.json → sfx.solo_fuentes; vacío = todas). null si no hay.
 */
export function archivoTecleo(catalogo: Pick<Catalogo, 'archivos'>, soloFuentes: readonly string[] | null): ArchivoSfx | null {
	const candidatos = catalogo.archivos.filter(
		(a) => a.categoria === 'especial' && PATRON_TECLEO.test(a.id) && (a.aprobacion === 'no-requiere' || a.aprobacion === 'aprobada') && (!soloFuentes || soloFuentes.includes(a.fuente)),
	);
	candidatos.sort((a, b) => Math.abs(a.semitonos) - Math.abs(b.semitonos) || b.duracion_s - a.duracion_s || a.id.localeCompare(b.id));
	return candidatos[0] ?? null;
}

type TarjetaEdl = Edicion['tarjetas'][number];
type SfxEdl = NonNullable<TarjetaEdl['sfx']>;

/**
 * Cuándo teclea una tarjeta que se escribe: arranca con la primera letra (offset = cuadros de caja vacía) y dura hasta
 * el cuadro en que el texto queda completo (inclusive). Mismo cálculo que Tarjeta.tsx: su tiempo en pantalla es de su
 * aparición a que se va su grupo. null si la tarjeta no se escribe letra por letra.
 */
export function cuadrosDeTecleo(t: TarjetaEdl, todas: readonly TarjetaEdl[], estilo: EstiloTarjeta): {offset: number; duracion: number} | null {
	if (entradaDeTarjeta(t, estilo) !== 'escritura') return null;
	const grupo = agruparTarjetas(todas).find((g) => g.tarjetas.some((x) => x.id === t.id));
	const desde = Math.round(t.desde * 30);
	const hasta = grupo ? grupo.hasta : Math.max(desde + 1, Math.round(t.hasta * 30));
	const {total, params} = escrituraDeTarjeta(t, estilo, hasta - desde);
	if (total <= 1) return null;
	if (t.escritura) {
		// Al compás de tu voz: teclea de la primera letra a la última (las pausas entre palabras van con tecleo, como
		// quien escribe de corrido). El director deja la primera letra a ≤ 6 cuadros de que aparece la caja.
		const c = cuadrosDeHorario(t.escritura, total, desde, hasta);
		if (!c) return null;
		const offset = Math.max(0, Math.min(6, c.primera - desde));
		return {offset, duracion: Math.max(1, c.completo - (desde + offset) + 1)};
	}
	const offset = Math.max(0, Math.min(6, Math.round(params.cuadros_vacia)));
	const completo = cuadroTextoCompleto(total, params);
	return {offset, duracion: Math.max(1, completo - offset + 1)};
}

export type OpcionesTecleo = {
	archivo: ArchivoSfx | null;
	estilo: EstiloTarjeta;
	/** Sonoridad de tu voz (LUFS) y el nivel del tecleo respecto a ella (dB; el más bajo de tu rango de SFX: es un fondo continuo). */
	vozLufs: number;
	nivelRelDb: number;
};

/**
 * El tecleo de cada tarjeta "prompt" que se escribe: {id → sfx con duracion_frames}. Avisa si no hay archivo de tecleo
 * o si el texto tarda más en escribirse de lo que dura el archivo (entonces suena el archivo completo).
 */
export function tecleoDeTarjetas(tarjetas: readonly TarjetaEdl[], op: OpcionesTecleo): {tecleos: Map<string, SfxEdl>; avisos: string[]} {
	const tecleos = new Map<string, SfxEdl>();
	const avisos: string[] = [];
	const prompts = tarjetas.filter((t) => t.variante === 'prompt');
	if (prompts.length === 0) return {tecleos, avisos};
	if (!op.archivo) {
		avisos.push('no encontré tu tecleo en biblioteca/sfx/catalogo.json (categoría "especial", "typing on the keyboard"): los prompts van sin sonido de teclas; corre npx tsx herramientas/sfx/catalogar.ts');
		return {tecleos, avisos};
	}
	const maxCuadros = Math.floor(op.archivo.duracion_s * 30);
	let ganancia = op.nivelRelDb + op.vozLufs - op.archivo.lufs;
	ganancia = Math.max(-40, Math.min(0, Math.round(ganancia * 10) / 10));
	for (const t of prompts) {
		const c = cuadrosDeTecleo(t, tarjetas, op.estilo);
		if (!c) {
			avisos.push(`tarjeta prompt ${t.id}: no se escribe letra por letra (entrada "${t.entrada}"), así que va sin tecleo`);
			continue;
		}
		let duracion = c.duracion;
		if (duracion > maxCuadros) {
			avisos.push(`tarjeta prompt ${t.id}: tarda ${duracion} cuadros en escribirse y tu tecleo dura ${maxCuadros}; suena completo y acaba antes (pártelo en dos tarjetas)`);
			duracion = maxCuadros;
		}
		tecleos.set(t.id, {asset: op.archivo.archivo, ganancia_db: ganancia, offset_frames: c.offset, variante: op.archivo.semitonos === 0 ? 0 : op.archivo.semitonos > 0 ? 1 : 2, duracion_frames: duracion});
	}
	return {tecleos, avisos};
}

/** ¿Este SFX es un tecleo de prompt (recortado a lo que tarda en escribirse)? */
export const esTecleo = (sfx: {duracion_frames?: number} | null | undefined): boolean => typeof sfx?.duracion_frames === 'number';
