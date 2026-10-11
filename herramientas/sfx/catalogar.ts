/**
 * Arma la biblioteca de SFX del editor.
 *
 *   npx tsx herramientas/sfx/catalogar.ts [--pixabay <carpeta>] [--propios <carpeta>] [--cache <carpeta>] [--sin-red]
 *   npx tsx herramientas/sfx/catalogar.ts --aprobar-pop=1,4,7      (lo que el creador aprobó al escuchar la hoja)
 *   npx tsx herramientas/sfx/catalogar.ts --aprobar-pop=ninguno
 *   npx tsx herramientas/sfx/catalogar.ts --solo-revisar           (revisa catálogo y archivos sin regenerar)
 *
 * Fuentes (todas se leen sin modificarse):
 *   (a) Pixabay: los SFX de la carpeta de creador.json → sfx.pixabay o --pixabay (Pixabay Content
 *       License según su CREDITS.md). Los pares idénticos se detectan por sha256 del audio decodificado.
 *   (b) Kenney (CC0): Interface Sounds, UI Audio, Impact Sounds y Sci-fi Sounds, bajados de kenney.nl a
 *       out/f3-sfx/cache/ y verificados contra su sha256. Sus drop/pluck/tick cuentan como "pop" solo si
 *       el creador los aprueba escuchando out/f3-sfx/hoja-pop.wav; hasta entonces quedan pendientes y el
 *       selector no los usa.
 *   (c) Síntesis propia (herramientas/sfx/sintesis.ts): 2 recetas por categoría.
 *   (d) Los tuyos: los audios de la carpeta de biblioteca/sfx/seleccion.json (tuyos o con licencia de uso; --propios
 *       cambia la carpeta), con la categoría que dice ese archivo. Los que no estén en la selección se reportan y no entran.
 *
 * Cada archivo de la biblioteca: WAV estéreo de 48 kHz, 16 bits, sin silencio inicial (el ataque arranca
 * en los primeros 2 ms) y con el pico real en −1 dBTP (medido con ebur128). Más dos variantes de ±1
 * semitono (asetrate + aresample) marcadas como variante de la misma fuente.
 *
 * Salidas: biblioteca/sfx/<categoria>/*.wav (no se versionan), biblioteca/sfx/catalogo.json,
 * biblioteca/sfx/aprobaciones.json, biblioteca/licencias/sfx.md, out/f3-sfx/hoja-pop.{wav,json}.
 * Solo borra WAV que ella misma creó en una corrida anterior (los que lista el catálogo viejo).
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, join, relative, resolve} from 'node:path';
import {z} from 'zod';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {expandirRuta, leerCreador} from '../lib/creador.ts';
import {RAIZ} from '../lib/manifest.ts';
import {
	agruparCasiIguales,
	APROBACIONES_INICIALES,
	AprobacionesEsquema,
	ataqueMs,
	CATEGORIAS_SFX,
	CatalogoEsquema,
	contarFuentes,
	decodificar,
	dbALineal,
	duracionDe,
	escribirJson,
	escribirWav,
	huella,
	inicioMs,
	mapearEventos,
	medirSonoridad,
	muestrasDe,
	picoMuestra,
	PICO_OBJETIVO_DBTP,
	prepararSfx,
	problemasDelCatalogo,
	rasgosEspectrales,
	redondear,
	REGLAS_SFX,
	RUTA_APROBACIONES,
	RUTA_CATALOGO,
	sha256AudioDecodificado,
	sha256DeArchivo,
	similitudHuellas,
	TASA_SFX,
	TIPOS_EVENTO,
	aEstereo,
	aplicarGanancia,
	linealADb,
	MAPEO_SUPUESTO,
	mapeoDesdeEstilo,
	RUTA_ESTILO,
	type Aprobacion,
	type Aprobaciones,
	type ArchivoSfx,
	type Audio,
	type Catalogo,
	type ConteoCategoria,
	type FuenteSfx,
	type TipoEvento,
} from '../lib/sfx.ts';
import {RECETAS, sintetizar} from './sintesis.ts';

// ───────────────────────────── Selección curada ─────────────────────────────

/** Carpeta de Pixabay: creador.json → sfx.pixabay (o biblioteca/sfx/_originales/pixabay). --pixabay manda. */
export const DIR_PIXABAY = ((): string => {
	const c = leerCreador();
	return c.sfx.pixabay ? expandirRuta(c.sfx.pixabay) : join(RAIZ, 'biblioteca', 'sfx', '_originales', 'pixabay');
})();
export const DIR_CACHE = join(RAIZ, 'out', 'f3-sfx', 'cache');
export const DIR_SALIDA_PRUEBAS = join(RAIZ, 'out', 'f3-sfx');
export const RUTA_LICENCIAS = join(RAIZ, 'biblioteca', 'licencias', 'sfx.md');
export const DIR_BIBLIOTECA_SFX = join(RAIZ, 'biblioteca', 'sfx');

/** Duración máxima por categoría (s): lo que pase se corta con un fundido de salida. */
export const MAX_DURACION: Record<string, number> = {
	pop: 0.6,
	burbuja: 0.6,
	pluck: 0.8,
	brillo: 1.5,
	blip: 0.6,
	clic: 0.4,
	toque: 0.6,
	whoosh: 1.2,
	impacto: 1.2,
	tecla: 1.2,
	glitch: 1.2,
	especial: 8,
};

type SeleccionPixabay = {categoria: string; recorte?: {desde_s: number; hasta_s: number}; fundidoEntradaMs?: number; nota?: string} | {descartar: string};

/** Qué hace cada archivo de Pixabay (por nombre sin extensión). Los duplicados se resuelven por sha256. */
export const SELECCION_PIXABAY: Record<string, SeleccionPixabay> = {
	pop: {categoria: 'pop'},
	click: {categoria: 'clic'},
	'click-soft': {categoria: 'clic'},
	'key-press': {categoria: 'tecla'},
	typing: {categoria: 'tecla', nota: 'ráfaga de tecleo de ~1 s'},
	sparkle: {categoria: 'brillo'},
	chime: {categoria: 'brillo', nota: 'campanita de 2 s, cortada a 1.5 s con fundido'},
	ping: {categoria: 'brillo'},
	notification: {categoria: 'brillo'},
	whoosh: {categoria: 'whoosh'},
	'whoosh-short': {categoria: 'whoosh'},
	'whoosh-cinematic': {
		categoria: 'whoosh',
		recorte: {desde_s: 2.3, hasta_s: 3.4},
		fundidoEntradaMs: 40,
		nota: 'el original sube 2.5 s; se usa el tramo de 2.3 a 3.4 s (el golpe de aire) con 40 ms de fundido de entrada',
	},
	'impact-bass-1': {categoria: 'impacto', nota: 'grave sostenido de 2 s, cortado a 1.2 s con fundido'},
	'impact-bass-2': {categoria: 'impacto', nota: 'grave sostenido de 2.5 s, cortado a 1.2 s con fundido'},
	'glitch-1': {categoria: 'glitch'},
	'glitch-2': {categoria: 'glitch'},
	'glitch-3': {categoria: 'glitch'},
	error: {descartar: 'tono de error: no encaja con stickers, tarjetas, inserts ni zooms'},
	riser: {descartar: 'subida de 10 s: no cabe en un evento corto'},
};

/**
 * Los Foleys propios del creador: biblioteca/sfx/seleccion.json (datos personales, no se exportan) dice su fuente
 * (el id que va en el catálogo), su carpeta, su licencia y la categoría de cada archivo (por nombre sin extensión).
 * Lo largo o de gag (error, notificación, tecleo) va a "especial", que no entra al mapeo de eventos y se pone a mano en
 * sfx_extra. Sin ese archivo no hay SFX propios.
 */
export const RUTA_SELECCION = join(RAIZ, 'biblioteca', 'sfx', 'seleccion.json');
export const SeleccionPropiaEsquema = z.looseObject({
	fuente: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	carpeta: z.string().min(1),
	licencia: z.string().min(1),
	archivos: z.record(z.string(), z.object({categoria: z.string().min(1), nota: z.string().optional()})),
});
export type SeleccionPropia = z.infer<typeof SeleccionPropiaEsquema>;

/** Lee la selección propia; null si no existe. Mal formada: código 2. */
export function leerSeleccionPropia(ruta = RUTA_SELECCION): SeleccionPropia | null {
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch {
		throw fallo('leer la selección de SFX propios', `${relative(RAIZ, ruta)} no es JSON válido`, 'corrígelo', 2);
	}
	const r = SeleccionPropiaEsquema.safeParse(datos);
	if (!r.success) throw fallo('leer la selección de SFX propios', `${relative(RAIZ, ruta)} no cumple {fuente, carpeta, licencia, archivos}`, 'corrígelo', 2, r.error.issues);
	return r.data;
}

export type PaqueteKenney = 'interface-sounds' | 'ui-audio' | 'impact-sounds' | 'sci-fi-sounds' | 'casino-audio';

/** Zips de Kenney fijados (URL y sha256 del 2026-10-03). Si la URL cambia, se busca en la página del paquete. */
export const PAQUETES_KENNEY: Record<PaqueteKenney, {pagina: string; zip: string; sha256: string; corto: string}> = {
	'interface-sounds': {
		pagina: 'https://kenney.nl/assets/interface-sounds',
		zip: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
		sha256: 'f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232',
		corto: 'interfaz',
	},
	'ui-audio': {
		pagina: 'https://kenney.nl/assets/ui-audio',
		zip: 'https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip',
		sha256: '946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6',
		corto: 'ui',
	},
	'impact-sounds': {
		pagina: 'https://kenney.nl/assets/impact-sounds',
		zip: 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',
		sha256: '029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8',
		corto: 'impactos',
	},
	'sci-fi-sounds': {
		pagina: 'https://kenney.nl/assets/sci-fi-sounds',
		zip: 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip',
		sha256: '119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04',
		corto: 'scifi',
	},
	'casino-audio': {
		pagina: 'https://kenney.nl/assets/casino-audio',
		zip: 'https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip',
		sha256: 'f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18',
		corto: 'casino',
	},
};

type SeleccionKenney = {paquete: PaqueteKenney; archivo: string; categoria: string; requiereAprobacion: 'pop' | null; nota: string | null};

const K = (paquete: PaqueteKenney, categoria: string, archivos: string[], requiereAprobacion: 'pop' | null = null, nota: string | null = null): SeleccionKenney[] =>
	archivos.map((archivo) => ({paquete, archivo, categoria, requiereAprobacion, nota}));

/**
 * Selección de Kenney por categoría. Se eligió mirando espectrogramas y midiendo duración, ataque,
 * centroide y planitud (whoosh = ruido filtrado con ataque rápido; brillo = tonal y agudo; toque = golpe
 * corto con poca cola). Los "open" lentos, las puertas que suben despacio y los paquetes de juego (Digital,
 * Casino, RPG) quedaron fuera.
 */
export const SELECCION_KENNEY: SeleccionKenney[] = [
	...K('interface-sounds', 'pop', ['drop_001', 'drop_002', 'drop_003', 'drop_004', 'pluck_001', 'pluck_002', 'tick_001', 'tick_002', 'tick_004'], 'pop', 'candidato a pop: cuenta solo si el creador lo aprueba al escuchar la hoja'),
	...K('interface-sounds', 'brillo', ['glass_001', 'glass_002', 'glass_004', 'glass_005', 'confirmation_002', 'confirmation_003']),
	...K('impact-sounds', 'brillo', ['impactGlass_light_000', 'impactGlass_light_002', 'impactGlass_light_004', 'impactMetal_light_000', 'impactMetal_light_002', 'impactMetal_light_003']),
	...K('interface-sounds', 'blip', ['toggle_001', 'toggle_002', 'toggle_003', 'toggle_004', 'select_003', 'select_004', 'select_005', 'select_006', 'maximize_007', 'maximize_009', 'back_002', 'back_004']),
	...K('interface-sounds', 'clic', ['click_001', 'click_002', 'click_003', 'click_004', 'click_005', 'select_001', 'select_002', 'select_007', 'select_008']),
	...K('ui-audio', 'clic', ['click1', 'click2', 'click3', 'click4', 'click5', 'mouseclick1', 'mouserelease1']),
	...K('impact-sounds', 'toque', [
		'impactGeneric_light_000',
		'impactGeneric_light_002',
		'impactGeneric_light_004',
		'impactWood_light_000',
		'impactWood_light_002',
		'impactWood_light_004',
		'impactSoft_medium_000',
		'impactSoft_medium_002',
		'impactSoft_medium_004',
		'impactTin_medium_000',
		'impactTin_medium_002',
		'impactTin_medium_004',
		'impactWood_medium_000',
		'impactPlank_medium_000',
	]),
	...K('casino-audio', 'toque', ['chip-lay-1'], null, 'ficha que se apoya: golpecito agudo y seco'),
	...K('interface-sounds', 'whoosh', ['open_001', 'close_001', 'close_002', 'close_003', 'close_004'], null, 'swoosh de interfaz (ruido filtrado que barre)'),
	...K('sci-fi-sounds', 'whoosh', ['doorOpen_000', 'doorOpen_001', 'doorOpen_002'], null, 'swoosh de puerta neumática (ruido con phaser)'),
	...K('impact-sounds', 'impacto', [
		'impactPunch_heavy_000',
		'impactPunch_heavy_002',
		'impactPunch_medium_000',
		'impactPunch_medium_002',
		'impactSoft_heavy_000',
		'impactSoft_heavy_002',
		'impactPlate_heavy_000',
		'impactPlate_heavy_002',
		'impactWood_heavy_000',
		'impactWood_heavy_002',
		'impactMining_000',
	]),
	...K('sci-fi-sounds', 'impacto', ['impactMetal_000', 'impactMetal_001', 'lowFrequency_explosion_001']),
	...K('interface-sounds', 'glitch', ['glitch_001', 'glitch_002', 'glitch_003', 'glitch_004']),
];

export const LICENCIAS = {
	pixabay: 'Pixabay Content License',
	kenney: 'CC0 1.0 (Kenney Vleugels, kenney.nl)',
	sintesis: 'Propia (síntesis de este proyecto, sin terceros)',
} as const;

// ───────────────────────────── Utilidades puras ─────────────────────────────

/** "impactGlass_light_000" → "impact-glass-light-000". */
export function aKebab(nombre: string): string {
	return nombre
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Familia de un archivo de Kenney: el nombre sin el número final ("impactGlass_light_000" → "impactGlass_light"). */
export const familiaKenney = (archivo: string): string => archivo.replace(/[_-]?\d+$/, '');

/** Id de la variante: +1 semitono = "-agudo", −1 = "-grave". */
export const idVariante = (id: string, semitonos: 1 | -1): string => `${id}-${semitonos > 0 ? 'agudo' : 'grave'}`;

/** Número de variante que va en la EDL: 0 original, 1 = +1 semitono, 2 = −1 semitono. */
export const numeroVariante = (semitonos: number): number => (semitonos === 0 ? 0 : semitonos > 0 ? 1 : 2);

/** Acomoda candidatos en una hoja: arranca en 0.5 s y deja 0.5 s entre uno y otro. Pura. */
export function acomodarHoja(duraciones: number[], separacion = 0.5, inicio = 0.5): number[] {
	const t: number[] = [];
	let cursor = inicio;
	for (const d of duraciones) {
		t.push(redondear(cursor, 3));
		cursor += d + separacion;
	}
	return t;
}

/** Interpreta "1,4,7" / "ninguno" / ids contra la lista de candidatos (en el orden de la hoja). Pura. */
export function interpretarAprobacion(texto: string, candidatos: string[]): {aprobados: string[]; rechazados: string[]} {
	const limpio = texto.trim().toLowerCase();
	if (limpio === 'ninguno' || limpio === 'ninguna' || limpio === '') return {aprobados: [], rechazados: [...candidatos]};
	const aprobados = new Set<string>();
	for (const parte of limpio.split(/[,\s]+/).filter(Boolean)) {
		if (/^\d+$/.test(parte)) {
			const n = Number(parte);
			if (n < 1 || n > candidatos.length) {
				throw fallo('registrar tu aprobación', `el número ${n} no está en la hoja (van del 1 al ${candidatos.length})`, 'revisa out/f3-sfx/hoja-pop.json y vuelve a correr con los números de la hoja', 2);
			}
			aprobados.add(candidatos[n - 1]);
		} else if (candidatos.includes(parte)) {
			aprobados.add(parte);
		} else {
			throw fallo('registrar tu aprobación', `"${parte}" no es un número ni un id de la hoja`, 'usa los números de out/f3-sfx/hoja-pop.json, p. ej. --aprobar-pop=1,4,7', 2);
		}
	}
	return {aprobados: candidatos.filter((c) => aprobados.has(c)), rechazados: candidatos.filter((c) => !aprobados.has(c))};
}

// ───────────────────────────── Origen de cada sonido ─────────────────────────────

type Original = {
	id: string;
	fuente: FuenteSfx;
	categoria: string;
	/** Ruta que ffmpeg puede decodificar (original, extraído del zip o WAV de síntesis). */
	ruta: string;
	origen: string;
	url: string | null;
	licencia: string;
	familia: string;
	fuenteIdBase: string;
	sha256_origen: string | null;
	sha256_audio_origen: string | null;
	recorte: {desde_s: number; hasta_s: number} | null;
	fundidoEntradaMs: number;
	requiereAprobacion: 'pop' | null;
	nota: string | null;
};

type Inventario = Record<string, unknown>;

function reunirPixabay(dir: string): {originales: Original[]; inventario: Inventario; descartados: {origen: string; motivo: string}[]} {
	if (!existsSync(dir)) {
		throw fallo('leer los SFX de Pixabay', `no existe ${dir}`, 'revisa la ruta o pásala con --pixabay <carpeta>', 2);
	}
	const creditos = join(dir, 'CREDITS.md');
	const manifest = join(dir, 'manifest.json');
	if (!existsSync(creditos) || !readFileSync(creditos, 'utf8').includes('Pixabay Content License')) {
		throw fallo('leer los SFX de Pixabay', 'falta CREDITS.md o no dice "Pixabay Content License"', 'sin licencia clara no se copian: revisa la carpeta de origen', 2);
	}
	const lista = existsSync(manifest) ? Object.values(JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, {file: string}>).map((x) => x.file) : [];
	const mp3 = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).sort();
	const faltan = lista.filter((f) => !mp3.includes(f));
	if (faltan.length > 0) throw fallo('leer los SFX de Pixabay', `manifest.json lista ${faltan.join(', ')} y no están`, 'revisa la carpeta de origen', 2);

	// Pares idénticos: mismo sha256 del audio decodificado → una sola fuente (se queda el primer nombre).
	const porAudio = new Map<string, string[]>();
	const shaArchivo = new Map<string, string>();
	const shaAudio = new Map<string, string>();
	for (const f of mp3) {
		const ruta = join(dir, f);
		const sa = sha256AudioDecodificado(ruta);
		shaAudio.set(f, sa);
		shaArchivo.set(f, sha256DeArchivo(ruta));
		porAudio.set(sa, [...(porAudio.get(sa) ?? []), f]);
	}
	const identicos = [...porAudio.values()].filter((g) => g.length > 1);
	const originales: Original[] = [];
	const descartados: {origen: string; motivo: string}[] = [];
	for (const grupo of porAudio.values()) {
		// De un par idéntico se queda el nombre más corto ("click" y no "click-soft").
		const [canonico, ...copias] = [...grupo].sort((a, b) => a.length - b.length || a.localeCompare(b));
		const nombre = canonico.replace(/\.mp3$/i, '');
		const sel = SELECCION_PIXABAY[nombre];
		for (const copia of copias) descartados.push({origen: join(dir, copia), motivo: `mismo audio que ${canonico} (sha256 del audio decodificado ${shaAudio.get(copia)!.slice(0, 12)}…): cuenta como una sola fuente`});
		if (!sel) {
			descartados.push({origen: join(dir, canonico), motivo: 'no está en la selección curada de catalogar.ts'});
			continue;
		}
		if ('descartar' in sel) {
			descartados.push({origen: join(dir, canonico), motivo: sel.descartar});
			continue;
		}
		originales.push({
			id: `pixabay-${aKebab(nombre)}`,
			fuente: 'pixabay',
			categoria: sel.categoria,
			ruta: join(dir, canonico),
			origen: join(dir, canonico),
			url: null,
			licencia: LICENCIAS.pixabay,
			familia: `pixabay/${nombre}`,
			fuenteIdBase: `pixabay:${nombre}`,
			sha256_origen: shaArchivo.get(canonico)!,
			sha256_audio_origen: shaAudio.get(canonico)!,
			recorte: sel.recorte ?? null,
			fundidoEntradaMs: sel.fundidoEntradaMs ?? 0,
			requiereAprobacion: null,
			nota: [sel.nota, copias.length ? `idéntico a ${copias.join(', ')}` : null].filter(Boolean).join('; ') || null,
		});
	}
	const inventario = {
		carpeta: dir,
		archivos_mp3: mp3.length,
		distintos_por_audio: porAudio.size,
		identicos: identicos.map((g) => g.slice()),
		creditos_sha256: sha256DeArchivo(creditos),
		manifest_sha256: existsSync(manifest) ? sha256DeArchivo(manifest) : null,
	};
	return {originales, inventario, descartados};
}

function reunirPropios(sel: SeleccionPropia | null, dir: string): {originales: Original[]; inventario: Inventario; descartados: {origen: string; motivo: string}[]} {
	if (!sel || !existsSync(dir)) return {originales: [], inventario: {carpeta: dir, archivos: 0}, descartados: []};
	const audios = readdirSync(dir)
		.filter((f) => /\.(mp3|wav|m4a|aif|aiff)$/i.test(f))
		.sort();
	const originales: Original[] = [];
	const descartados: {origen: string; motivo: string}[] = [];
	for (const f of audios) {
		const nombre = f.replace(/\.[^.]+$/, '');
		const ruta = join(dir, f);
		const elegido = sel.archivos[nombre];
		if (!elegido) {
			descartados.push({origen: ruta, motivo: 'no está en biblioteca/sfx/seleccion.json → archivos: agrégalo con su categoría'});
			continue;
		}
		originales.push({
			id: `${sel.fuente}-${aKebab(nombre)}`,
			fuente: sel.fuente,
			categoria: elegido.categoria,
			ruta,
			origen: ruta,
			url: null,
			licencia: sel.licencia,
			familia: `${sel.fuente}/${aKebab(nombre)}`,
			fuenteIdBase: `${sel.fuente}:${nombre}`,
			sha256_origen: sha256DeArchivo(ruta),
			sha256_audio_origen: sha256AudioDecodificado(ruta),
			recorte: null,
			fundidoEntradaMs: 0,
			requiereAprobacion: null,
			nota: elegido.nota ?? null,
		});
	}
	return {originales, inventario: {carpeta: relative(RAIZ, dir), archivos: audios.length, usados: originales.length}, descartados};
}

function descargar(url: string, destino: string): {ok: boolean; error: string | null} {
	const r = spawnSync('curl', ['-fsSL', '--max-time', '180', '-o', destino, url], {encoding: 'utf8'});
	if (r.error) return {ok: false, error: r.error.message};
	if (r.status !== 0) return {ok: false, error: (r.stderr || `curl salió con ${r.status}`).trim().split('\n').pop() ?? null};
	return {ok: true, error: null};
}

function zipKenney(paquete: PaqueteKenney, cache: string, sinRed: boolean): {ruta: string; sha256: string; avisos: string[]} {
	const p = PAQUETES_KENNEY[paquete];
	mkdirSync(join(cache, 'kenney'), {recursive: true});
	const ruta = join(cache, 'kenney', `kenney_${paquete}.zip`);
	const avisos: string[] = [];
	if (!existsSync(ruta)) {
		if (sinRed) throw fallo(`usar el paquete ${paquete} de Kenney`, `no está en la caché (${ruta}) y pediste --sin-red`, 'corre sin --sin-red para bajarlo de kenney.nl', 2);
		const tmp = `${ruta}.parcial`;
		let r = descargar(p.zip, tmp);
		if (!r.ok) {
			// La URL del zip cambia si Kenney actualiza el paquete: búscala en su página.
			const pagina = join(cache, 'kenney', `${paquete}.html`);
			const rp = descargar(p.pagina, pagina);
			const enlace = rp.ok ? /https:\/\/kenney\.nl\/media\/[^"']+\.zip/.exec(readFileSync(pagina, 'utf8'))?.[0] : undefined;
			if (!enlace) {
				throw fallo(`bajar el paquete ${paquete} de Kenney`, `kenney.nl no respondió (${r.error ?? rp.error})`, 'revisa la red (kenney.nl debe estar permitido en el sandbox) y vuelve a correr', 3, {r, rp});
			}
			avisos.push(`la URL fijada de ${paquete} ya no responde; usé la de su página: ${enlace}`);
			r = descargar(enlace, tmp);
			if (!r.ok) throw fallo(`bajar el paquete ${paquete} de Kenney`, `kenney.nl no respondió (${r.error})`, 'revisa la red y vuelve a correr', 3, r);
		}
		writeFileSync(ruta, readFileSync(tmp));
		rmSync(tmp, {force: true});
	}
	const sha = sha256DeArchivo(ruta);
	if (sha !== p.sha256) avisos.push(`el zip de ${paquete} cambió (sha256 ${sha.slice(0, 12)}…, esperaba ${p.sha256.slice(0, 12)}…): se catalogó lo que trae ahora`);
	return {ruta, sha256: sha, avisos};
}

function extraerDeZip(zip: string, interno: string, destino: string): void {
	const r = spawnSync('unzip', ['-p', zip, interno], {maxBuffer: 1 << 28});
	if (r.error || r.status !== 0 || !r.stdout || r.stdout.length === 0) {
		throw fallo('extraer un SFX de Kenney', `no encontré ${interno} en ${basename(zip)}`, 'borra el zip de out/f3-sfx/cache/kenney y vuelve a correr', 1, {status: r.status, stderr: r.stderr?.toString()});
	}
	writeFileSync(destino, r.stdout);
}

function reunirKenney(cache: string, sinRed: boolean, tmp: string): {originales: Original[]; inventario: Inventario; avisos: string[]} {
	const usados = [...new Set(SELECCION_KENNEY.map((s) => s.paquete))];
	const zips = new Map<PaqueteKenney, {ruta: string; sha256: string}>();
	const avisos: string[] = [];
	const licencias: Record<string, string> = {};
	for (const paquete of usados) {
		const z = zipKenney(paquete, cache, sinRed);
		zips.set(paquete, z);
		avisos.push(...z.avisos);
		const lic = join(tmp, `${paquete}-License.txt`);
		extraerDeZip(z.ruta, 'License.txt', lic);
		const texto = readFileSync(lic, 'utf8');
		if (!/CC0|Creative Commons Zero/i.test(texto)) {
			throw fallo(`usar el paquete ${paquete} de Kenney`, 'su License.txt no dice CC0', 'no se usa sin licencia clara: revisa el zip', 2);
		}
		licencias[paquete] = sha256DeArchivo(lic);
	}
	const originales: Original[] = [];
	for (const s of SELECCION_KENNEY) {
		const p = PAQUETES_KENNEY[s.paquete];
		const z = zips.get(s.paquete)!;
		const interno = `Audio/${s.archivo}.ogg`;
		const ruta = join(tmp, `${s.paquete}-${s.archivo}.ogg`);
		extraerDeZip(z.ruta, interno, ruta);
		originales.push({
			id: `kenney-${p.corto}-${aKebab(s.archivo)}`,
			fuente: 'kenney',
			categoria: s.categoria,
			ruta,
			origen: `${basename(z.ruta)}#${interno}`,
			url: p.pagina,
			licencia: LICENCIAS.kenney,
			familia: `kenney/${s.paquete}/${familiaKenney(s.archivo)}`,
			fuenteIdBase: `kenney:${s.paquete}/${s.archivo}`,
			sha256_origen: sha256DeArchivo(ruta),
			sha256_audio_origen: sha256AudioDecodificado(ruta),
			recorte: null,
			fundidoEntradaMs: 0,
			requiereAprobacion: s.requiereAprobacion,
			nota: s.nota,
		});
	}
	// Duplicados exactos dentro de Kenney (mismo audio decodificado): se queda el primero.
	const vistos = new Map<string, string>();
	const unicos = originales.filter((o) => {
		const previo = vistos.get(o.sha256_audio_origen!);
		if (previo) {
			avisos.push(`${o.id} tiene el mismo audio que ${previo}: se quedó solo ${previo}`);
			return false;
		}
		vistos.set(o.sha256_audio_origen!, o.id);
		return true;
	});
	const inventario = {
		paquetes: Object.fromEntries(
			usados.map((paq) => [
				paq,
				{
					pagina: PAQUETES_KENNEY[paq].pagina,
					zip: basename(zips.get(paq)!.ruta),
					zip_sha256: zips.get(paq)!.sha256,
					license_txt_sha256: licencias[paq],
					archivos_usados: SELECCION_KENNEY.filter((s) => s.paquete === paq).length,
				},
			]),
		),
	};
	return {originales: unicos, inventario, avisos};
}

function reunirSintesis(tmp: string): Original[] {
	return RECETAS.map((r) => {
		const ruta = join(tmp, `sintesis-${r.id}.wav`);
		sintetizar(r, ruta);
		return {
			id: `sintesis-${r.id}`,
			fuente: 'sintesis' as const,
			categoria: r.categoria,
			ruta,
			origen: `receta:${r.id}`,
			url: null,
			licencia: LICENCIAS.sintesis,
			familia: `sintesis/${r.id}`,
			fuenteIdBase: `sintesis:${r.id}`,
			sha256_origen: null,
			sha256_audio_origen: null,
			recorte: null,
			fundidoEntradaMs: 0,
			requiereAprobacion: null,
			nota: r.descripcion,
		};
	});
}

// ───────────────────────────── Normalización ─────────────────────────────

type Procesado = {archivo: Omit<ArchivoSfx, 'fuente_id' | 'aprobacion'>; audio: Audio};

/** Tolerancia del pico real normalizado (dB). */
export const TOLERANCIA_PICO_DB = 0.02;

/** Normaliza al pico real objetivo con ebur128: ajusta, escribe, mide y corrige (hasta 4 pasadas). */
export function normalizarYEscribir(audio: Audio, ruta: string): {audio: Audio; pico_dbtp: number; lufs: number} {
	let ganancia = PICO_OBJETIVO_DBTP - linealADb(picoMuestra(audio));
	let ultimo = NaN;
	for (let intento = 0; intento < 4; intento++) {
		const final = aplicarGanancia(audio, ganancia);
		escribirWav(ruta, final);
		const s = medirSonoridad(ruta);
		ultimo = s.tp_dbtp;
		const exceso = s.tp_dbtp - PICO_OBJETIVO_DBTP;
		if (Math.abs(exceso) <= TOLERANCIA_PICO_DB) {
			return {audio: final, pico_dbtp: redondear(s.tp_dbtp, 3), lufs: redondear(s.m_max, 1)};
		}
		ganancia -= exceso;
	}
	throw fallo('normalizar un SFX', `${basename(ruta)} quedó en ${redondear(ultimo, 2)} dBTP tras 4 pasadas`, 'revisa el archivo de origen y avísame', 1);
}

function procesarAudio(audio: Audio, o: Original, id: string, categoria: string, semitonos: number, varianteDe: string | null): Procesado {
	const ruta = join(DIR_BIBLIOTECA_SFX, categoria, `${id}.wav`);
	const {audio: final, pico_dbtp, lufs} = normalizarYEscribir(audio, ruta);
	return {
		archivo: {
			id,
			archivo: `biblioteca/sfx/${categoria}/${id}.wav`,
			categoria,
			fuente: o.fuente,
			licencia: o.licencia,
			url: o.url,
			duracion_s: redondear(duracionDe(final), 3),
			pico_dbtp,
			lufs,
			ataque_ms: redondear(ataqueMs(final), 2),
			variante_de: varianteDe,
			semitonos,
			sha256: sha256DeArchivo(ruta),
			origen: o.origen,
			sha256_origen: o.sha256_origen,
			sha256_audio_origen: o.sha256_audio_origen,
			familia: o.familia,
			inicio_ms: redondear(inicioMs(final), 3),
			recorte: o.recorte,
			rasgos: rasgosEspectrales(final),
			nota: o.nota,
		},
		audio: final,
	};
}

/** Original preparado → WAV normalizado + sus 2 variantes de ±1 semitono. */
function procesarOriginal(o: Original, categoria: string, tmp: string): {original: Procesado; variantes: Procesado[]} {
	const max = MAX_DURACION[categoria] ?? 1.2;
	const crudo = aEstereo(decodificar(o.ruta, {tasa: TASA_SFX, canales: 2}));
	const preparado = prepararSfx(crudo, {recorte: o.recorte, maxDuracionS: max});
	let audio = preparado.audio;
	if (o.fundidoEntradaMs > 0) {
		const n = Math.round((o.fundidoEntradaMs / 1000) * audio.tasa);
		audio = {tasa: audio.tasa, canales: audio.canales.map((c) => c.map((v, i) => (i < n ? (v * i) / n : v)))};
	}
	const original = procesarAudio(audio, o, o.id, categoria, 0, null);
	// Variantes: el original ya preparado, con asetrate + aresample (cambia tono y duración juntos).
	const base = join(tmp, `${o.id}-base.wav`);
	escribirWav(base, aplicarGanancia(audio, PICO_OBJETIVO_DBTP - linealADb(picoMuestra(audio)) - 3));
	const variantes: Procesado[] = [];
	for (const s of [1, -1] as const) {
		const tasa = Math.round(TASA_SFX * Math.pow(2, s / 12));
		const crudoVar = decodificar(base, {tasa: TASA_SFX, canales: 2, filtros: `asetrate=${tasa},aresample=${TASA_SFX}`});
		const prep = prepararSfx(crudoVar, {maxDuracionS: max});
		variantes.push(procesarAudio(prep.audio, o, idVariante(o.id, s), categoria, s, o.id));
	}
	return {original, variantes};
}

// ───────────────────────────── Hoja de aprobación ─────────────────────────────

export const HOJA_POP = {duracion_s: 10, separacion_s: 0.5, inicio_s: 0.5, lufs_objetivo: -20} as const;

function escribirHojaPop(candidatos: ArchivoSfx[], dirSalida: string): {wav: string; json: string; colocados: {n: number; id: string; t_s: number}[]} {
	const tasa = TASA_SFX;
	const n = Math.round(HOJA_POP.duracion_s * tasa);
	const canales = [new Float32Array(n), new Float32Array(n)];
	const audios = candidatos.map((c) => decodificar(join(RAIZ, c.archivo), {tasa, canales: 2}));
	const tiempos = acomodarHoja(audios.map(duracionDe), HOJA_POP.separacion_s, HOJA_POP.inicio_s);
	const colocados: {n: number; id: string; t_s: number; ganancia_db: number; duracion_s: number}[] = [];
	// Todos al nivel del más bajo (o −20 LUFS si todos pasan de ahí): así se comparan parejo sin pasar de −1 dBTP.
	const objetivo = Math.min(HOJA_POP.lufs_objetivo, ...candidatos.map((c) => c.lufs));
	candidatos.forEach((c, k) => {
		const ganancia = Math.min(0, objetivo - c.lufs);
		const g = dbALineal(ganancia);
		const desde = Math.round(tiempos[k] * tasa);
		const a = audios[k];
		if (desde + muestrasDe(a) > n) {
			throw fallo('armar la hoja de pops', `los ${candidatos.length} candidatos no caben en ${HOJA_POP.duracion_s} s`, 'reduce la lista de candidatos en catalogar.ts', 1);
		}
		for (let ch = 0; ch < 2; ch++) for (let i = 0; i < muestrasDe(a); i++) canales[ch][desde + i] += a.canales[ch][i] * g;
		colocados.push({n: k + 1, id: c.id, t_s: tiempos[k], ganancia_db: redondear(ganancia, 1), duracion_s: c.duracion_s});
	});
	mkdirSync(dirSalida, {recursive: true});
	const wav = join(dirSalida, 'hoja-pop.wav');
	const json = join(dirSalida, 'hoja-pop.json');
	escribirWav(wav, {tasa, canales});
	escribirJson(json, {
		que: 'Candidatos de Kenney a "pop" (drop, pluck y tick). Escúchalos y di cuáles sí suenan a pop para tus stickers.',
		como_aprobar: 'npx tsx herramientas/sfx/catalogar.ts --aprobar-pop=1,4,7   (o --aprobar-pop=ninguno)',
		duracion_s: HOJA_POP.duracion_s,
		separacion_s: HOJA_POP.separacion_s,
		nivel: `cada candidato igualado a ${redondear(objetivo, 1)} LUFS de sonoridad momentánea máxima (el nivel del más bajo; sin pasar de −1 dBTP)`,
		candidatos: colocados,
	});
	return {wav, json, colocados};
}

// ───────────────────────────── Licencias ─────────────────────────────

export function markdownLicencias(cat: Catalogo, sel: SeleccionPropia | null = leerSeleccionPropia()): string {
	const filas = [...cat.archivos]
		.sort((a, b) => a.archivo.localeCompare(b.archivo))
		.map((a) => {
			const origen = a.fuente === 'sintesis' ? `\`${a.origen}\` (herramientas/sfx/sintesis.ts)` : `\`${a.origen.replace(homedir(), '~')}\``;
			const notas = [
				a.variante_de ? `variante ${a.semitonos > 0 ? '+1' : '−1'} semitono de \`${a.variante_de}\`` : null,
				a.aprobacion === 'pendiente' ? 'pendiente de tu aprobación como pop: el selector no lo usa' : null,
				a.aprobacion === 'rechazada' ? 'rechazado como pop: el selector no lo usa' : null,
				a.recorte ? `recorte ${a.recorte.desde_s}–${a.recorte.hasta_s ?? 'fin'} s del original` : null,
			]
				.filter(Boolean)
				.join('; ');
			return `| \`${a.archivo.replace(/^biblioteca\//, '')}\` | ${a.categoria} | ${a.fuente} | ${a.licencia} | ${origen} | ${a.url ?? '—'} | ${cat.generado_en.slice(0, 10)} | \`${a.sha256}\` | ${notas || '—'} |`;
		});
	const inv = cat.inventario as {pixabay?: {carpeta?: string; identicos?: string[][]; distintos_por_audio?: number; archivos_mp3?: number; creditos_sha256?: string}; kenney?: {paquetes?: Record<string, {zip: string; zip_sha256: string; license_txt_sha256: string; pagina: string}>}};
	const kenney = Object.entries(inv.kenney?.paquetes ?? {})
		.map(([p, d]) => `| ${p} | ${d.pagina} | \`${d.zip}\` | \`${d.zip_sha256}\` | \`${d.license_txt_sha256}\` |`)
		.join('\n');
	return [
		'# Licencias de los SFX (`biblioteca/sfx/`)',
		'',
		'Lo genera `herramientas/sfx/catalogar.ts`; no lo edites a mano (se reescribe en cada corrida). Una fila por archivo; los WAV no se versionan (`.gitignore`), este registro sí.',
		'',
		'## Licencias',
		'',
		`- **Pixabay** — ${LICENCIAS.pixabay} (https://pixabay.com/service/license-summary/): uso comercial y no comercial, se puede modificar, sin atribución obligatoria. Origen: \`${(inv.pixabay?.carpeta ?? DIR_PIXABAY).replace(homedir(), '~')}/\` (su \`CREDITS.md\`, sha256 \`${inv.pixabay?.creditos_sha256 ?? '—'}\`, dice que todos son de Pixabay con esa licencia; no trae la página de cada sonido, por eso la URL va como "—"). ${inv.pixabay?.archivos_mp3 ?? '—'} mp3, ${inv.pixabay?.distintos_por_audio ?? '—'} distintos por audio decodificado; idénticos: ${(inv.pixabay?.identicos ?? []).map((g) => g.join(' = ')).join('; ') || 'ninguno'}.`,
		`- **Kenney** — ${LICENCIAS.kenney} (https://creativecommons.org/publicdomain/zero/1.0/): dominio público, uso comercial sin atribución. Paquetes bajados de kenney.nl:`,
		'',
		'| Paquete | Página | Zip | sha256 del zip | sha256 de su License.txt |',
		'|---|---|---|---|---|',
		kenney,
		'',
		`- **Síntesis propia** — ${LICENCIAS.sintesis}: generada con ffmpeg \`aevalsrc\` por \`herramientas/sfx/sintesis.ts\`; no viene de terceros. Es tuya.`,
		...(sel ? [`- **Tuyos** — ${sel.licencia}. Origen: \`${sel.carpeta}/\` (no se versionan).`] : []),
		'- **Variantes** de ±1 semitono: misma licencia que su original (es una modificación con `asetrate` + `aresample`).',
		'',
		'## Archivos',
		'',
		'| Archivo | Categoría | Fuente | Licencia | Origen | URL | Fecha | sha256 | Notas |',
		'|---|---|---|---|---|---|---|---|---|',
		...filas,
		`| \`sfx/catalogo.json\` | — | este proyecto | Propia | \`herramientas/sfx/catalogar.ts\` | — | ${cat.generado_en.slice(0, 10)} | — | catálogo y mapeo de eventos |`,
		`| \`sfx/aprobaciones.json\` | — | este proyecto | Propia | tus respuestas a la hoja de pops | — | ${cat.generado_en.slice(0, 10)} | — | qué Kenney aprobaste como pop |`,
		'',
	].join('\n');
}

// ───────────────────────────── Programa ─────────────────────────────

type Opciones = {pixabay: string; propios: string | null; cache: string; sinRed: boolean; aprobarPop: string | null; soloRevisar: boolean};

function leerOpciones(argv: string[]): Opciones {
	const valor = (nombre: string): string | undefined => {
		const i = argv.findIndex((a) => a === nombre || a.startsWith(`${nombre}=`));
		if (i < 0) return undefined;
		return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
	};
	const conocidas = ['--pixabay', '--propios', '--cache', '--sin-red', '--aprobar-pop', '--solo-revisar'];
	for (const a of argv) {
		if (a.startsWith('--') && !conocidas.includes(a.split('=')[0])) {
			throw fallo('catalogar los SFX', `no conozco la opción ${a}`, `usa: ${conocidas.join(', ')}`, 2);
		}
	}
	return {
		pixabay: resolve(valor('--pixabay') ?? DIR_PIXABAY),
		propios: valor('--propios') ? resolve(valor('--propios')!) : null,
		cache: resolve(valor('--cache') ?? DIR_CACHE),
		sinRed: argv.includes('--sin-red'),
		aprobarPop: valor('--aprobar-pop') ?? null,
		soloRevisar: argv.includes('--solo-revisar'),
	};
}

function leerAprobaciones(): Aprobaciones {
	if (!existsSync(RUTA_APROBACIONES)) return JSON.parse(JSON.stringify(APROBACIONES_INICIALES));
	const r = AprobacionesEsquema.safeParse(JSON.parse(readFileSync(RUTA_APROBACIONES, 'utf8')));
	if (!r.success) throw fallo('leer tus aprobaciones de SFX', 'biblioteca/sfx/aprobaciones.json no cumple el esquema', 'revísalo o bórralo para volver a empezar', 2, r.error.issues);
	return r.data;
}

/** Revisa que cada WAV del catálogo exista y tenga su sha256. Devuelve problemas. */
export function revisarArchivos(cat: Catalogo, raiz = RAIZ): string[] {
	const problemas: string[] = [];
	for (const a of cat.archivos) {
		const ruta = join(raiz, a.archivo);
		if (!existsSync(ruta)) problemas.push(`falta ${a.archivo}`);
		else if (sha256DeArchivo(ruta) !== a.sha256) problemas.push(`${a.archivo} no tiene el sha256 del catálogo`);
	}
	return problemas;
}

async function main(): Promise<void> {
	const op = leerOpciones(process.argv.slice(2));
	if (op.soloRevisar) {
		const cat = CatalogoEsquema.parse(JSON.parse(readFileSync(RUTA_CATALOGO, 'utf8')));
		const problemas = [...problemasDelCatalogo(cat), ...revisarArchivos(cat)];
		if (problemas.length > 0) throw fallo('revisar la biblioteca de SFX', `${problemas.length} problemas, el primero: ${problemas[0]}`, 'vuelve a correr npx tsx herramientas/sfx/catalogar.ts', 2, problemas);
		console.log(`Biblioteca de SFX en orden: ${cat.archivos.length} archivos con su sha256; mapeo ${JSON.stringify(cat.eventos)}.`);
		return;
	}

	const t0 = performance.now();
	const tmp = mkdtempSync(join(tmpdir(), 'sfx-catalogar-'));
	const avisos: string[] = [];
	try {
		console.log('1/6 Pixabay: leo y comparo el audio decodificado…');
		const pix = reunirPixabay(op.pixabay);
		console.log(`    ${pix.inventario.archivos_mp3} mp3, ${pix.inventario.distintos_por_audio} distintos; idénticos: ${(pix.inventario.identicos as string[][]).map((g) => g.join(' = ')).join('; ')}`);
		console.log('2/6 Kenney: zips en caché o de kenney.nl…');
		const ken = reunirKenney(op.cache, op.sinRed, tmp);
		avisos.push(...ken.avisos);
		console.log('3/6 Síntesis propia…');
		const sin = reunirSintesis(tmp);
		const sel = leerSeleccionPropia();
		const enr = reunirPropios(sel, op.propios ?? (sel ? resolve(RAIZ, sel.carpeta) : join(RAIZ, 'biblioteca', 'sfx', '_originales')));
		console.log(`    Tuyos: ${enr.originales.length} de ${enr.inventario.archivos} en ${enr.inventario.carpeta}`);
		const originales = [...pix.originales, ...ken.originales, ...sin, ...enr.originales];

		// Aprobaciones de pop.
		let aprob = leerAprobaciones();
		const candidatosPop = originales.filter((o) => o.requiereAprobacion === 'pop').map((o) => o.id);
		if (op.aprobarPop !== null) {
			const {aprobados, rechazados} = interpretarAprobacion(op.aprobarPop, candidatosPop);
			aprob = {version: 1, pop: {estado: 'respondida', aprobados, rechazados, fecha: new Date().toISOString(), nota: `--aprobar-pop=${op.aprobarPop}`}};
			escribirJson(RUTA_APROBACIONES, aprob);
		} else if (!existsSync(RUTA_APROBACIONES)) {
			escribirJson(RUTA_APROBACIONES, aprob);
		}
		const aprobacionDe = (o: Original): Aprobacion => {
			if (o.requiereAprobacion !== 'pop') return 'no-requiere';
			if (aprob.pop.aprobados.includes(o.id)) return 'aprobada';
			if (aprob.pop.rechazados.includes(o.id)) return 'rechazada';
			return 'pendiente';
		};

		// Catálogo viejo: para borrar solo lo que esta herramienta creó.
		const viejo = existsSync(RUTA_CATALOGO) ? CatalogoEsquema.safeParse(JSON.parse(readFileSync(RUTA_CATALOGO, 'utf8'))) : null;

		console.log(`4/6 Normalizo ${originales.length} originales a −1 dBTP y hago sus variantes de ±1 semitono…`);
		const procesados: {o: Original; original: Procesado; variantes: Procesado[]}[] = [];
		for (const [i, o] of originales.entries()) {
			const r = procesarOriginal(o, o.categoria, tmp);
			procesados.push({o, ...r});
			if ((i + 1) % 20 === 0) console.log(`    ${i + 1}/${originales.length}`);
		}

		console.log('5/6 Busco originales casi iguales (huella espectro-temporal)…');
		const huellas = procesados.map((p) => huella(p.original.audio));
		const pares: {a: string; b: string; similitud: number; misma_categoria: boolean}[] = [];
		for (let i = 0; i < procesados.length; i++) {
			for (let j = i + 1; j < procesados.length; j++) {
				pares.push({
					a: procesados[i].o.id,
					b: procesados[j].o.id,
					similitud: redondear(similitudHuellas(huellas[i], huellas[j]), 3),
					misma_categoria: procesados[i].o.categoria === procesados[j].o.categoria,
				});
			}
		}
		// Calibración: cada original contra sus propias variantes (por definición, la misma fuente).
		const contraVariantes = procesados.flatMap((p, i) => p.variantes.map((v) => similitudHuellas(huellas[i], huella(v.audio))));
		const ordenadas = [...contraVariantes].sort((a, b) => a - b);
		const entre = pares.map((p) => p.similitud).sort((a, b) => a - b);
		const cuantil = (v: number[], q: number): number => redondear(v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))] ?? 0, 3);
		// Solo se juntan casi iguales de la MISMA categoría: es donde importa el conteo, y entre categorías la
		// huella confunde texturas de ruido largas (un glitch con un whoosh) que se oyen distintas.
		const deMismaCategoria = pares.filter((p) => p.misma_categoria);
		const representante = agruparCasiIguales(procesados.map((p) => p.o.id), deMismaCategoria, REGLAS_SFX.umbral_casi_igual);
		const fuenteIdDe = new Map(procesados.map((p) => [p.o.id, p.o.fuenteIdBase]));
		const casiIguales = deMismaCategoria
			.filter((p) => p.similitud >= REGLAS_SFX.umbral_casi_igual)
			.sort((a, b) => b.similitud - a.similitud)
			.map(({a, b, similitud}) => ({a, b, similitud}));
		const parecidosEntreCategorias = pares.filter((p) => !p.misma_categoria && p.similitud >= REGLAS_SFX.umbral_casi_igual).length;

		const archivos: ArchivoSfx[] = [];
		for (const p of procesados) {
			const fuente_id = fuenteIdDe.get(representante.get(p.o.id)!)!;
			const aprobacion = aprobacionDe(p.o);
			for (const x of [p.original, ...p.variantes]) archivos.push({...x.archivo, fuente_id, aprobacion});
		}
		archivos.sort((a, b) => a.archivo.localeCompare(b.archivo));

		// Conteo por categoría y mapeo de eventos (sin salida de escape). La preferencia sale de estilo.json →
		// sfx.mapeo si la Fase 2 ya la aprendió; si no, del supuesto.
		const mapeoEstilo = existsSync(RUTA_ESTILO) ? mapeoDesdeEstilo(JSON.parse(readFileSync(RUTA_ESTILO, 'utf8'))) : null;
		const preferido = mapeoEstilo ?? MAPEO_SUPUESTO;
		const eventos = mapearEventos(archivos, preferido);
		const categorias: Record<string, ConteoCategoria> = {};
		for (const c of [...new Set(archivos.map((a) => a.categoria))].sort()) {
			const conteo = contarFuentes(archivos, c);
			const enEventos = TIPOS_EVENTO.filter((t) => eventos[t].includes(c)) as TipoEvento[];
			let nota: string | null = null;
			if (!conteo.cumple) {
				nota = `no entra al mapeo: ${conteo.cuentan} de ${REGLAS_SFX.min_fuentes} fuentes (${conteo.reales} reales + ${Math.min(conteo.sintesis, REGLAS_SFX.max_sintesis_que_cuentan)} de síntesis)`;
				if (conteo.pendientes > 0) nota += `; ${conteo.pendientes} candidatos esperan tu aprobación (out/f3-sfx/hoja-pop.wav)`;
			} else if (enEventos.length === 0) {
				nota = 'cumple, pero no está en el mapeo supuesto de eventos (queda para uso explícito en sfx_extra)';
			}
			categorias[c] = {descripcion: CATEGORIAS_SFX[c] ?? c, ...conteo, en_eventos: enEventos, nota};
		}

		console.log('6/6 Hoja de pops, catálogo y licencias…');
		const candidatos = archivos.filter((a) => a.variante_de === null && candidatosPop.includes(a.id)).sort((a, b) => candidatosPop.indexOf(a.id) - candidatosPop.indexOf(b.id));
		const hoja = escribirHojaPop(candidatos, DIR_SALIDA_PRUEBAS);
		const pendientes =
			aprob.pop.estado === 'pendiente'
				? [
						{
							que: 'Aprobar (o no) los drop/pluck/tick de Kenney como "pop": hasta entonces el selector no los usa',
							categoria: 'pop',
							hoja: relative(RAIZ, hoja.wav),
							candidatos: hoja.colocados.map((c) => ({n: c.n, id: c.id, t_s: c.t_s})),
							como_aprobar: 'npx tsx herramientas/sfx/catalogar.ts --aprobar-pop=1,4,7   (o --aprobar-pop=ninguno)',
						},
					]
				: [];

		const catalogo: Catalogo = {
			version: 1,
			generado_en: new Date().toISOString(),
			generado_por: 'herramientas/sfx/catalogar.ts',
			normalizacion: {
				formato: `WAV PCM 16 bits, ${TASA_SFX} Hz, estéreo (mono duplicado)`,
				silencio_inicial: `se quita: la primera muestra a ${REGLAS_SFX.umbral_inicio_db} dB del pico cae en los primeros ${REGLAS_SFX.max_inicio_ms} ms (inicio_ms)`,
				pico: `${PICO_OBJETIVO_DBTP} dBTP (pico real de ffmpeg ebur128, sobremuestreo ×4), ±0.05`,
				lufs: 'sonoridad momentánea máxima (ventana de 400 ms) de ffmpeg ebur128, en LUFS, del WAV tal cual',
				ataque_ms: 'del inicio a la primera muestra a −6 dB del pico',
				cola: 'se corta por debajo de −60 dB del pico (+5 ms con fundido); lo que pase de la duración máxima de su categoría se corta con fundido de 80 ms',
				duracion_maxima_s: MAX_DURACION,
				variantes: '±1 semitono con asetrate + aresample sobre el original ya preparado; comparten fuente_id y no cuentan como fuente',
				variante_en_edl: '0 = original, 1 = +1 semitono (-agudo), 2 = −1 semitono (-grave)',
			},
			reglas: {
				...REGLAS_SFX,
				mapeo_preferido: preferido,
				mapeo_fuente: mapeoEstilo ? 'estilo/estilo.json → sfx.mapeo' : 'supuesto (MAPEO_SUPUESTO en herramientas/lib/sfx.ts) hasta que la Fase 2 lo aprenda',
				conteo: 'fuentes distintas por categoría = fuente_id distintos entre los originales usables; la síntesis cuenta máx. 2; variantes y pendientes no cuentan; los casi iguales (similitud ≥ umbral) comparten fuente_id',
				calibracion_casi_igual: {
					original_contra_sus_variantes: {n: ordenadas.length, min: cuantil(ordenadas, 0), p10: cuantil(ordenadas, 0.1), mediana: cuantil(ordenadas, 0.5)},
					entre_originales_distintos: {n: entre.length, mediana: cuantil(entre, 0.5), p99: cuantil(entre, 0.99), max: cuantil(entre, 1)},
					pares_juntados: casiIguales.length,
					pares_parecidos_entre_categorias_no_juntados: parecidosEntreCategorias,
					nota: 'la huella compara espectrogramas de 1/6 de octava de los primeros 640 ms (±30 ms, ±1 banda); una variante de ±1 semitono también cambia la duración ~6 %, por eso puntúa menos que un casi igual de la misma duración. Solo se juntan pares de la misma categoría',
				},
			},
			eventos,
			categorias,
			inventario: {pixabay: pix.inventario, kenney: ken.inventario, sintesis: {recetas: RECETAS.length, archivo: 'herramientas/sfx/sintesis.ts'}, ...(sel ? {[sel.fuente]: enr.inventario} : {})},
			pendientes,
			casi_iguales: casiIguales,
			descartados: [...pix.descartados, ...enr.descartados],
			archivos,
		};
		const problemas = problemasDelCatalogo(catalogo);
		if (problemas.length > 0) throw fallo('armar el catálogo de SFX', problemas[0], 'avísame: es un error interno del catalogador', 1, problemas);

		// Borra solo los WAV que esta herramienta creó antes y ya no están.
		const nuevos = new Set(archivos.map((a) => a.archivo));
		let borrados = 0;
		if (viejo?.success) {
			for (const a of viejo.data.archivos) {
				if (!nuevos.has(a.archivo) && existsSync(join(RAIZ, a.archivo))) {
					rmSync(join(RAIZ, a.archivo));
					borrados++;
				}
			}
		}
		escribirJson(RUTA_CATALOGO, catalogo);
		mkdirSync(join(RAIZ, 'biblioteca', 'licencias'), {recursive: true});
		writeFileSync(RUTA_LICENCIAS, markdownLicencias(catalogo));

		// Resumen.
		const s = Math.round((performance.now() - t0) / 100) / 10;
		console.log(`\nListo en ${s} s: ${archivos.length} WAV (${procesados.length} originales + ${archivos.length - procesados.length} variantes)${borrados ? `, ${borrados} viejos borrados` : ''}.`);
		for (const [c, k] of Object.entries(categorias)) {
			console.log(`  ${k.cumple ? '✓' : '✗'} ${c.padEnd(8)} ${String(k.cuentan).padStart(2)} fuentes que cuentan (${k.reales} reales de ${k.familias} familias + ${k.sintesis} síntesis${k.pendientes ? `, ${k.pendientes} pendientes` : ''}) → ${k.en_eventos.join(', ') || 'sin mapeo'}`);
		}
		console.log(`  Mapeo: ${TIPOS_EVENTO.map((t) => `${t}: [${eventos[t].join(', ')}]`).join(' · ')}`);
		console.log(`  Casi iguales (≥ ${REGLAS_SFX.umbral_casi_igual}): ${casiIguales.length} pares${casiIguales.length ? `, p. ej. ${casiIguales.slice(0, 3).map((p) => `${p.a} ≈ ${p.b} (${p.similitud})`).join('; ')}` : ''}.`);
		if (pendientes.length > 0) console.log(`  Pendiente: escucha ${relative(RAIZ, hoja.wav)} (${hoja.colocados.length} candidatos) y aprueba con --aprobar-pop=…`);
		for (const a of avisos) console.log(`  Aviso: ${a}`);
	} finally {
		rmSync(tmp, {recursive: true, force: true});
	}
}

if (esPrincipal(import.meta.url)) await correr(main);
