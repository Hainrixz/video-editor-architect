// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/** Sticker de persona (herramientas/stickers/avatar.ts): tipo de imagen y tile con el avatar en círculo. */
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CANDIDATAS} from '../../src/estilo/fuentes.ts';
import {abrirFuente} from '../../herramientas/lib/texto-ancho.ts';
import {RAIZ} from '../../herramientas/lib/manifest.ts';
import {armarTileAvatar, svgAvatarCircular, tipoImagen} from '../../herramientas/stickers/avatar.ts';
import {PESO_NOMBRE} from '../../herramientas/stickers/logo.ts';
import {HAY_FUENTES} from './requisitos.ts';

/** PNG 1×1 rojo opaco. */
const PNG_ROJO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

describe('avatar', () => {
	it('reconoce PNG, JPEG y WebP por sus bytes y rechaza lo demás', () => {
		expect(tipoImagen(PNG_ROJO)).toEqual({mime: 'image/png', ext: 'png'});
		expect(tipoImagen(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({mime: 'image/jpeg', ext: 'jpg'});
		expect(tipoImagen(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toEqual({mime: 'image/webp', ext: 'webp'});
		expect(tipoImagen(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
	});

	it('el SVG recorta la imagen en un círculo que llena el cuadro', () => {
		const svg = svgAvatarCircular(PNG_ROJO, 'image/png', 100);
		expect(svg).toContain('<circle cx="50" cy="50" r="50"/>');
		expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
		expect(svg).toContain(`data:image/png;base64,${PNG_ROJO.toString('base64')}`);
	});

	it.runIf(HAY_FUENTES)('el tile lleva el avatar dibujado (no se pierde) en el centro de la caja del logo, y esquinas transparentes', () => {
		const archivo = CANDIDATAS['tiktok-sans'].archivos[PESO_NOMBRE]!;
		const fuente = abrirFuente(join(RAIZ, archivo.ruta));
		const {imagen} = armarTileAvatar(PNG_ROJO, 'image/png', 'Ana García', fuente, 200);
		const px = (x: number, y: number) => {
			const k = (y * imagen.ancho + x) * 4;
			return [...imagen.datos.subarray(k, k + 4)];
		};
		expect(px(0, 0)[3]).toBe(0);
		// Centro del avatar: 0.42 del alto del tile (más el margen de la sombra).
		const m = (imagen.ancho - 200) / 2;
		const [r, g, b, a] = px(Math.round(m + 100), Math.round(m + 84));
		expect(a).toBe(255);
		expect(r).toBeGreaterThan(200);
		expect(g).toBeLessThan(60);
		expect(b).toBeLessThan(60);
	});
});
