// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * ajustar.ts — /ajustar mínimo (Fase 1): cada ajuste es una versión nueva de la EDL; la anterior no se toca.
 *
 *   npx tsx herramientas/ajustar.ts <slug> [--desde N] [--json]
 *
 * - Si edicion-v(N+1).json NO existe: la crea como copia exacta de edicion-vN.json, deja vN de solo lectura
 *   (chmod 444: inmutable), la valida y te dice que la edites. (Sin --desde, N es la versión más alta.)
 * - Si edicion-v(N+1).json YA existe (ya la editaste): la valida con validar.ts e imprime el diff JSON contra vN
 *   (solo las rutas que cambiaron). Nunca sobrescribe ninguna versión.
 * Rutas del diff: los arreglos de objetos con `id` (subtítulos, stickers, inserts, zooms) se comparan por id,
 * así quitar el sticker k3 da UN cambio ("stickers[id=k3]") y no un corrimiento de todos los de después.
 *   ~ ruta: antes → después     (cambió)     + ruta: valor (se agregó)     - ruta: valor (se quitó)
 * --json imprime el diff como JSON (para pruebas o para otra herramienta).
 * Sale con 0 si la versión nueva es válida; con 2 si no lo es o falta algo.
 */
import {chmodSync, existsSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ, dirProyecto, validarSlug} from './lib/manifest.ts';
import {elegirVersion, rutaEdicion} from './render.ts';
import {validarEdicion, type Hallazgo} from './validar.ts';

const USO = 'npx tsx herramientas/ajustar.ts <slug> [--desde N] [--json]';

export type Cambio = {tipo: 'cambiado' | 'agregado' | 'quitado' | 'orden'; ruta: string; antes?: unknown; despues?: unknown};

const esObjeto = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** ¿Es un arreglo de objetos, cada uno con `id` de texto y sin repetir? Entonces se compara por id. */
function conIds(xs: unknown[]): xs is Array<Record<string, unknown> & {id: string}> {
	if (xs.length === 0) return false;
	const ids = xs.map((x) => (esObjeto(x) && typeof x.id === 'string' ? x.id : null));
	return ids.every((id) => id !== null) && new Set(ids).size === ids.length;
}

function iguales(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Diff entre dos JSON: lista de rutas que cambiaron (ver formato en el encabezado). Pura. */
export function diffJson(antes: unknown, despues: unknown, ruta = ''): Cambio[] {
	if (iguales(antes, despues)) return [];
	if (Array.isArray(antes) && Array.isArray(despues)) {
		const porId = (antes.length === 0 || conIds(antes)) && (despues.length === 0 || conIds(despues)) && (antes.length > 0 || despues.length > 0);
		if (porId) {
			const a = antes as Array<{id: string}>;
			const d = despues as Array<{id: string}>;
			const mapaA = new Map(a.map((x) => [x.id, x]));
			const mapaD = new Map(d.map((x) => [x.id, x]));
			const cambios: Cambio[] = [];
			for (const x of a) {
				const r = `${ruta}[id=${x.id}]`;
				if (!mapaD.has(x.id)) cambios.push({tipo: 'quitado', ruta: r, antes: x});
				else cambios.push(...diffJson(x, mapaD.get(x.id), r));
			}
			for (const x of d) if (!mapaA.has(x.id)) cambios.push({tipo: 'agregado', ruta: `${ruta}[id=${x.id}]`, despues: x});
			const ordenA = a.map((x) => x.id).filter((id) => mapaD.has(id));
			const ordenD = d.map((x) => x.id).filter((id) => mapaA.has(id));
			if (!iguales(ordenA, ordenD)) cambios.push({tipo: 'orden', ruta, antes: ordenA, despues: ordenD});
			return cambios;
		}
		const cambios: Cambio[] = [];
		for (let i = 0; i < Math.max(antes.length, despues.length); i++) {
			const r = `${ruta}[${i}]`;
			if (i >= despues.length) cambios.push({tipo: 'quitado', ruta: r, antes: antes[i]});
			else if (i >= antes.length) cambios.push({tipo: 'agregado', ruta: r, despues: despues[i]});
			else cambios.push(...diffJson(antes[i], despues[i], r));
		}
		return cambios;
	}
	if (esObjeto(antes) && esObjeto(despues)) {
		const cambios: Cambio[] = [];
		const llaves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])];
		for (const k of llaves) {
			const r = ruta ? `${ruta}.${k}` : k;
			if (!(k in despues)) cambios.push({tipo: 'quitado', ruta: r, antes: antes[k]});
			else if (!(k in antes)) cambios.push({tipo: 'agregado', ruta: r, despues: despues[k]});
			else cambios.push(...diffJson(antes[k], despues[k], r));
		}
		return cambios;
	}
	return [{tipo: 'cambiado', ruta: ruta || '(raíz)', antes, despues}];
}

const corto = (x: unknown): string => {
	const t = JSON.stringify(x);
	return t === undefined ? 'undefined' : t.length > 90 ? `${t.slice(0, 87)}…` : t;
};

/** Una línea por cambio, para leer en la terminal. */
export function formatearDiff(cambios: Cambio[]): string[] {
	return cambios.map((c) => {
		if (c.tipo === 'cambiado') return `~ ${c.ruta}: ${corto(c.antes)} → ${corto(c.despues)}`;
		if (c.tipo === 'agregado') return `+ ${c.ruta}: ${corto(c.despues)}`;
		if (c.tipo === 'quitado') return `- ${c.ruta}: ${corto(c.antes)}`;
		return `↕ ${c.ruta || '(raíz)'} (orden): ${corto(c.antes)} → ${corto(c.despues)}`;
	});
}

export type ResultadoAjuste = {
	slug: string;
	desde: number;
	nueva: number;
	ruta: string;
	creada: boolean;
	hallazgos: Hallazgo[];
	cambios: Cambio[];
};

function leerJson(ruta: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(`leer ${basename(ruta)}`, 'no es JSON válido', `corrige ${relative(RAIZ, ruta)} y vuelve a correr ajustar.ts`, 2, error);
	}
}

/** Deja un archivo de solo lectura (444). No falla si no se puede: solo es una protección extra. */
function soloLectura(ruta: string): boolean {
	try {
		chmodSync(ruta, statSync(ruta).mode & 0o444);
		return true;
	} catch {
		return false;
	}
}

export function ajustar(op: {slug: string; desde?: number; proyectos?: string}): ResultadoAjuste {
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const slug = validarSlug(op.slug);
	const dir = dirProyecto(slug, proyectos);
	if (!existsSync(dir)) throw fallo(`ajustar ${slug}`, `no existe proyectos/${slug}`, 'revisa el slug (la carpeta de proyectos/)', 2);
	const desde = elegirVersion(dir, op.desde);
	const nueva = desde + 1;
	const rutaDesde = rutaEdicion(dir, desde);
	const rutaNueva = rutaEdicion(dir, nueva);
	const anterior = leerJson(rutaDesde);

	let creada = false;
	if (!existsSync(rutaNueva)) {
		// 'wx' = nunca sobrescribe: si alguien la creó entre medio, falla en vez de pisarla.
		writeFileSync(rutaNueva, readFileSync(rutaDesde), {flag: 'wx'});
		creada = true;
	}
	soloLectura(rutaDesde);
	const actual = leerJson(rutaNueva);
	const {hallazgos} = validarEdicion(actual);
	return {slug, desde, nueva, ruta: rutaNueva, creada, hallazgos, cambios: diffJson(anterior, actual)};
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({allowPositionals: true, options: {desde: {type: 'string'}, json: {type: 'boolean', default: false}}});
	const slug = positionals[0];
	if (!slug) throw fallo('ajustar', 'falta el slug del proyecto', `usa ${USO}`, 2);
	const desde = values.desde === undefined ? undefined : Number(values.desde);
	if (desde !== undefined && !(Number.isInteger(desde) && desde >= 1)) throw fallo('ajustar', `--desde tiene que ser un entero ≥ 1 (me llegó "${values.desde}")`, `usa ${USO}`, 2);

	const r = ajustar({slug, desde});
	const relNueva = relative(RAIZ, r.ruta);
	if (values.json) {
		console.log(JSON.stringify({desde: r.desde, nueva: r.nueva, creada: r.creada, valida: r.hallazgos.length === 0, hallazgos: r.hallazgos, cambios: r.cambios}, null, '\t'));
	} else {
		if (r.creada) {
			console.log(`Listo: ${relNueva} es una copia de v${r.desde} (v${r.desde} queda de solo lectura).`);
			console.log(`Edita ${relNueva} y vuelve a correr \`npx tsx herramientas/ajustar.ts ${r.slug} --desde ${r.desde}\` para validarla y ver el diff.`);
		}
		if (!r.creada) {
			console.log(`Diff v${r.desde} → v${r.nueva}: ${r.cambios.length} cambio(s)${r.cambios.length === 0 ? ` (todavía no editas ${relNueva})` : ''}`);
			for (const linea of formatearDiff(r.cambios)) console.log(`  ${linea}`);
		}
	}
	if (r.hallazgos.length > 0) {
		if (!values.json) {
			console.log(`✖ ${relNueva}: ${r.hallazgos.length} problema(s)`);
			for (const h of r.hallazgos) console.log(`  - [${h.regla}] ${h.donde}: ${h.detalle}`);
		}
		throw fallo(`validar ${basename(r.ruta)}`, `${r.hallazgos.length} regla(s) no se cumplen`, `corrige ${relNueva} y vuelve a correr ajustar.ts`, 2);
	}
	if (!values.json) console.log(`✔ ${relNueva}: válida`);
}

if (esPrincipal(import.meta.url)) void correr(main);
