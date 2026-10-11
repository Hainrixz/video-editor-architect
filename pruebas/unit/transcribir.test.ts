import {describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo';
import {
	alinearPalabras,
	aplicarCorrecciones,
	empalmar,
	normalizarPalabra,
	ordenarTiempos,
	palabrasFinales,
	zonasDudosas,
	type PalabraFinal,
} from '../../herramientas/transcribir';
import type {PalabraWhisper} from '../../herramientas/lib/whisper-json';

/** Palabras seguidas de 300 ms con p = 0.95, salvo lo que se sobrescriba. */
function frase(texto: string, desde = 0, sobrescribir: Record<number, Partial<PalabraFinal>> = {}): PalabraFinal[] {
	return texto.split(' ').map((t, i) => ({i, t, d: desde + i * 0.3, h: desde + i * 0.3 + 0.25, p: 0.95, ...sobrescribir[i]}));
}

describe('zonasDudosas', () => {
	it('marca una palabra con p baja', () => {
		const p = frase('uno dos tres cuatro cinco', 0, {2: {p: 0.05}});
		expect(zonasDudosas(p)).toEqual([{i0: 2, i1: 2}]);
	});

	it('marca dos palabras seguidas apretadas cuando una tiene ≥ 3 letras', () => {
		const p = frase('de esta liga para hacer', 0, {1: {d: 0.3, h: 0.3}, 2: {d: 0.3, h: 0.33}});
		expect(zonasDudosas(p)).toEqual([{i0: 1, i1: 2}]);
	});

	it('no marca palabras cortas normales ("va a")', () => {
		const p = frase('te va a hacer', 0, {1: {d: 0.3, h: 0.34}, 2: {d: 0.34, h: 0.36}});
		expect(zonasDudosas(p)).toEqual([]);
	});

	it('une zonas cercanas y separa las lejanas', () => {
		const texto = Array.from({length: 30}, (_, i) => `p${i}`).join(' ');
		const p = frase(texto, 0, {2: {p: 0.1}, 6: {p: 0.1}, 25: {p: 0.1}});
		expect(zonasDudosas(p)).toEqual([
			{i0: 2, i1: 6},
			{i0: 25, i1: 25},
		]);
	});
});

describe('alinearPalabras y normalizarPalabra', () => {
	it('normaliza mayúsculas, acentos y puntuación', () => {
		expect(normalizarPalabra('¿Está,')).toBe('esta');
		expect(normalizarPalabra('WebKit.')).toBe('webkit');
	});

	it('encuentra la subsecuencia común más larga', () => {
		expect(alinearPalabras(['a', 'b', 'x', 'c'], ['a', 'y', 'b', 'c'])).toEqual([
			[0, 0],
			[1, 2],
			[3, 3],
		]);
	});
});

describe('empalmar', () => {
	// Caso real de IMG_4874 (30.2 s): whisper con prompt escribió "de esta liga, para".
	const base = frase('instalar todas las dependencias necesarias de esta liga, para hacer la página web de mi', 28, {
		6: {p: 0.836},
		7: {p: 0.863},
		8: {p: 0.055},
	});
	const zona = {i0: 6, i1: 8};
	const alternativa = frase('las dependencias necesarias de este agente llamado webkit para hacer la página web', 28.6);

	it('reemplaza entre anclas cuando la alternativa es más confiable', () => {
		const r = empalmar(base, zona, alternativa);
		expect(r.revision.aplicada).toBe(true);
		expect(r.revision.original).toBe('esta liga, para');
		expect(r.revision.alternativa).toBe('este agente llamado webkit para');
		expect(r.palabras.map((p) => p.t).join(' ')).toBe(
			'instalar todas las dependencias necesarias de este agente llamado webkit para hacer la página web de mi',
		);
		expect(r.palabras.filter((p) => p.fuente === 'segunda-opinion')).toHaveLength(5);
	});

	it('no cambia nada si el texto es el mismo', () => {
		const igual = frase('las dependencias necesarias de esta liga, para hacer la página web', 28.6);
		const r = empalmar(base, zona, igual);
		expect(r.revision.aplicada).toBe(false);
		expect(r.revision.motivo).toBe('mismo texto');
		expect(r.palabras).toBe(base);
	});

	it('no cambia nada si la alternativa no es más confiable', () => {
		const dudosa = alternativa.map((p) => ({...p, p: 0.5}));
		const r = empalmar(base, zona, dudosa);
		expect(r.revision.aplicada).toBe(false);
		expect(r.revision.motivo).toBe('la alternativa no es más confiable');
	});

	it('no cambia nada sin anclas a los dos lados', () => {
		const r = empalmar(base, zona, frase('otra cosa completamente distinta', 28.6));
		expect(r.revision.aplicada).toBe(false);
		expect(r.revision.motivo).toBe('sin palabras ancla a los dos lados');
	});
});

describe('palabrasFinales con fin de tramo', () => {
	// Caso real de IMG_4874: la última palabra, anclada en t_dtw con la duración de sus offsets,
	// terminaba en 73.73 s con el tramo cortado en 73.29 s.
	const ultima: PalabraWhisper = {texto: 'herramienta.', inicioOffsetsMs: 72260, inicioDtwMs: 72720, finMs: 73290, p: 0.99, segmento: 0, tokens: 3};

	it('sin límite, el fin puede pasar del tramo', () => {
		expect(palabrasFinales([ultima], 't_dtw', 19)[0].h).toBeCloseTo(73.731, 3);
	});

	it('con límite, el fin se recorta al tramo', () => {
		const [p] = palabrasFinales([ultima], 't_dtw', 19, () => 73290);
		expect(p.d).toBeCloseTo(72.701, 3);
		expect(p.h).toBeCloseTo(73.29, 3);
	});
});

describe('ordenarTiempos', () => {
	it('deja inicios monótonos, fines ≤ inicio siguiente y reindexa', () => {
		const p: PalabraFinal[] = [
			{i: 5, t: 'a', d: 1.0, h: 1.5, p: 1},
			{i: 9, t: 'b', d: 0.9, h: 1.2, p: 1},
			{i: 2, t: 'c', d: 1.4, h: 1.6, p: 1},
		];
		const r = ordenarTiempos(p);
		expect(r.map((x) => x.i)).toEqual([0, 1, 2]);
		expect(r.map((x) => x.d)).toEqual([1.0, 1.0, 1.4]);
		expect(r[0].h).toBe(1.0);
		expect(r[1].h).toBe(1.2);
		for (let j = 0; j + 1 < r.length; j++) expect(r[j].h).toBeLessThanOrEqual(r[j + 1].d);
	});
});

describe('aplicarCorrecciones', () => {
	it('corrige respetando la puntuación pegada y guarda el original', () => {
		const p = frase('con Cloud, el ¿Cloud? nuevo');
		const r = aplicarCorrecciones(p, {cloud: 'Claude'});
		expect(r.palabras.map((x) => x.t)).toEqual(['con', 'Claude,', 'el', '¿Claude?', 'nuevo']);
		expect(r.palabras[1].t_whisper).toBe('Cloud,');
		expect(r.palabras[0].t_whisper).toBeUndefined();
		expect(r.cambios).toEqual([
			{i: 1, de: 'Cloud,', a: 'Claude,'},
			{i: 3, de: '¿Cloud?', a: '¿Claude?'},
		]);
	});

	it('aplica claves de varias palabras antes que las de una', () => {
		const p = frase('abre cloud code ya');
		const r = aplicarCorrecciones(p, {cloud: 'Claude', 'cloud code': 'Claude Code'});
		expect(r.palabras.map((x) => x.t)).toEqual(['abre', 'Claude', 'Code', 'ya']);
		expect(r.palabras[2].d).toBe(p[2].d);
	});

	it('junta varias palabras en una con los tiempos del grupo', () => {
		const p = frase('usa chat gpt, hoy', 0, {2: {p: 0.4}});
		const r = aplicarCorrecciones(p, {'chat gpt': 'ChatGPT'});
		expect(r.palabras.map((x) => x.t)).toEqual(['usa', 'ChatGPT,', 'hoy']);
		expect(r.palabras[1].d).toBe(p[1].d);
		expect(r.palabras[1].h).toBe(p[2].h);
		expect(r.palabras[1].p).toBe(0.4);
		expect(r.palabras[1].t_whisper).toBe('chat gpt,');
		expect(r.palabras.map((x) => x.i)).toEqual([0, 1, 2]);
	});

	it('parte una palabra que whisper juntó y reparte su tiempo por letras', () => {
		const p = frase('si Claudelanada se traba');
		const r = aplicarCorrecciones(p, {claudelanada: 'Claude de la nada'});
		expect(r.palabras.map((x) => x.t)).toEqual(['si', 'Claude', 'de', 'la', 'nada', 'se', 'traba']);
		const partes = r.palabras.slice(1, 5);
		expect(partes[0].d).toBe(p[1].d);
		expect(partes[3].h).toBe(p[1].h);
		for (let k = 1; k < partes.length; k++) expect(partes[k].d).toBeCloseTo(partes[k - 1].h, 6);
		expect(partes.every((x) => x.t_whisper === 'Claudelanada')).toBe(true);
		expect(r.palabras.map((x) => x.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it('es idempotente', () => {
		const una = aplicarCorrecciones(frase('con cloud hoy'), {cloud: 'Claude'});
		const dos = aplicarCorrecciones(una.palabras, {cloud: 'Claude'});
		expect(dos.palabras).toEqual(una.palabras);
		expect(dos.cambios).toEqual([]);
	});

	it('rechaza una corrección que cambia el número de palabras (salvo a una)', () => {
		try {
			aplicarCorrecciones(frase('a b'), {'a b': 'x y z'});
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(FalloEditor);
			expect((error as FalloEditor).codigo).toBe(2);
		}
	});
});
