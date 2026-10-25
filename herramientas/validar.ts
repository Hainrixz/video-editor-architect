// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * validar.ts — compuerta obligatoria antes de cualquier render (etapa 10 de /editar, bloqueante).
 * Remotion NO valida las props contra el schema al renderizar; esto sí, y además revisa las reglas de la Fase 3.
 *
 * Uso: npx tsx herramientas/validar.ts <ruta/edicion-vN.json> [--json]
 * Sale con 0 si la EDL es válida; 2 si no (cada FAIL con su número de regla y su origen).
 *
 * Reglas (cada FAIL dice cuál y de dónde salió, p. ej. "[R1] k3: invade la cara 42 px en t=12.3 s (… cara.json)"):
 *   esquema  Zod + coherencia de tiempos (src/esquema/edicion.ts).
 *   R1  Debajo de tu boca (la zona protegida): stickers, tarjetas e inserts en tarjeta con tapaCabeza = false llevan su
 *       borde de arriba ≥ boca máx (punto más bajo de tus labios, t0−0.2…t1+0.2 s, con zooms) + 12 px (margen
 *       supuesto, estilo.cabeza.margen_boca). Como la boca va debajo de la nariz y de los ojos, lo que pasa tampoco
 *       los tapa (por construcción): un sticker que tapa boca u ojos HACE FALLAR validar. Pueden tocar tu barba y tu
 *       barbilla, como en tus tomas de cerca. Si cara.json no trae la boca (es de antes), se estima como barbilla −
 *       0.18 × alto de la cara y se avisa. El titular no toca la CARA (puede rozar el pelo, como en tus reels). Sin cara.json: N/A.
 *   R2  Franja de subtítulos libre: ningún sticker, tarjeta, titular ni insert en tarjeta (ni su texto) la cruza.
 *   R3  tapaCabeza por controversia (stickers y tarjetas) por reel ≤ p90 del estilo (si es N/A, máximo 1); no cuentan el titular ni los inserts de R4.
 *   R4  Insert en tarjeta: si debajo de la barbilla solo cabe con < 70 % de ancho legible (756 px), va con
 *       tapaCabeza = true; si cabe, va debajo (tapaCabeza = false). Sin cara.json: N/A. Los memes de
 *       biblioteca/memes/ no entran: tapan la cara a propósito (src/estilo/memes.ts).
 *   R5  Stickers: PNG con las 4 esquinas en α = 0 (regla "alfa") y borde tipo sticker (orilla blanca, verificarSticker).
 *   R6  SFX: no se repite archivo en 5 eventos con sonido, ninguna categoría más de 2 seguidas, silencio en [p10, p90],
 *       offsets de stickers entre −2 y 0 cuadros (herramientas/sfx/elegir.ts → revisarReglas). Los tecleos de los
 *       prompts (sfx.duracion_frames) van aparte: solo en tarjetas "prompt", del catálogo y sin pasarse del archivo.
 *   R7  Duración mínima por palabra del titular, las tarjetas y los textos de inserts (estilo; si no, 0.3 s, BRAG).
 *   R8  El titular sin nada de la lista "Prohibido" de voice.md.
 *   R9  Dos stickers seguidos no repiten pose (la del sticker por pose de la EDL o de su catálogo).
 *   R10 Demos: la de pantalla está usable (secretos revisados) y su trim cae dentro de la toma; la de terminal cumple
 *       su contrato y el insert dura lo que necesita su guion.
 *   R11 Archivos y rutas (reglas "archivo" y "ruta"): todo existe en public/, sin rutas absolutas ni "..", nada de entrada/.
 *   R12 Zona segura de Reels (src/estilo/zona-segura.ts, guía de zona segura de Reels): tarjetas, prompts,
 *       stickers y logos dentro de x 135–945 e y 220–1600; subtítulos dentro de x 135–945 con su borde de abajo
 *       ≤ 1590; titular, inserts en tarjeta y textos de inserts dentro de x 35–1045 e y 220–1600 y sin tocar la
 *       columna de íconos (x > 945 entre y 1280–1600). Los inserts a pantalla completa y la base no aplican.
 *   R13 Texto vivo (src/estilo/texto-vivo.ts): cada elemento dentro de la zona segura de capas (x 135–945, y 220–1600) y
 *       sin encimarse con la caja de tu cara (cara.json, cuadro por cuadro) salvo los que van DETRÁS de ti con tu silueta
 *       encima (persona.webm); los subtítulos vivos dentro de x 135–945, con su borde de abajo ≤ 1590 y debajo de tu boca
 *       + 12 px. Sin texto_vivo: N/A.
 *
 * Al final: "cumple X de Y reglas (Z N/A)". Los N/A dicen qué falta.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {esMeme} from '../src/estilo/memes.ts';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {aCuadro, EdicionValidada, type Edicion} from '../src/esquema/edicion';
import {resolverEstiloSticker, resolverEstiloTarjeta, resolverEstiloTitular} from '../src/estilo/capas';
import {TomaDemo} from '../src/estilo/demo';
import {fueraDeZona} from '../src/estilo/zona-segura';
import {anchoTexto, cajaElemento, vaDetras, VOCES} from '../src/estilo/texto-vivo';
import {DemoTerminalEsquema, ajustesDeDemo, erroresDemo, prepararTerminal} from '../src/estilo/terminal';
import {LOGO_CLAUDE, duracionMinimaMotion, resolverMotion} from '../src/estilo/motion';
import {demoUsable, estadoRevision} from './grabador/secretos';
import {CATALOGO_MASCOTA, rutaCatalogoMascota} from './lib/director/stickers';
import {
	anchoLegibleDebajo,
	cajasVisiblesTarjetas,
	cajaVisibleSubtitulo,
	cajaVisibleInsert,
	cajaVisibleSticker,
	crearContexto,
	encimeVertical,
	esTerminal,
	franjaDeEdicion,
	franjaDeEstilo,
	geometriaTitular,
	peorBoca,
	redondearCaja,
	zoomsDeEdicion,
	type CajaVisible,
	type Franja,
	type InfoPng,
} from './layout';
import {bocaMedida, cajaCara, leerCara, type CaraConsultable} from './lib/cara';
import {leerEstiloDirector, textoMedida, type EstiloDirector} from './lib/director/estilo';
import {leerVoz, reglasDeVoz, revisarVoz, type ReglaVoz} from './lib/director/voz';
import {correr, esPrincipal, fallo} from './lib/fallo';
import {t} from './lib/i18n';
import {interpretarSondeo, type FfprobeCrudo} from './lib/ffprobe';
import {leerCatalogo, leerEstiloSfx, type Catalogo, type EstiloSfx} from './lib/sfx';
import {revisarReglas, type Eleccion} from './sfx/elegir';
import {esTecleo} from './lib/director/tecleo';
import {cajaTinta, leerPngArchivo, verificarSticker, type VerificacionSticker} from './stickers/lib/borde';

const RAIZ = resolve(import.meta.dirname, '..');
const PUBLICO = join(RAIZ, 'public');
const FPS = 30;

/** Un FAIL. `regla` es el nombre corto ("R1"… o los de la Fase 0: "esquema", "archivo", "ruta", "alfa"); `numero`, su número del plan. */
export type Hallazgo = {regla: string; donde: string; detalle: string; numero?: string};

export type EstadoRegla = {regla: string; nombre: string; estado: 'PASA' | 'FALLA' | 'N/A'; detalle: string};

/** Lo que se ve de cada capa (para el diagnóstico del layout y las hojas de contacto). */
export type CapaRevisada = {id: string; tipo: 'sticker' | 'tarjeta' | 'titular' | 'insert' | 'texto-insert'; desde: number; hasta: number; caja: CajaVisible; tapaCabeza: boolean};

export type ResultadoValidacion = {edicion?: Edicion; hallazgos: Hallazgo[]; avisos: string[]; reglas: EstadoRegla[]; capas: CapaRevisada[]};

export type OpcionesValidar = {
	/** Revisar que existan los archivos y el alfa de los stickers (por defecto sí). */
	revisarArchivos?: boolean;
	/** Reglas R1–R10 y R12 (por defecto sí). false = solo esquema y archivos (lo de la Fase 0). */
	reglas?: boolean;
	/** Cara del video. Por defecto, proyectos/<slug>/cara.json según `base` ("p/<slug>/base.mp4"). null = sin cara (R1 y R4 N/A). */
	cara?: CaraConsultable | null;
	/** Estilo (por defecto el de leerEstiloDirector). */
	estilo?: EstiloDirector;
	/** Texto de voice.md (por defecto el de creador.json → voz; null = no hay → R8 N/A). */
	voz?: string | null;
	/** Catálogo de SFX (por defecto biblioteca/sfx/catalogo.json; null = no hay → R6 solo revisa offsets). */
	catalogoSfx?: Catalogo | null;
	estiloSfx?: EstiloSfx;
	/** Carpeta proyectos/ donde buscar cara.json (por defecto la del editor). */
	proyectos?: string;
};

export const NOMBRES_REGLAS: Readonly<Record<string, string>> = {
	R1: 'nada sobre tu boca, nariz ni ojos',
	R2: 'franja de subtítulos libre',
	R3: 'tapaCabeza por reel',
	R4: 'inserts que no caben debajo de la barbilla',
	R5: 'stickers con alfa y borde tipo sticker',
	R6: 'SFX variados y offsets',
	R7: 'duración mínima por palabra',
	R8: 'titular sin palabras prohibidas',
	R9: 'sin pose de sticker repetida',
	R10: 'demos usables y completas',
	R11: 'archivos y rutas',
	R12: 'zona segura de Reels',
	R13: 'texto vivo en su lugar',
};

/** Resuelve una ruta de la EDL (relativa a public/) siguiendo symlinks. */
export function rutaEnPublic(rel: string): string {
	return join(PUBLICO, rel);
}

/** Lee el canal alfa de las 4 esquinas de un PNG con ffmpeg (sin dependencias nuevas). */
export function alfaEsquinas(rutaPng: string): number[] {
	const sonda = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', rutaPng], {encoding: 'utf8'}).trim();
	const [w, h] = sonda.split(',').map(Number);
	const esquinas: Array<[number, number]> = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
	return esquinas.map(([x, y]) => {
		const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', rutaPng, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-frames:v', '1', '-f', 'rawvideo', '-'], {maxBuffer: 1024});
		return buf[3];
	});
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Ancho y alto visibles de una imagen o video (con la rotación). null si no se pudo leer. */
export function dimensionesMedio(ruta: string): {ancho: number; alto: number; duracion: number | null} | null {
	if (!existsSync(ruta)) return null;
	if (ruta.toLowerCase().endsWith('.png')) {
		try {
			const buf = readFileSync(ruta);
			if (buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') return {ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20), duracion: null};
		} catch {
			// sigue con ffprobe
		}
	}
	const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ruta], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
	if (r.status !== 0) return null;
	try {
		const s = interpretarSondeo(JSON.parse(r.stdout) as FfprobeCrudo, ruta);
		return {ancho: s.video.anchoVisible, alto: s.video.altoVisible, duracion: s.duracion};
	} catch {
		return null;
	}
}

/** Slug del proyecto a partir de la base ("p/<slug>/base.mp4"). */
export function slugDeBase(base: string): string | null {
	return /^p\/([a-z0-9_][a-z0-9_-]{0,79})\/[^/]+$/.exec(base)?.[1] ?? null;
}

type InfoSticker = {info: InfoPng | null; verificacion: VerificacionSticker | null; error: string | null};

/** Lee un PNG de sticker una sola vez: tamaño, tinta (α ≥ 128) y verificación de alfa y borde. */
function leerSticker(ruta: string): InfoSticker {
	try {
		const img = leerPngArchivo(ruta);
		return {info: {ancho: img.ancho, alto: img.alto, tinta: cajaTinta(img, 128)}, verificacion: verificarSticker(img), error: null};
	} catch (error) {
		return {info: null, verificacion: null, error: error instanceof Error ? error.message : String(error)};
	}
}

/** Pose de un sticker: la de la EDL o, si no la trae, la del catálogo de poses por su archivo. */
function poseDe(s: Edicion['stickers'][number], catalogo: Map<string, string | null>): string | null {
	return s.mascota?.pose ?? catalogo.get(s.asset) ?? null;
}

function leerCatalogoMascota(): Map<string, string | null> {
	const rel = rutaCatalogoMascota(RAIZ);
	const mapa = new Map<string, string | null>();
	if (!rel) return mapa;
	const ruta = join(RAIZ, rel);
	try {
		const lista = JSON.parse(readFileSync(ruta, 'utf8')) as Array<{archivo?: string; pose?: string | null}>;
		for (const x of lista) if (typeof x.archivo === 'string') mapa.set(x.archivo, x.pose ?? null);
	} catch {
		// sin catálogo, solo cuenta la pose de la EDL
	}
	return mapa;
}

const palabrasDe = (texto: string): number => texto.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Valida una EDL ya parseada como objeto. `hallazgos` vacío = válida. */
export function validarEdicion(datos: unknown, opciones: OpcionesValidar = {}): ResultadoValidacion {
	const hallazgos: Hallazgo[] = [];
	const avisos: string[] = [];
	const r = EdicionValidada.safeParse(datos);
	if (!r.success) {
		for (const issue of r.error.issues) {
			hallazgos.push({regla: 'esquema', donde: issue.path.join('.') || '(raíz)', detalle: issue.message});
		}
		return {hallazgos, avisos, reglas: [], capas: []};
	}
	const e = r.data;
	const revisarArchivos = opciones.revisarArchivos !== false;
	const conReglas = opciones.reglas !== false;
	const estados = new Map<string, {revisados: number; fallas: number; na: string | null; nota: string[]}>();
	for (const id of Object.keys(NOMBRES_REGLAS)) estados.set(id, {revisados: 0, fallas: 0, na: null, nota: []});
	const fallar = (numero: string, regla: string, donde: string, detalle: string) => {
		hallazgos.push({regla, donde, detalle, numero});
		estados.get(numero)!.fallas++;
	};
	const revisado = (numero: string, n = 1) => {
		estados.get(numero)!.revisados += n;
	};
	const na = (numero: string, motivo: string) => {
		estados.get(numero)!.na = motivo;
	};

	// ── R11: archivos y rutas (Fase 0) ──
	if (revisarArchivos) {
		const referidos: Array<[string, string]> = [['base', e.base]];
		e.stickers.forEach((s) => {
			referidos.push([`stickers.${s.id}`, s.asset]);
			if (s.sfx) referidos.push([`stickers.${s.id}.sfx`, s.sfx.asset]);
		});
		e.tarjetas.forEach((t) => {
			if (t.sfx) referidos.push([`tarjetas.${t.id}.sfx`, t.sfx.asset]);
		});
		e.inserts.forEach((x) => {
			// Un motion no es archivo ("motion:<nombre>"): se revisan los archivos que usa (foto, logo).
			if (x.tipo === 'motion') {
				const r = x.motion ? resolverMotion(x.motion) : null;
				if (r?.nombre === 'skills-instaladas' && r.avatar) referidos.push([`inserts.${x.id}.motion.avatar`, r.avatar]);
				if (r?.nombre === 'reglas-apple' && r.logo) referidos.push([`inserts.${x.id}.motion.logo`, r.logo]);
				if (r?.nombre === 'skills-instaladas' && r.pie) referidos.push([`inserts.${x.id}.motion.pie`, LOGO_CLAUDE]);
			} else referidos.push([`inserts.${x.id}`, x.asset]);
			if (x.eventos) referidos.push([`inserts.${x.id}.eventos`, x.eventos]);
			if (x.sfx) referidos.push([`inserts.${x.id}.sfx`, x.sfx.asset]);
		});
		e.sfx_extra.forEach((x, i) => referidos.push([`sfx_extra.${i}`, x.sfx.asset]));
		for (const [donde, rel] of referidos) {
			revisado('R11');
			if (rel.startsWith('/') || rel.includes('..')) {
				fallar('R11', 'ruta', donde, `"${rel}" debe ser relativa a public/ y sin ".."`);
				continue;
			}
			const ruta = rutaEnPublic(rel);
			if (!existsSync(ruta)) {
				fallar('R11', 'archivo', donde, `no existe public/${rel}`);
				continue;
			}
			const real = realpathSync(ruta);
			if (real.includes(`${join(RAIZ, 'entrada')}`)) fallar('R11', 'ruta', donde, 'apunta a entrada/, que nunca se expone al render');
		}
	} else na('R11', 'no se revisaron archivos (revisarArchivos = false)');

	// ── R5: alfa y borde de los stickers ──
	const pngs = new Map<string, InfoSticker>();
	if (revisarArchivos) {
		for (const s of e.stickers) {
			const ruta = rutaEnPublic(s.asset);
			if (!existsSync(ruta)) continue; // ya lo marcó R11
			revisado('R5');
			if (!s.asset.toLowerCase().endsWith('.png')) {
				fallar('R5', 'alfa', `stickers.${s.id}`, 'el sticker debe ser PNG con transparencia');
				continue;
			}
			const info = pngs.get(s.asset) ?? leerSticker(ruta);
			pngs.set(s.asset, info);
			if (!info.verificacion) {
				fallar('R5', 'alfa', `stickers.${s.id}`, `no se pudo leer el PNG (${info.error}): debe ser PNG con transparencia`);
				continue;
			}
			const v = info.verificacion;
			if (!v.esquinasTransparentes) {
				fallar('R5', 'alfa', `stickers.${s.id}`, `esquinas con alfa ${v.alfaEsquinas.join('/')} (deben ser 0: fondo transparente)`);
				continue;
			}
			if (!v.ok) {
				const peor = v.orilla.peor ? ` (p. ej. rgb(${v.orilla.peor.rgb.join(', ')}) en ${v.orilla.peor.x},${v.orilla.peor.y})` : '';
				fallar('R5', 'R5', s.id, `no tiene borde tipo sticker: ${v.orilla.blancos} de ${v.orilla.total} píxeles de su orilla son blancos${peor} (${s.asset}, verificarSticker)`);
			}
		}
		if (e.stickers.length === 0) na('R5', 'no hay stickers');
	} else na('R5', 'no se revisaron archivos (revisarArchivos = false)');

	if (!conReglas) {
		for (const id of ['R1', 'R2', 'R3', 'R4', 'R6', 'R7', 'R8', 'R9', 'R10', 'R12', 'R13']) na(id, 'reglas apagadas (reglas = false)');
		return {edicion: e, hallazgos, avisos, reglas: resumirReglas(estados), capas: []};
	}

	// ── Contexto: estilo, cara, franja ──
	let estilo = opciones.estilo;
	if (!estilo) {
		const l = leerEstiloDirector();
		estilo = l.estilo;
	}
	let cara: CaraConsultable | null = null;
	let fuenteCara = 'cara.json';
	if (opciones.cara !== undefined) {
		cara = opciones.cara;
		fuenteCara = 'cara dada';
	} else {
		const slug = slugDeBase(e.base);
		const ruta = slug ? join(opciones.proyectos ?? join(RAIZ, 'proyectos'), slug, 'cara.json') : null;
		if (ruta && existsSync(ruta)) {
			try {
				const leida = leerCara(ruta);
				// Una cara.json de otra base (p. ej. de antes de rehacer los cortes) no sirve: dura distinto.
				if (Math.abs(leida.duracion_s - e.duracion_s) > 2 / FPS) {
					avisos.push(`proyectos/${slug}/cara.json dura ${leida.duracion_s} s y la edición ${e.duracion_s} s: es de otra base; R1 y R4 quedan N/A hasta que corras npx tsx herramientas/cara.ts ${slug} --forzar`);
				} else {
					cara = leida;
					fuenteCara = `proyectos/${slug}/cara.json`;
				}
			} catch (error) {
				avisos.push(`no pude leer ${ruta} (${error instanceof Error ? error.message : String(error)}): R1 y R4 quedan N/A`);
			}
		} else {
			avisos.push(`no hay cara.json para la base ${e.base}: R1 (debajo de la cabeza) y R4 (inserts) quedan N/A; corre npx tsx herramientas/cara.ts <slug>`);
		}
	}
	const zooms = zoomsDeEdicion(e.zooms);
	// Los subtítulos vivos se mueven contigo (R13 los revisa); la franja la marcan los que siguen fijos.
	const subsFijos = e.texto_vivo?.subtitulos?.activo ? e.subtitulos.filter((s) => e.texto_vivo!.subtitulos!.normales.includes(s.id)) : e.subtitulos;
	const franja: Franja = franjaDeEdicion(subsFijos, e.estilos, estilo.franja.margen.valor) ?? franjaDeEstilo(estilo);
	const ctx = crearContexto({cara, estilo, zooms, franja, estilos: e.estilos});
	const margenBoca = estilo.cabeza.margen_boca.valor;

	// ── Geometría de lo que se ve ──
	const capas: CapaRevisada[] = [];
	const estiloSticker = resolverEstiloSticker(e.estilos?.stickers);
	for (const s of e.stickers) {
		const info = pngs.get(s.asset)?.info ?? null;
		const {caja, aproximada} = cajaVisibleSticker(s, info, estiloSticker);
		if (aproximada && revisarArchivos) avisos.push(`${s.id}: no pude leer su PNG; su caja se supone cuadrada`);
		capas.push({id: s.id, tipo: 'sticker', desde: s.desde, hasta: s.hasta, caja: redondearCaja(caja), tapaCabeza: s.tapaCabeza});
	}
	const estiloTarjeta = resolverEstiloTarjeta(e.estilos?.tarjetas);
	const tapaTarjeta = new Map(e.tarjetas.map((t) => [t.id, t.tapaCabeza]));
	for (const t of cajasVisiblesTarjetas(e.tarjetas, estiloTarjeta)) capas.push({id: t.id, tipo: 'tarjeta', desde: t.desde, hasta: t.hasta, caja: redondearCaja(t.caja), tapaCabeza: tapaTarjeta.get(t.id) ?? false});
	const estiloTitular = resolverEstiloTitular(e.estilos?.titular);
	if (e.titular) {
		const g = geometriaTitular(e.titular, estiloTitular);
		capas.push({id: 'titular', tipo: 'titular', desde: e.titular.desde, hasta: e.titular.hasta, caja: redondearCaja(g.caja), tapaCabeza: e.titular.tapaCabeza});
	}
	const medios = new Map<string, {ancho: number; alto: number; duracion: number | null} | null>();
	for (const ins of e.inserts) {
		let medio: {ancho: number; alto: number} | null = null;
		if (ins.layout === 'tarjeta' && ins.tipo !== 'demo' && ins.tipo !== 'motion' && ins.caja?.h === undefined) {
			if (!medios.has(ins.asset)) medios.set(ins.asset, revisarArchivos ? dimensionesMedio(rutaEnPublic(ins.asset)) : null);
			medio = medios.get(ins.asset) ?? null;
		}
		const {caja, aproximada} = cajaVisibleInsert(ins, medio);
		if (aproximada) avisos.push(`${ins.id}: no pude leer la proporción de ${ins.asset}; se supone 16:9`);
		capas.push({id: ins.id, tipo: 'insert', desde: ins.desde, hasta: ins.hasta, caja: redondearCaja(caja), tapaCabeza: ins.tapaCabeza});
		if (ins.texto) {
			// Insert.tsx dibuja el texto como tarjeta normal en la y del estilo de tarjetas.
			const t = cajasVisiblesTarjetas([{id: `${ins.id}-texto`, desde: ins.desde, hasta: ins.hasta, texto: ins.texto, caja: {x: estiloTarjeta.x, y: estiloTarjeta.y}, grupo: null, variante: 'normal', entrada: 'corte', tapaCabeza: ins.tapaCabeza, sfx: null}], estiloTarjeta)[0];
			capas.push({id: `${ins.id}-texto`, tipo: 'texto-insert', desde: ins.desde, hasta: ins.hasta, caja: redondearCaja(t.caja), tapaCabeza: ins.tapaCabeza || ins.layout !== 'tarjeta'});
		}
	}

	// ── R1: debajo de tu boca (zona protegida: boca, nariz y ojos) ──
	if (!cara) na('R1', 'sin cara.json: no sé dónde va tu cabeza');
	else {
		const estimada = !bocaMedida(cara);
		if (estimada) {
			avisos.push(`${fuenteCara} no trae tu boca (es de antes de medirla): R1 la estima como barbilla − ${estilo.cabeza.factor_boca.valor} × alto de la cara; vuelve a correr npx tsx herramientas/cara.ts <slug> --forzar para medirla con Vision`);
			estados.get('R1')!.nota.push('boca estimada (cara.json sin boca)');
		}
		for (const c of capas) {
			if (c.tipo === 'titular') continue;
			const ins = c.tipo === 'insert' || c.tipo === 'texto-insert' ? e.inserts.find((x) => c.id === x.id || c.id === `${x.id}-texto`) : null;
			// Pantalla completa te tapa entero; flotante va encima de tu toma desenfocada a propósito (src/estilo/flotante.ts).
			if (ins && ins.layout !== 'tarjeta') continue;
			if (c.tapaCabeza) continue;
			// Mientras un insert a pantalla completa tapa la toma (p. ej. una escena del avatar), tu cara no está en
			// pantalla: lo que va encima de él no puede taparla. Solo si la capa cae entera dentro de ese insert.
			const dentroDePantallaCompleta = e.inserts.some((x) => x.layout === 'pantalla-completa' && x.desde <= c.desde + 1e-6 && c.hasta <= x.hasta + 1e-6);
			if (dentroDePantallaCompleta) continue;
			revisado('R1');
			const peor = peorBoca(cara, c.desde, c.hasta, zooms);
			if (!peor) continue;
			const limite = r1(peor.y + margenBoca);
			if (c.caja.y0 < limite - 0.5) {
				fallar(
					'R1',
					'R1',
					c.id,
					`invade la cara ${r1(limite - c.caja.y0)} px en t=${peor.t} s (borde de arriba en y=${c.caja.y0}; boca máx ${peor.y}${peor.estimada ? ` estimada (barbilla − ${estilo.cabeza.factor_boca.valor} × alto de la cara)` : ''} + ${margenBoca} = ${limite}: nada tapa tu boca, nariz ni ojos; ${fuenteCara})`,
				);
			}
		}
		if (e.titular) {
			revisado('R1');
			const t = capas.find((c) => c.tipo === 'titular')!;
			let peor: {px: number; t: number; cabeza: number} | null = null;
			const a = Math.max(0, Math.ceil((e.titular.desde - 0.2) * FPS - 1e-6));
			const b = Math.min(cara.cuadros.length - 1, Math.floor((e.titular.hasta + 0.2) * FPS + 1e-6));
			for (let j = a; j <= b; j++) {
				const k = cajaCara(cara, j / FPS, j / FPS, zooms, {margen_s: 0});
				if (!k) continue;
				const px = encimeVertical(t.caja, {x0: k.x, y0: k.y, x1: k.x + k.w, y1: k.y + k.h});
				if (px > 0.5 && (!peor || px > peor.px)) peor = {px, t: r2(j / FPS), cabeza: k.y};
			}
			if (peor) {
				fallar('R1', 'R1', 'titular', `toca la cara ${r1(peor.px)} px en t=${peor.t} s (borde de abajo del titular en y=${t.caja.y1}; frente en y=${r1(peor.cabeza)}; ${fuenteCara})`);
			}
		}
		if (estados.get('R1')!.revisados === 0 && estados.get('R1')!.fallas === 0) na('R1', 'no hay capas que deban ir debajo de tu boca');
	}

	// ── R2: franja de subtítulos ──
	for (const c of capas) {
		const ins = c.tipo === 'insert' ? e.inserts.find((x) => x.id === c.id) : null;
		if (ins && ins.layout === 'pantalla-completa') continue;
		revisado('R2');
		const px = Math.min(c.caja.y1, franja.y1) - Math.max(c.caja.y0, franja.y0);
		if (px > 0.5) {
			fallar('R2', 'R2', c.id, `cruza la franja de subtítulos ${r1(px)} px (ocupa y=${c.caja.y0}–${c.caja.y1}; franja ${franja.y0}–${franja.y1}: ${franja.fuente})`);
		}
	}
	if (estados.get('R2')!.revisados === 0 && estados.get('R2')!.fallas === 0) na('R2', 'no hay capas');

	// ── R12: zona segura de Reels ──
	for (const c of capas) {
		const ins = c.tipo === 'insert' ? e.inserts.find((x) => x.id === c.id) : null;
		if (ins && ins.layout === 'pantalla-completa') continue;
		revisado('R12');
		// Un motion flotante se revisa como capa (lo legible en la zona cian x 135–945, y 220–1600), no como insert amplio.
		const clase = c.tipo === 'titular' || (c.tipo === 'insert' && ins?.layout !== 'flotante') ? 'amplia' : 'capa';
		const fuera = fueraDeZona(c.caja, clase);
		if (fuera.length) fallar('R12', 'R12', c.id, `${fuera.join('; ')} (zona segura de Reels: src/estilo/zona-segura.ts)`);
	}
	for (const s of e.subtitulos) {
		revisado('R12');
		const fuera = fueraDeZona(redondearCaja(cajaVisibleSubtitulo(s, e.estilos)), 'subtitulo');
		if (fuera.length) fallar('R12', 'R12', s.id, `subtítulo: ${fuera.join('; ')} (zona segura de Reels: src/estilo/zona-segura.ts)`);
	}
	if (estados.get('R12')!.revisados === 0 && estados.get('R12')!.fallas === 0) na('R12', 'no hay capas ni subtítulos');

	// ── R13: texto vivo ──
	const vivo = e.texto_vivo;
	if (!vivo || (vivo.elementos.length === 0 && !vivo.subtitulos?.activo)) na('R13', 'la edición no usa texto vivo');
	else {
		const pantallaCompleta = (desde: number, hasta: number) => e.inserts.some((x) => x.layout === 'pantalla-completa' && x.desde <= desde + 1e-6 && hasta <= x.hasta + 1e-6);
		const peorEncime = (caja: {x0: number; y0: number; x1: number; y1: number}, desde: number, hasta: number) => {
			if (!cara) return null;
			let peor: {px: number; t: number} | null = null;
			for (let j = Math.max(0, aCuadro(desde)); j <= Math.min(cara.cuadros.length - 1, aCuadro(hasta)); j++) {
				const k = cajaCara(cara, j / FPS, j / FPS, zooms, {margen_s: 0});
				if (!k) continue;
				const ix = Math.min(caja.x1, k.x + k.w) - Math.max(caja.x0, k.x);
				const iy = Math.min(caja.y1, k.y + k.h) - Math.max(caja.y0, k.y);
				if (ix > 0.5 && iy > 0.5 && (!peor || ix * iy > peor.px)) peor = {px: ix * iy, t: r2(j / FPS)};
			}
			return peor;
		};
		for (const el of vivo.elementos) {
			revisado('R13');
			const caja = redondearCaja(cajaElemento(el));
			const fuera = fueraDeZona(caja, 'capa');
			if (fuera.length) fallar('R13', 'R13', el.id, `${el.tipo}: ${fuera.join('; ')} (zona segura de Reels: src/estilo/zona-segura.ts)`);
			const detras = vaDetras(el) && vivo.persona !== null;
			if (!detras && !pantallaCompleta(el.desde, el.hasta)) {
				const p = peorEncime(caja, el.desde, el.hasta);
				if (p) fallar('R13', 'R13', el.id, `${el.tipo} se encima con tu cara (${Math.round(p.px)} px² en t=${p.t} s; caja x ${caja.x0}–${caja.x1}, y ${caja.y0}–${caja.y1}; ${fuenteCara})`);
			}
		}
		const op = vivo.subtitulos;
		if (op?.activo) {
			const normales = new Set(op.normales);
			const clave = new Set(e.resaltar_palabras);
			for (const s of e.subtitulos) {
				if (normales.has(s.id)) continue;
				revisado('R13');
				const x = s.caja?.x ?? 540;
				const y = s.caja?.y ?? 1500;
				const tams = s.palabras.map((p) => op.tamano_px * (clave.has(p.i) ? op.escala_clave : 1));
				const w = s.palabras.reduce((a, p, i) => a + anchoTexto(p.t, clave.has(p.i) ? op.voz_clave : 'sans', tams[i]), 0) + (s.palabras.length - 1) * op.tamano_px * 0.26;
				const alto = Math.max(...tams);
				const caja = redondearCaja({x0: x - w / 2, x1: x + w / 2, y0: y - alto * VOCES.sans.alto_mayuscula, y1: y + alto * 0.28});
				const fuera = fueraDeZona(caja, 'subtitulo');
				if (fuera.length) fallar('R13', 'R13', s.id, `subtítulo vivo: ${fuera.join('; ')} (zona segura de Reels)`);
				if (cara && !pantallaCompleta(s.desde, s.hasta)) {
					const boca = peorBoca(cara, s.desde, s.hasta, zooms);
					if (boca && caja.y0 < boca.y + margenBoca - 0.5) fallar('R13', 'R13', s.id, `subtítulo vivo arriba de tu boca: borde de arriba en y=${caja.y0} y la boca llega a ${boca.y} + ${margenBoca} en t=${boca.t} s (${fuenteCara})`);
				}
			}
		}
		if (estados.get('R13')!.revisados === 0 && estados.get('R13')!.fallas === 0) na('R13', 'texto vivo sin elementos ni subtítulos vivos');
	}

	// ── R3: tapaCabeza por reel ──
	{
		// Solo cuentan las excepciones por controversia (stickers y tarjetas). Los inserts que no caben debajo de la
		// cara con ≥ 70 % de ancho legible van con tapaCabeza por R4 (excepción 1 del plan) y no entran aquí.
		const tapan = [...e.stickers, ...e.tarjetas].filter((x) => x.tapaCabeza).map((x) => x.id);
		const p90 = estilo.tapa_cabeza_p90;
		const maximo = p90.valor === null ? 1 : Math.floor(p90.valor + 1e-9);
		const fuente = p90.valor === null ? 'p90 sin medir: máximo 1 por reel (plan, excepción 2)' : `p90 del estilo (${textoMedida(p90)})`;
		revisado('R3');
		if (tapan.length > maximo) fallar('R3', 'R3', tapan.join(', '), `${tapan.length} capas con tapaCabeza = true y el máximo es ${maximo} (${fuente}; el titular no cuenta)`);
		else estados.get('R3')!.nota.push(`${tapan.length} de máx. ${maximo} (${fuente})`);
	}

	// ── R4: inserts que no caben debajo de la barbilla ──
	// Los memes (biblioteca/memes/) tapan tu cara a propósito, como en tus reels: R4 no aplica (src/estilo/memes.ts).
	const insertsTarjeta = e.inserts.filter((x) => x.layout === 'tarjeta' && !esMeme(x.asset));
	if (insertsTarjeta.length === 0) na('R4', e.inserts.some((x) => x.layout === 'tarjeta') ? 'solo hay memes en tarjeta (tapan la cara a propósito)' : 'no hay inserts en tarjeta');
	else if (!cara) na('R4', 'sin cara.json: no sé cuánto cabe debajo de tu barbilla');
	else {
		const minimo = estilo.cabeza.ancho_legible_min.valor;
		for (const ins of insertsTarjeta) {
			const c = capas.find((x) => x.id === ins.id)!;
			const aspecto = (c.caja.y1 - c.caja.y0) / Math.max(1, c.caja.x1 - c.caja.x0);
			const {ancho, banda} = anchoLegibleDebajo(ctx, ins.desde, ins.hasta, aspecto);
			revisado('R4');
			if (ancho >= minimo && ins.tapaCabeza) {
				fallar('R4', 'R4', ins.id, `cabe debajo de la barbilla con ${ancho} px de ancho (≥ ${minimo}, 70 %): debe ir debajo con tapaCabeza = false (${banda.origen}; ${fuenteCara})`);
			} else if (ancho < minimo && !ins.tapaCabeza) {
				fallar('R4', 'R4', ins.id, `debajo de la barbilla solo cabe a ${ancho} px de ancho (${r1((100 * ancho) / 1080)} % < 70 %): debe ir con tapaCabeza = true (${banda.origen}; ${fuenteCara})`);
			}
		}
	}

	// ── R6: SFX ──
	{
		let catalogo: Catalogo | null = null;
		if (opciones.catalogoSfx !== undefined) catalogo = opciones.catalogoSfx;
		else {
			try {
				catalogo = leerCatalogo();
			} catch (error) {
				avisos.push(`no pude leer el catálogo de SFX (${error instanceof Error ? error.message : String(error)}): R6 solo revisa los offsets`);
			}
		}
		let estiloSfx = opciones.estiloSfx;
		if (!estiloSfx) {
			try {
				estiloSfx = leerEstiloSfx().estilo;
			} catch {
				estiloSfx = undefined;
			}
		}
		const [o0, o1] = estiloSfx?.offset_cuadros.valor ?? [-2, 0];
		const enCatalogo = new Set((catalogo?.archivos ?? []).map((a) => a.archivo));
		const eventos: Array<{id: string; tipo: 'sticker' | 'tarjeta' | 'insert' | 'zoom'; t: number; sfx: Edicion['stickers'][number]['sfx']}> = [
			...e.stickers.map((s) => ({id: s.id, tipo: 'sticker' as const, t: s.desde, sfx: s.sfx})),
			// Los tecleos de los prompts (sfx.duracion_frames) no son del selector: se revisan aparte, abajo.
			...e.tarjetas.filter((s) => !esTecleo(s.sfx)).map((s) => ({id: s.id, tipo: 'tarjeta' as const, t: s.desde, sfx: s.sfx})),
			...e.inserts.map((s) => ({id: s.id, tipo: 'insert' as const, t: s.desde, sfx: s.sfx})),
			...e.zooms.map((z) => ({id: z.id, tipo: 'zoom' as const, t: z.desde, sfx: e.sfx_extra.find((x) => Math.round(x.en * FPS) === Math.round(z.desde * FPS))?.sfx ?? null})),
		];
		const fuera = eventos.filter((x) => x.sfx && !enCatalogo.has(x.sfx.asset));
		for (const x of fuera) avisos.push(`${x.id}: su SFX ${x.sfx!.asset} no está en biblioteca/sfx/catalogo.json (no reviso con él la no-repetición ni el silencio)`);
		// Offsets de stickers (−2…0 de su primer cuadro visible), también para los que no son del catálogo.
		for (const s of e.stickers) {
			if (!s.sfx) continue;
			revisado('R6');
			if (s.sfx.offset_frames < o0 || s.sfx.offset_frames > o1) {
				fallar('R6', 'R6', s.id, `su SFX arranca a ${s.sfx.offset_frames} cuadros de su primer cuadro visible (debe ir entre ${o0} y ${o1}; ${estiloSfx?.offset_cuadros.fuente ?? 'supuesto'})`);
			}
		}
		// Tecleos (regla del prompt): solo en tarjetas "prompt", del catálogo y sin pasarse de lo que dura el archivo.
		const porArchivo = new Map((catalogo?.archivos ?? []).map((a) => [a.archivo, a]));
		for (const t of e.tarjetas) {
			if (!esTecleo(t.sfx)) {
				if (t.variante === 'prompt' && !t.sfx) avisos.push(`${t.id}: es un prompt y va sin tecleo (corre el director sin --sin-sfx)`);
				continue;
			}
			revisado('R6');
			const sfx = t.sfx!;
			if (t.variante !== 'prompt') fallar('R6', 'R6', t.id, `lleva un SFX recortado (duracion_frames ${sfx.duracion_frames}) y solo los prompts teclean`);
			const a = porArchivo.get(sfx.asset);
			if (catalogo && !a) fallar('R6', 'R6', t.id, `su tecleo ${sfx.asset} no está en biblioteca/sfx/catalogo.json`);
			if (a && sfx.duracion_frames! > Math.floor(a.duracion_s * FPS) + 1) fallar('R6', 'R6', t.id, `su tecleo dura ${sfx.duracion_frames} cuadros y el archivo ${a.id} solo ${Math.floor(a.duracion_s * FPS)}`);
			if (!(sfx.ganancia_db <= 0 && sfx.ganancia_db >= -40)) fallar('R6', 'R6', t.id, `ganancia del tecleo ${sfx.ganancia_db} dB fuera de [−40, 0]`);
		}
		if (catalogo) {
			const dentro = eventos.filter((x) => !x.sfx || enCatalogo.has(x.sfx.asset));
			const conSonido = dentro.filter((x) => x.sfx).length;
			const elecciones: Eleccion[] = dentro.map((x) => ({
				id: x.id,
				tipo: x.tipo,
				t: x.t,
				sfx: x.sfx ? {...x.sfx} : null,
				motivo: x.sfx ? 'sonido' : catalogo!.eventos[x.tipo].length === 0 ? 'sin-categoria' : 'silencio-planeado',
				categoria: null,
				fuente_id: null,
				archivo_id: null,
				nivel_rel_db: null,
				respaldo: false,
			}));
			let violaciones = revisarReglas(elecciones, catalogo, {estilo: estiloSfx, ventanaInicial: []});
			// Offsets de stickers ya revisados arriba; sin ningún SFX elegido, el silencio no se revisa (aún no se eligieron).
			violaciones = violaciones.filter((v) => !(v.regla === 'offset' && e.stickers.some((s) => s.id === v.evento)));
			if (conSonido === 0) {
				violaciones = violaciones.filter((v) => v.regla !== 'silencio-p10-p90');
				if (dentro.length > 0) avisos.push('ningún evento tiene SFX del catálogo: el % de silencio no se revisa (corre herramientas/sfx/elegir.ts o el director sin --sin-sfx)');
			}
			revisado('R6', conSonido);
			for (const v of violaciones) fallar('R6', 'R6', v.evento ?? 'sfx', `${v.regla}: ${v.detalle} (biblioteca/sfx/catalogo.json, ${estiloSfx?.prob_silencio.fuente ?? 'supuesto'})`);
		}
		const s6 = estados.get('R6')!;
		if (s6.revisados === 0 && s6.fallas === 0) na('R6', 'no hay SFX que revisar');
	}

	// ── R7: duración mínima por palabra ──
	{
		const min = estilo.min_por_palabra_s;
		const revisar = (id: string, texto: string, dura: number, que: string) => {
			const n = palabrasDe(texto);
			if (n === 0) return;
			revisado('R7');
			const necesita = r2(n * min.valor);
			if (dura + 1 / FPS / 2 < necesita) {
				fallar('R7', 'R7', id, `${que} "${texto.replace(/\n/g, ' / ')}" dura ${r2(dura)} s y necesita ${necesita} s (${n} palabras × ${min.valor} s; ${min.fuente})`);
			}
		};
		if (e.titular) revisar('titular', e.titular.texto, e.titular.hasta - e.titular.desde, 'el titular');
		const visibles = cajasVisiblesTarjetas(e.tarjetas, estiloTarjeta);
		for (const t of e.tarjetas) {
			const v = visibles.find((x) => x.id === t.id);
			const hasta = v ? v.hasta : t.hasta;
			revisar(t.id, t.texto, (Math.round(hasta * FPS) - aCuadro(t.desde)) / FPS, 'la tarjeta');
		}
		for (const ins of e.inserts) if (ins.texto) revisar(ins.id, ins.texto, ins.hasta - ins.desde, 'el texto del insert');
		// Texto vivo: cada línea de un titular cuenta desde que entra (su `en`).
		for (const el of e.texto_vivo?.elementos ?? []) {
			if (el.tipo === 'titular') for (const [i, l] of el.lineas.entries()) revisar(`${el.id}.${i}`, l.texto, el.hasta - (l.en ?? el.desde), 'la línea del titular vivo');
			else if (el.tipo === 'impacto') revisar(el.id, [el.arriba, el.texto].filter(Boolean).join(' '), el.hasta - el.desde, 'el impacto');
			else if (el.tipo === 'nota') revisar(el.id, el.texto, el.hasta - el.desde, 'la nota');
			else if (el.tipo === 'pildora' && (el.contenido.clase === 'texto' || el.contenido.clase === 'iconos')) revisar(el.id, el.contenido.texto, el.hasta - el.desde, 'la píldora');
		}
		if (estados.get('R7')!.revisados === 0 && estados.get('R7')!.fallas === 0) na('R7', 'no hay titular, tarjetas ni textos de inserts');
	}

	// ── R8: voice.md ──
	if (!e.titular) na('R8', 'no hay titular');
	else {
		let reglasVoz: ReglaVoz[] | null = null;
		let fuenteVoz = 'voice.md';
		if (opciones.voz !== undefined) {
			reglasVoz = opciones.voz === null ? null : reglasDeVoz(opciones.voz);
		} else {
			const v = leerVoz();
			reglasVoz = v?.reglas ?? null;
			if (v) fuenteVoz = v.fuente;
		}
		if (!reglasVoz || reglasVoz.length === 0) na('R8', 'no encontré la lista "Prohibido" de voice.md (su ruta va en creador.json → voz)');
		else {
			revisado('R8');
			for (const c of revisarVoz(e.titular.texto, reglasVoz)) {
				if (c.nivel === 'aviso') avisos.push(`titular: ${c.descripcion} ("${c.texto}")`);
				else {
					fallar('R8', 'R8', 'titular', `trae ${c.descripcion}: "${c.texto}" (${fuenteVoz}, sección Prohibido)`);
				}
			}
		}
	}

	// ── R9: pose repetida ──
	{
		const catalogoMascota = leerCatalogoMascota();
		const ordenados = [...e.stickers].sort((a, b) => a.desde - b.desde || a.id.localeCompare(b.id));
		let conPose = 0;
		for (let i = 0; i < ordenados.length; i++) {
			const pose = poseDe(ordenados[i], catalogoMascota);
			if (pose) conPose++;
			if (i === 0) continue;
			const previa = poseDe(ordenados[i - 1], catalogoMascota);
			if (!pose || !previa) continue;
			revisado('R9');
			if (pose === previa) {
				fallar('R9', 'R9', ordenados[i].id, `repite la pose "${pose}" del sticker anterior (${ordenados[i - 1].id}) (${rutaCatalogoMascota(RAIZ) ?? CATALOGO_MASCOTA})`);
			}
		}
		if (conPose < 2) na('R9', 'menos de 2 stickers con pose');
	}

	// ── R10: demos ──
	{
		const demos = e.inserts.filter((x) => x.tipo === 'demo');
		// Motion graphics: que duren lo que necesitan para que todo entre y se lea (src/estilo/motion.ts).
		const motions = e.inserts.filter((x) => x.tipo === 'motion' && x.motion);
		for (const ins of motions) {
			revisado('R10');
			const minimo = duracionMinimaMotion(ins.motion!);
			const dura = ins.hasta - ins.desde;
			if (dura + 1 / FPS < minimo) fallar('R10', 'R10', ins.id, `el motion "${ins.motion!.nombre}" dura ${r2(dura)} s y necesita ${minimo} s para que todo entre y se lea (~0.3 s por palabra; src/estilo/motion.ts)`);
		}
		if (demos.length === 0 && motions.length === 0) na('R10', 'no hay demos');
		for (const ins of demos) {
			const ruta = rutaEnPublic(ins.asset);
			if (!existsSync(ruta)) continue; // R11
			revisado('R10');
			if (esTerminal(ins)) {
				let datos: unknown;
				try {
					datos = JSON.parse(readFileSync(ruta, 'utf8'));
				} catch {
					fallar('R10', 'R10', ins.id, `${ins.asset} no es JSON válido (demo de terminal)`);
					continue;
				}
				const errores = erroresDemo(datos);
				for (const x of errores) fallar('R10', 'R10', ins.id, `la demo de terminal no cumple su contrato: ${x} (${ins.asset}, src/estilo/terminal.ts)`);
				if (errores.length === 0) {
					const demo = DemoTerminalEsquema.parse(datos);
					const p = prepararTerminal({...ajustesDeDemo(demo), ancho: ins.caja?.w, alto: ins.caja?.h});
					const dura = ins.hasta - ins.desde;
					if (dura + 1 / FPS < p.duracion) fallar('R10', 'R10', ins.id, `dura ${r2(dura)} s y la terminal necesita ${r2(p.duracion)} s (retraso + guion + cola; ${ins.asset})`);
				}
			} else {
				const dir = dirname(ruta);
				if (!demoUsable(dir)) fallar('R10', 'R10', ins.id, `la demo no se puede usar: ${estadoRevision(dir).motivo} (revision.json; la revisas tú con estudio.ts revision <slug> --aprobar)`);
				const rutaToma = join(dir, 'toma.json');
				if (existsSync(rutaToma)) {
					const t = TomaDemo.safeParse(JSON.parse(readFileSync(rutaToma, 'utf8')));
					if (t.success) {
						const fin = ins.trim_desde + (ins.hasta - ins.desde);
						if (fin > t.data.duracion_s + 1 / FPS) fallar('R10', 'R10', ins.id, `pide la toma hasta el segundo ${r2(fin)} (trim ${ins.trim_desde} + ${r2(ins.hasta - ins.desde)} s) y la toma dura ${r2(t.data.duracion_s)} s (toma.json)`);
					} else fallar('R10', 'R10', ins.id, 'toma.json no tiene la forma esperada (src/estilo/demo.ts)');
				} else fallar('R10', 'R10', ins.id, `falta toma.json junto a ${ins.asset}`);
			}
		}
	}

	return {edicion: e, hallazgos, avisos, reglas: resumirReglas(estados), capas};
}

function resumirReglas(estados: Map<string, {revisados: number; fallas: number; na: string | null; nota: string[]}>): EstadoRegla[] {
	return [...estados.entries()].map(([regla, s]) => {
		const nombre = NOMBRES_REGLAS[regla];
		if (s.fallas > 0) return {regla, nombre, estado: 'FALLA', detalle: `${s.fallas} falla(s)`};
		if (s.na !== null && s.revisados === 0) return {regla, nombre, estado: 'N/A', detalle: s.na};
		return {regla, nombre, estado: 'PASA', detalle: s.nota.length ? s.nota.join('; ') : `${s.revisados} revisado(s)`};
	});
}

/** "cumple X de Y reglas (Z N/A)". */
export function fraseReglas(reglas: readonly EstadoRegla[]): string {
	const na = reglas.filter((r) => r.estado === 'N/A').length;
	const total = reglas.length - na;
	const cumple = reglas.filter((r) => r.estado === 'PASA').length;
	return t('validar.frase', {cumple, total, na});
}

/** Cómo se imprime un hallazgo: "[R1] k3: …" (las de la Fase 0 llevan su nombre: "[R11 archivo] base: …"). */
export const textoHallazgo = (h: Hallazgo): string => `[${h.numero && h.numero !== h.regla ? `${h.numero} ${h.regla}` : h.regla}] ${h.donde}: ${h.detalle}`;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const ruta = args.find((a) => !a.startsWith('--'));
	const json = args.includes('--json');
	if (!ruta) throw fallo(t('validar.que'), t('validar.sin_ruta'), t('validar.sin_ruta.paso'), 2);
	if (!existsSync(ruta)) throw fallo(t('validar.que'), t('validar.no_existe', {ruta}), t('fallo.paso.revisar_ruta'), 2);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(t('validar.que'), t('validar.no_json', {ruta}), t('validar.no_json.paso'), 2, error);
	}
	const r = validarEdicion(datos);
	if (json) console.log(JSON.stringify({hallazgos: r.hallazgos, reglas: r.reglas, avisos: r.avisos, capas: r.capas}, null, '\t'));
	if (r.hallazgos.length > 0) {
		if (!json) {
			console.log(t('validar.problemas', {ruta, n: r.hallazgos.length}));
			for (const h of r.hallazgos) console.log(`  - ${textoHallazgo(h)}`);
			if (r.reglas.length) console.log(`  ${fraseReglas(r.reglas)}`);
			for (const a of r.avisos) console.log(`  · ${a}`);
		}
		throw fallo(t('validar.que_edicion'), t('validar.reglas_fallan', {n: r.hallazgos.length}), t('validar.reglas_fallan.paso'), 2);
	}
	if (!json) {
		console.log(t('validar.valida', {ruta, frase: fraseReglas(r.reglas)}));
		for (const x of r.reglas) console.log(`  ${x.regla} ${x.estado.padEnd(5)} ${x.nombre}: ${x.detalle}`);
		for (const a of r.avisos) console.log(`  · ${a}`);
	}
}

if (esPrincipal(import.meta.url)) {
	void correr(main);
}
