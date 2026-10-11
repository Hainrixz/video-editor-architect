/**
 * Base (etapa 5 de /editar): el video vertical limpio sobre el que se monta todo lo demás.
 *
 *   npx tsx herramientas/base.ts <slug> [--cortes proyectos/<slug>/cortes.json] [--desde s --hasta s]
 *                                [--encuadre proyectos/<slug>/encuadre.json | --sin-encuadre] [--velocidad F] [--forzar]
 *
 * Genera proyectos/<slug>/base.mp4 en UNA pasada desde el original que registró la ingesta (nunca una copia):
 * - Tramos que se quedan: los `keep` de cortes.json ({"keep": [{"desde": s, "hasta": s}, …]}, en segundos del
 *   original) o el clip entero si no hay cortes; recortados a --desde/--hasta (solo para pruebas) y cuantizados
 *   a cuadro de 30 fps.
 * - Velocidad F (como tú: aceleras tus reels ×1.05–×1.15, mediana ×1.096 en tus 4 pares). La decide cortes.ts y la
 *   escribe en cortes.json ("velocidad"), porque los tiempos de transcripcion-base.json ya salen divididos entre F:
 *   la base usa ESA. Si le pides otra con --velocidad, sale con 2 (la base y los subtítulos se desfasarían): vuelve
 *   a correr cortes.ts con esa --velocidad. Un cortes.json de antes de la velocidad (sin "velocidad") va a ×1. Sin
 *   cortes.json (el clip entero, para pruebas) va a ×1 salvo que pidas --velocidad F. F va de 0.5 a 2 (un solo
 *   atempo). Con F = 1 el filtro es idéntico al de siempre.
 *   Audio: después del concat, UN solo atempo=F (WSOLA: cambia el ritmo, no el tono; medido con tu voz, cada arranque
 *   queda a +4 ms de t/F en la mediana) y ajustado a las muestras exactas de los cuadros (apad + atrim: atempo
 *   entrega unas muestras de más o de menos). Video: setpts=PTS/F + fps=30 en cada tramo, con los cuadros exactos que le tocan
 *   en la base: el tramo k empieza en el cuadro round(Σ anteriores / F × 30), la misma cuenta de subtitulos.ts (con
 *   un setpts global después del concat, cuando Σ/F cae justo en medio cuadro ffmpeg puede poner el corte un cuadro
 *   antes: medido con F = 1.2, y un subtítulo cruzaría el corte). Duración = Σkeep / F; cuadros = round(duración ×
 *   30); audio = video. F va en los parámetros de la etapa (solo si F ≠ 1, así las bases de siempre siguen
 *   vigentes): si cambia, la base se rehace. tramos_cuadros sigue en cuadros del crudo; dónde cae cada tramo en la
 *   base acelerada queda en la etapa (tramos_base_s) y se calcula con lib/remapear.ts (duracionBase(keep, F)).
 * - Encuadre (opcional): el recorte de encuadre.json (lo calcula herramientas/encuadre.ts) se aplica al ORIGINAL de
 *   4K en esta misma pasada, después de la autorrotación y ANTES de escalar a 1440×2560: así acercar no pierde
 *   nitidez (2160 px de ancho → 1440 aguantan hasta ×1.5 sin agrandar pixeles). Si existe
 *   proyectos/<slug>/encuadre.json se usa solo; --sin-encuadre lo ignora. Un recorte del cuadro completo es lo mismo
 *   que no tener encuadre (no cambia los parámetros: la base sigue vigente). El recorte va en los parámetros de la
 *   etapa: si cambia, la base deja de estar vigente. Después de un encuadre nuevo hay que volver a medir la cara
 *   (herramientas/cara.ts <slug>).
 * - Video: autorrotación de ffmpeg (la de por defecto) → [crop del encuadre] → fps=30 → trim por tramo → setpts →
 *   [setpts=PTS/F → fps=30 → cuadros exactos del tramo] → concat → scale+crop a 1440×2560.
 * - Audio: 48 kHz → atrim por tramo → asetpts → afade de 15 ms de entrada y de salida DENTRO de cada tramo
 *   (sin solape entre tramos) → concat → [atempo=F → muestras exactas].
 * - libx264 -crf 15 -preset medium -g 15 -pix_fmt yuv420p; AAC 48 kHz 256k estéreo; +faststart.
 * - Al final verifica con ffprobe: 1440×2560, 30/1, sin rotación y |audio − video| ≤ 1 cuadro. Si no, código 1.
 *
 * Por qué fps=30 va antes del trim: así cada tramo empieza y termina en un cuadro exacto de la salida
 * (start_pts/end_pts enteros en base 1/30) y el audio se corta en la muestra exacta (1 cuadro = 1600 muestras a
 * 48 kHz). Cada tramo dura lo mismo en audio y en video, y la base dura exactamente la suma de sus tramos.
 */
import {existsSync, readFileSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {basename, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {esIdentidad, filtroRecorte, leerEncuadre, problemasRecorte, type Recorte} from './lib/encuadre.ts';
import {correr, fallo} from './lib/fallo.ts';
import {correrFfmpeg, revisarApto, sondear, type Sondeo} from './lib/ffprobe.ts';
import {duracionBase, esVelocidadValida, VELOCIDAD_MAX, VELOCIDAD_MIN} from './lib/remapear.ts';
import {
	DIR_PROYECTOS,
	RAIZ,
	dirProyecto,
	etapaVigente,
	hashearArchivo,
	leerManifest,
	registrarEtapa,
	rutaSalidaSegura,
	validarSlug,
	type ArchivoHash,
} from './lib/manifest.ts';

export const FPS = 30;
export const ANCHO = 1440;
export const ALTO = 2560;
export const MUESTREO = 48000;
export const MUESTRAS_POR_CUADRO = MUESTREO / FPS; // 1600
export const FADE_MS = 15;
export const MUESTRAS_FADE = Math.round((MUESTREO * FADE_MS) / 1000); // 720
export const CODIFICACION = {
	video: {codec: 'libx264', crf: 15, preset: 'medium', g: 15, pix_fmt: 'yuv420p'},
	audio: {codec: 'aac', bitrate: '256k', muestreo: MUESTREO, canales: 2},
} as const;
export const NOMBRE_BASE = 'base.mp4';
/** Base en 4K (--4k): el mismo corte que base.mp4 a 2160×3840 (×1.5 del lienzo) para exportar el final en 4K. */
export const NOMBRE_BASE_4K = 'base-4k.mp4';
export const LIENZO_4K: readonly [number, number] = [2160, 3840];
export const NOMBRE_ENCUADRE = 'encuadre.json';

const USO =
	'npx tsx herramientas/base.ts <slug> [--cortes proyectos/<slug>/cortes.json] [--desde s --hasta s] [--encuadre proyectos/<slug>/encuadre.json | --sin-encuadre] [--velocidad F] [--forzar] [--4k]';

/** Tramo en segundos del original. */
export type TramoSegundos = {desde: number; hasta: number};
/** Tramo en cuadros de 30 fps del original: [inicio, fin). */
export type TramoCuadros = {inicio: number; fin: number};

/** Contrato de cortes.json que lee esta etapa (lo escribe la etapa de cortes). Se permiten campos extra. */
export const CortesEsquema = z.looseObject({
	keep: z
		.array(z.looseObject({desde: z.number().nonnegative(), hasta: z.number().positive()}))
		.min(1),
	/** Velocidad F con que cortes.ts ya dividió los tiempos de transcripcion-base.json (sin el campo: ×1). */
	velocidad: z.unknown().optional(),
});

/** Lo que base.ts usa de cortes.json: los tramos y la velocidad (null si el archivo es de antes de la velocidad). */
export type CortesLeidos = {keep: TramoSegundos[]; velocidad: number | null};

export function leerCortes(ruta: string): TramoSegundos[] {
	return leerCortesConVelocidad(ruta).keep;
}

export function leerCortesConVelocidad(ruta: string): CortesLeidos {
	const nombre = basename(ruta);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw fallo('leer los cortes', `no existe ${ruta}`, 'genera cortes.json con la etapa de cortes o quita --cortes', 2);
		}
		throw fallo('leer los cortes', `${nombre} no es JSON válido`, `revisa ${ruta}`, 2, error);
	}
	const r = CortesEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(
			'leer los cortes',
			`${nombre} no trae "keep": [{"desde", "hasta"}] en segundos (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`,
			`revisa ${ruta}`,
			2,
			r.error.issues,
		);
	}
	const velocidad = r.data.velocidad;
	if (velocidad !== undefined && !esVelocidadValida(velocidad)) {
		throw fallo(
			'leer los cortes',
			`${nombre} trae "velocidad": ${JSON.stringify(velocidad)}, que no es un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX}`,
			'vuelve a correr npx tsx herramientas/cortes.ts <slug> (con --velocidad F si quieres otra)',
			2,
		);
	}
	return {keep: r.data.keep.map(({desde, hasta}) => ({desde, hasta})), velocidad: velocidad ?? null};
}

/** Velocidad que usa la base y de dónde salió. */
export type VelocidadBase = {factor: number; origen: string};

/**
 * Velocidad de la base (pura):
 * - con cortes.json: la que trae (×1 si es de antes de la velocidad). Si pides otra con --velocidad, código 2: los
 *   tiempos de transcripcion-base.json (y con ellos los subtítulos) ya están divididos entre la de cortes.json.
 * - sin cortes.json (el clip entero): --velocidad o ×1.
 */
export function resolverVelocidad(pedida: number | undefined, cortes: {ruta: string; velocidad: number | null} | null, slug = '<slug>'): VelocidadBase {
	if (pedida !== undefined && !esVelocidadValida(pedida)) {
		throw fallo('leer los argumentos', `--velocidad tiene que ser un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX} (me llegó ${String(pedida)})`, `usa ${USO}`, 2);
	}
	if (cortes) {
		const deCortes = cortes.velocidad ?? 1;
		if (pedida !== undefined && Math.abs(pedida - deCortes) > 1e-9) {
			const nombre = relative(RAIZ, cortes.ruta).startsWith('..') ? cortes.ruta : relative(RAIZ, cortes.ruta);
			throw fallo(
				`generar la base de ${slug} a ×${pedida}`,
				`${nombre} se armó para ×${deCortes}${cortes.velocidad === null ? ' (es de antes de la velocidad)' : ''} y los tiempos de transcripcion-base.json y de los subtítulos ya están en esa velocidad`,
				`corre primero npx tsx herramientas/cortes.ts ${slug} (con --aplicar-texto si aprobaste el texto) --velocidad ${pedida} y luego base.ts sin --velocidad`,
				2,
			);
		}
		return {factor: deCortes, origen: cortes.velocidad === null ? 'cortes.json de antes de la velocidad (×1)' : 'cortes.json'};
	}
	return pedida !== undefined ? {factor: pedida, origen: '--velocidad'} : {factor: 1, origen: 'sin cortes.json: el clip tal cual (×1)'};
}

/**
 * Cuadro de la base acelerada en que empieza cada tramo, y al final el total: [0, m1, …, M]. Es la MISMA cuenta que
 * hace subtitulos.ts para los bordes de sus tramos (Math.round(duracionBase(keep[0..k), F) × 30), con lib/remapear.ts),
 * así el primer cuadro de cada tramo cae justo donde los subtítulos esperan el corte, con cualquier F (también cuando
 * Σ/F cae justo en medio cuadro, donde un fps global de ffmpeg puede irse al cuadro de al lado: medido con F = 1.2).
 */
export function cuadrosDeCortes(tramos: TramoCuadros[], velocidad = 1): number[] {
	const keep = tramos.map((t) => ({desde: t.inicio / FPS, hasta: t.fin / FPS}));
	return [0, ...tramos.map((_, k) => (velocidad === 1 ? totalCuadros(tramos.slice(0, k + 1)) : Math.round(duracionBase(keep.slice(0, k + 1), velocidad) * FPS)))];
}

/** Cuadros de la base: round(Σkeep / F × 30). Con F = 1, la suma de los tramos (exacta). */
export function cuadrosDeLaBase(tramos: TramoCuadros[], velocidad = 1): number {
	return velocidad === 1 ? totalCuadros(tramos) : cuadrosDeCortes(tramos, velocidad).at(-1)!;
}

/**
 * Dónde cae cada tramo en la base ya acelerada (s): [Σ anteriores / F, Σ hasta este / F]. Es lo mismo que calcula
 * lib/remapear.ts (duracionBase(keep, F)), que usan cortes.ts, subtitulos.ts y la sincronía.
 */
export function tramosEnLaBase(tramos: TramoCuadros[], velocidad = 1): Array<[number, number]> {
	const keep = tramos.map((t) => ({desde: t.inicio / FPS, hasta: t.fin / FPS}));
	const redondo = (x: number) => Math.round(x * 1e6) / 1e6;
	return tramos.map((_, k) => [redondo(k === 0 ? 0 : duracionBase(keep.slice(0, k), velocidad)), redondo(duracionBase(keep.slice(0, k + 1), velocidad))]);
}

/**
 * Cuantiza los tramos a cuadros de 30 fps.
 * - Exige tramos válidos (0 ≤ desde < hasta), en orden y sin encimarse (código 2 si no).
 * - Los recorta a la ventana --desde/--hasta y a `limiteCuadros` (lo que de verdad dura el clip).
 * - Redondea al cuadro más cercano, quita los que quedan vacíos y une los que se tocan
 *   (así no hay fundidos de 15 ms donde no hubo corte).
 */
export function cuantizarTramos(
	tramos: TramoSegundos[],
	limiteCuadros: number,
	ventana: {desde?: number; hasta?: number} = {},
): TramoCuadros[] {
	tramos.forEach((t, i) => {
		if (!Number.isFinite(t.desde) || !Number.isFinite(t.hasta) || t.desde < 0 || !(t.hasta > t.desde)) {
			throw fallo('armar los tramos', `el tramo ${i + 1} (${t.desde}–${t.hasta} s) no es válido`, 'revisa que cada tramo cumpla 0 ≤ desde < hasta', 2);
		}
		if (i > 0 && t.desde < tramos[i - 1].hasta - 1e-9) {
			throw fallo(
				'armar los tramos',
				`el tramo ${i + 1} empieza en ${t.desde} s, antes de que termine el anterior (${tramos[i - 1].hasta} s)`,
				'ordena los tramos y quita los encimados',
				2,
			);
		}
	});
	const vDesde = ventana.desde ?? 0;
	const vHasta = ventana.hasta ?? Number.POSITIVE_INFINITY;
	const enCuadros = (s: number): number => Math.min(limiteCuadros, Math.max(0, Math.round(s * FPS)));

	const unidos: TramoCuadros[] = [];
	for (const t of tramos) {
		const desde = Math.max(t.desde, vDesde);
		const hasta = Math.min(t.hasta, vHasta);
		if (!(hasta > desde)) continue;
		const tramo = {inicio: enCuadros(desde), fin: enCuadros(hasta)};
		if (tramo.fin <= tramo.inicio) continue;
		const ultimo = unidos.at(-1);
		if (ultimo && tramo.inicio <= ultimo.fin) ultimo.fin = Math.max(ultimo.fin, tramo.fin);
		else unidos.push(tramo);
	}
	if (unidos.length === 0) {
		throw fallo('armar los tramos', 'no queda ningún tramo de al menos un cuadro dentro del clip', 'revisa --desde/--hasta o los keep de cortes.json', 2);
	}
	return unidos;
}

export const totalCuadros = (tramos: TramoCuadros[]): number => tramos.reduce((suma, t) => suma + (t.fin - t.inicio), 0);

/** Velocidad como texto para ffmpeg: el mismo double que usan los tiempos (sin notación exponencial). */
export function textoVelocidad(velocidad: number): string {
	if (!esVelocidadValida(velocidad)) {
		throw fallo('armar el filtro de la base', `la velocidad ${String(velocidad)} no es un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX}`, 'revisa de dónde salió (cortes.json o --velocidad)', 2);
	}
	return String(velocidad);
}

/**
 * Filtro de ffmpeg (filter_complex) para los tramos dados.
 * Video: [0:v] (ya rotado por ffmpeg) → [crop del encuadre, px del original] → fps=30 → split → trim por tramo
 * (en cuadros) → [velocidad: setpts=PTS/F → fps=30 → los cuadros exactos del tramo] → concat → scale+crop 1440×2560.
 * Audio: [0:a] → 48 kHz (con relleno si arranca tarde) → asplit → atrim por tramo (en muestras) → fades → concat
 * → [velocidad: UN atempo=F → apad + atrim a las muestras exactas de los cuadros].
 * Con velocidad = 1 el filtro es idéntico al de antes de la velocidad.
 */
export function construirFiltro(
	tramos: TramoCuadros[],
	indices: {video: number; audio: number},
	recorte: Recorte | null = null,
	velocidad = 1,
	lienzo: readonly [number, number] = [ANCHO, ALTO],
): string {
	const [anchoL, altoL] = lienzo;
	const n = tramos.length;
	const etiquetas = (prefijo: string): string => tramos.map((_, i) => `[${prefijo}${i}]`).join('');
	const partes = [
		`[0:${indices.video}]${recorte ? `${filtroRecorte(recorte)},` : ''}fps=${FPS}:start_time=0,split=${n}${etiquetas('vs')}`,
		`[0:${indices.audio}]aresample=${MUESTREO}:async=1:first_pts=0,asplit=${n}${etiquetas('as')}`,
	];
	const acelerar = velocidad !== 1;
	const f = acelerar ? textoVelocidad(velocidad) : '1';
	const cortes = acelerar ? cuadrosDeCortes(tramos, velocidad) : [];
	const conVideo: number[] = [];
	tramos.forEach(({inicio, fin}, i) => {
		const m0 = inicio * MUESTRAS_POR_CUADRO;
		const m1 = fin * MUESTRAS_POR_CUADRO;
		const muestras = m1 - m0;
		const fade = Math.min(MUESTRAS_FADE, Math.floor(muestras / 2)); // nunca se enciman entrada y salida
		const recortar = `[vs${i}]trim=start_pts=${inicio}:end_pts=${fin},setpts=PTS-STARTPTS`;
		if (!acelerar) {
			partes.push(`${recortar}[v${i}]`);
			conVideo.push(i);
		} else {
			// Video del tramo a F: setpts divide el tiempo entre F (en microsegundos, settb=AVTB, para no perder
			// precisión); fps=30 (round=near) se queda con el último cuadro que cae en cada cuadro de salida; tpad + trim
			// lo dejan con exactamente los cuadros que le tocan en la base (cuadrosDeCortes). Un tramo que en la base no
			// llega a un cuadro (un solo cuadro del crudo a F > 1) se queda sin video; su audio sí suena.
			const cuadros = cortes[i + 1] - cortes[i];
			if (cuadros > 0) {
				partes.push(`${recortar},settb=AVTB,setpts=PTS/${f},fps=${FPS}:round=near,tpad=stop_mode=clone:stop=1,trim=end_frame=${cuadros}[v${i}]`);
				conVideo.push(i);
			} else {
				partes.push(`${recortar},nullsink`);
			}
		}
		partes.push(
			`[as${i}]atrim=start_pts=${m0}:end_pts=${m1},asetpts=PTS-STARTPTS,` +
				`afade=t=in:ss=0:ns=${fade},afade=t=out:ss=${muestras - fade}:ns=${fade}[a${i}]`,
		);
	});
	const escalar = `scale=${anchoL}:${altoL}:force_original_aspect_ratio=increase:flags=lanczos,crop=${anchoL}:${altoL},setsar=1,format=yuv420p[vout]`;
	if (!acelerar) {
		partes.push(`${tramos.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`);
		partes.push(`[vc]${escalar}`);
		return partes.join(';');
	}
	// El audio se junta SIN acelerar (con sus fundidos dentro de cada tramo) y pasa por UN solo atempo (WSOLA: cambia
	// el ritmo, no el tono). Sin compensación de tiempo: medido con tu voz (IMG_5199, arranques de consenso), atempo
	// deja cada arranque a +4 ms de t/F (mediana; p10 −4, p90 +9…+12 ms con F 1.0963 y 1.15). Solo sobre silencio
	// DIGITAL (pitidos sintéticos sin ruido) los adelanta ~18 ms, algo que con el piso de ruido de una grabación real no
	// pasa: retrasar la entrada media ventana dejaba tu voz ~23 ms tarde. atempo entrega unas muestras de más o de menos
	// (en tu voz, +1…+9 ms en 20–141 s); por eso queda con las muestras exactas de los cuadros de la base (apad rellena,
	// atrim corta): audio = video. El video ya viene acelerado por tramo, con sus cuadros exactos.
	const muestras = cortes[cortes.length - 1] * MUESTRAS_POR_CUADRO;
	partes.push(`${conVideo.map((i) => `[v${i}]`).join('')}concat=n=${conVideo.length}:v=1:a=0[vc]`);
	partes.push(`${tramos.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[acc]`);
	partes.push(`[acc]atempo=${f},apad=whole_len=${muestras},atrim=end_sample=${muestras}[ac]`);
	partes.push(`[vc]${escalar}`);
	return partes.join(';');
}

/** Argumentos completos de ffmpeg. Los metadatos del original (GPS incluido) no pasan a la base. */
export function argumentosBase(original: string, salida: string, filtro: string): string[] {
	const {video, audio} = CODIFICACION;
	return [
		'-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
		'-i', original,
		'-filter_complex', filtro,
		'-map', '[vout]', '-map', '[ac]',
		'-c:v', video.codec, '-preset', video.preset, '-crf', String(video.crf), '-g', String(video.g), '-pix_fmt', video.pix_fmt,
		'-fps_mode', 'cfr', '-r', String(FPS),
		'-c:a', audio.codec, '-b:a', audio.bitrate, '-ar', String(audio.muestreo), '-ac', String(audio.canales),
		'-map_metadata', '-1', '-map_chapters', '-1',
		'-movflags', '+faststart',
		'-progress', 'pipe:1', '-nostats',
		salida,
	];
}

export type VerificacionBase = {
	ok: boolean;
	problemas: string[];
	ancho: number;
	alto: number;
	r_frame_rate: string;
	rotacion: number;
	cuadros: number;
	cuadros_esperados: number;
	duracion_video_s: number;
	duracion_audio_s: number | null;
	dif_cuadros_audio_video: number | null;
};

/** Verificación final con ffprobe: 1440×2560, 30/1, sin rotación, h264 yuv420p, AAC 48 kHz y duraciones ±1 cuadro. */
export function verificarBase(sondeo: Sondeo, cuadrosEsperados: number, lienzo: readonly [number, number] = [ANCHO, ALTO]): VerificacionBase {
	const [anchoL, altoL] = lienzo;
	const v = sondeo.video;
	const problemas: string[] = [];
	const duracionVideo = v.duracion ?? sondeo.duracion;
	const duracionAudio = sondeo.audio ? (sondeo.audio.duracion ?? sondeo.duracion) : null;
	const cuadros = v.cuadros ?? Math.round(duracionVideo * FPS);

	if (v.ancho !== anchoL || v.alto !== altoL) problemas.push(`mide ${v.ancho}×${v.alto} y no ${anchoL}×${altoL}`);
	if (v.rotacion !== 0) problemas.push(`quedó con rotación de ${v.rotacion}°`);
	if (v.rFrameRate !== `${FPS}/1`) problemas.push(`va a ${v.rFrameRate} y no a ${FPS}/1`);
	if (v.codec !== 'h264' || v.pixFmt !== 'yuv420p') problemas.push(`salió en ${v.codec} ${v.pixFmt ?? '?'} y no en h264 yuv420p`);
	if (Math.abs(cuadros - cuadrosEsperados) > 1) problemas.push(`tiene ${cuadros} cuadros y esperaba ${cuadrosEsperados}`);

	let difAV: number | null = null;
	if (!sondeo.audio || duracionAudio === null) problemas.push('no trae audio');
	else {
		difAV = Math.abs(duracionAudio - duracionVideo) * FPS;
		if (difAV > 1 + 1e-6) problemas.push(`audio (${duracionAudio.toFixed(3)} s) y video (${duracionVideo.toFixed(3)} s) difieren ${difAV.toFixed(2)} cuadros`);
		if (sondeo.audio.codec !== 'aac' || sondeo.audio.sampleRate !== MUESTREO) {
			problemas.push(`el audio salió en ${sondeo.audio.codec} a ${sondeo.audio.sampleRate} Hz y no en AAC a ${MUESTREO} Hz`);
		}
	}
	return {
		ok: problemas.length === 0,
		problemas,
		ancho: v.ancho,
		alto: v.alto,
		r_frame_rate: v.rFrameRate,
		rotacion: v.rotacion,
		cuadros,
		cuadros_esperados: cuadrosEsperados,
		duracion_video_s: duracionVideo,
		duracion_audio_s: duracionAudio,
		dif_cuadros_audio_video: difAV === null ? null : Number(difAV.toFixed(3)),
	};
}

/** Cuadros que de verdad cubren video y audio del original (lo más corto de los dos, hacia abajo). */
export function limiteDeCuadros(sondeo: Sondeo): number {
	const video = sondeo.video.duracion ?? sondeo.duracion;
	const audio = sondeo.audio?.duracion ?? sondeo.duracion;
	return Math.floor(Math.min(video, audio, sondeo.duracion) * FPS + 1e-6);
}

/** Encuadre que se usó (o se ignoró por ser el cuadro completo). */
export type EncuadreAplicado = {
	/** Ruta del encuadre.json (relativa a la raíz si vive dentro). */
	ruta: string;
	/** Recorte en px del original (cuadro visible, ya rotado). null = cuadro completo: no se recorta nada. */
	recorte: Recorte | null;
	escala_efectiva: number;
	identidad: boolean;
};

export type ResultadoBase = {
	slug: string;
	salida: string;
	/** Tramos en cuadros de 30 fps del crudo (los de keep[], cuantizados). */
	tramos: TramoCuadros[];
	verificacion: VerificacionBase | null;
	archivo: ArchivoHash;
	reutilizada: boolean;
	segundos: number;
	encuadre: EncuadreAplicado | null;
	/** Velocidad con que se aceleró la base (1 = sin acelerar) y de dónde salió. */
	velocidad: VelocidadBase;
};

export type OpcionesBase = {
	slug: string;
	cortes?: string;
	desde?: number;
	hasta?: number;
	/**
	 * Ruta de un encuadre.json. Sin valor (undefined): se usa proyectos/<slug>/encuadre.json si existe.
	 * null: sin encuadre aunque exista ese archivo (--sin-encuadre).
	 */
	encuadre?: string | null;
	/**
	 * Velocidad pedida (--velocidad). Con cortes.json tiene que ser la de cortes.json (si no, código 2); sin
	 * cortes.json, sin valor = ×1. Ver resolverVelocidad().
	 */
	velocidad?: number;
	/** Si se da, los tramos cuantizados tienen que ser exactamente estos (los de la base anterior); si no, código 2. */
	tramosEsperados?: ReadonlyArray<readonly [number, number]>;
	forzar?: boolean;
	/** --4k: la misma base a 2160×3840 en base-4k.mp4, con su propia etapa "base-4k" (base.mp4 no se toca). */
	cuatroK?: boolean;
	proyectos?: string;
	alProgreso?: (fraccion: number) => void;
	alEmpezar?: (tramos: TramoCuadros[], velocidad: number) => void;
};

/**
 * Encuadre a usar: el de --encuadre, el de proyectos/<slug>/encuadre.json si existe, o ninguno.
 * Revisa que sea del mismo original (sha256, si lo trae) y que el recorte quepa en su cuadro visible (código 2 si
 * no). Un recorte del cuadro completo vuelve con `recorte: null` (no se recorta nada).
 */
export function resolverEncuadre(
	ruta: string | null,
	original: {sha256: string},
	sondeo: Pick<Sondeo, 'video'>,
): EncuadreAplicado | null {
	if (ruta === null) return null;
	const enc = leerEncuadre(ruta);
	const nombre = relative(RAIZ, ruta).startsWith('..') ? ruta : relative(RAIZ, ruta);
	const visible = {ancho_visible: sondeo.video.anchoVisible, alto_visible: sondeo.video.altoVisible};
	const sha = enc.original.sha256;
	if (sha !== undefined && sha !== original.sha256) {
		throw fallo('aplicar el encuadre', `${nombre} se calculó para otro original (su sha256 no es el del crudo de este proyecto)`, 'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug> o usa --sin-encuadre', 2);
	}
	if (enc.original.ancho_visible !== visible.ancho_visible || enc.original.alto_visible !== visible.alto_visible) {
		throw fallo(
			'aplicar el encuadre',
			`${nombre} es para un cuadro de ${enc.original.ancho_visible}×${enc.original.alto_visible} y el original se ve de ${visible.ancho_visible}×${visible.alto_visible}`,
			'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug> o usa --sin-encuadre',
			2,
		);
	}
	const problemas = problemasRecorte(enc.recorte, visible);
	if (problemas.length > 0) throw fallo('aplicar el encuadre', `el recorte de ${nombre} no sirve: ${problemas.join('; ')}`, 'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug>', 2);
	const identidad = esIdentidad(enc.recorte, visible);
	return {ruta: nombre, recorte: identidad ? null : enc.recorte, escala_efectiva: identidad ? 1 : enc.escala_efectiva, identidad};
}

const mismosTramos = (a: ReadonlyArray<readonly [number, number]>, b: TramoCuadros[]) =>
	a.length === b.length && a.every(([i, f], k) => i === b[k].inicio && f === b[k].fin);

export async function generarBase(opciones: OpcionesBase): Promise<ResultadoBase> {
	const t0 = performance.now();
	const {forzar = false, proyectos = DIR_PROYECTOS} = opciones;
	const lienzo: readonly [number, number] = opciones.cuatroK ? LIENZO_4K : [ANCHO, ALTO];
	const nombreSalida = opciones.cuatroK ? NOMBRE_BASE_4K : NOMBRE_BASE;
	const etapa = opciones.cuatroK ? 'base-4k' : 'base';
	const slug = validarSlug(opciones.slug);
	const dir = dirProyecto(slug, proyectos);

	// Primero lo barato: argumentos y cortes.json, antes de leer el original completo.
	for (const [nombre, valor] of [['--desde', opciones.desde], ['--hasta', opciones.hasta]] as const) {
		if (valor !== undefined && (!Number.isFinite(valor) || valor < 0)) {
			throw fallo('leer los argumentos', `${nombre} tiene que ser un número de segundos ≥ 0`, `usa ${USO}`, 2);
		}
	}
	if (opciones.desde !== undefined && opciones.hasta !== undefined && !(opciones.hasta > opciones.desde)) {
		throw fallo('leer los argumentos', '--hasta tiene que ser mayor que --desde', `usa ${USO}`, 2);
	}
	const rutaCortes = opciones.cortes ? resolve(opciones.cortes) : null;
	const leidos = rutaCortes ? leerCortesConVelocidad(rutaCortes) : null;
	const cortes = leidos?.keep ?? null;
	const velocidad = resolverVelocidad(opciones.velocidad, rutaCortes && leidos ? {ruta: rutaCortes, velocidad: leidos.velocidad} : null, slug);
	const F = velocidad.factor;
	const rutaEncuadreAuto = resolve(dir, NOMBRE_ENCUADRE);
	const rutaEncuadre =
		opciones.encuadre === null ? null : opciones.encuadre !== undefined ? resolve(opciones.encuadre) : existsSync(rutaEncuadreAuto) ? rutaEncuadreAuto : null;
	if (rutaEncuadre) leerEncuadre(rutaEncuadre); // barato: si el archivo no sirve, falla antes de leer el original

	const manifest = leerManifest(slug, proyectos);
	if (!manifest?.original || manifest.etapas.ingesta?.estado !== 'terminada') {
		throw fallo(`generar la base de ${slug}`, 'ese proyecto todavía no pasa por la ingesta', `corre primero npx tsx herramientas/ingesta.ts <ruta-crudo> --slug ${slug}`, 2);
	}
	const original = manifest.original.ruta;
	if (!existsSync(original)) {
		throw fallo(`generar la base de ${slug}`, `ya no encuentro el original en ${original}`, 'regrésalo a esa ruta o vuelve a correr la ingesta con la nueva', 2);
	}

	// El original tiene que ser el mismo que registró la ingesta (mismo sha256).
	const entradas: ArchivoHash[] = [await hashearArchivo(original)];
	if (entradas[0].sha256 !== manifest.original.sha256) {
		throw fallo(
			`generar la base de ${slug}`,
			'el original cambió desde la ingesta (su sha256 ya no es el mismo)',
			`si es el crudo correcto, vuelve a correr la ingesta de ${basename(original)} con --slug ${slug} --forzar`,
			2,
		);
	}

	const sondeo = await sondear(original);
	revisarApto(sondeo);
	const limite = limiteDeCuadros(sondeo);
	const encuadre = resolverEncuadre(rutaEncuadre, manifest.original, sondeo);

	// Sin cortes = el clip entero. cortes.json también es entrada: si cambia, la base deja de estar vigente.
	const tramosSegundos: TramoSegundos[] = cortes ?? [{desde: 0, hasta: limite / FPS}];
	if (rutaCortes) entradas.push(await hashearArchivo(rutaCortes));
	const tramos = cuantizarTramos(tramosSegundos, limite, {desde: opciones.desde, hasta: opciones.hasta});
	const cuadrosEsperados = cuadrosDeLaBase(tramos, F);
	if (opciones.tramosEsperados && !mismosTramos(opciones.tramosEsperados, tramos)) {
		const antes = opciones.tramosEsperados.reduce((s, [i, f]) => s + (f - i), 0);
		throw fallo(
			`generar la base de ${slug}`,
			`con esos cortes los tramos salen distintos a los de la base anterior (${tramos.length} tramos y ${totalCuadros(tramos)} cuadros del crudo contra ${opciones.tramosEsperados.length} y ${antes})`,
			`corre tú npx tsx herramientas/base.ts ${slug} con los mismos --cortes/--desde/--hasta de antes y --encuadre`,
			2,
			{esperados: opciones.tramosEsperados, calculados: tramos},
		);
	}

	// El recorte del encuadre y la velocidad son parámetros: si cambian (o se quitan), la base deja de estar vigente.
	// Sin encuadre (o con el cuadro completo) y a ×1, los parámetros quedan idénticos a los de siempre.
	// tramos_cuadros sigue en cuadros del CRUDO (lo leen qa.ts, cara.ts y encuadre.ts); con F, en la base cada uno cae
	// en tramos_base_s (abajo, en la etapa).
	const parametros: Record<string, unknown> = {
		version: 1,
		tramos_cuadros: tramos.map((t) => [t.inicio, t.fin]),
		fps: FPS,
		lienzo: [...lienzo],
		fade_ms: FADE_MS,
		...CODIFICACION,
		...(encuadre?.recorte
			? {encuadre: {recorte: [encuadre.recorte.x, encuadre.recorte.y, encuadre.recorte.w, encuadre.recorte.h], cuadro: [sondeo.video.anchoVisible, sondeo.video.altoVisible]}}
			: {}),
		...(F !== 1 ? {velocidad: F} : {}),
	};
	if (!forzar && (await etapaVigente(slug, etapa, entradas, parametros, proyectos))) {
		const registro = leerManifest(slug, proyectos)!.etapas[etapa];
		return {
			slug,
			salida: resolve(dir, nombreSalida),
			tramos,
			verificacion: (registro.verificacion as VerificacionBase | undefined) ?? null,
			archivo: registro.salidas[0],
			reutilizada: true,
			segundos: (performance.now() - t0) / 1000,
			encuadre,
			velocidad,
		};
	}

	registrarEtapa(slug, etapa, {estado: 'en-curso', entradas, parametros}, proyectos);
	const temporal = rutaSalidaSegura(slug, nombreSalida.replace('.mp4', '.tmp.mp4'), original, proyectos);
	const destino = rutaSalidaSegura(slug, nombreSalida, original, proyectos);
	opciones.alEmpezar?.(tramos, F);
	try {
		const filtro = construirFiltro(tramos, {video: sondeo.video.indice, audio: sondeo.audio!.indice}, encuadre?.recorte ?? null, F, lienzo);
		await correrFfmpeg(argumentosBase(original, temporal, filtro), {
			que: `generar la base de ${slug}`,
			duracionTotal: cuadrosEsperados / FPS,
			alProgreso: opciones.alProgreso,
		});
	} catch (error) {
		rmSync(temporal, {force: true});
		registrarEtapa(slug, etapa, {estado: 'fallida', entradas, parametros}, proyectos);
		throw error;
	}

	const verificacion = verificarBase(await sondear(temporal), cuadrosEsperados, lienzo);
	if (!verificacion.ok) {
		registrarEtapa(slug, etapa, {estado: 'fallida', entradas, parametros, extra: {verificacion}}, proyectos);
		throw fallo(`verificar la base de ${slug}`, verificacion.problemas.join('; '), `revisa ${relative(RAIZ, temporal)} y avísame`, 1, verificacion);
	}
	renameSync(temporal, destino);

	const archivo = await hashearArchivo(destino, dir);
	const segundos = (performance.now() - t0) / 1000;
	registrarEtapa(
		slug,
		etapa,
		{
			estado: 'terminada',
			entradas,
			parametros,
			salidas: [archivo],
			// cortes y encuadre van aparte (no cuentan para la vigencia): sirven para rehacer la base con los mismos cortes.
			// tramos_base_s: dónde cae cada tramo en la base ya acelerada (s); los cortes de la base son sus bordes.
			extra: {
				verificacion,
				duracion_proceso_s: Number(segundos.toFixed(2)),
				cortes: rutaCortes,
				encuadre,
				velocidad_origen: velocidad.origen,
				duracion_sin_acelerar_s: Number((totalCuadros(tramos) / FPS).toFixed(6)),
				tramos_base_s: tramosEnLaBase(tramos, F),
			},
		},
		proyectos,
	);
	return {slug, salida: destino, tramos, verificacion, archivo, reutilizada: false, segundos, encuadre, velocidad};
}

/** 127.4 → "2 min 07 s"; 119.6 → "2 min 00 s"; 5.24 → "5.2 s". */
export function formatoDuracion(segundos: number): string {
	if (segundos < 60) return `${segundos.toFixed(1)} s`;
	const total = Math.round(segundos);
	return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
}

export function resumenBase(r: ResultadoBase): string {
	const v = r.verificacion;
	const n = r.tramos.length;
	const lineas = [`Base ${r.reutilizada ? 'ya estaba al día' : 'lista'}: ${relative(RAIZ, r.salida)}`];
	if (v) {
		lineas.push(`  ${v.ancho}×${v.alto} · ${v.r_frame_rate} · ${v.cuadros} cuadros (${v.duracion_video_s.toFixed(3)} s de video, ${v.duracion_audio_s?.toFixed(3) ?? '?'} s de audio; diferencia ${v.dif_cuadros_audio_video ?? '?'} cuadros)`);
	}
	lineas.push(`  ${n} tramo${n === 1 ? '' : 's'} · ${((r.archivo.bytes ?? 0) / 1e6).toFixed(0)} MB · ${formatoDuracion(r.segundos)}`);
	if (r.velocidad.factor !== 1) {
		const sinAcelerar = totalCuadros(r.tramos) / FPS;
		lineas.push(`  velocidad ×${r.velocidad.factor} (${r.velocidad.origen}): ${sinAcelerar.toFixed(3)} s sin acelerar → ${(sinAcelerar / r.velocidad.factor).toFixed(3)} s, mismo tono (atempo)`);
	}
	const e = r.encuadre;
	if (e?.recorte) {
		lineas.push(`  encuadre ×${e.escala_efectiva.toFixed(3)}: recorte ${e.recorte.w}×${e.recorte.h} en x=${e.recorte.x}, y=${e.recorte.y} del original (${e.ruta})`);
	} else if (e?.identidad) {
		lineas.push(`  encuadre ×1: ${e.ruta} es el cuadro completo, así que no se recorta nada`);
	}
	return lineas.join('\n');
}

function numeroDeArgumento(nombre: string, valor: string | undefined): number | undefined {
	if (valor === undefined) return undefined;
	const n = Number(valor);
	if (valor.trim() === '' || !Number.isFinite(n) || n < 0) {
		throw fallo('leer los argumentos', `${nombre} tiene que ser un número de segundos ≥ 0 (me llegó "${valor}")`, `usa ${USO}`, 2);
	}
	return n;
}

/** --velocidad F: un número de 0.5 a 2 (1 = sin acelerar). */
export function velocidadDeArgumento(valor: string | undefined): number | undefined {
	if (valor === undefined) return undefined;
	const n = Number(valor);
	if (valor.trim() === '' || !esVelocidadValida(n)) {
		throw fallo('leer los argumentos', `--velocidad tiene que ser un número de ${VELOCIDAD_MIN} a ${VELOCIDAD_MAX} (me llegó "${valor}")`, `usa ${USO}`, 2);
	}
	return n;
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				cortes: {type: 'string'},
				desde: {type: 'string'},
				hasta: {type: 'string'},
				encuadre: {type: 'string'},
				'sin-encuadre': {type: 'boolean', default: false},
				velocidad: {type: 'string'},
				forzar: {type: 'boolean', default: false},
				'4k': {type: 'boolean', default: false},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error);
		const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
		throw fallo('leer los argumentos', desconocida ? `no conozco la opción ${desconocida[1]}` : 'los argumentos no tienen la forma esperada', `usa ${USO}`, 2, mensaje);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	if (posicionales.length !== 1) {
		throw fallo('empezar la base', posicionales.length === 0 ? 'falta el slug del proyecto' : 'me pasaste más de un slug', `usa ${USO}`, 2);
	}
	if (valores.encuadre !== undefined && valores['sin-encuadre']) {
		throw fallo('leer los argumentos', '--encuadre y --sin-encuadre no van juntos', `usa ${USO}`, 2);
	}

	let siguiente = 0.2;
	const resultado = await generarBase({
		slug: posicionales[0],
		cortes: valores.cortes,
		desde: numeroDeArgumento('--desde', valores.desde),
		hasta: numeroDeArgumento('--hasta', valores.hasta),
		encuadre: valores['sin-encuadre'] ? null : valores.encuadre,
		velocidad: velocidadDeArgumento(valores.velocidad),
		forzar: valores.forzar,
		cuatroK: valores['4k'],
		alEmpezar: (tramos, velocidad) => {
			const n = tramos.length;
			const segundos = totalCuadros(tramos) / FPS;
			const acelerada = velocidad === 1 ? `${segundos.toFixed(2)} s` : `${segundos.toFixed(2)} s a ×${velocidad} = ${(cuadrosDeLaBase(tramos, velocidad) / FPS).toFixed(2)} s`;
			console.log(`Generando base de ${posicionales[0]}: ${n} tramo${n === 1 ? '' : 's'}, ${acelerada} → ${valores['4k'] ? LIENZO_4K.join('×') : `${ANCHO}×${ALTO}`} a ${FPS} fps…`);
		},
		alProgreso: (fraccion) => {
			while (fraccion >= siguiente - 1e-9 && siguiente < 1 - 1e-9) {
				console.log(`  … ${Math.round(siguiente * 100)} %`);
				siguiente += 0.2;
			}
		},
	});
	console.log(resumenBase(resultado));
}

/** Solo corre main si este archivo es el que se ejecutó (no al importarlo desde pruebas). */
function esEjecucionDirecta(): boolean {
	try {
		return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (esEjecucionDirecta()) await correr(main);
