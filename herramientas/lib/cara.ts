/**
 * Cara, barbilla y coronilla, para que todo vaya DEBAJO de la cabeza del creador (y el titular arriba).
 *
 * Motor (herramientas/lib/plataforma.ts → motorVision('cara')): en macOS, Apple Vision (herramientas/bin/cara,
 * de herramientas/vision/cara.swift) si está compilado; en Windows y Linux (o con EDITOR_VISION=python), MediaPipe
 * en el .venv (herramientas/py/cara.py: Face Landmarker + Face Detector + Image Segmenter "selfie"). Los dos
 * escriben la misma línea JSON por cuadro (`CaraVision`), así que el resto de este módulo es igual.
 *
 * `analizarCara(mp4, {cortes})`:
 *   1. ffmpeg toma 1 de cada `paso` cuadros nativos (30 fps → paso 3 = 10 fps), los escala a 720 de ancho
 *      (720×1280 en 9:16) y los manda crudos (RGBA) al motor (con Vision: VNDetectFaceLandmarksRequest
 *      revisión 3, 76 puntos, y la silueta de persona VNGeneratePersonSegmentationRequest). Se elige con
 *      `select` por número de cuadro: cada muestra sabe su cuadro exacto (t = n / fps; supone CFR, como la base
 *      y los reels publicados).
 *   2. Cara principal por muestra (`elegirCaras`): la más grande, con preferencia (×2) por la que sigue a la de
 *      la muestra anterior (IoU ≥ 0.3) dentro del mismo tramo. Fuera: confianza < 0.5, ancho < 40 px y menos del
 *      40 % del ancho típico de la principal (caras de fondo o de capturas).
 *   3. Todo pasa a la base 1080×1920 (como el `objectFit: cover` de Reel.tsx).
 *   4. Barbilla = punto más bajo del contorno de la cara (faceContour), bajado a la orilla de abajo de la barba
 *      cuando se ve clara (el contorno sigue la quijada y quedaba 15–40 px base arriba de la barba; ver
 *      `elegirBordeBarbilla`). Coronilla = tope de la silueta sobre la cara (medido); lados = orillas de la silueta
 *      a la altura de ojos y nariz (medido). Si la silueta falta o no es creíble, se usan las fórmulas de
 *      `SUPUESTOS` con el factor medido en el mismo video (ver abajo).
 *      Boca = punto más bajo de los labios por fuera (outerLips): la ZONA PROTEGIDA (en las tomas de cerca las
 *      tarjetas y los logos tocan la barba, pero nunca tapan boca, nariz ni ojos). Cuenta si es creíble (abajo de la
 *      nariz y de los ojos y arriba de la barbilla del contorno); si no, se estima con barbilla − k × alto de la caja
 *      (k medido en el mismo video o el supuesto 0.18). Por construcción nunca queda arriba de la nariz ni de los ojos.
 *   5. Por tramo (entre cortes), sin mezclar nunca dos tramos: huecos de hasta 3 muestras se rellenan en línea
 *      recta (si la cara de los dos lados es la misma), mediana de 3 muestras (quita lecturas sueltas de Vision),
 *      interpolación a 30 fps y EMA de ida y vuelta (α = 0.4 por cuadro; de fase cero, así no atrasa). La mediana
 *      va en las muestras y no en los 30 fps: ya interpolada, una lectura mala se reparte en varios cuadros.
 *
 * Por qué no la caja de Vision para todo: la caja es cuadrada y salta ±10 % (y se corre de lado hasta ~100 px)
 * cuando su `yaw` cuantizado cambia entre 0 y −45°, aunque la cabeza casi no se mueva. El contorno, los ojos y la
 * silueta no tienen ese salto (medido en pruebas/integracion/f2-cara.ts).
 *
 * Coordenadas: base 1080×1920, origen arriba-izquierda. Tiempos en segundos sobre la línea de tiempo del video.
 * El formato del archivo (proyectos/<slug>/cara.json) es `Cara`; `leerCara()` lo valida con Zod.
 *
 * Para el layout y validar.ts: `barbillaMax`, `bocaMax`, `coronillaMin` y `cajaCabeza` (ventana t0−0.2…t1+0.2 s,
 * con el zoom de la EDL aplicado alrededor de su origen) y `cobertura`. Un cara.json de antes de medir la boca no la
 * trae: `bocaMax` la estima (barbilla − 0.18 × alto de la cara) y `bocaMedida` lo dice. Para medir el estilo: `detectarZooms` (sobre
 * muestras a los fps nativos) y `verificarZoomsConFondo` (descarta cortes entre tomas que no son zoom).
 *
 * Apple Vision no funciona dentro del sandbox de macOS: con ese motor esto corre desde comandos excluidos
 * (herramientas/cara.ts o pruebas/integracion/f2-cara.ts). El motor Python corre en CPU y no tiene esa restricción. La parte pura (`construirCara` y casi todo lo demás) se prueba en pruebas/unit.
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {z} from 'zod';
import {fallo} from './fallo.ts';
import {sondear} from './ffprobe.ts';
import {RAIZ} from './manifest.ts';
import {comandoVision, comoInstalar, faltaParaVision, type ComandoVision, type MotorVision} from './plataforma.ts';

/** Binario de Apple Vision (solo macOS). Con el motor Python se usa herramientas/py/cara.py: ver `comandoCara`. */
export const RUTA_CARA = join(RAIZ, 'herramientas', 'bin', 'cara');
export const FUENTE_CARA_SWIFT = join(RAIZ, 'herramientas', 'vision', 'cara.swift');
export const FUENTE_CARA_PY = join(RAIZ, 'herramientas', 'py', 'cara.py');

/** Programa y prefijo para buscar caras con el motor que toque en este sistema. */
export function comandoCara(): ComandoVision {
	return comandoVision('cara', {raiz: RAIZ});
}

/** Qué motor describe el análisis (va en cara.json → analisis.vision). */
export function descripcionMotorCara(motor: MotorVision): string {
	return motor === 'python'
		? 'MediaPipe FaceLandmarker (478 puntos) + FaceDetector + ImageSegmenter selfie'
		: 'VNDetectFaceLandmarksRequest rev. 3 (76 puntos) + VNGeneratePersonSegmentationRequest';
}
export const BASE_W = 1080;
export const BASE_H = 1920;
export const FPS_SALIDA = 30;
const EPS = 1e-6;

/**
 * Fórmulas de respaldo (cuando un video no trae silueta medible) y de dónde sale cada número. Medidos contra la
 * silueta de Vision en 4 videos (base de IMG_4874 y 3 reels publicados, a 30 fps;
 * pruebas/integracion/f2-cara.ts):
 * - coronilla_factor: tope de la cabeza con pelo ≈ tope de la caja − k × alto de la caja. El plan proponía 0.30;
 *   medido: p10 0.237 · p50 0.309 · p90 0.385 (n = 7892 cuadros; mediana por video de 0.277 a 0.355).
 * - lado_factor: lados de la cabeza (orejas y pelo) ≈ extremos del contorno ± k × ancho del contorno. Medido:
 *   p50 0.036 · p90 0.135 (n = 15784 orillas). Se usa 0.12 (cerca del p90: la caja casi siempre contiene la cabeza).
 * - barbilla_sin_contorno: si Vision no da contorno, barbilla ≈ tope de la caja + k × alto. Medido: p50 1.004
 *   (n = 7892).
 * - boca_factor: si Vision no da labios creíbles (o el cara.json es de antes de medir la boca), boca ≈ barbilla −
 *   k × alto de la caja. SUPUESTO del pedido del director v2 (0.18), hasta medirlo: en cada video se reemplaza por la
 *   mediana medida con los labios (outerLips) de ese mismo video.
 * En cada video, si hay al menos `min_muestras_factor` muestras con silueta (o labios) creíble, el factor de
 * respaldo se reemplaza por la mediana medida en ese mismo video.
 */
export const SUPUESTOS = {
	coronilla_factor: 0.3,
	lado_factor: 0.12,
	barbilla_sin_contorno: 1.0,
	boca_factor: 0.18,
} as const;

/** Parámetros del análisis (van al manifest: si cambian, la etapa "cara" deja de estar vigente). */
export const PARAMETROS_CARA = {
	fps_objetivo: 10,
	ancho_analisis: 720,
	min_confianza: 0.5,
	min_ancho_px: 40,
	factor_ancho_minimo: 0.4,
	iou_continuidad: 0.3,
	bono_continuidad: 2,
	memoria_continuidad: 3,
	hueco_max_muestras: 3,
	ventana_mediana: 3,
	alfa_ema: 0.4,
	/** Silueta creíble: (tope caja − tope silueta) / alto caja dentro de este rango. */
	coronilla_min: 0.1,
	coronilla_max: 0.65,
	/** Lado creíble: (contorno − silueta) / ancho del contorno dentro de este rango. */
	lado_min: -0.2,
	lado_max: 0.5,
	min_muestras_factor: 5,
	/** Borde de la barba: fuerza mínima (subida de luminancia en 4 filas) y rango aceptado bajo la barbilla del
	 *  contorno, en fracciones de la distancia ojos–barbilla (F). Medido a ojo en 24 cuadros de 4 videos: la barba
	 *  real quedó de 0.01 a 0.15 F abajo; los errores (brazo, mano o tarjeta debajo) cayeron de 0.16 a 0.26 F. */
	borde_fuerza_min: 12,
	borde_min_f: -0.03,
	borde_max_f: 0.15,
	umbral_zoom: 0.07,
	margen_ventana_s: 0.2,
} as const;

export type ParametrosCara = {-readonly [K in keyof typeof PARAMETROS_CARA]: number};

// ───────────────────────────── Tipos ─────────────────────────────

export type Rect = {x: number; y: number; w: number; h: number};
export type Punto2 = {x: number; y: number};

/** Silueta medida por herramientas/bin/cara (normalizada al cuadro; null si no se pudo medir esa parte). */
export type SiluetaVision = {tope: number | null; izq: number | null; der: number | null};

/** Una cara tal como la escribe herramientas/bin/cara: normalizada (0–1) al cuadro, origen arriba-izquierda. */
export type CaraVision = Rect & {
	confianza: number;
	confianza_puntos: number | null;
	roll: number | null;
	yaw: number | null;
	pitch: number | null;
	barbilla: Punto2 | null;
	/** Punto más bajo de los labios por fuera (outerLips). Falta en lecturas de antes de medir la boca. */
	boca?: Punto2 | null;
	contorno: Array<[number, number]>;
	ojo_izq: Array<[number, number]>;
	ojo_der: Array<[number, number]>;
	nariz: Array<[number, number]>;
	/** Bordes oscuro→claro bajo la barbilla del contorno: [y normalizada, fuerza], de arriba abajo. */
	bordes_barbilla?: Array<[number, number]>;
	silueta?: SiluetaVision | null;
};

/** Lo que vio Vision en el cuadro nativo `n` (t = n / fps del video). */
export type CuadroVision = {n: number; t: number; caras: CaraVision[]};

/** Una cara ya en la base 1080×1920 (px). */
export type CaraBase = {
	caja: Rect;
	/** Punto más bajo del contorno de Vision. */
	barbilla: Punto2 | null;
	/** Punto más bajo de los labios por fuera (outerLips). */
	boca: Punto2 | null;
	/** Altura de los ojos (promedio de sus puntos), para medir la distancia ojos–barbilla. */
	ojos_y: number | null;
	/** Punto más bajo de la nariz: la boca nunca queda arriba de él. */
	nariz_y: number | null;
	/** Bordes oscuro→claro bajo la barbilla (y en px base y fuerza), de arriba abajo. */
	bordes_barbilla: Array<{y: number; fuerza: number}>;
	confianza: number;
	/** Dispersión RMS de los puntos (contorno, ojos y nariz) alrededor de su centro: tamaño de la cara sin el salto de la caja. */
	escala_puntos: number | null;
	centro_puntos: Punto2 | null;
	/** Extremos del contorno en x. */
	contorno_x: [number, number] | null;
	silueta: SiluetaVision | null;
};

/** Muestra de Vision ya con la cara principal elegida, en px base y SIN suavizar (sirve para medir zooms). */
export type MuestraCara = {
	n: number;
	t: number;
	/** Tramo de la base (entre cortes). */
	tramo: number;
	/** Caja de Vision. */
	cara: Rect | null;
	barbilla_y: number | null;
	/** Barbilla del contorno de Vision, antes de bajarla a la orilla de la barba. */
	barbilla_contorno_y: number | null;
	/** true si la barbilla se bajó a la orilla de la barba (borde claro dentro del rango). */
	barbilla_borde: boolean;
	/** true si Vision no dio contorno y la barbilla se estimó con la caja. */
	barbilla_estimada: boolean;
	/** Boca (labios por fuera): la medida si es creíble; si no, barbilla − k × alto de la caja. */
	boca_y: number | null;
	/** true si la boca salió de los labios de Vision; false si de la fórmula. */
	boca_medida: boolean;
	coronilla_y: number | null;
	/** true si la coronilla salió de la silueta; false si de la fórmula. */
	coronilla_medida: boolean;
	/** Lados de la cabeza [izquierda, derecha]. */
	lados: [number, number] | null;
	lados_medidos: boolean;
	escala_puntos: number | null;
	centro_puntos: Punto2 | null;
	/** Confianza de la detección (0 sin cara). */
	confianza: number;
	/** Cuántas caras vio Vision en el cuadro (antes de filtrar). */
	caras: number;
};

/** Un cuadro de 30 fps, ya interpolado y suavizado. */
export type CuadroCara = {
	t: number;
	/** Caja de la cara de Vision. */
	cara: Rect | null;
	barbilla_y: number | null;
	/** Boca: punto más bajo de los labios por fuera (zona protegida). Falta en un cara.json de antes de medirla. */
	boca_y?: number | null;
	coronilla_y: number | null;
	/** Caja de la cabeza: de un lado al otro (orejas y pelo) y de la coronilla a la barbilla. */
	cabeza: Rect | null;
	/** Confianza de las detecciones de Vision vecinas del mismo tramo (0 = cuadro rellenado o sin cara). */
	confianza: number;
};

export type Cuantiles = {p50: number | null; p90: number | null; max: number | null};

/** Un factor de forma: el que se usó, de dónde salió y con cuántas muestras. */
export type FactorMedido = {valor: number; n: number; fuente: 'silueta (este video)' | 'supuesto' | 'contorno (este video)' | 'labios (este video)'};

export type ResumenCara = {
	/** Fracción de cuadros de 30 fps con cara (después de rellenar huecos de ≤ 3 muestras). */
	cobertura: number;
	/** Fracción de muestras de Vision con cara (sin rellenar). */
	cobertura_muestras: number;
	barbilla_y: Cuantiles;
	/** Boca (cuadros de 30 fps con cara). Falta en un cara.json de antes de medir la boca. */
	boca_y?: Cuantiles;
	coronilla_y: {p10: number | null; p50: number | null; min: number | null};
	cuadros: number;
	cuadros_sin_cara: number;
	muestras: number;
	muestras_con_cara: number;
	/** Muestras donde Vision vio más de una cara válida. */
	muestras_varias_caras: number;
	/** Muestras sin cara rellenadas en línea recta (huecos de ≤ 3 muestras). */
	muestras_rellenadas: number;
	barbillas_estimadas: number;
	/** Muestras donde la barbilla se bajó a la orilla de la barba y cuánto (px base). */
	barbillas_borde: number;
	barbilla_borde_px: {p50: number | null; p90: number | null; max: number | null};
	/** Muestras con la boca medida en los labios de Vision (las demás, con la fórmula). */
	bocas_medidas?: number;
	coronillas_medidas: number;
	lados_medidos: number;
	factores: {barbilla: FactorMedido; coronilla: FactorMedido; lado: FactorMedido; boca?: FactorMedido};
};

export type Cara = {
	version: 1;
	fuente: string;
	fps: 30;
	fps_muestreo: number;
	duracion_s: number;
	base: [1080, 1920];
	video: {ancho: number; alto: number; fps: number; cuadros: number};
	analisis: {ancho: number; alto: number; paso: number; vision: string; silueta: boolean};
	/** Cortes de la base (s): ahí se reinicia el suavizado. */
	cortes_s: number[];
	parametros: ParametrosCara;
	cuadros: CuadroCara[];
	muestras: MuestraCara[];
	resumen: ResumenCara;
	tiempos_s?: {vision: number; total: number};
};

/** Lo mínimo que necesitan las consultas por ventana (barbillaMax, bocaMax, coronillaMin, cajaCabeza, cobertura). */
export type CaraConsultable = {
	fps: number;
	cuadros: Array<Pick<CuadroCara, 't' | 'cara' | 'barbilla_y' | 'coronilla_y'> & {cabeza?: Rect | null; boca_y?: number | null}>;
};

// ───────────────────────────── Utilidades puras ─────────────────────────────

export function mediana(v: number[]): number | null {
	const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (s.length === 0) return null;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Cuantil con interpolación lineal (el mismo que herramientas/estilo/medir.ts). */
export function cuantil(valores: number[], p: number): number | null {
	const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const h = (v.length - 1) * Math.min(1, Math.max(0, p));
	const lo = Math.floor(h);
	const hi = Math.min(v.length - 1, lo + 1);
	return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const rNull = (v: number | null, f: (x: number) => number = r1) => (v === null ? null : f(v));

export function iou(a: Rect, b: Rect): number {
	const x0 = Math.max(a.x, b.x);
	const y0 = Math.max(a.y, b.y);
	const x1 = Math.min(a.x + a.w, b.x + b.w);
	const y1 = Math.min(a.y + a.h, b.y + b.h);
	const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
	const union = a.w * a.h + b.w * b.h - inter;
	return union > 0 ? inter / union : 0;
}

export const centro = (r: Rect): Punto2 => ({x: r.x + r.w / 2, y: r.y + r.h / 2});

/** Cuadros nativos entre dos muestras de Vision: 30 fps → 3 (10 fps). */
export function pasoMuestreo(fpsVideo: number, fpsObjetivo: number = PARAMETROS_CARA.fps_objetivo): number {
	if (!(fpsVideo > 0)) return 1;
	return Math.max(1, Math.round(fpsVideo / fpsObjetivo));
}

/** Escala y desplazamiento de un video (ancho×alto visibles) a la base 1080×1920 con `cover` (centrado). */
export type Transformacion = {escala: number; dx: number; dy: number; ancho: number; alto: number};

export function transformacionBase(ancho: number, alto: number): Transformacion {
	const escala = Math.max(BASE_W / ancho, BASE_H / alto);
	return {escala, dx: (BASE_W - ancho * escala) / 2, dy: (BASE_H - alto * escala) / 2, ancho, alto};
}

const aBaseX = (x: number, tr: Transformacion) => x * tr.ancho * tr.escala + tr.dx;
const aBaseY = (y: number, tr: Transformacion) => y * tr.alto * tr.escala + tr.dy;

/** Rectángulo normalizado (0–1) del cuadro → px base. */
export function rectABase(r: Rect, tr: Transformacion): Rect {
	return {x: aBaseX(r.x, tr), y: aBaseY(r.y, tr), w: r.w * tr.ancho * tr.escala, h: r.h * tr.alto * tr.escala};
}

export function puntoABase(p: Punto2, tr: Transformacion): Punto2 {
	return {x: aBaseX(p.x, tr), y: aBaseY(p.y, tr)};
}

/** Centro y dispersión RMS (px) de un conjunto de puntos. */
export function dispersion(puntos: ReadonlyArray<Punto2>): {centro: Punto2; escala: number} | null {
	if (puntos.length < 3) return null;
	const cx = puntos.reduce((s, p) => s + p.x, 0) / puntos.length;
	const cy = puntos.reduce((s, p) => s + p.y, 0) / puntos.length;
	const escala = Math.sqrt(puntos.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / puntos.length);
	return escala > 0 ? {centro: {x: cx, y: cy}, escala} : null;
}

export function caraABase(c: CaraVision, tr: Transformacion): CaraBase {
	const pts = [...c.contorno, ...c.ojo_izq, ...c.ojo_der, ...c.nariz].map(([x, y]) => ({x: aBaseX(x, tr), y: aBaseY(y, tr)}));
	const d = dispersion(pts);
	const xs = c.contorno.map(([x]) => aBaseX(x, tr));
	const s = c.silueta;
	const ojos = [...c.ojo_izq, ...c.ojo_der];
	return {
		caja: rectABase(c, tr),
		barbilla: c.barbilla ? puntoABase(c.barbilla, tr) : null,
		boca: c.boca ? puntoABase(c.boca, tr) : null,
		ojos_y: ojos.length ? aBaseY(ojos.reduce((a, [, y]) => a + y, 0) / ojos.length, tr) : null,
		nariz_y: c.nariz.length ? aBaseY(Math.max(...c.nariz.map(([, y]) => y)), tr) : null,
		bordes_barbilla: (c.bordes_barbilla ?? []).map(([y, fuerza]) => ({y: aBaseY(y, tr), fuerza})),
		confianza: c.confianza,
		escala_puntos: d ? d.escala : null,
		centro_puntos: d ? d.centro : null,
		contorno_x: xs.length >= 2 ? [Math.min(...xs), Math.max(...xs)] : null,
		silueta: s
			? {tope: s.tope === null ? null : aBaseY(s.tope, tr), izq: s.izq === null ? null : aBaseX(s.izq, tr), der: s.der === null ? null : aBaseX(s.der, tr)}
			: null,
	};
}

/**
 * Bordes de tramo de la base → tiempos de corte en la base (s).
 * `tramos` = manifest.etapas.base.parametros.tramos_cuadros: [inicio, fin) en cuadros de 30 fps del crudo.
 * La base es su concatenación; hay corte donde un tramo termina y el siguiente no empieza justo ahí.
 */
export function cortesDeTramos(tramos: ReadonlyArray<readonly [number, number]>, fps = FPS_SALIDA): number[] {
	const cortes: number[] = [];
	let acumulado = 0;
	for (let i = 0; i < tramos.length - 1; i++) {
		acumulado += tramos[i][1] - tramos[i][0];
		if (tramos[i + 1][0] !== tramos[i][1]) cortes.push(acumulado / fps);
	}
	return cortes;
}

/** Cortes ordenados, sin repetidos y dentro de (0, duración). */
export function normalizarCortes(cortes: readonly number[], duracion: number): number[] {
	const v = [...cortes].filter((c) => Number.isFinite(c) && c > EPS && c < duracion - EPS).sort((a, b) => a - b);
	return v.filter((c, i) => i === 0 || c - v[i - 1] > EPS);
}

/** Índice del tramo de `t`: cuántos cortes quedan en o antes de t (un cuadro justo en el corte ya es del nuevo). */
export function indiceTramo(t: number, cortes: readonly number[]): number {
	let lo = 0;
	let hi = cortes.length;
	while (lo < hi) {
		const m = (lo + hi) >> 1;
		if (cortes[m] <= t + EPS) lo = m + 1;
		else hi = m;
	}
	return lo;
}

// ───────────────────────────── Cara principal ─────────────────────────────

/**
 * Elige la cara principal de cada muestra (pura): la más grande, ×`bono_continuidad` si sigue a la última
 * elegida del mismo tramo (IoU ≥ `iou_continuidad`, mirando hasta `memoria_continuidad` muestras atrás).
 * Fuera: confianza < `min_confianza`, ancho < `min_ancho_px` y, al final, las de menos de
 * `factor_ancho_minimo` × la mediana del ancho de la cara más grande de cada muestra.
 */
export function elegirCaras<C extends Pick<CaraBase, 'caja' | 'confianza'>>(
	muestras: ReadonlyArray<{tramo: number; caras: C[]}>,
	parametros: Partial<ParametrosCara> = {},
): Array<C | null> {
	const p = {...PARAMETROS_CARA, ...parametros};
	const validas = muestras.map((m) => m.caras.filter((c) => c.confianza >= p.min_confianza && c.caja.w >= p.min_ancho_px));
	const anchoTipico = mediana(validas.filter((v) => v.length > 0).map((v) => Math.max(...v.map((c) => c.caja.w))));
	const elegidas: Array<C | null> = [];
	for (let k = 0; k < muestras.length; k++) {
		let previa: C | null = null;
		for (let j = k - 1; j >= Math.max(0, k - p.memoria_continuidad) && muestras[j].tramo === muestras[k].tramo; j--) {
			if (elegidas[j]) {
				previa = elegidas[j];
				break;
			}
		}
		let mejor: C | null = null;
		let puntajeMejor = Number.NEGATIVE_INFINITY;
		for (const c of validas[k]) {
			const sigue = previa !== null && iou(c.caja, previa.caja) >= p.iou_continuidad;
			const puntaje = c.caja.w * c.caja.h * (sigue ? p.bono_continuidad : 1);
			if (puntaje > puntajeMejor) {
				mejor = c;
				puntajeMejor = puntaje;
			}
		}
		elegidas.push(mejor && anchoTipico !== null && mejor.caja.w >= p.factor_ancho_minimo * anchoTipico ? mejor : null);
	}
	return elegidas;
}

// ───────────────────────────── Zooms ─────────────────────────────

export type ZoomDetectado = {
	/** Cuadro nativo y tiempo de la primera muestra con el tamaño nuevo. El salto pasó entre n_antes y n. */
	n: number;
	t: number;
	n_antes: number;
	t_antes: number;
	/** Tamaño de la cara después ÷ antes, medido con la dispersión de los puntos. >1 acerca, <1 aleja. */
	razon: number;
	/** Lo mismo medido con la caja de Vision (debe ir en el mismo sentido). */
	razon_caja: number;
	tipo: 'acercar' | 'alejar';
	ancho_antes: number;
	ancho_despues: number;
	/** Origen del zoom que explica el salto (px base): o = (c₁ − r·c₀) / (1 − r), con c el centro de los puntos. */
	origen: Punto2 | null;
	/** El origen cae dentro del cuadro con holgura (±25 %). */
	origen_plausible: boolean;
	/** El tamaño nuevo se sostuvo en la muestra siguiente. */
	confirmado: boolean;
	/** Por qué no cuenta (solo con `todos`): pico de una muestra, la caja no acompaña, sin muestra que confirme u origen fuera. */
	descarte: 'pico' | 'caja-no-acompana' | 'sin-confirmar' | 'origen-fuera' | null;
};

/**
 * Zooms de edición en un video ya editado (pura, sobre `muestras`, sin suavizar). Un zoom es un salto de tamaño
 * de cara > `umbral` (7 %) entre dos muestras seguidas del mismo tramo, medido con la dispersión de los puntos de
 * Vision, con la caja de Vision cambiando en el mismo sentido (≥ la mitad del umbral: así no cuenta una mano
 * que tapa la barbilla y desacomoda el contorno), que no sea el regreso de un pico, que se sostenga en la muestra
 * siguiente y con un origen creíble.
 *
 * Usa muestras a los fps nativos (paso 1): un zoom de edición pasa en UN cuadro, y una toma en mano puede
 * cambiar >7 % en 0.1 s (a 10 fps se cuela). Ojo: un corte entre dos tomas donde te acercaste o alejaste a la
 * cámara también salta; para separarlo usa `verificarZoomsConFondo` (en un zoom digital el fondo también crece).
 * Con `todos: true` devuelve también los descartados, con su motivo.
 */
export function detectarZooms(cara: Pick<Cara, 'muestras' | 'fps_muestreo'>, op: {umbral?: number; todos?: boolean} = {}): ZoomDetectado[] {
	const umbral = op.umbral ?? PARAMETROS_CARA.umbral_zoom;
	const limite = Math.log(1 + umbral);
	const m = cara.muestras;
	const dtMax = 1.5 / cara.fps_muestreo;
	const ok = (i: number) => i >= 0 && i < m.length && !!m[i].cara && m[i].escala_puntos !== null && m[i].escala_puntos! > 0;
	const seguidas = (i: number, j: number) => ok(i) && ok(j) && m[i].tramo === m[j].tramo && m[j].t - m[i].t <= dtMax * (j - i) + EPS;
	const dist = (i: number, j: number) => Math.abs(Math.log(m[j].escala_puntos! / m[i].escala_puntos!));
	const zooms: ZoomDetectado[] = [];
	for (let k = 0; k + 1 < m.length; k++) {
		if (!seguidas(k, k + 1)) continue;
		const a = m[k];
		const b = m[k + 1];
		const razon = b.escala_puntos! / a.escala_puntos!;
		if (Math.abs(Math.log(razon)) <= limite) continue;
		const razonCaja = Math.sqrt((b.cara!.w * b.cara!.h) / (a.cara!.w * a.cara!.h));

		let descarte: ZoomDetectado['descarte'] = null;
		if (seguidas(k - 1, k) && dist(k - 1, k) >= dist(k - 1, k + 1)) descarte = 'pico';
		if (descarte === null && !(Math.sign(Math.log(razonCaja)) === Math.sign(Math.log(razon)) && Math.abs(Math.log(razonCaja)) >= limite / 2)) {
			descarte = 'caja-no-acompana';
		}
		let confirmado = false;
		if (seguidas(k + 1, k + 2)) {
			confirmado = dist(k + 1, k + 2) < dist(k, k + 2);
			if (!confirmado && descarte === null) descarte = 'pico';
		} else if (descarte === null) {
			descarte = 'sin-confirmar';
		}
		const ca = a.centro_puntos ?? centro(a.cara!);
		const cb = b.centro_puntos ?? centro(b.cara!);
		const origen = Math.abs(1 - razon) > 0.02 ? {x: (cb.x - razon * ca.x) / (1 - razon), y: (cb.y - razon * ca.y) / (1 - razon)} : null;
		const origenPlausible = origen !== null && origen.x >= -0.25 * BASE_W && origen.x <= 1.25 * BASE_W && origen.y >= -0.25 * BASE_H && origen.y <= 1.25 * BASE_H;
		if (descarte === null && !origenPlausible) descarte = 'origen-fuera';
		if (descarte !== null && !op.todos) continue;
		zooms.push({
			n: b.n,
			t: b.t,
			n_antes: a.n,
			t_antes: a.t,
			razon: r4(razon),
			razon_caja: r4(razonCaja),
			tipo: razon > 1 ? 'acercar' : 'alejar',
			ancho_antes: r1(a.cara!.w),
			ancho_despues: r1(b.cara!.w),
			origen: origen ? {x: r1(origen.x), y: r1(origen.y)} : null,
			origen_plausible: origenPlausible,
			confirmado,
			descarte,
		});
	}
	return zooms;
}

/** Imagen en escala de grises (un byte por pixel). */
export type ImagenGris = {ancho: number; alto: number; datos: Uint8Array};

export type VerificacionFondo = {
	veredicto: 'zoom' | 'sin-zoom' | 'dudoso';
	/** Diferencia del fondo (desviación mediana, 0–255, sin el cambio global de brillo) entre los dos cuadros tal cual… */
	dif_igual: number;
	/** …aplicando al de antes el zoom que mejor alinea el fondo… */
	dif_zoom: number;
	/** …y entre el cuadro de antes y el anterior a él (el ruido de la misma toma), si se pudo medir. */
	dif_ruido: number | null;
	escala: number;
	origen: Punto2;
	/** Pixeles de fondo comparados (arriba de la barbilla y fuera de la cabeza). */
	pixeles: number;
	/** Textura media del fondo (gradiente); con muy poca, no se puede decidir. */
	textura: number;
};

function muestrear(img: ImagenGris, x: number, y: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const i = y0 * img.ancho + x0;
	const d = img.datos;
	return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + img.ancho] * (1 - fx) + d[i + img.ancho + 1] * fx) * fy;
}

/**
 * ¿El fondo confirma el zoom? (pura) Compara el fondo de dos cuadros (`antes`, `despues`, en escala de grises y
 * con el encuadre de la base reducido a `ancho`×`alto`) tal cual contra aplicarle al de antes un zoom alrededor
 * de un origen. Busca la mejor escala (razón ±3 %) y origen (±120 px base alrededor del que dio la cara).
 * Fondo = todo lo que está arriba de la barbilla y fuera de la cabeza (con 15 % de margen), lejos de las orillas.
 * Diferencia = desviación mediana de (después − antes) quitando su mediana: un cambio de exposición entre tomas
 * (todo un poco más claro) no parece zoom, y un titular fijo (que un zoom no escala) o una mano que pasa, que son
 * minoría de pixeles, no deciden. `previo` (opcional) es el cuadro anterior a `antes`: su diferencia con `antes`
 * es el ruido de la misma toma (compresión, cámara en mano).
 *   zoom: el fondo cambió (≥ 2 y ≥ 2 × ruido) y el zoom lo explica (lo baja a ≤ 40 % y al menos 1.5 niveles;
 *   con menos, en fondos oscuros y lisos un corte entre tomas se colaba como zoom).
 *   sin-zoom: el fondo no cambió más que el ruido (≤ 1.5 × ruido + 0.5) o el zoom no ayuda (≥ 90 %).
 *   dudoso: lo demás, menos de 300 pixeles de fondo o un fondo liso (textura < 1) que no deja ver nada.
 * Un zoom digital escala también el fondo; un corte entre tomas con la cámara fija lo deja igual.
 */
export function compararFondo(
	antes: ImagenGris,
	despues: ImagenGris,
	zona: {cabeza: {izq: number; der: number; arriba: number; abajo: number}; razon: number; origen: Punto2},
	previo: ImagenGris | null = null,
): VerificacionFondo {
	const f = antes.ancho / BASE_W;
	const ancho = antes.ancho;
	const alto = antes.alto;
	const anchoCabeza = Math.max(1, zona.cabeza.der - zona.cabeza.izq);
	const altoCabeza = Math.max(1, zona.cabeza.abajo - zona.cabeza.arriba);
	const hx0 = (zona.cabeza.izq - 0.15 * anchoCabeza) * f;
	const hx1 = (zona.cabeza.der + 0.15 * anchoCabeza) * f;
	const hy0 = (zona.cabeza.arriba - 0.1 * altoCabeza) * f;
	const orilla = Math.max(1, Math.round(0.04 * ancho));
	const yMax = Math.min(alto - 2, Math.round(zona.cabeza.abajo * f));
	const pixeles: number[] = [];
	for (let y = orilla; y <= yMax; y++) {
		for (let x = orilla; x < ancho - orilla; x++) {
			if (x >= hx0 && x <= hx1 && y >= hy0) continue;
			pixeles.push(x, y);
		}
	}
	const total = pixeles.length / 2;
	let textura = 0;
	for (let k = 0; k < pixeles.length; k += 2) {
		const i = pixeles[k + 1] * ancho + pixeles[k];
		textura += Math.abs(despues.datos[i + 1] - despues.datos[i - 1]) + Math.abs(despues.datos[i + ancho] - despues.datos[i - ancho]);
	}
	textura = total ? textura / (2 * total) : 0;

	// Desviación mediana en dos pasadas con histogramas (pasos de 0.25): O(n) por hipótesis.
	const histograma = new Uint32Array(2049);
	const difs = new Float32Array(Math.max(1, total));
	const medianaHist = (n: number, desplazamiento: number): number => {
		let acumulado = 0;
		for (let b = 0; b < histograma.length; b++) {
			acumulado += histograma[b];
			if (acumulado * 2 >= n) return (b - desplazamiento) / 4;
		}
		return (histograma.length - 1 - desplazamiento) / 4;
	};
	const desviacion = (a: ImagenGris, b: ImagenGris, s: number, o: Punto2): number => {
		histograma.fill(0);
		let n = 0;
		const ox = o.x * f;
		const oy = o.y * f;
		for (let k = 0; k < pixeles.length; k += 2) {
			const x = pixeles[k];
			const y = pixeles[k + 1];
			const sx = ox + (x - ox) / s;
			const sy = oy + (y - oy) / s;
			if (sx < 0 || sy < 0 || sx >= ancho - 1 || sy >= alto - 1) continue;
			const d = b.datos[y * ancho + x] - muestrear(a, sx, sy);
			difs[n++] = d;
			histograma[Math.max(0, Math.min(2048, Math.round(d * 4) + 1024))]++;
		}
		if (n <= total * 0.5) return Number.POSITIVE_INFINITY;
		const centro = medianaHist(n, 1024);
		histograma.fill(0);
		for (let k = 0; k < n; k++) histograma[Math.min(2048, Math.round(Math.abs(difs[k] - centro) * 4))]++;
		return medianaHist(n, 0);
	};
	const difIgual = desviacion(antes, despues, 1, {x: 0, y: 0});
	const ruido = previo ? desviacion(previo, antes, 1, {x: 0, y: 0}) : null;
	let mejor = {dif: Number.POSITIVE_INFINITY, s: zona.razon, o: zona.origen};
	for (const s of [zona.razon / 1.03, zona.razon, zona.razon * 1.03]) {
		for (let dx = -120; dx <= 120; dx += 60) {
			for (let dy = -120; dy <= 120; dy += 60) {
				const o = {x: zona.origen.x + dx, y: zona.origen.y + dy};
				const d = desviacion(antes, despues, s, o);
				if (d < mejor.dif) mejor = {dif: d, s, o};
			}
		}
	}
	const ruidoValido = ruido !== null && Number.isFinite(ruido) ? ruido : null;
	let veredicto: VerificacionFondo['veredicto'] = 'dudoso';
	if (total >= 300 && Number.isFinite(difIgual) && Number.isFinite(mejor.dif)) {
		const explica = mejor.dif <= 0.4 * difIgual && difIgual - mejor.dif >= 1.5;
		if (explica && difIgual >= 2 && (ruidoValido === null || difIgual >= 2 * ruidoValido)) veredicto = 'zoom';
		else if ((ruidoValido !== null && difIgual <= 1.5 * ruidoValido + 0.5) || mejor.dif >= 0.9 * difIgual) veredicto = 'sin-zoom';
		if (veredicto === 'sin-zoom' && textura < 1) veredicto = 'dudoso';
	}
	return {
		veredicto,
		dif_igual: Number.isFinite(difIgual) ? r3(difIgual) : -1,
		dif_zoom: Number.isFinite(mejor.dif) ? r3(mejor.dif) : -1,
		dif_ruido: ruidoValido === null ? null : r3(ruidoValido),
		escala: r4(mejor.s),
		origen: {x: r1(mejor.o.x), y: r1(mejor.o.y)},
		pixeles: total,
		textura: r3(textura),
	};
}

// ───────────────────────────── Series: relleno, mediana, interpolación, EMA ─────────────────────────────

type Vec = number[];

/** Rachas [inicio, fin] de índices seguidos con valor y del mismo segmento. */
function rachas(serie: ReadonlyArray<Vec | null>, segs: readonly number[]): Array<[number, number]> {
	const r: Array<[number, number]> = [];
	let ini = -1;
	for (let i = 0; i <= serie.length; i++) {
		const corta = i === serie.length || serie[i] === null || (ini >= 0 && segs[i] !== segs[i - 1]);
		if (ini >= 0 && corta) {
			r.push([ini, i - 1]);
			ini = -1;
		}
		if (i < serie.length && serie[i] !== null && ini < 0) ini = i;
	}
	return r;
}

/**
 * Rellena huecos cortos (pura): hasta `max` muestras nulas seguidas entre dos con valor del mismo segmento se
 * interpolan en línea recta, si `mismaCara(a, b)` dice que los dos lados son la misma cara.
 */
export function rellenarHuecos(
	serie: ReadonlyArray<Vec | null>,
	segs: readonly number[],
	max: number,
	mismaCara: (a: Vec, b: Vec) => boolean = () => true,
): {serie: Array<Vec | null>; rellenadas: boolean[]} {
	const salida = serie.map((v) => (v ? [...v] : null));
	const rellenadas = serie.map(() => false);
	let i = 0;
	while (i < serie.length) {
		if (serie[i] !== null) {
			i++;
			continue;
		}
		let j = i;
		while (j < serie.length && serie[j] === null) j++;
		const a = i - 1;
		const b = j;
		if (a >= 0 && b < serie.length && j - i <= max && segs.slice(a, b + 1).every((s) => s === segs[a]) && mismaCara(serie[a]!, serie[b]!)) {
			for (let k = i; k < j; k++) {
				const f = (k - a) / (b - a);
				salida[k] = serie[a]!.map((v, c) => v + (serie[b]![c] - v) * f);
				rellenadas[k] = true;
			}
		}
		i = j;
	}
	return {serie: salida, rellenadas};
}

/** Mediana móvil centrada de `ventana` muestras, por componente, dentro de cada racha (pura). */
export function medianaMovil(serie: ReadonlyArray<Vec | null>, segs: readonly number[], ventana: number): Array<Vec | null> {
	const salida = serie.map((v) => (v ? [...v] : null));
	const radio = Math.max(0, Math.floor(ventana / 2));
	if (radio === 0) return salida;
	for (const [ini, fin] of rachas(serie, segs)) {
		for (let i = ini; i <= fin; i++) {
			const a = Math.max(ini, i - radio);
			const b = Math.min(fin, i + radio);
			salida[i] = serie[i]!.map((_, c) => mediana(serie.slice(a, b + 1).map((v) => v![c]))!);
		}
	}
	return salida;
}

/** EMA hacia adelante y luego hacia atrás (fase cero: no atrasa), por racha (pura). Cada racha arranca de cero. */
export function emaIdaVuelta(serie: ReadonlyArray<Vec | null>, segs: readonly number[], alfa: number): Array<Vec | null> {
	const salida = serie.map((v) => (v ? [...v] : null));
	for (const [ini, fin] of rachas(serie, segs)) {
		for (let i = ini + 1; i <= fin; i++) salida[i] = salida[i]!.map((v, c) => alfa * v + (1 - alfa) * salida[i - 1]![c]);
		for (let i = fin - 1; i >= ini; i--) salida[i] = salida[i]!.map((v, c) => alfa * v + (1 - alfa) * salida[i + 1]![c]);
	}
	return salida;
}

/**
 * Valores de muestras (t, seg, v) en los tiempos de salida, sin cruzar segmentos (pura).
 * Entre dos muestras del mismo segmento con valor: línea recta. Si solo una tiene valor: la más cercana (si es la
 * nula, no hay cara). En la orilla de un segmento (antes de su primera muestra o después de la última) se
 * sostiene la muestra hasta `sostenerS` segundos.
 */
export function interpolarSerie(
	muestras: ReadonlyArray<{t: number; seg: number; v: Vec | null}>,
	salida: ReadonlyArray<{t: number; seg: number}>,
	sostenerS: number,
): Array<Vec | null> {
	const ts = muestras.map((m) => m.t);
	const ultimaHasta = (t: number) => {
		let lo = 0;
		let hi = ts.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (ts[m] <= t + EPS) lo = m + 1;
			else hi = m;
		}
		return lo - 1;
	};
	return salida.map(({t, seg}) => {
		const u = ultimaHasta(t);
		const p: number | null = u >= 0 && muestras[u].seg === seg ? u : null;
		let n: number | null = p !== null && Math.abs(muestras[p].t - t) <= EPS ? p : u + 1;
		if (n >= muestras.length || muestras[n].seg !== seg) n = null;
		if (p !== null && n !== null) {
			if (p === n) return muestras[p].v ? [...muestras[p].v!] : null;
			const vp = muestras[p].v;
			const vn = muestras[n].v;
			if (vp && vn) {
				const f = (t - muestras[p].t) / (muestras[n].t - muestras[p].t);
				return vp.map((v, c) => v + (vn[c] - v) * f);
			}
			const cercana = t - muestras[p].t <= muestras[n].t - t ? vp : vn;
			return cercana ? [...cercana] : null;
		}
		if (p !== null) return muestras[p].v && t - muestras[p].t <= sostenerS + EPS ? [...muestras[p].v!] : null;
		if (n !== null) return muestras[n].v && muestras[n].t - t <= sostenerS + EPS ? [...muestras[n].v!] : null;
		return null;
	});
}

// ───────────────────────────── Armado del resultado (puro) ─────────────────────────────

export type MetaVideo = {
	fuente: string;
	/** Tamaño visible del video (ya rotado). */
	ancho: number;
	alto: number;
	fpsVideo: number;
	cuadrosVideo: number;
	paso: number;
	anchoAnalisis: number;
	altoAnalisis: number;
	silueta: boolean;
	/** Motor que leyó las caras (por defecto 'vision'). */
	motor?: MotorVision;
};

export type OpcionesCara = {
	/** Tiempos de corte de la base (s): el suavizado se reinicia en cada uno. */
	cortes?: readonly number[];
	parametros?: Partial<ParametrosCara>;
};

/**
 * Orilla de abajo de la barba (pura). El contorno de Vision sigue la quijada y su punto más bajo puede quedar arriba
 * de la barba (15–40 px base en la base de IMG_4874, revisado a ojo). Se baja la barbilla al PRIMER borde
 * oscuro→claro con fuerza ≥ `borde_fuerza_min` entre `borde_min_f` y `borde_max_f` × F bajo la barbilla del
 * contorno (F = distancia ojos–barbilla). Si ese primer borde claro ya cae más abajo del rango, es un brazo, una
 * mano o una tarjeta: se queda el contorno. Nunca sube la barbilla. null = no hay borde claro en el rango.
 */
export function elegirBordeBarbilla(
	barbillaY: number,
	ojosY: number | null,
	bordes: ReadonlyArray<{y: number; fuerza: number}>,
	parametros: Partial<ParametrosCara> = {},
): number | null {
	const p = {...PARAMETROS_CARA, ...parametros};
	if (ojosY === null || !(barbillaY - ojosY > 0)) return null;
	const f = barbillaY - ojosY;
	for (const b of [...bordes].sort((a, c) => a.y - c.y)) {
		if (b.fuerza < p.borde_fuerza_min) continue;
		const d = (b.y - barbillaY) / f;
		if (d < p.borde_min_f) continue;
		if (d > p.borde_max_f) return null;
		return Math.max(barbillaY, b.y);
	}
	return null;
}

/** Factor de una lista de mediciones: su mediana si hay suficientes; si no, el supuesto. */
function factor(medidas: number[], supuesto: number, minimo: number, fuente: FactorMedido['fuente']): FactorMedido {
	const m = mediana(medidas);
	return medidas.length >= minimo && m !== null ? {valor: r3(m), n: medidas.length, fuente} : {valor: supuesto, n: medidas.length, fuente: 'supuesto'};
}

/**
 * ¿Los labios de Vision son creíbles? (pura) Su punto más bajo debe quedar abajo de la nariz y de los ojos y arriba
 * de la barbilla del contorno. Una lectura que no cumple (mano en la boca, cara de lado) se cambia por la fórmula.
 */
export function bocaCreible(c: Pick<CaraBase, 'boca' | 'barbilla' | 'nariz_y' | 'ojos_y'>): boolean {
	if (!c.boca || !c.barbilla) return false;
	if (!(c.boca.y < c.barbilla.y)) return false;
	if (c.nariz_y !== null && !(c.boca.y > c.nariz_y)) return false;
	if (c.ojos_y !== null && !(c.boca.y > c.ojos_y)) return false;
	return true;
}

/** Boca estimada (pura): barbilla − k × alto de la cara (k medido en el video o el supuesto 0.18). */
export function estimarBoca(barbillaY: number, altoCara: number, k: number = SUPUESTOS.boca_factor): number {
	return barbillaY - k * altoCara;
}

/**
 * Lecturas de Vision → `Cara` (pura). Ver el encabezado del módulo: cara principal, base 1080×1920, coronilla y
 * lados (silueta o fórmula), relleno de huecos, mediana, interpolación a 30 fps y EMA, todo por tramo.
 */
export function construirCara(lineas: readonly CuadroVision[], meta: MetaVideo, op: OpcionesCara = {}): Cara {
	const p: ParametrosCara = {...PARAMETROS_CARA, ...op.parametros};
	const tr = transformacionBase(meta.ancho, meta.alto);
	const fpsMuestreo = meta.fpsVideo / meta.paso;
	const duracion = meta.cuadrosVideo / meta.fpsVideo;
	const cortes = normalizarCortes(op.cortes ?? [], duracion);
	const orden = [...lineas].sort((a, b) => a.n - b.n);
	const tiempos = orden.map((l) => l.t);

	// 1) Cara principal de cada muestra, en px base.
	const candidatas = orden.map((l) => ({n: l.n, t: l.t, tramo: indiceTramo(l.t, cortes), caras: l.caras.map((c) => caraABase(c, tr))}));
	const elegidas = elegirCaras(candidatas, p);
	const conCara = elegidas.filter((c): c is CaraBase => c !== null);

	// 2) Barbilla (contorno o la orilla de la barba) y factores de este video (silueta creíble) o los supuestos.
	const bordeDe = (c: CaraBase) => (c.barbilla ? elegirBordeBarbilla(c.barbilla.y, c.ojos_y, c.bordes_barbilla, p) : null);
	const barbillaDe = (c: CaraBase) => (c.barbilla ? (bordeDe(c) ?? c.barbilla.y) : null);
	const factorBarbilla = factor(
		conCara.filter((c) => c.barbilla).map((c) => (barbillaDe(c)! - c.caja.y) / c.caja.h),
		SUPUESTOS.barbilla_sin_contorno,
		p.min_muestras_factor,
		'contorno (este video)',
	);
	const kCoronilla = (c: CaraBase) => (c.silueta?.tope != null ? (c.caja.y - c.silueta.tope) / c.caja.h : null);
	const coronillaCreible = (c: CaraBase) => {
		const k = kCoronilla(c);
		return k !== null && k >= p.coronilla_min && k <= p.coronilla_max;
	};
	const factorCoronilla = factor(
		conCara.filter(coronillaCreible).map((c) => kCoronilla(c)!),
		SUPUESTOS.coronilla_factor,
		p.min_muestras_factor,
		'silueta (este video)',
	);
	const anchoContorno = (c: CaraBase) => (c.contorno_x ? c.contorno_x[1] - c.contorno_x[0] : c.caja.w);
	const ladosVision = (c: CaraBase): [number, number] => (c.contorno_x ? c.contorno_x : [c.caja.x, c.caja.x + c.caja.w]);
	const kLados = (c: CaraBase): [number | null, number | null] => {
		const s = c.silueta;
		const [c0, c1] = ladosVision(c);
		const w = anchoContorno(c);
		return [s?.izq != null ? (c0 - s.izq) / w : null, s?.der != null ? (s.der - c1) / w : null];
	};
	const ladoCreible = (k: number | null) => k !== null && k >= p.lado_min && k <= p.lado_max;
	const factorLado = factor(
		conCara.flatMap((c) => kLados(c).filter(ladoCreible) as number[]),
		SUPUESTOS.lado_factor,
		p.min_muestras_factor,
		'silueta (este video)',
	);
	// Boca: (barbilla − labios) / alto de la caja en las muestras con labios creíbles; si no hay, el supuesto 0.18.
	const factorBoca = factor(
		conCara.filter(bocaCreible).map((c) => (barbillaDe(c)! - c.boca!.y) / c.caja.h),
		SUPUESTOS.boca_factor,
		p.min_muestras_factor,
		'labios (este video)',
	);
	/** Boca de una muestra: la medida si es creíble; si no, la fórmula. Nunca arriba de la nariz ni de los ojos. */
	const bocaDe = (c: CaraBase, barbilla: number): {y: number; medida: boolean} => {
		if (bocaCreible(c)) return {y: c.boca!.y, medida: true};
		const piso = Math.max(c.nariz_y ?? Number.NEGATIVE_INFINITY, c.ojos_y ?? Number.NEGATIVE_INFINITY);
		return {y: Math.min(barbilla, Math.max(piso, estimarBoca(barbilla, c.caja.h, factorBoca.valor))), medida: false};
	};

	// 3) Muestras (sin suavizar).
	const muestras: MuestraCara[] = candidatas.map((m, k) => {
		const c = elegidas[k];
		const base = {n: m.n, t: r4(m.t), tramo: m.tramo, caras: m.caras.length};
		if (!c) {
			return {
				...base,
				cara: null,
				barbilla_y: null,
				barbilla_contorno_y: null,
				barbilla_borde: false,
				barbilla_estimada: false,
				boca_y: null,
				boca_medida: false,
				coronilla_y: null,
				coronilla_medida: false,
				lados: null,
				lados_medidos: false,
				escala_puntos: null,
				centro_puntos: null,
				confianza: 0,
			};
		}
		const borde = bordeDe(c);
		const barbilla = barbillaDe(c) ?? c.caja.y + factorBarbilla.valor * c.caja.h;
		const boca = bocaDe(c, barbilla);
		const coronillaMedida = coronillaCreible(c);
		const coronilla = coronillaMedida ? c.silueta!.tope! : c.caja.y - factorCoronilla.valor * c.caja.h;
		const [ki, kd] = kLados(c);
		const [c0, c1] = ladosVision(c);
		const w = anchoContorno(c);
		const izq = ladoCreible(ki) ? c.silueta!.izq! : c0 - factorLado.valor * w;
		const der = ladoCreible(kd) ? c.silueta!.der! : c1 + factorLado.valor * w;
		return {
			...base,
			cara: {x: r1(c.caja.x), y: r1(c.caja.y), w: r1(c.caja.w), h: r1(c.caja.h)},
			barbilla_y: r1(barbilla),
			barbilla_contorno_y: c.barbilla ? r1(c.barbilla.y) : null,
			barbilla_borde: borde !== null,
			barbilla_estimada: !c.barbilla,
			boca_y: r1(boca.y),
			boca_medida: boca.medida,
			coronilla_y: r1(coronilla),
			coronilla_medida: coronillaMedida,
			lados: [r1(izq), r1(der)],
			lados_medidos: ladoCreible(ki) && ladoCreible(kd),
			escala_puntos: c.escala_puntos === null ? null : r3(c.escala_puntos),
			centro_puntos: c.centro_puntos ? {x: r1(c.centro_puntos.x), y: r1(c.centro_puntos.y)} : null,
			confianza: r3(c.confianza),
		};
	});

	// 4) Por muestra: [x, y, w, h, barbilla, coronilla, izq, der, boca] → relleno de huecos → mediana (por tramo).
	//    La boca va en la misma serie: mismo relleno, mediana, interpolación y EMA, y se reinicia en cada corte.
	const segMuestra = tiempos.map((t) => indiceTramo(t, cortes));
	const crudas: Array<Vec | null> = muestras.map((m) => (m.cara ? [m.cara.x, m.cara.y, m.cara.w, m.cara.h, m.barbilla_y!, m.coronilla_y!, m.lados![0], m.lados![1], m.boca_y!] : null));
	const mismaCara = (a: Vec, b: Vec) => {
		const ra = {x: a[0], y: a[1], w: a[2], h: a[3]};
		const rb = {x: b[0], y: b[1], w: b[2], h: b[3]};
		const ca = centro(ra);
		const cb = centro(rb);
		return Math.abs(Math.log((rb.w * rb.h) / (ra.w * ra.h))) <= Math.log(1.3) && Math.hypot(cb.x - ca.x, cb.y - ca.y) <= 0.5 * (ra.w + rb.w) / 2;
	};
	const {serie: rellenas, rellenadas} = rellenarHuecos(crudas, segMuestra, p.hueco_max_muestras, mismaCara);
	const medianas = medianaMovil(rellenas, segMuestra, p.ventana_mediana);

	// 5) Interpolación a 30 fps y EMA de ida y vuelta, sin cruzar tramos.
	const nSalida = Math.max(0, Math.round(duracion * FPS_SALIDA));
	const salida = Array.from({length: nSalida}, (_, j) => {
		const t = j / FPS_SALIDA;
		return {t, seg: indiceTramo(t, cortes)};
	});
	const interpoladas = interpolarSerie(
		muestras.map((_, k) => ({t: tiempos[k], seg: segMuestra[k], v: medianas[k]})),
		salida,
		1 / fpsMuestreo,
	);
	const suaves = emaIdaVuelta(interpoladas, salida.map((s) => s.seg), p.alfa_ema);
	// Confianza: la de las detecciones vecinas del mismo tramo, sin suavizar (0 en las muestras rellenadas).
	const confianzas = interpolarSerie(
		muestras.map((m, k) => ({t: tiempos[k], seg: segMuestra[k], v: m.cara ? [m.confianza] : rellenadas[k] ? [0] : null})),
		salida,
		1 / fpsMuestreo,
	);

	const cuadros: CuadroCara[] = salida.map(({t}, j) => {
		const v = suaves[j];
		if (!v) return {t: r4(t), cara: null, barbilla_y: null, boca_y: null, coronilla_y: null, cabeza: null, confianza: 0};
		const [x, y, w, h, barbilla, coronilla, izq, der, boca] = v;
		return {
			t: r4(t),
			cara: {x: r1(x), y: r1(y), w: r1(w), h: r1(h)},
			barbilla_y: r1(barbilla),
			boca_y: r1(Math.min(boca, barbilla)),
			coronilla_y: r1(coronilla),
			cabeza: {x: r1(izq), y: r1(coronilla), w: r1(Math.max(0, der - izq)), h: r1(Math.max(0, barbilla - coronilla))},
			confianza: confianzas[j] ? r3(confianzas[j]![0]) : 0,
		};
	});

	const conCaraSalida = cuadros.filter((c) => c.cara !== null);
	const barbillas = conCaraSalida.map((c) => c.barbilla_y!);
	const bocas = conCaraSalida.map((c) => c.boca_y!);
	const coronillas = conCaraSalida.map((c) => c.coronilla_y!);
	const muestrasConCara = muestras.filter((m) => m.cara !== null).length;
	const conBorde = muestras.filter((m) => m.barbilla_borde).map((m) => m.barbilla_y! - m.barbilla_contorno_y!);
	const resumen: ResumenCara = {
		cobertura: nSalida ? r4(conCaraSalida.length / nSalida) : 0,
		cobertura_muestras: muestras.length ? r4(muestrasConCara / muestras.length) : 0,
		barbilla_y: {p50: rNull(cuantil(barbillas, 0.5)), p90: rNull(cuantil(barbillas, 0.9)), max: rNull(barbillas.length ? Math.max(...barbillas) : null)},
		boca_y: {p50: rNull(cuantil(bocas, 0.5)), p90: rNull(cuantil(bocas, 0.9)), max: rNull(bocas.length ? Math.max(...bocas) : null)},
		coronilla_y: {p10: rNull(cuantil(coronillas, 0.1)), p50: rNull(cuantil(coronillas, 0.5)), min: rNull(coronillas.length ? Math.min(...coronillas) : null)},
		cuadros: nSalida,
		cuadros_sin_cara: nSalida - conCaraSalida.length,
		muestras: muestras.length,
		muestras_con_cara: muestrasConCara,
		muestras_varias_caras: candidatas.filter((m) => m.caras.filter((c) => c.confianza >= p.min_confianza && c.caja.w >= p.min_ancho_px).length > 1).length,
		muestras_rellenadas: rellenadas.filter(Boolean).length,
		barbillas_estimadas: muestras.filter((m) => m.barbilla_estimada).length,
		barbillas_borde: conBorde.length,
		barbilla_borde_px: {p50: rNull(cuantil(conBorde, 0.5)), p90: rNull(cuantil(conBorde, 0.9)), max: rNull(conBorde.length ? Math.max(...conBorde) : null)},
		bocas_medidas: muestras.filter((m) => m.boca_medida).length,
		coronillas_medidas: muestras.filter((m) => m.coronilla_medida).length,
		lados_medidos: muestras.filter((m) => m.lados_medidos).length,
		factores: {barbilla: factorBarbilla, coronilla: factorCoronilla, lado: factorLado, boca: factorBoca},
	};

	return {
		version: 1,
		fuente: meta.fuente,
		fps: FPS_SALIDA,
		fps_muestreo: r4(fpsMuestreo),
		duracion_s: r4(duracion),
		base: [BASE_W, BASE_H],
		video: {ancho: meta.ancho, alto: meta.alto, fps: r4(meta.fpsVideo), cuadros: meta.cuadrosVideo},
		analisis: {ancho: meta.anchoAnalisis, alto: meta.altoAnalisis, paso: meta.paso, vision: descripcionMotorCara(meta.motor ?? 'vision'), silueta: meta.silueta},
		cortes_s: cortes.map(r4),
		parametros: p,
		cuadros,
		muestras,
		resumen,
	};
}

// ───────────────────────────── Consultas por ventana (layout y validar) ─────────────────────────────

/** Zoom de la EDL (o uno fijo sin tiempos). `origen` en px base; la base se escala alrededor de él. */
export type ZoomCara = {
	escala: number;
	origen: Punto2;
	desde?: number;
	hasta?: number;
	transicion?: 'corte' | 'suave';
};

export type OpcionesVentana = {
	/** Margen alrededor de [t0, t1] (s). Por defecto 0.2. */
	margen_s?: number;
};

/** Índices de los cuadros con t en [t0 − margen, t1 + margen]. */
function cuadrosEnVentana(cara: CaraConsultable, t0: number, t1: number, op: OpcionesVentana = {}): number[] {
	const margen = op.margen_s ?? PARAMETROS_CARA.margen_ventana_s;
	const fps = cara.fps || FPS_SALIDA;
	const a = Math.max(0, Math.ceil((Math.min(t0, t1) - margen) * fps - EPS));
	const b = Math.min(cara.cuadros.length - 1, Math.floor((Math.max(t0, t1) + margen) * fps + EPS));
	const r: number[] = [];
	for (let j = a; j <= b; j++) r.push(j);
	return r;
}

/**
 * Escalas posibles de la base en el cuadro j: sin zoom activo, 1. Un zoom con tiempos está activo en los cuadros
 * [round(desde·30), round(hasta·30)) (igual que una Sequence de Remotion). Con transición "suave" la escala va
 * de 1 a `escala` y regresa, así que cuentan las dos (se supone que el resorte no se pasa de `escala`); con
 * "corte", solo `escala`. Un zoom sin tiempos aplica fijo en toda la ventana.
 */
function escalasEnCuadro(j: number, fps: number, zooms: readonly ZoomCara[]): Array<{s: number; o: Punto2}> {
	const r: Array<{s: number; o: Punto2}> = [];
	let activo = false;
	for (const z of zooms) {
		if (z.desde === undefined || z.hasta === undefined) {
			r.push({s: z.escala, o: z.origen});
			activo = true;
			continue;
		}
		if (j >= Math.round(z.desde * fps) && j < Math.round(z.hasta * fps)) {
			r.push({s: z.escala, o: z.origen});
			if (z.transicion !== 'corte') r.push({s: 1, o: z.origen});
			activo = true;
		}
	}
	if (!activo) r.push({s: 1, o: {x: 0, y: 0}});
	return r;
}

const comoLista = (zoom?: ZoomCara | readonly ZoomCara[] | null): readonly ZoomCara[] => (!zoom ? [] : Array.isArray(zoom) ? zoom : [zoom as ZoomCara]);

/**
 * Barbilla más baja (y mayor, px base) en la ventana t0 − 0.2 … t1 + 0.2 s, con el zoom aplicado alrededor de
 * su origen (y' = oy + (y − oy)·s). null si no hay cara en la ventana.
 * Para el layout es la PREFERENCIA (debajo de la barbilla cuando cabe); el límite duro es la boca (bocaMax + 12).
 */
export function barbillaMax(cara: CaraConsultable, t0: number, t1: number, zoom?: ZoomCara | readonly ZoomCara[] | null, op: OpcionesVentana = {}): number | null {
	const zooms = comoLista(zoom);
	let max: number | null = null;
	for (const j of cuadrosEnVentana(cara, t0, t1, op)) {
		const y = cara.cuadros[j].barbilla_y;
		if (y === null || y === undefined) continue;
		for (const {s, o} of escalasEnCuadro(j, cara.fps || FPS_SALIDA, zooms)) {
			const yz = o.y + (y - o.y) * s;
			if (max === null || yz > max) max = yz;
		}
	}
	return max === null ? null : r1(max);
}

/** ¿El cara.json trae la boca medida? (uno de antes del director v2 no: bocaMax la estima con la barbilla). */
export function bocaMedida(cara: Pick<CaraConsultable, 'cuadros'>): boolean {
	return cara.cuadros.some((c) => typeof c.boca_y === 'number');
}

/**
 * Boca de un cuadro (px base, sin zoom): la del cara.json; si el archivo no la trae (es de antes de medirla), la
 * estimación barbilla − 0.18 × alto de la caja de la cara (`estimada` = true). null si no hay cara.
 */
export function bocaDeCuadro(c: CaraConsultable['cuadros'][number]): {y: number; estimada: boolean} | null {
	if (typeof c.boca_y === 'number') return {y: c.boca_y, estimada: false};
	if (c.barbilla_y === null || c.barbilla_y === undefined || !c.cara) return null;
	return {y: estimarBoca(c.barbilla_y, c.cara.h), estimada: true};
}

/**
 * Boca más baja (y mayor, px base) en la ventana t0 − 0.2 … t1 + 0.2 s, con el zoom aplicado alrededor de su origen.
 * Es la zona protegida (director v2): el borde de arriba de toda capa con tapaCabeza = false queda ≥ esto + 12 px.
 * Con un cara.json sin boca, la estima (ver bocaDeCuadro). null si no hay cara en la ventana.
 */
export function bocaMax(cara: CaraConsultable, t0: number, t1: number, zoom?: ZoomCara | readonly ZoomCara[] | null, op: OpcionesVentana = {}): number | null {
	const zooms = comoLista(zoom);
	let max: number | null = null;
	for (const j of cuadrosEnVentana(cara, t0, t1, op)) {
		const b = bocaDeCuadro(cara.cuadros[j]);
		if (!b) continue;
		for (const {s, o} of escalasEnCuadro(j, cara.fps || FPS_SALIDA, zooms)) {
			const yz = o.y + (b.y - o.y) * s;
			if (max === null || yz > max) max = yz;
		}
	}
	return max === null ? null : r1(max);
}

/** Coronilla más alta (y menor, px base) en la ventana, con el zoom aplicado. Para el titular. null sin cara. */
export function coronillaMin(cara: CaraConsultable, t0: number, t1: number, zoom?: ZoomCara | readonly ZoomCara[] | null, op: OpcionesVentana = {}): number | null {
	const zooms = comoLista(zoom);
	let min: number | null = null;
	for (const j of cuadrosEnVentana(cara, t0, t1, op)) {
		const y = cara.cuadros[j].coronilla_y;
		if (y === null || y === undefined) continue;
		for (const {s, o} of escalasEnCuadro(j, cara.fps || FPS_SALIDA, zooms)) {
			const yz = o.y + (y - o.y) * s;
			if (min === null || yz < min) min = yz;
		}
	}
	return min === null ? null : r1(min);
}

/** Caja de la cabeza de un cuadro: la guardada o, si falta, la armada con los supuestos. */
function cabezaDeCuadro(c: CaraConsultable['cuadros'][number]): Rect | null {
	if (c.cabeza) return c.cabeza;
	if (!c.cara || c.barbilla_y === null || c.coronilla_y === null) return null;
	const margen = SUPUESTOS.lado_factor * c.cara.w;
	return {x: c.cara.x - margen, y: c.coronilla_y, w: c.cara.w + 2 * margen, h: Math.max(0, c.barbilla_y - c.coronilla_y)};
}

/** Unión de las cajas de la cabeza en la ventana (px base), con el zoom aplicado. null si no hay cara. */
export function cajaCabeza(cara: CaraConsultable, t0: number, t1: number, zoom?: ZoomCara | readonly ZoomCara[] | null, op: OpcionesVentana = {}): Rect | null {
	const zooms = comoLista(zoom);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const j of cuadrosEnVentana(cara, t0, t1, op)) {
		const k = cabezaDeCuadro(cara.cuadros[j]);
		if (!k) continue;
		for (const {s, o} of escalasEnCuadro(j, cara.fps || FPS_SALIDA, zooms)) {
			x0 = Math.min(x0, o.x + (k.x - o.x) * s);
			x1 = Math.max(x1, o.x + (k.x + k.w - o.x) * s);
			y0 = Math.min(y0, o.y + (k.y - o.y) * s);
			y1 = Math.max(y1, o.y + (k.y + k.h - o.y) * s);
		}
	}
	if (!Number.isFinite(x0)) return null;
	return {x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0)};
}

/**
 * Unión de las cajas de la CARA (Vision: de la frente a la barbilla, sin el pelo) en la ventana, con zooms.
 * Es la zona que protege el titular: en los reels publicados el titular puede rozar el pelo, nunca la cara. null sin cara.
 */
export function cajaCara(cara: CaraConsultable, t0: number, t1: number, zoom?: ZoomCara | readonly ZoomCara[] | null, op: OpcionesVentana = {}): Rect | null {
	const zooms = comoLista(zoom);
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const j of cuadrosEnVentana(cara, t0, t1, op)) {
		const k = cara.cuadros[j]?.cara;
		if (!k) continue;
		for (const {s: e, o} of escalasEnCuadro(j, cara.fps || FPS_SALIDA, zooms)) {
			x0 = Math.min(x0, o.x + (k.x - o.x) * e);
			x1 = Math.max(x1, o.x + (k.x + k.w - o.x) * e);
			y0 = Math.min(y0, o.y + (k.y - o.y) * e);
			y1 = Math.max(y1, o.y + (k.y + k.h - o.y) * e);
		}
	}
	if (!Number.isFinite(x0)) return null;
	return {x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0)};
}

/** Fracción de cuadros con cara (0–1). */
export function cobertura(cara: Pick<CaraConsultable, 'cuadros'>): number {
	if (cara.cuadros.length === 0) return 0;
	return cara.cuadros.filter((c) => c.cara !== null).length / cara.cuadros.length;
}

// ───────────────────────────── Archivo cara.json ─────────────────────────────

const RectEsquema = z.object({x: z.number(), y: z.number(), w: z.number(), h: z.number()});

export const CaraEsquema = z.looseObject({
	version: z.literal(1),
	fuente: z.string(),
	fps: z.literal(30),
	fps_muestreo: z.number().positive(),
	duracion_s: z.number().nonnegative(),
	cortes_s: z.array(z.number()).default([]),
	cuadros: z.array(
		z.looseObject({
			t: z.number(),
			cara: RectEsquema.nullable(),
			barbilla_y: z.number().nullable(),
			boca_y: z.number().nullable().optional(),
			coronilla_y: z.number().nullable(),
			cabeza: RectEsquema.nullable().optional(),
			confianza: z.number(),
		}),
	),
	muestras: z
		.array(
			z.looseObject({
				n: z.number().int(),
				t: z.number(),
				tramo: z.number().int(),
				cara: RectEsquema.nullable(),
				barbilla_y: z.number().nullable(),
				escala_puntos: z.number().nullable().optional(),
				confianza: z.number(),
			}),
		)
		.default([]),
	resumen: z.looseObject({
		cobertura: z.number(),
		barbilla_y: z.object({p50: z.number().nullable(), p90: z.number().nullable(), max: z.number().nullable()}),
		cuadros_sin_cara: z.number().int(),
	}),
});

/** Lee y valida un cara.json. Falla con 2 si no existe y con 1 si no tiene la forma esperada. */
export function leerCara(ruta: string): Cara {
	if (!existsSync(ruta)) {
		throw fallo('leer la cara del video', `no existe ${ruta}`, 'corre npx tsx herramientas/cara.ts <slug> (o --video … --salida …)', 2);
	}
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo('leer la cara del video', `${basename(ruta)} no es JSON válido`, 'vuelve a correr herramientas/cara.ts con --forzar', 1, error);
	}
	const r = CaraEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo('leer la cara del video', `${basename(ruta)} no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`, 'vuelve a correr herramientas/cara.ts con --forzar', 1, r.error.issues);
	}
	return r.data as unknown as Cara;
}

// ───────────────────────────── Motor de visión (ffmpeg → herramientas/bin/cara o herramientas/py/cara.py) ─────────────────────────────

/** Revisa que exista el motor (binario de Vision o el .venv con herramientas/py/cara.py). */
export function asegurarBinarioCara(): void {
	const c = comandoCara();
	const falta = faltaParaVision(c, existsSync);
	if (falta) {
		throw fallo('buscar la cara', `no existe ${falta === c.programa && c.motor === 'python' ? 'el Python del .venv' : c.nombre}`, c.comoInstalar, 2);
	}
}

/** true si cara.swift cambió después de compilar el binario (hay que recompilar). Con el motor Python, false. */
export function binarioCaraDesactualizado(): boolean {
	if (comandoCara().motor !== 'vision') return false;
	try {
		return statSync(FUENTE_CARA_SWIFT).mtimeMs > statSync(RUTA_CARA).mtimeMs + 1000;
	} catch {
		return false;
	}
}

export type SeleccionVision = {tipo: 'paso'; paso: number} | {tipo: 'lista'; cuadros: number[]};

/** Máximo de cuadros sueltos en una lista (cada uno es un término de `select`). */
export const MAX_LISTA_VISION = 60;

/** Expresión de `select` para ffmpeg y el número de cuadro nativo de la k-ésima salida. */
export function seleccionFfmpeg(sel: SeleccionVision): {expresion: string; cuadro: (k: number) => number; esperados: number | null} {
	if (sel.tipo === 'paso') {
		const paso = Math.max(1, Math.round(sel.paso));
		return {expresion: `not(mod(n,${paso}))`, cuadro: (k) => k * paso, esperados: null};
	}
	const lista = [...new Set(sel.cuadros.map((n) => Math.round(n)))].filter((n) => n >= 0).sort((a, b) => a - b);
	if (lista.length === 0 || lista.length > MAX_LISTA_VISION) {
		throw fallo('elegir los cuadros', `la lista trae ${lista.length} cuadros (de 1 a ${MAX_LISTA_VISION})`, 'pide menos cuadros o usa un paso', 1);
	}
	return {expresion: lista.map((n) => `eq(n,${n})`).join('+'), cuadro: (k) => lista[k], esperados: lista.length};
}

export type OpcionesVision = {
	video: string;
	/** fps del video (CFR): t = n / fpsVideo. */
	fpsVideo: number;
	seleccion: SeleccionVision;
	/** Tamaño al que ffmpeg escala cada cuadro antes de pasarlo a Vision. */
	anchoAnalisis: number;
	altoAnalisis: number;
	hilos?: number;
	cpu?: boolean;
	/** Mide también la silueta de persona (coronilla y lados medidos). */
	silueta?: boolean;
	/** Avisa cada vez que Vision termina un cuadro (cuántos lleva). */
	alCuadro?: (hechos: number) => void;
};

/**
 * Corre ffmpeg | herramientas/bin/cara sobre los cuadros elegidos. Devuelve un CuadroVision por cuadro, en orden.
 * Fallos: 2 si falta el binario o ffmpeg; 1 si alguno termina con error (el de Vision trae su propia frase).
 */
export function correrVision(op: OpcionesVision): Promise<{cuadros: CuadroVision[]; segundos: number}> {
	asegurarBinarioCara();
	if (!existsSync(op.video)) throw fallo(`leer ${basename(op.video)}`, `no existe ${op.video}`, 'revisa la ruta', 2);
	const sel = seleccionFfmpeg(op.seleccion);
	const fpsEntrada = op.seleccion.tipo === 'paso' ? op.fpsVideo / Math.max(1, Math.round(op.seleccion.paso)) : op.fpsVideo;
	const argsFf = [
		'-v', 'error', '-nostdin', '-i', op.video,
		'-map', '0:v:0', '-an', '-sn', '-dn',
		'-vf', `select='${sel.expresion}',scale=${op.anchoAnalisis}:${op.altoAnalisis}:flags=area`,
		'-fps_mode', 'passthrough',
		'-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
	];
	const argsCara = ['--ancho', String(op.anchoAnalisis), '--alto', String(op.altoAnalisis), '--fps', String(fpsEntrada), '--hilos', String(op.hilos ?? 4)];
	if (op.cpu) argsCara.push('--cpu');
	if (op.silueta) argsCara.push('--silueta');
	const que = `buscar la cara en ${basename(op.video)}`;
	const t0 = performance.now();
	const motor = comandoCara();

	return new Promise((resolver, rechazar) => {
		const ff = spawn('ffmpeg', argsFf, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
		const vc = spawn(motor.programa, [...motor.prefijo, ...argsCara], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...motor.env}, windowsHide: true});
		let errFf = '';
		let errVc = '';
		let terminado = false;
		let codigoFf: number | null | undefined;
		let codigoVc: number | null | undefined;
		const lineas: Array<{i: number; t: number; caras: CaraVision[]}> = [];

		const abortar = (error: unknown) => {
			if (terminado) return;
			terminado = true;
			ff.kill('SIGKILL');
			vc.kill('SIGKILL');
			rechazar(error);
		};
		ff.stderr.on('data', (d: Buffer) => {
			errFf = (errFf + d.toString()).slice(-6000);
		});
		vc.stderr.on('data', (d: Buffer) => {
			errVc = (errVc + d.toString()).slice(-6000);
		});
		ff.on('error', (e: NodeJS.ErrnoException) =>
			abortar(
				e.code === 'ENOENT'
					? fallo(que, 'no encuentro ffmpeg en el PATH', `instala ffmpeg (${comoInstalar('ffmpeg')})`, 2, e)
					: fallo(que, `no pude arrancar ffmpeg (${e.message})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, e),
			),
		);
		vc.on('error', (e: NodeJS.ErrnoException) => abortar(fallo(que, `no pude arrancar ${motor.nombre} (${e.message})`, motor.comoInstalar, 1, e)));
		// Si cara muere antes de tiempo, escribir en su stdin da EPIPE: lo reporta su propio cierre.
		vc.stdin.on('error', () => {});
		ff.stdout.pipe(vc.stdin);

		createInterface({input: vc.stdout}).on('line', (linea) => {
			if (!linea.trim()) return;
			try {
				const l = JSON.parse(linea) as {i: number; t: number; caras: CaraVision[]};
				if (typeof l.i !== 'number' || !Array.isArray(l.caras)) throw new Error('forma inesperada');
				lineas.push(l);
				op.alCuadro?.(lineas.length);
			} catch (error) {
				abortar(fallo(que, `${motor.nombre} devolvió una línea que no es JSON válido`, motor.comoInstalar, 1, {error: String(error), linea: linea.slice(0, 500)}));
			}
		});

		const alCerrar = () => {
			if (terminado || codigoFf === undefined || codigoVc === undefined) return;
			terminado = true;
			if (codigoVc !== 0) {
				// cara ya imprime "No pude …. Siguiente paso: …." en español; macOS a veces pega sus avisos antes.
				const desde = errVc.lastIndexOf('No pude ');
				const frase = desde >= 0 ? errVc.slice(desde).split('\n')[0].trim() : undefined;
				const motivo = frase ? frase.replace(/^No pude [^:]*: /, '').replace(/\. Siguiente paso:.*$/, '') : `cara salió con ${codigoVc}`;
				const siguiente = frase?.match(/Siguiente paso: (.*)\.$/)?.[1] ?? 'revisa proyectos/_logs/fallos.log y avísame';
				rechazar(fallo(que, motivo, siguiente, codigoVc === 2 ? 2 : 1, {argsCara, stderr: errVc}));
				return;
			}
			if (codigoFf !== 0) {
				const ultima = errFf.trim().split('\n').pop() || `código ${codigoFf}`;
				rechazar(fallo(que, `ffmpeg terminó con error (${ultima})`, 'revisa proyectos/_logs/fallos.log y avísame', 1, {argsFf, stderr: errFf}));
				return;
			}
			if (sel.esperados !== null && lineas.length !== sel.esperados) {
				rechazar(fallo(que, `el motor de caras devolvió ${lineas.length} lecturas para ${sel.esperados} cuadros pedidos`, 'revisa que los cuadros existan en el video', 1, {argsFf, motor: motor.motor}));
				return;
			}
			const cuadros = lineas
				.sort((a, b) => a.i - b.i)
				.map((l) => {
					const n = sel.cuadro(l.i);
					return {n, t: n / op.fpsVideo, caras: l.caras};
				});
			resolver({cuadros, segundos: (performance.now() - t0) / 1000});
		};
		ff.on('close', (codigo) => {
			codigoFf = codigo;
			alCerrar();
		});
		vc.on('close', (codigo) => {
			codigoVc = codigo;
			// Si cara se fue antes que ffmpeg (falló Vision), nadie lee más cuadros: ffmpeg se quedaría esperando.
			if (codigoFf === undefined) {
				ff.stdout.unpipe(vc.stdin);
				ff.stdout.resume();
				ff.kill('SIGKILL');
			}
			alCerrar();
		});
	});
}

export type OpcionesAnalisis = OpcionesCara & {
	hilos?: number;
	cpu?: boolean;
	/** Mide la silueta (coronilla y lados medidos). Por defecto sí; cuesta ~2× en tiempo de Vision. */
	silueta?: boolean;
	alCuadro?: (hechos: number, total: number) => void;
	/** Recibe las lecturas crudas de Vision (para guardarlas con --crudo). */
	alLeer?: (cuadros: CuadroVision[]) => void;
};

/** Ruta corta para el JSON: relativa a la raíz del proyecto si vive dentro; si no, absoluta. */
export function rutaFuente(ruta: string): string {
	const absoluta = isAbsolute(ruta) ? ruta : resolve(ruta);
	const rel = relative(RAIZ, absoluta);
	return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absoluta;
}

/** Cara de un video completo: Vision a 10 fps (o los que pidas) + `construirCara`. Ver el encabezado del módulo. */
export async function analizarCara(mp4: string, op: OpcionesAnalisis = {}): Promise<Cara> {
	asegurarBinarioCara();
	const t0 = performance.now();
	const sondeo = await sondear(mp4);
	const v = sondeo.video;
	const fpsVideo = v.fpsReal > 0 ? v.fpsReal : v.fpsNominal;
	if (!(fpsVideo > 0)) throw fallo(`leer ${basename(mp4)}`, 'ffprobe no reporta sus fps', 'revisa que el video esté completo', 2);
	const cuadrosVideo = v.cuadros && v.cuadros > 0 ? v.cuadros : Math.round((v.duracion ?? sondeo.duracion) * fpsVideo);
	const parametros: ParametrosCara = {...PARAMETROS_CARA, ...op.parametros};
	const paso = pasoMuestreo(fpsVideo, parametros.fps_objetivo);
	const anchoAnalisis = Math.round(parametros.ancho_analisis / 2) * 2;
	const altoAnalisis = Math.max(2, Math.round((anchoAnalisis * v.altoVisible) / v.anchoVisible / 2) * 2);
	const silueta = op.silueta ?? true;
	const total = Math.ceil(cuadrosVideo / paso);
	const vision = await correrVision({
		video: mp4,
		fpsVideo,
		seleccion: {tipo: 'paso', paso},
		anchoAnalisis,
		altoAnalisis,
		hilos: op.hilos,
		cpu: op.cpu,
		silueta,
		alCuadro: op.alCuadro ? (hechos) => op.alCuadro!(hechos, total) : undefined,
	});
	op.alLeer?.(vision.cuadros);
	const cara = construirCara(
		vision.cuadros,
		{fuente: rutaFuente(mp4), ancho: v.anchoVisible, alto: v.altoVisible, fpsVideo, cuadrosVideo, paso, anchoAnalisis, altoAnalisis, silueta, motor: comandoCara().motor},
		{cortes: op.cortes, parametros},
	);
	const dosDecimales = (s: number) => Math.round(s * 100) / 100;
	cara.tiempos_s = {vision: dosDecimales(vision.segundos), total: dosDecimales((performance.now() - t0) / 1000)};
	return cara;
}

/** Cuadros nativos en gris, con el encuadre de la base (cover) reducido a `ancho`×`alto`. */
export function cuadrosGris(video: string, cuadros: number[], ancho = 270, alto = 480): Promise<Map<number, ImagenGris>> {
	const lista = [...new Set(cuadros.map((n) => Math.round(n)))].filter((n) => n >= 0).sort((a, b) => a - b);
	const resultado = new Map<number, ImagenGris>();
	const tandas: number[][] = [];
	for (let i = 0; i < lista.length; i += MAX_LISTA_VISION) tandas.push(lista.slice(i, i + MAX_LISTA_VISION));
	const bytes = ancho * alto;
	const una = (tanda: number[]) =>
		new Promise<void>((resolver, rechazar) => {
			const filtro = `select='${tanda.map((n) => `eq(n,${n})`).join('+')}',scale=${ancho}:${alto}:force_original_aspect_ratio=increase,crop=${ancho}:${alto},format=gray`;
			const ff = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', video, '-map', '0:v:0', '-an', '-vf', filtro, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const partes: Buffer[] = [];
			let err = '';
			ff.stdout.on('data', (d: Buffer) => partes.push(d));
			ff.stderr.on('data', (d: Buffer) => {
				err = (err + d.toString()).slice(-4000);
			});
			ff.on('error', (e) => rechazar(fallo(`leer cuadros de ${basename(video)}`, `no pude arrancar ffmpeg (${e.message})`, `instala ffmpeg (${comoInstalar('ffmpeg')})`, 2, e)));
			ff.on('close', (codigo) => {
				const todo = Buffer.concat(partes);
				if (codigo !== 0 || todo.length !== bytes * tanda.length) {
					rechazar(fallo(`leer cuadros de ${basename(video)}`, `ffmpeg entregó ${Math.floor(todo.length / bytes)} de ${tanda.length} cuadros`, 'revisa que los cuadros existan en el video', 1, {err}));
					return;
				}
				tanda.forEach((n, k) => resultado.set(n, {ancho, alto, datos: new Uint8Array(todo.subarray(k * bytes, (k + 1) * bytes))}));
				resolver();
			});
		});
	return tandas.reduce((p, t) => p.then(() => una(t)), Promise.resolve()).then(() => resultado);
}

export type ZoomVerificado = ZoomDetectado & {fondo: VerificacionFondo};

/**
 * Verifica cada zoom con el fondo (lee 3 cuadros por zoom con ffmpeg: el anterior para el ruido, el de antes y el
 * de después): `compararFondo` dice si el fondo también creció o se encogió (zoom de edición) o si quedó igual
 * (corte entre tomas donde la persona se movió).
 */
export async function verificarZoomsConFondo(video: string, cara: Pick<Cara, 'muestras'>, zooms: readonly ZoomDetectado[]): Promise<ZoomVerificado[]> {
	if (zooms.length === 0) return [];
	const porN = new Map(cara.muestras.map((m) => [m.n, m]));
	const imagenes = await cuadrosGris(video, zooms.flatMap((z) => [z.n_antes - 1, z.n_antes, z.n].filter((n) => n >= 0)));
	return zooms.map((z) => {
		const a = porN.get(z.n_antes);
		const b = porN.get(z.n);
		const ia = imagenes.get(z.n_antes);
		const ib = imagenes.get(z.n);
		const sinDatos: VerificacionFondo = {veredicto: 'dudoso', dif_igual: -1, dif_zoom: -1, dif_ruido: null, escala: z.razon, origen: z.origen ?? {x: BASE_W / 2, y: BASE_H / 2}, pixeles: 0, textura: 0};
		if (!a?.cara || !b?.cara || !a.lados || !b.lados || a.coronilla_y === null || b.coronilla_y === null || !ia || !ib) return {...z, fondo: sinDatos};
		// La cabeza de los dos cuadros queda fuera; el fondo se mide arriba de la barbilla más alta.
		const cabeza = {
			izq: Math.min(a.lados[0], b.lados[0]),
			der: Math.max(a.lados[1], b.lados[1]),
			arriba: Math.min(a.coronilla_y, b.coronilla_y),
			abajo: Math.min(a.barbilla_y!, b.barbilla_y!),
		};
		return {...z, fondo: compararFondo(ia, ib, {cabeza, razon: z.razon, origen: z.origen ?? {x: BASE_W / 2, y: BASE_H / 2}}, imagenes.get(z.n_antes - 1) ?? null)};
	});
}
