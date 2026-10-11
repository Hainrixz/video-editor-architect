/**
 * Pruebas del módulo de ingesta y base:
 * - sondear() contra el fixture real pruebas/fixtures/clip-6s.mp4;
 * - detección de HDR, rotación y VFR con objetos de ffprobe simulados (y con un clip HLG generado al vuelo);
 * - manifest (sha256 por streaming, vigencia de etapas, rutas de salida seguras);
 * - base (cuantización de tramos, filtro de ffmpeg, verificación) y una corrida corta de punta a punta.
 */
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	construirFiltro,
	cuantizarTramos,
	formatoDuracion,
	generarBase,
	leerCortes,
	limiteDeCuadros,
	totalCuadros,
	verificarBase,
} from '../../herramientas/base.ts';
import {argumentosAudio16k, ingerir, slugSugerido} from '../../herramientas/ingesta.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {
	esHdr,
	esVfr,
	fraccion,
	interpretarSondeo,
	normalizarGrados,
	revisarApto,
	rotacionDeMatriz,
	sondear,
	type FfprobeCrudo,
	type StreamCrudo,
} from '../../herramientas/lib/ffprobe.ts';
import {
	RAIZ,
	etapaVigente,
	hashParametros,
	hashearArchivo,
	jsonCanonico,
	leerManifest,
	registrarEtapa,
	rutaSalidaSegura,
	sha256Archivo,
	validarSlug,
} from '../../herramientas/lib/manifest.ts';
import {HAY_FIXTURES} from './requisitos.ts';

const FIXTURE = join(RAIZ, 'pruebas', 'fixtures', 'clip-6s.mp4');

/** Matrices tal cual las imprime ffprobe 8.1 para IMG_3905 (+90) e IMG_4323 (−90). */
const MATRIZ_3905 = '\n00000000:            0      -65536           0\n00000001:        65536           0           0\n00000002:            0   251658240  1073741824\n';
const MATRIZ_4323 = '\n00000000:            0       65536           0\n00000001:       -65536           0           0\n00000002:    141557760           0  1073741824\n';

/** JSON de ffprobe simulado, parecido a IMG_3905 (HEVC 3840×2160, rotación +90, 60 fps, SDR). */
function crudoSimulado(cambios: {video?: Partial<StreamCrudo>; audio?: Partial<StreamCrudo> | null} = {}): FfprobeCrudo {
	const video: StreamCrudo = {
		index: 0,
		codec_type: 'video',
		codec_name: 'hevc',
		width: 3840,
		height: 2160,
		r_frame_rate: '60/1',
		avg_frame_rate: '1185360/19757',
		color_transfer: 'bt709',
		color_primaries: 'bt709',
		color_space: 'bt709',
		pix_fmt: 'yuv420p',
		duration: '164.641667',
		nb_frames: '9878',
		side_data_list: [{side_data_type: 'Display Matrix', displaymatrix: MATRIZ_3905, rotation: 90}],
		...cambios.video,
	};
	const audio: StreamCrudo[] =
		cambios.audio === null
			? []
			: [{index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '164.640000', ...cambios.audio}];
	return {
		streams: [video, ...audio],
		format: {
			duration: '164.641667',
			tags: {creation_time: '2026-08-27T17:30:23.000000Z', 'com.apple.quicktime.creationdate': '2026-08-27T10:30:23-0700'},
		},
	};
}

/** Corre fn y devuelve el FalloEditor que lanzó (o falla la prueba si no lanzó uno). */
function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no lanzó nada');
}

let tmp: string;
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), 'editor-ingesta-'));
});
afterAll(() => {
	rmSync(tmp, {recursive: true, force: true});
});

describe('sondear() con el fixture clip-6s.mp4', () => {
	it.runIf(HAY_FIXTURES)('lee duración, códec, tamaño, rotación, fps, color y audio', async () => {
		const s = await sondear(FIXTURE);
		expect(s.duracion).toBeCloseTo(6, 3);
		expect(s.video).toMatchObject({
			codec: 'h264',
			ancho: 1440,
			alto: 2560,
			rotacion: 0,
			anchoVisible: 1440,
			altoVisible: 2560,
			rFrameRate: '30/1',
			avgFrameRate: '30/1',
			fpsNominal: 30,
			fpsReal: 30,
			vfr: false,
			colorTransfer: 'bt709',
			hdr: false,
			cuadros: 180,
		});
		expect(s.video.duracion).toBeCloseTo(6, 3);
		expect(s.audio).toMatchObject({codec: 'aac', sampleRate: 48000, canales: 2});
		expect(s.creationTime).toBeNull();
		expect(() => revisarApto(s)).not.toThrow();
	});

	it('si el archivo no existe falla con código 2 y una sola frase con siguiente paso', async () => {
		const error = await sondear(join(tmp, 'no-existe.mov')).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		expect((error as FalloEditor).message).toMatch(/^No pude .+: .+\. Siguiente paso: .+\.$/);
	});
});

describe('detección de HDR (objetos simulados)', () => {
	it('esHdr: HLG y PQ sí; bt709, smpte170m y vacío no', () => {
		expect(esHdr('arib-std-b67')).toBe(true);
		expect(esHdr('smpte2084')).toBe(true);
		expect(esHdr('bt709')).toBe(false);
		expect(esHdr('smpte170m')).toBe(false);
		expect(esHdr(null)).toBe(false);
		expect(esHdr(undefined)).toBe(false);
	});

	it('un clip HLG (iPhone con Video HDR) sale hdr=true y revisarApto lo detiene con código 2', () => {
		const s = interpretarSondeo(
			crudoSimulado({video: {color_transfer: 'arib-std-b67', color_primaries: 'bt2020', color_space: 'bt2020nc', pix_fmt: 'yuv420p10le'}}),
			'/x/IMG_9999.MOV',
		);
		expect(s.video.hdr).toBe(true);
		const error = falloDe(() => revisarApto(s));
		expect(error.codigo).toBe(2);
		expect(error.message).toContain('HDR (HLG, arib-std-b67)');
		expect(error.message).toMatch(/^No pude preparar IMG_9999\.MOV: .+\. Siguiente paso: .+\.$/);
	});

	it('un clip PQ (HDR10) también es HDR', () => {
		const s = interpretarSondeo(crudoSimulado({video: {color_transfer: 'smpte2084'}}), '/x/a.mp4');
		expect(s.video.hdr).toBe(true);
		expect(falloDe(() => revisarApto(s)).message).toContain('HDR (PQ, smpte2084)');
	});

	it('SDR bt709 o sin dato de color no es HDR', () => {
		expect(interpretarSondeo(crudoSimulado(), '/x/a.mov').video.hdr).toBe(false);
		const sinColor = interpretarSondeo(crudoSimulado({video: {color_transfer: undefined}}), '/x/a.mov');
		expect(sinColor.video.hdr).toBe(false);
		expect(sinColor.video.colorTransfer).toBeNull();
	});
});

describe('rotación, fps y forma del sondeo (objetos simulados)', () => {
	it('rotación +90 desde side_data y tamaño visible vertical', () => {
		const s = interpretarSondeo(crudoSimulado(), '/x/IMG_3905.MOV');
		expect(s.video).toMatchObject({rotacion: 90, ancho: 3840, alto: 2160, anchoVisible: 2160, altoVisible: 3840});
	});

	it('si ffprobe no trae "rotation", la calcula de la matriz (+90 y −90)', () => {
		expect(rotacionDeMatriz(MATRIZ_3905)).toBeCloseTo(90, 6);
		expect(rotacionDeMatriz(MATRIZ_4323)).toBeCloseTo(-90, 6);
		const s = interpretarSondeo(
			crudoSimulado({video: {side_data_list: [{side_data_type: 'Display Matrix', displaymatrix: MATRIZ_4323}]}}),
			'/x/IMG_4323.MOV',
		);
		expect(s.video.rotacion).toBe(-90);
		expect(s.video.altoVisible).toBe(3840);
		expect(rotacionDeMatriz('basura')).toBeNull();
	});

	it('tag viejo "rotate" (horario) se convierte a la convención de ffprobe', () => {
		const s = interpretarSondeo(crudoSimulado({video: {side_data_list: [], tags: {rotate: '90'}}}), '/x/a.mov');
		expect(s.video.rotacion).toBe(-90);
	});

	it('normalizarGrados lleva todo a (−180, 180]', () => {
		expect(normalizarGrados(270)).toBe(-90);
		expect(normalizarGrados(-270)).toBe(90);
		expect(normalizarGrados(-180)).toBe(180);
		expect(normalizarGrados(360)).toBe(0);
		expect(Object.is(normalizarGrados(-0), 0)).toBe(true);
	});

	it('fps real (avg) y nominal (r); VFR solo si difieren más de 0.5 %', () => {
		const s = interpretarSondeo(crudoSimulado(), '/x/a.mov');
		expect(s.video.fpsNominal).toBe(60);
		expect(s.video.fpsReal).toBeCloseTo(59.997, 3);
		expect(s.video.vfr).toBe(false);
		expect(esVfr(29.99921, 30)).toBe(false);
		expect(esVfr(29, 30)).toBe(true);
		const vfr = interpretarSondeo(crudoSimulado({video: {avg_frame_rate: '2900/100', r_frame_rate: '30/1'}}), '/x/a.mov');
		expect(vfr.video.vfr).toBe(true);
		expect(fraccion('0/0')).toBe(0);
		expect(fraccion('30')).toBe(30);
		expect(fraccion(undefined)).toBe(0);
	});

	it('sin audio → audio null y revisarApto falla con código 2', () => {
		const s = interpretarSondeo(crudoSimulado({audio: null}), '/x/mudo.mov');
		expect(s.audio).toBeNull();
		expect(falloDe(() => revisarApto(s)).codigo).toBe(2);
	});

	it('sin video (o solo carátula) falla con código 2', () => {
		const soloAudio: FfprobeCrudo = {streams: [{codec_type: 'audio', codec_name: 'mp3'}], format: {duration: '1'}};
		expect(falloDe(() => interpretarSondeo(soloAudio, '/x/pop.mp3')).codigo).toBe(2);
		const caratula: FfprobeCrudo = {
			streams: [{codec_type: 'video', codec_name: 'png', width: 10, height: 10, disposition: {attached_pic: 1}}],
			format: {duration: '1'},
		};
		expect(falloDe(() => interpretarSondeo(caratula, '/x/pop.mp3')).codigo).toBe(2);
	});

	it('fecha de grabación y slug sugerido salen del creationdate local del iPhone', () => {
		const s = interpretarSondeo(crudoSimulado(), '/home/x/Downloads/IMG_3905.MOV');
		expect(s.creationTime).toBe('2026-08-27T17:30:23.000000Z');
		expect(s.creationTimeLocal).toBe('2026-08-27T10:30:23-0700');
		expect(slugSugerido(s, '/home/x/Downloads/IMG_3905.MOV', new Date(2020, 0, 1))).toBe('2026-08-27-img-3905');
		expect(() => validarSlug(slugSugerido(s, '/x/Tomá Ñandú (2).MOV', new Date()))).not.toThrow();
	});
});

describe('manifest', () => {
	it('sha256 por streaming coincide con el valor conocido', async () => {
		const ruta = join(tmp, 'abc.txt');
		writeFileSync(ruta, 'abc');
		expect(await sha256Archivo(ruta)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('valida slugs', () => {
		expect(validarSlug('_prueba-f0-3905')).toBe('_prueba-f0-3905');
		expect(validarSlug('2026-10-03-claude-code')).toBe('2026-10-03-claude-code');
		for (const malo of ['', '../fuera', 'con espacio', 'Mayus', '_logs', 'a/b', '-empieza-con-guion']) {
			expect(falloDe(() => validarSlug(malo)).codigo).toBe(2);
		}
	});

	it('el hash de parámetros no depende del orden de las llaves', () => {
		expect(jsonCanonico({b: 1, a: {d: [1, 2], c: null}})).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
		expect(hashParametros({a: 1, b: 2})).toBe(hashParametros({b: 2, a: 1}));
		expect(hashParametros({a: 1})).not.toBe(hashParametros({a: 2}));
	});

	it('etapaVigente: true con mismas entradas y parámetros; false si cambia algo o falta la salida', async () => {
		const proyectos = join(tmp, 'proyectos');
		const entrada = join(tmp, 'entrada.bin');
		writeFileSync(entrada, 'contenido original');
		const salida = join(proyectos, '_vigencia', 'salida.txt');
		const parametros = {crf: 15, tramos: [[0, 90]]};

		expect(await etapaVigente('_vigencia', 'base', [entrada], parametros, proyectos)).toBe(false);
		registrarEtapa('_vigencia', 'base', {estado: 'en-curso', entradas: [await hashearArchivo(entrada)], parametros}, proyectos);
		expect(await etapaVigente('_vigencia', 'base', [entrada], parametros, proyectos)).toBe(false); // aún en curso

		writeFileSync(salida, 'salida');
		const hashSalida = await hashearArchivo(salida, join(proyectos, '_vigencia'));
		expect(hashSalida.ruta).toBe('salida.txt');
		registrarEtapa('_vigencia', 'base', {estado: 'terminada', entradas: [await hashearArchivo(entrada)], parametros, salidas: [hashSalida]}, proyectos);
		const etapa = leerManifest('_vigencia', proyectos)?.etapas.base;
		expect(etapa?.terminado_en).toEqual(expect.any(String));
		expect(etapa?.parametros_sha256).toBe(hashParametros(parametros));

		expect(await etapaVigente('_vigencia', 'base', [entrada], {tramos: [[0, 90]], crf: 15}, proyectos)).toBe(true);
		expect(await etapaVigente('_vigencia', 'base', [entrada], {...parametros, crf: 16}, proyectos)).toBe(false);
		writeFileSync(entrada, 'contenido cambiado');
		expect(await etapaVigente('_vigencia', 'base', [entrada], parametros, proyectos)).toBe(false);
		writeFileSync(entrada, 'contenido original');
		expect(await etapaVigente('_vigencia', 'base', [entrada], parametros, proyectos)).toBe(true);
		rmSync(salida);
		expect(await etapaVigente('_vigencia', 'base', [entrada], parametros, proyectos)).toBe(false);
		expect(await etapaVigente('_vigencia', 'base', [join(tmp, 'no-existe')], parametros, proyectos)).toBe(false);
	});

	it('rutaSalidaSegura no deja escribir fuera del proyecto ni sobre el original', () => {
		const proyectos = join(tmp, 'proyectos');
		const original = join(proyectos, '_seguro', 'crudo.mov');
		expect(rutaSalidaSegura('_seguro', 'base.mp4', original, proyectos)).toBe(join(proyectos, '_seguro', 'base.mp4'));
		expect(falloDe(() => rutaSalidaSegura('_seguro', '../otro/base.mp4', original, proyectos)).codigo).toBe(1);
		expect(falloDe(() => rutaSalidaSegura('_seguro', 'crudo.mov', original, proyectos)).codigo).toBe(1);
	});
});

describe('base: tramos, filtro y verificación', () => {
	it('sin cortes: todo el clip, acotado a lo que dura (IMG_3905 → 4939 cuadros)', () => {
		const s = interpretarSondeo(crudoSimulado(), '/x/IMG_3905.MOV');
		const limite = limiteDeCuadros(s);
		expect(limite).toBe(4939); // floor(min(164.641667, 164.64) × 30)
		expect(cuantizarTramos([{desde: 0, hasta: limite / 30}], limite)).toEqual([{inicio: 0, fin: 4939}]);
	});

	it('cuantiza a cuadro, recorta a la ventana, une los que se tocan y quita los vacíos', () => {
		const tramos = cuantizarTramos(
			[
				{desde: 1.004, hasta: 2.51}, // → 30..75
				{desde: 2.51, hasta: 3}, // se toca con el anterior → se une
				{desde: 5, hasta: 5.01}, // < medio cuadro → vacío
				{desde: 8, hasta: 20}, // la ventana lo corta en 10 s
				{desde: 30, hasta: 40}, // fuera de la ventana
			],
			10_000,
			{desde: 1, hasta: 10},
		);
		expect(tramos).toEqual([
			{inicio: 30, fin: 90},
			{inicio: 240, fin: 300},
		]);
		expect(totalCuadros(tramos)).toBe(120);
		expect(cuantizarTramos([{desde: 100, hasta: 200}], 4939)).toEqual([{inicio: 3000, fin: 4939}]);
	});

	it('tramos encimados, inválidos o vacíos fallan con código 2', () => {
		expect(falloDe(() => cuantizarTramos([{desde: 0, hasta: 5}, {desde: 4, hasta: 8}], 1000)).codigo).toBe(2);
		expect(falloDe(() => cuantizarTramos([{desde: 3, hasta: 2}], 1000)).codigo).toBe(2);
		expect(falloDe(() => cuantizarTramos([{desde: -1, hasta: 2}], 1000)).codigo).toBe(2);
		expect(falloDe(() => cuantizarTramos([{desde: 0, hasta: 5}], 1000, {desde: 50, hasta: 60})).codigo).toBe(2);
	});

	it('el filtro hace fps=30 antes del trim, corta audio en muestras exactas y pone fades de 15 ms dentro de cada tramo', () => {
		const filtro = construirFiltro(
			[
				{inicio: 300, fin: 390},
				{inicio: 450, fin: 541},
			],
			{video: 0, audio: 1},
		);
		expect(filtro).toContain('[0:0]fps=30:start_time=0,split=2[vs0][vs1]');
		expect(filtro).toContain('[0:1]aresample=48000:async=1:first_pts=0,asplit=2[as0][as1]');
		expect(filtro).toContain('[vs0]trim=start_pts=300:end_pts=390,setpts=PTS-STARTPTS[v0]');
		expect(filtro).toContain('[as0]atrim=start_pts=480000:end_pts=624000,asetpts=PTS-STARTPTS,afade=t=in:ss=0:ns=720,afade=t=out:ss=143280:ns=720[a0]');
		expect(filtro).toContain('[as1]atrim=start_pts=720000:end_pts=865600,asetpts=PTS-STARTPTS,afade=t=in:ss=0:ns=720,afade=t=out:ss=144880:ns=720[a1]');
		expect(filtro).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]');
		expect(filtro).toContain('[vc]scale=1440:2560:force_original_aspect_ratio=increase:flags=lanczos,crop=1440:2560,setsar=1,format=yuv420p[vout]');
		// Un tramo de 1 cuadro (1600 muestras): los fades no se enciman.
		expect(construirFiltro([{inicio: 0, fin: 1}], {video: 0, audio: 1})).toContain('afade=t=in:ss=0:ns=720,afade=t=out:ss=880:ns=720');
	});

	it('verificarBase acepta 1440×2560 30/1 con A/V ±1 cuadro y rechaza lo demás', () => {
		const bueno = interpretarSondeo(
			{
				streams: [
					{index: 0, codec_type: 'video', codec_name: 'h264', width: 1440, height: 2560, r_frame_rate: '30/1', avg_frame_rate: '30/1', pix_fmt: 'yuv420p', duration: '164.633333', nb_frames: '4939'},
					{index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '164.633000'},
				],
				format: {duration: '164.633333'},
			},
			'/x/base.mp4',
		);
		const ok = verificarBase(bueno, 4939);
		expect(ok.ok).toBe(true);
		expect(ok.dif_cuadros_audio_video).toBeLessThan(0.02);

		const malo = verificarBase({...bueno, video: {...bueno.video, ancho: 1080, alto: 1920, rFrameRate: '60/1'}, audio: {...bueno.audio!, duracion: 164.7}}, 4939);
		expect(malo.ok).toBe(false);
		expect(malo.problemas.join(' | ')).toMatch(/1080×1920.*60\/1.*difieren/);
		expect(verificarBase(bueno, 4900).ok).toBe(false); // le faltan cuadros
	});

	it('leerCortes acepta {keep: [{desde, hasta}]} y rechaza otras formas con código 2', () => {
		const bueno = join(tmp, 'cortes.json');
		writeFileSync(bueno, JSON.stringify({keep: [{desde: 1, hasta: 2, razon: 'voz'}], version: 1}));
		expect(leerCortes(bueno)).toEqual([{desde: 1, hasta: 2}]);
		const malo = join(tmp, 'cortes-malo.json');
		writeFileSync(malo, JSON.stringify({keep: [[1, 2]]}));
		expect(falloDe(() => leerCortes(malo)).codigo).toBe(2);
		writeFileSync(malo, '{no es json');
		expect(falloDe(() => leerCortes(malo)).codigo).toBe(2);
		expect(falloDe(() => leerCortes(join(tmp, 'no-existe.json'))).codigo).toBe(2);
	});

	it('formatoDuracion nunca escribe "60 s"', () => {
		expect(formatoDuracion(127.4)).toBe('2 min 07 s');
		expect(formatoDuracion(119.6)).toBe('2 min 00 s');
		expect(formatoDuracion(59.9)).toBe('59.9 s');
		expect(formatoDuracion(5.24)).toBe('5.2 s');
	});

	it('audio16k.wav: mono, 16 kHz, PCM 16 bits y alineado a la línea de tiempo del original', () => {
		const args = argumentosAudio16k('/x/IMG_1.MOV', 1, '/p/audio16k.tmp.wav');
		expect(args.join(' ')).toContain('-map 0:1 -vn -af aresample=async=1:first_pts=0 -ac 1 -ar 16000 -c:a pcm_s16le');
		expect(args.at(-1)).toBe('/p/audio16k.tmp.wav');
		expect(args[args.indexOf('-i') + 1]).toBe('/x/IMG_1.MOV');
	});
});

describe.runIf(HAY_FIXTURES)('de punta a punta con el fixture (carpeta temporal)', () => {
	it('ingesta + base de 1 s: 1440×2560, 30/1, 30 cuadros; la segunda vez se reutiliza y con otros parámetros se rehace', async () => {
		const proyectos = join(tmp, 'e2e');
		const antes = await sha256Archivo(FIXTURE);

		const ingesta = await ingerir({ruta: FIXTURE, slug: '_e2e', proyectos});
		expect(ingesta.reutilizada).toBe(false);
		expect(existsSync(join(proyectos, '_e2e', 'audio16k.wav'))).toBe(true);
		expect((await ingerir({ruta: FIXTURE, slug: '_e2e', proyectos})).reutilizada).toBe(true);

		const base = await generarBase({slug: '_e2e', desde: 1, hasta: 2, proyectos});
		expect(base.reutilizada).toBe(false);
		expect(base.verificacion).toMatchObject({ok: true, ancho: 1440, alto: 2560, r_frame_rate: '30/1', rotacion: 0, cuadros: 30});
		expect(base.verificacion!.dif_cuadros_audio_video!).toBeLessThanOrEqual(1);
		expect((await generarBase({slug: '_e2e', desde: 1, hasta: 2, proyectos})).reutilizada).toBe(true);
		const otra = await generarBase({slug: '_e2e', desde: 1, hasta: 2.5, proyectos});
		expect(otra.reutilizada).toBe(false);
		expect(otra.verificacion?.cuadros).toBe(45);

		const manifest = JSON.parse(readFileSync(join(proyectos, '_e2e', 'manifest.json'), 'utf8'));
		expect(manifest.original).toMatchObject({ruta: FIXTURE, sha256: antes, tamano_bytes: expect.any(Number), mtime: expect.any(String)});
		expect(manifest.etapas.base.estado).toBe('terminada');
		expect(await sha256Archivo(FIXTURE)).toBe(antes); // el original no se tocó
		expect(existsSync(join(proyectos, '_e2e', 'clip-6s.mp4'))).toBe(false); // ni se copió
	}, 60_000);

	it('original movido (mismo contenido): solo se actualiza su ruta; otro crudo en el mismo slug pide --forzar', async () => {
		const proyectos = join(tmp, 'movido');
		const a = join(tmp, 'crudo-a.mp4');
		copyFileSync(FIXTURE, a);
		expect((await ingerir({ruta: a, slug: '_movido', proyectos})).reutilizada).toBe(false);

		const b = join(tmp, 'otra-carpeta', 'crudo-a.mp4');
		mkdirSync(join(tmp, 'otra-carpeta'));
		renameSync(a, b);
		expect((await ingerir({ruta: b, slug: '_movido', proyectos})).reutilizada).toBe(true);
		expect(leerManifest('_movido', proyectos)?.original?.ruta).toBe(b);
		const base = await generarBase({slug: '_movido', desde: 0, hasta: 0.5, proyectos}); // lee el original en su ruta nueva
		expect(base.verificacion).toMatchObject({ok: true, cuadros: 15});

		const otro = join(tmp, 'crudo-otro.mp4');
		const generar = spawnSync(
			'ffmpeg',
			['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', otro],
			{encoding: 'utf8'},
		);
		expect(generar.status, generar.stderr).toBe(0);
		const error = await ingerir({ruta: otro, slug: '_movido', proyectos}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		expect((error as FalloEditor).message).toContain('--forzar');

		const forzada = await ingerir({ruta: otro, slug: '_movido', proyectos, forzar: true});
		expect(forzada.reutilizada).toBe(false);
		expect(leerManifest('_movido', proyectos)?.original?.sha256).toBe(await sha256Archivo(otro));
		// La base anterior era del otro crudo: ya no está vigente.
		expect((await generarBase({slug: '_movido', desde: 0, hasta: 0.5, proyectos})).reutilizada).toBe(false);
	}, 60_000);
});

describe('CLI de ingesta con un clip HLG real (generado al vuelo)', () => {
	it('sondear lo marca HDR y el CLI sale con código 2 sin crear el proyecto', async () => {
		const clip = join(tmp, 'hlg.mp4');
		const generar = spawnSync(
			'ffmpeg',
			[
				'-nostdin', '-v', 'error', '-y',
				'-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
				'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
				'-t', '0.5',
				// En ffmpeg 8 las etiquetas de color viajan en los cuadros: setparams las pone y x264 las escribe.
				'-vf', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc',
				'-c:v', 'libx264', '-pix_fmt', 'yuv420p',
				'-c:a', 'aac', clip,
			],
			{encoding: 'utf8'},
		);
		expect(generar.status, generar.stderr).toBe(0);
		const s = await sondear(clip);
		expect(s.video.colorTransfer).toBe('arib-std-b67');
		expect(s.video.hdr).toBe(true);

		const slug = '_prueba-unit-hdr';
		const cli = spawnSync('npx', ['tsx', 'herramientas/ingesta.ts', clip, '--slug', slug], {cwd: RAIZ, encoding: 'utf8'});
		expect(cli.status).toBe(2);
		expect(cli.stderr.trim().split('\n').at(-1)).toMatch(/^No pude preparar hlg\.mp4: es un video HDR \(HLG, arib-std-b67\).+\. Siguiente paso: .+\.$/);
		expect(existsSync(join(RAIZ, 'proyectos', slug))).toBe(false);
	}, 60_000);
});
