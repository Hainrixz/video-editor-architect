/**
 * Capa multiplataforma (herramientas/lib/plataforma.ts) y lo que depende del sistema en doctor.ts, grabador/ventana.ts,
 * grabador/estudio.ts y cara.ts (--mascara). Todo puro o con carpetas temporales: corre igual en macOS, Windows y Linux.
 */
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {argumentosMascara} from '../../herramientas/cara.ts';
import {dependenciasDe, filtrosRequeridos, FILTROS_REQUERIDOS, NOTA_REMOTION, cachePlaywright} from '../../herramientas/doctor.ts';
import {carpetaPerfilEstudio} from '../../herramientas/grabador/estudio.ts';
import {argumentosFfmpegVentana, leerArgumentos, rectanguloDeXwininfo} from '../../herramientas/grabador/ventana.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {
	binarioVision,
	buscarEnPath,
	candidatosModelo,
	comandoVision,
	comoInstalar,
	ejecutable,
	faltaParaVision,
	INSTALACION,
	modelosHeredados,
	motorVision,
	nombreEjecutable,
	pythonVenv,
	rutaModeloWhisper,
	rutaModelos,
	scriptVision,
	sistema,
} from '../../herramientas/lib/plataforma.ts';

const temporales: string[] = [];
function carpeta(prefijo: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefijo));
	temporales.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of temporales) rmSync(d, {recursive: true, force: true});
});

describe('sistema y ejecutables', () => {
	it('traduce process.platform', () => {
		expect(sistema('darwin')).toBe('mac');
		expect(sistema('win32')).toBe('windows');
		expect(sistema('linux')).toBe('linux');
		expect(sistema('freebsd')).toBe('linux');
	});

	it('agrega .exe solo en Windows y solo si no trae extensión', () => {
		expect(nombreEjecutable('ffmpeg', 'windows')).toBe('ffmpeg.exe');
		expect(nombreEjecutable('ffmpeg.exe', 'windows')).toBe('ffmpeg.exe');
		expect(nombreEjecutable('ffmpeg', 'mac')).toBe('ffmpeg');
		expect(nombreEjecutable('ffmpeg', 'linux')).toBe('ffmpeg');
	});

	it('busca en el PATH sin shell (y en Windows con PATHEXT)', () => {
		const dir = carpeta('plataforma-path-');
		const prog = join(dir, 'herramienta-x');
		writeFileSync(prog, '#!/bin/sh\n');
		chmodSync(prog, 0o755);
		writeFileSync(join(dir, 'otra.exe'), '');
		if (sistema() !== 'windows') {
			expect(buscarEnPath('herramienta-x', {env: {PATH: `/no/existe:${dir}`}, sistema: 'linux'})).toBe(prog);
			expect(ejecutable('herramienta-x', {env: {PATH: dir}, sistema: 'mac'})).toBe(prog);
		}
		expect(buscarEnPath('otra', {env: {PATH: `C:\\nada;${dir}`, PATHEXT: '.COM;.EXE'}, sistema: 'windows'})).toBe(join(dir, 'otra.exe'));
		expect(buscarEnPath('no-existe-jamas', {env: {PATH: dir}, sistema: 'linux'})).toBeNull();
		expect(ejecutable(join(dir, 'no-hay'))).toBeNull();
	});
});

describe('rutas de modelos y del .venv', () => {
	it('EDITOR_MODELOS manda; si no, ~/.cache/video-editor/modelos', () => {
		expect(rutaModelos({}, '/home/x')).toBe(join('/home/x', '.cache', 'video-editor', 'modelos'));
		expect(rutaModelos({EDITOR_MODELOS: join(tmpdir(), 'm')}, '/home/x')).toBe(join(tmpdir(), 'm'));
	});

	it('Python del .venv según el sistema, o EDITOR_PYTHON', () => {
		expect(pythonVenv({env: {}, sistema: 'mac', raiz: '/r'})).toBe(join('/r', '.venv', 'bin', 'python'));
		expect(pythonVenv({env: {}, sistema: 'windows', raiz: '/r'})).toBe(join('/r', '.venv', 'Scripts', 'python.exe'));
		expect(pythonVenv({env: {EDITOR_PYTHON: '/otro/python'}, sistema: 'linux', raiz: '/r'})).toBe('/otro/python');
	});

	it('modelos de whisper: variable → carpeta de modelos → respaldo heredado (solo si existe)', () => {
		const home = carpeta('plataforma-home-');
		const viejo = join(home, 'Desktop', 'algo', 'sub', 'models');
		mkdirSync(viejo, {recursive: true});
		writeFileSync(join(viejo, 'ggml-large-v3.bin'), 'x');
		expect(modelosHeredados('ggml-large-v3.bin', home)).toEqual([join(viejo, 'ggml-large-v3.bin')]);
		expect(modelosHeredados('ggml-silero-v5.1.2.bin', home)).toEqual([]);

		const env = {EDITOR_MODELOS: join(home, 'modelos')};
		expect(candidatosModelo('whisper', {env, home})).toEqual([join(home, 'modelos', 'ggml-large-v3.bin'), join(viejo, 'ggml-large-v3.bin')]);
		// Sin el de la carpeta de modelos, gana el heredado que existe.
		expect(rutaModeloWhisper('whisper', {env, home})).toBe(join(viejo, 'ggml-large-v3.bin'));
		// Con el de la carpeta de modelos, gana ese.
		mkdirSync(join(home, 'modelos'), {recursive: true});
		writeFileSync(join(home, 'modelos', 'ggml-large-v3.bin'), 'x');
		expect(rutaModeloWhisper('whisper', {env, home})).toBe(join(home, 'modelos', 'ggml-large-v3.bin'));
		// La variable manda aunque no exista (el error dirá esa ruta).
		expect(rutaModeloWhisper('whisper', {env: {...env, EDITOR_WHISPER_MODELO: '/no/hay.bin'}, home})).toBe('/no/hay.bin');
		// Ninguno: la ruta de la carpeta de modelos (para decir dónde ponerlo).
		expect(rutaModeloWhisper('vad', {env, home})).toBe(join(home, 'modelos', 'ggml-silero-v5.1.2.bin'));
	});
});

describe('motor de visión', () => {
	const siempre = () => true;
	const nunca = () => false;

	it('macOS con binario → vision; sin binario, Windows o Linux → python', () => {
		expect(motorVision('ocr', {env: {}, sistema: 'mac', existe: siempre})).toBe('vision');
		expect(motorVision('ocr', {env: {}, sistema: 'mac', existe: nunca})).toBe('python');
		expect(motorVision('cara', {env: {}, sistema: 'windows', existe: siempre})).toBe('python');
		expect(motorVision('mascara', {env: {}, sistema: 'linux', existe: siempre})).toBe('python');
	});

	it('EDITOR_VISION lo fuerza', () => {
		expect(motorVision('ocr', {env: {EDITOR_VISION: 'python'}, sistema: 'mac', existe: siempre})).toBe('python');
		expect(motorVision('ocr', {env: {EDITOR_VISION: 'Vision'}, sistema: 'mac', existe: nunca})).toBe('vision');
		expect(motorVision('ocr', {env: {EDITOR_VISION: 'otra'}, sistema: 'mac', existe: siempre})).toBe('vision');
	});

	it('el comando: binario directo con Vision; python + script con Python (y la carpeta de modelos en su entorno)', () => {
		const v = comandoVision('cara', {env: {}, sistema: 'mac', existe: siempre, raiz: '/r'});
		expect(v).toMatchObject({motor: 'vision', programa: binarioVision('cara', '/r'), prefijo: []});
		const p = comandoVision('ocr', {env: {EDITOR_MODELOS: '/m'}, sistema: 'windows', existe: siempre, raiz: '/r'});
		expect(p.motor).toBe('python');
		expect(p.programa).toBe(join('/r', '.venv', 'Scripts', 'python.exe'));
		expect(p.prefijo).toEqual([scriptVision('ocr', '/r')]);
		expect(p.env.EDITOR_MODELOS).toBe(join('/m'));
		expect(faltaParaVision(p, (r) => r !== p.programa)).toBe(p.programa);
		expect(faltaParaVision(p, siempre)).toBeNull();
	});

	it('los scripts de Python existen en el repo', () => {
		for (const h of ['ocr', 'cara', 'mascara'] as const) expect(faltaParaVision(comandoVision(h, {env: {EDITOR_VISION: 'python', EDITOR_PYTHON: process.execPath}}))).toBeNull();
	});
});

describe('cómo instalar (tabla de datos)', () => {
	it('mac con brew, Windows con winget; whisper.cpp en Windows por los zips oficiales', () => {
		expect(comoInstalar('ffmpeg', 'mac')).toBe('brew install ffmpeg');
		expect(comoInstalar('ffmpeg', 'windows')).toBe('winget install Gyan.FFmpeg');
		expect(comoInstalar('uv', 'windows')).toBe('winget install astral-sh.uv');
		expect(comoInstalar('node', 'windows')).toBe('winget install OpenJS.NodeJS');
		expect(comoInstalar('yt-dlp', 'windows')).toBe('winget install yt-dlp.yt-dlp');
		expect(comoInstalar('whisper-cpp', 'windows')).toMatch(/github\.com\/ggml-org\/whisper\.cpp\/releases/);
		expect(comoInstalar('swift', 'windows')).toMatch(/no hace falta/);
		for (const [dep, porSistema] of Object.entries(INSTALACION)) {
			if (dep !== 'swift') for (const s of ['mac', 'windows', 'linux'] as const) expect(porSistema[s], `${dep} en ${s}`).toBeTruthy();
		}
	});
});

describe('doctor por sistema', () => {
	it('en Windows y Linux no pide swiftc, Retina ni scale_vt', () => {
		for (const s of ['windows', 'linux'] as const) {
			const items = dependenciasDe(s).map((d) => d.item);
			expect(items).not.toContain('swiftc');
			expect(items).not.toContain('Pantalla Retina');
			expect(items).toContain('ffmpeg');
			expect(items).toContain('Visión (OCR, cara, silueta)');
			expect(items).toContain('yt-dlp');
			expect(filtrosRequeridos(s)).not.toContain('scale_vt');
		}
		expect(dependenciasDe('mac').map((d) => d.item)).toEqual(expect.arrayContaining(['swiftc', 'Pantalla Retina']));
		expect(filtrosRequeridos('mac')).toEqual([...FILTROS_REQUERIDOS]);
		expect(NOTA_REMOTION).toMatch(/licencia/);
	});

	it('caché de Playwright por sistema', () => {
		expect(cachePlaywright('mac', '/h', {})).toBe(join('/h', 'Library', 'Caches', 'ms-playwright'));
		expect(cachePlaywright('windows', '/h', {LOCALAPPDATA: '/l'})).toBe(join('/l', 'ms-playwright'));
		expect(cachePlaywright('linux', '/h', {})).toBe(join('/h', '.cache', 'ms-playwright'));
	});
});

describe('grabador de ventana en Windows y Linux (ffmpeg)', () => {
	const RAIZ = '/proyecto';
	const op = leerArgumentos(['--titulo', 'Símbolo del sistema', '--segundos', '2', '--salida', 'demos/d/t.mp4', '--fps', '30'], RAIZ);
	if (op.modo !== 'grabar') throw new Error('modo');

	it('Windows: gdigrab por título, CFR y el número exacto de cuadros', () => {
		const a = argumentosFfmpegVentana(op, 'windows');
		expect(a.slice(a.indexOf('-f'), a.indexOf('-f') + 8)).toEqual(['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1', '-i', 'title=Símbolo del sistema']);
		expect(a[a.indexOf('-frames:v') + 1]).toBe('60');
		expect(a).toContain('-an');
		expect(a.at(-1)).toBe(op.salida);
		expect(a).toContain('-n');
	});

	it('Windows con solo --app: pide --titulo (código 2)', () => {
		const soloApp = leerArgumentos(['--app', 'Terminal', '--segundos', '2', '--salida', 'demos/d/t.mp4'], RAIZ);
		if (soloApp.modo !== 'grabar') throw new Error('modo');
		try {
			argumentosFfmpegVentana(soloApp, 'windows');
			expect.unreachable();
		} catch (e) {
			expect((e as FalloEditor).codigo).toBe(2);
		}
	});

	it('Linux: x11grab sobre el rectángulo de xwininfo', () => {
		const texto = ['xwininfo: Window id: 0x3a00007 "zsh"', '  Absolute upper-left X:  120', '  Absolute upper-left Y:  -4', '  Width: 801', '  Height: 600'].join('\n');
		const r = rectanguloDeXwininfo(texto);
		expect(r).toEqual({x: 120, y: -4, w: 801, h: 600});
		expect(rectanguloDeXwininfo('xwininfo: error: No window with name zsh exists!')).toBeNull();
		const a = argumentosFfmpegVentana(op, 'linux', {rectangulo: r!, pantalla: ':1'});
		expect(a).toEqual(expect.arrayContaining(['x11grab', '-video_size', '801x600', '-i', ':1+120,-4']));
	});
});

describe('perfil del estudio y máscara sin shell', () => {
	it('perfil del estudio en cada sistema', () => {
		expect(carpetaPerfilEstudio('mac', '/h', {})).toBe(join('/h', 'Library', 'Application Support', 'claude-editor', 'estudio-chrome'));
		expect(carpetaPerfilEstudio('windows', '/h', {LOCALAPPDATA: '/l'})).toBe(join('/l', 'claude-editor', 'estudio-chrome'));
		expect(carpetaPerfilEstudio('linux', '/h', {})).toBe(join('/h', '.config', 'claude-editor', 'estudio-chrome'));
	});

	it('la cadena de la máscara son tres arreglos de argumentos (rutas con espacios y comillas tal cual)', () => {
		const base = "/p/mi proyecto/o'base.mp4";
		const a = argumentosMascara(base, '/p/salida.webm', {ancho: 1440, alto: 2560});
		expect(a.entrada).toContain(base);
		expect(a.salida).toContain(base);
		expect(a.mascara).toEqual(['--ancho', '720', '--alto', '1280']);
		expect(a.salida.at(-1)).toBe('/p/salida.webm');
		expect(a.salida.join(' ')).toContain('alphamerge');
	});
});
