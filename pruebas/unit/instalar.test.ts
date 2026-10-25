// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {describe, expect, it} from 'vitest';
import {
	argvBrew,
	argvWinget,
	armarPlan,
	assetWhisper,
	barra,
	BYTES_MODELO_WHISPER,
	componentesDe,
	desdeDonde,
	elegirAssetWhisper,
	formatearArgv,
	leerInfoHuggingFace,
	leerSolo,
	pathAmpliado,
	resumen,
	textoPlan,
	verificarDescarga,
	type EntradaPlan,
	type IdComponente,
	type Paso,
	type ResultadoPaso,
} from '../../herramientas/instalar';
import {archivosFuentes, FAMILIAS_OFL} from '../../herramientas/lib/fuentes-ofl';
import type {Sistema} from '../../herramientas/lib/plataforma';

/** Entrada del plan con comprobaciones simuladas (sin tocar el disco ni la red). */
function entrada(s: Sistema, faltan: IdComponente[] | 'todo', extra: Partial<EntradaPlan> = {}): EntradaPlan {
	const estado = Object.fromEntries(componentesDe(s).map((c) => [c.id, faltan === 'todo' ? false : !faltan.includes(c.id)]));
	return {
		s,
		arch: 'x64',
		estado,
		raiz: '/proyecto',
		python: s === 'windows' ? 'C:\\proyecto\\.venv\\Scripts\\python.exe' : '/proyecto/.venv/bin/python',
		hayVenv: false,
		modeloWhisper: '/casa/.cache/video-editor/modelos/ggml-large-v3.bin',
		modeloVad: '/casa/.cache/video-editor/modelos/ggml-silero-v5.1.2.bin',
		carpetaWhisper: '/casa/.cache/video-editor/whisper',
		playwrightCli: '/proyecto/node_modules/playwright/cli.js',
		node: '/bin/node',
		...extra,
	};
}

const argvsDe = (pasos: Paso[]): string[][] => pasos.flatMap((p) => (p.accion.tipo === 'comandos' ? p.accion.argvs : []));
const paso = (pasos: Paso[], id: IdComponente): Paso => {
	const p = pasos.find((x) => x.componente === id);
	if (!p) throw new Error(`no hay paso para ${id}`);
	return p;
};

describe('argumentos de los gestores', () => {
	it('winget sin preguntas a mitad', () => {
		expect(argvWinget('Gyan.FFmpeg')).toEqual(['winget', 'install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements']);
	});
	it('brew normal y cask', () => {
		expect(argvBrew('ffmpeg')).toEqual(['brew', 'install', 'ffmpeg']);
		expect(argvBrew('google-chrome', true)).toEqual(['brew', 'install', '--cask', 'google-chrome']);
	});
	it('formatearArgv solo pone comillas donde hace falta', () => {
		expect(formatearArgv(['uv', 'pip', 'install', '-r', 'a b/req.txt'])).toBe('uv pip install -r "a b/req.txt"');
	});
});

describe('plan por sistema', () => {
	it('mac: brew para lo de sistema, xcode-select solo avisado y Vision después de Swift', () => {
		const {pasos} = armarPlan(entrada('mac', 'todo'));
		expect(paso(pasos, 'ffmpeg').accion).toEqual({tipo: 'comandos', argvs: [['brew', 'install', 'ffmpeg']]});
		expect(paso(pasos, 'uv').accion).toEqual({tipo: 'comandos', argvs: [['brew', 'install', 'uv']]});
		expect(paso(pasos, 'yt-dlp').accion).toEqual({tipo: 'comandos', argvs: [['brew', 'install', 'yt-dlp']]});
		expect(paso(pasos, 'whisper-cpp').accion).toEqual({tipo: 'comandos', argvs: [['brew', 'install', 'whisper-cpp']]});
		expect(paso(pasos, 'chrome').accion).toEqual({tipo: 'comandos', argvs: [['brew', 'install', '--cask', 'google-chrome']]});
		expect(paso(pasos, 'ffmpeg').dependeDe).toEqual(['gestor']);
		expect(paso(pasos, 'gestor').accion.tipo).toBe('manual');
		expect(paso(pasos, 'swift').accion).toEqual({tipo: 'manual', instruccion: 'xcode-select --install'});
		const vision = paso(pasos, 'vision-swift');
		expect(vision.dependeDe).toEqual(['swift']);
		expect(argvsDe([vision]).map((a) => a[1].split('/').pop())).toEqual(['compilar.sh', 'compilar-cara.sh', 'compilar-recortar.sh']);
	});

	it('mac con todo listo salvo yt-dlp: un solo paso', () => {
		const {pasos, listos} = armarPlan(entrada('mac', ['yt-dlp']));
		expect(pasos.map((p) => p.componente)).toEqual(['yt-dlp']);
		expect(listos).toContain('gestor');
		expect(textoPlan({pasos, listos}, {s: 'mac', arch: 'arm64'})).toContain('brew install yt-dlp');
	});

	it('windows: winget con sus ids, Node solo avisado, whisper del zip oficial y sin Swift', () => {
		const {pasos} = armarPlan(entrada('windows', 'todo'));
		expect(paso(pasos, 'ffmpeg').accion).toEqual({tipo: 'comandos', argvs: [argvWinget('Gyan.FFmpeg')]});
		expect(paso(pasos, 'uv').accion).toEqual({tipo: 'comandos', argvs: [argvWinget('astral-sh.uv')]});
		expect(paso(pasos, 'yt-dlp').accion).toEqual({tipo: 'comandos', argvs: [argvWinget('yt-dlp.yt-dlp')]});
		expect(paso(pasos, 'chrome').accion).toEqual({tipo: 'comandos', argvs: [argvWinget('Google.Chrome')]});
		expect(paso(pasos, 'node').accion.tipo).toBe('manual');
		expect(paso(pasos, 'whisper-cpp').accion).toEqual({tipo: 'whisper-release', asset: 'whisper-bin-x64.zip', carpeta: '/casa/.cache/video-editor/whisper'});
		expect(pasos.some((p) => p.componente === 'swift' || p.componente === 'vision-swift')).toBe(false);
	});

	it('linux: lo de sudo queda a mano; uv con su instalador y yt-dlp con uv', () => {
		const {pasos} = armarPlan(entrada('linux', 'todo'));
		expect(paso(pasos, 'ffmpeg').accion.tipo).toBe('manual');
		expect(paso(pasos, 'chrome').accion.tipo).toBe('manual');
		expect(paso(pasos, 'uv').accion).toEqual({tipo: 'script-remoto', url: 'https://astral.sh/uv/install.sh', interprete: 'sh'});
		expect(paso(pasos, 'yt-dlp')).toMatchObject({accion: {tipo: 'comandos', argvs: [['uv', 'tool', 'install', 'yt-dlp']]}, dependeDe: ['uv']});
		expect(paso(pasos, 'whisper-cpp').accion).toMatchObject({tipo: 'whisper-release', asset: 'whisper-bin-ubuntu-x64.tar.gz'});
		expect(pasos.some((p) => p.componente === 'gestor')).toBe(false);
	});

	it('todos: .venv con uv y Python 3.12, fuentes después del .venv, modelos a la carpeta de modelos', () => {
		for (const s of ['mac', 'windows', 'linux'] as const) {
			const e = entrada(s, 'todo');
			const {pasos} = armarPlan(e);
			const venv = paso(pasos, 'venv');
			expect(venv.dependeDe).toEqual(['uv']);
			expect(argvsDe([venv])).toEqual([
				['uv', 'venv', '/proyecto/.venv', '--python', '3.12'],
				['uv', 'pip', 'install', '--python', e.python, '-r', expect.stringMatching(/requirements\.txt$/)],
			]);
			expect(paso(pasos, 'fuentes').dependeDe).toEqual(['venv']);
			expect(paso(pasos, 'modelo-whisper')).toMatchObject({accion: {tipo: 'modelo', cual: 'whisper', destino: e.modeloWhisper}, bytesAprox: BYTES_MODELO_WHISPER});
			expect(paso(pasos, 'modelo-vad').accion).toMatchObject({tipo: 'modelo', cual: 'vad', destino: e.modeloVad});
			expect(argvsDe([paso(pasos, 'chromium-playwright')])).toEqual([['/bin/node', '/proyecto/node_modules/playwright/cli.js', 'install', 'chromium']]);
			// El modelo pesado va al final.
			expect(pasos.at(-1)?.componente).toBe('modelo-whisper');
		}
	});

	it('con .venv ya creado solo instala los paquetes', () => {
		const {pasos} = armarPlan(entrada('mac', ['venv'], {hayVenv: true}));
		expect(argvsDe(pasos)).toEqual([['uv', 'pip', 'install', '--python', '/proyecto/.venv/bin/python', '-r', expect.stringMatching(/requirements\.txt$/)]]);
	});

	it('sin npm ci, Playwright queda a mano', () => {
		const {pasos} = armarPlan(entrada('linux', ['chromium-playwright'], {playwrightCli: null}));
		expect(pasos[0].accion.tipo).toBe('manual');
	});

	it('nunca arma sudo ni un shell con cadena', () => {
		for (const s of ['mac', 'windows', 'linux'] as const) {
			for (const arch of ['x64', 'arm64']) {
				const argvs = argvsDe(armarPlan(entrada(s, 'todo', {arch})).pasos);
				expect(argvs.length).toBeGreaterThan(0);
				for (const argv of argvs) {
					expect(argv).not.toContain('sudo');
					expect(argv.some((a) => /(^|\s)sudo\s/.test(a))).toBe(false);
					expect(argv.includes('-c')).toBe(false);
					expect(['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell'].includes(argv[0]) && argv.length === 1).toBe(false);
				}
			}
		}
	});

	it('el texto del plan dice lo que baja y que no instaló nada', () => {
		const plan = armarPlan(entrada('windows', ['modelo-whisper', 'modelo-vad']));
		const texto = textoPlan(plan, {s: 'windows', arch: 'x64'});
		expect(texto).toContain('~3.1 GB');
		expect(texto).toContain('Nada se instaló todavía');
		expect(texto).toContain('--si');
	});
});

describe('--solo', () => {
	it('acepta piezas del sistema y rechaza las que no son', () => {
		expect(leerSolo(undefined, 'mac')).toBeNull();
		expect(leerSolo('uv, venv', 'mac')).toEqual(['uv', 'venv']);
		expect(() => leerSolo('swift', 'windows')).toThrow(/swift/);
		expect(() => leerSolo('nada', 'linux')).toThrow(/nada/);
	});
});

describe('whisper.cpp para Windows y Linux', () => {
	const RELEASES = [
		{tag_name: 'v1.9.5', draft: false, prerelease: false, assets: []},
		{
			tag_name: 'b5454',
			draft: false,
			prerelease: true,
			assets: [
				{name: 'whisper-bin-ubuntu-x64.tar.gz', size: 10364195, state: 'uploaded', browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz'},
				{name: 'whisper-bin-win-cuda-12.4.0-x64.zip', size: 684913404, state: 'uploaded', browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip'},
			],
		},
		{tag_name: 'b5200', draft: true, assets: [{name: 'whisper-bin-x64.zip', size: 1, browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5200/whisper-bin-x64.zip'}]},
		{
			tag_name: 'b5130',
			draft: false,
			prerelease: true,
			assets: [
				{
					name: 'whisper-bin-x64.zip',
					size: 8573270,
					state: 'uploaded',
					digest: 'sha256:f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
					browser_download_url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
				},
			],
		},
	];

	it('elige el asset por sistema y arquitectura', () => {
		expect(assetWhisper('windows', 'x64')).toBe('whisper-bin-x64.zip');
		expect(assetWhisper('windows', 'arm64')).toBe('whisper-bin-win-cpu-arm64.zip');
		expect(assetWhisper('linux', 'x64')).toBe('whisper-bin-ubuntu-x64.tar.gz');
		expect(assetWhisper('mac', 'arm64')).toBeNull();
	});

	it('salta releases vacías, borradores y las que no traen el zip; toma su sha256', () => {
		expect(elegirAssetWhisper(RELEASES, 'whisper-bin-x64.zip')).toEqual({
			tag: 'b5130',
			nombre: 'whisper-bin-x64.zip',
			url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
			bytes: 8573270,
			sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
		});
		expect(elegirAssetWhisper(RELEASES, 'whisper-bin-ubuntu-x64.tar.gz')).toMatchObject({tag: 'b5454', bytes: 10364195});
		expect(elegirAssetWhisper(RELEASES, 'whisper-bin-ubuntu-x64.tar.gz')?.sha256).toBeUndefined();
	});

	it('no acepta URLs fuera del repo oficial ni JSON raro', () => {
		const ajeno = [{tag_name: 'b1', assets: [{name: 'whisper-bin-x64.zip', size: 1, browser_download_url: 'https://ejemplo.invalid/whisper-bin-x64.zip'}]}];
		expect(elegirAssetWhisper(ajeno, 'whisper-bin-x64.zip')).toBeNull();
		expect(elegirAssetWhisper({message: 'API rate limit exceeded'}, 'whisper-bin-x64.zip')).toBeNull();
	});
});

describe('descargas', () => {
	it('verifica tamaño exacto, mínimo y sha256', () => {
		expect(verificarDescarga({bytes: 10}, {bytes: 10})).toEqual({ok: true});
		expect(verificarDescarga({bytes: 9}, {bytes: 10}).ok).toBe(false);
		expect(verificarDescarga({bytes: 50}, {minimo: 100}).ok).toBe(false);
		expect(verificarDescarga({bytes: 10, sha256: 'AA'.repeat(32)}, {bytes: 10, sha256: 'aa'.repeat(32)})).toEqual({ok: true});
		expect(verificarDescarga({bytes: 10, sha256: 'bb'.repeat(32)}, {bytes: 10, sha256: 'aa'.repeat(32)}).motivo).toMatch(/sha256/);
	});

	it('retoma un parcial, salvo que sea más grande de lo esperado', () => {
		expect(desdeDonde(0, 100)).toBeNull();
		expect(desdeDonde(40, 100)).toBe(40);
		expect(desdeDonde(40)).toBe(40);
		expect(desdeDonde(140, 100)).toBeNull();
	});

	it('lee tamaño y sha256 de los encabezados de Hugging Face', () => {
		const h = new Headers({'x-linked-size': '3095033483', 'x-linked-etag': '"64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2"'});
		expect(leerInfoHuggingFace(h)).toEqual({bytes: 3095033483, sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2'});
		expect(leerInfoHuggingFace(new Headers({etag: '"abc"'}))).toEqual({});
	});

	it('barra de progreso', () => {
		expect(barra(50, 100, 10)).toBe('[#####-----]  50%  1 KB de 1 KB');
		expect(barra(1.5e9, 3e9, 4)).toBe('[##--]  50%  1.5 GB de 3.0 GB');
		expect(barra(2e6, undefined)).toBe('2 MB');
	});
});

describe('resumen y PATH', () => {
	it('"listo X de Y (Z omitidos)"', () => {
		const p = armarPlan(entrada('linux', 'todo')).pasos;
		const r: ResultadoPaso[] = [
			{paso: p[0], estado: 'listo'},
			{paso: p[1], estado: 'a-mano'},
			{paso: p[2], estado: 'omitido'},
			{paso: p[3], estado: 'listo'},
		];
		expect(resumen(r)).toBe('listo 2 de 4 (2 omitidos)');
		expect(resumen([...r, {paso: p[4], estado: 'fallo'}])).toBe('listo 2 de 5 (2 omitidos, 1 con fallo)');
	});

	it('agrega las carpetas de winget o de ~/.local/bin si existen', () => {
		const existe = () => true;
		expect(pathAmpliado({PATH: 'C:\\Windows', LOCALAPPDATA: 'C:\\L'}, 'windows', 'C:\\casa', existe).split(';')).toHaveLength(2);
		expect(pathAmpliado({PATH: '/usr/bin'}, 'linux', '/casa', existe)).toBe('/usr/bin:/casa/.local/bin:/casa/.cargo/bin');
		expect(pathAmpliado({PATH: '/usr/bin'}, 'linux', '/casa', () => false)).toBe('/usr/bin');
	});
});

describe('fuentes OFL en TypeScript', () => {
	it('cubre lo mismo que los scripts .sh y todo trae sha256', () => {
		expect(archivosFuentes()).toHaveLength(14);
		for (const f of FAMILIAS_OFL) {
			expect(f.ofl.sha256).toMatch(/^[0-9a-f]{64}$/);
			if (Array.isArray(f.instancias)) for (const i of f.instancias) expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
			else expect(f.sha256Fuente).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});
