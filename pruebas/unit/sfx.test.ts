// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de la biblioteca de SFX y del selector (Fase 3):
 * - lib/sfx.ts: semilla, conteo de fuentes (síntesis máx. 2, variantes y pendientes no cuentan), mapeo sin
 *   salida de escape, estilo supuesto, historial, ebur128, casi iguales y procesamiento de audio con ffmpeg
 *   (silencio inicial, pico a −1 dBTP, sha256 del audio decodificado, variantes de ±1 semitono);
 * - sintesis.ts: cada receta suena, dura lo que dice y sus 2 diseños por categoría son distintos;
 * - catalogar.ts: aprobación de pops, hoja de candidatos y el catálogo real (si ya se generó);
 * - elegir.ts: reglas duras con un revisor independiente, determinismo, respaldo de tipo, silencio por
 *   video, offsets, nivel bajo la voz, historial entre videos, EDL y CLI;
 * - simulación de 1,000 videos con el catálogo real (si existe) y con uno mínimo de 5 fuentes por categoría.
 * Todo corre dentro del sandbox (ffmpeg sí; nada de Chrome, GPU ni Vision).
 */
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {EdicionBase, type Edicion} from '../../src/esquema/edicion.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {
	agruparCasiIguales,
	aEstereo,
	CatalogoEsquema,
	contarFuentes,
	contextoHistorial,
	crearAleatorio,
	decodificar,
	duracionDe,
	elegirConPeso,
	escribirWav,
	ESTILO_SFX_SUPUESTO,
	estiloSfxDesde,
	hash32,
	huella,
	inicioMs,
	leerCatalogo,
	MAPEO_SUPUESTO,
	mapearEventos,
	mapeoDesdeEstilo,
	medirSonoridad,
	muestrasDe,
	parsearMetadatosEbur128,
	prepararSfx,
	problemasDelCatalogo,
	registrarVideo,
	REGLAS_SFX,
	RUTA_CATALOGO,
	sha256AudioDecodificado,
	sha256DeArchivo,
	similitudHuellas,
	TIPOS_EVENTO,
	type ArchivoSfx,
	type Audio,
	type Catalogo,
	type EstiloSfx,
	type HistorialSfx,
} from '../../herramientas/lib/sfx.ts';
import {RECETAS, sintetizar} from '../../herramientas/sfx/sintesis.ts';
import {acomodarHoja, aKebab, familiaKenney, idVariante, interpretarAprobacion, markdownLicencias, normalizarYEscribir, numeroVariante, revisarArchivos} from '../../herramientas/sfx/catalogar.ts';
import {aplicarAEdicion, elegirSfx, eventosDeEdicion, eventosSimulados, rangoSilencios, revisarReglas, simularVideos, type Eleccion, type EventoSfx} from '../../herramientas/sfx/elegir.ts';
import {catalogoConDatos} from './requisitos.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sfx-'));
afterAll(() => rmSync(tmp, {recursive: true, force: true}));

const clonar = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ───────────────────────────── Catálogos de prueba ─────────────────────────────

function archivoFalso(x: {id: string; categoria: string; fuente_id: string} & Partial<ArchivoSfx>): ArchivoSfx {
	return {
		archivo: `biblioteca/sfx/${x.categoria}/${x.id}.wav`,
		fuente: 'kenney',
		licencia: 'CC0 1.0 (Kenney Vleugels, kenney.nl)',
		url: null,
		duracion_s: 0.2,
		pico_dbtp: -1,
		lufs: -20,
		ataque_ms: 1,
		variante_de: null,
		semitonos: 0,
		sha256: '0'.repeat(64),
		origen: 'prueba',
		sha256_origen: null,
		sha256_audio_origen: null,
		familia: `prueba/${x.fuente_id}`,
		aprobacion: 'no-requiere',
		inicio_ms: 0,
		recorte: null,
		rasgos: {centroide_hz: 1000, planitud: 0.1},
		nota: null,
		...x,
	};
}

type DefCategoria = {reales: number; sintesis: number; variantes?: boolean; pendientes?: number; lufs?: number};

/** Catálogo sintético: por categoría, N fuentes reales + M de síntesis (+ variantes y pendientes opcionales). */
function catalogoFalso(defs: Record<string, DefCategoria>, eventos: Partial<Catalogo['eventos']>): Catalogo {
	const archivos: ArchivoSfx[] = [];
	for (const [c, d] of Object.entries(defs)) {
		const agregar = (id: string, fuente: ArchivoSfx['fuente'], aprobacion: ArchivoSfx['aprobacion'] = 'no-requiere') => {
			const base = archivoFalso({id, categoria: c, fuente_id: `${fuente}:${id}`, fuente, aprobacion, lufs: d.lufs ?? -20});
			archivos.push(base);
			if (d.variantes) {
				archivos.push(archivoFalso({...base, id: `${id}-agudo`, archivo: `biblioteca/sfx/${c}/${id}-agudo.wav`, variante_de: id, semitonos: 1}));
				archivos.push(archivoFalso({...base, id: `${id}-grave`, archivo: `biblioteca/sfx/${c}/${id}-grave.wav`, variante_de: id, semitonos: -1}));
			}
		};
		for (let i = 0; i < d.reales; i++) agregar(`${c}-r${i}`, 'kenney');
		for (let i = 0; i < d.sintesis; i++) agregar(`${c}-s${i}`, 'sintesis');
		for (let i = 0; i < (d.pendientes ?? 0); i++) agregar(`${c}-p${i}`, 'kenney', 'pendiente');
	}
	return {
		version: 1,
		generado_en: '2026-10-03T00:00:00.000Z',
		generado_por: 'prueba',
		normalizacion: {},
		reglas: {},
		eventos: {sticker: [], tarjeta: [], insert: [], zoom: [], titular: [], ...eventos},
		categorias: {},
		inventario: {},
		pendientes: [],
		casi_iguales: [],
		descartados: [],
		archivos,
	};
}

/** Catálogo mínimo que cumple: cada categoría con exactamente 5 fuentes que cuentan (3 reales + 2 síntesis). */
const catalogoMinimo = (): Catalogo =>
	catalogoFalso(
		{
			clic: {reales: 3, sintesis: 2, variantes: true},
			brillo: {reales: 3, sintesis: 2, variantes: true},
			blip: {reales: 3, sintesis: 2, variantes: true, pendientes: 2},
			toque: {reales: 3, sintesis: 2, variantes: true},
			whoosh: {reales: 3, sintesis: 2, variantes: true},
			impacto: {reales: 3, sintesis: 2, variantes: true},
		},
		{sticker: ['clic', 'brillo', 'blip'], tarjeta: ['clic', 'toque', 'blip', 'brillo'], insert: ['whoosh'], zoom: ['whoosh', 'impacto'], titular: []},
	);

const conSilencio = (p10: number, valor: number, p90: number): EstiloSfx => ({...clonar(ESTILO_SFX_SUPUESTO), prob_silencio: {...ESTILO_SFX_SUPUESTO.prob_silencio, p10, valor, p90}});

const ffmpeg = (args: string[]): void => {
	const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], {encoding: 'utf8'});
	if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
};

/** Frecuencia por cruces por cero (para un seno limpio). */
function frecuencia(x: Float32Array, tasa: number): number {
	let cruces = 0;
	let primero = -1;
	let ultimo = -1;
	for (let i = 1; i < x.length; i++) {
		if (x[i - 1] < 0 && x[i] >= 0) {
			cruces++;
			if (primero < 0) primero = i;
			ultimo = i;
		}
	}
	return ((cruces - 1) * tasa) / (ultimo - primero);
}

// ───────────────────────────── lib/sfx.ts ─────────────────────────────

describe('semilla', () => {
	it('misma semilla → misma secuencia; otra semilla → otra', () => {
		const a = crearAleatorio('video-1');
		const b = crearAleatorio('video-1');
		const c = crearAleatorio('video-2');
		const sa = Array.from({length: 50}, a);
		expect(Array.from({length: 50}, b)).toEqual(sa);
		expect(Array.from({length: 50}, c)).not.toEqual(sa);
		expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
	});

	it('la media de 20,000 números está en 0.5 ± 0.01 y FNV-1a da su valor de referencia', () => {
		const r = crearAleatorio(42);
		let s = 0;
		for (let i = 0; i < 20000; i++) s += r();
		expect(Math.abs(s / 20000 - 0.5)).toBeLessThan(0.01);
		expect(hash32('')).toBe(0x811c9dc5);
		expect(hash32('a')).toBe(0xe40c292c);
	});

	it('elegirConPeso respeta los pesos (1:3 → 25 % ± 2) y con pesos 0 elige parejo', () => {
		const r = crearAleatorio(3);
		let a = 0;
		for (let i = 0; i < 20000; i++) if (elegirConPeso(r, ['a', 'b'], (x) => (x === 'a' ? 1 : 3)) === 'a') a++;
		expect(Math.abs(a / 20000 - 0.25)).toBeLessThan(0.02);
		const vistos = new Set(Array.from({length: 200}, () => elegirConPeso(r, ['x', 'y', 'z'], () => 0)));
		expect(vistos.size).toBe(3);
	});
});

describe('conteo de fuentes y mapeo (sin salida de escape)', () => {
	it('la síntesis cuenta máx. 2, las variantes y lo pendiente no cuentan', () => {
		const cat = catalogoFalso({clic: {reales: 3, sintesis: 4, variantes: true, pendientes: 3}}, {});
		const k = contarFuentes(cat.archivos, 'clic');
		expect(k).toMatchObject({reales: 3, sintesis: 4, cuentan: 5, cumple: true, pendientes: 3});
		// 3 reales + 4 síntesis, cada una con 2 variantes = 21 usables (los pendientes no).
		expect(k.archivos).toBe(21);
		const solo = catalogoFalso({pop: {reales: 1, sintesis: 6, variantes: true, pendientes: 9}}, {});
		expect(contarFuentes(solo.archivos, 'pop')).toMatchObject({reales: 1, cuentan: 3, cumple: false});
	});

	it('dos archivos con el mismo fuente_id (casi iguales) cuentan como uno', () => {
		const cat = catalogoFalso({toque: {reales: 4, sintesis: 2}}, {});
		cat.archivos[1].fuente_id = cat.archivos[0].fuente_id;
		expect(contarFuentes(cat.archivos, 'toque')).toMatchObject({reales: 3, cuentan: 5, cumple: true});
		cat.archivos[2].fuente_id = cat.archivos[0].fuente_id;
		expect(contarFuentes(cat.archivos, 'toque')).toMatchObject({reales: 2, cuentan: 4, cumple: false});
	});

	it('mapearEventos deja fuera la categoría que no llega a 5 y el titular va vacío', () => {
		const cat = catalogoFalso({clic: {reales: 3, sintesis: 2}, pop: {reales: 2, sintesis: 2, pendientes: 9}, brillo: {reales: 5, sintesis: 0}}, {});
		const ev = mapearEventos(cat.archivos);
		expect(ev.sticker).toEqual(['clic', 'brillo']);
		expect(ev.sticker).not.toContain('pop');
		expect(ev.titular).toEqual([]);
	});

	it('al aprobar candidatos de Kenney, "pop" llega a 5 y entra al mapeo de stickers (y no antes)', () => {
		const cat = catalogoFalso({pop: {reales: 1, sintesis: 2, variantes: true, pendientes: 9}, clic: {reales: 5, sintesis: 0}}, {});
		expect(mapearEventos(cat.archivos).sticker).toEqual(['clic']);
		for (const id of ['pop-p0', 'pop-p3']) cat.archivos.find((a) => a.id === id)!.aprobacion = 'aprobada';
		expect(contarFuentes(cat.archivos, 'pop')).toMatchObject({reales: 3, cuentan: 5, cumple: true, pendientes: 7});
		expect(mapearEventos(cat.archivos).sticker).toEqual(['pop', 'clic']);
		cat.archivos.find((a) => a.id === 'pop-p3')!.aprobacion = 'rechazada';
		expect(mapearEventos(cat.archivos).sticker).toEqual(['clic']);
	});

	it('el mapeo de estilo.json (sfx.mapeo) reemplaza al supuesto y lo que falte queda supuesto', () => {
		expect(mapeoDesdeEstilo({})).toBeNull();
		const m = mapeoDesdeEstilo({sfx: {mapeo: {sticker: ['pop', 'clic'], tarjeta: 'clic', insert: ['Mal Nombre']}}})!;
		expect(m.sticker).toEqual(['pop', 'clic']);
		expect(m.tarjeta).toEqual(MAPEO_SUPUESTO.tarjeta);
		expect(m.insert).toEqual(MAPEO_SUPUESTO.insert);
		const cat = catalogoFalso({clic: {reales: 5, sintesis: 0}, brillo: {reales: 5, sintesis: 0}}, {});
		expect(mapearEventos(cat.archivos, m).sticker).toEqual(['clic']);
	});

	it('un catálogo que mapea una categoría con 4 fuentes no se usa (código 2) y elegirSfx tampoco lo acepta', () => {
		const cat = catalogoFalso({clic: {reales: 2, sintesis: 2}, brillo: {reales: 5, sintesis: 0}}, {sticker: ['clic', 'brillo']});
		expect(problemasDelCatalogo(cat)[0]).toMatch(/"clic".*4 fuentes/);
		const ruta = join(tmp, 'catalogo-malo.json');
		writeFileSync(ruta, JSON.stringify(cat));
		let error: unknown;
		try {
			leerCatalogo(ruta);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(FalloEditor);
		expect((error as FalloEditor).codigo).toBe(2);
		expect(() => elegirSfx([{id: 'k1', tipo: 'sticker', t: 1}], {catalogo: cat, semilla: 1})).toThrow(/4 fuentes/);
	});
});

describe('estilo del selector', () => {
	it('sin estilo.json → supuestos (n = 0) con notas', () => {
		const {estilo, notas} = estiloSfxDesde({});
		expect(estilo.prob_silencio).toMatchObject({valor: 0.2, p10: 0.1, p90: 0.3, n: 0, fuente: 'supuesto'});
		expect(estilo.offset_cuadros.valor).toEqual([-2, 0]);
		expect(estilo.ganancia_db).toMatchObject({valor: [-14, -8], variacion_db: 2});
		expect(notas.length).toBeGreaterThan(0);
	});

	it('con sfx medido toma los valores y lo que viene "N/A" queda supuesto', () => {
		const {estilo, notas} = estiloSfxDesde({
			sfx: {
				prob_silencio: {valor: 0.3, p10: 0.15, p90: 0.45, n: 8, fuente: 'onsets.ts'},
				offset_cuadros: {valor: [-1, 0], n: 8, fuente: 'onsets.ts'},
				ganancia_db: {valor: 'N/A', n: 0, fuente: 'onsets.ts', falta: 'sin separación de voz'},
			},
		});
		// El rango del video se acota a la mediana ± 0.1 dentro de p10–p90 (0.15–0.45 → 0.2–0.4).
		expect(estilo.prob_silencio).toMatchObject({valor: 0.3, n: 8, fuente: 'onsets.ts', falta: null});
		expect(estilo.prob_silencio.p10).toBeCloseTo(0.2, 9);
		expect(estilo.prob_silencio.p90).toBeCloseTo(0.4, 9);
		expect(estilo.offset_cuadros).toMatchObject({valor: [-1, 0], n: 8});
		expect(estilo.ganancia_db.fuente).toBe('supuesto');
		expect(notas.join(' ')).toMatch(/ganancia_db/);
	});
});

describe('historial entre videos', () => {
	const uso = (f: string) => ({t: 1, tipo: 'sticker' as const, categoria: 'clic', fuente_id: f, archivo_id: f.replace(':', '-')});
	const h: HistorialSfx = {
		version: 1,
		videos: [
			{slug: 'a', fecha: 'x', semilla: 'a', usados: ['f1', 'f2'].map(uso)},
			{slug: 'b', fecha: 'x', semilla: 'b', usados: ['f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'].map(uso)},
		],
	};

	it('la ventana inicial son las últimas 5 del video anterior y el mismo slug se ignora', () => {
		expect(contextoHistorial(h, 'c').ventanaInicial).toEqual(['f5', 'f6', 'f7', 'f8', 'f9']);
		expect(contextoHistorial(h, 'b').ventanaInicial).toEqual(['f1', 'f2']);
		const usos = contextoHistorial(h, 'c').usosRecientes;
		expect(usos.get('f9')).toBe(3); // el anterior pesa ×3
		expect(usos.get('f1')).toBe(1);
	});

	it('registrarVideo reemplaza la entrada del mismo slug y guarda los últimos N', () => {
		const h2 = registrarVideo(h, {slug: 'a', semilla: 'z', fecha: 'y', usados: [uso('f0')]});
		expect(h2.videos.map((v) => v.slug)).toEqual(['b', 'a']);
		expect(h2.videos[1].usados[0].fuente_id).toBe('f0');
		expect(registrarVideo(h2, {slug: 'c', semilla: 'c', fecha: 'y', usados: []}, 2).videos.map((v) => v.slug)).toEqual(['a', 'c']);
	});
});

describe('ebur128 y casi iguales', () => {
	it('parsea M, pico real e integrada del modo metadata=1', () => {
		const stderr = [
			'[Parsed_ametadata_1 @ 0x1] frame:0    pts:0       pts_time:0',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.M=-120.691',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.true_peak=0.300',
			'[Parsed_ametadata_1 @ 0x1] frame:1    pts:4800    pts_time:0.1',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.M=-21.066',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.I=-21.066',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.true_peak=0.352',
			'[Parsed_ametadata_1 @ 0x1] frame:2    pts:9600    pts_time:0.2',
			'[Parsed_ametadata_1 @ 0x1] lavfi.r128.M=-38.4',
		].join('\n');
		const s = parsearMetadatosEbur128(stderr);
		expect(s.m_max).toBeCloseTo(-21.066, 3);
		expect(s.t_m_max).toBeCloseTo(0.2, 3);
		expect(s.tp_dbtp).toBeCloseTo(20 * Math.log10(0.352), 3);
		expect(s.i_lufs).toBeCloseTo(-21.066, 3);
		expect(s.m).toHaveLength(3);
	});

	it('agruparCasiIguales une por encima del umbral con el menor id como representante', () => {
		const rep = agruparCasiIguales(['c', 'a', 'b', 'd'], [{a: 'c', b: 'b', similitud: 0.97}, {a: 'b', b: 'a', similitud: 0.96}, {a: 'a', b: 'd', similitud: 0.9}], 0.95);
		expect([rep.get('a'), rep.get('b'), rep.get('c'), rep.get('d')]).toEqual(['a', 'a', 'a', 'd']);
	});
});

// ───────────────────────────── Audio con ffmpeg ─────────────────────────────

describe('procesamiento de audio (ffmpeg)', () => {
	it('quita el silencio inicial: el ataque queda en los primeros 2 ms y la duración baja ~0.3 s', () => {
		const ruta = join(tmp, 'tono-con-silencio.wav');
		// 300 ms de casi silencio (ruido a −80 dB) y luego un tono de 1 kHz que decae.
		ffmpeg(['-f', 'lavfi', '-i', "aevalsrc=exprs='if(lt(t,0.3),0.0001*(2*random(0)-1),0.8*sin(2*PI*1000*t)*exp(-(t-0.3)/0.05))':s=48000:d=0.8", '-c:a', 'pcm_f32le', ruta]);
		const crudo = aEstereo(decodificar(ruta));
		expect(inicioMs(crudo)).toBeGreaterThan(290);
		const {audio, inicio_original_s} = prepararSfx(crudo, {maxDuracionS: 2});
		expect(inicioMs(audio)).toBeLessThanOrEqual(REGLAS_SFX.max_inicio_ms);
		expect(inicio_original_s).toBeGreaterThan(0.297);
		expect(inicio_original_s).toBeLessThan(0.301);
		expect(duracionDe(audio)).toBeLessThan(0.5);
	});

	it('corta lo que pasa de la duración máxima con fundido y aplica el recorte manual', () => {
		const ruta = join(tmp, 'ruido-largo.wav');
		ffmpeg(['-f', 'lavfi', '-i', "aevalsrc=exprs='0.5*(2*random(0)-1)':s=48000:d=2", '-c:a', 'pcm_f32le', ruta]);
		const a = aEstereo(decodificar(ruta));
		const r = prepararSfx(a, {maxDuracionS: 0.5});
		expect(r.recortado_por_duracion).toBe(true);
		expect(duracionDe(r.audio)).toBeCloseTo(0.5, 3);
		expect(Math.abs(r.audio.canales[0][muestrasDe(r.audio) - 1])).toBeLessThan(0.01);
		const m = prepararSfx(a, {recorte: {desde_s: 1, hasta_s: 1.25}});
		expect(m.inicio_original_s).toBeGreaterThanOrEqual(1);
		expect(duracionDe(m.audio)).toBeLessThanOrEqual(0.26);
	});

	it('normaliza el pico real a −1 dBTP ± 0.02 (medido con ebur128) en un WAV estéreo de 48 kHz', () => {
		const ruta = join(tmp, 'clic.wav');
		ffmpeg(['-f', 'lavfi', '-i', "aevalsrc=exprs='0.2*(2*random(0)-1)*exp(-t/0.002)+0.1*sin(2*PI*2400*t)*exp(-t/0.004)':s=48000:d=0.05", '-c:a', 'pcm_f32le', ruta]);
		const salida = join(tmp, 'clic-norm.wav');
		const r = normalizarYEscribir(prepararSfx(aEstereo(decodificar(ruta))).audio, salida);
		expect(Math.abs(r.pico_dbtp + 1)).toBeLessThanOrEqual(0.02);
		expect(Math.abs(medirSonoridad(salida).tp_dbtp + 1)).toBeLessThanOrEqual(0.02);
		const sondeo = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name', '-of', 'csv=p=0', salida], {encoding: 'utf8'}).stdout.trim();
		expect(sondeo).toBe('pcm_s16le,48000,2');
	});

	it('sha256 del audio decodificado: el mismo audio en otro contenedor o con otra etiqueta da lo mismo', () => {
		const wav = join(tmp, 'base.wav');
		ffmpeg(['-f', 'lavfi', '-i', "aevalsrc=exprs='0.3*sin(2*PI*440*t)':s=44100:d=0.3", '-c:a', 'pcm_s16le', wav]);
		const flac = join(tmp, 'base.flac');
		ffmpeg(['-i', wav, '-c:a', 'flac', flac]);
		const etiquetado = join(tmp, 'etiquetado.wav');
		ffmpeg(['-i', wav, '-c', 'copy', '-metadata', 'title=otro nombre', etiquetado]);
		const otro = join(tmp, 'otro.wav');
		ffmpeg(['-f', 'lavfi', '-i', "aevalsrc=exprs='0.3*sin(2*PI*441*t)':s=44100:d=0.3", '-c:a', 'pcm_s16le', otro]);
		expect(sha256DeArchivo(etiquetado)).not.toBe(sha256DeArchivo(wav));
		const h = sha256AudioDecodificado(wav);
		expect(sha256AudioDecodificado(flac)).toBe(h);
		expect(sha256AudioDecodificado(etiquetado)).toBe(h);
		expect(sha256AudioDecodificado(otro)).not.toBe(h);
	});

	it('la variante de +1 semitono (asetrate + aresample) sube el tono ×2^(1/12) y acorta igual', () => {
		const ruta = join(tmp, 'seno-1k.wav');
		const original: Audio = {tasa: 48000, canales: [new Float32Array(24000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000))]};
		escribirWav(ruta, aEstereo(original));
		const tasa = Math.round(48000 * Math.pow(2, 1 / 12));
		const v = decodificar(ruta, {filtros: `asetrate=${tasa},aresample=48000`});
		expect(frecuencia(v.canales[0], 48000)).toBeCloseTo(1000 * Math.pow(2, 1 / 12), 0);
		expect(duracionDe(v)).toBeCloseTo(0.5 / Math.pow(2, 1 / 12), 2);
		expect(idVariante('kenney-ui-click1', 1)).toBe('kenney-ui-click1-agudo');
		expect([numeroVariante(0), numeroVariante(1), numeroVariante(-1)]).toEqual([0, 1, 2]);
	});
});

describe('síntesis propia', () => {
	it('cada receta da un WAV que suena y dura lo que dice; las 2 de cada categoría son diseños distintos', () => {
		const huellas = new Map<string, Float64Array>();
		for (const r of RECETAS) {
			const ruta = join(tmp, `sint-${r.id}.wav`);
			sintetizar(r, ruta);
			const a = aEstereo(decodificar(ruta));
			expect(duracionDe(a), r.id).toBeCloseTo(r.duracion_s, 2);
			const pico = Math.max(...a.canales[0].map(Math.abs));
			expect(pico, r.id).toBeGreaterThan(0.05);
			huellas.set(r.id, huella(prepararSfx(a).audio));
		}
		const porCategoria = new Map<string, string[]>();
		for (const r of RECETAS) porCategoria.set(r.categoria, [...(porCategoria.get(r.categoria) ?? []), r.id]);
		for (const [c, ids] of porCategoria) {
			expect(ids, c).toHaveLength(2);
			expect(similitudHuellas(huellas.get(ids[0])!, huellas.get(ids[1])!), c).toBeLessThan(REGLAS_SFX.umbral_casi_igual);
		}
		// Determinista: dos corridas dan los mismos bytes.
		const otra = join(tmp, 'sint-otra.wav');
		sintetizar(RECETAS[14], otra);
		expect(sha256DeArchivo(otra)).toBe(sha256DeArchivo(join(tmp, `sint-${RECETAS[14].id}.wav`)));
	});
});

// ───────────────────────────── catalogar.ts ─────────────────────────────

describe('catalogar: utilidades', () => {
	it('nombres, familias y hoja de candidatos', () => {
		expect(aKebab('impactGlass_light_000')).toBe('impact-glass-light-000');
		expect(aKebab('chip-lay-1')).toBe('chip-lay-1');
		expect(familiaKenney('impactGlass_light_000')).toBe('impactGlass_light');
		expect(familiaKenney('click3')).toBe('click');
		expect(acomodarHoja([0.1, 0.2, 0.05])).toEqual([0.5, 1.1, 1.8]);
	});

	it('interpreta tu aprobación por número o id; un número fuera de la hoja sale con código 2', () => {
		const c = ['kenney-interfaz-drop-001', 'kenney-interfaz-drop-002', 'kenney-interfaz-tick-001'];
		expect(interpretarAprobacion('1, 3', c)).toEqual({aprobados: [c[0], c[2]], rechazados: [c[1]]});
		expect(interpretarAprobacion('ninguno', c)).toEqual({aprobados: [], rechazados: c});
		expect(interpretarAprobacion('kenney-interfaz-drop-002', c).aprobados).toEqual([c[1]]);
		let error: unknown;
		try {
			interpretarAprobacion('9', c);
		} catch (e) {
			error = e;
		}
		expect((error as FalloEditor).codigo).toBe(2);
	});
});

// El catálogo con datos del creador (la plantilla lo trae vacío).
const hayCatalogo = catalogoConDatos('biblioteca/sfx/catalogo.json');

describe.runIf(hayCatalogo)('catálogo real (biblioteca/sfx/catalogo.json)', () => {
	const cat = hayCatalogo ? CatalogoEsquema.parse(JSON.parse(readFileSync(RUTA_CATALOGO, 'utf8'))) : (null as unknown as Catalogo);

	it('cumple el esquema y no tiene problemas', () => {
		expect(problemasDelCatalogo(cat)).toEqual([]);
		expect(() => leerCatalogo()).not.toThrow();
	});

	it('cada categoría del mapeo tiene ≥ 5 fuentes recontadas (síntesis máx. 2, sin variantes ni pendientes)', () => {
		const mapeadas = new Set(TIPOS_EVENTO.flatMap((t) => cat.eventos[t]));
		expect(mapeadas.size).toBeGreaterThan(0);
		for (const c of mapeadas) {
			const k = contarFuentes(cat.archivos, c);
			expect(k.cuentan, c).toBeGreaterThanOrEqual(5);
			expect(k.reales + Math.min(k.sintesis, 2), c).toBe(k.cuentan);
			expect(k.reales, c).toBeGreaterThanOrEqual(3);
		}
		expect(cat.eventos.titular).toEqual([]);
		for (const tipo of ['sticker', 'tarjeta', 'insert', 'zoom'] as const) expect(cat.eventos[tipo].length, tipo).toBeGreaterThan(0);
	});

	it('cada archivo: ataque en ≤ 2 ms, pico real −1 ± 0.02 dBTP, y las variantes comparten fuente_id con su original', () => {
		const porId = new Map(cat.archivos.map((a) => [a.id, a]));
		for (const a of cat.archivos) {
			expect(a.inicio_ms, a.id).toBeLessThanOrEqual(2);
			// Tolerancia de la normalización (0.02 dB) + el redondeo a 3 decimales con que se guarda.
			expect(Math.abs(a.pico_dbtp + 1), a.id).toBeLessThanOrEqual(0.0205);
			if (a.variante_de) {
				expect(porId.get(a.variante_de)?.fuente_id, a.id).toBe(a.fuente_id);
				expect(Math.abs(a.semitonos), a.id).toBe(1);
			}
		}
		const originales = cat.archivos.filter((a) => !a.variante_de);
		expect(cat.archivos.length).toBe(originales.length * 3);
	});

	it('Pixabay: 19 mp3 → 17 distintos, con los pares idénticos click/click-soft y whoosh/whoosh-short', () => {
		const pix = cat.inventario.pixabay as {archivos_mp3: number; distintos_por_audio: number; identicos: string[][]};
		expect(pix.archivos_mp3).toBe(19);
		expect(pix.distintos_por_audio).toBe(17);
		expect(pix.identicos.map((g) => [...g].sort().join('='))).toEqual(['click-soft.mp3=click.mp3', 'whoosh-short.mp3=whoosh.mp3']);
		// Cada audio distinto queda como un original de la biblioteca o como descartado con su motivo.
		const originales = cat.archivos.filter((a) => a.fuente === 'pixabay' && !a.variante_de);
		expect(originales.length + cat.descartados.filter((d) => !/mismo audio/.test(d.motivo)).length).toBe(17);
		expect(new Set(originales.map((a) => a.sha256_audio_origen)).size).toBe(originales.length);
		expect(originales.map((a) => a.id)).toContain('pixabay-click');
		expect(originales.map((a) => a.id)).not.toContain('pixabay-click-soft');
	});

	it('los candidatos de Kenney a pop no los usa el selector mientras estén pendientes', () => {
		const pendientes = cat.archivos.filter((a) => a.aprobacion === 'pendiente');
		if (pendientes.length > 0) {
			expect(cat.pendientes.length).toBe(1);
			expect(cat.pendientes[0].candidatos.length).toBe(pendientes.filter((a) => !a.variante_de).length);
			const el = elegirSfx(
				Array.from({length: 40}, (_, i) => ({id: `k${i}`, tipo: 'sticker' as const, t: i})),
				{catalogo: cat, semilla: 'pendientes', estilo: conSilencio(0, 0, 0)},
			);
			const ids = new Set(pendientes.map((a) => a.archivo));
			expect(el.filter((e) => e.sfx && ids.has(e.sfx.asset))).toEqual([]);
		}
	});

	it('licencias: una fila por archivo en biblioteca/licencias/sfx.md', () => {
		const md = readFileSync(join(RAIZ, 'biblioteca', 'licencias', 'sfx.md'), 'utf8');
		for (const a of cat.archivos) expect(md, a.archivo).toContain(`\`${a.archivo.replace(/^biblioteca\//, '')}\``);
		expect(markdownLicencias(cat).split('\n').filter((l) => l.startsWith('| `sfx/')).length).toBe(cat.archivos.length + 2);
	});

	it.runIf(cat && cat.archivos.every((a) => existsSync(join(RAIZ, a.archivo))))('cada WAV existe y tiene el sha256 del catálogo', () => {
		expect(revisarArchivos(cat)).toEqual([]);
	});
});

// ───────────────────────────── elegir.ts ─────────────────────────────

/** Elecciones a mano para probar el revisor (independiente del selector). */
function eleccionManual(id: string, t: number, a: ArchivoSfx | null, offset = -1): Eleccion {
	return {
		id,
		tipo: 'sticker',
		t,
		sfx: a ? {asset: a.archivo, ganancia_db: -10, offset_frames: offset, variante: 0} : null,
		motivo: a ? 'sonido' : 'silencio-planeado',
		categoria: a?.categoria ?? null,
		fuente_id: a?.fuente_id ?? null,
		archivo_id: a?.id ?? null,
		nivel_rel_db: a ? -11 : null,
		respaldo: false,
	};
}

describe('revisor de reglas (independiente del selector)', () => {
	const cat = catalogoMinimo();
	const de = (c: string, i: number) => cat.archivos.find((a) => a.id === `${c}-r${i}`)!;
	const estilo = conSilencio(0, 0, 1);

	it('un silencio no rompe la racha: A, A, (silencio), A es violación; A, A, B, A no', () => {
		const malo = [eleccionManual('1', 1, de('clic', 0)), eleccionManual('2', 2, de('clic', 1)), eleccionManual('3', 3, null), eleccionManual('4', 4, de('clic', 2))];
		expect(revisarReglas(malo, cat, {estilo}).map((v) => v.regla)).toEqual(['racha-categoria']);
		const bueno = [eleccionManual('1', 1, de('clic', 0)), eleccionManual('2', 2, de('clic', 1)), eleccionManual('3', 3, de('brillo', 0)), eleccionManual('4', 4, de('clic', 2))];
		expect(revisarReglas(bueno, cat, {estilo})).toEqual([]);
	});

	it('la ventana de 5 cuenta solo eventos con sonido y trata a las variantes como la misma fuente', () => {
		const variante = cat.archivos.find((a) => a.id === 'clic-r0-agudo')!;
		const seq = [de('clic', 0), de('brillo', 0), de('toque', 0), de('brillo', 1), de('clic', 1)];
		const el = seq.map((a, i) => eleccionManual(String(i), i, a));
		el.push(eleccionManual('s', 5, null), eleccionManual('v', 6, variante));
		expect(revisarReglas(el, cat, {estilo}).map((v) => v.regla)).toEqual(['ventana-5']);
		// Con 5 eventos con sonido en medio, ya se puede repetir.
		const ok = [...seq, de('blip', 0)].map((a, i) => eleccionManual(String(i), i, a));
		ok.push(eleccionManual('v', 9, variante));
		expect(revisarReglas(ok, cat, {estilo})).toEqual([]);
	});

	it('marca offset fuera de [−2, 0], archivos pendientes y la ventana que viene del video anterior', () => {
		const pend = cat.archivos.find((a) => a.aprobacion === 'pendiente' && !a.variante_de)!;
		const el = [eleccionManual('1', 1, de('clic', 0), 1), eleccionManual('2', 2, pend)];
		expect(revisarReglas(el, cat, {estilo}).map((v) => v.regla).sort()).toEqual(['aprobacion', 'offset']);
		expect(revisarReglas([eleccionManual('1', 1, de('clic', 0))], cat, {estilo, ventanaInicial: [de('clic', 0).fuente_id]}).map((v) => v.regla)).toEqual(['ventana-5']);
	});
});

describe('selector', () => {
	const cat = catalogoMinimo();
	const eventos = (n: number, tipo: EventoSfx['tipo'] = 'sticker'): EventoSfx[] => Array.from({length: n}, (_, i) => ({id: `${tipo[0]}${i}`, tipo, t: 0.5 + i * 1.7}));

	it('es determinista con su semilla y otra semilla cambia la elección', () => {
		const ev = [...eventos(10), ...eventos(8, 'tarjeta')];
		const a = elegirSfx(ev, {catalogo: cat, semilla: 'x'});
		expect(elegirSfx(ev, {catalogo: cat, semilla: 'x'})).toEqual(a);
		expect(elegirSfx(ev, {catalogo: cat, semilla: 'y'})).not.toEqual(a);
		expect(a.map((e) => e.id)).toEqual(ev.map((e) => e.id));
	});

	it('el titular nunca suena y no cuenta para el silencio; un tipo sin categorías tampoco', () => {
		const el = elegirSfx([{id: 'tit', tipo: 'titular', t: 0}, ...eventos(12)], {catalogo: cat, semilla: 1});
		expect(el[0]).toMatchObject({sfx: null, motivo: 'sin-categoria'});
		expect(revisarReglas(el, cat)).toEqual([]);
	});

	it('6 tarjetas seguidas sin silencios: la racha obliga a cambiar y nunca hay 3 iguales', () => {
		const el = elegirSfx(eventos(30, 'tarjeta'), {catalogo: cat, semilla: 5, estilo: conSilencio(0, 0, 0)});
		expect(el.every((e) => e.sfx)).toBe(true);
		expect(revisarReglas(el, cat, {estilo: conSilencio(0, 0, 0)})).toEqual([]);
	});

	it('la no-repetición manda sobre el tipo: si el tipo solo tiene una categoría, usa la de un tipo compatible', () => {
		const c = catalogoFalso({whoosh: {reales: 5, sintesis: 0}, impacto: {reales: 5, sintesis: 0}}, {insert: ['whoosh'], zoom: ['impacto']});
		const el = elegirSfx(eventos(12, 'insert'), {catalogo: c, semilla: 2, estilo: conSilencio(0, 0, 0)});
		const respaldo = el.filter((e) => e.respaldo);
		expect(respaldo.length).toBeGreaterThan(0);
		expect(respaldo.every((e) => e.categoria === 'impacto')).toBe(true);
		expect(revisarReglas(el, c, {estilo: conSilencio(0, 0, 0)})).toEqual([]);
	});

	it('--preferir-fuente: tus sonidos suenan más sin romper ninguna regla', () => {
		const c = catalogoFalso({clic: {reales: 5, sintesis: 0}, toque: {reales: 5, sintesis: 0}}, {tarjeta: ['clic', 'toque']});
		// Dos fuentes de clic pasan a ser tuyas.
		for (const a of c.archivos) if (a.id === 'clic-r0' || a.id === 'clic-r1') a.fuente = 'propios';
		const ev = eventos(40, 'tarjeta');
		const sin = elegirSfx(ev, {catalogo: c, semilla: 9, estilo: conSilencio(0, 0, 0)});
		const con = elegirSfx(ev, {catalogo: c, semilla: 9, estilo: conSilencio(0, 0, 0), preferirFuente: 'propios'});
		const tuyos = (el: Eleccion[]) => el.filter((e) => e.archivo_id === 'clic-r0' || e.archivo_id === 'clic-r1').length;
		expect(tuyos(con)).toBeGreaterThan(tuyos(sin));
		expect(revisarReglas(con, c, {estilo: conSilencio(0, 0, 0)})).toEqual([]);
	});

	it('soloFuentes: solo suenan archivos de esas fuentes', () => {
		const c = catalogoFalso({clic: {reales: 5, sintesis: 0}, toque: {reales: 5, sintesis: 0}}, {tarjeta: ['clic', 'toque']});
		for (const a of c.archivos) if (['clic-r0', 'clic-r1', 'clic-r2', 'toque-r0', 'toque-r1', 'toque-r2'].includes(a.id)) a.fuente = 'propios';
		const el = elegirSfx(eventos(30, 'tarjeta'), {catalogo: c, semilla: 4, soloFuentes: ['propios']});
		const ids = new Set(c.archivos.filter((a) => a.fuente === 'propios').map((a) => a.id));
		expect(el.filter((e) => e.sfx).length).toBeGreaterThan(0);
		expect(el.filter((e) => e.sfx).every((e) => ids.has(e.archivo_id!))).toBe(true);
	});

	it('si nada sirve, deja silencio (sin-opcion) y no rompe ninguna regla', () => {
		const c = catalogoFalso({whoosh: {reales: 5, sintesis: 0}}, {insert: ['whoosh']});
		const el = elegirSfx(eventos(9, 'insert'), {catalogo: c, semilla: 3, estilo: conSilencio(0, 0, 0)});
		expect(el.filter((e) => e.motivo === 'sin-opcion').length).toBeGreaterThan(0);
		expect(revisarReglas(el, c, {estilo: conSilencio(0, 0, 1)})).toEqual([]);
	});

	it('el silencio por video cae en [p10, p90] para N de 12 a 30 y cada semilla', () => {
		for (let n = 12; n <= 30; n++) {
			for (let s = 0; s < 20; s++) {
				const el = elegirSfx(eventos(n), {catalogo: cat, semilla: `${n}-${s}`});
				const callados = el.filter((e) => !e.sfx).length;
				const r = rangoSilencios(n, 0.1, 0.3);
				expect(callados, `n=${n} s=${s}`).toBeGreaterThanOrEqual(r.min);
				expect(callados, `n=${n} s=${s}`).toBeLessThanOrEqual(r.max);
			}
		}
	});

	it('offsets dentro del rango del estilo y nivel bajo la voz dentro de [−14, −8] dB', () => {
		const estilo: EstiloSfx = {...clonar(ESTILO_SFX_SUPUESTO), offset_cuadros: {...ESTILO_SFX_SUPUESTO.offset_cuadros, valor: [-1, -1]}};
		const el = elegirSfx(eventos(40), {catalogo: cat, semilla: 9, estilo, vozLufs: -18});
		for (const e of el.filter((x) => x.sfx)) {
			expect(e.sfx!.offset_frames).toBe(-1);
			expect(e.nivel_rel_db!).toBeGreaterThanOrEqual(-14);
			expect(e.nivel_rel_db!).toBeLessThanOrEqual(-8);
			// lufs del catálogo falso = −20: ganancia = nivel + voz − lufs.
			expect(e.sfx!.ganancia_db).toBeCloseTo(e.nivel_rel_db! - 18 + 20, 0);
		}
	});

	it('no elige archivos que ni a 0 dB llegan al mínimo bajo la voz', () => {
		const c = catalogoFalso(
			{clic: {reales: 3, sintesis: 2, lufs: -40}, brillo: {reales: 5, sintesis: 0, lufs: -20}, blip: {reales: 5, sintesis: 0, lufs: -20}},
			{sticker: ['clic', 'brillo', 'blip']},
		);
		const el = elegirSfx(eventos(30), {catalogo: c, semilla: 4, vozLufs: -18});
		expect(el.some((e) => e.categoria === 'clic')).toBe(false);
		expect(el.filter((e) => e.sfx).every((e) => e.sfx!.ganancia_db <= 0)).toBe(true);
		expect(revisarReglas(el, c)).toEqual([]);
	});

	it('el historial: re-elegir el mismo video da lo mismo y el video siguiente no arranca repitiendo', () => {
		const ev = eventos(15);
		let h: HistorialSfx = {version: 1, videos: []};
		const v1 = elegirSfx(ev, {catalogo: cat, semilla: 'v1', historial: h, slug: 'v1'});
		h = registrarVideo(h, {slug: 'v1', semilla: 'v1', fecha: 'x', usados: v1.filter((e) => e.sfx).map((e) => ({t: e.t, tipo: e.tipo, categoria: e.categoria!, fuente_id: e.fuente_id!, archivo_id: e.archivo_id!}))});
		expect(elegirSfx(ev, {catalogo: cat, semilla: 'v1', historial: h, slug: 'v1'})).toEqual(v1);
		const v2 = elegirSfx(ev, {catalogo: cat, semilla: 'v2', historial: h, slug: 'v2'});
		expect(revisarReglas(v2, cat, {ventanaInicial: contextoHistorial(h, 'v2').ventanaInicial})).toEqual([]);
	});
});

describe('simulación de 1,000 videos', () => {
	it('catálogo mínimo (5 fuentes por categoría): 0 violaciones y todo video en [p10, p90] de silencio', () => {
		const r = simularVideos(1000, {catalogo: catalogoMinimo(), semilla: 'minimo'});
		expect(r.violaciones, JSON.stringify(r.ejemplos_violacion)).toBe(0);
		expect(r.silencio.fuera_de_rango).toBe(0);
		expect(Object.keys(r.offsets).map(Number).every((o) => o >= -2 && o <= 0)).toBe(true);
	});

	it.runIf(hayCatalogo)('catálogo real: 0 violaciones, silencio en [p10, p90], offsets −2…0 y el historial baja la repetición entre videos', () => {
		const catalogo = leerCatalogo();
		const r = simularVideos(1000, {catalogo, semilla: 'real'});
		expect(r.videos).toBe(1000);
		expect(r.eventos).toBeGreaterThan(12 * 1000);
		expect(r.violaciones, JSON.stringify(r.ejemplos_violacion)).toBe(0);
		expect(r.silencio.fuera_de_rango).toBe(0);
		expect(r.silencio.min).toBeGreaterThanOrEqual(0.1);
		expect(r.silencio.max).toBeLessThanOrEqual(0.3);
		expect(Object.keys(r.offsets).map(Number).sort()).toEqual([-1, -2, 0].sort());
		expect(r.nivel_rel_db.min).toBeGreaterThanOrEqual(-14);
		expect(r.nivel_rel_db.max).toBeLessThanOrEqual(-8);
		expect(r.sin_opcion_pct).toBeLessThan(1);
		const sin = simularVideos(1000, {catalogo, semilla: 'real', conHistorial: false});
		expect(r.repeticion_entre_videos.media).toBeLessThan(sin.repeticion_entre_videos.media);
	});

	it('los eventos simulados respetan el rango de eventos por video', () => {
		const rnd = crearAleatorio('ev');
		for (let i = 0; i < 200; i++) {
			const ev = eventosSimulados(rnd, ESTILO_SFX_SUPUESTO, `v${i}`).filter((e) => e.tipo !== 'titular');
			expect(ev.length).toBeGreaterThanOrEqual(12);
			expect(ev.length).toBeLessThanOrEqual(30);
		}
	});
});

// ───────────────────────────── EDL y CLI ─────────────────────────────

const EDL_BASE = JSON.parse(readFileSync(join(RAIZ, 'pruebas', 'edl', 'f0-3s.json'), 'utf8'));

function edlDePrueba(): Edicion {
	const e = EdicionBase.parse(clonar(EDL_BASE));
	e.duracion_s = 3;
	e.tarjetas = [{id: 'c1', desde: 0.5, hasta: 1.5, texto: 'Gratis', caja: {x: 540, y: 1200}, grupo: null, variante: 'normal', entrada: 'corte', tapaCabeza: false, sfx: null}];
	e.inserts = [];
	e.zooms = [{id: 'z1', desde: 2, hasta: 2.9, escala: 1.2, origen: {x: 540, y: 900}, transicion: 'corte'}];
	return e;
}

describe('EDL', () => {
	it('saca los eventos de stickers, tarjetas, inserts, zooms y titular', () => {
		const e = edlDePrueba();
		e.titular = {texto: 'Hola', desde: 0, hasta: 3, tapaCabeza: true};
		expect(eventosDeEdicion(e).map((x) => `${x.tipo}:${x.id}@${x.t}`)).toEqual(['sticker:k1@1', 'tarjeta:c1@0.5', 'zoom:z1@2', 'titular:__titular@0']);
	});

	it('aplica las elecciones: sfx en stickers y tarjetas, el zoom va a sfx_extra y re-aplicar no lo duplica', () => {
		const e = edlDePrueba();
		const sfx = {asset: 'biblioteca/sfx/clic/x.wav', ganancia_db: -9, offset_frames: -1, variante: 0};
		const el: Eleccion[] = [
			{...eleccionManual('k1', 1, null), sfx: null},
			{...eleccionManual('c1', 0.5, null), sfx},
			{...eleccionManual('z1', 2, null), tipo: 'zoom', sfx},
		];
		const una = aplicarAEdicion(e, el);
		expect(una.stickers[0].sfx).toBeNull();
		expect(una.tarjetas[0].sfx).toEqual(sfx);
		expect(una.sfx_extra).toEqual([{en: 2, sfx}]);
		const dos = aplicarAEdicion(una, el);
		expect(dos.sfx_extra).toHaveLength(1);
		expect(EdicionBase.safeParse(dos).success).toBe(true);
		expect(e.sfx_extra).toEqual([]); // no toca la original
	});
});

const correrCli = (script: string, args: string[]) =>
	spawnSync(process.execPath, ['--import', 'tsx', join(RAIZ, 'herramientas', 'sfx', script), ...args], {cwd: RAIZ, encoding: 'utf8', timeout: 120_000});

describe.runIf(hayCatalogo)('CLI de elegir.ts', () => {
	const dir = join(tmp, 'cli');
	mkdirSync(dir, {recursive: true});
	const entrada = join(dir, 'edicion-v1.json');
	writeFileSync(entrada, JSON.stringify(edlDePrueba(), null, '\t'));

	it('escribe una EDL nueva y válida con los SFX, sin tocar la de entrada', () => {
		const antes = readFileSync(entrada, 'utf8');
		const salida = join(dir, 'edicion-v2.json');
		const historial = join(dir, 'historial.json');
		const r = correrCli('elegir.ts', ['--edicion', entrada, '--salida', salida, '--voz-lufs', '-18', '--semilla', 'cli', '--historial', historial, '--guardar-historial']);
		expect(r.status, r.stderr).toBe(0);
		expect(readFileSync(entrada, 'utf8')).toBe(antes);
		const nueva = EdicionBase.parse(JSON.parse(readFileSync(salida, 'utf8')));
		const conSfx = [nueva.stickers[0].sfx, nueva.tarjetas[0].sfx, ...nueva.sfx_extra.map((x) => x.sfx)].filter(Boolean);
		for (const s of conSfx) {
			expect(existsSync(join(RAIZ, 'public', s!.asset))).toBe(true);
			expect(s!.offset_frames).toBeGreaterThanOrEqual(-2);
			expect(s!.offset_frames).toBeLessThanOrEqual(0);
		}
		const h = JSON.parse(readFileSync(historial, 'utf8')) as HistorialSfx;
		expect(h.videos).toHaveLength(1);
		expect(h.videos[0].usados).toHaveLength(conSfx.length);
	});

	it('sale con 2 si la salida es la entrada, si ya existe, si falta --salida o si la opción no existe', () => {
		expect(correrCli('elegir.ts', ['--edicion', entrada, '--salida', entrada, '--voz-lufs', '-18']).status).toBe(2);
		const existe = join(dir, 'ya-existe.json');
		writeFileSync(existe, '{}');
		expect(correrCli('elegir.ts', ['--edicion', entrada, '--salida', existe, '--voz-lufs', '-18']).status).toBe(2);
		expect(correrCli('elegir.ts', ['--edicion', entrada]).status).toBe(2);
		expect(correrCli('elegir.ts', ['--simular', '10', '--rara']).status).toBe(2);
		const invalida = join(dir, 'invalida.json');
		writeFileSync(invalida, JSON.stringify({version: 1}));
		const r = correrCli('elegir.ts', ['--edicion', invalida, '--salida', join(dir, 'x.json'), '--voz-lufs', '-18']);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/Siguiente paso/);
	});

	it.runIf(existsSync(join(RAIZ, 'public', 'fx', 'clip-6s.mp4')))('sin --voz-lufs mide tu voz en la base de la EDL', () => {
		const salida = join(dir, 'edicion-v3.json');
		const r = correrCli('elegir.ts', ['--edicion', entrada, '--salida', salida, '--semilla', 'medida', '--sin-historial']);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toMatch(/Voz -?\d+(\.\d)? LUFS \(medida en la base\)/);
	});

	it('--simular 50 sale con 0 y reporta 0 violaciones', () => {
		const r = correrCli('elegir.ts', ['--simular', '50', '--semilla', 'cli']);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toMatch(/"violaciones": 0/);
	});
});

describe.runIf(hayCatalogo)('CLI de catalogar.ts', () => {
	it('una opción desconocida sale con 2', () => {
		expect(correrCli('catalogar.ts', ['--rara']).status).toBe(2);
	});

	it.runIf(hayCatalogo && CatalogoEsquema.parse(JSON.parse(readFileSync(RUTA_CATALOGO, 'utf8'))).archivos.every((a) => existsSync(join(RAIZ, a.archivo))))(
		'--solo-revisar sale con 0 cuando la biblioteca está completa',
		() => {
			const r = correrCli('catalogar.ts', ['--solo-revisar']);
			expect(r.status, r.stderr).toBe(0);
		},
	);
});

describe('sintesis.ts como CLI', () => {
	it('sin --salida sale con 2 y con una receta escribe su WAV', () => {
		expect(correrCli('sintesis.ts', []).status).toBe(2);
		const dir = join(tmp, 'sint-cli');
		const r = correrCli('sintesis.ts', ['--salida', dir, '--receta', 'pop-boca']);
		expect(r.status, r.stderr).toBe(0);
		expect(existsSync(join(dir, 'pop-boca.wav'))).toBe(true);
		copyFileSync(join(dir, 'pop-boca.wav'), join(tmp, 'copia.wav'));
	});
});
