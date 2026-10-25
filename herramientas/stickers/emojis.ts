// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * emojis.ts — emojis animados (Noto Emoji Animation de Google, CC BY 4.0) como stickers para el director.
 *
 *   npx tsx herramientas/stickers/emojis.ts [--solo risa,fuego] [--sin-bajar]
 *
 * Por cada emoji de EMOJIS:
 *   1. Baja `https://fonts.gstatic.com/s/e/notoemoji/latest/<codepoint>/512.webp` (WebP animado con alfa completo) a
 *      biblioteca/stickers/emojis/fuente/ (no se versiona). Si ya está, no lo vuelve a bajar. Es gratis y sin llave.
 *   2. Lo descompone en cuadros con las herramientas de libwebp (webpmux + dwebp, vienen con el ffmpeg de Homebrew) y
 *      los compone con su fusión y desecho (spec de WebP animado). Sin dependencias nuevas.
 *   3. Pone a cada cuadro el mismo borde blanco tipo sticker y la misma sombra que los demás stickers
 *      (stickers/lib/borde.ts), con grosor y sombra FIJOS para todo el emoji (sale del lado mayor de su tinta más grande),
 *      en un lienzo cuadrado común a todos los cuadros (así no "tiembla" al animarse).
 *   4. Escribe `emoji-<nombre>.webp` (animado, con sus tiempos originales, loop infinito) y `emoji-<nombre>.png`
 *      (póster: el cuadro de tinta más grande; es el `asset` de la EDL, lo que revisan validar.ts R5 y el layout).
 *      Remotion dibuja el .webp de al lado (src/reel/Sticker.tsx → animacionDeSticker).
 *   5. catalogo.json (versionado) con id `emoji-<nombre>`, codepoint, etiquetas en español, caja_tinta (la unión de
 *      todos los cuadros: nada se sale de ahí al animarse) y su fila en biblioteca/licencias/emojis.md.
 *
 * Licencia: "Animated Noto Emoji is licensed under CC BY 4.0" (FAQ de googlefonts.github.io/noto-emoji-animation,
 * revisada el 2026-10-04: se puede usar comercialmente en video). Atribución: ver ATRIBUCION.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {cajaTinta, grosorPorDefecto, guardarPng, nuevaImagen, ponerBorde, sha256, sombraPorDefecto, type Caja, type ImagenRGBA, type OpcionesSombra} from './lib/borde.ts';

export const RAIZ = resolve(import.meta.dirname, '../..');
export const DIR_EMOJIS = join(RAIZ, 'biblioteca', 'stickers', 'emojis');
export const URL_NOTO = (codepoint: string): string => `https://fonts.gstatic.com/s/e/notoemoji/latest/${codepoint}/512.webp`;
export const LICENCIA = 'CC BY 4.0';
export const ATRIBUCION = 'Animated Noto Emoji © Google, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), https://googlefonts.github.io/noto-emoji-animation/. Modificado: borde blanco y sombra.';

/** Emojis del set inicial: nombre (id = emoji-<nombre>), codepoint de Noto y etiquetas por concepto (las del director). */
export const EMOJIS: ReadonlyArray<{nombre: string; emoji: string; codepoint: string; etiquetas: string[]}> = [
	{nombre: 'risa', emoji: '😂', codepoint: '1f602', etiquetas: ['risa', 'jaja', 'chistoso', 'gracioso']},
	{nombre: 'carcajada', emoji: '🤣', codepoint: '1f923', etiquetas: ['risa', 'carcajada', 'jaja', 'gracioso']},
	{nombre: 'llorando', emoji: '😭', codepoint: '1f62d', etiquetas: ['llorar', 'triste', 'drama']},
	{nombre: 'calavera', emoji: '💀', codepoint: '1f480', etiquetas: ['me muero', 'muerto', 'risa']},
	{nombre: 'mente-explota', emoji: '🤯', codepoint: '1f92f', etiquetas: ['impresionante', 'increíble', 'wow', 'sorpresa']},
	{nombre: 'grito', emoji: '😱', codepoint: '1f631', etiquetas: ['miedo', 'terror', 'sorpresa', 'peligro']},
	{nombre: 'sonrojado', emoji: '😳', codepoint: '1f633', etiquetas: ['sorpresa', 'pena', 'incómodo']},
	{nombre: 'derretido', emoji: '🫠', codepoint: '1fae0', etiquetas: ['derretido', 'cansado', 'abrumado', 'incómodo']},
	{nombre: 'al-reves', emoji: '🙃', codepoint: '1f643', etiquetas: ['ironía', 'sarcasmo', 'ni modo']},
	{nombre: 'lentes', emoji: '😎', codepoint: '1f60e', etiquetas: ['cool', 'fácil', 'relax', 'tranquilo']},
	{nombre: 'pensando', emoji: '🤔', codepoint: '1f914', etiquetas: ['pensar', 'pregunta', 'duda']},
	{nombre: 'monoculo', emoji: '🧐', codepoint: '1f9d0', etiquetas: ['buscar', 'investigar', 'analizar', 'revisar']},
	{nombre: 'ojos', emoji: '👀', codepoint: '1f440', etiquetas: ['ojo', 'mirar', 'atención', 'importante']},
	{nombre: 'fuego', emoji: '🔥', codepoint: '1f525', etiquetas: ['fuego', 'viral', 'potente']},
	{nombre: 'cien', emoji: '💯', codepoint: '1f4af', etiquetas: ['100', 'top', 'mejor', 'perfecto']},
	{nombre: 'check', emoji: '✅', codepoint: '2705', etiquetas: ['listo', 'check', 'aprobado', 'completado']},
	{nombre: 'tache', emoji: '❌', codepoint: '274c', etiquetas: ['error', 'no', 'mal']},
	{nombre: 'cohete', emoji: '🚀', codepoint: '1f680', etiquetas: ['cohete', 'lanzamiento', 'rápido', 'crecer']},
	{nombre: 'rayo', emoji: '⚡', codepoint: '26a1', etiquetas: ['rápido', 'velocidad', 'al instante', 'automático']},
	{nombre: 'foco', emoji: '💡', codepoint: '1f4a1', etiquetas: ['idea', 'tip', 'truco']},
	{nombre: 'diana', emoji: '🎯', codepoint: '1f3af', etiquetas: ['objetivo', 'meta', 'exacto']},
	{nombre: 'aplausos', emoji: '👏', codepoint: '1f44f', etiquetas: ['aplausos', 'bravo', 'felicidades']},
	{nombre: 'manos-arriba', emoji: '🙌', codepoint: '1f64c', etiquetas: ['celebrar', 'por fin', 'felicidades']},
	{nombre: 'trato', emoji: '🤝', codepoint: '1f91d', etiquetas: ['trato', 'acuerdo', 'equipo', 'conectar']},
	{nombre: 'dinero-vuela', emoji: '💸', codepoint: '1f4b8', etiquetas: ['dinero', 'gastar', 'precio', 'pago']},
	{nombre: 'cara-dinero', emoji: '🤑', codepoint: '1f911', etiquetas: ['dinero', 'ganar', 'ventas', 'vender']},
	{nombre: 'resoplido', emoji: '😤', codepoint: '1f624', etiquetas: ['enojado', 'frustrante', 'coraje']},
	{nombre: 'sonrisa-lagrima', emoji: '🥲', codepoint: '1f972', etiquetas: ['ni modo', 'triste', 'aguantar']},
	{nombre: 'saludo', emoji: '🫡', codepoint: '1fae1', etiquetas: ['a la orden', 'respeto', 'hola']},
	{nombre: 'destellos', emoji: '✨', codepoint: '2728', etiquetas: ['nuevo', 'magia', 'novedad', 'brillante']},
	{nombre: 'fiesta', emoji: '🎉', codepoint: '1f389', etiquetas: ['fiesta', 'celebrar', 'felicidades', 'lanzamiento']},
];

// ───────────────────────────── WebP animado (puro) ─────────────────────────────

export type CuadroWebp = {ancho: number; alto: number; x: number; y: number; duracion_ms: number; desecho: 'fondo' | 'nada'; fusion: boolean};

/** Lee la salida de `webpmux -info` (lienzo y una fila por cuadro). */
export function parsearInfoWebp(texto: string): {ancho: number; alto: number; cuadros: CuadroWebp[]} {
	const lienzo = /Canvas size:\s*(\d+)\s*x\s*(\d+)/.exec(texto);
	if (!lienzo) throw fallo('leer el WebP', 'webpmux no dio el tamaño del lienzo', 'revisa que el archivo sea un WebP animado', 2);
	const cuadros: CuadroWebp[] = [];
	for (const linea of texto.split('\n')) {
		const m = /^\s*\d+:\s+(\d+)\s+(\d+)\s+(yes|no)\s+(\d+)\s+(\d+)\s+(\d+)\s+(background|none)\s+(yes|no)\b/.exec(linea);
		if (!m) continue;
		cuadros.push({ancho: +m[1], alto: +m[2], x: +m[4], y: +m[5], duracion_ms: +m[6], desecho: m[7] === 'background' ? 'fondo' : 'nada', fusion: m[8] === 'yes'});
	}
	if (cuadros.length === 0) throw fallo('leer el WebP', 'no trae cuadros de animación', 'usa el 512.webp animado de Noto', 2);
	return {ancho: +lienzo[1], alto: +lienzo[2], cuadros};
}

/** Lee un PAM RGB_ALPHA de 8 bits (lo que escribe `dwebp -pam`). */
export function leerPam(buf: Uint8Array): ImagenRGBA {
	const cabeza = Buffer.from(buf.subarray(0, Math.min(buf.length, 200))).toString('latin1');
	const fin = cabeza.indexOf('ENDHDR\n');
	const w = /WIDTH (\d+)/.exec(cabeza);
	const h = /HEIGHT (\d+)/.exec(cabeza);
	if (fin < 0 || !w || !h || !/DEPTH 4/.test(cabeza) || !/MAXVAL 255/.test(cabeza)) throw fallo('leer un cuadro', 'el PAM no es RGBA de 8 bits', 'revisa dwebp', 1);
	const ancho = +w[1];
	const alto = +h[1];
	const ini = fin + 'ENDHDR\n'.length;
	if (buf.length < ini + ancho * alto * 4) throw fallo('leer un cuadro', 'el PAM viene incompleto', 'revisa dwebp', 1);
	return {ancho, alto, datos: new Uint8ClampedArray(buf.slice(ini, ini + ancho * alto * 4))};
}

/** Escribe un PAM RGB_ALPHA (img2webp lo acepta de entrada). */
export function escribirPam(img: ImagenRGBA): Buffer {
	const cabeza = Buffer.from(`P7\nWIDTH ${img.ancho}\nHEIGHT ${img.alto}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`, 'latin1');
	return Buffer.concat([cabeza, Buffer.from(img.datos.buffer, img.datos.byteOffset, img.datos.byteLength)]);
}

/**
 * Compone los cuadros de un WebP animado en lienzos completos (spec de WebP: antes de pintar un cuadro, si el anterior
 * pide desecho "background", su rectángulo vuelve a transparente; con fusión el cuadro va encima con alfa, sin fusión
 * reemplaza su rectángulo).
 */
export function componerAnimacion(lienzo: {ancho: number; alto: number}, cuadros: ReadonlyArray<{info: CuadroWebp; img: ImagenRGBA}>): ImagenRGBA[] {
	const L = nuevaImagen(lienzo.ancho, lienzo.alto);
	const d = L.datos;
	const salida: ImagenRGBA[] = [];
	let anterior: CuadroWebp | null = null;
	for (const {info, img} of cuadros) {
		if (anterior?.desecho === 'fondo') {
			for (let y = anterior.y; y < Math.min(lienzo.alto, anterior.y + anterior.alto); y++) d.fill(0, (y * lienzo.ancho + anterior.x) * 4, (y * lienzo.ancho + Math.min(lienzo.ancho, anterior.x + anterior.ancho)) * 4);
		}
		for (let y = 0; y < img.alto; y++) {
			const yy = info.y + y;
			if (yy < 0 || yy >= lienzo.alto) continue;
			for (let x = 0; x < img.ancho; x++) {
				const xx = info.x + x;
				if (xx < 0 || xx >= lienzo.ancho) continue;
				const o = (yy * lienzo.ancho + xx) * 4;
				const s = (y * img.ancho + x) * 4;
				const as = img.datos[s + 3] / 255;
				if (!info.fusion || as >= 1) {
					d[o] = img.datos[s];
					d[o + 1] = img.datos[s + 1];
					d[o + 2] = img.datos[s + 2];
					d[o + 3] = img.datos[s + 3];
					continue;
				}
				if (as <= 0) continue;
				const ad = d[o + 3] / 255;
				const a = as + ad * (1 - as);
				for (let c = 0; c < 3; c++) d[o + c] = Math.round((img.datos[s + c] * as + d[o + c] * ad * (1 - as)) / a);
				d[o + 3] = Math.round(a * 255);
			}
		}
		salida.push({ancho: L.ancho, alto: L.alto, datos: new Uint8ClampedArray(d)});
		anterior = info;
	}
	return salida;
}

const union = (a: Caja | null, b: Caja | null): Caja | null => {
	if (!a) return b;
	if (!b) return a;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y};
};

/**
 * Borde blanco y sombra a cada cuadro con el mismo grosor y la misma sombra, en un lienzo cuadrado común (el sujeto
 * no se mueve de lugar entre cuadros). Devuelve los cuadros, la unión de su tinta (caja_tinta del catálogo) y el
 * índice del póster (el cuadro de tinta más grande).
 */
export function bordeAnimado(cuadros: readonly ImagenRGBA[], op: {grosor?: number; sombra?: OpcionesSombra | null} = {}): {cuadros: ImagenRGBA[]; caja_tinta: Caja; poster: number; grosor: number} {
	if (cuadros.length === 0) throw fallo('poner el borde al emoji', 'no hay cuadros', 'revisa el WebP', 1);
	const {ancho: W, alto: H} = cuadros[0];
	const tintas = cuadros.map((c) => cajaTinta(c, 1));
	const lado = Math.max(1, ...tintas.map((t) => (t ? Math.max(t.w, t.h) : 0)));
	const grosor = Math.max(0, Math.round(op.grosor ?? grosorPorDefecto(lado)));
	const sombra = op.sombra === undefined ? sombraPorDefecto(lado + 2 * grosor) : op.sombra;
	// Con grosor y sombra fijos, ponerBorde deja siempre el mismo margen m alrededor de la tinta: el cuadro con borde
	// va en (t.x, t.y) de un lienzo de (W + 2m) × (H + 2m) y el sujeto queda donde estaba.
	let m = -1;
	const grandes: Array<ImagenRGBA | null> = cuadros.map((c, i) => {
		const t = tintas[i];
		if (!t) return null;
		const r = ponerBorde(c, {grosor, sombra});
		const mi = (r.imagen.ancho - t.w) / 2;
		if (m < 0) m = mi;
		const L = nuevaImagen(W + 2 * m, H + 2 * m);
		for (let y = 0; y < r.imagen.alto; y++) {
			const yy = t.y + y;
			if (yy < 0 || yy >= L.alto) continue;
			const ini = (yy * L.ancho + t.x) * 4;
			L.datos.set(r.imagen.datos.subarray(y * r.imagen.ancho * 4, (y + 1) * r.imagen.ancho * 4).subarray(0, Math.max(0, (L.ancho - t.x) * 4)), ini);
		}
		return L;
	});
	if (m < 0) throw fallo('poner el borde al emoji', 'todos los cuadros vienen vacíos', 'revisa el WebP', 1);
	let u: Caja | null = null;
	for (const g of grandes) if (g) u = union(u, cajaTinta(g, 1));
	const caja = u!;
	// Lienzo final: la unión con 2 px de aire, cuadrado y centrado.
	const lado2 = Math.max(caja.w, caja.h) + 4;
	const ox = caja.x - Math.floor((lado2 - caja.w) / 2);
	const oy = caja.y - Math.floor((lado2 - caja.h) / 2);
	const finales = grandes.map((g) => {
		const F = nuevaImagen(lado2, lado2);
		if (!g) return F;
		for (let y = 0; y < lado2; y++) {
			const ys = oy + y;
			if (ys < 0 || ys >= g.alto) continue;
			for (let x = 0; x < lado2; x++) {
				const xs = ox + x;
				if (xs < 0 || xs >= g.ancho) continue;
				const s = (ys * g.ancho + xs) * 4;
				if (g.datos[s + 3] === 0) continue;
				F.datos.set(g.datos.subarray(s, s + 4), (y * lado2 + x) * 4);
			}
		}
		return F;
	});
	let poster = 0;
	let mejor = -1;
	finales.forEach((f, i) => {
		const t = cajaTinta(f, 1);
		const area = t ? t.w * t.h : 0;
		if (area > mejor) {
			mejor = area;
			poster = i;
		}
	});
	return {cuadros: finales, caja_tinta: {x: caja.x - ox, y: caja.y - oy, w: caja.w, h: caja.h}, poster, grosor};
}

// ───────────────────────────── Catálogo y licencias ─────────────────────────────

export type FilaEmoji = {
	id: string;
	nombre: string;
	emoji: string;
	codepoint: string;
	fuente: 'noto-emoji-animation';
	archivo: string;
	animacion: string;
	ancho: number;
	alto: number;
	caja_tinta: Caja;
	cuadros: number;
	duracion_s: number;
	etiquetas: string[];
	licencia: string;
	atribucion: string;
	origen: {url: string; sha256: string};
	borde_px: number;
	sha256: string;
	sha256_animacion: string;
	procesado_en: string;
};

export function licencias(filas: readonly FilaEmoji[]): string {
	return [
		'# Licencias — emojis animados',
		'',
		`**Animated Noto Emoji** de Google, licencia **${LICENCIA}** (https://creativecommons.org/licenses/by/4.0/). La página del proyecto (https://googlefonts.github.io/noto-emoji-animation/, FAQ "Can I use these animated assets commercially: for a video…?") dice: "Animated Noto Emoji is licensed under CC BY 4.0". Revisado el 2026-10-04.`,
		'',
		`- **Atribución** (CC BY pide darla de forma razonable; por ejemplo en la descripción del reel o en una nota fija de tu perfil): "${ATRIBUCION}"`,
		'- **Cambios:** cada cuadro lleva el borde blanco y la sombra de tus stickers (`herramientas/stickers/emojis.ts`). Los originales se bajan a `stickers/emojis/fuente/` (no se versionan).',
		'- Los `.png` (póster) y `.webp` (animación) no se versionan: se rehacen con `npx tsx herramientas/stickers/emojis.ts`.',
		'',
		'| Archivo | Emoji | Licencia | Origen | sha256 del original |',
		'|---|---|---|---|---|',
		...filas.flatMap((f) => [
			`| \`${f.archivo.replace(/^biblioteca\//, '')}\` | ${f.emoji} ${f.nombre} | ${LICENCIA} (Google, modificado) | ${f.origen.url} | \`${f.origen.sha256}\` |`,
			`| \`${f.animacion.replace(/^biblioteca\//, '')}\` | ${f.emoji} ${f.nombre} (animado) | ${LICENCIA} (Google, modificado) | ${f.origen.url} | \`${f.origen.sha256}\` |`,
		]),
		`| \`stickers/emojis/catalogo.json\` | — | Código de este proyecto | — | — |`,
		'',
	].join('\n');
}

// ───────────────────────────── CLI ─────────────────────────────

const correrCmd = (cmd: string, args: string[]): Buffer => {
	try {
		return execFileSync(cmd, args, {stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28});
	} catch (e) {
		const err = e as {code?: string; stderr?: Buffer};
		if (err.code === 'ENOENT') throw fallo(`correr ${cmd}`, 'no está instalado', 'instala libwebp (brew install webp; viene con ffmpeg de Homebrew)', 2);
		throw fallo(`correr ${cmd}`, String(err.stderr ?? e).trim().split('\n').at(-1) ?? 'falló', 'revisa el archivo de entrada', 1, e);
	}
};

function bajar(codepoint: string, destino: string): void {
	try {
		execFileSync('curl', ['-fsSL', '--retry', '2', '-o', destino, URL_NOTO(codepoint)], {stdio: ['ignore', 'pipe', 'pipe']});
	} catch (e) {
		rmSync(destino, {force: true});
		throw fallo(`bajar el emoji ${codepoint}`, 'fonts.gstatic.com no respondió', 'revisa la red (o corre con --sin-bajar para usar solo los que ya están)', 3, e);
	}
}

function procesar(e: (typeof EMOJIS)[number], tmp: string, sinBajar: boolean): FilaEmoji | null {
	const fuente = join(DIR_EMOJIS, 'fuente', `${e.codepoint}.webp`);
	if (!existsSync(fuente)) {
		if (sinBajar) return null;
		bajar(e.codepoint, fuente);
	}
	const info = parsearInfoWebp(correrCmd('webpmux', ['-info', fuente]).toString('utf8'));
	const dir = mkdtempSync(join(tmp, `${e.nombre}-`));
	const crudos = info.cuadros.map((c, i) => {
		const f = join(dir, `c${i}.webp`);
		correrCmd('webpmux', ['-get', 'frame', String(i + 1), fuente, '-o', f]);
		const pam = join(dir, `c${i}.pam`);
		correrCmd('dwebp', [f, '-pam', '-o', pam]);
		return {info: c, img: leerPam(readFileSync(pam))};
	});
	const completos = componerAnimacion(info, crudos);
	const r = bordeAnimado(completos);
	const id = `emoji-${e.nombre}`;
	const args = ['-loop', '0', '-lossy', '-q', '85', '-m', '4'];
	r.cuadros.forEach((c, i) => {
		const p = join(dir, `b${i}.pam`);
		writeFileSync(p, escribirPam(c));
		args.push('-d', String(info.cuadros[i].duracion_ms), p);
	});
	const anim = join(DIR_EMOJIS, `${id}.webp`);
	correrCmd('img2webp', [...args, '-o', anim]);
	const png = join(DIR_EMOJIS, `${id}.png`);
	const g = guardarPng(png, r.cuadros[r.poster]);
	rmSync(dir, {recursive: true, force: true});
	return {
		id,
		nombre: e.nombre,
		emoji: e.emoji,
		codepoint: e.codepoint,
		fuente: 'noto-emoji-animation',
		archivo: `biblioteca/stickers/emojis/${id}.png`,
		animacion: `biblioteca/stickers/emojis/${id}.webp`,
		ancho: r.cuadros[0].ancho,
		alto: r.cuadros[0].alto,
		caja_tinta: r.caja_tinta,
		cuadros: r.cuadros.length,
		duracion_s: Math.round(info.cuadros.reduce((s, c) => s + c.duracion_ms, 0)) / 1000,
		etiquetas: e.etiquetas,
		licencia: LICENCIA,
		atribucion: ATRIBUCION,
		origen: {url: URL_NOTO(e.codepoint), sha256: sha256(readFileSync(fuente))},
		borde_px: r.grosor,
		sha256: g.sha256,
		sha256_animacion: sha256(readFileSync(anim)),
		procesado_en: new Date().toISOString().slice(0, 10),
	};
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const sinBajar = argv.includes('--sin-bajar');
	const iSolo = argv.indexOf('--solo');
	const solo = iSolo >= 0 ? new Set((argv[iSolo + 1] ?? '').split(',').filter(Boolean)) : null;
	if (solo) for (const n of solo) if (!EMOJIS.some((e) => e.nombre === n)) throw fallo('elegir los emojis', `no conozco "${n}"`, `usa uno de: ${EMOJIS.map((e) => e.nombre).join(', ')}`, 2);
	mkdirSync(join(DIR_EMOJIS, 'fuente'), {recursive: true});
	const rutaCat = join(DIR_EMOJIS, 'catalogo.json');
	const previas: FilaEmoji[] = existsSync(rutaCat) ? JSON.parse(readFileSync(rutaCat, 'utf8')) : [];
	const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'emojis-'));
	const filas: FilaEmoji[] = [];
	const faltan: string[] = [];
	for (const e of EMOJIS) {
		const previa = previas.find((p) => p.nombre === e.nombre);
		if (solo && !solo.has(e.nombre)) {
			if (previa) filas.push({...previa, etiquetas: e.etiquetas});
			continue;
		}
		const t0 = Date.now();
		const f = procesar(e, tmp, sinBajar);
		if (!f) {
			faltan.push(e.nombre);
			if (previa) filas.push(previa);
			continue;
		}
		filas.push(f);
		const kb = Math.round(statSync(join(RAIZ, f.animacion)).size / 1024);
		console.log(`${e.emoji} ${f.id}: ${f.cuadros} cuadros (${f.duracion_s} s), ${f.ancho}×${f.alto}, borde ${f.borde_px} px, ${kb} KB · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	}
	rmSync(tmp, {recursive: true, force: true});
	writeFileSync(rutaCat, `${JSON.stringify(filas, null, '\t')}\n`);
	writeFileSync(join(RAIZ, 'biblioteca', 'licencias', 'emojis.md'), licencias(filas));
	console.log(`Emojis: ${filas.length} en el catálogo${faltan.length ? ` · sin original (corre sin --sin-bajar): ${faltan.join(', ')}` : ''}.`);
}

if (esPrincipal(import.meta.url)) correr(main);
