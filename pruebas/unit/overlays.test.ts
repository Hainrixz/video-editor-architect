// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/lib/overlays.ts y de las funciones puras de herramientas/estilo/overlays.ts, sin ffmpeg:
 * cuadros sintéticos en memoria (fondo que se mueve + capas quietas), rachas, agrupado, fusión, clase, pop medido
 * contra uno conocido, tomas y la relación con los SFX.
 * La validación con 10 stickers compuestos sobre un reel real está en pruebas/integracion/f2-overlays.ts.
 */
import {describe, expect, it} from 'vitest';
import {
	apariencia,
	clasificar,
	componentes,
	eventosDeRachas,
	fusionarFragmentos,
	iou,
	MINI_H,
	MINI_W,
	morfologia,
	refinarEvento,
	SegmentadorRachas,
	solidez,
	tomasDeVideo,
	type EventoCrudo,
	type PorCuadro,
	type Recorte,
} from '../../herramientas/lib/overlays.ts';
import {coberturaAlAzar, cuantil, resumirReel, secuenciasDeInsert, sfxDeAparicion, type EventoCapa} from '../../herramientas/estilo/overlays.ts';

function azar(semilla: number): () => number {
	let a = semilla >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const empacar = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Cuadro w×h RGB con fondo que cambia (ruido) y rectángulos quietos encima. */
function cuadro(w: number, h: number, n: number, capas: Array<{x0: number; y0: number; x1: number; y1: number; desde: number; hasta: number; rgb: [number, number, number]}>): Uint8Array {
	const r = azar(1000 + n);
	const out = new Uint8Array(w * h * 3);
	for (let p = 0; p < w * h; p++) {
		const v = 60 + Math.floor(r() * 120);
		out[3 * p] = v;
		out[3 * p + 1] = v;
		out[3 * p + 2] = v;
	}
	for (const c of capas) {
		if (n < c.desde || n >= c.hasta) continue;
		for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) out.set(c.rgb, 3 * (y * w + x));
	}
	return out;
}

describe('rachas por píxel', () => {
	it('una capa quieta sobre un fondo que se mueve da rachas exactamente en su tramo', () => {
		const w = 40;
		const h = 60;
		const seg = new SegmentadorRachas(w, h, 12, 8);
		const capa = {x0: 10, y0: 20, x1: 25, y1: 35, desde: 10, hasta: 30, rgb: [230, 120, 40] as [number, number, number]};
		for (let n = 0; n < 50; n++) seg.procesar(cuadro(w, h, n, [capa]));
		const r = seg.terminar();
		const p = 28 * w + 15;
		const suyas = [...Array(r.n).keys()].filter((i) => r.pix[i] === p);
		expect(suyas.map((i) => [r.ini[i], r.fin[i]])).toEqual([[10, 30]]);
		// El fondo (ruido) casi no hace rachas largas y ninguna dura tanto como la capa.
		const fondo = [...Array(r.n).keys()].filter((i) => Math.floor(r.pix[i] / w) < 15);
		expect(fondo.length).toBeLessThan(0.05 * 15 * w);
		expect(Math.max(0, ...fondo.map((i) => r.fin[i] - r.ini[i]))).toBeLessThan(20);
	});

	it('tolera un cuadro suelto de ruido sin cortar la racha', () => {
		const seg = new SegmentadorRachas(1, 1, 10, 3);
		const valores = [100, 100, 100, 160, 100, 100, 100, 100];
		for (const v of valores) seg.procesar(Uint8Array.from([v, v, v]));
		const r = seg.terminar();
		expect([r.ini[0], r.fin[0]]).toEqual([0, 8]);
	});
});

describe('máscaras y geometría', () => {
	it('componentes y morfología', () => {
		const w = 10;
		const m = new Uint8Array(w * 10);
		for (const [x, y] of [[1, 1], [2, 1], [7, 7], [8, 8]]) m[y * w + x] = 1;
		const c = componentes(m, w, 10);
		expect(c.n).toBe(2);
		expect(c.cajas[1]).toEqual({x0: 1, y0: 1, x1: 2, y1: 1});
		const d = morfologia(m, w, 10, 1);
		expect(d[0]).toBe(1);
		const e = morfologia(d, w, 10, -1);
		expect(e[1 * w + 1]).toBe(1);
		expect(e[0]).toBe(0);
	});

	it('solidez: un cuadrado lleno ≈ 1, un tablero ≈ 0.5', () => {
		const w = 20;
		const lleno: number[] = [];
		const tablero: number[] = [];
		for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
			lleno.push(y * w + x);
			if ((x + y) % 2 === 0) tablero.push(y * w + x);
		}
		expect(solidez(lleno, w)).toBeCloseTo(1, 5);
		expect(solidez(tablero, w)).toBeGreaterThan(0.45);
		expect(solidez(tablero, w)).toBeLessThan(0.55);
	});

	it('iou', () => {
		expect(iou({x0: 0, y0: 0, x1: 9, y1: 9}, {x0: 0, y0: 0, x1: 9, y1: 9})).toBe(1);
		expect(iou({x0: 0, y0: 0, x1: 9, y1: 9}, {x0: 5, y0: 0, x1: 14, y1: 9})).toBeCloseTo(50 / 150, 9);
		expect(iou({x0: 0, y0: 0, x1: 1, y1: 1}, {x0: 5, y0: 5, x1: 6, y1: 6})).toBe(0);
	});
});

describe('rachas → eventos', () => {
	it('encuentra la capa (caja y tiempos) y no el fondo quieto de todo el video', () => {
		const w = 60;
		const h = 80;
		const seg = new SegmentadorRachas(w, h, 12, 8);
		const sticker = {x0: 15, y0: 30, x1: 40, y1: 55, desde: 20, hasta: 70, rgb: [220, 90, 40] as [number, number, number]};
		const pared = {x0: 0, y0: 0, x1: 59, y1: 8, desde: 0, hasta: 1000, rgb: [200, 190, 170] as [number, number, number]};
		for (let n = 0; n < 100; n++) seg.procesar(cuadro(w, h, n, [pared, sticker]));
		const ev = eventosDeRachas(seg.terminar(), {fps: 30, minPixeles: 60});
		expect(ev.length).toBe(1);
		expect(ev[0].asentado).toBe(20);
		expect(ev[0].fin).toBe(70);
		expect(ev[0].caja).toEqual({x0: 15, y0: 30, x1: 40, y1: 55});
	});

	it('quita el fondo natural que se repite y respeta la franja excluida', () => {
		const w = 60;
		const h = 80;
		const seg = new SegmentadorRachas(w, h, 12, 8);
		// Un rectángulo beige (natural) que aparece 3 veces en el mismo lugar: fondo que vuelve.
		const fondo = [0, 1, 2].map((k) => ({x0: 5, y0: 5, x1: 30, y1: 25, desde: 50 * k, hasta: 50 * k + 20, rgb: [190, 170, 150] as [number, number, number]}));
		const enFranja = {x0: 10, y0: 60, x1: 50, y1: 70, desde: 10, hasta: 60, rgb: [255, 255, 255] as [number, number, number]};
		for (let n = 0; n < 150; n++) seg.procesar(cuadro(w, h, n, [...fondo, enFranja]));
		const excluir = new Uint8Array(w * h);
		for (let y = 58; y < 72; y++) excluir.fill(1, y * w, (y + 1) * w);
		const ev = eventosDeRachas(seg.terminar(), {fps: 30, minPixeles: 60, excluir, fondoS: 1, fondoFrac: 0.1});
		expect(ev.length).toBe(0);
	});
});

const crudo = (asentado: number, fin: number, caja: EventoCrudo['caja'], color: number, w = 270): EventoCrudo => {
	const px: number[] = [];
	for (let y = caja.y0; y <= caja.y1; y++) for (let x = caja.x0; x <= caja.x1; x++) px.push(y * w + x);
	return {asentado, fin, pixeles: Int32Array.from(px), colores: Int32Array.from(px, () => color), caja};
};

describe('fusión de fragmentos', () => {
	it('junta el texto que se va escribiendo con su tarjeta (mismo fin, encimados)', () => {
		const tarjeta = crudo(10, 100, {x0: 20, y0: 50, x1: 80, y1: 70}, empacar(255, 255, 255));
		const palabra = crudo(40, 100, {x0: 25, y0: 55, x1: 40, y1: 62}, empacar(20, 20, 20));
		const f = fusionarFragmentos([tarjeta, palabra]);
		expect(f.length).toBe(1);
		expect(f[0].asentado).toBe(10);
	});

	it('no junta tarjetas apiladas en lista (no se enciman)', () => {
		const a = crudo(10, 100, {x0: 20, y0: 50, x1: 80, y1: 60}, empacar(255, 255, 255));
		const b = crudo(30, 100, {x0: 20, y0: 63, x1: 80, y1: 73}, empacar(255, 255, 255));
		expect(fusionarFragmentos([a, b]).length).toBe(2);
	});

	it('reemplazo: si otra capa grande termina donde nace la tardía, la unión empieza en la tardía', () => {
		const anterior = crudo(10, 60, {x0: 20, y0: 50, x1: 80, y1: 70}, empacar(255, 255, 255));
		const compartido = crudo(10, 100, {x0: 22, y0: 52, x1: 78, y1: 69}, empacar(255, 255, 255));
		const nueva = crudo(60, 100, {x0: 22, y0: 60, x1: 78, y1: 69}, empacar(30, 30, 30));
		const f = fusionarFragmentos([anterior, compartido, nueva]);
		const unida = f.find((e) => e.fin === 100)!;
		expect(unida.asentado).toBe(60);
	});
});

describe('apariencia y clase', () => {
	const W = 270;
	const H = 480;
	const tarjetaBlanca = (): EventoCrudo => {
		const e = crudo(0, 30, {x0: 80, y0: 300, x1: 180, y1: 325}, empacar(255, 255, 255));
		// Texto: una franja gris oscura en medio.
		for (let i = 0; i < e.pixeles.length; i++) {
			const y = Math.floor(e.pixeles[i] / W);
			const x = e.pixeles[i] % W;
			if (y >= 310 && y <= 315 && x >= 90 && x <= 170 && x % 3 !== 0) e.colores[i] = empacar(40, 40, 40);
		}
		return e;
	};
	it('blanca con texto y ancha → tarjeta', () => {
		expect(clasificar(apariencia(tarjetaBlanca(), W, H))).toBe('tarjeta');
	});
	it('naranja viva → sticker', () => {
		expect(clasificar(apariencia(crudo(0, 30, {x0: 100, y0: 280, x1: 160, y1: 340}, empacar(217, 119, 87)), W, H))).toBe('sticker');
	});
	it('caja de más del 25 % del cuadro → insert', () => {
		expect(clasificar(apariencia(crudo(0, 30, {x0: 10, y0: 100, x1: 260, y1: 300}, empacar(30, 40, 60)), W, H))).toBe('insert');
	});
	it('beige natural chico → no es capa', () => {
		expect(clasificar(apariencia(crudo(0, 30, {x0: 100, y0: 280, x1: 130, y1: 300}, empacar(190, 170, 150)), W, H))).toBeNull();
	});
	it('blanco liso alto (pared) → no es tarjeta', () => {
		expect(clasificar(apariencia(crudo(0, 30, {x0: 100, y0: 200, x1: 120, y1: 300}, empacar(240, 240, 240)), W, H))).toBeNull();
	});
});

describe('pasada 2: pop medido contra uno conocido', () => {
	/** Recorte con un disco naranja de borde blanco a escala s alrededor de (cx, cy), sobre ruido. */
	function recorteCon(n: number, s: number | null, cx: number, cy: number, radio: number): Recorte {
		const x0 = 10;
		const y0 = 10;
		const w = 120;
		const h = 120;
		const r = azar(500 + n);
		const rgb = new Uint8Array(w * h * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const o = 3 * (y * w + x);
				const v = 60 + Math.floor(r() * 100);
				rgb[o] = v;
				rgb[o + 1] = v;
				rgb[o + 2] = v;
				if (s === null) continue;
				const d = Math.hypot(x0 + x - cx, y0 + y - cy) / s;
				if (d <= radio) rgb.set(d <= radio - 3 ? [217, 119, 87] : [255, 255, 255], o);
			}
		}
		return {x0, y0, w, h, rgb};
	}
	it('mide desde, cuadros del pop, escala inicial y sobrepaso', () => {
		const cx = 70;
		const cy = 70;
		const radio = 30;
		const escalas = [0.5, 0.68, 0.84, 0.96, 1.05, 1.03, 1.0];
		const recortes = new Map<number, Recorte>();
		const inicio = 40;
		for (let n = 0; n < 100; n++) {
			let s: number | null = null;
			if (n >= inicio && n < 90) s = escalas[Math.min(escalas.length - 1, n - inicio)];
			recortes.set(n, recorteCon(n, s, cx, cy, radio));
		}
		// Píxeles de la capa (a escala 1) en coordenadas del cuadro W = 270.
		const W = 270;
		const px: number[] = [];
		for (let y = cy - radio; y <= cy + radio; y++) for (let x = cx - radio; x <= cx + radio; x++) if (Math.hypot(x - cx, y - cy) <= radio) px.push(y * W + x);
		const e: EventoCrudo = {asentado: inicio + 3, fin: 90, pixeles: Int32Array.from(px), colores: Int32Array.from(px, () => empacar(217, 119, 87)), caja: {x0: cx - radio, y0: cy - radio, x1: cx + radio, y1: cy + radio}};
		const r = refinarEvento(e, W, recortes, 15, 100, 30);
		expect(r.desde).toBe(inicio);
		expect(r.hasta).toBe(90);
		expect(r.pop).not.toBeNull();
		expect(r.pop!.cuadros).toBe(6);
		expect(r.pop!.escala_inicial).toBeGreaterThanOrEqual(0.46);
		expect(r.pop!.escala_inicial).toBeLessThanOrEqual(0.54);
		expect(r.pop!.sobrepaso).toBeGreaterThanOrEqual(0.03);
		expect(r.pop!.sobrepaso).toBeLessThanOrEqual(0.07);
	});
});

describe('tomas', () => {
	it('una toma distinta en medio de la principal sale como insert', () => {
		const n = 100;
		const mini = new Uint8Array(n * MINI_W * MINI_H);
		const miniRgb = new Uint8Array(n * MINI_W * MINI_H * 3);
		for (let t = 0; t < n; t++) {
			const otra = t >= 30 && t < 50;
			for (let b = 0; b < MINI_W * MINI_H; b++) {
				const x = b % MINI_W;
				const v = otra ? 20 + ((x * 7) % 30) : 150 + ((b * 13) % 60);
				mini[t * MINI_W * MINI_H + b] = v;
				miniRgb.set(otra ? [v, v, v + 40] : [v + 30, v, v - 30], 3 * (t * MINI_W * MINI_H + b));
			}
		}
		const pc: PorCuadro = {cambio: new Float32Array(n), nitidez: new Float32Array(n).fill(10), miniaturas: mini, miniaturasRgb: miniRgb};
		const {cortes, tomas} = tomasDeVideo(pc, 30);
		expect(cortes).toEqual([30, 50]);
		expect(tomas.map((t) => t.principal)).toEqual([true, false, true]);
	});
});

describe('relación con SFX y resumen', () => {
	const onsets = [
		{t: 1.0, fuentes: ['clic' as const], margen_db: 3},
		{t: 2.6, fuentes: ['agudos' as const], margen_db: 1},
	];
	it('sfxDeAparicion: onset a ±3 cuadros, desfase en cuadros', () => {
		expect(sfxDeAparicion(1.033, onsets, 30)).toMatchObject({con_sfx: true, desfase_cuadros: -1, confiable: true});
		expect(sfxDeAparicion(2.5, onsets, 30)).toMatchObject({con_sfx: true, desfase_cuadros: 3, confiable: false});
		expect(sfxDeAparicion(2.0, onsets, 30).con_sfx).toBe(false);
	});
	it('coberturaAlAzar: unión de ventanas de ±3.5 cuadros', () => {
		expect(coberturaAlAzar(onsets, 10, 30)).toBeCloseTo((2 * 7) / 30 / 10, 9);
		expect(coberturaAlAzar([{t: 1, fuentes: ['clic'], margen_db: 0}, {t: 1.05, fuentes: ['clic'], margen_db: 0}], 10, 30)).toBeCloseTo((0.05 + 7 / 30) / 10, 9);
	});
	it('resumirReel y secuenciasDeInsert', () => {
		const ev = (id: string, clase: EventoCapa['clase'], subtipo: EventoCapa['subtipo'], d: number, h: number, sfx: boolean): EventoCapa => ({
			id,
			clase,
			subtipo,
			desde: d,
			hasta: h,
			desde_cuadro: Math.round(d * 30),
			hasta_cuadro: Math.round(h * 30),
			duracion_s: h - d,
			caja: {x: 400, y: 1100, w: 300, h: 300},
			centro: {x: 550, y: 1250},
			entrada: clase === 'sticker' ? {cuadros: 5, escala_inicial: 0.55, sobrepaso: 0, escalas: []} : null,
			apariencia: null,
			sfx: {con_sfx: sfx, onset_s: sfx ? d : null, desfase_cuadros: sfx ? 0 : null, fuentes: sfx ? ['clic'] : [], confiable: sfx},
			nota: null,
		});
		const eventos = [
			ev('e1', 'sticker', 'capa', 1, 2, true),
			ev('e2', 'tarjeta', 'capa', 3, 4, true),
			ev('e3', 'tarjeta', 'capa', 6, 7, false),
			ev('e4', 'insert', 'pantalla-completa', 8, 9, false),
			ev('e5', 'insert', 'pantalla-completa', 9, 10, false),
		];
		expect(secuenciasDeInsert(eventos)).toBe(1);
		const r = resumirReel(eventos, 60, onsets, 30);
		expect(r.por_clase).toEqual({sticker: 1, tarjeta: 2, insert: 2, otro: 0});
		expect(r.stickers_por_min).toEqual({valor: 1, n: 1});
		expect(r.pct_con_sfx).toEqual({valor: 40, n: 5});
		expect(r.pct_sin_sonido).toEqual({valor: 60, n: 5});
		expect(r.huecos_entre_eventos_con_sonido_s).toMatchObject({p50: 2, n: 1});
		expect(r.pop_cuadros_sticker).toMatchObject({valor: 5, n: 1});
		expect(cuantil([1, 2, 3, 4], 0.5)).toBe(2.5);
	});
});
