/**
 * Prompts al compás de tu voz (revisión de la v11 de un reel de prueba, 2026-10-04): el director escribe en la EDL un horario
 * de escritura por tarjeta prompt (cada palabra aparece cuando la dices), el corte entre dos partes cae cuando
 * empiezas la 2.ª y el tecleo suena de la primera letra a la última.
 */
import {describe, expect, it} from 'vitest';
import {EdicionBase, EdicionValidada, edicionVacia, type Edicion} from '../../src/esquema/edicion.ts';
import {cuadrosDeHorario, grafemas, visiblesPorHorario} from '../../src/estilo/capas.ts';
import {crearContexto} from '../../herramientas/layout.ts';
import type {CaraConsultable} from '../../herramientas/lib/cara.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {leerNotas, planear} from '../../herramientas/lib/director/plan.ts';
import {alinearPrompt, cuadrosDeTecleo, horarioDeParte, partirPrompt, rangosDePartes, tiempoDeCaracter} from '../../herramientas/lib/director/tecleo.ts';
import type {Palabra} from '../../herramientas/lib/director/texto.ts';
import {HAY_FUENTES} from './requisitos.ts';

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Palabras dichas a `paso` s cada una (cada una dura paso − 0.05). */
function voz(texto: string, paso = 0.3, t0 = 0): Palabra[] {
	return texto
		.split(/\s+/)
		.filter(Boolean)
		.map((t, i) => ({i, t, d: r3(t0 + i * paso), h: r3(t0 + i * paso + paso - 0.05)}));
}

function cara(segundos = 60): CaraConsultable {
	return {fps: 30, cuadros: Array.from({length: segundos * 30}, (_, j) => ({t: j / 30, cara: {x: 400, y: 600, w: 300, h: 250}, barbilla_y: 900, coronilla_y: 500, cabeza: {x: 380, y: 500, w: 340, h: 400}}))};
}

const PROMPT = 'En base a las reglas de Apple, quiero que analices mi página web y me digas cómo podemos mejorar el diseño. Y en base a las reglas de animación que te acabo de instalar, ¿cómo podemos mejorar las animaciones?';

describe('horario de escritura', () => {
	const h = [
		{car: 0, t: 1},
		{car: 4, t: 1.4},
		{car: 5, t: 2},
		{car: 9, t: 2.4},
	];
	it('antes del primer punto no se ve nada; entre puntos sale parejo; después, todo', () => {
		expect(visiblesPorHorario(0.9, h, 9)).toBe(0);
		expect(visiblesPorHorario(1, h, 9)).toBe(0);
		expect(visiblesPorHorario(1.05, h, 9)).toBe(1);
		expect(visiblesPorHorario(1.4, h, 9)).toBe(4);
		// En la pausa entre palabras va el espacio y se espera a la siguiente.
		expect(visiblesPorHorario(1.7, h, 9)).toBe(5);
		expect(visiblesPorHorario(2.2, h, 9)).toBe(7);
		expect(visiblesPorHorario(5, h, 9)).toBe(9);
		// Dos puntos en el mismo segundo (palabra de 0 s): sale de golpe, sin dividir entre cero.
		expect(visiblesPorHorario(1, [{car: 0, t: 1}, {car: 3, t: 1}, {car: 5, t: 2}], 5)).toBe(3);
	});
	it('cuadros de la primera letra y del texto completo', () => {
		expect(cuadrosDeHorario(h, 9, 28, 90)).toEqual({primera: 31, completo: 70});
		expect(cuadrosDeHorario(h, 9, 28, 40)).toEqual({primera: 31, completo: 39});
	});
	it('el contrato lo acepta en orden y dentro de la tarjeta', () => {
		const t = {id: 't1', desde: 1, hasta: 3, texto: 'Hola mundo', caja: {x: 540, y: 1300}, grupo: null, variante: 'prompt' as const, entrada: 'escritura' as const, tapaCabeza: false, sfx: null};
		const con = (escritura: unknown, extra: object = {}) => ({...edicionVacia, duracion_s: 10, tarjetas: [{...t, escritura, ...extra}]});
		expect(EdicionValidada.safeParse(con([{car: 0, t: 1.1}, {car: 10, t: 2}])).success).toBe(true);
		expect(EdicionBase.safeParse(con([{car: 5, t: 1.1}, {car: 2, t: 2}])).success).toBe(false);
		expect(EdicionBase.safeParse(con([{car: 0, t: 1.1}])).success).toBe(false);
		expect(EdicionValidada.safeParse(con([{car: 0, t: 0.5}, {car: 10, t: 2}])).success).toBe(false);
		expect(EdicionValidada.safeParse(con([{car: 0, t: 1.1}, {car: 10, t: 2}], {entrada: 'corte'})).success).toBe(false);
	});
});

describe('alinear el prompt con tu voz', () => {
	it('cada palabra dicha marca su inicio y su final; las que no dijiste se reparten entre vecinas', () => {
		const dicho = voz('vas a decirle a Claude, oye en base a las reglas de Apple quiero que analices mi página');
		const i0 = dicho.findIndex((p) => p.t === 'oye');
		const al = alinearPrompt('En base a las reglas de Apple, quiero que revises mi página', dicho, i0)!;
		expect(al).not.toBeNull();
		expect(al.emparejadas).toBe(11);
		const en = dicho.find((p) => p.t === 'en')!;
		expect(al.puntos[0]).toEqual({car: 0, t: en.d});
		// "revises" no lo dijiste: se escribe entre "que" y "mi".
		const rev = al.palabras.find((p) => p.w === 'revises')!;
		expect(rev.d).toBeNull();
		const tq = dicho.find((p) => p.t === 'que')!.h;
		const tm = dicho.find((p) => p.t === 'mi')!.d;
		const t = tiempoDeCaracter(al.puntos, rev.a + 3);
		expect(t).toBeGreaterThan(tq);
		expect(t).toBeLessThan(tm);
	});
	it('si casi nada coincide, no alinea (va a la velocidad medida)', () => {
		const dicho = voz('oye haz esto y luego lo otro por favor y gracias');
		expect(alinearPrompt('Analiza mi página web y dime cómo mejorar el diseño', dicho, 0)).toBeNull();
	});
	it('horario de una parte: de su primera letra a la última, dentro de su tarjeta', () => {
		const dicho = voz(`oye ${PROMPT}`, 0.25, 10);
		const al = alinearPrompt(PROMPT, dicho, 0)!;
		const partes = partirPrompt(PROMPT);
		const rangos = rangosDePartes(partes);
		expect(rangos.map((r) => r.B - r.A)).toEqual(partes.map((p) => grafemas(p).length));
		const h = horarioDeParte(al, rangos[1].A, rangos[1].B, 20, 30);
		expect(h[0].car).toBe(0);
		expect(h.at(-1)!.car).toBe(rangos[1].B - rangos[1].A);
		expect(h.every((p, i) => p.t >= 20 && p.t <= 30 && (i === 0 || (p.t >= h[i - 1].t && p.car >= h[i - 1].car)))).toBe(true);
	});
});

describe('el director escribe el prompt al compás de tu voz', () => {
	const dicho = voz(`te lo instalas y vas a decirle a Claude, oye ${PROMPT} Podemos agregar estas cosas y listo.`, 0.25, 5);
	const plan = (hasta?: number) => {
		const {notas} = leerNotas({sin_tarjetas: true, sin_stickers: true, titular: null, tarjetas_forzadas: [{texto: PROMPT, variante: 'prompt', desde_palabra: 'oye', ...(hasta ? {hasta} : {})}]});
		const estilo = estiloDesde({});
		const ctx = crearContexto({cara: cara(), estilo, semilla: 'p'});
		return {ctx, plan: planear({slug: 'p', semilla: 'p', palabras: dicho, duracion: dicho.at(-1)!.h, ctx, estilo, catalogos: {mascotas: [], logos: []}, terminos: [], notas, voz: null})};
	};

	it.runIf(HAY_FUENTES)('la 2.ª parte arranca cuando empiezas a decir su primera palabra; la 1.ª, 2 cuadros antes de su primera letra', () => {
		const {plan: p} = plan();
		const prompts = p.tarjetas.filter((t) => t.variante === 'prompt').sort((a, b) => a.desde - b.desde);
		expect(prompts).toHaveLength(2);
		const [t1, t2] = prompts;
		const primera2 = t2.texto.split(/\s+/)[0];
		// "Y" es la primera palabra de la 2.ª parte: la 1.ª vez que dices "Y" con mayúscula después de "diseño.".
		const kDiseno = dicho.findIndex((w) => w.t === 'diseño.');
		expect(dicho[kDiseno + 1].t).toBe(primera2);
		expect(t2.desde).toBeCloseTo(dicho[kDiseno + 1].d, 3);
		expect(t1.hasta).toBeCloseTo(t2.desde, 3);
		const kEn = dicho.findIndex((w) => w.t === 'En');
		expect(t1.desde).toBeCloseTo(dicho[kEn].d - 2 / 30, 3);
		for (const t of prompts) {
			expect(t.escritura).toBeDefined();
			expect(t.escritura!.at(-1)!.car).toBe(grafemas(t.texto).length);
			expect(t.escritura!.every((x) => x.t >= t.desde - 1e-6 && x.t <= t.hasta + 1e-6)).toBe(true);
		}
		// La última letra de la 1.ª cae cuando terminas "diseño.".
		expect(t1.escritura!.at(-1)!.t).toBeCloseTo(dicho[kDiseno].h, 3);
		// Y la EDL con el horario pasa el contrato.
		const e: Edicion = {...edicionVacia, duracion_s: 60, tarjetas: prompts};
		expect(EdicionValidada.safeParse(e).success).toBe(true);
	});

	it.runIf(HAY_FUENTES)('el tecleo va de la primera letra a la última', () => {
		const {plan: p, ctx} = plan();
		const prompts = p.tarjetas.filter((t) => t.variante === 'prompt');
		for (const t of prompts) {
			const c = cuadrosDeTecleo(t, prompts, ctx.estiloTarjeta)!;
			const desde = Math.round(t.desde * 30);
			const h = cuadrosDeHorario(t.escritura!, grafemas(t.texto).length, desde, Math.round(t.hasta * 30))!;
			expect(desde + c.offset).toBe(h.primera);
			expect(desde + c.offset + c.duracion - 1).toBe(h.completo);
			expect(c.offset).toBeLessThanOrEqual(6);
		}
	});

	it.runIf(HAY_FUENTES)('sin "hasta", la última parte se queda 1.2 s para leerla; con un "hasta" corto, avisa', () => {
		const sin = plan().plan.tarjetas.filter((t) => t.variante === 'prompt').sort((a, b) => a.desde - b.desde);
		const ultima = sin.at(-1)!;
		expect(ultima.hasta - ultima.escritura!.at(-1)!.t).toBeCloseTo(1.2, 2);
		const kFin = dicho.findIndex((w) => w.t === 'animaciones?');
		const corto = plan(r3(dicho[kFin].h + 0.05)).plan;
		expect(corto.avisos.some((a) => /alarga su "hasta"/.test(a))).toBe(true);
	});
});
