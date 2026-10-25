// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {describe, expect, it} from 'vitest';
import {calcularRitmo, cortesDeShowinfo, nombreDeReferencia} from '../../herramientas/estilo/referencia.ts';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';

describe('referencia.ts: ritmo de un reel de referencia', () => {
	it('lee los cortes de showinfo en orden', () => {
		const texto = '[Parsed_showinfo_1] n:0 pts:90 pts_time:3.0 duration\n[Parsed_showinfo_1] n:1 pts:30 pts_time:1.5 x\nbasura';
		expect(cortesDeShowinfo(texto)).toEqual([1.5, 3]);
		expect(cortesDeShowinfo('nada')).toEqual([]);
	});

	it('calcula cortes por minuto y tomas (sin cortes en los bordes ni repetidos)', () => {
		const r = calcularRitmo([0, 2, 2, 5, 9.99], 10);
		expect(r.cortes).toBe(2);
		expect(r.cortes_por_min).toBe(12);
		expect(r.toma_media_s).toBeCloseTo(10 / 3, 3);
		expect(r.toma_mediana_s).toBe(3);
		const sin = calcularRitmo([], 30);
		expect(sin.cortes).toBe(0);
		expect(sin.toma_mediana_s).toBe(30);
		expect(() => calcularRitmo([], 0)).toThrow(FalloEditor);
	});

	it('nombra la referencia por el shortCode de Instagram o por el archivo', () => {
		expect(nombreDeReferencia('https://www.instagram.com/reel/Aa_1bCdEf2G/?igsh=x')).toBe('Aa_1bCdEf2G');
		expect(nombreDeReferencia('/home/x/Descargas/Mi reel ñandú.mp4')).toBe('Mi-reel-nandu');
	});
});
