import {mkdtempSync, readlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {prepararPublic} from '../../herramientas/preparar-public.ts';

describe('prepararPublic', () => {
	it('crea los cuatro accesos y la segunda vez no toca nada', () => {
		const raiz = mkdtempSync(join(tmpdir(), 'public-'));
		expect(prepararPublic(raiz, 'darwin').map((r) => r.estado)).toEqual(['creado', 'creado', 'creado', 'creado']);
		expect(readlinkSync(join(raiz, 'public', 'p'))).toBe(join('..', 'proyectos'));
		expect(prepararPublic(raiz, 'darwin').every((r) => r.estado === 'ya-estaba')).toBe(true);
	});

	it('en el repo actual deja los accesos bien puestos (los crea si faltan)', () => {
		prepararPublic(undefined, process.platform);
		expect(prepararPublic(undefined, process.platform).every((r) => r.estado === 'ya-estaba')).toBe(true);
	});
});
