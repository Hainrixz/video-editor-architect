// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Regla del prompt (decisión del estilo, 2026-10-04): "le dices a Claude" → tarjeta prompt escribiéndose con el tecleo de tus
 * Foleys, que dura lo que tarda en escribirse. Duración del SFX en la EDL (sfx.duracion_frames) y su fundido.
 */
import {describe, expect, it} from 'vitest';
import {EdicionBase, edicionVacia, FUNDIDO_SFX_CUADROS, volumenSfx, dbAGanancia, type Edicion} from '../../src/esquema/edicion.ts';
import {cuadroTextoCompleto, ESCRITURA_PROMPT_MEDIDA} from '../../src/estilo/animaciones.ts';
import {ESTILO_TARJETA_POR_DEFECTO} from '../../src/estilo/capas.ts';
import {crearContexto} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {leerNotas, planear} from '../../herramientas/lib/director/plan.ts';
import {
	archivoTecleo,
	CARACTERES_RENGLON_PROMPT,
	cuadrosDeTecleo,
	esTecleo,
	momentosPrompt,
	partirPrompt,
	renglonesPrompt,
	RENGLONES_PROMPT,
	tecleoDeTarjetas,
	tiempoPrompt,
} from '../../herramientas/lib/director/tecleo.ts';
import type {Palabra} from '../../herramientas/lib/director/texto.ts';
import type {ArchivoSfx} from '../../herramientas/lib/sfx.ts';
import {eventosDeEdicion} from '../../herramientas/sfx/elegir.ts';
import {HAY_FUENTES} from './requisitos.ts';

const ESTILO_T = ESTILO_TARJETA_POR_DEFECTO;

function palabrasDe(texto: string, paso = 0.3, t0 = 0): Palabra[] {
	return texto
		.split(/\s+/)
		.filter(Boolean)
		.map((t, i) => ({i, t, d: Math.round((t0 + i * paso) * 1000) / 1000, h: Math.round((t0 + i * paso + paso - 0.05) * 1000) / 1000}));
}

function cara(segundos = 60): CaraConsultable {
	return {fps: 30, cuadros: Array.from({length: segundos * 30}, (_, j) => ({t: j / 30, cara: {x: 400, y: 600, w: 300, h: 250}, barbilla_y: 900, coronilla_y: 500, cabeza: {x: 380, y: 500, w: 340, h: 400}}))};
}

const archivo = (extra: Partial<ArchivoSfx> = {}): ArchivoSfx =>
	({id: 'propios-typing-on-the-keyboard', archivo: 'biblioteca/sfx/especial/propios-typing-on-the-keyboard.wav', categoria: 'especial', fuente: 'propios', duracion_s: 7.403, lufs: -26.6, semitonos: 0, aprobacion: 'no-requiere', ...extra}) as ArchivoSfx;

const tarjetaPrompt = (texto: string, desde = 1, hasta = 8, extra: Partial<Edicion['tarjetas'][number]> = {}): Edicion['tarjetas'][number] => ({
	id: 't1',
	desde,
	hasta,
	texto,
	caja: {x: 540, y: 1200},
	grupo: null,
	variante: 'prompt',
	entrada: 'escritura',
	tapaCabeza: false,
	sfx: null,
	...extra,
});

describe('duración de un SFX en la EDL', () => {
	it('duracion_frames es opcional y entero positivo', () => {
		const sfx = {asset: 'a.wav', ganancia_db: -10, offset_frames: 2, variante: 0};
		const conTarjeta = (s: object) => ({...edicionVacia, tarjetas: [tarjetaPrompt('Hola Claude, ayúdame', 0.5, 2.5, {sfx: s as never})]});
		expect(EdicionBase.safeParse(conTarjeta(sfx)).success).toBe(true);
		expect(EdicionBase.safeParse(conTarjeta({...sfx, duracion_frames: 40})).success).toBe(true);
		expect(EdicionBase.safeParse(conTarjeta({...sfx, duracion_frames: 0})).success).toBe(false);
		expect(EdicionBase.safeParse(conTarjeta({...sfx, duracion_frames: 2.5})).success).toBe(false);
	});

	it('volumen: fijo sin duración; con ella, fundido de 3 cuadros y silencio al final', () => {
		const g = dbAGanancia(-12);
		expect(volumenSfx(500, {ganancia_db: -12})).toBeCloseTo(g, 9);
		const s = {ganancia_db: -12, duracion_frames: 30};
		expect(FUNDIDO_SFX_CUADROS).toBe(3);
		expect(volumenSfx(0, s)).toBeCloseTo(g, 9);
		expect(volumenSfx(26, s)).toBeCloseTo(g, 9);
		expect(volumenSfx(27, s)).toBeCloseTo(g * 0.75, 9);
		expect(volumenSfx(29, s)).toBeCloseTo(g * 0.25, 9);
		expect(volumenSfx(30, s)).toBe(0);
		// Un SFX de 2 cuadros también baja (sin dividir entre cero).
		expect(volumenSfx(1, {ganancia_db: 0, duracion_frames: 2})).toBeGreaterThan(0);
		expect(volumenSfx(1, {ganancia_db: 0, duracion_frames: 2})).toBeLessThan(1);
	});
});

describe('tecleo de los prompts', () => {
	it('elige tu Foley de tecleo (el original), solo de las fuentes permitidas', () => {
		const cat = {archivos: [archivo({id: 'propios-typing-on-the-keyboard-agudo', semitonos: 1}), archivo(), archivo({id: 'pixabay-typing', categoria: 'tecla', fuente: 'pixabay'}), archivo({id: 'propios-error'})]};
		expect(archivoTecleo(cat, ['propios'])?.id).toBe('propios-typing-on-the-keyboard');
		expect(archivoTecleo(cat, ['pixabay'])).toBeNull();
		expect(archivoTecleo({archivos: [archivo({aprobacion: 'pendiente'})]}, null)).toBeNull();
	});

	it('arranca con la primera letra y dura lo que tarda en escribirse', () => {
		const texto = 'Analiza mi página web y dime cómo mejorar el diseño';
		const t = tarjetaPrompt(texto, 1, 8);
		const c = cuadrosDeTecleo(t, [t], ESTILO_T)!;
		const completo = cuadroTextoCompleto(texto.length, ESCRITURA_PROMPT_MEDIDA);
		expect(c.offset).toBe(ESCRITURA_PROMPT_MEDIDA.cuadros_vacia);
		expect(c.duracion).toBe(completo - c.offset + 1);
		// ~31 car/s: 51 caracteres ≈ 1.6 s.
		expect(c.duracion / 30).toBeGreaterThan(1.4);
		expect(c.duracion / 30).toBeLessThan(1.8);
	});

	it('si la tarjeta dura poco, la escritura se acelera y el tecleo se acorta con ella', () => {
		const texto = 'Analiza mi página web y dime cómo mejorar el diseño';
		const larga = tarjetaPrompt(texto, 1, 8);
		const corta = tarjetaPrompt(texto, 1, 2);
		const dl = cuadrosDeTecleo(larga, [larga], ESTILO_T)!.duracion;
		const dc = cuadrosDeTecleo(corta, [corta], ESTILO_T)!.duracion;
		expect(dc).toBeLessThan(dl);
		expect(dc + ESCRITURA_PROMPT_MEDIDA.cuadros_vacia).toBeLessThanOrEqual(Math.floor(0.87 * 30) + 1);
	});

	it('cada prompt lleva su tecleo con duracion_frames; las demás tarjetas no', () => {
		const p = tarjetaPrompt('Hazme un plan de contenido para mi semana', 1, 6);
		const normal = {...tarjetaPrompt('Gratis', 7, 8), id: 't2', variante: 'normal' as const, entrada: 'corte' as const};
		const r = tecleoDeTarjetas([p, normal], {archivo: archivo(), estilo: ESTILO_T, vozLufs: -16, nivelRelDb: -14});
		expect([...r.tecleos.keys()]).toEqual(['t1']);
		const s = r.tecleos.get('t1')!;
		expect(s.asset).toBe('biblioteca/sfx/especial/propios-typing-on-the-keyboard.wav');
		expect(s.duracion_frames).toBe(cuadrosDeTecleo(p, [p, normal], ESTILO_T)!.duracion);
		// −14 dB bajo tu voz: −14 + (−16) − (−26.6) = −3.4 dB.
		expect(s.ganancia_db).toBeCloseTo(-3.4, 6);
		expect(esTecleo(s)).toBe(true);
		expect(r.avisos).toEqual([]);
	});

	it('sin archivo de tecleo, avisa y no inventa uno; un prompt que no se escribe no teclea', () => {
		const p = tarjetaPrompt('Hazme un plan de contenido', 1, 6);
		const sin = tecleoDeTarjetas([p], {archivo: null, estilo: ESTILO_T, vozLufs: -16, nivelRelDb: -14});
		expect(sin.tecleos.size).toBe(0);
		expect(sin.avisos[0]).toMatch(/tecleo/);
		const enCorte = tecleoDeTarjetas([{...p, entrada: 'corte'}], {archivo: archivo(), estilo: ESTILO_T, vozLufs: -16, nivelRelDb: -14});
		expect(enCorte.tecleos.size).toBe(0);
	});

	it('un tecleo más largo que el archivo se recorta al archivo, con aviso', () => {
		const p = tarjetaPrompt('x'.repeat(150), 0, 20);
		const r = tecleoDeTarjetas([p], {archivo: archivo({duracion_s: 2}), estilo: ESTILO_T, vozLufs: -16, nivelRelDb: -14});
		expect(r.tecleos.get('t1')!.duracion_frames).toBe(60);
		expect(r.avisos[0]).toMatch(/pártelo/);
	});

	it('elegir.ts no re-elige el SFX de una tarjeta con tecleo', () => {
		const p = tarjetaPrompt('Hazme un plan', 1, 4, {sfx: {asset: 'a.wav', ganancia_db: -5, offset_frames: 2, variante: 0, duracion_frames: 20}});
		const e = {...edicionVacia, duracion_s: 10, tarjetas: [p, {...p, id: 't2', variante: 'normal' as const, sfx: null}]};
		expect(eventosDeEdicion(e).map((x) => x.id)).toEqual(['t2']);
	});
});

describe('frases que dictan un prompt', () => {
	it('"vas a decirle a Claude, …" sugiere el tramo hasta el final de la pregunta (los "..." no cortan)', () => {
		const palabras = palabrasDe('lo instalas y vas a decirle a Claude, oye analiza mi página web y en base a lo que te instalé... ¿Cómo podemos mejorar las animaciones? Podemos agregar estas.');
		const m = momentosPrompt(palabras);
		expect(m).toHaveLength(1);
		expect(m[0].texto).toBe('oye analiza mi página web y en base a lo que te instalé... ¿Cómo podemos mejorar las animaciones?');
		expect(m[0].desde_palabra).toBe('oye');
		expect(m[0].disparo).toMatch(/decirle a Claude/);
	});

	it('detecta "le dices", "le pides" y "le escribes a Claude"; "a Claude" sin verbo, no', () => {
		const palabras = palabrasDe('Primero le dices a Claude: hazme un resumen. Luego le pides a Claude que lo traduzca. Y le escribes a Claude gracias. Esto se lo enseño a Claude Code.');
		const m = momentosPrompt(palabras);
		expect(m.map((x) => x.texto)).toEqual(['hazme un resumen.', 'que lo traduzca.', 'gracias.']);
	});
});

describe('prompts largos en varias tarjetas', () => {
	const LARGO = 'Oye, en base a las reglas de Apple quiero que analices mi página web y me digas cómo mejorar el diseño. ¿Cómo podemos mejorar las animaciones?';

	it('uno corto va entero; uno largo se parte en 2 de ≤ 4 renglones de ≤ 33 caracteres, en un fin de frase', () => {
		expect(partirPrompt('Hazme un resumen de este PDF')).toEqual(['Hazme un resumen de este PDF']);
		const partes = partirPrompt(LARGO);
		expect(partes).toHaveLength(2);
		expect(partes.join(' ')).toBe(LARGO);
		for (const p of partes) {
			const r = renglonesPrompt(p);
			expect(r.length).toBeLessThanOrEqual(RENGLONES_PROMPT);
			for (const l of r) expect(l.length).toBeLessThanOrEqual(CARACTERES_RENGLON_PROMPT);
		}
		expect(partes[0]).toMatch(/diseño\.$/);
	});

	it.runIf(HAY_FUENTES)('el director pone las partes seguidas, cada una con tiempo para escribirse y leerse', () => {
		const palabras = palabrasDe('vas a decirle a Claude, oye haz esto y luego lo otro por favor y gracias '.repeat(4));
		const {notas} = leerNotas({sin_tarjetas: true, sin_stickers: true, titular: null, tarjetas_forzadas: [{texto: LARGO, variante: 'prompt', desde_palabra: 'oye'}]});
		const estilo = estiloDesde({});
		const ctx = crearContexto({cara: cara(), estilo, semilla: 'p'});
		const plan = planear({slug: 'p', semilla: 'p', palabras, duracion: palabras.at(-1)!.h, ctx, estilo, catalogos: {mascotas: [], logos: []}, terminos: [], notas, voz: null});
		const prompts = plan.tarjetas.filter((t) => t.variante === 'prompt').sort((a, b) => a.desde - b.desde);
		expect(prompts).toHaveLength(2);
		expect(prompts.every((t) => t.entrada === 'escritura')).toBe(true);
		expect(prompts[0].hasta).toBeCloseTo(prompts[1].desde, 3);
		expect(prompts[0].hasta - prompts[0].desde).toBeGreaterThanOrEqual(tiempoPrompt(prompts[0].texto, ctx.estiloTarjeta) - 1e-3);
		expect(prompts.map((t) => t.texto).join(' ')).toBe(LARGO);
	});
});
