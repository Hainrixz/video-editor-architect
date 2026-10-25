// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de los inserts de tu material (Fase 4): herramientas/lib/inserts.ts y su CLI.
 *
 * Todo corre dentro del sandbox con archivos sintéticos hechos al vuelo en $TMPDIR (ffmpeg, y cwebp si está):
 * - nombres, medidas, formatos y argumentos de ffmpeg (puro);
 * - color: perfiles ICC reales del sistema (sRGB, Display P3), cICP/nclx, contenedores PNG/JPEG/WebP/HEIF y la
 *   conversión P3 → sRGB contra la matriz publicada (no contra el propio código);
 * - videos de verdad: rotación −90 (como tus clips del iPhone), 60 fps y VFR → 30/1, ancho ≤ 1440, audio AAC 48 kHz,
 *   sin metadatos, HDR → código 2, reutilización, ids que chocan, el original intacto (sha256 y fecha);
 * - imágenes de verdad: P3 → sRGB, orientación EXIF, lado mayor ≤ 2560 sin agrandar, alfa, chunks sRGB;
 * - OCR de secretos con un escáner inyectado (Vision no corre aquí): BLOQUEADA, SIN_ESCANEAR, aprobación y cambio;
 * - insertParaEdicion y problemasDeInserts contra el contrato de src/esquema/edicion.ts.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {crc32, deflateSync} from 'node:zlib';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EdicionValidada, Insert as EsquemaInsert, edicionVacia} from '../../src/esquema/edicion.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {sondear} from '../../herramientas/lib/ffprobe.ts';
import type {ResultadoEscaneo} from '../../herramientas/grabador/secretos.ts';
import {
	ALTO_MAX_TARJETA,
	CURVA_SRGB,
	PRIMARIOS_H273,
	SRGB_D50,
	aprobarInsert,
	argumentosVideo,
	asignarId,
	cajaTarjeta,
	colorDeHeif,
	colorDeJpeg,
	colorDePng,
	colorDeWebp,
	decidirColor,
	dimensionesImagenDestino,
	dimensionesVideo,
	dirInserts,
	escanearPendientes,
	esSrgb,
	estadoInsert,
	evaluarCurva,
	expandirEntradas,
	filtroEscalaImagen,
	formatoDeImagen,
	idDeArchivo,
	insertParaEdicion,
	inv3,
	leerIcc,
	leerMetaInsert,
	leerPam,
	listarMetas,
	matrizDePrimarios,
	mul3,
	orientacionHeif,
	pixelesASrgb8,
	prepararConversion,
	problemasDeInserts,
	procesarInserts,
	tipoPorExtension,
	type Escaner,
	type Mat3,
	type MetaInsert,
} from '../../herramientas/lib/inserts.ts';

// ───────────────────────── utilidades de prueba ─────────────────────────

const ICC_SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc';
const ICC_P3 = '/System/Library/ColorSync/Profiles/Display P3.icc';
const hayIcc = existsSync(ICC_SRGB) && existsSync(ICC_P3);
const hayCwebp = spawnSync('cwebp', ['-version']).status === 0;

let tmp: string;
let proyectos: string;

function ffmpeg(args: string[], entrada?: Buffer): Buffer {
	const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args], {input: entrada, maxBuffer: 512 * 1024 * 1024});
	if (r.status !== 0) throw new Error(`ffmpeg falló: ${r.stderr?.toString()}`);
	return r.stdout;
}

/** RGB(A) crudo → PNG (bytes). */
const pngDe = (datos: Buffer, ancho: number, alto: number, canales: 3 | 4 = 3) =>
	ffmpeg(['-f', 'rawvideo', '-pix_fmt', canales === 4 ? 'rgba' : 'rgb24', '-s', `${ancho}x${alto}`, '-i', 'pipe:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], datos);

/** RGB crudo → JPEG 4:4:4 de máxima calidad (bytes). */
const jpegDe = (datos: Buffer, ancho: number, alto: number) =>
	ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${ancho}x${alto}`, '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'yuvj444p', '-q:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], datos);

/** Cualquier imagen → RGB crudo de 8 bits (para medir píxeles). */
function rgbDe(ruta: string): {datos: Buffer; ancho: number; alto: number} {
	const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', ruta], {encoding: 'utf8'});
	const [ancho, alto] = r.stdout.trim().split(',').map(Number);
	return {datos: ffmpeg(['-i', ruta, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']), ancho, alto};
}

const pixel = (img: {datos: Buffer; ancho: number}, x: number, y: number) => {
	const o = (y * img.ancho + x) * 3;
	return [img.datos[o], img.datos[o + 1], img.datos[o + 2]];
};

const u32be = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
};
const u16be = (n: number) => {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
};
const u32le = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n);
	return b;
};

function chunkPng(tipo: string, datos: Buffer): Buffer {
	const t = Buffer.from(tipo, 'latin1');
	return Buffer.concat([u32be(datos.length), t, datos, u32be(crc32(Buffer.concat([t, datos])) >>> 0)]);
}
/** Mete chunks justo después del IHDR (8 de firma + 25 del IHDR). */
const pngConChunks = (png: Buffer, chunks: Buffer[]) => Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
const chunkIccp = (icc: Buffer) => chunkPng('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), deflateSync(icc)]));

function chunksDePng(png: Buffer): string[] {
	const tipos: string[] = [];
	for (let i = 8; i + 12 <= png.length; ) {
		const n = png.readUInt32BE(i);
		tipos.push(png.toString('latin1', i + 4, i + 8));
		i += 12 + n;
	}
	return tipos;
}

function segmentoJpeg(marca: number, datos: Buffer): Buffer {
	const cab = Buffer.from([0xff, marca, 0, 0]);
	cab.writeUInt16BE(datos.length + 2, 2);
	return Buffer.concat([cab, datos]);
}
const jpegConSegmentos = (jpeg: Buffer, segmentos: Buffer[]) => Buffer.concat([jpeg.subarray(0, 2), ...segmentos, jpeg.subarray(2)]);
const app2Icc = (trozo: Buffer, n: number, total: number) => segmentoJpeg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([n, total]), trozo]));
function app1Orientacion(o: number): Buffer {
	const tiff = Buffer.alloc(26);
	tiff.write('MM', 0, 'latin1');
	tiff.writeUInt16BE(42, 2);
	tiff.writeUInt32BE(8, 4);
	tiff.writeUInt16BE(1, 8);
	tiff.writeUInt16BE(0x0112, 10);
	tiff.writeUInt16BE(3, 12);
	tiff.writeUInt32BE(1, 14);
	tiff.writeUInt16BE(o, 18);
	tiff.writeUInt32BE(0, 22);
	return segmentoJpeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

function caja(tipo: string, ...partes: Buffer[]): Buffer {
	const cuerpo = Buffer.concat(partes);
	return Buffer.concat([u32be(8 + cuerpo.length), Buffer.from(tipo, 'latin1'), cuerpo]);
}
const heifSintetico = (colr: Buffer[]) =>
	Buffer.concat([
		caja('ftyp', Buffer.from('heic', 'latin1'), Buffer.alloc(4), Buffer.from('mif1heic', 'latin1')),
		caja('meta', Buffer.alloc(4), caja('hdlr', Buffer.alloc(8), Buffer.from('pict', 'latin1'), Buffer.alloc(13)), caja('iprp', caja('ipco', ...colr, caja('ispe', Buffer.alloc(4), u32be(64), u32be(32))))),
	]);

function webpConIcc(simple: Buffer, icc: Buffer, ancho: number, alto: number): Buffer {
	const vp8x = Buffer.alloc(18);
	vp8x.write('VP8X', 0, 'latin1');
	vp8x.writeUInt32LE(10, 4);
	vp8x[8] = 0x20;
	vp8x.writeUIntLE(ancho - 1, 12, 3);
	vp8x.writeUIntLE(alto - 1, 15, 3);
	const iccp = Buffer.concat([Buffer.from('ICCP', 'latin1'), u32le(icc.length), icc, Buffer.alloc(icc.length % 2)]);
	const cuerpo = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, iccp, simple.subarray(12)]);
	return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(cuerpo.length), cuerpo]);
}

/** Parches de color de 16×16 en fila (RGB crudo). */
const PARCHES: Array<[number, number, number]> = [
	[200, 100, 50],
	[128, 128, 128],
	[0, 255, 0],
	[30, 60, 200],
	[250, 250, 250],
];
function crudoDeParches(lado = 16): Buffer {
	const ancho = lado * PARCHES.length;
	const b = Buffer.alloc(ancho * lado * 3);
	for (let y = 0; y < lado; y++)
		for (let x = 0; x < ancho; x++) {
			const c = PARCHES[Math.floor(x / lado)];
			b.set(c, (y * ancho + x) * 3);
		}
	return b;
}

/** P3 → sRGB con la matriz publicada (independiente del código bajo prueba) y las curvas sRGB. */
const P3_A_SRGB = [
	[1.2249401, -0.2249404, 0],
	[-0.0420569, 1.0420571, 0],
	[-0.0196376, -0.0786361, 1.0982735],
];
const decodificar = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const codificar = (l: number) => {
	const x = Math.min(1, Math.max(0, l));
	return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
};
const esperadoP3 = ([r, g, b]: [number, number, number]) => {
	const l = [decodificar(r), decodificar(g), decodificar(b)];
	return P3_A_SRGB.map((f) => codificar(f[0] * l[0] + f[1] * l[1] + f[2] * l[2]));
};

const huella = (ruta: string) => ({sha: createHash('sha256').update(readFileSync(ruta)).digest('hex'), mtime: statSync(ruta).mtimeMs});

function capturarFallo(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('no falló');
}
async function capturarFalloAsync(fn: () => Promise<unknown>): Promise<FalloEditor> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('no falló');
}

const escanerLimpio: Escaner = async (_ruta, nombre) => ({archivo: nombre, leidos: 1, paso: null, hallazgos: [], segundos: 0});
const escanerConLlave: Escaner = async (_ruta, nombre): Promise<ResultadoEscaneo> => ({
	archivo: nombre,
	leidos: 1,
	paso: null,
	segundos: 0,
	hallazgos: [{archivo: nombre, tipo: 'llave sk-', muestra: 'sk-…(28)', huella: 'abc', cuadro: null, t: null, lecturas: 1, caja: {x: 10, y: 20, w: 300, h: 24}}],
});
const escanerSandbox: Escaner = async () => {
	throw new FalloEditor('leer el texto de x.png', 'Vision no pudo cargar su modelo; pasa dentro del sandbox', 'corre fuera del sandbox', 1);
};

/** Meta mínima para las pruebas puras de insertParaEdicion. */
function metaDePrueba(cambios: Partial<MetaInsert> = {}): MetaInsert {
	return {
		version: 1,
		id: 'img-5091',
		tipo: 'video',
		archivo: 'img-5091.mp4',
		asset: 'p/_prueba/inserts/img-5091.mp4',
		ancho: 1440,
		alto: 2560,
		duracion_s: 3.133333,
		fps: 30,
		cuadros: 94,
		tiene_audio: true,
		rotacion_original: -90,
		espejo: false,
		origen: {ruta: '/x/IMG_5091.MOV', sha256: 'a'.repeat(64), mtime: '2026-09-27T06:12:48.000Z', bytes: 1},
		procesado_en: '2026-10-03T00:00:00.000Z',
		salida: {sha256: 'b'.repeat(64), bytes: 1},
		parametros_sha256: 'c'.repeat(64),
		detalle: {},
		revision: {estado: 'NO_APLICA', motivo: 'video', escaneado_en: null, sha256: null, leidos: 0, hallazgos: [], aprobado_por: null, aprobado_en: null, siguiente_paso: null},
		avisos: [],
		...cambios,
	};
}

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), 'editor-inserts-'));
	proyectos = join(tmp, 'proyectos');
	mkdirSync(proyectos, {recursive: true});
});

afterAll(() => {
	rmSync(tmp, {recursive: true, force: true});
});

// ───────────────────────── nombres, medidas y argumentos ─────────────────────────

describe('nombres, tipos y medidas', () => {
	it('id a partir del nombre del archivo', () => {
		expect(idDeArchivo('IMG_5091.MOV')).toBe('img-5091');
		expect(idDeArchivo('Captura de pantalla 2026-10-03 a la(s) 10.23.08.png')).toBe('captura-de-pantalla-2026-10-03-a-la-s-10-23-08');
		expect(idDeArchivo('Ñandú y Pingüino.webp')).toBe('nandu-y-pinguino');
		expect(idDeArchivo('___.png')).toBe('insert');
		const largo = idDeArchivo(`${'a'.repeat(59)} b c.png`);
		expect(largo.length).toBeLessThanOrEqual(60);
		expect(largo.endsWith('-')).toBe(false);
	});

	it('tipo por extensión y formato real por los primeros bytes', () => {
		expect(tipoPorExtension('/x/IMG_1.MOV')).toBe('video');
		expect(tipoPorExtension('a.m4v')).toBe('video');
		expect(tipoPorExtension('a.HEIC')).toBe('imagen');
		expect(tipoPorExtension('a.gif')).toBeNull();
		expect(formatoDeImagen(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('png');
		expect(formatoDeImagen(Buffer.from('ffd8ffe0', 'hex'))).toBe('jpeg');
		expect(formatoDeImagen(Buffer.concat([Buffer.from('RIFF'), u32le(4), Buffer.from('WEBPVP8 ')]))).toBe('webp');
		expect(formatoDeImagen(heifSintetico([]))).toBe('heif');
		expect(formatoDeImagen(Buffer.from('GIF89a0000000000'))).toBeNull();
	});

	it('video: ancho ≤ 1440 sin agrandar, alto por proporción, ambos pares', () => {
		expect(dimensionesVideo(2160, 3840)).toEqual({ancho: 1440, alto: 2560});
		expect(dimensionesVideo(3840, 2160)).toEqual({ancho: 1440, alto: 810});
		expect(dimensionesVideo(720, 1280)).toEqual({ancho: 720, alto: 1280});
		expect(dimensionesVideo(1081, 1921)).toEqual({ancho: 1080, alto: 1920});
		expect(dimensionesVideo(180, 320)).toEqual({ancho: 180, alto: 320});
	});

	it('imagen: lado mayor ≤ 2560 sin agrandar', () => {
		expect(dimensionesImagenDestino(3000, 1200)).toEqual({ancho: 2560, alto: 1024});
		expect(dimensionesImagenDestino(1200, 3000)).toEqual({ancho: 1024, alto: 2560});
		expect(dimensionesImagenDestino(800, 600)).toEqual({ancho: 800, alto: 600});
		expect(dimensionesImagenDestino(2560, 1600)).toEqual({ancho: 2560, alto: 1600});
		expect(filtroEscalaImagen()).toContain("min(iw,2560)");
	});

	it('argumentos de ffmpeg de un video: CFR 30, CRF 16, BT.709, GOP 15, audio AAC 48 kHz y sin metadatos', () => {
		const s = {
			video: {indice: 0, anchoVisible: 2160, altoVisible: 3840},
			audio: {indice: 1},
		} as unknown as Parameters<typeof argumentosVideo>[2];
		const {args, ancho, alto} = argumentosVideo('/o.MOV', '/d.mp4', s);
		expect([ancho, alto]).toEqual([1440, 2560]);
		const texto = args.join(' ');
		expect(texto).toContain('-map 0:0 -map 0:1');
		expect(texto).toContain('fps=30,scale=1440:2560');
		expect(texto).toContain('out_color_matrix=bt709');
		expect(texto).toContain('-crf 16');
		expect(texto).toContain('-pix_fmt yuv420p');
		expect(texto).toContain('-g 15 -keyint_min 15');
		expect(texto).toContain('-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv');
		expect(texto).toContain('-c:a aac -b:a 192k -ar 48000 -ac 2');
		expect(texto).toContain('-map_metadata -1');
		const sinAudio = argumentosVideo('/o.MOV', '/d.mp4', {...s, audio: null} as unknown as Parameters<typeof argumentosVideo>[2]);
		expect(sinAudio.args).toContain('-an');
		expect(sinAudio.args.join(' ')).not.toContain('-c:a');
	});

	it('PAM: lee la cabecera y rechaza lo que no es PAM', () => {
		const datos = Buffer.alloc(2 * 1 * 4 * 2, 0xff);
		const pam = leerPam(Buffer.concat([Buffer.from('P7\nWIDTH 2\nHEIGHT 1\nDEPTH 4\nMAXVAL 65535\nTUPLTYPE RGB_ALPHA\nENDHDR\n', 'latin1'), datos]));
		expect([pam.ancho, pam.alto, pam.profundidad, pam.maxval, pam.datos.length]).toEqual([2, 1, 4, 65535, 16]);
		expect(() => leerPam(Buffer.from('P6\n2 1\n255\n'))).toThrow();
	});
});

// ───────────────────────── color ─────────────────────────

describe('color: perfiles y conversión a sRGB', () => {
	it('matemática: matrices, primarios BT.709 = colorantes de sRGB (D50)', () => {
		const m: Mat3 = [
			[2, 0, 1],
			[1, 3, 0],
			[0, 1, 4],
		];
		const id = mul3(m, inv3(m));
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(id[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
		const srgb = matrizDePrimarios(PRIMARIOS_H273[1].xy);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(srgb[i][j] - SRGB_D50[i][j])).toBeLessThan(0.0015);
	});

	it('curvas: gamma, tabla y paramétricas (la sRGB da los valores de la norma)', () => {
		expect(evaluarCurva({tipo: 'gamma', g: 2.2}, 0.5)).toBeCloseTo(Math.pow(0.5, 2.2), 9);
		expect(evaluarCurva({tipo: 'tabla', valores: [0, 0.5, 1]}, 0.25)).toBeCloseTo(0.25, 9);
		expect(evaluarCurva({tipo: 'identidad'}, 0.3)).toBe(0.3);
		expect(evaluarCurva(CURVA_SRGB, 0.5)).toBeCloseTo(0.214041, 5);
		expect(evaluarCurva(CURVA_SRGB, 0.02)).toBeCloseTo(0.02 / 12.92, 9);
		expect(evaluarCurva({tipo: 'parametrica', funcion: 0, p: [2]}, 0.5)).toBeCloseTo(0.25, 9);
		expect(evaluarCurva({tipo: 'parametrica', funcion: 4, p: [1, 1, 0, 0.5, 0.5, 0.1, 0.05]}, 0.2)).toBeCloseTo(0.15, 9);
	});

	it.skipIf(!hayIcc)('ICC reales del sistema: sRGB es sRGB; Display P3 no, y su matriz a sRGB es la publicada (±0.003)', () => {
		const srgb = leerIcc(readFileSync(ICC_SRGB));
		expect(srgb.espacio).toBe('RGB ');
		expect(srgb.descripcion).toMatch(/sRGB/);
		expect(esSrgb(srgb)).toBe(true);
		const p3 = leerIcc(readFileSync(ICC_P3));
		expect(p3.descripcion).toBe('Display P3');
		expect(esSrgb(p3)).toBe(false);
		const conv = prepararConversion(p3);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(conv.matriz[i][j] - P3_A_SRGB[i][j])).toBeLessThan(0.003);
		// Los primarios de Display P3 (código H.273 12) dan los mismos colorantes que el ICC de Apple.
		const deCodigos = matrizDePrimarios(PRIMARIOS_H273[12].xy);
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(deCodigos[i][j] - (p3.matriz as Mat3)[i][j])).toBeLessThan(0.002);
	});

	it.skipIf(!hayIcc)('contenedores: PNG (iCCP, cICP, sRGB), JPEG (APP2 en 2 trozos), WebP (ICCP) y HEIF (colr prof / nclx)', () => {
		const icc = readFileSync(ICC_P3);
		const png = pngDe(crudoDeParches(), 80, 16);
		const conIcc = colorDePng(pngConChunks(png, [chunkIccp(icc)]));
		expect(conIcc.fuente).toBe('iCCP');
		expect(conIcc.icc?.equals(icc)).toBe(true);
		const conCicp = colorDePng(pngConChunks(png, [chunkIccp(icc), chunkPng('cICP', Buffer.from([12, 13, 0, 1]))]));
		expect(conCicp.fuente).toBe('cICP');
		expect(conCicp.cicp).toEqual({primarios: 12, transferencia: 13, matriz: 0, rangoCompleto: true});
		expect(colorDePng(pngConChunks(png, [chunkPng('sRGB', Buffer.from([0]))])).fuente).toBe('sRGB');
		expect(colorDePng(png).fuente).toBe('ninguna');

		const jpeg = jpegDe(crudoDeParches(), 80, 16);
		const mitad = Math.floor(icc.length / 2);
		const conApp2 = colorDeJpeg(jpegConSegmentos(jpeg, [app2Icc(icc.subarray(mitad), 2, 2), app2Icc(icc.subarray(0, mitad), 1, 2)]));
		expect(conApp2.fuente).toBe('APP2');
		expect(conApp2.icc?.equals(icc)).toBe(true);

		const webpFalso = Buffer.concat([Buffer.from('RIFF'), u32le(0), Buffer.from('WEBP'), Buffer.from('VP8L'), u32le(0)]);
		const conIccp = colorDeWebp(webpConIcc(webpFalso, icc, 80, 16));
		expect(conIccp.fuente).toBe('ICCP');
		expect(conIccp.icc?.equals(icc)).toBe(true);

		const heifProf = colorDeHeif(heifSintetico([caja('colr', Buffer.from('prof', 'latin1'), icc)]));
		expect(heifProf.fuente).toBe('colr-prof');
		expect(heifProf.icc?.equals(icc)).toBe(true);
		const heifNclx = colorDeHeif(heifSintetico([caja('colr', Buffer.from('nclx', 'latin1'), u16be(12), u16be(13), u16be(6), Buffer.from([0x80]))]));
		expect(heifNclx.cicp).toEqual({primarios: 12, transferencia: 13, matriz: 6, rangoCompleto: true});
	});

	it.skipIf(!hayIcc)('HEIF: irot, imir y colr del ítem principal (pitm + ipma), como en las fotos del iPhone', () => {
		const fullbox = (tipo: string, version: number, flags: number, ...partes: Buffer[]) => caja(tipo, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...partes);
		const icc = readFileSync(ICC_P3);
		const props = [
			caja('colr', Buffer.from('nclx', 'latin1'), u16be(1), u16be(13), u16be(1), Buffer.from([0x80])), // 1
			caja('irot', Buffer.from([1])), // 2
			caja('colr', Buffer.from('prof', 'latin1'), icc), // 3
			caja('irot', Buffer.from([3])), // 4
			caja('imir', Buffer.from([0])), // 5
		];
		const heif = (principal: number | null) =>
			Buffer.concat([
				caja('ftyp', Buffer.from('heic', 'latin1'), Buffer.alloc(4), Buffer.from('mif1heic', 'latin1')),
				caja(
					'meta',
					Buffer.alloc(4),
					...(principal === null ? [] : [fullbox('pitm', 0, 0, u16be(principal))]),
					caja('iprp', caja('ipco', ...props), fullbox('ipma', 0, 0, u32be(2), u16be(1), Buffer.from([3, 0x83, 4, 5]), u16be(2), Buffer.from([2, 1, 2]))),
				),
			]);
		expect(orientacionHeif(heif(1))).toEqual({rotacion: -90, espejo: true});
		const c1 = colorDeHeif(heif(1));
		expect([c1.fuente, c1.icc?.equals(icc), c1.cicp]).toEqual(['colr-prof', true, null]);
		expect(orientacionHeif(heif(2))).toEqual({rotacion: 90, espejo: false});
		expect(colorDeHeif(heif(2)).cicp).toEqual({primarios: 1, transferencia: 13, matriz: 1, rangoCompleto: true});
		expect(orientacionHeif(heif(null))).toBeNull();
		expect(colorDeHeif(heif(null)).fuente).toBe('colr-nclx');
	});

	it.skipIf(!hayIcc)('decidirColor: P3 se convierte, sRGB no, sin perfil se asume sRGB y HDR es código 2', () => {
		expect(decidirColor({fuente: 'iCCP', icc: readFileSync(ICC_P3), cicp: null, srgb: false}).convertido).toBe(true);
		const s = decidirColor({fuente: 'iCCP', icc: readFileSync(ICC_SRGB), cicp: null, srgb: false});
		expect([s.convertido, s.conversion]).toEqual([false, null]);
		expect(decidirColor({fuente: 'cICP', icc: null, cicp: {primarios: 1, transferencia: 13, matriz: 0, rangoCompleto: true}, srgb: false}).convertido).toBe(false);
		expect(decidirColor({fuente: 'cICP', icc: null, cicp: {primarios: 12, transferencia: 13, matriz: 0, rangoCompleto: true}, srgb: false}).perfil_origen).toMatch(/Display P3/);
		const nada = decidirColor({fuente: 'ninguna', icc: null, cicp: null, srgb: false});
		expect(nada.nota).toMatch(/se asume sRGB/);
		// HEIC de sips: nclx "sin especificar" (2/2) junto a un perfil Display P3 → manda el perfil.
		const sips = decidirColor({fuente: 'colr-nclx', icc: readFileSync(ICC_P3), cicp: {primarios: 2, transferencia: 2, matriz: 2, rangoCompleto: true}, srgb: false});
		expect([sips.fuente, sips.perfil_origen, sips.convertido]).toEqual(['colr-prof', 'Display P3', true]);
		expect(decidirColor({fuente: 'colr-nclx', icc: null, cicp: {primarios: 2, transferencia: 2, matriz: 2, rangoCompleto: true}, srgb: false}).nota).toMatch(/sin especificar/);
		expect(decidirColor({fuente: 'iCCP', icc: Buffer.from('basura'), cicp: null, srgb: false}).nota).toMatch(/no se pudo leer/);
		const hdr = capturarFallo(() => decidirColor({fuente: 'cICP', icc: null, cicp: {primarios: 9, transferencia: 16, matriz: 0, rangoCompleto: false}, srgb: false}));
		expect(hdr.codigo).toBe(2);
	});

	it.skipIf(!hayIcc)('píxeles: P3 → sRGB igual a la matriz publicada (±1 de 255) y el alfa se conserva', () => {
		const conv = prepararConversion(leerIcc(readFileSync(ICC_P3)));
		const n = PARCHES.length;
		const datos = Buffer.alloc(n * 4);
		PARCHES.forEach(([r, g, b], k) => datos.set([r, g, b, k === 0 ? 0 : 255], k * 4));
		const r = pixelesASrgb8({ancho: n, alto: 1, profundidad: 4, maxval: 255, datos}, conv);
		expect(r.canales).toBe(4);
		PARCHES.forEach((c, k) => {
			const esperado = esperadoP3(c);
			for (let j = 0; j < 3; j++) expect(Math.abs(r.datos[k * 4 + j] - esperado[j])).toBeLessThanOrEqual(1);
		});
		expect(r.datos[3]).toBe(0);
		expect(r.datos[7]).toBe(255);
		const opaca = pixelesASrgb8({ancho: 1, alto: 1, profundidad: 4, maxval: 255, datos: Buffer.from([128, 64, 0, 255])}, null);
		expect(opaca.canales).toBe(3);
		expect([...opaca.datos]).toEqual([128, 64, 0]);
		expect(() => pixelesASrgb8({ancho: 1, alto: 1, profundidad: 4, maxval: 65535, datos: Buffer.alloc(8)}, null)).toThrow();
	});
});

// ───────────────────────── videos de verdad ─────────────────────────

describe('videos (ffmpeg real)', () => {
	let rotado: string;

	beforeAll(() => {
		const dir = join(tmp, 'entrada');
		mkdirSync(dir, {recursive: true});
		// Fondo azul con un cuadro rojo arriba a la izquierda del cuadro GUARDADO: 320×180 a 60 fps + tono a 44.1 kHz.
		const plano = join(dir, 'plano.mp4');
		ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=60:d=1.5,drawbox=x=0:y=0:w=60:h=60:color=red:t=fill', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', 'location=+32.5056-116.9933/', '-shortest', plano]);
		// Rotación −90 como tus clips del iPhone (ffprobe: rotation −90).
		rotado = join(dir, 'IMG_9001.MOV');
		ffmpeg(['-display_rotation:v:0', '-90', '-i', plano, '-c', 'copy', rotado]);
	});

	it('clip rotado −90 a 60 fps → vertical 180×320, 30/1 CFR, H.264 yuv420p BT.709, sin rotación, audio AAC 48 kHz, sin metadatos; el original intacto', async () => {
		const antes = huella(rotado);
		const [r] = await procesarInserts({slug: '_prueba-video', entradas: [rotado], ocr: false, proyectos});
		expect(huella(rotado)).toEqual(antes);
		const m = r.meta;
		expect([m.id, m.tipo, m.ancho, m.alto, m.fps, m.cuadros, m.tiene_audio, m.rotacion_original]).toEqual(['img-9001', 'video', 180, 320, 30, 45, true, -90]);
		expect(m.duracion_s).toBeCloseTo(1.5, 6);
		expect(m.asset).toBe('p/_prueba-video/inserts/img-9001.mp4');
		expect(m.origen.sha256).toBe(antes.sha);
		expect(m.revision.estado).toBe('NO_APLICA');
		const s = await sondear(r.ruta);
		expect([s.video.codec, s.video.pixFmt, s.video.rFrameRate, s.video.avgFrameRate, s.video.rotacion, s.video.ancho, s.video.alto]).toEqual(['h264', 'yuv420p', '30/1', '30/1', 0, 180, 320]);
		expect([s.video.colorPrimaries, s.video.colorTransfer, s.video.colorSpace]).toEqual(['bt709', 'bt709', 'bt709']);
		expect([s.audio?.codec, s.audio?.sampleRate, s.audio?.canales]).toEqual(['aac', 48000, 2]);
		expect(s.video.cuadros).toBe(45);
		const tags = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', r.ruta], {encoding: 'utf8'}).stdout;
		expect(tags).not.toMatch(/location/i);
		// La rotación se aplicó en los píxeles: el cuadro rojo (arriba a la izquierda del cuadro guardado) queda
		// arriba a la DERECHA al girar 90° en el sentido del reloj, como se ve el clip en el iPhone.
		const cuadro = ffmpeg(['-i', r.ruta, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
		const img = {datos: cuadro, ancho: 180};
		const [rr, gr, br] = pixel(img, 165, 15);
		const [ra, ga, ba] = pixel(img, 15, 15);
		expect(rr > 180 && gr < 60 && br < 60).toBe(true);
		expect(ba > 180 && ra < 60 && ga < 60).toBe(true);
		const manifest = JSON.parse(readFileSync(join(proyectos, '_prueba-video', 'manifest.json'), 'utf8'));
		expect(manifest.etapas['insert-img-9001'].entradas[0].sha256).toBe(antes.sha);
		expect(manifest.etapas['insert-img-9001'].salidas[0].ruta).toBe('inserts/img-9001.mp4');
	});

	it('reutiliza lo ya procesado; --forzar lo rehace', async () => {
		const [r1] = await procesarInserts({slug: '_prueba-video', entradas: [rotado], ocr: false, proyectos});
		expect(r1.reutilizado).toBe(true);
		const [r2] = await procesarInserts({slug: '_prueba-video', entradas: [rotado], ocr: false, proyectos, forzar: true});
		expect(r2.reutilizado).toBe(false);
		expect(r2.meta.salida.sha256).toBe(r1.meta.salida.sha256);
	});

	it('horizontal 1920×1080 sin audio → 1440×810 sin audio; uno chico no se agranda; VFR → 30/1', async () => {
		const dir = join(tmp, 'entrada-2');
		mkdirSync(dir, {recursive: true});
		const ancho = join(dir, 'ancho.mp4');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ancho]);
		const chico = join(dir, 'chico.mov');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', chico]);
		const vfr = join(dir, 'vfr.mp4');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=60:d=2', '-vf', "select='not(eq(mod(n,3),2))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', vfr]);
		const rs = await procesarInserts({slug: '_prueba-video', entradas: [dir], ocr: false, proyectos});
		const por = Object.fromEntries(rs.map((r) => [r.meta.id, r.meta]));
		expect([por.ancho.ancho, por.ancho.alto, por.ancho.tiene_audio]).toEqual([1440, 810, false]);
		expect([por.chico.ancho, por.chico.alto, por.chico.tiene_audio]).toEqual([720, 1280, true]);
		expect(por.vfr.cuadros).toBe(60);
		const s = await sondear(join(dirInserts('_prueba-video', proyectos), 'vfr.mp4'));
		expect([s.video.rFrameRate, s.video.avgFrameRate, s.video.vfr]).toEqual(['30/1', '30/1', false]);
	});

	it('un video HDR (HLG) sale con código 2 antes de convertir nada', async () => {
		const hdr = join(tmp, 'hdr.mov');
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=0.5', '-vf', 'format=yuv420p,setparams=color_trc=arib-std-b67:color_primaries=bt2020:colorspace=bt2020nc', '-c:v', 'libx264', '-preset', 'ultrafast', hdr]);
		expect((await sondear(hdr)).video.hdr).toBe(true);
		const f = await capturarFalloAsync(() => procesarInserts({slug: '_prueba-hdr', entradas: [hdr], ocr: false, proyectos}));
		expect(f.codigo).toBe(2);
		expect(f.message).toMatch(/HDR/);
		expect(existsSync(dirInserts('_prueba-hdr', proyectos))).toBe(false);
	});

	it('dos originales distintos con el mismo nombre → ids "clip" y "clip-2"; el mismo original reutiliza su id', async () => {
		const a = join(tmp, 'a');
		const b = join(tmp, 'b');
		mkdirSync(a, {recursive: true});
		mkdirSync(b, {recursive: true});
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(a, 'clip.mp4')]);
		ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(b, 'clip.mp4')]);
		const rs = await procesarInserts({slug: '_prueba-ids', entradas: [join(a, 'clip.mp4'), join(b, 'clip.mp4')], ocr: false, proyectos});
		expect(rs.map((r) => r.meta.id)).toEqual(['clip', 'clip-2']);
		const dir = dirInserts('_prueba-ids', proyectos);
		expect(asignarId(dir, 'clip.mp4', rs[1].meta.origen.sha256)).toBe('clip-2');
		expect(listarMetas(dir).map((m) => m.id)).toEqual(['clip', 'clip-2']);
	});

	it('entradas inválidas: no existe, tipo no soportado, imagen que no es imagen, o un insert ya procesado → código 2', async () => {
		expect(capturarFallo(() => expandirEntradas([join(tmp, 'no-existe.mov')])).codigo).toBe(2);
		const gif = join(tmp, 'a.gif');
		writeFileSync(gif, 'GIF89a');
		expect(capturarFallo(() => expandirEntradas([gif])).codigo).toBe(2);
		const falsa = join(tmp, 'falsa.png');
		writeFileSync(falsa, 'GIF89a esto no es un png');
		expect((await capturarFalloAsync(() => procesarInserts({slug: '_prueba-mal', entradas: [falsa], ocr: false, proyectos}))).codigo).toBe(2);
		const yaProcesado = join(dirInserts('_prueba-video', proyectos), 'img-9001.mp4');
		expect((await capturarFalloAsync(() => procesarInserts({slug: '_prueba-video', entradas: [yaProcesado], ocr: false, proyectos}))).codigo).toBe(2);
		const vacia = join(tmp, 'vacia');
		mkdirSync(vacia, {recursive: true});
		writeFileSync(join(vacia, 'notas.txt'), 'x');
		expect(capturarFallo(() => expandirEntradas([vacia])).codigo).toBe(2);
	});
});

// ───────────────────────── imágenes de verdad ─────────────────────────

describe('imágenes (ffmpeg real)', () => {
	const procesarUna = async (nombre: string, bytes: Buffer, escaner: Escaner = escanerLimpio) => {
		const ruta = join(tmp, 'imagenes', nombre);
		mkdirSync(join(tmp, 'imagenes'), {recursive: true});
		writeFileSync(ruta, bytes);
		const antes = huella(ruta);
		const [r] = await procesarInserts({slug: '_prueba-img', entradas: [ruta], proyectos, escaner});
		expect(huella(ruta)).toEqual(antes);
		return r;
	};

	it.skipIf(!hayIcc)('PNG con perfil Display P3 → PNG sRGB con los colores de la matriz publicada (±1), chunks sRGB y sin ICC ni EXIF', async () => {
		const png = pngConChunks(pngDe(crudoDeParches(), 80, 16), [chunkIccp(readFileSync(ICC_P3))]);
		const r = await procesarUna('p3.png', png);
		expect(r.meta.detalle.color).toEqual({fuente: 'iCCP', perfil_origen: 'Display P3', convertido_a_srgb: true});
		const salida = readFileSync(r.ruta);
		const chunks = chunksDePng(salida);
		expect(chunks).toContain('sRGB');
		expect(chunks.some((c) => ['iCCP', 'eXIf', 'cICP', 'tEXt', 'iTXt'].includes(c))).toBe(false);
		const img = rgbDe(r.ruta);
		PARCHES.forEach((c, k) => {
			const esperado = esperadoP3(c);
			const real = pixel(img, k * 16 + 8, 8);
			for (let j = 0; j < 3; j++) expect(Math.abs(real[j] - esperado[j])).toBeLessThanOrEqual(1);
		});
		expect(r.meta.revision.estado).toBe('LIMPIA');
	});

	it.skipIf(!hayIcc)('PNG con cICP P3 y su ICC (como tus capturas de macOS) se convierte UNA sola vez', async () => {
		const png = pngConChunks(pngDe(crudoDeParches(), 80, 16), [chunkIccp(readFileSync(ICC_P3)), chunkPng('cICP', Buffer.from([12, 13, 0, 1]))]);
		const r = await procesarUna('captura-mac.png', png);
		expect((r.meta.detalle.color as {fuente: string}).fuente).toBe('cICP');
		const img = rgbDe(r.ruta);
		PARCHES.forEach((c, k) => {
			const esperado = esperadoP3(c);
			const real = pixel(img, k * 16 + 8, 8);
			for (let j = 0; j < 3; j++) expect(Math.abs(real[j] - esperado[j])).toBeLessThanOrEqual(1);
		});
	});

	it.skipIf(!hayIcc)('PNG con perfil sRGB: los píxeles no cambian', async () => {
		const png = pngConChunks(pngDe(crudoDeParches(), 80, 16), [chunkIccp(readFileSync(ICC_SRGB))]);
		const r = await procesarUna('srgb.png', png);
		expect((r.meta.detalle.color as {convertido_a_srgb: boolean}).convertido_a_srgb).toBe(false);
		const img = rgbDe(r.ruta);
		PARCHES.forEach((c, k) => expect(pixel(img, k * 16 + 8, 8)).toEqual(c));
	});

	it.skipIf(!hayIcc)('JPEG con ICC Display P3 en APP2 → convertido (±3, JPEG con pérdida)', async () => {
		const icc = readFileSync(ICC_P3);
		const jpeg = jpegConSegmentos(jpegDe(crudoDeParches(), 80, 16), [app2Icc(icc, 1, 1)]);
		const r = await procesarUna('foto-p3.jpg', jpeg);
		expect((r.meta.detalle.color as {perfil_origen: string}).perfil_origen).toBe('Display P3');
		const img = rgbDe(r.ruta);
		PARCHES.forEach((c, k) => {
			const esperado = esperadoP3(c);
			const real = pixel(img, k * 16 + 8, 8);
			for (let j = 0; j < 3; j++) expect(Math.abs(real[j] - esperado[j])).toBeLessThanOrEqual(3);
		});
	});

	it('JPEG con orientación EXIF 6 → se gira: 640×360 guardado sale 360×640 y rotacion_original = −90', async () => {
		const crudo = Buffer.alloc(640 * 360 * 3);
		for (let y = 0; y < 360; y++)
			for (let x = 0; x < 640; x++) crudo.set(x < 80 && y < 80 ? [230, 20, 20] : [20, 20, 230], (y * 640 + x) * 3);
		const jpeg = jpegConSegmentos(jpegDe(crudo, 640, 360), [app1Orientacion(6)]);
		const r = await procesarUna('girada.jpg', jpeg);
		expect([r.meta.ancho, r.meta.alto, r.meta.rotacion_original, r.meta.espejo]).toEqual([360, 640, -90, false]);
		const img = rgbDe(r.ruta);
		expect([img.ancho, img.alto]).toEqual([360, 640]);
		const arribaDerecha = pixel(img, 340, 20);
		const arribaIzquierda = pixel(img, 20, 20);
		expect(arribaDerecha[0] > 180 && arribaDerecha[2] < 80).toBe(true);
		expect(arribaIzquierda[2] > 180 && arribaIzquierda[0] < 80).toBe(true);
	});

	it.skipIf(!hayIcc || !hayCwebp)('WebP con ICC Display P3 (VP8X + ICCP) → convertido (±1, sin pérdida)', async () => {
		const pngPlano = join(tmp, 'parches.png');
		writeFileSync(pngPlano, pngDe(crudoDeParches(), 80, 16));
		const simple = join(tmp, 'parches.webp');
		const c = spawnSync('cwebp', ['-quiet', '-lossless', '-exact', pngPlano, '-o', simple]);
		expect(c.status).toBe(0);
		const r = await procesarUna('p3.webp', webpConIcc(readFileSync(simple), readFileSync(ICC_P3), 80, 16));
		expect((r.meta.detalle.color as {fuente: string}).fuente).toBe('ICCP');
		const img = rgbDe(r.ruta);
		PARCHES.forEach((col, k) => {
			const esperado = esperadoP3(col);
			const real = pixel(img, k * 16 + 8, 8);
			for (let j = 0; j < 3; j++) expect(Math.abs(real[j] - esperado[j])).toBeLessThanOrEqual(1);
		});
	});

	it('lado mayor ≤ 2560 sin agrandar (horizontal, vertical y chica)', async () => {
		const grande = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=3000x1200', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
		const alta = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1200x3000', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
		const chica = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
		const g = await procesarUna('grande.png', grande);
		const a = await procesarUna('alta.png', alta);
		const c = await procesarUna('chica.png', chica);
		expect([g.meta.ancho, g.meta.alto]).toEqual([2560, 1024]);
		expect([a.meta.ancho, a.meta.alto]).toEqual([1024, 2560]);
		expect([c.meta.ancho, c.meta.alto]).toEqual([800, 600]);
		expect([rgbDe(g.ruta).ancho, rgbDe(a.ruta).alto]).toEqual([2560, 2560]);
	});

	it('alfa: una captura con transparencia sale RGBA (alfa 0 donde era transparente); una opaca sale RGB', async () => {
		const crudo = Buffer.alloc(64 * 32 * 4);
		for (let y = 0; y < 32; y++)
			for (let x = 0; x < 64; x++) crudo.set([200, 30, 30, x < 32 ? 0 : 255], (y * 64 + x) * 4);
		const r = await procesarUna('ventana.png', pngDe(crudo, 64, 32, 4));
		const salida = readFileSync(r.ruta);
		expect(salida[25]).toBe(6);
		const rgba = ffmpeg(['-i', r.ruta, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
		expect(rgba[(16 * 64 + 8) * 4 + 3]).toBe(0);
		expect(rgba[(16 * 64 + 48) * 4 + 3]).toBe(255);
		expect(r.meta.detalle.alfa).toBe(true);
		const opaca = await procesarUna('opaca.png', pngDe(crudoDeParches(), 80, 16));
		expect(readFileSync(opaca.ruta)[25]).toBe(2);
	});

	it('una imagen HDR (cICP con PQ) → código 2 sin escribir nada', async () => {
		const png = pngConChunks(pngDe(crudoDeParches(), 80, 16), [chunkPng('cICP', Buffer.from([9, 16, 0, 1]))]);
		const ruta = join(tmp, 'hdr.png');
		writeFileSync(ruta, png);
		const f = await capturarFalloAsync(() => procesarInserts({slug: '_prueba-hdr-img', entradas: [ruta], ocr: false, proyectos}));
		expect(f.codigo).toBe(2);
		expect(existsSync(dirInserts('_prueba-hdr-img', proyectos))).toBe(false);
	});
});

// ───────────────────────── OCR de secretos ─────────────────────────

describe('OCR de secretos en capturas', () => {
	const slug = '_prueba-ocr';
	const preparar = (nombre: string, colorFondo: [number, number, number] = [240, 240, 240]) => {
		const crudo = Buffer.alloc(64 * 32 * 3);
		for (let i = 0; i < 64 * 32; i++) crudo.set(colorFondo, i * 3);
		const ruta = join(tmp, 'ocr', nombre);
		mkdirSync(join(tmp, 'ocr'), {recursive: true});
		writeFileSync(ruta, pngDe(crudo, 64, 32));
		return ruta;
	};

	it('con hallazgos queda BLOQUEADA (sin guardar el secreto), no entra a la EDL y tu aprobación la libera hasta que cambie', async () => {
		const ruta = preparar('llave.png');
		const [r] = await procesarInserts({slug, entradas: [ruta], proyectos, escaner: escanerConLlave});
		const dir = dirInserts(slug, proyectos);
		expect(r.meta.revision.estado).toBe('BLOQUEADA');
		expect(r.meta.revision.hallazgos).toEqual([{tipo: 'llave sk-', muestra: 'sk-…(28)', caja: {x: 10, y: 20, w: 300, h: 24}}]);
		expect(r.meta.revision.siguiente_paso).toContain(`--aprobar ${r.meta.id}`);
		expect(estadoInsert(dir, r.meta).usable).toBe(false);
		expect(capturarFallo(() => insertParaEdicion(r.meta, {desde: 0, hasta: 1, layout: 'pantalla-completa'})).codigo).toBe(2);
		const edl = {inserts: [{...insertParaEdicion({...r.meta, revision: {...r.meta.revision, estado: 'LIMPIA'}}, {desde: 0, hasta: 1, layout: 'pantalla-completa'}), asset: `p/${slug}/inserts/llave.png`}]};
		expect(problemasDeInserts(edl, proyectos).map((p) => p.regla)).toEqual(['secretos']);

		const aprobada = aprobarInsert(dir, r.meta.id, 'Creador');
		expect(aprobada.revision.estado).toBe('APROBADA');
		expect(aprobada.revision.aprobado_por).toBe('Creador');
		expect(estadoInsert(dir, aprobada).usable).toBe(true);
		expect(insertParaEdicion(aprobada, {desde: 0, hasta: 1, layout: 'pantalla-completa'}).asset).toBe(`p/${slug}/inserts/llave.png`);
		expect(problemasDeInserts(edl, proyectos)).toEqual([]);
		// Re-escanear el mismo archivo con lo mismo: sigue aprobada.
		const re = await escanearPendientes({slug, proyectos, escaner: escanerConLlave, todas: true});
		expect(re[0].revision.estado).toBe('APROBADA');

		// Si el archivo cambia, se vuelve a bloquear.
		writeFileSync(join(dir, 'llave.png'), readFileSync(preparar('otra.png', [10, 10, 10])));
		const actual = leerMetaInsert(dir, 'llave') as MetaInsert;
		expect(estadoInsert(dir, actual)).toMatchObject({estado: 'BLOQUEADA', usable: false});
		expect(capturarFallo(() => aprobarInsert(dir, 'llave')).codigo).toBe(2);
		expect(problemasDeInserts(edl, proyectos)[0].detalle).toMatch(/cambió/);
	});

	it('si Vision no puede correr (sandbox) queda SIN_ESCANEAR, no entra y no se puede aprobar; --escanear la limpia después', async () => {
		const ruta = preparar('sin-vision.png', [200, 220, 240]);
		const [r] = await procesarInserts({slug, entradas: [ruta], proyectos, escaner: escanerSandbox});
		const dir = dirInserts(slug, proyectos);
		expect(r.meta.revision.estado).toBe('SIN_ESCANEAR');
		expect(r.meta.revision.motivo).toMatch(/Vision/);
		expect(r.meta.revision.siguiente_paso).toMatch(/--escanear/);
		expect(capturarFallo(() => insertParaEdicion(r.meta, {desde: 0, hasta: 1, layout: 'tarjeta'})).codigo).toBe(2);
		expect(capturarFallo(() => aprobarInsert(dir, r.meta.id)).codigo).toBe(2);
		const escaneadas = await escanearPendientes({slug, proyectos, escaner: escanerLimpio});
		expect(escaneadas.map((m) => [m.id, m.revision.estado])).toContainEqual(['sin-vision', 'LIMPIA']);
		expect(estadoInsert(dir, leerMetaInsert(dir, 'sin-vision') as MetaInsert).usable).toBe(true);
		// Un re-escaneo que no puede correr (sandbox) no borra el resultado válido del mismo archivo…
		await escanearPendientes({slug, proyectos, escaner: escanerSandbox, todas: true});
		expect((leerMetaInsert(dir, 'sin-vision') as MetaInsert).revision.estado).toBe('LIMPIA');
		// …ni un reproceso con --forzar que deja el PNG idéntico.
		const [otra] = await procesarInserts({slug, entradas: [ruta], proyectos, escaner: escanerSandbox, forzar: true});
		expect([otra.reutilizado, otra.meta.revision.estado]).toEqual([false, 'LIMPIA']);
	});

	it('--sin-ocr deja la captura SIN_ESCANEAR; el escáner real (Vision) da LIMPIA fuera del sandbox o SIN_ESCANEAR dentro', async () => {
		const [r] = await procesarInserts({slug, entradas: [preparar('sin-ocr.png', [90, 90, 90])], proyectos, ocr: false});
		expect(r.meta.revision.estado).toBe('SIN_ESCANEAR');
		expect(r.meta.revision.motivo).toMatch(/sin-ocr/);
		const [real] = await procesarInserts({slug, entradas: [preparar('vision-real.png', [120, 140, 160])], proyectos});
		expect(['LIMPIA', 'SIN_ESCANEAR']).toContain(real.meta.revision.estado);
	});
});

// ───────────────────────── para la EDL ─────────────────────────

describe('insertParaEdicion y problemasDeInserts', () => {
	it('video vertical en tarjeta: caja por defecto 461.25×820 centrada en (540, 995), mudo a −12 dB, trim 0, tapaCabeza false', () => {
		const ins = insertParaEdicion(metaDePrueba(), {desde: 0.8, hasta: 2.8, layout: 'tarjeta'});
		expect(ins).toEqual({
			id: 'ins-img-5091',
			tipo: 'video',
			desde: 0.8,
			hasta: 2.8,
			asset: 'p/_prueba/inserts/img-5091.mp4',
			trim_desde: 0,
			layout: 'tarjeta',
			caja: {x: 540, y: 995, w: 461.25, h: ALTO_MAX_TARJETA},
			tapaCabeza: false,
			texto: null,
			eventos: null,
			audio: {modo: 'mute', ganancia_db: -12},
			sfx: null,
		});
		expect(EsquemaInsert.safeParse(ins).success).toBe(true);
	});

	it('cajas: horizontal 770 de ancho; con solo w o solo h el otro sale de la proporción; pantalla completa tapa la cabeza y no lleva caja', () => {
		expect(cajaTarjeta({ancho: 1440, alto: 810})).toEqual({x: 540, y: 995, w: 770, h: 433.13});
		expect(cajaTarjeta({ancho: 1440, alto: 2560}, {w: 450, escala: 0.9})).toEqual({x: 540, y: 995, w: 450, h: 800, escala: 0.9});
		expect(cajaTarjeta({ancho: 2560, alto: 1600}, {h: 400, x: 500, y: 1100})).toEqual({x: 500, y: 1100, w: 640, h: 400});
		const pc = insertParaEdicion(metaDePrueba({tipo: 'imagen', archivo: 'repo.png', asset: 'p/_prueba/inserts/repo.png', ancho: 2560, alto: 1600, duracion_s: null, fps: null, cuadros: null, tiene_audio: false, revision: {...metaDePrueba().revision, estado: 'LIMPIA', sha256: 'd'.repeat(64)}}), {desde: 3.5, hasta: 5, layout: 'pantalla-completa', texto: 'Así se ve', trim_desde: 9});
		expect(pc.tapaCabeza).toBe(true);
		expect(pc.caja).toBeUndefined();
		expect(pc.trim_desde).toBe(0);
		expect(pc.texto).toBe('Así se ve');
		expect(pc.tipo).toBe('imagen');
	});

	it('errores con código 2: tiempos al revés, clip que se acaba, trim negativo y "duck" sin audio', () => {
		const m = metaDePrueba();
		expect(capturarFallo(() => insertParaEdicion(m, {desde: 2, hasta: 2, layout: 'tarjeta'})).codigo).toBe(2);
		expect(capturarFallo(() => insertParaEdicion(m, {desde: 0, hasta: 3.5, layout: 'tarjeta'})).codigo).toBe(2);
		expect(capturarFallo(() => insertParaEdicion(m, {desde: 0, hasta: 2, layout: 'tarjeta', trim_desde: 1.5})).codigo).toBe(2);
		expect(capturarFallo(() => insertParaEdicion(m, {desde: 0, hasta: 1, layout: 'tarjeta', trim_desde: -1})).codigo).toBe(2);
		expect(capturarFallo(() => insertParaEdicion(metaDePrueba({tiene_audio: false}), {desde: 0, hasta: 1, layout: 'tarjeta', audio: {modo: 'duck'}})).codigo).toBe(2);
		expect(insertParaEdicion(m, {desde: 0, hasta: 3.1, layout: 'tarjeta', audio: {modo: 'duck', ganancia_db: -6}}).audio).toEqual({modo: 'duck', ganancia_db: -6});
	});

	it('una EDL con un video en tarjeta y una captura a pantalla completa pasa el contrato completo', () => {
		const video = insertParaEdicion(metaDePrueba(), {desde: 0.8, hasta: 2.8, layout: 'tarjeta'});
		const imagen = insertParaEdicion(metaDePrueba({id: 'repo', tipo: 'imagen', archivo: 'repo.png', asset: 'p/_prueba/inserts/repo.png', ancho: 2560, alto: 1600, duracion_s: null, fps: null, cuadros: null, tiene_audio: false, revision: {...metaDePrueba().revision, estado: 'LIMPIA'}}), {desde: 3.5, hasta: 5, layout: 'pantalla-completa'});
		const r = EdicionValidada.safeParse({...edicionVacia, duracion_s: 6, inserts: [video, imagen]});
		expect(r.success).toBe(true);
	});

	it('problemasDeInserts: falta el .json, clip demasiado largo, tipo equivocado, y los assets que no son de inserts/ no se revisan', async () => {
		const [r] = await procesarInserts({slug: '_prueba-video', entradas: [join(tmp, 'entrada', 'IMG_9001.MOV')], ocr: false, proyectos});
		const bien = insertParaEdicion(r.meta, {desde: 0, hasta: 1.5, layout: 'pantalla-completa'});
		expect(problemasDeInserts({inserts: [bien]}, proyectos)).toEqual([]);
		const largo = {...bien, id: 'b2', hasta: 2};
		const tipo = {...bien, id: 'b3', tipo: 'imagen' as const};
		const falta = {...bien, id: 'b4', asset: 'p/_prueba-video/inserts/no-existe.mp4'};
		const ajeno = {...bien, id: 'b5', asset: 'demos/x/toma.mp4', tipo: 'demo' as const};
		const problemas = problemasDeInserts({inserts: [largo, tipo, falta, ajeno]}, proyectos);
		expect(problemas.map((p) => [p.donde, p.regla])).toEqual([
			['inserts.b2', 'insert'],
			['inserts.b3', 'insert'],
			['inserts.b4', 'insert'],
		]);
		expect(readdirSync(dirInserts('_prueba-video', proyectos)).some((n) => n.includes('.tmp-'))).toBe(false);
	});
});
