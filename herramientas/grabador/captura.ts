/**
 * Captura del estudio de pantalla (Fase 5): CDP screencast → cuadros con su timestamp → toma CFR 30.
 *
 * - `Grabadora`: Page.startScreencast (png, o jpeg calidad 95) con tope = viewport × DPR (maxWidth/maxHeight).
 *   Chrome manda un cuadro cuando la página se repinta (VFR) con su timestamp ("frame swap", segundos desde 1970).
 *   Cada cuadro se confirma al instante (Page.screencastFrameAck: sin confirmación Chrome deja de mandar) y se
 *   escribe a disco con su timestamp y un hash de contenido.
 * - `codificarToma`: pasa los cuadros a 30 fps constantes repitiendo el último cuadro (eventos.mapaCfr), deja solo
 *   los tramos de keep[] (compresión de tiempos muertos) y codifica H.264 CRF 14 (yuv420p, BT.709, keyframe cada
 *   15 cuadros para que Remotion busque rápido).
 * - `hojaDeContacto`: miniaturas con etiqueta en una sola imagen, para revisar a ojo.
 *
 * El navegador y la ventana viven en estudio.ts; aquí solo hay cuadros.
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {CDPSession} from 'playwright';
import {fallo} from '../lib/fallo.ts';
import {cuadrosConservados, FPS, mapaCfr, type Tramo} from './eventos.ts';

export type FormatoCaptura = 'jpeg' | 'png';

/** Parámetros de captura y codificación (plan v5: jpeg q95 o png; H.264 CRF 14). */
export const CAPTURA = {
	formato: 'jpeg' as FormatoCaptura,
	calidad: 95,
	crf: 14,
	preset: 'medium',
	/** Keyframe cada 15 cuadros (como la base del reel): Remotion busca exacto y rápido. */
	gop: 15,
};

export type CuadroCrudo = {
	i: number;
	/** Timestamp del cuadro según Chrome (s desde 1970). */
	ts: number;
	/** Cuándo llegó a Node (s desde 1970), para comparar relojes. */
	recibido: number;
	archivo: string;
	bytes: number;
	/** sha1 del contenido (para contar cuadros con contenido distinto). */
	hash: string;
};

/** Ancho y alto de un PNG o JPEG leyendo su cabecera (puro). */
export function dimensionesImagen(buf: Buffer): {ancho: number; alto: number; formato: 'png' | 'jpeg'} {
	if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
		return {ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20), formato: 'png'};
	}
	if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) {
				i++;
				continue;
			}
			const m = buf[i + 1];
			if (m === 0xff) {
				i++;
				continue;
			}
			if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
				i += 2;
				continue;
			}
			const largo = buf.readUInt16BE(i + 2);
			// SOF0–SOF15 salvo DHT (C4), JPG (C8) y DAC (CC): ahí vienen alto y ancho.
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				return {alto: buf.readUInt16BE(i + 5), ancho: buf.readUInt16BE(i + 7), formato: 'jpeg'};
			}
			i += 2 + largo;
		}
	}
	throw fallo('leer el tamaño de la imagen', 'no es un PNG ni un JPEG que pueda leer', 'revisa el archivo', 1);
}

export type OpcionesGrabadora = {
	/** Carpeta donde se escriben los cuadros (se crea). */
	dir: string;
	formato: FormatoCaptura;
	/** Solo para jpeg (0–100). */
	calidad: number;
	/** Tope del cuadro: viewport × DPR (con 1280×800 y DPR 2: 2560×1600). */
	maxAncho: number;
	maxAlto: number;
};

type CuadroCdp = {data: string; sessionId: number; metadata: {timestamp?: number; deviceWidth?: number; deviceHeight?: number}};

/** Graba la página con CDP screencast. Un objeto por grabación. */
export class Grabadora {
	private cuadros: CuadroCrudo[] = [];
	private escrituras: Promise<void>[] = [];
	private activa = false;
	private readonly alCuadro = (p: CuadroCdp) => this.recibir(p);

	constructor(
		private readonly cdp: CDPSession,
		private readonly op: OpcionesGrabadora,
	) {}

	async iniciar(): Promise<void> {
		mkdirSync(this.op.dir, {recursive: true});
		this.cdp.on('Page.screencastFrame', this.alCuadro);
		this.activa = true;
		const params: Record<string, unknown> = {format: this.op.formato, maxWidth: this.op.maxAncho, maxHeight: this.op.maxAlto, everyNthFrame: 1};
		if (this.op.formato === 'jpeg') params.quality = this.op.calidad;
		await this.cdp.send('Page.startScreencast', params);
	}

	private recibir(p: CuadroCdp): void {
		// Confirmar primero: Chrome no manda el siguiente cuadro hasta que se confirma (máx. ~2 en vuelo).
		this.cdp.send('Page.screencastFrameAck', {sessionId: p.sessionId}).catch(() => {});
		if (!this.activa) return;
		const recibido = Date.now() / 1000;
		const datos = Buffer.from(p.data, 'base64');
		const i = this.cuadros.length;
		const archivo = join(this.op.dir, `${String(i).padStart(6, '0')}.${this.op.formato === 'png' ? 'png' : 'jpg'}`);
		this.cuadros.push({
			i,
			ts: typeof p.metadata?.timestamp === 'number' ? p.metadata.timestamp : recibido,
			recibido,
			archivo,
			bytes: datos.length,
			hash: createHash('sha1').update(datos).digest('hex'),
		});
		this.escrituras.push(writeFile(archivo, datos));
	}

	/** Cuántos cuadros van. */
	get total(): number {
		return this.cuadros.length;
	}

	/** Detiene el screencast y espera a que todos los cuadros estén en disco. */
	async detener(): Promise<CuadroCrudo[]> {
		await this.cdp.send('Page.stopScreencast').catch(() => {});
		this.activa = false;
		this.cdp.off('Page.screencastFrame', this.alCuadro);
		await Promise.all(this.escrituras);
		return [...this.cuadros];
	}
}

export type OpcionesCodificar = {
	cuadros: readonly CuadroCrudo[];
	/** El 0 de la toma cruda (s desde 1970): el timestamp del primer cuadro. */
	t0: number;
	/** keep[] de la compresión, en tiempo crudo (eventos.planCompresion). */
	keep: readonly Tramo[];
	salida: string;
	/** Tamaño de salida (pares). */
	ancho: number;
	alto: number;
	crf?: number;
	preset?: string;
	gop?: number;
};

export type ResultadoCodificar = {cuadros: number; duracion_s: number; segundos: number; repetidos: number};

/**
 * Cuadros VFR → toma.mp4 CFR 30 (H.264, yuv420p, BT.709). Escribe a un temporal y lo renombra al final, así una
 * toma a medias nunca queda con el nombre final.
 */
export async function codificarToma(op: OpcionesCodificar): Promise<ResultadoCodificar> {
	if (op.cuadros.length === 0) throw fallo('codificar la toma', 'no llegó ningún cuadro', 'revisa que la ventana del estudio estuviera visible al grabar', 1);
	const t0Ms = performance.now();
	const tiempos = op.cuadros.map((c) => c.ts - op.t0);
	const ultimo = op.keep[op.keep.length - 1];
	const totalCrudo = Math.round(ultimo.hasta * FPS);
	const mapa = mapaCfr(tiempos, totalCrudo);
	const salidaK = cuadrosConservados(op.keep);
	const ancho = Math.round(op.ancho / 2) * 2;
	const alto = Math.round(op.alto / 2) * 2;
	const decodificador = op.cuadros[0].archivo.endsWith('.png') ? 'png' : 'mjpeg';
	mkdirSync(dirname(op.salida), {recursive: true});
	const tmp = `${op.salida}.parcial.mp4`;
	const filtro = `scale=${ancho}:${alto}:force_original_aspect_ratio=decrease:flags=lanczos:out_color_matrix=bt709:out_range=tv,pad=${ancho}:${alto}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
	const args = [
		'-v', 'error', '-nostdin', '-y',
		'-f', 'image2pipe', '-framerate', String(FPS), '-c:v', decodificador, '-i', '-',
		'-vf', filtro,
		'-c:v', 'libx264', '-preset', op.preset ?? CAPTURA.preset, '-crf', String(op.crf ?? CAPTURA.crf),
		'-g', String(op.gop ?? CAPTURA.gop), '-pix_fmt', 'yuv420p',
		'-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
		'-r', String(FPS), '-movflags', '+faststart', '-an', tmp,
	];
	const ff = spawn('ffmpeg', args, {stdio: ['pipe', 'ignore', 'pipe']});
	let err = '';
	ff.stderr.on('data', (d: Buffer) => {
		err = (err + d.toString()).slice(-4000);
	});
	const cierre = new Promise<number | null>((listo, falla) => {
		ff.on('error', (e: NodeJS.ErrnoException) =>
			falla(e.code === 'ENOENT' ? fallo('codificar la toma', 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú)', 2, e) : e),
		);
		ff.on('close', (c) => listo(c));
	});
	ff.stdin.on('error', () => {});
	let cerrado = false;
	const fin = cierre.then(
		(c) => {
			cerrado = true;
			return c;
		},
		(e) => {
			cerrado = true;
			throw e;
		},
	);
	fin.catch(() => {});
	let repetidos = 0;
	let cacheIdx = -1;
	let cache: Buffer | null = null;
	for (const k of salidaK) {
		if (cerrado) break; // ffmpeg ya terminó (con error): no tiene caso seguir escribiendo
		const idx = mapa[k];
		if (idx === cacheIdx && cache) repetidos++;
		else {
			cache = readFileSync(op.cuadros[idx].archivo);
			cacheIdx = idx;
		}
		if (!ff.stdin.write(cache)) {
			await Promise.race([new Promise<void>((r) => ff.stdin.once('drain', () => r())), fin.then(() => undefined, () => undefined)]);
		}
	}
	ff.stdin.end();
	const codigo = await fin;
	if (codigo !== 0) {
		rmSync(tmp, {force: true});
		throw fallo('codificar la toma', `ffmpeg salió con ${codigo}`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, err});
	}
	renameSync(tmp, op.salida);
	return {cuadros: salidaK.length, duracion_s: salidaK.length / FPS, segundos: (performance.now() - t0Ms) / 1000, repetidos};
}

/** Miniatura JPEG de una imagen o de un cuadro de video (ffmpeg). */
export function miniatura(entrada: string | Buffer, ancho: number, opciones: {tiempo_s?: number} = {}): Buffer {
	const args = ['-v', 'error', '-nostdin'];
	if (opciones.tiempo_s !== undefined) args.push('-ss', opciones.tiempo_s.toFixed(3));
	args.push('-i', typeof entrada === 'string' ? entrada : 'pipe:0', '-frames:v', '1', '-vf', `scale=${ancho}:-2:flags=lanczos`, '-q:v', '3', '-f', 'mjpeg', 'pipe:1');
	const r = spawnSync('ffmpeg', args, {input: typeof entrada === 'string' ? undefined : entrada, maxBuffer: 64 * 1024 * 1024});
	if (r.status !== 0 || !r.stdout?.length) {
		throw fallo('hacer la miniatura', `ffmpeg salió con ${r.status}`, 'revisa que el archivo exista y sea una imagen o video', 1, r.stderr?.toString());
	}
	return r.stdout;
}

const escaparXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Hoja de contacto: miniaturas (JPEG) en rejilla con su etiqueta debajo → JPEG. Usa resvg para el SVG y ffmpeg
 * para pasarlo a JPEG.
 */
export async function hojaDeContacto(
	minis: ReadonlyArray<{jpeg: Buffer; etiqueta: string}>,
	salida: string,
	op: {columnas: number; titulo: string},
): Promise<string> {
	const {Resvg} = await import('@resvg/resvg-js');
	if (minis.length === 0) throw fallo('armar la hoja de contacto', 'no hay miniaturas', 'revisa la prueba', 1);
	const dims = minis.map((m) => dimensionesImagen(m.jpeg));
	const anchoCelda = Math.max(...dims.map((d) => d.ancho));
	const altoCelda = Math.max(...dims.map((d) => d.alto));
	const etiqueta = 30;
	const margen = 12;
	const encabezado = 56;
	const columnas = Math.max(1, Math.min(op.columnas, minis.length));
	const filas = Math.ceil(minis.length / columnas);
	const W = columnas * (anchoCelda + margen) + margen;
	const H = encabezado + filas * (altoCelda + etiqueta + margen) + margen;
	const celdas = minis.map((m, i) => {
		const x = margen + (i % columnas) * (anchoCelda + margen);
		const y = encabezado + margen + Math.floor(i / columnas) * (altoCelda + etiqueta + margen);
		const d = dims[i];
		return (
			`<image x="${x + (anchoCelda - d.ancho) / 2}" y="${y + (altoCelda - d.alto) / 2}" width="${d.ancho}" height="${d.alto}" xlink:href="data:image/jpeg;base64,${m.jpeg.toString('base64')}"/>` +
			`<text x="${x + anchoCelda / 2}" y="${y + altoCelda + 22}" font-size="17" text-anchor="middle" fill="#f2f2f2">${escaparXml(m.etiqueta)}</text>`
		);
	});
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">` +
		`<rect width="${W}" height="${H}" fill="#161616"/>` +
		`<text x="${margen}" y="38" font-size="24" fill="#ffffff">${escaparXml(op.titulo)}</text>` +
		celdas.join('') +
		'</svg>';
	const png = new Resvg(svg, {font: {loadSystemFonts: true, defaultFontFamily: 'Helvetica'}}).render().asPng();
	mkdirSync(dirname(salida), {recursive: true});
	const rutaPng = salida.replace(/\.(jpe?g|png)$/i, '') + '.png';
	writeFileSync(rutaPng, png);
	if (/\.png$/i.test(salida)) return rutaPng;
	const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', rutaPng, '-q:v', '3', salida], {encoding: 'utf8'});
	if (r.status === 0) {
		rmSync(rutaPng, {force: true});
		return salida;
	}
	return rutaPng;
}
