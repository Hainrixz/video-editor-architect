/**
 * Capa multiplataforma (macOS, Windows y Linux): qué sistema es, dónde están los programas y los modelos, y con
 * qué motor se hace la visión (OCR, cara y silueta).
 *
 * - `sistema()`: 'mac' | 'windows' | 'linux'.
 * - `ejecutable(nombre)`: ruta del programa en el PATH (en Windows agrega `.exe`/PATHEXT). Busca con `which`/`where`
 *   sin shell y, si no están, recorre el PATH a mano. null si no está.
 * - `rutaModelos()`: carpeta de modelos locales (whisper, MediaPipe…). `EDITOR_MODELOS` manda; si no,
 *   `~/.cache/video-editor/modelos`. Nunca dentro del repo.
 * - `pythonVenv()`: el Python del `.venv` del proyecto (`EDITOR_PYTHON` manda; `.venv/bin/python` o
 *   `.venv\Scripts\python.exe` en Windows).
 * - `motorVision(herramienta)`: 'vision' (binarios Swift de Apple Vision en herramientas/bin/, solo macOS) o
 *   'python' (herramientas/py/*.py: RapidOCR y MediaPipe en el .venv). En macOS gana Vision si su binario está
 *   compilado; en Windows y Linux siempre Python. `EDITOR_VISION=python|vision` lo fuerza.
 * - `comandoVision(herramienta)`: programa y argumentos para lanzarla (los dos motores leen y escriben lo mismo:
 *   cuadros RGBA por stdin y una línea JSON por cuadro, o la máscara gris en el caso de `mascara`).
 *
 * Nada aquí usa `bash -c` ni `zsh -c`: todo va con spawn/execFile y un arreglo de argumentos.
 */
import {spawnSync} from 'node:child_process';
import {accessSync, constants, existsSync, readdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Raíz del proyecto (sin importar manifest.ts, para que esto no arrastre dependencias). */
export const RAIZ_PROYECTO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Sistema = 'mac' | 'windows' | 'linux';
type Entorno = Record<string, string | undefined>;

/** Sistema operativo (cualquier Unix que no sea macOS cuenta como linux). */
export function sistema(plataforma: string = process.platform): Sistema {
	if (plataforma === 'darwin') return 'mac';
	if (plataforma === 'win32') return 'windows';
	return 'linux';
}

/** Nombre del archivo del programa: en Windows con `.exe` (si no trae ya una extensión). */
export function nombreEjecutable(nombre: string, s: Sistema = sistema()): string {
	if (s !== 'windows') return nombre;
	return /\.[A-Za-z0-9]{2,4}$/.test(nombre) ? nombre : `${nombre}.exe`;
}

/** ¿Se puede ejecutar ese archivo? (en Windows basta con que exista y sea archivo). */
function esEjecutable(ruta: string, s: Sistema): boolean {
	try {
		if (!statSync(ruta).isFile()) return false;
		if (s === 'windows') return true;
		accessSync(ruta, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Busca un programa recorriendo el PATH (puro salvo por el disco). En Windows prueba las extensiones de PATHEXT.
 * Exportada para las pruebas (con `env` y `sistema` inyectados).
 */
export function buscarEnPath(nombre: string, op: {env?: Entorno; sistema?: Sistema} = {}): string | null {
	const s = op.sistema ?? sistema();
	const env = op.env ?? process.env;
	const ruta = env.PATH ?? env.Path ?? '';
	const sep = s === 'windows' ? ';' : ':';
	const extensiones =
		s === 'windows' && !/\.[A-Za-z0-9]{2,4}$/.test(nombre)
			? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
			: [''];
	for (const dir of ruta.split(sep)) {
		if (!dir) continue;
		for (const ext of extensiones) {
			const candidato = join(dir, `${nombre}${ext}`);
			if (esEjecutable(candidato, s)) return candidato;
		}
	}
	return null;
}

/**
 * Ruta del programa `nombre` o null. Primero `which` (mac/linux) o `where` (Windows), sin shell; si no responden,
 * recorre el PATH a mano. Si `nombre` ya es una ruta (trae / o \), solo revisa que exista.
 */
export function ejecutable(nombre: string, op: {env?: Entorno; sistema?: Sistema} = {}): string | null {
	const s = op.sistema ?? sistema();
	if (/[\\/]/.test(nombre)) return esEjecutable(nombre, s) ? nombre : null;
	if (!op.env && s === sistema()) {
		const buscador = s === 'windows' ? 'where' : 'which';
		const r = spawnSync(buscador, [nombreEjecutable(nombre, s)], {encoding: 'utf8', timeout: 10_000, windowsHide: true});
		const primera = r.status === 0 ? (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined;
		if (primera && existsSync(primera)) return primera;
	}
	return buscarEnPath(nombre, {env: op.env, sistema: s});
}

/** Carpeta de modelos locales: `EDITOR_MODELOS` o `~/.cache/video-editor/modelos`. */
export function rutaModelos(env: Entorno = process.env, home: string = homedir()): string {
	const propia = env.EDITOR_MODELOS?.trim();
	return propia ? resolve(propia) : join(home, '.cache', 'video-editor', 'modelos');
}

/** Python del `.venv` del proyecto (o `EDITOR_PYTHON`). */
export function pythonVenv(op: {env?: Entorno; sistema?: Sistema; raiz?: string} = {}): string {
	const env = op.env ?? process.env;
	if (env.EDITOR_PYTHON?.trim()) return env.EDITOR_PYTHON.trim();
	const raiz = op.raiz ?? RAIZ_PROYECTO;
	return (op.sistema ?? sistema()) === 'windows' ? join(raiz, '.venv', 'Scripts', 'python.exe') : join(raiz, '.venv', 'bin', 'python');
}

/** Comando para crear el .venv e instalar los paquetes de visión (para mensajes de "siguiente paso"). */
export const INSTALAR_PY_VISION = 'uv venv .venv --python 3.12 y uv pip install --python <python del .venv> -r herramientas/py/requirements.txt';

// ───────────────────────────── visión ─────────────────────────────

export type MotorVision = 'vision' | 'python';
export type HerramientaVision = 'ocr' | 'cara' | 'mascara';

/** Binario Swift compilado (herramientas/bin/<nombre>, solo macOS). */
export function binarioVision(nombre: HerramientaVision | 'recortar', raiz = RAIZ_PROYECTO): string {
	return join(raiz, 'herramientas', 'bin', nombre);
}

/** Script de Python equivalente (herramientas/py/<nombre>.py). */
export function scriptVision(nombre: HerramientaVision, raiz = RAIZ_PROYECTO): string {
	return join(raiz, 'herramientas', 'py', `${nombre}.py`);
}

/** Cómo se compila cada binario de Vision (para los mensajes). */
export const COMPILAR_VISION: Record<HerramientaVision | 'recortar', string> = {
	ocr: 'sh herramientas/vision/compilar.sh ocr',
	cara: 'sh herramientas/vision/compilar-cara.sh',
	mascara: 'sh herramientas/vision/compilar.sh mascara',
	recortar: 'sh herramientas/vision/compilar-recortar.sh',
};

/**
 * Motor de visión para una herramienta. `EDITOR_VISION=python|vision` manda. Si no: en macOS 'vision' si su
 * binario está compilado; en lo demás (o sin binario) 'python'.
 */
export function motorVision(
	herramienta: HerramientaVision = 'ocr',
	op: {env?: Entorno; sistema?: Sistema; existe?: (ruta: string) => boolean; raiz?: string} = {},
): MotorVision {
	const env = op.env ?? process.env;
	const forzado = env.EDITOR_VISION?.trim().toLowerCase();
	if (forzado === 'python' || forzado === 'vision') return forzado;
	const s = op.sistema ?? sistema();
	const existe = op.existe ?? existsSync;
	return s === 'mac' && existe(binarioVision(herramienta, op.raiz)) ? 'vision' : 'python';
}

export type ComandoVision = {
	motor: MotorVision;
	/** Programa a lanzar (binario de Vision o el Python del .venv). */
	programa: string;
	/** Argumentos que van antes de los de la herramienta (la ruta del script con Python). */
	prefijo: string[];
	/** Lo que tiene que existir para poder correrla (binario o script + python). */
	requisitos: string[];
	/** Nombre corto para los mensajes ("herramientas/bin/ocr" o "herramientas/py/ocr.py"). */
	nombre: string;
	/** Qué hacer si falta. */
	comoInstalar: string;
	/** Variables de entorno extra para el proceso (la carpeta de modelos para Python). */
	env: Record<string, string>;
};

/** Programa, prefijo y requisitos para correr una herramienta de visión con el motor que toque. */
export function comandoVision(
	herramienta: HerramientaVision,
	op: {env?: Entorno; sistema?: Sistema; existe?: (ruta: string) => boolean; raiz?: string} = {},
): ComandoVision {
	const motor = motorVision(herramienta, op);
	const raiz = op.raiz ?? RAIZ_PROYECTO;
	if (motor === 'vision') {
		const bin = binarioVision(herramienta, raiz);
		return {
			motor,
			programa: bin,
			prefijo: [],
			requisitos: [bin],
			nombre: `herramientas/bin/${herramienta}`,
			comoInstalar: `compílalo con ${COMPILAR_VISION[herramienta]} (o usa el motor Python con EDITOR_VISION=python)`,
			env: {},
		};
	}
	const python = pythonVenv({env: op.env, sistema: op.sistema, raiz});
	const script = scriptVision(herramienta, raiz);
	return {
		motor,
		programa: python,
		prefijo: [script],
		requisitos: [python, script],
		nombre: `herramientas/py/${herramienta}.py`,
		comoInstalar: `prepara el .venv: ${INSTALAR_PY_VISION}`,
		env: {EDITOR_MODELOS: rutaModelos(op.env ?? process.env), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1'},
	};
}

/** Lo primero que falta para correr el comando (null si está todo). */
export function faltaParaVision(c: ComandoVision, existe: (ruta: string) => boolean = existsSync): string | null {
	return c.requisitos.find((r) => !existe(r)) ?? null;
}

// ───────────────────────────── cómo instalar cada cosa (datos, no ifs regados) ─────────────────────────────

export type Dependencia = 'node' | 'ffmpeg' | 'uv' | 'yt-dlp' | 'whisper-cpp' | 'chrome' | 'swift' | 'modelo-whisper' | 'modelo-vad';

/** Comando o instrucción para instalar cada dependencia en cada sistema (null = no aplica en ese sistema). */
export const INSTALACION: Record<Dependencia, Record<Sistema, string | null>> = {
	node: {mac: 'brew install node', windows: 'winget install OpenJS.NodeJS', linux: 'instala Node 24 con tu gestor de paquetes o desde https://nodejs.org'},
	ffmpeg: {mac: 'brew install ffmpeg', windows: 'winget install Gyan.FFmpeg', linux: 'sudo apt install ffmpeg (o el paquete de tu distribución)'},
	uv: {mac: 'brew install uv', windows: 'winget install astral-sh.uv', linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh'},
	'yt-dlp': {mac: 'brew install yt-dlp', windows: 'winget install yt-dlp.yt-dlp', linux: 'uv tool install yt-dlp'},
	'whisper-cpp': {
		mac: 'brew install whisper-cpp',
		windows: 'baja whisper-bin-x64.zip de https://github.com/ggml-org/whisper.cpp/releases, descomprímelo y pon esa carpeta en el PATH (o su ruta en EDITOR_WHISPER_CLI)',
		linux: 'compila whisper.cpp (https://github.com/ggml-org/whisper.cpp, cmake -B build && cmake --build build) y pon build/bin en el PATH',
	},
	chrome: {mac: 'instálalo desde https://www.google.com/chrome', windows: 'winget install Google.Chrome', linux: 'instala Google Chrome desde https://www.google.com/chrome'},
	swift: {mac: 'xcode-select --install', windows: null, linux: null},
	'modelo-whisper': {
		mac: 'baja https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin a la carpeta de modelos (o pon su ruta en EDITOR_WHISPER_MODELO)',
		windows: 'baja https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin a la carpeta de modelos (o pon su ruta en EDITOR_WHISPER_MODELO)',
		linux: 'baja https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin a la carpeta de modelos (o pon su ruta en EDITOR_WHISPER_MODELO)',
	},
	'modelo-vad': {
		mac: 'baja https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin a la carpeta de modelos (o pon su ruta en EDITOR_VAD_MODELO)',
		windows: 'baja https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin a la carpeta de modelos (o pon su ruta en EDITOR_VAD_MODELO)',
		linux: 'baja https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin a la carpeta de modelos (o pon su ruta en EDITOR_VAD_MODELO)',
	},
};

/** Cómo instalar una dependencia en este sistema (o en el que digas). */
export function comoInstalar(dep: Dependencia, s: Sistema = sistema()): string {
	return INSTALACION[dep][s] ?? `no hace falta en ${s}`;
}

// ───────────────────────────── modelos de whisper ─────────────────────────────

export const MODELO_WHISPER = 'ggml-large-v3.bin';
export const MODELO_VAD = 'ggml-silero-v5.1.2.bin';

/**
 * Respaldo heredado: carpetas `models/` de instalaciones viejas en el escritorio (`~/Desktop/<x>/models/` y
 * `~/Desktop/<x>/<y>/models/`). Solo las que ya traen el archivo; nunca se crean.
 */
export function modelosHeredados(archivo: string, home: string = homedir(), existe: (ruta: string) => boolean = existsSync): string[] {
	const escritorio = join(home, 'Desktop');
	const hijos = (dir: string): string[] => {
		try {
			return readdirSync(dir, {withFileTypes: true})
				.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
				.map((d) => join(dir, d.name));
		} catch {
			return [];
		}
	};
	const encontrados: string[] = [];
	for (const nivel1 of hijos(escritorio)) {
		for (const dir of [nivel1, ...hijos(nivel1)]) {
			const ruta = join(dir, 'models', archivo);
			if (existe(ruta)) encontrados.push(ruta);
		}
	}
	return encontrados.sort();
}

/**
 * Rutas candidatas de un modelo de whisper, en orden: variable de entorno → carpeta de modelos → (respaldo
 * heredado) `modelosHeredados`. Ver `rutaModeloWhisper`.
 */
export function candidatosModelo(cual: 'whisper' | 'vad', op: {env?: Entorno; home?: string; existe?: (ruta: string) => boolean} = {}): string[] {
	const env = op.env ?? process.env;
	const home = op.home ?? homedir();
	const variable = cual === 'whisper' ? env.EDITOR_WHISPER_MODELO : env.EDITOR_VAD_MODELO;
	const archivo = cual === 'whisper' ? MODELO_WHISPER : MODELO_VAD;
	return [...(variable?.trim() ? [variable.trim()] : []), join(rutaModelos(env, home), archivo), ...modelosHeredados(archivo, home, op.existe)];
}

/**
 * Ruta del modelo de whisper (`whisper`) o del VAD silero (`vad`). La variable de entorno manda aunque no exista
 * (el error dirá esa ruta); si no, la primera candidata que exista; si ninguna, la de la carpeta de modelos.
 */
export function rutaModeloWhisper(cual: 'whisper' | 'vad', op: {env?: Entorno; home?: string; existe?: (ruta: string) => boolean} = {}): string {
	const env = op.env ?? process.env;
	const existe = op.existe ?? existsSync;
	const candidatos = candidatosModelo(cual, op);
	const variable = cual === 'whisper' ? env.EDITOR_WHISPER_MODELO : env.EDITOR_VAD_MODELO;
	if (variable?.trim()) return candidatos[0];
	return candidatos.find((c) => existe(c)) ?? candidatos[0];
}
