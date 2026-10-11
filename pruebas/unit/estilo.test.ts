/**
 * Pruebas del estilo aprendido (Fase 2, cierre):
 * - agregar.ts: cuantiles ponderados, una cifra por reel y luego entre reels (los N/A no cuentan), capas de un reel con su
 *   SFX y si tapan la cabeza, adelanto de subtítulos, filtro de reels sin tu estilo de subtítulo, prob. de silencio
 *   corregida por azar, alias de claves y momentos.jsonl.
 * - lib/estilo.ts: esquema, revisión de métricas {valor|N/A, n, fuente, falta}, getters y leerEstilo/leerMomentos.
 * - Compatibilidad con quien lee estilo.json: leerMiniEstilo (subtitulos.ts), estiloSfxDesde (lib/sfx.ts) y el estilo del
 *   director (lib/director/estilo.ts). Si ya existe el estilo/estilo.json real, también se prueba con él.
 * - aprender.ts (partes puras): conjunto de reels, franja para overlays, cierre de imports, sonoridad con compuertas,
 *   nivel del SFX por resta de potencias y parecido de máscaras de texto.
 * Todo corre dentro del sandbox: sin Vision, sin ffmpeg y sin tocar tus archivos.
 */
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {
	adelantosSubtitulos,
	capasDeReel,
	construirEstilo,
	cuantilPonderado,
	estadisticasDeReel,
	metricaPorReel,
	momentosDe,
	normalizar,
	seccionCortes,
	type DatosReel,
	type Extra,
} from '../../herramientas/estilo/agregar.ts';
import {
	armarConjunto,
	cierreDeImports,
	franjaParaOverlays,
	fuenteDeFuncion,
	integradaConCompuertas,
	mascaraRellenoEncerrado,
	nivelDeEvento,
	parecidoMascaras,
	recortarMascara,
	vozIntegrada,
	type ReelConjunto,
} from '../../herramientas/estilo/aprender.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {ZONA_NEUTRA} from '../../herramientas/lib/perfil-estilo.ts';
import {
	configTarjetas,
	configTitular,
	densidades,
	estilosEdl,
	franjaSubtitulos,
	leerEstilo,
	leerMomentos,
	MetricaEsquema,
	problemasDelEstilo,
	revisarMetricas,
	tapaCabezaMaxima,
	zonaUi,
} from '../../herramientas/lib/estilo.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {estiloSfxDesde} from '../../herramientas/lib/sfx.ts';
import {leerMiniEstilo} from '../../herramientas/subtitulos.ts';

const tmp = mkdtempSync(join(tmpdir(), 'estilo-test-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

// ───────────────────────── reels falsos ─────────────────────────

type OpReel = {
	sc: string;
	grupo?: ReelConjunto['grupo'];
	reciente?: boolean;
	puntaje?: number | null;
	dur?: number;
	subs?: number;
	ySubs?: number;
	colorTexto?: string;
	tarjetas?: Array<{desde: number; texto: string; y?: number; lista?: string | null; desfase?: number}>;
	stickers?: Array<{desde: number; x?: number; y?: number; w?: number}>;
	onsets?: number[];
	titular?: boolean;
	cara?: {barbilla: number; coronilla: number; x: number; w: number};
	palabras?: Array<{t: string; d: number; h: number}>;
};

function reelFalso(o: OpReel): DatosReel {
	const dur = o.dur ?? 60;
	const reel: ReelConjunto = {
		shortCode: o.sc,
		mp4: `/no/existe/${o.sc}.mp4`,
		grupo: o.grupo ?? 'recientes',
		en_muestra: true,
		puntaje: o.puntaje === undefined ? 1 : o.puntaje,
		rank: null,
		publicado_en: '2026-09-01T00:00:00.000Z',
		resolucion: '1440x2560',
		fps: 30,
		duracion_s: dur,
		reciente: o.reciente ?? true,
	};
	const nSubs = o.subs ?? 40;
	const eventos = Array.from({length: nSubs}, (_, i) => ({
		id: `e${i}`,
		texto: i % 2 ? 'hola mundo' : 'esto es',
		palabras: 2,
		lineas: 1,
		mayusculas: false,
		confianza: 1,
		nDesde: i * 30,
		nHasta: i * 30 + 15,
		desde: i * 1,
		hasta: i * 1 + 0.5,
		duracion: 0.5,
		x: 540,
		y: (o.ySubs ?? 1500) + (i % 3) - 1,
		ancho: 300 + (i % 5) * 20,
		alto_caja: 60,
		alto_mayuscula: 43,
		color_texto: o.colorTexto ?? '#FEFBFF',
		color_borde: '#040001',
		grosor_borde: 4,
		confianza_color: 1,
		resaltado: [],
	}));
	const ys = eventos.map((e) => e.y).sort((a, b) => a - b);
	const subtitulos = {
		video: reel.mp4,
		ancho: 1440,
		alto: 2560,
		fps: 30,
		duracion_s: dur,
		n: nSubs,
		eventos,
		resumen: {
			y_p10: ys[Math.floor(nSubs * 0.1)] ?? null,
			y_p50: ys[Math.floor(nSubs * 0.5)] ?? null,
			y_p90: ys[Math.floor(nSubs * 0.9)] ?? null,
			ancho_p90: 380,
			alto_mayuscula_p50: 43,
			color_texto: o.colorTexto ?? '#FEFBFF',
			color_borde: '#040001',
			grosor_borde_p50: 4,
			palabras_por_evento: {p10: 1, p50: 2, p90: 3},
			duracion: {p10: 0.3, p50: 0.5, p90: 0.8},
			mayusculas_pct: 0,
			una_linea_pct: 100,
			resaltado_pct: 0,
			resaltado_modos: {color: 0, peso: 0, escala: 0},
			n_por_metrica: {},
		},
	};
	const tarjetas = (o.tarjetas ?? []).map((t, i) => {
		const y = t.y ?? 1280;
		return {
			id: `t${i + 1}`,
			texto: t.texto,
			lineas: 1,
			confianza_ocr: 1,
			nDesde: Math.round(t.desde * 30),
			nHasta: Math.round(t.desde * 30) + 24,
			desde: t.desde,
			hasta: t.desde + 0.8,
			duracion: 0.8,
			caja: {x: 540, y, w: 400, h: 118},
			orillas: {x0: 340, y0: y - 59, x1: 740, y1: y + 59},
			radio: 16,
			padding: {h: 24, v: 30},
			padding_detalle: {izq: 24, der: 24, arriba: 30, abajo: 36},
			padding_mayuscula: {arriba: 30, abajo: 36},
			alto_mayuscula: 52,
			alto_mayuscula_fuente: 'tinta',
			x_altura: 38,
			tallo: 11,
			peso: 0.214,
			color_caja: '#FEFBFF',
			color_texto: '#020002',
			emoji: false,
			alineacion: 'centro',
			grande: false,
			escritura: false,
			texto_inicial: '',
			fragmentos: 1,
			lista: t.lista ?? null,
			palabras: t.texto.split(/\s+/).length,
			mayuscula_inicial: true,
			digitos: /\d/.test(t.texto),
			tipo_palabra: 'clave',
			entrada: 'corte',
			salida: 'corte',
			anim_entrada_cuadros: 0,
			anim_salida_cuadros: 0,
			habla: {tipo: 'literal', cobertura: 1, cobertura_contenido: 1, palabras: [0], texto_dicho: t.texto, inicio_habla: t.desde, desfase_s: (t.desfase ?? -1) / 30, desfase_cuadros: t.desfase ?? -1, numero_en_digitos: null},
			n_medicion: 1,
		};
	});
	const capas = {
		version: 1,
		video: reel.mp4,
		nombre: o.sc,
		ancho: 1440,
		alto: 2560,
		fps: 30,
		duracion_s: dur,
		total_cuadros: dur * 30,
		titular:
			o.titular === false
				? {presente: false, motivo: 'no hay', lecturas: 10}
				: {
						presente: true,
						texto: 'Un titular\nde prueba',
						n_lineas: 2,
						lineas: [
							{texto: 'Un titular', presencia: 1, x_centro: 540, y_centro: 300, ancho: 700, alto_caja: 80, alto_mayuscula: 58, alto_mayuscula_tinta: 52, x_altura: 38, linea_base: 330, color_texto: '#FEFEFE', contorno: {color: '#020000', grosor: 3.75}, tallo: 11, peso: 0.2, halo: null, n_cuadros: 6},
							{texto: 'de prueba', presencia: 1, x_centro: 540, y_centro: 385, ancho: 600, alto_caja: 80, alto_mayuscula: 58, alto_mayuscula_tinta: 52, x_altura: 38, linea_base: 415, color_texto: '#FEFEFE', contorno: {color: '#020000', grosor: 3.75}, tallo: 11, peso: 0.2, halo: null, n_cuadros: 6},
						],
						y_primera_linea: 300,
						interlineado: 85,
						y_abajo: 425,
						sombra_suave: false,
						tipografia_vs_subtitulos: {veredicto: 'no concluyente'},
						lecturas: 40,
					},
		tarjetas,
		listas: [],
		resumen: {},
		habla: {fuente: 'x', palabras: 10, metodo: 't_dtw'},
		descartados: [],
		descartes_por_motivo: {},
		cuadros_escaneados: dur * 30,
		tiempos_s: {},
	};
	const eventosOv = (o.stickers ?? []).map((s, i) => ({
		id: `e${String(i + 1).padStart(3, '0')}`,
		clase: 'sticker',
		subtipo: 'capa',
		desde_cuadro: Math.round(s.desde * 30),
		hasta_cuadro: Math.round(s.desde * 30) + 21,
		desde: s.desde,
		hasta: s.desde + 0.7,
		duracion_s: 0.7,
		caja: {x: (s.x ?? 540) - (s.w ?? 300) / 2, y: (s.y ?? 1250) - (s.w ?? 300) / 2, w: s.w ?? 300, h: s.w ?? 300},
		centro: {x: s.x ?? 540, y: s.y ?? 1250},
		entrada: {cuadros: 5, escala_inicial: 0.58, sobrepaso: 0, escalas: []},
		apariencia: null,
		sfx: null,
		nota: null,
	}));
	const overlays = {
		version: 1,
		generado_por: 'x',
		fuente: reel.mp4,
		fps: 30,
		cuadros: dur * 30,
		duracion_s: dur,
		resolucion: '1440×2560',
		metodo: {},
		franja_subtitulos: [1420, 1580],
		titular: null,
		tomas: {cortes: 0, principales: 1, inserts: 0, capas_descartadas_dentro_de_insert: 0},
		eventos: eventosOv,
		onsets: {archivo: null, n: 0, lateral: '', nota: null},
		resumen: {secuencias_de_insert_por_min: {valor: 0, n: 0}},
		segundos: {},
	};
	const onsets = o.onsets ? {onsets: o.onsets.map((t) => ({t, fuentes: ['clic'], margen_db: 10})), lateral: {usado: false, diferencia_db: null, nota: ''}} : null;
	const cara = o.cara
		? {
				fps: 30,
				cuadros: Array.from({length: dur * 30}, (_, j) => ({
					t: j / 30,
					cara: {x: o.cara!.x, y: o.cara!.coronilla + 50, w: o.cara!.w, h: o.cara!.barbilla - o.cara!.coronilla - 50},
					barbilla_y: o.cara!.barbilla,
					coronilla_y: o.cara!.coronilla,
					cabeza: {x: o.cara!.x - 20, y: o.cara!.coronilla, w: o.cara!.w + 40, h: o.cara!.barbilla - o.cara!.coronilla},
					confianza: 1,
				})),
			}
		: null;
	return {
		reel,
		peso: reel.puntaje ?? 1,
		subtitulos: subtitulos as unknown as DatosReel['subtitulos'],
		capas: capas as unknown as DatosReel['capas'],
		overlays: overlays as unknown as DatosReel['overlays'],
		onsets: onsets as unknown as DatosReel['onsets'],
		zooms: {candidatos: 2, confirmados: 0, descartados: 0, por_veredicto: {'sin-zoom': 2}, duracion_s: dur, cobertura: 1, zooms: [{t: 5, razon: 1.1, tipo: 'acercar', fondo: {veredicto: 'sin-zoom'}}, {t: 9, razon: 0.9, tipo: 'alejar', fondo: {veredicto: 'sin-zoom'}}]},
		nivel: {voz: {lufs_integrado: -16, rms_mediana_dbfs: -20}, lateral: null, eventos: [{id: 'e001', clase: 'sticker', onset_s: 1, confiable: true, m_antes: -17, m_despues: -13, m_sfx: -15.2, lu_vs_voz: 0.8, rms_pico_dbfs: -14, db_vs_voz_rms: 6}]},
		transcripcion: {palabras: o.palabras ?? []},
		cara,
		registro: null,
	};
}

const CORPUS_FALSO: Extra['corpus'] = {
	dueno: {username: 'creador-demo', id: '1234567890'},
	ranking: {mediana_puntaje: 1, n: 3},
	resumen: {},
	reels: [
		{shortCode: 'A1', mp4: '/x/A1.mp4', puntaje: 10},
		{shortCode: 'B2', mp4: '/x/B2.mp4', puntaje: 1},
		{shortCode: 'C3', mp4: null, puntaje: 0.5},
	],
	top10: [{rank: 1, shortCode: 'A1', mp4: '/x/A1.mp4', puntaje: 10, falta: null}],
};

const extraFalso = (otro: Partial<Extra> = {}): Extra => ({
	corpus: CORPUS_FALSO,
	muestra: {n: {top: 1, recientes: 2, resto: 0, total: 3}},
	encuadre: null,
	calibracionCortes: null,
	tipografia: {
		version: 1,
		generado_en: 'x',
		metodo: 'prueba',
		capas: {
			subtitulos: {n_muestras: 6, reels: ['R1', 'R2'], ranking: [{id: 'tiktok-sans', peso: 800, parecido_p50: 0.9, ancho_rel_p50: 1.01, tinta_rel_p50: 1.02, n: 6}]},
			titular: {n_muestras: 4, reels: ['R1'], ranking: [{id: 'tiktok-sans', peso: 800, parecido_p50: 0.88, ancho_rel_p50: 1, tinta_rel_p50: 1, n: 4}]},
			tarjetas: {n_muestras: 0, reels: [], ranking: [], nota: 'sin recortes'},
		},
	},
	mp4Existe: () => true,
	fecha: '2026-10-03T00:00:00.000Z',
	...otro,
});

function estiloDePrueba(): {estilo: Record<string, unknown>; datos: DatosReel[]} {
	const datos = [
		reelFalso({sc: 'R1', puntaje: 3, tarjetas: [{desde: 2, texto: 'Claude Code'}, {desde: 10, texto: 'Gratis'}], stickers: [{desde: 5}], onsets: [2.02, 30], palabras: [{t: 'Claude', d: 2.03, h: 2.4}, {t: 'Code', d: 2.4, h: 2.7}], cara: {barbilla: 1040, coronilla: 500, x: 380, w: 320}}),
		reelFalso({sc: 'R2', puntaje: 1, tarjetas: [{desde: 4, texto: 'Opus'}], stickers: [{desde: 1}, {desde: 20}], onsets: [1.0, 20.03]}),
		reelFalso({sc: 'T1', grupo: 'top', reciente: false, puntaje: 20, tarjetas: [], stickers: [], titular: false}),
	];
	const estilo = construirEstilo(datos.map(estadisticasDeReel), extraFalso());
	return {estilo, datos};
}

// ───────────────────────── agregar.ts ─────────────────────────

describe('agregación entre reels', () => {
	it('cuantil ponderado: con pesos iguales es la mediana de siempre; el peso mueve la mediana', () => {
		expect(cuantilPonderado([{v: 1, w: 1}, {v: 3, w: 1}], 0.5)).toBe(2);
		expect(cuantilPonderado([{v: 1, w: 1}, {v: 2, w: 1}, {v: 9, w: 1}], 0.5)).toBe(2);
		expect(cuantilPonderado([{v: 1, w: 10}, {v: 9, w: 1}], 0.5)).toBe(1);
		expect(cuantilPonderado([{v: 5, w: 0}], 0.5)).toBeNull();
		expect(cuantilPonderado([], 0.5)).toBeNull();
	});

	it('una cifra por reel y luego la mediana entre reels; los N/A (null) no cuentan ni en el valor ni en n', () => {
		const m = metricaPorReel(
			[
				{sc: 'a', v: 10, w: 1, n: 50},
				{sc: 'b', v: 20, w: 1, n: 5},
				{sc: 'c', v: null, w: 1, n: 0},
				{sc: 'd', v: 30, w: 1, n: 1},
			],
			{ponderar: false, fuente: 'prueba', unidad: 'u', falta: 'nada', entreReels: true},
		);
		expect(m.valor).toBe(20);
		expect(m.n).toBe(3);
		expect(m.n_eventos).toBe(56);
		expect(m.por_reel).toEqual({a: 10, b: 20, d: 30});
		expect(m.p10).toBeGreaterThanOrEqual(10);
		expect(m.p90).toBeLessThanOrEqual(30);
		expect(MetricaEsquema.safeParse(m).success).toBe(true);
	});

	it('sin ningún valor es N/A con lo que falta, y pasa el esquema', () => {
		const m = metricaPorReel([{sc: 'a', v: null, w: 1}], {ponderar: true, fuente: 'prueba', unidad: 'u', falta: 'no hay nada medido'});
		expect(m.valor).toBe('N/A');
		expect(m.n).toBe(0);
		expect(m.falta).toBe('no hay nada medido');
		expect(MetricaEsquema.safeParse(m).success).toBe(true);
	});

	it('ponderado con el puntaje: el reel de puntaje alto manda, y también se reporta sin ponderar', () => {
		const m = metricaPorReel(
			[
				{sc: 'viral', v: 30, w: 20},
				{sc: 'r1', v: 10, w: 1},
				{sc: 'r2', v: 12, w: 1},
			],
			{ponderar: true, fuente: 'prueba', unidad: 'u', falta: 'x'},
		);
		expect(m.valor).toBe(30);
		expect(m.sin_ponderar).toBe(12);
	});

	it('normalizar quita acentos, mayúsculas y signos', () => {
		expect(normalizar('¿Cómo?')).toBe('como');
		expect(normalizar('Niño,')).toBe('nino');
	});

	it('adelanto de subtítulos: inicio de la 1.ª palabra − inicio del subtítulo, emparejando por texto', () => {
		const a = adelantosSubtitulos(
			[
				{texto: 'Hola mundo', desde: 1.0},
				{texto: 'nada que ver', desde: 5},
			],
			[
				{t: 'hola', d: 1.05},
				{t: 'Hola', d: 3},
				{t: 'otra', d: 5},
			],
		);
		expect(a).toHaveLength(1);
		expect(a[0]).toBeCloseTo(0.05, 6);
	});
});

describe('capas y estadísticas de un reel', () => {
	it('junta tarjetas (capas.json) y stickers (overlays.json), con su SFX a ±3 cuadros', () => {
		const d = reelFalso({sc: 'X', tarjetas: [{desde: 2, texto: 'Hola'}], stickers: [{desde: 5}], onsets: [2.05, 7]});
		const capas = capasDeReel(d);
		expect(capas.map((c) => c.clase)).toEqual(['tarjeta', 'sticker']);
		expect(capas[0].sfx?.con_sfx).toBe(true);
		expect(capas[0].sfx?.desfase_30).toBeCloseTo(1.5, 1);
		expect(capas[1].sfx?.con_sfx).toBe(false);
	});

	it('una capa cuyo borde de arriba sube sobre tu barbilla y se encima con tu cabeza la tapa; una debajo no', () => {
		const d = reelFalso({sc: 'X', stickers: [{desde: 5, y: 1000, w: 300}, {desde: 9, y: 1300, w: 300}], cara: {barbilla: 1040, coronilla: 500, x: 380, w: 320}});
		const [arriba, abajo] = capasDeReel(d);
		expect(arriba.tapa_cabeza).toBe(true);
		expect(abajo.tapa_cabeza).toBe(false);
		expect(abajo.sobre_barbilla).toBeCloseTo(1150 - 1040, 0);
		// Sin labios medidos, la boca se estima con barbilla − 0.18 × alto de la cara (lib/cara.ts → bocaMax).
		const boca = 1040 - 0.18 * (1040 - 500 - 50);
		expect(abajo.sobre_boca!).toBeCloseTo(1150 - boca, 0);
		expect(arriba.sobre_boca!).toBeLessThan(0);
	});

	it('un reel con menos de 10 subtítulos o con colores al revés no aporta al estilo de subtítulos', () => {
		expect(estadisticasDeReel(reelFalso({sc: 'pocos', subs: 6})).subs.aporta).toBe(false);
		const invertido = estadisticasDeReel(reelFalso({sc: 'inv', colorTexto: '#070408'}));
		expect(invertido.subs.aporta).toBe(false);
		expect(invertido.subs.motivo).toMatch(/no son blancos/);
		expect(estadisticasDeReel(reelFalso({sc: 'ok'})).subs.aporta).toBe(true);
	});

	it('la probabilidad de silencio se corrige por lo que coincidiría por azar', () => {
		// 4 capas, 2 con un onset al lado: observado 0.5; los 2 onsets cubren ~0.23 s de 60 s (azar ≈ 0.4 %).
		const s = estadisticasDeReel(reelFalso({sc: 'X', tarjetas: [{desde: 2, texto: 'a b'}, {desde: 12, texto: 'c d'}], stickers: [{desde: 20}, {desde: 30}], onsets: [2.01, 20.02]}));
		expect(s.sfx.capas).toBe(4);
		expect(s.sfx.con_sfx).toBe(2);
		expect(s.sfx.pct_azar!).toBeLessThan(1);
		expect(s.sfx.prob_silencio!).toBeGreaterThan(0.49);
		expect(s.sfx.prob_silencio!).toBeLessThan(0.51);
	});
});

describe('estilo.json armado', () => {
	const {estilo, datos} = estiloDePrueba();

	it('cumple el esquema y cada métrica es {valor|N/A, n, fuente, falta}', () => {
		expect(problemasDelEstilo(estilo)).toEqual([]);
		const {problemas, conteo} = revisarMetricas(estilo);
		expect(problemas).toEqual([]);
		expect(conteo.total).toBe(conteo.medidas + conteo.na + conteo.supuestos);
		expect((estilo.resumen as {na: number}).na).toBe(conteo.na);
	});

	it('trae los alias que leen las otras herramientas (mismos valores)', () => {
		const e = estilo as Record<string, Record<string, unknown>>;
		expect(e.tarjetas.por_min).toEqual(e.tarjetas.por_minuto);
		expect(e.densidades.tarjetas_por_min).toEqual(e.tarjetas.por_minuto);
		expect(e.densidades.stickers_por_min).toEqual(e.stickers.por_minuto);
		expect(e.zooms.por_min).toEqual(e.zooms.por_minuto);
		expect(e.efectos.desenfoque_por_min).toEqual(e.efectos.desenfoque_por_minuto);
		expect(e.tarjetas.y).toEqual((e.tarjetas.centro_y as Record<string, unknown>).p50);
		expect(e.franja_subtitulos.y_p10).toEqual((e.subtitulos.franja as Record<string, unknown>).y_p10);
		expect(e.subtitulos.ancho_max).toEqual(e.subtitulos.ancho_p90);
		expect((e.stickers.ancho_px as Record<string, unknown>).p10).toBeDefined();
	});

	it('subtítulos y layout salen solo de los reels recientes; las densidades, de todos', () => {
		const e = estilo as Record<string, Record<string, {n: number; por_reel?: Record<string, unknown>}>>;
		expect(Object.keys(e.subtitulos.ancho_p90.por_reel ?? {}).sort()).toEqual(['R1', 'R2']);
		expect(Object.keys(e.tarjetas.por_minuto.por_reel ?? {}).sort()).toEqual(['R1', 'R2', 'T1']);
	});

	it('los parámetros externos van como supuesto (n = 0) y nunca como medidos', () => {
		const e = estilo as Record<string, Record<string, Record<string, {fuente: string; n: number}>>>;
		expect(e.supuestos.brag.gancho_s.fuente).toMatch(/^supuesto/);
		expect(e.supuestos.brag.gancho_s.n).toBe(0);
		expect(e.supuestos.zoom_demos.entra_antes_ms.fuente).toMatch(/^supuesto/);
		expect((e.textos.min_por_palabra_brag as unknown as {fuente: string}).fuente).toMatch(/^supuesto/);
	});

	it('la semántica (Gemini) y lo que no existe quedan N/A con su falta', () => {
		const e = estilo as Record<string, Record<string, Record<string, unknown>>>;
		expect(e.sfx.categorias_por_tipo.valor).toBe('N/A');
		expect(String(e.sfx.categorias_por_tipo.falta)).toMatch(/Gemini/);
		expect((e.cortes.parametros as {valor: string}).valor).toBe('N/A');
		expect((e.encuadre.barbilla_y as {valor: string}).valor).toBe('N/A');
		expect(e.sfx.mapeo).toBeUndefined();
	});

	it('los config usan lo medido y lo entienden los componentes (getters de lib/estilo.ts)', () => {
		writeFileSync(join(tmp, 'estilo.json'), JSON.stringify(estilo));
		const leido = leerEstilo(join(tmp, 'estilo.json'));
		expect(leido.hash).toMatch(/^estilo-[0-9a-f]{12}$/);
		// Decisión de zona explícita (como la de un estilo que baja textos y achica tarjetas), sin depender del estilo activo.
		const zona = {...ZONA_NEUTRA, subtitulos_y: 1545, bajada_capas_px: 46.5, tarjeta_letra: 0.88, tarjeta_relleno: 0.65, prompt_letra: 0.94, ancho_max: 810, nota: 'decisión de prueba'};
		const t = configTarjetas(leido.estilo, zona);
		// Lo medido (52 y 22) con la decisión encima: letra × 0.88 y relleno × 0.65.
		expect(t.alto_mayuscula_px).toBeCloseTo(52 * 0.88, 2);
		expect(t.pad_lados_px).toBeCloseTo(22 * 0.65, 2);
		expect(t.ancho_max).toBe(810);
		expect(t.entrada).toBe('corte');
		const tit = configTitular(leido.estilo);
		expect(tit.alto_mayuscula_px).toBe(52);
		expect(tit.borde_px).toBeCloseTo(3.75 + 0.4, 6);
		expect(tit.fuente).toBe('tiktok-sans');
		const edl = estilosEdl(leido.estilo, zona);
		expect(edl.subtitulos?.fuente).toBe('tiktok-sans');
		expect(edl.subtitulos?.peso).toBe(800);
		expect(edl.subtitulos?.y).toBe(1545); // la decisión de zona (medido ~1498)
		expect(franjaSubtitulos(leido.estilo).ancho_p90).toBe(380);
		expect(zonaUi(leido.estilo).arriba).not.toBeNull();
		expect(densidades(leido.estilo).tarjetas).not.toBeNull();
		expect(tapaCabezaMaxima(leido.estilo).medido).toBe(true);
	});

	it('leerEstilo falla con código 2 si una métrica N/A no dice qué falta', () => {
		const roto = JSON.parse(JSON.stringify(estilo));
		roto.tarjetas.por_minuto = {valor: 'N/A', n: 0, fuente: 'x', falta: null};
		writeFileSync(join(tmp, 'roto.json'), JSON.stringify(roto));
		let error: unknown;
		try {
			leerEstilo(join(tmp, 'roto.json'));
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		expect(() => leerEstilo(join(tmp, 'no-existe.json'))).toThrow(/no existe/);
	});

	it('compatibilidad: leerMiniEstilo (subtitulos.ts) lee la sección subtitulos de estilo.json', () => {
		const ruta = join(tmp, 'estilo-subs.json');
		writeFileSync(ruta, JSON.stringify(estilo));
		const m = leerMiniEstilo(ruta);
		expect(m.estilo.ancho_max).toBe(380);
		expect(m.estilo.y).toBeGreaterThan(1490);
		expect(m.altoMayusculaPx).toBe(43);
		expect(m.estilo.borde_px).toBe(4);
		expect(m.estilo.color).toBe('#FEFBFF');
		expect(m.estilo.color_borde).toBe('#040001');
		expect(m.estilo.mayusculas).toBe(false);
		expect(m.estilo.fuente).toBe('tiktok-sans');
		expect(m.estilo.peso).toBe(800);
		expect(m.parametros.duracionMinS).toBe(0.3);
		expect(m.parametros.palabrasObjetivo).toBe(2);
	});

	it('compatibilidad: estiloSfxDesde (lib/sfx.ts) toma prob_silencio, offset y eventos por video medidos', () => {
		const {estilo: sfx, notas} = estiloSfxDesde(estilo);
		const s = (estilo as Record<string, Record<string, {valor: unknown; n: number}>>).sfx;
		expect(sfx.prob_silencio.valor).toBe(s.prob_silencio.valor);
		expect(sfx.prob_silencio.n).toBe(s.prob_silencio.n);
		expect(sfx.prob_silencio.fuente).not.toBe('supuesto');
		expect(sfx.prob_silencio.p10).toBeLessThanOrEqual(sfx.prob_silencio.valor);
		expect(sfx.prob_silencio.p90).toBeGreaterThanOrEqual(sfx.prob_silencio.valor);
		expect(notas.some((n) => n.includes('prob_silencio sin valor'))).toBe(false);
	});

	it('compatibilidad: el estilo del director lee tarjetas y stickers por minuto, franja y zona UI de estilo.json', () => {
		const d = estiloDesde({estiloJson: estilo});
		expect(d.ritmo.tarjetas_por_min.fuente).toMatch(/estilo\/estilo\.json/);
		expect(d.ritmo.stickers_por_min.fuente).toMatch(/estilo\/estilo\.json/);
		expect(d.franja.y_p10.fuente).toMatch(/estilo\/estilo\.json/);
		expect(d.zona_ui.arriba.fuente).toMatch(/estilo\/estilo\.json/);
		expect(d.tarjeta.y.fuente).toMatch(/estilo\/estilo\.json/);
		expect(d.min_por_palabra_s.fuente).toMatch(/estilo\/estilo\.json/);
	});

	it('momentos.jsonl: una línea por capa con lo que dijiste alrededor, y leerMomentos lo valida', () => {
		const stats = datos.map(estadisticasDeReel);
		const momentos = momentosDe(stats, (sc) => datos.find((d) => d.reel.shortCode === sc)?.transcripcion?.palabras ?? []);
		expect(momentos).toHaveLength(datos.reduce((s, d) => s + capasDeReel(d).length, 0));
		const tarjeta = momentos.find((m) => m.texto === 'Claude Code')!;
		expect(tarjeta.palabras_dichas).toBe('Claude Code');
		expect(tarjeta.con_sfx).toBe(true);
		expect(tarjeta.segmento).toBe('gancho');
		expect(tarjeta.reel).toBe('R1');
		const ruta = join(tmp, 'momentos.jsonl');
		writeFileSync(ruta, momentos.map((m) => JSON.stringify(m)).join('\n') + '\n');
		expect(leerMomentos(ruta)).toHaveLength(momentos.length);
		writeFileSync(join(tmp, 'momentos-roto.jsonl'), '{"reel": "x"}\n');
		expect(() => leerMomentos(join(tmp, 'momentos-roto.jsonl'))).toThrow(FalloEditor);
	});

	it('arranque del SFX: el selector recibe solo la parte del rango medido que cumple la regla del plan (−2…0)', () => {
		const tarde = (sc: string, lag: number) =>
			reelFalso({sc, tarjetas: [1, 5, 9, 13, 17, 21].map((t) => ({desde: t, texto: 'a b'})), onsets: [1, 5, 9, 13, 17, 21].map((t) => t + lag / 30)});
		const conLag = (lag: number) => construirEstilo([tarde('L1', lag), tarde('L2', lag)].map(estadisticasDeReel), extraFalso()) as Record<string, Record<string, Record<string, unknown>>>;
		const casi = conLag(0.6);
		expect(casi.sfx.offset_medido_cuadros.valor).toEqual([1, 1]);
		expect(casi.sfx.offset_cuadros.valor).toBe('N/A');
		expect(String(casi.sfx.offset_cuadros.falta)).toMatch(/fuera de la regla/);
		const justo = conLag(0);
		expect(justo.sfx.offset_cuadros.valor).toEqual([0, 0]);
		const {estilo: sfx} = estiloSfxDesde(justo);
		expect(sfx.offset_cuadros.valor).toEqual([0, 0]);
		expect(revisarMetricas(casi).problemas).toEqual([]);
	});

	it('cortes: con calibracion-cortes.json se integra con su n; sin él, N/A', () => {
		const sin = seccionCortes(null);
		expect((sin.parametros as {valor: string}).valor).toBe('N/A');
		const con = seccionCortes({n_pares: 2, parametros: {huecoMinimoS: 0.3}, por_par: [{cortes_por_min_publicado: 10}, {cortes_por_min_publicado: 12}], velocidad: {factor: 1.09}});
		expect((con.cortes_por_min as {valor: number; n: number}).valor).toBe(11);
		expect((con.parametros as {n: number}).n).toBe(2);
		expect(revisarMetricas(con).problemas).toEqual([]);
	});
});

// ───────────────────────── aprender.ts (partes puras) ─────────────────────────

describe('aprender.ts', () => {
	it('el conjunto: la muestra + lo medido antes, sin pares de prueba ni reels fuera del corpus', () => {
		const corpus = {
			dueno: {username: 'creador-demo', id: '1234567890'},
			ranking: {mediana_puntaje: 1},
			top10: [],
			reels: [
				{shortCode: 'M1', publicado_en: '2026-03-01T00:00:00Z', duracion_s: 30, resolucion: '720x1280', fps: 30, mp4: '/a/M1.mp4', puntaje: 9, rank: 1},
				{shortCode: 'P1', publicado_en: '2026-09-01T00:00:00Z', duracion_s: 30, resolucion: '1440x2560', fps: 30, mp4: '/a/P1.mp4', puntaje: null, rank: null},
				{shortCode: 'V1', publicado_en: '2026-08-01T00:00:00Z', duracion_s: 30, resolucion: '1440x2560', fps: 30, mp4: '/a/V1.mp4', puntaje: null, rank: null},
			],
		};
		const muestra = {reels: [{grupo: 'top' as const, shortCode: 'M1', mp4: '/a/M1.mp4'}]};
		const {reels, avisos} = armarConjunto(corpus, muestra, ['P1', 'V1', 'OTRA'], new Set(['P1']));
		expect(reels.map((r) => r.shortCode)).toEqual(['M1', 'V1']);
		expect(reels[1]).toMatchObject({grupo: 'recientes', en_muestra: false, reciente: true});
		expect(avisos.join(' ')).toMatch(/P1 es un par de prueba/);
		expect(avisos.join(' ')).toMatch(/OTRA no está en estilo\/corpus\.json/);
	});

	it('franja para overlays: la de siempre si tus subtítulos van al centro; se ensancha si no', () => {
		expect(franjaParaOverlays(null)).toEqual([1420, 1580]);
		expect(franjaParaOverlays({n: 100, resumen: {y_p10: 1495, y_p90: 1503}})).toEqual([1420, 1580]);
		expect(franjaParaOverlays({n: 30, resumen: {y_p10: 1447, y_p90: 1458}})).toEqual([1372, 1580]);
		expect(franjaParaOverlays({n: 5, resumen: {y_p10: 1200, y_p90: 1250}})).toEqual([1420, 1580]);
	});

	it('el cierre de imports sigue rutas relativas con y sin extensión', () => {
		const d = join(tmp, 'mods');
		mkdirSync(join(d, 'lib'), {recursive: true});
		writeFileSync(join(d, 'a.ts'), "import {b} from './lib/b.ts';\nimport x from 'zod';\nexport const a = b;\n");
		writeFileSync(join(d, 'lib', 'b.ts'), "export {c} from './c';\nexport const b = 1;\n");
		writeFileSync(join(d, 'lib', 'c.ts'), 'export const c = 2;\n');
		expect(cierreDeImports(join(d, 'a.ts')).map((r) => r.slice(d.length + 1))).toEqual(['a.ts', 'lib/b.ts', 'lib/c.ts']);
	});

	it('la huella de una etapa puede tomar solo una función de un archivo (fuenteDeFuncion)', () => {
		mkdirSync(join(tmp, 'mods'), {recursive: true});
		const ruta = join(tmp, 'mods', 'cli.ts');
		writeFileSync(ruta, "export function otra() {\n\treturn 1;\n}\n\nexport async function medir(x: number) {\n\treturn x * 2;\n}\n\nfunction main() {}\n");
		expect(fuenteDeFuncion(ruta, 'medir')).toBe('export async function medir(x: number) {\n\treturn x * 2;\n}');
		expect(fuenteDeFuncion(join(tmp, 'no-existe.ts'), 'medir')).toBe('');
	});

	it('sonoridad integrada con compuertas EBU: ignora el silencio (−70) y lo que va 10 LU abajo', () => {
		expect(integradaConCompuertas([-20, -20, -20])).toBeCloseTo(-20, 6);
		expect(integradaConCompuertas([-20, -20, -80, -45])).toBeCloseTo(-20, 6);
		expect(integradaConCompuertas([])).toBeNull();
		const voz = vozIntegrada(
			[
				[1.0, -18],
				[1.1, -18],
				[2.0, -5],
			],
			[{d: 0.5, h: 2.5}],
			[1.85],
		);
		expect(voz.n).toBe(2);
		expect(voz.lufs).toBeCloseTo(-18, 6);
	});

	it('nivel del SFX: resta de potencias contra tu voz justo antes; sin subida de 1 dB no hay dato', () => {
		const bloques: Array<[number, number]> = [
			[0.9, -20],
			[1.2, -20],
			[1.3, -17],
			[1.4, -16.99],
		];
		const sin = {pico: () => null, vozDb: null};
		const n = nivelDeEvento({id: 'e1', clase: 'sticker', onset_s: 1.0, confiable: true}, bloques, -20, sin);
		// −17 ≈ el doble de potencia que −20: el SFX solo ≈ −20, o sea 0 LU contra la voz.
		expect(n.m_sfx!).toBeCloseTo(-20, 0);
		expect(n.lu_vs_voz!).toBeCloseTo(0, 0);
		const plano = nivelDeEvento({id: 'e2', clase: 'sticker', onset_s: 1.0, confiable: true}, [[0.9, -20], [1.2, -19.5]], -20, sin);
		expect(plano.m_sfx).toBeNull();
		expect(plano.lu_vs_voz).toBeNull();
	});

	it('máscaras de texto: el relleno encerrado por el contorno y el parecido (IoU) de dos máscaras', () => {
		// Un cuadrado blanco de 10×10 con contorno negro de 2 px, sobre fondo gris claro.
		const w = 30;
		const h = 30;
		const rgba = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const o = (y * w + x) * 4;
				const dentro = x >= 10 && x < 20 && y >= 10 && y < 20;
				const borde = x >= 8 && x < 22 && y >= 8 && y < 22 && !dentro;
				const v = dentro ? 250 : borde ? 10 : 200;
				rgba[o] = v;
				rgba[o + 1] = v;
				rgba[o + 2] = v;
				rgba[o + 3] = 255;
			}
		}
		const m = recortarMascara(mascaraRellenoEncerrado(rgba, w, h))!;
		expect(m.w).toBe(10);
		expect(m.h).toBe(10);
		expect(parecidoMascaras(m, m).iou).toBe(1);
		const mitad = {w: 5, h: 10, px: new Uint8Array(50).fill(1)};
		const p = parecidoMascaras(m, mitad);
		expect(p.iou).toBeCloseTo(0.5, 2);
		expect(p.ancho_rel).toBe(0.5);
	});
});

// ───────────────────────── con el estilo real (si ya se generó) ─────────────────────────

const RUTA_REAL = join(RAIZ, 'estilo', 'estilo.json');

describe.runIf(existsSync(RUTA_REAL))('estilo/estilo.json real', () => {
	// La plantilla trae un estilo.json neutro (version '0.0.0-plantilla', métricas "supuesto" con n = 0).
	const medido = (() => {
		try {
			const crudo = JSON.parse(readFileSync(RUTA_REAL, 'utf8')) as {version?: string};
			return crudo.version !== '0.0.0-plantilla' && leerEstilo(RUTA_REAL).conteo.medidas > 0;
		} catch {
			return false;
		}
	})();
	it.runIf(medido)('pasa leerEstilo (esquema + métricas) y trae los reels medidos', () => {
		const leido = leerEstilo(RUTA_REAL);
		expect(leido.conteo.medidas).toBeGreaterThan(50);
		expect(revisarMetricas(leido.crudo).problemas).toEqual([]);
	});

	it('leerMiniEstilo lo entiende sin fallar y estiloSfxDesde toma su prob_silencio', () => {
		const m = leerMiniEstilo(RUTA_REAL);
		expect(m.estilo.y).toBeGreaterThan(1300);
		expect(m.estilo.ancho_max).toBeGreaterThan(200);
		const crudo = JSON.parse(readFileSync(RUTA_REAL, 'utf8'));
		const {estilo} = estiloSfxDesde(crudo);
		if (crudo.sfx?.prob_silencio?.valor !== 'N/A') expect(estilo.prob_silencio.fuente).not.toBe('supuesto');
	});
});
