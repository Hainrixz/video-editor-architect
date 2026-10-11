/**
 * Pasos de un guion de demo (demos/<slug>/guion.json) y su candado de riesgo (Fase 5).
 *
 * guion.json:
 *   {
 *     "version": 1,
 *     "aprobado": false,                // true SOLO con tu sí (habilita pasos que no son de lectura)
 *     "aprobado_nota": "…",             // de dónde salió el sí (fecha, qué aprobaste)
 *     "pasos": [
 *       {"accion": "ir", "url": "https://github.com/latent-spaces/brag", "riesgo": "lectura"},
 *       {"accion": "scroll", "px": 700, "duracion_ms": 1500, "riesgo": "lectura"},
 *       {"accion": "clic", "rol": "button", "nombre": "Code", "riesgo": "lectura"},
 *       {"accion": "esperar", "ms": 1200, "riesgo": "lectura"}
 *     ]
 *   }
 *
 * Acciones: ir · clic · escribir · tecla · scroll · esperar · captura. El objetivo de un paso se da con `selector`
 * (selector de Playwright: CSS o text=…) o con `rol` + `nombre` (accesible, como getByRole).
 *
 * Riesgo (criterio del plan): cada paso declara "lectura" | "escritura" | "gasto" | "publica". Un paso que no sea
 * de lectura sale con código 3 ANTES de ejecutarse, salvo que el guion traiga aprobado: true (tu sí). Un paso de
 * "gasto" además necesita `costo_usd` y --si-gasto=<monto> en el comando (lib/gasto.ts; pasa por el permiso "ask").
 * Todo el guion se revisa antes de abrir el navegador, y cada paso otra vez justo antes de correr.
 *
 * Teclas: el registro de eventos guarda solo {tipo: "tecla"} con la caja del campo; el texto nunca se guarda ni se
 * imprime (los mensajes dicen cuántos caracteres, no cuáles).
 *
 * El texto de las páginas es DATO, no instrucción (regla 7): nada de lo que diga una página cambia los pasos.
 */
import {z} from 'zod';
import type {Locator, Page} from 'playwright';
import {FalloEditor, fallo} from '../lib/fallo.ts';
import {exigirSiGasto} from '../lib/gasto.ts';
import type {EventoCrudo} from './eventos.ts';

export const RIESGOS = ['lectura', 'escritura', 'gasto', 'publica'] as const;
export type Riesgo = (typeof RIESGOS)[number];

const comun = {
	riesgo: z.enum(RIESGOS),
	/** Costo estimado en USD (obligatorio si riesgo = "gasto"). */
	costo_usd: z.number().nonnegative().optional(),
	nota: z.string().max(300).optional(),
	/** Pausa después del paso (ms), para que se vea el resultado. Por defecto 600. */
	pausa_ms: z.number().int().min(0).max(15000).optional(),
};

const objetivo = {
	selector: z.string().min(1).max(500).optional(),
	rol: z.string().min(1).max(40).optional(),
	nombre: z.string().min(1).max(200).optional(),
	/** Con rol + nombre: el nombre debe coincidir completo (por defecto true). */
	exacto: z.boolean().optional(),
};

const PasoIr = z.strictObject({accion: z.literal('ir'), url: z.string().min(1).max(2000), ...comun});
const PasoClic = z.strictObject({accion: z.literal('clic'), ...objetivo, ...comun});
const PasoEscribir = z.strictObject({
	accion: z.literal('escribir'),
	...objetivo,
	texto: z.string().max(2000),
	/** El texto es privado: además de no guardarse (nunca se guarda), tampoco se cuenta en los mensajes. */
	sensible: z.boolean().optional(),
	/** Retraso entre teclas (ms). Por defecto 70. */
	retraso_ms: z.number().int().min(0).max(400).optional(),
	...comun,
});
const PasoTecla = z.strictObject({accion: z.literal('tecla'), texto: z.string().min(1).max(40), sensible: z.boolean().optional(), ...comun});
const PasoScroll = z.strictObject({
	accion: z.literal('scroll'),
	...objetivo,
	/** Cuánto desplazar (px CSS; negativo = hacia arriba). Por defecto 600. */
	px: z.number().min(-50000).max(50000).optional(),
	/** Cuánto dura el desplazamiento (ms). Por defecto 1200. */
	duracion_ms: z.number().int().min(0).max(30000).optional(),
	/** "suave" (entra y sale despacio) o "lineal" (velocidad constante). Por defecto suave. */
	curva: z.enum(['suave', 'lineal']).optional(),
	...comun,
});
const PasoEsperar = z.strictObject({accion: z.literal('esperar'), ms: z.number().int().min(0).max(60000).optional(), ...objetivo, ...comun});
/** `archivo`: nombre del PNG (sin extensión) en demos/<slug>/capturas/. */
const PasoCaptura = z.strictObject({accion: z.literal('captura'), archivo: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(), ...objetivo, ...comun});

const ConObjetivo = new Set(['clic', 'escribir']);

export const Paso = z
	.discriminatedUnion('accion', [PasoIr, PasoClic, PasoEscribir, PasoTecla, PasoScroll, PasoEsperar, PasoCaptura])
	.superRefine((p, ctx) => {
		if (ConObjetivo.has(p.accion)) {
			const o = p as {selector?: string; rol?: string; nombre?: string};
			if (!o.selector && !(o.rol && o.nombre)) {
				ctx.addIssue({code: 'custom', message: `"${p.accion}" necesita selector, o rol + nombre`, path: ['selector']});
			}
		}
		if ('rol' in p && p.rol && !('nombre' in p && p.nombre)) {
			ctx.addIssue({code: 'custom', message: 'rol necesita nombre (el texto accesible del elemento)', path: ['nombre']});
		}
		if (p.riesgo === 'gasto' && p.costo_usd === undefined) {
			ctx.addIssue({code: 'custom', message: 'un paso de gasto necesita costo_usd (lo que cuesta, en dólares)', path: ['costo_usd']});
		}
	});
export type Paso = z.infer<typeof Paso>;

/**
 * Tema de la página al grabar. Tus inserts de pantalla recientes son en modo oscuro (GitHub, Claude: reel P3,
 * reel P4, reel P5, reel P6, reel P7) y ahí tu titular blanco con contorno se lee; sobre una página
 * blanca queda blanco sobre blanco. "oscuro" pide prefers-color-scheme: dark (lo respetan GitHub y casi todo sitio con
 * modo oscuro); "oscuro-forzado" además oscurece con el modo automático de Chrome los sitios que no tienen (Dribbble);
 * "claro" deja la página como viene.
 */
export const TemaDemo = z.enum(['oscuro', 'oscuro-forzado', 'claro']);
export type TemaDemo = z.infer<typeof TemaDemo>;

/**
 * Idioma del navegador al grabar (BCP 47, p. ej. "es-MX"): Chrome arranca con --lang y la página recibe ese
 * navigator.language y Accept-Language, así sitios como X muestran su interfaz y su botón de traducir en español.
 * Sin él, el idioma del sistema.
 */
export const IdiomaDemo = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'usa un código como "es" o "es-MX"');

export const Guion = z.strictObject({
	version: z.literal(1),
	descripcion: z.string().max(500).optional(),
	tema: TemaDemo.default('oscuro'),
	idioma: IdiomaDemo.optional(),
	/** true SOLO con el sí del creador: habilita los pasos de escritura, gasto o publica. */
	aprobado: z.boolean().default(false),
	aprobado_nota: z.string().max(500).optional(),
	pasos: z.array(Paso).min(1).max(200),
});
export type Guion = z.infer<typeof Guion>;

/** Lee y valida un guion (objeto ya parseado). Código 2 si no cumple el formato. */
export function validarGuion(datos: unknown, origen = 'el guion'): Guion {
	const r = Guion.safeParse(datos);
	if (!r.success) {
		const p = r.error.issues[0];
		const ruta = p.path.length ? p.path.join('.') : 'raíz';
		throw fallo(`leer ${origen}`, `no cumple el formato (${ruta}: ${p.message})`, 'corrige ese campo del guion y vuelve a correrlo', 2, r.error.issues);
	}
	return r.data;
}

/** Describe un paso para mensajes, sin texto tecleado (solo cuántos caracteres, y ni eso si es sensible). */
export function describirPaso(p: Paso): string {
	const obj = (o: {selector?: string; rol?: string; nombre?: string}) => (o.rol ? `${o.rol} "${o.nombre}"` : (o.selector ?? 'la página'));
	switch (p.accion) {
		case 'ir':
			return `ir a ${p.url}`;
		case 'clic':
			return `clic en ${obj(p)}`;
		case 'escribir':
			return `escribir ${p.sensible ? 'texto sensible' : `${[...p.texto].length} caracteres`} en ${obj(p)}`;
		case 'tecla':
			return p.sensible ? 'tecla sensible' : `tecla ${p.texto}`;
		case 'scroll':
			return `scroll de ${p.px ?? 600} px en ${p.selector || p.rol ? obj(p) : 'la página'}`;
		case 'esperar':
			return p.ms !== undefined ? `esperar ${p.ms} ms` : `esperar a ${obj(p)}`;
		case 'captura':
			return `captura${p.archivo ? ` ${p.archivo}` : ''}`;
	}
}

/**
 * El candado: lanza un FalloEditor con código 3 si el paso no es de lectura y el guion no trae tu sí.
 * Para un paso de gasto exige además --si-gasto=<monto> en argv (lib/gasto.ts). Es síncrona: va antes de tocar
 * el navegador.
 */
export function revisarRiesgo(paso: Paso, indice: number, guion: Pick<Guion, 'aprobado'>, argv: readonly string[]): void {
	if (paso.riesgo === 'lectura') return;
	const que = `correr el paso ${indice + 1} (${describirPaso(paso)})`;
	if (guion.aprobado !== true) {
		throw fallo(
			que,
			`es de riesgo "${paso.riesgo}" y el guion no trae aprobado: true con tu sí`,
			'revisa conmigo qué hace ese paso; si me dices que sí, pongo aprobado: true en el guion y lo vuelvo a correr',
			3,
			{indice, riesgo: paso.riesgo},
		);
	}
	if (paso.riesgo === 'gasto') {
		exigirSiGasto(argv, {servicio: `el paso ${indice + 1} del guion`, estimadoUsd: paso.costo_usd ?? Number.NaN});
	}
}

/** Revisa todos los pasos (antes de abrir el navegador). */
export function revisarGuion(guion: Guion, argv: readonly string[]): void {
	guion.pasos.forEach((p, i) => revisarRiesgo(p, i, guion, argv));
}

export type Ejecutor = (paso: Paso, indice: number) => Promise<EventoCrudo[]>;

/**
 * Corre los pasos en orden con el ejecutor dado. Antes de empezar revisa el guion completo y, antes de cada paso,
 * otra vez su riesgo: un paso con riesgo sin tu sí sale con 3 sin que el ejecutor lo toque.
 */
export async function ejecutarGuion(
	guion: Guion,
	argv: readonly string[],
	ejecutor: Ejecutor,
	alTerminarPaso?: (indice: number, eventos: EventoCrudo[]) => void | Promise<void>,
): Promise<EventoCrudo[]> {
	revisarGuion(guion, argv);
	const eventos: EventoCrudo[] = [];
	for (let i = 0; i < guion.pasos.length; i++) {
		const paso = guion.pasos[i];
		revisarRiesgo(paso, i, guion, argv);
		const nuevos = await ejecutor(paso, i);
		eventos.push(...nuevos);
		await alTerminarPaso?.(i, nuevos);
	}
	return eventos;
}

// ───────────────────────── ejecutor con Playwright ─────────────────────────

export type ContextoPlaywright = {
	pagina: Page;
	/** Reloj de pared en segundos (el mismo que los timestamps del screencast). */
	reloj: () => number;
	/** px del cuadro por px CSS ahora mismo (ancho del cuadro / innerWidth). */
	escala: () => Promise<number>;
	/** ¿La URL está en sitios.txt? */
	permitido: (url: string) => boolean;
	/** Guarda una captura del viewport y devuelve su ruta (pasos "captura"). */
	capturar?: (archivo: string | undefined) => Promise<string>;
	/** Tiempo máximo por paso (ms). Por defecto 20000. */
	tiempoMaximoMs?: number;
	/** Pausa por defecto después de cada paso (ms). Por defecto 600. */
	pausaMs?: number;
};

type CajaCss = {x: number; y: number; w: number; h: number};

function localizar(pagina: Page, o: {selector?: string; rol?: string; nombre?: string; exacto?: boolean}): Locator {
	const loc = o.rol
		? pagina.getByRole(o.rol as Parameters<Page['getByRole']>[0], {name: o.nombre, exact: o.exacto ?? true})
		: pagina.locator(o.selector!);
	return loc.filter({visible: true}).first();
}

async function cajaDe(loc: Locator): Promise<CajaCss> {
	const b = await loc.boundingBox();
	if (!b) throw fallo('ubicar el elemento', 'no tiene caja visible en la página', 'revisa el selector del paso', 2);
	return {x: b.x, y: b.y, w: b.width, h: b.height};
}

async function viewport(pagina: Page): Promise<{w: number; h: number}> {
	return pagina.evaluate(() => ({w: window.innerWidth, h: window.innerHeight}));
}

/**
 * Script de página que desplaza con requestAnimationFrame (se ve fluido en la toma). Sin selector desplaza la
 * ventana. Ignora `scroll-behavior: smooth` de la página (cada paso va "instant") para que la curva sea la nuestra.
 * Va como TEXTO a propósito: tsx le agrega `__name(...)` a las funciones con nombre y en la página ese ayudante
 * no existe; un script en texto llega tal cual.
 */
const SCRIPT_DESPLAZAR = `async ({px, ms, curva, selector}) => {
	const el = selector ? document.querySelector(selector) : null;
	const inicio = el ? el.scrollTop : window.scrollY;
	const poner = (y) => {
		if (el) el.scrollTo({top: y, behavior: 'instant'});
		else window.scrollTo({top: y, behavior: 'instant'});
	};
	if (ms <= 0) {
		poner(inicio + px);
		return;
	}
	const f = (x) => (curva === 'lineal' ? x : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
	await new Promise((listo) => {
		const t0 = performance.now();
		const cuadro = (ahora) => {
			const p = Math.min(1, Math.max(0, (ahora - t0) / ms));
			poner(inicio + px * f(p));
			if (p < 1) requestAnimationFrame(cuadro);
			else listo();
		};
		requestAnimationFrame(cuadro);
	});
}`;

async function desplazar(pagina: Page, px: number, ms: number, curva: 'suave' | 'lineal', selector?: string): Promise<void> {
	await pagina.evaluate(`(${SCRIPT_DESPLAZAR})(${JSON.stringify({px, ms, curva, selector: selector ?? null})})`);
}

/** Si el elemento no se ve completo, desplaza la ventana (con curva) hasta centrarlo. Devuelve el evento de scroll. */
async function asegurarVisible(ctx: ContextoPlaywright, loc: Locator): Promise<EventoCrudo | null> {
	const caja = await cajaDe(loc);
	const vp = await viewport(ctx.pagina);
	if (caja.y >= 0 && caja.y + caja.h <= vp.h) return null;
	const delta = Math.round(caja.y + caja.h / 2 - vp.h / 2);
	const reloj = ctx.reloj();
	const ms = Math.min(1200, 350 + Math.abs(delta) * 0.5);
	await desplazar(ctx.pagina, delta, ms, 'suave');
	const ahora = await cajaDe(loc);
	if (ahora.y < 0 || ahora.y + ahora.h > vp.h) await loc.scrollIntoViewIfNeeded();
	return {reloj, tipo: 'scroll', caja: {x: 0, y: 0, w: vp.w, h: vp.h}, escala: await ctx.escala(), dur: ms / 1000};
}

/** Mueve el mouse real (hover de la página) y hace clic en el centro de la caja. Devuelve el evento. */
async function clicEn(ctx: ContextoPlaywright, loc: Locator): Promise<EventoCrudo[]> {
	const eventos: EventoCrudo[] = [];
	const scroll = await asegurarVisible(ctx, loc);
	if (scroll) eventos.push(scroll);
	const caja = await cajaDe(loc);
	const x = caja.x + caja.w / 2;
	const y = caja.y + caja.h / 2;
	// La escala se mide ANTES del clic: si el clic navega, la página ya no contesta.
	const escala = await ctx.escala();
	await ctx.pagina.mouse.move(x, y, {steps: 14});
	const reloj = ctx.reloj();
	await ctx.pagina.mouse.down();
	await ctx.pagina.mouse.up();
	eventos.push({reloj, tipo: 'clic', caja, escala});
	return eventos;
}

function traducirError(error: unknown, paso: Paso, indice: number): FalloEditor {
	if (error instanceof FalloEditor) return error;
	const mensaje = error instanceof Error ? error.message.split('\n')[0] : String(error);
	const que = `correr el paso ${indice + 1} (${describirPaso(paso)})`;
	if (/Timeout|timeout/.test(mensaje)) {
		if (paso.accion === 'ir') {
			return fallo(que, 'la página no terminó de cargar a tiempo', 'revisa tu conexión o que el sitio esté arriba y vuelve a intentar', 3, mensaje);
		}
		return fallo(que, 'el elemento no apareció a tiempo en la página', 'revisa el selector con estudio explorar y corrige el guion', 2, mensaje);
	}
	if (/net::ERR_|NS_ERROR|ERR_NAME|ERR_CONNECTION/.test(mensaje)) {
		return fallo(que, `la página no cargó (${mensaje.slice(0, 120)})`, 'revisa tu conexión o que el sitio esté arriba y vuelve a intentar', 3, mensaje);
	}
	return fallo(que, mensaje.slice(0, 200), 'revisa proyectos/_logs/fallos.log y avísame', 1, mensaje);
}

/** Ejecutor real: corre un paso en la página y devuelve sus eventos (reloj de pared, caja en px CSS). */
export function crearEjecutor(ctx: ContextoPlaywright): Ejecutor {
	const limite = ctx.tiempoMaximoMs ?? 20_000;
	return async (paso, indice) => {
		const eventos: EventoCrudo[] = [];
		try {
			switch (paso.accion) {
				case 'ir': {
					if (!ctx.permitido(paso.url)) {
						throw fallo(`correr el paso ${indice + 1}`, `${paso.url} no está en sitios.txt`, 'agrega el dominio a demos/<slug>/sitios.txt (si es tuyo) o quita el paso', 2);
					}
					await ctx.pagina.goto(paso.url, {waitUntil: 'load', timeout: limite});
					await ctx.pagina.waitForLoadState('networkidle', {timeout: 5000}).catch(() => {});
					break; // la navegación la registra el estudio (framenavigated), con su hora real
				}
				case 'clic': {
					const loc = localizar(ctx.pagina, paso);
					await loc.waitFor({state: 'visible', timeout: limite});
					eventos.push(...(await clicEn(ctx, loc)));
					break;
				}
				case 'escribir': {
					const loc = localizar(ctx.pagina, paso);
					await loc.waitFor({state: 'visible', timeout: limite});
					eventos.push(...(await clicEn(ctx, loc)));
					const caja = await cajaDe(loc);
					const escala = await ctx.escala();
					const reloj = ctx.reloj();
					await ctx.pagina.keyboard.type(paso.texto, {delay: paso.retraso_ms ?? 70});
					eventos.push({reloj, tipo: 'tecla', caja, escala, dur: ctx.reloj() - reloj});
					break;
				}
				case 'tecla': {
					// Caja del campo con foco y escala ANTES de la tecla (un Enter puede navegar).
					const caja = await ctx.pagina.evaluate(() => {
						const a = document.activeElement;
						if (!a || a === document.body || a === document.documentElement) return {x: 0, y: 0, w: 0, h: 0};
						const r = a.getBoundingClientRect();
						return {x: r.x, y: r.y, w: r.width, h: r.height};
					});
					const escala = await ctx.escala();
					const reloj = ctx.reloj();
					await ctx.pagina.keyboard.press(paso.texto);
					eventos.push({reloj, tipo: 'tecla', caja, escala});
					break;
				}
				case 'scroll': {
					const ms = paso.duracion_ms ?? 1200;
					const vp = await viewport(ctx.pagina);
					let caja: CajaCss = {x: 0, y: 0, w: vp.w, h: vp.h};
					let selector: string | undefined;
					if (paso.selector || paso.rol) {
						const loc = localizar(ctx.pagina, paso);
						await loc.waitFor({state: 'visible', timeout: limite});
						caja = await cajaDe(loc);
						// Se marca el elemento para desplazarlo desde la página (rol + nombre no es CSS).
						await loc.evaluate((el) => el.setAttribute('data-claude-desplazar', '1'));
						selector = '[data-claude-desplazar="1"]';
					}
					const reloj = ctx.reloj();
					await desplazar(ctx.pagina, paso.px ?? 600, ms, paso.curva ?? 'suave', selector);
					if (selector) await ctx.pagina.locator(selector).first().evaluate((el) => el.removeAttribute('data-claude-desplazar')).catch(() => {});
					eventos.push({reloj, tipo: 'scroll', caja, escala: await ctx.escala(), dur: ms / 1000});
					break;
				}
				case 'esperar': {
					if (paso.selector || paso.rol) await localizar(ctx.pagina, paso).waitFor({state: 'visible', timeout: limite});
					if (paso.ms !== undefined) await ctx.pagina.waitForTimeout(paso.ms);
					break;
				}
				case 'captura': {
					if (!ctx.capturar) throw fallo(`correr el paso ${indice + 1}`, 'este modo no guarda capturas', 'usa estudio grabar o estudio captura', 2);
					if (paso.selector || paso.rol) {
						const loc = localizar(ctx.pagina, paso);
						await loc.waitFor({state: 'visible', timeout: limite});
						const scroll = await asegurarVisible(ctx, loc);
						if (scroll) eventos.push(scroll);
					}
					await ctx.capturar(paso.archivo);
					break;
				}
			}
		} catch (error) {
			throw traducirError(error, paso, indice);
		}
		const pausa = paso.pausa_ms ?? ctx.pausaMs ?? 600;
		if (pausa > 0) await ctx.pagina.waitForTimeout(pausa);
		return eventos;
	};
}
