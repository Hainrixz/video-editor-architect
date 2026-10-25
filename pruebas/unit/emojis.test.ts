// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Emojis animados (Noto Emoji Animation, CC BY 4.0): lectura de WebP animado (info de webpmux, PAM), composición con
 * fusión y desecho, borde fijo en un lienzo cuadrado común, catálogo para el director (compiten por concepto y se
 * fuerzan con "emoji-<nombre>") y la animación que dibuja Remotion. Todo en el sandbox, sin red.
 */
import {describe, expect, it} from 'vitest';
import {crearContexto, type InfoPng} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde, type EstiloDirector} from '../../herramientas/lib/director/estilo.ts';
import {candidatosStickers, CONCEPTOS_STICKER} from '../../herramientas/lib/director/momentos.ts';
import {leerNotas, planear, type EntradasPlan} from '../../herramientas/lib/director/plan.ts';
import {leerCatalogosStickers, opcionesSticker, type EntradaMascota} from '../../herramientas/lib/director/stickers.ts';
import type {Palabra} from '../../herramientas/lib/director/texto.ts';
import {reglasDeVoz} from '../../herramientas/lib/director/voz.ts';
import {bordeAnimado, componerAnimacion, EMOJIS, escribirPam, leerPam, licencias, parsearInfoWebp, type CuadroWebp, type FilaEmoji} from '../../herramientas/stickers/emojis.ts';
import {cajaTinta, nuevaImagen, verificarSticker, type ImagenRGBA} from '../../herramientas/stickers/lib/borde.ts';
import {animacionDeSticker, ladoCanvasEmoji} from '../../src/reel/Sticker.tsx';
import {HAY_FUENTES} from './requisitos.ts';

const INFO = `Canvas size: 512 x 512
Features present: animation transparency
Background color : 0xFFFFFFFF  Loop Count : 0
Number of frames: 3
No.: width height alpha x_offset y_offset duration   dispose blend image_size  compression
  1:   499   447   yes        6       28       30 background    no      11348       lossy
  2:   489   447   yes       12       28       30 background   yes      11200       lossy
  3:   465   447   yes       22       28       40       none    no      11062       lossy
`;

/** Imagen de un solo color. */
function lleno(ancho: number, alto: number, rgba: [number, number, number, number]): ImagenRGBA {
	return nuevaImagen(ancho, alto, rgba);
}
const px = (img: ImagenRGBA, x: number, y: number) => Array.from(img.datos.subarray((y * img.ancho + x) * 4, (y * img.ancho + x) * 4 + 4));

/** Un disco de radio r centrado en (cx, cy) dentro de un lienzo w×w. */
function disco(w: number, cx: number, cy: number, r: number): ImagenRGBA {
	const img = nuevaImagen(w, w);
	for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.datos.set([240, 180, 20, 255], (y * w + x) * 4);
	return img;
}

describe('WebP animado', () => {
	it('lee la info de webpmux: lienzo, desplazamientos, duraciones, desecho y fusión', () => {
		const r = parsearInfoWebp(INFO);
		expect(r).toMatchObject({ancho: 512, alto: 512});
		expect(r.cuadros).toHaveLength(3);
		expect(r.cuadros[0]).toEqual({ancho: 499, alto: 447, x: 6, y: 28, duracion_ms: 30, desecho: 'fondo', fusion: false});
		expect(r.cuadros[2]).toMatchObject({duracion_ms: 40, desecho: 'nada', fusion: false});
		expect(() => parsearInfoWebp('nada')).toThrow(/lienzo/);
	});

	it('PAM RGBA de ida y vuelta', () => {
		const img = lleno(3, 2, [10, 20, 30, 128]);
		img.datos.set([1, 2, 3, 4], 0);
		const r = leerPam(escribirPam(img));
		expect(r.ancho).toBe(3);
		expect(r.alto).toBe(2);
		expect(Array.from(r.datos)).toEqual(Array.from(img.datos));
	});

	it('compone con fusión (alfa encima), sin fusión (reemplaza) y desecho "background" (vuelve a transparente)', () => {
		const c = (x: number, y: number, ancho: number, alto: number, extra: Partial<CuadroWebp>): CuadroWebp => ({ancho, alto, x, y, duracion_ms: 30, desecho: 'nada', fusion: true, ...extra});
		const r = componerAnimacion({ancho: 4, alto: 4}, [
			{info: c(0, 0, 4, 4, {}), img: lleno(4, 4, [255, 0, 0, 255])},
			// Mitad de alfa encima del rojo, en (1,1)-(2,2), y luego desecho de su rectángulo.
			{info: c(1, 1, 2, 2, {desecho: 'fondo'}), img: lleno(2, 2, [0, 0, 255, 128])},
			// Sin fusión: reemplaza (0,0) con transparente; el rectángulo del anterior ya quedó en transparente.
			{info: c(0, 0, 1, 1, {fusion: false}), img: lleno(1, 1, [0, 0, 0, 0])},
		]);
		expect(px(r[0], 2, 2)).toEqual([255, 0, 0, 255]);
		const mezcla = px(r[1], 1, 1);
		expect(mezcla[3]).toBe(255);
		expect(mezcla[0]).toBeGreaterThan(120);
		expect(mezcla[2]).toBeGreaterThan(120);
		expect(px(r[1], 3, 3)).toEqual([255, 0, 0, 255]);
		expect(px(r[2], 1, 1)[3]).toBe(0);
		expect(px(r[2], 2, 2)[3]).toBe(0);
		expect(px(r[2], 0, 0)[3]).toBe(0);
		expect(px(r[2], 3, 3)).toEqual([255, 0, 0, 255]);
	});

	it('borde fijo en un lienzo cuadrado común: el sujeto no se mueve, la orilla es blanca y la tinta cubre todos los cuadros', () => {
		// Un disco que crece y otro que se corre: el lienzo sale del tamaño de la unión.
		const cuadros = [disco(120, 60, 60, 30), disco(120, 60, 60, 40), disco(120, 75, 60, 30), nuevaImagen(120, 120)];
		const r = bordeAnimado(cuadros, {grosor: 6});
		expect(new Set(r.cuadros.map((c) => `${c.ancho}x${c.alto}`)).size).toBe(1);
		expect(r.cuadros[0].ancho).toBe(r.cuadros[0].alto);
		expect(r.poster).toBe(1);
		expect(verificarSticker(r.cuadros[r.poster]).ok).toBe(true);
		// El centro del disco 0 y del 1 coincide (mismo lugar en el lienzo); el 2 está 15 px a la derecha.
		const centro = (i: number) => {
			const t = cajaTinta(r.cuadros[i], 250)!;
			return {x: t.x + t.w / 2, y: t.y + t.h / 2};
		};
		expect(Math.abs(centro(0).x - centro(1).x)).toBeLessThanOrEqual(1);
		expect(Math.abs(centro(2).x - centro(0).x - 15)).toBeLessThanOrEqual(1);
		// La caja de tinta cubre la tinta de cada cuadro; el cuadro vacío sigue vacío.
		for (const c of r.cuadros.slice(0, 3)) {
			const t = cajaTinta(c, 1)!;
			expect(t.x).toBeGreaterThanOrEqual(r.caja_tinta.x);
			expect(t.y).toBeGreaterThanOrEqual(r.caja_tinta.y);
			expect(t.x + t.w).toBeLessThanOrEqual(r.caja_tinta.x + r.caja_tinta.w);
			expect(t.y + t.h).toBeLessThanOrEqual(r.caja_tinta.y + r.caja_tinta.h);
		}
		expect(cajaTinta(r.cuadros[3], 1)).toBeNull();
	});
});

describe('catálogo de emojis', () => {
	it('el set inicial: ids únicos, codepoints en hexadecimal y etiquetas en español', () => {
		expect(EMOJIS.length).toBeGreaterThanOrEqual(30);
		expect(new Set(EMOJIS.map((e) => e.nombre)).size).toBe(EMOJIS.length);
		for (const e of EMOJIS) {
			expect(e.nombre).toMatch(/^[a-z0-9-]+$/);
			expect(e.codepoint).toMatch(/^[0-9a-f]{4,5}$/);
			expect(String.fromCodePoint(Number.parseInt(e.codepoint, 16))).toBe(e.emoji.replace(/️/g, ''));
			expect(e.etiquetas.length).toBeGreaterThan(0);
		}
	});

	it('cada concepto de emoji que agregó el director tiene al menos un emoji que lo cubre', () => {
		const cat = {mascotas: EMOJIS.map((e): EntradaMascota => ({id: `emoji-${e.nombre}`, archivo: `biblioteca/stickers/emojis/emoji-${e.nombre}.png`, ancho: 548, alto: 548, caja_tinta: {x: 2, y: 2, w: 544, h: 544}, pose: `emoji:emoji-${e.nombre}`, ojos: null, prop: null, texto: null, etiquetas: e.etiquetas, fuente: 'emoji', emoji: e.emoji})), logos: []};
		for (const id of ['risa', 'miedo', 'sorpresa', 'fiesta', 'triste', 'objetivo', 'cool', 'impresionante', 'rapido', 'idea', 'listo', 'dinero', 'error', 'fuego', 'pensar', 'buscar', 'importante']) {
			const c = CONCEPTOS_STICKER.find((x) => x.id === id)!;
			const o = opcionesSticker({concepto: id, etiquetas: c.etiquetas, marca: null, logo: false}, cat, 's');
			expect(o.length, id).toBeGreaterThan(0);
			expect(o[0].nota).toMatch(/^emoji animado /);
		}
	});

	it('"jajaja" pide sticker de risa', () => {
		const palabras: Palabra[] = ['eso', 'fue', 'jajaja', 'increíble'].map((t, i) => ({i, t, d: i * 0.4, h: i * 0.4 + 0.35}));
		const c = candidatosStickers(palabras, []);
		expect(c.map((x) => x.sticker?.concepto)).toContain('risa');
	});

	it('el catálogo real (si ya corrió emojis.ts) entra al director con su propia pose y sin ventaja sobre mascota', () => {
		const cat = leerCatalogosStickers();
		const emojis = cat.mascotas.filter((c) => c.fuente === 'emoji');
		if (emojis.length === 0) return; // sin catálogo de emojis todavía: nada que revisar
		expect(new Set(emojis.map((e) => e.pose)).size).toBe(emojis.length);
		for (const e of emojis) {
			expect(e.id).toMatch(/^emoji-/);
			expect(e.ancho).toBe(e.alto);
			expect(animacionDeSticker(e.archivo)).toBe(e.archivo.replace(/\.png$/, '.webp'));
		}
		// Empate de etiquetas entre un emoji y un mascota: el orden lo decide la semilla, no la fuente.
		const voxel: EntradaMascota = {id: 'mascota-x', archivo: 'a.png', ancho: 10, alto: 10, caja_tinta: {x: 0, y: 0, w: 10, h: 10}, pose: 'frente', ojos: null, prop: null, texto: null, etiquetas: ['idea']};
		const emoji: EntradaMascota = {...voxel, id: 'emoji-foco', archivo: 'biblioteca/stickers/emojis/emoji-foco.png', pose: 'emoji:emoji-foco', fuente: 'emoji', emoji: '💡'};
		const o = opcionesSticker({concepto: 'idea', etiquetas: ['idea'], marca: null, logo: false}, {mascotas: [voxel, emoji], logos: []}, 's');
		expect(o.map((x) => x.coincidencias)).toEqual([2, 2]);
	});

	it('licencias: una fila por póster y por animación, con la atribución CC BY 4.0', () => {
		const f = {id: 'emoji-risa', nombre: 'risa', emoji: '😂', codepoint: '1f602', archivo: 'biblioteca/stickers/emojis/emoji-risa.png', animacion: 'biblioteca/stickers/emojis/emoji-risa.webp', origen: {url: 'https://x', sha256: 'a'.repeat(64)}} as FilaEmoji;
		const md = licencias([f]);
		expect(md).toMatch(/CC BY 4\.0/);
		expect(md).toMatch(/Google/);
		expect(md).toMatch(/stickers\/emojis\/emoji-risa\.png/);
		expect(md).toMatch(/stickers\/emojis\/emoji-risa\.webp/);
	});
});

describe('Remotion', () => {
	it('solo los pósters de emoji tienen animación (el .webp de al lado)', () => {
		expect(animacionDeSticker('biblioteca/stickers/emojis/emoji-risa.png')).toBe('biblioteca/stickers/emojis/emoji-risa.webp');
		expect(animacionDeSticker('biblioteca/stickers/mascota/mascota-frente-felices.png')).toBeNull();
		expect(animacionDeSticker('biblioteca/stickers/emojis/catalogo.json')).toBeNull();
		expect(ladoCanvasEmoji(300)).toBe(400);
		expect(ladoCanvasEmoji(5000)).toBe(1024);
	});
});

// ───────────────────────── sticker forzado en el plan ─────────────────────────

function cara(barbilla: number, coronilla = 500, segundos = 20): CaraConsultable {
	const h = barbilla - coronilla - 150;
	return {fps: 30, cuadros: Array.from({length: segundos * 30}, (_, j) => ({t: j / 30, cara: {x: 400, y: barbilla - h, w: 300, h}, barbilla_y: barbilla, coronilla_y: coronilla, cabeza: {x: 380, y: coronilla, w: 340, h: barbilla - coronilla}}))};
}

describe('director', () => {
	it.runIf(HAY_FUENTES)('un emoji se fuerza en notas-director.json con id_catalogo "emoji-<nombre>" y su asset es el póster', () => {
		const estilo: EstiloDirector = estiloDesde({decision: false});
		const palabras: Palabra[] = 'esto me dio mucha risa la verdad y luego lo probé otra vez con calma'.split(' ').map((t, i) => ({i, t, d: i * 0.35, h: i * 0.35 + 0.3}));
		const png: InfoPng = {ancho: 548, alto: 548, tinta: {x: 2, y: 2, w: 544, h: 544}};
		const emoji: EntradaMascota = {id: 'emoji-risa', archivo: 'biblioteca/stickers/emojis/emoji-risa.png', ancho: png.ancho, alto: png.alto, caja_tinta: png.tinta!, pose: 'emoji:emoji-risa', ojos: null, prop: null, texto: null, etiquetas: ['risa'], fuente: 'emoji', emoji: '😂'};
		const entradas: EntradasPlan = {
			slug: 'prueba',
			semilla: 'prueba',
			palabras,
			duracion: palabras.at(-1)!.h + 0.5,
			ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'}),
			estilo,
			catalogos: {mascotas: [emoji], logos: []},
			terminos: [],
			notas: leerNotas({stickers_forzados: [{id_catalogo: 'emoji-risa', desde_palabra: 'risa'}], sin_tarjetas: true}).notas,
			voz: reglasDeVoz('## Prohibido\n- nada\n'),
		};
		const plan = planear(entradas);
		const s = plan.stickers.find((x) => x.asset === emoji.archivo);
		expect(s, plan.avisos.join(' | ')).toBeDefined();
		expect(s!.desde).toBeCloseTo(palabras[4].d, 3);
		expect(s!.entrada).toBe('pop');
		expect(s!.salida).toBe('corte');
		expect(animacionDeSticker(s!.asset)).toBe('biblioteca/stickers/emojis/emoji-risa.webp');
	});
});
