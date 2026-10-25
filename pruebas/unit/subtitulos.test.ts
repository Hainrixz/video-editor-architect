// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas del agrupador de subtítulos (herramientas/subtitulos.ts), de la medición con fontkit
 * (herramientas/lib/texto-ancho.ts) y de la tabla de fuentes candidatas (src/estilo/fuentes.ts).
 *
 * Usan las fuentes reales de biblioteca/fuentes/. Si faltan: `sh biblioteca/fuentes/preparar.sh`.
 * Los proyectos de prueba viven en una carpeta temporal; no tocan proyectos/.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EdicionValidada, Subtitulo as SubtituloEsquema, edicionVacia} from '../../src/esquema/edicion.ts';
import {
	CANDIDATAS,
	ESTILO_SUBTITULO_POR_DEFECTO,
	FUENTE_POR_DEFECTO,
	IDS_FUENTE,
	archivoFuente,
	pesoDisponible,
	resolverEstilo,
	textoVisible,
} from '../../src/estilo/fuentes.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {RAIZ, leerManifest} from '../../herramientas/lib/manifest.ts';
import {cuantizar, remapearIntervalo, type Tramo} from '../../herramientas/lib/remapear.ts';
import {abrirFuente, medirTexto, UNION_BORDE} from '../../herramientas/lib/texto-ancho.ts';
import {
	DESTELLO_CUADROS,
	FPS,
	MARGEN_ANTIALIAS_PX,
	ESCALA_MIN_ABSOLUTA,
	PARAMETROS_POR_DEFECTO,
	agruparSubtitulos,
	anchoZonaSubtitulos,
	crucesDeOracion,
	esNexo,
	formaDe,
	anchoUtil,
	crearMedidor,
	generarSubtitulos,
	leerMiniEstilo,
	leerTerminos,
	normalizarPalabras,
	partirEnFrases,
	tramosEnBase,
	estirarDestellos,
	unirDestellos,
	unirFrasesSueltas,
	type Medidor,
	type PalabraBase,
	type TramoBase,
} from '../../herramientas/subtitulos.ts';
import {HAY_FUENTES} from './requisitos.ts';

const FORMATO = /^No pude [^:\n]+: [^\n]+\. Siguiente paso: [^\n]+\.$/;
/** Quita los avisos que npm/npx imprime según la configuración de la máquina (no son del editor). */
const sinAvisosNpm = (texto: string) => texto.split('\n').filter((l) => !/^npm (warn|notice)/.test(l)).join('\n').trim();
const RUTA_TIKTOK = join(RAIZ, CANDIDATAS['tiktok-sans'].archivos[600].ruta);
const ESTILO = resolverEstilo({});

function falloDe(fn: () => unknown): FalloEditor {
	try {
		fn();
	} catch (error) {
		if (error instanceof FalloEditor) return error;
		throw error;
	}
	throw new Error('se esperaba un FalloEditor y no lanzó nada');
}

async function falloAsync(promesa: Promise<unknown>): Promise<FalloEditor> {
	const error = await promesa.then(
		() => null,
		(e: unknown) => e,
	);
	if (error instanceof FalloEditor) return error;
	throw new Error(`se esperaba un FalloEditor y llegó ${String(error)}`);
}

/** Medidor falso: cada carácter mide `px` (así las pruebas de lógica no dependen de la fuente). */
function medidorFalso(px: number): Medidor {
	return (grupo) => {
		const ancho = grupo.map((p) => p.t).join(' ').length * px;
		return {avance: ancho, tintaIzq: 0, tintaDer: ancho, trazoIzq: 0, trazoDer: ancho, ancho, anchoTinta: ancho};
	};
}

/** ¿Se puede partir la frase en grupos de 2–3 palabras que quepan todos? (búsqueda exhaustiva con memoria). */
function sinSueltasPosible(frase: readonly PalabraBase[], medir: Medidor, anchoMax: number): boolean {
	const memo = new Map<number, boolean>();
	const desde = (k: number): boolean => {
		if (k === frase.length) return true;
		if (memo.has(k)) return memo.get(k)!;
		let posible = false;
		for (const n of [2, 3]) {
			if (k + n <= frase.length && medir(frase.slice(k, k + n)).ancho <= anchoMax && desde(k + n)) posible = true;
		}
		memo.set(k, posible);
		return posible;
	};
	return desde(0);
}

/** Palabras seguidas en un solo tramo, con huecos dados (s) entre una y otra. */
function seguidas(textos: string[], huecos: number[] = [], inicio = 1, tramo = 0): PalabraBase[] {
	let t = inicio;
	return textos.map((texto, i) => {
		const d = t;
		const h = d + 0.25;
		t = h + (huecos[i] ?? 0.05);
		return {i, t: texto, d: Number(d.toFixed(3)), h: Number(h.toFixed(3)), tramo};
	});
}

const textos = (subs: {palabras: {t: string}[]}[]): string[] => subs.map((s) => s.palabras.map((p) => p.t).join(' '));

// ───────────────────────── fixture realista: crudo → keep → base ─────────────────────────

const GUION =
	'Hoy te voy a enseñar cómo Claude Code puede programar una aplicación completa sin que tú escribas una sola línea de código. ' +
	'Primero, abres la terminal y le pides lo que quieres. Después, Claude hace un plan, escribe los archivos y prueba que todo funcione. ' +
	'¿Lo mejor? Puedes revisar cada cambio antes de aceptarlo. Desafortunadamente, todavía se equivoca a veces, así que siempre revisa lo que hace. ' +
	'Si te sirvió, guárdalo y compártelo con alguien que lo necesite.';

type Fixture = {keep: Tramo[]; tramos: TramoBase[]; palabras: PalabraBase[]; duracionBase: number};

/**
 * Tiempos en el crudo: cada palabra dura 0.12 s + 45 ms por letra; después de coma hay 0.18 s, de punto 0.45 s,
 * y después de "puede" (i = 8) hay una pausa de 0.3 s (se parte ahí).
 * Cada 2 oraciones hay 1.6 s de silencio que la etapa de cortes quitaría: ahí acaba un tramo de keep[].
 * Las palabras se remapean a la base con remapearIntervalo, como lo haría la etapa de cortes.
 */
function fixtureRealista(): Fixture {
	const palabrasCrudo: {t: string; d: number; h: number}[] = [];
	const cortesDespues = new Set<number>();
	let t = 0.6;
	let oraciones = 0;
	GUION.split(' ').forEach((texto, i) => {
		const d = t;
		const h = d + 0.12 + 0.045 * texto.replace(/[^\p{L}]/gu, '').length;
		palabrasCrudo.push({t: texto, d, h});
		let hueco = 0.06;
		if (/[,]$/.test(texto)) hueco = 0.18;
		if (i === 8) hueco = 0.3; // "puede … programar": pausa de 300 ms
		if (/[.?!]$/.test(texto)) {
			hueco = 0.45;
			oraciones++;
			if (oraciones % 2 === 0) {
				hueco = 1.6;
				cortesDespues.add(i);
			}
		}
		t = h + hueco;
	});
	// keep[]: de 0.1 s antes de la primera palabra de cada bloque a 0.1 s después de la última.
	const keep: Tramo[] = [];
	let inicioBloque = 0;
	palabrasCrudo.forEach((p, i) => {
		if (cortesDespues.has(i) || i === palabrasCrudo.length - 1) {
			keep.push({desde: cuantizar(palabrasCrudo[inicioBloque].d - 0.1), hasta: cuantizar(p.h + 0.1)});
			inicioBloque = i + 1;
		}
	});
	const palabras = palabrasCrudo.map((p, i) => {
		const r = remapearIntervalo(keep, p.d, p.h);
		if (!r) throw new Error(`la palabra ${i} cayó en un corte`);
		return {i, t: p.t, d: Number(r.desde.toFixed(6)), h: Number(r.hasta.toFixed(6)), tramo: r.tramo};
	});
	const tramos = tramosEnBase(keep);
	return {keep, tramos, palabras, duracionBase: tramos[tramos.length - 1].hasta};
}

const FIX = fixtureRealista();

// ───────────────────────── fuentes ─────────────────────────

describe.runIf(HAY_FUENTES)('fuentes candidatas (src/estilo/fuentes.ts y biblioteca/fuentes/)', () => {
	it('los 6 archivos existen y su sha256 es el registrado (si no: sh biblioteca/fuentes/preparar.sh)', () => {
		for (const id of IDS_FUENTE) {
			for (const archivo of Object.values(CANDIDATAS[id].archivos)) {
				const sha = createHash('sha256').update(readFileSync(join(RAIZ, archivo.ruta))).digest('hex');
				expect(sha, archivo.ruta).toBe(archivo.sha256);
			}
		}
	});

	it('alto de mayúscula y unidades por em de la tabla son los del archivo (y la "H" mide eso)', () => {
		for (const id of IDS_FUENTE) {
			const c = CANDIDATAS[id];
			for (const archivo of Object.values(c.archivos)) {
				const f = abrirFuente(join(RAIZ, archivo.ruta));
				expect(f.unitsPerEm, archivo.ruta).toBe(c.unidadesEm);
				expect(f.capHeight / f.unitsPerEm, archivo.ruta).toBeCloseTo(c.altoMayuscula, 9);
				expect(f.glyphForCodePoint(0x48).bbox.maxY, archivo.ruta).toBe(f.capHeight);
			}
		}
	});

	it('la activa por defecto es TikTok Sans 600 con resaltado en 800 (apagado), blanco con borde negro', () => {
		expect(FUENTE_POR_DEFECTO).toEqual({id: 'tiktok-sans', peso: 600});
		expect(ESTILO_SUBTITULO_POR_DEFECTO).toMatchObject({fuente: 'tiktok-sans', peso: 600, color: '#FFFFFF', color_borde: '#000000', ancho_max: 864});
		expect(ESTILO_SUBTITULO_POR_DEFECTO.resaltado).toEqual({activo: false, peso: 800, color: null, escala: 1});
		expect(archivoFuente('tiktok-sans', 600).ruta).toBe('biblioteca/fuentes/tiktok-sans/TikTokSans-SemiBold.ttf');
	});

	it('pesoDisponible: Instrument Sans no tiene 800 y usa 700; los pesos exactos se respetan', () => {
		expect(pesoDisponible('instrument-sans', 800)).toBe(700);
		expect(pesoDisponible('inter', 800)).toBe(800);
		expect(pesoDisponible('tiktok-sans', 600)).toBe(600);
		expect(pesoDisponible('tiktok-sans', 700)).toBe(800); // empate → el más grueso
	});

	it('biblioteca/LICENCIAS.md tiene una fila OFL-1.1 por archivo, con su URL de origen y sha256', () => {
		const md = readFileSync(join(RAIZ, 'biblioteca', 'LICENCIAS.md'), 'utf8');
		for (const id of IDS_FUENTE) {
			const c = CANDIDATAS[id];
			const rutas = [...Object.values(c.archivos).map((a) => a.ruta), `biblioteca/fuentes/${id}/OFL.txt`];
			for (const ruta of rutas) {
				const fila = md.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${ruta.replace(/^biblioteca\//, '')}\``));
				expect(fila, ruta).toBeDefined();
				expect(fila).toContain('OFL-1.1');
				expect(fila).toContain('https://raw.githubusercontent.com/google/fonts/');
				expect(fila).toContain('2026-10-03');
			}
			for (const archivo of Object.values(c.archivos)) expect(md).toContain(archivo.sha256);
		}
	});

	it('textoVisible: mayúsculas y puntuación de las orillas solo si el estilo lo pide', () => {
		expect(textoVisible('¿Código?', ESTILO)).toBe('¿Código?');
		expect(textoVisible('¿Código?', {mayusculas: true, quitar_puntuacion: false})).toBe('¿CÓDIGO?');
		expect(textoVisible('¿Código?', {mayusculas: false, quitar_puntuacion: true})).toBe('Código');
		expect(textoVisible('3.5', {mayusculas: false, quitar_puntuacion: true})).toBe('3.5');
		expect(textoVisible('...', {mayusculas: false, quitar_puntuacion: true})).toBe('...');
	});
});

// ───────────────────────── medición ─────────────────────────

describe.runIf(HAY_FUENTES)('texto-ancho (fontkit sobre el mismo archivo)', () => {
	it('el borde suma 2× su grosor al ancho (y nunca menos que avance + 2× borde)', () => {
		// Letras rectas en las orillas: el borde suma justo 2 × 5 px.
		const sin = medirTexto(RUTA_TIKTOK, 'HIH', 72, 0);
		const con = medirTexto(RUTA_TIKTOK, 'HIH', 72, 5);
		expect(con.ancho - sin.ancho).toBeCloseTo(10, 9);
		expect(con.avance).toBeCloseTo(sin.avance, 9);
		// Cualquier texto: el ancho con borde es al menos el ancho de fontkit + 2× el borde.
		for (const texto of ['Hola', 'Wow ya voy', 'jota', 'Escribe código perfecto']) {
			expect(medirTexto(RUTA_TIKTOK, texto, 72, 5).ancho, texto).toBeGreaterThanOrEqual(medirTexto(RUTA_TIKTOK, texto, 72, 0).avance + 10 - 1e-9);
		}
	});

	it('crece lineal con el tamaño', () => {
		expect(medirTexto(RUTA_TIKTOK, 'Escribe código', 144).avance).toBeCloseTo(2 * medirTexto(RUTA_TIKTOK, 'Escribe código', 72).avance, 6);
	});

	it('aplica el shaping de la fuente (kerning): "AV" junto mide menos que "A" + "V"', () => {
		const junto = medirTexto(RUTA_TIKTOK, 'AV', 100).avance;
		const separado = medirTexto(RUTA_TIKTOK, 'A', 100).avance + medirTexto(RUTA_TIKTOK, 'V', 100).avance;
		expect(junto).toBeLessThan(separado);
	});

	it('la "j" del inicio se sale de la caja CSS y el ancho centrado lo cubre', () => {
		const m = medirTexto(RUTA_TIKTOK, 'jota', 100, 0);
		expect(m.tintaIzq!).toBeLessThan(0);
		expect(m.ancho).toBeGreaterThan(m.avance);
	});

	it('con uniones redondas (como dibuja Subtitulo.tsx) el borde suma justo 2× a la tinta, también en esquinas agudas ("W", "y", "a")', () => {
		expect(UNION_BORDE).toBe('redonda');
		for (const texto of ['HIH', 'Wy', 'a']) {
			const m = medirTexto(RUTA_TIKTOK, texto, 100, 5);
			expect(m.anchoTinta, texto).toBeCloseTo(m.tintaDer! - m.tintaIzq! + 10, 6);
		}
	});

	it('si falta el archivo de fuente sale con código 2 y el siguiente paso', () => {
		const error = falloDe(() => abrirFuente(join(RAIZ, 'biblioteca', 'fuentes', 'no-existe.ttf')));
		expect(error.codigo).toBe(2);
		expect(error.message).toMatch(FORMATO);
		expect(error.message).toContain('preparar.sh');
	});
});

// ───────────────────────── agrupador ─────────────────────────

describe.runIf(HAY_FUENTES)('agrupador: forma de los subtítulos', () => {
	// Se calcula al recolectar: sin fuentes (describe saltado) no se mide nada.
	const r = HAY_FUENTES ? agruparSubtitulos(FIX.palabras, FIX.tramos, ESTILO) : (null as unknown as ReturnType<typeof agruparSubtitulos>);

	it('el fixture es realista: 4 tramos de keep, ~70 palabras', () => {
		expect(FIX.tramos.length).toBe(4);
		expect(FIX.palabras.length).toBeGreaterThan(60);
	});

	it('cada subtítulo trae 1–3 palabras; uno de 1 solo sale si su frase no se puede partir en grupos de 2–3 que quepan', () => {
		const medir = crearMedidor(ESTILO);
		const frases = partirEnFrases(FIX.palabras, 0.25);
		const fraseDe = new Map(frases.flatMap((f) => f.map((p) => [p.i, f] as const)));
		for (const s of r.subtitulos) {
			expect(s.palabras.length).toBeGreaterThanOrEqual(1);
			expect(s.palabras.length).toBeLessThanOrEqual(3);
			if (s.palabras.length === 1) expect(sinSueltasPosible(fraseDe.get(s.palabras[0].i)!, medir, ESTILO.ancho_max), s.palabras[0].t).toBe(false);
		}
		expect(r.resumen.por_tamano[2] + r.resumen.por_tamano[3]).toBeGreaterThanOrEqual(0.85 * r.subtitulos.length);
	});

	it('texto concatenado == texto de transcripcion-base (0 palabras distintas, mismos índices)', () => {
		const palabras = r.subtitulos.flatMap((s) => s.palabras);
		expect(palabras.map((p) => p.t).join(' ')).toBe(FIX.palabras.map((p) => p.t).join(' '));
		expect(palabras.map((p) => p.i)).toEqual(FIX.palabras.map((p) => p.i));
		expect(palabras.map((p) => [p.d, p.h])).toEqual(FIX.palabras.map((p) => [p.d, p.h]));
	});

	it('ningún subtítulo cruza un corte: palabras de un solo tramo y tiempos dentro de ese tramo', () => {
		const tramoDe = new Map(FIX.palabras.map((p) => [p.i, p.tramo]));
		for (const s of r.subtitulos) {
			const tramos = new Set(s.palabras.map((p) => tramoDe.get(p.i)));
			expect(tramos.size, s.id).toBe(1);
			const t = FIX.tramos[[...tramos][0]!];
			expect(s.desde, s.id).toBeGreaterThanOrEqual(t.desde - 1e-9);
			expect(s.hasta, s.id).toBeLessThanOrEqual(t.hasta + 1e-9);
		}
	});

	it('parte en puntuación final: la palabra que sigue a . ? ! … abre subtítulo', () => {
		const palabras = r.subtitulos.flatMap((s) => s.palabras);
		const primeras = new Set(r.subtitulos.map((s) => s.palabras[0].i));
		palabras.forEach((p, k) => {
			if (k + 1 < palabras.length && /[.?!…]$/.test(p.t)) expect(primeras.has(palabras[k + 1].i), `después de "${p.t}"`).toBe(true);
		});
	});

	it('parte en pausas de más de 250 ms (y no lo exige con 250 ms justos)', () => {
		const libre = {...PARAMETROS_POR_DEFECTO, minPalabras: 1};
		const corta = agruparSubtitulos(seguidas(['uno', 'dos'], [0.25]), [{desde: 0, hasta: 10}], ESTILO, libre, medidorFalso(10));
		expect(textos(corta.subtitulos)).toEqual(['uno dos']);
		const larga = agruparSubtitulos(seguidas(['uno', 'dos'], [0.26]), [{desde: 0, hasta: 10}], ESTILO, libre, medidorFalso(10));
		expect(textos(larga.subtitulos)).toEqual(['uno', 'dos']);
		// En el fixture, "puede" (i=8) va seguida de 300 ms: "programar" abre subtítulo.
		expect(r.subtitulos.some((s) => s.palabras[0].i === 9)).toBe(true);
	});

	it('el ancho medido con fontkit (fuente activa, con borde) nunca pasa del máximo menos el margen de antialias', () => {
		expect(anchoUtil(ESTILO)).toBe(ESTILO.ancho_max - MARGEN_ANTIALIAS_PX);
		const medir = crearMedidor(ESTILO);
		const porIndice = new Map(FIX.palabras.map((p) => [p.i, p]));
		for (const s of r.subtitulos) {
			const ancho = medir(s.palabras.map((p) => porIndice.get(p.i)!)).ancho;
			expect(ancho, s.palabras.map((p) => p.t).join(' ')).toBeLessThanOrEqual(anchoUtil(ESTILO));
			expect(s.caja?.w).toBe(Math.ceil(ancho));
		}
		expect(r.resumen.ancho_max_medido_px).toBeLessThanOrEqual(anchoUtil(ESTILO));
	});

	it('si un grupo no cabe lo parte; una palabra sola que no cabe va escalada para caber', () => {
		// Centro en x = 300: la zona segura (x 135–945) solo deja 330 px, así que el tope es el ancho útil (418.5).
		const estrecho = resolverEstilo({ancho_max: 420, x: 300});
		const r2 = agruparSubtitulos(FIX.palabras, FIX.tramos, estrecho, {...PARAMETROS_POR_DEFECTO, escalaMin: 1});
		const medir = crearMedidor(estrecho);
		const porIndice = new Map(FIX.palabras.map((p) => [p.i, p]));
		expect(r2.subtitulos.length).toBeGreaterThan(r.subtitulos.length);
		for (const s of r2.subtitulos) {
			const ancho = medir(s.palabras.map((p) => porIndice.get(p.i)!)).ancho;
			if (s.palabras.length > 1) expect(ancho).toBeLessThanOrEqual(anchoUtil(estrecho));
			else if (ancho > anchoUtil(estrecho)) expect(ancho * s.caja!.escala!).toBeLessThanOrEqual(anchoUtil(estrecho));
		}
		// "Desafortunadamente," no cabe en 420 px a 72 px: va sola y escalada, con aviso.
		const larga = r2.subtitulos.find((s) => s.palabras[0].t === 'Desafortunadamente,')!;
		expect(larga.palabras.length).toBe(1);
		expect(larga.caja!.escala!).toBeLessThan(1);
		expect(r2.avisos.join(' ')).toContain('Desafortunadamente');
	});

	it('si 3 palabras no caben en una línea, parte en grupos más chicos (medidor falso)', () => {
		const palabras = seguidas(['abcd', 'efgh', 'ijkl', 'mnop']);
		const r3 = agruparSubtitulos(palabras, [{desde: 0, hasta: 10}], resolverEstilo({ancho_max: 95}), PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(textos(r3.subtitulos)).toEqual(['abcd efgh', 'ijkl mnop']);
	});

	it('prefiere partir en coma y no dejar "a/lo/la/que…" al final de un subtítulo', () => {
		const opciones = [[{desde: 0, hasta: 10}], ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10)] as const;
		expect(textos(agruparSubtitulos(seguidas(['Si', 'funciona,', 'lo', 'guardas', 'y', 'listo']), ...opciones).subtitulos)).toEqual([
			'Si funciona,',
			'lo guardas',
			'y listo',
		]);
		expect(textos(agruparSubtitulos(seguidas(['voy', 'a', 'enseñarte', 'algo', 'nuevo']), ...opciones).subtitulos)).toEqual([
			'voy a enseñarte',
			'algo nuevo',
		]);
	});

	it('no parte un nombre del vocabulario ("Claude Code") si puede evitarlo', () => {
		const palabras = seguidas(['cómo', 'Claude', 'Code', 'puede', 'programar']);
		const tramo = [{desde: 0, hasta: 10}];
		const sin = agruparSubtitulos(palabras, tramo, ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(textos(sin.subtitulos)).toEqual(['cómo Claude', 'Code puede programar']); // empate: sin vocabulario lo parte
		const con = agruparSubtitulos(palabras, tramo, ESTILO, {...PARAMETROS_POR_DEFECTO, terminos: ['Claude Code']}, medidorFalso(10));
		expect(textos(con.subtitulos)).toEqual(['cómo Claude Code', 'puede programar']);
		expect(leerTerminos(join(RAIZ, 'biblioteca', 'vocabulario.json')).terminos).toContain('Claude Code');
	});
});

describe.runIf(HAY_FUENTES)('agrupador: monolíneas de 2–3 palabras (decisión del estilo, 2026-10-04)', () => {
	const tramo = [{desde: 0, hasta: 30}];

	it('una palabra entre pausas de > 250 ms se une a la vecina; aislada entre pausas largas se queda sola', () => {
		// "podemos" | 0.3 s | "mejorar" | 0.3 s | "las cosas": antes salían sueltas.
		const unidas = agruparSubtitulos(seguidas(['podemos', 'mejorar', 'las', 'cosas'], [0.3, 0.3, 0.05]), tramo, ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(unidas.resumen.por_tamano[1]).toBe(0);
		expect(textos(unidas.subtitulos).join(' ')).toBe('podemos mejorar las cosas');
		// "Dale" con 1 s de silencio a los dos lados: no hay con quién unirla.
		const aislada = agruparSubtitulos(seguidas(['esto', 'importa', 'Dale', 'otra', 'vez'], [0.05, 1, 1, 0.05]), tramo, ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(textos(aislada.subtitulos)).toEqual(['esto importa', 'Dale', 'otra vez']);
	});

	it('unirFrasesSueltas: la palabra que cierra oración va con la anterior; tras un punto, con la siguiente; nunca cruza un corte', () => {
		const p = (i: number, t: string, d: number, tramo = 0): PalabraBase => ({i, t, d, h: d + 0.2, tramo});
		expect(unirFrasesSueltas([[p(0, 'muy', 0)], [p(1, 'importante.', 0.5)], [p(2, 'Dale', 1.0), p(3, 'algo', 1.25)]], 2, 0.46).map((f) => f.map((x) => x.t))).toEqual([
			['muy', 'importante.'],
			['Dale', 'algo'],
		]);
		expect(unirFrasesSueltas([[p(0, 'es', 0), p(1, 'esto.', 0.25)], [p(2, 'Dale', 0.75)], [p(3, 'más', 1.25), p(4, 'cosas', 1.5)]], 2, 0.46).map((f) => f.map((x) => x.t))).toEqual([
			['es', 'esto.'],
			['Dale', 'más', 'cosas'],
		]);
		// Otro tramo (hay un corte) a los dos lados: se queda sola.
		expect(unirFrasesSueltas([[p(0, 'a', 0), p(1, 'b', 0.25)], [p(2, 'sola', 0.5, 1)], [p(3, 'c', 0.75, 2), p(4, 'd', 1, 2)]], 2, 0.46)).toHaveLength(3);
	});

	it('si 2 palabras no caben en ancho_max pero sí en el tope (o achicadas hasta escalaMin), van en una línea y no sueltas', () => {
		// medidor falso de 10 px por carácter: "podemos mejorar" = 150 px; ancho_max 140 → util 138.5. Centro en x = 200:
		// la zona segura solo deja 130 px, así que no sube el tope.
		const estilo = resolverEstilo({ancho_max: 140, x: 200});
		const palabras = seguidas(['podemos', 'mejorar']);
		const antes = agruparSubtitulos(palabras, tramo, estilo, {...PARAMETROS_POR_DEFECTO, escalaMin: 1}, medidorFalso(10));
		expect(textos(antes.subtitulos)).toEqual(['podemos', 'mejorar']);
		// Tope de 160 px: cabe a tamaño completo.
		const tope = agruparSubtitulos(palabras, tramo, estilo, {...PARAMETROS_POR_DEFECTO, anchoTopePx: 160}, medidorFalso(10));
		expect(textos(tope.subtitulos)).toEqual(['podemos mejorar']);
		expect(tope.subtitulos[0].caja?.escala).toBeUndefined();
		// Con tope de 145 px: achicada a 143.5 / 150 = 0.956 (≥ 0.95).
		const chica = agruparSubtitulos(palabras, tramo, estilo, {...PARAMETROS_POR_DEFECTO, anchoTopePx: 145}, medidorFalso(10));
		expect(textos(chica.subtitulos)).toEqual(['podemos mejorar']);
		expect(chica.subtitulos[0].caja?.escala).toBeCloseTo(0.956, 3);
		expect(chica.avisos.join(' ')).toContain('achicada');
		// Sin tope habría que achicar a 0.923: aunque el estilo permita 0.91, nunca baja de 0.95 y se parte.
		const parte = agruparSubtitulos(palabras, tramo, estilo, {...PARAMETROS_POR_DEFECTO, escalaMin: 0.91}, medidorFalso(10));
		expect(textos(parte.subtitulos)).toEqual(['podemos', 'mejorar']);
	});

	it('con 4 palabras que no caben de 3 en 3, parte 2 + 2 (nunca 3 + 1)', () => {
		const r = agruparSubtitulos(seguidas(['abcd', 'efgh', 'ijkl', 'mnop']), tramo, resolverEstilo({ancho_max: 120}), PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(textos(r.subtitulos)).toEqual(['abcd efgh', 'ijkl mnop']);
	});

	it('--max-palabras 2 nunca da grupos de 3; un mínimo mayor que el máximo es entrada inválida', () => {
		const r = agruparSubtitulos(seguidas(['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis']), tramo, ESTILO, {...PARAMETROS_POR_DEFECTO, maxPalabras: 2}, medidorFalso(10));
		expect(r.subtitulos.every((s) => s.palabras.length === 2)).toBe(true);
		const f = falloDe(() => agruparSubtitulos(seguidas(['uno']), tramo, ESTILO, {...PARAMETROS_POR_DEFECTO, minPalabras: 3, maxPalabras: 2}, medidorFalso(10)));
		expect(f.codigo).toBe(2);
	});

	it('en el fixture realista solo queda sola la palabra que no cabe con ninguna vecina ni achicada', () => {
		const r = agruparSubtitulos(FIX.palabras, FIX.tramos, ESTILO);
		// "Desafortunadamente," mide casi todo el ancho a 72 px: con cualquier vecina pasa del tope aun achicada.
		expect(textos(r.subtitulos.filter((s) => s.palabras.length === 1))).toEqual(['Desafortunadamente,']);
	});

	it('de estilo.json lee el máximo (p90 = 3), el tope (ancho_p90.p90) y cuánto se puede achicar (alto de mayúscula p10 ÷ p50)', () => {
		const m = leerMiniEstilo(join(RAIZ, 'estilo', 'estilo.json'));
		expect(m.parametros.maxPalabras).toBe(3);
		expect(m.parametros.anchoTopePx).toBeGreaterThan(m.estilo.ancho_max ?? 0);
		expect(m.parametros.escalaMin).toBeGreaterThan(0.8);
		expect(m.parametros.escalaMin).toBeLessThanOrEqual(1);
		expect(m.origen.escala_min).toContain('alto_mayuscula');
	});
});

describe.runIf(HAY_FUENTES)('agrupador: tiempos', () => {
	// Se calcula al recolectar: sin fuentes (describe saltado) no se mide nada.
	const r = HAY_FUENTES ? agruparSubtitulos(FIX.palabras, FIX.tramos, ESTILO) : (null as unknown as ReturnType<typeof agruparSubtitulos>);

	it('todo en cuadros enteros de 30 fps, en orden y sin encimarse', () => {
		r.subtitulos.forEach((s, k) => {
			expect(Math.abs(s.desde * FPS - Math.round(s.desde * FPS))).toBeLessThan(1e-9);
			expect(Math.abs(s.hasta * FPS - Math.round(s.hasta * FPS))).toBeLessThan(1e-9);
			expect(s.hasta).toBeGreaterThan(s.desde);
			if (k > 0) expect(s.desde).toBeGreaterThanOrEqual(r.subtitulos[k - 1].hasta - 1e-9);
		});
	});

	it('por defecto entra en el cuadro de su palabra (adelanto 0: lo que cumple la sincronía acordada)', () => {
		expect(PARAMETROS_POR_DEFECTO.adelantoCuadros).toBe(0);
	});

	it('con adelanto 1 entra 1 cuadro antes de su primera palabra (salvo que lo impida el inicio del tramo o el anterior)', () => {
		const r1 = agruparSubtitulos(FIX.palabras, FIX.tramos, ESTILO, {...PARAMETROS_POR_DEFECTO, adelantoCuadros: 1});
		const iniciosDeTramo = new Set(FIX.tramos.map((t) => Math.round(t.desde * FPS)));
		r1.subtitulos.forEach((s, k) => {
			const esperado = Math.round(s.palabras[0].d * FPS) - 1;
			const real = Math.round(s.desde * FPS);
			if (real !== esperado) {
				const anterior = k > 0 ? Math.round(r1.subtitulos[k - 1].desde * FPS) : -1;
				expect(iniciosDeTramo.has(real) || real === anterior + 1, s.id).toBe(true);
			}
		});
	});

	it('el adelanto es configurable (0 cuadros = entra en el cuadro de su palabra)', () => {
		const r0 = agruparSubtitulos(FIX.palabras, FIX.tramos, ESTILO, {...PARAMETROS_POR_DEFECTO, adelantoCuadros: 0});
		const s = r0.subtitulos[3];
		expect(Math.round(s.desde * FPS)).toBe(Math.round(s.palabras[0].d * FPS));
	});

	it('dura al menos 0.3 s cuando hay lugar, sin pisar al siguiente ni pasar el final del tramo', () => {
		const palabras = [
			{i: 0, t: 'Sí.', d: 1.0, h: 1.08, tramo: 0},
			{i: 1, t: 'Claro.', d: 1.2, h: 1.4, tramo: 0},
			{i: 2, t: 'Fin.', d: 1.95, h: 2.0, tramo: 0}, // 4 cuadros antes del corte: corto, pero no destello
			{i: 3, t: 'Otro', d: 3.0, h: 3.05, tramo: 1},
		];
		const tramos = [
			{desde: 0, hasta: 2.1},
			{desde: 2.1, hasta: 4},
		];
		const r2 = agruparSubtitulos(palabras, tramos, ESTILO, {...PARAMETROS_POR_DEFECTO, minPalabras: 1}, medidorFalso(10));
		const [a, b, c, d] = r2.subtitulos;
		expect(a.hasta).toBeCloseTo(b.desde, 9); // quiere 0.3 s pero el siguiente entra antes: llega justo hasta él
		expect(b.hasta - b.desde).toBeGreaterThanOrEqual(0.3 - 1e-9);
		expect(c.hasta).toBeLessThanOrEqual(2.1 + 1e-9); // no cruza el corte
		expect(d.hasta - d.desde).toBeGreaterThanOrEqual(0.3 - 1e-9);
		expect(r2.resumen.bajo_duracion_minima).toBe(2);
	});

	it('un destello (< 4 cuadros) se une al anterior si caben 3 palabras (en la partición o después); si no, al siguiente', () => {
		// "web." casi no se oye: whisper le da 1 cuadro, entre una pausa y la palabra que sigue.
		const palabras = [
			{i: 0, t: 'hacer', d: 0.0, h: 0.3, tramo: 0},
			{i: 1, t: 'páginas', d: 0.35, h: 0.8, tramo: 0},
			{i: 2, t: 'web.', d: 1.2, h: 1.23, tramo: 0},
			{i: 3, t: 'Chulísimas,', d: 1.234, h: 1.8, tramo: 0},
			{i: 4, t: 'no', d: 1.85, h: 1.95, tramo: 0},
		];
		const r = agruparSubtitulos(palabras, [{desde: 0, hasta: 10}], ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(textos(r.subtitulos)).toEqual(['hacer páginas web.', 'Chulísimas, no']);
		for (const sub of r.subtitulos) expect(Math.round((sub.hasta - sub.desde) * 30)).toBeGreaterThanOrEqual(DESTELLO_CUADROS);
		// Con el anterior lleno (3 palabras) va con el siguiente.
		const llenas = [{i: 0, t: 'uno', d: 0, h: 0.2, tramo: 0}, {i: 1, t: 'dos', d: 0.25, h: 0.4, tramo: 0}, {i: 2, t: 'tres.', d: 0.45, h: 0.6, tramo: 0}, ...palabras.slice(2).map((p, k) => ({...p, i: 3 + k}))];
		const r2 = unirDestellos(
			[llenas.slice(0, 3), [llenas[3]], llenas.slice(4)],
			[{ini: 0, fin: 18}, {ini: 36, fin: 37}, {ini: 37, fin: 59}],
			medidorFalso(10),
			1000,
		);
		expect(r2!.grupos.map((g) => g.map((p) => p.t).join(' '))).toEqual(['uno dos tres.', 'web. Chulísimas, no']);
		// Sin destellos no cambia nada.
		expect(unirDestellos([llenas.slice(0, 3)], [{ini: 0, fin: 18}], medidorFalso(10), 1000)).toBeNull();
	});

	it('la partición evita grupos de menos de 4 cuadros en habla rápida ("es a" de 3 cuadros → otro reparto)', () => {
		// "que vas a ir es a la herramienta": "es a" se dice en 0.1 s.
		const t = [0, 0.15, 0.3, 0.42, 0.55, 0.6, 0.65, 0.75, 1.3];
		const ws = ['que', 'vas', 'a', 'ir', 'es', 'a', 'la', 'herramienta', 'fin.'];
		const palabras = ws.map((x, i) => ({i, t: x, d: t[i], h: (t[i + 1] ?? t[i] + 0.3) - 0.01, tramo: 0}));
		const r = agruparSubtitulos(palabras, [{desde: 0, hasta: 10}], ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		for (const sub of r.subtitulos) expect(Math.round((sub.hasta - sub.desde) * 30)).toBeGreaterThanOrEqual(DESTELLO_CUADROS);
	});

	it('último recurso: si no se puede unir, el siguiente (en habla continua) cede hasta 2 cuadros; tras una pausa no cede', () => {
		const g = [[{i: 0, t: 'web.', d: 1.2, h: 1.25, tramo: 1}], [{i: 1, t: 'Chulísimas,', d: 1.267, h: 1.9, tramo: 1}]];
		const v = [{ini: 36, fin: 38}, {ini: 38, fin: 57}];
		const avisos = estirarDestellos(g, v);
		expect(v).toEqual([{ini: 36, fin: 40}, {ini: 40, fin: 57}]);
		expect(avisos[0]).toMatch(/duraba 2 cuadros: el siguiente entra 2 cuadros después/);
		// Con hueco entre los dos (el siguiente arranca tras una pausa) no se toca.
		const v2 = [{ini: 36, fin: 38}, {ini: 45, fin: 57}];
		expect(estirarDestellos(g, v2)).toEqual([]);
		expect(v2[1].ini).toBe(45);
	});

	it('con pausas de 250 ms o menos se queda hasta que entra el siguiente (sin parpadeo)', () => {
		const palabras = seguidas(['uno', 'dos', 'tres', 'cuatro', 'cinco'], [0.05, 0.05, 0.2, 0.05]);
		const r2 = agruparSubtitulos(palabras, [{desde: 0, hasta: 10}], ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(r2.subtitulos.length).toBe(2);
		expect(r2.subtitulos[0].hasta).toBeCloseTo(r2.subtitulos[1].desde, 9);
	});

	it('la palabra que arranca justo en el inicio de un tramo no se adelanta al tramo anterior', () => {
		const palabras = [
			{i: 0, t: 'antes', d: 0.5, h: 0.9, tramo: 0},
			{i: 1, t: 'después', d: 1.0, h: 1.4, tramo: 1},
		];
		const r2 = agruparSubtitulos(palabras, [{desde: 0, hasta: 1}, {desde: 1, hasta: 2}], ESTILO, PARAMETROS_POR_DEFECTO, medidorFalso(10));
		expect(r2.subtitulos[1].desde).toBeCloseTo(1, 9);
		expect(r2.subtitulos[0].hasta).toBeLessThanOrEqual(1 + 1e-9);
	});
});

// ───────────────────────── etapa completa (archivos) ─────────────────────────

describe.runIf(HAY_FUENTES)('generarSubtitulos (proyectos/<slug>/subtitulos.json)', () => {
	let proyectos: string;
	const slug = '_prueba-subtitulos';
	const escribir = (nombre: string, datos: unknown, s = slug) => {
		mkdirSync(join(proyectos, s), {recursive: true});
		writeFileSync(join(proyectos, s, nombre), typeof datos === 'string' ? datos : JSON.stringify(datos));
	};

	beforeAll(() => {
		proyectos = mkdtempSync(join(tmpdir(), 'editor-subtitulos-'));
	});
	afterAll(() => {
		rmSync(proyectos, {recursive: true, force: true});
	});

	it('lee transcripcion-base.json + cortes.json y escribe el arreglo listo para la EDL', async () => {
		escribir('transcripcion-base.json', {palabras: FIX.palabras});
		escribir('cortes.json', {keep: FIX.keep});
		const r = await generarSubtitulos({slug, proyectos, estilo: null});
		const archivo = JSON.parse(readFileSync(join(proyectos, slug, 'subtitulos.json'), 'utf8'));
		expect(archivo.subtitulos.length).toBe(r.subtitulos.length);
		expect(SubtituloEsquema.array().safeParse(archivo.subtitulos).success).toBe(true);
		expect(archivo.subtitulos.map((s: {id: string}) => s.id)).toEqual(archivo.subtitulos.map((_: unknown, k: number) => `s${k + 1}`));
		expect(archivo.subtitulos.every((s: {caja: {x: number; y: number}}) => s.caja.x === 540 && s.caja.y === ESTILO.y)).toBe(true);
		expect(archivo.estilo).toMatchObject({fuente: 'tiktok-sans', peso: 600, ancho_max: 864});
		expect(archivo.fuente).toMatchObject({archivo: 'biblioteca/fuentes/tiktok-sans/TikTokSans-SemiBold.ttf'});
		expect(archivo.origen.keep).toBe('cortes.json');
		expect(archivo.origen.ancho_max).toContain('supuesto');
		expect(archivo.avisos.join(' ')).toContain('sin mini-estilo');
		expect(archivo.parametros.terminos_sin_partir).toContain('Claude Code');
		// Entra tal cual en una EDL válida con la duración de la base.
		const edl = {...edicionVacia, duracion_s: FIX.duracionBase, subtitulos: archivo.subtitulos};
		const v = EdicionValidada.safeParse(edl);
		expect(v.success, v.success ? '' : JSON.stringify(v.error.issues[0])).toBe(true);
		// Queda registrado en el manifest con sus entradas.
		const etapa = leerManifest(slug, proyectos)!.etapas.subtitulos;
		expect(etapa.estado).toBe('terminada');
		expect(etapa.entradas.length).toBeGreaterThanOrEqual(3); // transcripción, cortes y fuente
	});

	it('sin cortes.json: un solo tramo; si la palabra no trae tramo se deduce del tiempo', async () => {
		const s = '_prueba-sin-cortes';
		escribir('transcripcion-base.json', seguidas(['Hola', 'a', 'todos.', 'Bienvenidos']).map((p) => ({i: p.i, t: p.t, d: p.d, h: p.h})), s);
		const r = await generarSubtitulos({slug: s, proyectos, estilo: null, minPalabras: 1});
		expect(textos(r.subtitulos)).toEqual(['Hola a todos.', 'Bienvenidos']);
		// Con el mínimo de 2 (por defecto), "Bienvenidos" no se queda sola: el estilo pide 2–3 palabras por subtítulo.
		const dos = await generarSubtitulos({slug: s, proyectos, estilo: null});
		expect(dos.subtitulos.every((x) => x.palabras.length >= 2)).toBe(true);
		expect(dos.parametros).toMatchObject({minPalabras: 2, maxPalabras: 3});
		expect(r.avisos.join(' ')).toContain('no sé cuánto dura la base');
	});

	it('usa el mini-estilo: Y, ancho máximo, p10 de duración y alto de mayúscula (N/A → por defecto, con aviso)', async () => {
		const mini = join(proyectos, 'mini-estilo.json');
		writeFileSync(
			mini,
			JSON.stringify({
				subtitulos: {
					y: {valor: 1100, n: 6, fuente: 'medir.ts', falta: null},
					ancho: {p10: 500, p50: 620, p90: 700},
					duracion_s: {p10: 0.4, p50: 0.8},
					alto_mayuscula: {valor: 50.76, n: 6},
					grosor_borde: {valor: 'N/A', n: 0, fuente: 'medir.ts', falta: 'sin recortes'},
					color_texto: '#FFFFFF',
				},
			}),
		);
		const r = await generarSubtitulos({slug, proyectos, estilo: mini});
		expect(r.estilo.y).toBe(1100);
		expect(r.estilo.ancho_max).toBe(700);
		expect(r.estilo.tamano_px).toBeCloseTo(50.76 / CANDIDATAS['tiktok-sans'].altoMayuscula, 1);
		expect(r.estilo.borde_px).toBe(ESTILO_SUBTITULO_POR_DEFECTO.borde_px);
		expect(r.parametros.duracionMinS).toBe(0.4);
		expect(r.origen.y).toContain('subtitulos.y');
		expect(r.origen.ancho_max).toContain('ancho.p90');
		expect(r.avisos.join(' ')).toContain('N/A');
		expect(r.subtitulos.every((s) => s.caja?.y === 1100)).toBe(true);
		// Todo cabe en la zona segura de subtítulos (810 px): "Desafortunadamente," (710 px a 72 px) pasa de los 700 del
		// estilo, pero cabe a tamaño completo en la zona y no se achica.
		const medir = crearMedidor(r.estilo);
		const porIndice = new Map(FIX.palabras.map((p) => [p.i, p]));
		for (const s of r.subtitulos) {
			expect(medir(s.palabras.map((p) => porIndice.get(p.i)!)).ancho * (s.caja?.escala ?? 1), s.id).toBeLessThanOrEqual(810 - MARGEN_ANTIALIAS_PX);
		}
		expect(r.resumen.escalados).toBe(0);
	});

	it('--fuente cambia la candidata y mide con su archivo', async () => {
		const r = await generarSubtitulos({slug, proyectos, estilo: null, fuente: 'inter'});
		expect(r.estilo.fuente).toBe('inter');
		const archivo = JSON.parse(readFileSync(join(proyectos, slug, 'subtitulos.json'), 'utf8'));
		expect(archivo.fuente.archivo).toBe('biblioteca/fuentes/inter/Inter-SemiBold.ttf');
		expect(r.resumen.ancho_max_medido_px).toBeLessThanOrEqual(864);
	});

	it('entradas inválidas salen con código 2 y una frase con siguiente paso', async () => {
		const casos: [string, () => Promise<unknown>][] = [
			['no existe la transcripción', () => generarSubtitulos({slug: '_prueba-vacio', proyectos, estilo: null})],
			[
				'JSON roto',
				async () => {
					escribir('transcripcion-base.json', '{"palabras": [', '_prueba-roto');
					return generarSubtitulos({slug: '_prueba-roto', proyectos, estilo: null});
				},
			],
			[
				'palabra fuera de su tramo',
				async () => {
					escribir('transcripcion-base.json', {palabras: [{i: 0, t: 'hola', d: 5, h: 5.2, tramo: 0}]}, '_prueba-fuera');
					escribir('cortes.json', {keep: [{desde: 0, hasta: 1}, {desde: 2, hasta: 3}]}, '_prueba-fuera');
					return generarSubtitulos({slug: '_prueba-fuera', proyectos, estilo: null});
				},
			],
			[
				'índices fuera de orden',
				async () => {
					escribir('transcripcion-base.json', {palabras: [{i: 1, t: 'b', d: 0.1, h: 0.2, tramo: 0}, {i: 0, t: 'a', d: 0.3, h: 0.4, tramo: 0}]}, '_prueba-orden');
					return generarSubtitulos({slug: '_prueba-orden', proyectos, estilo: null});
				},
			],
			[
				'mini-estilo fuera de rango',
				async () => {
					const mini = join(proyectos, 'mini-malo.json');
					writeFileSync(mini, JSON.stringify({subtitulos: {y: 5000}}));
					return generarSubtitulos({slug, proyectos, estilo: mini});
				},
			],
			['fuente desconocida', () => generarSubtitulos({slug, proyectos, estilo: null, fuente: 'comic-sans'})],
		];
		for (const [nombre, correrCaso] of casos) {
			const error = await falloAsync(correrCaso());
			expect(error.codigo, nombre).toBe(2);
			expect(error.message, nombre).toMatch(FORMATO);
		}
	});

	it('normalizarPalabras: tramo que no existe o palabra que retrocede → código 2', () => {
		const tramos = [{desde: 0, hasta: 5}];
		expect(falloDe(() => normalizarPalabras([{i: 0, t: 'a', d: 1, h: 1.2, tramo: 3}], tramos)).codigo).toBe(2);
		expect(
			falloDe(() =>
				normalizarPalabras(
					[
						{i: 0, t: 'a', d: 2, h: 2.2, tramo: 0},
						{i: 1, t: 'b', d: 1, h: 1.2, tramo: 0},
					],
					tramos,
				),
			).codigo,
		).toBe(2);
	});

	it('leerMiniEstilo entiende la salida de medir.ts ("resumen": y_p50, ancho_p90, alto_mayuscula_p50…)', () => {
		const ruta = join(proyectos, 'medir.json');
		writeFileSync(
			ruta,
			JSON.stringify({
				video: 'Dk3pCcbY3_x.mp4',
				resumen: {
					y_p10: 1150,
					y_p50: 1180.5,
					y_p90: 1210,
					ancho_p90: 780,
					alto_mayuscula_p50: 52,
					color_texto: '#FDFDFD',
					color_borde: '#050505',
					grosor_borde_p50: 4.5,
					palabras_por_evento: {p10: 1, p50: 2, p90: 3},
					duracion: {p10: 0.35, p50: 0.7, p90: 1.2},
					mayusculas_pct: 80,
					resaltado_pct: null,
				},
			}),
		);
		const m = leerMiniEstilo(ruta);
		expect(m.estilo).toMatchObject({y: 1180.5, ancho_max: 780, borde_px: 4.5, color: '#FDFDFD', color_borde: '#050505', mayusculas: true});
		expect(m.altoMayusculaPx).toBe(52);
		expect(m.parametros).toMatchObject({palabrasObjetivo: 2, duracionMinS: 0.35});
		expect(m.origen.y).toContain('resumen.y_p50');
		expect(m.origen.mayusculas).toContain('80');
	});

	it('con objetivo de 2 palabras, una frase de 3 no se parte en 2 + 1 (la suelta se castiga)', () => {
		const r = agruparSubtitulos(seguidas(['uno', 'dos', 'tres']), [{desde: 0, hasta: 10}], ESTILO, {...PARAMETROS_POR_DEFECTO, palabrasObjetivo: 2}, medidorFalso(10));
		expect(textos(r.subtitulos)).toEqual(['uno dos tres']);
	});

	it('leerMiniEstilo acepta el nombre de la fuente y métricas {valor}', () => {
		const ruta = join(proyectos, 'mini-fuente.json');
		writeFileSync(ruta, JSON.stringify({subtitulos: {fuente: 'Instrument Sans', borde_px: {valor: 4}, palabras_p50: 2.2}}));
		const m = leerMiniEstilo(ruta);
		expect(m.estilo.fuente).toBe('instrument-sans');
		expect(m.estilo.borde_px).toBe(4);
		expect(m.parametros.palabrasObjetivo).toBe(2.2);
	});

	it('el adelanto MEDIDO en tus reels queda como dato (la sincronía acordada manda); un número suelto (ajuste tuyo) sí se aplica', () => {
		const medido = join(proyectos, 'mini-adelanto-medido.json');
		writeFileSync(medido, JSON.stringify({subtitulos: {adelanto_cuadros: {valor: 1.1, n: 21, fuente: 'medido: medir.ts'}}}));
		const m = leerMiniEstilo(medido);
		expect(m.parametros.adelantoCuadros).toBeUndefined();
		expect(m.adelantoMedido).toEqual({cuadros: 1.1, donde: expect.stringContaining('subtitulos.adelanto_cuadros')});
		expect(m.origen.adelanto_cuadros).toBeUndefined();
		const ajuste = join(proyectos, 'mini-adelanto-ajuste.json');
		writeFileSync(ajuste, JSON.stringify({subtitulos: {adelanto_cuadros: 2}}));
		const a = leerMiniEstilo(ajuste);
		expect(a.parametros.adelantoCuadros).toBe(2);
		expect(a.adelantoMedido).toBeUndefined();
	});
});

describe.runIf(HAY_FUENTES)('CLI', () => {
	it('sin slug sale con código 2 y una sola frase con siguiente paso', () => {
		const r = spawnSync('npx', ['tsx', 'herramientas/subtitulos.ts'], {cwd: RAIZ, encoding: 'utf8'});
		expect(r.status).toBe(2);
		expect(sinAvisosNpm(r.stderr)).toMatch(FORMATO);
	});

	it('--min-palabras fuera de 1–3 sale con código 2', () => {
		const r = spawnSync('npx', ['tsx', 'herramientas/subtitulos.ts', 'x', '--min-palabras', '4'], {cwd: RAIZ, encoding: 'utf8'});
		expect(r.status).toBe(2);
		expect(sinAvisosNpm(r.stderr)).toMatch(FORMATO);
	});
});

describe('agrupador: revisión de la v11 de un reel de prueba (zona segura, puntos y nexos)', () => {
	const tramo = [{desde: 0, hasta: 30}];
	// Como su estilo: ancho_max 450.1 y tope medido 503.1 px.
	const estilo = resolverEstilo({ancho_max: 450.1});
	const parametros = {...PARAMETROS_POR_DEFECTO, anchoTopePx: 503.1, escalaMin: 0.91, palabrasObjetivo: 2};
	const textosDe = (r: ReturnType<typeof agruparSubtitulos>) => r.subtitulos.map((s) => s.palabras.map((p) => p.t).join(' '));

	it('el tope de una línea es la zona segura de subtítulos (810 px) si es mayor que el medido; la escala nunca baja de 0.95', () => {
		expect(anchoZonaSubtitulos(540)).toBe(810);
		const forma = formaDe(estilo, parametros);
		expect(forma.anchoTope).toBe(810 - MARGEN_ANTIALIAS_PX);
		expect(forma.escalaMin).toBe(ESCALA_MIN_ABSOLUTA);
		expect(formaDe(estilo, {...parametros, escalaMin: 1}).escalaMin).toBe(1);
	});

	it('«mejorar las animaciones?» (720 px) va completa en una línea y sin achicar, no 0.7 ni partida con una suelta', () => {
		const r = agruparSubtitulos(seguidas(['¿Cómo', 'podemos', 'mejorar', 'las', 'animaciones?']), tramo, estilo, parametros, medidorFalso(30));
		expect(textosDe(r)).toEqual(['¿Cómo podemos', 'mejorar las animaciones?']);
		expect(r.subtitulos.every((s) => s.caja?.escala === undefined)).toBe(true);
		expect(r.resumen.escalados).toBe(0);
	});

	it('si ni en la zona cabe (ni a 0.95), parte 2 + 2 respetando el mínimo de 2', () => {
		// 40 px por carácter: «mejorar las animaciones» = 920 px > 808.5 / 0.95.
		const r = agruparSubtitulos(seguidas(['podemos', 'mejorar', 'las', 'animaciones']), tramo, estilo, parametros, medidorFalso(40));
		expect(textosDe(r)).toEqual(['podemos mejorar', 'las animaciones']);
		expect(r.subtitulos.every((s) => (s.caja?.escala ?? 1) >= ESCALA_MIN_ABSOLUTA)).toBe(true);
	});

	it('no junta palabras a los dos lados de un punto: «Y» tras un punto va con lo que sigue aunque haya 0.6 s de pausa', () => {
		const r = agruparSubtitulos(seguidas(['es', 'tu', 'página.', 'Y', 'sigue', 'más'], [0.05, 0.05, 0.05, 0.6, 0.05]), tramo, estilo, parametros, medidorFalso(10));
		expect(textosDe(r)).toEqual(['es tu página.', 'Y sigue más']);
		expect(r.subtitulos.every((s) => crucesDeOracion(s.palabras) === 0)).toBe(true);
		// ¿/¡ también abre otra oración.
		expect(crucesDeOracion([{t: 'esto'}, {t: '¿Cómo'}])).toBe(1);
	});

	it('cruza un punto solo si no queda otra para no dejar una palabra suelta', () => {
		// «Y» aislada 2 s antes de lo que sigue: o va con la anterior o queda sola; cruza, pero en un grupo de 2.
		const r = agruparSubtitulos(seguidas(['es', 'tu', 'página.', 'Y', 'sigue', 'más'], [0.05, 0.05, 0.05, 2, 0.05]), tramo, estilo, parametros, medidorFalso(10));
		expect(r.resumen.por_tamano[1]).toBe(0);
		expect(textosDe(r)).toEqual(['es tu', 'página. Y', 'sigue más']);
	});

	it('no termina un subtítulo en artículo, preposición o conjunción si la siguiente palabra puede ir con él', () => {
		const frase = ['y', 'ya', 'puedes', 'agregarle', 'las', 'reglas', 'de', 'diseño', 'de', 'Apple'];
		const r = agruparSubtitulos(seguidas(frase), tramo, estilo, parametros, medidorFalso(10));
		const grupos = r.subtitulos.map((s) => s.palabras);
		expect(grupos.slice(0, -1).filter((g) => esNexo(g.at(-1)!.t)).map((g) => g.map((p) => p.t).join(' '))).toEqual([]);
		expect(r.resumen.por_tamano[1]).toBe(0);
		expect(esNexo('las')).toBe(true);
		expect(esNexo('y,')).toBe(false);
	});

	it('unirDestellos: un destello tras un punto va con el siguiente, no con el anterior', () => {
		const p = (i: number, t: string): PalabraBase => ({i, t, d: i, h: i + 0.2, tramo: 0});
		const grupos = [[p(0, 'hacer'), p(1, 'eso.')], [p(2, 'Y')], [p(3, 'de'), p(4, 'hecho')]];
		const r = unirDestellos(grupos, [{ini: 0, fin: 10}, {ini: 10, fin: 12}, {ini: 12, fin: 30}], medidorFalso(10), 1000, {maxPalabras: 3, anchoTope: 1000, escalaMin: 1});
		expect(r?.grupos.map((g) => g.map((x) => x.t).join(' '))).toEqual(['hacer eso.', 'Y de hecho']);
	});
});
