// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Motion graphics propios (src/estilo/motion.ts): contrato en la EDL, valores por defecto, curvas, líneas de tiempo y
 * cajas. Lo visual se revisó renderizando cada motion; aquí se prueba que los números hagan lo que dicen los comentarios.
 */
import {describe, expect, it} from 'vitest';
import {EdicionValidada, edicionVacia, type Edicion} from '../../src/esquema/edicion';
import {
	COMANDO_EJEMPLO,
	CURVAS,
	ESCENA,
	SKILLS_EJEMPLO,
	assetMotion,
	avance,
	bezier,
	cajaMotion,
	caracteresTecleados,
	duracionMinimaMotion,
	lineaApple,
	lineaBasura,
	lineaSkills,
	resolverMotion,
	type Motion,
} from '../../src/estilo/motion';
import {fueraDeZona} from '../../src/estilo/zona-segura';
import {leerNotas} from '../../herramientas/lib/director/plan';

const insertMotion = (motion: Motion | undefined, extra: Partial<Edicion['inserts'][number]> = {}): Edicion['inserts'][number] => ({
	id: 'm1',
	tipo: 'motion',
	desde: 0,
	hasta: 3,
	asset: motion ? assetMotion(motion.nombre) : 'motion:skills-instaladas',
	trim_desde: 0,
	layout: 'pantalla-completa',
	tapaCabeza: false,
	texto: null,
	eventos: null,
	audio: {modo: 'mute', ganancia_db: 0},
	sfx: null,
	...(motion ? {motion} : {}),
	...extra,
});

const conInserts = (inserts: Edicion['inserts']) => EdicionValidada.safeParse({...edicionVacia, duracion_s: 10, inserts});

describe('contrato del insert "motion"', () => {
	it('acepta los tres motions con sus props', () => {
		const r = conInserts([
			insertMotion({nombre: 'skills-instaladas'}, {id: 'a'}),
			insertMotion({nombre: 'basura-a-diseno', cambio_s: 2}, {id: 'b', desde: 3, hasta: 7.1}),
			insertMotion({nombre: 'reglas-apple', principios: [{titulo: 'Jerarquía', nota: 'Lo importante primero'}, {titulo: 'Armonía', nota: 'Todo se siente parte'}, {titulo: 'Consistencia', nota: 'Patrones conocidos'}]}, {id: 'c', desde: 7.1, hasta: 9.5}),
		]);
		expect(r.success).toBe(true);
	});

	it('pide `motion`, el asset "motion:<nombre>" y no deja `motion` en otros tipos', () => {
		expect(conInserts([insertMotion(undefined)]).success).toBe(false);
		expect(conInserts([insertMotion({nombre: 'reglas-apple'}, {asset: 'motion:skills-instaladas'})]).success).toBe(false);
		expect(conInserts([insertMotion({nombre: 'reglas-apple'}, {tipo: 'imagen', asset: 'p/x/a.png'})]).success).toBe(false);
	});

	it('rechaza props fuera de rango (2 principios, 9 skills, nombre desconocido)', () => {
		expect(conInserts([insertMotion({nombre: 'reglas-apple', principios: [{titulo: 'A', nota: 'a'}, {titulo: 'B', nota: 'b'}]})]).success).toBe(false);
		expect(conInserts([insertMotion({nombre: 'skills-instaladas', skills: Array.from({length: 9}, (_, i) => `s${i}`)})]).success).toBe(false);
		expect(conInserts([insertMotion({nombre: 'otro'} as unknown as Motion, {asset: 'motion:otro'})]).success).toBe(false);
	});

	it('notas-director.json acepta inserts motion', () => {
		const r = leerNotas({inserts: [{asset: 'motion:reglas-apple', tipo: 'motion', layout: 'pantalla-completa', desde: 13.65, hasta: 16.5, motion: {nombre: 'reglas-apple'}}]});
		expect(r.problemas).toEqual([]);
		expect(r.notas?.inserts[0].motion?.nombre).toBe('reglas-apple');
	});
});

describe('valores por defecto', () => {
	it('skills: el comando y las skills de ejemplo (genéricos) si la EDL no trae los suyos', () => {
		const r = resolverMotion({nombre: 'skills-instaladas'});
		if (r.nombre !== 'skills-instaladas') throw new Error('tipo');
		expect(r.comando).toBe(COMANDO_EJEMPLO);
		expect(r.comando).toBe('npx skills@latest add autor/skills');
		expect(r.repo).toBe('autor/skills');
		expect(r.skills).toEqual([...SKILLS_EJEMPLO]);
		expect(r.skills).toContain('apple-design');
		expect(r.pie).toBe('Listas en Claude Code');
		expect(resolverMotion({nombre: 'skills-instaladas', pie: null})).toMatchObject({pie: null});
	});

	it('apple: claridad, deferencia y profundidad; basura: cambio a 1.5 s', () => {
		expect(resolverMotion({nombre: 'reglas-apple'})).toMatchObject({principios: [{titulo: 'Claridad'}, {titulo: 'Deferencia'}, {titulo: 'Profundidad'}]});
		expect(resolverMotion({nombre: 'basura-a-diseno'})).toMatchObject({cambio_s: 1.5, antes: 'Basura de IA'});
	});
});

describe('curvas', () => {
	it('bezier vale 0 y 1 en las orillas y nunca baja', () => {
		for (const c of [CURVAS.salida, CURVAS.mover, bezier(0.25, 0.1, 0.25, 1)]) {
			expect(c(0)).toBe(0);
			expect(c(1)).toBe(1);
			let previo = 0;
			for (let t = 0; t <= 1.0001; t += 0.02) {
				const v = c(t);
				expect(v).toBeGreaterThanOrEqual(previo - 1e-9);
				previo = v;
			}
		}
	});

	it('ease-out arranca rápido (a la mitad ya pasó el 85 %) y ease-in-out va lenta en las dos orillas', () => {
		expect(CURVAS.salida(0.5)).toBeGreaterThan(0.85);
		expect(CURVAS.mover(0.1)).toBeLessThan(0.05);
		expect(CURVAS.mover(0.9)).toBeGreaterThan(0.95);
		expect(CURVAS.mover(0.5)).toBeGreaterThan(0.4);
		expect(CURVAS.mover(0.5)).toBeLessThan(0.7);
	});

	it('avance se queda en 0 antes y en 1 después', () => {
		expect(avance(-5, 0, 10)).toBe(0);
		expect(avance(20, 0, 10)).toBe(1);
	});
});

describe('líneas de tiempo', () => {
	it('skills: teclea, da Enter y las filas caen con 2 cuadros de stagger, en orden', () => {
		const r = resolverMotion({nombre: 'skills-instaladas'});
		if (r.nombre !== 'skills-instaladas') throw new Error('tipo');
		const lt = lineaSkills(r);
		expect(lt.tecleo.fin).toBeLessThan(lt.enter);
		expect(lt.enter).toBeLessThan(lt.encabezado);
		expect(lt.filas[0]).toBeGreaterThan(lt.encabezado);
		lt.filas.forEach((f, i) => i > 0 && expect(f - lt.filas[i - 1]).toBe(2));
		expect(lt.pie!).toBeGreaterThan(lt.filas[lt.filas.length - 1]);
		expect(caracteresTecleados(lt, r.comando.length, lt.tecleo.inicio - 1)).toBe(0);
		expect(caracteresTecleados(lt, r.comando.length, lt.tecleo.fin)).toBe(r.comando.length);
		expect(caracteresTecleados(lt, r.comando.length, 999)).toBe(r.comando.length);
	});

	it('basura: el barrido arranca en cambio_s y dura 0.5 s', () => {
		const r = resolverMotion({nombre: 'basura-a-diseno', cambio_s: 2});
		if (r.nombre !== 'basura-a-diseno') throw new Error('tipo');
		const lt = lineaBasura(r);
		expect(lt.cambio).toBe(60);
		expect(lt.barrido).toBe(15);
		expect(lt.minimo).toBeGreaterThan(lt.cambio + lt.barrido);
	});

	it('apple: una tarjeta por principio, 4 cuadros entre una y otra', () => {
		const r = resolverMotion({nombre: 'reglas-apple'});
		if (r.nombre !== 'reglas-apple') throw new Error('tipo');
		expect(lineaApple(r).tarjetas).toEqual([6, 10, 14]);
	});

	it('las duraciones propuestas para el reel de referencia alcanzan (skills 3.1 s, basura 4.42 s, apple 2.85 s)', () => {
		expect(duracionMinimaMotion({nombre: 'skills-instaladas'})).toBeLessThanOrEqual(3.1);
		expect(duracionMinimaMotion({nombre: 'basura-a-diseno', cambio_s: 2})).toBeLessThanOrEqual(4.42);
		expect(duracionMinimaMotion({nombre: 'reglas-apple'})).toBeLessThanOrEqual(2.85);
	});
});

describe('cajas y zona segura', () => {
	it('pantalla completa cubre el cuadro; la escena cabe en la zona cian a lo ancho', () => {
		expect(cajaMotion('pantalla-completa')).toEqual({x0: 0, y0: 0, x1: 1080, y1: 1920});
		expect(ESCENA.ancho).toBe(945 - 135);
		// Escena centrada en (540, 740): y 250–1230, dentro de 220–1600 y arriba de las tarjetas del pecho.
		expect(fueraDeZona({x0: 135, y0: 740 - ESCENA.alto / 2, x1: 945, y1: 740 + ESCENA.alto / 2}, 'capa')).toEqual([]);
	});

	it('la tarjeta por defecto queda dentro de la zona segura amplia (sin tocar los íconos)', () => {
		const c = cajaMotion('tarjeta');
		expect(fueraDeZona(c, 'amplia')).toEqual([]);
		expect(c.x1 - c.x0).toBe(810);
		expect((c.y0 + c.y1) / 2).toBe(940);
	});
});
