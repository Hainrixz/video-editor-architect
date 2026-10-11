/**
 * Motion graphics FLOTANTES "libres" (rediseño del 2026-10-04 tras la revisión de un reel de referencia): en vez de una escena de
 * 810 × 980 con su fondo, cada pieza vive en coordenadas absolutas de la base 1080×1920, encima de tu toma
 * desenfocada y anclada a tu cabeza. Decisión del estilo: que el creador siga en cuadro, con lo que flota encima y el
 * video en blur, y que no sean muy simples ni solo grabación de pantalla.
 *
 * Rediseño 2 (críticas de la v14 flotante): NADA tapa tus ojos, nariz ni boca más de 0.5 s (solo los vuelos rápidos
 * cruzan), tu cabeza queda NÍTIDA (foco de retrato: solo tu cuarto se desenfoca) y lo que flota vive en los huecos de
 * tu cuadro: la franja de arriba de tu cabeza (y 220 → coronilla), tu pecho (barbilla → 1480) y detrás de tu cabeza
 * (oclusión con la elipse de cara.json). Texto legible: ≥ 28 px base en lo que importa.
 *
 * Rediseño 3 (segunda ronda de críticas): nada a media opacidad ni desenfocado sobre tu cara; lo que cruza tu cabeza va
 * DETRÁS de ella (oclusión) o no la cruza; la retícula de Apple solo destella; las cartas bajan por tu costado.
 *
 *  - prueba-corregida: corte seco del meme a la landing de IA (degradado morado) en una ventana YA arriba de tu cabeza,
 *    detrás de tu coronilla; la pluma roja la marca; en "habilidades" cuelgan dos ranuras con la forma exacta de las
 *    fichas; en "diseño" cae la ficha y la página buena se revela en círculo desde ella (misma ventana, mismo layout);
 *    en "animación" la página baja a la curva ease-out (640 px) y su bolita la recorre dejando estela.
 *  - plantilla-apple: esquinas de enfoque blancas se cierran sobre tu cara y se vuelven el contorno del ícono; la
 *    retícula interna destella ≤ 12 cuadros a ≤ 0.35; 3 reglas concretas (44 pt, 1024 px, 22.37 %) arriba de tu cabeza
 *    y en tu pecho; la cota arriba de tu pelo; sale escalonado (4 cuadros por ficha).
 *  - pantalla-a-objeto: la demo se recorta hacia arriba a la derecha y queda detrás de tu cabeza desde el cuadro 1; el
 *    comando baja a tu pecho en una ficha de terminal oscura; en "instalas" la tecla se hunde y de la pantalla salen las
 *    skills como cartas (la estrella al frente); poco antes de "Claude" crece la caja de la tarjeta desde su cursor y
 *    las cartas caen en ella por tu costado izquierdo.
 *
 * Todo lo que importa cae en una palabra: `golpes` trae los segundos ABSOLUTOS de la base (los saca el director de
 * transcripcion-base.json); aquí se pasan a cuadros desde que entra el insert. Sin golpes se usan los del diseño
 * (cuadros relativos medidos en el reel de referencia del diseño).
 *
 * Valores marcados [D]: decisión de diseño, NO medidos en tus reels.
 * Puro: sin React, sin Remotion y sin Node.
 */
import {z} from 'zod';
import type {PistaCabeza} from './anclaje';

const FPS = 30;

// ───────────────────────── piezas del contrato ─────────────────────────

/** Cómo se ve tu toma detrás (sobrescribe FLOTANTE en src/estilo/flotante.ts para este insert). */
export const FondoMotionEsquema = z.object({
	blur_px: z.number().min(0).max(30).optional(),
	oscurecer: z.number().min(0).max(0.6).optional(),
	escala: z.number().min(1).max(1.2).optional(),
});
export type FondoMotionProps = z.infer<typeof FondoMotionEsquema>;

/** Un sonido del motion en un golpe: segundo ABSOLUTO de la base (como `golpes`), relativo a public/. */
export const SfxMotionEsquema = z.object({
	asset: z.string().min(1),
	en: z.number().nonnegative(),
	ganancia_db: z.number().min(-40).max(0),
});
export type SfxMotion = z.infer<typeof SfxMotionEsquema>;

const seg = z.number().nonnegative();
const Rect = z.object({x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number()});

/**
 * Pista de tu cabeza cuadro por cuadro (src/estilo/anclaje.ts → pistaCabeza): la escribe el director desde cara.json.
 * Con ella el foco de retrato, la oclusión detrás de tu cabeza y la plantilla de Apple te siguen; sin ella todo usa una
 * cabeza fija (la de `ancla` o la mediana del diseño).
 */
export const PistaEsquema = z.object({
	inicio: z.number().int().min(-30).max(30),
	c: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])).min(1).max(1800),
});

export const MotionPruebaCorregida = z.object({
	nombre: z.literal('prueba-corregida'),
	/** Segundos absolutos de cada palabra que manda un golpe. */
	golpes: z.object({normal: seg, porque: seg, has: seg, claude: seg, habilidades: seg, diseno: seg, animacion: seg}).partial().optional(),
	/** Lo que dicen las dos pestañas (lo que le falta a Claude). */
	etiquetas: z.object({diseno: z.string().min(1).max(12), animacion: z.string().min(1).max(12)}).optional(),
	/** @deprecated Desde el rediseño 3 la ventana entra en su lugar (corte seco desde el meme); se acepta y se ignora. */
	origen: z.object({x: z.number(), y: z.number(), w: z.number().positive()}).nullable().optional(),
	pista: PistaEsquema.optional(),
	fondo: FondoMotionEsquema.optional(),
	sfx: z.array(SfxMotionEsquema).max(8).optional(),
});

export const MotionPlantillaApple = z.object({
	nombre: z.literal('plantilla-apple'),
	golpes: z.object({reglas: seg, diseno: seg, apple: seg, para: seg, eso: seg}).partial().optional(),
	/** Centro y lado de la plantilla (px base): la mediana de tu cara en el tramo (src/estilo/anclaje.ts). */
	ancla: z.object({x: z.number(), y: z.number(), lado: z.number().min(300).max(800)}).optional(),
	titulo: z.string().min(1).max(32).optional(),
	logo: z.string().min(1).nullable().optional(),
	/** Tres reglas concretas de la HIG (valor grande + qué es). */
	principios: z.array(z.object({titulo: z.string().min(1).max(14), nota: z.string().min(1).max(26)})).length(3).optional(),
	pista: PistaEsquema.optional(),
	/** Etiqueta de la esquina continua y número de las cotas. */
	esquina: z.string().min(1).max(20).optional(),
	medida: z.string().min(1).max(6).optional(),
	fondo: FondoMotionEsquema.optional(),
	sfx: z.array(SfxMotionEsquema).max(8).optional(),
});

/** El último cuadro de una demo de pantalla (lo dibuja DemoPantalla congelado en `cuadro` desde que entró la demo). */
export const DemoCongelada = z.object({
	asset: z.string().min(1),
	eventos: z.string().min(1).nullable(),
	trim_desde: z.number().nonnegative(),
	cuadro: z.number().int().nonnegative(),
	encuadre: z.enum(['horizontal', 'vertical']).optional(),
});

export const MotionPantallaAObjeto = z.object({
	nombre: z.literal('pantalla-a-objeto'),
	golpes: z.object({instalas: seg, y: seg, literalmente: seg, vas: seg, claude: seg}).partial().optional(),
	/** La demo a pantalla completa que viene justo antes (null = una pantalla oscura genérica con el comando). */
	demo: DemoCongelada.nullable().optional(),
	comando: z.string().min(1).max(48).optional(),
	skills: z.array(z.string().min(1).max(30)).min(1).max(8).optional(),
	/** Dónde está el texto del comando en ese cuadro de la demo (px base, pantalla completa). */
	comando_en_demo: Rect.optional(),
	/** Dónde arranca el texto de la tarjeta que sigue (px base): ahí aterriza el cursor. */
	cursor: z.object({x: z.number(), y: z.number(), alto: z.number().positive().max(80)}).optional(),
	/** Caja de la tarjeta que sigue en su primer cuadro (px base): de ahí crece la caja blanca desde el cursor. */
	tarjeta: Rect.optional(),
	pista: PistaEsquema.optional(),
	fondo: FondoMotionEsquema.optional(),
	sfx: z.array(SfxMotionEsquema).max(8).optional(),
});

export const NOMBRES_LIBRES = ['prueba-corregida', 'plantilla-apple', 'pantalla-a-objeto'] as const;
export type NombreLibre = (typeof NOMBRES_LIBRES)[number];
export const esLibre = (nombre: string): nombre is NombreLibre => (NOMBRES_LIBRES as readonly string[]).includes(nombre);

// ───────────────────────── valores por defecto ─────────────────────────

/** Golpes del diseño en cuadros desde que entra el insert (reel de referencia del diseño, transcripcion-base.json). */
export const GOLPES_DISENO = {
	'prueba-corregida': {normal: 8, porque: 18, has: 29, claude: 41, habilidades: 60, diseno: 77, animacion: 103},
	'plantilla-apple': {reglas: 0, diseno: 15, apple: 35, para: 51, eso: 77},
	'pantalla-a-objeto': {instalas: 9, y: 27, literalmente: 36, vas: 60, claude: 78},
} as const;

/**
 * Fondo de cada uno [D]. Con la pista, tu cabeza queda NÍTIDA (foco de retrato) y solo se desenfoca tu cuarto, así que
 * el desenfoque es moderado (6–7 px: con 10–14 tus manos borrosas delante de tu cara nítida delataban la máscara); el
 * push-in es leve (3 %).
 */
export const FONDO_DISENO = {
	'prueba-corregida': {blur_px: 7, oscurecer: 0.2, escala: 1.03},
	'plantilla-apple': {blur_px: 6, oscurecer: 0.22, escala: 1.03},
	'pantalla-a-objeto': {blur_px: 7, oscurecer: 0.18, escala: 1.03},
} as const;

/** Texto del comando en el último cuadro de la demo de ejemplo (toma.mp4 a pantalla completa) [D si no viene en la EDL]. */
export const COMANDO_EN_DEMO_EJEMPLO = {x0: 138, y0: 1052, x1: 942, y1: 1102} as const;
/** Arranque del texto de una tarjeta prompt de ejemplo (un renglón, centro y ≈ 1283). */
export const CURSOR_PROMPT_EJEMPLO = {x: 152, y: 1284, alto: 44} as const;
/** Caja de una tarjeta prompt de ejemplo en su primer cuadro (un renglón). */
export const TARJETA_PROMPT_EJEMPLO = {x0: 135, y0: 1248, x1: 945, y1: 1318} as const;
/** Centro y lado de la plantilla si no viene `ancla`: la cara mediana del reel de referencia del diseño (cara.json). */
export const ANCLA_DISENO = {x: 537, y: 987, lado: 636} as const;

// ───────────────────────── resolver ─────────────────────────

type Golpes<N extends NombreLibre> = {[K in keyof (typeof GOLPES_DISENO)[N]]: number};
type FondoResuelto = {blur_px: number; oscurecer: number; escala: number};
export type SfxResuelto = {asset: string; cuadro: number; ganancia_db: number};

export type PruebaResuelto = {nombre: 'prueba-corregida'; golpes: Golpes<'prueba-corregida'>; etiquetas: {diseno: string; animacion: string}; origen: {x: number; y: number; w: number} | null; pista: PistaCabeza | null; fondo: FondoResuelto; sfx: SfxResuelto[]};
export type PlantillaResuelto = {
	nombre: 'plantilla-apple';
	golpes: Golpes<'plantilla-apple'>;
	ancla: {x: number; y: number; lado: number};
	titulo: string;
	logo: string | null;
	principios: Array<{titulo: string; nota: string}>;
	esquina: string;
	medida: string;
	pista: PistaCabeza | null;
	fondo: FondoResuelto;
	sfx: SfxResuelto[];
};
export type PantallaResuelto = {
	nombre: 'pantalla-a-objeto';
	golpes: Golpes<'pantalla-a-objeto'>;
	demo: z.infer<typeof DemoCongelada> | null;
	comando: string;
	skills: string[];
	comando_en_demo: {x0: number; y0: number; x1: number; y1: number};
	cursor: {x: number; y: number; alto: number};
	tarjeta: {x0: number; y0: number; x1: number; y1: number};
	pista: PistaCabeza | null;
	fondo: FondoResuelto;
	sfx: SfxResuelto[];
};
export type LibreResuelto = PruebaResuelto | PlantillaResuelto | PantallaResuelto;

/**
 * Golpes absolutos (s) → cuadros desde que entra el insert. Sin `desde` (o sin el golpe) usa el del diseño. Un golpe
 * que cae antes del insert se queda en 0.
 */
export function golpesRelativos<N extends NombreLibre>(nombre: N, golpes: Partial<Record<string, number>> | undefined, desde: number | undefined): Golpes<N> {
	const base = GOLPES_DISENO[nombre] as Record<string, number>;
	const out: Record<string, number> = {};
	for (const k of Object.keys(base)) {
		const abs = golpes?.[k];
		out[k] = abs !== undefined && desde !== undefined ? Math.max(0, Math.round(abs * FPS) - Math.round(desde * FPS)) : base[k];
	}
	return out as Golpes<N>;
}

const sfxRelativos = (sfx: SfxMotion[] | undefined, desde: number | undefined): SfxResuelto[] =>
	(sfx ?? []).map((s) => ({asset: s.asset, ganancia_db: s.ganancia_db, cuadro: desde === undefined ? 0 : Math.max(0, Math.round(s.en * FPS) - Math.round(desde * FPS))}));

const fondoDe = (nombre: NombreLibre, f: FondoMotionProps | undefined): FondoResuelto => ({...FONDO_DISENO[nombre], ...(f ?? {})});

/**
 * Reglas concretas de la HIG (no valores abstractos): 44 pt de área táctil mínima (HIG → Accessibility / Buttons),
 * lienzo de ícono de 1024 px (HIG → App icons) y el radio de esquina de ~22.37 % del lado que se suele medir en los
 * íconos de iOS (medida de la comunidad, no publicada por Apple) [D].
 */
export const PRINCIPIOS_PLANTILLA = [
	{titulo: '44 pt', nota: 'mínimo para tocar'},
	{titulo: '1024 px', nota: 'lienzo del ícono'},
	{titulo: '22.37 %', nota: 'radio de la esquina'},
] as const;

export function resolverLibre(
	m: z.infer<typeof MotionPruebaCorregida> | z.infer<typeof MotionPlantillaApple> | z.infer<typeof MotionPantallaAObjeto>,
	desde: number | undefined,
	defaults: {logoApple: string; comando: string; skills: readonly string[]},
): LibreResuelto {
	switch (m.nombre) {
		case 'prueba-corregida':
			return {
				nombre: m.nombre,
				golpes: golpesRelativos('prueba-corregida', m.golpes, desde),
				etiquetas: m.etiquetas ?? {diseno: 'DISEÑO', animacion: 'ANIMACIÓN'},
				origen: m.origen === undefined ? {x: 540, y: 940, w: 800} : m.origen,
				pista: m.pista ?? null,
				fondo: fondoDe(m.nombre, m.fondo),
				sfx: sfxRelativos(m.sfx, desde),
			};
		case 'plantilla-apple':
			return {
				nombre: m.nombre,
				golpes: golpesRelativos('plantilla-apple', m.golpes, desde),
				ancla: m.ancla ?? {...ANCLA_DISENO},
				titulo: m.titulo ?? 'Human Interface Guidelines',
				logo: m.logo === undefined ? defaults.logoApple : m.logo,
				principios: (m.principios ?? PRINCIPIOS_PLANTILLA).map((p) => ({...p})),
				esquina: m.esquina ?? 'esquina continua',
				medida: m.medida ?? '1024',
				pista: m.pista ?? null,
				fondo: fondoDe(m.nombre, m.fondo),
				sfx: sfxRelativos(m.sfx, desde),
			};
		case 'pantalla-a-objeto':
			return {
				nombre: m.nombre,
				golpes: golpesRelativos('pantalla-a-objeto', m.golpes, desde),
				demo: m.demo ?? null,
				comando: m.comando ?? defaults.comando,
				skills: [...(m.skills ?? defaults.skills)],
				comando_en_demo: m.comando_en_demo ?? {...COMANDO_EN_DEMO_EJEMPLO},
				cursor: m.cursor ?? {...CURSOR_PROMPT_EJEMPLO},
				tarjeta: m.tarjeta ?? {...TARJETA_PROMPT_EJEMPLO},
				pista: m.pista ?? null,
				fondo: fondoDe(m.nombre, m.fondo),
				sfx: sfxRelativos(m.sfx, desde),
			};
	}
}

// ───────────────────────── líneas de tiempo (cuadros desde que entra) ─────────────────────────

/** Tu cuarto empieza a desenfocarse `ANTES_LIBRE` cuadros antes de que entre el motion (rack focus, no salto). */
export const ANTES_LIBRE = 3;
/** Rampa de entrada del fondo (ease-out fuerte): de nítido a su máximo en 10 cuadros. */
export const ENTRADA_FONDO_LIBRE = 10;
/** Los últimos `FOCO_SALIDA` cuadros solo se enfoca tu cuarto: ya no queda nada encima de ti. */
export const FOCO_SALIDA = 9;
/** Cuadros de la salida de las piezas (ease-in-out, suben 80 px con desenfoque), justo antes del foco. */
export const SALIDA_LIBRE = 6;
/** Cuadro en que empiezan a salir las piezas: terminan cuando arranca el foco. */
export const salidaPiezas = (dur: number): number => dur - FOCO_SALIDA - SALIDA_LIBRE;

/** Stagger que se acorta (3, 2, 2, 1…) en vez de uniforme: lo primero se nota, lo último ya va de corrido. */
export function staggerDecreciente(inicio: number, n: number, pasos: readonly number[] = [3, 2, 2, 1, 1]): number[] {
	const out: number[] = [];
	let t = inicio;
	for (let i = 0; i < n; i++) {
		out.push(t);
		t += pasos[Math.min(i, pasos.length - 1)];
	}
	return out;
}

export type LineaPrueba = {
	vuelo: number;
	ovalo: number;
	tachon: number;
	equis: number;
	huecos: number;
	diseno: number;
	piezas: number[];
	animacion: number;
	zoom: number;
	curva: number;
	bolita: number;
	salida: number;
	minimo: number;
};

/**
 * Entrada de la ventana (rediseño 3): corte seco desde el meme a la ventana YA arriba de tu cabeza, con su entrada corta
 * propia (sube 40 px, aparece y se enfoca de 6 px a 0 en 6 cuadros, ease-out). Antes volaba desde el lugar del meme y
 * cruzaba tus ojos con desenfoque de movimiento.
 */
export const ENTRADA_VENTANA = 6;
/** @deprecated nombre viejo de ENTRADA_VENTANA. */
export const VUELO_VENTANA = ENTRADA_VENTANA;
/** Periodo (cuadros) de la bolita que recorre la curva en loop. */
export const PERIODO_BOLITA = 20;

export function lineaPrueba(r: PruebaResuelto, dur: number): LineaPrueba {
	const g = r.golpes;
	const ovalo = Math.max(g.normal, ENTRADA_VENTANA + 1);
	const tachon = Math.max(g.porque, ovalo + 6);
	const equis = Math.max(g.has, tachon + 5);
	return {
		vuelo: 0,
		ovalo,
		tachon,
		equis,
		huecos: g.habilidades,
		diseno: g.diseno,
		piezas: staggerDecreciente(g.diseno + 3, 4, [3, 2, 2]),
		animacion: g.animacion,
		zoom: g.animacion + 3, // la página baja (scroll) a la sección de la curva
		curva: g.animacion + 7,
		bolita: g.animacion + 13,
		salida: Math.max(g.animacion + 18, salidaPiezas(dur)),
		minimo: g.animacion + 20 + SALIDA_LIBRE + FOCO_SALIDA,
	};
}

export type LineaPlantilla = {foco: number; pulsos: number; blanco: number; lineas: number[]; reticulaFuera: number; cotas: [number, number]; esquinas: number; titulo: number; fichas: [number, number, number]; salidaFichas: [number, number, number]; salidaReticula: number; salida: number; minimo: number};

/**
 * La retícula INTERNA de la plantilla (diagonales, ejes, círculos, rectángulos guía) cruza tus ojos, nariz y boca: se
 * dibuja de golpe (stagger de 1), a lo mucho a 0.35 de opacidad, y se va antes de RETICULA_MAX cuadros desde "diseño".
 * Lo que se queda es la superelipse de afuera (no te cruza la cara) [D].
 */
export const RETICULA_MAX = 12;
export const RETICULA_OPACIDAD = 0.35;
/** Cuadros de la salida de cada ficha de la plantilla (sin quedarse a opacidad intermedia). */
export const SALIDA_FICHA = 4;

/** Lectura mínima de las fichas ya asentadas antes de que salgan (cuadros). */
export const LECTURA_FICHAS = 8;

export function lineaPlantilla(r: PlantillaResuelto, dur: number): LineaPlantilla {
	const g = r.golpes;
	const fichas: [number, number, number] = [g.para, g.para + 2, g.para + 4];
	// Salida escalonada: fichas (stagger 2) → retícula (dashoffset en reversa, 6) → foco de tu cuarto (9).
	const salidaReticula = Math.max(fichas[2] + 10 + LECTURA_FICHAS + 6, dur - FOCO_SALIDA - 6);
	const s0 = salidaReticula - 6; // fichas a 0, 2 y 4; la retícula arranca cuando la última ya va de salida
	return {
		foco: g.reglas,
		pulsos: g.reglas + 9,
		blanco: g.diseno,
		lineas: staggerDecreciente(g.diseno, 6, [1, 1, 1, 1, 1]),
		reticulaFuera: g.diseno + RETICULA_MAX - 4,
		cotas: [g.diseno + 7, g.diseno + 10],
		esquinas: g.apple,
		titulo: g.apple + 2,
		fichas,
		salidaFichas: [s0, s0 + 2, s0 + 4],
		salidaReticula,
		salida: salidaReticula + 6,
		minimo: fichas[2] + 10 + LECTURA_FICHAS + 6 + 6 + FOCO_SALIDA,
	};
}

export type LineaPantalla = {
	aleja: number;
	retira: number;
	despega: number;
	tecla: number;
	hunde: number;
	rompe: number;
	vuelan: number[];
	respira: number;
	caja: number;
	cursor: number;
	convergen: number[];
	pulso: number;
	salida: number;
	minimo: number;
};

/** Cuadros de la caída de cada skill a la caja de la tarjeta (ease-in: aceleran hacia ella). */
export const CUADROS_CONVERGEN = 6;
/** Cuadros en que la caja de la tarjeta crece desde el cursor (de izquierda a derecha, ease-out). */
export const CUADROS_CAJA = 7;
/** La caja ya está completa (con su cursor) estos cuadros antes de que caiga la primera skill. */
export const CAJA_ANTES = 3;

/**
 * Rediseño 3: la pantalla se recorta hacia arriba a la derecha y queda detrás de tu cabeza; en "instalas" la tecla se
 * hunde y de la pantalla salen las skills como cartas que se reparten (arriba de tu cabeza); la pantalla se retira; en
 * "literalmente" las cartas laten; la caja de la tarjeta crece desde el cursor poco antes de "Claude" y las cartas caen
 * en ella por tu costado izquierdo (nunca por tu cara), la última justo antes de que la tarjeta empiece a escribir.
 */
export function lineaPantalla(r: PantallaResuelto, dur: number): LineaPantalla {
	const g = r.golpes;
	const n = skillsVisibles(r.skills).length;
	const vuelan = staggerDecreciente(g.instalas + 2, n, [3, 2, 2]);
	// Caen en "Claude", pero la última aterriza a lo mucho 2 cuadros antes del relevo (la tarjeta escribe enseguida).
	const c0 = Math.max(g.vas + CUADROS_CAJA + CAJA_ANTES, Math.min(Math.max(g.claude, dur - 2 - CUADROS_CONVERGEN - (n - 1)), dur - CUADROS_CONVERGEN - n));
	const convergen = Array.from({length: n}, (_, i) => c0 + i);
	const pulso = (convergen[n - 1] ?? c0) + CUADROS_CONVERGEN;
	const caja = c0 - CAJA_ANTES - CUADROS_CAJA;
	return {
		aleja: 0,
		retira: (vuelan[n - 1] ?? vuelan[0]) + 5,
		despega: 1,
		tecla: 3,
		hunde: g.instalas,
		rompe: g.instalas + 3,
		vuelan,
		respira: g.literalmente,
		caja,
		cursor: caja,
		convergen,
		pulso,
		salida: dur,
		minimo: c0 + CUADROS_CONVERGEN + n + 2,
	};
}

/** Parpadeo del cursor: prendido, apagado, prendido, apagado (cuadros) y así; prendido mientras caen las skills. */
export const PARPADEO_CURSOR = [8, 6] as const;

/** ¿Se ve el cursor `k` cuadros después de aparecer? (parpadeo de 14 cuadros, como un caret real). */
export function cursorVisible(k: number): boolean {
	if (k < 0) return false;
	const ciclo = PARPADEO_CURSOR[0] + PARPADEO_CURSOR[1];
	return k % ciclo < PARPADEO_CURSOR[0];
}

/** Cuadros mínimos de cada uno (con los golpes que traiga). */
export function minimoLibre(r: LibreResuelto): number {
	if (r.nombre === 'prueba-corregida') return lineaPrueba(r, 0).minimo;
	if (r.nombre === 'plantilla-apple') return lineaPlantilla(r, 0).minimo;
	return lineaPantalla(r, 0).minimo;
}

// ───────────────────────── geometría ─────────────────────────

/** Caja donde vive lo legible de un motion libre (px base): la zona cian sin la franja de subtítulos ni el pecho bajo. */
export const CAJA_LIBRE = {x0: 135, y0: 220, x1: 945, y1: 1480} as const;

/** Las skills que se ven (3) y un "+N" con las demás: a 28 px se leen; 7 fichas de 12 px eran ruido. */
export function skillsVisibles(skills: readonly string[], max = 3): string[] {
	const v = skills.slice(0, max);
	return skills.length > max ? [...v, `+${skills.length - max}`] : v;
}

export type FichaSkill = {texto: string; cx: number; cy: number; w: number; h: number; letra: number; escala: number; blur: number; rot: number; estrella: boolean; mas: boolean; rotulo: string | null};

/**
 * Cartas de skill [D] (rediseño 3: ya no son pastillas beige con punto verde): oscuras como la terminal de donde
 * salen, mono claro. La estrella (la primera) va al frente, más grande (40 px, con rótulo "skill" de 24 px), nítida y
 * derecha; las demás detrás, a 0.88 (32 px → 28 efectivos), con desenfoque de profundidad y un giro leve.
 */
export const FICHA_SKILL = {estrella: 40, letra: 32, rotulo: 24, ancho_car: 0.6, pad: 22, pad_v: 16} as const;

export const anchoFicha = (texto: string, letra: number = FICHA_SKILL.letra): number => Math.round(texto.length * letra * FICHA_SKILL.ancho_car + 2 * FICHA_SKILL.pad);

/**
 * Lugar de cada carta arriba de tu cabeza (y 250–475; en el reel de referencia la coronilla nunca sube de ~509): la estrella al
 * frente a la izquierda, la segunda abajo a la izquierda, la tercera a la derecha y el "+N" como la última de la fila de
 * abajo.
 */
export function lugaresSkills(skills: readonly string[]): FichaSkill[] {
	const v = skillsVisibles(skills);
	const lugares = [
		{cx: 410, cy: 300, escala: 1, blur: 0, rot: 0},
		{cx: 292, cy: 424, escala: 0.88, blur: 1, rot: -1.5},
		{cx: 784, cy: 318, escala: 0.88, blur: 1.2, rot: 1.5},
		{cx: 0, cy: 424, escala: 0.88, blur: 0.8, rot: 1},
	];
	const out: FichaSkill[] = [];
	v.forEach((texto, i) => {
		const mas = texto.startsWith('+');
		const estrella = i === 0;
		const letra = estrella ? FICHA_SKILL.estrella : FICHA_SKILL.letra;
		const w = anchoFicha(texto, letra);
		const h = Math.round(letra * 1.25 + 2 * FICHA_SKILL.pad_v + (estrella ? FICHA_SKILL.rotulo * 1.2 + 4 : 0));
		const l = lugares[mas ? 3 : Math.min(i, 2)];
		let cx = l.cx;
		// El "+N" va pegado a la derecha de la segunda carta (la última de la fila de abajo).
		if (mas) {
			const seg = out[1];
			cx = seg ? seg.cx + (seg.w * seg.escala) / 2 + 14 + (w * l.escala) / 2 : 420;
		}
		cx = Math.min(945 - (w * l.escala) / 2, Math.max(135 + (w * l.escala) / 2, cx));
		out.push({texto, cx, cy: l.cy, w, h, letra, escala: l.escala, blur: l.blur, rot: l.rot, estrella, mas, rotulo: estrella ? 'skill' : null});
	});
	return out;
}

/**
 * Ficha del comando y tecla return (px base) [D]: en tu pecho, entre tu barbilla (la más baja del reel de referencia en ese
 * tramo: 1345) y los subtítulos (centro y 1545: ~160 px entre centros); mono 26 px claro sobre fondo de terminal oscuro (contrasta
 * con tu camiseta blanca).
 */
export function piezasComando(comando: string): {ficha: {x0: number; y0: number; x1: number; y1: number; letra: number}; tecla: {x0: number; y0: number; x1: number; y1: number}} {
	const letra = 26;
	const w = Math.round(comando.length * letra * 0.6 + 2 * 22);
	const x0 = Math.max(135, Math.min(150, 945 - 110 - 10 - w));
	const tx0 = Math.min(945 - 104, x0 + w + 10);
	return {ficha: {x0, y0: 1356, x1: x0 + w, y1: 1414, letra}, tecla: {x0: tx0, y0: 1349, x1: tx0 + 104, y1: 1421}};
}
