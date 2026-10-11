/**
 * Encuadre automático de la base de un proyecto (estático, todo el video) → proyectos/<slug>/encuadre.json.
 *
 *   npx tsx herramientas/encuadre.ts <slug> [--objetivo estilo/encuadre.json] [--escala-max 1.35] [--aplicar]
 *
 * --escala-max baja el tope de acercamiento (entre 1 y 1.35). Medido en pruebas/integracion/f6-encuadre.ts:
 * recortar el 4K pierde nitidez por pixel al acercar (ver out/f6-encuadre/reporte.json → mecanismo.curva).
 *
 * Lee la cara de la base (proyectos/<slug>/cara.json, de herramientas/cara.ts) y el objetivo medido en tus reels
 * (estilo/encuadre.json) y calcula cuánto acercar y cómo mover la toma (herramientas/lib/encuadre.ts):
 *   s = clamp(alto de cara objetivo / alto de cara de la base, 1, 1.35); la barbilla mediana a la barbilla objetivo
 *   y el centro x de la cara a 540, sin salirse del cuadro (sin bordes negros). Nunca aleja.
 * Escribe el recorte en px del ORIGINAL (cuadro visible, ya rotado) y lo registra como etapa "encuadre" del
 * manifest. Si la base ya tenía un encuadre, la cara se lleva a la base sin encuadre antes de calcular: el resultado
 * siempre es respecto al original (volver a correrlo no acumula zoom).
 *
 * --aplicar: regenera la base con ese encuadre (base.ts con los mismos cortes; si los tramos no salen iguales a los
 * de la base anterior, no toca nada y sale con 2). Después hay que volver a medir la cara sobre la base nueva:
 *   base → cara → encuadre → base --encuadre → cara
 * (cara.ts usa Vision: va solo en su llamada de Bash). encuadre.ts no usa Vision y corre dentro del sandbox.
 *
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo (ingesta, base, cara, objetivo) o la cara es de otra base.
 */
import {existsSync, mkdirSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {FPS, formatoDuracion, generarBase, NOMBRE_ENCUADRE, resumenBase, totalCuadros, type ResultadoBase} from './base.ts';
import {leerCara} from './lib/cara.ts';
import {
	archivoEncuadre,
	calcularEncuadre,
	LIMITES_ENCUADRE,
	leerObjetivo,
	medidasDeCara,
	type EncuadreArchivo,
	type Recorte,
	type ResultadoEncuadre,
	type VideoOriginal,
} from './lib/encuadre.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {sondear} from './lib/ffprobe.ts';
import {DIR_PROYECTOS, dirProyecto, hashearArchivo, leerManifest, RAIZ, registrarEtapa, validarSlug, type Manifest} from './lib/manifest.ts';

export const RUTA_OBJETIVO = join(RAIZ, 'estilo', 'encuadre.json');
const USO = 'npx tsx herramientas/encuadre.ts <slug> [--objetivo estilo/encuadre.json] [--escala-max 1.35] [--aplicar]';
/** Debajo de esta cobertura de cara en la base, las medianas salen de pocos cuadros: se avisa. */
const COBERTURA_AVISO = 0.8;

const rel = (ruta: string) => {
	const r = relative(RAIZ, ruta);
	return r.startsWith('..') ? ruta : r;
};

/** Escribe un JSON legible de forma atómica (temporal + rename). */
function escribirJson(ruta: string, datos: unknown): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const temporal = `${ruta}.tmp-${process.pid}`;
	writeFileSync(temporal, `${JSON.stringify(datos, null, '\t')}\n`);
	renameSync(temporal, ruta);
}

/** Recorte con el que se hizo la base actual (manifest → etapas.base.parametros.encuadre), o undefined. */
export function recorteDeLaBase(manifest: Pick<Manifest, 'etapas'>): Recorte | undefined {
	const r = (manifest.etapas.base?.parametros.encuadre as {recorte?: unknown} | undefined)?.recorte;
	if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isInteger(v))) return undefined;
	const [x, y, w, h] = r as number[];
	return {x, y, w, h};
}

/** cortes.json con el que se hizo la base: el que registró base.ts o, en manifests viejos, la entrada .json. */
export function cortesDeLaBase(manifest: Pick<Manifest, 'etapas' | 'original'>): string | null {
	const etapa = manifest.etapas.base;
	if (!etapa) return null;
	const registrado = (etapa as {cortes?: unknown}).cortes;
	if (typeof registrado === 'string') return registrado;
	if (registrado === null) return null;
	return etapa.entradas.find((e) => e.ruta !== manifest.original?.ruta && e.ruta.endsWith('.json'))?.ruta ?? null;
}

export type ResultadoEncuadreProyecto = {
	slug: string;
	salida: string;
	resultado: ResultadoEncuadre;
	archivo: EncuadreArchivo & Record<string, unknown>;
	video: VideoOriginal;
	cobertura: number;
	avisos: string[];
};

/** Calcula el encuadre de un proyecto y escribe proyectos/<slug>/encuadre.json (+ etapa "encuadre"). */
export async function encuadreDeProyecto(slugCrudo: string, op: {objetivo?: string; proyectos?: string; escalaMax?: number} = {}): Promise<ResultadoEncuadreProyecto> {
	const slug = validarSlug(slugCrudo);
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const dir = dirProyecto(slug, proyectos);
	const que = `calcular el encuadre de ${slug}`;
	const escalaMax = op.escalaMax ?? LIMITES_ENCUADRE.escala_max;
	if (!(escalaMax >= LIMITES_ENCUADRE.escala_min && escalaMax <= LIMITES_ENCUADRE.escala_max)) {
		throw fallo(que, `--escala-max tiene que ir de ${LIMITES_ENCUADRE.escala_min} a ${LIMITES_ENCUADRE.escala_max} (llegó ${escalaMax})`, `usa ${USO}`, 2);
	}
	const limites = {escala_min: LIMITES_ENCUADRE.escala_min, escala_max: escalaMax};
	const manifest = leerManifest(slug, proyectos);
	if (!manifest?.original || manifest.etapas.ingesta?.estado !== 'terminada') {
		throw fallo(que, 'ese proyecto todavía no pasa por la ingesta', `corre primero npx tsx herramientas/ingesta.ts <ruta-crudo> --slug ${slug}`, 2);
	}
	const etapaBase = manifest.etapas.base;
	const rutaBase = join(dir, 'base.mp4');
	if (!etapaBase || etapaBase.estado !== 'terminada' || !existsSync(rutaBase)) {
		throw fallo(que, 'ese proyecto todavía no tiene su base.mp4 terminada', `corre antes npx tsx herramientas/base.ts ${slug} --cortes proyectos/${slug}/cortes.json`, 2);
	}
	const etapaCara = manifest.etapas.cara;
	const rutaCara = join(dir, 'cara.json');
	if (!etapaCara || etapaCara.estado !== 'terminada' || !existsSync(rutaCara)) {
		throw fallo(que, 'falta la cara de la base (cara.json)', `córrela con npx tsx herramientas/cara.ts ${slug} (va solo en su llamada de Bash)`, 2);
	}
	// La cara tiene que ser de la base que hay ahora (mismo sha256 y mismo tamaño en disco).
	const salidaBase = etapaBase.salidas[0];
	const caraDeEstaBase = salidaBase && etapaCara.entradas.some((e) => e.sha256 === salidaBase.sha256) && statSync(rutaBase).size === salidaBase.bytes;
	if (!caraDeEstaBase) {
		throw fallo(que, 'cara.json se midió sobre otra base (la base cambió después)', `vuelve a medirla con npx tsx herramientas/cara.ts ${slug} (va solo en su llamada de Bash)`, 2);
	}
	const original = manifest.original.ruta;
	if (!existsSync(original)) {
		throw fallo(que, `ya no encuentro el original en ${original}`, 'regrésalo a esa ruta o vuelve a correr la ingesta con la nueva', 2);
	}

	const cara = leerCara(rutaCara);
	const medidas = medidasDeCara(cara);
	if (!medidas) throw fallo(que, 'Vision no vio tu cara en ningún cuadro de la base', 'revisa la base; sin cara no hay encuadre (la base se queda como está)', 2);
	const cobertura = cara.cuadros.length ? medidas.n / cara.cuadros.length : 0;

	const rutaObjetivo = resolve(op.objetivo ?? RUTA_OBJETIVO);
	const objetivo = leerObjetivo(rutaObjetivo);
	const sondeo = await sondear(original);
	const video: VideoOriginal = {
		ancho: sondeo.video.ancho,
		alto: sondeo.video.alto,
		rotacion: sondeo.video.rotacion,
		ancho_visible: sondeo.video.anchoVisible,
		alto_visible: sondeo.video.altoVisible,
	};
	const recorteActual = recorteDeLaBase(manifest);
	const resultado = calcularEncuadre({medidas, objetivo: objetivo.objetivo, video, recorteActual, limites});

	const avisos = [...resultado.avisos];
	if (cobertura < COBERTURA_AVISO) avisos.push(`solo hay cara en el ${(cobertura * 100).toFixed(1)} % de la base: las medianas salen de ${medidas.n} cuadros`);
	const huellaCara = await hashearArchivo(rutaCara);
	const huellaObjetivo = await hashearArchivo(rutaObjetivo);
	const archivo = archivoEncuadre(resultado, {
		slug,
		video: {...video, ruta: original},
		fuente: {
			cara: rel(rutaCara),
			cara_sha256: huellaCara.sha256,
			base_sha256: salidaBase.sha256,
			cara_cuadros: medidas.n,
			cara_cobertura: Math.round(cobertura * 10000) / 10000,
			base_con_encuadre: recorteActual ?? null,
			objetivo: rel(rutaObjetivo),
			objetivo_sha256: huellaObjetivo.sha256,
			n_reels: objetivo.n_reels,
			objetivo_rango: {
				barbilla_y: [objetivo.barbilla_y.p10, objetivo.barbilla_y.p90],
				alto_cara: [objetivo.alto_cara.p10, objetivo.alto_cara.p90],
			},
		},
	});
	(archivo.original as Record<string, unknown>).sha256 = manifest.original.sha256;
	archivo.avisos = avisos;
	archivo.limites = {...LIMITES_ENCUADRE, ...limites};

	const salida = join(dir, NOMBRE_ENCUADRE);
	escribirJson(salida, archivo);
	registrarEtapa(
		slug,
		'encuadre',
		{
			estado: 'terminada',
			entradas: [huellaCara, huellaObjetivo],
			parametros: {version: 1, limites: {...LIMITES_ENCUADRE, ...limites}, recorte_base: recorteActual ?? null},
			salidas: [await hashearArchivo(salida, dir)],
			extra: {escala: resultado.escala, escala_pedida: resultado.escala_pedida, recorte: resultado.recorte, identidad: resultado.identidad},
		},
		proyectos,
	);
	return {slug, salida, resultado, archivo, video, cobertura, avisos};
}

/** Regenera la base con el encuadre (mismos cortes y mismos tramos que la base anterior). */
export async function aplicarEncuadre(
	slug: string,
	op: {proyectos?: string; alProgreso?: (fraccion: number) => void; alEmpezar?: Parameters<typeof generarBase>[0]['alEmpezar']} = {},
): Promise<ResultadoBase> {
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const manifest = leerManifest(slug, proyectos);
	const etapaBase = manifest?.etapas.base;
	if (!manifest || !etapaBase) throw fallo(`aplicar el encuadre de ${slug}`, 'ese proyecto no tiene base', `corre antes npx tsx herramientas/base.ts ${slug}`, 2);
	const cortes = cortesDeLaBase(manifest);
	if (cortes && !existsSync(cortes)) {
		throw fallo(`aplicar el encuadre de ${slug}`, `la base se hizo con ${cortes} y ya no existe`, `corre tú npx tsx herramientas/base.ts ${slug} --cortes <cortes.json> --encuadre proyectos/${slug}/encuadre.json`, 2);
	}
	const tramos = etapaBase.parametros.tramos_cuadros as Array<[number, number]> | undefined;
	return generarBase({
		slug,
		cortes: cortes ?? undefined,
		encuadre: join(dirProyecto(slug, proyectos), NOMBRE_ENCUADRE),
		tramosEsperados: Array.isArray(tramos) ? tramos : undefined,
		velocidad: typeof etapaBase.parametros.velocidad === 'number' ? etapaBase.parametros.velocidad : undefined,
		proyectos,
		alProgreso: op.alProgreso,
		alEmpezar: op.alEmpezar,
	});
}

const px = (v: number | null) => (v === null ? 'N/A' : `${Math.round(v)} px`);

/** Resumen en español para la terminal. */
export function resumenEncuadre(r: ResultadoEncuadreProyecto): string {
	const e = r.resultado;
	const o = e.objetivo;
	const rango = (r.archivo.fuente as {objetivo_rango?: {barbilla_y: [number | null, number | null]; alto_cara: [number | null, number | null]}; n_reels?: number}) ?? {};
	const n = rango.n_reels ?? '?';
	const lineas = [`Encuadre listo: ${rel(r.salida)}`];
	const max = (r.archivo.limites as {escala_max?: number} | undefined)?.escala_max ?? LIMITES_ENCUADRE.escala_max;
	const porque = e.limite_escala === 'min' ? ' (tu cara ya es igual o más grande que el objetivo: nunca alejo)' : e.limite_escala === 'max' ? ` (pedía ×${e.escala_pedida.toFixed(2)}; el máximo es ×${max})` : '';
	lineas.push(`  escala ×${e.escala.toFixed(3)}${porque} · efectiva ×${e.escala_efectiva.toFixed(3)}`);
	lineas.push(
		`  barbilla ${px(e.antes.barbilla_y)} → ${px(e.despues.barbilla_y)} (objetivo ${px(o.barbilla_y)}, n = ${n} reels${rango.objetivo_rango ? `, p10–p90 ${px(rango.objetivo_rango.barbilla_y[0])}–${px(rango.objetivo_rango.barbilla_y[1])}` : ''})`,
	);
	lineas.push(
		`  alto de cara ${px(e.antes.alto_cara)} → ${px(e.despues.alto_cara)} (objetivo ${px(o.alto_cara)}${rango.objetivo_rango ? `, p10–p90 ${px(rango.objetivo_rango.alto_cara[0])}–${px(rango.objetivo_rango.alto_cara[1])}` : ''}) · centro x ${px(e.antes.centro_x)} → ${px(e.despues.centro_x)} · coronilla ${px(e.antes.coronilla_y)} → ${px(e.despues.coronilla_y)}`,
	);
	const v = r.video;
	const recorte = `${e.recorte.w}×${e.recorte.h} en x=${e.recorte.x}, y=${e.recorte.y}`;
	lineas.push(
		e.identidad
			? `  recorte: el cuadro completo del original (${v.ancho_visible}×${v.alto_visible}): base.ts no cambia nada`
			: `  recorte del original (${v.ancho_visible}×${v.alto_visible}${v.rotacion ? `, rotado ${v.rotacion}°` : ''}): ${recorte}`,
	);
	for (const a of r.avisos) lineas.push(`  Ojo: ${a}.`);
	return lineas.join('\n');
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				objetivo: {type: 'string'},
				'escala-max': {type: 'string'},
				aplicar: {type: 'boolean', default: false},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error);
		const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
		throw fallo('leer los argumentos', desconocida ? `no conozco la opción ${desconocida[1]}` : 'los argumentos no tienen la forma esperada', `usa ${USO}`, 2, mensaje);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	if (posicionales.length !== 1) {
		throw fallo('leer los argumentos', posicionales.length === 0 ? 'falta el slug del proyecto' : 'me pasaste más de un slug', `usa ${USO}`, 2);
	}
	const slug = posicionales[0];
	const textoMax = valores['escala-max'];
	const escalaMax = textoMax === undefined ? undefined : Number(textoMax);
	if (textoMax !== undefined && (textoMax.trim() === '' || !Number.isFinite(escalaMax))) {
		throw fallo('leer los argumentos', `--escala-max tiene que ser un número de ${LIMITES_ENCUADRE.escala_min} a ${LIMITES_ENCUADRE.escala_max} (llegó "${textoMax}")`, `usa ${USO}`, 2);
	}
	const r = await encuadreDeProyecto(slug, {objetivo: valores.objetivo, escalaMax});
	console.log(resumenEncuadre(r));
	if (!valores.aplicar) {
		console.log(`Siguiente paso: npx tsx herramientas/encuadre.ts ${slug} --aplicar (o base.ts ${slug} …, que ya lo toma solo) y luego npx tsx herramientas/cara.ts ${slug}.`);
		return;
	}
	let siguiente = 0.2;
	const base = await aplicarEncuadre(slug, {
		alEmpezar: (tramos) => console.log(`Regenerando la base de ${slug} con el encuadre: ${tramos.length} tramos, ${(totalCuadros(tramos) / FPS).toFixed(2)} s…`),
		alProgreso: (fraccion) => {
			while (fraccion >= siguiente - 1e-9 && siguiente < 1 - 1e-9) {
				console.log(`  … ${Math.round(siguiente * 100)} %`);
				siguiente += 0.2;
			}
		},
	});
	console.log(resumenBase(base));
	if (base.reutilizada) {
		console.log(`La base ya tenía este encuadre (${formatoDuracion(base.segundos)}); la cara de antes sigue valiendo.`);
	} else {
		console.log(`Siguiente paso: mide la cara en la base nueva con npx tsx herramientas/cara.ts ${slug} (va solo en su llamada de Bash).`);
	}
}

if (esPrincipal(import.meta.url)) await correr(main);
