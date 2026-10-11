/**
 * doctor.ts — revisa que la computadora (macOS, Windows o Linux) tenga todo lo que el editor necesita.
 *
 * Uso: npx tsx herramientas/doctor.ts
 *
 * Sale con 0 si todo lo obligatorio está y con 2 si falta algo obligatorio.
 * Las llaves, la pantalla Retina (solo macOS) y lo opcional son avisos: no cambian el código de salida.
 * Cada fila que falta dice cómo instalarla EN ESTE SISTEMA (brew en macOS, winget en Windows; ver
 * lib/plataforma.ts → INSTALACION). Las dependencias viven en una tabla de datos (`DEPENDENCIAS`).
 *
 * Llaves: solo dice "presente (archivo)", "presente (entorno)" o "falta".
 * Del archivo ~/.config/claude-editor/.env solo mira si hay una línea `NOMBRE=<algo>`;
 * el valor nunca se guarda ni se imprime. Del entorno solo mira si la variable está definida.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {
	binarioVision,
	comoInstalar,
	ejecutable,
	MODELO_VAD,
	MODELO_WHISPER,
	motorVision,
	pythonVenv,
	rutaModeloWhisper,
	rutaModelos,
	sistema,
	type Sistema,
} from './lib/plataforma';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));

export const FILTROS_REQUERIDOS = [
	'aevalsrc',
	'scale_vt',
	'loudnorm',
	'ebur128',
	'silencedetect',
	'scdet',
	'aspectralstats',
	'astats',
] as const;

export const LLAVES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'APIFY_TOKEN'] as const;

/** scale_vt es de VideoToolbox (solo macOS): en Windows y Linux no se pide. */
export function filtrosRequeridos(s: Sistema = sistema()): string[] {
	return FILTROS_REQUERIDOS.filter((f) => s === 'mac' || f !== 'scale_vt');
}

/** Versiones fijas del .venv (herramientas/py/requirements.txt). */
const PINES_PYTHON = {fonttools: '4.63.0', pathops: '0.9.2'} as const;
/** Versión de whisper.cpp con la que se calibraron los tiempos. */
const WHISPER_FIJO = '1.8.4';

export type Chequeo = {
	item: string;
	ok: boolean;
	obligatorio: boolean;
	/** Versión, ruta o motivo. Nunca lleva valores de llaves. */
	detalle: string;
};

export type EstadoLlave = 'presente (archivo)' | 'presente (entorno)' | 'falta';

export type LlaveRevisada = {
	nombre: string;
	estado: EstadoLlave;
	enArchivo: boolean;
	enEntorno: boolean;
};

type Entorno = Record<string, string | undefined>;

// ───────────────────────── utilidades ─────────────────────────

/** Muestra rutas con ~ en vez de la carpeta del usuario. */
function corta(ruta: string, home = homedir()): string {
	const base = resolve(home);
	return ruta.startsWith(base + sep) || ruta.startsWith(base + '/') ? '~' + ruta.slice(base.length) : ruta;
}

type Resultado = {ok: boolean; salida: string; noExiste: boolean};

/** Corre un comando sin shell y sin las llaves en su entorno (ninguno de estos programas las necesita). */
function ejecutar(comando: string, args: string[], timeoutMs = 30_000): Resultado {
	const env = {...process.env};
	for (const nombre of LLAVES) delete env[nombre];
	const r = spawnSync(comando, args, {
		encoding: 'utf8',
		timeout: timeoutMs,
		env,
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	const codigoError = (r.error as NodeJS.ErrnoException | undefined)?.code;
	return {
		ok: !r.error && r.status === 0,
		salida: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
		noExiste: codigoError === 'ENOENT',
	};
}

function gb(bytes: number): string {
	return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Si un chequeo truena, lo marca ✖ con una frase en vez de tumbar todo el doctor. */
function seguro(item: string, obligatorio: boolean, fn: () => Chequeo): Chequeo {
	try {
		return fn();
	} catch (error) {
		const motivo = error instanceof Error ? error.message.split('\n')[0] : String(error);
		return {item, ok: false, obligatorio, detalle: `no pude revisarlo (${motivo})`};
	}
}

// ───────────────────────── funciones puras (con pruebas) ─────────────────────────

/** Nombres de filtros que faltan en la salida de `ffmpeg -filters`. */
export function filtrosFaltantes(listado: string, requeridos: readonly string[]): string[] {
	const nombres = new Set<string>();
	for (const linea of listado.split('\n')) {
		// Ej.: " .S aspectralstats    A->A       Show frequency…"  ·  " .. aevalsrc   |->A   Generate…"
		const m = /^\s*[A-Z.]{1,4}\s+([A-Za-z0-9_]+)\s+\S*->\S*/.exec(linea);
		if (m) nombres.add(m[1]);
	}
	return requeridos.filter((f) => !nombres.has(f));
}

/**
 * Busca en un config de playwright-cli (a cualquier profundidad; el esquema real los pone en `browser`)
 * lo que haría que Claude use un perfil con sesión o se conecte a tu Chrome:
 * `userDataDir` con valor, `isolated: false` o `cdpEndpoint` con valor.
 */
export function problemasConfigPlaywright(config: unknown): string[] {
	const vistos = new Set<string>();
	const conValor = (v: unknown) => v !== null && v !== undefined && v !== '';
	const visitar = (nodo: unknown, profundidad: number): void => {
		if (profundidad > 32 || nodo === null || typeof nodo !== 'object') return;
		if (Array.isArray(nodo)) {
			for (const x of nodo) visitar(x, profundidad + 1);
			return;
		}
		for (const [clave, valor] of Object.entries(nodo)) {
			if (clave === 'userDataDir' && conValor(valor)) vistos.add('userDataDir');
			if (clave === 'isolated' && (valor === false || valor === 'false')) vistos.add('isolated:false');
			if (clave === 'cdpEndpoint' && conValor(valor)) vistos.add('cdpEndpoint');
			visitar(valor, profundidad + 1);
		}
	};
	visitar(config, 0);
	return ['userDataDir', 'isolated:false', 'cdpEndpoint'].filter((p) => vistos.has(p));
}

/** Revisa los archivos de config de playwright-cli que existan. Solo reporta nombres de clave, nunca valores. */
export function revisarConfigsPlaywright(rutas: string[], home = homedir()): Chequeo {
	const item = 'Config de playwright-cli';
	const hallazgos: string[] = [];
	let revisados = 0;
	for (const ruta of rutas) {
		if (!existsSync(ruta)) continue;
		revisados++;
		let datos: unknown;
		try {
			datos = JSON.parse(readFileSync(ruta, 'utf8'));
		} catch {
			hallazgos.push(`${corta(ruta, home)} no es JSON válido`);
			continue;
		}
		const problemas = problemasConfigPlaywright(datos);
		if (problemas.length) hallazgos.push(`${corta(ruta, home)} trae ${problemas.join(', ')}`);
	}
	if (hallazgos.length) {
		return {
			item,
			ok: false,
			obligatorio: true,
			detalle: `${hallazgos.join('; ')} → quita esas claves (o borra el archivo) para que el navegador quede en memoria`,
		};
	}
	return {
		item,
		ok: true,
		obligatorio: true,
		detalle:
			revisados === 0
				? 'sin config (perfil en memoria por defecto)'
				: `${revisados} config sin userDataDir, isolated:false ni cdpEndpoint`,
	};
}

/** ¿Hay una pantalla Retina conectada? Lee la salida de `system_profiler SPDisplaysDataType` (solo macOS). */
export function detectarRetina(texto: string): {hay: boolean; detalle: string} {
	const lineas = texto.split('\n');
	let pantalla = '';
	let respaldo: string | null = null;
	for (const linea of lineas) {
		const nombre = /^\s{6,}([^:]+):\s*$/.exec(linea);
		if (nombre && nombre[1].trim() !== 'Displays') pantalla = nombre[1].trim();
		const esRetina = /Retina/i.test(linea) || /3024\s*[x×]\s*1964/.test(linea);
		if (!esRetina) continue;
		const limpia = linea.trim();
		if (/^Resolution:/i.test(limpia)) {
			return {hay: true, detalle: `${pantalla ? pantalla + ' · ' : ''}${limpia.replace(/^Resolution:\s*/i, '')}`};
		}
		respaldo ??= `${pantalla ? pantalla + ' · ' : ''}${limpia}`;
	}
	return respaldo ? {hay: true, detalle: respaldo} : {hay: false, detalle: ''};
}

export function rutaArchivoLlaves(home: string): string {
	return join(home, '.config', 'claude-editor', '.env');
}

/**
 * Estado de cada llave sin tocar su valor.
 * - Archivo: una línea `NOMBRE=` (o `export NOMBRE=`) seguida de algo que no esté vacío.
 *   La expresión solo captura el NOMBRE; el valor no sale de la línea leída.
 * - Entorno: la variable está definida y no está vacía.
 * Si está en los dos lados, cuenta el archivo (es la fuente recomendada).
 */
export function estadoLlaves(
	nombres: readonly string[],
	{home, env}: {home: string; env: Entorno},
): LlaveRevisada[] {
	const ruta = rutaArchivoLlaves(home);
	const enArchivo = new Set<string>();
	if (existsSync(ruta)) {
		const asignacion = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(?=\s*(?:"[^"]|'[^']|[^\s"'#]))/;
		for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
			const nombre = asignacion.exec(linea)?.[1];
			if (nombre) enArchivo.add(nombre);
		}
	}
	return nombres.map((nombre) => {
		const archivo = enArchivo.has(nombre);
		const entorno = typeof env[nombre] === 'string' && env[nombre] !== '';
		const estado: EstadoLlave = archivo ? 'presente (archivo)' : entorno ? 'presente (entorno)' : 'falta';
		return {nombre, estado, enArchivo: archivo, enEntorno: entorno};
	});
}

/** Filas de la tabla para las llaves (avisos en la Fase 0) y notas sin valores. */
export function chequeosLlaves({home, env}: {home: string; env: Entorno}): {
	chequeos: Chequeo[];
	notas: string[];
} {
	const revisadas = estadoLlaves(LLAVES, {home, env});
	const chequeos = revisadas.map((l) => ({
		item: l.nombre,
		ok: l.estado !== 'falta',
		obligatorio: false,
		detalle: l.estado,
	}));
	const notas: string[] = [];
	const soloEntorno = revisadas.filter((l) => l.enEntorno && !l.enArchivo).map((l) => l.nombre);
	if (soloEntorno.length) {
		const una = soloEntorno.length === 1;
		notas.push(
			`${soloEntorno.join(' y ')} ${una ? 'está' : 'están'} solo en tu shell: cualquier proceso ${una ? 'la' : 'las'} ve. Recomendado: ${una ? 'pásala' : 'pásalas'} a ~/.config/claude-editor/.env (600) y quita el export de tu perfil.`,
		);
	}
	const enAmbos = revisadas.filter((l) => l.enEntorno && l.enArchivo).map((l) => l.nombre);
	if (enAmbos.length) {
		notas.push(`${enAmbos.join(' y ')} también ${enAmbos.length === 1 ? 'sigue exportada' : 'siguen exportadas'} en tu shell: quita el export.`);
	}
	const ruta = rutaArchivoLlaves(home);
	if (existsSync(ruta)) {
		const permisos = statSync(ruta).mode & 0o777;
		if (permisos & 0o077) {
			notas.push(`${corta(ruta, home)} tiene permisos ${permisos.toString(8)}: déjalo en 600 con chmod 600.`);
		}
	}
	return {chequeos, notas};
}

export function formatearTabla(chequeos: Chequeo[]): string {
	const nombre = (c: Chequeo) => (c.obligatorio ? c.item : `${c.item} (aviso)`);
	const ancho = Math.max(...chequeos.map((c) => nombre(c).length));
	return chequeos.map((c) => `  ${c.ok ? '✔' : '✖'}  ${nombre(c).padEnd(ancho)}  ${c.detalle}`).join('\n');
}

// ───────────────────────── chequeos del sistema ─────────────────────────

function chequeoNode(): Chequeo {
	const version = process.versions.node;
	const mayor = Number(version.split('.')[0]);
	return mayor >= 24
		? {item: 'Node ≥ 24', ok: true, obligatorio: true, detalle: `v${version}`}
		: {item: 'Node ≥ 24', ok: false, obligatorio: true, detalle: `tienes v${version}: instala Node 24 o más nuevo (${comoInstalar('node')})`};
}

function chequeoFfmpeg(s: Sistema): Chequeo {
	const item = 'ffmpeg';
	const requeridos = filtrosRequeridos(s);
	const v = ejecutar('ffmpeg', ['-hide_banner', '-version']);
	if (!v.ok) {
		return {item, ok: false, obligatorio: true, detalle: `no está en tu PATH → ${comoInstalar('ffmpeg', s)}`};
	}
	const version = /ffmpeg version (\S+)/.exec(v.salida)?.[1] ?? '¿?';
	const filtros = ejecutar('ffmpeg', ['-hide_banner', '-filters']);
	const faltan = filtrosFaltantes(filtros.salida, requeridos);
	if (!filtros.ok || faltan.length) {
		return {item, ok: false, obligatorio: true, detalle: `${version} · faltan filtros: ${(filtros.ok ? faltan : ['(no pude listar filtros)']).join(', ')}`};
	}
	return {item, ok: true, obligatorio: true, detalle: `${version} · ${requeridos.length} de ${requeridos.length} filtros (${requeridos.join(', ')})`};
}

function chequeoFfprobe(s: Sistema): Chequeo {
	const v = ejecutar('ffprobe', ['-hide_banner', '-version']);
	if (!v.ok) return {item: 'ffprobe', ok: false, obligatorio: true, detalle: `no está en tu PATH → viene con ffmpeg (${comoInstalar('ffmpeg', s)})`};
	return {item: 'ffprobe', ok: true, obligatorio: true, detalle: /ffprobe version (\S+)/.exec(v.salida)?.[1] ?? 'versión desconocida'};
}

/** whisper-cli no tiene --version: la versión sale de la ruta real de Homebrew (Cellar/whisper-cpp/<v>/), si la hay. */
function versionWhisper(binario: string): string | null {
	try {
		return /whisper[.-]cpp[\\/]([^\\/]+)[\\/]/.exec(realpathSync(binario))?.[1] ?? null;
	} catch {
		return null;
	}
}

function chequeoBinarioWhisper(nombre: string, s: Sistema): Chequeo {
	const variable = nombre === 'whisper-cli' ? process.env.EDITOR_WHISPER_CLI : process.env.EDITOR_VAD_CLI;
	const ruta = variable?.trim() || ejecutable(nombre);
	if (!ruta || !existsSync(ruta)) {
		return {item: nombre, ok: false, obligatorio: true, detalle: `no está en tu PATH → viene con whisper.cpp: ${comoInstalar('whisper-cpp', s)}`};
	}
	const ayuda = ejecutar(ruta, ['-h'], 20_000);
	if (!ayuda.ok) return {item: nombre, ok: false, obligatorio: true, detalle: `${corta(ruta)} no arranca (falló \`-h\`)`};
	const version = versionWhisper(ruta);
	const nota = version && version !== WHISPER_FIJO ? ` (los tiempos se calibraron con ${WHISPER_FIJO})` : '';
	return {item: nombre, ok: true, obligatorio: true, detalle: `${version ?? corta(ruta)}${nota}`};
}

function chequeoArchivo(item: string, ruta: string, minimoBytes: number, comoConseguirlo: string): Chequeo {
	if (!existsSync(ruta)) {
		return {item, ok: false, obligatorio: true, detalle: `no está en ${corta(ruta)} → ${comoConseguirlo}`};
	}
	const tamano = statSync(ruta).size;
	if (tamano < minimoBytes) {
		return {item, ok: false, obligatorio: true, detalle: `${corta(ruta)} pesa ${tamano} bytes y parece incompleto → ${comoConseguirlo}`};
	}
	return {item, ok: true, obligatorio: true, detalle: `${corta(ruta)} (${tamano >= 1e8 ? gb(tamano) : `${Math.round(tamano / 1024)} KB`})`};
}

function chequeoSwift(): Chequeo {
	const v = ejecutar('swiftc', ['--version']);
	if (!v.ok) {
		return {item: 'swiftc', ok: false, obligatorio: false, detalle: `no responde → ${comoInstalar('swift', 'mac')} (sin él se usa el motor de visión en Python)`};
	}
	return {item: 'swiftc', ok: true, obligatorio: false, detalle: `Swift ${/Swift version (\S+)/.exec(v.salida)?.[1] ?? '¿?'}`};
}

function chequeoUv(s: Sistema): Chequeo {
	const v = ejecutar('uv', ['--version']);
	if (!v.ok) return {item: 'uv', ok: false, obligatorio: true, detalle: `no está en tu PATH → ${comoInstalar('uv', s)}`};
	return {item: 'uv', ok: true, obligatorio: true, detalle: /uv (\S+)/.exec(v.salida)?.[1] ?? 'versión desconocida'};
}

function chequeoYtDlp(s: Sistema): Chequeo {
	const v = ejecutar('yt-dlp', ['--version']);
	if (!v.ok) return {item: 'yt-dlp', ok: false, obligatorio: false, detalle: `no está en tu PATH (hace falta para bajar reels de referencia) → ${comoInstalar('yt-dlp', s)}`};
	return {item: 'yt-dlp', ok: true, obligatorio: false, detalle: v.salida.trim().split(/\s+/)[0] || 'versión desconocida'};
}

const INSTALAR_VENV = 'uv venv .venv --python 3.12 y uv pip install --python <python del .venv> -r herramientas/py/requirements.txt';

function chequeoVenv(raiz: string, s: Sistema): Chequeo {
	const item = '.venv (fonttools + pathops)';
	const instalar = `corre ${INSTALAR_VENV}`;
	const python = pythonVenv({raiz, sistema: s});
	if (!existsSync(python)) return {item, ok: false, obligatorio: true, detalle: `no existe .venv → ${instalar}`};
	const r = ejecutar(python, ['-c', 'import sys, fontTools, pathops; print(sys.version.split()[0], fontTools.version, pathops.__version__)']);
	if (!r.ok) return {item, ok: false, obligatorio: true, detalle: `no importa fontTools o pathops → ${instalar}`};
	const [py, fonttools, pathops] = r.salida.trim().split(/\s+/);
	const instancer = ejecutar(python, ['-m', 'fontTools', 'varLib.instancer', '--help']);
	if (!instancer.ok) return {item, ok: false, obligatorio: true, detalle: `\`fonttools varLib.instancer --help\` falla → ${instalar}`};
	const detalle = `Python ${py} · fonttools ${fonttools} · skia-pathops ${pathops}`;
	if (fonttools !== PINES_PYTHON.fonttools || pathops !== PINES_PYTHON.pathops) {
		return {item, ok: false, obligatorio: true, detalle: `${detalle}, pero se fijan ${PINES_PYTHON.fonttools} y ${PINES_PYTHON.pathops} → ${instalar}`};
	}
	return {item, ok: true, obligatorio: true, detalle};
}

/** Motor de visión (OCR, cara, silueta): binarios de Apple Vision en macOS o paquetes de Python. */
function chequeoVision(raiz: string, s: Sistema): Chequeo {
	const item = 'Visión (OCR, cara, silueta)';
	const herramientas = ['ocr', 'cara', 'mascara'] as const;
	const motores = herramientas.map((h) => motorVision(h, {sistema: s, raiz}));
	if (motores.every((m) => m === 'vision')) {
		return {item, ok: true, obligatorio: true, detalle: 'Apple Vision (herramientas/bin/ocr, cara y mascara compilados)'};
	}
	const python = pythonVenv({raiz, sistema: s});
	const instalar = `corre ${INSTALAR_VENV}`;
	if (!existsSync(python)) return {item, ok: false, obligatorio: true, detalle: `motor Python sin .venv → ${instalar}`};
	const r = ejecutar(python, ['-c', 'import rapidocr_onnxruntime, mediapipe, numpy; print(mediapipe.__version__)'], 60_000);
	if (!r.ok) return {item, ok: false, obligatorio: true, detalle: `motor Python: no importa rapidocr-onnxruntime o mediapipe → ${instalar}`};
	const faltanBin = s === 'mac' ? herramientas.filter((h) => !existsSync(binarioVision(h, raiz))) : [];
	const nota = faltanBin.length ? ` (en macOS puedes compilar Apple Vision: sh herramientas/vision/compilar.sh y compilar-cara.sh)` : '';
	return {item, ok: true, obligatorio: true, detalle: `RapidOCR + MediaPipe ${r.salida.trim().split(/\s+/).pop()} · modelos en ${corta(rutaModelos())}${nota}`};
}

/** Alineación forzada (herramientas/alinear.py): opcional, se baja su modelo de Hugging Face la primera vez. */
function chequeoAlinear(raiz: string, s: Sistema): Chequeo {
	const item = 'Alineación (alinear.py)';
	const python = pythonVenv({raiz, sistema: s});
	const r = existsSync(python) ? ejecutar(python, ['-c', 'import ctc_forced_aligner, onnxruntime']) : {ok: false, salida: '', noExiste: true};
	return r.ok
		? {item, ok: true, obligatorio: false, detalle: 'ctc-forced-aligner + onnxruntime (el modelo se baja la primera vez a ~/.cache/huggingface)'}
		: {item, ok: false, obligatorio: false, detalle: 'falta ctc-forced-aligner en el .venv (solo para alinear un texto al audio) → uv pip install --python <python del .venv> ctc-forced-aligner==1.0.2'};
}

function chequeoChrome(home: string, s: Sistema, env: Entorno): Chequeo {
	const item = 'Google Chrome';
	const instalar = comoInstalar('chrome', s);
	if (s === 'mac') {
		const apps = ['/Applications/Google Chrome.app', join(home, 'Applications', 'Google Chrome.app')];
		const app = apps.find((a) => existsSync(join(a, 'Contents', 'MacOS', 'Google Chrome')));
		if (!app) return {item, ok: false, obligatorio: true, detalle: `no está en /Applications → ${instalar}`};
		const v = ejecutar('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]);
		return {item, ok: true, obligatorio: true, detalle: v.ok ? v.salida.trim() : corta(app, home)};
	}
	if (s === 'windows') {
		const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((b): b is string => !!b);
		const exe = bases.map((b) => join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((r) => existsSync(r));
		return exe ? {item, ok: true, obligatorio: true, detalle: corta(exe, home)} : {item, ok: false, obligatorio: true, detalle: `no lo encuentro → ${instalar}`};
	}
	const bin = ['google-chrome', 'google-chrome-stable'].map((n) => ejecutable(n)).find(Boolean);
	if (!bin) return {item, ok: false, obligatorio: true, detalle: `no está en tu PATH → ${instalar}`};
	const v = ejecutar(bin, ['--version']);
	return {item, ok: true, obligatorio: true, detalle: v.ok ? v.salida.trim() : bin};
}

/** Carpeta de navegadores de Playwright en cada sistema. */
export function cachePlaywright(s: Sistema, home: string, env: Entorno): string {
	if (s === 'mac') return join(home, 'Library', 'Caches', 'ms-playwright');
	if (s === 'windows') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
	return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright');
}

/** La revisión de Chromium que pide el playwright fijado del proyecto, leída de su browsers.json. */
function chequeoChromiumPlaywright(raiz: string, home: string, s: Sistema, env: Entorno): Chequeo {
	const item = 'Chromium de Playwright';
	const requerir = createRequire(join(raiz, 'package.json'));
	const pkgPlaywright = requerir.resolve('playwright/package.json');
	const versionPlaywright = JSON.parse(readFileSync(pkgPlaywright, 'utf8')).version as string;
	const pkgCore = createRequire(pkgPlaywright).resolve('playwright-core/package.json');
	const navegadores = JSON.parse(readFileSync(join(dirname(pkgCore), 'browsers.json'), 'utf8')) as {
		browsers: {name: string; revision: string; browserVersion?: string}[];
	};
	const chromium = navegadores.browsers.find((b) => b.name === 'chromium');
	if (!chromium) return {item, ok: false, obligatorio: true, detalle: `playwright ${versionPlaywright} no declara Chromium`};
	const variable = env.PLAYWRIGHT_BROWSERS_PATH;
	const cache = variable === '0' ? join(dirname(pkgCore), '.local-browsers') : variable ? variable : cachePlaywright(s, home, env);
	const carpeta = join(cache, `chromium-${chromium.revision}`);
	if (!existsSync(join(carpeta, 'INSTALLATION_COMPLETE'))) {
		return {
			item,
			ok: false,
			obligatorio: true,
			detalle: `falta chromium-${chromium.revision} (playwright ${versionPlaywright}) en ${corta(cache, home)} → corre \`npx playwright install chromium\` (descarga gratis)`,
		};
	}
	return {item, ok: true, obligatorio: true, detalle: `chromium-${chromium.revision}${chromium.browserVersion ? ` (${chromium.browserVersion})` : ''} para playwright ${versionPlaywright}`};
}

function chequeoRetina(): Chequeo {
	const r = ejecutar('system_profiler', ['SPDisplaysDataType'], 60_000);
	if (!r.ok) return {item: 'Pantalla Retina', ok: false, obligatorio: false, detalle: 'no pude leer system_profiler'};
	const retina = detectarRetina(r.salida);
	return retina.hay
		? {item: 'Pantalla Retina', ok: true, obligatorio: false, detalle: retina.detalle}
		: {item: 'Pantalla Retina', ok: false, obligatorio: false, detalle: 'no la veo: si es una laptop, abre la tapa (sirve para grabar demos nítidas; sin ella se fuerza DPR 2)'};
}

/** Aviso fijo: Remotion tiene su propia licencia. */
export const NOTA_REMOTION =
	'Remotion es gratis para personas y empresas chicas; una empresa con más de 3 empleados necesita su licencia de empresa (https://www.remotion.dev/license).';

// ───────────────────────── tabla de dependencias ─────────────────────────

export type Contexto = {home: string; env: Entorno; raiz: string; s: Sistema};

export type Dependencia = {
	item: string;
	obligatorio: boolean;
	/** Sistemas donde se revisa (los demás la saltan). */
	sistemas: readonly Sistema[];
	revisar: (c: Contexto) => Chequeo;
};

const TODOS: readonly Sistema[] = ['mac', 'windows', 'linux'];

/** Lo que el editor necesita, en datos: qué, si es obligatorio, en qué sistemas y cómo se revisa. */
export const DEPENDENCIAS: readonly Dependencia[] = [
	{item: 'Node ≥ 24', obligatorio: true, sistemas: TODOS, revisar: () => chequeoNode()},
	{item: 'ffmpeg', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoFfmpeg(c.s)},
	{item: 'ffprobe', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoFfprobe(c.s)},
	{item: 'whisper-cli', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoBinarioWhisper('whisper-cli', c.s)},
	{
		item: 'Modelo large-v3',
		obligatorio: true,
		sistemas: TODOS,
		revisar: (c) => chequeoArchivo('Modelo large-v3', rutaModeloWhisper('whisper', {env: c.env, home: c.home}), 2_900_000_000, `${comoInstalar('modelo-whisper', c.s)} (${MODELO_WHISPER})`),
	},
	{
		item: 'VAD silero',
		obligatorio: true,
		sistemas: TODOS,
		revisar: (c) => chequeoArchivo('VAD silero', rutaModeloWhisper('vad', {env: c.env, home: c.home}), 100_000, `${comoInstalar('modelo-vad', c.s)} (${MODELO_VAD})`),
	},
	{item: 'whisper-vad-speech-segments', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoBinarioWhisper('whisper-vad-speech-segments', c.s)},
	{item: 'uv', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoUv(c.s)},
	{item: '.venv (fonttools + pathops)', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoVenv(c.raiz, c.s)},
	{item: 'Visión (OCR, cara, silueta)', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoVision(c.raiz, c.s)},
	{item: 'swiftc', obligatorio: false, sistemas: ['mac'], revisar: () => chequeoSwift()},
	{item: 'yt-dlp', obligatorio: false, sistemas: TODOS, revisar: (c) => chequeoYtDlp(c.s)},
	{item: 'Alineación (alinear.py)', obligatorio: false, sistemas: TODOS, revisar: (c) => chequeoAlinear(c.raiz, c.s)},
	{item: 'Google Chrome', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoChrome(c.home, c.s, c.env)},
	{item: 'Chromium de Playwright', obligatorio: true, sistemas: TODOS, revisar: (c) => chequeoChromiumPlaywright(c.raiz, c.home, c.s, c.env)},
	{
		item: 'Config de playwright-cli',
		obligatorio: true,
		sistemas: TODOS,
		revisar: (c) => revisarConfigsPlaywright([join(c.raiz, '.playwright', 'cli.config.json'), join(c.home, '.playwright', 'cli.config.json')], c.home),
	},
	{item: 'Pantalla Retina', obligatorio: false, sistemas: ['mac'], revisar: () => chequeoRetina()},
];

/** Las dependencias que aplican en un sistema (pura). */
export function dependenciasDe(s: Sistema): Dependencia[] {
	return DEPENDENCIAS.filter((d) => d.sistemas.includes(s));
}

/** Contexto de este equipo (o con lo que inyectes). Lo usa también instalar.ts. */
export function contextoDoctor(op: Partial<Contexto> = {}): Contexto {
	return {home: op.home ?? homedir(), env: op.env ?? (process.env as Entorno), raiz: op.raiz ?? RAIZ, s: op.s ?? sistema()};
}

/**
 * Corre solo las comprobaciones con esos nombres (`item` de DEPENDENCIAS) que apliquen en el sistema del contexto.
 * Las que no aplican no salen. instalar.ts la usa para saber qué falta y para verificar después de cada paso.
 */
export function revisarItems(items: readonly string[], contexto: Contexto = contextoDoctor()): Chequeo[] {
	return dependenciasDe(contexto.s)
		.filter((d) => items.includes(d.item))
		.map((d) => seguro(d.item, d.obligatorio, () => d.revisar(contexto)));
}

// ───────────────────────── diagnóstico completo ─────────────────────────

export function diagnosticar({
	home = homedir(),
	env = process.env as Entorno,
	raiz = RAIZ,
	s = sistema(),
}: {home?: string; env?: Entorno; raiz?: string; s?: Sistema} = {}): {chequeos: Chequeo[]; notas: string[]} {
	const llaves = chequeosLlaves({home, env});
	const contexto: Contexto = {home, env, raiz, s};
	const chequeos: Chequeo[] = [...dependenciasDe(s).map((d) => seguro(d.item, d.obligatorio, () => d.revisar(contexto))), ...llaves.chequeos];
	return {chequeos, notas: [...llaves.notas, NOTA_REMOTION]};
}

async function main(): Promise<void> {
	const {chequeos, notas} = diagnosticar();
	console.log(`Doctor · Claude Editor de Video (${sistema()})\n`);
	console.log(formatearTabla(chequeos));
	const obligatorios = chequeos.filter((c) => c.obligatorio);
	const faltan = obligatorios.filter((c) => !c.ok);
	const avisos = chequeos.filter((c) => !c.obligatorio);
	console.log(
		`\nObligatorio: ${obligatorios.length - faltan.length} de ${obligatorios.length} ✔ · Avisos: ${avisos.filter((c) => c.ok).length} de ${avisos.length} ✔ (no cambian el código de salida)`,
	);
	for (const nota of notas) console.log(`Nota: ${nota}`);
	if (faltan.length) {
		throw fallo(
			'dejar listo tu entorno',
			`falta lo obligatorio en ${faltan.length} ${faltan.length === 1 ? 'punto' : 'puntos'} (${faltan.map((c) => c.item).join(', ')})`,
			'arregla lo marcado con ✖ (cada fila dice cómo) y vuelve a correr npx tsx herramientas/doctor.ts',
			2,
		);
	}
}

if (esPrincipal(import.meta.url)) void correr(main);
