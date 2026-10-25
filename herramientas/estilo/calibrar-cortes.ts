// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * calibrar-cortes.ts — calibra los cortes (Fases 1 y 6) con lo que TÚ hiciste en tus pares crudo ↔ publicado.
 *
 *   npx tsx herramientas/estilo/calibrar-cortes.ts [--pares pruebas/pares.json] [--salida estilo/calibracion-cortes.json]
 *                                                  [--detalle out/f6-calibracion] [--sin-video] [--sin-imagenes]
 *
 * Entra: por cada par aceptado de pruebas/pares.json, dos proyectos ya transcritos con transcribir.ts:
 *   proyectos/_cal-<crudo>  (p. ej. _cal-img-5199)  y  proyectos/_cal-pub-<shortCode en minúsculas>.
 * Los crea pruebas/integracion/f6-calibrar.ts (ingesta.ts + transcribir.ts; whisper corre fuera del sandbox).
 * Este CLI solo lee: los proyectos, tus mp4 publicados (cuadros con ffmpeg, en solo lectura) y pares.json.
 *
 * 1. Reconstruye tu edición de cada par:
 *    a. Velocidad: en tramos de habla continua (≥ 6 palabras seguidas en los dos lados, sin pausas de 0.25 s) busca
 *       el factor y el desfase que mejor empatan la envolvente de energía del publicado con la del crudo
 *       (correlación de Pearson en dB, ventanas de 10 ms cada 5 ms). factor = tiempo del crudo / tiempo del publicado
 *       (1.10 = lo aceleraste 10 %). Cuenta solo con correlación ≥ 0.8; se reporta la mediana ponderada por duración y n.
 *    b. Alineación de palabras crudo ↔ publicado (claves de lib/tomas.ts: sin acentos, b = v, z = s, sin h muda) con
 *       programación dinámica y huecos afines: saltarse un pedazo del crudo cuesta lo mismo sea largo o corto (un
 *       corte), así que entre tomas repetidas gana la que deja el texto más seguido.
 *    c. Desfase fino de cada bloque de habla (entre pausas de 0.1 s) por correlación de la envolvente: tiempo del crudo
 *       = factor · tiempo del publicado + desfase. Un bloque que contradice el orden (el publicado tendría más tiempo
 *       que el crudo entre dos bloques) se descarta. Los bloques fuertes (correlación ≥ 0.6 en ≥ 0.5 s) son anclas: entre
 *       dos anclas seguidas hay corte si el desfase sube ≥ 50 ms (≥ 20 ms si además hay salto de imagen en el hueco), y
 *       ese aumento es lo que quitaste del crudo. Un bloque débil (una o dos palabras) se une al grupo vecino de desfase
 *       más parecido; así una palabra suelta mal medida no inventa un corte.
 *    d. El cuadro exacto de cada corte en el publicado: el salto de imagen (diferencia entre cuadros en la zona de la
 *       cabeza, 2.5× la mediana de ±5 cuadros y 1.5× sus dos vecinos: un corte es un cuadro aislado, un gesto no)
 *       dentro del hueco entre palabras; si una captura tapa la cara, por audio (qué lado empata mejor con el crudo);
 *       si tampoco, se reparte el hueco con la proporción mediana medida.
 *    e. Con eso: los tramos del crudo que se quedaron (en s del crudo), qué pausas cortaste y cuáles dejaste, cuánto
 *       silencio dejaste antes y después de cada corte (pads), las palabras o tomas que quitaste y la velocidad.
 * 2. Calibra PARAMETROS_CORTES (cortes.ts): con TU selección de palabras (como si aprobaras su texto) prueba una rejilla
 *    de huecoMinimoS × padAntesS × padDespuesS. Por par: duración de nuestra base vs la tuya sin acelerar (la suma de
 *    tus tramos en s del crudo) y F1 de bordes a ±100 ms. Gana la que cumple la meta en todos los pares (±5 %; si
 *    ninguna, ±15 %) con el mejor F1 medio; si empatan (F1 ±0.02 y error ±0.5 puntos), la más cercana a los pads que
 *    mediste en tus cortes de pausa (si los datos no distinguen, no se aleja de lo medido directamente).
 *    La regla de tomas (lib/tomas.ts) se calibra aparte: F1 por palabra entre lo que quita la propuesta automática y lo
 *    que quitaste tú; solo cambia si la nueva regla casi nunca quita algo que dejaste (precisión ≥ 0.95) y mejora en al
 *    menos 2 pares.
 * 3. Escribe estilo/calibracion-cortes.json ({parametros, n_pares, por_par, velocidad, pausas, pads, fuente, metodo…});
 *    cortes.ts solo lee `parametros`. El detalle, las líneas de tiempo y las hojas de saltos van a out/f6-calibracion/.
 *
 * La velocidad NO se aplica aquí (base.ts es de otra pieza): se reporta con su n.
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo (pares.json, un proyecto _cal-* sin transcribir, el mp4 publicado).
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename, extname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
	analizarEnergia,
	construirKeep,
	leerTranscripcion,
	limiteDelCrudo,
	PARAMETROS_CORTES,
	refinarPalabras,
	type AnalisisEnergia,
	type Limites,
	type Palabra,
	type ParametrosCortes,
} from '../cortes.ts';
import {energiaPorVentana, leerWav, type Wav} from '../lib/energia.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, leerManifest} from '../lib/manifest.ts';
import {duracionBase, FPS, type Tramo} from '../lib/remapear.ts';
import {claveDeToma, detectarTomas, OPCIONES_TOMAS, similitud, type OpcionesTomas} from '../lib/tomas.ts';

const USO =
	'npx tsx herramientas/estilo/calibrar-cortes.ts [--pares pruebas/pares.json] [--salida estilo/calibracion-cortes.json] [--detalle out/f6-calibracion] [--sin-video] [--sin-imagenes]';

/** Opciones del método (van completas al informe). */
export const OPCIONES_CALIBRACION = Object.freeze({
	alineacion: Object.freeze({acierto: 2, abrirHueco: 1.5, extenderHuecoCrudo: 0, extenderHuecoPublicado: 0.3}),
	envolvente: Object.freeze({ventanaS: 0.01, saltoS: 0.005, pisoBajoVozDb: 45}),
	velocidad: Object.freeze({
		min: 0.9,
		max: 1.4,
		pasoGrueso: 0.01,
		pasoFino: 0.0025,
		radioDesfaseS: 0.25,
		palabrasMin: 6,
		pausaMaxS: 0.25,
		duracionMinS: 1.2,
		rMin: 0.8,
	}),
	segmentos: Object.freeze({
		/** Un bloque de habla se parte en pausas (crudo o publicado) de al menos esto (s). */
		pausaSubbloqueS: 0.1,
		/** Ventana mínima (s del publicado) para fiarse de la correlación de un bloque. */
		ventanaMinS: 0.25,
		margenS: 0.05,
		radioDesfaseS: 0.15,
		pasoDesfaseS: 0.0025,
		/** Correlación desde la que un bloque se da por bien ubicado. */
		rConfiable: 0.6,
		/** Un bloque es ancla si su correlación es confiable en una ventana de al menos esto (s). */
		ventanaFuerteS: 0.5,
		/** Entre dos anclas hay corte si el desfase sube al menos esto (s del crudo)… */
		corteMinimoS: 0.05,
		/** …o esto si además hay salto de imagen en el hueco. */
		corteMinimoConSaltoS: 0.02,
		/** Un bloque débil se une al grupo vecino si su desfase queda a menos de esto (s). */
		debilMaxS: 0.12,
		/** Si el publicado tendría más de esto (s) de tiempo que el crudo entre dos bloques, uno de los dos está mal ubicado. */
		negativoMaxS: 0.1,
	}),
	saltos: Object.freeze({
		/** Franja vertical (fracción del alto) donde se mide el salto: la cabeza, debajo del titular y arriba de los stickers. */
		region: Object.freeze([0.08, 0.52] as const),
		ancho: 90,
		alto: 160,
		razonMin: 2.5,
		/** …y al menos esto sobre sus dos vecinos inmediatos. */
		razonInmediata: 1.5,
		difMin: 4,
		vecinos: 5,
		margenCuadros: 2,
	}),
	audioCorte: Object.freeze({usar: true, margenS: 0.08, gananciaMinDb: 2}),
	bordes: Object.freeze({toleranciaS: 0.1}),
	pausas: Object.freeze({minimaS: 0.05}),
});

/** Los números de las opciones como `number` (Object.freeze los deja como literales). */
type Ensanchar<T> = T extends number ? number : T extends boolean ? boolean : T extends object ? {readonly [K in keyof T]: Ensanchar<T[K]>} : T;
export type OpcionesCalibracion = Ensanchar<typeof OPCIONES_CALIBRACION>;

// ───────────────────────── utilidades numéricas (puras) ─────────────────────────

/** Cuantil con interpolación lineal; null sin datos. */
export function cuantil(valores: readonly number[], q: number): number | null {
	const v = valores.filter(Number.isFinite).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const pos = (v.length - 1) * Math.min(1, Math.max(0, q));
	const bajo = Math.floor(pos);
	const alto = Math.min(bajo + 1, v.length - 1);
	return v[bajo] + (v[alto] - v[bajo]) * (pos - bajo);
}

/** Mediana ponderada (pesos > 0); null sin datos. */
export function medianaPonderada(valores: ReadonlyArray<{valor: number; peso: number}>): number | null {
	const v = valores.filter((x) => Number.isFinite(x.valor) && x.peso > 0).sort((a, b) => a.valor - b.valor);
	const total = v.reduce((s, x) => s + x.peso, 0);
	if (v.length === 0 || total <= 0) return null;
	let acumulado = 0;
	for (const x of v) {
		acumulado += x.peso;
		if (acumulado >= total / 2 - 1e-12) return x.valor;
	}
	return v.at(-1)!.valor;
}

/** Correlación de Pearson; NaN si alguna serie es constante. */
export function correlacion(x: ArrayLike<number>, y: ArrayLike<number>): number {
	const n = Math.min(x.length, y.length);
	if (n < 2) return Number.NaN;
	let mx = 0;
	let my = 0;
	for (let k = 0; k < n; k++) {
		mx += x[k];
		my += y[k];
	}
	mx /= n;
	my /= n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let k = 0; k < n; k++) {
		const a = x[k] - mx;
		const b = y[k] - my;
		sxy += a * b;
		sxx += a * a;
		syy += b * b;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

// ───────────────────────── envolvente ─────────────────────────

/** Energía en dB por ventana, con un piso relativo a la voz (así el ruido de fondo de cada archivo no manda). */
export interface Envolvente {
	db: Float64Array;
	saltoS: number;
	ventanaS: number;
	pisoDb: number;
}

export function envolventeDe(wav: Wav, op: OpcionesCalibracion['envolvente'] = OPCIONES_CALIBRACION.envolvente): Envolvente {
	const {dbfs, saltoS, ventanaS} = energiaPorVentana(wav, op.ventanaS, op.saltoS);
	const referencia = cuantil(Array.from(dbfs), 0.9) ?? -20;
	const pisoDb = referencia - op.pisoBajoVozDb;
	const db = Float64Array.from(dbfs, (x) => Math.max(pisoDb, x));
	return {db, saltoS, ventanaS, pisoDb};
}

/** Envolvente en el tiempo t (s), interpolada; fuera del audio, el piso. */
export function muestrear(env: Envolvente, t: number): number {
	const x = (t - env.ventanaS / 2) / env.saltoS;
	if (!(x >= 0) || x > env.db.length - 1) return env.pisoDb;
	const k = Math.floor(x);
	const f = x - k;
	const a = env.db[k];
	const b = k + 1 < env.db.length ? env.db[k + 1] : a;
	return a + (b - a) * f;
}

/** Muestras del publicado en [p0, p1] cada `paso` s. */
function serie(env: Envolvente, p0: number, p1: number, paso: number): {t: number[]; v: number[]} {
	const t: number[] = [];
	for (let x = p0; x <= p1 + 1e-9; x += paso) t.push(x);
	return {t, v: t.map((x) => muestrear(env, x))};
}

/** Correlación entre el publicado (ya muestreado) y el crudo con tiempo del crudo = factor · tiempo + desfase. */
function correlacionMapeo(envC: Envolvente, publicado: {t: number[]; v: number[]}, factor: number, desfase: number): number {
	const c = publicado.t.map((t) => muestrear(envC, factor * t + desfase));
	return correlacion(publicado.v, c);
}

// ───────────────────────── velocidad ─────────────────────────

export interface MedidaVelocidad {
	/** Ventana del publicado (s). */
	p0: number;
	p1: number;
	factor: number;
	desfase: number;
	r: number;
}

/**
 * Busca factor y desfase (tiempo del crudo = factor · t + desfase) para una ventana del publicado, cerca de
 * `desfaseEstimado` (para factor = 1). Rejilla gruesa y luego fina alrededor del mejor.
 */
export function medirVelocidadTramo(
	envC: Envolvente,
	envP: Envolvente,
	p0: number,
	p1: number,
	cEnP0: number,
	op: OpcionesCalibracion['velocidad'] = OPCIONES_CALIBRACION.velocidad,
): MedidaVelocidad {
	const pub = serie(envP, p0, p1, envP.saltoS);
	let mejor = {factor: 1, desfase: cEnP0 - p0, r: -2};
	const probar = (factor: number, desde: number, hasta: number, paso: number) => {
		for (let d = desde; d <= hasta + 1e-12; d += paso) {
			// d = desplazamiento del crudo en p0: tiempo del crudo en p0 = cEnP0 + d.
			const desfase = cEnP0 + d - factor * p0;
			const r = correlacionMapeo(envC, pub, factor, desfase);
			if (r > mejor.r) mejor = {factor, desfase, r};
		}
	};
	for (let f = op.min; f <= op.max + 1e-12; f += op.pasoGrueso) probar(f, -op.radioDesfaseS, op.radioDesfaseS, 0.01);
	const base = mejor;
	const d0 = base.desfase + base.factor * p0 - cEnP0;
	for (let f = base.factor - op.pasoGrueso; f <= base.factor + op.pasoGrueso + 1e-12; f += op.pasoFino) probar(f, d0 - 0.015, d0 + 0.015, op.pasoFino);
	return {p0, p1, factor: r4(mejor.factor), desfase: r4(mejor.desfase), r: r3(mejor.r)};
}

export interface ResultadoVelocidad {
	/** Mediana ponderada por duración de los tramos con r ≥ rMin; null si no hubo ninguno. */
	factor: number | null;
	n: number;
	/** Tramos probados (con y sin correlación suficiente). */
	probados: number;
	min: number | null;
	max: number | null;
	segundos: number;
	medidas: MedidaVelocidad[];
}

export function resumirVelocidad(medidas: MedidaVelocidad[], rMin: number = OPCIONES_CALIBRACION.velocidad.rMin): ResultadoVelocidad {
	const buenas = medidas.filter((m) => m.r >= rMin);
	const factor = medianaPonderada(buenas.map((m) => ({valor: m.factor, peso: m.p1 - m.p0})));
	return {
		factor: factor === null ? null : r4(factor),
		n: buenas.length,
		probados: medidas.length,
		min: buenas.length ? Math.min(...buenas.map((m) => m.factor)) : null,
		max: buenas.length ? Math.max(...buenas.map((m) => m.factor)) : null,
		segundos: r3(buenas.reduce((s, m) => s + m.p1 - m.p0, 0)),
		medidas,
	};
}

// ───────────────────────── alineación de palabras ─────────────────────────

/** Clave para alinear: la de las tomas (sin acentos ni puntuación, b = v, z = s, sin h muda). */
export const claveAlineacion = (t: string): string => claveDeToma(t);

/**
 * Alinea dos secuencias de claves (crudo `a`, publicado `b`) con huecos afines (Gotoh). Devuelve los pares
 * [i, j] emparejados en orden. Claves vacías nunca empatan. Desempates fijos: emparejar > saltar crudo > saltar publicado.
 */
export function alinearSecuencias(
	a: readonly string[],
	b: readonly string[],
	op: OpcionesCalibracion['alineacion'] = OPCIONES_CALIBRACION.alineacion,
): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	const W = m + 1;
	const NEG = -1e18;
	const M = new Float64Array((n + 1) * W).fill(NEG);
	const X = new Float64Array((n + 1) * W).fill(NEG); // la última operación se saltó una palabra del crudo
	const Y = new Float64Array((n + 1) * W).fill(NEG); // la última operación se saltó una palabra del publicado
	const dM = new Int8Array((n + 1) * W);
	const dX = new Int8Array((n + 1) * W);
	const dY = new Int8Array((n + 1) * W);
	M[0] = 0;
	const mejorDe = (vals: [number, number, number]): [number, number] => {
		let k = 0;
		for (let q = 1; q < 3; q++) if (vals[q] > vals[k] + 1e-12) k = q;
		return [vals[k], k];
	};
	for (let i = 0; i <= n; i++) {
		for (let j = 0; j <= m; j++) {
			const x = i * W + j;
			if (i > 0 && j > 0 && a[i - 1] !== '' && a[i - 1] === b[j - 1]) {
				const y = (i - 1) * W + (j - 1);
				const [v, k] = mejorDe([M[y], X[y], Y[y]]);
				if (v > NEG / 2) {
					M[x] = v + op.acierto;
					dM[x] = k;
				}
			}
			if (i > 0) {
				const y = (i - 1) * W + j;
				const [v, k] = mejorDe([M[y] - op.abrirHueco, X[y] - op.extenderHuecoCrudo, Y[y] - op.abrirHueco]);
				if (v > NEG / 2) {
					X[x] = v;
					dX[x] = k;
				}
			}
			if (j > 0) {
				const y = i * W + (j - 1);
				const [v, k] = mejorDe([M[y] - op.abrirHueco, X[y] - op.abrirHueco, Y[y] - op.extenderHuecoPublicado]);
				if (v > NEG / 2) {
					Y[x] = v;
					dY[x] = k;
				}
			}
		}
	}
	const fin = n * W + m;
	let [, estado] = mejorDe([M[fin], X[fin], Y[fin]]);
	let i = n;
	let j = m;
	const pares: Array<[number, number]> = [];
	while (i > 0 || j > 0) {
		const x = i * W + j;
		if (estado === 0) {
			pares.push([i - 1, j - 1]);
			estado = dM[x];
			i--;
			j--;
		} else if (estado === 1) {
			estado = dX[x];
			i--;
		} else {
			estado = dY[x];
			j--;
		}
	}
	return pares.reverse();
}

// ───────────────────────── reconstrucción de tu edición ─────────────────────────

/** Un lado del par (crudo o publicado) ya listo para comparar. */
export interface Lado {
	slug: string;
	palabras: Palabra[];
	/** Bordes de cada palabra recortados con la energía (cortes.ts → refinarPalabras). */
	limites: Limites[];
	claves: string[];
	energia: AnalisisEnergia;
	env: Envolvente;
	/** Duración útil (s). */
	duracionS: number;
}

export function prepararLado(slug: string, palabras: Palabra[], wav: Wav, duracionS: number, parametros: ParametrosCortes = PARAMETROS_CORTES): Lado {
	const energia = analizarEnergia(wav, palabras, parametros.energia);
	const {limites} = refinarPalabras(energia, palabras);
	return {slug, palabras, limites, claves: palabras.map((p) => claveAlineacion(p.t)), energia, env: envolventeDe(wav), duracionS};
}

/** Bloque de habla emparejado: palabras [i0, i1] del crudo ↔ [j0, j1] del publicado, con su desfase. */
export interface Bloque {
	i0: number;
	i1: number;
	j0: number;
	j1: number;
	/** Tiempo del crudo = factor · tiempo del publicado + desfase. */
	desfase: number;
	/** Correlación de la envolvente con ese desfase (NaN si la ventana era muy corta para medirla). */
	r: number;
	confiable: boolean;
	/** Largo de la ventana del publicado con que se midió (s). */
	ventana: number;
}

export interface Segmento {
	bloques: Bloque[];
	i0: number;
	i1: number;
	j0: number;
	j1: number;
	desfase: number;
}

export type MetodoCorte = 'video' | 'audio' | 'reparto';

export interface CorteSuyo {
	/** Primer cuadro del publicado después del corte (t = cuadro / fps). */
	cuadro: number;
	t_pub: number;
	/** Lo que quitaste del crudo (s del crudo): [desde, hasta). */
	desde: number;
	hasta: number;
	quitado_s: number;
	metodo: MetodoCorte;
	/** Palabras del crudo (posición en palabras[]) que se fueron con este corte. */
	palabras: number[];
	tipo: 'pausa' | 'palabras';
	/** Pausa del crudo entre la última palabra antes y la primera después (bordes por energía), si son seguidas. */
	pausa_crudo_s: number | null;
	/** Silencio que dejaste después de la última palabra y antes de la siguiente (s del crudo). */
	pad_despues_s: number | null;
	pad_antes_s: number | null;
	/** Salto de imagen medido (diferencia del cuadro y cuántas veces sobre sus vecinos), si lo hubo. */
	salto: {dif: number; razon: number} | null;
	/** Diagnóstico: cuadro que habría dado el audio − cuadro del salto de imagen (solo cortes con salto). */
	audio_vs_video_cuadros: number | null;
}

export interface PausaCrudo {
	/** Posición (en palabras[] del crudo) de la palabra antes de la pausa. */
	i: number;
	duracion_s: number;
	cortada: boolean;
	quitado_s: number;
	quedo_s: number;
}

export type TipoQuitada = 'inicio' | 'final' | 'toma-repetida' | 'arranque-en-falso' | 'palabra-suelta' | 'relleno' | 'contenido';

export interface Quitada {
	i0: number;
	i1: number;
	texto: string;
	d: number;
	h: number;
	palabras: number;
	tipo: TipoQuitada;
	/** Para tomas repetidas: el texto que sí quedó y su similitud. */
	por?: string;
	similitud?: number;
}

export interface EdicionSuya {
	velocidad: ResultadoVelocidad;
	/** Factor usado para reconstruir (el medido, o 1 si no se pudo medir). */
	factor: number;
	pares: Array<[number, number]>;
	segmentos: Segmento[];
	/** Tramos del crudo que se quedaron (s del crudo, sin cuantizar: tus cortes van en cuadros del publicado). */
	keep: Tramo[];
	cortes: CorteSuyo[];
	/** Palabras del crudo que quedaron en el publicado. */
	seleccion: boolean[];
	pausas: PausaCrudo[];
	quitadas: Quitada[];
	publicadasSinPar: {palabras: number; texto: string[]};
	/**
	 * Rachas de ≥ 3 palabras seguidas de tu reel sin pareja en el crudo: material de otro clip o tomas usadas en otro
	 * orden (la alineación es monótona y no las puede ubicar). Su tiempo queda dentro del tramo vecino.
	 */
	publicadoSinReconstruir: Array<{desde: number; hasta: number; palabras: number; texto: string}>;
	bloquesDescartados: number;
	duracionPublicadoS: number;
	/** Suma de tus tramos en s del crudo (tu reel sin acelerar). */
	duracionSinAcelerarS: number;
}

export interface EntradaReconstruccion {
	crudo: Lado;
	publicado: Lado;
	/** Diferencia entre cuadros del publicado (difs[k] = cuadro k vs k−1); null si no se midió el video. */
	difs: Float64Array | null;
	fps: number;
	duracionPublicadoS: number;
	opciones?: OpcionesCalibracion;
}

/** Bloques contiguos (índices seguidos en los dos lados) de una lista de pares. */
export function bloquesContiguos(pares: ReadonlyArray<[number, number]>): Array<Array<[number, number]>> {
	const salida: Array<Array<[number, number]>> = [];
	for (const p of pares) {
		const ultimo = salida.at(-1)?.at(-1);
		if (ultimo && p[0] === ultimo[0] + 1 && p[1] === ultimo[1] + 1) salida.at(-1)!.push(p);
		else salida.push([p]);
	}
	return salida;
}

/** Tramos de habla continua para medir la velocidad (ver encabezado, 1a). */
export function tramosContinuos(
	crudo: Pick<Lado, 'limites'>,
	publicado: Pick<Lado, 'limites'>,
	pares: ReadonlyArray<[number, number]>,
	op: OpcionesCalibracion['velocidad'] = OPCIONES_CALIBRACION.velocidad,
): Array<{p0: number; p1: number; cEnP0: number}> {
	const salida: Array<{p0: number; p1: number; cEnP0: number}> = [];
	const C = crudo.limites;
	const P = publicado.limites;
	let actual: Array<[number, number]> = [];
	const cerrar = () => {
		if (actual.length >= op.palabrasMin) {
			const [i0, j0] = actual[0];
			const [, j1] = actual.at(-1)!;
			const p0 = P[j0].d - 0.05;
			const p1 = P[j1].h + 0.05;
			if (p1 - p0 >= op.duracionMinS) salida.push({p0, p1, cEnP0: C[i0].d - 0.05});
		}
		actual = [];
	};
	for (const par of pares) {
		const previo = actual.at(-1);
		const sigue =
			previo &&
			par[0] === previo[0] + 1 &&
			par[1] === previo[1] + 1 &&
			C[par[0]].d - C[previo[0]].h < op.pausaMaxS &&
			P[par[1]].d - P[previo[1]].h < op.pausaMaxS;
		if (!sigue) cerrar();
		actual.push(par);
	}
	cerrar();
	return salida;
}

/** Busca el desfase (tiempo del crudo = factor · t + desfase) que mejor empata [p0, p1] del publicado, cerca de `estimado`. */
export function ajustarDesfase(
	envC: Envolvente,
	envP: Envolvente,
	factor: number,
	p0: number,
	p1: number,
	estimado: number,
	radioS: number = OPCIONES_CALIBRACION.segmentos.radioDesfaseS,
	pasoS: number = OPCIONES_CALIBRACION.segmentos.pasoDesfaseS,
): {desfase: number; r: number} {
	const pub = serie(envP, p0, p1, envP.saltoS);
	let mejor = {desfase: estimado, r: -2};
	for (let d = estimado - radioS; d <= estimado + radioS + 1e-12; d += pasoS) {
		const r = correlacionMapeo(envC, pub, factor, d);
		if (r > mejor.r) mejor = {desfase: d, r};
	}
	return {desfase: r4(mejor.desfase), r: r3(mejor.r)};
}

/**
 * Salto de imagen dentro de [f0, f1]: el cuadro cuya diferencia con el anterior es al menos `razonMin` veces la
 * mediana de sus vecinos (±vecinos, sin él), al menos `difMin` niveles de gris y al menos `razonInmediata` veces sus
 * dos vecinos inmediatos (un corte es un cuadro aislado; un gesto rápido sube y baja en varios cuadros). null si no hay.
 */
export function buscarSalto(
	difs: ArrayLike<number>,
	f0: number,
	f1: number,
	op: Pick<OpcionesCalibracion['saltos'], 'razonMin' | 'difMin' | 'vecinos' | 'razonInmediata'> = OPCIONES_CALIBRACION.saltos,
): {cuadro: number; dif: number; razon: number} | null {
	let mejor: {cuadro: number; dif: number; razon: number} | null = null;
	for (let f = Math.max(1, f0); f <= Math.min(difs.length - 1, f1); f++) {
		const vecinos: number[] = [];
		for (let k = f - op.vecinos; k <= f + op.vecinos; k++) if (k !== f && k >= 1 && k < difs.length) vecinos.push(difs[k]);
		const med = cuantil(vecinos, 0.5) ?? 0;
		const razon = difs[f] / Math.max(med, 0.5);
		const inmediatos = Math.max(difs[f - 1] ?? 0, f + 1 < difs.length ? difs[f + 1] : 0);
		const aislado = difs[f] >= op.razonInmediata * Math.max(inmediatos, 0.5);
		if (difs[f] >= op.difMin && razon >= op.razonMin && aislado && (!mejor || razon > mejor.razon)) mejor = {cuadro: f, dif: r3(difs[f]), razon: r3(razon)};
	}
	return mejor;
}

/**
 * Cuadro del corte por audio: el que mejor explica el hueco del publicado como "antes del corte, el crudo con
 * desfase A; después, con desfase B". Solo se acepta si mejora al peor candidato en ≥ gananciaMinDb por muestra
 * del hueco (en silencio puro los dos lados empatan igual y no se puede decidir).
 */
export function ubicarCortePorAudio(
	envC: Envolvente,
	envP: Envolvente,
	factor: number,
	desfaseA: number,
	desfaseB: number,
	g0: number,
	g1: number,
	fps: number,
	op: Pick<OpcionesCalibracion['audioCorte'], 'margenS' | 'gananciaMinDb'> = OPCIONES_CALIBRACION.audioCorte,
): {cuadro: number; ganancia: number} | null {
	const t0 = g0 - op.margenS;
	const t1 = g1 + op.margenS;
	const pub = serie(envP, t0, t1, envP.saltoS);
	const dA = pub.t.map((t, k) => Math.abs(pub.v[k] - muestrear(envC, factor * t + desfaseA)));
	const dB = pub.t.map((t, k) => Math.abs(pub.v[k] - muestrear(envC, factor * t + desfaseB)));
	const fIni = Math.max(1, Math.floor(g0 * fps) - 1);
	const fFin = Math.ceil(g1 * fps) + 1;
	let mejor: {cuadro: number; costo: number} | null = null;
	let peor = -Infinity;
	for (let f = fIni; f <= fFin; f++) {
		const tc = f / fps;
		let costo = 0;
		pub.t.forEach((t, k) => (costo += t < tc ? dA[k] : dB[k]));
		if (!mejor || costo < mejor.costo) mejor = {cuadro: f, costo};
		peor = Math.max(peor, costo);
	}
	if (!mejor) return null;
	const enHueco = Math.max(1, pub.t.filter((t) => t >= g0 && t <= g1).length);
	const ganancia = (peor - mejor.costo) / enHueco;
	return ganancia >= op.gananciaMinDb ? {cuadro: mejor.cuadro, ganancia: r3(ganancia)} : null;
}

/** ¿El centro de la palabra cae en algún tramo? */
const dentroDeKeep = (keep: readonly Tramo[], d: number, h: number): boolean => {
	const c = (d + h) / 2;
	return keep.some((t) => c >= t.desde && c < t.hasta);
};

const RELLENOS = new Set(['mmm', 'mm', 'em', 'eh', 'ehh', 'ah', 'aja', 'este', 'emm', 'mmmm']);

/** Clasifica las rachas de palabras del crudo que no quedaron (ver Quitada). Pura. */
export function clasificarQuitadas(crudo: Pick<Lado, 'palabras' | 'limites' | 'claves'>, seleccion: readonly boolean[]): Quitada[] {
	const n = seleccion.length;
	const primera = seleccion.indexOf(true);
	const ultima = seleccion.lastIndexOf(true);
	const salida: Quitada[] = [];
	let k = 0;
	while (k < n) {
		if (seleccion[k]) {
			k++;
			continue;
		}
		const i0 = k;
		while (k < n && !seleccion[k]) k++;
		const i1 = k - 1;
		const claves = crudo.claves.slice(i0, i1 + 1).filter(Boolean);
		const texto = crudo.palabras.slice(i0, i1 + 1).map((p) => p.t).join(' ');
		const base = {i0, i1, texto, d: r3(crudo.limites[i0].d), h: r3(crudo.limites[i1].h), palabras: i1 - i0 + 1};
		if (primera < 0 || i1 < primera) {
			salida.push({...base, tipo: 'inicio'});
			continue;
		}
		if (i0 > ultima) {
			salida.push({...base, tipo: 'final'});
			continue;
		}
		// Lo que sí quedó después (hasta 15 s), para buscar la toma buena.
		const despues: number[] = [];
		for (let j = i1 + 1; j < n && crudo.limites[j].d - crudo.limites[i1].h < 15; j++) if (seleccion[j] && crudo.claves[j]) despues.push(j);
		const clavesDespues = despues.map((j) => crudo.claves[j]);
		if (claves.length > 0 && claves.every((c) => RELLENOS.has(c))) {
			salida.push({...base, tipo: 'relleno'});
			continue;
		}
		if (claves.length > 0 && claves.length <= 3 && claves.every((c, x) => clavesDespues[x] === c)) {
			salida.push({...base, tipo: 'arranque-en-falso', por: despues.slice(0, claves.length).map((j) => crudo.palabras[j].t).join(' ')});
			continue;
		}
		if (claves.length >= 2) {
			let mejor = {valor: 0, comunes: 0, desde: 0, largo: 0};
			for (let desde = 0; desde < Math.min(clavesDespues.length, 40); desde++) {
				const largo = Math.min(clavesDespues.length - desde, claves.length + 3);
				const s = similitud(claves, clavesDespues.slice(desde, desde + largo));
				if (s.valor > mejor.valor) mejor = {...s, desde, largo};
			}
			const mismoArranque = claves.length >= 2 && clavesDespues.length >= 2 && claves[0] === clavesDespues[0] && claves[1] === clavesDespues[1];
			if ((mejor.valor >= 0.5 && mejor.comunes >= 2) || mismoArranque) {
				const por = despues.slice(mejor.desde, mejor.desde + mejor.largo).map((j) => crudo.palabras[j].t).join(' ');
				salida.push({...base, tipo: 'toma-repetida', por, similitud: r3(mejor.valor)});
				continue;
			}
		}
		const antes = i0 - 1;
		const sigue = i1 + 1;
		const pegada =
			claves.length <= 2 &&
			antes >= 0 &&
			sigue < n &&
			seleccion[antes] &&
			seleccion[sigue] &&
			crudo.limites[sigue].d - crudo.limites[antes].h < 1.2;
		salida.push({...base, tipo: pegada ? 'palabra-suelta' : 'contenido'});
	}
	return salida;
}

/** Reconstruye tu edición de un par (ver encabezado, paso 1). Pura salvo por el tiempo de cómputo. */
export function reconstruirEdicion(e: EntradaReconstruccion): EdicionSuya {
	const op = e.opciones ?? OPCIONES_CALIBRACION;
	const C = e.crudo;
	const P = e.publicado;
	const fps = e.fps;

	// b. Alineación de palabras.
	let pares = alinearSecuencias(C.claves, P.claves, op.alineacion);

	// a. Velocidad.
	const medidas = tramosContinuos(C, P, pares, op.velocidad).map((t) => medirVelocidadTramo(C.env, P.env, t.p0, t.p1, t.cEnP0, op.velocidad));
	const velocidad = resumirVelocidad(medidas, op.velocidad.rMin);
	const s = velocidad.factor ?? 1;

	// c. Bloques entre pausas, con su desfase fino.
	const os = op.segmentos;
	const armarBloques = (lista: ReadonlyArray<[number, number]>): Bloque[] => {
		const bloques: Bloque[] = [];
		for (const contiguo of bloquesContiguos(lista)) {
			let inicio = 0;
			for (let k = 1; k <= contiguo.length; k++) {
				const corta =
					k === contiguo.length ||
					C.limites[contiguo[k][0]].d - C.limites[contiguo[k - 1][0]].h >= os.pausaSubbloqueS ||
					P.limites[contiguo[k][1]].d - P.limites[contiguo[k - 1][1]].h >= os.pausaSubbloqueS;
				if (!corta) continue;
				const parte = contiguo.slice(inicio, k);
				inicio = k;
				const [i0, j0] = parte[0];
				const [i1, j1] = parte.at(-1)!;
				const estimados = parte.map(([i, j]) => C.limites[i].d - s * P.limites[j].d);
				const estimado = cuantil(estimados, 0.5) ?? 0;
				const p0 = P.limites[j0].d - os.margenS;
				const p1 = P.limites[j1].h + os.margenS;
				const ventana = r3(p1 - p0);
				if (ventana >= os.ventanaMinS) {
					const {desfase, r} = ajustarDesfase(C.env, P.env, s, p0, p1, estimado, os.radioDesfaseS, os.pasoDesfaseS);
					bloques.push({i0, i1, j0, j1, desfase, r, confiable: r >= os.rConfiable, ventana});
				} else {
					bloques.push({i0, i1, j0, j1, desfase: r4(estimado), r: Number.NaN, confiable: false, ventana});
				}
			}
		}
		return bloques;
	};
	const bloques = armarBloques(pares);

	// Descarta bloques que contradicen el orden: entre dos bloques, el crudo no puede tener menos tiempo que el publicado.
	let descartados = 0;
	const puntaje = (b: Bloque) => (Number.isFinite(b.r) ? Math.max(0, b.r) : 0.3) * (b.i1 - b.i0 + 1);
	const descartar = (b: Bloque) => {
		pares = pares.filter(([i, j]) => !(i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1));
		bloques.splice(bloques.indexOf(b), 1);
		descartados++;
	};
	for (let vuelta = 0; vuelta < 1000; vuelta++) {
		let peor: Bloque | null = null;
		for (let k = 0; k + 1 < bloques.length; k++) {
			const quitado = bloques[k + 1].desfase - bloques[k].desfase;
			const inverso = bloques[k + 1].i0 <= bloques[k].i1;
			if (quitado < -os.negativoMaxS || inverso) {
				peor = puntaje(bloques[k]) <= puntaje(bloques[k + 1]) ? bloques[k] : bloques[k + 1];
				break;
			}
		}
		if (!peor) break;
		descartar(peor);
	}

	// Segmentos. Las anclas son los bloques fuertes (correlación ≥ rConfiable en una ventana ≥ ventanaFuerteS): entre
	// dos anclas seguidas hay corte si el desfase sube al menos corteMinimoS (corteMinimoConSaltoS si además hay salto
	// de imagen en el hueco). Un bloque débil se une al grupo vecino de desfase más parecido (a ±debilMaxS); si ninguno
	// se parece y cae entre dos grupos (donde ya hay un corte), forma el suyo; si cae dentro de un grupo, se descarta
	// (es una palabra suelta mal ubicada).
	const fuerte = (b: Bloque) => b.confiable && b.ventana >= os.ventanaFuerteS;
	const saltoEnHueco = (jA: number, jB: number): boolean => {
		if (!e.difs) return false;
		let g0 = P.limites[jA].h;
		let g1 = P.limites[jB].d;
		if (g1 < g0) g0 = g1 = (g0 + g1) / 2;
		return buscarSalto(e.difs, Math.floor(g0 * fps) - op.saltos.margenCuadros, Math.ceil(g1 * fps) + op.saltos.margenCuadros, op.saltos) !== null;
	};
	const pesoDe = (b: Bloque) => b.ventana * Math.max(0.05, Number.isFinite(b.r) ? b.r : 0);
	const desfaseDe = (bs: readonly Bloque[]): number => {
		const fuertes = bs.filter(fuerte);
		const usar = fuertes.length > 0 ? fuertes : bs;
		const w = usar.map(pesoDe);
		return r4(usar.reduce((sum, b, q) => sum + b.desfase * w[q], 0) / w.reduce((x, y) => x + y, 0));
	};
	type Grupo = {bloques: Bloque[]; desfase: number};
	const grupos: Grupo[] = [];
	for (const b of bloques.filter(fuerte)) {
		const g = grupos.at(-1);
		if (g) {
			const minimo = saltoEnHueco(g.bloques.at(-1)!.j1, b.j0) ? os.corteMinimoConSaltoS : os.corteMinimoS;
			if (Math.abs(b.desfase - g.desfase) < minimo) {
				g.bloques.push(b);
				g.desfase = desfaseDe(g.bloques);
				continue;
			}
		}
		grupos.push({bloques: [b], desfase: b.desfase});
	}
	const extremos = (g: Grupo) => ({j0: Math.min(...g.bloques.map((x) => x.j0)), j1: Math.max(...g.bloques.map((x) => x.j1))});
	for (const b of bloques.filter((x) => !fuerte(x))) {
		const dentro = grupos.find((g) => extremos(g).j0 < b.j0 && extremos(g).j1 > b.j1);
		const antes = [...grupos].filter((g) => extremos(g).j1 < b.j0).sort((x, y) => extremos(y).j1 - extremos(x).j1)[0];
		const despues = [...grupos].filter((g) => extremos(g).j0 > b.j1).sort((x, y) => extremos(x).j0 - extremos(y).j0)[0];
		const candidatos = [dentro, antes, despues].filter((g): g is Grupo => g !== undefined).sort((x, y) => Math.abs(x.desfase - b.desfase) - Math.abs(y.desfase - b.desfase));
		const elegido = candidatos[0];
		if (elegido && Math.abs(elegido.desfase - b.desfase) <= os.debilMaxS) {
			elegido.bloques.push(b);
			elegido.desfase = desfaseDe(elegido.bloques);
		} else if (dentro) {
			descartar(b);
		} else {
			grupos.push({bloques: [b], desfase: b.desfase});
		}
	}
	const segmentos: Segmento[] = grupos
		.map((g) => {
			const bs = [...g.bloques].sort((x, y) => x.j0 - y.j0);
			return {bloques: bs, i0: Math.min(...bs.map((x) => x.i0)), i1: Math.max(...bs.map((x) => x.i1)), j0: bs[0].j0, j1: Math.max(...bs.map((x) => x.j1)), desfase: g.desfase};
		})
		.sort((x, y) => x.j0 - y.j0);
	if (segmentos.length === 0) {
		throw fallo('reconstruir tu edición', `no encontré palabras en común entre ${C.slug} y ${P.slug}`, 'revisa que el par de pruebas/pares.json sea el correcto', 2);
	}

	// d. Cuadro de cada corte, siempre creciente: primero el salto de imagen; si no hay, el audio; si tampoco, se
	// reparte el hueco con la proporción mediana de los cortes medidos.
	type CorteCrudo = {k: number; cuadro: number; metodo: MetodoCorte; salto: {dif: number; razon: number} | null; g0: number; g1: number; f0: number; f1: number; audioVsVideo: number | null};
	const cortesCrudos: CorteCrudo[] = [];
	let previo = 0;
	for (let k = 0; k + 1 < segmentos.length; k++) {
		const a = segmentos[k];
		const b = segmentos[k + 1];
		let g0 = P.limites[a.j1].h;
		let g1 = P.limites[b.j0].d;
		if (g1 < g0) g0 = g1 = (g0 + g1) / 2;
		const f0 = Math.max(previo + 1, Math.floor(g0 * fps) - op.saltos.margenCuadros);
		const f1 = Math.max(f0, Math.ceil(g1 * fps) + op.saltos.margenCuadros);
		const salto = e.difs ? buscarSalto(e.difs, f0, f1, op.saltos) : null;
		const audio = ubicarCortePorAudio(C.env, P.env, s, a.desfase, b.desfase, g0, g1, fps, {...op.audioCorte, gananciaMinDb: 0});
		if (salto) {
			cortesCrudos.push({k, cuadro: salto.cuadro, metodo: 'video', salto: {dif: salto.dif, razon: salto.razon}, g0, g1, f0, f1, audioVsVideo: audio ? audio.cuadro - salto.cuadro : null});
		} else if (op.audioCorte.usar && audio && audio.ganancia >= op.audioCorte.gananciaMinDb) {
			cortesCrudos.push({k, cuadro: Math.min(f1, Math.max(f0, audio.cuadro)), metodo: 'audio', salto: null, g0, g1, f0, f1, audioVsVideo: null});
		} else {
			cortesCrudos.push({k, cuadro: -1, metodo: 'reparto', salto: null, g0, g1, f0, f1, audioVsVideo: null});
		}
		if (cortesCrudos.at(-1)!.cuadro >= 0) previo = cortesCrudos.at(-1)!.cuadro;
	}
	const fracciones = cortesCrudos.filter((c) => c.metodo !== 'reparto' && c.g1 - c.g0 > 0.03).map((c) => Math.min(1, Math.max(0, (c.cuadro / fps - c.g0) / (c.g1 - c.g0))));
	const fraccion = cuantil(fracciones, 0.5) ?? 0.5;
	cortesCrudos.forEach((c, q) => {
		if (c.metodo !== 'reparto') return;
		const anterior = q > 0 ? cortesCrudos[q - 1].cuadro : 0;
		const siguiente = cortesCrudos.slice(q + 1).find((x) => x.cuadro >= 0)?.cuadro ?? Number.MAX_SAFE_INTEGER;
		c.cuadro = Math.min(siguiente - 1, Math.max(anterior + 1, Math.round((c.g0 + fraccion * (c.g1 - c.g0)) * fps)));
	});

	// e. Tramos del crudo (s del crudo).
	const aCrudo = (seg: Segmento, t: number) => s * t + seg.desfase;
	const limiteCrudo = C.duracionS;
	const keep: Tramo[] = [];
	segmentos.forEach((seg, k) => {
		const tIni = k === 0 ? 0 : cortesCrudos[k - 1].cuadro / fps;
		const tFin = k === segmentos.length - 1 ? e.duracionPublicadoS : cortesCrudos[k].cuadro / fps;
		const desde = Math.min(limiteCrudo, Math.max(0, aCrudo(seg, tIni)));
		const hasta = Math.min(limiteCrudo, Math.max(desde, aCrudo(seg, tFin)));
		keep.push({desde: r4(desde), hasta: r4(hasta)});
	});
	// Por si un cuadro de corte quedó fuera de su hueco: los tramos nunca se enciman.
	for (let k = 1; k < keep.length; k++) if (keep[k].desde < keep[k - 1].hasta) keep[k].desde = keep[k - 1].hasta;

	const seleccion = C.palabras.map((_, i) => dentroDeKeep(keep, C.limites[i].d, C.limites[i].h));

	const cortes: CorteSuyo[] = cortesCrudos.map((c) => {
		const a = segmentos[c.k];
		const b = segmentos[c.k + 1];
		const desde = keep[c.k].hasta;
		const hasta = keep[c.k + 1].desde;
		const palabras: number[] = [];
		C.limites.forEach((w, i) => {
			const centro = (w.d + w.h) / 2;
			if (centro >= desde && centro < hasta) palabras.push(i);
		});
		const seguidas = b.i0 === a.i1 + 1;
		return {
			cuadro: c.cuadro,
			t_pub: r3(c.cuadro / fps),
			desde: r4(desde),
			hasta: r4(hasta),
			quitado_s: r3(hasta - desde),
			metodo: c.metodo,
			palabras,
			tipo: palabras.length > 0 ? 'palabras' : 'pausa',
			pausa_crudo_s: seguidas ? r3(C.limites[b.i0].d - C.limites[a.i1].h) : null,
			pad_despues_s: r3(desde - C.limites[a.i1].h),
			pad_antes_s: r3(C.limites[b.i0].d - hasta),
			salto: c.salto,
			audio_vs_video_cuadros: c.audioVsVideo,
		};
	});

	// Pausas del crudo entre palabras seguidas que quedaron.
	const pausas: PausaCrudo[] = [];
	const tramoDe = (i: number) => keep.findIndex((t) => (C.limites[i].d + C.limites[i].h) / 2 >= t.desde && (C.limites[i].d + C.limites[i].h) / 2 < t.hasta);
	for (let i = 0; i + 1 < C.palabras.length; i++) {
		if (!seleccion[i] || !seleccion[i + 1]) continue;
		const duracion = C.limites[i + 1].d - C.limites[i].h;
		if (duracion < op.pausas.minimaS) continue;
		const ta = tramoDe(i);
		const tb = tramoDe(i + 1);
		const quitado = ta >= 0 && tb > ta ? keep[tb].desde - keep[ta].hasta : 0;
		pausas.push({i, duracion_s: r3(duracion), cortada: tb > ta, quitado_s: r3(quitado), quedo_s: r3(duracion - quitado)});
	}

	const emparejadasPub = new Set(pares.map(([, j]) => j));
	const sinPar = P.palabras.filter((_, j) => !emparejadasPub.has(j)).map((p) => p.t);
	const sinReconstruir: EdicionSuya['publicadoSinReconstruir'] = [];
	for (let j = 0; j < P.palabras.length; ) {
		if (emparejadasPub.has(j)) {
			j++;
			continue;
		}
		const j0 = j;
		while (j < P.palabras.length && !emparejadasPub.has(j)) j++;
		if (j - j0 >= 3) {
			sinReconstruir.push({desde: r3(P.limites[j0].d), hasta: r3(P.limites[j - 1].h), palabras: j - j0, texto: P.palabras.slice(j0, j).map((w) => w.t).join(' ')});
		}
	}

	return {
		velocidad,
		factor: s,
		pares,
		segmentos,
		keep,
		cortes,
		seleccion,
		pausas,
		quitadas: clasificarQuitadas(C, seleccion),
		publicadasSinPar: {palabras: sinPar.length, texto: sinPar},
		publicadoSinReconstruir: sinReconstruir,
		bloquesDescartados: descartados,
		duracionPublicadoS: e.duracionPublicadoS,
		duracionSinAcelerarS: r3(keep.reduce((sum, t) => sum + (t.hasta - t.desde), 0)),
	};
}

// ───────────────────────── comparación ─────────────────────────

export interface ResultadoF1 {
	precision: number;
	exhaustividad: number;
	f1: number;
	emparejados: number;
	nuestros: number;
	suyos: number;
}

/** F1 de bordes: empareja uno a uno (los más cercanos primero) a ±tolerancia. Sin bordes en ninguno de los dos: 1. */
export function f1Bordes(nuestros: readonly number[], suyos: readonly number[], toleranciaS: number = OPCIONES_CALIBRACION.bordes.toleranciaS): ResultadoF1 {
	const candidatos: Array<[number, number, number]> = [];
	nuestros.forEach((a, x) => suyos.forEach((b, y) => {
		const d = Math.abs(a - b);
		if (d <= toleranciaS + 1e-9) candidatos.push([d, x, y]);
	}));
	candidatos.sort((u, v) => u[0] - v[0] || u[1] - v[1] || u[2] - v[2]);
	const usadoA = new Set<number>();
	const usadoB = new Set<number>();
	for (const [, x, y] of candidatos) {
		if (usadoA.has(x) || usadoB.has(y)) continue;
		usadoA.add(x);
		usadoB.add(y);
	}
	const emparejados = usadoA.size;
	if (nuestros.length === 0 && suyos.length === 0) return {precision: 1, exhaustividad: 1, f1: 1, emparejados: 0, nuestros: 0, suyos: 0};
	const precision = nuestros.length ? emparejados / nuestros.length : 0;
	const exhaustividad = suyos.length ? emparejados / suyos.length : 0;
	const f1 = precision + exhaustividad > 0 ? (2 * precision * exhaustividad) / (precision + exhaustividad) : 0;
	return {precision: r3(precision), exhaustividad: r3(exhaustividad), f1: r3(f1), emparejados, nuestros: nuestros.length, suyos: suyos.length};
}

export const bordesDe = (keep: readonly Tramo[]): number[] => keep.flatMap((t) => [t.desde, t.hasta]);

/** Cortes por minuto: cortes interiores (tramos − 1) por minuto de video. */
export const cortesPorMinuto = (tramos: number, duracionS: number): number => (duracionS > 0 ? r3((Math.max(0, tramos - 1) * 60) / duracionS) : 0);

/**
 * Tramos de keep[] sin ninguna palabra que se queda: voz que whisper no transcribió y que cortes.ts conserva a propósito
 * (nunca corta voz sin palabras que no esté pegada a lo que quitaste). Cuántos son y cuánto duran.
 */
export function tramosSinPalabras(keep: readonly Tramo[], seleccion: readonly boolean[], limites: readonly Limites[]): {n: number; segundos: number} {
	const vacios = keep.filter((t) => !limites.some((w, i) => seleccion[i] && (w.d + w.h) / 2 >= t.desde && (w.d + w.h) / 2 < t.hasta));
	return {n: vacios.length, segundos: r3(vacios.reduce((s, t) => s + (t.hasta - t.desde), 0))};
}

/** Umbral de pausa que mejor separa las que cortaste de las que dejaste ("se corta si dura más que esto"). */
export function umbralDePausas(pausas: ReadonlyArray<Pick<PausaCrudo, 'duracion_s' | 'cortada'>>): {umbral_s: number | null; exactitud: number | null; n: number; cortadas: number} {
	const n = pausas.length;
	const cortadas = pausas.filter((p) => p.cortada).length;
	if (n === 0) return {umbral_s: null, exactitud: null, n, cortadas};
	const candidatos = [...new Set(pausas.map((p) => p.duracion_s))].sort((a, b) => a - b);
	let mejor = {umbral: candidatos.at(-1)!, aciertos: -1};
	// Umbral entre dos pausas consecutivas: la regla es "duración > umbral".
	const puntos = [0, ...candidatos.map((c, k) => (k + 1 < candidatos.length ? (c + candidatos[k + 1]) / 2 : c))];
	for (const u of puntos) {
		const aciertos = pausas.filter((p) => (p.duracion_s > u) === p.cortada).length;
		if (aciertos > mejor.aciertos) mejor = {umbral: u, aciertos};
	}
	return {umbral_s: r3(mejor.umbral), exactitud: r3(mejor.aciertos / n), n, cortadas};
}

// ───────────────────────── simulación de nuestros cortes ─────────────────────────

/** Selección de la propuesta automática (cortes.ts): las frases que lib/tomas.ts no descarta. */
export function seleccionPropuesta(crudo: Pick<Lado, 'palabras' | 'limites'>, tomas: Partial<OpcionesTomas> = OPCIONES_TOMAS): boolean[] {
	const {frases} = detectarTomas(
		crudo.palabras.map((w, j) => ({t: w.t, d: crudo.limites[j].d, h: crudo.limites[j].h})),
		tomas,
	);
	const seleccion = new Array<boolean>(crudo.palabras.length).fill(false);
	for (const f of frases) if (!f.descartada) for (let j = f.i0; j <= f.i1; j++) seleccion[j] = true;
	return seleccion;
}

export interface Simulacion {
	keep: Tramo[];
	duracionS: number;
	cortes: number;
}

/** Corre construirKeep (cortes.ts) sobre el crudo con unos parámetros y una selección de palabras. */
export function simularCortes(crudo: Lado, parametros: ParametrosCortes, seleccion: readonly boolean[]): Simulacion {
	const r = construirKeep({limites: crudo.limites, seleccion, energia: crudo.energia, limiteS: crudo.duracionS, parametros});
	return {keep: r.keep, duracionS: r3(duracionBase(r.keep)), cortes: r.keep.length - 1};
}

/** Lo que hace falta de cada par para calibrar (sin video ni rutas). */
export interface DatosPar {
	par: string;
	crudo: Lado;
	suya: EdicionSuya;
}

export interface ValoresRejilla {
	huecoMinimoS: number[];
	padAntesS: number[];
	padDespuesS: number[];
}

export const REJILLA: Readonly<ValoresRejilla> = Object.freeze({
	huecoMinimoS: [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8],
	padAntesS: [0.02, 0.04, 0.06, 0.08, 0.1, 0.12],
	padDespuesS: [0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15],
});

export interface Combinacion {
	huecoMinimoS: number;
	padAntesS: number;
	padDespuesS: number;
	por_par: Array<{par: string; duracion_s: number; error_duracion: number; f1: number; cortes: number}>;
	f1_medio: number;
	error_medio_abs: number;
	error_max_abs: number;
	/** 0: todos los pares a ±5 % · 1: a ±15 % · 2: alguno fuera de ±15 %. */
	nivel: 0 | 1 | 2;
}

/** Evalúa una combinación de parámetros con TU selección de palabras (la duración se compara sin acelerar). */
export function evaluarCombinacion(pares: readonly DatosPar[], base: ParametrosCortes, valores: Pick<Combinacion, 'huecoMinimoS' | 'padAntesS' | 'padDespuesS'>): Combinacion {
	const parametros: ParametrosCortes = {...base, ...valores};
	const por_par = pares.map((d) => {
		const sim = simularCortes(d.crudo, parametros, d.suya.seleccion);
		const objetivo = d.suya.duracionSinAcelerarS;
		return {
			par: d.par,
			duracion_s: sim.duracionS,
			error_duracion: r4((sim.duracionS - objetivo) / objetivo),
			f1: f1Bordes(bordesDe(sim.keep), bordesDe(d.suya.keep)).f1,
			cortes: sim.cortes,
		};
	});
	const errores = por_par.map((p) => Math.abs(p.error_duracion));
	const maxErr = Math.max(...errores);
	return {
		...valores,
		por_par,
		f1_medio: r3(por_par.reduce((s, p) => s + p.f1, 0) / por_par.length),
		error_medio_abs: r4(errores.reduce((s, x) => s + x, 0) / errores.length),
		error_max_abs: r4(maxErr),
		nivel: maxErr <= 0.05 ? 0 : maxErr <= 0.15 ? 1 : 2,
	};
}

/** Valores de referencia para desempatar: los pads que mediste en tus cortes (o los de por defecto) y el hueco por defecto. */
export interface ReferenciaRejilla {
	huecoMinimoS: number;
	padAntesS: number;
	padDespuesS: number;
}

/**
 * Orden de la rejilla: nivel (meta ±5 % en todos los pares; si ninguna, ±15 %), luego el mejor F1 medio de bordes.
 * Empates (F1 a ±0.02 y error de duración a ±0.5 puntos): gana la más cercana a la referencia (tus pads medidos):
 * si los datos no distinguen dos valores, no se aleja de lo que se midió directamente.
 */
export function elegirMejor(combinaciones: readonly Combinacion[], referencia: ReferenciaRejilla = PARAMETROS_CORTES): Combinacion {
	const nivel = Math.min(...combinaciones.map((c) => c.nivel));
	const candidatos = combinaciones.filter((c) => c.nivel === nivel);
	const mejorF1 = Math.max(...candidatos.map((c) => c.f1_medio));
	const porF1 = candidatos.filter((c) => c.f1_medio >= mejorF1 - 0.02 - 1e-9);
	const menorError = Math.min(...porF1.map((c) => c.error_medio_abs));
	const empatados = porF1.filter((c) => c.error_medio_abs <= menorError + 0.005 + 1e-9);
	const distancia = (c: Combinacion) =>
		Math.abs(c.padAntesS - referencia.padAntesS) + Math.abs(c.padDespuesS - referencia.padDespuesS) + Math.abs(c.huecoMinimoS - referencia.huecoMinimoS);
	return [...empatados].sort((a, b) => distancia(a) - distancia(b) || b.f1_medio - a.f1_medio || a.error_medio_abs - b.error_medio_abs || a.huecoMinimoS - b.huecoMinimoS)[0];
}

export function buscarParametros(
	pares: readonly DatosPar[],
	rejilla: ValoresRejilla = REJILLA,
	base: ParametrosCortes = PARAMETROS_CORTES,
	referencia: ReferenciaRejilla = base,
): {mejor: Combinacion; todas: Combinacion[]} {
	const todas: Combinacion[] = [];
	for (const huecoMinimoS of rejilla.huecoMinimoS) {
		for (const padAntesS of rejilla.padAntesS) {
			for (const padDespuesS of rejilla.padDespuesS) todas.push(evaluarCombinacion(pares, base, {huecoMinimoS, padAntesS, padDespuesS}));
		}
	}
	return {mejor: elegirMejor(todas, referencia), todas};
}

// ───────────────────────── regla de tomas ─────────────────────────

export interface ValoresTomas {
	similitudMinima: number[];
	cercaniaS: number[];
	pausaFraseS: number[];
	arranquePalabras: number[];
}

export const REJILLA_TOMAS: Readonly<ValoresTomas> = Object.freeze({
	similitudMinima: [0.5, 0.6, 0.7],
	cercaniaS: [10, 20, 30],
	pausaFraseS: [0.4, 0.6, 0.8],
	arranquePalabras: [2, 3],
});

export interface EvaluacionTomas {
	tomas: Partial<OpcionesTomas>;
	/** Palabras que quitamos los dos / solo nosotros / solo tú (todas las de los pares juntas). */
	ambos: number;
	solo_nuestras: number;
	solo_tuyas: number;
	precision: number;
	exhaustividad: number;
	f1: number;
	/** Lo mismo por par (F1 y palabras que quitaríamos y tú dejaste). */
	por_par: Array<{par: string; f1: number; solo_nuestras: number}>;
}

function prf(ambos: number, soloNuestras: number, soloTuyas: number): {precision: number; exhaustividad: number; f1: number} {
	const precision = ambos + soloNuestras > 0 ? ambos / (ambos + soloNuestras) : 0;
	const exhaustividad = ambos + soloTuyas > 0 ? ambos / (ambos + soloTuyas) : 0;
	const f1 = precision + exhaustividad > 0 ? (2 * precision * exhaustividad) / (precision + exhaustividad) : 0;
	return {precision: r3(precision), exhaustividad: r3(exhaustividad), f1: r3(f1)};
}

/** Compara lo que quita la propuesta automática con lo que quitaste tú, palabra por palabra. */
export function evaluarTomas(pares: readonly DatosPar[], tomas: Partial<OpcionesTomas>): EvaluacionTomas {
	let ambos = 0;
	let soloNuestras = 0;
	let soloTuyas = 0;
	const por_par: EvaluacionTomas['por_par'] = [];
	for (const d of pares) {
		const nuestra = seleccionPropuesta(d.crudo, {...OPCIONES_TOMAS, ...tomas});
		let a = 0;
		let n = 0;
		let t = 0;
		d.suya.seleccion.forEach((suya, i) => {
			const quitoEl = !suya;
			const quitamos = !nuestra[i];
			if (quitoEl && quitamos) a++;
			else if (quitamos) n++;
			else if (quitoEl) t++;
		});
		ambos += a;
		soloNuestras += n;
		soloTuyas += t;
		por_par.push({par: d.par, f1: prf(a, n, t).f1, solo_nuestras: n});
	}
	return {tomas, ambos, solo_nuestras: soloNuestras, solo_tuyas: soloTuyas, ...prf(ambos, soloNuestras, soloTuyas), por_par};
}

/**
 * Rejilla de la regla de tomas. Solo cuentan las reglas con precisión ≥ precisionMinima (casi nunca quitan algo que tú
 * dejaste: eso es peor que dejar una toma que luego quitas al aprobar el texto) y que mejoran el F1 en al menos
 * `paresMinimos` pares (una mejora que sale de un solo par puede ser casualidad). Entre esas gana el mejor F1; si
 * empatan (±0.01), la que quita menos palabras que tú dejaste. Si ninguna supera a la de por defecto, se queda esa.
 */
export function buscarTomas(
	pares: readonly DatosPar[],
	rejilla: ValoresTomas = REJILLA_TOMAS,
	precisionMinima = 0.95,
	paresMinimos = 2,
): {mejor: EvaluacionTomas; porDefecto: EvaluacionTomas; mejorSinFiltro: EvaluacionTomas; todas: EvaluacionTomas[]} {
	const todas: EvaluacionTomas[] = [];
	for (const similitudMinima of rejilla.similitudMinima) {
		for (const cercaniaS of rejilla.cercaniaS) {
			for (const pausaFraseS of rejilla.pausaFraseS) {
				for (const arranquePalabras of rejilla.arranquePalabras) todas.push(evaluarTomas(pares, {similitudMinima, cercaniaS, pausaFraseS, arranquePalabras}));
			}
		}
	}
	const porDefecto = evaluarTomas(pares, {});
	const elegir = (lista: EvaluacionTomas[]) => {
		const mejorF1 = Math.max(...lista.map((t) => t.f1));
		return [...lista.filter((t) => t.f1 >= mejorF1 - 0.01 - 1e-9)].sort((a, b) => a.solo_nuestras - b.solo_nuestras || b.f1 - a.f1)[0];
	};
	const mejoraEn = (t: EvaluacionTomas) => t.por_par.filter((x, k) => x.f1 > porDefecto.por_par[k].f1 + 1e-9).length;
	const aceptables = [porDefecto, ...todas.filter((t) => t.precision >= precisionMinima && mejoraEn(t) >= Math.min(paresMinimos, pares.length))];
	const mejor = elegir(aceptables);
	return {mejor: mejor.f1 > porDefecto.f1 + 0.01 ? mejor : porDefecto, porDefecto, mejorSinFiltro: elegir([porDefecto, ...todas]), todas};
}

/** Solo las opciones de tomas que cambian respecto a las de por defecto. */
export function tomasDistintas(tomas: Partial<OpcionesTomas>): Partial<OpcionesTomas> {
	const salida: Record<string, number> = {};
	for (const [k, v] of Object.entries(tomas)) if (v !== undefined && v !== (OPCIONES_TOMAS as unknown as Record<string, number>)[k]) salida[k] = v as number;
	return salida as Partial<OpcionesTomas>;
}

// ───────────────────────── archivos (solo lectura de tus originales) ─────────────────────────

/** Diferencia media (niveles de gris 0–255) entre cada cuadro y el anterior, en la franja de la cabeza. */
export function difsDeVideo(ruta: string, op: OpcionesCalibracion['saltos'] = OPCIONES_CALIBRACION.saltos): Float64Array {
	const W = op.ancho;
	const H = op.alto;
	const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', ruta, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], {maxBuffer: 2 * 1024 * 1024 * 1024});
	if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw fallo('medir los saltos de imagen', 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú)', 2);
	if (r.status !== 0) throw fallo('medir los saltos de imagen', `ffmpeg salió con código ${r.status ?? r.signal} con ${basename(ruta)}`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {stderr: r.stderr?.toString().slice(-2000)});
	const buf = r.stdout as Buffer;
	const tam = W * H;
	const n = Math.floor(buf.length / tam);
	const y0 = Math.floor(op.region[0] * H);
	const y1 = Math.floor(op.region[1] * H);
	const difs = new Float64Array(n);
	for (let k = 1; k < n; k++) {
		let suma = 0;
		const a = k * tam;
		const b = (k - 1) * tam;
		for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) suma += Math.abs(buf[a + y * W + x] - buf[b + y * W + x]);
		difs[k] = suma / ((y1 - y0) * W);
	}
	return difs;
}

/** Slugs de los proyectos de calibración de un par. */
export function slugsDelPar(crudo: string, shortCode: string): {crudo: string; publicado: string} {
	const nombre = basename(crudo, extname(crudo))
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const corto = shortCode.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
	return {crudo: `_cal-${nombre}`, publicado: `_cal-pub-${corto}`};
}

export interface ParAceptado {
	crudo: string;
	shortCode: string;
	publicado_mp4: string;
}

/** Ruta para los mensajes: relativa a la raíz si queda dentro, absoluta si no. */
const paraMostrar = (ruta: string): string => {
	const r = relative(RAIZ, ruta);
	return r.startsWith('..') ? ruta : r;
};

export function leerParesAceptados(ruta = join(RAIZ, 'pruebas', 'pares.json')): ParAceptado[] {
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer los pares crudo ↔ publicado', `no pude leer ${paraMostrar(ruta)}`, 'corre npx tsx herramientas/emparejar.ts', 2);
	}
	if (!Array.isArray(datos)) throw fallo('leer los pares crudo ↔ publicado', `${paraMostrar(ruta)} no es una lista`, 'vuelve a correr npx tsx herramientas/emparejar.ts', 2);
	return datos
		.filter((p): p is ParAceptado & {aceptado: boolean} => typeof p === 'object' && p !== null && (p as {aceptado?: unknown}).aceptado === true && typeof (p as {publicado_mp4?: unknown}).publicado_mp4 === 'string')
		.map((p) => ({crudo: p.crudo, shortCode: p.shortCode, publicado_mp4: p.publicado_mp4}));
}

/** Carga un lado desde su proyecto de calibración (transcripcion.json + audio16k.wav + manifest). */
export function cargarLado(slug: string, proyectos = DIR_PROYECTOS): Lado & {fps: number; original: string | null} {
	const dir = dirProyecto(slug, proyectos);
	const rutaT = join(dir, 'transcripcion.json');
	if (!existsSync(rutaT)) {
		throw fallo('calibrar los cortes', `falta proyectos/${slug}/transcripcion.json`, 'corre primero npx tsx pruebas/integracion/f6-calibrar.ts (hace la ingesta y la transcripción de cada par)', 2);
	}
	const palabras = leerTranscripcion(rutaT);
	const wav = leerWav(join(dir, 'audio16k.wav'), 16000);
	const duracion = limiteDelCrudo(slug, proyectos, wav);
	const manifest = leerManifest(slug, proyectos) as {original?: {ruta?: string}; sondeo?: {video?: {fpsNominal?: number}}} | null;
	const fps = manifest?.sondeo?.video?.fpsNominal ?? FPS;
	return {...prepararLado(slug, palabras, wav, duracion), fps: Number.isFinite(fps) && fps > 0 ? fps : FPS, original: manifest?.original?.ruta ?? null};
}

// ───────────────────────── imágenes para revisar a ojo ─────────────────────────

const escaparXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG de la línea de tiempo del crudo: tus tramos contra los nuestros. Pura. */
export function svgLineaDeTiempo(
	titulo: string,
	duracionCrudoS: number,
	filas: ReadonlyArray<{etiqueta: string; tramos: readonly Tramo[]; color: string}>,
	palabras: ReadonlyArray<{d: number; h: number; quedo: boolean}>,
): string {
	const W = 1800;
	const izq = 230;
	const der = 20;
	const alto = 34;
	const H = 70 + (filas.length + 1) * (alto + 14) + 40;
	const x = (t: number) => izq + (t / Math.max(duracionCrudoS, 1e-6)) * (W - izq - der);
	const partes: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`,
		`<rect width="${W}" height="${H}" fill="#151515"/>`,
		`<text x="16" y="34" font-size="22" fill="#ffffff">${escaparXml(titulo)}</text>`,
	];
	const yVoz = 60;
	partes.push(`<text x="16" y="${yVoz + 22}" font-size="16" fill="#cfcfcf">palabras del crudo</text>`);
	for (const p of palabras) {
		partes.push(`<rect x="${x(p.d).toFixed(1)}" y="${yVoz + 6}" width="${Math.max(1, x(p.h) - x(p.d)).toFixed(1)}" height="${alto - 12}" fill="${p.quedo ? '#9a9a9a' : '#d9534f'}"/>`);
	}
	filas.forEach((f, k) => {
		const y = yVoz + (k + 1) * (alto + 14);
		partes.push(`<text x="16" y="${y + 22}" font-size="16" fill="#cfcfcf">${escaparXml(f.etiqueta)}</text>`);
		partes.push(`<rect x="${izq}" y="${y}" width="${W - izq - der}" height="${alto}" fill="#262626"/>`);
		for (const t of f.tramos) partes.push(`<rect x="${x(t.desde).toFixed(1)}" y="${y}" width="${Math.max(1, x(t.hasta) - x(t.desde)).toFixed(1)}" height="${alto}" fill="${f.color}"/>`);
	});
	const yEje = yVoz + (filas.length + 1) * (alto + 14) + 6;
	for (let t = 0; t <= duracionCrudoS + 1e-9; t += 5) {
		partes.push(`<line x1="${x(t).toFixed(1)}" y1="${yEje}" x2="${x(t).toFixed(1)}" y2="${yEje + 8}" stroke="#888"/>`);
		partes.push(`<text x="${x(t).toFixed(1)}" y="${yEje + 26}" font-size="13" fill="#aaa" text-anchor="middle">${t} s</text>`);
	}
	partes.push('</svg>');
	return partes.join('');
}

/** SVG con miniaturas en rejilla (base64) y su etiqueta. Pura. */
export function svgMiniaturas(titulo: string, celdas: ReadonlyArray<{jpegBase64: string; etiqueta: string}>, columnas = 8, ancho = 180, alto = 320): string {
	const margen = 10;
	const etiqueta = 40;
	const encabezado = 50;
	const filas = Math.max(1, Math.ceil(celdas.length / columnas));
	const W = columnas * (ancho + margen) + margen;
	const H = encabezado + filas * (alto + etiqueta + margen) + margen;
	const partes = [
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`,
		`<rect width="${W}" height="${H}" fill="#151515"/>`,
		`<text x="${margen}" y="34" font-size="22" fill="#ffffff">${escaparXml(titulo)}</text>`,
	];
	celdas.forEach((c, i) => {
		const x = margen + (i % columnas) * (ancho + margen);
		const y = encabezado + margen + Math.floor(i / columnas) * (alto + etiqueta + margen);
		partes.push(`<image x="${x}" y="${y}" width="${ancho}" height="${alto}" xlink:href="data:image/jpeg;base64,${c.jpegBase64}"/>`);
		const [l1, l2] = c.etiqueta.split('\n');
		partes.push(`<text x="${x + ancho / 2}" y="${y + alto + 17}" font-size="14" text-anchor="middle" fill="#f2f2f2">${escaparXml(l1 ?? '')}</text>`);
		if (l2) partes.push(`<text x="${x + ancho / 2}" y="${y + alto + 34}" font-size="13" text-anchor="middle" fill="#bdbdbd">${escaparXml(l2)}</text>`);
	});
	partes.push('</svg>');
	return partes.join('');
}

async function svgAPng(svg: string, ruta: string): Promise<void> {
	const {Resvg} = await import('@resvg/resvg-js');
	const png = new Resvg(svg, {font: {loadSystemFonts: true, defaultFontFamily: 'Helvetica'}}).render().asPng();
	writeFileSync(ruta, png);
}

/** Miniaturas JPEG (base64) de unos cuadros de un video, en orden de `cuadros` (tandas de 40 por el límite del parser de ffmpeg). */
function miniaturas(video: string, cuadros: readonly number[], dirTrabajo: string, ancho = 180, alto = 320): Map<number, string> {
	const salida = new Map<number, string>();
	const unicos = [...new Set(cuadros)].sort((a, b) => a - b);
	mkdirSync(dirTrabajo, {recursive: true});
	for (let inicio = 0; inicio < unicos.length; inicio += 40) {
		const tanda = unicos.slice(inicio, inicio + 40);
		const prefijo = join(dirTrabajo, `m${String(inicio).padStart(4, '0')}-`);
		const expr = tanda.map((c) => `eq(n\\,${c})`).join('+');
		const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select='${expr}',scale=${ancho}:${alto}`, '-fps_mode', 'passthrough', '-q:v', '4', `${prefijo}%04d.jpg`], {encoding: 'utf8'});
		if (r.status !== 0) continue;
		tanda.forEach((c, k) => {
			const ruta = `${prefijo}${String(k + 1).padStart(4, '0')}.jpg`;
			if (existsSync(ruta)) salida.set(c, readFileSync(ruta).toString('base64'));
		});
	}
	rmSync(dirTrabajo, {recursive: true, force: true});
	return salida;
}

// ───────────────────────── etapa completa ─────────────────────────

export interface ResultadoPar {
	par: string;
	crudo: string;
	publicado: string;
	shortCode: string;
	slugs: {crudo: string; publicado: string};
	datos: DatosPar;
	video: boolean;
	/** Cuadros por segundo del publicado. */
	fps: number;
}

export interface OpcionesEtapa {
	pares?: string;
	salida?: string;
	detalle?: string;
	proyectos?: string;
	video?: boolean;
	imagenes?: boolean;
	avisar?: (m: string) => void;
}

/** Corre la calibración completa (ver encabezado) y escribe los archivos. Devuelve el objeto de calibracion-cortes.json. */
export async function calibrarCortes(op: OpcionesEtapa = {}): Promise<{calibracion: Record<string, unknown>; detalle: Record<string, unknown>; archivos: string[]}> {
	const t0 = performance.now();
	const avisar = op.avisar ?? ((m: string) => console.error(m));
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const rutaPares = op.pares ?? join(RAIZ, 'pruebas', 'pares.json');
	const salida = op.salida ?? join(RAIZ, 'estilo', 'calibracion-cortes.json');
	const dirDetalle = op.detalle ?? join(RAIZ, 'out', 'f6-calibracion');
	mkdirSync(dirDetalle, {recursive: true});
	const aceptados = leerParesAceptados(rutaPares);
	if (aceptados.length === 0) throw fallo('calibrar los cortes', `${paraMostrar(rutaPares)} no trae ningún par aceptado con su mp4 publicado`, 'corre npx tsx herramientas/emparejar.ts o dame un par a mano', 2);

	// 1. Reconstrucción de tu edición por par.
	const resultados: ResultadoPar[] = [];
	for (const p of aceptados) {
		const slugs = slugsDelPar(p.crudo, p.shortCode);
		const nombre = basename(p.crudo, extname(p.crudo));
		avisar(`Par ${nombre} → ${p.shortCode}: reconstruyendo tu edición…`);
		const crudo = cargarLado(slugs.crudo, proyectos);
		const publicado = cargarLado(slugs.publicado, proyectos);
		if (!existsSync(p.publicado_mp4)) throw fallo('calibrar los cortes', `no encuentro tu reel publicado ${p.publicado_mp4}`, 'revisa que el archivo siga en su lugar (solo se lee)', 2);
		const difs = op.video === false ? null : difsDeVideo(p.publicado_mp4);
		const duracionPublicadoS = publicado.duracionS;
		const suya = reconstruirEdicion({crudo, publicado, difs, fps: publicado.fps, duracionPublicadoS});
		resultados.push({par: `${nombre}→${p.shortCode}`, crudo: p.crudo, publicado: p.publicado_mp4, shortCode: p.shortCode, slugs, datos: {par: `${nombre}→${p.shortCode}`, crudo, suya}, video: difs !== null, fps: publicado.fps});
		avisar(
			`  velocidad ${suya.velocidad.factor ?? 'N/A'} (n=${suya.velocidad.n}) · ${suya.segmentos.length} tramos, ${suya.cortes.length} cortes (${suya.cortes.filter((c) => c.metodo === 'video').length} por salto de imagen) · ` +
				`${suya.duracionSinAcelerarS.toFixed(2)} s sin acelerar → ${duracionPublicadoS.toFixed(2)} s publicado`,
		);
	}
	const datos = resultados.map((r) => r.datos);

	// Pads y pausas de todos los pares (solo cortes con cuadro medido por imagen o audio).
	const visibles = resultados.flatMap((r) => r.datos.suya.cortes.filter((c) => c.metodo !== 'reparto'));
	const deVideo = resultados.flatMap((r) => r.datos.suya.cortes.filter((c) => c.metodo === 'video'));
	const resumenPads = (xs: Array<number | null>) => {
		const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
		return {p25: cuantil(v, 0.25) === null ? null : r3(cuantil(v, 0.25)!), p50: cuantil(v, 0.5) === null ? null : r3(cuantil(v, 0.5)!), p75: cuantil(v, 0.75) === null ? null : r3(cuantil(v, 0.75)!), n: v.length};
	};
	const padsDePausa = visibles.filter((c) => c.tipo === 'pausa');
	// 2. Rejilla de pausas y pads (con tu selección de palabras) y regla de tomas. Para desempatar se usan los pads que
	//    mediste en tus cortes de pausa (si hay al menos 5); si no, los de por defecto.
	const padAntesMedido = cuantil(padsDePausa.map((c) => c.pad_antes_s).filter((x): x is number => x !== null), 0.5);
	const padDespuesMedido = cuantil(padsDePausa.map((c) => c.pad_despues_s).filter((x): x is number => x !== null), 0.5);
	const referencia: ReferenciaRejilla =
		padsDePausa.length >= 5 && padAntesMedido !== null && padDespuesMedido !== null
			? {huecoMinimoS: PARAMETROS_CORTES.huecoMinimoS, padAntesS: padAntesMedido, padDespuesS: padDespuesMedido}
			: PARAMETROS_CORTES;
	avisar(`Rejilla: ${REJILLA.huecoMinimoS.length * REJILLA.padAntesS.length * REJILLA.padDespuesS.length} combinaciones × ${datos.length} pares…`);
	const {mejor, todas} = buscarParametros(datos, REJILLA, PARAMETROS_CORTES, referencia);
	const tomas = buscarTomas(datos);
	const tomasCalibradas = tomasDistintas(tomas.mejor.tomas);
	const parametrosCalibrados: ParametrosCortes = {
		...PARAMETROS_CORTES,
		huecoMinimoS: mejor.huecoMinimoS,
		padAntesS: mejor.padAntesS,
		padDespuesS: mejor.padDespuesS,
		tomas: {...OPCIONES_TOMAS, ...tomasCalibradas},
	};

	// 3. Antes y después por par. "antes" = valores por defecto, "después" = calibrados, los dos con TU selección de
	//    palabras (como si aprobaras el texto que publicaste); aparte, lo mismo con la propuesta automática.
	const porPar = resultados.map((r) => {
		const {crudo, suya} = r.datos;
		const antes = simularCortes(crudo, PARAMETROS_CORTES, suya.seleccion);
		const despues = simularCortes(crudo, parametrosCalibrados, suya.seleccion);
		const propuestaAntes = simularCortes(crudo, PARAMETROS_CORTES, seleccionPropuesta(crudo, PARAMETROS_CORTES.tomas));
		const propuestaDespues = simularCortes(crudo, parametrosCalibrados, seleccionPropuesta(crudo, parametrosCalibrados.tomas));
		const bordesSuyos = bordesDe(suya.keep);
		const factor = suya.velocidad.factor;
		const pub = suya.duracionPublicadoS;
		const sinAcelerar = suya.duracionSinAcelerarS;
		const visibles = suya.cortes.filter((c) => c.metodo !== 'reparto');
		const cpmPub = cortesPorMinuto(suya.segmentos.length, pub);
		const cpmSinAcelerar = cortesPorMinuto(suya.segmentos.length, sinAcelerar);
		const cpmAntes = cortesPorMinuto(antes.keep.length, antes.duracionS);
		const cpmDespues = cortesPorMinuto(despues.keep.length, despues.duracionS);
		const relativo = (nuestro: number, suyo: number) => (suyo > 0 ? r4((nuestro - suyo) / suyo) : nuestro === 0 ? 0 : null);
		const errores = {
			duracion_sin_acelerar: {antes: relativo(antes.duracionS, sinAcelerar), despues: relativo(despues.duracionS, sinAcelerar)},
			duracion_tal_cual: {antes: relativo(antes.duracionS, pub), despues: relativo(despues.duracionS, pub)},
			...(factor ? {duracion_con_su_velocidad: {antes: relativo(antes.duracionS / factor, pub), despues: relativo(despues.duracionS / factor, pub)}} : {}),
			cortes_por_min_sin_acelerar: {antes: relativo(cpmAntes, cpmSinAcelerar), despues: relativo(cpmDespues, cpmSinAcelerar)},
			cortes_por_min_tal_cual: {antes: relativo(cpmAntes, cpmPub), despues: relativo(cpmDespues, cpmPub)},
			nota:
				'fracción (nuestro − tuyo) / tuyo. "sin_acelerar": contra tus mismos cortes en s del crudo (sin la velocidad); "tal_cual": contra tu reel publicado (que va acelerado); ' +
				'"con_su_velocidad": como si base.ts aplicara tu factor. null = tú no hiciste ningún corte y nosotros sí',
		};
		const dentro = (x: number | null | undefined, tol: number) => x !== null && x !== undefined && Math.abs(x) <= tol + 1e-9;
		return {
			par: r.par,
			crudo: r.crudo,
			publicado: r.publicado,
			duracion_crudo: r3(crudo.duracionS),
			duracion_publicado: r3(pub),
			duracion_publicado_sin_acelerar: sinAcelerar,
			duracion_nuestra_antes: antes.duracionS,
			duracion_nuestra_despues: despues.duracionS,
			f1_bordes: f1Bordes(bordesDe(despues.keep), bordesSuyos).f1,
			f1_bordes_antes: f1Bordes(bordesDe(antes.keep), bordesSuyos).f1,
			cortes_por_min_publicado: cpmPub,
			cortes_por_min_publicado_sin_acelerar: cpmSinAcelerar,
			cortes_por_min_nuestros: cpmDespues,
			cortes_por_min_nuestros_antes: cpmAntes,
			velocidad: {
				factor,
				n: suya.velocidad.n,
				probados: suya.velocidad.probados,
				min: suya.velocidad.min,
				max: suya.velocidad.max,
				segundos_medidos: suya.velocidad.segundos,
				fuente: 'correlación de la envolvente de energía (10 ms cada 5 ms) en tramos de habla continua; factor = tiempo del crudo / tiempo del publicado; solo tramos con r ≥ 0.8',
			},
			errores,
			criterios: {
				nota: 'con los parámetros calibrados y tu selección de palabras',
				duracion_15_sin_acelerar: dentro(errores.duracion_sin_acelerar.despues, 0.15),
				duracion_5_sin_acelerar: dentro(errores.duracion_sin_acelerar.despues, 0.05),
				duracion_15_tal_cual: dentro(errores.duracion_tal_cual.despues, 0.15),
				cortes_por_min_15_sin_acelerar: dentro(errores.cortes_por_min_sin_acelerar.despues, 0.15),
				cortes_por_min_15_tal_cual: dentro(errores.cortes_por_min_tal_cual.despues, 0.15),
			},
			propuesta_automatica: {
				nota: 'sin tu aprobación: la propuesta de cortes.ts (tomas repetidas) en vez de tu texto',
				duracion_antes: propuestaAntes.duracionS,
				duracion_despues: propuestaDespues.duracionS,
				error_duracion_sin_acelerar: {antes: relativo(propuestaAntes.duracionS, sinAcelerar), despues: relativo(propuestaDespues.duracionS, sinAcelerar)},
				f1_bordes: {antes: f1Bordes(bordesDe(propuestaAntes.keep), bordesSuyos).f1, despues: f1Bordes(bordesDe(propuestaDespues.keep), bordesSuyos).f1},
				cortes_por_min: {antes: cortesPorMinuto(propuestaAntes.keep.length, propuestaAntes.duracionS), despues: cortesPorMinuto(propuestaDespues.keep.length, propuestaDespues.duracionS)},
			},
			tramos_sin_palabras: tramosSinPalabras(despues.keep, suya.seleccion, crudo.limites),
			cortes_suyos: {
				total: suya.cortes.length,
				por_metodo: {video: suya.cortes.filter((c) => c.metodo === 'video').length, audio: suya.cortes.filter((c) => c.metodo === 'audio').length, reparto: suya.cortes.filter((c) => c.metodo === 'reparto').length},
				de_pausa: suya.cortes.filter((c) => c.tipo === 'pausa').length,
				con_palabras: suya.cortes.filter((c) => c.tipo === 'palabras').length,
				pads_medidos: visibles.length,
			},
			cortes_nuestros: {antes: antes.cortes, despues: despues.cortes},
			pausas: {...umbralDePausas(suya.pausas), lista: suya.pausas},
			quitadas: suya.quitadas.map((q) => ({...q})),
			palabras: {crudo: crudo.palabras.length, quedaron: suya.seleccion.filter(Boolean).length, publicado_sin_par: suya.publicadasSinPar.palabras},
			publicado_sin_reconstruir: {
				nota: 'rachas de ≥ 3 palabras de tu reel sin pareja en el crudo (otro clip o tomas en otro orden): su tiempo queda dentro del tramo vecino y sus bordes no se pueden comparar',
				segundos: r3(suya.publicadoSinReconstruir.reduce((s, x) => s + (x.hasta - x.desde), 0)),
				rachas: suya.publicadoSinReconstruir,
			},
		};
	});

	const todasLasPausas = resultados.flatMap((r) => r.datos.suya.pausas);
	const factores = resultados.map((r) => r.datos.suya.velocidad.factor).filter((x): x is number => x !== null);
	const velocidadGlobal = {
		por_par: resultados.map((r) => ({par: r.par, factor: r.datos.suya.velocidad.factor, n: r.datos.suya.velocidad.n})),
		mediana: factores.length ? r4(cuantil(factores, 0.5)!) : null,
		min: factores.length ? Math.min(...factores) : null,
		max: factores.length ? Math.max(...factores) : null,
		n_pares: factores.length,
		n_tramos: resultados.reduce((s, r) => s + r.datos.suya.velocidad.n, 0),
		consistente: factores.length > 0 && factores.every((f) => f > 1.03),
		nota: 'No se aplica aquí: base.ts es de otra pieza. Va en necesita_de_otros con el factor.',
	};

	const huellaPares = createHash('sha256').update(readFileSync(rutaPares)).digest('hex');
	const calibracion: Record<string, unknown> = {
		version: 1,
		generado: new Date().toISOString(),
		parametros: {
			huecoMinimoS: mejor.huecoMinimoS,
			padAntesS: mejor.padAntesS,
			padDespuesS: mejor.padDespuesS,
			...(Object.keys(tomasCalibradas).length > 0 ? {tomas: tomasCalibradas} : {}),
		},
		por_defecto: {huecoMinimoS: PARAMETROS_CORTES.huecoMinimoS, padAntesS: PARAMETROS_CORTES.padAntesS, padDespuesS: PARAMETROS_CORTES.padDespuesS, tomas: {...OPCIONES_TOMAS}},
		n_pares: porPar.length,
		por_par: porPar.map(({pausas, quitadas, ...resto}) => ({
			...resto,
			pausas: {umbral_s: pausas.umbral_s, exactitud: pausas.exactitud, n: pausas.n, cortadas: pausas.cortadas},
			quitadas: {
				rachas: quitadas.length,
				palabras: quitadas.reduce((s, q) => s + q.palabras, 0),
				por_tipo: quitadas.reduce<Record<string, number>>((m, q) => ({...m, [q.tipo]: (m[q.tipo] ?? 0) + q.palabras}), {}),
			},
		})),
		velocidad: velocidadGlobal,
		pausas: {
			...umbralDePausas(todasLasPausas),
			nota: 'pausas entre dos palabras seguidas que quedaron, con bordes por energía; "cortada" = hay un corte entre ellas en tu reel',
		},
		pads: {
			despues_s: resumenPads(padsDePausa.map((c) => c.pad_despues_s)),
			antes_s: resumenPads(padsDePausa.map((c) => c.pad_antes_s)),
			todos_los_cortes: {despues_s: resumenPads(visibles.map((c) => c.pad_despues_s)), antes_s: resumenPads(visibles.map((c) => c.pad_antes_s))},
			solo_salto_de_imagen: {
				despues_s: resumenPads(padsDePausa.filter((c) => c.metodo === 'video').map((c) => c.pad_despues_s)),
				antes_s: resumenPads(padsDePausa.filter((c) => c.metodo === 'video').map((c) => c.pad_antes_s)),
				suma_s: resumenPads(padsDePausa.filter((c) => c.metodo === 'video').map((c) => (c.pad_despues_s === null || c.pad_antes_s === null ? null : r3(c.pad_despues_s + c.pad_antes_s)))),
			},
			n_cortes_por_video: deVideo.length,
			audio_vs_video_cuadros: (() => {
				const v = deVideo.map((c) => c.audio_vs_video_cuadros).filter((x): x is number => x !== null);
				return {p50: cuantil(v, 0.5), dentro_de_1: v.filter((x) => Math.abs(x) <= 1).length, n: v.length};
			})(),
			nota:
				'segundos del crudo entre el borde de la palabra (energía) y tu corte; solo cortes con cuadro medido (salto de imagen o audio). ' +
				'El reparto entre "antes" y "después" depende de la sincronía audio-video del mp4 publicado (medida contra el crudo por movimiento de la cabeza: entre −25 y +25 ms, sin signo fijo); la suma de los dos es robusta',
		},
		rejilla: {
			valores: REJILLA,
			probadas: todas.length,
			criterio:
				'todos los pares a ±5 % (si ninguna, ±15 %) con tu selección de palabras; el mejor F1 de bordes a ±100 ms; si empatan (F1 ±0.02 y error de duración ±0.5 puntos), la más cercana a los pads que mediste en tus cortes',
			referencia_desempate: referencia,
			elegida: mejor,
			mejores: [...todas].sort((a, b) => a.nivel - b.nivel || b.f1_medio - a.f1_medio || a.error_medio_abs - b.error_medio_abs).slice(0, 10),
			por_defecto: evaluarCombinacion(datos, PARAMETROS_CORTES, {huecoMinimoS: PARAMETROS_CORTES.huecoMinimoS, padAntesS: PARAMETROS_CORTES.padAntesS, padDespuesS: PARAMETROS_CORTES.padDespuesS}),
		},
		tomas: {
			valores: REJILLA_TOMAS,
			criterio:
				'precisión ≥ 0.95 (casi nunca quitar algo que tú dejaste) y mejora del F1 en al menos 2 pares; luego el mejor F1; si ninguna supera a la de por defecto por más de 0.01, se queda la de por defecto',
			elegida: tomas.mejor,
			por_defecto: tomas.porDefecto,
			mejor_sin_filtro: tomas.mejorSinFiltro,
			nota: 'F1 por palabra entre lo que quita la propuesta automática y lo que quitaste tú (incluye lo que quitaste por contenido, que la propuesta no puede adivinar)',
		},
		fuente:
			`pruebas/pares.json (sha256 ${huellaPares.slice(0, 12)}…): ${porPar.length} pares aceptados (${resultados.map((r) => r.par).join(', ')}); ` +
			'transcripción whisper large-v3 (transcribir.ts) de crudo y publicado; cuadros de tus mp4 publicados (solo lectura)',
		metodo:
			'alineación de palabras crudo↔publicado (programación dinámica con huecos afines) + desfase fino por correlación de la envolvente de energía + ' +
			'saltos de imagen en la zona de la cabeza para ubicar cada corte; rejilla de cortes.ts (construirKeep) con tu selección de palabras',
		opciones: OPCIONES_CALIBRACION,
		segundos: r3((performance.now() - t0) / 1000),
	};

	const detalle: Record<string, unknown> = {
		generado: calibracion.generado,
		pares: resultados.map((r, k) => ({
			par: r.par,
			slugs: r.slugs,
			velocidad: r.datos.suya.velocidad,
			segmentos: r.datos.suya.segmentos.map((s) => ({i0: s.i0, i1: s.i1, j0: s.j0, j1: s.j1, desfase: s.desfase, bloques: s.bloques.length, texto: r.datos.crudo.palabras.slice(s.i0, s.i1 + 1).map((w) => w.t).join(' ').slice(0, 120)})),
			keep_suyo: r.datos.suya.keep,
			cortes: r.datos.suya.cortes.map((c) => ({...c, palabras: c.palabras.map((i) => r.datos.crudo.palabras[i].t).join(' ')})),
			pausas: porPar[k].pausas,
			quitadas: porPar[k].quitadas,
			publicado_sin_par: r.datos.suya.publicadasSinPar,
			bloques_descartados: r.datos.suya.bloquesDescartados,
		})),
		rejilla: todas,
		tomas: tomas.todas,
	};

	const archivos: string[] = [];
	const escribir = (ruta: string, contenido: string) => {
		const temporal = `${ruta}.tmp-${process.pid}`;
		writeFileSync(temporal, contenido);
		renameSync(temporal, ruta);
		archivos.push(ruta);
	};
	mkdirSync(join(salida, '..'), {recursive: true});
	escribir(salida, `${JSON.stringify(calibracion, null, '\t')}\n`);
	escribir(join(dirDetalle, 'detalle.json'), `${JSON.stringify(detalle, null, '\t')}\n`);

	// Imágenes para revisar a ojo: línea de tiempo por par y hoja de saltos de imagen.
	if (op.imagenes !== false) {
		for (const r of resultados) {
			const {crudo, suya} = r.datos;
			const antes = simularCortes(crudo, PARAMETROS_CORTES, suya.seleccion);
			const conSuTexto = simularCortes(crudo, parametrosCalibrados, suya.seleccion);
			const despues = simularCortes(crudo, parametrosCalibrados, seleccionPropuesta(crudo, parametrosCalibrados.tomas));
			const nombre = r.slugs.crudo.replace(/^_cal-/, '');
			const svg = svgLineaDeTiempo(
				`${r.par} · crudo ${crudo.duracionS.toFixed(1)} s · tu reel ${suya.duracionPublicadoS.toFixed(1)} s a ×${suya.velocidad.factor ?? 'N/A'} (${suya.duracionSinAcelerarS.toFixed(1)} s sin acelerar)`,
				crudo.duracionS,
				[
					{etiqueta: `tu edición (${suya.keep.length} tramos)`, tramos: suya.keep, color: '#2fbf71'},
					{etiqueta: `calibrado + tu texto (${conSuTexto.keep.length})`, tramos: conSuTexto.keep, color: '#3d8bfd'},
					{etiqueta: `por defecto + tu texto (${antes.keep.length})`, tramos: antes.keep, color: '#8a8a8a'},
					{etiqueta: `calibrado + propuesta (${despues.keep.length})`, tramos: despues.keep, color: '#9b6bff'},
				],
				crudo.limites.map((l, i) => ({d: l.d, h: l.h, quedo: suya.seleccion[i]})),
			);
			const rutaLinea = join(dirDetalle, `linea-${nombre}.png`);
			await svgAPng(svg, rutaLinea);
			archivos.push(rutaLinea);

			const conCuadro = suya.cortes.filter((c) => c.metodo === 'video').slice(0, 32);
			if (conCuadro.length > 0 && existsSync(r.publicado)) {
				const minis = miniaturas(r.publicado, conCuadro.flatMap((c) => [c.cuadro - 1, c.cuadro]), join(dirDetalle, `.minis-${nombre}`));
				const celdas = conCuadro.flatMap((c) => {
					const antesTxt = crudo.palabras[segmentoDeCorte(suya, c, 'antes')]?.t ?? '';
					const despuesTxt = crudo.palabras[segmentoDeCorte(suya, c, 'despues')]?.t ?? '';
					return [
						{jpegBase64: minis.get(c.cuadro - 1) ?? '', etiqueta: `c${c.cuadro - 1} · ${((c.cuadro - 1) / r.fps).toFixed(2)} s\n«${antesTxt}» antes`},
						{jpegBase64: minis.get(c.cuadro) ?? '', etiqueta: `c${c.cuadro} salto ×${c.salto?.razon ?? '?'}\n«${despuesTxt}» quitó ${c.quitado_s.toFixed(2)} s`},
					];
				}).filter((x) => x.jpegBase64 !== '');
				const rutaSaltos = join(dirDetalle, `saltos-${nombre}.png`);
				await svgAPng(svgMiniaturas(`${r.par} · cuadro antes y después de cada corte (salto de imagen)`, celdas, 8), rutaSaltos);
				archivos.push(rutaSaltos);
			}
		}
	}
	return {calibracion, detalle, archivos};
}

/** Palabra del crudo justo antes o después de un corte (para las etiquetas de la hoja). */
function segmentoDeCorte(suya: EdicionSuya, corte: CorteSuyo, lado: 'antes' | 'despues'): number {
	const k = suya.cortes.indexOf(corte);
	if (k < 0) return -1;
	return lado === 'antes' ? suya.segmentos[k].i1 : suya.segmentos[k + 1].i0;
}

export function resumenCalibracion(c: Record<string, unknown>): string {
	const p = c.parametros as {huecoMinimoS: number; padAntesS: number; padDespuesS: number; tomas?: Record<string, number>};
	const d = c.por_defecto as {huecoMinimoS: number; padAntesS: number; padDespuesS: number};
	const v = c.velocidad as {mediana: number | null; min: number | null; max: number | null; n_tramos: number; consistente: boolean};
	const pares = c.por_par as Array<{
		par: string;
		duracion_publicado: number;
		duracion_publicado_sin_acelerar: number;
		duracion_nuestra_antes: number;
		duracion_nuestra_despues: number;
		f1_bordes: number;
		f1_bordes_antes: number;
		velocidad: {factor: number | null; n: number};
		propuesta_automatica: {duracion_despues: number; f1_bordes: {despues: number}};
	}>;
	const lineas = [
		`Calibración de cortes lista (${c.n_pares} pares):`,
		`  huecoMinimoS ${d.huecoMinimoS} → ${p.huecoMinimoS} s · padAntesS ${d.padAntesS} → ${p.padAntesS} s · padDespuesS ${d.padDespuesS} → ${p.padDespuesS} s${p.tomas ? ` · tomas ${JSON.stringify(p.tomas)}` : ''}`,
		`  Velocidad de tus reels: mediana ×${v.mediana ?? 'N/A'} (de ×${v.min ?? '?'} a ×${v.max ?? '?'}, ${v.n_tramos} tramos medidos)${v.consistente ? ' → la aceleras siempre (no se aplica aquí: es de base.ts)' : ''}.`,
	];
	for (const x of pares) {
		lineas.push(
			`  ${x.par}: publicado ${x.duracion_publicado.toFixed(1)} s (×${x.velocidad.factor ?? 'N/A'}, n=${x.velocidad.n}; ${x.duracion_publicado_sin_acelerar.toFixed(1)} s sin acelerar) · ` +
				`con tu texto: base ${x.duracion_nuestra_antes.toFixed(1)} → ${x.duracion_nuestra_despues.toFixed(1)} s, F1 bordes ${x.f1_bordes_antes} → ${x.f1_bordes} · ` +
				`propuesta automática: ${x.propuesta_automatica.duracion_despues.toFixed(1)} s, F1 ${x.propuesta_automatica.f1_bordes.despues}`,
		);
	}
	return lineas.join('\n');
}

async function main(): Promise<void> {
	let valores;
	try {
		({values: valores} = parseArgs({
			options: {
				pares: {type: 'string'},
				salida: {type: 'string'},
				detalle: {type: 'string'},
				'sin-video': {type: 'boolean', default: false},
				'sin-imagenes': {type: 'boolean', default: false},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		throw fallo('leer los argumentos', error instanceof Error ? error.message.split('\n')[0] : 'no entendí los argumentos', `usa ${USO}`, 2);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	const {calibracion, archivos} = await calibrarCortes({
		pares: valores.pares ? resolve(valores.pares) : undefined,
		salida: valores.salida ? resolve(valores.salida) : undefined,
		detalle: valores.detalle ? resolve(valores.detalle) : undefined,
		video: !valores['sin-video'],
		imagenes: !valores['sin-imagenes'],
	});
	console.log(resumenCalibracion(calibracion));
	console.log(`Archivos: ${archivos.map(paraMostrar).join(', ')}`);
}

if (esPrincipal(import.meta.url)) void correr(main);

