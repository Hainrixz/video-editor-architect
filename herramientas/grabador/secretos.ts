/**
 * Enmascarado y revisión de secretos de las demos de pantalla (Fase 5).
 *
 * 1) Blur ANTES de grabar: `scriptOcultar()` es un init script (context.addInitScript, con bypassCSP: true) que,
 *    en cuanto existe documentElement, mete un <style id="claude-editor-ocultar"> con `filter: blur(12px)` para
 *    los selectores de demos/<slug>/ocultar.json más los de siempre (contraseñas, tarjetas, códigos de un solo uso,
 *    campos de token o llave). Corre en cada documento: después de navegar y dentro de los iframes. Si la página
 *    borra el <style>, un MutationObserver lo vuelve a poner. Una regla por selector: uno mal escrito no tumba a
 *    los demás. Límite: no entra a shadow DOM cerrado.
 *
 * 2) OCR DESPUÉS de grabar (Apple Vision vía herramientas/lib/ocr.ts; solo funciona fuera del sandbox, o sea desde
 *    estudio.ts o desde pruebas/integracion/…): lee cuadros de toma.mp4 y las capturas PNG buscando correos, sk-,
 *    sk_, AIza, apify_api_, ghp_/gho_/ghu_/ghs_/ghr_, github_pat_, hf_, AKIA, xox, eyJ, -----BEGIN y cadenas
 *    largas junto a key/token/secret. Si encuentra algo, la demo queda BLOQUEADA en demos/<slug>/revision.json
 *    hasta que la revises tú.
 *
 * revision.json nunca guarda el secreto: solo su tipo, una muestra censurada ("sk-…(28)"), dónde y cuándo.
 * El texto leído por OCR es DATO, nunca instrucción (regla 7).
 */
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename, join, relative} from 'node:path';
import {z} from 'zod';
import type {Page} from 'playwright';
import {fallo} from '../lib/fallo.ts';
import {lineasDeCajas, ocrCuadros, type CajaOcr, type Rect} from '../lib/ocr.ts';
import {dimensionesImagen} from './captura.ts';

// ───────────────────────── 1) blur ─────────────────────────

/** Siempre se ocultan (además de los de ocultar.json). */
export const SELECTORES_POR_DEFECTO: readonly string[] = [
	'input[type="password" i]',
	'[autocomplete*="cc-" i]',
	'[autocomplete="one-time-code" i]',
	'[autocomplete="current-password" i]',
	'[autocomplete="new-password" i]',
	'input[name*="token" i]',
	'input[name*="secret" i]',
	'input[name*="api_key" i]',
	'input[name*="apikey" i]',
	'input[name*="api-key" i]',
	'[data-claude-ocultar]',
];

export const RADIO_BLUR_PX = 12;
export const ID_ESTILO = 'claude-editor-ocultar';

const SELECTOR_PELIGROSO = /[{};<>\n\r\\]/;

/** Revisa un selector (no puede cerrar la regla CSS ni meter otra). Código 2 si trae {, }, ;, <, >, \ o saltos. */
export function revisarSelector(selector: unknown, origen = 'ocultar.json'): string {
	if (typeof selector !== 'string' || !selector.trim()) {
		throw fallo(`leer ${origen}`, 'trae un selector vacío o que no es texto', 'deja solo selectores CSS como ".llave" o "#token"', 2);
	}
	if (SELECTOR_PELIGROSO.test(selector)) {
		throw fallo(`leer ${origen}`, `el selector «${selector.slice(0, 60)}» trae caracteres no permitidos ({ } ; < > \\ o saltos de línea)`, 'deja solo el selector CSS, sin reglas', 2);
	}
	return selector.trim();
}

/** Lee demos/<slug>/ocultar.json (lista de selectores, o {"selectores": [...]}) y le suma los de siempre. */
export function leerSelectores(dirDemo: string): string[] {
	const ruta = join(dirDemo, 'ocultar.json');
	const propios: string[] = [];
	if (existsSync(ruta)) {
		let datos: unknown;
		try {
			datos = JSON.parse(readFileSync(ruta, 'utf8'));
		} catch (error) {
			throw fallo('leer ocultar.json', `${ruta} no es JSON válido`, 'escríbelo como ["#selector", ".otro"]', 2, error);
		}
		const lista = Array.isArray(datos) ? datos : (datos as {selectores?: unknown})?.selectores;
		if (!Array.isArray(lista)) throw fallo('leer ocultar.json', 'no es una lista de selectores', 'escríbelo como ["#selector", ".otro"]', 2);
		for (const s of lista) propios.push(revisarSelector(s));
	}
	return [...new Set([...SELECTORES_POR_DEFECTO, ...propios])];
}

/** Init script del blur (texto de JS para context.addInitScript). Una regla por selector. */
export function scriptOcultar(selectores: readonly string[], radioPx = RADIO_BLUR_PX): string {
	const reglas = selectores.map((s) => `${revisarSelector(s, 'la lista de selectores')}{filter:blur(${radioPx}px) !important;}`).join('\n');
	return `(() => {
	const ID = ${JSON.stringify(ID_ESTILO)};
	const CSS = ${JSON.stringify(reglas)};
	const poner = () => {
		const raiz = document.documentElement;
		if (!raiz || document.getElementById(ID)) return;
		const estilo = document.createElement('style');
		estilo.id = ID;
		estilo.textContent = CSS;
		(document.head || raiz).appendChild(estilo);
	};
	poner();
	new MutationObserver(poner).observe(document, {childList: true, subtree: true});
})();`;
}

export type EstadoOcultoMarco = {url: string; estilo: boolean; coinciden: number; borrosos: number};

/**
 * Revisa en cada marco de la página (principal e iframes) que el <style> esté y que todo elemento que coincide
 * con los selectores tenga el blur aplicado. Sirve para las pruebas y como chequeo después de navegar.
 */
export async function revisarOcultos(pagina: Page, selectores: readonly string[]): Promise<EstadoOcultoMarco[]> {
	const salida: EstadoOcultoMarco[] = [];
	for (const marco of pagina.frames()) {
		const r = await marco
			.evaluate(
				({sels, id}) => {
					let coinciden = 0;
					let borrosos = 0;
					for (const s of sels) {
						let lista: NodeListOf<Element>;
						try {
							lista = document.querySelectorAll(s);
						} catch {
							continue;
						}
						for (const el of Array.from(lista)) {
							coinciden++;
							if (/blur\(/.test(getComputedStyle(el).filter)) borrosos++;
						}
					}
					return {url: location.href, estilo: !!document.getElementById(id), coinciden, borrosos};
				},
				{sels: [...selectores], id: ID_ESTILO},
			)
			.catch(() => null);
		if (r) salida.push(r);
	}
	return salida;
}

// ───────────────────────── 2) patrones de secretos ─────────────────────────

export type Coincidencia = {tipo: string; valor: string; inicio: number; fin: number};

type Patron = {tipo: string; re: RegExp; descartar?: (valor: string) => boolean};

/** Correos públicos que no son de nadie (remotos SSH, noreply). Lista corta y explícita. */
const CORREOS_PUBLICOS = /^(?:git@(?:github\.com|gitlab\.com|bitbucket\.org)|(?:no-?reply)@github\.com|[^@]+@users\.noreply\.github\.com)$/i;

export const PATRONES: readonly Patron[] = [
	{tipo: 'correo', re: /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g, descartar: (v) => CORREOS_PUBLICOS.test(v)},
	{tipo: 'llave sk-', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/g},
	{tipo: 'llave sk_', re: /(?<![A-Za-z0-9])sk_[A-Za-z0-9_]{8,}/g},
	{tipo: 'llave de Google (AIza)', re: /AIza[0-9A-Za-z_-]{20,}/g},
	{tipo: 'token de Apify', re: /apify_api_[A-Za-z0-9]{8,}/g},
	{tipo: 'token de GitHub (gh*_)', re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{12,}/g},
	{tipo: 'token de GitHub (github_pat_)', re: /github_pat_[A-Za-z0-9_]{12,}/g},
	{tipo: 'token de Hugging Face (hf_)', re: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{12,}/g},
	{tipo: 'llave de AWS (AKIA)', re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{12,}/g},
	{tipo: 'token de Slack (xox)', re: /(?<![A-Za-z0-9])xox[abeoprs]-[A-Za-z0-9-]{6,}/g},
	{tipo: 'JWT (eyJ)', re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}/g},
	{tipo: 'llave privada (BEGIN)', re: /-{3,}\s*BEGIN\b(?:[ ][A-Z]+)*/g},
];

/** Palabras que anuncian un secreto cerca. */
export const ETIQUETA_SECRETO = /(?<![A-Za-z0-9])(?:api[\s_-]?key|apikey|access[\s_-]?key|secret[\s_-]?key|private[\s_-]?key|key|keys|token|tokens|secret|secrets|secreto|clave|password|passwd|contraseña|bearer|authorization|credential|credencial)(?![A-Za-z0-9])/i;

const VALOR_LARGO = /(?<![A-Za-z0-9_\-+/=.])[A-Za-z0-9_\-+/=.]{24,}(?![A-Za-z0-9_\-+/=.])/g;

/** ¿Una cadena larga parece un secreto (y no una URL, ruta o palabra)? */
export function pareceSecreto(valor: string): boolean {
	if (/^(?:https?|ftp):|:\/\/|^www\./i.test(valor)) return false;
	if ((valor.match(/\//g) ?? []).length > 1) return false;
	if (/\.(?:com|org|net|io|dev|md|js|ts|json|html|png|jpg|git)$/i.test(valor)) return false;
	if (!/[A-Za-z]/.test(valor) || !/\d/.test(valor)) return false;
	return new Set(valor).size >= 10;
}

/**
 * Texto de OCR → texto para buscar: guiones raros a "-", sin caracteres de ancho cero, y un guion seguido de espacio
 * se pega ("sk- ant" → "sk-ant"). No se pegan espacios alrededor de "@" ni "_": el ícono de enlace de GitHub se lee
 * como "@" y pegaba palabras de columnas distintas ("last week @latent-spaces.github.io" no es un correo).
 */
export function normalizarOcr(texto: string): string {
	return texto
		.normalize('NFKC')
		.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
		.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
		.replace(/([A-Za-z0-9])-\s+(?=[A-Za-z0-9])/g, '$1-');
}

/** Busca secretos en un texto (puro). No incluye la regla de "cadena larga junto a key/token/secret". */
export function buscarSecretos(texto: string): Coincidencia[] {
	const t = normalizarOcr(texto);
	const salida: Coincidencia[] = [];
	for (const p of PATRONES) {
		p.re.lastIndex = 0;
		for (const m of t.matchAll(p.re)) {
			if (p.descartar?.(m[0])) continue;
			salida.push({tipo: p.tipo, valor: m[0], inicio: m.index ?? 0, fin: (m.index ?? 0) + m[0].length});
		}
	}
	return salida;
}

/** Cadenas largas con pinta de secreto en un texto que trae (o tiene al lado) una etiqueta key/token/secret. */
export function buscarJuntoAEtiqueta(texto: string, etiquetaCerca = false): Coincidencia[] {
	const t = normalizarOcr(texto);
	if (!etiquetaCerca && !ETIQUETA_SECRETO.test(t)) return [];
	const salida: Coincidencia[] = [];
	for (const m of t.matchAll(VALOR_LARGO)) {
		if (pareceSecreto(m[0])) salida.push({tipo: 'cadena larga junto a key/token/secret', valor: m[0], inicio: m.index ?? 0, fin: (m.index ?? 0) + m[0].length});
	}
	return salida;
}

/** Muestra censurada para reportes: los 3 primeros caracteres y el largo ("sk-…(28)"). Nunca el valor completo. */
export function censurar(valor: string): string {
	const v = [...valor];
	return `${v.slice(0, Math.min(3, Math.max(1, v.length - 4))).join('')}…(${v.length})`;
}

export type HallazgoCuadro = {tipo: string; muestra: string; caja: Rect; huella: string};

/**
 * Huella para unir lecturas del mismo secreto dentro de una corrida. Es un HMAC con una sal aleatoria de este
 * proceso: no sirve para adivinar el valor (ni siquiera un correo) fuera de esta corrida.
 */
const SAL = randomBytes(32);
const huella = (tipo: string, valor: string) => createHmac('sha256', SAL).update(`${tipo}\u0000${valor}`).digest('hex').slice(0, 16);

/** Un tramo de texto: cajas de la misma línea que están cerca (una frase, un campo, un token partido). */
export type TramoTexto = {texto: string; caja: Rect};

/**
 * Cajas de OCR → tramos de texto (puro). Misma línea = se enciman en vertical. Dentro de la línea, dos cajas casi
 * pegadas (hueco < 0.3 × alto: Vision partió un token) se unen sin espacio; hasta 2 × alto, con espacio; más lejos
 * son tramos distintos (otra columna de la interfaz). `aspecto` = ancho / alto del cuadro (las cajas vienen
 * normalizadas a cada eje y el hueco se compara en píxeles).
 */
export function tramosDeTexto(cajas: readonly CajaOcr[], aspecto = 16 / 10): TramoTexto[] {
	const salida: TramoTexto[] = [];
	for (const linea of lineasDeCajas([...cajas])) {
		let actual: {texto: string; x0: number; y0: number; x1: number; y1: number} | null = null;
		let anterior: CajaOcr | null = null;
		const cerrar = () => {
			if (actual) salida.push({texto: actual.texto, caja: {x: actual.x0, y: actual.y0, w: actual.x1 - actual.x0, h: actual.y1 - actual.y0}});
		};
		for (const c of linea.cajas) {
			const texto = c.texto.trim();
			if (actual && anterior) {
				const alto = Math.max(c.h, anterior.h);
				const hueco = ((c.x - (anterior.x + anterior.w)) * aspecto) / Math.max(alto, 1e-9); // en altos de letra
				if (hueco <= 2) {
					actual.texto += (hueco < 0.3 ? '' : ' ') + texto;
					actual.x0 = Math.min(actual.x0, c.x);
					actual.y0 = Math.min(actual.y0, c.y);
					actual.x1 = Math.max(actual.x1, c.x + c.w);
					actual.y1 = Math.max(actual.y1, c.y + c.h);
					anterior = c;
					continue;
				}
			}
			cerrar();
			actual = {texto, x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h};
			anterior = c;
		}
		cerrar();
	}
	return salida;
}

/**
 * Secretos en las cajas de OCR de UN cuadro (puro): por caja, por tramo de texto (cajas cercanas unidas) y por
 * cercanía de una etiqueta key/token/secret (en el mismo tramo, a la derecha en la misma línea hasta 8 altos de
 * letra, o en el tramo de abajo). Cajas normalizadas 0–1. Cada hallazgo trae una huella para unir lecturas del
 * mismo secreto entre cuadros sin guardarlo.
 */
export function hallazgosEnCuadro(cajas: readonly CajaOcr[], aspecto = 16 / 10): HallazgoCuadro[] {
	const vistos = new Map<string, HallazgoCuadro>();
	const agregar = (c: Coincidencia, caja: Rect) => {
		const h = huella(c.tipo, c.valor);
		// Solo la geometría: la caja de OCR trae el texto leído (el secreto) y no debe salir de aquí.
		if (!vistos.has(h)) vistos.set(h, {tipo: c.tipo, muestra: censurar(c.valor), caja: {x: caja.x, y: caja.y, w: caja.w, h: caja.h}, huella: h});
	};
	for (const caja of cajas) for (const c of buscarSecretos(caja.texto)) agregar(c, caja);
	const tramos = tramosDeTexto(cajas, aspecto);
	for (const t of tramos) for (const c of buscarSecretos(t.texto)) agregar(c, t.caja);
	for (const t of tramos) {
		if (!ETIQUETA_SECRETO.test(normalizarOcr(t.texto))) continue;
		for (const c of buscarJuntoAEtiqueta(t.texto, true)) agregar(c, t.caja);
		for (const o of tramos) {
			if (o === t) continue;
			const alto = Math.max(t.caja.h, o.caja.h);
			const mismaLinea = Math.min(t.caja.y + t.caja.h, o.caja.y + o.caja.h) - Math.max(t.caja.y, o.caja.y) > 0.5 * Math.min(t.caja.h, o.caja.h);
			const aLaDerecha = mismaLinea && o.caja.x >= t.caja.x + t.caja.w && ((o.caja.x - (t.caja.x + t.caja.w)) * aspecto) / alto <= 8;
			const hueco = o.caja.y - (t.caja.y + t.caja.h);
			const encima = Math.min(t.caja.x + t.caja.w, o.caja.x + o.caja.w) - Math.max(t.caja.x, o.caja.x);
			const abajo = hueco >= -0.25 * alto && hueco <= 2.5 * alto && encima > 0 && !mismaLinea;
			if (aLaDerecha || abajo) for (const c of buscarJuntoAEtiqueta(o.texto, true)) agregar(c, o.caja);
		}
	}
	return [...vistos.values()];
}

// ───────────────────────── 3) OCR de tomas y capturas ─────────────────────────

/** Alto mínimo del texto que lee Vision, como fracción del alto del cuadro (≈ 10 px en 1600; Vision usa 1/32). */
export const OCR_MIN_ALTO = 0.006;
/** Se lee un cuadro de cada 5 de la toma (6 por segundo): un secreto visible ≥ 170 ms cae en al menos una lectura. */
export const OCR_PASO = 5;

export type Hallazgo = {
	archivo: string;
	tipo: string;
	muestra: string;
	huella: string;
	/** Primer cuadro y segundo (en la toma) donde se vio; null en una imagen. */
	cuadro: number | null;
	t: number | null;
	/** En cuántos cuadros leídos apareció. */
	lecturas: number;
	/** Caja en px del archivo. */
	caja: {x: number; y: number; w: number; h: number};
};

function aPx(c: Rect, ancho: number, alto: number) {
	const r = (v: number) => Math.round(v * 10) / 10;
	return {x: r(c.x * ancho), y: r(c.y * alto), w: r(c.w * ancho), h: r(c.h * alto)};
}

/** Une hallazgos del mismo secreto en distintos cuadros: se queda el primero y cuenta las lecturas. */
function unirHallazgos(lista: Hallazgo[]): Hallazgo[] {
	const porHuella = new Map<string, Hallazgo>();
	for (const h of lista) {
		const previo = porHuella.get(h.huella);
		if (previo) previo.lecturas += h.lecturas;
		else porHuella.set(h.huella, {...h});
	}
	return [...porHuella.values()].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

export type ResultadoEscaneo = {archivo: string; leidos: number; paso: number | null; hallazgos: Hallazgo[]; segundos: number};

/** OCR de un video CFR (toma.mp4): un cuadro de cada `paso`. Fuera del sandbox. */
export async function escanearVideo(ruta: string, op: {ancho: number; alto: number; fps: number; totalCuadros: number; paso?: number; nombre?: string}): Promise<ResultadoEscaneo> {
	const paso = op.paso ?? OCR_PASO;
	const r = await ocrCuadros({video: ruta, ancho: op.ancho, alto: op.alto, fps: op.fps, totalCuadros: op.totalCuadros, seleccion: {tipo: 'paso', paso}, modo: 'accurate', minAlto: OCR_MIN_ALTO, hilos: 4});
	const archivo = op.nombre ?? basename(ruta);
	const hallazgos: Hallazgo[] = [];
	for (const c of r.cuadros) {
		for (const h of hallazgosEnCuadro(c.cajas, op.ancho / op.alto)) {
			hallazgos.push({archivo, tipo: h.tipo, muestra: h.muestra, huella: h.huella, cuadro: c.n, t: Math.round(c.t * 1000) / 1000, lecturas: 1, caja: aPx(h.caja, op.ancho, op.alto)});
		}
	}
	return {archivo, leidos: r.cuadros.length, paso, hallazgos: unirHallazgos(hallazgos), segundos: r.segundos};
}

/** OCR de una imagen (PNG o JPEG). Fuera del sandbox. Devuelve también las cajas en px (para tapar). */
export async function escanearImagen(ruta: string, nombre?: string): Promise<ResultadoEscaneo> {
	const {ancho, alto} = dimensionesImagen(readFileSync(ruta));
	const r = await ocrCuadros({video: ruta, ancho, alto, fps: 1, totalCuadros: 1, seleccion: {tipo: 'paso', paso: 1}, modo: 'accurate', minAlto: OCR_MIN_ALTO, hilos: 1});
	const archivo = nombre ?? basename(ruta);
	const hallazgos: Hallazgo[] = [];
	for (const c of r.cuadros) {
		for (const h of hallazgosEnCuadro(c.cajas, ancho / alto)) {
			hallazgos.push({archivo, tipo: h.tipo, muestra: h.muestra, huella: h.huella, cuadro: null, t: null, lecturas: 1, caja: aPx(h.caja, ancho, alto)});
		}
	}
	return {archivo, leidos: r.cuadros.length, paso: null, hallazgos: unirHallazgos(hallazgos), segundos: r.segundos};
}

/**
 * Tapa con negro las cajas de los hallazgos en un PNG (para los PNG que Claude mira con `explorar`: así Claude
 * no ve el secreto). Sobrescribe el PNG que el mismo estudio acaba de generar (se puede regenerar).
 */
export function taparEnPng(ruta: string, cajas: ReadonlyArray<{x: number; y: number; w: number; h: number}>): void {
	if (cajas.length === 0) return;
	const margen = 6;
	const filtros = cajas
		.map((c) => `drawbox=x=${Math.max(0, Math.floor(c.x - margen))}:y=${Math.max(0, Math.floor(c.y - margen))}:w=${Math.ceil(c.w + 2 * margen)}:h=${Math.ceil(c.h + 2 * margen)}:color=black@1:t=fill`)
		.join(',');
	const tmp = `${ruta}.tapando.png`;
	const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', ruta, '-vf', filtros, '-frames:v', '1', tmp], {encoding: 'utf8'});
	if (r.status !== 0) throw fallo('tapar el secreto en la captura', `ffmpeg salió con ${r.status}`, 'borra esa captura y no la abras; avísame', 1, r.stderr);
	renameSync(tmp, ruta);
}

// ───────────────────────── 4) revision.json ─────────────────────────

export const ESTADOS_REVISION = ['LIMPIA', 'BLOQUEADA', 'APROBADA'] as const;
export type EstadoRevision = (typeof ESTADOS_REVISION)[number];

const FuenteRevision = z.object({
	archivo: z.string(),
	sha256: z.string(),
	leidos: z.number().int().nonnegative(),
	paso: z.number().int().positive().nullable(),
	escaneado_en: z.string(),
	/** Problemas que no son un texto leído pero obligan a revisar (p. ej. un iframe al que no llegó el blur). */
	avisos: z.array(z.string()).default([]),
	hallazgos: z.array(
		z.object({
			archivo: z.string(),
			tipo: z.string(),
			muestra: z.string(),
			huella: z.string(),
			cuadro: z.number().int().nullable(),
			t: z.number().nullable(),
			lecturas: z.number().int().positive(),
			caja: z.object({x: z.number(), y: z.number(), w: z.number(), h: z.number()}),
		}),
	),
});

export const Revision = z.object({
	version: z.literal(1),
	estado: z.enum(ESTADOS_REVISION),
	motivo: z.string(),
	revisado_por: z.string().nullable(),
	revisado_en: z.string().nullable(),
	/** sha256 de cada archivo con hallazgos cuando lo aprobaste: si el archivo cambia, se vuelve a bloquear. */
	aprobado_sha256: z.record(z.string(), z.string()),
	fuentes: z.array(FuenteRevision),
	como_aprobar: z.string(),
});
export type Revision = z.infer<typeof Revision>;

export const COMO_APROBAR =
	'Mira los cuadros y capturas de "hallazgos". Si no hay nada privado, corre tú (no Claude): npx tsx herramientas/grabador/estudio.ts revision <slug> --aprobar';

export function rutaRevision(dirDemo: string): string {
	return join(dirDemo, 'revision.json');
}

export function sha256De(ruta: string): string {
	return createHash('sha256').update(readFileSync(ruta)).digest('hex');
}

export function leerRevision(dirDemo: string): Revision | null {
	const ruta = rutaRevision(dirDemo);
	if (!existsSync(ruta)) return null;
	let datos: unknown;
	try {
		datos = JSON.parse(readFileSync(ruta, 'utf8'));
	} catch (error) {
		throw fallo('leer revision.json', `${ruta} no es JSON válido`, 'vuelve a grabar o escanear la demo', 2, error);
	}
	const r = Revision.safeParse(datos);
	if (!r.success) throw fallo('leer revision.json', `${ruta} no cumple el formato`, 'vuelve a grabar o escanear la demo', 2, r.error.issues);
	return r.data;
}

/**
 * Estado a partir de los escaneos (puro): LIMPIA si nada tiene hallazgos ni avisos; APROBADA si todo lo que tiene
 * hallazgos lo aprobaste con ese mismo sha256; si no, BLOQUEADA (con la lista de lo que falta revisar).
 */
function calcularEstado(fuentes: Revision['fuentes'], aprobados: Record<string, string>): {estado: EstadoRevision; motivo: string} {
	const conHallazgos = fuentes.filter((f) => f.hallazgos.length > 0 || f.avisos.length > 0);
	if (conHallazgos.length === 0) return {estado: 'LIMPIA', motivo: `OCR sin hallazgos en ${fuentes.length} archivo(s)`};
	const sinAprobar = conHallazgos.filter((f) => aprobados[f.archivo] !== f.sha256);
	const contar = (lista: typeof fuentes) => lista.reduce((s, f) => s + f.hallazgos.length + f.avisos.length, 0);
	const tipos = (lista: typeof fuentes) => [...new Set(lista.flatMap((f) => [...f.hallazgos.map((h) => h.tipo), ...f.avisos]))].join(', ');
	if (sinAprobar.length === 0) return {estado: 'APROBADA', motivo: `${contar(conHallazgos)} hallazgo(s) (${tipos(conHallazgos)}) revisados y aprobados por ti`};
	return {estado: 'BLOQUEADA', motivo: `OCR encontró ${contar(sinAprobar)} posible(s) secreto(s) (${tipos(sinAprobar)}) en ${sinAprobar.map((f) => f.archivo).join(', ')}`};
}

/**
 * Registra el escaneo de un archivo en revision.json (reemplaza el escaneo anterior del mismo archivo) y recalcula
 * el estado. Un archivo nuevo con hallazgos bloquea aunque antes estuviera aprobada.
 */
export function registrarEscaneo(dirDemo: string, escaneo: ResultadoEscaneo, rutaArchivo: string, avisos: readonly string[] = []): Revision {
	const previa = leerRevision(dirDemo);
	const archivo = relative(dirDemo, rutaArchivo) || basename(rutaArchivo);
	const fuente = {
		archivo,
		sha256: sha256De(rutaArchivo),
		leidos: escaneo.leidos,
		paso: escaneo.paso,
		escaneado_en: new Date().toISOString(),
		avisos: [...new Set(avisos)],
		hallazgos: escaneo.hallazgos.map((h) => ({...h, archivo})),
	};
	// Se quitan los escaneos de archivos que ya no existen (no se pueden usar) y el del mismo archivo (se reemplaza).
	const fuentes = [...(previa?.fuentes ?? []).filter((f) => f.archivo !== archivo && existsSync(join(dirDemo, f.archivo))), fuente];
	// Una aprobación vale solo para el archivo con el sha256 que aprobaste.
	const aprobados = Object.fromEntries(Object.entries(previa?.aprobado_sha256 ?? {}).filter(([a, sha]) => fuentes.some((f) => f.archivo === a && f.sha256 === sha)));
	const {estado, motivo} = calcularEstado(fuentes, aprobados);
	const revision: Revision = {
		version: 1,
		estado,
		motivo,
		revisado_por: estado === 'APROBADA' ? (previa?.revisado_por ?? null) : null,
		revisado_en: estado === 'APROBADA' ? (previa?.revisado_en ?? null) : null,
		aprobado_sha256: aprobados,
		fuentes,
		como_aprobar: COMO_APROBAR,
	};
	writeFileSync(rutaRevision(dirDemo), `${JSON.stringify(revision, null, '\t')}\n`);
	return revision;
}

/**
 * Aprobación del creador: fija el sha256 de cada archivo con hallazgos. Si un archivo cambia, se vuelve a bloquear.
 * No aprueba si algo cambió desde el escaneo o si hay una toma o captura sin escanear (código 2).
 */
export function aprobarRevision(dirDemo: string, quien = 'creador'): Revision {
	const r = leerRevision(dirDemo);
	if (!r) throw fallo('aprobar la revisión', 'la demo no tiene revision.json', 'graba o escanea la demo primero', 2);
	const vigente = estadoRevision(dirDemo);
	if (vigente.estado === 'BLOQUEADA' && /cambió|sin escanear/.test(vigente.motivo)) {
		throw fallo('aprobar la revisión', vigente.motivo, 'vuelve a grabar o escanear antes de aprobar', 2);
	}
	const fuentes = r.fuentes.filter((f) => existsSync(join(dirDemo, f.archivo)));
	const aprobados: Record<string, string> = {};
	for (const f of fuentes) if (f.hallazgos.length > 0 || f.avisos.length > 0) aprobados[f.archivo] = f.sha256;
	const {estado, motivo} = calcularEstado(fuentes, aprobados);
	const revision: Revision = {...r, fuentes, estado, motivo: estado === 'APROBADA' ? motivo.replace('por ti', `por ${quien}`) : motivo, revisado_por: quien, revisado_en: new Date().toISOString(), aprobado_sha256: aprobados};
	writeFileSync(rutaRevision(dirDemo), `${JSON.stringify(revision, null, '\t')}\n`);
	return revision;
}

/**
 * Estado vigente de la demo, recalculado con lo que hay en disco:
 *   - un archivo escaneado que cambió desde el escaneo → BLOQUEADA (hay que volver a escanear);
 *   - toma.mp4 o una captura (capturas/*.png, salvo las explorar-*.png, que son solo para que Claude mire y ya salen
 *     con lo sospechoso tapado) que existe y nunca se escaneó → BLOQUEADA;
 *   - un escaneo de un archivo que ya no existe no cuenta (ese archivo no se puede usar);
 *   - sin revision.json → BLOQUEADA: nada entra sin escanear.
 */
export function estadoRevision(dirDemo: string): {estado: EstadoRevision; motivo: string} {
	const r = leerRevision(dirDemo);
	if (!r) return {estado: 'BLOQUEADA', motivo: 'la demo no tiene revision.json (no se escaneó)'};
	const presentes = r.fuentes.filter((f) => existsSync(join(dirDemo, f.archivo)));
	for (const f of presentes) {
		if (sha256De(join(dirDemo, f.archivo)) !== f.sha256) return {estado: 'BLOQUEADA', motivo: `${f.archivo} cambió desde el escaneo`};
	}
	const escaneados = new Set(presentes.map((f) => f.archivo));
	const usables = [
		...(existsSync(join(dirDemo, 'toma.mp4')) ? ['toma.mp4'] : []),
		...(existsSync(join(dirDemo, 'capturas'))
			? readdirSync(join(dirDemo, 'capturas'))
					.filter((n) => /\.(png|jpe?g)$/i.test(n) && !n.startsWith('explorar-'))
					.map((n) => join('capturas', n))
			: []),
	];
	const sinEscanear = usables.filter((a) => !escaneados.has(a));
	if (sinEscanear.length) return {estado: 'BLOQUEADA', motivo: `${sinEscanear.join(', ')} sin escanear`};
	return calcularEstado(presentes, r.aprobado_sha256);
}

/** ¿La demo puede entrar a un reel? Solo LIMPIA o APROBADA (lo usa quien arme o valide el EDL). */
export function demoUsable(dirDemo: string): boolean {
	const {estado} = estadoRevision(dirDemo);
	return estado === 'LIMPIA' || estado === 'APROBADA';
}
