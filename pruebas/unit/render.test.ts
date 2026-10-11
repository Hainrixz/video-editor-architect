/**
 * Pruebas de la salida de la Fase 1:
 * - render.ts: parseo de loudnorm (1ª pasada) y de ebur128, filtros de la 2ª pasada, TP del reintento,
 *   versiones de la EDL, y que una EDL inválida se rechaza con código 2 ANTES de renderizar (en proceso, con
 *   un motor falso que registra si lo llamaron, y como CLI);
 * - ajustar.ts: diff JSON por id (las 2 órdenes de prueba del plan dan exactamente 2 cambios) y versiones inmutables;
 * - lib/reporte.ts: "cumple X de Y checks (Z N/A)" y reporte.md;
 * - qa.ts: verificación del MP4, stills en el cuadro exacto y hoja de contacto;
 * - lib/ab.ts: ΔE2000 (datos de Sharma et al. 2005), colores, checks de subtítulos, texto y duración.
 * Nada de esto abre Chrome ni usa la GPU: corre dentro del sandbox.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {ajustar, diffJson, formatearDiff} from '../../herramientas/ajustar.ts';
import {cargarMedir, checkDuracion, checksSubtitulos, colorALab, compararTextos, deltaE2000, extraerResumen, srgbALab} from '../../herramientas/lib/ab.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import type {Sondeo} from '../../herramientas/lib/ffprobe.ts';
import {RAIZ, leerManifest} from '../../herramientas/lib/manifest.ts';
import {actualizarReporte, contarChecks, crearCheck, fraseConteo, generarMarkdown, leerReporte, type Check} from '../../herramientas/lib/reporte.ts';
import {expresionSelect, extraerStills, hojasDeContacto, HOJA, registrarVeredicto, STILLS_POR_PASADA, stillsDeSubtitulos, verificarVideo} from '../../herramientas/qa.ts';
import {
	elegirVersion,
	filtroLoudnormAplicar,
	filtroLoudnormMedir,
	notaLoudness,
	parsearEbur128,
	parsearLoudnorm,
	renderizar,
	tpDeReintento,
	versionesEdicion,
	type Motor,
} from '../../herramientas/render.ts';
import {HAY_FUENTES} from './requisitos.ts';

const EDL = JSON.parse(readFileSync(join(RAIZ, 'pruebas', 'edl', 'f0-3s.json'), 'utf8'));
const clonar = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const tmp = mkdtempSync(join(tmpdir(), 'render-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

/** stderr real de ffmpeg 8.1 (1ª pasada de loudnorm sobre los primeros 3 s de pruebas/fixtures/clip-6s.mp4). */
const STDERR_LOUDNORM = `      handler_name    : Core Media Audio
[Parsed_loudnorm_0 @ 0x77eac2cb40]
{
	"input_i" : "-26.91",
	"input_tp" : "-11.57",
	"input_lra" : "0.00",
	"input_thresh" : "-45.92",
	"output_i" : "-21.55",
	"output_tp" : "-1.50",
	"output_lra" : "0.00",
	"output_thresh" : "-37.17",
	"normalization_type" : "dynamic",
	"target_offset" : "7.55"
}
[out#0/null @ 0x77eac2c3c0] video:0KiB audio:2250KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
size=N/A time=00:00:03.00 bitrate=N/A speed=54.6x elapsed=0:00:00.05`;

/** stderr real de ffmpeg 8.1 con ebur128=peak=true (mismo clip). */
const STDERR_EBUR128 = `[Parsed_ebur128_0 @ 0x7770c0d140] t: 2.9      TARGET:-23 LUFS    M: -30.1 S: -28.6     I: -28.4 LUFS       LRA:  20.0 LU  FTPK: -12.0 -12.1 dBFS  TPK: -11.6 -11.7 dBFS
[Parsed_ebur128_0 @ 0x7770c0d140] Summary:

  Integrated loudness:
    I:         -28.4 LUFS
    Threshold: -49.6 LUFS

  Loudness range:
    LRA:        20.0 LU
    Threshold: -54.2 LUFS
    LRA low:   -54.2 LUFS
    LRA high:  -34.2 LUFS

  True peak:
    Peak:      -11.6 dBFS
[out#0/null @ 0x7770c0c9c0] video:0KiB audio:562KiB subtitle:0KiB`;

describe('render.ts — loudness', () => {
	it('lee el JSON de la 1ª pasada de loudnorm (texto → número)', () => {
		const m = parsearLoudnorm(STDERR_LOUDNORM);
		expect(m).toEqual({
			input_i: -26.91,
			input_tp: -11.57,
			input_lra: 0,
			input_thresh: -45.92,
			output_i: -21.55,
			output_tp: -1.5,
			output_lra: 0,
			output_thresh: -37.17,
			normalization_type: 'dynamic',
			target_offset: 7.55,
		});
	});

	it('arma los filtros de la 1ª y la 2ª pasada con lo medido', () => {
		const o = {I: -14, TP: -1.5, LRA: 11};
		expect(filtroLoudnormMedir(o)).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
		expect(filtroLoudnormAplicar(o, parsearLoudnorm(STDERR_LOUDNORM))).toBe(
			'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-26.91:measured_TP=-11.57:measured_LRA=0:measured_thresh=-45.92:offset=7.55:linear=true:print_format=json',
		);
	});

	it('audio en silencio (-inf): lo lee y la 2ª pasada se niega con código 2', () => {
		const silencio = STDERR_LOUDNORM.replace('"-26.91"', '"-inf"').replace('"-11.57"', '"-inf"').replace('"7.55"', '"inf"');
		const m = parsearLoudnorm(silencio);
		expect(m.input_i).toBe(Number.NEGATIVE_INFINITY);
		expect(m.target_offset).toBe(Number.POSITIVE_INFINITY);
		const error = (() => {
			try {
				filtroLoudnormAplicar({I: -14, TP: -1.5, LRA: 11}, m);
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
	});

	it('sin JSON de loudnorm: fallo interno (código 1)', () => {
		expect(() => parsearLoudnorm('nada por aquí')).toThrow(FalloEditor);
	});

	it('lee el resumen de ebur128 (I, LRA y pico real), también con silencio', () => {
		expect(parsearEbur128(STDERR_EBUR128)).toEqual({I: -28.4, LRA: 20, TP: -11.6});
		const silencio = STDERR_EBUR128.replace('-28.4 LUFS\n    Threshold: -49.6', '-70.0 LUFS\n    Threshold: 0.0').replace('Peak:      -11.6 dBFS', 'Peak:       -inf dBFS');
		expect(parsearEbur128(silencio)).toMatchObject({I: -70, TP: Number.NEGATIVE_INFINITY});
	});

	it('explica con lo medido por qué la loudness integrada no llegó (y no dice nada si llegó)', () => {
		const m = parsearLoudnorm(STDERR_LOUDNORM.replace('"-26.91"', '"-27.51"').replace('"-11.57"', '"-11.58"'));
		const intento = {tp_objetivo: -1.5, primera_pasada: m, segunda_pasada: {...m, normalization_type: 'dynamic'}};
		expect(notaLoudness({I: -16.2, LRA: 20, TP: -1.5}, intento, -14)).toBe(
			'loudnorm no pudo subir 13.5 dB en lineal (el pico habría quedado en 1.9 dBTP, arriba de -1.5) y en modo dinámico se quedó en -16.2 LUFS',
		);
		expect(notaLoudness({I: -14.1, LRA: 3, TP: -1.5}, intento, -14)).toBeNull();
	});

	it('el reintento baja el TP a −2 dBTP (o 0.5 dB más si la EDL ya pedía menos)', () => {
		expect(tpDeReintento(-1.5)).toBe(-2);
		expect(tpDeReintento(-1)).toBe(-2);
		expect(tpDeReintento(-3)).toBe(-3.5);
	});
});

describe('render.ts — versiones y compuerta de validación', () => {
	const proyectos = join(tmp, 'proyectos');
	const slug = '_prueba-render';
	const dir = join(proyectos, slug);

	beforeAll(() => {
		mkdirSync(dir, {recursive: true});
		const invalida = clonar(EDL);
		invalida.subtitulos[0].desde = 2; // desde > hasta (1.4)
		writeFileSync(join(dir, 'edicion-v1.json'), JSON.stringify(EDL));
		writeFileSync(join(dir, 'edicion-v3.json'), JSON.stringify(invalida));
	});

	it('lista las versiones y elige la pedida o la más alta', () => {
		expect(versionesEdicion(dir)).toEqual([1, 3]);
		expect(elegirVersion(dir)).toBe(3);
		expect(elegirVersion(dir, 1)).toBe(1);
		expect(() => elegirVersion(dir, 2)).toThrow(/no existe edicion-v2\.json/);
		expect(() => elegirVersion(join(tmp, 'vacio'))).toThrow(FalloEditor);
	});

	/** Motor falso: registra cada llamada; el bundle falla a propósito para no renderizar nada de verdad. */
	function motorEspia() {
		const llamadas: string[] = [];
		const motor = {
			bundle: vi.fn(async () => {
				llamadas.push('bundle');
				throw new Error('bundle simulado');
			}),
			openBrowser: vi.fn(async () => {
				llamadas.push('openBrowser');
				throw new Error('no debería abrirse');
			}),
			selectComposition: vi.fn(async () => {
				llamadas.push('selectComposition');
				throw new Error('no debería llamarse');
			}),
			renderMedia: vi.fn(async () => {
				llamadas.push('renderMedia');
				throw new Error('no debería llamarse');
			}),
		} as unknown as Motor;
		return {motor, llamadas};
	}

	it('una EDL inválida sale con código 2 sin tocar Remotion ni crear salida/', async () => {
		const {motor, llamadas} = motorEspia();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = await renderizar({slug, version: 3, proyectos, motor, avisar: () => {}}).catch((e: unknown) => e);
		log.mockRestore();
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		expect((error as FalloEditor).message).toMatch(/^No pude renderizar: la edición no pasa validar\.ts/);
		expect(llamadas).toEqual([]);
		expect(existsSync(join(dir, 'salida'))).toBe(false);
		expect(leerManifest(slug, proyectos)).toBeNull();
	});

	it.runIf(HAY_FUENTES)('con la EDL válida sí pasa la compuerta y llega al bundle (que aquí falla a propósito: código 1)', async () => {
		const {motor, llamadas} = motorEspia();
		const error = await renderizar({slug, version: 1, proyectos, motor, avisar: () => {}}).catch((e: unknown) => e);
		expect(llamadas).toEqual(['bundle']);
		expect((error as FalloEditor).codigo).toBe(1);
		expect(leerManifest(slug, proyectos)?.etapas['render-v1']?.estado).toBe('fallida');
	});

	it('CLI: npx tsx herramientas/render.ts con una EDL inválida sale con 2 y no crea nada', () => {
		const slugCli = '_prueba-unit-render';
		const dirCli = join(RAIZ, 'proyectos', slugCli);
		rmSync(dirCli, {recursive: true, force: true});
		mkdirSync(dirCli, {recursive: true});
		try {
			const invalida = clonar(EDL);
			invalida.lienzo.w = 1080;
			writeFileSync(join(dirCli, 'edicion-v1.json'), JSON.stringify(invalida));
			const r = spawnSync('npx', ['tsx', 'herramientas/render.ts', slugCli], {cwd: RAIZ, encoding: 'utf8'});
			expect(r.status, r.stderr).toBe(2);
			expect(r.stdout).toMatch(/\[esquema\] lienzo\.w/);
			expect(r.stderr.trim().split('\n').at(-1)).toMatch(/^No pude renderizar: la edición no pasa validar\.ts \(1 problema\(s\)\)\. Siguiente paso: .+\.$/);
			expect(r.stderr).not.toMatch(/Render final de/);
			expect(existsSync(join(dirCli, 'salida'))).toBe(false);
			expect(existsSync(join(dirCli, 'manifest.json'))).toBe(false);
		} finally {
			rmSync(dirCli, {recursive: true, force: true});
		}
	}, 60_000);
});

describe('ajustar.ts — diff JSON', () => {
	const base = {
		version: 1,
		subtitulos: [
			{id: 's1', desde: 0.2, hasta: 1.4, palabras: [{i: 0, t: 'hola', d: 0.2, h: 0.6}]},
			{id: 's2', desde: 1.5, hasta: 2.0, palabras: [{i: 1, t: 'todos', d: 1.5, h: 2.0}]},
		],
		stickers: [
			{id: 'k2', caja: {x: 400, y: 1000, w: 280}, sfx: {asset: 'fx/pop.mp3', ganancia_db: -10, offset_frames: 0, variante: 0}},
			{id: 'k5', caja: {x: 100, y: 1100, w: 200}, sfx: {asset: 'fx/pop.mp3', ganancia_db: -12, offset_frames: 0, variante: 1}},
		],
		resaltar_palabras: [0],
	};

	it('sin cambios: diff vacío', () => {
		expect(diffJson(base, clonar(base))).toEqual([]);
	});

	it('"baja k2 100 px" y "quita el SFX de k5" dan exactamente esos 2 cambios', () => {
		const v2 = clonar(base);
		v2.stickers[0].caja.y += 100;
		(v2.stickers[1] as {sfx: unknown}).sfx = null;
		const d = diffJson(base, v2);
		expect(d).toEqual([
			{tipo: 'cambiado', ruta: 'stickers[id=k2].caja.y', antes: 1000, despues: 1100},
			{tipo: 'cambiado', ruta: 'stickers[id=k5].sfx', antes: base.stickers[1].sfx, despues: null},
		]);
		expect(formatearDiff(d)[0]).toBe('~ stickers[id=k2].caja.y: 1000 → 1100');
	});

	it('quitar un elemento de en medio es UN cambio (por id, no por posición); agregar y reordenar también se ven', () => {
		const v2 = clonar(base);
		v2.subtitulos.splice(0, 1);
		expect(diffJson(base, v2)).toEqual([{tipo: 'quitado', ruta: 'subtitulos[id=s1]', antes: base.subtitulos[0]}]);

		const v3 = clonar(base);
		v3.stickers.reverse();
		v3.resaltar_palabras.push(4);
		const d = diffJson(base, v3);
		expect(d).toContainEqual({tipo: 'orden', ruta: 'stickers', antes: ['k2', 'k5'], despues: ['k5', 'k2']});
		expect(d).toContainEqual({tipo: 'agregado', ruta: 'resaltar_palabras[1]', despues: 4});
		expect(d).toHaveLength(2);
	});

	it('llaves agregadas y quitadas en un objeto', () => {
		const v2 = clonar(base) as Record<string, unknown>;
		delete v2.resaltar_palabras;
		v2.titular = null;
		expect(diffJson(base, v2)).toEqual([
			{tipo: 'quitado', ruta: 'resaltar_palabras', antes: [0]},
			{tipo: 'agregado', ruta: 'titular', despues: null},
		]);
	});
});

describe('ajustar.ts — versiones inmutables', () => {
	const proyectos = join(tmp, 'ajustes');
	const slug = '_prueba-ajustar';
	const dir = join(proyectos, slug);

	beforeAll(() => {
		mkdirSync(dir, {recursive: true});
		writeFileSync(join(dir, 'edicion-v1.json'), JSON.stringify(EDL, null, '\t'));
	});

	it.runIf(HAY_FUENTES)('crea v2 como copia exacta, deja v1 de solo lectura y valida (0 cambios)', () => {
		const r = ajustar({slug, proyectos});
		expect(r).toMatchObject({desde: 1, nueva: 2, creada: true, cambios: [], hallazgos: []});
		expect(readFileSync(join(dir, 'edicion-v2.json'), 'utf8')).toBe(readFileSync(join(dir, 'edicion-v1.json'), 'utf8'));
		expect(statSync(join(dir, 'edicion-v1.json')).mode & 0o222).toBe(0);
	});

	it.runIf(HAY_FUENTES)('si v2 ya existe no la pisa: la valida y da el diff contra v1', () => {
		const v2 = JSON.parse(readFileSync(join(dir, 'edicion-v2.json'), 'utf8'));
		v2.stickers[0].caja.y += 100;
		v2.stickers[0].sfx = null;
		writeFileSync(join(dir, 'edicion-v2.json'), JSON.stringify(v2));
		const r = ajustar({slug, desde: 1, proyectos});
		expect(r.creada).toBe(false);
		expect(r.hallazgos).toEqual([]);
		expect(r.cambios.map((c) => c.ruta)).toEqual(['stickers[id=k1].caja.y', 'stickers[id=k1].sfx']);
		expect(JSON.parse(readFileSync(join(dir, 'edicion-v2.json'), 'utf8')).stickers[0].sfx).toBeNull();
	});

	it.runIf(HAY_FUENTES)('una v2 inválida da hallazgos (el CLI sale con 2)', () => {
		const v2 = JSON.parse(readFileSync(join(dir, 'edicion-v2.json'), 'utf8'));
		v2.subtitulos[0].hasta = 0.1;
		writeFileSync(join(dir, 'edicion-v2.json'), JSON.stringify(v2));
		const r = ajustar({slug, desde: 1, proyectos});
		expect(r.hallazgos.length).toBeGreaterThan(0);
		expect(r.hallazgos[0].regla).toBe('esquema');
	});
});

describe('lib/reporte.ts', () => {
	const checks: Check[] = [
		crearCheck({id: 'a', nombre: 'A', nivel: 'bloqueante', pasa: true, valor: 1, criterio: '=1', n: null, fuente: 'x'}),
		crearCheck({id: 'b', nombre: 'B', nivel: 'estetico', pasa: false, valor: 2, criterio: '=1', n: 3, fuente: 'y'}),
		crearCheck({id: 'c', nombre: 'C', nivel: 'estetico', pasa: null, valor: null, criterio: '=1', n: null, fuente: 'z', nota: 'falta medir.ts'}),
	];

	it('"cumple X de Y checks (Z N/A)": los N/A no cuentan en Y', () => {
		expect(contarChecks(checks)).toEqual({cumple: 1, total: 2, na: 1, fallan: 1});
		expect(fraseConteo(contarChecks(checks))).toBe('cumple 1 de 2 checks (1 N/A)');
	});

	it('escribe reporte.json y reporte.md con la versión más reciente primero y lo que impide subir arriba', () => {
		const proyectos = join(tmp, 'reportes');
		mkdirSync(join(proyectos, '_prueba-reporte'), {recursive: true});
		actualizarReporte('_prueba-reporte', 1, 'render', {titulo: 'Render final', checks: [checks[0]], tiempos_s: {bundle: 3.2, video: 40.1}}, proyectos);
		const r = actualizarReporte('_prueba-reporte', 2, 'qa', {titulo: 'QA', checks, detalle: ['línea de detalle']}, proyectos);
		expect(r.conteo).toEqual({cumple: 1, total: 2, na: 1, fallan: 1});
		const md = readFileSync(r.rutaMd, 'utf8');
		expect(md.indexOf('## v2 (la más reciente) · cumple 1 de 2 checks (1 N/A)')).toBeGreaterThan(0);
		expect(md.indexOf('## v2')).toBeLessThan(md.indexOf('## v1 · cumple 1 de 1 checks (0 N/A)'));
		expect(md.indexOf('Lo que impide subir')).toBeLessThan(md.indexOf('Lo estético'));
		expect(md).toContain('| **total** | **43.3 s** |');
		expect(md).toContain('falta medir.ts');
		expect(leerReporte('_prueba-reporte', proyectos).versiones['2'].secciones.qa.checks).toHaveLength(3);
		expect(generarMarkdown(leerReporte('_prueba-reporte', proyectos), null)).toBe(md);
	});
});

describe('qa.ts', () => {
	const sondeo = (cambios: {ancho?: number; cuadros?: number | null; audio?: number | null} = {}): Sondeo => ({
		ruta: 'x.mp4',
		duracion: 3,
		video: {
			indice: 0, codec: 'h264', ancho: cambios.ancho ?? 1440, alto: 2560, rotacion: 0, anchoVisible: 1440, altoVisible: 2560,
			fpsReal: 30, fpsNominal: 30, rFrameRate: '30/1', avgFrameRate: '30/1', vfr: false, colorTransfer: 'bt709', colorPrimaries: 'bt709',
			colorSpace: 'bt709', pixFmt: 'yuv420p', hdr: false, duracion: 3, cuadros: cambios.cuadros === undefined ? 90 : cambios.cuadros,
		},
		audio: cambios.audio === null ? null : {indice: 1, codec: 'aac', sampleRate: 48000, canales: 2, duracion: cambios.audio ?? 3.01},
		creationTime: null,
		creationTimeLocal: null,
	});

	it('--veredicto: pasa el check del lado a lado de N/A a PASA/FALLA sin tocar los demás', () => {
		const proyectos = join(tmp, 'veredicto');
		const slug = '_prueba-veredicto';
		mkdirSync(join(proyectos, slug), {recursive: true});
		expect(() => registrarVeredicto(slug, 1, 'si', proyectos)).toThrow(/todavía no tiene A\/B/);
		const pendiente = crearCheck({id: 'ab.veredicto', nombre: 'Tu veredicto', nivel: 'estetico', pasa: null, valor: null, criterio: '"sí"', n: null, fuente: 'ab-v1.mp4', nota: 'pendiente'});
		const texto = crearCheck({id: 'ab.texto', nombre: 'Texto', nivel: 'estetico', pasa: true, valor: 0.98, criterio: '≥ 0.9', n: 292, fuente: 'whisper'});
		actualizarReporte(slug, 1, 'ab', {titulo: 'A/B', checks: [texto, pendiente]}, proyectos);
		expect(registrarVeredicto(slug, 1, 'si', proyectos)).toBe('cumple 2 de 2 checks (0 N/A)');
		const checks = leerReporte(slug, proyectos).versiones['1'].secciones.ab.checks;
		expect(checks.find((c) => c.id === 'ab.veredicto')).toMatchObject({estado: 'PASA', valor: 'sí'});
		expect(checks.find((c) => c.id === 'ab.texto')).toEqual(texto);
		expect(registrarVeredicto(slug, 1, 'no', proyectos)).toBe('cumple 1 de 2 checks (0 N/A)');
	});

	it('verificarVideo: pasa con 1440×2560, 90 cuadros y audio a 0.3 cuadros', () => {
		const v = verificarVideo(sondeo(), {ancho: 1440, alto: 2560, cuadros: 90}, 'prueba');
		expect(v.checks.map((c) => c.estado)).toEqual(['PASA', 'PASA', 'PASA']);
		expect(v.datos.dif_cuadros_audio_video).toBe(0.3);
	});

	it('verificarVideo: falla con otro ancho, 89 cuadros o audio a 2 cuadros', () => {
		const v = verificarVideo(sondeo({ancho: 1080, cuadros: 89, audio: 3.0667}), {ancho: 1440, alto: 2560, cuadros: 90}, 'prueba');
		expect(v.checks.map((c) => c.estado)).toEqual(['FALLA', 'FALLA', 'FALLA']);
		expect(v.problemas).toHaveLength(3);
	});

	it('stills de subtítulos: inicio = round(desde × 30) y mitad; los del mismo cuadro se juntan', () => {
		const subs = [
			{id: 's1', desde: 0.2, hasta: 1.4, palabras: [{i: 0, t: 'a', d: 0.2, h: 1.4}]},
			{id: 's2', desde: 2.0, hasta: 2.02, palabras: [{i: 1, t: 'b', d: 2.0, h: 2.02}]},
		];
		expect(stillsDeSubtitulos(subs, 90)).toEqual([
			{cuadro: 6, etiqueta: 's1 inicio'},
			{cuadro: 24, etiqueta: 's1 mitad'},
			{cuadro: 60, etiqueta: 's2 inicio + s2 mitad'},
		]);
		expect(expresionSelect([6, 24])).toBe("select='between(t,0.183333,0.216667)+between(t,0.783333,0.816667)'");
		// Con búsqueda (-ss), los tiempos quedan relativos al punto de búsqueda.
		expect(expresionSelect([6], 0.1)).toBe("select='between(t,0.083333,0.116667)'");
	});

	it('extrae el cuadro exacto (cada cuadro de prueba tiene su propio gris) y arma la hoja de contacto', async () => {
		const video = join(tmp, 'grises.mp4');
		const g = spawnSync(
			'ffmpeg',
			['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=2', '-vf', "geq=lum='N*4':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', video],
			{encoding: 'utf8'},
		);
		expect(g.status, g.stderr).toBe(0);
		const dir = join(tmp, 'qa-grises');
		mkdirSync(dir, {recursive: true});
		const gris = (ruta: string) => spawnSync('ffmpeg', ['-v', 'error', '-i', ruta, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], {maxBuffer: 1024}).stdout[0];
		// El JPEG va en rango completo: el gris 4·N del video (rango TV) se lee como (4·N − 16)·255/219.
		// Dos cuadros vecinos difieren ~4.7 niveles, así que ±2 distingue el cuadro exacto.
		const esperado = (n: number) => Math.min(255, Math.max(0, Math.round(((4 * n - 16) * 255) / 219)));
		// 44 cuadros pedidos (más de una tanda) y en desorden: cada uno tiene que salir exacto.
		const pedidos = [59, 10, 37, ...Array.from({length: 42}, (_, k) => 11 + k).filter((c) => c !== 37)].map((cuadro) => ({cuadro, etiqueta: `c${cuadro}`}));
		expect(pedidos.length).toBeGreaterThan(STILLS_POR_PASADA);
		const todos = extraerStills(video, pedidos, dir);
		expect(todos).toHaveLength(pedidos.length);
		todos.forEach((s) => expect(Math.abs(gris(s.ruta) - esperado(s.cuadro)), `cuadro ${s.cuadro}`).toBeLessThanOrEqual(2));
		const stills = todos.filter((s) => [10, 37, 59].includes(s.cuadro));
		expect(stills.map((s) => s.cuadro)).toEqual([10, 37, 59]);
		const hojas = await hojasDeContacto(stills, dir, 'prueba');
		expect(hojas).toHaveLength(1);
		const tam = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', hojas[0]], {encoding: 'utf8'}).stdout.trim();
		expect(tam).toBe(`${HOJA.columnas * (HOJA.ancho + HOJA.margen) + HOJA.margen},${HOJA.encabezado + HOJA.alto + HOJA.etiqueta + 2 * HOJA.margen}`);
	}, 30_000);
});

describe('lib/ab.ts', () => {
	it('ΔE2000 coincide con los pares de prueba de Sharma, Wu y Dalal (2005)', () => {
		const casos: Array<[[number, number, number], [number, number, number], number]> = [
			[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
			[[50, 0, 0], [50, -1, 2], 2.3669],
			[[50, 2.5, 0], [73, 25, -18], 27.1492],
			[[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
			[[50, 2.5, 0], [50, 0, -2.5], 4.3065],
		];
		for (const [a, b, esperado] of casos) {
			expect(deltaE2000({L: a[0], a: a[1], b: a[2]}, {L: b[0], a: b[1], b: b[2]})).toBeCloseTo(esperado, 3);
		}
	});

	it('entiende los colores en hex, rgb(), arreglo, {r,g,b}, {L,a,b} y {valor}', () => {
		expect(srgbALab({r: 255, g: 255, b: 255}).L).toBeCloseTo(100, 2);
		expect(srgbALab({r: 0, g: 0, b: 0}).L).toBeCloseTo(0, 6);
		const blanco = colorALab('#FFFFFF');
		for (const x of ['#fff', 'rgb(255, 255, 255)', [255, 255, 255], {r: 255, g: 255, b: 255}, {valor: '#ffffff'}]) {
			expect(deltaE2000(colorALab(x)!, blanco!)).toBeLessThan(1e-6);
		}
		expect(colorALab({L: 50, a: 10, b: -5})).toEqual({L: 50, a: 10, b: -5});
		expect(colorALab('N/A')).toBeNull();
	});

	it('checks de subtítulos: pasa dentro de tolerancia, falla fuera y queda N/A sin medir.ts', () => {
		const pub = {y_p50: 1500, alto_mayuscula_p50: 50, color_texto: '#ffffff', color_borde: '#000000', grosor_borde_p50: 6, n: 40};
		const bien = checksSubtitulos({y_p50: 1520, alto_mayuscula_p50: 51, color_texto: '#fefefe', color_borde: '#050505', grosor_borde_p50: 6.5, n: 38}, pub);
		expect(bien.map((c) => c.estado)).toEqual(['PASA', 'PASA', 'PASA', 'PASA', 'PASA']);
		expect(bien[0].n).toBe(38);
		// Con N por métrica (como lo da medir.ts), cada check usa el suyo.
		const conN = checksSubtitulos({...pub, n_por_metrica: {y: 30, color: 12}}, {...pub, n: 40, n_por_metrica: {y: 35, color: 20, grosor_borde: 9}});
		expect(conN.map((c) => c.n)).toEqual([30, 40, 12, 12, 9]);
		const mal = checksSubtitulos({y_p50: 1540, alto_mayuscula_p50: 54, color_texto: '#ffe000', color_borde: '#303030', grosor_borde_p50: 8, n: 30}, pub);
		expect(mal.map((c) => c.estado)).toEqual(['FALLA', 'FALLA', 'FALLA', 'FALLA', 'FALLA']);
		const sin = checksSubtitulos(null, null, 'todavía no existe medir.ts');
		expect(sin.every((c) => c.estado === 'N/A' && c.nota === 'todavía no existe medir.ts')).toBe(true);
	});

	it('el resumen de medir.ts puede venir directo o dentro de {resumen}', () => {
		expect(extraerResumen({resumen: {y_p50: 1, n: 5}})).toMatchObject({y_p50: 1, n: 5});
		expect(extraerResumen({y_p50: {valor: 2}, eventos: [1, 2, 3]})).toMatchObject({n: 3});
		expect(extraerResumen(null)).toBeNull();
	});

	it('texto: 1 − WER sin acentos ni puntuación; duración ±15 %', () => {
		expect(compararTextos('Hola, ¿qué tal? Esto es Claude Code.', 'hola que tal esto es claude code').similitud).toBe(1);
		const c = compararTextos('uno dos tres cuatro cinco seis siete ocho nueve diez', 'uno dos tres cuatro cinco seis siete ocho nueve');
		expect(c).toMatchObject({similitud: 0.9, wer: 0.1, palabras_publicado: 10, palabras_render: 9});
		expect(checkDuracion(70, 73).estado).toBe('PASA');
		expect(checkDuracion(60, 73).estado).toBe('FALLA');
	});

	it('si medir.ts no existe, lo dice en vez de tronar', async () => {
		const r = await cargarMedir(join(tmp, 'no-existe', 'medir.ts'));
		expect(r.modulo).toBeNull();
		expect(r.motivo).toMatch(/todavía no existe/);
	});
});
