// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * overlays.ts: detecta en un reel CUÁNDO y DÓNDE aparecen stickers, tarjetas e inserts, cómo entran (pop) y si
 * suena un SFX al aparecer.
 *
 *   npx tsx herramientas/estilo/overlays.ts <reel.mp4> [--salida referencias/reels/<id>/overlays.json]
 *                                                     [--franja 1420,1580] [--sin-onsets]
 *
 * Cómo (ver herramientas/lib/overlays.ts): rachas de color quieto por píxel (¼ de la base), agrupadas por cuándo
 * nacen y mueren; se quitan el fondo, el titular y la franja de subtítulos; se clasifican por apariencia; una
 * segunda pasada afina desde/hasta a los fps nativos y mide el pop. Las tomas que no son la principal (tu laptop
 * a pantalla completa) salen como inserts. Los SFX salen de herramientas/lib/onsets.ts sobre el mismo audio.
 * Sin Vision ni GPU (solo ffmpeg). Va en excludedCommands porque tarda y lee los reels de ~/Desktop.
 * Salida por defecto: referencias/reels/<id>/overlays.json (y onsets.json al lado).
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (no existe, no es video, falta ffmpeg).
 */
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {sondear} from '../lib/ffprobe.ts';
import {RAIZ} from '../lib/manifest.ts';
import {
	BASE_H,
	BASE_W,
	capasDeVideo,
	FRANJA_SUBTITULOS,
	tomasDeVideo,
	tramosDesenfocados,
	type Apariencia,
	type CajaBase,
	type ClaseCapa,
	type Pop,
} from '../lib/overlays.ts';
import type {FuenteOnset, Onset} from '../lib/onsets.ts';
import {analizarOnsets, salidaPorDefecto, type ReporteOnsets} from './onsets.ts';

/** Ventana (± cuadros a fps nativos) en la que un onset cuenta como el SFX de una aparición. */
export const VENTANA_SFX_CUADROS = 3;
/** Fuentes de onset que casi nunca son voz (sin el flujo de agudos solo, que también dispara con respiraciones). */
export const FUENTES_CONFIABLES: FuenteOnset[] = ['clic', 'tono', 'golpe', 'lateral'];

export type SfxDeEvento = {
	con_sfx: boolean;
	/** Onset más cercano a la aparición dentro de ±VENTANA_SFX_CUADROS. */
	onset_s: number | null;
	desfase_cuadros: number | null;
	fuentes: FuenteOnset[];
	/** ¿Lo vio al menos una fuente confiable (no solo el flujo de agudos)? */
	confiable: boolean;
};

export type EventoCapa = {
	id: string;
	clase: ClaseCapa;
	subtipo: 'capa' | 'pantalla-completa' | 'desenfoque';
	desde: number;
	hasta: number;
	desde_cuadro: number;
	hasta_cuadro: number;
	duracion_s: number;
	/** Caja en base 1080×1920 (x, y = esquina superior izquierda). Pantalla completa = todo el cuadro. */
	caja: CajaBase;
	centro: {x: number; y: number};
	entrada: Pop | null;
	apariencia: Apariencia | null;
	sfx: SfxDeEvento | null;
	nota: string | null;
};

export type Metrica = {valor: number | null; n: number; nota?: string};
export type Cuantiles = {p10: number | null; p50: number | null; p90: number | null; n: number; nota?: string};

export type ResumenReel = {
	duracion_s: number;
	por_clase: Record<ClaseCapa, number>;
	stickers_por_min: Metrica;
	tarjetas_por_min: Metrica;
	inserts_por_min: Metrica;
	/** Tomas de insert seguidas (sin toma principal en medio) cuentan como una secuencia. */
	secuencias_de_insert_por_min: Metrica;
	duracion_stickers_s: Cuantiles;
	duracion_tarjetas_s: Cuantiles;
	ancho_sticker_px: Cuantiles;
	centro_y_sticker_px: Metrica;
	pop_cuadros_sticker: Metrica;
	pop_escala_inicial_sticker: Metrica;
	pop_sobrepaso_sticker: Metrica;
	pct_con_sfx: Metrica;
	pct_sin_sonido: Metrica;
	pct_con_sfx_confiable: Metrica;
	pct_esperado_al_azar: Metrica;
	pct_esperado_al_azar_confiable: Metrica;
	desfase_sfx_cuadros_p50: Metrica;
	huecos_entre_eventos_con_sonido_s: Cuantiles;
};

export type ReporteOverlays = {
	version: 1;
	generado_por: string;
	fuente: string;
	fps: number;
	cuadros: number;
	duracion_s: number;
	resolucion: string;
	metodo: Record<string, string>;
	franja_subtitulos: [number, number];
	titular: CajaBase | null;
	tomas: {cortes: number; principales: number; inserts: number; capas_descartadas_dentro_de_insert: number};
	eventos: EventoCapa[];
	onsets: {archivo: string | null; n: number; lateral: string; nota: string | null};
	resumen: ResumenReel;
	segundos: Record<string, number>;
};

// ───────────────────────────── Puro: relación con SFX y resumen ─────────────────────────────

/** Cuantil tipo 7; null si no hay datos. */
export function cuantil(valores: number[], p: number): number | null {
	const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const h = (v.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

const r2 = (v: number | null, d = 2): number | null => (v === null ? null : Number(v.toFixed(d)));

export function cuantiles(valores: number[], d = 2, nota?: string): Cuantiles {
	const n = valores.filter(Number.isFinite).length;
	return {p10: r2(cuantil(valores, 0.1), d), p50: r2(cuantil(valores, 0.5), d), p90: r2(cuantil(valores, 0.9), d), n, ...(n === 0 && nota ? {nota} : {})};
}

/** SFX de una aparición: el onset más cercano a `desde` dentro de ±ventana cuadros (a fps nativos). */
export function sfxDeAparicion(desde: number, onsets: Onset[], fps: number, ventana = VENTANA_SFX_CUADROS): SfxDeEvento {
	let mejor: Onset | null = null;
	let dist = Infinity;
	for (const o of onsets) {
		const d = Math.abs(o.t - desde);
		if (d <= (ventana + 0.5) / fps && d < dist) {
			dist = d;
			mejor = o;
		}
	}
	if (!mejor) return {con_sfx: false, onset_s: null, desfase_cuadros: null, fuentes: [], confiable: false};
	return {
		con_sfx: true,
		onset_s: mejor.t,
		desfase_cuadros: Math.round((mejor.t - desde) * fps),
		fuentes: mejor.fuentes,
		confiable: mejor.fuentes.some((f) => FUENTES_CONFIABLES.includes(f)),
	};
}

/**
 * Probabilidad de que un instante al azar tenga un onset a ±ventana cuadros: fracción del video cubierta por la
 * unión de [t − v, t + v] de todos los onsets. Es la línea base contra la que se compara el % con SFX.
 */
export function coberturaAlAzar(onsets: Onset[], duracionS: number, fps: number, ventana = VENTANA_SFX_CUADROS): number {
	if (duracionS <= 0) return 0;
	const v = (ventana + 0.5) / fps;
	const tramos = onsets.map((o) => [Math.max(0, o.t - v), Math.min(duracionS, o.t + v)] as const).sort((a, b) => a[0] - b[0]);
	let cubierto = 0;
	let a = -1;
	let b = -1;
	for (const [x, y] of tramos) {
		if (x > b) {
			if (b > a) cubierto += b - a;
			a = x;
			b = y;
		} else b = Math.max(b, y);
	}
	if (b > a) cubierto += b - a;
	return cubierto / duracionS;
}

/** Cuántas secuencias de inserts a pantalla completa hay (tomas pegadas, a ≤ 2 cuadros, cuentan como una). */
export function secuenciasDeInsert(eventos: EventoCapa[]): number {
	const pc = eventos.filter((e) => e.subtipo === 'pantalla-completa').sort((a, b) => a.desde_cuadro - b.desde_cuadro);
	let n = 0;
	let fin = -Infinity;
	for (const e of pc) {
		if (e.desde_cuadro > fin + 2) n++;
		fin = Math.max(fin, e.hasta_cuadro);
	}
	return n;
}

/** Resumen de un reel: tasas, duraciones, cajas, pop y SFX (cada número con su n). */
export function resumirReel(eventos: EventoCapa[], duracionS: number, onsets: Onset[] | null, fps: number): ResumenReel {
	const min = duracionS / 60;
	const de = (c: ClaseCapa) => eventos.filter((e) => e.clase === c);
	const porClase = {sticker: de('sticker').length, tarjeta: de('tarjeta').length, insert: de('insert').length, otro: de('otro').length};
	const tasa = (n: number): Metrica => ({valor: min > 0 ? r2(n / min) : null, n});
	const stickers = de('sticker');
	const conPop = stickers.filter((e) => e.entrada !== null);
	const pct = (a: number, b: number) => (b > 0 ? r2((100 * a) / b, 1) : null);
	const capas = eventos.filter((e) => e.subtipo !== 'desenfoque');
	const sinOnsets = onsets === null;
	const conSfx = capas.filter((e) => e.sfx?.con_sfx);
	const conConf = capas.filter((e) => e.sfx?.confiable);
	const notaSfx = sinOnsets ? 'N/A: no se corrieron los onsets' : undefined;
	const sonados = capas.filter((e) => e.sfx?.con_sfx).sort((a, b) => a.desde - b.desde);
	const huecos: number[] = [];
	for (let i = 1; i < sonados.length; i++) huecos.push(sonados[i].desde - sonados[i - 1].desde);
	const confiables = onsets?.filter((o) => o.fuentes.some((f) => FUENTES_CONFIABLES.includes(f))) ?? [];
	return {
		duracion_s: r2(duracionS) ?? 0,
		por_clase: porClase,
		stickers_por_min: tasa(porClase.sticker),
		tarjetas_por_min: tasa(porClase.tarjeta),
		inserts_por_min: tasa(porClase.insert),
		secuencias_de_insert_por_min: tasa(secuenciasDeInsert(eventos)),
		duracion_stickers_s: cuantiles(stickers.map((e) => e.duracion_s), 2, 'N/A: no hay stickers'),
		duracion_tarjetas_s: cuantiles(de('tarjeta').map((e) => e.duracion_s), 2, 'N/A: no hay tarjetas'),
		ancho_sticker_px: cuantiles(stickers.map((e) => e.caja.w), 0, 'N/A: no hay stickers'),
		centro_y_sticker_px: {valor: r2(cuantil(stickers.map((e) => e.centro.y), 0.5), 0), n: stickers.length, ...(stickers.length ? {} : {nota: 'N/A: no hay stickers'})},
		pop_cuadros_sticker: {valor: r2(cuantil(conPop.map((e) => e.entrada!.cuadros), 0.5), 1), n: conPop.length, ...(conPop.length ? {} : {nota: 'N/A: ningún sticker con entrada medible'})},
		pop_escala_inicial_sticker: {valor: r2(cuantil(conPop.map((e) => e.entrada!.escala_inicial), 0.5)), n: conPop.length},
		pop_sobrepaso_sticker: {valor: r2(cuantil(conPop.map((e) => e.entrada!.sobrepaso), 0.5)), n: conPop.length},
		pct_con_sfx: {valor: sinOnsets ? null : pct(conSfx.length, capas.length), n: capas.length, ...(notaSfx ? {nota: notaSfx} : {})},
		pct_sin_sonido: {valor: sinOnsets ? null : pct(capas.length - conSfx.length, capas.length), n: capas.length, ...(notaSfx ? {nota: notaSfx} : {})},
		pct_con_sfx_confiable: {valor: sinOnsets ? null : pct(conConf.length, capas.length), n: capas.length, ...(notaSfx ? {nota: notaSfx} : {})},
		pct_esperado_al_azar: {valor: sinOnsets ? null : r2(100 * coberturaAlAzar(onsets, duracionS, fps), 1), n: onsets?.length ?? 0, ...(notaSfx ? {nota: notaSfx} : {})},
		pct_esperado_al_azar_confiable: {valor: sinOnsets ? null : r2(100 * coberturaAlAzar(confiables, duracionS, fps), 1), n: confiables.length, ...(notaSfx ? {nota: notaSfx} : {})},
		desfase_sfx_cuadros_p50: {valor: r2(cuantil(conSfx.map((e) => e.sfx!.desfase_cuadros!), 0.5), 1), n: conSfx.length},
		huecos_entre_eventos_con_sonido_s: cuantiles(huecos, 2, sinOnsets ? 'N/A: no se corrieron los onsets' : 'N/A: menos de 2 eventos con sonido'),
	};
}

// ───────────────────────────── Análisis de un reel ─────────────────────────────

export type OpcionesReel = {franja?: [number, number]; onsets?: ReporteOnsets | null; sinOnsets?: boolean; alProgreso?: (m: string) => void};

export async function analizarReel(video: string, op: OpcionesReel = {}): Promise<ReporteOverlays> {
	const t0 = performance.now();
	const s = await sondear(video);
	const fps = s.video.fpsReal;
	if (!(fps > 0)) throw fallo(`analizar ${basename(video)}`, 'ffprobe no reporta los fps', 'revisa que el video esté completo', 2);
	const total = s.video.cuadros ?? Math.round(s.duracion * fps);
	const franja = op.franja ?? FRANJA_SUBTITULOS;
	const r = await capasDeVideo(video, {fps, totalCuadros: total, franja, alProgreso: op.alProgreso});
	const t1 = performance.now();
	const {cortes, tomas} = tomasDeVideo(r.porCuadro, fps, franja);
	const desenfoques = tramosDesenfocados(r.porCuadro, tomas, fps);
	let onsets: ReporteOnsets | null = op.onsets ?? null;
	let notaOnsets: string | null = null;
	if (!onsets && !op.sinOnsets) {
		try {
			onsets = await analizarOnsets(video);
		} catch (error) {
			notaOnsets = `N/A: no pude leer el audio (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
		}
	}
	const t2 = performance.now();
	const listaOnsets = onsets?.onsets ?? null;
	const evento = (base: Omit<EventoCapa, 'id' | 'sfx' | 'desde' | 'hasta' | 'duracion_s' | 'centro'>): Omit<EventoCapa, 'id'> => {
		const desde = base.desde_cuadro / fps;
		const hasta = base.hasta_cuadro / fps;
		return {
			...base,
			desde: Number(desde.toFixed(3)),
			hasta: Number(hasta.toFixed(3)),
			duracion_s: Number((hasta - desde).toFixed(3)),
			centro: {x: base.caja.x + base.caja.w / 2, y: base.caja.y + base.caja.h / 2},
			sfx: listaOnsets && base.subtipo !== 'desenfoque' ? sfxDeAparicion(desde, listaOnsets, fps) : null,
		};
	};
	const eventos: Array<Omit<EventoCapa, 'id'>> = [];
	const tomasInsert = tomas.filter((t) => !t.principal);
	let dentroDeInsert = 0;
	for (const c of r.capas) {
		// Lo que se queda quieto DENTRO de las tomas de tu laptop desde que empieza la toma (barras, botones de la
		// pantalla) no es una capa, salvo que sea una tarjeta: fuera si ≥ 80 % de su tiempo cae en esas tomas y
		// nace a ≤ 2 cuadros del corte. Lo que aparece a mitad de la toma sí cuenta (un sticker encima del video).
		const enInsert = tomasInsert.reduce((s, t) => s + Math.max(0, Math.min(c.hasta_cuadro, t.hasta) - Math.max(c.desde_cuadro, t.desde)), 0);
		const naceEnCorte = tomasInsert.some((t) => Math.abs(c.desde_cuadro - t.desde) <= 2);
		const dentro = enInsert >= 0.8 * (c.hasta_cuadro - c.desde_cuadro) && naceEnCorte;
		if (dentro && c.clase !== 'tarjeta') {
			dentroDeInsert++;
			continue;
		}
		eventos.push(evento({clase: c.clase, subtipo: 'capa', desde_cuadro: c.desde_cuadro, hasta_cuadro: c.hasta_cuadro, caja: c.caja, entrada: c.pop, apariencia: c.apariencia, nota: c.nota}));
	}
	const completo: CajaBase = {x: 0, y: 0, w: BASE_W, h: BASE_H};
	for (const t of tomas) {
		if (t.principal || t.hasta - t.desde < 0.3 * fps) continue;
		// Si una capa ya cubre casi todo el cuadro en ese tramo, es la misma cosa: queda una sola.
		const yaEsta = eventos.find((e) => e.clase === 'insert' && e.caja.w * e.caja.h >= 0.6 * BASE_W * BASE_H && Math.min(e.hasta_cuadro, t.hasta) - Math.max(e.desde_cuadro, t.desde) >= 0.5 * (t.hasta - t.desde));
		if (yaEsta) continue;
		eventos.push(evento({clase: 'insert', subtipo: 'pantalla-completa', desde_cuadro: t.desde, hasta_cuadro: t.hasta, caja: completo, entrada: null, apariencia: null, nota: `toma distinta a la principal (parecido ${t.similitud})`}));
	}
	for (const [a, b] of desenfoques) {
		eventos.push(evento({clase: 'otro', subtipo: 'desenfoque', desde_cuadro: a, hasta_cuadro: b, caja: completo, entrada: null, apariencia: null, nota: 'la toma se desenfoca (nitidez < 50 % de su mediana)'}));
	}
	eventos.sort((a, b) => a.desde_cuadro - b.desde_cuadro || a.caja.y - b.caja.y);
	const conId: EventoCapa[] = eventos.map((e, i) => ({id: `e${String(i + 1).padStart(3, '0')}`, ...e}));
	const duracionS = r.total / fps;
	return {
		version: 1,
		generado_por: 'herramientas/estilo/overlays.ts',
		fuente: video,
		fps: Number(fps.toFixed(3)),
		cuadros: r.total,
		duracion_s: Number(duracionS.toFixed(3)),
		resolucion: `${s.video.anchoVisible}×${s.video.altoVisible}`,
		metodo: {
			capas: 'rachas de color quieto por píxel (270×480 = ¼ de la base, tolerancia 12 por canal, ≥ 0.25 s); una capa = rachas que mueren juntas (±1 cuadro) y nacen juntas (moda −0.4 s…+2 cuadros), vecinas; se quita el fondo (color natural que se repite ≥ 3 s fuera del evento), la franja de subtítulos y el titular; se juntan fragmentos (texto que se escribe); se exige relleno ≥ 0.5 y ≥ 250 px de análisis (4000 px base)',
			clase: 'tarjeta = blanco ≥ 45 %, ≥ 85 % sin color (blanco, gris o negro), ≤ 5 % de color vivo, más ancha que alta, llena y con texto (o con emoji: ≤ 12 % vivo y aspecto ≥ 1.5); lo blanco sin forma de tarjeta se descarta; sticker = gráfica (blanco + color vivo ≥ 25 %) o imagen colorida; insert = caja > 25 % del cuadro o toma distinta a la principal; otro = rectángulo lleno sin blanco ni color, o desenfoque',
			bordes_y_pop: 'pasada 2 a fps nativos: plantilla = la capa asentada; hacia atrás, mejor escala 0.2–1.4 (pasos de 0.02) por cuadro; visible si su error queda bajo la mitad del camino entre asentado y ausente; pop = cuadros hasta escala 1 ± 0.02, escala inicial y sobrepaso',
			tomas: 'cortes por salto de miniatura de luma 27×48; la toma principal = grupo de tomas parecidas (≥ 55 % de bloques, tolerando zoom 1–1.6) con más duración',
			sfx: `onset a ±${VENTANA_SFX_CUADROS} cuadros (fps nativos) de la aparición; "confiable" = visto por clic, tono, golpe o lateral; % esperado al azar = fracción del video a ±${VENTANA_SFX_CUADROS} cuadros de algún onset`,
		},
		franja_subtitulos: franja,
		titular: r.titular,
		tomas: {cortes: cortes.length, principales: tomas.filter((t) => t.principal).length, inserts: tomas.filter((t) => !t.principal).length, capas_descartadas_dentro_de_insert: dentroDeInsert},
		eventos: conId,
		onsets: {archivo: null, n: onsets?.n_onsets ?? 0, lateral: onsets?.lateral.nota ?? 'N/A', nota: notaOnsets ?? (op.sinOnsets ? 'N/A: corrida con --sin-onsets' : null)},
		resumen: resumirReel(conId, duracionS, listaOnsets, fps),
		segundos: {
			pasada1: Number(r.segundos.pasada1.toFixed(1)),
			agrupar: Number(r.segundos.agrupar.toFixed(1)),
			pasada2: Number(r.segundos.pasada2.toFixed(1)),
			onsets: Number(((t2 - t1) / 1000).toFixed(1)),
			total: Number(((performance.now() - t0) / 1000).toFixed(1)),
		},
	};
}

/** Escribe overlays.json (y onsets.json al lado si se calcularon aquí). Devuelve las rutas. */
export function escribirReporte(rep: ReporteOverlays, salida: string, onsets: ReporteOnsets | null): {overlays: string; onsets: string | null} {
	mkdirSync(dirname(salida), {recursive: true});
	let rutaOnsets: string | null = null;
	if (onsets) {
		rutaOnsets = join(dirname(salida), 'onsets.json');
		writeFileSync(rutaOnsets, `${JSON.stringify(onsets, null, '\t')}\n`);
		rep.onsets.archivo = relative(RAIZ, rutaOnsets);
	}
	writeFileSync(salida, `${JSON.stringify(rep, null, '\t')}\n`);
	return {overlays: salida, onsets: rutaOnsets};
}

function leerFranja(texto: string | undefined): [number, number] | undefined {
	if (!texto) return undefined;
	const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(texto.trim());
	if (!m || Number(m[1]) >= Number(m[2])) {
		throw fallo('leer --franja', `"${texto}" no es y0,y1 con y0 < y1`, 'usa, por ejemplo, --franja 1420,1580 (base 1920)', 2);
	}
	return [Number(m[1]), Number(m[2])];
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({
		allowPositionals: true,
		options: {salida: {type: 'string'}, franja: {type: 'string'}, 'sin-onsets': {type: 'boolean'}},
	});
	if (positionals.length !== 1) {
		throw fallo('buscar capas', 'falta el video (o sobran argumentos)', 'usa: npx tsx herramientas/estilo/overlays.ts <reel.mp4> [--salida x.json] [--franja 1420,1580] [--sin-onsets]', 2);
	}
	const video = resolve(positionals[0]);
	if (!existsSync(video)) throw fallo(`buscar capas en ${basename(video)}`, `no existe ${video}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2);
	const salida = resolve(values.salida ?? salidaPorDefecto(video, 'overlays.json'));
	const onsets = values['sin-onsets'] ? null : await analizarOnsets(video);
	const rep = await analizarReel(video, {franja: leerFranja(values.franja), onsets, sinOnsets: values['sin-onsets'], alProgreso: (m) => console.log(`· ${m}`)});
	const rutas = escribirReporte(rep, salida, onsets);
	const r = rep.resumen;
	console.log(`${basename(video)}: ${rep.eventos.length} eventos en ${rep.duracion_s} s (${r.por_clase.sticker} stickers, ${r.por_clase.tarjeta} tarjetas, ${r.por_clase.insert} inserts, ${r.por_clase.otro} otros).`);
	console.log(`  por minuto: stickers ${r.stickers_por_min.valor} · tarjetas ${r.tarjetas_por_min.valor} · inserts ${r.inserts_por_min.valor}`);
	console.log(`  con SFX ${r.pct_con_sfx.valor ?? 'N/A'} % (al azar ${r.pct_esperado_al_azar.valor ?? 'N/A'} %) · confiable ${r.pct_con_sfx_confiable.valor ?? 'N/A'} % (al azar ${r.pct_esperado_al_azar_confiable.valor ?? 'N/A'} %)`);
	console.log(`Tiempo: ${rep.segundos.total} s. Detalle: ${relative(RAIZ, rutas.overlays)}`);
}

if (esPrincipal(import.meta.url)) void correr(main);
