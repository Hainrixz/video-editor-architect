// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * A/B: el render contra el reel que el creador publicó en Instagram (criterios de la Fase 1 en los pares).
 *
 * - Duración: |render − publicado| / publicado ≤ 15 %.
 * - Texto: 1 − WER ≥ 0.9 entre la transcripción del render y la del publicado (whisper-cli large-v3, -l es,
 *   igual que herramientas/emparejar.ts; referencia = el publicado; palabras normalizadas con normalizarPalabras()).
 * - Subtítulos (OCR de herramientas/estilo/medir.ts, que exporta medirSubtitulos(mp4) con un resumen
 *   {y_p50, alto_mayuscula_p50, color_texto, color_borde, grosor_borde_p50} en base 1080×1920):
 *   |ΔY| ≤ 28 px, alto de mayúscula ±5 %, ΔE2000 ≤ 5 en color de texto y de borde, grosor ±1 px.
 *   Si medir.ts todavía no existe (lo construye otra pieza), esos checks quedan N/A con la nota; se carga con
 *   un import dinámico, así este módulo no depende de él para compilar.
 * - Video lado a lado (cada lado a 1080 de alto, hstack) en salida/ab-vN.mp4 para tu veredicto visual.
 *
 * El reel publicado y tus carpetas se leen y nada más. whisper-cli usa la GPU (Metal), que no funciona dentro
 * del sandbox: esto corre desde qa.ts, que es un comando excluido.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {normalizarPalabras, similitudTexto, wer} from '../emparejar.ts';
import {ubicarHerramientas} from '../transcribir.ts';
import {fallo, FalloEditor, registrarDetalle} from './fallo.ts';
import {RAIZ} from './manifest.ts';
import {crearCheck, type Check} from './reporte.ts';
import {extraerAudio16k} from './sincronia.ts';

export const CRITERIOS_AB = {
	duracionRelativa: 0.15,
	similitudMinima: 0.9,
	deltaYpx: 28,
	altoMayusculaRelativo: 0.05,
	deltaEMaximo: 5,
	grosorPx: 1,
} as const;

/** Sin --dtw ni --vad: aquí solo importa el texto (los mismos argumentos que emparejar.ts). */
export const ARGS_WHISPER_TEXTO = ['-l', 'es', '-otxt', '-np'] as const;

export const RUTA_MEDIR = join(RAIZ, 'herramientas', 'estilo', 'medir.ts');

// ───────────────────────── color (puro) ─────────────────────────

export type Rgb = {r: number; g: number; b: number};
export type Lab = {L: number; a: number; b: number};

/** Número de un valor que puede venir como número, texto numérico o {valor: …} (convención de métricas). */
export function numeroDe(x: unknown): number | null {
	if (typeof x === 'number') return Number.isFinite(x) ? x : null;
	if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
	if (x && typeof x === 'object' && 'valor' in x) return numeroDe((x as {valor: unknown}).valor);
	return null;
}

/**
 * Color en Lab desde lo que dé medir.ts: "#rrggbb", "#rgb", "rgb(r, g, b)", [r, g, b] (0–255), {r, g, b},
 * {L, a, b} (ya en Lab), {hex} o {valor: …}. null si no se reconoce (o es "N/A").
 */
export function colorALab(x: unknown): Lab | null {
	if (x === null || x === undefined) return null;
	if (typeof x === 'string') {
		const s = x.trim();
		let m = /^#?([0-9a-f]{6})$/i.exec(s);
		if (m) {
			const n = Number.parseInt(m[1], 16);
			return srgbALab({r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255});
		}
		m = /^#?([0-9a-f]{3})$/i.exec(s);
		if (m) {
			const [r, g, b] = m[1].split('').map((c) => Number.parseInt(c + c, 16));
			return srgbALab({r, g, b});
		}
		m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
		if (m) return srgbALab({r: Number(m[1]), g: Number(m[2]), b: Number(m[3])});
		return null;
	}
	if (Array.isArray(x) && x.length >= 3 && x.slice(0, 3).every((v) => typeof v === 'number')) {
		return srgbALab({r: x[0], g: x[1], b: x[2]});
	}
	if (typeof x === 'object') {
		const o = x as Record<string, unknown>;
		if ('valor' in o) return colorALab(o.valor);
		if ('hex' in o) return colorALab(o.hex);
		const L = numeroDe(o.L ?? o.l);
		if (L !== null && numeroDe(o.a) !== null && numeroDe(o.b) !== null && !('r' in o)) return {L, a: numeroDe(o.a) as number, b: numeroDe(o.b) as number};
		const r = numeroDe(o.r);
		const g = numeroDe(o.g);
		const b = numeroDe(o.b);
		if (r !== null && g !== null && b !== null) return srgbALab({r, g, b});
	}
	return null;
}

/** sRGB (0–255) → CIELAB (D65). */
export function srgbALab({r, g, b}: Rgb): Lab {
	const lineal = (c: number) => {
		const v = Math.min(255, Math.max(0, c)) / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const [R, G, B] = [lineal(r), lineal(g), lineal(b)];
	const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
	const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
	const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
	return {L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z))};
}

/** ΔE CIEDE2000 (kL = kC = kH = 1). */
export function deltaE2000(x: Lab, y: Lab): number {
	const rad = Math.PI / 180;
	const C1 = Math.hypot(x.a, x.b);
	const C2 = Math.hypot(y.a, y.b);
	const Cm = (C1 + C2) / 2;
	const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
	const a1 = (1 + G) * x.a;
	const a2 = (1 + G) * y.a;
	const C1p = Math.hypot(a1, x.b);
	const C2p = Math.hypot(a2, y.b);
	const h = (a: number, b: number) => {
		if (a === 0 && b === 0) return 0;
		const ang = Math.atan2(b, a) / rad;
		return ang >= 0 ? ang : ang + 360;
	};
	const h1 = h(a1, x.b);
	const h2 = h(a2, y.b);
	const dL = y.L - x.L;
	const dC = C2p - C1p;
	let dh = 0;
	if (C1p * C2p !== 0) {
		dh = h2 - h1;
		if (dh > 180) dh -= 360;
		else if (dh < -180) dh += 360;
	}
	const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
	const Lm = (x.L + y.L) / 2;
	const Cmp = (C1p + C2p) / 2;
	let hm = h1 + h2;
	if (C1p * C2p !== 0) {
		if (Math.abs(h1 - h2) <= 180) hm = (h1 + h2) / 2;
		else hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
	}
	const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
	const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
	const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
	const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
	const Sc = 1 + 0.045 * Cmp;
	const Sh = 1 + 0.015 * Cmp * T;
	const Rt = -Math.sin(2 * dTheta * rad) * Rc;
	return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

// ───────────────────────── subtítulos por OCR ─────────────────────────

/** Lo que este módulo lee del resumen de medir.ts (todo opcional: lo que falte queda N/A). */
export type ResumenSubtitulos = {
	y_p50?: unknown;
	alto_mayuscula_p50?: unknown;
	color_texto?: unknown;
	color_borde?: unknown;
	grosor_borde_p50?: unknown;
	n?: unknown;
	/** N de cada métrica (medir.ts: y, alto_mayuscula, color, grosor_borde); si falta, se usa `n`. */
	n_por_metrica?: unknown;
};

type ModuloMedir = {medirSubtitulos: (mp4: string) => Promise<unknown> | unknown};

/** Carga herramientas/estilo/medir.ts si ya existe; null si todavía no (con el motivo). */
export async function cargarMedir(ruta = RUTA_MEDIR): Promise<{modulo: ModuloMedir | null; motivo?: string}> {
	if (!existsSync(ruta)) return {modulo: null, motivo: 'todavía no existe herramientas/estilo/medir.ts (lo construye otra pieza de la Fase 1)'};
	try {
		const modulo = (await import(pathToFileURL(ruta).href)) as Partial<ModuloMedir>;
		if (typeof modulo.medirSubtitulos !== 'function') return {modulo: null, motivo: 'herramientas/estilo/medir.ts no exporta medirSubtitulos(mp4)'};
		return {modulo: modulo as ModuloMedir};
	} catch (error) {
		registrarDetalle(error);
		return {modulo: null, motivo: `no pude cargar herramientas/estilo/medir.ts (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`};
	}
}

/** El resumen viene como {resumen: {...}} o directo; también acepta {valor: …} en cada campo. */
export function extraerResumen(resultado: unknown): ResumenSubtitulos | null {
	if (!resultado || typeof resultado !== 'object') return null;
	const r = resultado as Record<string, unknown>;
	const resumen = (r.resumen && typeof r.resumen === 'object' ? r.resumen : r) as Record<string, unknown>;
	const n = numeroDe(resumen.n) ?? numeroDe(r.n) ?? (Array.isArray(r.eventos) ? r.eventos.length : null);
	return {...resumen, n};
}

/** Los 5 checks de subtítulos (render contra publicado). Sin resumen → N/A con `motivo`. */
export function checksSubtitulos(render: ResumenSubtitulos | null, publicado: ResumenSubtitulos | null, motivo?: string): Check[] {
	const fuente = 'herramientas/estilo/medir.ts (OCR), base 1080×1920';
	/** N de la comparación = el menor de los dos videos, por métrica (eventos que aportan esa medida). */
	const nDe = (metrica: string): number | null => {
		if (!render || !publicado) return null;
		const de = (r: ResumenSubtitulos) => {
			const porMetrica = r.n_por_metrica && typeof r.n_por_metrica === 'object' ? numeroDe((r.n_por_metrica as Record<string, unknown>)[metrica]) : null;
			return porMetrica ?? numeroDe(r.n) ?? Infinity;
		};
		const n = Math.min(de(render), de(publicado));
		return Number.isFinite(n) ? n : null;
	};
	const faltan = (que: string) => motivo ?? `medir.ts no devolvió ${que} de alguno de los dos videos`;
	const par = (campo: keyof ResumenSubtitulos) => [numeroDe(render?.[campo]), numeroDe(publicado?.[campo])] as const;

	const [yR, yP] = par('y_p50');
	const [aR, aP] = par('alto_mayuscula_p50');
	const [gR, gP] = par('grosor_borde_p50');
	const cT = [colorALab(render?.color_texto), colorALab(publicado?.color_texto)] as const;
	const cB = [colorALab(render?.color_borde), colorALab(publicado?.color_borde)] as const;
	const dY = yR !== null && yP !== null ? Math.abs(yR - yP) : null;
	const dA = aR !== null && aP !== null && aP !== 0 ? Math.abs(aR - aP) / aP : null;
	const dT = cT[0] && cT[1] ? deltaE2000(cT[0], cT[1]) : null;
	const dB = cB[0] && cB[1] ? deltaE2000(cB[0], cB[1]) : null;
	const dG = gR !== null && gP !== null ? Math.abs(gR - gP) : null;
	const r1 = (x: number) => Math.round(x * 10) / 10;
	return [
		crearCheck({id: 'ab.y', nombre: 'Y del subtítulo (p50) vs publicado', nivel: 'estetico', pasa: dY === null ? null : dY <= CRITERIOS_AB.deltaYpx, valor: dY === null ? null : `|ΔY| ${r1(dY)} px (${r1(yR as number)} vs ${r1(yP as number)})`, criterio: `|ΔY| ≤ ${CRITERIOS_AB.deltaYpx} px (base 1920)`, n: nDe('y'), fuente, ...(dY === null ? {nota: faltan('y_p50')} : {})}),
		crearCheck({id: 'ab.alto_mayuscula', nombre: 'Alto de mayúscula (p50) vs publicado', nivel: 'estetico', pasa: dA === null ? null : dA <= CRITERIOS_AB.altoMayusculaRelativo, valor: dA === null ? null : `${r1(dA * 100)} % (${r1(aR as number)} vs ${r1(aP as number)} px)`, criterio: `±${CRITERIOS_AB.altoMayusculaRelativo * 100} %`, n: nDe('alto_mayuscula'), fuente, ...(dA === null ? {nota: faltan('alto_mayuscula_p50')} : {})}),
		crearCheck({id: 'ab.color_texto', nombre: 'Color del texto vs publicado', nivel: 'estetico', pasa: dT === null ? null : dT <= CRITERIOS_AB.deltaEMaximo, valor: dT === null ? null : `ΔE2000 ${r1(dT)}`, criterio: `ΔE2000 ≤ ${CRITERIOS_AB.deltaEMaximo}`, n: nDe('color'), fuente, ...(dT === null ? {nota: faltan('color_texto')} : {})}),
		crearCheck({id: 'ab.color_borde', nombre: 'Color del borde vs publicado', nivel: 'estetico', pasa: dB === null ? null : dB <= CRITERIOS_AB.deltaEMaximo, valor: dB === null ? null : `ΔE2000 ${r1(dB)}`, criterio: `ΔE2000 ≤ ${CRITERIOS_AB.deltaEMaximo}`, n: nDe('color'), fuente, ...(dB === null ? {nota: faltan('color_borde')} : {})}),
		crearCheck({id: 'ab.grosor_borde', nombre: 'Grosor del borde (p50) vs publicado', nivel: 'estetico', pasa: dG === null ? null : dG <= CRITERIOS_AB.grosorPx, valor: dG === null ? null : `|Δ| ${r1(dG)} px (${r1(gR as number)} vs ${r1(gP as number)})`, criterio: `±${CRITERIOS_AB.grosorPx} px`, n: nDe('grosor_borde'), fuente, ...(dG === null ? {nota: faltan('grosor_borde_p50')} : {})}),
	];
}

// ───────────────────────── duración y texto ─────────────────────────

export function duracionDe(ruta: string): number {
	const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ruta], {encoding: 'utf8'});
	const d = Number(r.stdout?.trim());
	if (r.status !== 0 || !Number.isFinite(d)) {
		throw fallo(`leer la duración de ${basename(ruta)}`, 'ffprobe no la pudo leer', 'revisa que el archivo exista y esté completo', 2, {stderr: r.stderr});
	}
	return d;
}

export function checkDuracion(render_s: number, publicado_s: number): Check {
	const rel = Math.abs(render_s - publicado_s) / publicado_s;
	return crearCheck({
		id: 'ab.duracion',
		nombre: 'Duración vs publicado',
		nivel: 'estetico',
		pasa: rel <= CRITERIOS_AB.duracionRelativa,
		valor: `${render_s.toFixed(2)} s vs ${publicado_s.toFixed(2)} s (${(rel * 100).toFixed(1)} %)`,
		criterio: `±${CRITERIOS_AB.duracionRelativa * 100} %`,
		n: null,
		fuente: 'ffprobe (duración del contenedor)',
	});
}

export type ComparacionTexto = {similitud: number | null; wer: number | null; palabras_render: number; palabras_publicado: number};

/** 1 − WER con el publicado como referencia (palabras normalizadas: minúsculas, sin acentos ni puntuación). */
export function compararTextos(textoPublicado: string, textoRender: string): ComparacionTexto {
	const ref = normalizarPalabras(textoPublicado);
	const hip = normalizarPalabras(textoRender);
	const w = wer(ref, hip);
	return {similitud: similitudTexto(ref, hip), wer: w === null ? null : Math.round(w * 1000) / 1000, palabras_render: hip.length, palabras_publicado: ref.length};
}

export function checkTexto(c: ComparacionTexto | null, nota?: string): Check {
	const sim = c?.similitud ?? null;
	return crearCheck({
		id: 'ab.texto',
		nombre: 'Texto (1 − WER) vs publicado',
		nivel: 'estetico',
		pasa: sim === null ? null : sim >= CRITERIOS_AB.similitudMinima,
		valor: sim === null ? null : Math.round(sim * 1000) / 1000,
		criterio: `≥ ${CRITERIOS_AB.similitudMinima}`,
		n: c ? c.palabras_publicado : null,
		fuente: 'whisper-cli large-v3 (-l es, sin DTW), referencia = publicado',
		...(sim === null ? {nota: nota ?? 'no hubo texto que comparar'} : {}),
	});
}

/**
 * Texto completo de un video con whisper-cli (audio a 16 kHz mono). Reusa la transcripción si el audio y los
 * argumentos no cambiaron (clave sha256 junto al .txt).
 */
export function transcribirTexto(video: string, dirTrabajo: string, nombre: string): string {
	mkdirSync(dirTrabajo, {recursive: true});
	const wav = join(dirTrabajo, `${nombre}.wav`);
	const base = join(dirTrabajo, nombre);
	const txt = `${base}.txt`;
	extraerAudio16k(video, wav);
	const h = ubicarHerramientas();
	const args = ['-m', h.modelo, '-f', wav, ...ARGS_WHISPER_TEXTO, '-of', base];
	const clave = createHash('sha256').update(readFileSync(wav)).update(`\u0000${h.version}\u0000${args.slice(2).join('\u0000')}`).digest('hex');
	const rutaClave = `${base}.clave`;
	if (existsSync(txt) && existsSync(rutaClave) && readFileSync(rutaClave, 'utf8').trim() === clave) return readFileSync(txt, 'utf8');
	const r = spawnSync(h.whisperCli, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000});
	if (r.status !== 0 || !existsSync(txt)) {
		throw fallo(`transcribir ${basename(video)} para el A/B`, `whisper-cli salió con código ${r.status ?? r.signal}`, 'si corriste dentro del sandbox, corre qa.ts solo en su llamada de Bash (Metal no funciona en el sandbox); si no, revisa proyectos/_logs/fallos.log', 1, {stderr: r.stderr?.slice(-3000)});
	}
	writeFileSync(rutaClave, `${clave}\n`);
	return readFileSync(txt, 'utf8');
}

// ───────────────────────── lado a lado ─────────────────────────

/** Etiquetas arriba de cada lado (PNG con resvg); null si no se pudo (el video sale igual, sin etiquetas). */
async function etiquetaPng(ruta: string, ancho: number, izquierda: string, derecha: string): Promise<string | null> {
	try {
		const {Resvg} = await import('@resvg/resvg-js');
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const mitad = ancho / 2;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="52"><rect width="${ancho}" height="52" fill="#000" fill-opacity="0.55"/><text x="${mitad / 2}" y="35" font-size="26" font-family="Helvetica, Arial, sans-serif" fill="#fff" text-anchor="middle">${esc(izquierda)}</text><text x="${mitad + mitad / 2}" y="35" font-size="26" font-family="Helvetica, Arial, sans-serif" fill="#fff" text-anchor="middle">${esc(derecha)}</text></svg>`;
		const png = new Resvg(svg, {font: {loadSystemFonts: true, defaultFontFamily: 'Helvetica'}}).render().asPng();
		writeFileSync(ruta, png);
		return ruta;
	} catch (error) {
		registrarDetalle(error);
		return null;
	}
}

/**
 * Video lado a lado: render a la izquierda (con su audio) y publicado a la derecha, cada uno a 1080 de alto y
 * 30 fps; el más corto se queda congelado en su último cuadro hasta que acaba el otro.
 */
export async function ladoALado(opciones: {render: string; publicado: string; salida: string; etiquetas: [string, string]; dirTrabajo: string}): Promise<{ruta: string; duracion_s: number}> {
	const dR = duracionDe(opciones.render);
	const dP = duracionDe(opciones.publicado);
	const total = Math.max(dR, dP);
	const ancho = 2 * 608; // 1080 × 9/16 = 607.5 → 608 por lado (par, para yuv420p)
	mkdirSync(opciones.dirTrabajo, {recursive: true});
	const etiqueta = await etiquetaPng(join(opciones.dirTrabajo, 'etiquetas-ab.png'), ancho, ...opciones.etiquetas);
	const lado = (i: number, falta: number) =>
		`[${i}:v]fps=30,scale=608:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=608:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${falta > 0.001 ? `,tpad=stop_mode=clone:stop_duration=${falta.toFixed(3)}` : ''}[l${i}]`;
	const partes = [lado(0, total - dR), lado(1, total - dP), '[l0][l1]hstack=inputs=2[pila]'];
	partes.push(etiqueta ? '[pila][2:v]overlay=0:0[v]' : '[pila]null[v]');
	const temporal = `${opciones.salida}.tmp.mp4`;
	const args = [
		'-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
		'-i', opciones.render, '-i', opciones.publicado,
		...(etiqueta ? ['-i', etiqueta] : []),
		'-filter_complex', partes.join(';'),
		'-map', '[v]', '-map', '0:a:0?',
		'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
		'-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
		'-t', total.toFixed(3), '-movflags', '+faststart', temporal,
	];
	const r = spawnSync('ffmpeg', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
	if (r.status !== 0) {
		rmSync(temporal, {force: true});
		throw fallo('armar el video lado a lado', `ffmpeg salió con código ${r.status ?? r.signal}`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: r.stderr?.slice(-3000)});
	}
	renameSync(temporal, opciones.salida);
	return {ruta: opciones.salida, duracion_s: Math.round(total * 1000) / 1000};
}

// ───────────────────────── todo junto ─────────────────────────

export type ResultadoAB = {
	render: {ruta: string; duracion_s: number};
	publicado: {ruta: string; shortCode: string | null; duracion_s: number};
	texto: ComparacionTexto | null;
	subtitulos: {disponible: boolean; motivo?: string; render?: ResumenSubtitulos | null; publicado?: ResumenSubtitulos | null};
	lado_a_lado: string | null;
	checks: Check[];
	notas: string[];
	tiempos_s: Record<string, number>;
};

export type OpcionesAB = {
	render: string;
	publicado: string;
	shortCode?: string | null;
	version: number;
	/** Ruta del video lado a lado (salida/ab-vN.mp4). */
	salidaLadoALado: string;
	/** Carpeta para los WAV y textos de whisper (qa/ab/). */
	dirTrabajo: string;
	transcribir?: boolean;
	ocr?: boolean;
	hacerLadoALado?: boolean;
	avisar?: (m: string) => void;
};

/** Un paso que falla no tumba el A/B: su check queda N/A con la frase del error (el detalle va al log). */
function motivoDe(error: unknown): string {
	registrarDetalle(error);
	if (error instanceof FalloEditor) return error.message;
	return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

export async function compararAB(op: OpcionesAB): Promise<ResultadoAB> {
	const avisar = op.avisar ?? ((m: string) => console.error(m));
	const tiempos: Record<string, number> = {};
	const cronometro = async <T>(etapa: string, fn: () => Promise<T> | T): Promise<T> => {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			tiempos[etapa] = Math.round((performance.now() - t0) / 10) / 100;
		}
	};
	if (!existsSync(op.publicado)) {
		throw fallo('comparar contra el reel publicado', `no existe ${op.publicado}`, 'confirma la ruta del mp4 publicado (pásala con --publicado)', 2);
	}
	const notas: string[] = [];
	const huellaAntes = statSync(op.publicado);

	const dR = duracionDe(op.render);
	const dP = duracionDe(op.publicado);
	const checks: Check[] = [checkDuracion(dR, dP)];

	let texto: ComparacionTexto | null = null;
	if (op.transcribir === false) {
		checks.push(checkTexto(null, 'se pidió sin transcripción'));
	} else {
		try {
			texto = await cronometro('texto', () => {
				avisar('  A/B: transcribiendo el render y el publicado con whisper-cli…');
				const tR = transcribirTexto(op.render, op.dirTrabajo, `render-v${op.version}`);
				const tP = transcribirTexto(op.publicado, op.dirTrabajo, `publicado-${op.shortCode ?? basename(op.publicado).replace(/\.[^.]+$/, '')}`);
				return compararTextos(tP, tR);
			});
			checks.push(checkTexto(texto));
		} catch (error) {
			checks.push(checkTexto(null, motivoDe(error)));
		}
	}

	let subtitulos: ResultadoAB['subtitulos'] = {disponible: false};
	if (op.ocr === false) {
		subtitulos = {disponible: false, motivo: 'se pidió sin OCR'};
		checks.push(...checksSubtitulos(null, null, 'se pidió sin OCR'));
	} else {
		const {modulo, motivo} = await cargarMedir();
		if (!modulo) {
			subtitulos = {disponible: false, motivo};
			checks.push(...checksSubtitulos(null, null, motivo));
		} else {
			try {
				const [r, p] = await cronometro('ocr', async () => {
					avisar('  A/B: midiendo los subtítulos con OCR (medir.ts)…');
					return [extraerResumen(await modulo.medirSubtitulos(op.render)), extraerResumen(await modulo.medirSubtitulos(op.publicado))] as const;
				});
				subtitulos = {disponible: true, render: r, publicado: p};
				checks.push(...checksSubtitulos(r, p));
			} catch (error) {
				const m = motivoDe(error);
				subtitulos = {disponible: false, motivo: m};
				checks.push(...checksSubtitulos(null, null, m));
			}
		}
	}

	let rutaLado: string | null = null;
	if (op.hacerLadoALado !== false) {
		try {
			rutaLado = await cronometro('lado_a_lado', async () => {
				avisar('  A/B: armando el video lado a lado…');
				return (await ladoALado({render: op.render, publicado: op.publicado, salida: op.salidaLadoALado, dirTrabajo: op.dirTrabajo, etiquetas: [`render v${op.version}`, `publicado ${op.shortCode ?? ''}`.trim()]})).ruta;
			});
		} catch (error) {
			notas.push(`No salió el video lado a lado: ${motivoDe(error)}`);
		}
	}
	checks.push(
		crearCheck({
			id: 'ab.veredicto',
			nombre: 'Tu veredicto en el lado a lado',
			nivel: 'estetico',
			pasa: null,
			valor: null,
			criterio: '"sí" en al menos 1 par',
			n: null,
			fuente: rutaLado ? basename(rutaLado) : 'sin video lado a lado',
			nota: 'pendiente: míralo y regístralo con qa.ts <slug> --version N --veredicto si|no',
		}),
	);

	const huellaDespues = statSync(op.publicado);
	if (huellaAntes.size !== huellaDespues.size || huellaAntes.mtimeMs !== huellaDespues.mtimeMs) {
		throw fallo('comparar contra el reel publicado', `el archivo publicado ${op.publicado} cambió durante el A/B`, 'avísame de inmediato: tus archivos son solo lectura', 1);
	}
	return {
		render: {ruta: op.render, duracion_s: Math.round(dR * 1000) / 1000},
		publicado: {ruta: op.publicado, shortCode: op.shortCode ?? null, duracion_s: Math.round(dP * 1000) / 1000},
		texto,
		subtitulos,
		lado_a_lado: rutaLado,
		checks,
		notas,
		tiempos_s: tiempos,
	};
}

/** Par aceptado de pruebas/pares.json para un crudo (ruta absoluta del original); null si no hay. */
export function parDelCrudo(crudo: string, rutaPares = join(RAIZ, 'pruebas', 'pares.json')): {shortCode: string; publicado_mp4: string} | null {
	if (!existsSync(rutaPares)) return null;
	try {
		const pares = JSON.parse(readFileSync(rutaPares, 'utf8')) as Array<{crudo?: string; shortCode?: string; publicado_mp4?: string | null; aceptado?: boolean}>;
		const par = pares.find((p) => p.aceptado === true && p.crudo === crudo && typeof p.publicado_mp4 === 'string' && typeof p.shortCode === 'string');
		return par ? {shortCode: par.shortCode as string, publicado_mp4: par.publicado_mp4 as string} : null;
	} catch {
		return null;
	}
}
