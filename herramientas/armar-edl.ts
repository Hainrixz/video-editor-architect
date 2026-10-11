/**
 * armar-edl.ts <slug> — junta lo que ya calcularon las etapas en una edición nueva (edicion-vN.json).
 *
 *   npx tsx herramientas/armar-edl.ts <slug> [--desde-cero]
 *
 * - Base: proyectos/<slug>/base.mp4 (sus cuadros salen de la verificación de la etapa "base" del manifest).
 * - Subtítulos: proyectos/<slug>/subtitulos.json (los subtítulos y el estilo con que se midió su ancho).
 * - Dirección: si existe proyectos/<slug>/direccion.json (lo escribe el director: titular, tarjetas,
 *   stickers, inserts, zooms, efectos, sfx_extra, resaltar_palabras), se copia tal cual.
 * Nunca sobrescribe: escribe la versión siguiente a la más alta que exista y la valida con validar.ts.
 * Sale con 0, 1 o 2 (ver herramientas/lib/fallo.ts).
 */
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EdicionBase, edicionVacia, type Edicion} from '../src/esquema/edicion';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {RAIZ} from './lib/manifest';
import {esSlugValido, REGLA_SLUG} from './lib/slug';
import {validarEdicion} from './validar';

const USO = 'npx tsx herramientas/armar-edl.ts <slug>';

/** Campos que puede traer direccion.json; lo demás se ignora. */
const CAMPOS_DIRECCION = ['titular', 'tarjetas', 'stickers', 'inserts', 'zooms', 'efectos', 'sfx_extra', 'resaltar_palabras'] as const;

export function versionesExistentes(dir: string): number[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => /^edicion-v(\d+)\.json$/.exec(n)?.[1])
		.filter((v): v is string => v !== undefined)
		.map(Number)
		.sort((a, b) => a - b);
}

function leerJson(ruta: string, que: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${ruta} no es JSON válido`, 'vuelve a correr la etapa que lo genera', 2, error);
	}
}

/** Arma la edición a partir de los archivos del proyecto (sin escribir nada). */
export function armarEdicion(slug: string, dirProyecto: string): Edicion {
	const rutaManifest = join(dirProyecto, 'manifest.json');
	if (!existsSync(join(dirProyecto, 'base.mp4')) || !existsSync(rutaManifest)) {
		throw fallo('armar la edición', `falta proyectos/${slug}/base.mp4`, 'corre primero cortes.ts y base.ts', 2);
	}
	const manifest = leerJson(rutaManifest, 'leer el manifest') as {etapas?: {base?: {verificacion?: {cuadros?: number}}}};
	const cuadros = manifest.etapas?.base?.verificacion?.cuadros;
	if (typeof cuadros !== 'number' || cuadros <= 0) {
		throw fallo('armar la edición', 'el manifest no trae los cuadros verificados de la base', `vuelve a correr base.ts ${slug}`, 2);
	}
	const edicion: Record<string, unknown> = {
		...edicionVacia,
		estilo_version: '0.1.0',
		estilo_hash: 'mini-estilo',
		base: `p/${slug}/base.mp4`,
		duracion_s: Math.round((cuadros / 30) * 1e6) / 1e6,
	};
	const rutaSubs = join(dirProyecto, 'subtitulos.json');
	if (existsSync(rutaSubs)) {
		const subs = leerJson(rutaSubs, 'leer los subtítulos') as {subtitulos?: unknown; estilo?: Record<string, unknown>};
		edicion.subtitulos = subs.subtitulos ?? [];
		if (subs.estilo) edicion.estilos = {subtitulos: subs.estilo};
	}
	const rutaDireccion = join(dirProyecto, 'direccion.json');
	if (existsSync(rutaDireccion)) {
		const direccion = leerJson(rutaDireccion, 'leer la dirección') as Record<string, unknown>;
		for (const campo of CAMPOS_DIRECCION) if (direccion[campo] !== undefined) edicion[campo] = direccion[campo];
		if (typeof direccion.estilo_version === 'string') edicion.estilo_version = direccion.estilo_version;
		if (typeof direccion.estilo_hash === 'string') edicion.estilo_hash = direccion.estilo_hash;
		if (direccion.estilos && typeof direccion.estilos === 'object') {
			edicion.estilos = {...(edicion.estilos as object), ...(direccion.estilos as object)};
		}
	}
	const r = EdicionBase.safeParse(edicion);
	if (!r.success) {
		const detalle = r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
		throw fallo('armar la edición', `lo que juntaron las etapas no cumple el contrato (${detalle})`, 'revisa subtitulos.json y direccion.json', 2);
	}
	return r.data;
}

async function main(): Promise<void> {
	const slug = process.argv.slice(2).find((a) => !a.startsWith('--'));
	if (!slug) throw fallo('armar la edición', 'falta el slug', `corre ${USO}`, 2);
	if (!esSlugValido(slug)) throw fallo('armar la edición', `"${slug}" no es un slug válido`, `usa ${REGLA_SLUG}`, 2);
	const dir = join(RAIZ, 'proyectos', slug);
	const edicion = armarEdicion(slug, dir);
	const {hallazgos} = validarEdicion(edicion);
	if (hallazgos.length > 0) {
		for (const h of hallazgos) console.log(`  - [${h.regla}] ${h.donde}: ${h.detalle}`);
		throw fallo('armar la edición', `${hallazgos.length} regla(s) no se cumplen`, 'corrige lo de arriba y vuelve a armar', 2);
	}
	const version = (versionesExistentes(dir).at(-1) ?? 0) + 1;
	const ruta = join(dir, `edicion-v${version}.json`);
	writeFileSync(ruta, `${JSON.stringify(edicion, null, '\t')}\n`, {flag: 'wx'});
	console.log(
		`Edición lista: proyectos/${slug}/edicion-v${version}.json · ${edicion.duracion_s.toFixed(2)} s · ${edicion.subtitulos.length} subtítulos · ${edicion.tarjetas.length} tarjetas · ${edicion.stickers.length} stickers · ${edicion.inserts.length} inserts`,
	);
}

if (esPrincipal(import.meta.url)) void correr(main);
