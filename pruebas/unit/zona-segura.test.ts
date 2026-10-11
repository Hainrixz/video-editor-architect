/**
 * Zona segura de Instagram Reels (guía pública de 2025) y la decisión de zona de un estilo sobre lo medido (aquí, una
 * de prueba: subtítulos en y = 1545, tarjetas y stickers 46.5 px más abajo, tarjetas más chicas y con menos relleno),
 * la zona neutra del motor, y el layout que siempre coloca dentro de la zona (x 135–945, y 220–1600).
 */
import {describe, expect, it} from 'vitest';
import {colocarLista, colocarSticker, colocarTarjeta, crearContexto} from '../../herramientas/layout.ts';
import {estiloDesde} from '../../herramientas/lib/director/estilo.ts';
import {ESTILO_TARJETA_POR_DEFECTO, resolverEstiloTarjeta} from '../../src/estilo/capas.ts';
import {ZONA_NEUTRA} from '../../herramientas/lib/perfil-estilo.ts';
import {aplicarDecisionTarjetas, fueraDeZona, ZONA_SEGURA, type DecisionZona} from '../../src/estilo/zona-segura.ts';
import {HAY_FUENTES} from './requisitos.ts';

/** Una decisión de zona de prueba (la forma de perfil.json → motor.zona). */
const ZONA_PRUEBA: DecisionZona = {
	subtitulos_y: 1545,
	bajada_capas_px: 46.5,
	tarjeta_letra: 0.88,
	tarjeta_relleno: 0.65,
	prompt_letra: 0.94,
	ancho_max: 810,
	nota: 'decisión de prueba (textos más abajo, tarjetas más chicas)',
	puede_tapar_cara: true,
	margen_boca_px: -1920,
	nota_cara: 'decisión de prueba: se vale tapar la cara',
};

describe('fueraDeZona', () => {
	it('capas: x 135–945 e y 220–1600', () => {
		expect(fueraDeZona({x0: 135, x1: 945, y0: 220, y1: 1600}, 'capa')).toEqual([]);
		expect(fueraDeZona({x0: 100, x1: 500, y0: 1000, y1: 1100}, 'capa')[0]).toMatch(/izquierda/);
		expect(fueraDeZona({x0: 300, x1: 500, y0: 200, y1: 400}, 'capa')[0]).toMatch(/arriba/);
		expect(fueraDeZona({x0: 300, x1: 500, y0: 1500, y1: 1610}, 'capa')[0]).toMatch(/caption/);
	});
	it('subtítulos: hasta 1590 abajo; amplias: caja magenta sin la columna de íconos', () => {
		expect(fueraDeZona({x0: 300, x1: 780, y0: 1510, y1: 1589}, 'subtitulo')).toEqual([]);
		expect(fueraDeZona({x0: 300, x1: 780, y0: 1510, y1: 1595}, 'subtitulo')).toHaveLength(1);
		expect(fueraDeZona({x0: 40, x1: 1040, y0: 650, y1: 1270}, 'amplia')).toEqual([]);
		expect(fueraDeZona({x0: 40, x1: 1000, y0: 900, y1: 1300}, 'amplia').join(' ')).toMatch(/íconos/);
	});
});

describe('decisión de zona de un estilo', () => {
	it('tarjetas: letra × 0.88, relleno × 0.65, ancho máximo 810, y + 46.5; el prompt se achica menos', () => {
		const medido = {alto_mayuscula_px: 52.5, pad_arriba_px: 29.8, pad_abajo_px: 35.5, pad_lados_px: 21.5, y: 1280.8, entrada: 'corte'};
		const d = aplicarDecisionTarjetas(medido, ESTILO_TARJETA_POR_DEFECTO, ZONA_PRUEBA);
		expect(d.alto_mayuscula_px).toBeCloseTo(46.2, 1);
		expect(d.pad_lados_px).toBeCloseTo(13.98, 1);
		expect(d.pad_arriba_px).toBeCloseTo(19.37, 1);
		expect(d.y).toBeCloseTo(1327.3, 1);
		expect(d.ancho_max).toBe(810);
		expect(d.entrada).toBe('corte');
		const e = resolverEstiloTarjeta(d);
		expect(e.prompt.alto_mayuscula_px).toBeCloseTo(33.8 * 0.94, 1);
		expect(e.prompt.ancho_max).toBe(810);
		// El alto de una tarjeta de 1 renglón baja de ~118 px a ~89 px.
		expect(e.pad_arriba_px + e.alto_mayuscula_px + e.pad_abajo_px).toBeLessThan(90);
	});

	it('el estilo del director baja tarjetas, stickers y franja 46.5 px y acota la zona UI a la zona segura', () => {
		const medido = estiloDesde({decision: false});
		const nuevo = estiloDesde({decision: ZONA_PRUEBA});
		const b = ZONA_PRUEBA.bajada_capas_px;
		expect(nuevo.tarjeta.y.valor).toBeCloseTo(medido.tarjeta.y.valor + b, 1);
		expect(nuevo.sticker.centro_y.valor).toBeCloseTo(medido.sticker.centro_y.valor + b, 1);
		expect(nuevo.franja.y_p10.valor).toBeCloseTo(medido.franja.y_p10.valor + b, 1);
		expect(nuevo.tarjeta.y.nota).toMatch(/decisión de prueba/);
		expect(nuevo.cabeza.margen_boca.valor).toBe(-1920);
		expect(medido.cabeza.margen_boca.valor).toBeGreaterThan(0);
		for (const e of [medido, nuevo]) {
			expect(e.zona_ui.izquierda.valor).toBeGreaterThanOrEqual(ZONA_SEGURA.capas.x0);
			expect(e.zona_ui.derecha.valor).toBeLessThanOrEqual(ZONA_SEGURA.capas.x1);
			expect(e.zona_ui.arriba.valor).toBeGreaterThanOrEqual(ZONA_SEGURA.capas.y0);
		}
		// Con la zona UI medida más ancha (x 97.8–966.2) también se acota.
		const ancho = estiloDesde({estiloJson: {zona_ui: {izquierda: {valor: 97.8, n: 22, fuente: 'm'}, derecha: {valor: 966.2, n: 22, fuente: 'm'}, arriba: {valor: 200, n: 1, fuente: 'm'}}}});
		expect(ancho.zona_ui.izquierda.valor).toBe(135);
		expect(ancho.zona_ui.derecha.valor).toBe(945);
		expect(ancho.zona_ui.arriba.valor).toBe(220);
		expect(ancho.zona_ui.derecha.nota).toMatch(/medido 966.2/);
	});

	it('la zona neutra del motor deja lo medido tal cual (ancho máximo = zona cian) y protege la boca', () => {
		const medido = {alto_mayuscula_px: 52.5, pad_arriba_px: 29.8, pad_abajo_px: 35.5, pad_lados_px: 21.5, y: 1280.8};
		const d = aplicarDecisionTarjetas(medido, ESTILO_TARJETA_POR_DEFECTO, ZONA_NEUTRA);
		expect(d).toMatchObject({...medido, ancho_max: 810});
		const neutro = estiloDesde({decision: ZONA_NEUTRA});
		const sin = estiloDesde({decision: false});
		expect(neutro.tarjeta.y.valor).toBe(sin.tarjeta.y.valor);
		expect(neutro.cabeza.margen_boca).toEqual(sin.cabeza.margen_boca);
	});
});

describe('el layout coloca dentro de la zona segura', () => {
	const estilo = estiloDesde({decision: ZONA_PRUEBA});
	const estilos = {tarjetas: aplicarDecisionTarjetas({}, ESTILO_TARJETA_POR_DEFECTO, ZONA_PRUEBA)};
	const ctx = crearContexto({cara: null, estilo, estilos, semilla: 'zona'});
	const dentro = (c: {x0: number; x1: number; y0: number; y1: number}) => expect(fueraDeZona(c, 'capa')).toEqual([]);

	it.runIf(HAY_FUENTES)('tarjetas largas se parten (≤ 810 px) y quedan en x 135–945; stickers también', () => {
		for (const texto of ['Habilidades de diseño profesionales', 'Opus', 'Una frase de muchas palabras que se tiene que partir']) {
			const r = colocarTarjeta({t0: 1, t1: 2, texto}, ctx);
			expect(r.caja).not.toBeNull();
			dentro({x0: 540 - r.ancho / 2, x1: 540 + r.ancho / 2, y0: r.caja!.y - r.alto / 2, y1: r.caja!.y + r.alto / 2});
		}
		const s = colocarSticker({id: 'k1', t0: 1, t1: 2, anchoDeseado: 340, aspecto: 1}, ctx);
		expect(s.visible).not.toBeNull();
		dentro(s.visible!);
		const l = colocarLista({t0: 1, t1: 3, textos: ['Animaciones', 'Tipografía', 'Colores']}, ctx);
		expect(l.cajas.length).toBe(3);
	});
});
