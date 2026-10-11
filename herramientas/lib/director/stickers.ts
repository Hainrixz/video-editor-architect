/**
 * Catálogos de stickers (mascota del generador, tus mascotas, tus stickers propios, emojis animados y logos) y cómo se
 * ordenan las opciones de un momento: por cuántas etiquetas coinciden con el concepto, luego mascota con prop o letrero
 * antes que un prop suelto, y entre iguales un orden con semilla (variedad determinista). El layout decide al final cuál
 * cabe debajo de tu barbilla.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {InfoPng} from '../../layout.ts';
import {RAIZ} from '../manifest.ts';
import {normalizar} from './texto.ts';

type Caja = {x: number; y: number; w: number; h: number};

export type EntradaMascota = {
	id: string;
	archivo: string;
	ancho: number;
	alto: number;
	caja_tinta: Caja;
	pose: string | null;
	ojos: string | null;
	prop: string | null;
	texto: string | null;
	etiquetas: string[];
	/**
	 * "mascota": una de tus mascotas (biblioteca/stickers/mascotas); "propio": tus PNG procesados
	 * (biblioteca/stickers/propios); "emoji": emoji animado de Noto (biblioteca/stickers/emojis, CC BY 4.0; Remotion
	 * dibuja su .webp); sin esto, la mascota voxel del generador.
	 */
	fuente?: 'voxel' | 'mascota' | 'propio' | 'emoji' | 'ia';
	/** Solo emojis: el carácter (para las notas del director). */
	emoji?: string;
};
export type EntradaLogo = {id: string; marca: string; archivo: string; variante: string; ancho: number; alto: number; caja_tinta: Caja; etiquetas: string[]};

export type OpcionSticker = {
	id: string;
	/** Ruta relativa a public/ (es la que va en la EDL). */
	archivo: string;
	png: InfoPng;
	pose: string | null;
	ojos: string | null;
	coincidencias: number;
	nota: string;
};

const esCaja = (c: unknown): c is Caja => typeof c === 'object' && c !== null && ['x', 'y', 'w', 'h'].every((k) => typeof (c as Record<string, unknown>)[k] === 'number');

/** Catálogo de la mascota del generador (filas con pose y ojos). */
export const CATALOGO_MASCOTA = 'biblioteca/stickers/mascota/catalogo.json';

/**
 * Ruta (relativa a `raiz`) del catálogo de la mascota del generador: `biblioteca/stickers/mascota/catalogo.json` o, si
 * no existe, el de una carpeta anterior al renombre, que se reconoce por su forma (filas con `pose` y `ojos`).
 * null si no hay ninguno.
 */
export function rutaCatalogoMascota(raiz = RAIZ): string | null {
	if (existsSync(join(raiz, CATALOGO_MASCOTA))) return CATALOGO_MASCOTA;
	const dir = join(raiz, 'biblioteca', 'stickers');
	if (!existsSync(dir)) return null;
	for (const nombre of readdirSync(dir).sort()) {
		const rel = `biblioteca/stickers/${nombre}/catalogo.json`;
		if (!existsSync(join(raiz, rel))) continue;
		try {
			const datos = JSON.parse(readFileSync(join(raiz, rel), 'utf8'));
			if (Array.isArray(datos) && datos.length > 0 && datos.every((x) => typeof x === 'object' && x !== null && 'pose' in x && 'ojos' in x)) return rel;
		} catch {
			// no es JSON: no es este
		}
	}
	return null;
}

/** Lee los catálogos (los que no existan quedan vacíos con su aviso). */
export function leerCatalogosStickers(raiz = RAIZ): {mascotas: EntradaMascota[]; logos: EntradaLogo[]; ia: EntradaMascota[]; avisos: string[]} {
	const avisos: string[] = [];
	const leerOpcional = (rel: string): unknown[] => (existsSync(join(raiz, rel)) ? leer(rel) : []);
	const leer = (rel: string): unknown[] => {
		const ruta = join(raiz, rel);
		if (!existsSync(ruta)) {
			avisos.push(`no existe ${rel}: sin esos stickers`);
			return [];
		}
		try {
			const datos = JSON.parse(readFileSync(ruta, 'utf8'));
			return Array.isArray(datos) ? datos : [];
		} catch {
			avisos.push(`${rel} no es JSON válido: sin esos stickers`);
			return [];
		}
	};
	const rutaMascota = rutaCatalogoMascota(raiz);
	const voxel = (rutaMascota ? leer(rutaMascota) : leer(CATALOGO_MASCOTA))
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.ancho === 'number' && typeof x.alto === 'number' && esCaja(x.caja_tinta))
		.map((x) => ({
			id: x.id as string,
			archivo: x.archivo as string,
			ancho: x.ancho as number,
			alto: x.alto as number,
			caja_tinta: x.caja_tinta as Caja,
			pose: typeof x.pose === 'string' ? x.pose : null,
			ojos: typeof x.ojos === 'string' ? x.ojos : null,
			prop: typeof x.prop === 'string' ? x.prop : null,
			texto: typeof x.texto === 'string' ? x.texto : null,
			etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
		}));
	const logos = leer('biblioteca/stickers/logos/catalogo.json')
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.marca === 'string' && typeof x.ancho === 'number' && esCaja(x.caja_tinta))
		.map((x) => ({
			id: x.id as string,
			marca: x.marca as string,
			archivo: x.archivo as string,
			variante: typeof x.variante === 'string' ? x.variante : 'tile',
			ancho: x.ancho as number,
			alto: x.alto as number,
			caja_tinta: x.caja_tinta as Caja,
			etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
		}));
	// Tus mascotas (biblioteca/stickers/mascotas): entran junto a la mascota voxel. Cada una es su propia "pose"
	// (mascota:<id>), así nunca chocan con la regla de no repetir pose.
	const mascotas = leerOpcional('biblioteca/stickers/mascotas/catalogo.json')
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => x.excluida !== true && typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.ancho === 'number' && typeof x.alto === 'number' && esCaja(x.caja_tinta))
		.map(
			(x): EntradaMascota => ({
				id: x.id as string,
				archivo: x.archivo as string,
				ancho: x.ancho as number,
				alto: x.alto as number,
				caja_tinta: x.caja_tinta as Caja,
				pose: `mascota:${x.id as string}`,
				ojos: null,
				prop: null,
				texto: null,
				etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
				fuente: 'mascota',
			}),
		)
		.filter((x) => x.etiquetas.length > 0);
	// Tus stickers propios (PNG procesados con herramientas/stickers/procesar.ts --destino biblioteca/stickers/propios):
	// compiten por concepto igual que tus mascotas. Cada uno es su propia "pose" (propio:<id>).
	const propios = leerOpcional('biblioteca/stickers/propios/catalogo.json')
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => x.excluida !== true && typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.ancho === 'number' && typeof x.alto === 'number' && esCaja(x.caja_tinta))
		.map(
			(x): EntradaMascota => ({
				id: x.id as string,
				archivo: x.archivo as string,
				ancho: x.ancho as number,
				alto: x.alto as number,
				caja_tinta: x.caja_tinta as Caja,
				pose: `propio:${x.id as string}`,
				ojos: null,
				prop: null,
				texto: null,
				etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
				fuente: 'propio',
			}),
		)
		.filter((x) => x.etiquetas.length > 0);
	// Emojis animados (herramientas/stickers/emojis.ts): compiten por concepto con la mascota y tus stickers, sin ventaja.
	// Cada uno es su propia "pose" (emoji:<id>); se fuerzan en notas con id_catalogo "emoji-<nombre>".
	const emojis = leerOpcional('biblioteca/stickers/emojis/catalogo.json')
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => x.excluida !== true && typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.ancho === 'number' && typeof x.alto === 'number' && esCaja(x.caja_tinta))
		.map(
			(x): EntradaMascota => ({
				id: x.id as string,
				archivo: x.archivo as string,
				ancho: x.ancho as number,
				alto: x.alto as number,
				caja_tinta: x.caja_tinta as Caja,
				pose: `emoji:${x.id as string}`,
				ojos: null,
				prop: null,
				texto: null,
				etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
				fuente: 'emoji',
				emoji: typeof x.emoji === 'string' ? x.emoji : undefined,
			}),
		)
		.filter((x) => x.etiquetas.length > 0);
	// Stickers de IA (Higgsfield, limpiados con herramientas/stickers/ia-post.ts): no compiten por concepto; solo entran
	// forzados en notas con su id_catalogo ("ia-<concepto>").
	const ia = leerOpcional('biblioteca/stickers/ia/catalogo.json')
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.filter((x) => x.excluida !== true && typeof x.id === 'string' && typeof x.archivo === 'string' && typeof x.ancho === 'number' && typeof x.alto === 'number' && esCaja(x.caja_tinta))
		.map(
			(x): EntradaMascota => ({
				id: x.id as string,
				archivo: x.archivo as string,
				ancho: x.ancho as number,
				alto: x.alto as number,
				caja_tinta: x.caja_tinta as Caja,
				pose: `ia:${x.id as string}`,
				ojos: null,
				prop: null,
				texto: null,
				etiquetas: Array.isArray(x.etiquetas) ? (x.etiquetas as unknown[]).filter((e): e is string => typeof e === 'string') : [],
				fuente: 'ia',
			}),
		);
	return {mascotas: [...voxel, ...mascotas, ...propios, ...emojis], logos, ia, avisos};
}

/** Número en [0, 1) a partir de un texto (FNV-1a). */
function azar(texto: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < texto.length; i++) {
		h ^= texto.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 4294967296;
}

/** Mascota con prop > letrero con mascota > mascota sola > letrero > prop suelto. */
function tipoMascota(c: EntradaMascota): number {
	if (c.pose && c.prop) return 4;
	if (c.pose && c.texto) return 3;
	if (c.pose) return 2;
	if (c.texto) return 1;
	return 0;
}

/**
 * Opciones de sticker para un concepto (o un logo), mejor primero. `semilla` desempata entre iguales.
 * Para un logo: su tile y luego su versión sola. Para un concepto: las entradas voxel con alguna etiqueta del concepto;
 * cada etiqueta del concepto vale 2 y cada palabra que dijiste en ±1.5 s (`contexto`, sin acentos) que también sea
 * etiqueta vale 1 ("lo mandas a trabajar unos minutos" → laptop con reloj antes que laptop sola).
 */
export function opcionesSticker(
	pedido: {concepto: string; etiquetas: readonly string[]; marca: string | null; logo: boolean},
	cat: {mascotas: readonly EntradaMascota[]; logos: readonly EntradaLogo[]},
	semilla: string,
	contexto: readonly string[] = [],
): OpcionSticker[] {
	if (pedido.logo && pedido.marca) {
		const base = cat.logos.find((l) => l.id === pedido.marca);
		if (!base) return [];
		const misma = cat.logos.filter((l) => normalizar(l.marca) === normalizar(base.marca)).sort((a, b) => (a.variante === 'tile' ? 0 : 1) - (b.variante === 'tile' ? 0 : 1));
		return misma.map((l) => ({id: l.id, archivo: l.archivo, png: {ancho: l.ancho, alto: l.alto, tinta: l.caja_tinta}, pose: null, ojos: null, coincidencias: 1, nota: `logo ${l.marca} (${l.variante})`}));
	}
	const buscadas = new Set(pedido.etiquetas.map((e) => normalizar(e)));
	const cerca = new Set(contexto.map((w) => normalizar(w)));
	return cat.mascotas
		.map((c) => {
			const propias = c.etiquetas.filter((e) => buscadas.has(normalizar(e))).length;
			const deContexto = c.etiquetas.filter((e) => !buscadas.has(normalizar(e)) && cerca.has(normalizar(e))).length;
			// Tus mascotas y tus stickers propios van primero cuando empatan con la mascota voxel: son tuyos y ya los usas.
			return {c, propias, n: propias * 2 + deContexto + (propias > 0 && (c.fuente === 'mascota' || c.fuente === 'propio') ? 1 : 0)};
		})
		.filter((x) => x.propias > 0)
		.sort((a, b) => b.n - a.n || tipoMascota(b.c) - tipoMascota(a.c) || azar(`${semilla}:${pedido.concepto}:${a.c.id}`) - azar(`${semilla}:${pedido.concepto}:${b.c.id}`))
		.map(({c, n}) => ({
			id: c.id,
			archivo: c.archivo,
			png: {ancho: c.ancho, alto: c.alto, tinta: c.caja_tinta},
			pose: c.pose,
			ojos: c.ojos,
			coincidencias: n,
			nota: c.fuente === 'emoji' ? `emoji animado ${c.emoji ?? ''} ${c.id.replace(/^emoji-/, '')}`.replace(/\s+/g, ' ') : c.fuente === 'mascota' ? `tu mascota ${c.id.replace(/^chatgpt-/, '')}` : c.fuente === 'propio' ? `tu sticker ${c.id}` : `${c.pose ? `mascota ${c.pose}${c.ojos ? `, ojos ${c.ojos}` : ''}` : 'sin mascota'}${c.prop ? `, ${c.prop}` : ''}${c.texto ? `, letrero "${c.texto}"` : ''}`,
		}));
}

/** Pose de la mascota de un archivo del catálogo (null si no es mascota). */
export function poseDeArchivo(archivo: string, mascotas: readonly EntradaMascota[]): string | null {
	return mascotas.find((c) => c.archivo === archivo)?.pose ?? null;
}
