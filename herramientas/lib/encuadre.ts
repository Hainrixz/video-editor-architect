/**
 * Reencuadre automático de la base: acercar y mover la toma (estático, todo el video) para que tu cara quede como en
 * tus reels publicados y quede espacio debajo de la cabeza para stickers y tarjetas.
 *
 * 1. Objetivo (estilo/encuadre.json, lo mide pruebas/integracion/f6-encuadre.ts): en cada reel tuyo, la mediana (p50)
 *    de los cuadros con cara de: barbilla, alto de la caja de Vision ("alto de cara"), centro x de esa caja y
 *    coronilla, en la base 1080×1920 (herramientas/lib/cara.ts). Entre reels, la mediana de esos p50 (cada reel pesa
 *    igual), con p10, p90 y n. Un reel aporta solo si hay cara en ≥ 30 % de sus cuadros y en ≥ 300 cuadros
 *    (`CRITERIOS_REEL`): en un reel casi todo de capturas, la "cara" sale de unos pocos momentos o de un insert.
 *
 * 2. Encuadre de un proyecto (`calcularEncuadre`), con la cara de su base (cara.json):
 *      s = clamp(alto_cara_objetivo / alto_cara_medido, 1, 1.35)
 *    Nunca aleja (s ≥ 1): fuera del cuadro del original no hay pixeles. Con s, la ventana mide 1/s de la ventana que
 *    hoy llena la base ("cover" del cuadro completo) y se coloca para que la barbilla mediana quede en la barbilla
 *    objetivo y el centro x de la cara en 540; luego se acota dentro del cuadro (sin bordes negros) y se redondea a
 *    pares (yuv 4:2:0). Si s quedó en un límite o la ventana chocó con una orilla, el objetivo no se alcanza del todo
 *    y el resultado lo dice (`limite_escala`, `acotado`).
 *
 * Coordenadas:
 * - "px del original" = pixeles del cuadro VISIBLE del original (ya rotado), p. ej. 2160×3840 aunque el archivo
 *   guarde 3840×2160 con rotación ±90. Es lo que ve el `crop` de ffmpeg dentro del filtro, porque ffmpeg rota solo
 *   (autorrotación por defecto) antes del filtro. `recorteAlmacenado` da el mismo rectángulo en el cuadro guardado
 *   (sin rotar), por si algún día se usa -noautorotate. Verificado con ffmpeg 8.1: +90 = la imagen se gira 90° a la
 *   izquierda para verse (transpose=cclock); −90 = a la derecha (transpose=clock).
 * - La base es SIEMPRE el "cover" (escala y recorte centrado, como el `objectFit: cover` de Reel.tsx) de un recorte
 *   del original: sin encuadre, el recorte es el cuadro completo. Así una medida de cualquier base se lleva a
 *   cualquier otra pasando por px del original (`baseAOriginal` → `originalABase`).
 *
 * Todo aquí es puro (sin Vision ni ffmpeg): se prueba en pruebas/unit/encuadre.test.ts.
 */
import {existsSync, readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {z} from 'zod';
import {BASE_H, BASE_W, cuantil, transformacionBase, type CaraConsultable, type Punto2, type Transformacion} from './cara.ts';
import {fallo} from './fallo.ts';

/** Límites del encuadre (los da el plan de la Fase 6): nunca alejar y acercar hasta ×1.35. */
export const LIMITES_ENCUADRE = {escala_min: 1, escala_max: 1.35} as const;

/** Centro x de la cara si el objetivo no trae uno medido: el centro del cuadro. */
export const CENTRO_X_POR_DEFECTO = BASE_W / 2;

/** La ventana "chocó" con una orilla si para quedar en su sitio tuvo que moverse más de esto (px base). */
const ACOTADO_MIN_PX = 2;

/** Un reel aporta al objetivo si hay cara en ≥ 30 % de sus cuadros y en ≥ 300 cuadros (10 s a 30 fps). */
export const CRITERIOS_REEL = {cobertura_min: 0.3, cuadros_con_cara_min: 300} as const;

const EPS = 1e-6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const rNull = (v: number | null, f: (x: number) => number = r1) => (v === null ? null : f(v));

// ───────────────────────────── Tipos ─────────────────────────────

export type Recorte = {x: number; y: number; w: number; h: number};

/** Tamaño y rotación del original: guardado (ancho×alto del archivo) y visible (ya rotado). */
export type VideoOriginal = {ancho: number; alto: number; rotacion: number; ancho_visible: number; alto_visible: number};

/** Medianas de la cara en una base (px base 1080×1920). */
export type MedidasCara = {
	/** Cuadros (de 30 fps) con cara que entraron a las medianas. */
	n: number;
	barbilla_y: number;
	/** Alto de la caja de Vision. */
	alto_cara: number;
	/** Centro x de la caja de Vision. */
	centro_x: number;
	coronilla_y: number | null;
};

export type ObjetivoCara = {barbilla_y: number; alto_cara: number; centro_x: number};

export type Estadistico = {valor: number | null; p10: number | null; p90: number | null; n: number};

// ───────────────────────────── Medidas de una cara ─────────────────────────────

/** Medianas de los cuadros con cara de un cara.json (los de 30 fps, ya suavizados). null si no hay ninguno. */
export function medidasDeCara(cara: Pick<CaraConsultable, 'cuadros'>): MedidasCara | null {
	const con = cara.cuadros.filter((c) => c.cara !== null && c.barbilla_y !== null);
	if (con.length === 0) return null;
	const p50 = (v: number[]) => cuantil(v, 0.5)!;
	const coronillas = con.map((c) => c.coronilla_y).filter((v): v is number => v !== null && v !== undefined);
	return {
		n: con.length,
		barbilla_y: r1(p50(con.map((c) => c.barbilla_y!))),
		alto_cara: r1(p50(con.map((c) => c.cara!.h))),
		centro_x: r1(p50(con.map((c) => c.cara!.x + c.cara!.w / 2))),
		coronilla_y: coronillas.length ? r1(p50(coronillas)) : null,
	};
}

// ───────────────────────────── Objetivo (tus reels) ─────────────────────────────

/** Lo que aporta un reel al objetivo. */
export type ReelEncuadre = {
	shortCode: string;
	grupo: string;
	mp4: string;
	fps: number;
	duracion_s: number;
	cuadros: number;
	cuadros_con_cara: number;
	cobertura: number;
	barbilla_y_p50: number | null;
	alto_cara_p50: number | null;
	centro_x_p50: number | null;
	coronilla_y_p50: number | null;
	incluido: boolean;
	motivo: string | null;
};

/** Resumen de un reel medido con cara.ts: sus p50 y si aporta al objetivo (con el motivo si no). */
export function resumirReel(
	reel: {shortCode: string; grupo: string; mp4: string; fps: number; duracion_s: number},
	cara: Pick<CaraConsultable, 'cuadros'>,
	criterios: {cobertura_min: number; cuadros_con_cara_min: number} = CRITERIOS_REEL,
): ReelEncuadre {
	const m = medidasDeCara(cara);
	const cuadros = cara.cuadros.length;
	const conCara = m?.n ?? 0;
	const cobertura = cuadros > 0 ? conCara / cuadros : 0;
	let motivo: string | null = null;
	if (!m) motivo = 'Vision no vio tu cara en ningún cuadro';
	else if (cobertura < criterios.cobertura_min) motivo = `hay cara solo en el ${(cobertura * 100).toFixed(1)} % de los cuadros (mínimo ${criterios.cobertura_min * 100} %)`;
	else if (conCara < criterios.cuadros_con_cara_min) motivo = `hay cara solo en ${conCara} cuadros (mínimo ${criterios.cuadros_con_cara_min})`;
	return {
		...reel,
		cuadros,
		cuadros_con_cara: conCara,
		cobertura: r4(cobertura),
		barbilla_y_p50: m?.barbilla_y ?? null,
		alto_cara_p50: m?.alto_cara ?? null,
		centro_x_p50: m?.centro_x ?? null,
		coronilla_y_p50: m?.coronilla_y ?? null,
		incluido: motivo === null,
		motivo,
	};
}

/** Mediana, p10 y p90 (interpolación lineal, la de herramientas/lib/cara.ts) y n de una lista. */
export function estadistico(valores: readonly number[]): Estadistico {
	const v = valores.filter((x) => Number.isFinite(x));
	return {valor: rNull(cuantil(v, 0.5)), p10: rNull(cuantil(v, 0.1)), p90: rNull(cuantil(v, 0.9)), n: v.length};
}

export type ResumenObjetivo = {barbilla_y: Estadistico; alto_cara: Estadistico; centro_x: Estadistico; coronilla_y: Estadistico; n_reels: number};

/** Agrega los p50 de los reels que aportan: mediana entre reels (cada reel pesa igual). */
export function agregarObjetivo(reels: readonly ReelEncuadre[]): ResumenObjetivo {
	const ok = reels.filter((r) => r.incluido);
	const de = (f: (r: ReelEncuadre) => number | null) => estadistico(ok.map(f).filter((v): v is number => v !== null));
	return {
		barbilla_y: de((r) => r.barbilla_y_p50),
		alto_cara: de((r) => r.alto_cara_p50),
		centro_x: de((r) => r.centro_x_p50),
		coronilla_y: de((r) => r.coronilla_y_p50),
		n_reels: ok.length,
	};
}

const EstadisticoEsquema = z.object({valor: z.number().nullable(), p10: z.number().nullable(), p90: z.number().nullable(), n: z.number().int().nonnegative()});

/** estilo/encuadre.json (solo lo que lee el cálculo; el resto de campos se respeta tal cual). */
export const ObjetivoEsquema = z.looseObject({
	version: z.literal(1),
	fuente: z.string(),
	barbilla_y: EstadisticoEsquema,
	alto_cara: EstadisticoEsquema,
	centro_x: EstadisticoEsquema,
	coronilla_y: EstadisticoEsquema,
	n_reels: z.number().int().nonnegative(),
});
export type ObjetivoArchivo = z.infer<typeof ObjetivoEsquema>;

/** Lee estilo/encuadre.json. Código 2 si falta, no es JSON o no trae barbilla, alto de cara y centro medidos. */
export function leerObjetivo(ruta: string): ObjetivoArchivo & {objetivo: ObjetivoCara} {
	const que = 'leer el objetivo de encuadre';
	const siguiente = 'apréndelo de tus reels con /aprender-estilo (escribe estilo/encuadre.json) o usa el genérico de la plantilla';
	if (!existsSync(ruta)) throw fallo(que, `no existe ${ruta}`, siguiente, 2);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${basename(ruta)} no es JSON válido`, siguiente, 2, error);
	}
	const r = ObjetivoEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(que, `${basename(ruta)} no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`, siguiente, 2, r.error.issues);
	}
	const {barbilla_y, alto_cara, centro_x} = r.data;
	// Un objetivo supuesto (el genérico de la plantilla) no está medido: se acepta con n = 0 si trae valores.
	const supuesto = /^(supuesto|plantilla)/i.test(r.data.fuente.trim());
	if (barbilla_y.valor === null || alto_cara.valor === null || !(alto_cara.valor > 0) || (!supuesto && (barbilla_y.n === 0 || alto_cara.n === 0))) {
		throw fallo(que, `${basename(ruta)} no trae barbilla y alto de cara medidos (n = 0; solo un objetivo con fuente "supuesto…" o "plantilla…" puede ir sin medir)`, siguiente, 2);
	}
	return {...r.data, objetivo: {barbilla_y: barbilla_y.valor, alto_cara: alto_cara.valor, centro_x: centro_x.valor ?? CENTRO_X_POR_DEFECTO}};
}

// ───────────────────────────── Geometría: original ↔ base ─────────────────────────────

/** El cuadro visible completo del original (la base sin encuadre es su "cover"). */
export const recorteCompleto = (video: Pick<VideoOriginal, 'ancho_visible' | 'alto_visible'>): Recorte => ({x: 0, y: 0, w: video.ancho_visible, h: video.alto_visible});

export const mismoRecorte = (a: Recorte, b: Recorte): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** ¿El recorte es el cuadro completo? (aplicarlo no cambia nada: base.ts lo trata como "sin encuadre"). */
export const esIdentidad = (recorte: Recorte, video: Pick<VideoOriginal, 'ancho_visible' | 'alto_visible'>): boolean => mismoRecorte(recorte, recorteCompleto(video));

/** Transformación de un recorte del original a la base 1080×1920 ("cover" centrado del recorte). */
export const transformacionRecorte = (recorte: Recorte): Transformacion => transformacionBase(recorte.w, recorte.h);

/** px del original (visible) → px de la base que sale de ese recorte. */
export function originalABase(p: Punto2, recorte: Recorte): Punto2 {
	const t = transformacionRecorte(recorte);
	return {x: (p.x - recorte.x) * t.escala + t.dx, y: (p.y - recorte.y) * t.escala + t.dy};
}

/** px de una base (salida de ese recorte) → px del original (visible). */
export function baseAOriginal(p: Punto2, recorte: Recorte): Punto2 {
	const t = transformacionRecorte(recorte);
	return {x: (p.x - t.dx) / t.escala + recorte.x, y: (p.y - t.dy) / t.escala + recorte.y};
}

/** Lleva medidas de la cara de la base del recorte `desde` a la base del recorte `hasta` (alto: por la razón de escalas). */
export function convertirMedidas(m: MedidasCara, desde: Recorte, hasta: Recorte): MedidasCara {
	const td = transformacionRecorte(desde);
	const th = transformacionRecorte(hasta);
	const barbilla = originalABase(baseAOriginal({x: m.centro_x, y: m.barbilla_y}, desde), hasta);
	const coronilla = m.coronilla_y === null ? null : originalABase(baseAOriginal({x: m.centro_x, y: m.coronilla_y}, desde), hasta).y;
	return {n: m.n, barbilla_y: r1(barbilla.y), alto_cara: r1((m.alto_cara / td.escala) * th.escala), centro_x: r1(barbilla.x), coronilla_y: rNull(coronilla)};
}

/**
 * El mismo rectángulo en el cuadro GUARDADO (sin rotar) del archivo. `rotacion` con la convención de ffprobe
 * (antihoraria): +90 → ffmpeg gira la imagen a la izquierda para verla (guardado (x, y) → visible (y, ancho − x));
 * −90 → a la derecha (guardado (x, y) → visible (alto − y, x)); 180 → de cabeza.
 */
export function recorteAlmacenado(r: Recorte, video: Pick<VideoOriginal, 'ancho' | 'alto' | 'rotacion'>): Recorte {
	const rot = ((Math.round(video.rotacion) % 360) + 360) % 360;
	if (rot === 90) return {x: video.ancho - r.y - r.h, y: r.x, w: r.h, h: r.w};
	if (rot === 270) return {x: r.y, y: video.alto - r.x - r.w, w: r.h, h: r.w};
	if (rot === 180) return {x: video.ancho - r.x - r.w, y: video.alto - r.y - r.h, w: r.w, h: r.h};
	return {...r};
}

/** Filtro de ffmpeg del recorte (va sobre el cuadro ya rotado: la autorrotación de ffmpeg va antes del filtro). */
export const filtroRecorte = (r: Recorte): string => `crop=${r.w}:${r.h}:${r.x}:${r.y}`;

/** Problemas de un recorte contra el cuadro visible del original (vacío = sirve). El cuadro completo siempre sirve. */
export function problemasRecorte(r: Recorte, video: Pick<VideoOriginal, 'ancho_visible' | 'alto_visible'>): string[] {
	if (esIdentidad(r, video)) return [];
	const p: string[] = [];
	if (![r.x, r.y, r.w, r.h].every((v) => Number.isInteger(v))) p.push('x, y, w y h tienen que ser enteros');
	if ([r.x, r.y, r.w, r.h].some((v) => v % 2 !== 0)) p.push('x, y, w y h tienen que ser pares (video 4:2:0)');
	if (!(r.w > 0) || !(r.h > 0)) p.push('w y h tienen que ser mayores que 0');
	if (r.x < 0 || r.y < 0 || r.x + r.w > video.ancho_visible || r.y + r.h > video.alto_visible) {
		p.push(`se sale del cuadro de ${video.ancho_visible}×${video.alto_visible} (dejaría bordes negros)`);
	}
	return p;
}

// ───────────────────────────── Cálculo del encuadre ─────────────────────────────

/** Redondeo al par más cercano. */
const par = (v: number) => 2 * Math.round(v / 2);
/** Par hacia abajo. */
const parAbajo = (v: number) => 2 * Math.floor(v / 2 + EPS);
const acotar = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type ResultadoEncuadre = {
	/** s pedida por el alto de cara (sin acotar) y la que se usó (acotada a [1, 1.35]). */
	escala_pedida: number;
	escala: number;
	/** La que de verdad queda tras redondear el recorte a pares. */
	escala_efectiva: number;
	limite_escala: 'min' | 'max' | null;
	/** Recorte en px del original (cuadro visible, ya rotado). */
	recorte: Recorte;
	/** El mismo recorte en el cuadro guardado (sin rotar). */
	recorte_almacenado: Recorte;
	/** Centro del recorte en px del original. */
	centro_x: number;
	centro_y: number;
	/** Hacia dónde chocó la ventana con la orilla del cuadro (null = no chocó). */
	acotado: {x: 'izquierda' | 'derecha' | null; y: 'arriba' | 'abajo' | null};
	identidad: boolean;
	/** Medidas de la cara en la base sin encuadre (antes) y las que se esperan con este recorte (después). */
	antes: MedidasCara;
	despues: MedidasCara;
	objetivo: ObjetivoCara;
	/** después − objetivo (px base). */
	diferencia: {barbilla_y: number; alto_cara: number; centro_x: number};
	avisos: string[];
};

/**
 * Encuadre estático (ver el encabezado del módulo). `medidas` son de la base que sale de `recorteActual` (por
 * defecto el cuadro completo: una base sin encuadre); el resultado siempre se expresa respecto al original.
 */
export function calcularEncuadre(op: {
	medidas: MedidasCara;
	objetivo: ObjetivoCara;
	video: VideoOriginal;
	recorteActual?: Recorte;
	limites?: {escala_min: number; escala_max: number};
}): ResultadoEncuadre {
	const {video, objetivo} = op;
	const limites = {escala_min: LIMITES_ENCUADRE.escala_min, escala_max: LIMITES_ENCUADRE.escala_max, ...op.limites};
	const completo = recorteCompleto(video);
	if (!(video.ancho_visible > 0) || !(video.alto_visible > 0)) {
		throw fallo('calcular el encuadre', `el original no reporta su tamaño visible (${video.ancho_visible}×${video.alto_visible})`, 'revisa el original con ffprobe', 2);
	}
	const actual = op.recorteActual ?? completo;
	const problemasActual = problemasRecorte(actual, video);
	if (problemasActual.length > 0) {
		throw fallo('calcular el encuadre', `el recorte con el que se hizo la base no cabe en el original: ${problemasActual.join('; ')}`, 'vuelve a generar la base sin encuadre (base.ts <slug> --sin-encuadre) y mide la cara otra vez', 2);
	}
	if (!(op.medidas.alto_cara > 0) || !Number.isFinite(op.medidas.barbilla_y) || !Number.isFinite(op.medidas.centro_x)) {
		throw fallo('calcular el encuadre', 'las medidas de la cara no son válidas (alto ≤ 0 o sin barbilla)', 'vuelve a correr herramientas/cara.ts <slug> --forzar', 2);
	}
	if (!(objetivo.alto_cara > 0)) throw fallo('calcular el encuadre', 'el objetivo trae un alto de cara ≤ 0', 'vuelve a medir estilo/encuadre.json', 2);

	// Todo se mide contra la base SIN encuadre (cover del cuadro completo).
	const antes = convertirMedidas(op.medidas, actual, completo);
	const t0 = transformacionRecorte(completo);
	const escalaPedida = objetivo.alto_cara / antes.alto_cara;
	const escala = acotar(escalaPedida, limites.escala_min, limites.escala_max);
	const limiteEscala = escalaPedida < limites.escala_min - EPS ? 'min' : escalaPedida > limites.escala_max + EPS ? 'max' : null;

	// Ventana ideal en px del original: 1/s de la ventana que hoy llena la base, con la proporción de la base.
	const anchoVentana = BASE_W / t0.escala / escala;
	const altoVentana = BASE_H / t0.escala / escala;
	const k = t0.escala * escala; // px base por px del original con esta ventana
	const cara = baseAOriginal({x: antes.centro_x, y: antes.barbilla_y}, completo);
	const x0 = cara.x - objetivo.centro_x / k;
	const y0 = cara.y - objetivo.barbilla_y / k;

	// Enteros pares (4:2:0) dentro del cuadro: primero el tamaño, luego la posición.
	let w = Math.min(par(anchoVentana), parAbajo(video.ancho_visible));
	let h = Math.min(par((w * BASE_H) / BASE_W), parAbajo(video.alto_visible));
	if (escala <= limites.escala_min + EPS && Math.abs(anchoVentana - video.ancho_visible) < 1 && Math.abs(altoVentana - video.alto_visible) < 1) {
		// s = 1 sobre un original 9:16: la ventana es el cuadro completo (sin redondeos que lo achiquen un pixel).
		w = video.ancho_visible;
		h = video.alto_visible;
	}
	const xMax = Math.max(0, parAbajo(video.ancho_visible - w));
	const yMax = Math.max(0, parAbajo(video.alto_visible - h));
	const x = acotar(par(x0), 0, xMax);
	const y = acotar(par(y0), 0, yMax);
	// Solo cuenta como "chocó" si la orilla movió la ventana más de 2 px base (no por el redondeo a pares).
	const acotadoX = Math.abs(x0 - x) * k > ACOTADO_MIN_PX ? (x0 < x ? 'izquierda' : 'derecha') : null;
	const acotadoY = Math.abs(y0 - y) * k > ACOTADO_MIN_PX ? (y0 < y ? 'arriba' : 'abajo') : null;
	const recorte: Recorte = {x, y, w, h};

	const despues = convertirMedidas(antes, completo, recorte);
	const t1 = transformacionRecorte(recorte);
	const avisos: string[] = [];
	if (limiteEscala === 'min') {
		avisos.push(`tu cara ya mide ${Math.round(antes.alto_cara)} px de alto y el objetivo es ${Math.round(objetivo.alto_cara)} px: haría falta alejar (×${escalaPedida.toFixed(2)}) y fuera del cuadro no hay pixeles, así que la escala se queda en ×${limites.escala_min}`);
	}
	if (limiteEscala === 'max') {
		avisos.push(`tu cara mide ${Math.round(antes.alto_cara)} px y el objetivo es ${Math.round(objetivo.alto_cara)} px: haría falta ×${escalaPedida.toFixed(2)} y el máximo es ×${limites.escala_max}`);
	}
	// Solo se avisa lo que se nota: más de 10 px de barbilla o 30 px de centro fuera del objetivo.
	if (acotadoY && Math.abs(despues.barbilla_y - objetivo.barbilla_y) > 10) {
		avisos.push(
			`la barbilla queda en ${Math.round(despues.barbilla_y)} px y no en ${Math.round(objetivo.barbilla_y)}: para llegar, la ventana se saldría por ${acotadoY === 'abajo' ? 'abajo' : 'arriba'} del cuadro (dejaría un borde negro)`,
		);
	}
	if (acotadoX && Math.abs(despues.centro_x - objetivo.centro_x) > 30) {
		avisos.push(`la cara queda en x = ${Math.round(despues.centro_x)} y no en ${Math.round(objetivo.centro_x)}: la ventana chocó con la orilla ${acotadoX}`);
	}
	if (despues.coronilla_y !== null && despues.coronilla_y < 0) {
		avisos.push(`la coronilla queda fuera del cuadro (y = ${Math.round(despues.coronilla_y)} px): este encuadre corta la cabeza arriba`);
	}

	return {
		escala_pedida: r4(escalaPedida),
		escala: r4(escala),
		escala_efectiva: r4(t1.escala / t0.escala),
		limite_escala: limiteEscala,
		recorte,
		recorte_almacenado: recorteAlmacenado(recorte, video),
		centro_x: r1(x + w / 2),
		centro_y: r1(y + h / 2),
		acotado: {x: acotadoX, y: acotadoY},
		identidad: esIdentidad(recorte, video),
		antes,
		despues,
		objetivo: {barbilla_y: r1(objetivo.barbilla_y), alto_cara: r1(objetivo.alto_cara), centro_x: r1(objetivo.centro_x)},
		diferencia: {
			barbilla_y: r1(despues.barbilla_y - objetivo.barbilla_y),
			alto_cara: r1(despues.alto_cara - objetivo.alto_cara),
			centro_x: r1(despues.centro_x - objetivo.centro_x),
		},
		avisos,
	};
}

// ───────────────────────────── Archivo proyectos/<slug>/encuadre.json ─────────────────────────────

const RecorteEsquema = z.object({x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), w: z.number().int().positive(), h: z.number().int().positive()});
const MedidasEsquema = z.object({n: z.number(), barbilla_y: z.number(), alto_cara: z.number(), centro_x: z.number(), coronilla_y: z.number().nullable()});

/** Lo que lee base.ts de encuadre.json (lo demás es para ti y para el reporte). */
export const EncuadreEsquema = z.looseObject({
	version: z.literal(1),
	escala: z.number().min(1 - EPS).max(LIMITES_ENCUADRE.escala_max + EPS),
	escala_efectiva: z.number().positive(),
	recorte: RecorteEsquema,
	recorte_almacenado: RecorteEsquema.optional(),
	centro_x: z.number(),
	centro_y: z.number(),
	original: z.object({
		ruta: z.string().optional(),
		/** sha256 del crudo para el que se calculó (base.ts no lo aplica a otro original). */
		sha256: z.string().optional(),
		ancho: z.number().int().positive(),
		alto: z.number().int().positive(),
		rotacion: z.number(),
		ancho_visible: z.number().int().positive(),
		alto_visible: z.number().int().positive(),
	}),
	identidad: z.boolean(),
	barbilla_antes: z.number(),
	barbilla_despues: z.number(),
	antes: MedidasEsquema.optional(),
	despues: MedidasEsquema.optional(),
	objetivo: z.looseObject({barbilla_y: z.number(), alto_cara: z.number(), centro_x: z.number()}),
	fuente: z.looseObject({cara: z.string(), objetivo: z.string()}),
});
export type EncuadreArchivo = z.infer<typeof EncuadreEsquema>;

/** Lee y valida un encuadre.json. Código 2 si falta, no es JSON, no tiene la forma o el recorte no es válido. */
export function leerEncuadre(ruta: string): EncuadreArchivo {
	const que = 'leer el encuadre';
	if (!existsSync(ruta)) throw fallo(que, `no existe ${ruta}`, 'calcúlalo con npx tsx herramientas/encuadre.ts <slug>', 2);
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo(que, `${basename(ruta)} no es JSON válido`, 'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug>', 2, error);
	}
	const r = EncuadreEsquema.safeParse(datos);
	if (!r.success) {
		const primero = r.error.issues[0];
		throw fallo(que, `${basename(ruta)} no tiene la forma esperada (${primero?.path.join('.') || 'raíz'}: ${primero?.message ?? 'inválido'})`, 'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug>', 2, r.error.issues);
	}
	const problemas = problemasRecorte(r.data.recorte, r.data.original);
	if (problemas.length > 0) throw fallo(que, `el recorte de ${basename(ruta)} no sirve: ${problemas.join('; ')}`, 'vuelve a calcularlo con npx tsx herramientas/encuadre.ts <slug>', 2);
	return r.data;
}

/** Arma el contenido de encuadre.json a partir del resultado. */
export function archivoEncuadre(
	res: ResultadoEncuadre,
	datos: {slug: string; video: VideoOriginal & {ruta?: string}; fuente: {cara: string; objetivo: string} & Record<string, unknown>; generado_en?: string},
): EncuadreArchivo & Record<string, unknown> {
	return {
		version: 1,
		slug: datos.slug,
		generado_en: datos.generado_en ?? new Date().toISOString(),
		generado_por: 'herramientas/encuadre.ts (herramientas/lib/encuadre.ts → calcularEncuadre)',
		escala: res.escala,
		escala_pedida: res.escala_pedida,
		escala_efectiva: res.escala_efectiva,
		limite_escala: res.limite_escala,
		limites: {...LIMITES_ENCUADRE},
		recorte: res.recorte,
		recorte_almacenado: res.recorte_almacenado,
		centro_x: res.centro_x,
		centro_y: res.centro_y,
		acotado: res.acotado,
		identidad: res.identidad,
		original: {
			...(datos.video.ruta ? {ruta: datos.video.ruta} : {}),
			ancho: datos.video.ancho,
			alto: datos.video.alto,
			rotacion: datos.video.rotacion,
			ancho_visible: datos.video.ancho_visible,
			alto_visible: datos.video.alto_visible,
		},
		barbilla_antes: res.antes.barbilla_y,
		barbilla_despues: res.despues.barbilla_y,
		antes: res.antes,
		despues: res.despues,
		objetivo: res.objetivo,
		diferencia: res.diferencia,
		avisos: res.avisos,
		coordenadas:
			'recorte, recorte_almacenado y centro en px del original (recorte: cuadro visible ya rotado, que es lo que recorta ffmpeg; recorte_almacenado: cuadro guardado sin rotar); antes, despues, objetivo y barbilla_* en px de la base 1080×1920 (antes = base sin encuadre; despues = lo que se espera con este recorte, hay que medirlo con cara.ts)',
		fuente: datos.fuente,
	};
}
