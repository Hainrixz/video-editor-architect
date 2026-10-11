/**
 * Motion graphics propios (inserts de tipo "motion"): contrato, valores por defecto, curvas y líneas de tiempo.
 *
 * Este archivo es PURO: sin React, sin Remotion y sin Node. Lo usan src/reel/motion/* (lo que se dibuja),
 * src/esquema/edicion.ts (el contrato de la EDL), herramientas/validar.ts (duración mínima) y las pruebas.
 *
 * Criterio de animación (decisión de diseño 2026-10-04, NO medida en los reels):
 *  - Skills públicas de diseño de animación (design-eng / review-animations): entradas con ease-out fuerte
 *    cubic-bezier(0.23, 1, 0.32, 1); lo que se mueve en pantalla con ease-in-out cubic-bezier(0.77, 0, 0.175, 1);
 *    nada nace de scale(0) (mínimo 0.94 + opacidad); stagger corto (2 cuadros = 67 ms); solo transform, opacity y
 *    clip-path; resortes con rebote sutil.
 *  - /brag-slim (latent-spaces/brag, MIT): "entra rápido y se queda", todo legible ~0.3 s por palabra contado desde
 *    que la línea está completa, cada cuadro congelado debe verse bien.
 *  - Los reels medidos: el insert entra y sale en corte seco (el fondo está desde el cuadro 0; lo de adentro anima).
 *
 * Unidades: cuadros a 30 fps; px en la ESCENA (810 × 980, el ancho de la zona cian de Reels). El componente la
 * coloca a pantalla completa (x 135–945, y 250–1230: arriba de tus tarjetas y stickers del pecho y de los
 * subtítulos) o dentro de una tarjeta (caja.w, por defecto 810, centrada en y ≈ 940 como tus memes).
 */
import {z} from 'zod';
import {MotionPantallaAObjeto, MotionPlantillaApple, MotionPruebaCorregida, esLibre, minimoLibre, resolverLibre, type LibreResuelto} from './motion-libre';

export const FPS_MOTION = 30;

// ───────────────────────── contrato ─────────────────────────

/**
 * Valores de ejemplo de "skills-instaladas" cuando la EDL no trae los suyos (lo normal es que el director o las notas
 * escriban comando, skills y repo del reel en la EDL). Son genéricos: el contenido de un reel concreto va en su EDL.
 */
export const SKILLS_EJEMPLO = ['design-eng', 'animate', 'review-animations', 'improve-animations', 'find-animation-opportunities', 'animation-vocabulary', 'apple-design'] as const;
export const REPO_EJEMPLO = 'autor/skills';
export const FUENTE_SKILLS_EJEMPLO = 'ejemplo genérico (un repo de skills con su README → Install); pon los del reel en la EDL';
/** Comando de instalación de ejemplo (formato del README de un repo de skills). */
export const COMANDO_EJEMPLO = `npx skills@latest add ${REPO_EJEMPLO}`;
/** Logos monocromos que ya están en la biblioteca (biblioteca/stickers/logos/fuentes/, ver LICENCIAS.md). */
export const LOGO_GITHUB = 'biblioteca/stickers/logos/fuentes/simple-icons-github.svg';
export const LOGO_APPLE = 'biblioteca/stickers/logos/fuentes/simple-icons-apple.svg';
export const LOGO_CLAUDE = 'biblioteca/stickers/logos/fuentes/simple-icons-claude.svg';

export const MotionSkillsInstaladas = z.object({
	nombre: z.literal('skills-instaladas'),
	/** Lo que se teclea (por defecto COMANDO_EJEMPLO). */
	comando: z.string().min(1).max(60).optional(),
	/** Las que salen en cascada con su palomita (por defecto SKILLS_EJEMPLO). */
	skills: z.array(z.string().min(1).max(32)).min(1).max(8).optional(),
	/** Píldora final (null = sin píldora). */
	pie: z.string().min(1).max(40).nullable().optional(),
	/** Encabezado: ícono junto al repo (SVG monocromo → se pinta blanco; PNG/JPG → foto redonda; null = sin ícono). */
	avatar: z.string().min(1).nullable().optional(),
	repo: z.string().min(1).max(40).optional(),
});

export const MotionBasuraADiseno = z.object({
	nombre: z.literal('basura-a-diseno'),
	/** Segundos desde que entra el insert hasta que arranca el barrido que convierte la basura en diseño bueno. */
	cambio_s: z.number().positive().max(10).optional(),
	/** Etiqueta del estado feo y del bueno. */
	antes: z.string().min(1).max(28).optional(),
	despues: z.string().min(1).max(28).optional(),
});

export const PrincipioApple = z.object({titulo: z.string().min(1).max(16), nota: z.string().min(1).max(36)});

export const MotionReglasApple = z.object({
	nombre: z.literal('reglas-apple'),
	titulo: z.string().min(1).max(32).optional(),
	/** 3–4 principios (por defecto los de las Human Interface Guidelines: claridad, deferencia y profundidad). */
	principios: z.array(PrincipioApple).min(3).max(4).optional(),
	/** Logo monocromo (SVG o PNG con alfa, relativo a public/; se pinta blanco con máscara; null = sin logo). */
	logo: z.string().min(1).nullable().optional(),
});

/**
 * Los tres primeros (skills-instaladas, basura-a-diseno, reglas-apple) son escenas de 810 × 980 con fondo propio; los
 * tres "libres" (src/estilo/motion-libre.ts) solo van en layout "flotante", anclados a tu cabeza.
 */
export const MotionEsquema = z.discriminatedUnion('nombre', [MotionSkillsInstaladas, MotionBasuraADiseno, MotionReglasApple, MotionPruebaCorregida, MotionPlantillaApple, MotionPantallaAObjeto]);
export type Motion = z.infer<typeof MotionEsquema>;
export type NombreMotion = Motion['nombre'];
export const NOMBRES_MOTION: readonly NombreMotion[] = ['skills-instaladas', 'basura-a-diseno', 'reglas-apple', 'prueba-corregida', 'plantilla-apple', 'pantalla-a-objeto'];

/** ¿Es de los libres (solo flotante, anclados a tu cabeza)? */
export const esMotionLibre = (nombre: string): boolean => esLibre(nombre);

/** El asset de un insert motion: "motion:<nombre>" (no es archivo; validar.ts no lo busca en public/). */
export const assetMotion = (nombre: NombreMotion): string => `motion:${nombre}`;

// ───────────────────────── valores resueltos ─────────────────────────

export type SkillsResuelto = {nombre: 'skills-instaladas'; comando: string; skills: string[]; pie: string | null; avatar: string | null; repo: string};
export type BasuraResuelto = {nombre: 'basura-a-diseno'; cambio_s: number; antes: string; despues: string};
export type AppleResuelto = {nombre: 'reglas-apple'; titulo: string; principios: Array<{titulo: string; nota: string}>; logo: string | null};
export type EscenaResuelto = SkillsResuelto | BasuraResuelto | AppleResuelto;
export type MotionResuelto = EscenaResuelto | LibreResuelto;

export const PRINCIPIOS_APPLE = [
	{titulo: 'Claridad', nota: 'Se entiende a la primera'},
	{titulo: 'Deferencia', nota: 'El contenido manda'},
	{titulo: 'Profundidad', nota: 'Capas que dan contexto'},
] as const;
export const FUENTE_PRINCIPIOS_APPLE = 'Apple Human Interface Guidelines (Clarity, Deference, Depth) y la skill pública apple-design';

/** `desde` (segundos de la base) pasa los golpes absolutos de los motions libres a cuadros desde que entran. */
export function resolverMotion(m: Motion, desde?: number): MotionResuelto {
	if (m.nombre === 'prueba-corregida' || m.nombre === 'plantilla-apple' || m.nombre === 'pantalla-a-objeto') {
		return resolverLibre(m, desde, {logoApple: LOGO_APPLE, comando: COMANDO_EJEMPLO, skills: SKILLS_EJEMPLO});
	}
	switch (m.nombre) {
		case 'skills-instaladas':
			return {
				nombre: m.nombre,
				comando: m.comando ?? COMANDO_EJEMPLO,
				skills: [...(m.skills ?? SKILLS_EJEMPLO)],
				pie: m.pie === undefined ? 'Listas en Claude Code' : m.pie,
				avatar: m.avatar === undefined ? LOGO_GITHUB : m.avatar,
				repo: m.repo ?? REPO_EJEMPLO,
			};
		case 'basura-a-diseno':
			return {nombre: m.nombre, cambio_s: m.cambio_s ?? 1.5, antes: m.antes ?? 'Basura de IA', despues: m.despues ?? 'Con skills de diseño'};
		case 'reglas-apple':
			return {
				nombre: m.nombre,
				titulo: m.titulo ?? 'Reglas de diseño de Apple',
				principios: (m.principios ?? PRINCIPIOS_APPLE).map((p) => ({...p})),
				logo: m.logo === undefined ? LOGO_APPLE : m.logo,
			};
	}
}

// ───────────────────────── escena y colores ─────────────────────────

/** Escena de diseño en px base (ancho = zona cian de Reels). */
export const ESCENA = {ancho: 810, alto: 980} as const;
/** Centro de la escena a pantalla completa: y 250–1230 (deja libres pecho, y ≈ 1290–1460, y subtítulos, y ≈ 1545). */
export const CENTRO_PANTALLA = {x: 540, y: 740} as const;
/**
 * Tarjeta por defecto: centrada en y ≈ 940 como tus memes en tarjeta, pero de 810 px (no 888) para no tocar la columna
 * de íconos de Reels (x > 945 entre y 1280 y 1600): queda en x 135–945, y 450–1430.
 */
export const TARJETA_MOTION = {ancho: 810, y: 940, radio: 40} as const;

/** Modo oscuro como tus inserts de pantalla. Acento: el naranja de Claude que ya usa la terminal (#D97757). */
export const COLORES_MOTION = {
	fondo: '#09090B',
	fondoBrillo: 'rgba(217, 119, 87, 0.16)',
	panel: '#121215',
	panelAlto: '#18181C',
	linea: 'rgba(255, 255, 255, 0.09)',
	lineaFuerte: 'rgba(255, 255, 255, 0.16)',
	texto: '#F5F5F7',
	tenue: '#9A9AA6',
	acento: '#D97757',
	verde: '#4ADE80',
	rojo: '#FF5A5F',
} as const;

// ───────────────────────── curvas ─────────────────────────

/** Curva cubic-bezier(x1, y1, x2, y2) → función de t en [0, 1] (Newton + bisección, como el navegador). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const xDe = (s: number) => ((ax * s + bx) * s + cx) * s;
	const yDe = (s: number) => ((ay * s + by) * s + cy) * s;
	const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
	return (t: number) => {
		const x = Math.min(1, Math.max(0, t));
		if (x === 0 || x === 1) return x;
		let s = x;
		for (let i = 0; i < 8; i++) {
			const e = xDe(s) - x;
			const d = dx(s);
			if (Math.abs(e) < 1e-7) return yDe(s);
			if (Math.abs(d) < 1e-6) break;
			s -= e / d;
		}
		let a = 0;
		let b = 1;
		s = x;
		for (let i = 0; i < 40; i++) {
			const v = xDe(s);
			if (Math.abs(v - x) < 1e-7) break;
			if (v < x) a = s;
			else b = s;
			s = (a + b) / 2;
		}
		return yDe(s);
	};
}

/** Las dos curvas del criterio de animación: entrar/salir (ease-out fuerte) y moverse en pantalla (ease-in-out fuerte). */
export const CURVAS = {
	salida: bezier(0.23, 1, 0.32, 1),
	mover: bezier(0.77, 0, 0.175, 1),
	/** Trazos que se dibujan (pluma, líneas de plantilla): ease-in-out suave, la mano arranca y frena. */
	trazo: bezier(0.65, 0, 0.35, 1),
} as const;

/** Avance 0 → 1 de una animación que empieza en `inicio` y dura `cuadros`, con su curva. */
export function avance(f: number, inicio: number, cuadros: number, curva: (t: number) => number = CURVAS.salida): number {
	if (cuadros <= 0) return f >= inicio ? 1 : 0;
	return curva((f - inicio) / cuadros);
}

/** Entrada estándar: opacidad 0 → 1, sube `dy` px y escala `desde` → 1 (nunca de 0). */
export function entrada(f: number, inicio: number, cuadros = 9, dy = 18, desde = 0.96): {opacidad: number; y: number; escala: number} {
	const p = avance(f, inicio, cuadros);
	return {opacidad: Math.min(1, p * 1.4), y: (1 - p) * dy, escala: desde + (1 - desde) * p};
}

/** Cuadros que necesita leer un texto: ~0.3 s por palabra (regla de /brag-slim), mínimo 0.5 s. */
export function cuadrosLectura(texto: string): number {
	const palabras = texto.trim().split(/\s+/).filter(Boolean).length;
	return Math.ceil(Math.max(0.5, 0.3 * palabras) * FPS_MOTION);
}

// ───────────────────────── líneas de tiempo ─────────────────────────

export type LineaSkills = {
	ventana: {inicio: number; cuadros: number};
	tecleo: {inicio: number; porCuadro: number; fin: number};
	/** Cuadro en que "se da Enter" (el comando se queda y arranca la salida). */
	enter: number;
	encabezado: number;
	filas: number[];
	pie: number | null;
	/** Cuadros mínimos para que todo entre y lo último se alcance a leer. */
	minimo: number;
};

/** Stagger entre filas: 2 cuadros (67 ms, dentro de los 30–80 ms del criterio de animación). */
export const STAGGER_FILAS = 2;

export function lineaSkills(m: SkillsResuelto): LineaSkills {
	const ventana = {inicio: 0, cuadros: 8};
	const porCuadro = 2; // 60 car/s: rápido, se lee como "pegado y ejecutado"
	const inicioTecleo = 4;
	const fin = inicioTecleo + Math.ceil(m.comando.length / porCuadro);
	const enter = fin + 2;
	const encabezado = enter + 2;
	const filas = m.skills.map((_, i) => encabezado + 2 + i * STAGGER_FILAS);
	const ultimaFila = filas[filas.length - 1] ?? encabezado;
	const pie = m.pie ? ultimaFila + 5 : null;
	const minimo = pie !== null ? pie + 8 + cuadrosLectura(m.pie!) : ultimaFila + 9 + cuadrosLectura(m.skills[m.skills.length - 1] ?? '');
	return {ventana, tecleo: {inicio: inicioTecleo, porCuadro, fin}, enter, encabezado, filas, pie, minimo};
}

/** Caracteres del comando que ya se ven en el cuadro f. */
export function caracteresTecleados(lt: LineaSkills, total: number, f: number): number {
	if (f < lt.tecleo.inicio) return 0;
	return Math.min(total, Math.floor((f - lt.tecleo.inicio + 1) * lt.tecleo.porCuadro));
}

export type LineaBasura = {entra: number; cambio: number; barrido: number; asentado: number; minimo: number};

/** Barrido de la basura al diseño bueno: 15 cuadros (0.5 s) con la curva de moverse en pantalla. */
export const CUADROS_BARRIDO = 15;

export function lineaBasura(m: BasuraResuelto): LineaBasura {
	const cambio = Math.round(m.cambio_s * FPS_MOTION);
	const asentado = cambio + CUADROS_BARRIDO + 10;
	return {entra: 0, cambio, barrido: CUADROS_BARRIDO, asentado, minimo: asentado + cuadrosLectura(m.despues)};
}

export type LineaApple = {encabezado: number; tarjetas: number[]; minimo: number};

/** Stagger de las tarjetas de principios: 4 cuadros (133 ms): son pocas y cada una se lee. */
export const STAGGER_TARJETAS = 4;

export function lineaApple(m: AppleResuelto): LineaApple {
	const tarjetas = m.principios.map((_, i) => 6 + i * STAGGER_TARJETAS);
	const ultima = tarjetas[tarjetas.length - 1];
	// Los títulos de los principios son lo que se lee (1 palabra cada uno); las notas son textura.
	const lectura = cuadrosLectura(m.principios.map((p) => p.titulo).join(' '));
	return {encabezado: 0, tarjetas, minimo: Math.max(ultima + 12 + lectura, cuadrosLectura(m.titulo) + 12)};
}

/** Segundos mínimos que necesita un motion para que todo entre y se lea. */
export function duracionMinimaMotion(m: Motion): number {
	const r = resolverMotion(m);
	const cuadros = r.nombre === 'skills-instaladas' ? lineaSkills(r).minimo : r.nombre === 'basura-a-diseno' ? lineaBasura(r).minimo : r.nombre === 'reglas-apple' ? lineaApple(r).minimo : minimoLibre(r);
	return Math.round((cuadros / FPS_MOTION) * 100) / 100;
}

/** Caja visible (px base) de un insert motion. Pantalla completa → el cuadro entero. */
export function cajaMotion(layout: 'tarjeta' | 'pantalla-completa', caja?: {x?: number; y?: number; w?: number; h?: number; escala?: number}): {x0: number; y0: number; x1: number; y1: number} {
	if (layout === 'pantalla-completa') return {x0: 0, y0: 0, x1: 1080, y1: 1920};
	const esc = caja?.escala ?? 1;
	const w = (caja?.w ?? TARJETA_MOTION.ancho) * esc;
	const h = caja?.h !== undefined ? caja.h * esc : (w * ESCENA.alto) / ESCENA.ancho;
	const cx = caja?.x ?? 540;
	const cy = caja?.y ?? TARJETA_MOTION.y;
	return {x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2};
}
