// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * transcribir.ts <slug> — Etapa 2 de /editar: transcripción por palabra con tiempos confiables.
 *
 * Uso (desde la raíz):  npx tsx herramientas/transcribir.ts <slug> [--forzar]
 *
 * (a) Tramos de voz: whisper-vad-speech-segments (silero) sobre proyectos/<slug>/audio16k.wav.
 *     Se unen los tramos separados por < 0.3 s y se les agrega 0.2 s de margen → tramos.json.
 * (b) Cada tramo se recorta del WAV (exacto a la muestra) y se transcribe aparte con whisper-cli
 *     (large-v3, DTW, -sns, el vocabulario como prompt), SIN --vad: con --vad, -ojf deja los
 *     tiempos por palabra en una línea de tiempo sin silencios.
 * (c) Se parsea el -ojf como bytes (ver lib/whisper-json.ts) y se suma el inicio del tramo.
 * (d) Se descartan las palabras cuya energía queda > 30 dB bajo la mediana de la voz (alucinación).
 * (e) Se escribe transcripcion.json con el método y la k de estilo/calibracion-tiempos.json
 *     (si no existe: offsets, k = 0).
 * (f) Segunda opinión: las zonas dudosas (p < 0.2, o palabras que whisper apretó a < 45 ms) se
 *     vuelven a transcribir solas y SIN prompt; si la alternativa es más confiable, se empalma
 *     entre palabras ancla que coinciden en las dos versiones.
 * (g) Correcciones de vocabulario.json ("cloud" → "Claude"); la palabra original queda en t_whisper.
 *
 * Todo es local y gratis (whisper.cpp + ffmpeg); no usa llaves ni red.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {energiaEnIntervalo, energiaPorVentana, escribirWav, leerWav, mediana, muestraEn, type Wav} from './lib/energia';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {parsearWhisperJson, type PalabraWhisper} from './lib/whisper-json';
import {ajustarInicios} from './lib/inicio-voz';
import {esSlugValido, REGLA_SLUG} from './lib/slug';
import {comoInstalar, ejecutable, nombreEjecutable, rutaModeloWhisper} from './lib/plataforma';

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parámetros fijos del pipeline (la compuerta de tiempos mide exactamente esto). */
export const PARAMETROS = {
	idioma: 'es',
	hilos: 8,
	unirMenosDeS: 0.3,
	margenS: 0.2,
	descartarBajoMedianaDb: 30,
	/** Ancho de ventana para la mediana de energía de la voz. */
	ventanaEnergiaS: 0.02,
	/** Máximo de términos del vocabulario en el prompt (whisper acepta hasta n_text_ctx/2 tokens). */
	maxTerminosPrompt: 60,
} as const;

export type Metodo = 'offsets' | 't_dtw';

export interface Herramientas {
	whisperCli: string;
	vadCli: string;
	modelo: string;
	modeloVad: string;
	/** Versión de whisper.cpp leída de la ruta real del binario (Homebrew) o de su carpeta, o "desconocida". */
	version: string;
}

export interface TramoVad {
	inicio: number;
	fin: number;
}

export interface Tramo {
	i: number;
	/** Inicio en s, ya con margen y alineado a muestra. */
	inicio: number;
	/** Fin en s, ya con margen y alineado a muestra. */
	fin: number;
}

/** Palabra con los dos métodos de inicio, ya en la línea de tiempo del audio completo. */
export interface PalabraCruda extends PalabraWhisper {
	tramo: number;
	/** RMS (dBFS) del intervalo que cubren sus dos estimaciones de tiempo (offsets y t_dtw). */
	energiaDbfs: number;
}

export interface PalabraFinal {
	i: number;
	t: string;
	d: number;
	h: number;
	p: number;
	/** Texto que escribió whisper, si una corrección de vocabulario lo cambió. */
	t_whisper?: string;
	/** "segunda-opinion" si la palabra salió de volver a transcribir una zona dudosa. */
	fuente?: 'segunda-opinion';
}

export interface ResultadoTranscripcion {
	tramosVad: TramoVad[];
	tramos: Tramo[];
	palabras: PalabraCruda[];
	descartadas: PalabraCruda[];
	medianaVozDbfs: number;
	umbralDbfs: number;
	duracionS: number;
	prompt: string;
}

export interface Calibracion {
	metodo: Metodo;
	k_ms: number;
	fuente: string;
}

// ───────────────────────── herramientas locales ─────────────────────────

/**
 * Ubica whisper-cli, whisper-vad-speech-segments (junto a whisper-cli, o en el PATH) y los dos modelos.
 * Binarios: EDITOR_WHISPER_CLI / EDITOR_VAD_CLI, o el PATH (`ejecutable`, con .exe en Windows).
 * Modelos: EDITOR_WHISPER_MODELO / EDITOR_VAD_MODELO → carpeta de modelos (EDITOR_MODELOS o
 * ~/.cache/video-editor/modelos) → respaldo heredado (ver lib/plataforma.ts → rutaModeloWhisper).
 */
export function ubicarHerramientas(): Herramientas {
	const whisperCli = process.env.EDITOR_WHISPER_CLI ?? ejecutable('whisper-cli');
	if (!whisperCli || !existsSync(whisperCli)) {
		throw fallo('transcribir', 'no encontré whisper-cli (whisper.cpp)', `instálalo (${comoInstalar('whisper-cpp')}) o pon su ruta en EDITOR_WHISPER_CLI`, 2);
	}
	const vecino = join(dirname(whisperCli), nombreEjecutable('whisper-vad-speech-segments'));
	const vadCli = process.env.EDITOR_VAD_CLI ?? (existsSync(vecino) ? vecino : (ejecutable('whisper-vad-speech-segments') ?? vecino));
	if (!existsSync(vadCli)) {
		throw fallo(
			'detectar los tramos de voz',
			`no encontré whisper-vad-speech-segments junto a ${whisperCli}`,
			'confirma que tu whisper.cpp trae ese binario (viene en los paquetes oficiales) o pon su ruta en EDITOR_VAD_CLI',
			2,
		);
	}
	const modelo = rutaModeloWhisper('whisper');
	const modeloVad = rutaModeloWhisper('vad');
	for (const [que, ruta, dep] of [
		['el modelo de whisper large-v3', modelo, 'modelo-whisper'],
		['el modelo VAD silero', modeloVad, 'modelo-vad'],
	] as const) {
		if (!existsSync(ruta)) {
			throw fallo('transcribir', `no encontré ${que} en ${ruta}`, comoInstalar(dep), 2);
		}
	}
	let version = 'desconocida';
	try {
		version = /whisper[.-]cpp[\\/]([^\\/]+)[\\/]/.exec(realpathSync(whisperCli))?.[1] ?? version;
	} catch {
		// Sin versión no pasa nada: solo se anota.
	}
	return {whisperCli, vadCli, modelo, modeloVad, version};
}

// ───────────────────────── (a) tramos de voz ─────────────────────────

/**
 * Corre silero sobre el WAV y devuelve los tramos crudos en segundos.
 * whisper-vad-speech-segments 1.8.4 imprime "Speech segment N: start = X, end = Y" en CENTÉSIMAS de segundo.
 */
export function detectarVoz(rutaWav: string, h: Herramientas, duracionS: number): TramoVad[] {
	const r = spawnSync(h.vadCli, ['-vm', h.modeloVad, '-f', rutaWav, '-np'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: 10 * 60 * 1000,
	});
	if (r.status !== 0) {
		throw fallo('detectar los tramos de voz', `whisper-vad-speech-segments salió con código ${r.status ?? r.signal}`, 'revisa proyectos/_logs/fallos.log y vuelve a correr', 1, {
			stderr: r.stderr?.slice(-4000),
		});
	}
	const tramos: TramoVad[] = [];
	for (const linea of r.stdout.split('\n')) {
		const m = /Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/.exec(linea);
		if (m) tramos.push({inicio: Number(m[1]) / 100, fin: Number(m[2]) / 100});
	}
	const ultimo = tramos.at(-1);
	if (ultimo && ultimo.fin > duracionS + 1) {
		throw fallo('detectar los tramos de voz', `el VAD reporta voz hasta ${ultimo.fin} s en un audio de ${duracionS.toFixed(2)} s (cambió la unidad de su salida)`, 'revisa la versión de whisper-vad-speech-segments y ajusta detectarVoz()', 1);
	}
	return tramos;
}

/** Une los tramos separados por menos de `unirMenosDeS` y les da `margenS` sin que se encimen. */
export function armarTramos(
	crudos: TramoVad[],
	duracionS: number,
	frecuencia: number,
	unirMenosDeS: number = PARAMETROS.unirMenosDeS,
	margenS: number = PARAMETROS.margenS,
): Tramo[] {
	const orden = [...crudos].filter((t) => t.fin > t.inicio).sort((a, b) => a.inicio - b.inicio);
	const unidos: TramoVad[] = [];
	for (const t of orden) {
		const ultimo = unidos.at(-1);
		if (ultimo && t.inicio - ultimo.fin < unirMenosDeS) ultimo.fin = Math.max(ultimo.fin, t.fin);
		else unidos.push({...t});
	}
	const alinear = (s: number) => Math.round(s * frecuencia) / frecuencia;
	return unidos.map((t, i) => {
		const huecoAntes = i === 0 ? Infinity : t.inicio - unidos[i - 1].fin;
		const huecoDespues = i === unidos.length - 1 ? Infinity : unidos[i + 1].inicio - t.fin;
		return {
			i,
			inicio: alinear(Math.max(0, t.inicio - Math.min(margenS, huecoAntes / 2))),
			fin: alinear(Math.min(duracionS, t.fin + Math.min(margenS, huecoDespues / 2))),
		};
	});
}

// ───────────────────────── (b) whisper por tramo ─────────────────────────

/** Prompt con los términos de biblioteca/vocabulario.json (los primeros N). */
export function promptVocabulario(rutaVocabulario = join(RAIZ, 'biblioteca', 'vocabulario.json')): string {
	if (!existsSync(rutaVocabulario)) return '';
	try {
		const vocabulario = JSON.parse(readFileSync(rutaVocabulario, 'utf8')) as {terminos?: unknown};
		const terminos = Array.isArray(vocabulario.terminos)
			? vocabulario.terminos.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
			: [];
		return terminos.slice(0, PARAMETROS.maxTerminosPrompt).join(', ');
	} catch {
		throw fallo('leer el vocabulario', 'biblioteca/vocabulario.json no es un JSON válido', 'corrige el archivo (debe tener {"terminos": [...], "correcciones": {...}})', 2);
	}
}

export function argumentosWhisper(h: Herramientas, rutaTramo: string, baseSalida: string, prompt: string): string[] {
	const args = ['-m', h.modelo, '-f', rutaTramo, '-of', baseSalida, '-l', PARAMETROS.idioma, '-nfa', '--dtw', 'large.v3', '-ojf', '-sns'];
	if (prompt) args.push('--prompt', prompt, '--carry-initial-prompt');
	args.push('-t', String(PARAMETROS.hilos));
	return args;
}

/**
 * Recorta el tramo del WAV, corre whisper-cli y devuelve sus palabras ya desplazadas al audio completo.
 * Si el mismo tramo (mismas muestras y mismos argumentos) ya se transcribió, reusa su JSON.
 */
export function transcribirTramo(
	wav: Wav,
	tramo: Tramo,
	dirTramos: string,
	h: Herramientas,
	prompt: string,
	forzar = false,
	nombreArchivo?: string,
): PalabraWhisper[] {
	const nombre = nombreArchivo ?? `tramo-${String(tramo.i).padStart(3, '0')}`;
	const rutaTramo = join(dirTramos, `${nombre}.wav`);
	const base = join(dirTramos, nombre);
	const rutaJson = `${base}.json`;
	const a = muestraEn(wav, tramo.inicio);
	const b = muestraEn(wav, tramo.fin);
	const muestras = wav.muestras.subarray(a, b);

	const args = argumentosWhisper(h, rutaTramo, base, prompt);
	const clave = createHash('sha256')
		.update(Buffer.from(muestras.buffer, muestras.byteOffset, muestras.byteLength))
		.update(`\u0000${wav.frecuencia}\u0000${h.version}\u0000${args.join('\u0000')}`)
		.digest('hex');
	const rutaClave = `${base}.clave`;
	const reusable = !forzar && existsSync(rutaJson) && existsSync(rutaClave) && readFileSync(rutaClave, 'utf8').trim() === clave;

	if (!reusable) {
		escribirWav(rutaTramo, muestras, wav.frecuencia);
		const r = spawnSync(h.whisperCli, args, {maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000});
		writeFileSync(`${base}.log`, Buffer.concat([r.stdout ?? Buffer.alloc(0), Buffer.from('\n--- stderr ---\n'), r.stderr ?? Buffer.alloc(0)]));
		if (r.status !== 0 || !existsSync(rutaJson)) {
			throw fallo(
				`transcribir el ${nombre}`,
				`whisper-cli salió con código ${r.status ?? r.signal}`,
				`revisa ${base}.log y vuelve a correr con --forzar`,
				1,
			);
		}
		writeFileSync(rutaClave, `${clave}\n`);
	}
	// El inicio exacto del tramo es su primera muestra. Whisper rellena con silencio hasta 30 s y a veces
	// da a la última palabra un fin después del tramo (IMG_4874: 73.73 s en un audio de 73.53 s): se recorta.
	const finTramoMs = (b / wav.frecuencia) * 1000;
	const recortar = (ms: number | null) => (ms === null ? null : Math.min(ms, finTramoMs));
	return parsearWhisperJson(readFileSync(rutaJson), {desplazamientoS: a / wav.frecuencia}).map((p) => ({
		...p,
		inicioOffsetsMs: recortar(p.inicioOffsetsMs),
		inicioDtwMs: recortar(p.inicioDtwMs),
		finMs: recortar(p.finMs),
	}));
}

// ───────────────────────── (c)+(d) pipeline completo ─────────────────────────

/** Mediana de la energía (dBFS, ventanas de 20 ms) dentro de los tramos de voz crudos del VAD. */
export function medianaDeVoz(wav: Wav, tramosVad: TramoVad[]): number {
	const {dbfs, saltoS} = energiaPorVentana(wav, PARAMETROS.ventanaEnergiaS);
	const valores: number[] = [];
	for (const t of tramosVad) {
		const desde = Math.max(0, Math.floor(t.inicio / saltoS));
		const hasta = Math.min(dbfs.length, Math.ceil(t.fin / saltoS));
		for (let k = desde; k < hasta; k++) valores.push(dbfs[k]);
	}
	return mediana(valores);
}

/** Intervalo (s) que cubre las dos estimaciones de la palabra; así el filtro no depende del método. */
function intervaloAmplio(p: PalabraWhisper): [number, number] | null {
	const inicios = [p.inicioOffsetsMs, p.inicioDtwMs].filter((x): x is number => x !== null);
	if (inicios.length === 0) return null;
	const a = Math.min(...inicios) / 1000;
	const b = Math.max(p.finMs ?? -Infinity, Math.max(...inicios) + 50) / 1000;
	return [a, Math.max(b, a + 0.05)];
}

export interface OpcionesTranscripcion {
	/** Carpeta donde van los WAV/JSON/logs por tramo. */
	dirTramos: string;
	forzar?: boolean;
	/** Avisos de progreso (por defecto, a stderr). */
	avisar?: (mensaje: string) => void;
	herramientas?: Herramientas;
}

/** (a)–(d): tramos, whisper por tramo, desplazamiento y filtro de energía. */
export function transcribirAudio(rutaWav: string, opciones: OpcionesTranscripcion): ResultadoTranscripcion {
	const avisar = opciones.avisar ?? ((m: string) => console.error(m));
	const h = opciones.herramientas ?? ubicarHerramientas();
	const wav = leerWav(rutaWav, 16000);
	mkdirSync(opciones.dirTramos, {recursive: true});

	const tramosVad = detectarVoz(rutaWav, h, wav.duracionS);
	if (tramosVad.length === 0) {
		throw fallo('transcribir', `el VAD no encontró voz en ${basename(rutaWav)}`, 'confirma que el crudo trae tu voz (escúchalo o revisa su pista con ffprobe) y vuelve a correr', 2);
	}
	const tramos = armarTramos(tramosVad, wav.duracionS, wav.frecuencia);
	const prompt = promptVocabulario();
	avisar(`Tramos de voz: ${tramosVad.length} del VAD → ${tramos.length} tramos (${basename(rutaWav)}, ${wav.duracionS.toFixed(1)} s).`);

	const todas: PalabraCruda[] = [];
	for (const tramo of tramos) {
		const palabras = transcribirTramo(wav, tramo, opciones.dirTramos, h, prompt, opciones.forzar ?? false);
		for (const p of palabras) {
			const intervalo = intervaloAmplio(p);
			const energiaDbfs = intervalo ? energiaEnIntervalo(wav, intervalo[0], intervalo[1]) : -Infinity;
			todas.push({...p, tramo: tramo.i, energiaDbfs: Math.round(energiaDbfs * 100) / 100});
		}
		if ((tramo.i + 1) % 10 === 0 || tramo.i === tramos.length - 1) avisar(`  whisper: ${tramo.i + 1}/${tramos.length} tramos`);
	}

	const medianaVozDbfs = medianaDeVoz(wav, tramosVad);
	const umbralDbfs = medianaVozDbfs - PARAMETROS.descartarBajoMedianaDb;
	const palabras = todas.filter((p) => p.energiaDbfs >= umbralDbfs);
	const descartadas = todas.filter((p) => !(p.energiaDbfs >= umbralDbfs));
	return {
		tramosVad,
		tramos,
		palabras,
		descartadas,
		medianaVozDbfs: Math.round(medianaVozDbfs * 100) / 100,
		umbralDbfs: Math.round(umbralDbfs * 100) / 100,
		duracionS: wav.duracionS,
		prompt,
	};
}

// ───────────────────────── (e) método de la compuerta ─────────────────────────

/** Calibración del ajuste por energía (estilo/calibracion-energia.json); null si no existe. */
export function leerCalibracionEnergia(ruta = join(RAIZ, 'estilo', 'calibracion-energia.json')): {umbralDb: number; desplazamientoMs: number} | null {
	if (!existsSync(ruta)) return null;
	try {
		const datos = JSON.parse(readFileSync(ruta, 'utf8'));
		if (typeof datos.umbral_db !== 'number' || typeof datos.desplazamiento_ms !== 'number') return null;
		return {umbralDb: datos.umbral_db, desplazamientoMs: datos.desplazamiento_ms};
	} catch {
		return null;
	}
}

/**
 * Ajusta al arranque real de la voz el inicio de cada palabra que viene después de una pausa
 * (herramientas/lib/inicio-voz.ts). En validación cruzada bajó el p50 de 47 ms a 1.2 ms
 * contra la verdad de la compuerta; las palabras en medio del habla se quedan con t_dtw − k.
 */
export function ajustarPorEnergia(rutaWav: string, palabras: PalabraFinal[], cal: {umbralDb: number; desplazamientoMs: number}): {palabras: PalabraFinal[]; ajustadas: number} {
	const wav = leerWav(rutaWav, 16000);
	const res = ajustarInicios(wav, palabras.map((p) => ({inicioMs: p.d * 1000})), {umbralDb: cal.umbralDb, desplazamientoMs: cal.desplazamientoMs});
	let ajustadas = 0;
	const salida = palabras.map((p, i) => {
		const r = res[i];
		if (!r || !r.ajustada || r.inicioMs === null) return p;
		ajustadas++;
		const d = Math.round(r.inicioMs) / 1000;
		return {...p, d, h: Math.max(p.h, Math.round((d + 0.02) * 1000) / 1000)};
	});
	return {palabras: salida, ajustadas};
}

/** Lee el método y la k de estilo/calibracion-tiempos.json; si no existe: offsets, k = 0. */
export function leerCalibracion(ruta = join(RAIZ, 'estilo', 'calibracion-tiempos.json')): Calibracion {
	if (!existsSync(ruta)) return {metodo: 'offsets', k_ms: 0, fuente: 'por defecto (sin estilo/calibracion-tiempos.json)'};
	let datos: {metodo?: unknown; k_ms?: unknown};
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer la calibración de tiempos', 'estilo/calibracion-tiempos.json no es un JSON válido', 'déjalo con la forma {"metodo": "offsets" | "t_dtw", "k_ms": número} (el de la plantilla trae los valores por defecto) y revísalo con npx tsx herramientas/doctor.ts', 2);
	}
	if ((datos.metodo !== 'offsets' && datos.metodo !== 't_dtw') || typeof datos.k_ms !== 'number' || !Number.isFinite(datos.k_ms)) {
		throw fallo('leer la calibración de tiempos', 'estilo/calibracion-tiempos.json no trae metodo ("offsets" o "t_dtw") y k_ms numérico', 'déjalo con la forma {"metodo": "offsets" | "t_dtw", "k_ms": número} (el de la plantilla trae los valores por defecto) y revísalo con npx tsx herramientas/doctor.ts', 2);
	}
	return {metodo: datos.metodo, k_ms: datos.k_ms, fuente: 'estilo/calibracion-tiempos.json'};
}

/** Inicio (ms) de una palabra según el método; si falta ese dato, usa el otro método. */
export function inicioSegun(p: PalabraWhisper, metodo: Metodo, kMs: number): number | null {
	if (metodo === 't_dtw') {
		if (p.inicioDtwMs !== null) return p.inicioDtwMs - kMs;
		return p.inicioOffsetsMs;
	}
	if (p.inicioOffsetsMs !== null) return p.inicioOffsetsMs - kMs;
	return p.inicioDtwMs;
}

/**
 * Palabras finales {i, t, d, h, p} en segundos.
 * - d: inicio por el método elegido (t_dtw×10 − k u offsets.from).
 * - h: offsets.to del último token. Si los offsets quedaron corridos respecto a d (pasa con t_dtw en
 *   tramos largos), se usa la duración de los offsets anclada en d. Nunca baja de d + 20 ms ni pasa
 *   del inicio de la palabra siguiente ni del fin de su tramo (`finMaxMs`, si se da).
 */
export function palabrasFinales(
	palabras: PalabraWhisper[],
	metodo: Metodo,
	kMs: number,
	finMaxMs: (p: PalabraWhisper) => number = () => Infinity,
): PalabraFinal[] {
	const conInicio = palabras
		.map((p) => ({p, d: inicioSegun(p, metodo, kMs)}))
		.filter((x): x is {p: PalabraWhisper; d: number} => x.d !== null);
	// Los inicios no pueden retroceder (el DTW y los offsets son monótonos dentro de un tramo; esto cubre bordes).
	for (let j = 1; j < conInicio.length; j++) conInicio[j].d = Math.max(conInicio[j].d, conInicio[j - 1].d);
	return conInicio.map(({p, d}, j) => {
		const siguiente = Math.min(conInicio[j + 1]?.d ?? Infinity, Math.max(d, finMaxMs(p)));
		const duracionOffsets =
			p.finMs !== null && p.inicioOffsetsMs !== null ? Math.max(0, p.finMs - p.inicioOffsetsMs) : 0;
		let h = Math.max(p.finMs ?? d, d + duracionOffsets, d + 20);
		if (h > siguiente) h = Math.max(d, siguiente);
		return {
			i: j,
			t: p.texto,
			d: Math.round(Math.max(0, d)) / 1000,
			h: Math.round(Math.max(0, h)) / 1000,
			p: Math.round(p.p * 1000) / 1000,
		};
	});
}

// ───────────────────────── (f) segunda opinión en zonas dudosas ─────────────────────────

/**
 * Con el prompt de vocabulario, whisper a veces repite una frase reciente en vez de la real
 * (IMG_4874, 30.2 s: "de esta liga" con p = 0.06, donde se dice "de este agente llamado WebKit").
 * Esas zonas se vuelven a transcribir solas y sin prompt.
 */
export const SEGUNDA_OPINION = {
	/** Una palabra con probabilidad menor a esto es dudosa. */
	pMin: 0.2,
	/** Dos palabras seguidas más cortas que esto (y una con ≥ 3 letras) son dudosas: whisper las apretó. */
	duracionMinS: 0.045,
	/** Palabras de contexto a cada lado de la zona; sirven de anclas para empalmar. */
	contexto: 4,
	/** Audio extra (s) antes y después de la ventana. */
	margenS: 0.3,
	/** La alternativa entra si su probabilidad media supera a la original por al menos esto. */
	ventajaMinP: 0.05,
} as const;

export interface Zona {
	i0: number;
	i1: number;
}

export interface Revision {
	desde_s: number;
	hasta_s: number;
	original: string;
	alternativa: string;
	p_original: number;
	p_alternativa: number;
	aplicada: boolean;
	motivo: string;
}

/** Minúsculas, sin acentos ni puntuación: para comparar palabras entre dos transcripciones. */
export function normalizarPalabra(t: string): string {
	return t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

const letras = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').length;
const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Zonas con palabras dudosas; las que quedan a ≤ 2×contexto palabras se unen. */
export function zonasDudosas(palabras: PalabraFinal[], par: typeof SEGUNDA_OPINION = SEGUNDA_OPINION): Zona[] {
	const dudosa = palabras.map((p) => p.p < par.pMin);
	const corta = palabras.map((p) => p.h - p.d < par.duracionMinS);
	for (let j = 0; j + 1 < palabras.length; j++) {
		if (corta[j] && corta[j + 1] && Math.max(letras(palabras[j].t), letras(palabras[j + 1].t)) >= 3) {
			dudosa[j] = true;
			dudosa[j + 1] = true;
		}
	}
	const zonas: Zona[] = [];
	dudosa.forEach((es, j) => {
		if (!es) return;
		const ultima = zonas.at(-1);
		if (ultima && j - ultima.i1 <= 2 * par.contexto) ultima.i1 = j;
		else zonas.push({i0: j, i1: j});
	});
	return zonas;
}

/** Subsecuencia común más larga entre dos listas: pares [índice en a, índice en b], en orden. */
export function alinearPalabras(a: string[], b: string[]): Array<[number, number]> {
	const t = Array.from({length: a.length + 1}, () => new Array<number>(b.length + 1).fill(0));
	for (let x = a.length - 1; x >= 0; x--) {
		for (let y = b.length - 1; y >= 0; y--) {
			t[x][y] = a[x] === b[y] && a[x] !== '' ? t[x + 1][y + 1] + 1 : Math.max(t[x + 1][y], t[x][y + 1]);
		}
	}
	const pares: Array<[number, number]> = [];
	let x = 0;
	let y = 0;
	while (x < a.length && y < b.length) {
		if (a[x] === b[y] && a[x] !== '') {
			pares.push([x, y]);
			x++;
			y++;
		} else if (t[x + 1][y] >= t[x][y + 1]) x++;
		else y++;
	}
	return pares;
}

/**
 * Empalma la alternativa en la zona: busca la última palabra que coincide ANTES de la zona y la
 * primera DESPUÉS (anclas), y reemplaza lo de en medio si la alternativa es más confiable.
 */
export function empalmar(
	base: PalabraFinal[],
	zona: Zona,
	alternativa: PalabraFinal[],
	par: typeof SEGUNDA_OPINION = SEGUNDA_OPINION,
): {palabras: PalabraFinal[]; revision: Revision} {
	const a = Math.max(0, zona.i0 - par.contexto);
	const b = Math.min(base.length - 1, zona.i1 + par.contexto);
	const ventana = base.slice(a, b + 1);
	const pares = alinearPalabras(ventana.map((p) => normalizarPalabra(p.t)), alternativa.map((p) => normalizarPalabra(p.t)));
	const izq = [...pares].reverse().find(([x]) => x < zona.i0 - a);
	const der = pares.find(([x]) => x > zona.i1 - a);
	const sinCambio = (motivo: string, original: PalabraFinal[], alt: PalabraFinal[]) => ({
		palabras: base,
		revision: {
			desde_s: base[zona.i0].d,
			hasta_s: base[zona.i1].h,
			original: original.map((p) => p.t).join(' '),
			alternativa: alt.map((p) => p.t).join(' '),
			p_original: Math.round(media(original.map((p) => p.p)) * 1000) / 1000,
			p_alternativa: Math.round(media(alt.map((p) => p.p)) * 1000) / 1000,
			aplicada: false,
			motivo,
		},
	});
	const zonaBase = base.slice(zona.i0, zona.i1 + 1);
	if (!izq || !der) return sinCambio('sin palabras ancla a los dos lados', zonaBase, alternativa);
	const tramoBase = ventana.slice(izq[0] + 1, der[0]);
	const tramoAlt = alternativa.slice(izq[1] + 1, der[1]);
	if (tramoAlt.length === 0) return sinCambio('la alternativa no trae palabras entre las anclas', tramoBase, tramoAlt);
	const r = sinCambio('', tramoBase, tramoAlt);
	if (tramoBase.map((p) => normalizarPalabra(p.t)).join(' ') === tramoAlt.map((p) => normalizarPalabra(p.t)).join(' ')) {
		return {...r, revision: {...r.revision, motivo: 'mismo texto'}};
	}
	if (r.revision.p_alternativa < r.revision.p_original + par.ventajaMinP) {
		return {...r, revision: {...r.revision, motivo: 'la alternativa no es más confiable'}};
	}
	const inicio = a + izq[0] + 1;
	const fin = a + der[0];
	const nuevas = tramoAlt.map((p) => ({...p, fuente: 'segunda-opinion' as const}));
	return {
		palabras: [...base.slice(0, inicio), ...nuevas, ...base.slice(fin)],
		revision: {...r.revision, aplicada: true, motivo: `p media ${r.revision.p_original} → ${r.revision.p_alternativa}`},
	};
}

/** Tiempos monótonos tras un empalme: cada inicio ≥ el anterior y cada fin ≤ el inicio siguiente. */
export function ordenarTiempos(palabras: PalabraFinal[]): PalabraFinal[] {
	const salida = palabras.map((p) => ({...p}));
	for (let j = 1; j < salida.length; j++) salida[j].d = Math.max(salida[j].d, salida[j - 1].d);
	for (let j = 0; j < salida.length; j++) {
		const siguiente = salida[j + 1]?.d ?? Infinity;
		salida[j].h = Math.min(Math.max(salida[j].h, salida[j].d), Math.max(siguiente, salida[j].d));
	}
	return salida.map((p, i) => ({...p, i}));
}

/** (f) completa: busca zonas dudosas, las re-transcribe sin prompt y empalma lo que mejore. */
export function segundaOpinion(
	rutaWav: string,
	base: PalabraFinal[],
	opciones: {dirTramos: string; herramientas: Herramientas; metodo: Metodo; kMs: number; forzar?: boolean},
): {palabras: PalabraFinal[]; revisiones: Revision[]} {
	const zonas = zonasDudosas(base);
	if (zonas.length === 0) return {palabras: base, revisiones: []};
	const wav = leerWav(rutaWav, 16000);
	let palabras = base;
	const revisiones: Revision[] = [];
	// De la última a la primera: así los índices de las zonas pendientes no se mueven.
	for (const zona of [...zonas].reverse()) {
		const a = Math.max(0, zona.i0 - SEGUNDA_OPINION.contexto);
		const b = Math.min(palabras.length - 1, zona.i1 + SEGUNDA_OPINION.contexto);
		const alinear = (s: number) => Math.round(s * wav.frecuencia) / wav.frecuencia;
		const desde = alinear(Math.max(0, palabras[a].d - SEGUNDA_OPINION.margenS));
		const hasta = alinear(Math.min(wav.duracionS, palabras[b].h + SEGUNDA_OPINION.margenS));
		const nombre = `revision-${Math.round(desde * 1000)}-${Math.round(hasta * 1000)}`;
		const crudas = transcribirTramo(wav, {i: -1, inicio: desde, fin: hasta}, opciones.dirTramos, opciones.herramientas, '', opciones.forzar ?? false, nombre);
		const r = empalmar(palabras, zona, palabrasFinales(crudas, opciones.metodo, opciones.kMs, () => hasta * 1000));
		palabras = r.palabras;
		revisiones.unshift(r.revision);
	}
	return {palabras: ordenarTiempos(palabras), revisiones};
}

// ───────────────────────── (g) correcciones de vocabulario ─────────────────────────

/** Correcciones de biblioteca/vocabulario.json: {"cloud": "Claude", "cloud code": "Claude Code"}. */
export function leerCorrecciones(rutaVocabulario = join(RAIZ, 'biblioteca', 'vocabulario.json')): Record<string, string> {
	if (!existsSync(rutaVocabulario)) return {};
	const datos = JSON.parse(readFileSync(rutaVocabulario, 'utf8')) as {correcciones?: unknown};
	const c = datos.correcciones;
	if (!c || typeof c !== 'object') return {};
	return Object.fromEntries(Object.entries(c).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].trim() !== '' && e[1].trim() !== ''));
}

/**
 * Aplica las correcciones respetando la puntuación pegada ("Cloud," → "Claude,").
 * Una clave de varias palabras se busca seguida; si el reemplazo trae el mismo número de palabras,
 * cada una conserva sus tiempos, y si trae una sola, se juntan en una ("chat gpt" → "ChatGPT").
 */
export function aplicarCorrecciones(
	palabras: PalabraFinal[],
	correcciones: Record<string, string>,
): {palabras: PalabraFinal[]; cambios: Array<{i: number; de: string; a: string}>} {
	const reglas = Object.entries(correcciones)
		.map(([de, a]) => ({de: de.trim().split(/\s+/).map(normalizarPalabra), a: a.trim().split(/\s+/)}))
		.filter((r) => r.de.every((w) => w !== ''))
		.sort((x, y) => y.de.length - x.de.length);
	for (const r of reglas) {
		if (r.a.length !== 1 && r.a.length !== r.de.length && r.de.length !== 1) {
			throw fallo('aplicar las correcciones de vocabulario', `"${r.de.join(' ')}" → "${r.a.join(' ')}" cambia el número de palabras`, 'usa un reemplazo de una sola palabra, con las mismas palabras que la clave, o una clave de una palabra que se parte en varias', 2);
		}
	}
	const pre = (t: string) => /^[^\p{L}\p{N}]*/u.exec(t)?.[0] ?? '';
	const suf = (t: string) => /[^\p{L}\p{N}]*$/u.exec(t)?.[0] ?? '';
	const salida: PalabraFinal[] = [];
	const cambios: Array<{i: number; de: string; a: string}> = [];
	for (let j = 0; j < palabras.length; ) {
		const regla = reglas.find((r) => j + r.de.length <= palabras.length && r.de.every((w, k) => normalizarPalabra(palabras[j + k].t) === w));
		if (!regla) {
			salida.push(palabras[j]);
			j++;
			continue;
		}
		const grupo = palabras.slice(j, j + regla.de.length);
		const original = (p: PalabraFinal) => p.t_whisper ?? p.t;
		let nuevas: PalabraFinal[];
		if (regla.a.length === grupo.length) {
			nuevas = grupo.map((p, k) => {
				const t = pre(p.t) + regla.a[k] + suf(p.t);
				return t === p.t ? p : {...p, t, t_whisper: original(p)};
			});
		} else if (grupo.length === 1) {
			// Una palabra que whisper juntó ("Claudelanada" → "Claude de la nada"): se parte y el tiempo se reparte por letras.
			const p = grupo[0];
			const pesos = regla.a.map((w) => Math.max(1, letras(w)));
			const total = pesos.reduce((x, y) => x + y, 0);
			let d = p.d;
			nuevas = regla.a.map((w, k) => {
				const h = k === regla.a.length - 1 ? p.h : Math.round((d + ((p.h - p.d) * pesos[k]) / total) * 1000) / 1000;
				const t = (k === 0 ? pre(p.t) : '') + w + (k === regla.a.length - 1 ? suf(p.t) : '');
				const nueva = {...p, t, d, h, t_whisper: original(p)};
				d = h;
				return nueva;
			});
		} else {
			nuevas = [{...grupo[0], t: pre(grupo[0].t) + regla.a[0] + suf(grupo.at(-1)!.t), h: grupo.at(-1)!.h, p: Math.min(...grupo.map((p) => p.p)), t_whisper: grupo.map(original).join(' ')}];
		}
		const de = grupo.map((p) => p.t).join(' ');
		const a = nuevas.map((p) => p.t).join(' ');
		if (de !== a) cambios.push({i: grupo[0].i, de, a});
		salida.push(...nuevas);
		j += grupo.length;
	}
	return {palabras: salida.map((p, i) => ({...p, i})), cambios};
}

// ───────────────────────── CLI ─────────────────────────


async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const forzar = args.includes('--forzar');
	const slug = args.find((a) => !a.startsWith('--'));
	if (!slug) {
		throw fallo('transcribir', 'falta el slug del proyecto', 'corre `npx tsx herramientas/transcribir.ts <slug>` (la carpeta de proyectos/)', 2);
	}
	if (!esSlugValido(slug)) {
		throw fallo('transcribir', `"${slug}" no es un slug válido`, `usa ${REGLA_SLUG}`, 2);
	}
	const dirProyecto = join(RAIZ, 'proyectos', slug);
	const rutaWav = join(dirProyecto, 'audio16k.wav');
	if (!existsSync(rutaWav)) {
		throw fallo('transcribir', `no existe proyectos/${slug}/audio16k.wav`, `corre primero la ingesta de ese crudo para generar el audio`, 2);
	}

	const calibracion = leerCalibracion();
	const h = ubicarHerramientas();
	const r = transcribirAudio(rutaWav, {dirTramos: join(dirProyecto, 'tramos'), forzar, herramientas: h});

	writeFileSync(
		join(dirProyecto, 'tramos.json'),
		`${JSON.stringify(
			{
				fuente: 'audio16k.wav',
				duracion_s: Math.round(r.duracionS * 1000) / 1000,
				vad: {modelo: basename(h.modeloVad), herramienta: `whisper-vad-speech-segments (whisper.cpp ${h.version})`},
				unir_menos_de_s: PARAMETROS.unirMenosDeS,
				margen_s: PARAMETROS.margenS,
				voz: r.tramosVad.map((t) => ({inicio: Math.round(t.inicio * 1000) / 1000, fin: Math.round(t.fin * 1000) / 1000})),
				tramos: r.tramos.map((t) => ({i: t.i, inicio: Math.round(t.inicio * 1e6) / 1e6, fin: Math.round(t.fin * 1e6) / 1e6})),
			},
			null,
			'\t',
		)}\n`,
	);

	const calEnergia = leerCalibracionEnergia();
	const finTramoMs = (p: PalabraWhisper) => (r.tramos[(p as PalabraCruda).tramo]?.fin ?? r.duracionS) * 1000;
	const base = palabrasFinales(r.palabras, calibracion.metodo, calibracion.k_ms, finTramoMs);
	const {palabras: revisadas, revisiones} = segundaOpinion(rutaWav, base, {
		dirTramos: join(dirProyecto, 'tramos'),
		herramientas: h,
		metodo: calibracion.metodo,
		kMs: calibracion.k_ms,
		forzar,
	});
	for (const rev of revisiones) {
		console.error(`  segunda opinión ${rev.desde_s.toFixed(2)} s: "${rev.original}" → "${rev.alternativa}" (${rev.aplicada ? 'aplicada' : 'no aplicada'}: ${rev.motivo})`);
	}
	const {palabras: conEnergia, ajustadas} = calEnergia ? ajustarPorEnergia(rutaWav, revisadas, calEnergia) : {palabras: revisadas, ajustadas: 0};
	const {palabras, cambios} = aplicarCorrecciones(conEnergia, leerCorrecciones());
	writeFileSync(
		join(dirProyecto, 'transcripcion.json'),
		`${JSON.stringify(
			{
				metodo: calibracion.metodo,
				k_ms: calibracion.k_ms,
				modelo: `${basename(h.modelo)} (whisper.cpp ${h.version})`,
				calibracion: calibracion.fuente,
				ajuste_energia: calEnergia ? {umbral_db: calEnergia.umbralDb, desplazamiento_ms: calEnergia.desplazamientoMs, palabras_ajustadas: ajustadas} : null,
				idioma: PARAMETROS.idioma,
				prompt: r.prompt,
				tramos: r.tramos.length,
				energia: {mediana_voz_dbfs: r.medianaVozDbfs, umbral_dbfs: r.umbralDbfs, descartadas: r.descartadas.length},
				segunda_opinion: {parametros: SEGUNDA_OPINION, zonas: revisiones.length, aplicadas: revisiones.filter((x) => x.aplicada).length, revisiones},
				correcciones: cambios,
				generado: new Date().toISOString(),
				palabras,
				descartadas: r.descartadas.map((p) => ({
					t: p.texto,
					d: (inicioSegun(p, calibracion.metodo, calibracion.k_ms) ?? 0) / 1000,
					energia_dbfs: p.energiaDbfs,
				})),
			},
			null,
			'\t',
		)}\n`,
	);
	console.log(
		`Listo: ${palabras.length} palabras en ${r.tramos.length} tramos (método ${calibracion.metodo}, k = ${calibracion.k_ms} ms; ${ajustadas} inicios ajustados por energía; ${r.descartadas.length} descartadas; segunda opinión ${revisiones.filter((x) => x.aplicada).length}/${revisiones.length} zonas; ${cambios.length} correcciones de vocabulario) → proyectos/${slug}/transcripcion.json`,
	);
}

if (esPrincipal(import.meta.url)) void correr(main);
