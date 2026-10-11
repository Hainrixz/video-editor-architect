/**
 * Inserts de tu material (Fase 4): capturas y B-roll listos para la edición.
 *
 *   procesarInserts({slug, entradas}) → por cada archivo: proyectos/<slug>/inserts/<id>.<ext> + <id>.json
 *
 * VIDEOS (.mov, .mp4, .m4v) → <id>.mp4
 *   - Autorrotación: ffmpeg aplica la matriz de rotación del iPhone (−90/+90) y la salida queda sin matriz;
 *     `rotacion_original` guarda la que traía (convención de ffprobe, herramientas/lib/ffprobe.ts).
 *   - 30 fps constantes (filtro fps=30, como la base), H.264 CRF 16 yuv420p BT.709 (matriz, primarios,
 *     transferencia y rango de TV), keyframe cada 15 cuadros (Remotion busca exacto y rápido).
 *   - Ancho máximo 1440 sin agrandar; el alto sale de la proporción (par).
 *   - La pista de AUDIO SE CONSERVA (AAC 48 kHz estéreo): la EDL decide si suena ("duck") o no ("mute", el valor
 *     por defecto de insertParaEdicion).
 *   - Sin metadatos del original (ubicación GPS, fechas, modelo): -map_metadata -1.
 *   - HDR (HLG o PQ) → código 2: la conversión a SDR no está validada (igual que en la ingesta).
 * IMÁGENES (PNG, JPG, HEIC, WebP) → <id>.png sRGB, lado mayor ≤ 2560 sin agrandar
 *   - ffmpeg decodifica (con la orientación EXIF/irot aplicada) y reduce con lanczos a 16 bits por canal (PAM).
 *   - El perfil de color del archivo (cICP de PNG, nclx de HEIC o el ICC de PNG/JPEG/WebP/HEIC) se convierte a
 *     sRGB aquí, con la matriz y las curvas del perfil (colorimétrico relativo, con recorte de gama). Así una
 *     captura de tu Mac o una foto del iPhone (Display P3) no cambian de color en el reel. Se hace en TypeScript
 *     porque el ffmpeg 8.1 de Homebrew no trae lcms2 y `sips` no corre dentro del sandbox (escribe su temporal
 *     en /var/folders).
 *   - El PNG se escribe desde los píxeles: no lleva EXIF (ni GPS) y sí sus chunks sRGB/cHRM/gAMA.
 *   - OCR de secretos (herramientas/grabador/secretos.ts, Apple Vision): si ve algo, la captura queda BLOQUEADA
 *     hasta que la revises tú (--aprobar lo corres tú). Vision no corre dentro del sandbox: ahí queda SIN_ESCANEAR,
 *     que tampoco entra a la edición, hasta que se escanee desde un comando excluido.
 *   - Los videos no pasan por el OCR (revision NO_APLICA): el pedido es para capturas.
 *
 * Originales (entrada/, ~/Downloads): solo se leen (ffprobe, ffmpeg, sha256). La salida siempre es una
 * re-codificación dentro de proyectos/<slug>/inserts/ (rutaSalidaSegura): nunca una copia tal cual en public/.
 * Si el original no cambió (sha256) y los parámetros tampoco, se reutiliza lo ya procesado.
 *
 * Para la EDL: insertParaEdicion(meta, …) arma el objeto Insert de src/esquema/edicion.ts y
 * problemasDeInserts(edicion) revisa una EDL contra los <id>.json (capturas bloqueadas, clips que se acaban).
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, extname, join, resolve, sep} from 'node:path';
import {inflateSync} from 'node:zlib';
import {z} from 'zod';
import {Insert as EsquemaInsert, type Edicion} from '../../src/esquema/edicion.ts';
import {ESTILO_INSERT_POR_DEFECTO} from '../../src/estilo/capas.ts';
import {escanearImagen, type ResultadoEscaneo} from '../grabador/secretos.ts';
import {fallo, FalloEditor} from './fallo.ts';
import {correrFfmpeg, normalizarGrados, rotacionDeMatriz, sondear, type Sondeo} from './ffprobe.ts';
import {DIR_PROYECTOS, dirProyecto, hashParametros, huellaOriginal, registrarEtapa, rutaSalidaSegura, validarSlug, type HuellaOriginal} from './manifest.ts';

// ───────────────────────── parámetros ─────────────────────────

/** Sube este número si cambia cómo se procesa: todo lo procesado antes deja de estar vigente. */
export const VERSION_PROCESO = 1;

export const INSERTS = {
	video: {ancho_max: 1440, fps: 30, crf: 16, preset: 'medium', perfil: 'high', pix_fmt: 'yuv420p', color: 'bt709', gop: 15, escala: 'lanczos'},
	audio: {codec: 'aac', muestreo: 48000, bitrate: '192k', canales: 2},
	imagen: {lado_max: 2560, escala: 'lanczos', salida: 'png sRGB 8 bits'},
} as const;

export const EXTENSIONES_VIDEO: readonly string[] = ['.mov', '.mp4', '.m4v'];
export const EXTENSIONES_IMAGEN: readonly string[] = ['.png', '.jpg', '.jpeg', '.heic', '.heif', '.webp'];

/** Audio de un insert en la EDL si no se pide otra cosa: mudo, y −12 dB por si el director lo cambia a "duck". */
export const AUDIO_INSERT_POR_DEFECTO = {modo: 'mute', ganancia_db: -12} as const;

/**
 * Caja por defecto de un insert en tarjeta (px base 1080×1920): centro y ancho máximo de src/estilo/capas.ts
 * (MEDICIONES_CAPAS.insert_tarjeta: centro (540, 995), ancho 770; n = 2 de tus reels) y alto máximo 820, el más alto
 * de esos mismos 2 inserts (770×820 y 452×800). Un clip vertical queda de ≈ 461×820, como tu captura de reel P1.
 */
export const ALTO_MAX_TARJETA = 820;

// ───────────────────────── metadatos (<id>.json) ─────────────────────────

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const ESTADOS_REVISION_INSERT = ['LIMPIA', 'BLOQUEADA', 'APROBADA', 'SIN_ESCANEAR', 'NO_APLICA'] as const;
export type EstadoRevisionInsert = (typeof ESTADOS_REVISION_INSERT)[number];

export const RevisionInsert = z.object({
	estado: z.enum(ESTADOS_REVISION_INSERT),
	motivo: z.string(),
	escaneado_en: z.string().nullable(),
	/** sha256 del archivo procesado que se escaneó (y aprobó): si el archivo cambia, se vuelve a bloquear. */
	sha256: Sha.nullable(),
	leidos: z.number().int().nonnegative(),
	/** Nunca el secreto: solo su tipo, una muestra censurada ("sk-…(28)") y dónde (px del archivo). */
	hallazgos: z.array(z.object({tipo: z.string(), muestra: z.string(), caja: z.object({x: z.number(), y: z.number(), w: z.number(), h: z.number()})})),
	aprobado_por: z.string().nullable(),
	aprobado_en: z.string().nullable(),
	siguiente_paso: z.string().nullable(),
});
export type RevisionInsert = z.infer<typeof RevisionInsert>;

export const MetaInsert = z.object({
	version: z.literal(1),
	id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
	tipo: z.enum(['video', 'imagen']),
	/** Nombre del archivo procesado dentro de proyectos/<slug>/inserts/. */
	archivo: z.string().min(1),
	/** Ruta para la EDL (relativa a public/). */
	asset: z.string().min(1),
	ancho: z.number().int().positive(),
	alto: z.number().int().positive(),
	duracion_s: z.number().positive().nullable(),
	fps: z.number().positive().nullable(),
	cuadros: z.number().int().positive().nullable(),
	tiene_audio: z.boolean(),
	/** Rotación que traía el original (grados, convención de ffprobe: −90 = el iPhone en vertical). */
	rotacion_original: z.number(),
	espejo: z.boolean(),
	origen: z.object({ruta: z.string(), sha256: Sha, mtime: z.string(), bytes: z.number().int().nonnegative()}),
	procesado_en: z.string(),
	salida: z.object({sha256: Sha, bytes: z.number().int().positive()}),
	parametros_sha256: Sha,
	/** Lo que traía el original y cómo se convirtió (formato, códec, fps, perfil de color…). */
	detalle: z.record(z.string(), z.unknown()),
	revision: RevisionInsert,
	avisos: z.array(z.string()),
});
export type MetaInsert = z.infer<typeof MetaInsert>;

export type InsertEdl = Edicion['inserts'][number];

// ───────────────────────── nombres, tipos y medidas (puro) ─────────────────────────

export type TipoInsert = 'video' | 'imagen';

export function tipoPorExtension(ruta: string): TipoInsert | null {
	const e = extname(ruta).toLowerCase();
	if (EXTENSIONES_VIDEO.includes(e)) return 'video';
	if (EXTENSIONES_IMAGEN.includes(e)) return 'imagen';
	return null;
}

export type FormatoImagen = 'png' | 'jpeg' | 'webp' | 'heif';
const MARCAS_HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Formato real de una imagen por sus primeros bytes (no por la extensión). null si no es uno de los 4. */
export function formatoDeImagen(cab: Buffer): FormatoImagen | null {
	if (cab.length >= 8 && cab.readUInt32BE(0) === 0x89504e47 && cab.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
	if (cab.length >= 3 && cab[0] === 0xff && cab[1] === 0xd8 && cab[2] === 0xff) return 'jpeg';
	if (cab.length >= 12 && cab.toString('latin1', 0, 4) === 'RIFF' && cab.toString('latin1', 8, 12) === 'WEBP') return 'webp';
	if (cab.length >= 16 && cab.toString('latin1', 4, 8) === 'ftyp') {
		const tam = Math.min(cab.readUInt32BE(0), cab.length);
		const marcas = [cab.toString('latin1', 8, 12)];
		for (let i = 16; i + 4 <= tam; i += 4) marcas.push(cab.toString('latin1', i, i + 4));
		if (marcas.some((m) => MARCAS_HEIF.has(m))) return 'heif';
	}
	return null;
}

/** "IMG_5091.MOV" → "img-5091"; "Captura de pantalla 2026-10-03 a la(s) 10.23.08.png" → "captura-de-pantalla-2026-10-03-a-la-s-10-23-08". */
export function idDeArchivo(nombre: string): string {
	const id = basename(nombre, extname(nombre))
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+/, '')
		.slice(0, 60)
		.replace(/-+$/, '');
	return id || 'insert';
}

/** Tamaño de salida de un video: ancho ≤ 1440 sin agrandar, par; alto por proporción, par. */
export function dimensionesVideo(anchoVisible: number, altoVisible: number, anchoMax: number = INSERTS.video.ancho_max): {ancho: number; alto: number} {
	const ancho = Math.max(2, 2 * Math.floor(Math.min(anchoMax, anchoVisible) / 2));
	const alto = Math.max(2, 2 * Math.round((ancho * altoVisible) / anchoVisible / 2));
	return {ancho, alto};
}

/** Tamaño de salida de una imagen: lado mayor ≤ 2560 sin agrandar (el otro, redondeado como lo hace ffmpeg con -1). */
export function dimensionesImagenDestino(ancho: number, alto: number, ladoMax: number = INSERTS.imagen.lado_max): {ancho: number; alto: number} {
	if (Math.max(ancho, alto) <= ladoMax) return {ancho, alto};
	if (ancho >= alto) return {ancho: ladoMax, alto: Math.max(1, Math.round((alto * ladoMax) / ancho))};
	return {ancho: Math.max(1, Math.round((ancho * ladoMax) / alto)), alto: ladoMax};
}

// ───────────────────────── color: contenedores (puro) ─────────────────────────

export type Cicp = {primarios: number; transferencia: number; matriz: number; rangoCompleto: boolean};

export type InfoColorOrigen = {
	/** De dónde salió: chunk o caja del archivo. */
	fuente: 'cICP' | 'iCCP' | 'sRGB' | 'APP2' | 'ICCP' | 'colr-nclx' | 'colr-prof' | 'ninguna';
	icc: Buffer | null;
	cicp: Cicp | null;
	/** Chunk sRGB de PNG (dice "esto es sRGB" sin perfil). */
	srgb: boolean;
};

const sinColor = (): InfoColorOrigen => ({fuente: 'ninguna', icc: null, cicp: null, srgb: false});

/** PNG: cICP (manda), iCCP (perfil comprimido con zlib) y sRGB. Se detiene en el primer IDAT. */
export function colorDePng(buf: Buffer): InfoColorOrigen {
	const info = sinColor();
	let i = 8;
	while (i + 12 <= buf.length) {
		const n = buf.readUInt32BE(i);
		const tipo = buf.toString('latin1', i + 4, i + 8);
		if (tipo === 'IDAT' || tipo === 'IEND' || i + 12 + n > buf.length) break;
		const datos = buf.subarray(i + 8, i + 8 + n);
		if (tipo === 'cICP' && n >= 4) info.cicp = {primarios: datos[0], transferencia: datos[1], matriz: datos[2], rangoCompleto: datos[3] === 1};
		else if (tipo === 'iCCP') {
			const nulo = datos.indexOf(0);
			if (nulo > 0 && datos[nulo + 1] === 0) {
				try {
					info.icc = inflateSync(datos.subarray(nulo + 2));
				} catch {
					// Perfil dañado: se trata como si no tuviera (se asume sRGB y se avisa).
				}
			}
		} else if (tipo === 'sRGB') info.srgb = true;
		i += 12 + n;
	}
	info.fuente = info.cicp ? 'cICP' : info.icc ? 'iCCP' : info.srgb ? 'sRGB' : 'ninguna';
	return info;
}

/** JPEG: segmentos APP2 "ICC_PROFILE" (pueden ser varios; se unen por su número de secuencia). */
export function colorDeJpeg(buf: Buffer): InfoColorOrigen {
	const info = sinColor();
	const trozos: Array<{n: number; datos: Buffer}> = [];
	let i = 2;
	while (i + 4 <= buf.length) {
		if (buf[i] !== 0xff) break;
		const marca = buf[i + 1];
		if (marca === 0xff) {
			i++;
			continue;
		}
		if (marca === 0xd9 || marca === 0xda) break;
		if (marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) {
			i += 2;
			continue;
		}
		const largo = buf.readUInt16BE(i + 2);
		if (largo < 2 || i + 2 + largo > buf.length) break;
		const datos = buf.subarray(i + 4, i + 2 + largo);
		if (marca === 0xe2 && datos.length > 14 && datos.toString('latin1', 0, 12) === 'ICC_PROFILE\0') trozos.push({n: datos[12], datos: datos.subarray(14)});
		i += 2 + largo;
	}
	if (trozos.length) {
		info.icc = Buffer.concat(trozos.sort((a, b) => a.n - b.n).map((t) => t.datos));
		info.fuente = 'APP2';
	}
	return info;
}

/** WebP: chunk ICCP (formato extendido VP8X). */
export function colorDeWebp(buf: Buffer): InfoColorOrigen {
	const info = sinColor();
	let i = 12;
	while (i + 8 <= buf.length) {
		const tipo = buf.toString('latin1', i, i + 4);
		const n = buf.readUInt32LE(i + 4);
		if (i + 8 + n > buf.length) break;
		if (tipo === 'ICCP') {
			info.icc = Buffer.from(buf.subarray(i + 8, i + 8 + n));
			info.fuente = 'ICCP';
			break;
		}
		i += 8 + n + (n % 2);
	}
	return info;
}

type Caja = {tipo: string; datos: number; fin: number};

/** Cajas ISOBMFF entre `inicio` y `fin` (tamaño de 32 o 64 bits; 0 = hasta el final). */
function cajasIso(buf: Buffer, inicio: number, fin: number): Caja[] {
	const salida: Caja[] = [];
	let i = inicio;
	while (i + 8 <= fin) {
		let tam = buf.readUInt32BE(i);
		const tipo = buf.toString('latin1', i + 4, i + 8);
		let cab = 8;
		if (tam === 1) {
			if (i + 16 > fin) break;
			tam = Number(buf.readBigUInt64BE(i + 8));
			cab = 16;
		} else if (tam === 0) tam = fin - i;
		if (tam < cab || i + tam > fin) break;
		salida.push({tipo, datos: i + cab, fin: i + tam});
		i += tam;
	}
	return salida;
}

/** Propiedades (cajas de ipco) de un HEIF: todas, y las del ítem principal (pitm + ipma) si se pueden leer. */
export function propiedadesHeif(buf: Buffer): {todas: Caja[]; principal: Caja[] | null} {
	const meta = cajasIso(buf, 0, buf.length).find((c) => c.tipo === 'meta');
	if (!meta) return {todas: [], principal: null};
	const hijos = cajasIso(buf, meta.datos + 4, meta.fin);
	const iprp = hijos.find((c) => c.tipo === 'iprp');
	const dentro = iprp ? cajasIso(buf, iprp.datos, iprp.fin) : [];
	const ipco = dentro.find((c) => c.tipo === 'ipco');
	if (!ipco) return {todas: [], principal: null};
	const todas = cajasIso(buf, ipco.datos, ipco.fin);
	const pitm = hijos.find((c) => c.tipo === 'pitm');
	if (!pitm || pitm.fin - pitm.datos < 6) return {todas, principal: null};
	const principal = buf[pitm.datos] === 0 ? buf.readUInt16BE(pitm.datos + 4) : buf.readUInt32BE(pitm.datos + 4);
	for (const ipma of dentro.filter((c) => c.tipo === 'ipma')) {
		const version = buf[ipma.datos];
		const anchos = (buf.readUIntBE(ipma.datos + 1, 3) & 1) === 1;
		let i = ipma.datos + 4;
		const n = buf.readUInt32BE(i);
		i += 4;
		for (let k = 0; k < n && i < ipma.fin; k++) {
			const item = version < 1 ? buf.readUInt16BE(i) : buf.readUInt32BE(i);
			i += version < 1 ? 2 : 4;
			const cuantos = buf[i];
			i += 1;
			const indices: number[] = [];
			for (let a = 0; a < cuantos; a++) {
				indices.push(anchos ? buf.readUInt16BE(i) & 0x7fff : buf[i] & 0x7f);
				i += anchos ? 2 : 1;
			}
			if (item === principal) return {todas, principal: indices.filter((x) => x >= 1 && x <= todas.length).map((x) => todas[x - 1])};
		}
	}
	return {todas, principal: null};
}

/**
 * Orientación del ítem principal de un HEIF: irot (giro antihorario en pasos de 90°, como la convención de ffprobe:
 * irot 3 → −90, el de las fotos verticales) e imir (espejo). ffmpeg 8.1 los aplica al decodificar, también en las
 * rejillas de mosaicos, pero ffprobe no los muestra en el grupo; por eso se leen aquí. null si no se puede leer.
 */
export function orientacionHeif(buf: Buffer): {rotacion: number; espejo: boolean} | null {
	const {principal} = propiedadesHeif(buf);
	if (!principal) return null;
	const irot = principal.find((p) => p.tipo === 'irot');
	const angulo = irot && irot.fin > irot.datos ? (buf[irot.datos] & 3) * 90 : 0;
	return {rotacion: normalizarGrados(angulo), espejo: principal.some((p) => p.tipo === 'imir')};
}

/** HEIC/HEIF: la caja colr del ítem principal (o la primera de ipco): perfil ICC "prof"/"rICC" o códigos "nclx". */
export function colorDeHeif(buf: Buffer): InfoColorOrigen {
	const info = sinColor();
	const {todas, principal} = propiedadesHeif(buf);
	const colrs = (principal ?? []).filter((c) => c.tipo === 'colr');
	for (const c of colrs.length ? colrs : todas) {
		if (c.tipo !== 'colr' || c.fin - c.datos < 4) continue;
		const clase = buf.toString('latin1', c.datos, c.datos + 4);
		if ((clase === 'prof' || clase === 'rICC') && !info.icc) {
			info.icc = Buffer.from(buf.subarray(c.datos + 4, c.fin));
			if (!info.cicp) info.fuente = 'colr-prof';
		} else if (clase === 'nclx' && c.fin - c.datos >= 11 && !info.cicp) {
			info.cicp = {primarios: buf.readUInt16BE(c.datos + 4), transferencia: buf.readUInt16BE(c.datos + 6), matriz: buf.readUInt16BE(c.datos + 8), rangoCompleto: (buf[c.datos + 10] & 0x80) !== 0};
			info.fuente = 'colr-nclx';
		}
	}
	return info;
}

export function colorDeImagen(buf: Buffer, formato: FormatoImagen): InfoColorOrigen {
	switch (formato) {
		case 'png':
			return colorDePng(buf);
		case 'jpeg':
			return colorDeJpeg(buf);
		case 'webp':
			return colorDeWebp(buf);
		case 'heif':
			return colorDeHeif(buf);
	}
}

// ───────────────────────── color: perfiles ICC y conversión a sRGB (puro) ─────────────────────────

export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
type Vec3 = [number, number, number];

export const mul3 = (a: Mat3, b: Mat3): Mat3 =>
	[0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3;

export function inv3(m: Mat3): Mat3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const c11 = e * i - f * h;
	const c12 = -(d * i - f * g);
	const c13 = d * h - e * g;
	const det = a * c11 + b * c12 + c * c13;
	if (Math.abs(det) < 1e-12) throw new Error('matriz singular');
	return [
		[c11 / det, -(b * i - c * h) / det, (b * f - c * e) / det],
		[c12 / det, (a * i - c * g) / det, -(a * f - c * d) / det],
		[c13 / det, -(a * h - b * g) / det, (a * e - b * d) / det],
	];
}

const porVector = (m: Mat3, v: Vec3): Vec3 => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];

/** Curva de tono de un perfil (de código a luz lineal). */
export type Curva = {tipo: 'identidad'} | {tipo: 'gamma'; g: number} | {tipo: 'tabla'; valores: number[]} | {tipo: 'parametrica'; funcion: number; p: number[]};

/** La curva sRGB (IEC 61966-2-1) como curva paramétrica tipo 3 del ICC. */
export const CURVA_SRGB: Curva = {tipo: 'parametrica', funcion: 3, p: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]};
/** BT.709 / BT.601 / BT.2020 (inversa de la OETF). */
export const CURVA_BT709: Curva = {tipo: 'parametrica', funcion: 3, p: [1 / 0.45, 1 / 1.099, 0.099 / 1.099, 1 / 4.5, 0.081]};

export function evaluarCurva(c: Curva, x: number): number {
	const v = x <= 0 ? 0 : x >= 1 ? 1 : x;
	switch (c.tipo) {
		case 'identidad':
			return v;
		case 'gamma':
			return Math.pow(v, c.g);
		case 'tabla': {
			const n = c.valores.length;
			if (n === 0) return v;
			if (n === 1) return c.valores[0];
			const pos = v * (n - 1);
			const k = Math.min(n - 2, Math.floor(pos));
			const f = pos - k;
			return c.valores[k] * (1 - f) + c.valores[k + 1] * f;
		}
		case 'parametrica': {
			const [g, a = 1, b = 0, cc = 0, d = 0, e = 0, f = 0] = c.p;
			const base = (t: number) => Math.pow(Math.max(0, t), g);
			switch (c.funcion) {
				case 0:
					return Math.pow(v, g);
				case 1:
					return a !== 0 && v >= -b / a ? base(a * v + b) : 0;
				case 2:
					return a !== 0 && v >= -b / a ? base(a * v + b) + cc : cc;
				case 3:
					return v >= d ? base(a * v + b) : cc * v;
				case 4:
					return v >= d ? base(a * v + b) + e : cc * v + f;
				default:
					return v;
			}
		}
	}
}

/** De luz lineal a código sRGB (0–1). */
export function codificarSrgb(l: number): number {
	if (l <= 0) return 0;
	if (l >= 1) return 1;
	return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/**
 * Colorantes de sRGB adaptados a D50 (Bradford), como vienen en el perfil "sRGB IEC61966-2.1": columnas = rojo, verde,
 * azul en XYZ. Lo de cualquier perfil se lleva a sRGB con inv(SRGB_D50) × matriz del perfil.
 */
export const SRGB_D50: Mat3 = [
	[0.4360747, 0.3850649, 0.1430804],
	[0.2225045, 0.7168786, 0.0606169],
	[0.0139322, 0.0971045, 0.7141733],
];

const BRADFORD: Mat3 = [
	[0.8951, 0.2664, -0.1614],
	[-0.7502, 1.7135, 0.0367],
	[0.0389, -0.0685, 1.0296],
];
/** Iluminante de la PCS del ICC (D50). */
const D50: Vec3 = [0.9642, 1, 0.8249];

export type Primarios = {r: [number, number]; g: [number, number]; b: [number, number]; w: [number, number]};

const D65: [number, number] = [0.3127, 0.329];
/** Primarios por código H.273 (el de cICP y nclx). */
export const PRIMARIOS_H273: Readonly<Record<number, {nombre: string; xy: Primarios}>> = {
	1: {nombre: 'BT.709/sRGB', xy: {r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65}},
	9: {nombre: 'BT.2020', xy: {r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: D65}},
	11: {nombre: 'DCI-P3', xy: {r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: [0.314, 0.351]}},
	12: {nombre: 'Display P3', xy: {r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: D65}},
};

/** Transferencia por código H.273; 16 (PQ) y 18 (HLG) son HDR y no se convierten aquí. */
export const CURVAS_H273: Readonly<Record<number, {nombre: string; curva: Curva}>> = {
	1: {nombre: 'BT.709', curva: CURVA_BT709},
	4: {nombre: 'gamma 2.2', curva: {tipo: 'gamma', g: 2.2}},
	5: {nombre: 'gamma 2.8', curva: {tipo: 'gamma', g: 2.8}},
	6: {nombre: 'BT.601', curva: CURVA_BT709},
	8: {nombre: 'lineal', curva: {tipo: 'identidad'}},
	13: {nombre: 'sRGB', curva: CURVA_SRGB},
	14: {nombre: 'BT.2020', curva: CURVA_BT709},
	15: {nombre: 'BT.2020', curva: CURVA_BT709},
};

/** RGB lineal → XYZ (D50) a partir de los primarios y el blanco, con adaptación Bradford al D50 del ICC. */
export function matrizDePrimarios(p: Primarios): Mat3 {
	const xyz = ([x, y]: [number, number]): Vec3 => [x / y, 1, (1 - x - y) / y];
	const [r, g, b] = [xyz(p.r), xyz(p.g), xyz(p.b)];
	const P: Mat3 = [
		[r[0], g[0], b[0]],
		[r[1], g[1], b[1]],
		[r[2], g[2], b[2]],
	];
	const blanco = xyz(p.w);
	const s = porVector(inv3(P), blanco);
	const M = P.map((fila) => [fila[0] * s[0], fila[1] * s[1], fila[2] * s[2]]) as Mat3;
	const conoOrigen = porVector(BRADFORD, blanco);
	const conoDestino = porVector(BRADFORD, D50);
	const escala: Mat3 = [
		[conoDestino[0] / conoOrigen[0], 0, 0],
		[0, conoDestino[1] / conoOrigen[1], 0],
		[0, 0, conoDestino[2] / conoOrigen[2]],
	];
	return mul3(mul3(inv3(BRADFORD), mul3(escala, BRADFORD)), M);
}

export type PerfilColor = {
	descripcion: string | null;
	/** Espacio de color del perfil ('RGB ', 'GRAY', 'CMYK'…). */
	espacio: string;
	/** RGB lineal → XYZ D50 (columnas = colorantes rXYZ, gXYZ, bXYZ); null si el perfil no es de matriz. */
	matriz: Mat3 | null;
	curvas: [Curva, Curva, Curva] | null;
};

const s15 = (t: Buffer, o: number) => t.readInt32BE(o) / 65536;

function leerCurvaIcc(t: Buffer | undefined): Curva | null {
	if (!t || t.length < 12) return null;
	const tipo = t.toString('latin1', 0, 4);
	if (tipo === 'curv') {
		const n = t.readUInt32BE(8);
		if (n === 0) return {tipo: 'identidad'};
		if (n === 1) return t.length >= 14 ? {tipo: 'gamma', g: t.readUInt16BE(12) / 256} : null;
		if (t.length < 12 + 2 * n) return null;
		return {tipo: 'tabla', valores: Array.from({length: n}, (_, k) => t.readUInt16BE(12 + 2 * k) / 65535)};
	}
	if (tipo === 'para') {
		const funcion = t.readUInt16BE(8);
		const cuantos = [1, 3, 4, 5, 7][funcion];
		if (cuantos === undefined || t.length < 12 + 4 * cuantos) return null;
		return {tipo: 'parametrica', funcion, p: Array.from({length: cuantos}, (_, k) => s15(t, 12 + 4 * k))};
	}
	return null;
}

function utf16be(b: Buffer): string {
	const par = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
	return par.swap16().toString('utf16le');
}

function leerDescripcionIcc(t: Buffer | undefined): string | null {
	if (!t || t.length < 12) return null;
	const tipo = t.toString('latin1', 0, 4);
	if (tipo === 'desc') {
		const n = t.readUInt32BE(8);
		return t.toString('latin1', 12, Math.min(t.length, 12 + n)).split('\0')[0].trim() || null;
	}
	if (tipo === 'mluc' && t.length >= 16) {
		const registros = t.readUInt32BE(8);
		const tam = t.readUInt32BE(12);
		let elegido: {largo: number; off: number} | null = null;
		for (let k = 0; k < registros; k++) {
			const o = 16 + k * tam;
			if (o + 12 > t.length) break;
			const idioma = t.toString('latin1', o, o + 4);
			const r = {largo: t.readUInt32BE(o + 4), off: t.readUInt32BE(o + 8)};
			if (!elegido || idioma === 'enUS') elegido = r;
			if (idioma === 'enUS') break;
		}
		if (!elegido || elegido.off + elegido.largo > t.length) return null;
		return utf16be(t.subarray(elegido.off, elegido.off + elegido.largo)).replace(/\0+$/, '').trim() || null;
	}
	return null;
}

/** Lee un perfil ICC: descripción, espacio, matriz de colorantes (XYZ D50) y curvas rTRC/gTRC/bTRC. */
export function leerIcc(icc: Buffer): PerfilColor {
	if (icc.length < 132 || icc.toString('latin1', 36, 40) !== 'acsp') throw new Error('no es un perfil ICC');
	const espacio = icc.toString('latin1', 16, 20);
	const pcs = icc.toString('latin1', 20, 24);
	const n = icc.readUInt32BE(128);
	const etiquetas = new Map<string, Buffer>();
	for (let k = 0; k < n; k++) {
		const o = 132 + 12 * k;
		if (o + 12 > icc.length) break;
		const firma = icc.toString('latin1', o, o + 4);
		const off = icc.readUInt32BE(o + 4);
		const tam = icc.readUInt32BE(o + 8);
		if (off + tam <= icc.length) etiquetas.set(firma, icc.subarray(off, off + tam));
	}
	const xyz = (t: Buffer | undefined): Vec3 | null => (t && t.length >= 20 && t.toString('latin1', 0, 4) === 'XYZ ' ? [s15(t, 8), s15(t, 12), s15(t, 16)] : null);
	const [r, g, b] = ['rXYZ', 'gXYZ', 'bXYZ'].map((f) => xyz(etiquetas.get(f)));
	const matriz: Mat3 | null =
		r && g && b && pcs === 'XYZ '
			? [
					[r[0], g[0], b[0]],
					[r[1], g[1], b[1]],
					[r[2], g[2], b[2]],
				]
			: null;
	const curvas = ['rTRC', 'gTRC', 'bTRC'].map((f) => leerCurvaIcc(etiquetas.get(f)));
	return {
		descripcion: leerDescripcionIcc(etiquetas.get('desc')),
		espacio,
		matriz,
		curvas: curvas[0] && curvas[1] && curvas[2] ? [curvas[0], curvas[1], curvas[2]] : null,
	};
}

export function perfilDePrimarios(prim: Primarios, curva: Curva, descripcion: string): PerfilColor {
	return {descripcion, espacio: 'RGB ', matriz: matrizDePrimarios(prim), curvas: [curva, curva, curva]};
}

/** ¿El perfil es sRGB (colorantes ±0.0025 y curvas ±0.002)? Entonces no hace falta convertir. */
export function esSrgb(p: PerfilColor): boolean {
	if (p.espacio !== 'RGB ' || !p.matriz || !p.curvas) return false;
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(p.matriz[i][j] - SRGB_D50[i][j]) > 0.0025) return false;
	for (const c of p.curvas) {
		for (let k = 0; k <= 64; k++) {
			const x = k / 64;
			if (Math.abs(evaluarCurva(c, x) - evaluarCurva(CURVA_SRGB, x)) > 0.002) return false;
		}
	}
	return true;
}

export type Conversion = {
	/** RGB lineal del perfil → RGB lineal sRGB. */
	matriz: Mat3;
	/** Código de 8 bits → luz lineal, por canal. */
	entrada: [Float32Array, Float32Array, Float32Array];
};

export function prepararConversion(p: PerfilColor): Conversion {
	if (!p.matriz || !p.curvas) throw new Error('el perfil no es de matriz RGB');
	const cache = new Map<Curva, Float32Array>();
	const lut = (c: Curva) => {
		let t = cache.get(c);
		if (!t) {
			t = new Float32Array(256);
			for (let v = 0; v < 256; v++) t[v] = evaluarCurva(c, v / 255);
			cache.set(c, t);
		}
		return t;
	};
	return {matriz: mul3(inv3(SRGB_D50), p.matriz), entrada: [lut(p.curvas[0]), lut(p.curvas[1]), lut(p.curvas[2])]};
}

export type DecisionColor = {
	fuente: InfoColorOrigen['fuente'];
	perfil_origen: string;
	convertido: boolean;
	nota: string | null;
	conversion: Conversion | null;
};

/**
 * Qué hacer con el color de una imagen. Orden: cICP/nclx (manda, como en PNG 3.ª edición), luego el ICC, luego el
 * chunk sRGB. Sin nada: se asume sRGB (como hacen los navegadores). Una imagen HDR (PQ o HLG) → código 2.
 */
export function decidirColor(info: InfoColorOrigen, nombre = 'la imagen'): DecisionColor {
	const sinConvertir = (perfil_origen: string, nota: string | null): DecisionColor => ({fuente: info.fuente, perfil_origen, convertido: false, nota, conversion: null});
	const etiqueta = info.fuente === 'colr-nclx' ? 'nclx' : 'cICP';
	if (info.cicp && (info.cicp.transferencia === 16 || info.cicp.transferencia === 18)) {
		throw fallo(`convertir ${nombre} a sRGB`, `es una imagen HDR (${info.cicp.transferencia === 16 ? 'PQ' : 'HLG'})`, 'expórtala en SDR (JPG o PNG) y vuelve a procesarla', 2);
	}
	// Códigos "sin especificar" (2) no dicen nada: manda el ICC si lo hay (sips escribe nclx 2/2 junto al perfil).
	const cicp = info.cicp && info.cicp.primarios !== 2 && info.cicp.transferencia !== 2 ? info.cicp : null;
	if (cicp) {
		const {primarios, transferencia} = cicp;
		const prim = PRIMARIOS_H273[primarios];
		const curva = CURVAS_H273[transferencia];
		if (!prim || !curva) return sinConvertir(`${etiqueta} ${primarios}/${transferencia}`, `códigos de color ${primarios}/${transferencia} desconocidos: se asume sRGB`);
		const perfil = perfilDePrimarios(prim.xy, curva.curva, `${prim.nombre} (${curva.nombre})`);
		if (esSrgb(perfil)) return sinConvertir(`${prim.nombre} (${curva.nombre})`, null);
		return {fuente: info.fuente, perfil_origen: `${prim.nombre} (${curva.nombre})`, convertido: true, nota: null, conversion: prepararConversion(perfil)};
	}
	if (info.icc) {
		// La fuente es la del perfil aunque el archivo también traiga códigos sin especificar.
		const fuente: InfoColorOrigen['fuente'] = info.fuente === 'cICP' ? 'iCCP' : info.fuente === 'colr-nclx' ? 'colr-prof' : info.fuente;
		const deIcc = (perfil_origen: string, nota: string | null): DecisionColor => ({fuente, perfil_origen, convertido: false, nota, conversion: null});
		let perfil: PerfilColor;
		try {
			perfil = leerIcc(info.icc);
		} catch {
			return deIcc('ICC ilegible', 'el perfil ICC no se pudo leer: se asume sRGB');
		}
		const nombrePerfil = perfil.descripcion ?? 'ICC sin nombre';
		if (perfil.espacio !== 'RGB ' || !perfil.matriz || !perfil.curvas) {
			return deIcc(nombrePerfil, `perfil ${perfil.espacio.trim() || '?'} sin matriz RGB: los píxeles quedan como los entrega ffmpeg`);
		}
		if (esSrgb(perfil)) return deIcc(nombrePerfil, null);
		return {fuente, perfil_origen: nombrePerfil, convertido: true, nota: null, conversion: prepararConversion(perfil)};
	}
	if (info.srgb) return sinConvertir('sRGB (chunk sRGB)', null);
	if (info.cicp) return sinConvertir(`${etiqueta} ${info.cicp.primarios}/${info.cicp.transferencia}`, 'códigos de color sin especificar: se asume sRGB');
	return sinConvertir('sin perfil', 'sin perfil de color: se asume sRGB');
}

// ───────────────────────── píxeles (puro) ─────────────────────────

export type Pam = {ancho: number; alto: number; profundidad: number; maxval: number; datos: Buffer};

/** Lee un PAM (P7) como el que escribe ffmpeg (-c:v pam). */
export function leerPam(buf: Buffer): Pam {
	const fin = buf.indexOf('ENDHDR\n');
	if (buf.toString('latin1', 0, 3) !== 'P7\n' || fin < 0) throw new Error('no es un PAM');
	const cab = buf.toString('latin1', 3, fin);
	const campo = (nombre: string) => {
		const m = new RegExp(`^${nombre}\\s+(\\d+)\\s*$`, 'm').exec(cab);
		if (!m) throw new Error(`al PAM le falta ${nombre}`);
		return Number(m[1]);
	};
	const pam = {ancho: campo('WIDTH'), alto: campo('HEIGHT'), profundidad: campo('DEPTH'), maxval: campo('MAXVAL'), datos: buf.subarray(fin + 7)};
	const bytes = pam.ancho * pam.alto * pam.profundidad * (pam.maxval > 255 ? 2 : 1);
	if (pam.datos.length < bytes) throw new Error(`el PAM trae ${pam.datos.length} bytes y deberían ser ${bytes}`);
	pam.datos = pam.datos.subarray(0, bytes);
	return pam;
}

let lutSalidaSrgb: Uint8Array | null = null;

/** Luz lineal (cuantizada a 16 bits) → código sRGB de 8 bits. */
function tablaSalidaSrgb(): Uint8Array {
	if (!lutSalidaSrgb) {
		lutSalidaSrgb = new Uint8Array(65536);
		for (let v = 0; v < 65536; v++) lutSalidaSrgb[v] = Math.round(255 * codificarSrgb(v / 65535));
	}
	return lutSalidaSrgb;
}

/**
 * PAM RGBA de 8 bits → RGB(A) de 8 bits en sRGB. Con `conv`, cada píxel pasa por las curvas del perfil, la matriz a
 * sRGB (con recorte a [0, 1]) y la curva sRGB; sin `conv`, los píxeles quedan tal cual. El alfa (sin premultiplicar)
 * se conserva; si toda la imagen es opaca, la salida es RGB.
 * (Se decodifica a 8 bits y no a 16 porque swscale no pasa exacto de 8 a 16 bits: 255 → 65269, 200 → 51218.)
 */
export function pixelesASrgb8(pam: Pam, conv: Conversion | null): {datos: Buffer; canales: 3 | 4} {
	if (pam.profundidad !== 4 || pam.maxval !== 255) throw new Error(`se esperaba RGBA de 8 bits y llegó profundidad ${pam.profundidad}, máximo ${pam.maxval}`);
	const d = pam.datos;
	const n = pam.ancho * pam.alto;
	let conAlfa = false;
	for (let o = 3; o < d.length; o += 4) {
		if (d[o] !== 255) {
			conAlfa = true;
			break;
		}
	}
	const canales = conAlfa ? 4 : 3;
	const salida = Buffer.allocUnsafe(n * canales);
	if (!conv) {
		for (let o = 0, p = 0; o < d.length; o += 4, p += canales) {
			salida[p] = d[o];
			salida[p + 1] = d[o + 1];
			salida[p + 2] = d[o + 2];
			if (conAlfa) salida[p + 3] = d[o + 3];
		}
		return {datos: salida, canales};
	}
	const [lr, lg, lb] = conv.entrada;
	const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = conv.matriz;
	const s = tablaSalidaSrgb();
	const q = (x: number) => s[x <= 0 ? 0 : x >= 1 ? 65535 : (x * 65535 + 0.5) | 0];
	for (let o = 0, p = 0; o < d.length; o += 4, p += canales) {
		const R = lr[d[o]];
		const G = lg[d[o + 1]];
		const B = lb[d[o + 2]];
		salida[p] = q(m00 * R + m01 * G + m02 * B);
		salida[p + 1] = q(m10 * R + m11 * G + m12 * B);
		salida[p + 2] = q(m20 * R + m21 * G + m22 * B);
		if (conAlfa) salida[p + 3] = d[o + 3];
	}
	return {datos: salida, canales};
}

// ───────────────────────── ffmpeg ─────────────────────────

/** Argumentos de ffmpeg para un video (puro). Mapea solo el video y el primer audio (las pistas de datos del iPhone no). */
export function argumentosVideo(origen: string, destino: string, s: Pick<Sondeo, 'video' | 'audio'>): {args: string[]; ancho: number; alto: number} {
	const v = INSERTS.video;
	const a = INSERTS.audio;
	const {ancho, alto} = dimensionesVideo(s.video.anchoVisible, s.video.altoVisible);
	// setparams etiqueta los cuadros: ffmpeg 8 toma las etiquetas de color del cuadro y no las de -color_primaries.
	const filtro = [
		`fps=${v.fps}`,
		`scale=${ancho}:${alto}:flags=${v.escala}+accurate_rnd+full_chroma_int:out_color_matrix=${v.color}:out_range=tv`,
		`format=${v.pix_fmt}`,
		`setparams=color_primaries=${v.color}:color_trc=${v.color}:colorspace=${v.color}:range=tv`,
	].join(',');
	const args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', origen, '-map', `0:${s.video.indice}`];
	if (s.audio) args.push('-map', `0:${s.audio.indice}`);
	args.push(
		'-vf', filtro,
		'-fps_mode', 'cfr',
		'-c:v', 'libx264', '-preset', v.preset, '-crf', String(v.crf), '-profile:v', v.perfil, '-pix_fmt', v.pix_fmt,
		'-g', String(v.gop), '-keyint_min', String(v.gop), '-sc_threshold', '0',
		'-color_primaries', v.color, '-color_trc', v.color, '-colorspace', v.color, '-color_range', 'tv',
	);
	if (s.audio) args.push('-c:a', a.codec, '-b:a', a.bitrate, '-ar', String(a.muestreo), '-ac', String(a.canales));
	else args.push('-an');
	args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-movflags', '+faststart', '-f', 'mp4', destino);
	return {args, ancho, alto};
}

/** Filtro de escala de una imagen: el lado mayor queda en min(lado, 2560) y el otro sale de la proporción. */
export function filtroEscalaImagen(ladoMax: number = INSERTS.imagen.lado_max): string {
	return `scale=w='if(gte(iw,ih),min(iw,${ladoMax}),-1)':h='if(gte(iw,ih),-1,min(ih,${ladoMax}))':flags=${INSERTS.imagen.escala}+accurate_rnd+full_chroma_int`;
}

function correrSincrono(programa: string, args: string[], que: string, entrada?: Buffer): Buffer {
	const r = spawnSync(programa, args, {input: entrada, maxBuffer: 1024 * 1024 * 1024});
	if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
		throw fallo(que, `no encuentro ${programa} en el PATH`, 'instala ffmpeg (brew install ffmpeg, lo corres tú) y vuelve a intentar', 2);
	}
	if (r.status !== 0) {
		const ultima = (r.stderr?.toString() ?? '').trim().split('\n').pop()?.trim() || `código ${r.status ?? r.signal}`;
		throw fallo(que, `${programa} terminó con error (${ultima})`, 'revisa que el archivo esté completo; si sigue, revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.toString().slice(-4000)});
	}
	return r.stdout;
}

type Lado = {side_data_type?: string; rotation?: number; displaymatrix?: string};

export type Mosaico = {indice: number; ancho: number; alto: number; lados: Lado[]};

/**
 * HEIC/HEIF en mosaicos (las fotos del iPhone y lo que escribe sips vienen en tiles de 512×512): ffmpeg 8.1 los expone
 * como un grupo de streams "Tile Grid" y arma la imagen con su propio filtergraph, así que la escala se le pide con
 * -filter_complex "[0:g:N]…" (un -vf ahí falla con "Simple and complex filtering cannot be used together").
 * Devuelve el grupo más grande (la imagen principal; el mapa de ganancia HDR o la miniatura son más chicos) o null.
 */
export function mosaicoPrincipal(ruta: string): Mosaico | null {
	const r = spawnSync('ffprobe', ['-v', 'error', '-show_stream_groups', '-of', 'json', ruta], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
	type Grupo = {index?: number; type?: string; side_data_list?: Lado[]; components?: Array<{width?: number; height?: number; side_data_list?: Lado[]}>};
	let grupos: Grupo[] = [];
	try {
		grupos = (JSON.parse(r.stdout || '{}') as {stream_groups?: Grupo[]}).stream_groups ?? [];
	} catch {
		return null;
	}
	const mosaicos = grupos
		.filter((g) => /tile ?grid/i.test(g.type ?? '') && typeof g.index === 'number')
		.map((g) => {
			const c = g.components?.[0] ?? {};
			return {indice: g.index as number, ancho: c.width ?? 0, alto: c.height ?? 0, lados: [...(g.side_data_list ?? []), ...(c.side_data_list ?? [])]};
		})
		.sort((a, b) => b.ancho * b.alto - a.ancho * a.alto);
	return mosaicos[0] ?? null;
}

/** Rotación (y espejo) que ffmpeg aplica a una imagen: de la matriz del primer cuadro (EXIF), del mosaico o del stream (HEIF). */
export function orientacionDeImagen(ruta: string, mosaico: Mosaico | null = null): {rotacion: number; espejo: boolean} {
	const leer = (lista: Lado[] | undefined) => {
		const m = lista?.find((l) => /display ?matrix/i.test(l.side_data_type ?? ''));
		if (!m) return null;
		const numeros = (m.displaymatrix ?? '')
			.split('\n')
			.map((linea) => linea.replace(/^\s*[0-9a-f]+:/i, '').trim())
			.filter(Boolean)
			.flatMap((linea) => linea.split(/\s+/).map(Number));
		const espejo = numeros.length === 9 && numeros[0] * numeros[4] - numeros[1] * numeros[3] < 0;
		const rotacion = typeof m.rotation === 'number' ? m.rotation : m.displaymatrix ? (rotacionDeMatriz(m.displaymatrix) ?? 0) : 0;
		return {rotacion: Math.round(rotacion) === 0 ? 0 : Math.round(rotacion), espejo};
	};
	if (mosaico) {
		const de = leer(mosaico.lados);
		if (de) return de;
	}
	const cuadros = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', '-of', 'json', ruta], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
	try {
		const de = leer((JSON.parse(cuadros.stdout || '{}') as {frames?: Array<{side_data_list?: Lado[]}>}).frames?.[0]?.side_data_list);
		if (de) return de;
	} catch {
		// sin JSON: se intenta con el stream
	}
	const streams = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=side_data_list', '-of', 'json', ruta], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
	try {
		for (const s of (JSON.parse(streams.stdout || '{}') as {streams?: Array<{side_data_list?: Lado[]}>}).streams ?? []) {
			const de = leer(s.side_data_list);
			if (de) return de;
		}
	} catch {
		// sin rotación conocida
	}
	return {rotacion: 0, espejo: false};
}

/** Decodifica una imagen con ffmpeg (orientación aplicada, lado mayor ≤ 2560) a RGBA de 8 bits. */
export function decodificarImagen(ruta: string, mosaico: Mosaico | null = null): Pam {
	const que = `leer ${basename(ruta)}`;
	const filtro = `${filtroEscalaImagen()},format=rgba`;
	const seleccion = mosaico ? ['-filter_complex', `[0:g:${mosaico.indice}]${filtro}[v]`, '-map', '[v]'] : ['-vf', filtro];
	const salida = correrSincrono('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', ruta, ...seleccion, '-frames:v', '1', '-c:v', 'pam', '-f', 'image2pipe', 'pipe:1'], que);
	try {
		return leerPam(salida);
	} catch (error) {
		throw fallo(que, `ffmpeg no devolvió la imagen completa (${(error as Error).message})`, 'revisa que el archivo esté completo; si sigue, avísame', 1, error);
	}
}

/** Escribe un PNG sRGB (chunks sRGB, cHRM y gAMA; sin EXIF) desde píxeles RGB(A) de 8 bits. */
export function escribirPngSrgb(datos: Buffer, ancho: number, alto: number, canales: 3 | 4, destino: string): void {
	correrSincrono(
		'ffmpeg',
		['-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', canales === 4 ? 'rgba' : 'rgb24', '-s', `${ancho}x${alto}`, '-i', 'pipe:0', '-frames:v', '1', '-vf', 'setparams=color_primaries=bt709:color_trc=iec61966-2-1:range=pc', '-c:v', 'png', '-update', '1', '-f', 'image2', destino],
		`escribir ${basename(destino)}`,
		datos,
	);
}

// ───────────────────────── procesar un archivo ─────────────────────────

export type ResultadoVideo = {ancho: number; alto: number; cuadros: number; duracion_s: number; tiene_audio: boolean; detalle: Record<string, unknown>; avisos: string[]};

/** Revisa el sondeo de un video antes de procesarlo (código 2 si es HDR). Puro. */
export function revisarVideo(s: Sondeo): void {
	if (s.video.hdr) {
		const tipo = s.video.colorTransfer === 'arib-std-b67' ? 'HLG' : 'PQ';
		throw fallo(`preparar ${basename(s.ruta)}`, `es un video HDR (${tipo}) y la conversión a SDR todavía no está validada`, 'dime si lo convierto de todos modos o vuelve a grabar con Video HDR apagado (Ajustes > Cámara > Grabar video)', 2);
	}
}

export async function procesarVideo(origen: string, destino: string, s: Sondeo): Promise<ResultadoVideo> {
	revisarVideo(s);
	const {args, ancho, alto} = argumentosVideo(origen, destino, s);
	await correrFfmpeg(args, {que: `convertir ${basename(origen)}`});
	const r = await sondear(destino);
	const problemas: string[] = [];
	if (r.video.codec !== 'h264' || r.video.pixFmt !== 'yuv420p') problemas.push(`salió ${r.video.codec} ${r.video.pixFmt}`);
	if (r.video.ancho !== ancho || r.video.alto !== alto) problemas.push(`mide ${r.video.ancho}×${r.video.alto} y no ${ancho}×${alto}`);
	if (r.video.rFrameRate !== '30/1' || r.video.vfr) problemas.push(`va a ${r.video.rFrameRate} (promedio ${r.video.avgFrameRate})`);
	if (r.video.rotacion !== 0) problemas.push(`quedó con rotación ${r.video.rotacion}°`);
	if (s.audio && (!r.audio || r.audio.codec !== 'aac' || r.audio.sampleRate !== INSERTS.audio.muestreo)) problemas.push('perdió el audio o no quedó en AAC 48 kHz');
	if (problemas.length) throw fallo(`verificar ${basename(destino)}`, problemas.join('; '), 'revisa proyectos/_logs/fallos.log y avísame', 1, r);
	const cuadros = r.video.cuadros ?? Math.round((r.video.duracion ?? r.duracion) * INSERTS.video.fps);
	const avisos: string[] = [];
	const prim = s.video.colorPrimaries;
	if (prim && prim !== 'bt709' && prim !== 'unknown') avisos.push(`el original trae primarios ${prim}: se etiquetó BT.709 sin convertir la gama`);
	return {
		ancho,
		alto,
		cuadros,
		duracion_s: Math.round((cuadros / INSERTS.video.fps) * 1e6) / 1e6,
		tiene_audio: Boolean(r.audio),
		detalle: {
			codec_origen: s.video.codec,
			tamano_origen: `${s.video.ancho}×${s.video.alto}`,
			visible_origen: `${s.video.anchoVisible}×${s.video.altoVisible}`,
			fps_origen: Math.round(s.video.fpsReal * 1000) / 1000,
			vfr_origen: s.video.vfr,
			color_origen: {primarios: s.video.colorPrimaries, transferencia: s.video.colorTransfer, matriz: s.video.colorSpace},
			audio_origen: s.audio ? `${s.audio.codec} ${s.audio.sampleRate} Hz ${s.audio.canales} canal(es)` : null,
			duracion_origen_s: s.duracion,
		},
		avisos,
	};
}

export type ResultadoImagen = {ancho: number; alto: number; alfa: boolean; rotacion: number; espejo: boolean; detalle: Record<string, unknown>; avisos: string[]};

export function procesarImagen(origen: string, destino: string): ResultadoImagen {
	const buf = readFileSync(origen);
	const formato = formatoDeImagen(buf);
	if (!formato) throw fallo(`leer ${basename(origen)}`, 'no es PNG, JPG, HEIC ni WebP (por su contenido, no por su extensión)', 'conviértela a PNG o JPG y vuelve a procesarla', 2);
	const color = decidirColor(colorDeImagen(buf, formato), basename(origen));
	const mosaico = formato === 'heif' ? mosaicoPrincipal(origen) : null;
	const {rotacion, espejo} = (formato === 'heif' ? orientacionHeif(buf) : null) ?? orientacionDeImagen(origen, mosaico);
	const pam = decodificarImagen(origen, mosaico);
	if (Math.max(pam.ancho, pam.alto) > INSERTS.imagen.lado_max) throw fallo(`reducir ${basename(origen)}`, `quedó de ${pam.ancho}×${pam.alto}`, 'avísame', 1);
	if (mosaico) {
		// Una rejilla mal armada sale del tamaño de un mosaico (512×512): se compara contra el tamaño del grupo, ya girado
		// según irot (ffmpeg aplica el giro al decodificar).
		const girada = Math.abs(rotacion) === 90;
		const esperado = dimensionesImagenDestino(girada ? mosaico.alto : mosaico.ancho, girada ? mosaico.ancho : mosaico.alto);
		if (Math.abs(pam.ancho - esperado.ancho) > 1 || Math.abs(pam.alto - esperado.alto) > 1) {
			throw fallo(`armar ${basename(origen)}`, `la rejilla de mosaicos salió de ${pam.ancho}×${pam.alto} y debía ser ${esperado.ancho}×${esperado.alto}`, 'expórtala como JPG o PNG (Fotos > Exportar) y vuelve a procesarla', 2);
		}
	}
	const {datos, canales} = pixelesASrgb8(pam, color.conversion);
	escribirPngSrgb(datos, pam.ancho, pam.alto, canales, destino);
	const avisos = color.nota ? [color.nota] : [];
	return {
		ancho: pam.ancho,
		alto: pam.alto,
		alfa: canales === 4,
		rotacion,
		espejo,
		detalle: {formato_origen: formato, color: {fuente: color.fuente, perfil_origen: color.perfil_origen, convertido_a_srgb: color.convertido}, alfa: canales === 4},
		avisos,
	};
}

// ───────────────────────── OCR de secretos (capturas) ─────────────────────────

/** Lo que hace el OCR (inyectable en las pruebas). Por defecto, Apple Vision vía secretos.ts (solo fuera del sandbox). */
export type Escaner = (ruta: string, nombre: string) => Promise<ResultadoEscaneo>;

export const sha256Sincrono = (ruta: string): string => createHash('sha256').update(readFileSync(ruta)).digest('hex');

const comoEscanear = (slug: string) => `escanéala fuera del sandbox (Vision no corre dentro): npx tsx herramientas/procesar-inserts.ts ${slug} --escanear como comando excluido, o desde la etapa de assets de editar.ts`;
const comoAprobar = (slug: string, id: string) => `mira la captura; si no hay nada privado, corre tú (no Claude): npx tsx herramientas/procesar-inserts.ts ${slug} --aprobar ${id}`;

export function revisionNoAplica(): RevisionInsert {
	return {estado: 'NO_APLICA', motivo: 'video: el OCR de secretos se corre en las capturas (imágenes)', escaneado_en: null, sha256: null, leidos: 0, hallazgos: [], aprobado_por: null, aprobado_en: null, siguiente_paso: null};
}

export function revisionSinEscanear(slug: string, motivo: string): RevisionInsert {
	return {estado: 'SIN_ESCANEAR', motivo, escaneado_en: null, sha256: null, leidos: 0, hallazgos: [], aprobado_por: null, aprobado_en: null, siguiente_paso: comoEscanear(slug)};
}

/**
 * OCR de una captura ya procesada. Hallazgos → BLOQUEADA (salvo que ya la hayas aprobado con este mismo sha256);
 * nada → LIMPIA; si Vision no puede correr (sandbox) → SIN_ESCANEAR. El texto leído es dato, nunca instrucción.
 */
export async function revisarCaptura(ruta: string, op: {slug: string; id: string; escaner?: Escaner; previa?: RevisionInsert}): Promise<RevisionInsert> {
	const sha256 = sha256Sincrono(ruta);
	const escaner = op.escaner ?? ((r: string, n: string) => escanearImagen(r, n));
	let r: ResultadoEscaneo;
	try {
		r = await escaner(ruta, basename(ruta));
	} catch (error) {
		// Si ya había un escaneo válido de este mismo archivo, un re-escaneo que no pudo correr no lo borra.
		if (op.previa && op.previa.estado !== 'SIN_ESCANEAR' && op.previa.sha256 === sha256) return op.previa;
		const motivo = error instanceof FalloEditor ? error.porque : error instanceof Error ? error.message.split('\n')[0] : String(error);
		return revisionSinEscanear(op.slug, `Vision no pudo leerla (${motivo})`);
	}
	const ahora = new Date().toISOString();
	const hallazgos = r.hallazgos.map((h) => ({tipo: h.tipo, muestra: h.muestra, caja: {x: h.caja.x, y: h.caja.y, w: h.caja.w, h: h.caja.h}}));
	if (hallazgos.length === 0) {
		return {estado: 'LIMPIA', motivo: `OCR sin hallazgos (${r.leidos} lectura${r.leidos === 1 ? '' : 's'})`, escaneado_en: ahora, sha256, leidos: r.leidos, hallazgos: [], aprobado_por: null, aprobado_en: null, siguiente_paso: null};
	}
	if (op.previa?.estado === 'APROBADA' && op.previa.sha256 === sha256) return {...op.previa, escaneado_en: ahora, leidos: r.leidos, hallazgos};
	const tipos = [...new Set(hallazgos.map((h) => h.tipo))].join(', ');
	return {estado: 'BLOQUEADA', motivo: `el OCR encontró ${hallazgos.length} posible(s) secreto(s) (${tipos})`, escaneado_en: ahora, sha256, leidos: r.leidos, hallazgos, aprobado_por: null, aprobado_en: null, siguiente_paso: comoAprobar(op.slug, op.id)};
}

// ───────────────────────── carpeta de inserts ─────────────────────────

export const dirInserts = (slug: string, proyectos = DIR_PROYECTOS): string => join(dirProyecto(slug, proyectos), 'inserts');
export const rutaMeta = (dir: string, id: string): string => join(dir, `${id}.json`);

export function leerMetaInsert(dir: string, id: string): MetaInsert | null {
	const ruta = rutaMeta(dir, id);
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(`leer ${id}.json`, `${ruta} no es JSON válido`, 'vuelve a procesar ese insert con --forzar', 2, error);
	}
	const r = MetaInsert.safeParse(datos);
	if (!r.success) throw fallo(`leer ${id}.json`, `no tiene la forma esperada (${r.error.issues[0]?.path.join('.') ?? 'raíz'}: ${r.error.issues[0]?.message ?? 'inválido'})`, 'vuelve a procesar ese insert con --forzar', 2, r.error.issues);
	return r.data;
}

export function escribirMeta(dir: string, meta: MetaInsert): void {
	const ruta = rutaMeta(dir, meta.id);
	const tmp = `${ruta}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(MetaInsert.parse(meta), null, '\t')}\n`);
	renameSync(tmp, ruta);
}

export function listarMetas(dir: string): MetaInsert[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => /^[a-z0-9][a-z0-9-]*\.json$/.test(n))
		.map((n) => n.slice(0, -5))
		.sort((a, b) => a.localeCompare(b, 'es', {numeric: true}))
		.map((id) => leerMetaInsert(dir, id))
		.filter((m): m is MetaInsert => m !== null);
}

/**
 * Id para un original: el de su nombre ("img-5091"); si ese id ya es de OTRO original (otro sha256), "img-5091-2",
 * "-3"… Si ya es de este mismo original, se reutiliza.
 */
export function asignarId(dir: string, nombre: string, sha256: string): string {
	const base = idDeArchivo(nombre);
	for (let k = 1; k < 1000; k++) {
		const id = k === 1 ? base : `${base.slice(0, 60 - String(k).length - 1)}-${k}`;
		const previa = existsSync(rutaMeta(dir, id)) ? leerMetaInsert(dir, id) : null;
		if (!previa || previa.origen.sha256 === sha256) return id;
	}
	throw fallo('nombrar el insert', `hay demasiados inserts que se llaman ${base}`, 'renombra el archivo', 2);
}

export type EstadoInsert = {estado: EstadoRevisionInsert | 'FALTA'; motivo: string; usable: boolean};

/** Estado vigente con lo que hay en disco: falta el archivo, cambió desde el escaneo, o lo que diga su revisión. */
export function estadoInsert(dir: string, meta: MetaInsert): EstadoInsert {
	const ruta = join(dir, meta.archivo);
	if (!existsSync(ruta)) return {estado: 'FALTA', motivo: `no existe ${meta.archivo}`, usable: false};
	if (meta.tipo === 'video') return {estado: 'NO_APLICA', motivo: meta.revision.motivo, usable: true};
	const r = meta.revision;
	if (r.estado === 'LIMPIA' || r.estado === 'APROBADA') {
		if (r.sha256 !== sha256Sincrono(ruta)) return {estado: 'BLOQUEADA', motivo: `${meta.archivo} cambió desde el escaneo`, usable: false};
		return {estado: r.estado, motivo: r.motivo, usable: true};
	}
	return {estado: r.estado, motivo: r.motivo, usable: false};
}

/**
 * Tu aprobación de una captura bloqueada (la corres TÚ después de mirarla; Claude no la corre por su cuenta).
 * Vale solo para el archivo con el sha256 que se escaneó: si cambia, se vuelve a bloquear.
 */
export function aprobarInsert(dir: string, id: string, quien = 'creador'): MetaInsert {
	const meta = leerMetaInsert(dir, id);
	if (!meta) throw fallo(`aprobar ${id}`, `no existe inserts/${id}.json`, 'revisa el id con: npx tsx herramientas/procesar-inserts.ts <slug>', 2);
	if (meta.tipo !== 'imagen') throw fallo(`aprobar ${id}`, 'es un video y los videos no pasan por el OCR', 'no hace falta aprobarlo', 2);
	if (meta.revision.estado === 'SIN_ESCANEAR') throw fallo(`aprobar ${id}`, 'todavía no pasa por el OCR de secretos', 'escanéala primero (--escanear, fuera del sandbox)', 2);
	const ruta = join(dir, meta.archivo);
	if (!existsSync(ruta)) throw fallo(`aprobar ${id}`, `no existe ${meta.archivo}`, 'vuelve a procesar el original', 2);
	if (sha256Sincrono(ruta) !== meta.revision.sha256) throw fallo(`aprobar ${id}`, `${meta.archivo} cambió desde el escaneo`, 'vuelve a escanearla con --escanear y mírala otra vez', 2);
	if (meta.revision.estado !== 'BLOQUEADA') return meta;
	const tipos = [...new Set(meta.revision.hallazgos.map((h) => h.tipo))].join(', ');
	meta.revision = {...meta.revision, estado: 'APROBADA', motivo: `${meta.revision.hallazgos.length} hallazgo(s) (${tipos}) revisados y aprobados por ${quien}`, aprobado_por: quien, aprobado_en: new Date().toISOString(), siguiente_paso: null};
	escribirMeta(dir, meta);
	return meta;
}

// ───────────────────────── procesar varios (lo usa el CLI) ─────────────────────────

export type EntradaInsert = {ruta: string; tipo: TipoInsert};

/**
 * Archivos y carpetas → lista de archivos a procesar. Las carpetas se recorren sin entrar a subcarpetas y se saltan
 * los ocultos y los tipos que no son video ni imagen (van en `omitidos`). Código 2 si algo no existe o no se soporta.
 */
export function expandirEntradas(entradas: readonly string[], noDentroDe: readonly string[] = []): {archivos: EntradaInsert[]; omitidos: string[]} {
	const archivos: EntradaInsert[] = [];
	const omitidos: string[] = [];
	const vistos = new Set<string>();
	const prohibidas = noDentroDe.map((d) => (existsSync(d) ? realpathSync(d) : resolve(d)));
	const agregar = (ruta: string, tipo: TipoInsert) => {
		const real = realpathSync(ruta);
		if (prohibidas.some((p) => real === p || real.startsWith(p + sep))) {
			throw fallo(`procesar ${basename(ruta)}`, 'ya es un insert procesado de este proyecto', 'pásame el archivo original (de entrada/ o de ~/Downloads)', 2);
		}
		if (!vistos.has(real)) {
			vistos.add(real);
			archivos.push({ruta: resolve(ruta), tipo});
		}
	};
	for (const e of entradas) {
		const ruta = resolve(e);
		if (!existsSync(ruta)) throw fallo(`procesar ${basename(e)}`, `no existe ${e}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2);
		if (statSync(ruta).isDirectory()) {
			const nombres = readdirSync(ruta)
				.filter((n) => !n.startsWith('.'))
				.sort((a, b) => a.localeCompare(b, 'es'));
			let alguno = false;
			for (const n of nombres) {
				const r = join(ruta, n);
				if (!statSync(r).isFile()) continue;
				const tipo = tipoPorExtension(n);
				if (!tipo) {
					omitidos.push(join(e, n));
					continue;
				}
				agregar(r, tipo);
				alguno = true;
			}
			if (!alguno) throw fallo(`procesar la carpeta ${basename(e)}`, 'no trae videos (.mov, .mp4, .m4v) ni imágenes (.png, .jpg, .heic, .webp)', 'revisa la carpeta', 2);
			continue;
		}
		const tipo = tipoPorExtension(ruta);
		if (!tipo) throw fallo(`procesar ${basename(e)}`, `su tipo (${extname(ruta) || 'sin extensión'}) no es video ni imagen soportada`, 'usa .mov, .mp4 o .m4v para video y .png, .jpg, .heic o .webp para capturas', 2);
		agregar(ruta, tipo);
	}
	return {archivos, omitidos};
}

export type OpcionesProcesar = {
	slug: string;
	entradas: readonly string[];
	/** OCR de las capturas (por defecto sí; dentro del sandbox quedan SIN_ESCANEAR). */
	ocr?: boolean;
	/** Rehace aunque ya esté procesado con el mismo original y parámetros. */
	forzar?: boolean;
	proyectos?: string;
	escaner?: Escaner;
	avisar?: (mensaje: string) => void;
};

export type ResultadoInsert = {meta: MetaInsert; ruta: string; reutilizado: boolean; segundos: number};

const parametrosDe = (tipo: TipoInsert): Record<string, unknown> => ({version: VERSION_PROCESO, tipo, ...(tipo === 'video' ? {video: INSERTS.video, audio: INSERTS.audio} : {imagen: INSERTS.imagen})});

/** ¿Lo ya procesado vale para este original? Mismo sha256 del original, mismos parámetros y la salida intacta. */
function vigente(meta: MetaInsert | null, dir: string, huella: HuellaOriginal, parametrosSha: string): meta is MetaInsert {
	if (!meta || meta.origen.sha256 !== huella.sha256 || meta.parametros_sha256 !== parametrosSha) return false;
	const ruta = join(dir, meta.archivo);
	if (!existsSync(ruta) || statSync(ruta).size !== meta.salida.bytes) return false;
	return sha256Sincrono(ruta) === meta.salida.sha256;
}

/** Procesa una lista de archivos y carpetas. Valida todo primero (código 2 antes de convertir nada). */
export async function procesarInserts(op: OpcionesProcesar): Promise<ResultadoInsert[]> {
	const slug = validarSlug(op.slug);
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const avisar = op.avisar ?? (() => {});
	const dir = dirInserts(slug, proyectos);
	const {archivos, omitidos} = expandirEntradas(op.entradas, [dir]);
	for (const o of omitidos) avisar(`  (salto ${o}: no es video ni imagen)`);

	// 1) Validación previa, antes de convertir nada: sondeo de videos (HDR → 2) y formato y color reales de imágenes.
	const sondeos = new Map<string, Sondeo>();
	for (const a of archivos) {
		if (a.tipo === 'video') {
			const s = await sondear(a.ruta);
			revisarVideo(s);
			sondeos.set(a.ruta, s);
		} else {
			const buf = readFileSync(a.ruta);
			const formato = formatoDeImagen(buf);
			if (!formato) throw fallo(`leer ${basename(a.ruta)}`, 'no es PNG, JPG, HEIC ni WebP (por su contenido, no por su extensión)', 'conviértela a PNG o JPG y vuelve a procesarla', 2);
			decidirColor(colorDeImagen(buf, formato), basename(a.ruta));
		}
	}

	mkdirSync(dir, {recursive: true});
	const resultados: ResultadoInsert[] = [];
	for (const a of archivos) {
		const t0 = performance.now();
		const huella = await huellaOriginal(a.ruta);
		const id = asignarId(dir, basename(a.ruta), huella.sha256);
		const ext = a.tipo === 'video' ? 'mp4' : 'png';
		const archivo = `${id}.${ext}`;
		const destino = rutaSalidaSegura(slug, join('inserts', archivo), a.ruta, proyectos);
		const parametros = parametrosDe(a.tipo);
		const parametrosSha = hashParametros(parametros);
		const previa = leerMetaInsert(dir, id);
		let meta: MetaInsert;
		let reutilizado = false;
		if (!op.forzar && vigente(previa, dir, huella, parametrosSha)) {
			meta = previa;
			reutilizado = true;
		} else {
			// Si existía con otra extensión (p. ej. el mismo id con otro tipo), se quita para no dejar huérfanos.
			if (previa && previa.archivo !== archivo) rmSync(join(dir, previa.archivo), {force: true});
			const temporal = join(dir, `.${id}.tmp-${process.pid}.${ext}`);
			rmSync(temporal, {force: true});
			const base = {
				version: 1 as const,
				id,
				tipo: a.tipo,
				archivo,
				asset: `p/${slug}/inserts/${archivo}`,
				origen: {ruta: huella.ruta, sha256: huella.sha256, mtime: huella.mtime, bytes: huella.tamano_bytes},
				parametros_sha256: parametrosSha,
			};
			try {
				if (a.tipo === 'video') {
					const s = sondeos.get(a.ruta) as Sondeo;
					const r = await procesarVideo(a.ruta, temporal, s);
					renameSync(temporal, destino);
					meta = {...base, ancho: r.ancho, alto: r.alto, duracion_s: r.duracion_s, fps: INSERTS.video.fps, cuadros: r.cuadros, tiene_audio: r.tiene_audio, rotacion_original: s.video.rotacion, espejo: false, procesado_en: new Date().toISOString(), salida: {sha256: '', bytes: 0}, detalle: r.detalle, revision: revisionNoAplica(), avisos: r.avisos};
				} else {
					const r = procesarImagen(a.ruta, temporal);
					renameSync(temporal, destino);
					meta = {...base, ancho: r.ancho, alto: r.alto, duracion_s: null, fps: null, cuadros: null, tiene_audio: false, rotacion_original: r.rotacion, espejo: r.espejo, procesado_en: new Date().toISOString(), salida: {sha256: '', bytes: 0}, detalle: r.detalle, revision: revisionSinEscanear(slug, op.ocr === false ? 'se procesó con --sin-ocr' : 'todavía no pasa por el OCR'), avisos: r.avisos};
				}
			} finally {
				rmSync(temporal, {force: true});
			}
			meta.salida = {sha256: sha256Sincrono(destino), bytes: statSync(destino).size};
			// Si la imagen salió idéntica (mismo sha256), su escaneo y tu aprobación siguen valiendo (también un bloqueo).
			const r = previa?.revision;
			if (r && r.estado !== 'SIN_ESCANEAR' && r.estado !== 'NO_APLICA' && r.sha256 === meta.salida.sha256) meta.revision = r;
		}
		if (meta.tipo === 'imagen' && op.ocr !== false) {
			const pendiente = meta.revision.estado === 'SIN_ESCANEAR' || meta.revision.sha256 !== meta.salida.sha256;
			if (pendiente) meta.revision = await revisarCaptura(destino, {slug, id, escaner: op.escaner, previa: meta.revision});
		}
		escribirMeta(dir, meta);
		if (!reutilizado) {
			registrarEtapa(
				slug,
				`insert-${id}`,
				{
					estado: 'terminada',
					entradas: [{ruta: huella.ruta, sha256: huella.sha256, bytes: huella.tamano_bytes}],
					parametros,
					salidas: [{ruta: join('inserts', archivo), sha256: meta.salida.sha256, bytes: meta.salida.bytes}],
					extra: {segundos: Math.round((performance.now() - t0) / 10) / 100},
				},
				proyectos,
			);
		}
		resultados.push({meta, ruta: destino, reutilizado, segundos: Math.round((performance.now() - t0) / 10) / 100});
	}
	return resultados;
}

/** OCR de las capturas del proyecto que falten (sin escanear, o que cambiaron desde el escaneo). */
export async function escanearPendientes(op: {slug: string; proyectos?: string; escaner?: Escaner; todas?: boolean}): Promise<MetaInsert[]> {
	const slug = validarSlug(op.slug);
	const dir = dirInserts(slug, op.proyectos);
	const salida: MetaInsert[] = [];
	for (const meta of listarMetas(dir)) {
		if (meta.tipo !== 'imagen') continue;
		const ruta = join(dir, meta.archivo);
		if (!existsSync(ruta)) continue;
		const pendiente = op.todas || meta.revision.estado === 'SIN_ESCANEAR' || meta.revision.sha256 !== sha256Sincrono(ruta);
		if (!pendiente) continue;
		meta.revision = await revisarCaptura(ruta, {slug, id: meta.id, escaner: op.escaner, previa: meta.revision});
		escribirMeta(dir, meta);
		salida.push(meta);
	}
	return salida;
}

// ───────────────────────── para la EDL ─────────────────────────

export type OpcionesInsertEdl = {
	desde: number;
	hasta: number;
	layout: 'tarjeta' | 'pantalla-completa';
	/** Solo tarjeta: centro (x, y) y tamaño en px base. Lo que falte sale de los valores por defecto y de la proporción. */
	caja?: Partial<{x: number; y: number; w: number; h: number; escala: number}>;
	texto?: string | null;
	/** Id en la EDL (por defecto "ins-<id del insert>"); úsalo si el mismo insert entra dos veces. */
	id?: string;
	/** Solo video: desde qué segundo del clip arranca (por defecto 0). */
	trim_desde?: number;
	audio?: Partial<{modo: 'mute' | 'duck'; ganancia_db: number}>;
	sfx?: InsertEdl['sfx'];
};

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Caja de un insert en tarjeta (px base 1080×1920, caja.x/caja.y = centro). Sin caja: centro (540, 995) y el ancho
 * mayor que no pase de 770 de ancho ni de 820 de alto con la proporción del archivo. Con solo w (o solo h), el otro
 * sale de la proporción, así Insert.tsx no recorta nada.
 */
export function cajaTarjeta(medida: {ancho: number; alto: number}, caja: OpcionesInsertEdl['caja'] = {}): NonNullable<InsertEdl['caja']> {
	const t = ESTILO_INSERT_POR_DEFECTO.tarjeta;
	const proporcion = medida.alto / medida.ancho;
	let w = caja.w;
	let h = caja.h;
	if (w === undefined && h === undefined) {
		w = Math.min(t.ancho_px, ALTO_MAX_TARJETA / proporcion);
		h = w * proporcion;
	} else if (w === undefined) w = (h as number) / proporcion;
	else if (h === undefined) h = w * proporcion;
	return {x: caja.x ?? t.x, y: caja.y ?? t.y, w: r2(w), h: r2(h as number), ...(caja.escala !== undefined ? {escala: caja.escala} : {})};
}

/**
 * El objeto Insert de la EDL (src/esquema/edicion.ts) para un insert procesado. Valores por defecto: trim_desde 0,
 * audio {modo "mute", ganancia_db −12} (la pista se conservó: "duck" la hace sonar), sin texto, sin SFX.
 * tapaCabeza: pantalla-completa → true (cubre todo); tarjeta → false. OJO: en tarjeta, si puede ir debajo de tu barbilla
 * o tiene que subir (excepción "no cabe con ≥ 70 % de ancho legible") lo decide layout.ts (otra pieza): este false es
 * solo el punto de partida y layout.ts lo puede cambiar.
 * Código 2 si: la captura está BLOQUEADA o SIN_ESCANEAR, desde ≥ hasta, el clip se acaba antes que el insert, o se pide
 * "duck" de un video sin audio.
 */
export function insertParaEdicion(meta: MetaInsert, op: OpcionesInsertEdl): InsertEdl {
	const que = `poner ${meta.id} en la edición`;
	if (meta.tipo === 'imagen' && meta.revision.estado !== 'LIMPIA' && meta.revision.estado !== 'APROBADA') {
		const bloqueada = meta.revision.estado === 'BLOQUEADA';
		throw fallo(que, bloqueada ? `la captura está BLOQUEADA: ${meta.revision.motivo}` : 'la captura todavía no pasa por el OCR de secretos', meta.revision.siguiente_paso ?? (bloqueada ? 'revísala tú y apruébala con --aprobar' : 'escanéala con --escanear fuera del sandbox'), 2);
	}
	if (!(op.hasta > op.desde)) throw fallo(que, `desde (${op.desde}) debe ser menor que hasta (${op.hasta})`, 'revisa los tiempos', 2);
	const trim = meta.tipo === 'video' ? (op.trim_desde ?? 0) : 0;
	if (trim < 0) throw fallo(que, `trim_desde (${trim}) es negativo`, 'usa 0 o más', 2);
	if (meta.tipo === 'video' && meta.duracion_s !== null) {
		const quedan = meta.duracion_s - trim;
		if (op.hasta - op.desde > quedan + 1 / 30 + 1e-6) {
			throw fallo(que, `el insert dura ${r2(op.hasta - op.desde)} s y al clip le quedan ${r2(Math.max(0, quedan))} s desde ${trim} s`, 'acórtalo o baja trim_desde', 2);
		}
	}
	const audio = {modo: op.audio?.modo ?? AUDIO_INSERT_POR_DEFECTO.modo, ganancia_db: op.audio?.ganancia_db ?? AUDIO_INSERT_POR_DEFECTO.ganancia_db};
	if (audio.modo === 'duck' && !meta.tiene_audio) throw fallo(que, 'pide "duck" y el clip no trae audio', 'déjalo en "mute"', 2);
	const candidato = {
		id: op.id ?? `ins-${meta.id}`,
		tipo: meta.tipo,
		desde: op.desde,
		hasta: op.hasta,
		asset: meta.asset,
		trim_desde: trim,
		layout: op.layout,
		...(op.layout === 'tarjeta' ? {caja: cajaTarjeta(meta, op.caja)} : {}),
		tapaCabeza: op.layout === 'pantalla-completa',
		texto: op.texto ?? null,
		eventos: null,
		audio,
		sfx: op.sfx ?? null,
	};
	const r = EsquemaInsert.safeParse(candidato);
	if (!r.success) throw fallo(que, `no cumple el contrato (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`, 'revisa los valores que pasaste', 2, r.error.issues);
	return r.data;
}

export type ProblemaInsert = {regla: string; donde: string; detalle: string};

const PATRON_ASSET = /^p\/([a-z0-9_][a-z0-9_-]*)\/inserts\/([a-z0-9][a-z0-9-]*)\.(mp4|png)$/;

/**
 * Revisa los inserts de una EDL contra sus <id>.json (para validar.ts): capturas bloqueadas o sin escanear, archivos
 * que faltan o cambiaron, tipo equivocado, clips que se acaban antes que el insert y "duck" sin audio. Solo mira los
 * assets de proyectos/<slug>/inserts/ (las demos y BRAG tienen su propia revisión).
 */
export function problemasDeInserts(edicion: Pick<Edicion, 'inserts'>, proyectos = DIR_PROYECTOS): ProblemaInsert[] {
	const salida: ProblemaInsert[] = [];
	for (const ins of edicion.inserts) {
		const m = PATRON_ASSET.exec(ins.asset);
		if (!m) continue;
		const donde = `inserts.${ins.id}`;
		const dir = join(proyectos, m[1], 'inserts');
		let meta: MetaInsert | null;
		try {
			meta = leerMetaInsert(dir, m[2]);
		} catch (error) {
			salida.push({regla: 'insert', donde, detalle: error instanceof FalloEditor ? error.message : String(error)});
			continue;
		}
		if (!meta) {
			salida.push({regla: 'insert', donde, detalle: `falta inserts/${m[2]}.json: procésalo con procesar-inserts.ts`});
			continue;
		}
		const estado = estadoInsert(dir, meta);
		if (!estado.usable) salida.push({regla: 'secretos', donde, detalle: `${meta.archivo} está ${estado.estado}: ${estado.motivo}`});
		if ((ins.tipo === 'video' || ins.tipo === 'imagen') && ins.tipo !== meta.tipo) salida.push({regla: 'insert', donde, detalle: `dice tipo "${ins.tipo}" y ${meta.archivo} es ${meta.tipo}`});
		if (meta.tipo === 'video' && meta.duracion_s !== null && ins.trim_desde + (ins.hasta - ins.desde) > meta.duracion_s + 1 / 30 + 1e-6) {
			salida.push({regla: 'insert', donde, detalle: `dura ${r2(ins.hasta - ins.desde)} s desde ${ins.trim_desde} s y el clip dura ${meta.duracion_s} s`});
		}
		if (ins.audio.modo === 'duck' && !meta.tiene_audio) salida.push({regla: 'insert', donde, detalle: 'pide "duck" y el clip no trae audio'});
	}
	return salida;
}
