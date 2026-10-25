// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Franja de legibilidad de subtítulos sobre demos a pantalla completa (src/estilo/franja.ts).
 * Decisión de legibilidad 2026-10-04, no medida en tus reels: aquí solo se prueba que la geometría y el filtro hagan
 * lo que dice el comentario.
 */
import {describe, expect, it} from 'vitest';
import {MEDIA_MESETA_PX, MEDIO_ALTO_PX, OPACIDAD_PICO, franjaSubtitulos, llevaFranja} from '../../src/estilo/franja';

describe('llevaFranja', () => {
	it('solo demos de pantalla a pantalla completa', () => {
		expect(llevaFranja({tipo: 'demo', layout: 'pantalla-completa', asset: 'demos/x/toma.mp4'})).toBe(true);
		expect(llevaFranja({tipo: 'demo', layout: 'tarjeta', asset: 'demos/x/toma.mp4'})).toBe(false);
		expect(llevaFranja({tipo: 'demo', layout: 'pantalla-completa', asset: 'demos/x/a.terminal.json'})).toBe(false);
		expect(llevaFranja({tipo: 'video', layout: 'pantalla-completa', asset: 'p/x/inserts/a.mp4'})).toBe(false);
		expect(llevaFranja({tipo: 'imagen', layout: 'pantalla-completa', asset: 'p/x/inserts/a.png'})).toBe(false);
	});
});

describe('franjaSubtitulos', () => {
	it('queda centrada en la y del subtítulo, con el pico pedido (55–65 %)', () => {
		const f = franjaSubtitulos(1498.5);
		expect(f.top + f.alto / 2).toBeCloseTo(1498.5, 6);
		expect(f.alto).toBe(2 * MEDIO_ALTO_PX);
		expect(OPACIDAD_PICO).toBeGreaterThanOrEqual(0.55);
		expect(OPACIDAD_PICO).toBeLessThanOrEqual(0.65);
		expect(f.fondo).toContain(`rgba(0, 0, 0, ${OPACIDAD_PICO})`);
		expect(f.fondo.startsWith('linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%')).toBe(true);
		expect(f.fondo.endsWith('rgba(0, 0, 0, 0) 100%)')).toBe(true);
	});

	it('la meseta cubre la letra del subtítulo (58.7 px) y no llega a las tarjetas (y ≈ 1287) ni al pie', () => {
		expect(MEDIA_MESETA_PX * 2).toBeGreaterThan(58.7);
		const f = franjaSubtitulos(1498.5);
		expect(f.top).toBeGreaterThan(1287);
		expect(f.top + f.alto).toBeLessThan(1920);
	});

	it('acepta otros valores sin romper el orden de las paradas', () => {
		const f = franjaSubtitulos(1000, {pico: 0.5, mediaMeseta: 10, medioAlto: 5});
		const paradas = [...f.fondo.matchAll(/ ([\d.]+)%/g)].map((m) => Number(m[1]));
		expect(paradas).toEqual([...paradas].sort((a, b) => a - b));
		expect(f.fondo).toContain('rgba(0, 0, 0, 0.5)');
	});
});
