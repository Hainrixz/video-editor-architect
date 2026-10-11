/**
 * Manifest de cada proyecto: proyectos/<slug>/manifest.json.
 *
 * Guarda, por etapa (ingesta, base, transcripción…):
 *   { estado, entradas: [{ruta, sha256, bytes}], parametros, parametros_sha256, salidas: [{ruta, sha256, bytes}], terminado_en }
 * Las rutas de `entradas` son absolutas (el original vive fuera del proyecto); las de `salidas`, relativas a
 * proyectos/<slug>/.
 *
 * `etapaVigente()` dice si una etapa se puede saltar: terminó, sus entradas tienen el mismo sha256, sus
 * parámetros son los mismos y sus salidas siguen en su lugar con el mismo tamaño. Así se reintenta sin
 * rehacer trabajo ni volver a gastar. Si algo de lo que dependía cambió, deja de estar vigente sola.
 *
 * El sha256 se calcula por streaming (no carga el archivo a memoria) y nunca escribe en el original.
 */
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {fallo} from './fallo.ts';
import {esSlugValido} from './slug';

/** Raíz del proyecto (dos niveles arriba de herramientas/lib/). */
export const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
export const DIR_PROYECTOS = join(RAIZ, 'proyectos');

/** proyectos/_logs lo usa fallo.ts para su bitácora. */
const PATRON_SHA256 = /^[0-9a-f]{64}$/;

export const ArchivoHashEsquema = z.looseObject({
	ruta: z.string().min(1),
	sha256: z.string().regex(PATRON_SHA256),
	bytes: z.number().int().nonnegative().optional(),
});
export type ArchivoHash = z.infer<typeof ArchivoHashEsquema>;

export const EstadoEtapaEsquema = z.enum(['en-curso', 'terminada', 'fallida']);
export type EstadoEtapa = z.infer<typeof EstadoEtapaEsquema>;

export const EtapaEsquema = z.looseObject({
	estado: EstadoEtapaEsquema,
	entradas: z.array(ArchivoHashEsquema),
	parametros: z.record(z.string(), z.unknown()),
	parametros_sha256: z.string().regex(PATRON_SHA256),
	salidas: z.array(ArchivoHashEsquema),
	terminado_en: z.string().nullable(),
});
export type Etapa = z.infer<typeof EtapaEsquema>;

export const OriginalEsquema = z.looseObject({
	ruta: z.string().min(1),
	sha256: z.string().regex(PATRON_SHA256),
	tamano_bytes: z.number().int().nonnegative(),
	mtime: z.string(),
});
export type HuellaOriginal = z.infer<typeof OriginalEsquema>;

export const ManifestEsquema = z.looseObject({
	version: z.literal(1),
	slug: z.string().min(1),
	creado_en: z.string(),
	actualizado_en: z.string(),
	original: OriginalEsquema.optional(),
	etapas: z.record(z.string(), EtapaEsquema),
});
export type Manifest = z.infer<typeof ManifestEsquema>;

/** Valida un slug (AAAA-MM-DD-tema, o `_prueba-…` para pruebas) y lo devuelve tal cual. */
export function validarSlug(slug: string): string {
	if (!esSlugValido(slug)) {
		throw fallo(
			`usar el slug "${slug}"`,
			'solo acepto minúsculas, números, guion y guion bajo (máx. 80 caracteres, sin espacios ni barras)',
			'usa algo como 2026-10-03-claude-code',
			2,
		);
	}
	return slug;
}

export function dirProyecto(slug: string, proyectos = DIR_PROYECTOS): string {
	return join(proyectos, validarSlug(slug));
}

export function rutaManifest(slug: string, proyectos = DIR_PROYECTOS): string {
	return join(dirProyecto(slug, proyectos), 'manifest.json');
}

/**
 * Ruta absoluta para una salida dentro de proyectos/<slug>/. Falla (código 1) si cae fuera del proyecto
 * o si es el mismo archivo que el original: ningún ffmpeg puede escribir sobre un crudo tuyo.
 */
export function rutaSalidaSegura(slug: string, nombre: string, original: string, proyectos = DIR_PROYECTOS): string {
	const dir = resolve(dirProyecto(slug, proyectos));
	const salida = resolve(dir, nombre);
	const real = (ruta: string): string => {
		try {
			return realpathSync(ruta);
		} catch {
			return resolve(ruta);
		}
	};
	const originalReal = real(original);
	if (!salida.startsWith(dir + sep) || salida === resolve(original) || real(salida) === originalReal) {
		throw fallo(
			'preparar la salida',
			`${salida} cae fuera de ${dir} o apunta al original`,
			'revisa proyectos/_logs/fallos.log y avísame',
			1,
			{salida, original},
		);
	}
	return salida;
}

export function nuevoManifest(slug: string): Manifest {
	const ahora = new Date().toISOString();
	return {version: 1, slug: validarSlug(slug), creado_en: ahora, actualizado_en: ahora, etapas: {}};
}

/** Lee proyectos/<slug>/manifest.json; null si todavía no existe. */
export function leerManifest(slug: string, proyectos = DIR_PROYECTOS): Manifest | null {
	const ruta = rutaManifest(slug, proyectos);
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(`leer el manifest de ${slug}`, 'no es JSON válido', `revisa ${ruta} o usa otro --slug`, 1, error);
	}
	const r = ManifestEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(
			`leer el manifest de ${slug}`,
			`no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`,
			`revisa ${ruta} o usa otro --slug`,
			1,
			r.error.issues,
		);
	}
	return r.data;
}

/** Escribe el manifest de forma atómica (archivo temporal + rename), así nunca queda a medias. */
export function escribirManifest(manifest: Manifest, proyectos = DIR_PROYECTOS): void {
	const ruta = rutaManifest(manifest.slug, proyectos);
	mkdirSync(dirname(ruta), {recursive: true});
	const temporal = `${ruta}.tmp-${process.pid}`;
	writeFileSync(temporal, `${JSON.stringify(manifest, null, '\t')}\n`);
	renameSync(temporal, ruta);
}

/** Lee (o crea) el manifest, le aplica el cambio y lo guarda. */
export function actualizarManifest(slug: string, cambio: (m: Manifest) => void, proyectos = DIR_PROYECTOS): Manifest {
	const manifest = leerManifest(slug, proyectos) ?? nuevoManifest(slug);
	cambio(manifest);
	manifest.actualizado_en = new Date().toISOString();
	escribirManifest(manifest, proyectos);
	return manifest;
}

/** sha256 de un archivo por streaming (bloques de 4 MB). Solo lee. */
export async function sha256Archivo(ruta: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const trozo of createReadStream(ruta, {highWaterMark: 4 * 1024 * 1024})) {
		hash.update(trozo as Buffer);
	}
	return hash.digest('hex');
}

/** {ruta, sha256, bytes}. Con `relativaA`, la ruta queda relativa a esa carpeta (para las salidas). */
export async function hashearArchivo(ruta: string, relativaA?: string): Promise<ArchivoHash> {
	const absoluta = resolve(ruta);
	const sha256 = await sha256Archivo(absoluta);
	const bytes = statSync(absoluta).size;
	return {ruta: relativaA ? relative(relativaA, absoluta) : absoluta, sha256, bytes};
}

/** Huella del original para el manifest: ruta, sha256, tamaño y mtime. No lo copia ni lo modifica. */
export async function huellaOriginal(ruta: string): Promise<HuellaOriginal> {
	const absoluta = resolve(ruta);
	const datos = statSync(absoluta);
	const sha256 = await sha256Archivo(absoluta);
	return {ruta: absoluta, sha256, tamano_bytes: datos.size, mtime: datos.mtime.toISOString()};
}

/** JSON con llaves ordenadas: el mismo objeto da siempre el mismo texto (y el mismo hash). */
export function jsonCanonico(valor: unknown): string {
	if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? 'null' : jsonCanonico(v))).join(',')}]`;
	if (valor !== null && typeof valor === 'object') {
		const objeto = valor as Record<string, unknown>;
		const llaves = Object.keys(objeto)
			.filter((k) => objeto[k] !== undefined)
			.sort();
		return `{${llaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(objeto[k])}`).join(',')}}`;
	}
	return JSON.stringify(valor) ?? 'null';
}

export function hashParametros(parametros: Record<string, unknown>): string {
	return createHash('sha256').update(jsonCanonico(parametros)).digest('hex');
}

/** Una entrada puede venir ya hasheada ({ruta, sha256}) o como ruta (se hashea aquí). */
export type EntradaEtapa = string | ArchivoHash;

export async function hashearEntradas(entradas: EntradaEtapa[]): Promise<ArchivoHash[]> {
	return Promise.all(entradas.map((e) => (typeof e === 'string' ? hashearArchivo(e) : e)));
}

/**
 * ¿La etapa ya está hecha con estas mismas entradas y parámetros?
 * true solo si: estado "terminada", mismos sha256 de entradas (sin importar el orden ni la ruta),
 * mismo hash de parámetros y todas sus salidas existen con el tamaño registrado.
 */
export async function etapaVigente(
	slug: string,
	etapa: string,
	entradas: EntradaEtapa[],
	parametros: Record<string, unknown>,
	proyectos = DIR_PROYECTOS,
): Promise<boolean> {
	const registro = leerManifest(slug, proyectos)?.etapas[etapa];
	if (!registro || registro.estado !== 'terminada') return false;
	if (registro.parametros_sha256 !== hashParametros(parametros)) return false;

	let actuales: ArchivoHash[];
	try {
		actuales = await hashearEntradas(entradas);
	} catch {
		return false; // una entrada ya no existe o no se puede leer
	}
	const antes = registro.entradas.map((e) => e.sha256).sort();
	const ahora = actuales.map((e) => e.sha256).sort();
	if (antes.length !== ahora.length || antes.some((h, i) => h !== ahora[i])) return false;

	const dir = dirProyecto(slug, proyectos);
	return registro.salidas.every((s) => {
		try {
			const datos = statSync(isAbsolute(s.ruta) ? s.ruta : join(dir, s.ruta));
			return datos.isFile() && (s.bytes === undefined || datos.size === s.bytes);
		} catch {
			return false;
		}
	});
}

export type DatosEtapa = {
	estado: EstadoEtapa;
	entradas: ArchivoHash[];
	parametros: Record<string, unknown>;
	salidas?: ArchivoHash[];
	/** Datos extra de la etapa (verificación, tiempos…). No cuentan para la vigencia. */
	extra?: Record<string, unknown>;
};

const CAMPOS_ETAPA = new Set(['estado', 'entradas', 'parametros', 'parametros_sha256', 'salidas', 'terminado_en']);

/** Registra (o reemplaza) una etapa en el manifest. `terminado_en` se pone solo si terminó. */
export function registrarEtapa(slug: string, nombre: string, datos: DatosEtapa, proyectos = DIR_PROYECTOS): Etapa {
	const extra = Object.fromEntries(Object.entries(datos.extra ?? {}).filter(([llave]) => !CAMPOS_ETAPA.has(llave)));
	const etapa: Etapa = {
		estado: datos.estado,
		entradas: datos.entradas,
		parametros: datos.parametros,
		parametros_sha256: hashParametros(datos.parametros),
		salidas: datos.salidas ?? [],
		terminado_en: datos.estado === 'terminada' ? new Date().toISOString() : null,
		...extra,
	};
	actualizarManifest(
		slug,
		(m) => {
			m.etapas[nombre] = etapa;
		},
		proyectos,
	);
	return etapa;
}
