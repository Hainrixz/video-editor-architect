// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * instalar.ts — deja la computadora lista para el editor (macOS, Windows o Linux).
 *
 *   npx tsx herramientas/instalar.ts                 → revisa qué falta e imprime el PLAN (no instala nada)
 *   npx tsx herramientas/instalar.ts --si            → ejecuta el plan paso a paso
 *   npx tsx herramientas/instalar.ts --solo uv,venv  → solo esas piezas (con o sin --si)
 *   (o: npm run instalar -- --si)
 *
 * Qué revisa: las mismas comprobaciones de doctor.ts (`revisarItems`), más las fuentes OFL y, en macOS, los
 * binarios de Apple Vision. El plan solo trae lo que falta. Cada paso:
 *   - es un arreglo de argumentos (spawn sin shell); su salida se ve en vivo;
 *   - se verifica después volviendo a correr su comprobación;
 *   - si falla, los pasos que no dependen de él siguen; al final sale "listo X de Y (Z omitidos)" y el
 *     siguiente paso concreto (lib/fallo.ts: 2 = falta algo que corres tú, 3 = instalador o descarga externa).
 *
 * Por sistema:
 *   - macOS: Homebrew (si no está, da el comando oficial y no lo instala), `brew install` de ffmpeg, uv, yt-dlp,
 *     whisper-cpp y Chrome (cask). `xcode-select --install` solo se avisa. Compila Apple Vision si hay swiftc.
 *   - Windows: winget (`--id X -e --accept-source-agreements --accept-package-agreements`) para ffmpeg, uv, yt-dlp
 *     y Chrome. whisper.cpp no está en winget: baja el zip oficial de las releases de ggml-org/whisper.cpp,
 *     lo descomprime en la carpeta del editor y fija EDITOR_WHISPER_CLI y EDITOR_VAD_CLI con `setx` (tu usuario).
 *     Node solo se avisa (es lo que está corriendo esto).
 *   - Linux: lo que pide sudo (ffmpeg, Chrome, librerías de Playwright) se imprime para que lo corras tú.
 *     uv con su instalador oficial (sin sudo), whisper.cpp con el build oficial de Ubuntu de sus releases.
 *   - Todos: .venv de Python 3.12 con uv y herramientas/py/requirements.txt, modelos de whisper (large-v3 ~3.1 GB)
 *     y VAD silero a la carpeta de modelos (descarga reanudable, tamaño y sha256 revisados), fuentes OFL
 *     (lib/fuentes-ofl.ts) y el Chromium de Playwright.
 *
 * Nunca usa sudo por su cuenta y nunca pide ni escribe llaves.
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync} from 'node:fs';
import * as http from 'node:http';
import {createRequire} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {contextoDoctor, LLAVES, revisarItems, type Contexto} from './doctor.ts';
import {correr, esPrincipal, fallo, FalloEditor} from './lib/fallo.ts';
import {fuentesFaltantes, prepararFuentes} from './lib/fuentes-ofl.ts';
import {
	binarioVision,
	ejecutable,
	INSTALACION,
	MODELO_VAD,
	MODELO_WHISPER,
	nombreEjecutable,
	pythonVenv,
	RAIZ_PROYECTO,
	rutaModeloWhisper,
	rutaModelos,
	sistema,
	type Sistema,
} from './lib/plataforma.ts';

type Entorno = Record<string, string | undefined>;

// ───────────────────────── piezas ─────────────────────────

export type IdComponente =
	| 'gestor'
	| 'node'
	| 'ffmpeg'
	| 'uv'
	| 'venv'
	| 'fuentes'
	| 'whisper-cpp'
	| 'modelo-vad'
	| 'modelo-whisper'
	| 'yt-dlp'
	| 'chrome'
	| 'chromium-playwright'
	| 'swift'
	| 'vision-swift';

type Componente = {
	id: IdComponente;
	titulo: string;
	sistemas: readonly Sistema[];
	/** Comprobaciones de doctor.ts (`item` de DEPENDENCIAS) que deben pasar. Sin esto, la revisa instalar.ts. */
	items?: readonly string[];
};

const TODOS: readonly Sistema[] = ['mac', 'windows', 'linux'];

/** Lo que el instalador sabe dejar listo, en el orden en que lo instala (lo pesado al final). */
export const COMPONENTES: readonly Componente[] = [
	{id: 'gestor', titulo: 'Gestor de paquetes', sistemas: ['mac', 'windows']},
	{id: 'node', titulo: 'Node ≥ 24', sistemas: TODOS, items: ['Node ≥ 24']},
	{id: 'ffmpeg', titulo: 'ffmpeg y ffprobe', sistemas: TODOS, items: ['ffmpeg', 'ffprobe']},
	{id: 'uv', titulo: 'uv (gestor de Python)', sistemas: TODOS, items: ['uv']},
	{id: 'venv', titulo: '.venv de Python 3.12 (fuentes, OCR y cara)', sistemas: TODOS, items: ['.venv (fonttools + pathops)', 'Visión (OCR, cara, silueta)']},
	{id: 'fuentes', titulo: 'Fuentes OFL (biblioteca/fuentes)', sistemas: TODOS},
	{id: 'whisper-cpp', titulo: 'whisper.cpp (whisper-cli y whisper-vad-speech-segments)', sistemas: TODOS, items: ['whisper-cli', 'whisper-vad-speech-segments']},
	{id: 'modelo-vad', titulo: `Modelo VAD silero (${MODELO_VAD})`, sistemas: TODOS, items: ['VAD silero']},
	{id: 'yt-dlp', titulo: 'yt-dlp (bajar reels de referencia)', sistemas: TODOS, items: ['yt-dlp']},
	{id: 'chrome', titulo: 'Google Chrome', sistemas: TODOS, items: ['Google Chrome']},
	{id: 'chromium-playwright', titulo: 'Chromium de Playwright', sistemas: TODOS, items: ['Chromium de Playwright']},
	{id: 'swift', titulo: 'Swift (Command Line Tools de Xcode)', sistemas: ['mac'], items: ['swiftc']},
	{id: 'vision-swift', titulo: 'Apple Vision (binarios Swift de OCR, cara, silueta y recorte)', sistemas: ['mac']},
	{id: 'modelo-whisper', titulo: `Modelo de whisper large-v3 (${MODELO_WHISPER})`, sistemas: TODOS, items: ['Modelo large-v3']},
];

export const IDS_COMPONENTES: readonly IdComponente[] = COMPONENTES.map((c) => c.id);

export function componentesDe(s: Sistema): Componente[] {
	return COMPONENTES.filter((c) => c.sistemas.includes(s));
}

export function tituloDe(id: IdComponente, s?: Sistema): string {
	if (id === 'gestor' && s) return s === 'mac' ? 'Homebrew' : s === 'windows' ? 'winget' : 'Gestor de paquetes';
	return COMPONENTES.find((c) => c.id === id)?.titulo ?? id;
}

// ───────────────────────── comandos (puros) ─────────────────────────

/** `winget install` con aceptación de acuerdos (sin preguntas a mitad). */
export function argvWinget(id: string): string[] {
	return ['winget', 'install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements'];
}

/** `brew install` (o `--cask` para apps como Chrome). */
export function argvBrew(paquete: string, cask = false): string[] {
	return ['brew', 'install', ...(cask ? ['--cask'] : []), paquete];
}

/** Paquetes de winget por pieza (Windows). */
export const WINGET: Partial<Record<IdComponente, string>> = {
	ffmpeg: 'Gyan.FFmpeg',
	uv: 'astral-sh.uv',
	'yt-dlp': 'yt-dlp.yt-dlp',
	chrome: 'Google.Chrome',
};

/** Paquetes de Homebrew por pieza (macOS). */
export const BREW: Partial<Record<IdComponente, {paquete: string; cask?: boolean}>> = {
	ffmpeg: {paquete: 'ffmpeg'},
	uv: {paquete: 'uv'},
	'yt-dlp': {paquete: 'yt-dlp'},
	'whisper-cpp': {paquete: 'whisper-cpp'},
	chrome: {paquete: 'google-chrome', cask: true},
};

export const INSTALAR_HOMEBREW = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
export const INSTALAR_WINGET = 'instala "App Installer" desde Microsoft Store (trae winget): https://apps.microsoft.com/detail/9NBLGGH4NNS1';
export const URL_UV_LINUX = 'https://astral.sh/uv/install.sh';

export const URL_MODELO_WHISPER = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELO_WHISPER}`;
export const URL_MODELO_VAD = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${MODELO_VAD}`;
/** Tamaños publicados en Hugging Face (x-linked-size, 2026-10-11). Al bajar se vuelven a pedir con su sha256. */
export const BYTES_MODELO_WHISPER = 3_095_033_483;
export const BYTES_MODELO_VAD = 885_098;
/** Lo mínimo para darlos por completos (lo mismo que pide doctor.ts). */
const MINIMO_WHISPER = 2_900_000_000;
const MINIMO_VAD = 100_000;

export const API_RELEASES_WHISPER = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30';

/** Nombre del build oficial de whisper.cpp en sus releases para este sistema y arquitectura (null = no hay). */
export function assetWhisper(s: Sistema, arch: string): string | null {
	if (s === 'windows') return arch === 'x64' ? 'whisper-bin-x64.zip' : arch === 'arm64' ? 'whisper-bin-win-cpu-arm64.zip' : null;
	if (s === 'linux') return arch === 'x64' ? 'whisper-bin-ubuntu-x64.tar.gz' : arch === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : null;
	return null;
}

export type AssetElegido = {tag: string; nombre: string; url: string; bytes: number; sha256?: string};

/**
 * Del JSON de `GET /repos/ggml-org/whisper.cpp/releases` (la más nueva primero), la primera release publicada
 * que trae ese asset. Desde v1.9.3 las releases con etiqueta `v…` salen vacías y los zips viven en las numeradas
 * (`b5454`…), que a veces no traen todos los builds: por eso se recorre hasta encontrarlo.
 */
export function elegirAssetWhisper(releases: unknown, nombre: string): AssetElegido | null {
	if (!Array.isArray(releases)) return null;
	for (const r of releases) {
		if (!r || typeof r !== 'object') continue;
		const rel = r as {tag_name?: unknown; draft?: unknown; assets?: unknown};
		if (rel.draft === true || typeof rel.tag_name !== 'string' || !Array.isArray(rel.assets)) continue;
		for (const a of rel.assets) {
			const asset = a as {name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown; state?: unknown};
			if (asset.name !== nombre || typeof asset.browser_download_url !== 'string') continue;
			if (asset.state !== undefined && asset.state !== 'uploaded') continue;
			if (!asset.browser_download_url.startsWith('https://github.com/ggml-org/whisper.cpp/')) continue;
			const sha = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1]?.toLowerCase() : undefined;
			return {tag: rel.tag_name, nombre, url: asset.browser_download_url, bytes: typeof asset.size === 'number' ? asset.size : 0, ...(sha ? {sha256: sha} : {})};
		}
	}
	return null;
}

// ───────────────────────── plan (puro) ─────────────────────────

export type Accion =
	| {tipo: 'comandos'; argvs: string[][]}
	| {tipo: 'modelo'; cual: 'whisper' | 'vad'; url: string; destino: string}
	| {tipo: 'whisper-release'; asset: string; carpeta: string}
	| {tipo: 'script-remoto'; url: string; interprete: string}
	| {tipo: 'fuentes'}
	| {tipo: 'manual'; instruccion: string};

export type Paso = {
	componente: IdComponente;
	titulo: string;
	accion: Accion;
	/** Piezas que deben estar listas antes. */
	dependeDe: IdComponente[];
	/** Lo que baja, aproximado (para el plan). */
	bytesAprox?: number;
	nota?: string;
};

export type EntradaPlan = {
	s: Sistema;
	arch: string;
	/** ok de cada pieza revisada (las que no aparecen no se planean). */
	estado: Partial<Record<IdComponente, boolean>>;
	raiz: string;
	python: string;
	hayVenv: boolean;
	modeloWhisper: string;
	modeloVad: string;
	carpetaWhisper: string;
	/** cli.js de playwright (null si falta npm ci). */
	playwrightCli: string | null;
	/** Programa de Node (process.execPath). */
	node: string;
};

/** El paso que deja lista una pieza en un sistema (puro). */
export function pasoPara(id: IdComponente, e: EntradaPlan): Paso {
	const {s} = e;
	const base = {componente: id, titulo: tituloDe(id, s)};
	const manual = (instruccion: string, nota?: string): Paso => ({...base, accion: {tipo: 'manual', instruccion}, dependeDe: [], ...(nota ? {nota} : {})});
	const gestor: IdComponente[] = s === 'linux' ? [] : ['gestor'];
	const conGestor = (argv: string[], extra: Partial<Paso> = {}): Paso => ({...base, accion: {tipo: 'comandos', argvs: [argv]}, dependeDe: gestor, ...extra});

	switch (id) {
		case 'gestor':
			return manual(s === 'mac' ? INSTALAR_HOMEBREW : INSTALAR_WINGET, s === 'mac' ? 'Homebrew pide tu contraseña: córrelo tú en la Terminal y vuelve a correr el instalador.' : 'Después abre una terminal nueva y vuelve a correr el instalador.');
		case 'node':
			return manual(s === 'windows' ? formatearArgv(argvWinget('OpenJS.NodeJS.LTS')) : (INSTALACION.node[s] ?? 'instala Node 24 desde https://nodejs.org'), 'Node es lo que está corriendo este instalador: actualízalo tú, abre una terminal nueva y vuelve a correrlo.');
		case 'swift':
			return manual('xcode-select --install', 'Abre una ventana de macOS para aceptar la licencia. Sin Swift, el OCR y la cara usan el motor de Python del .venv.');
		case 'ffmpeg':
		case 'uv':
		case 'yt-dlp':
		case 'chrome':
		case 'whisper-cpp':
			if (s === 'mac') {
				const b = BREW[id]!;
				return conGestor(argvBrew(b.paquete, b.cask), id === 'whisper-cpp' ? {nota: 'Homebrew instala la versión más nueva; los tiempos se calibraron con whisper.cpp 1.8.4 (doctor.ts lo avisa).'} : {});
			}
			if (s === 'windows' && WINGET[id]) return conGestor(argvWinget(WINGET[id]!));
			if (id === 'whisper-cpp') {
				const asset = assetWhisper(s, e.arch);
				if (!asset) return manual(INSTALACION['whisper-cpp'][s] ?? 'compila whisper.cpp');
				return {
					...base,
					accion: {tipo: 'whisper-release', asset, carpeta: e.carpetaWhisper},
					dependeDe: [],
					bytesAprox: s === 'windows' ? 9_000_000 : 11_000_000,
					nota: `Build oficial de github.com/ggml-org/whisper.cpp/releases; ${s === 'windows' ? 'fija EDITOR_WHISPER_CLI y EDITOR_VAD_CLI con setx (solo tu usuario)' : 'te deja la línea export de EDITOR_WHISPER_CLI y EDITOR_VAD_CLI para tu perfil'}. Los tiempos se calibraron con 1.8.4.`,
				};
			}
			if (s === 'linux' && id === 'uv') return {...base, accion: {tipo: 'script-remoto', url: URL_UV_LINUX, interprete: 'sh'}, dependeDe: [], nota: 'Instalador oficial de uv (en tu carpeta de usuario, sin sudo).'};
			if (s === 'linux' && id === 'yt-dlp') return {...base, accion: {tipo: 'comandos', argvs: [['uv', 'tool', 'install', 'yt-dlp']]}, dependeDe: ['uv']};
			return manual(INSTALACION[id === 'chrome' ? 'chrome' : 'ffmpeg'][s] ?? '', 'Pide permisos de administrador: córrelo tú y vuelve a correr el instalador.');
		case 'venv': {
			const req = join(e.raiz, 'herramientas', 'py', 'requirements.txt');
			const argvs = [...(e.hayVenv ? [] : [['uv', 'venv', join(e.raiz, '.venv'), '--python', '3.12']]), ['uv', 'pip', 'install', '--python', e.python, '-r', req]];
			return {...base, accion: {tipo: 'comandos', argvs}, dependeDe: ['uv'], bytesAprox: 250_000_000, nota: 'Python 3.12 (si no lo tienes, uv lo baja) + fonttools, skia-pathops, numpy, onnxruntime, RapidOCR y MediaPipe.'};
		}
		case 'fuentes':
			return {...base, accion: {tipo: 'fuentes'}, dependeDe: ['venv'], bytesAprox: 3_000_000, nota: 'OFL-1.1 de google/fonts en un commit fijo, con sha256.'};
		case 'modelo-whisper':
			return {...base, accion: {tipo: 'modelo', cual: 'whisper', url: URL_MODELO_WHISPER, destino: e.modeloWhisper}, dependeDe: [], bytesAprox: BYTES_MODELO_WHISPER, nota: 'Se puede cortar y retomar: vuelve a correr el instalador y sigue donde se quedó.'};
		case 'modelo-vad':
			return {...base, accion: {tipo: 'modelo', cual: 'vad', url: URL_MODELO_VAD, destino: e.modeloVad}, dependeDe: [], bytesAprox: BYTES_MODELO_VAD};
		case 'chromium-playwright':
			if (!e.playwrightCli) return manual('npm ci && npx playwright install chromium', 'Primero instala lo de Node del proyecto (npm ci).');
			return {
				...base,
				accion: {tipo: 'comandos', argvs: [[e.node, e.playwrightCli, 'install', 'chromium']]},
				dependeDe: [],
				bytesAprox: 170_000_000,
				...(s === 'linux' ? {nota: 'Si al abrirlo faltan librerías del sistema: sudo npx playwright install-deps chromium (lo corres tú).'} : {}),
			};
		case 'vision-swift': {
			const v = (script: string, ...args: string[]) => ['bash', join(e.raiz, 'herramientas', 'vision', script), ...args];
			return {...base, accion: {tipo: 'comandos', argvs: [v('compilar.sh', 'ocr', 'mascara'), v('compilar-cara.sh'), v('compilar-recortar.sh')]}, dependeDe: ['swift']};
		}
	}
}

/** El plan: un paso por pieza que falta, en el orden de COMPONENTES. Las que ya están van en `listos`. */
export function armarPlan(e: EntradaPlan): {pasos: Paso[]; listos: IdComponente[]} {
	const pasos: Paso[] = [];
	const listos: IdComponente[] = [];
	for (const c of componentesDe(e.s)) {
		const ok = e.estado[c.id];
		if (ok === undefined) continue;
		if (ok) listos.push(c.id);
		else pasos.push(pasoPara(c.id, e));
	}
	return {pasos, listos};
}

/** Lista de `--solo` validada (null = todas). */
export function leerSolo(valor: string | undefined, s: Sistema): IdComponente[] | null {
	if (!valor?.trim()) return null;
	const pedidos = valor.split(',').map((x) => x.trim()).filter(Boolean);
	const validos = componentesDe(s).map((c) => c.id as string);
	const malos = pedidos.filter((p) => !validos.includes(p));
	if (malos.length) {
		throw fallo('leer --solo', `no conozco ${malos.join(', ')} en ${s}`, `usa una o varias de: ${validos.join(', ')}`, 2);
	}
	return pedidos as IdComponente[];
}

// ───────────────────────── mostrar (puro) ─────────────────────────

/** Un argumento como se escribiría en la terminal (comillas si trae espacios). Solo para mostrar. */
export function formatearArgv(argv: string[]): string {
	return argv.map((a) => (/[\s"'$&|<>;()]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
}

export function tamano(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
	if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
	return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function corta(ruta: string, home = homedir()): string {
	const base = resolve(home);
	return ruta === base ? '~' : ruta.startsWith(base + sep) ? '~' + ruta.slice(base.length) : ruta;
}

/** Cómo se ve la acción de un paso en el plan. */
export function describirAccion(a: Accion, op: {node?: string; home?: string} = {}): string {
	const c = (r: string) => corta(r, op.home);
	switch (a.tipo) {
		case 'comandos':
			return a.argvs
				.map((argv) => (op.node && argv[0] === op.node && /playwright/.test(argv[1] ?? '') ? `npx playwright ${argv.slice(2).join(' ')}` : formatearArgv(argv.map(c))))
				.join(' ; ');
		case 'modelo':
			return `bajar ${a.url} → ${c(a.destino)}`;
		case 'whisper-release':
			return `bajar ${a.asset} (última release de ggml-org/whisper.cpp) → ${c(a.carpeta)}`;
		case 'script-remoto':
			return `bajar ${a.url} y correrlo con ${a.interprete}`;
		case 'fuentes':
			return 'bajar de google/fonts y sacar las instancias con fonttools del .venv';
		case 'manual':
			return a.instruccion;
	}
}

/** Barra de progreso de texto: `[#####-----]  50%  1.5 GB de 3.1 GB`. */
export function barra(hechos: number, total: number | undefined, ancho = 24): string {
	if (!total || total <= 0) return `${tamano(hechos)}`;
	const f = Math.min(1, Math.max(0, hechos / total));
	const llenos = Math.round(f * ancho);
	return `[${'#'.repeat(llenos)}${'-'.repeat(ancho - llenos)}] ${String(Math.floor(f * 100)).padStart(3)}%  ${tamano(hechos)} de ${tamano(total)}`;
}

export function textoPlan(plan: {pasos: Paso[]; listos: IdComponente[]}, op: {s: Sistema; arch: string; node?: string; home?: string}): string {
	const lineas: string[] = [`Instalador · Claude Editor de Video (${op.s}, ${op.arch})`, ''];
	if (plan.listos.length) lineas.push(`Ya está (${plan.listos.length}): ${plan.listos.map((id) => tituloDe(id, op.s)).join(' · ')}`, '');
	if (!plan.pasos.length) {
		lineas.push('No falta nada. Confírmalo con: npx tsx herramientas/doctor.ts');
		return lineas.join('\n');
	}
	lineas.push(`Falta (${plan.pasos.length} ${plan.pasos.length === 1 ? 'paso' : 'pasos'}):`);
	plan.pasos.forEach((p, i) => {
		const peso = p.bytesAprox ? ` · baja ~${tamano(p.bytesAprox)}` : '';
		const aMano = p.accion.tipo === 'manual' ? ' · LO CORRES TÚ' : '';
		const pendientes = p.dependeDe.filter((d) => !plan.listos.includes(d));
		const dep = pendientes.length ? ` · después de: ${pendientes.map((d) => tituloDe(d, op.s)).join(', ')}` : '';
		lineas.push(`  ${i + 1}. ${p.titulo}${peso}${aMano}${dep}`, `     ${describirAccion(p.accion, op)}`);
		if (p.nota) lineas.push(`     ${p.nota}`);
	});
	const total = plan.pasos.reduce((a, p) => a + (p.accion.tipo === 'manual' ? 0 : (p.bytesAprox ?? 0)), 0);
	const automaticos = plan.pasos.filter((p) => p.accion.tipo !== 'manual').length;
	const gestor = op.s === 'mac' ? 'Homebrew' : op.s === 'windows' ? 'winget' : null;
	const usaGestor = gestor !== null && plan.pasos.some((p) => p.accion.tipo === 'comandos' && p.bytesAprox === undefined);
	const descargas = total > 0 ? `En total baja ~${tamano(total)}${usaGestor ? ` más lo que baje ${gestor}` : ''}` : usaGestor ? `Lo que baja lo dice ${gestor} al instalar` : 'No baja nada';
	lineas.push('', `${descargas} · ${automaticos} ${automaticos === 1 ? 'paso automático' : 'pasos automáticos'}, ${plan.pasos.length - automaticos} a mano.`);
	lineas.push('Nada se instaló todavía. Para hacerlo: npx tsx herramientas/instalar.ts --si');
	return lineas.join('\n');
}

// ───────────────────────── descargas ─────────────────────────

export type Esperado = {bytes?: number; sha256?: string; minimo?: number};

/** ¿La descarga cuadra? Tamaño exacto si se conoce (si no, el mínimo) y sha256 si se publicó. Pura. */
export function verificarDescarga(real: {bytes: number; sha256?: string}, esperado: Esperado): {ok: boolean; motivo?: string} {
	if (esperado.bytes !== undefined && real.bytes !== esperado.bytes) return {ok: false, motivo: `pesa ${real.bytes} bytes y debía pesar ${esperado.bytes}`};
	if (esperado.minimo !== undefined && real.bytes < esperado.minimo) return {ok: false, motivo: `pesa ${real.bytes} bytes, menos de lo mínimo (${esperado.minimo})`};
	if (esperado.sha256 && real.sha256 !== undefined && real.sha256.toLowerCase() !== esperado.sha256.toLowerCase()) {
		return {ok: false, motivo: `su sha256 (${real.sha256.slice(0, 12)}…) no es el publicado (${esperado.sha256.slice(0, 12)}…)`};
	}
	return {ok: true};
}

/** Desde dónde retomar: null = empezar de cero (no hay parcial, o es más grande de lo esperado). Pura. */
export function desdeDonde(bytesParcial: number, esperadoBytes?: number): number | null {
	if (bytesParcial <= 0) return null;
	if (esperadoBytes !== undefined && bytesParcial > esperadoBytes) return null;
	return bytesParcial;
}

/** Tamaño y sha256 que publica Hugging Face en los encabezados de `resolve/` (x-linked-size, x-linked-etag). Pura. */
export function leerInfoHuggingFace(encabezados: {get(nombre: string): string | null}): {bytes?: number; sha256?: string} {
	const bytes = Number(encabezados.get('x-linked-size'));
	const etag = (encabezados.get('x-linked-etag') ?? '').replace(/^W\//, '').replace(/"/g, '');
	return {...(Number.isFinite(bytes) && bytes > 0 ? {bytes} : {}), ...(/^[0-9a-f]{64}$/i.test(etag) ? {sha256: etag.toLowerCase()} : {})};
}

async function infoHuggingFace(url: string): Promise<{bytes?: number; sha256?: string}> {
	try {
		const r = await fetch(url, {method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(30_000)});
		return leerInfoHuggingFace(r.headers);
	} catch {
		return {};
	}
}

async function sha256Archivo(ruta: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const trozo of createReadStream(ruta)) hash.update(trozo as Buffer);
	return hash.digest('hex');
}

/** Baja `url` a `destino` con reanudación (`destino.parcial` + Range), barra de progreso y verificación. */
export async function descargar(url: string, destino: string, esperado: Esperado, que: string): Promise<void> {
	mkdirSync(dirname(destino), {recursive: true});
	const parcial = `${destino}.parcial`;
	const enDisco = existsSync(parcial) ? statSync(parcial).size : 0;
	let desde = desdeDonde(enDisco, esperado.bytes);
	if (desde === null && enDisco > 0) rmSync(parcial, {force: true});
	const yaCompleto = desde !== null && esperado.bytes !== undefined && desde === esperado.bytes;

	if (!yaCompleto) {
		let respuesta: Response;
		try {
			respuesta = await fetch(url, {headers: desde ? {Range: `bytes=${desde}-`} : {}, redirect: 'follow'});
		} catch (error) {
			throw fallo(`bajar ${que}`, `${url} no respondió (${error instanceof Error ? error.message : String(error)})`, 'revisa tu conexión y vuelve a correr el instalador: sigue donde se quedó', 3);
		}
		if (respuesta.status === 200 && desde) desde = null; // el servidor no aceptó el rango: de cero
		if (!(respuesta.status === 200 || respuesta.status === 206) || !respuesta.body) {
			throw fallo(`bajar ${que}`, `${url} respondió ${respuesta.status}`, 'vuelve a intentarlo en un rato; si se repite, bájalo a mano (doctor.ts dice la URL)', 3);
		}
		const largo = Number(respuesta.headers.get('content-length'));
		const total = esperado.bytes ?? (Number.isFinite(largo) && largo > 0 ? largo + (desde ?? 0) : undefined);
		const salida = createWriteStream(parcial, {flags: desde ? 'a' : 'w'});
		let hechos = desde ?? 0;
		let ultimo = 0;
		const tty = process.stderr.isTTY;
		const pintar = (final = false) => {
			const ahora = Date.now();
			if (!final && ahora - ultimo < (tty ? 250 : 15_000)) return;
			ultimo = ahora;
			process.stderr.write(tty ? `\r     ${barra(hechos, total)}   ` : `     ${barra(hechos, total)}\n`);
		};
		try {
			for await (const trozo of respuesta.body as unknown as AsyncIterable<Uint8Array>) {
				hechos += trozo.byteLength;
				if (!salida.write(trozo)) await once(salida, 'drain');
				pintar();
			}
		} catch (error) {
			salida.end();
			throw fallo(`bajar ${que}`, `se cortó la conexión en ${tamano(hechos)} (${error instanceof Error ? error.message : String(error)})`, 'vuelve a correr el instalador: sigue donde se quedó', 3);
		}
		salida.end();
		await once(salida, 'close');
		pintar(true);
		if (tty) process.stderr.write('\n');
	}

	const real = {bytes: statSync(parcial).size, ...(esperado.sha256 ? {sha256: await sha256Archivo(parcial)} : {})};
	const v = verificarDescarga(real, esperado);
	if (!v.ok) {
		rmSync(parcial, {force: true});
		throw fallo(`bajar ${que}`, `el archivo ${v.motivo}`, 'vuelve a correr el instalador para bajarlo de nuevo; si se repite, avísame', 3);
	}
	renameSync(parcial, destino);
}

// ───────────────────────── revisar el equipo ─────────────────────────

/** ¿Responde este programa? (para brew y winget: el alias de winget no siempre se deja ver con stat). */
function responde(programa: string, args: string[]): boolean {
	const r = spawnSync(programa, args, {encoding: 'utf8', timeout: 30_000, windowsHide: true});
	return !r.error && r.status === 0;
}

const BINARIOS_VISION = ['ocr', 'cara', 'mascara', 'recortar'] as const;

export type Revision = {ok: boolean; detalle: string};

/** Revisa una pieza con las comprobaciones de doctor.ts (o las propias del instalador). */
export function revisarComponente(id: IdComponente, ctx: Contexto): Revision {
	const c = COMPONENTES.find((x) => x.id === id)!;
	if (c.items) {
		const chequeos = revisarItems(c.items, ctx);
		const malos = chequeos.filter((x) => !x.ok);
		return {ok: chequeos.length > 0 && malos.length === 0, detalle: (malos.length ? malos : chequeos).map((x) => `${x.item}: ${x.detalle}`).join(' · ')};
	}
	if (id === 'gestor') {
		const [prog, args] = ctx.s === 'mac' ? ['brew', ['--version']] : ['winget', ['--version']];
		const ok = responde(prog as string, args as string[]);
		return {ok, detalle: ok ? `${prog} responde` : `no encontré ${prog}`};
	}
	if (id === 'fuentes') {
		const faltan = fuentesFaltantes(ctx.raiz);
		return {ok: faltan.length === 0, detalle: faltan.length ? `faltan ${faltan.length}: ${faltan.join(', ')}` : 'todas en biblioteca/fuentes'};
	}
	if (id === 'vision-swift') {
		const faltan = BINARIOS_VISION.filter((b) => !existsSync(binarioVision(b, ctx.raiz)));
		return {ok: faltan.length === 0, detalle: faltan.length ? `sin compilar: ${faltan.join(', ')}` : 'ocr, cara, mascara y recortar compilados'};
	}
	return {ok: false, detalle: 'sin comprobación'};
}

/** PATH con las carpetas donde los instaladores dejan programas (para verlos sin abrir otra terminal). Pura. */
export function pathAmpliado(env: Entorno, s: Sistema, home: string, existe: (r: string) => boolean = existsSync): string {
	const sepPath = s === 'windows' ? ';' : ':';
	const actual = env.PATH ?? env.Path ?? '';
	const partes = actual.split(sepPath).filter(Boolean);
	const extra =
		s === 'windows'
			? [join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links')]
			: [...(s === 'mac' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []), join(home, '.local', 'bin'), join(home, '.cargo', 'bin')];
	for (const dir of extra) if (!partes.includes(dir) && existe(dir)) partes.push(dir);
	return partes.join(sepPath);
}

function refrescarPath(s: Sistema): void {
	const nuevo = pathAmpliado(process.env, s, homedir());
	if (s === 'windows' && process.env.Path !== undefined && process.env.PATH === undefined) process.env.Path = nuevo;
	else process.env.PATH = nuevo;
}

function rutaPlaywrightCli(raiz: string): string | null {
	try {
		const cli = join(dirname(createRequire(join(raiz, 'package.json')).resolve('playwright/package.json')), 'cli.js');
		return existsSync(cli) ? cli : null;
	} catch {
		return null;
	}
}

// ───────────────────────── ejecutar ─────────────────────────

/** Entorno de los instaladores: el tuyo sin las llaves (ninguno las necesita). */
function entornoSinLlaves(): NodeJS.ProcessEnv {
	const env = {...process.env};
	for (const n of LLAVES) delete env[n];
	return env;
}

async function correrArgv(argv: string[]): Promise<void> {
	const [programa, ...args] = argv;
	const ruta = /[\\/]/.test(programa) ? programa : (ejecutable(programa) ?? programa);
	console.log(`     $ ${formatearArgv(argv.map((a) => corta(a)))}`);
	const hijo = spawn(ruta, args, {stdio: 'inherit', env: entornoSinLlaves(), windowsHide: false});
	const [codigo, error] = await new Promise<[number | null, NodeJS.ErrnoException | undefined]>((res) => {
		hijo.on('error', (e) => res([null, e as NodeJS.ErrnoException]));
		hijo.on('close', (c) => res([c, undefined]));
	});
	if (error) throw fallo(`correr ${programa}`, error.code === 'ENOENT' ? `no encontré ${programa}` : error.message, 'abre una terminal nueva (para que se actualice el PATH) y vuelve a correr el instalador', 3);
	if (codigo !== 0) throw fallo(`correr ${programa}`, `terminó con código ${codigo} (arriba está su salida)`, 'revisa el mensaje de arriba y vuelve a correr el instalador', 3);
}

function buscarArchivo(dir: string, nombre: string): string | null {
	for (const e of readdirSync(dir, {withFileTypes: true})) {
		const ruta = join(dir, e.name);
		if (e.isFile() && e.name.toLowerCase() === nombre.toLowerCase()) return ruta;
		if (e.isDirectory()) {
			const hallado = buscarArchivo(ruta, nombre);
			if (hallado) return hallado;
		}
	}
	return null;
}

/** Baja el build oficial de whisper.cpp (Windows/Linux), lo descomprime y deja las variables. */
async function instalarWhisperRelease(asset: string, carpeta: string, s: Sistema): Promise<string[]> {
	let releases: unknown;
	try {
		const r = await fetch(API_RELEASES_WHISPER, {headers: {Accept: 'application/vnd.github+json', 'User-Agent': 'editor-instalador'}, signal: AbortSignal.timeout(30_000)});
		if (!r.ok) throw new Error(`respondió ${r.status}`);
		releases = await r.json();
	} catch (error) {
		throw fallo('buscar whisper.cpp', `la API de GitHub no respondió (${error instanceof Error ? error.message : String(error)})`, `vuelve a intentarlo en un rato o ${INSTALACION['whisper-cpp'][s]}`, 3);
	}
	const elegido = elegirAssetWhisper(releases, asset);
	if (!elegido) throw fallo('buscar whisper.cpp', `ninguna de las últimas releases trae ${asset}`, INSTALACION['whisper-cpp'][s] ?? 'compílalo desde github.com/ggml-org/whisper.cpp', 3);
	console.log(`     ${elegido.nombre} de la release ${elegido.tag} (${tamano(elegido.bytes)}${elegido.sha256 ? ', con sha256' : ''})`);
	const temporal = mkdtempSync(join(tmpdir(), 'editor-whisper-'));
	try {
		const archivo = join(temporal, elegido.nombre);
		await descargar(elegido.url, archivo, {...(elegido.bytes ? {bytes: elegido.bytes} : {}), ...(elegido.sha256 ? {sha256: elegido.sha256} : {})}, 'whisper.cpp');
		const destino = join(carpeta, elegido.tag);
		rmSync(destino, {recursive: true, force: true});
		mkdirSync(destino, {recursive: true});
		await correrArgv(['tar', '-xf', archivo, '-C', destino]);
		const cli = buscarArchivo(destino, nombreEjecutable('whisper-cli', s));
		if (!cli) throw fallo('instalar whisper.cpp', `${elegido.nombre} no trae whisper-cli`, INSTALACION['whisper-cpp'][s] ?? 'compílalo', 1);
		const vad = join(dirname(cli), nombreEjecutable('whisper-vad-speech-segments', s));
		process.env.EDITOR_WHISPER_CLI = cli;
		process.env.EDITOR_VAD_CLI = vad;
		const avisos = [`whisper.cpp ${elegido.tag} quedó en ${corta(dirname(cli))}.`];
		if (s === 'windows') {
			await correrArgv(['setx', 'EDITOR_WHISPER_CLI', cli]);
			await correrArgv(['setx', 'EDITOR_VAD_CLI', vad]);
			avisos.push('Fijé EDITOR_WHISPER_CLI y EDITOR_VAD_CLI para tu usuario: abre una terminal nueva (y reinicia Claude Code) para que las vean.');
		} else {
			avisos.push(`Agrega a tu perfil (~/.bashrc o ~/.zshrc): export EDITOR_WHISPER_CLI="${cli}" EDITOR_VAD_CLI="${vad}"`);
		}
		return avisos;
	} finally {
		rmSync(temporal, {recursive: true, force: true});
	}
}

async function correrScriptRemoto(url: string, interprete: string): Promise<void> {
	const temporal = mkdtempSync(join(tmpdir(), 'editor-script-'));
	try {
		const archivo = join(temporal, 'instalar.sh');
		await descargar(url, archivo, {minimo: 100}, url);
		await correrArgv([interprete, archivo]);
	} finally {
		rmSync(temporal, {recursive: true, force: true});
	}
}

/** Corre un paso (lo que no es manual). Devuelve avisos para el resumen. */
async function ejecutarPaso(p: Paso, s: Sistema, raiz: string): Promise<string[]> {
	const a = p.accion;
	switch (a.tipo) {
		case 'comandos':
			for (const argv of a.argvs) await correrArgv(argv);
			return [];
		case 'modelo': {
			const publicado = await infoHuggingFace(a.url);
			const esperado: Esperado = {...publicado, minimo: a.cual === 'whisper' ? MINIMO_WHISPER : MINIMO_VAD};
			if (!publicado.bytes) esperado.bytes = a.cual === 'whisper' ? BYTES_MODELO_WHISPER : BYTES_MODELO_VAD;
			await descargar(a.url, a.destino, esperado, a.cual === 'whisper' ? MODELO_WHISPER : MODELO_VAD);
			return publicado.sha256 ? [] : [`${a.cual === 'whisper' ? MODELO_WHISPER : MODELO_VAD}: revisé su tamaño (Hugging Face no dio el sha256).`];
		}
		case 'whisper-release':
			return instalarWhisperRelease(a.asset, a.carpeta, s);
		case 'script-remoto':
			await correrScriptRemoto(a.url, a.interprete);
			return [];
		case 'fuentes':
			await prepararFuentes({raiz, log: (l) => console.log(`   ${l}`)});
			return [];
		case 'manual':
			return [];
	}
}

export type EstadoPaso = 'listo' | 'fallo' | 'omitido' | 'a-mano';
export type ResultadoPaso = {paso: Paso; estado: EstadoPaso; motivo?: string; codigo?: 1 | 2 | 3};

/** "listo X de Y (Z omitidos)": omitidos = los que no se corrieron (a mano o por una pieza que falta). Pura. */
export function resumen(resultados: ResultadoPaso[]): string {
	const listos = resultados.filter((r) => r.estado === 'listo').length;
	const omitidos = resultados.filter((r) => r.estado === 'omitido' || r.estado === 'a-mano').length;
	const fallos = resultados.filter((r) => r.estado === 'fallo').length;
	return `listo ${listos} de ${resultados.length} (${omitidos} omitidos${fallos ? `, ${fallos} con fallo` : ''})`;
}

async function ejecutarPlan(pasos: Paso[], listosIniciales: IdComponente[], ctx: Contexto): Promise<{resultados: ResultadoPaso[]; avisos: string[]}> {
	const listos = new Set<IdComponente>(listosIniciales);
	const resultados: ResultadoPaso[] = [];
	const avisos: string[] = [];
	for (const [i, p] of pasos.entries()) {
		console.log(`\n▶ ${i + 1}/${pasos.length} · ${p.titulo}`);
		const faltan = p.dependeDe.filter((d) => !listos.has(d));
		if (faltan.length) {
			const motivo = `falta antes: ${faltan.map((d) => tituloDe(d, ctx.s)).join(', ')}`;
			console.log(`   omitido (${motivo})`);
			resultados.push({paso: p, estado: 'omitido', motivo});
			continue;
		}
		if (p.accion.tipo === 'manual') {
			console.log(`   lo corres tú: ${p.accion.instruccion}`);
			resultados.push({paso: p, estado: 'a-mano', motivo: p.accion.instruccion});
			continue;
		}
		try {
			avisos.push(...(await ejecutarPaso(p, ctx.s, ctx.raiz)));
			refrescarPath(ctx.s);
			const v = revisarComponente(p.componente, ctx);
			if (v.ok) {
				listos.add(p.componente);
				console.log(`   ✔ verificado: ${v.detalle}`);
				resultados.push({paso: p, estado: 'listo'});
			} else {
				const motivo = ctx.s === 'windows' ? `${v.detalle} (si se acaba de instalar, abre una terminal nueva: el PATH se actualiza ahí)` : v.detalle;
				console.log(`   ✖ terminó, pero la comprobación no pasa: ${motivo}`);
				resultados.push({paso: p, estado: 'fallo', motivo, codigo: 3});
			}
		} catch (error) {
			const motivo = error instanceof Error ? error.message : String(error);
			console.log(`   ✖ ${motivo}`);
			resultados.push({paso: p, estado: 'fallo', motivo, codigo: error instanceof FalloEditor ? error.codigo : 1});
		}
	}
	return {resultados, avisos};
}

// ───────────────────────── main ─────────────────────────

/** Si hay HTTPS_PROXY (redes de empresa, sandbox), que fetch lo use: Node no lo toma solo. */
function usarProxyDelEntorno(): void {
	const hayProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((n) => process.env[n]);
	const fijar = (http as unknown as {setGlobalProxyFromEnv?: () => void}).setGlobalProxyFromEnv;
	if (hayProxy && typeof fijar === 'function') fijar();
}

export function entradaPlan(ctx: Contexto, estado: Partial<Record<IdComponente, boolean>>, arch: string = process.arch): EntradaPlan {
	const python = pythonVenv({raiz: ctx.raiz, sistema: ctx.s, env: ctx.env});
	return {
		s: ctx.s,
		arch,
		estado,
		raiz: ctx.raiz,
		python,
		hayVenv: existsSync(python),
		modeloWhisper: rutaModeloWhisper('whisper', {env: ctx.env, home: ctx.home}),
		modeloVad: rutaModeloWhisper('vad', {env: ctx.env, home: ctx.home}),
		carpetaWhisper: join(dirname(rutaModelos(ctx.env, ctx.home)), 'whisper'),
		playwrightCli: rutaPlaywrightCli(ctx.raiz),
		node: process.execPath,
	};
}

async function main(): Promise<void> {
	const {values} = parseArgs({options: {si: {type: 'boolean', default: false}, solo: {type: 'string'}, ayuda: {type: 'boolean', short: 'h'}}, allowPositionals: false});
	if (values.ayuda) {
		console.log('Uso: npx tsx herramientas/instalar.ts [--si] [--solo pieza,pieza]\nPiezas: ' + componentesDe(sistema()).map((c) => c.id).join(', '));
		return;
	}
	const ctx = contextoDoctor({raiz: RAIZ_PROYECTO});
	refrescarPath(ctx.s);
	usarProxyDelEntorno();
	const solo = leerSolo(values.solo, ctx.s);
	const ids = componentesDe(ctx.s)
		.map((c) => c.id)
		.filter((id) => !solo || solo.includes(id));
	console.log('Revisando qué hay en esta computadora…');
	const estado: Partial<Record<IdComponente, boolean>> = {};
	for (const id of ids) estado[id] = revisarComponente(id, ctx).ok;
	// Las piezas de las que dependen las pedidas también cuentan como "listas" si ya están.
	const listosFuera = componentesDe(ctx.s)
		.filter((c) => !ids.includes(c.id))
		.filter((c) => ['gestor', 'uv', 'venv', 'swift'].includes(c.id) && revisarComponente(c.id, ctx).ok)
		.map((c) => c.id);

	const plan = armarPlan(entradaPlan(ctx, estado));
	console.log(textoPlan(plan, {s: ctx.s, arch: process.arch, node: process.execPath}));
	if (!values.si || !plan.pasos.length) return;

	const {resultados, avisos} = await ejecutarPlan(plan.pasos, [...plan.listos, ...listosFuera], ctx);
	console.log(`\nResumen: ${resumen(resultados)}`);
	for (const r of resultados.filter((x) => x.estado !== 'listo')) {
		const etiqueta = r.estado === 'fallo' ? '✖' : r.estado === 'a-mano' ? '→ lo corres tú' : '· omitido';
		console.log(`  ${etiqueta} ${r.paso.titulo}: ${r.motivo ?? ''}`);
	}
	for (const a of avisos) console.log(`Nota: ${a}`);
	const fallos = resultados.filter((r) => r.estado === 'fallo');
	const pendientes = resultados.filter((r) => r.estado !== 'listo');
	if (fallos.length) {
		throw fallo(
			'dejar lista la computadora',
			`${fallos.length} ${fallos.length === 1 ? 'paso falló' : 'pasos fallaron'} (${fallos.map((r) => r.paso.componente).join(', ')})`,
			'arregla lo marcado con ✖ (dice qué pasó) y vuelve a correr npx tsx herramientas/instalar.ts --si; lo que ya quedó no se repite',
			fallos[0].codigo ?? 3,
		);
	}
	if (pendientes.length) {
		throw fallo(
			'terminar la instalación',
			`${pendientes.length} ${pendientes.length === 1 ? 'paso queda' : 'pasos quedan'} para ti (${pendientes.map((r) => r.paso.componente).join(', ')})`,
			'corre lo marcado con "lo corres tú", abre una terminal nueva y vuelve a correr npx tsx herramientas/instalar.ts --si',
			2,
		);
	}
	console.log('\nTodo listo. Confírmalo con: npx tsx herramientas/doctor.ts');
}

if (esPrincipal(import.meta.url)) void correr(main);
