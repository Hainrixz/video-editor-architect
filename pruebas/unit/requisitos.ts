/**
 * Lo que algunas pruebas necesitan y no viaja con la plantilla (o no está recién clonado el repo): las fuentes .ttf
 * (se bajan con `sh biblioteca/fuentes/preparar.sh`), los fixtures de video (pruebas/fixtures/) y los catálogos con
 * datos del creador (stickers, SFX, memes). Sin ellos esas pruebas se saltan en vez de fallar.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

export const RAIZ_PRUEBAS = resolve(import.meta.dirname, '..', '..');

/** ¿Existe este archivo (ruta relativa a la raíz)? */
export const hay = (rel: string): boolean => existsSync(join(RAIZ_PRUEBAS, rel));

/** Todas las .ttf que miden texto (tarjetas, titular, subtítulos, logos y la terminal). */
export const HAY_FUENTES = (() => {
	const dir = join(RAIZ_PRUEBAS, 'biblioteca', 'fuentes');
	if (!existsSync(dir)) return false;
	return ['tiktok-sans', 'instrument-sans', 'inter', 'jetbrains-mono'].every((f) => existsSync(join(dir, f)) && readdirSync(join(dir, f)).some((n) => n.endsWith('.ttf')));
})();

/** Fixtures de video y demos (pruebas/fixtures/, no se versionan). */
export const HAY_FIXTURES = hay('pruebas/fixtures/clip-6s.mp4') && hay('pruebas/fixtures/f7-claude-code.json');

/** ¿El catálogo (JSON con lista, o con `archivos` o `memes`) trae al menos una fila? */
export function catalogoConDatos(rel: string): boolean {
	if (!hay(rel)) return false;
	try {
		const datos = JSON.parse(readFileSync(join(RAIZ_PRUEBAS, rel), 'utf8'));
		const lista = Array.isArray(datos) ? datos : [datos?.archivos, datos?.memes].find(Array.isArray) ?? [];
		return lista.length > 0;
	} catch {
		return false;
	}
}
