// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Onsets de audio: los momentos en que ARRANCA un sonido agregado (un SFX) encima de tu voz.
 *
 * Por qué no basta un flujo espectral simple: tu voz también arranca de golpe (las oclusivas p/t/k son
 * transitorios de banda ancha) y sus eses llegan arriba de 8 kHz. Lo que distingue a un SFX es que hace algo
 * que la voz casi nunca hace en ese momento. Por eso hay un banco de detectores, cada uno con su umbral
 * adaptable (relativo a lo que hizo la voz en ±1.5 s alrededor):
 *
 *   - `clic`: transitorio IMPULSIVO de agudos (4–16 kHz): sube > N dB en 2 ms y cae otra vez en 4–12 ms.
 *     Una oclusiva sube igual de rápido, pero sigue sonando (explosión + vocal); un clic se apaga.
 *   - `agudos`: el flujo espectral con énfasis en agudos (4 bandas de 4 a 16 kHz) con umbral adaptable: la
 *     energía nueva tiene que superar el p90 de la voz alrededor en esas bandas (las eses fuertes).
 *   - `tono`: aparecen parciales estables (picos angostos que duran ≥ 40 ms) entre 2 y 14 kHz que no estaban
 *     antes y que suben sobre el fondo de esa frecuencia: pings, campanas, notificaciones. La voz arriba de
 *     2 kHz no hace líneas estables.
 *   - `golpe`: subida fuerte en 80–600 Hz por encima del p95 de la voz alrededor: los "pop" graves (los tuyos
 *     suenan a ~300 Hz, más fuertes que la voz).
 *   - `lateral`: si el audio es estéreo y tu voz va al centro (L = R), el canal lateral (L − R)/2 casi no
 *     tiene voz: cualquier subida ahí es un sonido agregado. Solo se usa si ese canal está limpio.
 *
 * Los parámetros (`PARAMETROS_ONSETS`) se afinaron con mezclas de desarrollo (otra toma de voz, ver
 * pruebas/integracion/f2-onsets.ts) y se validan en una mezcla aparte.
 *
 * Todo es puro salvo `leerAudio`, que corre ffmpeg (sin Vision ni GPU: corre dentro del sandbox).
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename} from 'node:path';
import {fallo} from './fallo.ts';

/** Frecuencia de muestreo con la que se analiza (la de tus reels de Instagram). */
export const FS_ONSETS = 44100;

// ───────────────────────────── FFT y espectrograma ─────────────────────────────

/** FFT compleja in situ (radix-2, iterativa). `re.length` debe ser potencia de 2. */
export function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	if (n !== im.length || (n & (n - 1)) !== 0) throw new Error(`fft: tamaño ${n} no es potencia de 2`);
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
	}
	for (let largo = 2; largo <= n; largo <<= 1) {
		const ang = (-2 * Math.PI) / largo;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		const mitad = largo >> 1;
		for (let i = 0; i < n; i += largo) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < mitad; k++) {
				const a = i + k;
				const b = a + mitad;
				const xr = re[b] * cr - im[b] * ci;
				const xi = re[b] * ci + im[b] * cr;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
				const nr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = nr;
			}
		}
	}
}

export type Espectrograma = {
	fs: number;
	ventana: number;
	salto: number;
	/** Bins de 0 a fs/2 (ventana/2 + 1). */
	nBins: number;
	nCuadros: number;
	/** Magnitud |X| normalizada (un seno de amplitud 1 da ≈ 1 en su bin), cuadro por cuadro: [c·nBins + k]. */
	mag: Float32Array;
};

/** Ventana de Hann periódica. */
export function hann(n: number): Float64Array {
	const w = new Float64Array(n);
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
	return w;
}

/**
 * STFT con ventana de Hann. El cuadro c cubre las muestras [c·salto, c·salto + ventana); su centro está en
 * (c·salto + ventana/2)/fs segundos.
 */
export function espectrograma(x: Float32Array, fs: number, ventana = 1024, salto = 256): Espectrograma {
	const nBins = ventana / 2 + 1;
	const nCuadros = x.length < ventana ? 0 : Math.floor((x.length - ventana) / salto) + 1;
	const mag = new Float32Array(nCuadros * nBins);
	const w = hann(ventana);
	let suma = 0;
	for (let i = 0; i < ventana; i++) suma += w[i];
	const norma = 2 / suma;
	const re = new Float64Array(ventana);
	const im = new Float64Array(ventana);
	for (let c = 0; c < nCuadros; c++) {
		const base = c * salto;
		for (let i = 0; i < ventana; i++) {
			re[i] = x[base + i] * w[i];
			im[i] = 0;
		}
		fft(re, im);
		const o = c * nBins;
		for (let k = 0; k < nBins; k++) mag[o + k] = Math.hypot(re[k], im[k]) * norma;
	}
	return {fs, ventana, salto, nBins, nCuadros, mag};
}

// ───────────────────────────── Estadística y filtros ─────────────────────────────

/** Cuantil con interpolación lineal (tipo 7). Vacío → NaN. */
export function cuantilDe(v: ArrayLike<number>, p: number): number {
	const o = Float64Array.from(v).sort();
	if (o.length === 0) return Number.NaN;
	const h = (o.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(o.length - 1, lo + 1);
	return o[lo] + (h - lo) * (o[hi] - o[lo]);
}

/** Decibeles de una potencia (con piso para no arrastrar −Infinity). */
export const aDb = (potencia: number): number => 10 * Math.log10(potencia + 1e-15);

type Biquad = [number, number, number, number, number];

/** Biquad de Butterworth (RBJ) pasa-altos o pasa-bajos, normalizado (b0, b1, b2, a1, a2). */
export function biquad(tipo: 'pasaAltos' | 'pasaBajos', f0: number, fs: number, q = Math.SQRT1_2): Biquad {
	const w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
	const cw = Math.cos(w0);
	const al = Math.sin(w0) / (2 * q);
	const b = tipo === 'pasaAltos' ? [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2] : [(1 - cw) / 2, 1 - cw, (1 - cw) / 2];
	const a0 = 1 + al;
	return [b[0] / a0, b[1] / a0, b[2] / a0, (-2 * cw) / a0, (1 - al) / a0];
}

/** Aplica biquads en cascada. */
export function filtrar(x: Float32Array, etapas: Biquad[]): Float32Array {
	let y = Float32Array.from(x);
	for (const [b0, b1, b2, a1, a2] of etapas) {
		const z = new Float32Array(y.length);
		let x1 = 0;
		let x2 = 0;
		let y1 = 0;
		let y2 = 0;
		for (let i = 0; i < y.length; i++) {
			const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
			x2 = x1;
			x1 = y[i];
			y2 = y1;
			y1 = v;
			z[i] = v;
		}
		y = z;
	}
	return y;
}

/** Banda [f0, f1] con pasa-altos y pasa-bajos de 4.º orden. */
export function pasaBanda(x: Float32Array, f0: number, f1: number, fs: number): Float32Array {
	const etapas: Biquad[] = [];
	if (f0 > 0) etapas.push(biquad('pasaAltos', f0, fs), biquad('pasaAltos', f0, fs));
	if (f1 < fs / 2) etapas.push(biquad('pasaBajos', f1, fs), biquad('pasaBajos', f1, fs));
	return filtrar(x, etapas);
}

/** Potencia media por bloques de `paso` muestras. */
export function potenciaPorBloques(y: Float32Array, paso: number): Float64Array {
	const n = Math.floor(y.length / paso);
	const e = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		let s = 0;
		for (let i = k * paso; i < (k + 1) * paso; i++) s += y[i] * y[i];
		e[k] = s / paso;
	}
	return e;
}

const maxEn = (e: ArrayLike<number>, a: number, b: number): number => {
	let m = 0;
	for (let k = Math.max(0, a); k < Math.min(e.length, b); k++) if (e[k] > m) m = e[k];
	return m;
};
const mediaEn = (e: ArrayLike<number>, a: number, b: number): number => {
	let s = 0;
	let n = 0;
	for (let k = Math.max(0, a); k < Math.min(e.length, b); k++) {
		s += e[k];
		n++;
	}
	return n ? s / n : 0;
};

/**
 * Cuantil local de una serie (en dB): para cada posición c, el cuantil `p` de la serie en [c − radio, c + radio]
 * SIN el tramo [c − huecoAntes, c + huecoDespues] (el propio evento: un SFX sostenido no debe subir su propia
 * referencia). Se evalúa por bloques (un valor por bloque) para que sea rápido.
 */
export function cuantilLocal(serie: Float64Array, radio: number, huecoAntes: number, huecoDespues: number, p: number, bloque = 10): Float64Array {
	const n = serie.length;
	const out = new Float64Array(n);
	const v: number[] = [];
	for (let b0 = 0; b0 < n; b0 += bloque) {
		const c = Math.min(n - 1, b0 + (bloque >> 1));
		v.length = 0;
		for (let j = Math.max(0, c - radio); j <= Math.min(n - 1, c + radio + huecoDespues); j++) {
			if (j >= c - huecoAntes && j <= c + huecoDespues) continue;
			v.push(serie[j]);
		}
		const q = v.length ? cuantilDe(v, p) : -150;
		for (let k = b0; k < Math.min(n, b0 + bloque); k++) out[k] = q;
	}
	return out;
}

// ───────────────────────────── Detectores ─────────────────────────────

export type FuenteOnset = 'clic' | 'agudos' | 'tono' | 'golpe' | 'lateral';

export type Candidato = {
	/** Segundos. */
	t: number;
	fuente: FuenteOnset;
	/** Margen sobre el umbral más justo de su detector (dB); > 0 = pasa. */
	margen: number;
	/** Rasgos crudos del detector (dB o ms), para depurar y para el reporte. */
	rasgos: Record<string, number>;
};

export type ParametrosOnsets = {
	/** Cada detector pasa si cada rasgo supera su mínimo Y la suma de sus rasgos supera `suma`. */
	clic: {subida: number; caida: number; nivel: number; suma: number};
	agudos: {flujo: number; nivel: number; suma: number};
	tono: {prominencia: number; duraMs: number; sobreFondo: number};
	golpe: {subida: number; nivel: number; suma: number};
	lateral: {subida: number; sobrePiso: number; limpioDb: number};
	/** Dos detecciones a menos de esto (s) son el mismo onset (queda la más temprana). */
	fusionS: number;
};

/** Afinados con las mezclas de desarrollo de pruebas/integracion/f2-onsets.ts (ver su reporte). */
export const PARAMETROS_ONSETS: ParametrosOnsets = {
	clic: {subida: 16, caida: 10, nivel: 0, suma: 30},
	agudos: {flujo: 12, nivel: 6, suma: 20},
	tono: {prominencia: 22, duraMs: 40, sobreFondo: 14},
	golpe: {subida: 8, nivel: 8, suma: 20},
	// Solo con el lateral en silencio digital cuando hablas (tus reels: 131–133 dB bajo el central). Con menos, el
	// códec mete restos de voz ahí (el AAC de ffmpeg deja la voz a ~60–90 dB) y el lateral da falsos.
	lateral: {subida: 12, sobrePiso: 20, limpioDb: 100},
	fusionS: 0.06,
};

/** Supresión de no-máximos: dentro de `ventanaS` queda el de mayor puntaje. */
export function suprimir<T extends {t: number}>(lista: T[], ventanaS: number, puntaje: (c: T) => number): T[] {
	const orden = [...lista].sort((a, b) => a.t - b.t);
	const out: T[] = [];
	for (const c of orden) {
		const u = out[out.length - 1];
		if (u && c.t - u.t < ventanaS) {
			if (puntaje(c) > puntaje(u)) out[out.length - 1] = c;
			continue;
		}
		out.push(c);
	}
	return out;
}

/** Margen (dB) de cada detector: el peor de sus mínimos y de su suma. ≥ 0 = pasa. */
export const margenClic = (r: Record<string, number>, p: ParametrosOnsets['clic']): number =>
	Math.min(r.subida - p.subida, r.caida - p.caida, r.nivel - p.nivel, r.subida + r.caida + r.nivel - p.suma);
export const margenAgudos = (r: Record<string, number>, p: ParametrosOnsets['agudos']): number =>
	Math.min(r.flujo - p.flujo, r.nivel - p.nivel, r.flujo + r.nivel - p.suma);
export const margenGolpe = (r: Record<string, number>, p: ParametrosOnsets['golpe']): number =>
	Math.min(r.subida - p.subida, r.nivel - p.nivel, r.subida + r.nivel - p.suma);

/** `clic`: transitorio impulsivo de 4–16 kHz (envolvente a 0.5 ms). Devuelve candidatos con subida ≥ 8 dB. */
export function candidatosClic(x: Float32Array, fs: number, p: ParametrosOnsets['clic']): Candidato[] {
	const paso = Math.max(1, Math.round(0.0005 * fs));
	const e = potenciaPorBloques(pasaBanda(x, 4000, 16000, fs), paso);
	const porBloque = 20; // 10 ms
	const e10 = Float64Array.from({length: Math.ceil(e.length / porBloque)}, (_, i) => aDb(mediaEn(e, i * porBloque, (i + 1) * porBloque)));
	const ctx = cuantilLocal(e10, 150, 3, 60, 0.9);
	const out: Candidato[] = [];
	for (let k = 40; k < e.length - 24; k++) {
		const pico = maxEn(e, k, k + 4);
		if (e[k] < pico || e[k] <= 0) continue;
		const subida = aDb(pico) - aDb(maxEn(e, k - 40, k - 4));
		if (subida < 8) continue;
		const caida = aDb(pico) - aDb(mediaEn(e, k + 8, k + 24));
		const nivel = aDb(mediaEn(e, k - 2, k + 4)) - ctx[Math.floor(k / porBloque)];
		const margen = margenClic({subida, caida, nivel}, p);
		out.push({t: (k * paso) / fs, fuente: 'clic', margen, rasgos: {subida, caida, nivel}});
	}
	return suprimir(out, 0.03, (c) => c.margen);
}

/** `agudos`: flujo espectral de 4 bandas entre 4 y 16 kHz (bloques de 2.5 ms) con nivel contra el p90 local. */
export function candidatosAgudos(x: Float32Array, fs: number, p: ParametrosOnsets['agudos']): Candidato[] {
	const paso = Math.max(1, Math.round(0.0025 * fs));
	const bandas: Array<[number, number]> = [[4000, 6000], [6000, 8000], [8000, 11000], [11000, 16000]];
	const es = bandas.map(([a, b]) => potenciaPorBloques(pasaBanda(x, a, b, fs), paso));
	const n = es[0].length;
	const porBloque = 4; // 10 ms
	const ctx = es.map((e) => cuantilLocal(Float64Array.from({length: Math.ceil(n / porBloque)}, (_, i) => aDb(mediaEn(e, i * porBloque, (i + 1) * porBloque))), 150, 3, 60, 0.9));
	const flujo = new Float64Array(n);
	for (let k = 8; k < n - 4; k++) {
		let s = 0;
		for (const e of es) s += Math.max(0, aDb(mediaEn(e, k, k + 4)) - aDb(maxEn(e, k - 8, k)));
		flujo[k] = s / es.length;
	}
	const out: Candidato[] = [];
	for (let k = 8; k < n - 8; k++) {
		if (flujo[k] < 3) continue;
		let esMax = true;
		for (let d = -6; d <= 6 && esMax; d++) if (d !== 0 && flujo[k + d] > flujo[k]) esMax = false;
		if (!esMax) continue;
		let nivel = -Infinity;
		for (let b = 0; b < es.length; b++) nivel = Math.max(nivel, aDb(mediaEn(es[b], k, k + 8)) - ctx[b][Math.floor(k / porBloque)]);
		const margen = margenAgudos({flujo: flujo[k], nivel}, p);
		out.push({t: (k * paso) / fs, fuente: 'agudos', margen, rasgos: {flujo: flujo[k], nivel}});
	}
	return suprimir(out, 0.05, (c) => c.margen);
}

/** `tono`: parciales estables nuevos entre 2 y 14 kHz (STFT 1024/128). */
export function candidatosTono(x: Float32Array, fs: number, p: ParametrosOnsets['tono']): Candidato[] {
	const V = 1024;
	const H = 128;
	const E = espectrograma(x, fs, V, H);
	const k0 = Math.ceil((2000 * V) / fs);
	const k1 = Math.min(E.nBins - 22, Math.floor((14000 * V) / fs));
	const nC = E.nCuadros;
	// Prominencia de cada pico local contra la mediana de ±20 bins (dB); 0 si no es pico.
	const prom = new Float32Array(nC * E.nBins);
	const vec = new Float64Array(36);
	for (let c = 0; c < nC; c++) {
		const o = c * E.nBins;
		for (let k = k0; k <= k1; k++) {
			const m = E.mag[o + k];
			if (m <= E.mag[o + k - 1] || m < E.mag[o + k + 1]) continue;
			let q = 0;
			for (let j = k - 20; j <= k + 20; j++) if (Math.abs(j - k) > 2) vec[q++] = E.mag[o + j];
			const orden = vec.subarray(0, q).sort();
			prom[o + k] = 20 * Math.log10(m / (orden[q >> 1] + 1e-12));
		}
	}
	const promEn = (c: number, k: number) => (c < 0 || c >= nC ? 0 : Math.max(prom[c * E.nBins + k - 1], prom[c * E.nBins + k], prom[c * E.nBins + k + 1]));
	const nivelEn = (c: number, k: number) => {
		let s = 0;
		for (let j = k - 2; j <= k + 2; j++) s += E.mag[c * E.nBins + j] ** 2;
		return aDb(s);
	};
	const cuadrosDura = Math.round((p.duraMs / 1000) * (fs / H));
	const pasado = Math.round(2 * (fs / H));
	const out: Candidato[] = [];
	for (let c = 8; c < nC - cuadrosDura - 1; c++) {
		let mejor: Candidato | null = null;
		for (let k = k0; k <= k1; k++) {
			const pr = prom[c * E.nBins + k];
			if (pr < 10) continue;
			let antes = 0;
			for (let d = 2; d <= 8; d++) antes = Math.max(antes, promEn(c - d, k));
			if (antes >= 8) continue;
			let dura = 0;
			while (dura < cuadrosDura && promEn(c + dura + 1, k) >= 8) dura++;
			if (dura < cuadrosDura) continue;
			let promMin = pr;
			for (let d = 1; d <= Math.min(6, dura); d++) promMin = Math.min(promMin, promEn(c + d, k));
			// Que no sea un tono de fondo que ya sonaba: nivel contra el p90 de esos bins en los 2 s previos.
			const previos: number[] = [];
			for (let d = 4; d <= pasado; d += 4) if (c - d >= 0) previos.push(nivelEn(c - d, k));
			const sobreFondo = nivelEn(c + 2, k) - (previos.length ? cuantilDe(previos, 0.9) : -150);
			const margen = Math.min(promMin - p.prominencia, sobreFondo - p.sobreFondo);
			if (!mejor || margen > mejor.margen) {
				mejor = {t: (c * H + V / 2) / fs - 0.006, fuente: 'tono', margen, rasgos: {prominencia: promMin, sobreFondo, hz: (k * fs) / V}};
			}
		}
		if (mejor) out.push(mejor);
	}
	return suprimir(out, 0.05, (c) => c.margen);
}

/**
 * `golpe`: subida en graves (bloques de 5 ms) sobre el p95 local, en dos bandas: 30–90 Hz (impactos, donde tu
 * voz casi no tiene energía) y 90–600 Hz (los "pop").
 */
export function candidatosGolpe(x: Float32Array, fs: number, p: ParametrosOnsets['golpe']): Candidato[] {
	const paso = Math.max(1, Math.round(0.005 * fs));
	const out: Candidato[] = [];
	for (const [f0, f1] of [[30, 90], [90, 600]] as const) {
		const e = potenciaPorBloques(pasaBanda(x, f0, f1, fs), paso);
		const edb = Float64Array.from(e, aDb);
		const ctx = cuantilLocal(edb, 300, 10, 120, 0.95, 20);
		const subidaEn = (k: number) => aDb(mediaEn(e, k, k + 3)) - aDb(maxEn(e, k - 8, k));
		for (let k = 8; k < e.length - 10; k++) {
			const subida = subidaEn(k);
			if (subida < 6) continue;
			let esMax = true;
			for (let d = -6; d <= 6 && esMax; d++) if (d !== 0 && subidaEn(k + d) > subida) esMax = false;
			if (!esMax) continue;
			const nivel = aDb(maxEn(e, k, k + 10)) - ctx[k];
			out.push({t: (k * paso) / fs, fuente: 'golpe', margen: margenGolpe({subida, nivel}, p), rasgos: {subida, nivel, hz: f0}});
		}
	}
	return suprimir(out, 0.05, (c) => c.margen);
}

/**
 * ¿El canal lateral (L − R)/2 está limpio de voz? Compara su energía con la del central en los bloques de
 * 50 ms con más voz (p90 del central): si el lateral va `limpioDb` o más por debajo, está limpio.
 */
export function lateralLimpio(central: Float32Array, lateral: Float32Array, fs: number, limpioDb: number): {limpio: boolean; diferenciaDb: number} {
	const paso = Math.max(1, Math.round(0.05 * fs));
	const ec = potenciaPorBloques(central, paso);
	const el = potenciaPorBloques(lateral, paso);
	const umbral = cuantilDe(Array.from(ec, aDb), 0.9) - 10;
	const dif: number[] = [];
	for (let k = 0; k < ec.length; k++) if (aDb(ec[k]) >= umbral) dif.push(aDb(ec[k]) - aDb(el[k]));
	const diferenciaDb = dif.length ? cuantilDe(dif, 0.5) : 0;
	return {limpio: diferenciaDb >= limpioDb, diferenciaDb};
}

/** `lateral`: subida de energía (200 Hz–16 kHz, bloques de 2.5 ms) en el canal lateral limpio. */
export function candidatosLateral(lateral: Float32Array, fs: number, p: ParametrosOnsets['lateral']): Candidato[] {
	const paso = Math.max(1, Math.round(0.0025 * fs));
	const e = potenciaPorBloques(pasaBanda(lateral, 200, 16000, fs), paso);
	const edb = Float64Array.from(e, aDb);
	const piso = cuantilLocal(edb, 800, 0, 0, 0.5, 40);
	const out: Candidato[] = [];
	for (let k = 12; k < e.length - 6; k++) {
		const ahora = aDb(mediaEn(e, k, k + 4));
		const subida = ahora - aDb(maxEn(e, k - 12, k));
		if (subida < 6) continue;
		const sobrePiso = ahora - piso[k];
		out.push({t: (k * paso) / fs, fuente: 'lateral', margen: Math.min(subida - p.subida, sobrePiso - p.sobrePiso), rasgos: {subida, sobrePiso}});
	}
	return suprimir(out, 0.05, (c) => c.margen);
}

export type Onset = {
	/** Segundos desde el inicio del audio. */
	t: number;
	/** Detectores que lo vieron (dentro de `fusionS`). */
	fuentes: FuenteOnset[];
	/** El mayor margen sobre el umbral entre sus detectores (dB). */
	margen_db: number;
};

export type ResultadoOnsets = {
	onsets: Onset[];
	/** Candidatos de cada detector (pasen o no), para depurar y afinar. */
	candidatos: Candidato[];
	lateral: {usado: boolean; diferenciaDb: number | null};
};

/** Junta las detecciones que pasan: dentro de `fusionS` queda una sola, con el tiempo de la más temprana. */
export function fusionar(candidatos: Candidato[], fusionS: number): Onset[] {
	const pasan = candidatos.filter((c) => c.margen >= 0).sort((a, b) => a.t - b.t);
	const out: Onset[] = [];
	for (const c of pasan) {
		const u = out[out.length - 1];
		if (u && c.t - u.t < fusionS) {
			if (!u.fuentes.includes(c.fuente)) u.fuentes.push(c.fuente);
			u.margen_db = Math.max(u.margen_db, c.margen);
			continue;
		}
		out.push({t: c.t, fuentes: [c.fuente], margen_db: c.margen});
	}
	return out.map((o) => ({...o, t: Number(o.t.toFixed(4)), margen_db: Number(o.margen_db.toFixed(1))}));
}

/** Todos los candidatos de todos los detectores (sin decidir). */
export function candidatosOnsets(
	central: Float32Array,
	fs: number,
	p: ParametrosOnsets = PARAMETROS_ONSETS,
	lateral?: Float32Array,
): {candidatos: Candidato[]; lateral: ResultadoOnsets['lateral']} {
	const candidatos = [
		...candidatosClic(central, fs, p.clic),
		...candidatosAgudos(central, fs, p.agudos),
		...candidatosTono(central, fs, p.tono),
		...candidatosGolpe(central, fs, p.golpe),
	];
	let infoLateral: ResultadoOnsets['lateral'] = {usado: false, diferenciaDb: null};
	if (lateral) {
		const {limpio, diferenciaDb} = lateralLimpio(central, lateral, fs, p.lateral.limpioDb);
		infoLateral = {usado: limpio, diferenciaDb: Number(diferenciaDb.toFixed(1))};
		if (limpio) candidatos.push(...candidatosLateral(lateral, fs, p.lateral));
	}
	return {candidatos, lateral: infoLateral};
}

/** Reaplica umbrales a candidatos ya calculados (para afinar sin recalcular). */
export function recalcularMargenes(candidatos: Candidato[], p: ParametrosOnsets): Candidato[] {
	return candidatos.map((c) => {
		const r = c.rasgos;
		let margen: number;
		switch (c.fuente) {
			case 'clic':
				margen = margenClic(r, p.clic);
				break;
			case 'agudos':
				margen = margenAgudos(r, p.agudos);
				break;
			case 'tono':
				margen = Math.min(r.prominencia - p.tono.prominencia, r.sobreFondo - p.tono.sobreFondo);
				break;
			case 'golpe':
				margen = margenGolpe(r, p.golpe);
				break;
			case 'lateral':
				margen = Math.min(r.subida - p.lateral.subida, r.sobrePiso - p.lateral.sobrePiso);
				break;
		}
		return {...c, margen};
	});
}

/**
 * Detecta onsets de SFX. `central` = (L+R)/2 (o el audio mono); `lateral` = (L−R)/2 si el audio es estéreo.
 * Ojo: el detector `tono` exige la duración mínima de los parámetros con los que se calcularon los candidatos.
 */
export function detectarOnsets(central: Float32Array, fs: number, p: ParametrosOnsets = PARAMETROS_ONSETS, lateral?: Float32Array): ResultadoOnsets {
	const {candidatos, lateral: infoLateral} = candidatosOnsets(central, fs, p, lateral);
	return {onsets: fusionar(candidatos, p.fusionS), candidatos, lateral: infoLateral};
}

// ───────────────────────────── Lectura de audio (ffmpeg) ─────────────────────────────

export type Audio = {fs: number; central: Float32Array; lateral: Float32Array | null; canales: number; duracionS: number};

/**
 * Lee el audio de un mp4/mov/wav con ffmpeg a `fs` Hz en float 32. Si es estéreo, devuelve el central
 * (L+R)/2 y el lateral (L−R)/2; si es mono, solo el central.
 * Códigos: 2 si el archivo no existe, no trae audio o falta ffmpeg; 1 si ffmpeg falla.
 */
export function leerAudio(ruta: string, fs = FS_ONSETS): Promise<Audio> {
	const nombre = basename(ruta);
	const que = `leer el audio de ${nombre}`;
	if (!existsSync(ruta)) {
		return Promise.reject(fallo(que, `no existe ${ruta}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2));
	}
	return new Promise<Audio>((resolver, rechazar) => {
		// Se pide estéreo siempre: un mono sale con L = R y el lateral queda en cero (se detecta abajo).
		const args = ['-v', 'error', '-nostdin', '-i', ruta, '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(fs), '-f', 'f32le', '-'];
		const hijo = spawn('ffmpeg', args, {stdio: ['ignore', 'pipe', 'pipe']});
		const partes: Buffer[] = [];
		let errores = '';
		hijo.stdout.on('data', (d: Buffer) => partes.push(d));
		hijo.stderr.on('data', (d: Buffer) => {
			errores = (errores + d.toString()).slice(-4000);
		});
		hijo.on('error', (e: NodeJS.ErrnoException) =>
			rechazar(
				e.code === 'ENOENT'
					? fallo(que, 'no encuentro ffmpeg en el PATH', 'instala ffmpeg (brew install ffmpeg, lo corres tú)', 2, e)
					: fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e),
			),
		);
		hijo.on('close', (codigo) => {
			if (codigo !== 0) {
				const sinAudio = /matches no streams|does not contain any stream|Stream map '0:a:0'/i.test(errores);
				rechazar(
					sinAudio
						? fallo(que, 'no trae pista de audio', 'usa el video con su audio', 2, {args, stderr: errores})
						: fallo(que, `ffmpeg terminó con error (${errores.trim().split('\n').pop() ?? codigo})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {args, stderr: errores}),
				);
				return;
			}
			const b = Buffer.concat(partes);
			const n = Math.floor(b.length / 8);
			const central = new Float32Array(n);
			const lat = new Float32Array(n);
			let energiaLateral = 0;
			for (let i = 0; i < n; i++) {
				const l = b.readFloatLE(8 * i);
				const r = b.readFloatLE(8 * i + 4);
				central[i] = (l + r) / 2;
				lat[i] = (l - r) / 2;
				energiaLateral += lat[i] * lat[i];
			}
			const estereo = energiaLateral > 1e-9 * Math.max(1, n);
			resolver({fs, central, lateral: estereo ? lat : null, canales: estereo ? 2 : 1, duracionS: n / fs});
		});
	});
}
