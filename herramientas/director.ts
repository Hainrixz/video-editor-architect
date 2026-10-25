// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * director.ts — el BORRADOR de la dirección de un reel (etapa 7 de /editar). Claude lo revisa y decide.
 *
 *   npx tsx herramientas/director.ts <slug> [--semilla s] [--sin-sfx] [--forzar] [--json]
 *
 * Lee de proyectos/<slug>/: transcripcion-base.json (palabras sobre la base cortada), subtitulos.json (dónde van los
 * subtítulos), cara.json (tu cabeza y tu boca), manifest.json (duración de la base) y, si existe, notas-director.json (lo
 * que Claude decide a mano; manda sobre el borrador). Además: el estilo (estilo/estilo.json o lo medido), los catálogos de
 * stickers y SFX, biblioteca/vocabulario.json, voice.md, demos/ (las tomas grabadas con el estudio) y
 * proyectos/<slug>/inserts/.
 *
 * Director v2: todo va debajo de tu BOCA (no de la barbilla; ver herramientas/layout.ts), al ritmo medido en tus reels
 * (tarjetas y stickers por minuto de estilo.json) y, en una toma de cerca (cara más grande que el p90 de tus reels),
 * prioriza las demos grabadas en los momentos de acción.
 *
 * Escribe proyectos/<slug>/direccion.json (lo que lee armar-edl.ts: titular, tarjetas, stickers, inserts, zooms, efectos,
 * sfx_extra, resaltar_palabras) y direccion.md (el plan en español: cada momento con la palabra que lo dispara, qué se
 * eligió, por qué y alternativas). Nunca toca notas-director.json. Si direccion.json se editó a mano (su huella no cuadra),
 * no lo pisa sin --forzar: lo que se decide a mano va en notas-director.json.
 *
 * Determinista: semilla = slug (o --semilla). Al final arma en memoria la edición que haría armar-edl.ts y la pasa por
 * validar.ts: "cumple X de Y reglas (Z N/A)". Corre dentro del sandbox (sin Chrome ni Vision; ffmpeg solo para medir tu voz).
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo (transcripción, notas inválidas) o la edición no pasa validar.ts.
 */
import {esMeme} from '../src/estilo/memes.ts';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {EdicionBase, type Edicion} from '../src/esquema/edicion.ts';
import {ajustesDeDemo, altoNecesarioTerminal, DemoTerminalEsquema, prepararTerminal} from '../src/estilo/terminal.ts';
import {armarEdicion} from './armar-edl.ts';
import {estadoRevision, demoUsable} from './grabador/secretos.ts';
import {bandaLibre, crearContexto, franjaDeEdicion, franjaDeEstilo} from './layout.ts';
import type {DemoDisponible} from './lib/director/momentos.ts';
import {leerCara, type Cara} from './lib/cara.ts';
import {leerEstiloDirector} from './lib/director/estilo.ts';
import {configStickers, configTarjetas, configTitular, leerEstilo as leerEstiloJson, RUTA_ESTILO} from './lib/estilo.ts';
import {informeDireccion} from './lib/director/informe.ts';
import {leerNotas, planear, type Notas, type Plan} from './lib/director/plan.ts';
import {leerCatalogosStickers} from './lib/director/stickers.ts';
import {archivoTecleo, momentosPrompt, tecleoDeTarjetas} from './lib/director/tecleo.ts';
import type {Palabra} from './lib/director/texto.ts';
import {leerVoz, rutaVoz} from './lib/director/voz.ts';
import {leerPerfilMotor} from './lib/perfil-estilo.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, RAIZ} from './lib/manifest.ts';
import {leerCatalogo, leerEstiloSfx, leerFuentesPermitidas, leerHistorial} from './lib/sfx.ts';
import {esSlugValido, REGLA_SLUG} from './lib/slug.ts';
import {elegirSfx, medirVozLufs, VOZ_LUFS_REFERENCIA, type Eleccion} from './sfx/elegir.ts';
import {dimensionesMedio, fraseReglas, rutaEnPublic, validarEdicion, type ResultadoValidacion} from './validar.ts';

const USO = 'npx tsx herramientas/director.ts <slug> [--semilla s] [--sin-sfx] [--forzar] [--json]';

/** sha256 del contenido sin la llave "huella" (para saber si alguien editó direccion.json a mano). */
/** titular/tarjetas/stickers de estilo/estilo.json (config de cada capa), o undefined si no hay estilo.json válido. */
function estilosDeEstiloJson(): Edicion['estilos'] | undefined {
	if (!existsSync(RUTA_ESTILO)) return undefined;
	try {
		const e = leerEstiloJson().estilo;
		return {titular: configTitular(e), tarjetas: configTarjetas(e), stickers: configStickers(e)};
	} catch {
		return undefined;
	}
}

export function huellaDe(obj: Record<string, unknown>): string {
	const {huella: _sinHuella, ...resto} = obj;
	void _sinHuella;
	return createHash('sha256').update(JSON.stringify(resto)).digest('hex');
}

/** ¿direccion.json existe y NO es la salida intacta del director (se editó a mano)? */
export function editadaAMano(ruta: string): boolean {
	if (!existsSync(ruta)) return false;
	try {
		const datos = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
		return typeof datos.huella !== 'string' || datos.huella !== huellaDe(datos);
	} catch {
		return true;
	}
}

function leerJson(ruta: string, que: string, siguiente: string): unknown {
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${relative(RAIZ, ruta)} no es JSON válido`, siguiente, 2, error);
	}
}

export type ResumenBanda = {p10: number | null; p50: number | null; min: number | null; n: number; boca: {p10: number | null; p50: number | null; min: number | null}; boca_estimada: boolean};

/** Zona libre debajo de tu barbilla y debajo de tu boca en ventanas de 1 s (para el resumen). */
export function resumenBanda(ctx: ReturnType<typeof crearContexto>, duracion: number): ResumenBanda {
	const vacio = {p10: null, p50: null, min: null};
	if (!ctx.cara) return {...vacio, n: 0, boca: vacio, boca_estimada: false};
	const altos: number[] = [];
	const bocas: number[] = [];
	let estimada = false;
	for (let t = 0; t < duracion; t += 1) {
		const b = bandaLibre(ctx, t, Math.min(duracion, t + 1));
		if (b.barbilla === null) continue;
		altos.push(b.alto);
		bocas.push(b.alto_boca);
		estimada ||= b.boca_estimada;
	}
	const q = (v: number[], p: number) => {
		const o = [...v].sort((a, b) => a - b);
		return o.length ? o[Math.min(o.length - 1, Math.floor(p * (o.length - 1)))] : null;
	};
	return {p10: q(altos, 0.1), p50: q(altos, 0.5), min: q(altos, 0), n: altos.length, boca: {p10: q(bocas, 0.1), p50: q(bocas, 0.5), min: q(bocas, 0)}, boca_estimada: estimada};
}

/**
 * Demos grabadas con el estudio que el director puede proponer: demos/<nombre>/toma.mp4 con su toma.json (no las que
 * empiezan con "_", que son de prueba). La descripción sale de guion.json y los clics y scrolls de eventos.json.
 */
export function demosGrabadas(raiz = RAIZ): DemoDisponible[] {
	const dir = join(raiz, 'demos');
	if (!existsSync(dir)) return [];
	const salida: DemoDisponible[] = [];
	for (const nombre of readdirSync(dir).sort()) {
		if (nombre.startsWith('_') || nombre.startsWith('.')) continue;
		const d = join(dir, nombre);
		if (!existsSync(join(d, 'toma.mp4')) || !existsSync(join(d, 'toma.json'))) continue;
		const leer = (n: string): unknown => {
			try {
				return JSON.parse(readFileSync(join(d, n), 'utf8'));
			} catch {
				return null;
			}
		};
		const toma = leer('toma.json') as {duracion_s?: unknown} | null;
		const guion = leer('guion.json') as {descripcion?: unknown} | null;
		const eventos = leer('eventos.json');
		const duracion = typeof toma?.duracion_s === 'number' ? toma.duracion_s : 0;
		if (!(duracion > 0)) continue;
		salida.push({
			asset: `demos/${nombre}/toma.mp4`,
			eventos: existsSync(join(d, 'eventos.json')) ? `demos/${nombre}/eventos.json` : null,
			duracion,
			usable: demoUsable(d),
			motivo: estadoRevision(d).motivo,
			descripcion: typeof guion?.descripcion === 'string' ? guion.descripcion : nombre,
			acciones: Array.isArray(eventos) ? (eventos as Array<{t?: unknown; tipo?: unknown}>).filter((x) => typeof x.t === 'number' && typeof x.tipo === 'string').map((x) => ({t: x.t as number, tipo: x.tipo as string})) : [],
		});
	}
	return salida;
}

/**
 * Tamaño y duración de lo que un insert de las notas quiere usar: una demo de terminal (lo que pide su guion), una toma
 * del estudio (toma.json) o una imagen o video (ffprobe). null si no se pudo leer.
 */
export function medioDe(asset: string): {ancho: number; alto: number; duracion: number | null} | null {
	const ruta = rutaEnPublic(asset);
	if (!existsSync(ruta)) return null;
	try {
		if (asset.endsWith('.terminal.json')) {
			// La ventana mide lo que su guion ocupa (no 1100 px con medio alto vacío encima de tu cara); Reel.tsx la
			// dibuja a ese tamaño natural y la escala a la caja.
			const demo = DemoTerminalEsquema.parse(JSON.parse(readFileSync(ruta, 'utf8')));
			const ajustes = ajustesDeDemo(demo);
			const p = prepararTerminal(ajustes);
			return {ancho: p.geo.ancho, alto: altoNecesarioTerminal(ajustes, p.geo.ancho), duracion: Math.ceil(p.duracion * 30) / 30};
		}
		const rutaToma = join(dirname(ruta), 'toma.json');
		if (asset.startsWith('demos/') && asset.endsWith('toma.mp4') && existsSync(rutaToma)) {
			const t = JSON.parse(readFileSync(rutaToma, 'utf8')) as {cuadro?: {ancho?: number; alto?: number}; duracion_s?: number};
			return {ancho: t.cuadro?.ancho ?? 2560, alto: t.cuadro?.alto ?? 1600, duracion: typeof t.duracion_s === 'number' ? t.duracion_s : null};
		}
	} catch {
		return null;
	}
	return dimensionesMedio(ruta);
}

export type ResultadoDirector = {plan: Plan; direccion: Record<string, unknown>; md: string; validacion: ResultadoValidacion | null; rutaJson: string; rutaMd: string};

export async function dirigir(op: {slug: string; semilla?: string; sinSfx?: boolean; forzar?: boolean; proyectos?: string; escribir?: boolean}): Promise<ResultadoDirector> {
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const slug = op.slug;
	if (!esSlugValido(slug)) throw fallo('dirigir', `"${slug}" no es un slug válido`, `usa ${REGLA_SLUG}`, 2);
	const dir = join(proyectos, slug);
	if (!existsSync(dir)) throw fallo('dirigir', `no existe proyectos/${slug}`, 'revisa el slug', 2);
	const semilla = op.semilla ?? slug;
	const avisos: string[] = [];

	// Transcript sobre la base cortada.
	const rutaTb = join(dir, 'transcripcion-base.json');
	if (!existsSync(rutaTb)) throw fallo('dirigir', `falta proyectos/${slug}/transcripcion-base.json`, `corre primero npx tsx herramientas/cortes.ts ${slug} (y aprueba el texto)`, 2);
	const tb = leerJson(rutaTb, 'leer la transcripción', `vuelve a correr cortes.ts ${slug}`) as {palabras?: Palabra[]; duracion_base_s?: number};
	const palabras = (tb.palabras ?? []).filter((p) => typeof p.t === 'string' && Number.isFinite(p.d) && Number.isFinite(p.h));
	if (palabras.length === 0) throw fallo('dirigir', 'la transcripción no trae palabras', `vuelve a correr cortes.ts ${slug}`, 2);

	// Duración: la de la base verificada (como armar-edl) o la de la transcripción.
	let duracion = typeof tb.duracion_base_s === 'number' ? tb.duracion_base_s : palabras.at(-1)!.h;
	const rutaManifest = join(dir, 'manifest.json');
	if (existsSync(rutaManifest)) {
		const m = leerJson(rutaManifest, 'leer el manifest', `vuelve a correr base.ts ${slug}`) as {etapas?: {base?: {verificacion?: {cuadros?: number}}}};
		const cuadros = m.etapas?.base?.verificacion?.cuadros;
		if (typeof cuadros === 'number' && cuadros > 0) duracion = Math.round((cuadros / 30) * 1e6) / 1e6;
	}

	const {estilo, avisos: avisosEstilo} = leerEstiloDirector();
	avisos.push(...avisosEstilo);
	const rutaCara = join(dir, 'cara.json');
	let cara: Cara | null = null;
	if (existsSync(rutaCara)) {
		const leida = leerCara(rutaCara);
		if (Math.abs(leida.duracion_s - duracion) > 2 / 30) avisos.push(`cara.json dura ${leida.duracion_s} s y la base ${duracion} s: es de otra base; corre npx tsx herramientas/cara.ts ${slug} --forzar (mientras, no sé dónde va tu cabeza)`);
		else cara = leida;
	} else avisos.push(`no hay cara.json: no sé dónde va tu cabeza; corre npx tsx herramientas/cara.ts ${slug} antes de dirigir (sin él, validar.ts deja R1 y R4 en N/A)`);
	const rutaSubs = join(dir, 'subtitulos.json');
	let franja = franjaDeEstilo(estilo);
	if (existsSync(rutaSubs)) {
		const subs = leerJson(rutaSubs, 'leer los subtítulos', `vuelve a correr subtitulos.ts ${slug}`) as {subtitulos?: Array<{id: string; desde: number; hasta: number; palabras: Array<{i: number; t: string; d: number; h: number}>; caja?: {x: number; y: number}}>; estilo?: Record<string, unknown>};
		franja = franjaDeEdicion((subs.subtitulos ?? []) as never, {subtitulos: subs.estilo} as never, estilo.franja.margen.valor) ?? franja;
	} else avisos.push(`no hay subtitulos.json: uso la franja de subtítulos del estilo (${franja.y0}–${franja.y1})`);
	// Estilos medidos de cada capa (estilo/estilo.json → config): el layout mide las cajas con las MISMAS fuentes y
	// tamaños que dibuja el render (van en direccion.json → estilos y armar-edl los pasa a la EDL).
	const estilosMedidos = estilosDeEstiloJson();
	const ctx = crearContexto({cara, estilo, franja, semilla, estilos: estilosMedidos});

	const catalogos = leerCatalogosStickers();
	avisos.push(...catalogos.avisos);
	const rutaVoc = join(RAIZ, 'biblioteca', 'vocabulario.json');
	const terminos = existsSync(rutaVoc) ? (((leerJson(rutaVoc, 'leer el vocabulario', 'revisa biblioteca/vocabulario.json') as {terminos?: unknown}).terminos as string[] | undefined) ?? []).filter((x) => typeof x === 'string') : [];

	let notas: Notas | null = null;
	const rutaNotas = join(dir, 'notas-director.json');
	if (existsSync(rutaNotas)) {
		const l = leerNotas(leerJson(rutaNotas, 'leer notas-director.json', 'corrige el JSON de las notas'));
		if (!l.notas) throw fallo('leer notas-director.json', l.problemas.join('; '), 'corrige las notas (ver la forma en herramientas/lib/director/plan.ts → NotasEsquema)', 2, l.problemas);
		notas = l.notas;
		avisos.push(...l.avisos);
	}
	const voz = leerVoz();
	if (!voz) avisos.push(`no encontré voice.md (${rutaVoz() ?? 'creador.json → voz no dice dónde está'}): el titular no se revisa contra la lista "Prohibido"`);

	// Demo grabada para este proyecto.
	const dirDemo = join(RAIZ, 'demos', slug);
	let demo: Parameters<typeof planear>[0]['demo'] = null;
	if (existsSync(join(dirDemo, 'toma.mp4'))) {
		let duracionToma = 0;
		try {
			duracionToma = Number((JSON.parse(readFileSync(join(dirDemo, 'toma.json'), 'utf8')) as {duracion_s?: number}).duracion_s ?? 0);
		} catch {
			duracionToma = 0;
		}
		demo = {asset: `demos/${slug}/toma.mp4`, eventos: existsSync(join(dirDemo, 'eventos.json')) ? `demos/${slug}/eventos.json` : null, duracion: duracionToma, usable: demoUsable(dirDemo), motivo: estadoRevision(dirDemo).motivo};
	}
	const dirInserts = join(dir, 'inserts');
	const insertsDisponibles = existsSync(dirInserts) ? readdirSync(dirInserts).filter((n) => !n.startsWith('.')).map((n) => `p/${slug}/inserts/${n}`) : [];

	const plan = planear({slug, semilla, palabras, duracion, ctx, estilo, catalogos, terminos, notas, voz: voz?.reglas ?? null, medio: (asset) => medioDe(asset), demo, demosDisponibles: demosGrabadas(), ritmo: leerPerfilMotor().ritmo ?? undefined});

	// SFX: el selector del catálogo (variado, a veces en silencio).
	let sfxResumen: Array<{id: string; tipo: string; t: number; que: string}> | null = null;
	if (!op.sinSfx) {
		const catalogo = leerCatalogo();
		const {estilo: estiloSfx, notas: notasSfx} = leerEstiloSfx();
		for (const n of notasSfx) avisos.push(`SFX: ${n}`);
		const historial = leerHistorial();
		let vozLufs: number = VOZ_LUFS_REFERENCIA.valor;
		try {
			vozLufs = medirVozLufs(`p/${slug}/base.mp4`).lufs;
		} catch {
			avisos.push(`no pude medir tu voz en la base: uso ${VOZ_LUFS_REFERENCIA.valor} LUFS (${VOZ_LUFS_REFERENCIA.fuente})`);
		}
		const eventos = [
			...plan.stickers.map((s) => ({id: s.id, tipo: 'sticker' as const, t: s.desde})),
			// Los prompts no entran al selector: llevan su tecleo (abajo).
			...plan.tarjetas.filter((s) => s.variante !== 'prompt').map((s) => ({id: s.id, tipo: 'tarjeta' as const, t: s.desde})),
			// Los memes suenan como sticker (pop corto al aparecer), no como insert (whoosh): src/estilo/memes.ts.
			...plan.inserts.map((s) => ({id: s.id, tipo: esMeme(s.asset) ? ('sticker' as const) : ('insert' as const), t: s.desde})),
		];
		const elecciones: Eleccion[] = eventos.length ? elegirSfx(eventos, {catalogo, estilo: estiloSfx, historial, slug, semilla, vozLufs, preferirFuente: notas?.sfx_preferir_fuente ?? null, soloFuentes: leerFuentesPermitidas()}) : [];
		const por = new Map(elecciones.map((x) => [x.id, x]));
		for (const lista of [plan.stickers, plan.tarjetas, plan.inserts]) for (const x of lista) x.sfx = por.get(x.id)?.sfx ?? null;
		sfxResumen = [...elecciones].sort((a, b) => a.t - b.t).map((x) => ({id: x.id, tipo: x.tipo, t: x.t, que: x.sfx ? `${x.categoria} · ${x.archivo_id} · ${x.sfx.ganancia_db} dB · offset ${x.sfx.offset_frames}${x.respaldo ? ' · respaldo' : ''}` : x.motivo === 'silencio-planeado' ? 'silencio (planeado)' : x.motivo}));
		// Regla del prompt: cada tarjeta "prompt" teclea con tu Foley mientras se escribe (lib/director/tecleo.ts).
		const tecleo = tecleoDeTarjetas(plan.tarjetas, {archivo: archivoTecleo(catalogo, leerFuentesPermitidas()), estilo: ctx.estiloTarjeta, vozLufs, nivelRelDb: estiloSfx.ganancia_db.valor[0]});
		avisos.push(...tecleo.avisos);
		for (const t of plan.tarjetas) {
			const sfx = tecleo.tecleos.get(t.id);
			if (!sfx) continue;
			t.sfx = sfx;
			sfxResumen.push({id: t.id, tipo: 'tarjeta', t: t.desde, que: `tecleo (prompt) · ${sfx.asset.split('/').pop()} · ${sfx.ganancia_db} dB · desde la 1.ª letra (+${sfx.offset_frames} cuadros) · ${sfx.duracion_frames} cuadros (${(sfx.duracion_frames! / 30).toFixed(2)} s, lo que tarda en escribirse)`});
		}
		sfxResumen.sort((a, b) => a.t - b.t);
	}

	const direccion: Record<string, unknown> = {
		version: 1,
		generado_por: 'herramientas/director.ts',
		slug,
		semilla,
		borrador: {titular: plan.titularInfo.borrador},
		estilo_version: estilo.version,
		estilo_hash: estilo.hash,
		titular: plan.titular,
		tarjetas: plan.tarjetas,
		stickers: plan.stickers,
		inserts: plan.inserts,
		zooms: [],
		efectos: plan.efectos,
		sfx_extra: [],
		resaltar_palabras: [],
		...(estilosMedidos ? {estilos: estilosMedidos} : {}),
		ritmo: plan.ritmo,
		cerca: plan.cerca,
		avisos: [...plan.avisos, ...plan.titularInfo.avisos],
	};
	direccion.huella = huellaDe(direccion);

	const rutaJson = join(dir, 'direccion.json');
	const rutaMd = join(dir, 'direccion.md');
	let validacion: ResultadoValidacion | null = null;
	if (op.escribir !== false) {
		if (editadaAMano(rutaJson) && !op.forzar) {
			throw fallo('escribir direccion.json', `proyectos/${slug}/direccion.json se editó a mano (su huella no cuadra)`, 'pasa esas decisiones a notas-director.json (mandan sobre el borrador) o corre con --forzar para pisarlo', 2);
		}
		writeFileSync(rutaJson, `${JSON.stringify(direccion, null, '\t')}\n`);
		// La edición que armaría armar-edl.ts, validada (sin escribir ninguna edicion-vN.json).
		try {
			const edicion = armarEdicion(slug, dir);
			validacion = validarEdicion(EdicionBase.parse(edicion), proyectos === DIR_PROYECTOS ? {} : {proyectos});
		} catch (error) {
			avisos.push(`no pude armar la edición para validarla: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const md = informeDireccion({
		slug,
		semilla,
		fecha: new Date().toISOString().slice(0, 10),
		plan,
		estilo,
		franja,
		banda: resumenBanda(ctx, duracion),
		sfx: sfxResumen,
		validacion: validacion ? {reglas: validacion.reglas, hallazgos: validacion.hallazgos, frase: fraseReglas(validacion.reglas)} : null,
		insertsDisponibles,
		prompts: momentosPrompt(palabras),
		avisos,
	});
	if (op.escribir !== false) writeFileSync(rutaMd, md);
	return {plan, direccion, md, validacion, rutaJson, rutaMd};
}

async function main(): Promise<void> {
	let valores: {semilla?: string; 'sin-sfx'?: boolean; forzar?: boolean; json?: boolean; ayuda?: boolean};
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {semilla: {type: 'string'}, 'sin-sfx': {type: 'boolean', default: false}, forzar: {type: 'boolean', default: false}, json: {type: 'boolean', default: false}, ayuda: {type: 'boolean', short: 'h', default: false}},
		}));
	} catch (error) {
		const m = error instanceof Error ? /Unknown option '([^']+)'/.exec(error.message) : null;
		throw fallo('leer los argumentos', m ? `no conozco la opción ${m[1]}` : 'los argumentos no tienen la forma esperada', `usa ${USO}`, 2, error);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	const slug = posicionales[0];
	if (!slug) throw fallo('dirigir', 'falta el slug', `usa ${USO}`, 2);
	const r = await dirigir({slug, semilla: valores.semilla, sinSfx: valores['sin-sfx'], forzar: valores.forzar});
	if (valores.json) {
		console.log(JSON.stringify({direccion: r.direccion, validacion: r.validacion && {reglas: r.validacion.reglas, hallazgos: r.validacion.hallazgos}}, null, '\t'));
	} else {
		const p = r.plan;
		console.log(`Dirección de ${slug}: ${p.ritmo.tarjetas} tarjetas (${p.ritmo.tarjetas_por_min}/min) · ${p.ritmo.stickers} stickers (${p.ritmo.stickers_por_min}/min) · ${p.ritmo.inserts} inserts · titular ${p.titular ? `«${p.titular.texto.replace('\n', ' / ')}»${p.titularInfo.borrador ? ' (borrador)' : ''}` : 'ninguno'}.`);
		if (p.cerca.activo) console.log(`  Modo de cerca: tu cara mide ${p.cerca.alto_cara_p50} px (p90 de tus reels: ${p.cerca.umbral}) · ${p.cerca.demos.length} demo(s) propuesta(s) en momentos de acción.`);
		console.log(`  ${relative(RAIZ, r.rutaJson)} y ${relative(RAIZ, r.rutaMd)}`);
		if (r.validacion) {
			console.log(`  validar.ts: ${fraseReglas(r.validacion.reglas)}`);
			for (const h of r.validacion.hallazgos) console.log(`  - [${h.numero ?? h.regla}] ${h.donde}: ${h.detalle}`);
		}
	}
	if (r.validacion && r.validacion.hallazgos.length > 0) {
		throw fallo('dejar lista la dirección', `la edición que armaría armar-edl.ts no pasa validar.ts (${r.validacion.hallazgos.length} FAIL)`, `revisa proyectos/${slug}/direccion.md y corrige notas-director.json`, 2);
	}
}

if (esPrincipal(import.meta.url)) void correr(main);
