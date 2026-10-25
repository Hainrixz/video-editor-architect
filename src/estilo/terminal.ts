// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Terminal animada (Fase 7): guion, línea de tiempo y estado por cuadro.
 *
 * Este archivo es PURO: sin React, sin Remotion y sin Node. Lo usan src/reel/TerminalAnimada.tsx (en el navegador)
 * y las pruebas (pruebas/unit/terminal.test.ts), así lo que se prueba es exactamente lo que se dibuja.
 *
 * Idea:
 *   1. El guion ([{tipo:"comando"|"salida"|"espera"}]) se convierte UNA vez en una línea de tiempo
 *      (`crearLineaDeTiempo`): cuándo aparece cada tecla, cada línea de salida y cada prompt.
 *   2. `estadoEn(lt, t)` dice qué se ve en el segundo t (t = cuadro / fps): filas con sus celdas, cajas
 *      (modo claude-code), el cursor y cuánto se desplazó el contenido.
 *
 * Unidades: tiempo en segundos; filas y columnas de la rejilla de la terminal (el componente las pasa a px).
 * Cada carácter ocupa 1 celda (2 si es ancho: CJK y emoji). JetBrains Mono mide 600/1000 em en todos sus
 * glifos de ancho 1, así que una columna mide 0.6 × tamaño de letra.
 *
 * Variaciones "humanas" (ritmo de tecleo, ritmo de las líneas) salen de un hash con semilla: el mismo guion con
 * la misma semilla da exactamente los mismos cuadros en cada render.
 *
 * Modo "claude-code": imita el aspecto de la interfaz de texto de Claude Code (encabezado naranja #D97757,
 * recuadro de entrada, "● " en las respuestas, indicador "Pensando…"). Todo está dibujado con texto y
 * rectángulos propios: sin logos ni código de terceros.
 */
import {z} from 'zod';

// ───────────────────────────── colores ─────────────────────────────

/** Colores con nombre que acepta el guion en `color` (también se vale "#RRGGBB"). */
export const COLORES = {
	texto: '#E9E9EE',
	tenue: '#8D8D99',
	verde: '#5BD67D',
	rojo: '#FF6B6B',
	amarillo: '#F4C552',
	azul: '#6CB6FF',
	cian: '#5ED3E6',
	magenta: '#D58CF6',
	naranja: '#D97757',
	blanco: '#FFFFFF',
} as const;

export type NombreColor = keyof typeof COLORES;
const NOMBRES = ['texto', 'tenue', 'verde', 'rojo', 'amarillo', 'azul', 'cian', 'magenta', 'naranja', 'blanco'] as const;
export const NOMBRES_COLOR: readonly NombreColor[] = NOMBRES;

/** Colores de la ventana (no se usan en el guion). Look macOS oscuro. */
export const VENTANA = {
	fondo: '#16161A',
	fondoAbajo: '#111114',
	barra: '#2B2B31',
	barraAbajo: '#242429',
	lineaBarra: '#0B0B0D',
	brillo: 'rgba(255,255,255,0.08)',
	titulo: '#A4A4AF',
	cursor: '#E9E9EE',
	bordeCaja: '#5D5D69',
	naranjaClaro: '#F6C3AE',
	semaforo: [
		{relleno: '#FF5F57', borde: '#E14942'},
		{relleno: '#FEBC2E', borde: '#DFA123'},
		{relleno: '#28C840', borde: '#1DAD2B'},
	],
	/** Radio de las esquinas de la ventana (px base). */
	radio: 14,
} as const;

/** Nombre del guion o "#RRGGBB" → "#RRGGBB". */
export function resolverColor(color: string | undefined, porDefecto: string): string {
	if (!color) return porDefecto;
	if ((NOMBRES as readonly string[]).includes(color)) return COLORES[color as NombreColor];
	return color.toUpperCase();
}

/** Mezcla dos colores "#RRGGBB" (w = 0 → a, w = 1 → b). */
export function mezclarColor(a: string, b: string, w: number): string {
	const p = Math.min(1, Math.max(0, w));
	const ca = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
	const cb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
	return `#${ca.map((v, i) => Math.round(v + (cb[i] - v) * p).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// ───────────────────────────── fuente ─────────────────────────────

/**
 * JetBrains Mono (OFL-1.1), de github.com/google/fonts (commit fijo). Los .ttf son instancias estáticas hechas con
 * fonttools (`sh biblioteca/fuentes/jetbrains-mono/preparar.sh`); no se versionan, pero su sha256 sí.
 * Licencia y origen: biblioteca/licencias/terminal.md.
 */
export const FUENTE_TERMINAL = {
	nombre: 'JetBrains Mono',
	/** Nombre propio en el navegador, para no chocar con una JetBrains Mono instalada en la Mac. */
	familiaCss: 'Editor Terminal Mono',
	licencia: 'OFL-1.1',
	origen:
		'https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
	archivos: {
		400: {
			ruta: 'biblioteca/fuentes/jetbrains-mono/JetBrainsMono-Regular.ttf',
			sha256: 'dd5e2d9fd69a610770d9e2d226ac32cd95f6cff4c2a7e1323d0e111c0f07cc55',
		},
		500: {
			ruta: 'biblioteca/fuentes/jetbrains-mono/JetBrainsMono-Medium.ttf',
			sha256: 'a06024eaeffed21fc2387ac726de4abd9caa21c08a6d1394471658b4e16e3d5f',
		},
		700: {
			ruta: 'biblioteca/fuentes/jetbrains-mono/JetBrainsMono-Bold.ttf',
			sha256: '18769effdd12fe681a8f1c3b4be6e6254bee54998fbc0d6cbde26bb13d7f84ce',
		},
	},
	/** Peso del texto normal: Medium aguanta mejor la compresión del reel que Regular. */
	pesoNormal: 500,
	pesoNegrita: 700,
	/** Avance de una celda como fracción del em (600/1000). */
	avance: 0.6,
	/** hhea/OS2 (typo, con USE_TYPO_METRICS): 1020 y 300 de 1000. */
	ascenso: 1.02,
	descenso: 0.3,
	altoX: 0.55,
	altoMayuscula: 0.73,
} as const;

/**
 * Puntos de código con glifo en JetBrains Mono (los mismos en 400, 500 y 700), en hexadecimal y por rangos.
 * Lo genera y lo verifica pruebas/unit/terminal.test.ts contra el archivo real.
 */
export const COBERTURA_FUENTE =
	'd,20-7e,a0-131,134-17f,18f,192,1a0-1a1,1af-1b0,1cd-1ce,1e6-1e7,1ea-1eb,1f4-1f5,1fc-1ff,218-21b,232-233,237,259,2b9-2ba,' +
	'2bc,2c6-2c7,2c9,2d8-2dd,2f3,2f7,300-304,306-30c,30f,312,31b,323,325-328,336,338,374-375,37e,384-38a,38c,38e-3a1,3a3-3cf,' +
	'3d7,401-40c,40e-44f,451-45c,45e-45f,490-491,4ae-4af,4e8-4e9,1e80-1e85,1e9e,1ea0-1ef9,2010,2013-2014,2018-201a,201c-201e,' +
	'2020-2022,2024,2026,2030,2032-2033,2039-203a,2044,2070,2074-207a,2080-2089,20ab-20ac,20ae,20bd,20bf,2113,2115-2116,2122,' +
	'212e,2190-2199,21e7,2200,2202-2203,2208-2209,220b-220c,220f-2212,2215,2218-221a,221e,2223,2225,2227-2228,222b,2237,223c,' +
	'2248-2249,2260-2261,2264-2265,2282-2287,2302-2305,2318,2325,2374,23fb-23fe,2500-25a1,25aa-25ab,25b2-25c7,25ca,25cc,' +
	'25ce-25cf,25d4-25d5,25e7-25eb,25ef,26a0-26a1,2715,276e-2771,27e8-27e9,27f5-27f7,2b58,e0a0-e0a2,e0b0-e0b3,feff,ffff';

const RANGOS_COBERTURA: ReadonlyArray<readonly [number, number]> = COBERTURA_FUENTE.split(',').map((r) => {
	const [a, b] = r.split('-');
	return [parseInt(a, 16), parseInt(b ?? a, 16)] as const;
});

/** ¿JetBrains Mono tiene glifo para este punto de código? */
export function tieneGlifo(cp: number): boolean {
	let bajo = 0;
	let alto = RANGOS_COBERTURA.length - 1;
	while (bajo <= alto) {
		const medio = (bajo + alto) >> 1;
		const [a, b] = RANGOS_COBERTURA[medio];
		if (cp < a) alto = medio - 1;
		else if (cp > b) bajo = medio + 1;
		else return true;
	}
	return false;
}

/**
 * Glifos que la fuente no trae y que el componente dibuja con SVG propio (en su celda, del color de la celda):
 * el conector de salida de herramienta, palomitas y tachas, y los asteriscos del indicador "Pensando…".
 */
export const GLIFOS_DIBUJADOS: ReadonlySet<string> = new Set(['⎿', '✓', '✔', '✗', '✘', '✢', '✳', '✶', '✻', '✽']);

/** Cuadros del indicador "Pensando…" (ida y vuelta), uno cada `SEGUNDOS_GIRO`. */
export const GIRO_PENSANDO = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'] as const;
export const SEGUNDOS_GIRO = 0.12;

// ───────────────────────────── guion (contrato) ─────────────────────────────

const sinControl = (s: string): boolean => !/[\u0000-\u001F\u007F]/.test(s);
const MENSAJE_CONTROL = 'no puede traer saltos de línea ni tabuladores (usa una línea por elemento y espacios)';

const ColorGuion = z.union([
	z.enum(NOMBRES),
	z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'el color va como nombre (texto, tenue, verde, rojo, amarillo, azul, cian, magenta, naranja, blanco) o #RRGGBB'),
]);

/** Pedazo de una línea con su propio color o negrita. */
export const SegmentoEsquema = z.strictObject({
	texto: z.string().max(500).refine(sinControl, MENSAJE_CONTROL),
	color: ColorGuion.optional(),
	negrita: z.boolean().optional(),
});

/** Una línea de salida: texto simple, un segmento o varios segmentos seguidos. "" = línea en blanco. */
export const LineaSalidaEsquema = z.union([
	z.string().max(500).refine(sinControl, MENSAJE_CONTROL),
	SegmentoEsquema,
	z.array(SegmentoEsquema).min(1).max(20),
]);

export const PasoComandoEsquema = z.strictObject({
	tipo: z.literal('comando'),
	texto: z.string().min(1).max(500).refine(sinControl, MENSAJE_CONTROL),
	/** Caracteres por segundo. Sin él: entre 25 y 40 (≈31 de promedio), con variaciones deterministas. */
	velocidad: z.number().min(5).max(200).optional(),
});

export const PasoSalidaEsquema = z.strictObject({
	tipo: z.literal('salida'),
	lineas: z.array(LineaSalidaEsquema).min(1).max(400),
	/** Color de todas sus líneas (lo de cada segmento manda). */
	color: ColorGuion.optional(),
	/** Segundos entre líneas (promedio; cada línea varía ±25 %). */
	ritmo: z.number().min(0).max(5).optional(),
});

export const PasoEsperaEsquema = z.strictObject({
	tipo: z.literal('espera'),
	s: z.number().positive().max(60),
});

export const PasoEsquema = z.discriminatedUnion('tipo', [PasoComandoEsquema, PasoSalidaEsquema, PasoEsperaEsquema]);
export const GuionEsquema = z.array(PasoEsquema).min(1).max(300);

export type Segmento = z.infer<typeof SegmentoEsquema>;
export type LineaSalida = z.infer<typeof LineaSalidaEsquema>;
export type Paso = z.infer<typeof PasoEsquema>;
export type Guion = z.infer<typeof GuionEsquema>;

export type ModoTerminal = 'terminal' | 'claude-code';

/** Textos fijos de la interfaz (modo claude-code). */
export type TextosTerminal = {pensando: string; interrumpir: string | null; pista: string | null};
export const TEXTOS_POR_DEFECTO: Readonly<TextosTerminal> = {
	pensando: 'Pensando…',
	interrumpir: '(esc para interrumpir)',
	pista: '? para atajos',
};

/**
 * Archivo de demo de terminal (p. ej. demos/<slug>/terminal.json): lo que un insert puede apuntar en `asset`
 * para que src/reel/TerminalAnimada.tsx (TerminalDesdeArchivo) lo dibuje.
 */
export const DemoTerminalEsquema = z.strictObject({
	version: z.literal(1),
	modo: z.enum(['terminal', 'claude-code']).default('terminal'),
	/** Texto de la barra de la ventana. */
	titulo: z.string().min(1).max(80).optional(),
	/** Carpeta que se muestra antes del "❯" (modo terminal) o en el encabezado (modo claude-code). */
	directorio: z.string().min(1).max(60).nullable().optional(),
	encabezado: z
		.strictObject({titulo: z.string().min(1).max(40).optional(), subtitulo: z.string().max(80).nullable().optional()})
		.optional(),
	textos: z
		.strictObject({
			pensando: z.string().min(1).max(30).optional(),
			interrumpir: z.string().max(40).nullable().optional(),
			pista: z.string().max(40).nullable().optional(),
		})
		.optional(),
	/** Pausas en segundos (lo que falte sale de PAUSAS_POR_DEFECTO del modo). */
	pausas: z
		.strictObject({
			antesDeEscribir: z.number().min(0).max(10).optional(),
			antesDeEnter: z.number().min(0).max(10).optional(),
			despuesDeEnter: z.number().min(0).max(10).optional(),
			promptTrasEnter: z.number().min(0).max(10).optional(),
			pensando: z.number().min(0).max(30).optional(),
			ritmoSalida: z.number().min(0).max(5).optional(),
			cola: z.number().min(0).max(10).optional(),
		})
		.optional(),
	tamano_letra: z.number().min(18).max(64).optional(),
	semilla: z.number().int().min(0).max(2147483647).optional(),
	/** Segundos entre que entra la ventana y arranca el guion. */
	retraso_s: z.number().min(0).max(5).optional(),
	guion: GuionEsquema,
});
export type DemoTerminal = z.infer<typeof DemoTerminalEsquema>;

type IssueZod = {code: string; path: PropertyKey[]; message: string; [k: string]: unknown};

const NOMBRE_TIPO: Record<string, string> = {string: 'texto', number: 'un número', boolean: 'true o false', array: 'una lista', object: 'un objeto'};

/** Pasa un problema de Zod a una frase en español (Zod trae sus mensajes en inglés; los nuestros ya vienen en español). */
export function mensajeZod(i: IssueZod): string {
	const origen = String(i.origin ?? '');
	const n = Number(i.minimum ?? i.maximum);
	const incl = i.inclusive !== false;
	switch (i.code) {
		case 'too_small':
			if (origen === 'string') return n <= 1 ? 'no puede ir vacío' : `debe tener al menos ${n} caracteres`;
			if (origen === 'array') return `debe tener al menos ${n} elemento${n === 1 ? '' : 's'}`;
			return `debe ser ${incl ? 'mayor o igual a' : 'mayor que'} ${n}`;
		case 'too_big':
			if (origen === 'string') return `debe tener como máximo ${n} caracteres`;
			if (origen === 'array') return `debe tener como máximo ${n} elementos`;
			return `debe ser ${incl ? 'menor o igual a' : 'menor que'} ${n}`;
		case 'invalid_type':
			return `debe ser ${NOMBRE_TIPO[String(i.expected)] ?? String(i.expected)}`;
		case 'unrecognized_keys':
			return `trae campos que no conozco (${(i.keys as string[] | undefined)?.join(', ') ?? '?'})`;
		case 'invalid_union':
			if (Array.isArray(i.options) && i.discriminator) return `"${String(i.discriminator)}" debe ser ${(i.options as string[]).map((o) => `"${o}"`).join(', ')}`;
			return 'no tiene una forma válida';
		case 'invalid_value':
			return `debe ser ${((i.values as unknown[] | undefined) ?? []).map((v) => JSON.stringify(v)).join(' o ')}`;
		default:
			return i.message;
	}
}

function rutaZod(raiz: string, path: readonly PropertyKey[]): string {
	return `${raiz}${path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('')}`;
}

/** Errores de un guion en una frase por error (español), o [] si es válido. */
export function erroresGuion(guion: unknown): string[] {
	const r = GuionEsquema.safeParse(guion);
	if (r.success) return [];
	return r.error.issues.map((i) => `${rutaZod('guion', i.path)}: ${mensajeZod(i as unknown as IssueZod)}`);
}

/** Errores de un archivo de demo de terminal (español), o [] si es válido. */
export function erroresDemo(demo: unknown): string[] {
	const r = DemoTerminalEsquema.safeParse(demo);
	if (r.success) return [];
	return r.error.issues.map((i) => `${rutaZod('demo', i.path)}: ${mensajeZod(i as unknown as IssueZod)}`);
}

// ───────────────────────────── caracteres y anchos ─────────────────────────────

/** Separa un texto en caracteres visibles (grafemas), ya normalizado a NFC. */
export function grafemas(texto: string): string[] {
	const t = texto.normalize('NFC');
	const Seg = (Intl as unknown as {Segmenter?: new (l: string, o: {granularity: 'grapheme'}) => {segment(s: string): Iterable<{segment: string}>}}).Segmenter;
	if (Seg) return Array.from(new Seg('es', {granularity: 'grapheme'}).segment(t), (s) => s.segment);
	return Array.from(t);
}

const RANGOS_ANCHOS: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe4f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f000, 0x1faff],
	[0x20000, 0x3fffd],
];

/**
 * Celdas que ocupa un carácter: 2 para CJK, ancho completo y emoji (si la fuente no lo trae); 2 para las flechas
 * largas de la fuente (⟵ ⟶ ⟷, que miden 1200/1000); 1 para lo demás. Es la regla de ESTE dibujo, no la de una
 * terminal real (que depende de su tabla de anchos).
 */
export function anchoCaracter(g: string): 1 | 2 {
	const cp = g.codePointAt(0) ?? 32;
	if (cp >= 0x27f5 && cp <= 0x27f7) return 2;
	if (tieneGlifo(cp) || GLIFOS_DIBUJADOS.has(g)) return 1;
	if (g.includes('️')) return 2;
	for (const [a, b] of RANGOS_ANCHOS) if (cp >= a && cp <= b) return 2;
	return 1;
}

/** Caracteres de un guion que no tienen glifo propio (ni en la fuente ni dibujados): se verían con otra fuente. */
export function caracteresSinGlifo(guion: readonly Paso[], extra: readonly string[] = []): string[] {
	const textos: string[] = [...extra];
	for (const p of guion) {
		if (p.tipo === 'comando') textos.push(p.texto);
		if (p.tipo === 'salida') for (const l of p.lineas) textos.push(...segmentosDeLinea(l, COLORES.texto).map((s) => s.texto));
	}
	const faltan = new Set<string>();
	for (const t of textos) {
		for (const g of grafemas(t)) {
			const cp = g.codePointAt(0) ?? 32;
			if (g === ' ' || GLIFOS_DIBUJADOS.has(g)) continue;
			if (Array.from(g).length === 1 && tieneGlifo(cp)) continue;
			faltan.add(g);
		}
	}
	return [...faltan];
}

/** Una celda de la rejilla. `origen`: índice del carácter tecleado (≥ 0), −1 = texto fijo, −2 = sangría. */
export type Celda = {ch: string; ancho: 1 | 2; color: string; negrita: boolean; origen: number};

type SegmentoResuelto = {texto: string; color: string; negrita: boolean};

function segmentosDeLinea(linea: LineaSalida, color: string): SegmentoResuelto[] {
	if (typeof linea === 'string') return [{texto: linea, color, negrita: false}];
	const lista = Array.isArray(linea) ? linea : [linea];
	return lista.map((s) => ({texto: s.texto, color: resolverColor(s.color, color), negrita: s.negrita ?? false}));
}

function celdasDeTexto(texto: string, color: string, negrita: boolean, origenFijo?: number): Celda[] {
	return grafemas(texto).map((ch, k) => ({ch, ancho: anchoCaracter(ch), color, negrita, origen: origenFijo ?? k}));
}

function celdasDeLinea(linea: LineaSalida, color: string): Celda[] {
	return segmentosDeLinea(linea, color).flatMap((s) => celdasDeTexto(s.texto, s.color, s.negrita, -1));
}

/**
 * Envuelve celdas en filas de `columnas` celdas, carácter por carácter (como una terminal, no por palabras).
 * Las filas de continuación empiezan con `sangria` celdas en blanco (origen −2). Un carácter ancho que no cabe
 * al final de una fila pasa entero a la siguiente. Siempre devuelve al menos una fila.
 */
export function envolver(celdas: readonly Celda[], columnas: number, sangria = 0): Celda[][] {
	const cols = Math.max(1, Math.floor(columnas));
	const sang = Math.min(Math.max(0, Math.floor(sangria)), cols - 2 > 0 ? cols - 2 : 0);
	const filas: Celda[][] = [[]];
	let ancho = 0;
	const sangrar = (fila: Celda[], color: string) => {
		for (let k = 0; k < sang; k++) fila.push({ch: ' ', ancho: 1, color, negrita: false, origen: -2});
		return sang;
	};
	for (const c of celdas) {
		if (ancho + c.ancho > cols) {
			const nueva: Celda[] = [];
			filas.push(nueva);
			ancho = sangrar(nueva, c.color);
		}
		filas[filas.length - 1].push(c);
		ancho += c.ancho;
	}
	return filas;
}

/**
 * Envuelve por palabras (para la salida y la transcripción: se lee mejor en un reel). Los espacios donde se parte
 * la línea se quitan; la sangría del principio se respeta; una palabra más larga que una fila se parte por
 * caracteres. Los comandos que se teclean NO usan esto (una palabra que salta de fila mientras se escribe se ve
 * rara): van con `envolver`.
 */
export function envolverPalabras(celdas: readonly Celda[], columnas: number, sangria = 0): Celda[][] {
	const cols = Math.max(1, Math.floor(columnas));
	const sang = Math.min(Math.max(0, Math.floor(sangria)), cols - 2 > 0 ? cols - 2 : 0);
	const tokens: Array<{espacio: boolean; celdas: Celda[]}> = [];
	for (const c of celdas) {
		const espacio = c.ch === ' ';
		const ultimo = tokens[tokens.length - 1];
		if (ultimo && ultimo.espacio === espacio) ultimo.celdas.push(c);
		else tokens.push({espacio, celdas: [c]});
	}
	const filas: Celda[][] = [[]];
	let ancho = 0;
	let hayTexto = false;
	let espacios: Celda[] = [];
	const nuevaFila = (color: string) => {
		const fila: Celda[] = [];
		for (let k = 0; k < sang; k++) fila.push({ch: ' ', ancho: 1, color, negrita: false, origen: -2});
		filas.push(fila);
		ancho = sang;
	};
	for (const tok of tokens) {
		if (tok.espacio) {
			if (!hayTexto) {
				// Sangría del principio de la línea: se queda (se parte por caracteres si no cabe).
				for (const c of tok.celdas) {
					if (ancho + c.ancho > cols) nuevaFila(c.color);
					filas[filas.length - 1].push(c);
					ancho += c.ancho;
				}
			} else espacios = tok.celdas;
			continue;
		}
		const w = anchoFila(tok.celdas);
		const wEsp = anchoFila(espacios);
		if (ancho + wEsp + w <= cols) {
			filas[filas.length - 1].push(...espacios, ...tok.celdas);
			ancho += wEsp + w;
		} else if (w > cols - sang) {
			for (const c of [...espacios, ...tok.celdas]) {
				if (ancho + c.ancho > cols) nuevaFila(c.color);
				filas[filas.length - 1].push(c);
				ancho += c.ancho;
			}
		} else {
			nuevaFila(tok.celdas[0].color);
			filas[filas.length - 1].push(...tok.celdas);
			ancho += w;
		}
		espacios = [];
		hayTexto = true;
	}
	return filas;
}

/** Celdas que ocupa una fila. */
export function anchoFila(fila: readonly Celda[]): number {
	return fila.reduce((s, c) => s + c.ancho, 0);
}

/** Texto de una fila (para pruebas y OCR): cada celda en su columna, sin espacios al final. */
export function textoDeCeldas(celdas: ReadonlyArray<{ch: string; ancho: number; col?: number}>): string {
	let s = '';
	let col = 0;
	for (const c of celdas) {
		const destino = c.col ?? col;
		while (col < destino) {
			s += ' ';
			col++;
		}
		s += c.ch;
		col += c.ancho;
	}
	return s.replace(/\s+$/u, '');
}

// ───────────────────────────── geometría ─────────────────────────────

export type GeometriaTerminal = {
	ancho: number;
	alto: number;
	tamanoLetra: number;
	/** Ancho de una columna (px base). */
	celda: number;
	/** Alto de una fila (px base, entero). */
	altoFila: number;
	/** Alto de la barra de la ventana. */
	barra: number;
	columnas: number;
	filasVisibles: number;
	/** Área de texto dentro de la ventana (px base, relativa a la esquina de la ventana). */
	area: {x: number; y: number; w: number; h: number};
	/** Línea base del texto dentro de una fila (px desde el tope de la fila). */
	lineaBase: number;
	/** Centro vertical de los glifos dibujados dentro de una fila (≈ eje matemático). */
	centroGlifo: number;
	radio: number;
};

/**
 * Rejilla de la terminal para una ventana de `ancho`×`alto` px base. La barra, los márgenes y el alto de fila
 * escalan con el tamaño de letra; el área de texto mide exactamente columnas × celda por filasVisibles × altoFila.
 */
export function geometriaTerminal(op: {ancho: number; alto: number; tamanoLetra: number}): GeometriaTerminal {
	const tam = op.tamanoLetra;
	const celda = tam * FUENTE_TERMINAL.avance;
	const altoFila = Math.round(tam * 1.42);
	const barra = Math.round(tam * 1.6);
	const margenX = Math.round(tam * 0.8);
	const margenY = Math.round(tam * 0.6);
	const columnas = Math.floor((op.ancho - 2 * margenX) / celda);
	const filasVisibles = Math.floor((op.alto - barra - 2 * margenY) / altoFila);
	const w = columnas * celda;
	const lineaBase = (altoFila - (FUENTE_TERMINAL.ascenso + FUENTE_TERMINAL.descenso) * tam) / 2 + FUENTE_TERMINAL.ascenso * tam;
	return {
		ancho: op.ancho,
		alto: op.alto,
		tamanoLetra: tam,
		celda,
		altoFila,
		barra,
		columnas,
		filasVisibles,
		area: {x: (op.ancho - w) / 2, y: barra + margenY, w, h: filasVisibles * altoFila},
		lineaBase,
		centroGlifo: lineaBase - tam * 0.32,
		radio: VENTANA.radio,
	};
}

// ───────────────────────────── ritmos deterministas ─────────────────────────────

/** Velocidad de tecleo por defecto (caracteres por segundo). */
export const ESCRITURA = {minimo: 25, maximo: 40} as const;

function hash32(a: number): number {
	let z = (a + 0x9e3779b9) | 0;
	z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
	z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
	return (z ^ (z >>> 16)) >>> 0;
}

/** Número en [0, 1) que solo depende de (semilla, paso, k). */
export function aleatorio(semilla: number, paso: number, k: number): number {
	return hash32(hash32(hash32(semilla) ^ Math.imul(paso + 1, 0x27d4eb2d)) ^ Math.imul(k + 1, 0x165667b1)) / 4294967296;
}

/**
 * Segundos entre la tecla k−1 y la tecla k (k ≥ 1). Sin `velocidad`: entre 1/40 y 1/25 s (25–40 car/s), un poco
 * más lento al empezar palabra. Con `velocidad`: entre 0.8 y 1.2 veces 1/velocidad.
 */
export function intervaloTecla(grafs: readonly string[], k: number, velocidad: number | undefined, semilla: number, paso: number): number {
	const r = aleatorio(semilla, paso, k);
	const inicioPalabra = k > 0 && grafs[k - 1] === ' ' && grafs[k] !== ' ';
	const u = inicioPalabra ? 0.55 + 0.45 * r : r;
	if (velocidad === undefined) return 1 / ESCRITURA.maximo + (1 / ESCRITURA.minimo - 1 / ESCRITURA.maximo) * u;
	return (1 / velocidad) * (0.8 + 0.4 * u);
}

/** Segundo en que aparece cada carácter de un comando que empieza a teclearse en `inicio`. */
export function tiemposEscritura(texto: string, inicio: number, velocidad: number | undefined, semilla: number, paso: number): number[] {
	const grafs = grafemas(texto);
	const tiempos: number[] = [];
	let t = inicio;
	for (let k = 0; k < grafs.length; k++) {
		if (k > 0) t += intervaloTecla(grafs, k, velocidad, semilla, paso);
		tiempos.push(t);
	}
	return tiempos;
}

function ritmoLinea(ritmo: number, semilla: number, paso: number, k: number): number {
	return ritmo * (0.75 + 0.5 * aleatorio(semilla, paso + 7919, k));
}

// ───────────────────────────── línea de tiempo ─────────────────────────────

export type PausasTerminal = {
	/** Segundos entre que el prompt (o la caja) está listo y la primera tecla. */
	antesDeEscribir: number;
	/** Segundos entre la última tecla y el enter. */
	antesDeEnter: number;
	/** Segundos entre el enter y la primera línea de salida (modo terminal). */
	despuesDeEnter: number;
	/** Segundos entre el enter de un comando sin salida y el prompt nuevo (modo terminal). */
	promptTrasEnter: number;
	/** Segundos mínimos del indicador "Pensando…" (modo claude-code). */
	pensando: number;
	/** Segundos entre líneas de salida si el paso no trae `ritmo`. */
	ritmoSalida: number;
	/** Segundos que se queda el final (cursor parpadeando) después del último evento. */
	cola: number;
};

export const PAUSAS_POR_DEFECTO: Readonly<Record<ModoTerminal, Readonly<PausasTerminal>>> = {
	terminal: {antesDeEscribir: 0.45, antesDeEnter: 0.3, despuesDeEnter: 0.12, promptTrasEnter: 0.06, pensando: 0, ritmoSalida: 0.07, cola: 0.8},
	'claude-code': {antesDeEscribir: 0.45, antesDeEnter: 0.35, despuesDeEnter: 0, promptTrasEnter: 0, pensando: 1.1, ritmoSalida: 0.09, cola: 0.8},
};

/** Segundos que tarda una fila nueva en abrir su espacio (y el contenido en desplazarse). */
export const DURACION_DESPLAZAMIENTO = 0.12;
/** Segundos del fundido de entrada de una línea (y de salida del indicador "Pensando…"). */
export const DURACION_FUNDIDO = 0.06;
/** Medio periodo del parpadeo del cursor (s). */
export const PARPADEO = 0.53;
const RAMPA_PARPADEO = 0.05;

export type OpcionesTerminal = {
	modo: ModoTerminal;
	columnas: number;
	filasVisibles: number;
	semilla: number;
	/** Modo terminal: carpeta antes del "❯". Modo claude-code: subtítulo del encabezado si no hay otro. */
	directorio: string | null;
	encabezado: {titulo: string; subtitulo: string | null};
	textos: TextosTerminal;
	pausas: PausasTerminal;
};

export type OpcionesTerminalEntrada = {columnas: number; filasVisibles: number} & Partial<
	Omit<OpcionesTerminal, 'columnas' | 'filasVisibles' | 'pausas' | 'textos' | 'encabezado'>
> & {
		pausas?: Partial<PausasTerminal>;
		textos?: Partial<TextosTerminal>;
		encabezado?: {titulo?: string; subtitulo?: string | null};
	};

export function resolverOpciones(e: OpcionesTerminalEntrada): OpcionesTerminal {
	const modo = e.modo ?? 'terminal';
	const sinUndef = <T extends object>(o: T | undefined): Partial<T> =>
		Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
	const directorio = e.directorio ?? null;
	return {
		modo,
		columnas: Math.floor(e.columnas),
		filasVisibles: Math.floor(e.filasVisibles),
		semilla: e.semilla ?? 7,
		directorio,
		encabezado: {
			titulo: e.encabezado?.titulo ?? 'Claude Code',
			subtitulo: e.encabezado?.subtitulo !== undefined ? e.encabezado.subtitulo : directorio,
		},
		textos: {...TEXTOS_POR_DEFECTO, ...sinUndef(e.textos)},
		pausas: {...PAUSAS_POR_DEFECTO[modo], ...sinUndef(e.pausas)},
	};
}

/** Un comando con el segundo en que aparece cada carácter. */
export type ComandoLt = {
	/** Índice del paso en el guion. */
	paso: number;
	texto: string;
	celdas: Celda[];
	tiempos: number[];
	/** Primera tecla. */
	inicio: number;
	/** Enter (el comando deja de editarse). */
	enter: number;
};

/** Cambio de altura de un bloque (en filas) que empieza en el segundo t y se suaviza en DURACION_DESPLAZAMIENTO. */
type Cambio = {t: number; d: number};

type BloqueComun = {clave: string; aparece: number; cambios: Cambio[]};

export type Bloque =
	| (BloqueComun & {tipo: 'texto'; filas: Celda[][]})
	| (BloqueComun & {tipo: 'prompt'; filas: Celda[][]; comando: ComandoLt | null})
	| (BloqueComun & {tipo: 'pensando'; hasta: number})
	| (BloqueComun & {tipo: 'encabezado'; titulo: Celda[]; subtitulo: Celda[] | null})
	| (BloqueComun & {tipo: 'vacio'})
	| (BloqueComun & {tipo: 'entrada'})
	| (BloqueComun & {tipo: 'pista'; celdas: Celda[]});

export type LineaDeTiempo = {
	modo: ModoTerminal;
	columnas: number;
	filasVisibles: number;
	pausas: PausasTerminal;
	textos: TextosTerminal;
	bloques: Bloque[];
	comandos: ComandoLt[];
	/** Segundos que dura el guion completo, con la cola. */
	duracion: number;
};

const SIEMPRE = -1e9;
/** Columnas que se comen el borde y el margen de la caja de entrada (modo claude-code): 2 de cada lado. */
export const MARGEN_CAJA = 2;

function primeraTecla(fila: readonly Celda[]): number {
	const c = fila.find((x) => x.origen >= 0);
	return c ? c.origen : -1;
}

/**
 * Convierte el guion en una línea de tiempo. Lanza un Error en español si el guion no cumple el contrato o si la
 * ventana es demasiado chica para el modo.
 */
export function crearLineaDeTiempo(guion: readonly Paso[], entrada: OpcionesTerminalEntrada): LineaDeTiempo {
	const errores = erroresGuion(guion);
	if (errores.length > 0) throw new Error(`El guion de la terminal no es válido: ${errores.join('; ')}.`);
	const op = resolverOpciones(entrada);
	const minimos = op.modo === 'claude-code' ? {columnas: 24, filas: 8} : {columnas: 12, filas: 2};
	if (op.columnas < minimos.columnas || op.filasVisibles < minimos.filas) {
		throw new Error(
			`La ventana de la terminal es muy chica para el modo ${op.modo}: caben ${op.columnas} columnas y ${op.filasVisibles} filas ` +
				`(mínimo ${minimos.columnas} y ${minimos.filas}). Agranda la ventana o baja el tamaño de letra.`,
		);
	}
	return op.modo === 'claude-code' ? lineaClaudeCode(guion, op) : lineaTerminal(guion, op);
}

function crearComando(paso: number, texto: string, velocidad: number | undefined, inicio: number, op: OpcionesTerminal): ComandoLt {
	const tiempos = tiemposEscritura(texto, inicio, velocidad, op.semilla, paso);
	return {
		paso,
		texto,
		celdas: celdasDeTexto(texto, COLORES.texto, false),
		tiempos,
		inicio,
		enter: tiempos[tiempos.length - 1] + op.pausas.antesDeEnter,
	};
}

function siguienteNoEspera(guion: readonly Paso[], i: number): Paso | null {
	for (let k = i + 1; k < guion.length; k++) if (guion[k].tipo !== 'espera') return guion[k];
	return null;
}

/** Prompt del modo terminal: "<carpeta> ❯ " (la carpeta en cian, la flecha en verde). */
export function celdasPrompt(directorio: string | null): Celda[] {
	const celdas: Celda[] = [];
	if (directorio) celdas.push(...celdasDeTexto(`${directorio} `, COLORES.cian, true, -1));
	celdas.push(...celdasDeTexto('❯', COLORES.verde, true, -1), ...celdasDeTexto(' ', COLORES.texto, false, -1));
	return celdas;
}

function lineaTerminal(guion: readonly Paso[], op: OpcionesTerminal): LineaDeTiempo {
	const bloques: Bloque[] = [];
	const comandos: ComandoLt[] = [];
	const prefijo = celdasPrompt(op.directorio);
	let n = 0;
	let t = 0;
	let fin = 0;
	let pendiente: Extract<Bloque, {tipo: 'prompt'}> | null = null;
	const filasPrefijo = envolver(prefijo, op.columnas, 0);
	const agregarPrompt = (en: number) => {
		const b: Extract<Bloque, {tipo: 'prompt'}> = {
			tipo: 'prompt',
			clave: `p${n++}`,
			aparece: en,
			cambios: [{t: en, d: filasPrefijo.length}],
			filas: filasPrefijo,
			comando: null,
		};
		bloques.push(b);
		pendiente = b;
		fin = Math.max(fin, en);
		return b;
	};

	const primero = guion.find((p) => p.tipo !== 'espera');
	if (!primero || primero.tipo === 'comando') agregarPrompt(0);

	for (let i = 0; i < guion.length; i++) {
		const paso = guion[i];
		if (paso.tipo === 'espera') {
			t += paso.s;
			fin = Math.max(fin, t);
			continue;
		}
		if (paso.tipo === 'comando') {
			const prompt: Extract<Bloque, {tipo: 'prompt'}> = pendiente ?? agregarPrompt(t);
			const cmd = crearComando(i, paso.texto, paso.velocidad, Math.max(t, prompt.aparece) + op.pausas.antesDeEscribir, op);
			prompt.comando = cmd;
			prompt.filas = envolver([...prefijo, ...cmd.celdas], op.columnas, 0);
			// Una fila más cuando la primera tecla de esa fila aparece (si la fila es del prompt mismo, desde el inicio).
			prompt.cambios = [{t: prompt.aparece, d: 1}];
			for (const fila of prompt.filas.slice(1)) {
				const k = primeraTecla(fila);
				prompt.cambios.push({t: k >= 0 ? cmd.tiempos[k] : prompt.aparece, d: 1});
			}
			comandos.push(cmd);
			pendiente = null;
			t = cmd.enter;
			fin = Math.max(fin, t);
			const sig = siguienteNoEspera(guion, i);
			// Comando sin salida: el shell vuelve a mostrar el prompt casi de inmediato.
			if (!sig || sig.tipo === 'comando') agregarPrompt(t + op.pausas.promptTrasEnter);
			continue;
		}
		const color = resolverColor(paso.color, COLORES.texto);
		const ritmo = paso.ritmo ?? op.pausas.ritmoSalida;
		let tl = i > 0 && guion[i - 1].tipo === 'comando' ? t + op.pausas.despuesDeEnter : t;
		paso.lineas.forEach((linea, k) => {
			if (k > 0) tl += ritmoLinea(ritmo, op.semilla, i, k);
			const filas = envolverPalabras(celdasDeLinea(linea, color), op.columnas, 0);
			bloques.push({tipo: 'texto', clave: `s${n++}`, aparece: tl, cambios: [{t: tl, d: filas.length}], filas});
		});
		t = tl + ritmo;
		fin = Math.max(fin, t);
		const sig = siguienteNoEspera(guion, i);
		if (!sig || sig.tipo === 'comando') agregarPrompt(t);
	}
	return {
		modo: 'terminal',
		columnas: op.columnas,
		filasVisibles: op.filasVisibles,
		pausas: op.pausas,
		textos: op.textos,
		bloques,
		comandos,
		duracion: fin + op.pausas.cola,
	};
}

function truncar(celdas: Celda[], columnas: number): Celda[] {
	if (anchoFila(celdas) <= columnas) return celdas;
	const salida: Celda[] = [];
	let ancho = 0;
	for (const c of celdas) {
		if (ancho + c.ancho > columnas - 1) break;
		salida.push(c);
		ancho += c.ancho;
	}
	const ultimo = celdas[salida.length] ?? celdas[celdas.length - 1];
	salida.push({ch: '…', ancho: 1, color: ultimo.color, negrita: ultimo.negrita, origen: -1});
	return salida;
}

function lineaClaudeCode(guion: readonly Paso[], op: OpcionesTerminal): LineaDeTiempo {
	const interior = op.columnas - 2 * MARGEN_CAJA;
	const transcripcion: Bloque[] = [];
	const comandos: ComandoLt[] = [];
	let n = 0;
	let t = 0;
	let fin = 0;

	transcripcion.push({
		tipo: 'encabezado',
		clave: 'enc',
		aparece: SIEMPRE,
		cambios: [{t: SIEMPRE, d: 3}],
		titulo: truncar(celdasDeTexto(op.encabezado.titulo, COLORES.naranja, true, -1), interior),
		subtitulo: op.encabezado.subtitulo ? truncar(celdasDeTexto(op.encabezado.subtitulo, COLORES.tenue, false, -1), interior) : null,
	});
	transcripcion.push({tipo: 'vacio', clave: 'enc-v', aparece: SIEMPRE, cambios: [{t: SIEMPRE, d: 1}]});

	const caja: Extract<Bloque, {tipo: 'entrada'}> = {tipo: 'entrada', clave: 'caja', aparece: SIEMPRE, cambios: [{t: SIEMPRE, d: 2}]};
	type Turno = {pensando: Extract<Bloque, {tipo: 'pensando'}>; minimo: number; insercion: number; salidas: number};
	let turno: Turno | null = null;
	const cerrarPensando = (en: number) => {
		if (!turno || !Number.isNaN(turno.pensando.hasta)) return;
		turno.pensando.hasta = en;
		turno.pensando.cambios.push({t: en, d: -1});
		fin = Math.max(fin, en);
	};
	const prefijoEntrada = celdasDeTexto('> ', COLORES.texto, false, -1);

	for (let i = 0; i < guion.length; i++) {
		const paso = guion[i];
		if (paso.tipo === 'espera') {
			t += paso.s;
			fin = Math.max(fin, t);
			continue;
		}
		if (paso.tipo === 'comando') {
			if (turno && Number.isNaN(turno.pensando.hasta)) {
				const cierre = Math.max(t, turno.minimo);
				cerrarPensando(cierre);
				t = cierre;
			}
			const cmd = crearComando(i, paso.texto, paso.velocidad, t + op.pausas.antesDeEscribir, op);
			// La caja crece una fila por cada fila nueva del texto (un poco antes de la tecla, para que el texto no se
			// salga del borde) y vuelve a una fila con el enter.
			const filasCaja = envolver([...prefijoEntrada, ...cmd.celdas], interior, 2);
			for (const fila of filasCaja.slice(1)) caja.cambios.push({t: cmd.tiempos[primeraTecla(fila)] - DURACION_DESPLAZAMIENTO / 2, d: 1});
			if (filasCaja.length > 1) caja.cambios.push({t: cmd.enter, d: -(filasCaja.length - 1)});
			comandos.push(cmd);
			t = cmd.enter;
			fin = Math.max(fin, t);
			const eco = envolverPalabras([...celdasDeTexto('> ', COLORES.tenue, false, -1), ...celdasDeTexto(paso.texto, COLORES.tenue, false, -1)], op.columnas, 2);
			transcripcion.push({tipo: 'texto', clave: `u${n++}`, aparece: t, cambios: [{t, d: eco.length}], filas: eco});
			transcripcion.push({tipo: 'vacio', clave: `v${n++}`, aparece: t, cambios: [{t, d: 1}]});
			const pensando: Extract<Bloque, {tipo: 'pensando'}> = {tipo: 'pensando', clave: `g${n++}`, aparece: t, hasta: Number.NaN, cambios: [{t, d: 1}]};
			transcripcion.push(pensando);
			transcripcion.push({tipo: 'vacio', clave: `v${n++}`, aparece: t, cambios: [{t, d: 1}]});
			// Las respuestas se insertan ANTES del indicador: la primera línea ocupa su lugar sin mover lo de abajo.
			turno = {pensando, minimo: t + op.pausas.pensando, insercion: transcripcion.length - 2, salidas: 0};
			continue;
		}
		// Salida: una respuesta ("● " en la primera línea con texto; las demás con sangría de 2).
		let tl = t;
		if (turno && Number.isNaN(turno.pensando.hasta)) {
			tl = Math.max(t, turno.minimo);
			cerrarPensando(tl);
		}
		const color = resolverColor(paso.color, COLORES.texto);
		const ritmo = paso.ritmo ?? op.pausas.ritmoSalida;
		const nuevos: Bloque[] = [];
		if (turno && turno.salidas > 0) nuevos.push({tipo: 'vacio', clave: `v${n++}`, aparece: tl, cambios: [{t: tl, d: 1}]});
		let conVineta = false;
		paso.lineas.forEach((linea, k) => {
			if (k > 0) tl += ritmoLinea(ritmo, op.semilla, i, k);
			const celdas = celdasDeLinea(linea, color);
			const vacia = celdas.length === 0;
			let prefijo: Celda[];
			if (vacia) prefijo = [];
			else if (!conVineta) {
				prefijo = [...celdasDeTexto('●', color, false, -1), ...celdasDeTexto(' ', color, false, -1)];
				conVineta = true;
			} else prefijo = celdasDeTexto('  ', color, false, -2);
			const filas = envolverPalabras([...prefijo, ...celdas], op.columnas, 2);
			nuevos.push({tipo: 'texto', clave: `r${n++}`, aparece: tl, cambios: [{t: tl, d: filas.length}], filas});
		});
		if (turno) {
			transcripcion.splice(turno.insercion, 0, ...nuevos);
			turno.insercion += nuevos.length;
			turno.salidas++;
		} else {
			transcripcion.push(...nuevos, {tipo: 'vacio', clave: `v${n++}`, aparece: tl, cambios: [{t: tl, d: 1}]});
		}
		t = tl + ritmo;
		fin = Math.max(fin, t);
	}
	if (turno && Number.isNaN((turno as Turno).pensando.hasta)) cerrarPensando(Math.max(t, (turno as Turno).minimo));

	const bloques: Bloque[] = [...transcripcion, caja];
	if (op.textos.pista) {
		bloques.push({
			tipo: 'pista',
			clave: 'pista',
			aparece: SIEMPRE,
			cambios: [{t: SIEMPRE, d: 1}],
			celdas: truncar(celdasDeTexto(op.textos.pista, COLORES.tenue, false, -1), interior),
		});
	}
	return {
		modo: 'claude-code',
		columnas: op.columnas,
		filasVisibles: op.filasVisibles,
		pausas: op.pausas,
		textos: op.textos,
		bloques,
		comandos,
		duracion: fin + op.pausas.cola,
	};
}

// ───────────────────────────── estado en el segundo t ─────────────────────────────

/** Celda ya colocada en su columna. */
export type CeldaEstado = {col: number; ch: string; ancho: 1 | 2; color: string; negrita: boolean};
/** Fila de texto: `fila` es la posición vertical en filas desde el tope del documento (puede ser fraccionaria). */
export type FilaEstado = {clave: string; fila: number; celdas: CeldaEstado[]; opacidad: number};
/** Recuadro (modo claude-code): encabezado naranja o caja de entrada. */
export type CajaEstado = {clave: string; tipo: 'encabezado' | 'entrada'; fila: number; alto: number; opacidad: number; color: string};
export type CursorEstado = {fila: number; col: number; opacidad: number};
export type EstadoTerminal = {
	filas: FilaEstado[];
	cajas: CajaEstado[];
	cursor: CursorEstado | null;
	/** Filas que el contenido subió para que se vea el final (0 mientras todo cabe). */
	desplazamiento: number;
	altoDocumento: number;
};

/** Curva de salida cúbica en [0, 1]. */
export function suavizar(x: number): number {
	const u = Math.min(1, Math.max(0, x));
	return 1 - (1 - u) ** 3;
}

function altura(cambios: readonly Cambio[], t: number): number {
	let h = 0;
	for (const c of cambios) if (t >= c.t) h += c.d * suavizar((t - c.t) / DURACION_DESPLAZAMIENTO);
	return h;
}

function fundido(t: number, desde: number): number {
	if (desde <= SIEMPRE) return 1;
	return Math.min(1, Math.max(0, (t - desde) / DURACION_FUNDIDO));
}

/** Opacidad del cursor: fijo justo después de cada tecla y luego parpadea (on/off cada PARPADEO s, con rampas cortas). */
export function opacidadCursor(t: number, reinicio: number): number {
	const u = t - reinicio;
	if (u < 0) return 1;
	const k = Math.floor(u / PARPADEO);
	const f = u - k * PARPADEO;
	const desde = k % 2 === 0 ? 1 : 0;
	if (f > PARPADEO - RAMPA_PARPADEO) return desde + (1 - 2 * desde) * ((f - (PARPADEO - RAMPA_PARPADEO)) / RAMPA_PARPADEO);
	return desde;
}

/** Cuántos tiempos son ≤ t (los tiempos vienen ordenados). */
function contar(tiempos: readonly number[], t: number): number {
	let bajo = 0;
	let alto = tiempos.length;
	while (bajo < alto) {
		const medio = (bajo + alto) >> 1;
		if (tiempos[medio] <= t) bajo = medio + 1;
		else alto = medio;
	}
	return bajo;
}

function colocar(fila: readonly Celda[], colInicial = 0): CeldaEstado[] {
	const salida: CeldaEstado[] = [];
	let col = colInicial;
	for (const c of fila) {
		salida.push({col, ch: c.ch, ancho: c.ancho, color: c.color, negrita: c.negrita});
		col += c.ancho;
	}
	return salida;
}

/**
 * Filas de un bloque de prompt con lo tecleado hasta t (la envoltura de un prefijo es prefijo de la envoltura).
 * Una fila de continuación se ve en cuanto tiene algo que no sea sangría (texto fijo o una tecla ya escrita).
 */
function filasHasta(filas: readonly Celda[][], tecleados: number): Celda[][] {
	return filas.map((f) => f.filter((c) => c.origen < tecleados)).filter((f, i) => i === 0 || f.some((c) => c.origen !== -2));
}

/** Posición del cursor después de la última celda (salta a la fila siguiente si la fila está llena). */
function cursorTrasFilas(filas: readonly Celda[][], columnas: number, sangria: number): {fila: number; col: number} {
	const r = filas.length - 1;
	const col = anchoFila(filas[r]);
	if (col >= columnas) return {fila: r + 1, col: sangria};
	return {fila: r, col};
}

function celdasPensando(lt: LineaDeTiempo, b: Extract<Bloque, {tipo: 'pensando'}>, t: number): CeldaEstado[] {
	const transcurrido = Math.max(0, t - b.aparece);
	const glifo = GIRO_PENSANDO[Math.floor(transcurrido / SEGUNDOS_GIRO) % GIRO_PENSANDO.length];
	const palabra = grafemas(lt.textos.pensando);
	// Brillo que recorre la palabra de izquierda a derecha cada 1.5 s.
	const pos = ((transcurrido / 1.5) % 1) * (palabra.length + 8) - 4;
	const celdas: Celda[] = [{ch: glifo, ancho: 1, color: COLORES.naranja, negrita: false, origen: -1}];
	celdas.push({ch: ' ', ancho: 1, color: COLORES.naranja, negrita: false, origen: -1});
	palabra.forEach((ch, j) => {
		const w = Math.max(0, 1 - Math.abs(j - pos) / 3);
		celdas.push({ch, ancho: anchoCaracter(ch), color: mezclarColor(COLORES.naranja, VENTANA.naranjaClaro, w), negrita: false, origen: -1});
	});
	if (lt.textos.interrumpir) {
		const extra = celdasDeTexto(` ${lt.textos.interrumpir}`, COLORES.tenue, false, -1);
		if (anchoFila(celdas) + anchoFila(extra) <= lt.columnas) celdas.push(...extra);
	}
	return colocar(celdas);
}

/** Lo que se ve en el segundo t (t relativo al arranque del guion). */
export function estadoEn(lt: LineaDeTiempo, t: number): EstadoTerminal {
	const filas: FilaEstado[] = [];
	const cajas: CajaEstado[] = [];
	let cursor: CursorEstado | null = null;
	let y = 0;
	for (const b of lt.bloques) {
		if (t < b.aparece) continue;
		const h = altura(b.cambios, t);
		let op = fundido(t, b.aparece);
		switch (b.tipo) {
			case 'texto':
				b.filas.forEach((f, r) => filas.push({clave: `${b.clave}:${r}`, fila: y + r, celdas: colocar(f), opacidad: op}));
				break;
			case 'prompt': {
				const tecleados = b.comando ? contar(b.comando.tiempos, t) : 0;
				const visibles = b.comando ? filasHasta(b.filas, tecleados) : b.filas;
				visibles.forEach((f, r) => filas.push({clave: `${b.clave}:${r}`, fila: y + r, celdas: colocar(f), opacidad: op}));
				const activo = !b.comando || t < b.comando.enter;
				if (activo) {
					const pos = cursorTrasFilas(visibles, lt.columnas, 0);
					const reinicio = b.comando && tecleados > 0 ? b.comando.tiempos[tecleados - 1] : b.aparece;
					cursor = {fila: y + pos.fila, col: pos.col, opacidad: opacidadCursor(t, reinicio) * op};
				}
				break;
			}
			case 'pensando': {
				if (!Number.isNaN(b.hasta) && t >= b.hasta) op *= 1 - fundido(t, b.hasta);
				if (op > 0) filas.push({clave: b.clave, fila: y, celdas: celdasPensando(lt, b, t), opacidad: op});
				break;
			}
			case 'encabezado':
				cajas.push({clave: b.clave, tipo: 'encabezado', fila: y + 0.1, alto: Math.max(0, h - 0.2), opacidad: op, color: COLORES.naranja});
				filas.push({clave: `${b.clave}:t`, fila: y + 0.5, celdas: colocar(b.titulo, MARGEN_CAJA), opacidad: op});
				if (b.subtitulo) filas.push({clave: `${b.clave}:s`, fila: y + 1.5, celdas: colocar(b.subtitulo, MARGEN_CAJA), opacidad: op});
				break;
			case 'vacio':
				break;
			case 'entrada': {
				// Comando que se está tecleando (o ninguno): el primero cuyo enter todavía no llega.
				const k = lt.comandos.findIndex((c) => t < c.enter);
				const cmd = k >= 0 ? lt.comandos[k] : null;
				const tecleados = cmd ? contar(cmd.tiempos, t) : 0;
				const celdas = [...celdasDeTexto('> ', COLORES.texto, false, -1), ...(cmd ? cmd.celdas.slice(0, tecleados) : [])];
				const interior = lt.columnas - 2 * MARGEN_CAJA;
				const filasCaja = envolver(celdas, interior, 2);
				cajas.push({clave: b.clave, tipo: 'entrada', fila: y + 0.1, alto: Math.max(0, h - 0.2), opacidad: op, color: VENTANA.bordeCaja});
				filasCaja.forEach((f, r) => filas.push({clave: `${b.clave}:${r}`, fila: y + 0.5 + r, celdas: colocar(f, MARGEN_CAJA), opacidad: op}));
				const pos = cursorTrasFilas(filasCaja, interior, 2);
				const anterior = k > 0 ? lt.comandos[k - 1].enter : k < 0 && lt.comandos.length > 0 ? lt.comandos[lt.comandos.length - 1].enter : 0;
				const reinicio = cmd && tecleados > 0 ? cmd.tiempos[tecleados - 1] : anterior;
				cursor = {fila: y + 0.5 + pos.fila, col: MARGEN_CAJA + pos.col, opacidad: opacidadCursor(t, reinicio)};
				break;
			}
			case 'pista':
				filas.push({clave: b.clave, fila: y, celdas: colocar(b.celdas, MARGEN_CAJA), opacidad: op});
				break;
		}
		y += h;
	}
	return {filas, cajas, cursor, desplazamiento: Math.max(0, y - lt.filasVisibles), altoDocumento: y};
}

// ───────────────────────────── consultas (para el director y las pruebas) ─────────────────────────────

/** Cuántos caracteres del k-ésimo comando se ven en el segundo t. */
export function caracteresEscritos(lt: LineaDeTiempo, k: number, t: number): number {
	const c = lt.comandos[k];
	if (!c) throw new Error(`El guion no tiene el comando ${k} (tiene ${lt.comandos.length}).`);
	return contar(c.tiempos, t);
}

/** Segundo (relativo al guion) que corresponde al cuadro n. */
export function segundoDeCuadro(cuadro: number, fps: number, retraso = 0): number {
	return cuadro / fps - retraso;
}

/**
 * Texto de cada fila que se ve completa en la ventana en el segundo t (de arriba abajo), sin espacios al final.
 * Solo cuenta las filas con opacidad ≥ `umbral` (una línea recién aparecida va en fundido).
 */
export function textoEnPantalla(lt: LineaDeTiempo, t: number, umbral = 0.5): string[] {
	const e = estadoEn(lt, t);
	return e.filas
		.filter((f) => {
			const y = f.fila - e.desplazamiento;
			return f.opacidad >= umbral && y >= -0.01 && y <= lt.filasVisibles - 1 + 0.01;
		})
		.sort((a, b) => a.fila - b.fila)
		.map((f) => textoDeCeldas(f.celdas));
}

// ───────────────────────────── ajustes del componente ─────────────────────────────

/** Valores por defecto del componente (px base 1080×1920). */
export const TERMINAL_POR_DEFECTO = {ancho: 960, alto: 1100, tamanoLetra: 34, retraso: 0.4, semilla: 7} as const;

/** Lo que recibe <TerminalAnimada> (sin las animaciones de entrada/salida). */
export type AjustesTerminal = {
	guion: readonly Paso[];
	modo?: ModoTerminal;
	/** Texto de la barra. Por defecto "zsh" (terminal) o "claude" (claude-code), con la carpeta si la hay. */
	titulo?: string;
	/** Carpeta: antes del "❯" (modo terminal) o en el encabezado (modo claude-code). */
	directorio?: string | null;
	encabezado?: {titulo?: string; subtitulo?: string | null};
	textos?: Partial<TextosTerminal>;
	pausas?: Partial<PausasTerminal>;
	/** Esquina superior izquierda de la ventana (px base). Por defecto, centrada en 1080×1920. */
	x?: number;
	y?: number;
	/** Tamaño de la ventana (px base). */
	ancho?: number;
	alto?: number;
	/** Tamaño de letra (px base). Con 34 px, una ventana de 960 px de ancho da 44 columnas. */
	tamanoLetra?: number;
	/** Segundos entre que empieza a entrar la ventana y arranca el guion. */
	retraso?: number;
	/** Semilla de las variaciones deterministas (ritmo de tecleo y de las líneas). */
	semilla?: number;
};

export type TerminalPreparada = {
	geo: GeometriaTerminal;
	lt: LineaDeTiempo;
	/** Esquina superior izquierda de la ventana (px base). */
	x: number;
	y: number;
	retraso: number;
	titulo: string;
	/** Segundos que necesita el insert: retraso + guion + cola. */
	duracion: number;
};

function lineaDeTiempoDe(a: AjustesTerminal, geo: GeometriaTerminal): LineaDeTiempo {
	return crearLineaDeTiempo(a.guion, {
		modo: a.modo ?? 'terminal',
		columnas: geo.columnas,
		filasVisibles: geo.filasVisibles,
		semilla: a.semilla ?? TERMINAL_POR_DEFECTO.semilla,
		directorio: a.directorio ?? null,
		encabezado: a.encabezado,
		textos: a.textos,
		pausas: a.pausas,
	});
}

/** Filas mínimas de una ventana ajustada al guion (para que no quede como una tira). */
export const FILAS_MINIMAS_AJUSTADA = 6;

/**
 * Alto (px base) de una ventana de `ancho` que muestra todo el guion sin desplazarse: barra, márgenes y las filas que
 * llega a ocupar el documento en algún momento (encabezado, caja de entrada y pista incluidos), con un mínimo de
 * FILAS_MINIMAS_AJUSTADA y nunca más que `alto` (el de por defecto). Un guion corto en la ventana de 1100 px deja medio
 * alto vacío; con esto la ventana mide lo que su contenido.
 */
export function altoNecesarioTerminal(a: AjustesTerminal, ancho: number = a.ancho ?? TERMINAL_POR_DEFECTO.ancho): number {
	const tam = a.tamanoLetra ?? TERMINAL_POR_DEFECTO.tamanoLetra;
	const tope = a.alto ?? TERMINAL_POR_DEFECTO.alto;
	const geo = geometriaTerminal({ancho, alto: tope, tamanoLetra: tam});
	const lt = lineaDeTiempoDe(a, geo);
	let filas = 0;
	const paso = 1 / 60;
	for (let t = 0; t <= lt.duracion + paso; t += paso) filas = Math.max(filas, estadoEn(lt, t).altoDocumento);
	const margenY = geo.area.y - geo.barra;
	const necesarias = Math.max(FILAS_MINIMAS_AJUSTADA, Math.ceil(filas - 1e-6));
	return Math.min(tope, geo.area.y + necesarias * geo.altoFila + margenY);
}

/** Geometría, línea de tiempo y posición: lo mismo que calcula el componente (las pruebas lo usan para comparar). */
export function prepararTerminal(a: AjustesTerminal): TerminalPreparada {
	const d = TERMINAL_POR_DEFECTO;
	const ancho = a.ancho ?? d.ancho;
	const alto = a.alto ?? d.alto;
	const modo = a.modo ?? 'terminal';
	const geo = geometriaTerminal({ancho, alto, tamanoLetra: a.tamanoLetra ?? d.tamanoLetra});
	const directorio = a.directorio ?? null;
	const lt = lineaDeTiempoDe(a, geo);
	const retraso = a.retraso ?? d.retraso;
	return {
		geo,
		lt,
		x: a.x ?? (1080 - ancho) / 2,
		y: a.y ?? (1920 - alto) / 2,
		retraso,
		titulo: a.titulo ?? `${modo === 'claude-code' ? 'claude' : 'zsh'}${directorio ? ` — ${directorio}` : ''}`,
		duracion: retraso + lt.duracion,
	};
}

/** Ajustes del componente a partir de un archivo de demo ya validado (DemoTerminalEsquema). */
export function ajustesDeDemo(demo: DemoTerminal): AjustesTerminal {
	return {
		guion: demo.guion,
		modo: demo.modo,
		titulo: demo.titulo,
		directorio: demo.directorio ?? null,
		encabezado: demo.encabezado,
		textos: demo.textos,
		pausas: demo.pausas,
		tamanoLetra: demo.tamano_letra,
		semilla: demo.semilla,
		retraso: demo.retraso_s,
	};
}

/** Segundos de cada tecla y de cada enter (para poner sonido de teclado si el director lo pide). */
export function tiemposDeTeclas(lt: LineaDeTiempo): Array<{t: number; tipo: 'tecla' | 'enter'}> {
	const lista: Array<{t: number; tipo: 'tecla' | 'enter'}> = [];
	for (const c of lt.comandos) {
		for (const t of c.tiempos) lista.push({t, tipo: 'tecla'});
		lista.push({t: c.enter, tipo: 'enter'});
	}
	return lista.sort((a, b) => a.t - b.t);
}
