/**
 * Estilo que usan el director, el layout y validar.ts: ritmo, duraciones, tamaños, posiciones y zonas, cada número
 * con su n y su fuente (regla 4 de la casa: lo que no se midió es N/A o un supuesto que lo dice).
 *
 * De dónde sale cada valor, en este orden:
 *   1. estilo/estilo.json (lo arma la Fase 2; lo lee con varias rutas posibles y acepta {valor, n, fuente, falta}).
 *   2. out/f2-overlays/agregado.json: overlays.ts sobre 11 de tus reels publicados (mediana por reel).
 *   3. src/estilo/capas.ts → MEDICIONES_CAPAS (tus reels, medidos cuadro por cuadro) y estilo/mini-estilo.json
 *      (franja de subtítulos, 8 reels, 726 eventos).
 *   4. Supuestos del plan o del pedido, marcados como tales (n = 0).
 *
 * Todo en px de la base 1080×1920 y en segundos. Puro salvo `leerEstiloDirector` (lee los archivos).
 */
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {MEDICIONES_CAPAS} from '../../../src/estilo/capas.ts';
import {FUENTE_ZONA_SEGURA, ZONA_SEGURA, type DecisionZona} from '../../../src/estilo/zona-segura.ts';
import {SUPUESTOS} from '../cara.ts';
import {RAIZ} from '../manifest.ts';
import {leerPerfilMotor} from '../perfil-estilo.ts';

/** Un número medido (o un supuesto con n = 0). p10/p90: el rango entre reels, si la fuente lo trae. */
export type Medida = {valor: number; n: number; fuente: string; nota?: string; p10?: number; p90?: number};
/** Algo que no se midió y no tiene supuesto: el que lo usa decide qué hacer (y lo dice). */
export type NoMedida = {valor: null; n: 0; fuente: 'N/A'; nota: string};

export type EstiloDirector = {
	/** Para direccion.json → edicion: versión y huella del estilo que se usó. */
	version: string;
	hash: string;
	/** Archivos que aportaron algo (rutas relativas a la raíz). */
	fuentes: string[];
	/**
	 * primera_capa_s: cuándo aparece la primera capa en tus reels (mediana ~0.7 s, p90 ~1.3 s): el director cuida que
	 * el arranque no se quede vacío. N/A si no se midió (y entonces no hay regla de gancho).
	 */
	ritmo: {tarjetas_por_min: Medida; stickers_por_min: Medida; primera_capa_s: Medida | NoMedida};
	duracion: {
		tarjeta: {p10: Medida; p50: Medida; p90: Medida};
		sticker: {p10: Medida; p50: Medida; p90: Medida};
	};
	/** Separación mínima entre dos capas seguidas (tarjetas y stickers). */
	separacion_min_s: Medida;
	/** Duración mínima por palabra leída (titular, tarjetas y textos de inserts). */
	min_por_palabra_s: Medida;
	/** Cuánto después del inicio de su palabra aparece una capa (0 si no se midió). */
	desfase_aparicion_s: Medida | NoMedida;
	/** Stickers: ancho visible p10/p50 y centro y medido (≈ 1256; p10/p90 entre reels). */
	sticker: {ancho_p10: Medida; ancho_p50: Medida; centro_y: Medida};
	/**
	 * Tarjetas: centro y medido (≈ 1284) y su rango dentro de un reel (p10–p90 del centro, ≈ 1264–1296): el layout
	 * solo las mueve dentro de ese rango para dejarlas debajo de tu barbilla.
	 */
	tarjeta: {y: Medida; y_rango: {p10: Medida; p90: Medida}; separacion_px: Medida; escala_lista: Medida; escala_min: Medida};
	titular: {y: Medida};
	/** Inserts: lugar en tarjeta y duración típica (p50/p90; para proponer demos). */
	insert: {x: Medida; y: Medida; ancho: Medida; duracion_p50: Medida; duracion_p90: Medida};
	franja: {y_p10: Medida; y_p90: Medida; alto_mayuscula: Medida; borde: Medida; margen: Medida};
	zona_ui: {arriba: Medida; abajo: Medida; izquierda: Medida; derecha: Medida};
	/**
	 * Cabeza. margen_barbilla: aire PREFERIDO debajo de la barbilla (lo que dejas en tus reels, p10; si no, el plan:
	 * 60). margen_boca: el límite duro, borde de arriba ≥ boca máx + esto (supuesto 12 px). factor_boca: boca ≈
	 * barbilla − k × alto de la cara cuando cara.json no trae la boca (supuesto 0.18).
	 */
	cabeza: {margen_barbilla: Medida; margen_boca: Medida; factor_boca: Medida; margen_titular: Medida; ancho_legible_min: Medida};
	/** Alto de cara de tus reels recientes (p50 por reel; p90 entre reels = el umbral del modo de cerca). */
	encuadre: {alto_cara: Medida | NoMedida};
	/** Tipos de palabra de tus tarjetas (clave, frase, cifra, producto, pregunta…) y cuántas de cada uno. */
	tipos_tarjeta: {valor: Record<string, number>; n: number; fuente: string} | NoMedida;
	/** Cuántos elementos con tapaCabeza por reel (p90). N/A → máximo 1 (plan, excepción 2). */
	tapa_cabeza_p90: Medida | NoMedida;
	desenfoque_por_min: Medida | NoMedida;
	zooms_por_min: Medida | NoMedida;
	/** % de subtítulos con alguna palabra resaltada en tus reels. */
	resaltado_pct: Medida | NoMedida;
};

export const RUTA_ESTILO_JSON = join(RAIZ, 'estilo', 'estilo.json');
export const RUTA_AGREGADO_OVERLAYS = join(RAIZ, 'out', 'f2-overlays', 'agregado.json');
export const RUTA_MINI_ESTILO = join(RAIZ, 'estilo', 'mini-estilo.json');
export const RUTA_ENCUADRE = join(RAIZ, 'estilo', 'encuadre.json');

/** Margen entre tu boca y el borde de arriba de cualquier capa (px base). SUPUESTO del pedido del director v2. */
export const MARGEN_BOCA_SUPUESTO = 12;
/** Boca ≈ barbilla − k × alto de la cara si cara.json no la trae. SUPUESTO del pedido: el mismo de lib/cara.ts (bocaDeCuadro). */
export const FACTOR_BOCA_SUPUESTO = SUPUESTOS.boca_factor;

// ───────────────────────── lectura tolerante ─────────────────────────

/** Lee una ruta con puntos dentro de un objeto. */
export function enRuta(obj: unknown, ruta: string): unknown {
	let actual: unknown = obj;
	for (const llave of ruta.split('.')) {
		if (typeof actual !== 'object' || actual === null) return undefined;
		actual = (actual as Record<string, unknown>)[llave];
	}
	return actual;
}

type Hallado = {valor: number; n: number; fuente: string; p10?: number; p90?: number} | 'N/A' | null;

const finito = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Busca un número en varias rutas posibles. Acepta un número suelto o una métrica {valor|mediana, n, fuente} (con
 * p10/p90 si los trae). "N/A" (o {valor: "N/A"}) cuenta como encontrado pero no medido. null si ninguna ruta existe.
 */
export function buscarNumero(obj: unknown, rutas: readonly string[], etiqueta: string): Hallado {
	for (const ruta of rutas) {
		const v = enRuta(obj, ruta);
		if (v === undefined) continue;
		if (v === 'N/A' || v === null) return 'N/A';
		if (typeof v === 'number' && Number.isFinite(v)) return {valor: v, n: 0, fuente: `${etiqueta}: ${ruta}`};
		if (typeof v === 'object') {
			const o = v as Record<string, unknown>;
			const valor = o.valor ?? o.mediana ?? o.p50;
			if (valor === 'N/A' || valor === null) return 'N/A';
			if (typeof valor === 'number' && Number.isFinite(valor)) {
				const n = typeof o.n === 'number' && Number.isFinite(o.n) ? Math.round(o.n) : 0;
				const fuente = typeof o.fuente === 'string' && o.fuente.length > 0 ? `${etiqueta}: ${ruta} (${o.fuente})` : `${etiqueta}: ${ruta}`;
				return {valor, n, fuente, ...(finito(o.p10) ? {p10: o.p10} : {}), ...(finito(o.p90) ? {p90: o.p90} : {})};
			}
		}
	}
	return null;
}

const supuesto = (valor: number, fuente: string, nota?: string): Medida => ({valor, n: 0, fuente: `supuesto: ${fuente}`, ...(nota ? {nota} : {})});
const noMedida = (nota: string): NoMedida => ({valor: null, n: 0, fuente: 'N/A', nota});
const esMedida = (m: Medida | NoMedida): m is Medida => m.valor !== null;

/** Primero estilo.json, luego el agregado de overlays, luego lo que se dé como respaldo. */
function elegir(estiloJson: unknown, rutasEstilo: readonly string[], agregado: unknown, llaveAgregado: string | null, respaldo: () => Medida | NoMedida): Medida | NoMedida {
	if (estiloJson) {
		const h = buscarNumero(estiloJson, rutasEstilo, 'estilo/estilo.json');
		if (h === 'N/A') {
			const r = respaldo();
			return esMedida(r) ? {...r, nota: `estilo.json lo trae como N/A; uso ${r.fuente}`} : r;
		}
		if (h) return h;
	}
	if (agregado && llaveAgregado) {
		const a = enRuta(agregado, `agregado.${llaveAgregado}`) as {mediana?: unknown; n?: unknown} | undefined;
		if (a && typeof a.mediana === 'number' && Number.isFinite(a.mediana)) {
			const n = typeof a.n === 'number' ? a.n : 0;
			return {valor: a.mediana, n, fuente: `out/f2-overlays/agregado.json: ${llaveAgregado} (overlays.ts, mediana por reel de tus reels publicados)`};
		}
	}
	return respaldo();
}

const medidaCapa = (llave: string, nota?: string): Medida => {
	const m = MEDICIONES_CAPAS[llave];
	if (!m || typeof m.valor !== 'number') throw new Error(`MEDICIONES_CAPAS.${llave} no es un número`);
	return {valor: m.valor, n: m.n, fuente: `src/estilo/capas.ts MEDICIONES_CAPAS.${llave} (${m.fuente})`, ...(nota ?? m.nota ? {nota: nota ?? m.nota} : {})};
};

/** Cuantil tipo 7 de unos valores. */
function cuantil(valores: number[], p: number): number {
	const v = [...valores].sort((a, b) => a - b);
	const h = (v.length - 1) * p;
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

/** Lo que trae mini-estilo.json de la franja (y_p10, y_p90, alto de mayúscula y borde). */
function deMini(mini: unknown, ruta: string): Medida | null {
	const v = enRuta(mini, ruta) as {valor?: unknown; n?: unknown} | undefined;
	if (!v || typeof v.valor !== 'number') return null;
	return {valor: v.valor, n: typeof v.n === 'number' ? v.n : 0, fuente: `estilo/mini-estilo.json: ${ruta} (medir.ts, tus reels recientes)`};
}

// ───────────────────────── armado ─────────────────────────

export type EntradasEstilo = {
	/** Contenido de estilo/estilo.json (null si no existe). */
	estiloJson?: unknown | null;
	/** Contenido de out/f2-overlays/agregado.json (null si no existe). */
	agregado?: unknown | null;
	/** Contenido de estilo/mini-estilo.json (null si no existe). */
	mini?: unknown | null;
	/** Contenido de estilo/encuadre.json (null si no existe): alto de cara de tus reels. */
	encuadre?: unknown | null;
	/**
	 * La zona del estilo (perfil.json → motor.zona, src/estilo/zona-segura.ts → DecisionZona): cuánto bajan
	 * subtítulos, tarjetas y stickers y si las capas pueden tapar la cara. Por defecto (true o sin valor), la del estilo
	 * activo (leerPerfilMotor); `false` trabaja con lo medido tal cual y con la boca protegida (las pruebas del layout);
	 * un objeto usa esa. La zona segura de Reels (zona UI acotada a x 135–945, y 220–1600) se aplica siempre.
	 */
	decision?: boolean | DecisionZona;
	/** Para la huella. */
	textos?: string[];
	fuentes?: string[];
};

/** Arma el estilo con lo que haya (puro). */
export function estiloDesde(e: EntradasEstilo = {}): EstiloDirector {
	const ej = e.estiloJson ?? null;
	const ag = e.agregado ?? null;
	const mini = e.mini ?? null;
	const M = (m: Medida | NoMedida, respaldo: Medida): Medida => (esMedida(m) ? m : respaldo);

	const tarjetasPorMin = M(
		elegir(ej, ['densidades.tarjetas_por_min', 'tarjetas.por_min', 'tarjetas_por_min', 'ritmo.tarjetas_por_min', 'overlays.tarjetas_por_min'], ag, 'tarjetas_por_min', () =>
			supuesto(8, 'pedido de la Fase 3 (~8 tarjetas/min)', 'no hay medida de tarjetas por minuto: corre overlays.ts sobre tus reels'),
		),
		supuesto(8, 'pedido de la Fase 3 (~8 tarjetas/min)'),
	);
	const stickersPorMin = M(
		elegir(ej, ['densidades.stickers_por_min', 'stickers.por_min', 'stickers_por_min', 'ritmo.stickers_por_min', 'overlays.stickers_por_min'], ag, 'stickers_por_min', () =>
			supuesto(4, 'pedido de la Fase 3 (~4 stickers/min)', 'no hay medida de stickers por minuto: corre overlays.ts sobre tus reels'),
		),
		supuesto(4, 'pedido de la Fase 3 (~4 stickers/min)'),
	);
	const dur = (clase: 'tarjetas' | 'stickers', p: 'p10' | 'p50' | 'p90', respaldo: number): Medida =>
		M(
			elegir(ej, [`${clase}.duracion_s.${p}`, `${clase}.duracion.${p}`, `duracion_${clase}_${p}_s`, `densidades.duracion_${clase}_${p}_s`], ag, `duracion_${clase}_${p}_s`, () =>
				supuesto(respaldo, `duración ${p} de ${clase} (sin medir)`),
			),
			supuesto(respaldo, `duración ${p} de ${clase} (sin medir)`),
		);

	// Ancho visible de los stickers (con su borde blanco): overlays (n = 10 reels) o MEDICIONES_CAPAS (n = 4 tiles).
	const anchosTiles = [260, 300, 332, 356]; // MEDICIONES_CAPAS.sticker_ancho → nota
	const anchoP10 = M(
		elegir(ej, ['stickers.ancho_p10', 'stickers.ancho_px.p10', 'stickers.ancho.p10', 'ancho_sticker_p10_px'], ag, 'ancho_sticker_p10_px', () => ({
			valor: Math.round(cuantil(anchosTiles, 0.1) * 10) / 10,
			n: 4,
			fuente: 'src/estilo/capas.ts MEDICIONES_CAPAS.sticker_ancho (tiles de 4 reels: 260, 300, 332, 356 → p10)',
		})),
		supuesto(260, 'mínimo de los tiles medidos'),
	);
	const anchoP50 = M(
		elegir(ej, ['stickers.ancho_p50', 'stickers.ancho_px.p50', 'stickers.ancho.p50', 'ancho_sticker_p50_px'], ag, 'ancho_sticker_p50_px', () => medidaCapa('sticker_ancho')),
		medidaCapa('sticker_ancho'),
	);
	// Centro y de los stickers: estilo.json (overlays.ts, n = 15) → agregado de overlays (n = 8) → supuesto del pedido.
	const stickerY = M(
		elegir(ej, ['stickers.centro_y', 'stickers.y', 'stickers.centro_y_p50'], ag, 'centro_y_sticker_p50_px', () => supuesto(1258, 'pedido del director v2 (≈ 1258 en tus reels)')),
		supuesto(1258, 'pedido del director v2 (≈ 1258 en tus reels)'),
	);

	const tarjetaY = M(elegir(ej, ['tarjetas.y', 'tarjetas.y_p50', 'tarjeta.y', 'tarjeta_y'], null, null, () => medidaCapa('tarjeta_y')), medidaCapa('tarjeta_y'));
	// Rango del centro de las tarjetas DENTRO de un reel (p10 y p90 de cada reel, mediana entre reels). Sin medida: el
	// rango entre reels de la misma y, y si tampoco, la y sola (sin margen para moverlas).
	const rangoY = (p: 'p10' | 'p90'): Medida => {
		const h = elegir(ej, [`tarjetas.centro_y.${p}`], null, null, () => noMedida('sin rango'));
		if (esMedida(h)) return h;
		const v = tarjetaY[p];
		return v !== undefined ? {valor: v, n: tarjetaY.n, fuente: `${tarjetaY.fuente} (${p} entre reels)`} : {...tarjetaY, nota: `sin ${p} medido: la y sola`};
	};
	const titularY = M(elegir(ej, ['titular.y', 'titular.y_p50', 'titular_y'], null, null, () => medidaCapa('titular_y')), medidaCapa('titular_y'));

	// Franja de subtítulos: estilo.json → mini-estilo.json → el valor que usa subtitulos.ts.
	const franja = (campo: 'y_p10' | 'y_p90'): Medida => {
		const r = elegir(ej, [`franja_subtitulos.${campo}`, `subtitulos.franja.${campo}`, `franja.${campo}`], null, null, () => deMini(mini, `franja.${campo}`) ?? supuesto(1498.5, 'y de subtítulos de proyectos/*/subtitulos.json'));
		return M(r, supuesto(1498.5, 'y de subtítulos'));
	};
	const altoMayuscula = M(
		elegir(ej, ['franja_subtitulos.alto_mayuscula', 'subtitulos.alto_mayuscula_p50', 'subtitulos.alto_mayuscula'], null, null, () => deMini(mini, 'alto_mayuscula_p50') ?? supuesto(43, 'alto de mayúscula de subtítulos')),
		supuesto(43, 'alto de mayúscula de subtítulos'),
	);
	const borde = M(
		elegir(ej, ['franja_subtitulos.borde', 'subtitulos.grosor_borde_p50', 'subtitulos.borde_px'], null, null, () => deMini(mini, 'grosor_borde_p50') ?? supuesto(3.94, 'borde de subtítulos')),
		supuesto(3.94, 'borde de subtítulos'),
	);

	// Zona UI: lo medido manda (tus textos viven dentro del 35 % de abajo de la guía de Meta).
	const titularMas = 259; // MEDICIONES_CAPAS.titular_y: rango 259–461 (n = 11)
	const mayusculaTitular = Number(MEDICIONES_CAPAS.titular_alto_mayuscula.valor);
	const contornoTitular = Number(MEDICIONES_CAPAS.titular_borde.valor);
	const arribaMedido: Medida = {
		valor: Math.round((titularMas - mayusculaTitular / 2 - contornoTitular) * 10) / 10,
		n: 11,
		fuente: 'tope del titular más alto de tus reels (MEDICIONES_CAPAS.titular_y: rango 259–461, menos media mayúscula de 47 y el contorno de 3.4)',
		nota: 'más alto que el 14 % de la guía de Meta (269 px): manda lo medido',
	};
	const zona = (rutas: string[], respaldo: Medida): Medida => M(elegir(ej, rutas, null, null, () => respaldo), respaldo);
	const zonaUi = {
		arriba: zona(['zona_ui.arriba', 'zona_ui.y0', 'zona_ui.top', 'zona_ui.y_min'], arribaMedido),
		abajo: zona(['zona_ui.abajo', 'zona_ui.y1', 'zona_ui.bottom', 'zona_ui.y_max'], supuesto(1920 * 0.65, 'guía de Meta para Reels (35 % abajo)', 'tus subtítulos y tarjetas viven más abajo: no acota nada del layout')),
		izquierda: zona(['zona_ui.izquierda', 'zona_ui.x0', 'zona_ui.left', 'zona_ui.x_min'], supuesto(1080 * 0.06, 'guía de Meta para Reels (6 % a los lados)')),
		derecha: zona(['zona_ui.derecha', 'zona_ui.x1', 'zona_ui.right', 'zona_ui.x_max'], supuesto(1080 * 0.94, 'guía de Meta para Reels (6 % a los lados)')),
	};

	const tapa = elegir(ej, ['tapa_cabeza.p90', 'tapaCabeza.p90', 'frecuencia_tapa_cabeza.p90', 'excepciones.tapa_cabeza.p90', 'tapa_cabeza_por_reel.p90'], null, null, () =>
		noMedida('no se midió cuántas capas tapan la cabeza por reel (overlays.ts + cara.json en la Fase 2): máximo 1 por reel'),
	);
	const desenfoque = elegir(ej, ['efectos.desenfoque_por_min', 'desenfoque.por_min', 'desenfoque_por_min'], null, null, () =>
		noMedida('frecuencia de desenfoque sin medir (MEDICIONES_CAPAS.desenfoque_rampa solo mide la rampa, n = 1): no se usa'),
	);
	const zooms = elegir(ej, ['zooms.por_min', 'zooms_por_min', 'zoom.por_min'], null, null, () =>
		noMedida('en tus reels no se confirmó ningún zoom de edición (n = 3 reels con cara.json, Fase 2): ninguno por defecto'),
	);
	const resaltado = elegir(ej, ['resaltado.valor', 'subtitulos.resaltado', 'resaltado_pct'], null, null, () => {
		const r = enRuta(mini, 'resaltado') as {valor?: unknown; n?: unknown} | undefined;
		if (r && typeof r.valor === 'number') return {valor: r.valor, n: typeof r.n === 'number' ? r.n : 0, fuente: 'estilo/mini-estilo.json: resaltado (8 reels, 726 eventos)'};
		return noMedida('resaltado de subtítulos sin medir');
	});
	const desfase = elegir(ej, ['capas.desfase_aparicion_s', 'tarjetas.desfase_s', 'desfase_aparicion_s'], null, null, () =>
		noMedida('desfase entre tu palabra y la aparición de la capa sin medir: aparece al inicio de la palabra'),
	);
	const minPalabra = M(
		elegir(ej, ['textos.min_por_palabra_s', 'min_por_palabra_s', 'titular.min_por_palabra_s', 'duracion_min_por_palabra_s'], null, null, () =>
			supuesto(0.3, 'BRAG (~0.3 s por palabra leída)', 'tus reels mandan sobre esto cuando se mida'),
		),
		supuesto(0.3, 'BRAG (~0.3 s por palabra leída)'),
	);
	// Aire preferido debajo de la barbilla: lo que dejas en tus reels (p10 de tus capas) o el del plan.
	const margenBarbilla = M(
		elegir(ej, ['cabeza.margen_barbilla_px', 'cabeza.margen_barbilla'], null, null, () => supuesto(60, 'plan, Fase 3 (borde de arriba ≥ barbilla máx + 60 px)')),
		supuesto(60, 'plan, Fase 3 (borde de arriba ≥ barbilla máx + 60 px)'),
	);
	// Alto de cara de tus reels recientes: estilo.json → estilo/encuadre.json (f6-encuadre, Apple Vision).
	const altoCara = (() => {
		const h = elegir(ej, ['encuadre.alto_cara'], null, null, () => {
			const r = buscarNumero(e.encuadre ?? null, ['alto_cara'], 'estilo/encuadre.json');
			return r && r !== 'N/A' ? r : noMedida('alto de cara de tus reels sin medir (estilo/encuadre.json): no se detecta el modo de cerca');
		});
		return h;
	})();
	// Duración de tus inserts: p50 medido y su p90 (el de la misma métrica si no viene aparte). Sin medida: el
	// supuesto del director v1 (una demo de 4 s como máximo).
	const durInsert = (p: 'p50' | 'p90'): Medida => {
		const respaldo = supuesto(p === 'p50' ? 1.4 : 4, 'director v1 (demo de 4 s como máximo)');
		const propia = elegir(ej, [`inserts.duracion_s.${p}`], null, null, () => noMedida('sin medida'));
		if (esMedida(propia)) return propia;
		const p50 = elegir(ej, ['inserts.duracion_s.p50'], null, null, () => noMedida('sin medida'));
		if (p === 'p90' && esMedida(p50) && p50.p90 !== undefined) return {valor: p50.p90, n: p50.n, fuente: `${p50.fuente} (su p90)`};
		return respaldo;
	};
	// Tipos de palabra de tus tarjetas (medir-capas.ts): solo para comparar en direccion.md.
	const tipos = ((): EstiloDirector['tipos_tarjeta'] => {
		const t = enRuta(ej, 'tarjetas.tipos_total') as {valor?: unknown; n?: unknown; fuente?: unknown} | undefined;
		if (t && typeof t.valor === 'object' && t.valor !== null && Object.values(t.valor).every((x) => typeof x === 'number')) {
			return {valor: t.valor as Record<string, number>, n: typeof t.n === 'number' ? t.n : 0, fuente: `estilo/estilo.json: tarjetas.tipos_total${typeof t.fuente === 'string' ? ` (${t.fuente})` : ''}`};
		}
		return noMedida('tipos de tarjeta sin medir (estilo.json → tarjetas.tipos_total)');
	})();

	// Zona del estilo (perfil.json → motor.zona) sobre lo medido: subtítulos, tarjetas y stickers bajan lo mismo, y la
	// zona UI se acota a la zona segura de Reels (capas en x 135–945, y 220–1600).
	const zonaEstilo: DecisionZona | null = e.decision === false ? null : typeof e.decision === 'object' ? e.decision : leerPerfilMotor().zona;
	const bajada = zonaEstilo?.bajada_capas_px ?? 0;
	const notaBajada = `+${bajada} px: ${zonaEstilo?.nota ?? ''}`;
	const bajar = (m: Medida): Medida => bajada === 0 ? m : ({
		...m,
		valor: Math.round((m.valor + bajada) * 10) / 10,
		...(m.p10 !== undefined ? {p10: Math.round((m.p10 + bajada) * 10) / 10} : {}),
		...(m.p90 !== undefined ? {p90: Math.round((m.p90 + bajada) * 10) / 10} : {}),
		nota: m.nota ? `${m.nota}; ${notaBajada}` : notaBajada,
	});
	const acotar = (m: Medida, lado: 'min' | 'max', limite: number): Medida => {
		const v = lado === 'min' ? Math.max(m.valor, limite) : Math.min(m.valor, limite);
		if (v === m.valor) return m;
		const nota = `acotado a ${limite} (medido ${m.valor}) por la ${FUENTE_ZONA_SEGURA}`;
		return {...m, valor: v, nota: m.nota ? `${m.nota}; ${nota}` : nota};
	};
	const zs = ZONA_SEGURA.capas;
	zonaUi.arriba = acotar(zonaUi.arriba, 'min', zs.y0);
	zonaUi.abajo = acotar(zonaUi.abajo, 'max', zs.y1);
	zonaUi.izquierda = acotar(zonaUi.izquierda, 'min', zs.x0);
	zonaUi.derecha = acotar(zonaUi.derecha, 'max', zs.x1);

	const huella = createHash('sha256');
	for (const t of e.textos ?? []) huella.update(t);
	const version = typeof enRuta(ej, 'version') === 'string' || typeof enRuta(ej, 'version') === 'number' ? String(enRuta(ej, 'version')) : '0.1.0';
	return {
		version,
		hash: ej ? `estilo-json-${huella.digest('hex').slice(0, 12)}` : `sin-estilo-json-${huella.digest('hex').slice(0, 12)}`,
		fuentes: e.fuentes ?? [],
		ritmo: {
			tarjetas_por_min: tarjetasPorMin,
			stickers_por_min: stickersPorMin,
			primera_capa_s: elegir(ej, ['ritmo.primera_capa_s'], ag, null, () => noMedida('primera capa sin medir (estilo.json → ritmo.primera_capa_s)')),
		},
		duracion: {
			tarjeta: {p10: dur('tarjetas', 'p10', 0.63), p50: dur('tarjetas', 'p50', 0.78), p90: dur('tarjetas', 'p90', 1.49)},
			sticker: {p10: dur('stickers', 'p10', 0.63), p50: dur('stickers', 'p50', 0.79), p90: dur('stickers', 'p90', 1.07)},
		},
		separacion_min_s: supuesto(0.8, 'pedido de la Fase 3 (separación mínima 0.8 s)'),
		min_por_palabra_s: minPalabra,
		desfase_aparicion_s: desfase,
		sticker: {ancho_p10: anchoP10, ancho_p50: anchoP50, centro_y: bajar(stickerY)},
		tarjeta: {
			y: bajar(tarjetaY),
			y_rango: {p10: bajar(rangoY('p10')), p90: bajar(rangoY('p90'))},
			separacion_px: medidaCapa('tarjeta_separacion'),
			escala_lista: medidaCapa('tarjeta_lista_escala'),
			escala_min: {valor: 0.58, n: 4, fuente: 'mínimo del rango medido de escala de lista (MEDICIONES_CAPAS.tarjeta_lista_escala: 0.58–0.81)'},
		},
		titular: {y: titularY},
		insert: {
			x: {valor: 540, n: 2, fuente: 'MEDICIONES_CAPAS.insert_tarjeta (centro x 540)'},
			y: {valor: 995, n: 2, fuente: 'MEDICIONES_CAPAS.insert_tarjeta (centro y 995)'},
			ancho: {valor: 770, n: 2, fuente: 'MEDICIONES_CAPAS.insert_tarjeta (ancho 770)'},
			duracion_p50: durInsert('p50'),
			duracion_p90: durInsert('p90'),
		},
		franja: {y_p10: bajar(franja('y_p10')), y_p90: bajar(franja('y_p90')), alto_mayuscula: altoMayuscula, borde, margen: supuesto(20, 'plan, layout (margen de la franja hasta medirlo)')},
		zona_ui: zonaUi,
		cabeza: {
			margen_barbilla: margenBarbilla,
			margen_boca: zonaEstilo?.puede_tapar_cara && zonaEstilo.margen_boca_px !== null
				? supuesto(zonaEstilo.margen_boca_px, zonaEstilo.nota_cara)
				: supuesto(MARGEN_BOCA_SUPUESTO, 'pedido del director v2 (borde de arriba ≥ boca máx + 12 px)', 'margen sin medir: en tus tomas de cerca las tarjetas y los logos quedan justo debajo de tu labio de abajo'),
			factor_boca: supuesto(FACTOR_BOCA_SUPUESTO, 'pedido del director v2 (boca ≈ barbilla − 0.18 × alto de la cara si cara.json no la trae)'),
			margen_titular: supuesto(12, 'aire entre el titular y la coronilla'),
			ancho_legible_min: supuesto(756, 'plan, excepción 1 (70 % de 1080 px)'),
		},
		encuadre: {alto_cara: altoCara},
		tipos_tarjeta: tipos,
		tapa_cabeza_p90: tapa,
		desenfoque_por_min: desenfoque,
		zooms_por_min: zooms,
		resaltado_pct: resaltado,
	};
}

/** Lee un JSON si existe (null si no o si está roto: lo dice en `avisos`). */
function leerSiExiste(ruta: string, avisos: string[]): {datos: unknown; texto: string} | null {
	if (!existsSync(ruta)) return null;
	try {
		const texto = readFileSync(ruta, 'utf8');
		return {datos: JSON.parse(texto), texto};
	} catch {
		avisos.push(`${ruta.replace(`${RAIZ}`, '')} no es JSON válido: no lo uso`);
		return null;
	}
}

/** Lee el estilo de los archivos del proyecto (estilo.json, agregado de overlays, mini-estilo). */
export function leerEstiloDirector(op: {raiz?: string} = {}): {estilo: EstiloDirector; avisos: string[]} {
	const raiz = op.raiz ?? RAIZ;
	const avisos: string[] = [];
	const rutas = {
		estilo: join(raiz, 'estilo', 'estilo.json'),
		agregado: join(raiz, 'out', 'f2-overlays', 'agregado.json'),
		mini: join(raiz, 'estilo', 'mini-estilo.json'),
		encuadre: join(raiz, 'estilo', 'encuadre.json'),
	};
	const ej = leerSiExiste(rutas.estilo, avisos);
	const ag = leerSiExiste(rutas.agregado, avisos);
	const mini = leerSiExiste(rutas.mini, avisos);
	const enc = leerSiExiste(rutas.encuadre, avisos);
	if (!ej) avisos.push('no existe estilo/estilo.json: uso lo medido (overlays, MEDICIONES_CAPAS, mini-estilo) y supuestos marcados');
	const fuentes = [ej ? 'estilo/estilo.json' : null, ag ? 'out/f2-overlays/agregado.json' : null, mini ? 'estilo/mini-estilo.json' : null, enc ? 'estilo/encuadre.json' : null, 'src/estilo/capas.ts (MEDICIONES_CAPAS)'].filter((x): x is string => x !== null);
	const estilo = estiloDesde({
		estiloJson: ej?.datos ?? null,
		agregado: ag?.datos ?? null,
		mini: mini?.datos ?? null,
		encuadre: enc?.datos ?? null,
		textos: [ej?.texto ?? '', ag?.texto ?? '', mini?.texto ?? '', enc?.texto ?? '', JSON.stringify(MEDICIONES_CAPAS)],
		fuentes,
	});
	return {estilo, avisos};
}

/** Una medida en una línea legible: "16.93 (n=11; out/f2-overlays/agregado.json …)". */
export function textoMedida(m: Medida | NoMedida, unidad = ''): string {
	if (m.valor === null) return `N/A (${m.nota})`;
	const valor = Number.isInteger(m.valor) ? String(m.valor) : m.valor.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
	return `${valor}${unidad} (n=${m.n}; ${m.fuente}${m.nota ? `; ${m.nota}` : ''})`;
}
