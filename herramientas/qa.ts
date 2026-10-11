/**
 * qa.ts — QA básica de un render (Fase 1).
 *
 *   npx tsx herramientas/qa.ts <slug> [--version N] [--borrador] [--tiempos 1.2,3.4]
 *       [--fuente-sincronia auto|original|base|final] [--sin-sincronia] [--sin-ab] [--publicado <mp4>]
 *   npx tsx herramientas/qa.ts <slug> --version N --veredicto si|no     (registra tu veredicto del lado a lado)
 *
 * 1. Verifica el MP4 (salida/final-vN.mp4; con --borrador, salida/borrador-vN.mp4): tamaño (1440×2560 o
 *    720×1280), 30/1, h264, AAC 48 kHz, cuadros = round(duracion_s × 30) y audio vs video ±1 cuadro.
 * 2. Stills con ffmpeg en el cuadro exacto (en tandas, select por tiempo tras buscar con -ss): en los tiempos de --tiempos o en el
 *    inicio y la mitad de cada subtítulo. Las hojas de contacto (con etiqueta por still) van a
 *    proyectos/<slug>/qa/vN/hoja-NN.jpg, y los stills a tamaño completo a proyectos/<slug>/qa/vN/stills/.
 * 3. Sincronía de los subtítulos contra la verdad de consenso (herramientas/lib/sincronia.ts). Con "auto" usa el
 *    audio del crudo (audio16k.wav + tramos y velocidad de la base del manifest) si existen, y si no el audio de la base.
 * 4. A/B contra el reel publicado (herramientas/lib/ab.ts) si el crudo tiene par aceptado en pruebas/pares.json
 *    o le pasas --publicado.
 * Escribe las secciones qa, sincronia y ab de reporte.md y la etapa qa-vN del manifest.
 * Sale con 1 si falla algo que impide subir (formato, cuadros, audio vs video); lo estético queda en el reporte.
 *
 * Corre fuera del sandbox (comando excluido): whisper-cli usa Metal. Lee tus archivos y nada más.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename, join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {EdicionValidada, type Edicion} from '../src/esquema/edicion.ts';
import {compararAB, parDelCrudo} from './lib/ab.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {sondear} from './lib/ffprobe.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, hashearArchivo, leerManifest, registrarEtapa, validarSlug} from './lib/manifest.ts';
import {esVelocidadValida} from './lib/remapear.ts';
import {actualizarReporte, contarChecks, crearCheck, fraseConteo, leerReporte, regenerarReporte, type Check} from './lib/reporte.ts';
import {extraerAudio16k, mapeoDesdeTramos, medirSincronia, MOTIVOS_EXCLUSION, SINCRONIA, type FuenteSincronia, type Mapeo, type MotivoExclusion, type ResultadoSincronia} from './lib/sincronia.ts';
import {elegirVersion, rutaEdicion, verificarVideo, type Esperado} from './render.ts';
import {rutaEnPublic} from './validar.ts';

export const FPS = 30;
const USO =
	'npx tsx herramientas/qa.ts <slug> [--version N] [--borrador] [--tiempos 1.2,3.4] [--fuente-sincronia auto|original|base|final] [--sin-sincronia] [--sin-ab] [--publicado <mp4>] [--veredicto si|no]';

/** Tamaño de cada miniatura de la hoja de contacto y cuántas van por hoja. */
export const HOJA = {ancho: 270, alto: 480, columnas: 6, filas: 4, etiqueta: 34, margen: 10, encabezado: 54} as const;

// La verificación del MP4 vive en render.ts (el render la usa antes de publicar el archivo).
export {verificarVideo, type DatosVerificacion, type Esperado} from './render.ts';

// ───────────────────────── stills ─────────────────────────

export type PedidoStill = {cuadro: number; etiqueta: string};

const aCuadro = (t: number) => Math.round(t * FPS);
const recortar = (c: number, total: number) => Math.min(Math.max(0, c), Math.max(0, total - 1));

/** Une pedidos del mismo cuadro (sus etiquetas se juntan) y los ordena. */
function unirPedidos(pedidos: PedidoStill[]): PedidoStill[] {
	const porCuadro = new Map<number, string[]>();
	for (const p of pedidos) porCuadro.set(p.cuadro, [...(porCuadro.get(p.cuadro) ?? []), p.etiqueta]);
	return [...porCuadro.entries()].sort((a, b) => a[0] - b[0]).map(([cuadro, etiquetas]) => ({cuadro, etiqueta: etiquetas.join(' + ')}));
}

/** Inicio (el primer cuadro en que se ve: round(desde × 30)) y mitad de cada subtítulo. */
export function stillsDeSubtitulos(subtitulos: Edicion['subtitulos'], totalCuadros: number): PedidoStill[] {
	return unirPedidos(
		subtitulos.flatMap((s) => [
			{cuadro: recortar(aCuadro(s.desde), totalCuadros), etiqueta: `${s.id} inicio`},
			{cuadro: recortar(aCuadro((s.desde + s.hasta) / 2), totalCuadros), etiqueta: `${s.id} mitad`},
		]),
	);
}

export function stillsDeTiempos(tiempos: number[], totalCuadros: number): PedidoStill[] {
	return unirPedidos(tiempos.map((t) => ({cuadro: recortar(aCuadro(t), totalCuadros), etiqueta: `t=${t} s`})));
}

export function parsearTiempos(texto: string): number[] {
	const tiempos = texto.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
	if (tiempos.length === 0 || tiempos.some((t) => !Number.isFinite(t) || t < 0)) {
		throw fallo('leer --tiempos', `"${texto}" no es una lista de segundos ≥ 0 separada por comas`, 'usa algo como --tiempos 1.2,3.4,10', 2);
	}
	return tiempos;
}

export type Still = PedidoStill & {t: number; ruta: string; mini: string};

/** Cuántos cuadros pide cada pasada de ffmpeg: el parser de expresiones de ffmpeg 8.1 acepta hasta 100 términos (con 101 falla, medido). */
export const STILLS_POR_PASADA = 40;

/**
 * Expresión de select para una tanda de cuadros, por tiempo relativo al punto de búsqueda `ss` (s): el cuadro k
 * es el que cae en ±medio cuadro de k/30 − ss. Con -ss antes de -i, ffmpeg descarta lo anterior a ss y corre los
 * tiempos para que ss sea 0, así que esto es exacto al cuadro sin depender del keyframe.
 */
export function expresionSelect(cuadros: number[], ss = 0): string {
	const t = (x: number) => Number(x.toFixed(6));
	return `select='${cuadros.map((c) => `between(t,${t((c - 0.5) / FPS - ss)},${t((c + 0.5) / FPS - ss)})`).join('+')}'`;
}

/**
 * Extrae los cuadros pedidos a tamaño completo (JPEG q2) y en miniatura para la hoja de contacto.
 * Va en tandas de STILLS_POR_PASADA: cada tanda busca justo antes de su primer cuadro y se detiene al sacar el último.
 */
export function extraerStills(video: string, pedidos: PedidoStill[], dir: string): Still[] {
	if (pedidos.length === 0) return [];
	const dirStills = join(dir, 'stills');
	const dirMinis = join(dir, '.minis');
	rmSync(dirStills, {recursive: true, force: true});
	rmSync(dirMinis, {recursive: true, force: true});
	mkdirSync(dirStills, {recursive: true});
	mkdirSync(dirMinis, {recursive: true});
	const orden = [...pedidos].sort((a, b) => a.cuadro - b.cuadro);
	const salida: Still[] = [];
	for (let inicio = 0; inicio < orden.length; inicio += STILLS_POR_PASADA) {
		const tanda = orden.slice(inicio, inicio + STILLS_POR_PASADA);
		const cuadros = tanda.map((p) => p.cuadro);
		const ss = Math.max(0, (cuadros[0] - 0.5) / FPS);
		const prefijo = `tmp-${String(inicio / STILLS_POR_PASADA).padStart(3, '0')}-`;
		const filtro = `[0:v]${expresionSelect(cuadros, ss)},split=2[completo][m];[m]scale=${HOJA.ancho}:${HOJA.alto}:flags=lanczos[mini]`;
		const r = spawnSync(
			'ffmpeg',
			[
				'-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', ss.toFixed(6), '-i', video, '-filter_complex', filtro,
				'-map', '[completo]', '-fps_mode', 'passthrough', '-frames:v', String(tanda.length), '-q:v', '2', join(dirStills, `${prefijo}%05d.jpg`),
				'-map', '[mini]', '-fps_mode', 'passthrough', '-frames:v', String(tanda.length), '-q:v', '3', join(dirMinis, `${prefijo}%05d.jpg`),
			],
			{encoding: 'utf8', maxBuffer: 64 * 1024 * 1024},
		);
		if (r.status !== 0) {
			throw fallo('sacar los stills de QA', `ffmpeg salió con código ${r.status ?? r.signal}`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {stderr: r.stderr?.slice(-3000)});
		}
		const salidos = readdirSync(dirStills).filter((n) => n.startsWith(prefijo)).sort();
		if (salidos.length !== tanda.length) {
			throw fallo('sacar los stills de QA', `salieron ${salidos.length} de ${tanda.length} cuadros pedidos en una tanda`, 'revisa que los tiempos caigan dentro del video', 1, {cuadros});
		}
		tanda.forEach((p, i) => {
			const nombre = `c${String(p.cuadro).padStart(6, '0')}.jpg`;
			const ruta = join(dirStills, nombre);
			const mini = join(dirMinis, nombre);
			renameSync(join(dirStills, salidos[i]), ruta);
			renameSync(join(dirMinis, salidos[i]), mini);
			salida.push({...p, t: p.cuadro / FPS, ruta, mini});
		});
	}
	return salida;
}

const escaparXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG de una hoja de contacto (pura): miniaturas en rejilla con su etiqueta debajo. */
export function svgHoja(stills: Array<{etiqueta: string; t: number; cuadro: number; jpegBase64: string}>, titulo: string): string {
	const {ancho, alto, columnas, etiqueta, margen, encabezado} = HOJA;
	const filas = Math.max(1, Math.ceil(stills.length / columnas));
	const W = columnas * (ancho + margen) + margen;
	const H = encabezado + filas * (alto + etiqueta + margen) + margen;
	const celdas = stills.map((s, i) => {
		const x = margen + (i % columnas) * (ancho + margen);
		const y = encabezado + margen + Math.floor(i / columnas) * (alto + etiqueta + margen);
		const texto = `${s.etiqueta} · ${s.t.toFixed(2)} s · c${s.cuadro}`;
		return (
			`<image x="${x}" y="${y}" width="${ancho}" height="${alto}" xlink:href="data:image/jpeg;base64,${s.jpegBase64}"/>` +
			`<text x="${x + ancho / 2}" y="${y + alto + 24}" font-size="17" text-anchor="middle" fill="#f2f2f2">${escaparXml(texto)}</text>`
		);
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">` +
		`<rect width="${W}" height="${H}" fill="#161616"/>` +
		`<text x="${margen}" y="36" font-size="24" fill="#ffffff">${escaparXml(titulo)}</text>` +
		celdas.join('') +
		'</svg>'
	);
}

/** Hojas de contacto (24 stills por hoja) → dir/hoja-NN.jpg. Usa resvg para el SVG y ffmpeg para pasar a JPEG. */
export async function hojasDeContacto(stills: Still[], dir: string, titulo: string): Promise<string[]> {
	const {Resvg} = await import('@resvg/resvg-js');
	const porHoja = HOJA.columnas * HOJA.filas;
	for (const viejo of readdirSync(dir).filter((n) => /^hoja-\d+\.(jpg|png)$/.test(n))) rmSync(join(dir, viejo));
	const total = Math.ceil(stills.length / porHoja);
	const rutas: string[] = [];
	for (let k = 0; k < total; k++) {
		const grupo = stills.slice(k * porHoja, (k + 1) * porHoja).map((s) => ({...s, jpegBase64: readFileSync(s.mini).toString('base64')}));
		const svg = svgHoja(grupo, `${titulo} · hoja ${k + 1} de ${total}`);
		const png = new Resvg(svg, {font: {loadSystemFonts: true, defaultFontFamily: 'Helvetica'}}).render().asPng();
		const nombre = `hoja-${String(k + 1).padStart(2, '0')}`;
		const rutaPng = join(dir, `${nombre}.png`);
		const rutaJpg = join(dir, `${nombre}.jpg`);
		writeFileSync(rutaPng, png);
		const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', rutaPng, '-q:v', '3', rutaJpg], {encoding: 'utf8'});
		if (r.status === 0) {
			rmSync(rutaPng);
			rutas.push(rutaJpg);
		} else {
			rutas.push(rutaPng); // si no se pudo pasar a JPEG, se queda el PNG
		}
	}
	return rutas;
}

// ───────────────────────── sincronía ─────────────────────────

export type PreparacionSincronia = {fuente: FuenteSincronia; audio16k: string; mapeo?: Mapeo; nota?: string};

type TramosManifest = Array<[number, number]>;

function tramosDeLaBase(slug: string, proyectos: string): TramosManifest | null {
	const t = leerManifest(slug, proyectos)?.etapas.base?.parametros?.tramos_cuadros;
	if (!Array.isArray(t) || t.length === 0) return null;
	if (!t.every((x) => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n)))) return null;
	return t as TramosManifest;
}

/** Velocidad con que base.ts aceleró la base (manifest → etapas.base.parametros.velocidad; sin el dato, ×1). */
export function velocidadDeLaBase(slug: string, proyectos: string): number {
	const v = leerManifest(slug, proyectos)?.etapas.base?.parametros?.velocidad;
	if (v === undefined) return 1;
	if (!esVelocidadValida(v)) {
		throw fallo('medir la sincronía en el audio del crudo', `el manifest dice que la base va a ×${String(v)}, que no es una velocidad válida`, `vuelve a generar la base con npx tsx herramientas/base.ts ${slug} --cortes proyectos/${slug}/cortes.json`, 2);
	}
	return v;
}

/** Elige y prepara el audio de la sincronía (ver el encabezado de lib/sincronia.ts). */
export function prepararSincronia(opciones: {
	slug: string;
	edicion: Edicion;
	pedida: FuenteSincronia | 'auto';
	video: string;
	dirQa: string;
	proyectos: string;
}): PreparacionSincronia {
	const {slug, edicion, pedida, video, dirQa, proyectos} = opciones;
	const dir = dirProyecto(slug, proyectos);
	const audioCrudo = join(dir, 'audio16k.wav');
	const tramos = tramosDeLaBase(slug, proyectos);
	const baseEsDelProyecto = edicion.base === `p/${slug}/base.mp4`;
	const originalPosible = tramos !== null && existsSync(audioCrudo) && baseEsDelProyecto;

	if (pedida === 'original' || (pedida === 'auto' && originalPosible)) {
		if (!originalPosible) {
			throw fallo('medir la sincronía en el audio del crudo', `al proyecto le falta ${!existsSync(audioCrudo) ? 'audio16k.wav' : tramos === null ? 'la etapa base con sus tramos en el manifest' : `una base propia (la EDL usa ${edicion.base})`}`, 'usa --fuente-sincronia base o corre antes la ingesta y base.ts', 2);
		}
		const velocidad = velocidadDeLaBase(slug, proyectos);
		return {
			fuente: 'original',
			audio16k: audioCrudo,
			mapeo: mapeoDesdeTramos(tramos as TramosManifest, velocidad),
			...(velocidad !== 1 ? {nota: `la base va a ×${velocidad}: los arranques del crudo se pasan a la base con sus tramos y divididos entre ${velocidad}`} : {}),
		};
	}
	const fuente: FuenteSincronia = pedida === 'final' ? 'final' : 'base';
	const origen = fuente === 'final' ? video : rutaEnPublic(edicion.base);
	if (!existsSync(origen)) throw fallo('medir la sincronía', `no existe ${origen}`, 'revisa la base de la EDL o corre el render primero', 2);
	mkdirSync(dirQa, {recursive: true});
	const wav = join(dirQa, `sincronia-${fuente}-16k.wav`);
	extraerAudio16k(origen, wav);
	return {fuente, audio16k: wav};
}

/** Sección "sincronia" del reporte. Pura. */
export function seccionSincronia(r: ResultadoSincronia, diagnostico: ResultadoSincronia | null, rel: (p: string) => string) {
	const fmt = (x: number | null) => (x === null ? 'N/A' : `${x} ms`);
	const nombreFuente = {original: 'audio del crudo (audio16k.wav) pasado a la base con sus tramos', base: 'audio de la base', final: 'audio del MP4 final'}[r.fuente];
	const check = crearCheck({
		id: 'sincronia.consenso',
		nombre: 'Sincronía de subtítulos (verdad de consenso)',
		nivel: 'estetico',
		pasa: r.pasa,
		valor: r.N === 0 ? null : `p50 ${fmt(r.p50_ms)} · p95 ${fmt(r.p95_ms)}`,
		criterio: `p50 ≤ ${SINCRONIA.criterio.p50_ms} ms y p95 ≤ ${SINCRONIA.criterio.p95_ms} ms (N ≥ ${SINCRONIA.nMinimo})`,
		n: r.N,
		fuente: `${nombreFuente}; ${r.verdad}`,
		...(r.nota ? {nota: r.nota} : {}),
	});
	const exc = (Object.entries(r.excluidos) as Array<[MotivoExclusion, number]>)
		.filter(([, n]) => n > 0)
		.map(([k, n]) => `${n}: ${MOTIVOS_EXCLUSION[k]}`)
		.join(' · ');
	const detalle = [
		`Fuente: ${nombreFuente} (${rel(r.audio)}, ${r.duracion_s} s). Pausas ≥ ${SINCRONIA.silencedetect.duracionMinS} s: ${r.pausas}; arranques: ${r.arranques}; con consenso: ${r.consenso}; emparejados (N): ${r.N}.`,
		`Error = desde del subtítulo − arranque. p50 |error| ${fmt(r.p50_ms)}, p95 ${fmt(r.p95_ms)}, mediana con signo ${fmt(r.mediana_error_ms)}, dentro de ${r.ventana_ms[0]}…+${r.ventana_ms[1]} ms: ${r.dentro_pct === null ? 'N/A' : `${r.dentro_pct} %`}.`,
		`Excluidos: ${exc || 'ninguno'}.`,
	];
	if (r.peores.length > 0) {
		detalle.push(`Peores: ${r.peores.map((p) => `${p.subtitulo} "${p.palabra}" ${p.error_ms} ms (arranque ${p.arranque_s} s)`).join(' · ')}.`);
	}
	if (diagnostico) {
		detalle.push(
			`Diagnóstico (no cuenta): con el audio de la ${diagnostico.fuente} salen N = ${diagnostico.N}, p50 ${fmt(diagnostico.p50_ms)}, p95 ${fmt(diagnostico.p95_ms)} (${diagnostico.pausas} pausas ≥ ${SINCRONIA.silencedetect.duracionMinS} s, ${diagnostico.consenso} con consenso).`,
		);
	}
	detalle.push('La re-transcripción solo alerta; la aprobación final de la sincronía es tu veredicto en el lado a lado.');
	return {
		titulo: 'Sincronía de subtítulos',
		checks: [check],
		detalle,
		datos: {
			fuente: r.fuente,
			N: r.N,
			p50_ms: r.p50_ms,
			p95_ms: r.p95_ms,
			mediana_error_ms: r.mediana_error_ms,
			dentro_pct: r.dentro_pct,
			pausas: r.pausas,
			arranques: r.arranques,
			consenso: r.consenso,
			excluidos: r.excluidos,
			pares: r.pares,
			diagnostico: diagnostico ? {fuente: diagnostico.fuente, N: diagnostico.N, p50_ms: diagnostico.p50_ms, p95_ms: diagnostico.p95_ms} : null,
		},
	};
}

// ───────────────────────── principal ─────────────────────────

export type OpcionesQa = {
	slug: string;
	version?: number;
	borrador?: boolean;
	tiempos?: number[];
	sincronia?: FuenteSincronia | 'auto' | false;
	ab?: boolean;
	publicado?: string;
	proyectos?: string;
	avisar?: (m: string) => void;
};

export type ResultadoQa = {version: number; video: string; checks: Check[]; hojas: string[]; stills: number; bloqueantesFallan: number; tiempos_s: Record<string, number>; resumen: string};

export async function correrQa(op: OpcionesQa): Promise<ResultadoQa> {
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const avisar = op.avisar ?? ((m: string) => console.error(m));
	const slug = validarSlug(op.slug);
	const dir = dirProyecto(slug, proyectos);
	if (!existsSync(dir)) throw fallo(`revisar ${slug}`, `no existe proyectos/${slug}`, 'revisa el slug (la carpeta de proyectos/)', 2);
	const version = elegirVersion(dir, op.version);
	const rel = (p: string) => relative(RAIZ, p);

	const rutaEdl = rutaEdicion(dir, version);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(rutaEdl, 'utf8'));
	} catch (error) {
		throw fallo(`revisar ${slug} v${version}`, `${basename(rutaEdl)} no es JSON válido`, 'corrígelo y valídalo con validar.ts', 2, error);
	}
	const parseada = EdicionValidada.safeParse(datos);
	if (!parseada.success) throw fallo(`revisar ${slug} v${version}`, `${basename(rutaEdl)} no pasa el esquema`, `corre npx tsx herramientas/validar.ts ${rel(rutaEdl)}`, 2, parseada.error.issues);
	const edicion = parseada.data;

	const nombreVideo = op.borrador ? `borrador-v${version}.mp4` : `final-v${version}.mp4`;
	const video = join(dir, 'salida', nombreVideo);
	if (!existsSync(video)) {
		throw fallo(`revisar ${slug} v${version}`, `no existe salida/${nombreVideo}`, `corre primero npx tsx herramientas/render.ts ${slug} --version ${version}${op.borrador ? ' --borrador' : ''}`, 2);
	}
	const dirQa = join(dir, 'qa', `v${version}`);
	mkdirSync(dirQa, {recursive: true});
	const tiempos: Record<string, number> = {};
	const medir = async <T>(etapa: string, fn: () => Promise<T> | T): Promise<T> => {
		const t0 = performance.now();
		try {
			return await fn();
		} finally {
			tiempos[etapa] = Math.round((performance.now() - t0) / 10) / 100;
		}
	};

	// 1. Verificación
	const cuadrosEsperados = Math.max(1, Math.round(edicion.duracion_s * FPS));
	const esperado: Esperado = op.borrador ? {ancho: 720, alto: 1280, cuadros: cuadrosEsperados} : {ancho: 1440, alto: 2560, cuadros: cuadrosEsperados};
	const verificacion = await medir('verificacion', async () => verificarVideo(await sondear(video), esperado, `ffprobe de salida/${nombreVideo}`));

	// 2. Stills + hojas de contacto
	const pedidos = op.tiempos?.length ? stillsDeTiempos(op.tiempos, cuadrosEsperados) : stillsDeSubtitulos(edicion.subtitulos, cuadrosEsperados);
	const {stills, hojas} = await medir('stills', async () => {
		const s = extraerStills(video, pedidos, dirQa);
		const h = s.length ? await hojasDeContacto(s, dirQa, `${slug} · v${version}${op.borrador ? ' · borrador' : ''}`) : [];
		rmSync(join(dirQa, '.minis'), {recursive: true, force: true});
		return {stills: s, hojas: h};
	});
	const detalleQa = [
		`Video: salida/${nombreVideo} (${verificacion.datos.ancho}×${verificacion.datos.alto}, ${verificacion.datos.cuadros ?? '?'} cuadros).`,
		stills.length
			? `Stills: ${stills.length} (${op.tiempos?.length ? 'tiempos pedidos' : 'inicio y mitad de cada subtítulo'}) en ${rel(join(dirQa, 'stills'))}; hojas de contacto: ${hojas.map(rel).join(', ')}.`
			: 'Stills: ninguno (la EDL no trae subtítulos y no pasaste --tiempos).',
	];
	actualizarReporte(slug, version, op.borrador ? 'qa-borrador' : 'qa', {titulo: op.borrador ? 'QA del borrador' : 'QA del MP4 final', checks: verificacion.checks, tiempos_s: {verificacion: tiempos.verificacion, stills: tiempos.stills}, detalle: detalleQa, datos: {verificacion: verificacion.datos, stills: stills.map((s) => ({cuadro: s.cuadro, etiqueta: s.etiqueta, ruta: rel(s.ruta)})), hojas: hojas.map(rel)}}, proyectos);

	// 3. Sincronía
	if (op.sincronia !== false && edicion.subtitulos.length > 0) {
		await medir('sincronia', () => {
			const prep = prepararSincronia({slug, edicion, pedida: op.sincronia || 'auto', video, dirQa, proyectos});
			avisar(`  sincronía: midiendo sobre el audio ${prep.fuente === 'original' ? 'del crudo' : prep.fuente === 'base' ? 'de la base' : 'del final'}…`);
			const r = medirSincronia({audio16k: prep.audio16k, subtitulos: edicion.subtitulos, fuente: prep.fuente, mapeo: prep.mapeo});
			let diagnostico: ResultadoSincronia | null = null;
			if (prep.fuente === 'original' && (op.sincronia ?? 'auto') === 'auto') {
				try {
					const base = prepararSincronia({slug, edicion, pedida: 'base', video, dirQa, proyectos});
					diagnostico = medirSincronia({audio16k: base.audio16k, subtitulos: edicion.subtitulos, fuente: 'base'});
				} catch {
					diagnostico = null;
				}
			}
			const seccion = seccionSincronia(r, diagnostico, rel);
			if (prep.nota) seccion.detalle.splice(1, 0, `Velocidad: ${prep.nota}.`);
			actualizarReporte(slug, version, 'sincronia', prep.fuente === 'original' ? {...seccion, datos: {...seccion.datos, velocidad: velocidadDeLaBase(slug, proyectos)}} : seccion, proyectos);
		});
	}

	// 4. A/B
	if (op.ab !== false && !op.borrador) {
		await medir('ab', async () => {
			const crudo = leerManifest(slug, proyectos)?.original?.ruta ?? null;
			const par = op.publicado ? {shortCode: basename(op.publicado).replace(/\.[^.]+$/, ''), publicado_mp4: op.publicado} : crudo ? parDelCrudo(crudo) : null;
			if (!par) {
				actualizarReporte(slug, version, 'ab', {
					titulo: 'A/B contra el reel publicado',
					checks: [crearCheck({id: 'ab.par', nombre: 'Reel publicado para comparar', nivel: 'estetico', pasa: null, valor: null, criterio: 'par aceptado en pruebas/pares.json o --publicado', n: null, fuente: 'pruebas/pares.json', nota: 'este proyecto no tiene reel publicado con qué comparar'})],
					detalle: ['Sin A/B: el crudo de este proyecto no tiene par aceptado en pruebas/pares.json (pásale --publicado <mp4> si existe).'],
				}, proyectos);
				return;
			}
			const r = await compararAB({
				render: video,
				publicado: par.publicado_mp4,
				shortCode: par.shortCode,
				version,
				salidaLadoALado: join(dir, 'salida', `ab-v${version}.mp4`),
				dirTrabajo: join(dir, 'qa', 'ab'),
				avisar,
			});
			const t = r.texto;
			const detalle = [
				`Publicado: ${par.shortCode} (${r.publicado.duracion_s} s) · render: ${r.render.duracion_s} s.`,
				t ? `Texto: 1 − WER ${t.similitud === null ? 'N/A' : t.similitud.toFixed(3)} (WER ${t.wer ?? 'N/A'}; ${t.palabras_render} palabras del render, ${t.palabras_publicado} del publicado).` : 'Texto: N/A.',
				r.subtitulos.disponible ? 'Subtítulos: medidos con OCR (herramientas/estilo/medir.ts).' : `Subtítulos: N/A (${r.subtitulos.motivo ?? 'sin OCR'}).`,
				r.lado_a_lado ? `Lado a lado: ${rel(r.lado_a_lado)} (izquierda: render con su audio; derecha: publicado).` : 'Lado a lado: no salió.',
				...r.notas,
			];
			actualizarReporte(slug, version, 'ab', {titulo: `A/B contra el reel publicado (${par.shortCode})`, checks: r.checks, tiempos_s: r.tiempos_s, detalle, datos: {publicado: r.publicado, render: r.render, texto: r.texto, subtitulos: r.subtitulos, lado_a_lado: r.lado_a_lado ? rel(r.lado_a_lado) : null}}, proyectos);
		});
	}

	// Manifest y resumen
	registrarEtapa(
		slug,
		`qa-v${version}${op.borrador ? '-borrador' : ''}`,
		{
			estado: 'terminada',
			entradas: [await hashearArchivo(video), await hashearArchivo(rutaEdl)],
			parametros: {version: 1, borrador: Boolean(op.borrador), tiempos: op.tiempos ?? null, sincronia: op.sincronia === false ? false : (op.sincronia ?? 'auto'), ab: op.ab !== false},
			salidas: await Promise.all(hojas.map((h) => hashearArchivo(h, dir))),
			extra: {tiempos_s: tiempos, stills: stills.length},
		},
		proyectos,
	);
	regenerarReporte(slug, proyectos); // para que la tabla de tiempos del manifest incluya esta QA
	const reporte = leerReporte(slug, proyectos);
	const v = reporte.versiones[String(version)];
	const checks = v ? Object.values(v.secciones).flatMap((s) => s.checks) : [];
	const conteo = contarChecks(checks);
	const bloqueantesFallan = verificacion.checks.filter((c) => c.estado === 'FALLA').length;
	return {
		version,
		video,
		checks,
		hojas,
		stills: stills.length,
		bloqueantesFallan,
		tiempos_s: tiempos,
		resumen: `QA de ${slug} v${version}: ${fraseConteo(conteo)} → ${rel(join(dir, 'reporte.md'))}`,
	};
}

/** Registra tu veredicto ("sí"/"no") del lado a lado en la sección A/B de esa versión. */
export function registrarVeredicto(slug: string, version: number, veredicto: 'si' | 'no', proyectos = DIR_PROYECTOS): string {
	const reporte = leerReporte(slug, proyectos);
	const seccion = reporte.versiones[String(version)]?.secciones.ab;
	const check = seccion?.checks.find((c) => c.id === 'ab.veredicto');
	if (!seccion || !check) {
		throw fallo(`registrar tu veredicto de v${version}`, 'esa versión todavía no tiene A/B con video lado a lado', `corre primero npx tsx herramientas/qa.ts ${slug} --version ${version}`, 2);
	}
	const checks = seccion.checks.map((c) =>
		c.id === 'ab.veredicto' ? {...c, estado: veredicto === 'si' ? ('PASA' as const) : ('FALLA' as const), valor: veredicto === 'si' ? 'sí' : 'no', fuente: `el creador, ${new Date().toISOString().slice(0, 10)} (${c.fuente})`, nota: undefined} : c,
	);
	return fraseConteo(actualizarReporte(slug, version, 'ab', {...seccion, generado_en: undefined, checks}, proyectos).conteo);
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {
			version: {type: 'string'},
			borrador: {type: 'boolean', default: false},
			tiempos: {type: 'string'},
			'fuente-sincronia': {type: 'string', default: 'auto'},
			'sin-sincronia': {type: 'boolean', default: false},
			'sin-ab': {type: 'boolean', default: false},
			publicado: {type: 'string'},
			veredicto: {type: 'string'},
		},
	});
	const slug = positionals[0];
	if (!slug) throw fallo('correr la QA', 'falta el slug del proyecto', `usa ${USO}`, 2);
	const version = values.version === undefined ? undefined : Number(values.version);
	if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw fallo('correr la QA', `--version tiene que ser un entero ≥ 1 (me llegó "${values.version}")`, `usa ${USO}`, 2);
	const fuente = values['fuente-sincronia'];
	if (!['auto', 'original', 'base', 'final'].includes(fuente as string)) throw fallo('correr la QA', `--fuente-sincronia "${fuente}" no existe`, 'usa auto, original, base o final', 2);

	if (values.veredicto !== undefined) {
		const v = values.veredicto.toLowerCase().replace('í', 'i');
		if (v !== 'si' && v !== 'no') throw fallo('registrar tu veredicto', `"${values.veredicto}" no es sí ni no`, 'usa --veredicto si o --veredicto no', 2);
		if (version === undefined) throw fallo('registrar tu veredicto', 'falta --version', 'di de qué versión es: --version N', 2);
		console.log(`Veredicto registrado en v${version}: ${registrarVeredicto(validarSlug(slug), version, v)}`);
		return;
	}
	const r = await correrQa({
		slug,
		version,
		borrador: values.borrador,
		tiempos: values.tiempos ? parsearTiempos(values.tiempos) : undefined,
		sincronia: values['sin-sincronia'] ? false : (fuente as FuenteSincronia | 'auto'),
		ab: !values['sin-ab'],
		publicado: values.publicado,
	});
	console.log(r.resumen);
	if (r.hojas.length) console.log(`Hojas de contacto: ${r.hojas.map((h) => relative(RAIZ, h)).join(', ')}`);
	console.log(`Tiempos: ${Object.entries(r.tiempos_s).map(([k, s]) => `${k} ${s.toFixed(1)} s`).join(' · ')}`);
	if (r.bloqueantesFallan > 0) {
		throw fallo(`aprobar la QA de ${slug} v${r.version}`, `${r.bloqueantesFallan} check(s) que impiden subir no pasan`, 'revisa la sección "Lo que impide subir" de reporte.md y vuelve a renderizar', 1);
	}
}

if (esPrincipal(import.meta.url)) void correr(main);
