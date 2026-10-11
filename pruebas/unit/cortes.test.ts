/**
 * Pruebas de la etapa de cortes: herramientas/lib/tomas.ts (tomas repetidas y arranques en falso) y
 * herramientas/cortes.ts (keep[], bordes en silencio y en cuadro, remapeo y texto aprobado).
 *
 * El audio es sintético y determinista (ruido con semilla fija + "vocales" con inicio y fin conocidos), así que
 * cada prueba sabe dónde está de verdad cada palabra. Las palabras "de whisper" se dan con el final estirado hasta
 * la palabra siguiente, como lo hace whisper.cpp, para probar que los cortes no se fían de esos finales.
 */
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {leerCortes} from '../../herramientas/base.ts';
import {
	alinearTexto,
	analizarEnergia,
	armarTranscripcionBase,
	construirKeep,
	ejecutarCortes,
	leerTextoAprobado,
	palabrasDistintas,
	PARAMETROS_CORTES,
	refinarPalabras,
	silenciosEn,
	sinEditar,
	verificarCortes,
	type Palabra,
	type PalabraSalida,
} from '../../herramientas/cortes.ts';
import {energiaEnIntervalo, escribirWav, type Wav} from '../../herramientas/lib/energia.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {leerManifest} from '../../herramientas/lib/manifest.ts';
import {aCrudo, duracionBase, FPS, validarKeep, type Tramo} from '../../herramientas/lib/remapear.ts';
import {claveDeToma, detectarTomas, dividirEnFrases, normalizarPalabra, similitud} from '../../herramientas/lib/tomas.ts';

// ───────────────────────── audio sintético ─────────────────────────

const FS = 16000;
const PISO_DBFS = -65;

function lcg(semilla: number): () => number {
	let s = semilla >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}

const amp = (dbfs: number) => 10 ** (dbfs / 20);
const n = (s: number) => Math.round(s * FS);

class Senal {
	readonly x: Float64Array;
	constructor(duracionS: number, pisoDbfs = PISO_DBFS, semilla = 7) {
		this.x = new Float64Array(n(duracionS));
		const azar = lcg(semilla);
		const a = amp(pisoDbfs) * Math.sqrt(3);
		for (let i = 0; i < this.x.length; i++) this.x[i] = a * azar();
	}

	/** "Vocal" (armónicos de f0) de [inicio, inicio + duracion) con ataque de 5 ms y caída de 10 ms; nivel = RMS. */
	voz(inicioS: number, duracionS: number, nivelDbfs = -20, f0 = 120): this {
		const armonicos = Math.floor(3000 / f0);
		let norma = 0;
		for (let k = 1; k <= armonicos; k++) norma += 1 / (k * k) / 2;
		const escala = amp(nivelDbfs) / Math.sqrt(norma);
		const i0 = n(inicioS);
		const largo = n(duracionS);
		for (let i = 0; i < largo && i0 + i < this.x.length; i++) {
			const t = i / FS;
			let v = 0;
			for (let k = 1; k <= armonicos; k++) v += Math.sin(2 * Math.PI * k * f0 * t + k * k * 0.7) / k;
			this.x[i0 + i] += escala * v * envolvente(t, duracionS, 0.005, 0.01);
		}
		return this;
	}

	wav(): Wav {
		const muestras = Int16Array.from(this.x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
		return {frecuencia: FS, muestras, duracionS: muestras.length / FS};
	}
}

function envolvente(t: number, duracion: number, subida: number, bajada: number): number {
	if (t < subida) return 0.5 - 0.5 * Math.cos((Math.PI * t) / subida);
	if (t > duracion - bajada) return Math.max(0, 0.5 - 0.5 * Math.cos((Math.PI * (duracion - t)) / bajada));
	return 1;
}

/** Palabra real: dónde suena de verdad. */
type Real = {t: string; d: number; h: number};

/**
 * Arma el audio y las palabras "de whisper": el inicio llega 20 ms antes del real y el final se estira hasta la
 * palabra siguiente (o 0.3 s después del real en la última), como hace whisper.cpp.
 */
function escena(reales: Real[], duracionS: number, extras: Array<[number, number]> = [], semilla = 7): {wav: Wav; palabras: Palabra[]} {
	const s = new Senal(duracionS, PISO_DBFS, semilla);
	reales.forEach((r, k) => s.voz(r.d, r.h - r.d, -20, 110 + 7 * (k % 5)));
	for (const [a, b] of extras) s.voz(a, b - a, -22, 150);
	const palabras: Palabra[] = reales.map((r, i) => {
		const siguiente = reales[i + 1];
		const d = Math.max(0, r.d - 0.02, i > 0 ? reales[i - 1].h : 0);
		const h = siguiente ? Math.max(r.h, siguiente.d - 0.02) : Math.min(duracionS, r.h + 0.3);
		return {i, t: r.t, d: Math.round(d * 1000) / 1000, h: Math.round(h * 1000) / 1000};
	});
	return {wav: s.wav(), palabras};
}

/** Corre la propuesta automática sobre una escena y devuelve todo lo necesario para revisarla. */
function proponer(wav: Wav, palabras: Palabra[], seleccionForzada?: boolean[]) {
	const energia = analizarEnergia(wav, palabras);
	const {limites} = refinarPalabras(energia, palabras);
	const {frases} = detectarTomas(palabras.map((w, j) => ({t: w.t, d: limites[j].d, h: limites[j].h})));
	const propuesta = new Array<boolean>(palabras.length).fill(false);
	for (const f of frases) if (!f.descartada) for (let j = f.i0; j <= f.i1; j++) propuesta[j] = true;
	const seleccion = seleccionForzada ?? propuesta;
	const r = construirKeep({limites, seleccion, energia, limiteS: wav.duracionS});
	return {energia, refinados: limites, frases, propuesta, seleccion, ...r};
}

const EPS = 1e-6;
const bordesDe = (keep: readonly Tramo[]) => keep.flatMap((t) => [t.desde, t.hasta]);
const dentroDeUnTramo = (keep: readonly Tramo[], a: number, b: number) => keep.some((t) => t.desde - EPS <= a && b <= t.hasta + EPS);
const tocaUnTramo = (keep: readonly Tramo[], a: number, b: number) => keep.some((t) => t.desde < b - EPS && t.hasta > a + EPS);

/** Revisión independiente contra dónde suenan DE VERDAD las palabras (no contra lo que dijo whisper). */
function revisarContraLaVerdad(keep: readonly Tramo[], reales: readonly Real[], seleccion: readonly boolean[]): void {
	for (const b of bordesDe(keep)) {
		for (const r of reales) expect(b > r.d + EPS && b < r.h - EPS, `borde ${b} dentro de «${r.t}» [${r.d}, ${r.h}]`).toBe(false);
	}
	reales.forEach((r, j) => {
		if (seleccion[j]) expect(dentroDeUnTramo(keep, r.d, r.h), `«${r.t}» se queda y no cae entera en un tramo`).toBe(true);
		else expect(tocaUnTramo(keep, r.d, r.h), `«${r.t}» se quita y toca un tramo`).toBe(false);
	});
}

// Escena base: pausas de 0.10, 0.25, 0.35, 0.50, 1.00, 2.00, 0.10 y 0.10 s entre palabras.
const PAUSAS: Real[] = [
	{t: 'Hola', d: 0.5, h: 0.9},
	{t: 'esto', d: 1.0, h: 1.4},
	{t: 'es', d: 1.65, h: 2.05},
	{t: 'una', d: 2.4, h: 2.8},
	{t: 'prueba.', d: 3.3, h: 3.7},
	{t: 'Ahora', d: 4.7, h: 5.1},
	{t: 'seguimos', d: 7.1, h: 7.5},
	{t: 'con', d: 7.6, h: 8.0},
	{t: 'otra.', d: 8.1, h: 8.6},
];

// ───────────────────────── tomas.ts ─────────────────────────

/** Palabras con tiempos inventados: cada frase de la lista va seguida de una pausa de `pausa` s. */
function frasesConTiempo(frases: string[], pausa = 0.8, inicio = 0.5): Array<{t: string; d: number; h: number}> {
	const salida: Array<{t: string; d: number; h: number}> = [];
	let t = inicio;
	for (const frase of frases) {
		for (const w of frase.split(' ')) {
			salida.push({t: w, d: t, h: t + 0.25});
			t += 0.3;
		}
		t += pausa;
	}
	return salida;
}

describe('tomas.ts: normalización y similitud', () => {
	it('normaliza sin acentos ni puntuación y junta b/v, z/s y la h muda solo para comparar tomas', () => {
		expect(normalizarPalabra('¿Cómo')).toBe('como');
		expect(normalizarPalabra('5.5')).toBe('55');
		expect(normalizarPalabra('—')).toBe('');
		expect(claveDeToma('BAS...')).toBe(claveDeToma('Vas'));
		expect(claveDeToma('hacer')).toBe('acer');
		expect(claveDeToma('chambear')).toBe('chambear');
		expect(claveDeToma('zapato')).toBe('sapato');
	});

	it('similitud = 2·LCS / (|A|+|B|)', () => {
		expect(similitud(['a', 'b', 'c'], ['a', 'b', 'c']).valor).toBe(1);
		expect(similitud(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd'])).toEqual({valor: 0.75, comunes: 3});
		expect(similitud([], []).valor).toBe(0);
	});
});

describe('tomas.ts: frases', () => {
	it('corta en . ? ! … ;, antes de ¿ o ¡ y en pausas de más de 0.6 s, pero no en comas', () => {
		const palabras = [
			{t: 'Hola,', d: 0, h: 0.2},
			{t: 'qué', d: 0.25, h: 0.4},
			{t: 'tal.', d: 0.45, h: 0.6},
			{t: 'Bien', d: 0.65, h: 0.8},
			{t: '¿Y', d: 0.85, h: 0.9},
			{t: 'tú?', d: 0.95, h: 1.1},
			{t: 'Yo', d: 1.15, h: 1.3},
			{t: 'aquí', d: 2.0, h: 2.2}, // pausa de 0.7 s
		];
		expect(dividirEnFrases(palabras)).toEqual([
			{i0: 0, i1: 2},
			{i0: 3, i1: 3},
			{i0: 4, i1: 5},
			{i0: 6, i1: 6},
			{i0: 7, i1: 7},
		]);
	});

	it('una repetición con comas dentro de la misma frase no es toma repetida', () => {
		const {frases} = detectarTomas(frasesConTiempo(['No me creas, la verdad, no me creas.']));
		expect(frases).toHaveLength(1);
		expect(frases[0].descartada).toBe(false);
	});
});

describe('tomas.ts: tomas repetidas (se queda la última)', () => {
	it('descarta la toma anterior por parecido (≥ 0.6 con ≥ 3 palabras en común)', () => {
		const {frases} = detectarTomas(
			frasesConTiempo(['Vas a crear un folder que se llame página web.', 'Luego vas a crear un folder que se llame página web de tu negocio.']),
		);
		expect(frases.map((f) => f.descartada)).toEqual([true, false]);
		expect(frases[0].tipo).toBe('parecido');
		expect(frases[0].por).toBe(1);
		expect(frases[0].motivo).toMatch(/toma repetida: se parece \d+ % a la frase 2/);
	});

	it('descarta por mismo arranque aunque el parecido no llegue a 0.6 (caso real de IMG_5199)', () => {
		const a = 'Y esto lo está volviendo un modelo de volumen.';
		const b = 'y esto lo vuelve un modelo para volumen y así lo están categorizando.';
		const {frases} = detectarTomas(frasesConTiempo([a, b]));
		expect(frases[0].similitud).toBeLessThan(0.6);
		expect(frases.map((f) => f.descartada)).toEqual([true, false]);
		expect(frases[0].tipo).toBe('mismo-arranque');
		expect(frases[0].motivo).toContain('«y esto lo»');
	});

	it('en una cadena A ~ B ~ C descarta A y B y deja C', () => {
		const {frases} = detectarTomas(
			frasesConTiempo([
				'Y esto lo está volviendo un modelo de volumen.',
				'y esto lo vuelve un modelo para volumen y así se lo están cali...',
				'y esto lo vuelve un modelo para volumen y así lo están categorizando.',
			]),
		);
		expect(frases.map((f) => f.descartada)).toEqual([true, true, false]);
		expect(frases[1].cortada).toBe(true);
	});

	it('no compara frases separadas por 10 s o más', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Vas a crear un folder que se llame página web.', 'Vas a crear un folder que se llame página web.'], 10.5));
		expect(frases.map((f) => f.descartada)).toEqual([false, false]);
	});

	it('un fragmento corto después no tumba a una frase completa por su arranque', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Vas a hacer un nuevo folder que se llame página web.', 'Vas a hacer']));
		expect(frases.map((f) => f.descartada)).toEqual([false, false]);
	});

	it('frases distintas que solo comparten 2 palabras al inicio se quedan', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Vas a copiar la liga en el botón verde.', 'Vas a buscar páginas que te gusten.']));
		expect(frases.map((f) => f.descartada)).toEqual([false, false]);
	});
});

describe('tomas.ts: arranques en falso', () => {
	it('una frase de 1–3 palabras que la siguiente repite completa al inicio se descarta', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Vas a.', 'Vas a ir a la parte de Code.'], 0.4));
		expect(frases.map((f) => f.descartada)).toEqual([true, false]);
		expect(frases[0].tipo).toBe('arranque-en-falso');
		expect(frases[0].motivo).toMatch(/^arranque en falso: «Vas a\.» se repite completo/);
	});

	it('reconoce el tartamudeo que whisper escribe distinto ("BAS... BAS... Vas a ir", IMG_4869)', () => {
		const {frases} = detectarTomas(frasesConTiempo(['BAS...', 'BAS...', 'Vas a ir a la parte de Code'], 0.7));
		expect(frases.map((f) => f.descartada)).toEqual([true, true, false]);
		expect(frases.every((f) => !f.descartada || f.tipo === 'arranque-en-falso')).toBe(true);
	});

	it('acepta una palabra de relleno antes de la repetición ("y vas a…")', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Vas a.', 'y vas a ir a la parte de Code.'], 0.4));
		expect(frases[0].descartada).toBe(true);
	});

	it('una frase corta seguida de otra cosa se queda', () => {
		const {frases} = detectarTomas(frasesConTiempo(['Es gratis.', 'Vas a copiar la liga en el botón verde.'], 0.4));
		expect(frases.map((f) => f.descartada)).toEqual([false, false]);
	});
});

// ───────────────────────── cortes.ts: keep[] ─────────────────────────

describe('cortes.ts: silencios', () => {
	const {wav, palabras} = escena(PAUSAS, 10);
	const r = proponer(wav, palabras);

	it('corta solo los huecos de más de 0.3 s (0.35, 0.5, 1 y 2 s), además del inicio y el final', () => {
		expect(r.keep).toHaveLength(5);
		expect(r.cortes.map((c) => c.motivo)).toEqual(['inicio', 'silencio', 'silencio', 'silencio', 'silencio', 'final']);
		// Cada corte de silencio cae dentro del hueco correspondiente.
		const huecos: Array<[number, number]> = [
			[2.05, 2.4],
			[2.8, 3.3],
			[3.7, 4.7],
			[5.1, 7.1],
		];
		r.cortes
			.filter((c) => c.motivo === 'silencio')
			.forEach((c, k) => {
				expect(c.desde).toBeGreaterThan(huecos[k][0]);
				expect(c.hasta).toBeLessThan(huecos[k][1]);
			});
	});

	it('ningún borde cae dentro de una palabra (ni de whisper ni de verdad) y la verificación sale limpia', () => {
		revisarContraLaVerdad(r.keep, PAUSAS, r.seleccion);
		const v = verificarCortes(r.keep, r.limites, r.seleccion);
		expect(v.dentroDePalabra).toEqual([]);
		expect(v.partidas).toEqual([]);
		expect(v.descartadasDentro).toEqual([]);
	});

	it('cada borde queda en silencio y deja al menos la guarda de 30 ms con la palabra', () => {
		for (const b of bordesDe(r.keep)) {
			if (b <= 0 || b >= wav.duracionS - 1e-6) continue;
			expect(energiaEnIntervalo(wav, b - 0.01, b + 0.01)).toBeLessThan(PISO_DBFS + 6);
			for (const p of PAUSAS) expect(Math.min(Math.abs(b - p.d), Math.abs(b - p.h))).toBeGreaterThanOrEqual(PARAMETROS_CORTES.guardiaS - 1e-6);
		}
	});

	it('respeta el pad: ~120 ms después de la palabra y ~80 ms antes (±80 ms del valle + medio cuadro)', () => {
		const tolerancia = PARAMETROS_CORTES.radioValleS + 0.5 / FPS + 1e-6;
		for (const c of r.cortes.filter((x) => x.motivo === 'silencio')) {
			const antes = PAUSAS.filter((p) => p.h <= c.desde).at(-1)!;
			const despues = PAUSAS.find((p) => p.d >= c.hasta)!;
			expect(Math.abs(c.desde - (antes.h + PARAMETROS_CORTES.padDespuesS))).toBeLessThanOrEqual(tolerancia);
			expect(Math.abs(c.hasta - (despues.d - PARAMETROS_CORTES.padAntesS))).toBeLessThanOrEqual(tolerancia);
		}
	});

	it('cuantiza todos los bordes a cuadro de 30 fps y keep[] pasa validarKeep', () => {
		for (const b of bordesDe(r.keep)) expect(Math.abs(b * FPS - Math.round(b * FPS))).toBeLessThan(1e-9);
		expect(() => validarKeep(r.keep)).not.toThrow();
		for (let k = 1; k < r.keep.length; k++) expect(r.keep[k].desde - r.keep[k - 1].hasta).toBeGreaterThanOrEqual(PARAMETROS_CORTES.corteMinimoS - 1e-9);
	});

	it('el final estirado de whisper no esconde la pausa: los bordes refinados vuelven a donde suena la palabra', () => {
		const limites = r.refinados;
		PAUSAS.forEach((p, j) => {
			expect(Math.abs(limites[j].d - p.d)).toBeLessThanOrEqual(0.015);
			expect(Math.abs(limites[j].h - p.h)).toBeLessThanOrEqual(0.015);
		});
	});
});

describe('cortes.ts: tramos sueltos sin palabras (quitarSueltosS, estilo/aires.json)', () => {
	// Voz sin palabras de 0.25 s, suelta entre dos pausas largas: queda como un tramo propio (un "cuadro muerto").
	const s = new Senal(5);
	s.voz(0.5, 0.5, -20, 110);
	s.voz(2.0, 0.25, -22, 150);
	s.voz(3.5, 0.5, -20, 117);
	const wav = s.wav();
	const palabras: Palabra[] = [
		{i: 0, t: 'Hola', d: 0.5, h: 1.0},
		{i: 1, t: 'amigos', d: 3.5, h: 4.0},
	];
	const correr = (quitarSueltosS: number) => {
		const parametros = {...PARAMETROS_CORTES, quitarSueltosS};
		const energia = analizarEnergia(wav, palabras, parametros.energia);
		const {limites} = refinarPalabras(energia, palabras);
		return construirKeep({limites, seleccion: [true, true], energia, limiteS: wav.duracionS, parametros});
	};

	it('por defecto el tramo sin palabras se queda', () => {
		const r = correr(0);
		expect(r.keep).toHaveLength(3);
		expect(tocaUnTramo(r.keep, 2.05, 2.2)).toBe(true);
	});

	it('con quitarSueltosS = 0.6 se quita y las palabras siguen en su tramo', () => {
		const r = correr(0.6);
		expect(r.keep).toHaveLength(2);
		expect(tocaUnTramo(r.keep, 2.05, 2.2)).toBe(false);
		expect(r.tramoDe).toEqual([0, 1]);
		expect(verificarCortes(r.keep, r.limites, [true, true]).dentroDePalabra).toEqual([]);
	});
});

describe('cortes.ts: voz que whisper no transcribió', () => {
	const reales: Real[] = [
		{t: 'antes', d: 0.5, h: 0.9},
		{t: 'después', d: 2.6, h: 3.0},
	];

	it('no corta voz sin palabras en medio de una pausa: corta los silencios de los lados y le deja su tramo', () => {
		// Voz real en [1.4, 2.0] que whisper no escribió (como IMG_4874 en 30.4 s, donde alucinó "de esta liga").
		const {wav, palabras} = escena(reales, 4, [[1.4, 2.0]]);
		palabras[0].h = 0.95; // whisper no estiró la palabra sobre esa voz
		const r = proponer(wav, palabras);
		expect(dentroDeUnTramo(r.keep, 1.4, 2.0)).toBe(true);
		expect(r.keep).toHaveLength(3);
		expect(r.tramoDe).toEqual([0, 2]);
		revisarContraLaVerdad(r.keep, reales, r.seleccion);
	});

	it('si whisper estiró la palabra sobre esa voz, tampoco se corta (nada se corta dentro de una palabra)', () => {
		const {wav, palabras} = escena(reales, 4, [[1.4, 2.0]]);
		expect(palabras[0].h).toBeGreaterThan(2);
		const r = proponer(wav, palabras);
		expect(dentroDeUnTramo(r.keep, 0.5, 2.0)).toBe(true);
		revisarContraLaVerdad(r.keep, reales, r.seleccion);
	});

	it('si la voz sin palabras llena el hueco, no hay corte', () => {
		const pegadas: Real[] = [
			{t: 'antes', d: 0.5, h: 0.9},
			{t: 'después', d: 2.0, h: 2.4},
		];
		const {wav, palabras} = escena(pegadas, 3, [[0.95, 1.95]]);
		palabras[0].h = 0.95;
		const r = proponer(wav, palabras);
		expect(r.keep).toHaveLength(1);
		expect(silenciosEn(r.energia, 0.95, 1.95).every(([a, b]) => b - a < 0.1)).toBe(true);
	});
});

describe('cortes.ts: tomas repetidas en el audio', () => {
	const reales: Real[] = [];
	let t = 0.5;
	for (const frase of ['Vas a hacer un nuevo.', 'Vas a hacer un nuevo folder.', 'Y listo.']) {
		for (const w of frase.split(' ')) {
			reales.push({t: w, d: t, h: t + 0.3});
			t += 0.4;
		}
		t += 0.8;
	}
	const {wav, palabras} = escena(reales, t + 0.5);
	const r = proponer(wav, palabras);

	it('quita la toma anterior completa y deja la última entera en un tramo', () => {
		expect(r.frases.map((f) => f.descartada)).toEqual([true, false, false]);
		expect(r.seleccion.slice(0, 5)).toEqual([false, false, false, false, false]);
		revisarContraLaVerdad(r.keep, reales, r.seleccion);
		expect(r.cortes[0].motivo).toBe('inicio');
		expect(r.cortes[0].palabras).toEqual([0, 1, 2, 3, 4]);
	});
});

describe('cortes.ts: remapeo a la base', () => {
	const {wav, palabras} = escena(PAUSAS, 10);
	const r = proponer(wav, palabras);
	const salida: PalabraSalida[] = palabras.map((w, j) => ({t: w.t, desde: j, hasta: j}));
	const base = armarTranscripcionBase(r.keep, palabras, salida, r.tramoDe);

	it('cada palabra cae en su tramo con el tiempo de la base = tiempo del crudo − cortes anteriores', () => {
		base.forEach((w, j) => {
			const k = w.tramo;
			expect(k).toBe(r.tramoDe[j]);
			const previos = r.keep.slice(0, k).reduce((s, x) => s + (x.hasta - x.desde), 0);
			const desde = Math.max(palabras[j].d, r.keep[k].desde);
			const hasta = Math.min(palabras[j].h, r.keep[k].hasta);
			expect(w.d).toBeCloseTo(previos + desde - r.keep[k].desde, 5);
			expect(w.h).toBeCloseTo(previos + hasta - r.keep[k].desde, 5);
			expect(aCrudo(r.keep, w.d)).toBeCloseTo(desde, 5);
		});
	});

	it('los tiempos de la base van en orden y no pasan de la duración de la base', () => {
		const total = duracionBase(r.keep);
		for (let j = 0; j < base.length; j++) {
			expect(base[j].d).toBeLessThanOrEqual(base[j].h);
			expect(base[j].h).toBeLessThanOrEqual(total + 1e-9);
			if (j > 0) expect(base[j].d).toBeGreaterThanOrEqual(base[j - 1].d);
		}
		expect(base.map((w) => w.i)).toEqual(palabras.map((w) => w.i));
		expect(base.map((w) => w.j)).toEqual(palabras.map((_, j) => j));
	});
});

describe('cortes.ts: propiedad con escenas al azar (semilla fija)', () => {
	it.each([1, 2, 3, 4, 5])('semilla %i: verificación limpia y ningún borde dentro de una palabra real', (semilla) => {
		const azar = lcg(semilla * 7919);
		const u = () => (azar() + 1) / 2;
		const reales: Real[] = [];
		let t = 0.3 + u();
		const quitar: boolean[] = [];
		for (let frase = 0; frase < 8; frase++) {
			const largo = 1 + Math.floor(u() * 5);
			const fuera = u() < 0.3;
			for (let w = 0; w < largo; w++) {
				const dur = 0.1 + u() * 0.4;
				reales.push({t: `p${reales.length}${w === largo - 1 ? '.' : ''}`, d: t, h: t + dur});
				quitar.push(fuera);
				t += dur + 0.04 + u() * (u() < 0.3 ? 1.2 : 0.25);
			}
			t += 0.25 + u() * 1.5; // entre frases siempre hay al menos 0.25 s de silencio
		}
		const {wav, palabras} = escena(reales, t + 0.5, [], semilla);
		const seleccion = quitar.map((q) => !q);
		if (!seleccion.some(Boolean)) seleccion[0] = true;
		const r = proponer(wav, palabras, seleccion);
		expect(() => validarKeep(r.keep)).not.toThrow();
		const v = verificarCortes(r.keep, r.limites, seleccion);
		expect(v.dentroDePalabra.length + v.partidas.length + v.descartadasDentro.length).toBe(0);
		revisarContraLaVerdad(r.keep, reales, seleccion);
		expect(r.junturas).toEqual([]);
	});
});

describe('cortes.ts: juntura entre palabras pegadas', () => {
	it('al quitar una palabra sin silencio alrededor, corta en el valle y anota cuánto se movió cada borde', () => {
		// "uno dos tres" sin pausas, con un hueco de energía de 15 ms entre palabras (como entre dos sílabas).
		const reales: Real[] = [
			{t: 'uno', d: 0.5, h: 0.785},
			{t: 'dos', d: 0.8, h: 1.085},
			{t: 'tres', d: 1.1, h: 1.4},
		];
		const {wav, palabras} = escena(reales, 2);
		const r = proponer(wav, palabras, [true, false, true]);
		const v = verificarCortes(r.keep, r.limites, [true, false, true]);
		revisarContraLaVerdad(r.keep, reales, [true, false, true]);
		expect(v.dentroDePalabra).toEqual([]);
		expect(v.descartadasDentro).toEqual([]);
		expect(r.keep).toHaveLength(2);
		// El corte se lleva "dos" y no se come más de un cuadro de "uno" ni de "tres".
		expect(r.keep[0].hasta).toBeGreaterThanOrEqual(0.785 - 1 / FPS - 1e-9);
		expect(r.keep[0].hasta).toBeLessThanOrEqual(0.8 + 1 / FPS);
		expect(r.keep[1].desde).toBeGreaterThanOrEqual(1.085 - 1 / FPS);
		expect(r.keep[1].desde).toBeLessThanOrEqual(1.1 + 1 / FPS);
		for (const j of r.junturas) expect(j.desplazamientoMs).toBeLessThanOrEqual(Math.ceil(1000 / FPS) + 20);
	});
});

// ───────────────────────── texto aprobado ─────────────────────────

describe('cortes.ts: leer el texto aprobado', () => {
	it('lee solo la sección "## Guion" del texto-propuesto.md, sin comentarios, y pega la puntuación suelta', () => {
		const md = ['# Texto propuesto', '<!-- no leas esto -->', '- Crudo: 10 s', '', '## Guion', '', 'Hola — mundo.', '<!--', 'tampoco esto', '-->', '¡ Va !', '', '## Frases descartadas', '1. «otra cosa»'].join('\n');
		const tokens = leerTextoAprobado(md);
		expect(tokens.map((t) => t.texto)).toEqual(['Hola —', 'mundo.', '¡ Va !']);
		expect(tokens.map((t) => t.norm)).toEqual(['hola', 'mundo', 'va']);
		expect(tokens.map((t) => t.linea)).toEqual([7, 7, 11]);
	});

	it('un .txt sin secciones se lee completo', () => {
		expect(leerTextoAprobado('uno dos\ntres').map((t) => t.norm)).toEqual(['uno', 'dos', 'tres']);
	});
});

describe('cortes.ts: alinear el texto aprobado', () => {
	const palabras: Palabra[] = ['Vas', 'a', 'hacer', 'Vas', 'a', 'hacer', 'un', 'folder', 'enfrente', 'Claude'].map((t, i) => ({i, t, d: i, h: i + 0.5}));
	palabras[9].t_whisper = 'Cloud';
	const propuesta = [false, false, false, true, true, true, true, true, true, true];
	const tok = (texto: string) => leerTextoAprobado(texto);

	it('prefiere las palabras de la propuesta cuando el texto está repetido en el audio', () => {
		const a = alinearTexto(tok('Vas a hacer un folder'), palabras, propuesta);
		expect(a.faltantes).toEqual([]);
		expect(a.pares.map((p) => p.w0)).toEqual([3, 4, 5, 6, 7]);
	});

	it('recupera una toma descartada si la pones en tu texto', () => {
		const a = alinearTexto(tok('Vas a hacer Vas a hacer un folder'), palabras, propuesta);
		expect(a.pares.map((p) => p.w0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('empata "en frente" con "enfrente" y lo que escribió whisper ("Cloud") con la palabra corregida', () => {
		const a = alinearTexto(tok('un folder en frente Cloud'), palabras, propuesta);
		expect(a.faltantes).toEqual([]);
		expect(a.pares.map((p) => [p.t0, p.t1, p.w0, p.w1])).toEqual([
			[0, 0, 6, 6],
			[1, 1, 7, 7],
			[2, 3, 8, 8],
			[4, 4, 9, 9],
		]);
	});

	it('las palabras que no están en el audio quedan como faltantes', () => {
		const a = alinearTexto(tok('Vas a hacer un súper folder'), palabras, propuesta);
		expect(a.faltantes).toEqual([4]);
	});
});

// ───────────────────────── etapa completa (archivos) ─────────────────────────

describe('cortes.ts: etapa completa sobre un proyecto de prueba', () => {
	const raiz = mkdtempSync(join(tmpdir(), 'cortes-'));
	afterAll(() => rmSync(raiz, {recursive: true, force: true}));
	const proyectos = join(raiz, 'proyectos');
	const vocabulario = join(raiz, 'vocabulario.json');
	writeFileSync(vocabulario, JSON.stringify({terminos: [], correcciones: {cloud: 'Claude'}}));
	const slug = '_prueba-cortes';
	const dir = join(proyectos, slug);
	mkdirSync(dir, {recursive: true});

	const frases = ['Primero abre Cloud.', 'Vas a hacer un nuevo.', 'Vas a hacer un nuevo folder.', 'Y luego lo corres.'];
	const reales: Real[] = [];
	let t = 0.6;
	for (const frase of frases) {
		for (const w of frase.split(' ')) {
			reales.push({t: w, d: t, h: t + 0.3});
			t += 0.38;
		}
		t += 0.9;
	}
	const {wav, palabras} = escena(reales, t + 0.4);
	escribirWav(join(dir, 'audio16k.wav'), wav.muestras, FS);
	writeFileSync(join(dir, 'transcripcion.json'), JSON.stringify({metodo: 't_dtw', palabras: palabras.map((p) => ({...p, p: 0.9}))}));

	it('escribe cortes.json (que base.ts lee), texto-propuesto.md y transcripcion-base.json con el texto propuesto', async () => {
		const r = await ejecutarCortes({slug, proyectos, vocabulario});
		expect(r.modo).toBe('propuesta');
		expect(r.frases.filter((f) => f.descartada).map((f) => f.texto)).toEqual(['Vas a hacer un nuevo.']);

		const keep = leerCortes(join(dir, 'cortes.json'));
		expect(keep).toEqual(r.keep);
		expect(() => validarKeep(keep)).not.toThrow();
		const cortes = JSON.parse(readFileSync(join(dir, 'cortes.json'), 'utf8'));
		expect(cortes.metodo).toMatch(/propuesta automática/);
		expect(cortes.parametros.huecoMinimoS).toBe(0.3);
		expect(cortes.verificacion.dentro_de_palabra).toBe(0);

		const md = readFileSync(join(dir, 'texto-propuesto.md'), 'utf8');
		expect(md).toContain('## Guion');
		expect(md).toContain('## Frases descartadas');
		expect(md).toMatch(/1\. «Vas a hacer un nuevo\.» .* — arranque en falso|1\. «Vas a hacer un nuevo\.» .* — toma repetida/);

		const base = JSON.parse(readFileSync(join(dir, 'transcripcion-base.json'), 'utf8'));
		const textoPropuesto = 'Primero abre Cloud. Vas a hacer un nuevo folder. Y luego lo corres.';
		expect(base.palabras.map((w: {t: string}) => w.t).join(' ')).toBe(textoPropuesto);
		expect(palabrasDistintas(base.palabras.map((w: {t: string}) => w.t), leerTextoAprobado(md).map((x) => x.texto))).toBe(0);
		expect(base.palabras[3].i).toBe(8); // "Vas" de la segunda toma
		expect(leerManifest(slug, proyectos)?.etapas.cortes?.estado).toBe('terminada');
	});

	it('con tu texto aprobado (quitas una frase y corriges una marca) el texto de la base queda idéntico al tuyo', async () => {
		const propuesto = readFileSync(join(dir, 'texto-propuesto.md'), 'utf8');
		const editado = propuesto.replace('Y luego lo corres.\n', '').replace('Cloud.', 'Claude.');
		const ruta = join(raiz, 'aprobado.md');
		writeFileSync(ruta, editado);
		const r = await ejecutarCortes({slug, proyectos, vocabulario, aplicarTexto: ruta});
		expect(r.modo).toBe('aprobado');
		const esperado = leerTextoAprobado(editado).map((x) => x.texto);
		expect(r.palabrasBase.map((w) => w.t)).toEqual(esperado);
		expect(r.texto).toBe('Primero abre Claude. Vas a hacer un nuevo folder.');
		const base = JSON.parse(readFileSync(join(dir, 'transcripcion-base.json'), 'utf8'));
		expect(palabrasDistintas(base.palabras.map((w: {t: string}) => w.t), esperado)).toBe(0);
		// La frase quitada ya no está en ningún tramo.
		const quitada = reales.slice(-4);
		for (const w of quitada) expect(tocaUnTramo(r.keep, w.d, w.h)).toBe(false);
		expect(readFileSync(join(dir, 'texto-aprobado.txt'), 'utf8')).toContain('Primero abre Claude.');
	});

	it('si agregas una palabra que no dijiste, sale con código 2 y te dice cuál', async () => {
		const ruta = join(raiz, 'agregada.txt');
		writeFileSync(ruta, 'Primero abre Claude. Vas a hacer un nuevo folder bonito.');
		await expect(ejecutarCortes({slug, proyectos, vocabulario, aplicarTexto: ruta})).rejects.toSatisfy(
			(e: unknown) => e instanceof FalloEditor && e.codigo === 2 && e.message.includes('«bonito.»') && /Siguiente paso:/.test(e.message),
		);
	});

	it('si cambias el orden, sale con código 2', async () => {
		const ruta = join(raiz, 'reordenada.txt');
		writeFileSync(ruta, 'Vas a hacer un nuevo folder. Primero abre Claude.');
		await expect(ejecutarCortes({slug, proyectos, vocabulario, aplicarTexto: ruta})).rejects.toSatisfy(
			(e: unknown) => e instanceof FalloEditor && e.codigo === 2 && e.message.includes('no en ese lugar'),
		);
	});

	it('con las mismas entradas escribe cortes.json byte por byte igual (así base.ts no vuelve a codificar)', async () => {
		await ejecutarCortes({slug, proyectos, vocabulario});
		const primero = readFileSync(join(dir, 'cortes.json'), 'utf8');
		const basePrimero = readFileSync(join(dir, 'transcripcion-base.json'), 'utf8');
		await ejecutarCortes({slug, proyectos, vocabulario});
		expect(readFileSync(join(dir, 'cortes.json'), 'utf8')).toBe(primero);
		expect(readFileSync(join(dir, 'transcripcion-base.json'), 'utf8')).toBe(basePrimero);
	});

	it('si editaste texto-propuesto.md a mano, guarda una copia antes de reescribirlo (no pierdes tus cambios)', async () => {
		const ruta = join(dir, 'texto-propuesto.md');
		const r1 = await ejecutarCortes({slug, proyectos, vocabulario});
		expect(r1.respaldo).toBeNull(); // sin cambios a mano: se reescribe sin copia
		expect(sinEditar(readFileSync(ruta, 'utf8'))).toBe(true);
		const editado = readFileSync(ruta, 'utf8').replace('Y luego lo corres.', '');
		writeFileSync(ruta, editado);
		expect(sinEditar(editado)).toBe(false);
		const r2 = await ejecutarCortes({slug, proyectos, vocabulario});
		expect(r2.respaldo).toBe(join(dir, 'texto-propuesto.editado-1.md'));
		expect(readFileSync(r2.respaldo!, 'utf8')).toBe(editado);
		expect(readFileSync(ruta, 'utf8')).toContain('Y luego lo corres.');
	});

	it('sin transcripcion.json sale con código 2', async () => {
		const otro = join(proyectos, '_sin-transcripcion');
		mkdirSync(otro, {recursive: true});
		await expect(ejecutarCortes({slug: '_sin-transcripcion', proyectos})).rejects.toSatisfy(
			(e: unknown) => e instanceof FalloEditor && e.codigo === 2 && e.message.includes('transcribir.ts'),
		);
	});
});
