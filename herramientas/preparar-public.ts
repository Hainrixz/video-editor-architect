/**
 * preparar-public.ts — crea los accesos de `public/` que Remotion necesita para servir archivos:
 *   public/p → proyectos/   public/biblioteca → biblioteca/   public/demos → demos/   public/fx → pruebas/fixtures/
 *
 *   npx tsx herramientas/preparar-public.ts
 *
 * En macOS y Linux son symlinks; en Windows son "junctions" (no piden permisos de administrador).
 * Crea las carpetas de destino si faltan y no toca un acceso que ya apunta bien. `entrada/` nunca va en public/.
 */
import {existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ACCESOS: ReadonlyArray<{nombre: string; destino: string}> = [
	{nombre: 'p', destino: 'proyectos'},
	{nombre: 'biblioteca', destino: 'biblioteca'},
	{nombre: 'demos', destino: 'demos'},
	{nombre: 'fx', destino: 'pruebas/fixtures'},
];

export type ResultadoAcceso = {nombre: string; estado: 'creado' | 'ya-estaba'};

export function prepararPublic(raiz = RAIZ, plataforma: NodeJS.Platform = process.platform): ResultadoAcceso[] {
	const publico = join(raiz, 'public');
	mkdirSync(publico, {recursive: true});
	return ACCESOS.map(({nombre, destino}) => {
		const absoluto = join(raiz, destino);
		mkdirSync(absoluto, {recursive: true});
		const enlace = join(publico, nombre);
		if (existsSync(enlace) || esEnlace(enlace)) {
			if (esEnlace(enlace) && resolve(publico, readlinkSync(enlace)) === resolve(absoluto)) return {nombre, estado: 'ya-estaba'};
			throw fallo(`preparar public/${nombre}`, 'ya existe algo ahí que no apunta a ' + destino, `revisa public/${nombre} y bórralo si es un acceso viejo`, 2);
		}
		// Windows: junction con ruta absoluta (sin admin). Mac/Linux: symlink relativo, como en git.
		if (plataforma === 'win32') symlinkSync(absoluto, enlace, 'junction');
		else symlinkSync(join('..', destino), enlace, 'dir');
		return {nombre, estado: 'creado'};
	});
}

function esEnlace(ruta: string): boolean {
	try {
		return lstatSync(ruta).isSymbolicLink();
	} catch {
		return false;
	}
}

if (esPrincipal(import.meta.url)) {
	void correr(() => {
		for (const r of prepararPublic()) console.log(`public/${r.nombre}: ${r.estado === 'creado' ? 'creado' : 'ya estaba'}`);
	});
}
