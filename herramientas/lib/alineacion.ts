/**
 * Alineación forzada (CTC) del texto de la transcripción contra el audio.
 *
 * Llama a herramientas/alinear.py con el .venv del proyecto (ctc-forced-aligner 1.0.2 + el modelo de
 * Hugging Face que elijas, todo local y gratis) y devuelve las palabras con el MISMO índice `i` de la
 * transcripción. Si una palabra no se alinea, se marca (`alineada: false`, con `motivo`) y conserva el
 * tiempo de Whisper que trae la entrada.
 *
 * Una palabra "no se alinea" cuando:
 * - no tiene letras del vocabulario del modelo (p. ej. solo puntuación), o
 * - el alineador la mandó lejos: score < scoreMinimo (el modelo casi no oye esas letras ahí) Y su inicio
 *   queda a más de maxDesvioS del de Whisper. Por defecto 0.01 y 0.3 s: en las 841 palabras de los
 *   fixtures, el p99 de |alineador − Whisper| es 0.25 s (sin usar la verdad de la compuerta), y una palabra
 *   que el modelo no oye y además se aleja más que eso es un salto (pasa con muletillas que Whisper escribió
 *   como "y").
 *
 * Después se garantiza el orden: los inicios no retroceden (una palabra de respaldo se acomoda entre sus
 * vecinas) y cada fin queda entre su inicio + 20 ms y el inicio de la siguiente, como en transcribir.ts.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fallo, type CodigoFallo} from './fallo';
import {pythonVenv} from './plataforma';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(RAIZ, 'herramientas', 'alinear.py');

export const MODELO_MMS = 'MahmoudAshraf/mms-300m-1130-forced-aligner';
export const MODELO_XLSR_ES = 'jonatasgrosman/wav2vec2-large-xlsr-53-spanish';

/** Respaldo por defecto: ver el encabezado. */
export const SCORE_MINIMO = 0.01;
export const MAX_DESVIO_S = 0.3;

/** Palabra de la transcripción (como en transcripcion.json): tiempos de Whisper en segundos. */
export interface PalabraEntrada {
	i: number;
	t: string;
	d: number;
	h: number;
}

/** Lo que alinear.py escribe por palabra (mismo orden que el texto). */
export interface PalabraAlineador {
	i: number;
	t: string;
	d: number | null;
	h: number | null;
	score: number | null;
	alineada: boolean;
	fichas: string;
}

export interface SalidaAlineador {
	modelo: string;
	origen_pesos: string;
	motor: string;
	dispositivo: string;
	idioma: string;
	romanizar: boolean;
	normalizar_audio: boolean;
	ventana_s: number;
	contexto_s: number;
	paso_s: number;
	convencion_tiempo: string;
	duracion_s: number;
	n_palabras: number;
	alineadas: number;
	tiempos_s: {carga: number; emisiones: number; alineacion: number; total: number};
	versiones: Record<string, string>;
	palabras: PalabraAlineador[];
}

export interface PalabraAlineada {
	/** Índice original de la transcripción. */
	i: number;
	t: string;
	/** Inicio final (s): del alineador (− k) o, si no se alineó, el de Whisper. */
	d: number;
	h: number;
	/** Score del alineador (0–1); null si la palabra no tiene letras alineables. */
	score: number | null;
	alineada: boolean;
	fuente: 'alineacion' | 'whisper';
	/** Por qué se quedó con Whisper (solo si alineada = false). */
	motivo?: string;
	/** Inicio crudo del alineador (s, sin k), o null. */
	dAlineador: number | null;
	/** Inicio de Whisper (s) que llegó en la entrada. */
	dWhisper: number;
}

export interface OpcionesAlineacion {
	/** Id de Hugging Face del modelo CTC (por defecto, MMS forced aligner). */
	modelo?: string;
	/** ISO 639-3; "spa" pasa los números a letras en español. */
	idioma?: string;
	motor?: 'auto' | 'onnx' | 'torch';
	romanizar?: 'auto' | 'si' | 'no';
	dispositivo?: 'auto' | 'cpu' | 'mps';
	normalizar?: 'auto' | 'si' | 'no';
	lote?: number;
	/** Corrección (ms) que se resta a los tiempos del alineador (la k de estilo/calibracion-alineacion.json). */
	kMs?: number;
	scoreMinimo?: number;
	maxDesvioS?: number;
	/** Carpeta donde quedan el .txt y el .json crudo del alineador. Sin ella se usa una temporal que se borra. */
	dirTrabajo?: string;
	/** Nombre base de esos archivos (por defecto "alineacion"). */
	nombre?: string;
	/** Python del .venv (por defecto el de lib/plataforma.ts → pythonVenv, o EDITOR_PYTHON). */
	python?: string;
	timeoutMs?: number;
	/** Avisos de progreso (por defecto, ninguno). */
	avisar?: (mensaje: string) => void;
}

export interface ResultadoAlineacion {
	palabras: PalabraAlineada[];
	/** Metadatos del alineador (modelo, motor, versiones, tiempos internos…), sin las palabras. */
	alineador: Omit<SalidaAlineador, 'palabras'>;
	/** Cuántas palabras se quedaron con el tiempo de Whisper. */
	sinAlinear: number;
	/** Tiempo de pared de la llamada (s): arranque de Python, carga del modelo, emisiones y Viterbi. */
	tiempoS: number;
	/** Ruta del JSON crudo del alineador si se pidió dirTrabajo; null si fue temporal. */
	rutaJson: string | null;
}

export function rutaPython(): string {
	return pythonVenv({raiz: RAIZ});
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Convierte el error de una línea de alinear.py ("No pude alinear: X. Siguiente paso: Y.") en un FalloEditor. */
function falloDePython(stderr: string, codigo: number | null): Error {
	const lineas = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
	const ultima = [...lineas].reverse().find((l) => l.startsWith('No pude alinear:')) ?? lineas.at(-1) ?? '';
	const m = /^No pude alinear: (.*)\. Siguiente paso: (.*?)\.?$/su.exec(ultima);
	const cod: CodigoFallo = codigo === 2 || codigo === 3 ? codigo : 1;
	if (m) return fallo('alinear', m[1], m[2], cod, {stderr: stderr.slice(-4000)});
	return fallo('alinear', `alinear.py salió con código ${codigo ?? 'desconocido'}`, 'revisa proyectos/_logs/fallos.log y avísame', cod, {stderr: stderr.slice(-4000)});
}

/** Lee y valida el JSON de alinear.py contra las palabras que se le mandaron. */
function leerSalida(rutaJson: string, esperadas: number): SalidaAlineador {
	let datos: SalidaAlineador;
	try {
		datos = JSON.parse(readFileSync(rutaJson, 'utf8')) as SalidaAlineador;
	} catch {
		throw fallo('alinear', `alinear.py no dejó un JSON legible en ${rutaJson}`, 'vuelve a correr; si se repite, avísame', 1);
	}
	if (!Array.isArray(datos.palabras) || datos.palabras.length !== esperadas) {
		throw fallo('alinear', `alinear.py devolvió ${datos.palabras?.length ?? 0} palabras y se mandaron ${esperadas}`, 'avísame: el texto y la salida no cuadran', 1);
	}
	datos.palabras.forEach((p, j) => {
		if (p.i !== j) throw fallo('alinear', `la palabra ${j} de alinear.py trae i = ${p.i}`, 'avísame: el orden de la salida no cuadra', 1);
	});
	return datos;
}

/**
 * Junta lo del alineador con la transcripción: conserva `i`, aplica k, decide el respaldo de Whisper
 * y garantiza el orden de inicios y fines. Pura (sin E/S) para poder probarla aparte.
 */
export function combinar(
	entrada: PalabraEntrada[],
	alineadas: PalabraAlineador[],
	opciones: {kMs?: number; scoreMinimo?: number; maxDesvioS?: number} = {},
): PalabraAlineada[] {
	const k = (opciones.kMs ?? 0) / 1000;
	const scoreMinimo = opciones.scoreMinimo ?? SCORE_MINIMO;
	const maxDesvioS = opciones.maxDesvioS ?? MAX_DESVIO_S;
	const salida: PalabraAlineada[] = entrada.map((w, j) => {
		const a = alineadas[j];
		const respaldo = (motivo: string): PalabraAlineada => ({
			i: w.i,
			t: w.t,
			d: w.d,
			h: w.h,
			score: a?.score ?? null,
			alineada: false,
			fuente: 'whisper',
			motivo,
			dAlineador: a?.d ?? null,
			dWhisper: w.d,
		});
		if (!a || !a.alineada || a.d === null || a.h === null) return respaldo('sin letras alineables');
		const d = a.d - k;
		const desvio = d - w.d;
		if ((a.score ?? 0) < scoreMinimo && Math.abs(desvio) > maxDesvioS) {
			return respaldo(`salto: score ${a.score} y ${desvio > 0 ? '+' : ''}${desvio.toFixed(2)} s respecto a Whisper`);
		}
		return {i: w.i, t: w.t, d, h: a.h - k, score: a.score, alineada: true, fuente: 'alineacion', dAlineador: a.d, dWhisper: w.d};
	});

	// Una palabra de respaldo no puede pasar a la siguiente palabra alineada.
	let siguienteAlineada = Infinity;
	for (let j = salida.length - 1; j >= 0; j--) {
		if (salida[j].alineada) siguienteAlineada = salida[j].d;
		else salida[j].d = Math.min(salida[j].d, siguienteAlineada);
	}
	// Los inicios no retroceden (el Viterbi ya es monótono; esto cubre los respaldos).
	for (let j = 0; j < salida.length; j++) {
		salida[j].d = Math.max(0, j > 0 ? Math.max(salida[j].d, salida[j - 1].d) : salida[j].d);
	}
	// Fin: al menos 20 ms después del inicio y nunca después del inicio de la siguiente.
	for (let j = 0; j < salida.length; j++) {
		const siguiente = salida[j + 1]?.d ?? Infinity;
		let h = Math.max(salida[j].h, salida[j].d + 0.02);
		if (h > siguiente) h = Math.max(salida[j].d, siguiente);
		salida[j].d = r3(salida[j].d);
		salida[j].h = r3(h);
	}
	return salida;
}

/**
 * Alinea las palabras de la transcripción contra el WAV (16 kHz mono, el audio16k.wav de la ingesta).
 * Lanza un FalloEditor con una frase en español si algo falla (2: entrada/instalación, 3: descarga).
 */
export function alinear(wav: string, palabras: PalabraEntrada[], opciones: OpcionesAlineacion = {}): ResultadoAlineacion {
	if (!existsSync(wav)) throw fallo('alinear', `no existe el audio ${wav}`, 'corre primero la ingesta del proyecto', 2);
	if (palabras.length === 0) throw fallo('alinear', 'la transcripción no trae palabras', 'corre primero transcribir.ts', 2);
	palabras.forEach((p, j) => {
		if (!Number.isFinite(p.d) || !Number.isFinite(p.h)) {
			throw fallo('alinear', `la palabra ${j} ("${p.t}") no trae tiempos de Whisper`, 'vuelve a correr transcribir.ts', 2);
		}
	});
	const python = opciones.python ?? rutaPython();
	if (!existsSync(python)) {
		throw fallo(
			'alinear',
			`no existe ${python}`,
			`crea el .venv (uv venv .venv --python 3.12) e instala ctc-forced-aligner==1.0.2 unidecode==1.4.0 (y torch==2.14.1 transformers==5.18.0 para modelos que no son MMS) con uv pip install --python ${python}`,
			2,
		);
	}
	const modelo = opciones.modelo ?? MODELO_MMS;
	const temporal = opciones.dirTrabajo ? null : mkdtempSync(join(tmpdir(), 'alinear-'));
	const dir = opciones.dirTrabajo ?? (temporal as string);
	mkdirSync(dir, {recursive: true});
	const nombre = opciones.nombre ?? 'alineacion';
	const rutaTexto = join(dir, `${nombre}.txt`);
	const rutaJson = join(dir, `${nombre}.json`);
	try {
		// Una palabra por línea y sin espacios internos: alinear.py separa por espacios y debe ver las mismas N.
		writeFileSync(rutaTexto, `${palabras.map((p) => p.t.replace(/\s+/gu, '') || '_').join('\n')}\n`);
		const args = [SCRIPT, '--audio', wav, '--texto', rutaTexto, '--idioma', opciones.idioma ?? 'spa', '--modelo', modelo, '--salida', rutaJson];
		if (opciones.motor) args.push('--motor', opciones.motor);
		if (opciones.romanizar) args.push('--romanizar', opciones.romanizar);
		if (opciones.dispositivo) args.push('--dispositivo', opciones.dispositivo);
		if (opciones.normalizar) args.push('--normalizar', opciones.normalizar);
		if (opciones.lote !== undefined) args.push('--lote', String(opciones.lote));
		opciones.avisar?.(`Alineando ${palabras.length} palabras con ${modelo}…`);
		const inicio = performance.now();
		const r = spawnSync(python, args, {encoding: 'utf8', timeout: opciones.timeoutMs ?? 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024});
		const tiempoS = (performance.now() - inicio) / 1000;
		if (r.error) {
			const codigo = (r.error as NodeJS.ErrnoException).code;
			if (codigo === 'ETIMEDOUT') {
				throw fallo('alinear', `alinear.py tardó más de ${Math.round((opciones.timeoutMs ?? 1_800_000) / 60_000)} min`, 'prueba con --dispositivo mps o un audio más corto', 1);
			}
			throw fallo('alinear', `no pude ejecutar ${python} (${codigo ?? r.error.message})`, 'revisa que el .venv exista y funcione', 2);
		}
		if (r.status !== 0) throw falloDePython(r.stderr ?? '', r.status);
		const crudo = leerSalida(rutaJson, palabras.length);
		opciones.avisar?.((r.stdout ?? '').trim());
		const combinadas = combinar(palabras, crudo.palabras, opciones);
		const {palabras: _descartar, ...alineador} = crudo;
		return {
			palabras: combinadas,
			alineador,
			sinAlinear: combinadas.filter((p) => !p.alineada).length,
			tiempoS,
			rutaJson: temporal ? null : rutaJson,
		};
	} finally {
		if (temporal) rmSync(temporal, {recursive: true, force: true});
	}
}

export interface CalibracionAlineacion {
	modelo: string;
	motor: string;
	k_ms: number;
	pasa: boolean;
	fuente: string;
}

/** Lee el modelo y la k elegidos por la compuerta (estilo/calibracion-alineacion.json), o null si no existe. */
export function leerCalibracionAlineacion(ruta = join(RAIZ, 'estilo', 'calibracion-alineacion.json')): CalibracionAlineacion | null {
	if (!existsSync(ruta)) return null;
	let datos: {modelo?: unknown; motor?: unknown; k_ms?: unknown; pasa?: unknown};
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer la calibración de alineación', 'estilo/calibracion-alineacion.json no es un JSON válido', 'déjalo con la forma {"modelo": texto, "k_ms": número} (el de la plantilla trae los valores por defecto) y revísalo con npx tsx herramientas/doctor.ts', 2);
	}
	if (typeof datos.modelo !== 'string' || typeof datos.k_ms !== 'number' || !Number.isFinite(datos.k_ms)) {
		throw fallo('leer la calibración de alineación', 'estilo/calibracion-alineacion.json no trae modelo y k_ms', 'déjalo con la forma {"modelo": texto, "k_ms": número} (el de la plantilla trae los valores por defecto) y revísalo con npx tsx herramientas/doctor.ts', 2);
	}
	return {
		modelo: datos.modelo,
		motor: typeof datos.motor === 'string' ? datos.motor : 'auto',
		k_ms: datos.k_ms,
		pasa: datos.pasa === true,
		fuente: 'estilo/calibracion-alineacion.json',
	};
}
