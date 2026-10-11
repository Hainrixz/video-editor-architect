/**
 * Selector de SFX: a cada evento de la edición (sticker, tarjeta, insert, zoom, titular) le toca un SFX del
 * catálogo o silencio. Variado, a veces callado, determinista con su semilla.
 *
 *   npx tsx herramientas/sfx/elegir.ts --edicion proyectos/<slug>/edicion-vN.json --salida proyectos/<slug>/edicion-vM.json
 *        [--semilla <texto>] [--voz-lufs <n>] [--guardar-historial] [--sin-historial] [--reemplazar] [--preferir-fuente <fuente>]
 *        [--solo-fuente <fuente>,...] [--todas-las-fuentes]   (por defecto: creador.json → sfx.solo_fuentes)
 *   npx tsx herramientas/sfx/elegir.ts --eventos eventos.json [--salida elecciones.json] [--voz-lufs <n>] [--semilla <texto>]
 *   npx tsx herramientas/sfx/elegir.ts --simular 1000 [--semilla <texto>]
 *
 * Reglas duras (plan, Fase 3):
 *  - Ningún archivo, ni sus variantes de tono ni un casi igual (mismo fuente_id), se repite en los últimos 5
 *    eventos CON sonido. El historial (estilo/historial-sfx.json) trae las últimas 5 del video anterior, para
 *    no arrancar repitiendo, y cuántas veces sonó cada fuente en los últimos 3 videos, para preferir las que
 *    menos sonaron.
 *  - Ninguna categoría va más de 2 veces seguidas. Un evento en silencio no cuenta para la racha.
 *  - La no-repetición manda sobre el tipo: si las categorías del tipo no dejan opción, se usa la de un tipo
 *    compatible (sticker ↔ tarjeta, insert ↔ zoom), luego cualquiera del mapeo y, si nada sirve, silencio.
 *  - Silencio por video dentro de [p10, p90] de `prob_silencio` (se reparte al azar con la semilla; un
 *    silencio forzado descuenta uno planeado más adelante).
 *  - El SFX arranca entre offset_cuadros[0] y [1] cuadros del evento (supuesto −2…0).
 *  - Nivel bajo tu voz: un centro por video dentro de ganancia_db (supuesto −14…−8 dB) y ±2 dB por evento.
 *    La ganancia del archivo = nivel relativo + sonoridad de tu voz − sonoridad momentánea máx. del archivo
 *    (sin pasar de 0 dB: un archivo que ni a 0 dB llega al mínimo no se elige).
 *  - Solo categorías con ≥ 5 fuentes (lo revisa leerCatalogo) y nunca algo pendiente de tu aprobación.
 *
 * Los parámetros salen de estilo/estilo.json → sfx cuando exista; hasta entonces son supuestos (n = 0).
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {EdicionBase, type Edicion} from '../../src/esquema/edicion.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {
	contextoHistorial,
	crearAleatorio,
	elegirConPeso,
	enteroEntre,
	escribirJson,
	ESTILO_SFX_SUPUESTO,
	FPS_SFX,
	leerCatalogo,
	leerEstiloSfx,
	leerFuentesPermitidas,
	leerHistorial,
	medirSonoridad,
	problemasDelCatalogo,
	redondear,
	registrarVideo,
	REGLAS_SFX,
	RUTA_CATALOGO,
	RUTA_HISTORIAL,
	TIPOS_COMPATIBLES,
	TIPOS_EVENTO,
	usable,
	type ArchivoSfx,
	type Catalogo,
	type EstiloSfx,
	type HistorialSfx,
	type TipoEvento,
} from '../lib/sfx.ts';

// ───────────────────────────── Tipos ─────────────────────────────

export type EventoSfx = {id: string; tipo: TipoEvento; t: number};

/** Lo que va en `sfx` de la EDL (contrato Sfx de src/esquema/edicion.ts). */
export type SfxElegido = {asset: string; ganancia_db: number; offset_frames: number; variante: number};

export type MotivoEleccion = 'sonido' | 'silencio-planeado' | 'sin-opcion' | 'sin-categoria';

export type Eleccion = {
	id: string;
	tipo: TipoEvento;
	t: number;
	sfx: SfxElegido | null;
	motivo: MotivoEleccion;
	categoria: string | null;
	fuente_id: string | null;
	archivo_id: string | null;
	/** Nivel del SFX respecto a tu voz (dB): sonoridad momentánea máx. del SFX con su ganancia − la de tu voz. */
	nivel_rel_db: number | null;
	/** true si la categoría no era del tipo del evento (la no-repetición mandó). */
	respaldo: boolean;
};

export type OpcionesElegir = {
	catalogo: Catalogo;
	estilo?: EstiloSfx;
	historial?: HistorialSfx | null;
	/** El video que se elige (su entrada del historial se ignora: re-elegir da lo mismo). */
	slug?: string | null;
	semilla: number | string;
	/** Sonoridad integrada de tu voz en la base (LUFS, estéreo). */
	vozLufs?: number;
	/**
	 * Fuente que se prefiere (p. ej. la de tus Foleys propios). Las reglas duras no cambian; entre lo permitido,
	 * una categoría con esa fuente disponible pesa ×20 y cada fuente suya ×50 (casi siempre gana).
	 */
	preferirFuente?: string | null;
	/** Solo estas fuentes (p. ej. la de tus Foleys); null = todas. Por defecto, creador.json → sfx.solo_fuentes. */
	soloFuentes?: string[] | null;
};

/**
 * Sonoridad de voz que se usa si no se da `vozLufs`: la integrada de la base real de prueba
 * (proyectos/2026-09-23-img-4874/base.mp4, ffmpeg ebur128, n = 1). El CLI siempre mide la base de la EDL.
 */
export const VOZ_LUFS_REFERENCIA = {valor: -18.3, n: 1, fuente: 'ebur128 de proyectos/2026-09-23-img-4874/base.mp4'} as const;

// ───────────────────────────── Selector ─────────────────────────────

/** Número de variante en la EDL: 0 original, 1 = +1 semitono, 2 = −1 semitono. */
const varianteDe = (a: ArchivoSfx): number => (a.semitonos === 0 ? 0 : a.semitonos > 0 ? 1 : 2);

/** Rango entero de silencios permitido para N eventos con [p10, p90]. Puro. */
export function rangoSilencios(n: number, p10: number, p90: number): {min: number; max: number; factible: boolean} {
	const min = Math.ceil(p10 * n - 1e-9);
	const max = Math.floor(p90 * n + 1e-9);
	return {min, max, factible: n > 0 && min <= max};
}

function validarEventos(eventos: EventoSfx[]): void {
	const ids = new Set<string>();
	for (const e of eventos) {
		if (!e || typeof e.id !== 'string' || e.id.length === 0) throw fallo('elegir los SFX', 'hay un evento sin id', 'cada evento lleva {id, tipo, t}', 2);
		if (ids.has(e.id)) throw fallo('elegir los SFX', `el id "${e.id}" está repetido`, 'usa ids únicos (los de la EDL)', 2);
		ids.add(e.id);
		if (!(TIPOS_EVENTO as readonly string[]).includes(e.tipo)) throw fallo('elegir los SFX', `el evento ${e.id} tiene tipo "${e.tipo}"`, `usa uno de: ${TIPOS_EVENTO.join(', ')}`, 2);
		if (!Number.isFinite(e.t) || e.t < 0) throw fallo('elegir los SFX', `el evento ${e.id} tiene t = ${e.t}`, 't va en segundos (≥ 0) sobre la base cortada', 2);
	}
}

/** Elige el SFX (o silencio) de cada evento. Devuelve las elecciones en el orden de entrada. Pura y determinista. */
export function elegirSfx(eventos: EventoSfx[], op: OpcionesElegir): Eleccion[] {
	validarEventos(eventos);
	const problemas = problemasDelCatalogo(op.catalogo);
	if (problemas.length > 0) throw fallo('elegir los SFX', problemas[0], 'vuelve a generar el catálogo con npx tsx herramientas/sfx/catalogar.ts', 2, problemas);
	const estilo = op.estilo ?? ESTILO_SFX_SUPUESTO;
	const vozLufs = op.vozLufs ?? VOZ_LUFS_REFERENCIA.valor;
	const rnd = crearAleatorio(String(op.semilla));
	const [r0, r1] = estilo.ganancia_db.valor;
	const variacion = estilo.ganancia_db.variacion_db;
	const [o0, o1] = estilo.offset_cuadros.valor;

	// Fuentes usables por categoría: fuente_id → versiones (original y variantes) que llegan al nivel mínimo a 0 dB.
	const porCategoria = new Map<string, Map<string, ArchivoSfx[]>>();
	for (const a of op.catalogo.archivos) {
		if (!usable(a)) continue;
		if (op.soloFuentes && !op.soloFuentes.includes(a.fuente)) continue;
		if (a.lufs - vozLufs < r0) continue; // ni a 0 dB llegaría a r0 dB bajo tu voz
		const fuentes = porCategoria.get(a.categoria) ?? new Map<string, ArchivoSfx[]>();
		fuentes.set(a.fuente_id, [...(fuentes.get(a.fuente_id) ?? []), a]);
		porCategoria.set(a.categoria, fuentes);
	}
	const mapeadas = [...new Set(TIPOS_EVENTO.flatMap((t) => op.catalogo.eventos[t]))];

	const ordenados = [...eventos].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
	const elegibles = ordenados.filter((e) => op.catalogo.eventos[e.tipo].length > 0);
	const n = elegibles.length;

	// Silencios planeados.
	const {valor, p10, p90} = estilo.prob_silencio;
	const rango = rangoSilencios(n, p10, p90);
	let k: number;
	if (rango.factible) {
		const objetivo = p10 + rnd() * (p90 - p10);
		k = Math.min(rango.max, Math.max(rango.min, Math.round(objetivo * n)));
	} else {
		k = Math.round(valor * n);
	}
	const indices = Array.from({length: n}, (_, i) => i);
	for (let i = 0; i < k; i++) {
		const j = i + Math.floor(rnd() * (n - i));
		[indices[i], indices[j]] = [indices[j], indices[i]];
	}
	const silencioPlaneado = new Set(indices.slice(0, k));

	// Estado.
	const {ventanaInicial, usosRecientes} = contextoHistorial(op.historial ?? null, op.slug ?? null);
	const ventana: string[] = ventanaInicial.slice(-REGLAS_SFX.ventana_sin_repetir);
	let racha: {categoria: string | null; n: number} = {categoria: null, n: 0};
	const usosVideo = new Map<string, number>();
	const ultimaVersion = new Map<string, string>();
	const centro = r1 - r0 >= 2 * variacion ? r0 + variacion + rnd() * (r1 - r0 - 2 * variacion) : (r0 + r1) / 2;

	const intentar = (e: EventoSfx): Omit<Eleccion, 'id' | 'tipo' | 't' | 'motivo'> | null => {
		const propias = op.catalogo.eventos[e.tipo];
		const compatibles = TIPOS_COMPATIBLES[e.tipo].flatMap((t) => op.catalogo.eventos[t]).filter((c) => !propias.includes(c));
		const resto = mapeadas.filter((c) => !propias.includes(c) && !compatibles.includes(c));
		for (const [grupo, respaldo] of [
			[propias, false],
			[[...new Set(compatibles)], true],
			[resto, true],
		] as const) {
			const candidatas = grupo
				.filter((c) => !(racha.categoria === c && racha.n >= REGLAS_SFX.max_racha_categoria))
				.map((c) => ({c, fuentes: [...(porCategoria.get(c) ?? new Map<string, ArchivoSfx[]>()).entries()].filter(([f]) => !ventana.includes(f))}))
				.filter((x) => x.fuentes.length > 0);
			if (candidatas.length === 0) continue;
			const preferida = ([, vs]: [string, ArchivoSfx[]]): boolean => !!op.preferirFuente && vs.some((a) => a.fuente === op.preferirFuente);
			// Categoría: pareja, con menos peso a la que acaba de sonar (más variedad que el mínimo de la regla).
			const cat = elegirConPeso(rnd, candidatas, (x) => (racha.categoria === x.c ? 0.5 : 1) * (x.fuentes.some(preferida) ? 20 : 1));
			// Fuente: las que menos han sonado en este video y en los recientes pesan más.
			const [fuenteId, versiones] = elegirConPeso(rnd, cat.fuentes, (x) => (preferida(x) ? 50 : 1) / (1 + 2 * (usosVideo.get(x[0]) ?? 0) + (usosRecientes.get(x[0]) ?? 0)));
			// Versión: el original pesa 2, cada variante 1; si ya sonó, se prefiere otra versión.
			const previa = ultimaVersion.get(fuenteId);
			const archivo = elegirConPeso(rnd, versiones, (a) => (a.id === previa && versiones.length > 1 ? 0.1 : a.semitonos === 0 ? 2 : 1));
			const relDeseado = Math.min(r1, Math.max(r0, centro + (rnd() * 2 - 1) * variacion));
			let ganancia = relDeseado + vozLufs - archivo.lufs;
			if (ganancia > 0) ganancia = 0;
			ganancia = Math.max(-40, redondear(ganancia, 1));
			const offset = enteroEntre(rnd, o0, o1);
			return {
				sfx: {asset: archivo.archivo, ganancia_db: ganancia, offset_frames: offset, variante: varianteDe(archivo)},
				categoria: cat.c,
				fuente_id: fuenteId,
				archivo_id: archivo.id,
				nivel_rel_db: redondear(archivo.lufs + ganancia - vozLufs, 1),
				respaldo,
			};
		}
		return null;
	};

	const porId = new Map<string, Eleccion>();
	let indiceElegible = -1;
	for (const e of ordenados) {
		const base = {id: e.id, tipo: e.tipo, t: e.t};
		if (op.catalogo.eventos[e.tipo].length === 0) {
			porId.set(e.id, {...base, sfx: null, motivo: 'sin-categoria', categoria: null, fuente_id: null, archivo_id: null, nivel_rel_db: null, respaldo: false});
			continue;
		}
		indiceElegible++;
		if (silencioPlaneado.has(indiceElegible)) {
			porId.set(e.id, {...base, sfx: null, motivo: 'silencio-planeado', categoria: null, fuente_id: null, archivo_id: null, nivel_rel_db: null, respaldo: false});
			continue;
		}
		const r = intentar(e);
		if (!r) {
			porId.set(e.id, {...base, sfx: null, motivo: 'sin-opcion', categoria: null, fuente_id: null, archivo_id: null, nivel_rel_db: null, respaldo: false});
			// Para no pasarse del silencio planeado, el siguiente silencio planeado ahora suena.
			const siguiente = [...silencioPlaneado].filter((i) => i > indiceElegible).sort((a, b) => a - b)[0];
			if (siguiente !== undefined) silencioPlaneado.delete(siguiente);
			continue;
		}
		porId.set(e.id, {...base, motivo: 'sonido', ...r});
		ventana.push(r.fuente_id!);
		if (ventana.length > REGLAS_SFX.ventana_sin_repetir) ventana.shift();
		racha = racha.categoria === r.categoria ? {categoria: r.categoria, n: racha.n + 1} : {categoria: r.categoria, n: 1};
		usosVideo.set(r.fuente_id!, (usosVideo.get(r.fuente_id!) ?? 0) + 1);
		ultimaVersion.set(r.fuente_id!, r.archivo_id!);
	}
	return eventos.map((e) => porId.get(e.id)!);
}

// ───────────────────────────── Revisión de reglas ─────────────────────────────

export type Violacion = {regla: string; evento: string | null; detalle: string};

/**
 * Revisa las reglas duras sobre unas elecciones (independiente del selector: así la prueba no confía en él).
 * `ventanaInicial` = fuentes de los últimos eventos con sonido del video anterior.
 */
export function revisarReglas(elecciones: Eleccion[], cat: Catalogo, op: {estilo?: EstiloSfx; ventanaInicial?: string[]} = {}): Violacion[] {
	const estilo = op.estilo ?? ESTILO_SFX_SUPUESTO;
	const v: Violacion[] = [];
	const porArchivo = new Map(cat.archivos.map((a) => [a.archivo, a]));
	const ordenadas = [...elecciones].sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
	const ventana: string[] = (op.ventanaInicial ?? []).slice(-REGLAS_SFX.ventana_sin_repetir);
	const categorias: string[] = [];
	for (const e of ordenadas) {
		if (!e.sfx) continue;
		const a = porArchivo.get(e.sfx.asset);
		if (!a) {
			v.push({regla: 'archivo-del-catalogo', evento: e.id, detalle: `${e.sfx.asset} no está en el catálogo`});
			continue;
		}
		if (!usable(a)) v.push({regla: 'aprobacion', evento: e.id, detalle: `${a.id} está ${a.aprobacion}`});
		if (ventana.includes(a.fuente_id)) v.push({regla: 'ventana-5', evento: e.id, detalle: `${a.fuente_id} ya sonó en los últimos ${REGLAS_SFX.ventana_sin_repetir} eventos con sonido`});
		ventana.push(a.fuente_id);
		if (ventana.length > REGLAS_SFX.ventana_sin_repetir) ventana.shift();
		categorias.push(a.categoria);
		const racha = categorias.slice(-(REGLAS_SFX.max_racha_categoria + 1));
		if (racha.length === REGLAS_SFX.max_racha_categoria + 1 && racha.every((c) => c === a.categoria)) {
			v.push({regla: 'racha-categoria', evento: e.id, detalle: `"${a.categoria}" va ${racha.length} veces seguidas`});
		}
		const [o0, o1] = estilo.offset_cuadros.valor;
		if (!Number.isInteger(e.sfx.offset_frames) || e.sfx.offset_frames < o0 || e.sfx.offset_frames > o1) {
			v.push({regla: 'offset', evento: e.id, detalle: `offset ${e.sfx.offset_frames} fuera de [${o0}, ${o1}]`});
		}
		if (!(e.sfx.ganancia_db <= 0 && e.sfx.ganancia_db >= -40)) v.push({regla: 'ganancia', evento: e.id, detalle: `ganancia ${e.sfx.ganancia_db} dB fuera de [−40, 0]`});
		const [r0, r1] = estilo.ganancia_db.valor;
		if (e.nivel_rel_db !== null && (e.nivel_rel_db < r0 - 0.05 || e.nivel_rel_db > r1 + 0.05)) {
			v.push({regla: 'nivel-bajo-la-voz', evento: e.id, detalle: `nivel ${e.nivel_rel_db} dB respecto a la voz, fuera de [${r0}, ${r1}]`});
		}
		const mapeadas = new Set(TIPOS_EVENTO.flatMap((t) => cat.eventos[t]));
		if (!mapeadas.has(a.categoria)) v.push({regla: 'categoria-mapeada', evento: e.id, detalle: `"${a.categoria}" no está en el mapeo (no cumple ≥ 5 fuentes o no se usa)`});
	}
	const elegibles = elecciones.filter((e) => e.motivo !== 'sin-categoria');
	const rango = rangoSilencios(elegibles.length, estilo.prob_silencio.p10, estilo.prob_silencio.p90);
	if (rango.factible) {
		const callados = elegibles.filter((e) => !e.sfx).length;
		if (callados < rango.min || callados > rango.max) {
			v.push({regla: 'silencio-p10-p90', evento: null, detalle: `${callados} de ${elegibles.length} en silencio, fuera de [${rango.min}, ${rango.max}]`});
		}
	}
	return v;
}

// ───────────────────────────── Simulación ─────────────────────────────

export type ResultadoSimulacion = {
	videos: number;
	eventos: number;
	eventos_con_sonido: number;
	violaciones: number;
	violaciones_por_regla: Record<string, number>;
	ejemplos_violacion: Violacion[];
	silencio: {min: number; p10: number; p50: number; p90: number; max: number; media: number; fuera_de_rango: number; rango_permitido: [number, number]};
	offsets: Record<string, number>;
	nivel_rel_db: {min: number; max: number; media: number};
	ganancia_db: {min: number; max: number};
	respaldo_pct: number;
	sin_opcion_pct: number;
	categorias: Record<string, number>;
	fuentes_distintas_usadas: number;
	repeticion_entre_videos: {media: number; p90: number; nota: string};
	semilla: string;
};

const cuantil = (v: number[], q: number): number => {
	if (v.length === 0) return NaN;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** Eventos de un video simulado: N en el rango del estilo, mezcla de tipos, a veces listas de tarjetas. Pura. */
export function eventosSimulados(rnd: () => number, estilo: EstiloSfx, prefijo: string): EventoSfx[] {
	const [n0, n1] = estilo.eventos_por_video.valor;
	const n = enteroEntre(rnd, n0, n1);
	const eventos: EventoSfx[] = [{id: `${prefijo}-titular`, tipo: 'titular', t: 0}];
	let t = 0.3 + rnd() * 1.5;
	let i = 0;
	while (i < n) {
		const r = rnd();
		if (r < 0.1 && n - i >= 3) {
			// Lista de 3–4 tarjetas que aparecen una por una.
			const m = Math.min(n - i, enteroEntre(rnd, 3, 4));
			for (let j = 0; j < m; j++) {
				eventos.push({id: `${prefijo}-e${i}`, tipo: 'tarjeta', t: redondear(t, 3)});
				t += 0.4 + rnd() * 0.6;
				i++;
			}
		} else {
			const tipo: TipoEvento = r < 0.5 ? 'sticker' : r < 0.84 ? 'tarjeta' : r < 0.92 ? 'insert' : 'zoom';
			eventos.push({id: `${prefijo}-e${i}`, tipo, t: redondear(t, 3)});
			i++;
		}
		t += 0.8 + rnd() * 3.2;
	}
	return eventos;
}

/** Simula `videos` videos seguidos (con el historial entre ellos si `conHistorial`) y resume las reglas. */
export function simularVideos(videos: number, op: {catalogo: Catalogo; estilo?: EstiloSfx; semilla: string | number; conHistorial?: boolean; vozLufs?: number}): ResultadoSimulacion {
	const estilo = op.estilo ?? ESTILO_SFX_SUPUESTO;
	const rnd = crearAleatorio(`sim-${op.semilla}`);
	let historial: HistorialSfx = {version: 1, videos: []};
	const conHistorial = op.conHistorial ?? true;
	const violaciones: Violacion[] = [];
	const silencios: number[] = [];
	let fuera = 0;
	const offsets: Record<string, number> = {};
	const niveles: number[] = [];
	const ganancias: number[] = [];
	const categorias: Record<string, number> = {};
	const fuentes = new Set<string>();
	const repeticiones: number[] = [];
	let eventos = 0;
	let conSonido = 0;
	let respaldo = 0;
	let sinOpcion = 0;
	let previas: Set<string> | null = null;
	for (let v = 0; v < videos; v++) {
		const slug = `sim-${v}`;
		const evs = eventosSimulados(rnd, estilo, slug);
		const ventanaInicial = conHistorial ? contextoHistorial(historial, slug).ventanaInicial : [];
		const el = elegirSfx(evs, {catalogo: op.catalogo, estilo, historial: conHistorial ? historial : null, slug, semilla: `${op.semilla}-${v}`, vozLufs: op.vozLufs});
		violaciones.push(...revisarReglas(el, op.catalogo, {estilo, ventanaInicial}));
		const elegibles = el.filter((e) => e.motivo !== 'sin-categoria');
		const callados = elegibles.filter((e) => !e.sfx).length;
		silencios.push(callados / elegibles.length);
		const rango = rangoSilencios(elegibles.length, estilo.prob_silencio.p10, estilo.prob_silencio.p90);
		if (callados < rango.min || callados > rango.max) fuera++;
		eventos += elegibles.length;
		const usadas = new Set<string>();
		for (const e of el) {
			if (e.motivo === 'sin-opcion') sinOpcion++;
			if (!e.sfx) continue;
			conSonido++;
			if (e.respaldo) respaldo++;
			offsets[String(e.sfx.offset_frames)] = (offsets[String(e.sfx.offset_frames)] ?? 0) + 1;
			niveles.push(e.nivel_rel_db!);
			ganancias.push(e.sfx.ganancia_db);
			categorias[e.categoria!] = (categorias[e.categoria!] ?? 0) + 1;
			fuentes.add(e.fuente_id!);
			usadas.add(e.fuente_id!);
		}
		if (previas) repeticiones.push(usadas.size ? [...usadas].filter((f) => previas!.has(f)).length / usadas.size : 0);
		previas = usadas;
		if (conHistorial) {
			historial = registrarVideo(historial, {
				slug,
				semilla: `${op.semilla}-${v}`,
				fecha: 'simulacion',
				usados: el.filter((e) => e.sfx).sort((a, b) => a.t - b.t).map((e) => ({t: e.t, tipo: e.tipo, categoria: e.categoria!, fuente_id: e.fuente_id!, archivo_id: e.archivo_id!})),
			}, 10);
		}
	}
	const porRegla: Record<string, number> = {};
	for (const x of violaciones) porRegla[x.regla] = (porRegla[x.regla] ?? 0) + 1;
	const media = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
	return {
		videos,
		eventos,
		eventos_con_sonido: conSonido,
		violaciones: violaciones.length,
		violaciones_por_regla: porRegla,
		ejemplos_violacion: violaciones.slice(0, 5),
		silencio: {
			min: redondear(Math.min(...silencios), 3),
			p10: redondear(cuantil(silencios, 0.1), 3),
			p50: redondear(cuantil(silencios, 0.5), 3),
			p90: redondear(cuantil(silencios, 0.9), 3),
			max: redondear(Math.max(...silencios), 3),
			media: redondear(media(silencios), 3),
			fuera_de_rango: fuera,
			rango_permitido: [estilo.prob_silencio.p10, estilo.prob_silencio.p90],
		},
		offsets,
		nivel_rel_db: {min: redondear(Math.min(...niveles), 1), max: redondear(Math.max(...niveles), 1), media: redondear(media(niveles), 2)},
		ganancia_db: {min: redondear(Math.min(...ganancias), 1), max: redondear(Math.max(...ganancias), 1)},
		respaldo_pct: redondear((100 * respaldo) / Math.max(1, conSonido), 2),
		sin_opcion_pct: redondear((100 * sinOpcion) / Math.max(1, eventos), 2),
		categorias,
		fuentes_distintas_usadas: fuentes.size,
		repeticion_entre_videos: {
			media: redondear(media(repeticiones), 3),
			p90: redondear(cuantil(repeticiones, 0.9), 3),
			nota: 'fracción de las fuentes que sonaron en un video y también en el anterior',
		},
		semilla: String(op.semilla),
	};
}

// ───────────────────────────── EDL ─────────────────────────────

/** Eventos de una EDL: stickers, tarjetas, inserts y zooms en su `desde`; el titular también (sin categorías: silencio). */
export function eventosDeEdicion(e: Edicion): EventoSfx[] {
	const eventos: EventoSfx[] = [
		...e.stickers.map((s) => ({id: s.id, tipo: 'sticker' as const, t: s.desde})),
		// Las tarjetas con tecleo (prompts, sfx.duracion_frames) se quedan con el suyo: no se re-eligen.
		...e.tarjetas.filter((s) => typeof s.sfx?.duracion_frames !== 'number').map((s) => ({id: s.id, tipo: 'tarjeta' as const, t: s.desde})),
		...e.inserts.map((s) => ({id: s.id, tipo: 'insert' as const, t: s.desde})),
		...e.zooms.map((s) => ({id: s.id, tipo: 'zoom' as const, t: s.desde})),
	];
	if (e.titular) eventos.push({id: '__titular', tipo: 'titular', t: e.titular.desde});
	return eventos;
}

/**
 * Escribe las elecciones en una copia de la EDL: `sfx` de stickers, tarjetas e inserts (null = silencio) y,
 * como Zoom no tiene campo sfx, una entrada de `sfx_extra` en el `desde` de cada zoom con sonido. Las
 * entradas de sfx_extra que ya estaban se quedan, salvo las que caen en el mismo cuadro de un zoom (las
 * reemplaza, así re-elegir no las duplica). Pura.
 */
export function aplicarAEdicion(e: Edicion, elecciones: Eleccion[]): Edicion {
	const por = new Map(elecciones.map((x) => [x.id, x]));
	const copia: Edicion = JSON.parse(JSON.stringify(e));
	for (const s of copia.stickers) if (por.has(s.id)) s.sfx = por.get(s.id)!.sfx;
	for (const s of copia.tarjetas) if (por.has(s.id)) s.sfx = por.get(s.id)!.sfx;
	for (const s of copia.inserts) if (por.has(s.id)) s.sfx = por.get(s.id)!.sfx;
	const cuadrosZoom = new Set(copia.zooms.map((z) => Math.round(z.desde * FPS_SFX)));
	copia.sfx_extra = copia.sfx_extra.filter((x) => !cuadrosZoom.has(Math.round(x.en * FPS_SFX)));
	for (const z of copia.zooms) {
		const x = por.get(z.id);
		if (x?.sfx) copia.sfx_extra.push({en: z.desde, sfx: x.sfx});
	}
	copia.sfx_extra.sort((a, b) => a.en - b.en);
	return copia;
}

/** Sonoridad integrada de la voz en la base de la EDL (ruta relativa a public/). */
export function medirVozLufs(base: string): {lufs: number; ruta: string} {
	const ruta = join(RAIZ, 'public', base);
	if (!existsSync(ruta)) throw fallo('medir tu voz', `no existe la base ${base} (public/${base})`, 'revisa el campo "base" de la EDL', 2);
	const s = medirSonoridad(ruta, 0);
	if (s.i_lufs === null) throw fallo('medir tu voz', `la base ${base} no tiene voz que medir (sonoridad integrada vacía)`, 'revisa que la base traiga tu audio', 2);
	return {lufs: redondear(s.i_lufs, 1), ruta};
}

// ───────────────────────────── CLI ─────────────────────────────

type OpcionesCli = {
	edicion: string | null;
	eventos: string | null;
	simular: number | null;
	salida: string | null;
	semilla: string | null;
	vozLufs: number | null;
	guardarHistorial: boolean;
	sinHistorial: boolean;
	reemplazar: boolean;
	catalogo: string;
	historial: string;
	preferirFuente: string | null;
	soloFuentes: string[] | null;
};

export function leerOpcionesCli(argv: string[]): OpcionesCli {
	const conocidas = ['--edicion', '--eventos', '--simular', '--salida', '--semilla', '--voz-lufs', '--guardar-historial', '--sin-historial', '--reemplazar', '--catalogo', '--historial', '--preferir-fuente', '--solo-fuente', '--todas-las-fuentes'];
	const valor = (nombre: string): string | null => {
		const i = argv.findIndex((a) => a === nombre || a.startsWith(`${nombre}=`));
		if (i < 0) return null;
		const v = argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
		if (v === undefined || v.startsWith('--')) throw fallo('elegir los SFX', `a ${nombre} le falta su valor`, `escribe ${nombre} <valor>`, 2);
		return v;
	};
	for (const a of argv) {
		if (a.startsWith('--') && !conocidas.includes(a.split('=')[0])) throw fallo('elegir los SFX', `no conozco la opción ${a}`, `usa: ${conocidas.join(', ')}`, 2);
	}
	const voz = valor('--voz-lufs');
	const sim = valor('--simular');
	const op: OpcionesCli = {
		edicion: valor('--edicion'),
		eventos: valor('--eventos'),
		simular: sim === null ? null : Number(sim),
		salida: valor('--salida'),
		semilla: valor('--semilla'),
		vozLufs: voz === null ? null : Number(voz),
		guardarHistorial: argv.includes('--guardar-historial'),
		sinHistorial: argv.includes('--sin-historial'),
		reemplazar: argv.includes('--reemplazar'),
		catalogo: valor('--catalogo') ?? RUTA_CATALOGO,
		historial: valor('--historial') ?? RUTA_HISTORIAL,
		preferirFuente: valor('--preferir-fuente'),
		soloFuentes: argv.includes('--todas-las-fuentes') ? null : (valor('--solo-fuente')?.split(',').map((x) => x.trim()).filter(Boolean) ?? leerFuentesPermitidas()),
	};
	const modos = [op.edicion, op.eventos, op.simular].filter((x) => x !== null).length;
	if (modos !== 1) throw fallo('elegir los SFX', 'usa uno (y solo uno) de --edicion, --eventos o --simular', 'p. ej.: --edicion proyectos/<slug>/edicion-v1.json --salida proyectos/<slug>/edicion-v2.json', 2);
	if (op.vozLufs !== null && !(Number.isFinite(op.vozLufs) && op.vozLufs < 0)) throw fallo('elegir los SFX', `--voz-lufs ${voz} no es una sonoridad válida`, 'usa un número negativo en LUFS, p. ej. --voz-lufs -18.3', 2);
	if (op.simular !== null && !(Number.isInteger(op.simular) && op.simular > 0)) throw fallo('elegir los SFX', `--simular ${sim} no es un número de videos`, 'usa un entero positivo, p. ej. --simular 1000', 2);
	if (op.edicion && !op.salida) throw fallo('elegir los SFX', 'falta --salida para la EDL con los SFX', 'la EDL de entrada no se toca: escribe --salida proyectos/<slug>/edicion-v<N+1>.json', 2);
	if (op.edicion && op.salida && resolve(op.edicion) === resolve(op.salida)) throw fallo('elegir los SFX', 'la salida es la misma EDL de entrada', 'las ediciones se versionan: usa otra --salida (edicion-v<N+1>.json)', 2);
	return op;
}

function leerJson(ruta: string, que: string): unknown {
	if (!existsSync(ruta)) throw fallo(que, `no existe ${ruta}`, 'revisa la ruta', 2);
	try {
		return JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${basename(ruta)} no es un JSON válido`, 'revisa el archivo', 2, error);
	}
}

function escribirSalida(ruta: string, datos: unknown, reemplazar: boolean): void {
	if (existsSync(ruta) && !reemplazar) throw fallo('guardar las elecciones de SFX', `${ruta} ya existe`, 'usa otra --salida (las EDL se versionan) o agrega --reemplazar si es un archivo de pruebas', 2);
	if (!existsSync(dirname(resolve(ruta)))) throw fallo('guardar las elecciones de SFX', `no existe la carpeta de ${ruta}`, 'revisa la ruta de --salida', 2);
	writeFileSync(ruta, `${JSON.stringify(datos, null, '\t')}\n`);
}

const slugDeRuta = (ruta: string): string => {
	const partes = resolve(ruta).split('/');
	const i = partes.lastIndexOf('proyectos');
	return i >= 0 && partes[i + 1] ? partes[i + 1] : basename(ruta).replace(/\.json$/, '');
};

function resumen(el: Eleccion[]): string {
	const elegibles = el.filter((e) => e.motivo !== 'sin-categoria');
	const callados = elegibles.filter((e) => !e.sfx).length;
	const respaldo = el.filter((e) => e.respaldo).length;
	const niveles = el.filter((e) => e.nivel_rel_db !== null).map((e) => e.nivel_rel_db!);
	return `${elegibles.length} eventos con opción de SFX, ${callados} en silencio (${elegibles.length ? Math.round((100 * callados) / elegibles.length) : 0} %), ${respaldo} con categoría de respaldo${niveles.length ? `, nivel ${Math.min(...niveles)}…${Math.max(...niveles)} dB respecto a tu voz` : ''}`;
}

async function main(): Promise<void> {
	const op = leerOpcionesCli(process.argv.slice(2));
	// Si el JSON sale por stdout (--simular, o --eventos sin --salida), los avisos van por stderr para no ensuciarlo.
	const jsonEnStdout = op.simular !== null || (op.eventos !== null && !op.salida);
	const aviso = jsonEnStdout ? console.error : console.log;
	const catalogo = leerCatalogo(resolve(op.catalogo));
	const {estilo, notas} = leerEstiloSfx();
	for (const n of notas) aviso(`Estilo: ${n}`);

	if (op.simular !== null) {
		const semilla = op.semilla ?? '1';
		const r = simularVideos(op.simular, {catalogo, estilo, semilla, vozLufs: op.vozLufs ?? undefined});
		const texto = JSON.stringify(r, null, '\t');
		if (op.salida) escribirSalida(op.salida, r, op.reemplazar);
		console.log(texto);
		if (r.violaciones > 0 || r.silencio.fuera_de_rango > 0) {
			throw fallo('simular los SFX', `${r.violaciones} violaciones y ${r.silencio.fuera_de_rango} videos con el silencio fuera de rango`, 'revisa ejemplos_violacion y avísame', 1, r.ejemplos_violacion);
		}
		return;
	}

	const historial = op.sinHistorial ? null : leerHistorial(resolve(op.historial));
	if (op.eventos) {
		const crudo = leerJson(resolve(op.eventos), 'leer los eventos');
		if (!Array.isArray(crudo)) throw fallo('leer los eventos', 'el JSON no es una lista', 'escribe una lista [{id, tipo, t}]', 2);
		const semilla = op.semilla ?? basename(op.eventos);
		const vozLufs = op.vozLufs ?? VOZ_LUFS_REFERENCIA.valor;
		if (op.vozLufs === null) aviso(`Voz: uso la referencia ${VOZ_LUFS_REFERENCIA.valor} LUFS (${VOZ_LUFS_REFERENCIA.fuente}); pásala con --voz-lufs si la mides.`);
		const el = elegirSfx(crudo as EventoSfx[], {catalogo, estilo, historial, slug: null, semilla, vozLufs});
		const salida = {semilla, voz_lufs: vozLufs, elecciones: el};
		if (op.salida) escribirSalida(op.salida, salida, op.reemplazar);
		else console.log(JSON.stringify(salida, null, '\t'));
		aviso(`Listo: ${resumen(el)}. Semilla "${semilla}".`);
		return;
	}

	// --edicion
	const rutaEdicion = resolve(op.edicion!);
	const r = EdicionBase.safeParse(leerJson(rutaEdicion, 'leer la EDL'));
	if (!r.success) {
		const i = r.error.issues[0];
		throw fallo('leer la EDL', `no cumple el contrato (${i?.path.join('.')}: ${i?.message})`, 'corre npx tsx herramientas/validar.ts sobre ella y corrígela', 2, r.error.issues);
	}
	const edicion = r.data;
	const slug = slugDeRuta(rutaEdicion);
	const semilla = op.semilla ?? slug;
	const voz = op.vozLufs !== null ? {lufs: op.vozLufs, ruta: '--voz-lufs'} : medirVozLufs(edicion.base);
	const el = elegirSfx(eventosDeEdicion(edicion), {catalogo, estilo, historial, slug, semilla, vozLufs: voz.lufs, preferirFuente: op.preferirFuente, soloFuentes: op.soloFuentes});
	const nueva = aplicarAEdicion(edicion, el);
	const revision = EdicionBase.safeParse(nueva);
	if (!revision.success) throw fallo('escribir los SFX en la EDL', 'la EDL resultante no cumple el contrato', 'avísame: es un error interno del selector', 1, revision.error.issues);
	escribirSalida(resolve(op.salida!), nueva, op.reemplazar);
	if (op.guardarHistorial) {
		const h = historial ?? leerHistorial(resolve(op.historial));
		const usados = el
			.filter((e) => e.sfx)
			.sort((a, b) => a.t - b.t)
			.map((e) => ({t: e.t, tipo: e.tipo, categoria: e.categoria!, fuente_id: e.fuente_id!, archivo_id: e.archivo_id!}));
		escribirJson(resolve(op.historial), registrarVideo(h, {slug, semilla, fecha: new Date().toISOString(), usados}));
	}
	for (const e of [...el].sort((a, b) => a.t - b.t)) {
		const que = e.sfx ? `${e.categoria} · ${e.archivo_id} · ${e.sfx.ganancia_db} dB · ${e.sfx.offset_frames} cuadros${e.respaldo ? ' · respaldo' : ''}` : e.motivo;
		console.log(`  ${e.t.toFixed(2).padStart(7)} s  ${e.tipo.padEnd(8)} ${e.id.padEnd(10)} ${que}`);
	}
	console.log(`Listo: ${resumen(el)}. Voz ${voz.lufs} LUFS (${voz.ruta === '--voz-lufs' ? 'dada' : 'medida en la base'}), semilla "${semilla}". EDL: ${op.salida}${op.guardarHistorial ? '; historial actualizado' : ''}.`);
}

if (esPrincipal(import.meta.url)) await correr(main);
