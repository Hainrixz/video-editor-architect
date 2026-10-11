/**
 * Curvas de animación (src/estilo/animaciones.ts) y estilos de las capas (src/estilo/capas.ts).
 * Son funciones puras: corren dentro del sandbox, sin Chrome ni GPU.
 */
import {describe, expect, it} from 'vitest';
import {
	IDENTIDAD,
	POP_MEDIDO,
	REBOTE,
	deslizar,
	escalaKenBurns,
	escalaPop,
	escalaRebote,
	escalaRespira,
	estadoZoomEn,
	intensidadDesenfoque,
	opacidadPop,
	planZoom,
	rampaResorte,
	salidaEncoger,
	type EstadoZoom,
	type ZoomCuadros,
} from '../../src/estilo/animaciones.ts';
import {
	ESTILO_STICKER_POR_DEFECTO,
	ESTILO_TARJETA_POR_DEFECTO,
	ESTILO_TITULAR_POR_DEFECTO,
	MEDICIONES_CAPAS,
	agruparTarjetas,
	altoCajaTarjeta,
	cuadrosDe,
	escalaDeTarjeta,
	geometriaTarjeta,
	partirEnDos,
	renglones,
	resolverEstiloInsert,
	resolverEstiloSticker,
	resolverEstiloTarjeta,
	resolverEstiloTitular,
	tamanoDeLetra,
} from '../../src/estilo/capas.ts';
import {animacionSticker, cuadrosDeEntrada} from '../../src/reel/Sticker.tsx';
import type {Edicion} from '../../src/esquema/edicion.ts';

const rango = (n: number, desde = 0) => Array.from({length: n}, (_, i) => desde + i);

// ───────────────────────── pop medido ─────────────────────────

describe('pop de stickers (el de tus reels)', () => {
	// Dit46BGVpA0 a 1440p: ancho del tile en cada cuadro ÷ ancho final (out/f3-componentes/_medir/medir-pop.mjs).
	const MEDIDO = [0.586, 0.669, 0.755, 0.839, 0.916, 1.0];

	it('sigue la curva medida (±0.01) y llega a 1.00 en el cuadro 5, sin sobrepaso', () => {
		MEDIDO.forEach((m, f) => expect(Math.abs(escalaPop(f) - m), `cuadro ${f}`).toBeLessThanOrEqual(0.01));
		for (const f of rango(60)) expect(escalaPop(f)).toBeLessThanOrEqual(1);
		for (const f of rango(60, 5)) expect(escalaPop(f)).toBe(1);
		for (const f of rango(10)) expect(escalaPop(f + 1)).toBeGreaterThanOrEqual(escalaPop(f));
	});

	it('el primer cuadro visible va al 83 % de opacidad (medido, n=6) y desde el segundo, opaco; antes de entrar, invisible', () => {
		expect(opacidadPop(-1)).toBe(0);
		expect(opacidadPop(0)).toBe(POP_MEDIDO.opacidadInicial);
		expect(opacidadPop(0)).toBe(0.83);
		expect(MEDICIONES_CAPAS.sticker_pop_opacidad.valor).toBe(0.83);
		for (const f of rango(30, 1)) expect(opacidadPop(f)).toBe(1);
	});

	it('el sticker con entrada "pop" usa esa curva y su primer cuadro visible es el de `desde`', () => {
		const e = ESTILO_STICKER_POR_DEFECTO;
		const a0 = animacionSticker(0, 60, 'pop', 'corte', null, e);
		expect(a0.opacidad).toBeGreaterThan(0);
		expect(a0.escala).toBeCloseTo(0.5833, 3);
		expect(animacionSticker(5, 60, 'pop', 'corte', null, e).escala).toBe(1);
		expect(animacionSticker(59, 60, 'pop', 'corte', null, e)).toEqual({escala: 1, opacidad: 1});
		expect(animacionSticker(0, 60, 'corte', 'corte', null, e)).toEqual({escala: 1, opacidad: 1});
	});
});

// ───────────────────────── rebote (resorte) ─────────────────────────

describe('rebote: resorte subamortiguado (opcional)', () => {
	it('arranca en 0.5, pasa por el sobrepaso (~1.06) y se asienta en 1.00 ±0.005 desde el cuadro 8', () => {
		const xs = rango(61).map((f) => escalaRebote(f));
		expect(xs[0]).toBe(REBOTE.escalaInicial);
		const max = Math.max(...xs);
		const enCuadro = xs.indexOf(max);
		expect(max).toBeGreaterThanOrEqual(1.04);
		expect(max).toBeLessThanOrEqual(1.08);
		expect(enCuadro).toBeGreaterThanOrEqual(2);
		expect(enCuadro).toBeLessThanOrEqual(5);
		for (let f = 8; f <= 60; f++) expect(Math.abs(xs[f] - 1), `cuadro ${f}`).toBeLessThanOrEqual(0.005);
		// Sí pasa del 1 antes de asentarse (si no, no sería rebote).
		expect(xs.slice(1, 8).some((x) => x > 1.03)).toBe(true);
	});

	it('con amortiguamiento ≥ 1 no tiene sobrepaso', () => {
		const xs = rango(40).map((f) => escalaRebote(f, {...REBOTE, amortiguamiento: 1}));
		expect(Math.max(...xs)).toBeLessThanOrEqual(1);
	});
});

// ───────────────────────── salidas, idle e inserts ─────────────────────────

describe('salida "encoger", idle "respira", Ken Burns y deslizar', () => {
	it('encoger: los últimos 3 cuadros van de 0.83 a 0.5 de escala y el último con la opacidad del pop; antes, intacto', () => {
		expect(salidaEncoger(4)).toEqual({escala: 1, opacidad: 1});
		expect(salidaEncoger(3).escala).toBeCloseTo(0.8333, 3);
		expect(salidaEncoger(2).escala).toBeCloseTo(0.6667, 3);
		expect(salidaEncoger(1)).toEqual({escala: 0.5, opacidad: 0.83});
	});

	it('respira: ±1.5 % con periodo de 1.2 s (36 cuadros) y sin salto al empezar', () => {
		expect(escalaRespira(0)).toBe(1);
		expect(escalaRespira(-5)).toBe(1);
		expect(escalaRespira(9)).toBeCloseTo(1.015, 6);
		expect(escalaRespira(27)).toBeCloseTo(0.985, 6);
		expect(escalaRespira(36)).toBeCloseTo(1, 6);
		for (const f of rango(200)) expect(Math.abs(escalaRespira(f) - 1)).toBeLessThanOrEqual(0.015 + 1e-12);
		// El idle arranca cuando termina el pop: en el cuadro de unión no hay salto.
		const e = ESTILO_STICKER_POR_DEFECTO;
		const fin = cuadrosDeEntrada('pop', e);
		const a = animacionSticker(fin, 120, 'pop', 'corte', 'respira', e).escala;
		const b = animacionSticker(fin + 1, 120, 'pop', 'corte', 'respira', e).escala;
		expect(a).toBe(1);
		expect(Math.abs(b - a)).toBeLessThan(0.003);
	});

	it('Ken Burns: 1.00 al entrar, 1.06 en el último cuadro y nunca retrocede', () => {
		expect(escalaKenBurns(0, 90)).toBe(1);
		expect(escalaKenBurns(89, 90)).toBeCloseTo(1.06, 10);
		for (const f of rango(89)) expect(escalaKenBurns(f + 1, 90)).toBeGreaterThan(escalaKenBurns(f, 90));
	});

	it('deslizar: sube y frena en 6 cuadros; en el cuadro 5 ya está en su lugar y opaco', () => {
		const dys = rango(8).map((f) => deslizar(f).dy);
		for (const f of rango(5)) expect(dys[f + 1]).toBeLessThan(dys[f]);
		expect(dys[5]).toBe(0);
		expect(deslizar(5).opacidad).toBe(1);
		expect(deslizar(0).opacidad).toBeGreaterThan(0);
	});
});

// ───────────────────────── desenfoque ─────────────────────────

describe('rampa de desenfoque', () => {
	const tramo = {desde: 30, hasta: 120, intensidad: 20};

	it('0 fuera del tramo; sube suave en 18 cuadros, se queda en la intensidad y baja hasta 0 en `hasta`', () => {
		const v = (f: number) => intensidadDesenfoque(f, [tramo]);
		expect(v(29)).toBe(0);
		expect(v(120)).toBe(0);
		expect(v(30)).toBeGreaterThan(0);
		expect(v(30)).toBeLessThan(1);
		for (let f = 30; f < 48; f++) expect(v(f + 1)).toBeGreaterThan(v(f));
		for (let f = 48; f <= 101; f++) expect(v(f)).toBe(20);
		for (let f = 101; f < 119; f++) expect(v(f + 1)).toBeLessThan(v(f));
		// Simétrica: el último cuadro lleva lo mismo que el primero.
		expect(v(119)).toBeCloseTo(v(30), 10);
		// Sin saltos grandes: el paso máximo entre cuadros es menor que intensidad × π / (2 × 19).
		for (let f = 29; f < 121; f++) expect(Math.abs(v(f + 1) - v(f))).toBeLessThanOrEqual((20 * Math.PI) / 38 + 1e-9);
	});

	it('en un tramo corto cada rampa se recorta a un tercio; con tramos encimados manda el mayor', () => {
		const corto = {desde: 0, hasta: 15, intensidad: 10};
		const v = (f: number) => intensidadDesenfoque(f, [corto]);
		for (let f = 0; f < 5; f++) expect(v(f + 1)).toBeGreaterThan(v(f));
		expect(v(5)).toBe(10);
		expect(v(9)).toBe(10);
		expect(v(14)).toBeGreaterThan(0);
		const dos = [
			{desde: 0, hasta: 60, intensidad: 8},
			{desde: 20, hasta: 80, intensidad: 30},
		];
		expect(intensidadDesenfoque(50, dos)).toBe(30);
		expect(intensidadDesenfoque(19, dos)).toBe(8);
		expect(intensidadDesenfoque(10, dos)).toBeLessThan(8);
		// Rampa 0 = entra de golpe.
		expect(intensidadDesenfoque(0, [{desde: 0, hasta: 30, intensidad: 12}], 0, 0)).toBe(12);
	});
});

// ───────────────────────── zoom ─────────────────────────

const cubre = (e: EstadoZoom) =>
	e.escala >= 1 && e.tx <= 1e-9 && e.ty <= 1e-9 && e.tx + 1080 * e.escala >= 1080 - 1e-9 && e.ty + 1920 * e.escala >= 1920 - 1e-9;

describe('zoom (ConZoom)', () => {
	const z = (desde: number, hasta: number, escala: number, transicion: 'corte' | 'suave', x = 540, y = 760): ZoomCuadros => ({
		desde,
		hasta,
		escala,
		origen: {x, y},
		transicion,
	});
	const serie = (zooms: ZoomCuadros[], hasta = 240) => {
		const plan = planZoom(zooms);
		return rango(hasta).map((f) => estadoZoomEn(f, plan));
	};
	/** Mayor cambio de escala entre dos cuadros seguidos. */
	const saltoMax = (xs: EstadoZoom[]) => Math.max(...xs.slice(1).map((e, i) => Math.abs(e.escala - xs[i].escala)));

	it('"corte": punch-in exacto en `desde` y vuelta exacta a 1 en `hasta`', () => {
		const xs = serie([z(30, 90, 1.25, 'corte')]);
		expect(xs[29]).toEqual(IDENTIDAD);
		expect(xs[30].escala).toBe(1.25);
		expect(xs[89].escala).toBe(1.25);
		expect(xs[90]).toEqual(IDENTIDAD);
		// El origen queda fijo: el punto (540, 760) no se mueve.
		expect(xs[30].escala * 540 + xs[30].tx).toBeCloseTo(540, 9);
		expect(xs[30].escala * 760 + xs[30].ty).toBeCloseTo(760, 9);
	});

	it('"suave": resorte de 8 cuadros de entrada y de salida, continuo y sin sobrepaso', () => {
		const xs = serie([z(30, 120, 1.3, 'suave')]);
		expect(xs[30].escala).toBe(1);
		expect(xs[38].escala).toBeCloseTo(1.3, 9);
		expect(xs[112].escala).toBeCloseTo(1.3, 9);
		expect(xs[120]).toEqual(IDENTIDAD);
		expect(Math.max(...xs.map((e) => e.escala))).toBeLessThanOrEqual(1.3 + 1e-9);
		// El paso más grande del resorte de 8 cuadros es < 30 % del salto total por cuadro.
		expect(saltoMax(xs)).toBeLessThan(0.3 * 0.3);
		for (let f = 30; f < 38; f++) expect(xs[f + 1].escala).toBeGreaterThan(xs[f].escala);
		for (let f = 112; f < 120; f++) expect(xs[f + 1].escala).toBeLessThan(xs[f].escala);
	});

	it('zooms seguidos o encimados: sin saltos y sin volver a 1 en medio', () => {
		const pegados = serie([z(30, 90, 1.2, 'suave', 540, 700), z(90, 160, 1.4, 'suave', 300, 900)]);
		// El salto más grande es el de la salida final (1.4 → 1); en la unión de los dos, < 30 % de 0.2 por cuadro.
		expect(saltoMax(pegados)).toBeLessThan(0.3 * 0.4);
		expect(saltoMax(pegados.slice(80, 101))).toBeLessThan(0.3 * 0.2);
		expect(pegados[89].escala).toBeCloseTo(1.2, 9);
		expect(pegados[98].escala).toBeCloseTo(1.4, 9);
		for (let f = 40; f < 150; f++) expect(pegados[f].escala, `cuadro ${f}`).toBeGreaterThan(1.15);
		// También la traslación es continua en la unión: cada cuadro avanza < 30 % del cambio total de A a B.
		const a = pegados[89];
		const b = pegados[98];
		for (let f = 81; f <= 100; f++) {
			expect(Math.abs(pegados[f].tx - pegados[f - 1].tx), `tx ${f}`).toBeLessThan(0.3 * Math.abs(b.tx - a.tx) + 1e-9);
			expect(Math.abs(pegados[f].ty - pegados[f - 1].ty), `ty ${f}`).toBeLessThan(0.3 * Math.abs(b.ty - a.ty) + 1e-9);
		}
		const encimados = serie([z(30, 100, 1.2, 'suave'), z(60, 150, 1.5, 'suave', 200, 400)]);
		expect(saltoMax(encimados)).toBeLessThan(0.3 * 0.5);
		expect(saltoMax(encimados.slice(55, 70))).toBeLessThan(0.3 * 0.3);
		expect(encimados[59].escala).toBeCloseTo(1.2, 9);
		expect(encimados[68].escala).toBeCloseTo(1.5, 9);
	});

	it('nunca se ven las orillas de la toma (escala ≥ 1 y el origen dentro del cuadro), aun con origen fuera', () => {
		const xs = serie([z(10, 50, 1.3, 'suave', -200, 3000), z(50, 80, 2, 'corte', 1080, 0), z(90, 140, 1.1, 'suave', 900, 1800)]);
		xs.forEach((e, f) => expect(cubre(e), `cuadro ${f}`).toBe(true));
	});

	it('el resorte normalizado va de 0 a 1 justo en el cuadro 8 y sin sobrepaso', () => {
		expect(rampaResorte(0, 8)).toBe(0);
		expect(rampaResorte(8, 8)).toBe(1);
		for (let t = 0; t < 8; t++) expect(rampaResorte(t + 1, 8)).toBeGreaterThan(rampaResorte(t, 8));
	});
});

// ───────────────────────── estilos y medidas de las capas ─────────────────────────

describe('estilos de las capas (src/estilo/capas.ts)', () => {
	it('cada valor medido trae su n y su fuente; lo no medido dice N/A o supuesto', () => {
		for (const [clave, m] of Object.entries(MEDICIONES_CAPAS)) {
			expect(m.fuente.length, clave).toBeGreaterThan(0);
			if (m.n === 0) expect(String(m.valor) === 'N/A' || /supuesto/i.test(m.nota ?? ''), clave).toBe(true);
		}
		expect(MEDICIONES_CAPAS.titular_y.valor).toBe(ESTILO_TITULAR_POR_DEFECTO.y);
		expect(MEDICIONES_CAPAS.tarjeta_y.valor).toBe(ESTILO_TARJETA_POR_DEFECTO.y);
		expect(MEDICIONES_CAPAS.tarjeta_separacion.valor).toBe(ESTILO_TARJETA_POR_DEFECTO.separacion_px);
	});

	it('la caja de una tarjeta normal mide lo de tus reels: 117 px con 1 renglón y 193 con 2', () => {
		const g = geometriaTarjeta(ESTILO_TARJETA_POR_DEFECTO, 1);
		expect(altoCajaTarjeta(g, 1)).toBeCloseTo(117, 6);
		expect(altoCajaTarjeta(g, 2)).toBeCloseTo(193, 6);
		expect(Math.abs(altoCajaTarjeta(g, 1) - Number(MEDICIONES_CAPAS.tarjeta_alto_caja.valor))).toBeLessThanOrEqual(1);
		// TikTok Sans: mayúscula = 0.705 em.
		expect(g.tamano_px).toBeCloseTo(51 / 0.705, 6);
		expect(tamanoDeLetra('tiktok-sans', 47)).toBeCloseTo(66.67, 2);
		// El relleno de arriba es mayor que el medio interlineado (si no, la caja no quedaría centrada).
		expect(g.pad_arriba_px).toBeGreaterThan(g.medio_interlineado_px);
	});

	it('escala de tarjeta: grande × caja.escala; en grupo sin escala usa la de lista', () => {
		const e = ESTILO_TARJETA_POR_DEFECTO;
		expect(escalaDeTarjeta({variante: 'normal', grupo: null, caja: {x: 540, y: 1274}}, e)).toBe(1);
		expect(escalaDeTarjeta({variante: 'grande', grupo: null, caja: {x: 540, y: 1274}}, e)).toBe(1.33);
		expect(escalaDeTarjeta({variante: 'normal', grupo: 'l', caja: {x: 540, y: 1274}}, e)).toBe(0.75);
		expect(escalaDeTarjeta({variante: 'grande', grupo: 'l', caja: {x: 540, y: 1274, escala: 0.5}}, e)).toBeCloseTo(0.665, 9);
	});

	it('agruparTarjetas: la lista aparece una por una y se va junta en el hasta más tardío', () => {
		const t = (id: string, desde: number, hasta: number, grupo: string | null): Edicion['tarjetas'][number] => ({
			id,
			desde,
			hasta,
			texto: id,
			caja: {x: 540, y: 1160},
			grupo,
			variante: 'normal',
			entrada: 'corte',
			tapaCabeza: false,
			sfx: null,
		});
		const grupos = agruparTarjetas([t('b', 1.5, 3, 'lista'), t('sola', 0.2, 0.9, null), t('a', 1.0, 2.5, 'lista'), t('c', 2.0, 3.4, 'lista')]);
		expect(grupos.map((g) => g.id)).toEqual(['lista', 'sola']);
		const lista = grupos[0];
		expect(lista.tarjetas.map((x) => x.id)).toEqual(['a', 'b', 'c']);
		expect(lista.desde).toBe(30);
		expect(lista.hasta).toBe(102);
		expect(grupos[1]).toMatchObject({desde: 6, hasta: 27});
	});

	it('los estilos parciales solo toman campos conocidos y con el tipo correcto', () => {
		const t = resolverEstiloTitular({y: 330, color: '#ffeeaa', borde_px: 'grueso', ancho_max: -3, desconocido: 1, sombra: true});
		expect(t.y).toBe(330);
		expect(t.color).toBe('#FFEEAA');
		expect(t.borde_px).toBe(ESTILO_TITULAR_POR_DEFECTO.borde_px);
		expect(t.ancho_max).toBe(ESTILO_TITULAR_POR_DEFECTO.ancho_max);
		expect(t.sombra.activa).toBe(true);
		expect(resolverEstiloTitular({tamano_px: 100}).alto_mayuscula_px).toBeCloseTo(70.5, 6);
		expect(resolverEstiloTitular('basura')).toEqual(ESTILO_TITULAR_POR_DEFECTO);
		const tj = resolverEstiloTarjeta({entrada: 'pop', separacion_px: 12, fuente: 'comic-sans'});
		expect(tj.entrada).toBe('pop');
		expect(tj.separacion_px).toBe(12);
		expect(tj.fuente).toBe('tiktok-sans');
		expect(resolverEstiloTarjeta({entrada: 'explosion'}).entrada).toBe('corte');
		const s = resolverEstiloSticker({entrada: 'rebote', sombra: false, pop: {cuadros: 8}});
		expect(s.entrada).toBe('rebote');
		expect(s.sombra.activa).toBe(false);
		expect(s.pop).toEqual({...POP_MEDIDO, cuadros: 8});
		expect(resolverEstiloInsert({tarjeta: {entrada: 'deslizar'}}).tarjeta.entrada).toBe('deslizar');
	});

	it('renglones y partirEnDos: respeta "\\n" y parte parejo un renglón largo', () => {
		expect(renglones('  Claude es tu mano \n derecha  en tu negocio\n\n')).toEqual(['Claude es tu mano', 'derecha en tu negocio']);
		const medir = (s: string) => s.length * 10;
		expect(partirEnDos('Ya haces animación con Claude Design', medir)).toEqual(['Ya haces animación', 'con Claude Design']);
		expect(partirEnDos('Hola', medir)).toBeNull();
	});

	it('cuadrosDe usa el mismo redondeo que Reel.tsx y dura al menos 1 cuadro', () => {
		expect(cuadrosDe({desde: 1.01, hasta: 2.0})).toEqual({desde: 30, hasta: 60, duracion: 30});
		expect(cuadrosDe({desde: 1.0, hasta: 1.01})).toEqual({desde: 30, hasta: 31, duracion: 1});
	});
});
