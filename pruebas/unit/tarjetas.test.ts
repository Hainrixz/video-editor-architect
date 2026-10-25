// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Tarjetas de la Fase 3: escritura letra por letra (src/estilo/animaciones.ts), variante "prompt" y listas en árbol con
 * `fila` (src/estilo/capas.ts). Todo puro: corre dentro del sandbox, sin Chrome. El render se revisa en
 * pruebas/integracion/f3-tarjetas.ts.
 */
import {describe, expect, it} from 'vitest';
import {
	ESCRITURA_MEDIDA,
	ESCRITURA_PROMPT_MEDIDA,
	ESCRITURA_TERMINA_MAX,
	ajustarEscritura,
	caracteresVisibles,
	cuadroTextoCompleto,
	cursorEncendido,
	type ParamsEscritura,
} from '../../src/estilo/animaciones.ts';
import {
	ESTILO_TARJETA_POR_DEFECTO,
	MEDICIONES_CAPAS,
	agruparTarjetas,
	altoCajaPrompt,
	anchoMaxDeTarjeta,
	centroPorDefecto,
	disponerGrupo,
	entradaDeTarjeta,
	escalaDeTarjeta,
	escrituraDeTarjeta,
	escrituraDeVariante,
	familiaTarjeta,
	filasDeGrupo,
	geometriaPrompt,
	grafemas,
	partirEscritura,
	radioPrompt,
	resolverEstiloTarjeta,
	textoTarjeta,
	xDeFila,
	type CajaDispuesta,
} from '../../src/estilo/capas.ts';
import type {Edicion} from '../../src/esquema/edicion.ts';

type TarjetaEdl = Edicion['tarjetas'][number];

const rango = (n: number, desde = 0) => Array.from({length: n}, (_, i) => desde + i);
const E = ESTILO_TARJETA_POR_DEFECTO;

const tarjeta = (id: string, texto: string, extra: Partial<TarjetaEdl> = {}): TarjetaEdl => ({
	id,
	desde: 1,
	hasta: 3,
	texto,
	caja: {x: 540, y: 1202},
	grupo: 'l1',
	variante: 'normal',
	entrada: 'corte',
	tapaCabeza: false,
	sfx: null,
	...extra,
});

// ───────────────────────── escritura: caracteres visibles por cuadro ─────────────────────────

describe('escritura letra por letra: cuadro n → caracteres visibles', () => {
	it('la caja sale vacía 1 cuadro y luego las letras salen parejo a 40 car/s (lo medido en tus tarjetas cortas)', () => {
		const p = ESCRITURA_MEDIDA;
		expect(p).toEqual({car_s: 40, cuadros_vacia: 1});
		const v = (f: number) => caracteresVisibles(f, 13, p);
		expect(v(-3)).toBe(0);
		expect(v(0)).toBe(0);
		expect(v(1)).toBe(1);
		// 1 + ⌊(f − 1) · 40 / 30⌋: 1, 2, 3, 5, 6, 7, 9…
		expect(rango(8, 1).map(v)).toEqual([1, 2, 3, 5, 6, 7, 9, 10]);
		expect(v(10)).toBe(13);
		expect(v(500)).toBe(13);
	});

	it('a 30 car/s sale exactamente 1 carácter por cuadro (como "Solo usas 2" en Dkrllv0b2Lc)', () => {
		const p: ParamsEscritura = {car_s: 30, cuadros_vacia: 2};
		expect(rango(16).map((f) => caracteresVisibles(f, 13, p))).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13]);
		expect(cuadroTextoCompleto(13, p)).toBe(14);
	});

	it('determinista, nunca baja, nunca pasa del total y llega justo en cuadroTextoCompleto (barrido de velocidades)', () => {
		const velocidades = [7.5, 23.8, 29.97, 30, 30.7, 37.9, 40, 45, 66.4, 120, 400];
		for (const car_s of velocidades) {
			for (const vacia of [0, 1, 2, 5]) {
				for (const total of [1, 2, 3, 13, 22, 116]) {
					const p = {car_s, cuadros_vacia: vacia};
					const serie = rango(600).map((f) => caracteresVisibles(f, total, p));
					expect(serie).toEqual(rango(600).map((f) => caracteresVisibles(f, total, p)));
					for (let f = 1; f < serie.length; f++) expect(serie[f]).toBeGreaterThanOrEqual(serie[f - 1]);
					expect(Math.max(...serie)).toBe(total);
					const primero = serie.findIndex((n) => n === total);
					expect(cuadroTextoCompleto(total, p), `car_s ${car_s}, vacía ${vacia}, total ${total}`).toBe(primero);
					// Antes de la vacía no hay letras; en la vacía, la primera.
					for (let f = 0; f < vacia; f++) expect(serie[f]).toBe(0);
					expect(serie[vacia]).toBe(1);
					// Nunca salen más de ⌈car_s / 30⌉ letras de un cuadro al siguiente.
					for (let f = 1; f < serie.length; f++) expect(serie[f] - serie[f - 1]).toBeLessThanOrEqual(Math.ceil(car_s / 30));
				}
			}
		}
	});

	it('el prompt usa su velocidad medida (30.7 car/s, 2 cuadros vacía): 116 caracteres en ~3.8 s', () => {
		expect(ESCRITURA_PROMPT_MEDIDA).toEqual({car_s: 30.7, cuadros_vacia: 2});
		const fin = cuadroTextoCompleto(116, ESCRITURA_PROMPT_MEDIDA);
		expect(fin).toBe(2 + Math.ceil((115 * 30) / 30.7));
		expect(fin / 30).toBeGreaterThan(3.7);
		expect(fin / 30).toBeLessThan(3.9);
	});

	it('si la tarjeta dura poco, se acelera lo justo para quedar completa al 87 % de su tiempo en pantalla', () => {
		const p = ESCRITURA_MEDIDA;
		// 60 caracteres a 40 car/s tardan 1 + 45 = 46 cuadros: en 120 cuadros alcanza (46 ≤ 104) y no cambia.
		expect(ajustarEscritura(60, 120, p)).toEqual(p);
		// En 30 cuadros no: termina en ⌊0.87 · 30⌋ = 26.
		const rapido = ajustarEscritura(60, 30, p);
		expect(rapido.car_s).toBeGreaterThan(p.car_s);
		expect(rapido.cuadros_vacia).toBe(1);
		expect(cuadroTextoCompleto(60, rapido)).toBe(Math.floor(ESCRITURA_TERMINA_MAX * 30));
		// Nunca más lenta que la medida, y siempre completa antes de irse.
		for (const dur of [2, 3, 5, 8, 13, 21, 34, 55, 89, 144]) {
			for (const total of [1, 5, 20, 80, 124]) {
				const q = ajustarEscritura(total, dur, p);
				expect(q.car_s).toBeGreaterThanOrEqual(p.car_s);
				expect(cuadroTextoCompleto(total, q)).toBeLessThanOrEqual(Math.max(0, Math.floor(0.87 * dur)));
				expect(caracteresVisibles(dur - 1, total, q)).toBe(total);
			}
		}
		// Una tarjeta de 1 cuadro: todo de golpe.
		const golpe = ajustarEscritura(30, 1, p);
		expect(caracteresVisibles(0, 30, golpe)).toBe(30);
	});

	it('cursor opcional: fijo mientras escribe y luego parpadea (15 cuadros encendido, 15 apagado)', () => {
		const p = ESCRITURA_MEDIDA;
		const fin = cuadroTextoCompleto(10, p);
		expect(cursorEncendido(-1, 10, p)).toBe(false);
		for (let f = 0; f < fin; f++) expect(cursorEncendido(f, 10, p)).toBe(true);
		expect(rango(15, fin).every((f) => cursorEncendido(f, 10, p))).toBe(true);
		expect(rango(15, fin + 15).every((f) => !cursorEncendido(f, 10, p))).toBe(true);
		expect(cursorEncendido(fin + 30, 10, p)).toBe(true);
		expect(cursorEncendido(fin + 15, 10, p, 0)).toBe(true);
		expect(E.escritura.cursor).toBe(false);
	});
});

// ───────────────────────── texto: grafemas y partes ─────────────────────────

describe('texto de la tarjeta: grafemas y lo que falta por escribir', () => {
	it('un emoji (con tono de piel o familia ZWJ) o una letra con tilde cuentan como UN carácter', () => {
		expect(grafemas('Solo usas 2 🫠')).toHaveLength(13);
		expect(grafemas('👍🏽')).toHaveLength(1);
		expect(grafemas('👨‍👩‍👧')).toHaveLength(1);
		expect(grafemas('campaña')).toHaveLength(7);
		expect(grafemas('ñ')).toHaveLength(1);
		expect(grafemas('Hola\nmundo')).toHaveLength(10);
	});

	it('partirEscritura: lo visible + lo oculto = el texto, en cualquier cuadro (nunca parte un emoji)', () => {
		const texto = textoTarjeta('  ¿Qué estas  \n construyendo ahorita? 🫠 ');
		expect(texto).toBe('¿Qué estas\nconstruyendo ahorita? 🫠');
		const total = grafemas(texto).length;
		for (let n = -2; n <= total + 3; n++) {
			const {visible, oculto} = partirEscritura(texto, n);
			expect(visible + oculto).toBe(texto);
			expect(grafemas(visible)).toHaveLength(Math.max(0, Math.min(total, n)));
		}
		expect(partirEscritura(texto, total - 1).oculto).toBe('🫠');
		expect(partirEscritura(texto, Number.POSITIVE_INFINITY)).toEqual({visible: texto, oculto: ''});
	});

	it('escrituraDeTarjeta: cuenta los grafemas del texto dibujado y usa la velocidad de su variante', () => {
		const corta = escrituraDeTarjeta({texto: ' Solo usas 2 🫠 ', variante: 'normal'}, E, 300);
		expect(corta.total).toBe(13);
		expect(corta.params).toEqual({car_s: 40, cuadros_vacia: 1});
		const prompt = escrituraDeTarjeta({texto: 'En base a todo lo que sabes\nde mi tienda', variante: 'prompt'}, E, 300);
		expect(prompt.total).toBe(40);
		expect(prompt.params).toEqual({car_s: 30.7, cuadros_vacia: 2});
		expect(escrituraDeVariante('grande', E)).toEqual(ESCRITURA_MEDIDA);
	});

	it('los emoji se dibujan con la fuente de emoji del sistema, detrás de la fuente de la tarjeta', () => {
		const familia = familiaTarjeta('tiktok-sans');
		expect(familia.startsWith('"Editor TikTok Sans"')).toBe(true);
		expect(familia).toContain('"Apple Color Emoji"');
	});
});

// ───────────────────────── entrada ─────────────────────────

describe('entrada de cada tarjeta', () => {
	it('"escritura" y "pop" de la tarjeta mandan; con "corte" (el valor por defecto) manda el estilo, como antes', () => {
		const pop = resolverEstiloTarjeta({entrada: 'pop'});
		expect(entradaDeTarjeta({entrada: 'escritura'}, pop)).toBe('escritura');
		expect(entradaDeTarjeta({entrada: 'pop'}, E)).toBe('pop');
		expect(entradaDeTarjeta({entrada: 'corte'}, pop)).toBe('pop');
		expect(entradaDeTarjeta({}, E)).toBe('corte');
		expect(entradaDeTarjeta({entrada: 'explosion'}, E)).toBe('corte');
		expect(resolverEstiloTarjeta({entrada: 'escritura'}).entrada).toBe('escritura');
	});
});

// ───────────────────────── listas en árbol: filas ─────────────────────────

/** Medida falsa: 20 px por carácter + 40 de relleno; alto fijo (o el que diga `altos`). */
const medidaFalsa =
	(altos: Record<string, number> = {}) =>
	(t: TarjetaEdl) => ({ancho: t.texto.length * 20 + 40, alto: altos[t.id] ?? 79});

const seEnciman = (a: CajaDispuesta, b: CajaDispuesta) =>
	Math.abs(a.x - b.x) < (a.ancho + b.ancho) / 2 - 1e-9 && Math.abs(a.y - b.y) < (a.alto + b.alto) / 2 - 1e-9;

describe('listas en árbol (fila)', () => {
	it('filasDeGrupo: sin fila, una por renglón en orden de aparición (lo de antes); con fila 0/1/1, 1 arriba y 2 abajo', () => {
		const a = tarjeta('a', 'Marketing');
		const b = tarjeta('b', 'Campañas');
		const c = tarjeta('c', 'Estadísticas');
		expect(filasDeGrupo([a, b, c]).map((f) => f.map((t) => t.id))).toEqual([['a'], ['b'], ['c']]);
		expect(filasDeGrupo([{...a, fila: 0}, {...b, fila: 1}, {...c, fila: 1}]).map((f) => f.map((t) => t.id))).toEqual([['a'], ['b', 'c']]);
		// Como DhdcjsxJbi8: 2 arriba y 1 abajo.
		expect(filasDeGrupo([{...a, fila: 0}, {...b, fila: 0}, {...c, fila: 1}]).map((f) => f.map((t) => t.id))).toEqual([['a', 'b'], ['c']]);
		// La fila manda sobre el orden de aparición, y los números que se saltan no dejan huecos.
		expect(filasDeGrupo([{...a, fila: 4}, {...b, fila: 0}, {...c, fila: 4}]).map((f) => f.map((t) => t.id))).toEqual([['b'], ['a', 'c']]);
		// Mezcla: la que no trae fila cuenta como si su fila fuera su lugar de aparición (0, 1, 2…).
		expect(filasDeGrupo([a, {...b, fila: 1}, {...c, fila: 1}]).map((f) => f.map((t) => t.id))).toEqual([['a'], ['b', 'c']]);
	});

	it('las de la misma fila van lado a lado, centradas como fila, con 31.9 px entre ellas y sin encimarse', () => {
		const lista = [tarjeta('t9', 'Marketing', {fila: 0}), tarjeta('t10', 'Campañas', {fila: 1}), tarjeta('t11', 'Estadísticas', {fila: 1})];
		const cajas = disponerGrupo(lista, E, medidaFalsa());
		const [t9, t10, t11] = cajas;
		expect(E.separacion_h_px).toBe(31.9);
		expect(t9).toMatchObject({fila: 0, x: 540, y: 1202});
		expect(t10.fila).toBe(1);
		expect(t11.fila).toBe(1);
		// La fila de abajo, centrada en 540 como fila (no cada tarjeta).
		expect((t10.x - t10.ancho / 2 + t11.x + t11.ancho / 2) / 2).toBeCloseTo(540, 9);
		expect(t11.x - t11.ancho / 2 - (t10.x + t10.ancho / 2)).toBeCloseTo(31.9, 9);
		expect(t10.y).toBe(t11.y);
		// Entre renglones, el hueco vertical medido (30).
		expect(t10.y - t10.alto / 2 - (t9.y + t9.alto / 2)).toBeCloseTo(E.separacion_px, 9);
		for (const p of cajas) for (const q of cajas) if (p !== q) expect(seEnciman(p, q), `${p.id} y ${q.id}`).toBe(false);
	});

	it('una fila de 3 con altos distintos: centradas en vertical, la fila sigue centrada y sigue sin encimarse', () => {
		const lista = [
			tarjeta('a', 'Lista clientes', {fila: 0}),
			tarjeta('b', 'Correo', {fila: 1}),
			tarjeta('c', 'Tu agenda', {fila: 1}),
			tarjeta('d', 'Seguimiento', {fila: 1}),
			tarjeta('e', 'Mensajes', {fila: 2}),
		];
		const cajas = disponerGrupo(lista, E, medidaFalsa({c: 140}));
		const fila1 = cajas.filter((c) => c.fila === 1);
		expect(fila1.map((c) => c.id)).toEqual(['b', 'c', 'd']);
		expect(new Set(fila1.map((c) => c.y)).size).toBe(1);
		const izquierda = fila1[0].x - fila1[0].ancho / 2;
		const derecha = fila1[2].x + fila1[2].ancho / 2;
		expect((izquierda + derecha) / 2).toBeCloseTo(540, 9);
		// El renglón de 140 de alto empuja al siguiente: hueco de 30 desde su orilla más baja.
		const e = cajas.find((c) => c.id === 'e')!;
		expect(e.y - e.alto / 2 - (fila1[0].y + 70)).toBeCloseTo(30, 9);
		for (const p of cajas) for (const q of cajas) if (p !== q) expect(seEnciman(p, q), `${p.id} y ${q.id}`).toBe(false);
	});

	it('sin fila queda igual que la lista apilada de antes (la 1.ª en su caja, las demás abajo, cada una en su caja.x)', () => {
		const lista = [
			tarjeta('a', 'Premier', {caja: {x: 540, y: 1164}}),
			tarjeta('b', 'After effects', {caja: {x: 500, y: 9999}}),
			tarjeta('c', 'Pagar a alguien', {caja: {x: 560, y: 1}}),
		];
		const medir = medidaFalsa({b: 120});
		const nuevas = disponerGrupo(lista, E, medir);
		// La regla de antes (Tarjeta.tsx y layout.cajasVisiblesTarjetas): centro de la 1.ª en su caja y luego hacia abajo.
		const viejas: {x: number; y: number}[] = [];
		let tope = 1164 + medir(lista[0]).alto / 2 + E.separacion_px;
		viejas.push({x: 540, y: 1164});
		for (const t of lista.slice(1)) {
			const m = medir(t);
			viejas.push({x: t.caja.x, y: tope + m.alto / 2});
			tope += m.alto + E.separacion_px;
		}
		nuevas.forEach((n, i) => {
			expect(n.x).toBeCloseTo(viejas[i].x, 9);
			expect(n.y).toBeCloseTo(viejas[i].y, 9);
		});
	});

	it('la fila se centra en el promedio de sus caja.x (si el director copió los centros medidos, queda casi en 540)', () => {
		expect(xDeFila([tarjeta('b', 'x', {caja: {x: 380.4, y: 1310}}), tarjeta('c', 'y', {caja: {x: 685.6, y: 1310}})], E)).toBeCloseTo(533, 9);
		expect(xDeFila([tarjeta('b', 'x'), tarjeta('c', 'y')], E)).toBe(540);
	});

	it('el grupo sigue apareciendo una por una y se va junto (agruparTarjetas no cambia con fila)', () => {
		const lista = [tarjeta('b', 'Campañas', {desde: 1.57, hasta: 2.2, fila: 1}), tarjeta('a', 'Marketing', {desde: 1.0, hasta: 2.2, fila: 0}), tarjeta('c', 'Estadísticas', {desde: 2.17, hasta: 2.23, fila: 1})];
		const [g] = agruparTarjetas(lista);
		expect(g.tarjetas.map((t) => t.id)).toEqual(['a', 'b', 'c']);
		expect(g.desde).toBe(30);
		expect(g.hasta).toBe(67);
	});
});

// ───────────────────────── variante prompt ─────────────────────────

/** Tus 5 prompts (out/f3-tarjetas/referencia/prompt.json): mayúscula, renglones, alto y radio en px base. */
const PROMPTS_MEDIDOS = [
	{reel: 'Dkrllv0b2Lc t10', mayuscula: 33.8, renglones: 3, alto: 200.3, radio: 40.5},
	{reel: 'DkygBZjoy3G t5', mayuscula: 34.5, renglones: 4, alto: 251.3, radio: 50.4},
	{reel: 'DkygBZjoy3G t12', mayuscula: 35.3, renglones: 4, alto: 251.3, radio: 49.9},
	{reel: 'Dkb8VtDxIG1 t14', mayuscula: 30.8, renglones: 3, alto: 175.5, radio: 34.9},
	{reel: 'Dkb8VtDxIG1 t15', mayuscula: 30.0, renglones: 4, alto: 219.8, radio: 45.2},
];

describe('variante "prompt"', () => {
	it('con la mayúscula de cada uno de tus prompts, la caja mide lo de tu reel (±2.5 %) y el radio es 0.201 × alto (±1.5 px)', () => {
		for (const m of PROMPTS_MEDIDOS) {
			const g = geometriaPrompt(E, m.mayuscula / E.prompt.alto_mayuscula_px);
			const alto = altoCajaPrompt(g, m.renglones);
			expect(Math.abs(alto - m.alto) / m.alto, m.reel).toBeLessThanOrEqual(0.025);
			expect(Math.abs(radioPrompt(g, m.alto) - m.radio), m.reel).toBeLessThanOrEqual(1.5);
		}
	});

	it('a escala 1: mayúscula 33.8, 50 px de línea base a línea base y rellenos que dan 29.4 arriba y 33.1 abajo', () => {
		const g = geometriaPrompt(E, 1);
		expect(g.alto_mayuscula_px).toBe(33.8);
		expect(g.tamano_px).toBeCloseTo(33.8 / 0.705, 6);
		// El relleno CSS + medio interlineado = lo que se ve.
		const medio = (g.interlineado_px - g.alto_mayuscula_px) / 2;
		expect(g.css_arriba_px + medio).toBeCloseTo(29.4, 9);
		expect(g.css_abajo_px + medio).toBeCloseTo(33.1, 9);
		expect(altoCajaPrompt(g, 4)).toBeCloseTo(29.4 + 33.8 + 3 * 50 + 33.1, 9);
		expect(altoCajaPrompt(g, 0)).toBeCloseTo(altoCajaPrompt(g, 1), 9);
		// El radio crece con la caja: 3 renglones < 4 renglones.
		expect(radioPrompt(g, altoCajaPrompt(g, 3))).toBeLessThan(radioPrompt(g, altoCajaPrompt(g, 4)));
		// Escala: todo crece menos el ancho máximo.
		const g2 = geometriaPrompt(E, 2);
		expect(g2.css_arriba_px).toBeCloseTo(2 * g.css_arriba_px, 9);
		expect(g2.ancho_max).toBe(g.ancho_max);
	});

	it('ancho máximo ~900 y centro por defecto el medido (y ≈ 1260); las demás tarjetas siguen con lo de antes', () => {
		expect(anchoMaxDeTarjeta({variante: 'prompt', caja: {}}, E)).toBe(900);
		expect(anchoMaxDeTarjeta({variante: 'prompt', caja: {w: 700}}, E)).toBe(700);
		expect(anchoMaxDeTarjeta({variante: 'normal', caja: {}}, E)).toBe(940);
		expect(centroPorDefecto({variante: 'prompt'}, E)).toEqual({x: 540, y: 1260});
		expect(centroPorDefecto({variante: 'normal'}, E)).toEqual({x: 540, y: 1274});
		// El prompt no se agranda como "grande": solo caja.escala (y la de lista si va en grupo).
		expect(escalaDeTarjeta({variante: 'prompt', grupo: null, caja: {x: 540, y: 1260}}, E)).toBe(1);
	});
});

// ───────────────────────── compatibilidad y mediciones ─────────────────────────

describe('compatibilidad con lo de hoy y mediciones con su n y su fuente', () => {
	it('los valores de antes no cambian (normal, grande, lista apilada, corte)', () => {
		expect(E).toMatchObject({
			fuente: 'tiktok-sans',
			peso: 800,
			alto_mayuscula_px: 51,
			pad_arriba_px: 30,
			pad_abajo_px: 36,
			pad_lados_px: 22,
			radio_px: 15,
			interlineado_px: 76,
			ancho_max: 940,
			x: 540,
			y: 1274,
			escala_grande: 1.33,
			escala_lista: 0.75,
			separacion_px: 30,
			entrada: 'corte',
		});
	});

	it('resolverEstiloTarjeta: toma los campos nuevos con su tipo, ignora lo demás y no comparte objetos con el de por defecto', () => {
		const r = resolverEstiloTarjeta({
			separacion_h_px: 20,
			escritura: {car_s: 50, cursor: true, termina_max: 7, cuadros_vacia: 'dos'},
			prompt: {ancho_max: 800, radio_relativo: 0.25, alto_mayuscula_px: -1},
		});
		expect(r.separacion_h_px).toBe(20);
		expect(r.escritura).toMatchObject({car_s: 50, cursor: true, termina_max: E.escritura.termina_max, cuadros_vacia: 1});
		expect(r.prompt).toMatchObject({ancho_max: 800, radio_relativo: 0.25, alto_mayuscula_px: 33.8});
		const basura = resolverEstiloTarjeta('basura');
		expect(basura).toEqual(E);
		basura.escritura.car_s = 1;
		basura.prompt.y = 1;
		expect(E.escritura.car_s).toBe(40);
		expect(E.prompt.y).toBe(1260);
	});

	it('cada valor nuevo sale de lo medido en tus reels (con n > 0 y su fuente) y coincide con el estilo por defecto', () => {
		const nuevas = Object.entries(MEDICIONES_CAPAS).filter(([k]) => /^tarjeta_(escritura|prompt|lista_(filas|separacion_h|retraso|escala_medida)|emoji)/.test(k));
		expect(nuevas.length).toBeGreaterThanOrEqual(15);
		for (const [k, m] of nuevas) {
			expect(m.n, k).toBeGreaterThan(0);
			expect(m.fuente.length, k).toBeGreaterThan(0);
		}
		expect(MEDICIONES_CAPAS.tarjeta_escritura_car_s.valor).toBe(E.escritura.car_s);
		expect(MEDICIONES_CAPAS.tarjeta_escritura_car_s_prompt.valor).toBe(E.escritura.car_s_prompt);
		expect(MEDICIONES_CAPAS.tarjeta_escritura_vacia.valor).toBe(E.escritura.cuadros_vacia);
		expect(MEDICIONES_CAPAS.tarjeta_escritura_termina.valor).toBe(E.escritura.termina_max);
		expect(MEDICIONES_CAPAS.tarjeta_lista_separacion_h.valor).toBe(E.separacion_h_px);
		expect(MEDICIONES_CAPAS.tarjeta_prompt_mayuscula.valor).toBe(E.prompt.alto_mayuscula_px);
		expect(MEDICIONES_CAPAS.tarjeta_prompt_radio.valor).toBe(E.prompt.radio_relativo);
		expect(Math.abs(Number(MEDICIONES_CAPAS.tarjeta_prompt_interlineado.valor) * E.prompt.alto_mayuscula_px - E.prompt.interlineado_px)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(Number(MEDICIONES_CAPAS.tarjeta_prompt_pad_arriba.valor) * E.prompt.alto_mayuscula_px - E.prompt.pad_arriba_px)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(Number(MEDICIONES_CAPAS.tarjeta_prompt_pad_abajo.valor) * E.prompt.alto_mayuscula_px - E.prompt.pad_abajo_px)).toBeLessThanOrEqual(0.1);
		expect(Math.abs(Number(MEDICIONES_CAPAS.tarjeta_prompt_y.valor) - E.prompt.y)).toBeLessThanOrEqual(1);
	});
});
