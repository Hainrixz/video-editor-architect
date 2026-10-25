// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Stickers de IA (Higgsfield → ia-post.ts → biblioteca/stickers/ia): solo entran forzados en notas-director.json.
 */
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {crearContexto, type InfoPng} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde, type EstiloDirector} from '../../herramientas/lib/director/estilo.ts';
import {leerNotas, planear, type EntradasPlan} from '../../herramientas/lib/director/plan.ts';
import {leerCatalogosStickers, type EntradaMascota} from '../../herramientas/lib/director/stickers.ts';
import type {Palabra} from '../../herramientas/lib/director/texto.ts';
import {reglasDeVoz} from '../../herramientas/lib/director/voz.ts';
import {HAY_FUENTES} from './requisitos.ts';

function cara(barbilla: number, coronilla = 500, segundos = 20): CaraConsultable {
	const h = barbilla - coronilla - 150;
	return {fps: 30, cuadros: Array.from({length: segundos * 30}, (_, j) => ({t: j / 30, cara: {x: 400, y: barbilla - h, w: 300, h}, barbilla_y: barbilla, coronilla_y: coronilla, cabeza: {x: 380, y: coronilla, w: 340, h: barbilla - coronilla}}))};
}

const png: InfoPng = {ancho: 600, alto: 600, tinta: {x: 10, y: 10, w: 580, h: 580}};
const escudo: EntradaMascota = {id: 'ia-escudo', archivo: 'biblioteca/stickers/ia/ia-escudo.png', ancho: png.ancho, alto: png.alto, caja_tinta: png.tinta!, pose: 'ia:ia-escudo', ojos: null, prop: null, texto: null, etiquetas: ['seguridad'], fuente: 'ia'};

function entradas(forzados: {id_catalogo: string; desde_palabra: string}[]): EntradasPlan {
	const estilo: EstiloDirector = estiloDesde({decision: false});
	const palabras: Palabra[] = 'la seguridad de tu aplicación es lo más importante cuando haces apps con Claude'.split(' ').map((t, i) => ({i, t, d: i * 0.35, h: i * 0.35 + 0.3}));
	return {
		slug: 'prueba',
		semilla: 'prueba',
		palabras,
		duracion: palabras.at(-1)!.h + 0.5,
		ctx: crearContexto({cara: cara(900), estilo, semilla: 'prueba'}),
		estilo,
		catalogos: {mascotas: [], logos: [], ia: [escudo]},
		terminos: [],
		notas: leerNotas({stickers_forzados: forzados, sin_tarjetas: true}).notas,
		voz: reglasDeVoz('## Prohibido\n- nada\n'),
	};
}

describe('stickers de IA', () => {
	it.runIf(HAY_FUENTES)('uno forzado con id_catalogo "ia-<concepto>" entra con su png', () => {
		const plan = planear(entradas([{id_catalogo: 'ia-escudo', desde_palabra: 'seguridad'}]));
		const s = plan.stickers.find((x) => x.asset === escudo.archivo);
		expect(s, plan.avisos.join(' | ')).toBeDefined();
		expect(s!.desde).toBeCloseTo(0.35, 3);
	});

	it.runIf(HAY_FUENTES)('uno que no existe avisa y no entra', () => {
		const plan = planear(entradas([{id_catalogo: 'ia-nada', desde_palabra: 'seguridad'}]));
		expect(plan.stickers).toHaveLength(0);
		expect(plan.avisos.some((a) => a.includes('ia-nada') && a.includes('no está en los catálogos'))).toBe(true);
	});

	it('leerCatalogosStickers los lee aparte (no compiten por concepto con mascota)', () => {
		const raiz = mkdtempSync(join(tmpdir(), 'ia-'));
		for (const c of ['mascota', 'logos', 'ia']) mkdirSync(join(raiz, 'biblioteca/stickers', c), {recursive: true});
		writeFileSync(join(raiz, 'biblioteca/stickers/mascota/catalogo.json'), '[]');
		writeFileSync(join(raiz, 'biblioteca/stickers/logos/catalogo.json'), '[]');
		writeFileSync(join(raiz, 'biblioteca/stickers/ia/catalogo.json'), JSON.stringify([{id: 'ia-escudo', archivo: escudo.archivo, ancho: 600, alto: 600, caja_tinta: png.tinta, etiquetas: []}]));
		const cat = leerCatalogosStickers(raiz);
		expect(cat.ia.map((x) => x.id)).toEqual(['ia-escudo']);
		expect(cat.mascotas).toHaveLength(0);
	});
});
