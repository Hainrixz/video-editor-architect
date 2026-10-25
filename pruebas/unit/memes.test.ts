// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {resultadosGiphy} from '../../herramientas/memes/buscar.ts';
import {cajaMeme, esMeme, MEME, radioMeme} from '../../src/estilo/memes.ts';
import {ZONA_SEGURA} from '../../src/estilo/zona-segura.ts';
import {catalogoConDatos} from './requisitos.ts';

const RAIZ = join(__dirname, '..', '..');

describe('memes', () => {
	it('esMeme: solo lo que vive en biblioteca/memes/', () => {
		expect(esMeme('biblioteca/memes/obama-encoge-hombros.mp4')).toBe(true);
		expect(esMeme('/biblioteca/memes/x.gif')).toBe(true);
		expect(esMeme('p/2026-10-04-reel-prueba/inserts/meme.mp4')).toBe(false);
		expect(esMeme('biblioteca/memes/sub/x.mp4')).toBe(false);
		expect(esMeme('demos/x/toma.mp4')).toBe(false);
	});

	it('cajaMeme: centro y 940, 800 de ancho y dentro de la zona cian; se achica si no cabe a lo alto', () => {
		const c = cajaMeme({aspecto: 0.75, techo: 220, piso: 1500});
		expect(c).toMatchObject({x: 540, y: 940, w: 800, h: 600, achicado: false});
		expect(cajaMeme({aspecto: 1, ancho: 2000, techo: 220, piso: 1500}).w).toBe(MEME.ancho_max);
		expect(MEME.x - MEME.ancho_max / 2).toBeGreaterThanOrEqual(ZONA_SEGURA.capas.x0);
		expect(MEME.x + MEME.ancho_max / 2).toBeLessThanOrEqual(ZONA_SEGURA.capas.x1);
		const alto = cajaMeme({aspecto: 2, techo: 400, piso: 1400});
		expect(alto.achicado).toBe(true);
		expect(alto.h).toBe(1000);
		expect(alto.y - alto.h / 2).toBeGreaterThanOrEqual(400);
		expect(alto.y + alto.h / 2).toBeLessThanOrEqual(1400);
	});

	it('radioMeme: ≈ 52 px a 770 de ancho (Dkb-2mabk15)', () => {
		expect(radioMeme(770)).toBeCloseTo(52, 1);
		expect(radioMeme(800)).toBeCloseTo(54, 0);
	});

	it.runIf(catalogoConDatos('biblioteca/memes/catalogo.json'))('catálogo: cada meme existe, con su URL de origen y medidas', () => {
		const cat = JSON.parse(readFileSync(join(RAIZ, 'biblioteca/memes/catalogo.json'), 'utf8')) as {memes: Array<{id: string; archivo: string; url_origen: string; duracion_s: number; ancho: number; alto: number; etiquetas: string[]}>};
		expect(cat.memes.length).toBeGreaterThanOrEqual(4);
		const ids = new Set<string>();
		for (const m of cat.memes) {
			expect(ids.has(m.id)).toBe(false);
			ids.add(m.id);
			expect(esMeme(m.archivo)).toBe(true);
			expect(existsSync(join(RAIZ, m.archivo))).toBe(true);
			expect(m.url_origen).toMatch(/^https:\/\//);
			expect(m.duracion_s).toBeGreaterThan(0);
			expect(m.ancho).toBeGreaterThan(0);
			expect(m.alto).toBeGreaterThan(0);
			expect(m.etiquetas.length).toBeGreaterThan(0);
		}
	});

	it('resultadosGiphy: id y título del HTML escapado, sin repetir', () => {
		const html = '{\\"type\\":\\"gif\\",\\"id\\":\\"LlE3uMF20U7Ys\\",\\"url\\":\\"x\\",\\"title\\":\\"barack obama shrug GIF\\"} {\\"id\\":\\"LlE3uMF20U7Ys\\",\\"title\\":\\"otra\\"} {"id":"abcdefgh","title":"Cat"}';
		expect(resultadosGiphy(html)).toEqual([
			{id: 'LlE3uMF20U7Ys', titulo: 'barack obama shrug GIF', mp4: 'https://media.giphy.com/media/LlE3uMF20U7Ys/giphy.mp4'},
			{id: 'abcdefgh', titulo: 'Cat', mp4: 'https://media.giphy.com/media/abcdefgh/giphy.mp4'},
		]);
	});
});
