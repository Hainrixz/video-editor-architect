/**
 * Curvas de animación de las capas del reel (titular, tarjetas, stickers, zoom, desenfoque e inserts).
 *
 * Este archivo es puro: sin React, sin Remotion y sin Node. Todo recibe cuadros (frames a 30 fps) y devuelve
 * números, así lo pueden usar los componentes de src/reel/ y lo pueden probar las pruebas unitarias.
 *
 * Lo medido en tus reels publicados (detalle, n y fuente en src/estilo/capas.ts → MEDICIONES_CAPAS):
 * - Pop de stickers, logos y tiles: escala LINEAL de 0.5 a 1.0 contando desde un cuadro antes del primero visible,
 *   en 6 cuadros, sin sobrepaso; el primer cuadro visible sale con ~83 % de opacidad y el segundo ya opaco.
 *   Ese es `escalaPop` / `opacidadPop`.
 * - Tarjetas de texto: corte seco de entrada y de salida (sin curva).
 * - Tarjetas que se escriben letra por letra (16 de 213): la caja sale a su tamaño final, vacía 1–2 cuadros, y las
 *   letras salen a velocidad pareja (40 car/s las cortas, 30.7 las tipo prompt). Ese es `caracteresVisibles`.
 * - El pop con sobrepaso (resorte subamortiguado: 0.5 → ~1.06 → 1.0) NO apareció en tus reels medidos; queda
 *   como estilo opcional "rebote" (`escalaRebote`).
 */

export const FPS = 30;

/** Limita x al rango [a, b]. */
export const limitar = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/** Interpolación lineal de a a b con t en [0, 1] (sin limitar t). */
export const mezclar = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Suavizado seno de entrada y salida: 0 → 1 con velocidad 0 en las dos orillas. */
export const suaveSeno = (t: number): number => {
	const x = limitar(t, 0, 1);
	return 0.5 - 0.5 * Math.cos(Math.PI * x);
};

/** Salida cúbica: arranca rápido y frena (para deslizar). */
export const salidaCubica = (t: number): number => {
	const x = limitar(t, 0, 1);
	return 1 - (1 - x) ** 3;
};

// ───────────────────────── pop (lo medido en tus reels) ─────────────────────────

export type ParamsPop = {
	/** Escala de la que parte la rampa, un cuadro antes del primero visible. */
	escalaInicial: number;
	/** Cuadros desde el primer cuadro visible hasta llegar a 1 (el cuadro `cuadros − 1` ya vale 1). */
	cuadros: number;
	/** Opacidad del primer cuadro visible. */
	opacidadInicial: number;
	/** Cuadros de la rampa de opacidad (1 = solo el primer cuadro va semitransparente). */
	cuadrosOpacidad: number;
};

/** Pop medido en tus reels (escala: n=6 eventos en 5 reels; opacidad del 1.er cuadro: n=6; ver MEDICIONES_CAPAS). */
export const POP_MEDIDO: ParamsPop = {escalaInicial: 0.5, cuadros: 6, opacidadInicial: 0.83, cuadrosOpacidad: 1};

/**
 * Escala del pop en el cuadro `f` contado desde la entrada (0 = primer cuadro visible).
 * Rampa lineal que vale `escalaInicial` en f = −1 y 1 en f = cuadros − 1. Antes de la entrada devuelve escalaInicial.
 */
export function escalaPop(f: number, p: ParamsPop = POP_MEDIDO): number {
	if (p.cuadros <= 0) return 1;
	if (f < 0) return p.escalaInicial;
	return mezclar(p.escalaInicial, 1, limitar((f + 1) / p.cuadros, 0, 1));
}

/** Opacidad del pop: `opacidadInicial` en el primer cuadro visible y 1 a partir de `cuadrosOpacidad`. Antes de la entrada, 0. */
export function opacidadPop(f: number, p: ParamsPop = POP_MEDIDO): number {
	if (f < 0) return 0;
	if (p.cuadrosOpacidad <= 0) return 1;
	return mezclar(p.opacidadInicial, 1, limitar(f / p.cuadrosOpacidad, 0, 1));
}

// ───────────────────────── rebote (resorte subamortiguado, opcional) ─────────────────────────

export type ParamsResorte = {
	/** Escala del primer cuadro visible. */
	escalaInicial: number;
	/** Razón de amortiguamiento ζ (< 1 = con sobrepaso). */
	amortiguamiento: number;
	/** Frecuencia natural ω en radianes por cuadro. */
	frecuencia: number;
};

/**
 * Resorte con sobrepaso de ~6 %: sube de 0.5, pasa por ~1.06 cerca del cuadro 3 y se asienta en 1.00 ±0.005
 * desde el cuadro 8 (lo comprueba pruebas/unit/animaciones.test.ts).
 * Con ζ = 0.56 el sobrepaso de un escalón es e^(−ζπ/√(1−ζ²)) ≈ 12 % del salto (0.5) ≈ 6 %.
 */
export const REBOTE: ParamsResorte = {escalaInicial: 0.5, amortiguamiento: 0.56, frecuencia: 1.15};

/** Solución exacta del oscilador amortiguado con velocidad inicial 0, de `escalaInicial` (f = 0) hacia 1. */
export function escalaRebote(f: number, p: ParamsResorte = REBOTE): number {
	if (f <= 0) return p.escalaInicial;
	const z = p.amortiguamiento;
	const w = p.frecuencia;
	const a = 1 - p.escalaInicial;
	if (z >= 1) {
		// Críticamente amortiguado (sin sobrepaso).
		return 1 - a * (1 + w * f) * Math.exp(-w * f);
	}
	const wd = w * Math.sqrt(1 - z * z);
	return 1 - a * Math.exp(-z * w * f) * (Math.cos(wd * f) + ((z * w) / wd) * Math.sin(wd * f));
}

// ───────────────────────── salidas e idle ─────────────────────────

/**
 * Salida "encoger" (no está en tus reels: ahí salen con corte): en los últimos `cuadros` cuadros la escala baja de 1 a
 * 0.5 (lineal) y el último cuadro va con la opacidad del primer cuadro del pop (el pop al revés).
 * `restantes` = cuadros que faltan para el final, contando el actual (1 = último).
 */
export function salidaEncoger(restantes: number, cuadros = 3, opacidadFinal = POP_MEDIDO.opacidadInicial): {escala: number; opacidad: number} {
	if (cuadros <= 0 || restantes > cuadros) return {escala: 1, opacidad: 1};
	const k = cuadros - limitar(restantes, 1, cuadros) + 1; // 1..cuadros
	return {escala: mezclar(1, 0.5, k / cuadros), opacidad: k === cuadros ? opacidadFinal : 1};
}

/** "Respira": escala 1 ± amplitud con periodo en segundos; vale 1 en f = 0 (sin salto al terminar la entrada). */
export function escalaRespira(f: number, amplitud = 0.015, periodoS = 1.2, fps = FPS): number {
	if (f <= 0 || amplitud === 0 || periodoS <= 0) return 1;
	return 1 + amplitud * Math.sin((2 * Math.PI * f) / (periodoS * fps));
}

// ───────────────────────── inserts ─────────────────────────

/** Ken Burns lento: de `desde` a `hasta` en línea recta a lo largo de `duracion` cuadros (f = 0 … duracion − 1). */
export function escalaKenBurns(f: number, duracion: number, desde = 1, hasta = 1.06): number {
	if (duracion <= 1) return desde;
	return mezclar(desde, hasta, limitar(f / (duracion - 1), 0, 1));
}

/** Entrada deslizando: desplazamiento vertical (px base) de `distancia` a 0 en `cuadros` cuadros, con frenado. */
export function deslizar(f: number, cuadros = 6, distancia = 140): {dy: number; opacidad: number} {
	if (cuadros <= 0) return {dy: 0, opacidad: 1};
	const t = limitar((f + 1) / cuadros, 0, 1);
	return {dy: distancia * (1 - salidaCubica(t)), opacidad: limitar((f + 1) / Math.max(1, Math.round(cuadros / 2)), 0, 1)};
}

// ───────────────────────── desenfoque ─────────────────────────

export type TramoDesenfoque = {desde: number; hasta: number; intensidad: number};

/**
 * Intensidad del desenfoque en el cuadro absoluto `f`. Cada tramo va de `desde` a `hasta` (cuadros, hasta exclusivo):
 * sube con suavizado seno en `entrada` cuadros, se queda y baja en `salida` cuadros; en `hasta` ya vale 0.
 * Las dos rampas son simétricas: el primer y el último cuadro del tramo llevan el mismo desenfoque pequeño.
 * Si el tramo es corto, cada rampa se recorta a un tercio de su duración. Con tramos encimados manda el mayor.
 */
export function intensidadDesenfoque(f: number, tramos: readonly TramoDesenfoque[], entrada = 18, salida = 18): number {
	let max = 0;
	for (const t of tramos) {
		const dur = t.hasta - t.desde;
		if (dur <= 0 || f < t.desde || f >= t.hasta) continue;
		const tope = Math.floor(dur / 3);
		const rEnt = Math.min(Math.max(0, Math.round(entrada)), tope);
		const rSal = Math.min(Math.max(0, Math.round(salida)), tope);
		const local = f - t.desde; // 0 en el primer cuadro del tramo
		const faltan = t.hasta - f; // 1 en el último cuadro del tramo
		let k = 1;
		if (rEnt > 0 && local < rEnt) k = Math.min(k, suaveSeno((local + 1) / (rEnt + 1)));
		if (rSal > 0 && faltan <= rSal) k = Math.min(k, suaveSeno(faltan / (rSal + 1)));
		max = Math.max(max, t.intensidad * k);
	}
	return max;
}

// ───────────────────────── zoom ─────────────────────────

/** Transformación de la toma base en coordenadas base: x' = escala · x + tx (igual en y). */
export type EstadoZoom = {escala: number; tx: number; ty: number};

export const IDENTIDAD: EstadoZoom = {escala: 1, tx: 0, ty: 0};

export type ZoomCuadros = {
	/** Cuadro de entrada (inclusive). */
	desde: number;
	/** Cuadro de salida (exclusivo). */
	hasta: number;
	escala: number;
	origen: {x: number; y: number};
	transicion: 'corte' | 'suave';
};

export type CambioZoom = {cuadro: number; hacia: EstadoZoom; suave: boolean; cuadros: number};

/** Escala alrededor de `origen` (base 1080×1920; el origen se limita al cuadro para que nunca se vean orillas). */
export function estadoDeZoom(escala: number, origen: {x: number; y: number}, ancho = 1080, alto = 1920): EstadoZoom {
	const e = Math.max(1, escala);
	const ox = limitar(origen.x, 0, ancho);
	const oy = limitar(origen.y, 0, alto);
	return {escala: e, tx: (1 - e) * ox, ty: (1 - e) * oy};
}

/** Mezcla lineal de dos estados (escala y traslación): el origen efectivo queda entre los dos, así no se ven orillas. */
export function mezclarZoom(a: EstadoZoom, b: EstadoZoom, t: number): EstadoZoom {
	return {escala: mezclar(a.escala, b.escala, t), tx: mezclar(a.tx, b.tx, t), ty: mezclar(a.ty, b.ty, t)};
}

/** Resorte críticamente amortiguado normalizado: 0 en t = 0 y 1 justo en t = cuadros (sin sobrepaso). */
export function rampaResorte(t: number, cuadros: number, frecuencia = 0.8): number {
	if (cuadros <= 0 || t >= cuadros) return 1;
	if (t <= 0) return 0;
	const c = (x: number) => 1 - (1 + frecuencia * x) * Math.exp(-frecuencia * x);
	return c(t) / c(cuadros);
}

/**
 * Plan de cambios de la toma base a partir de los zooms (en cuadros).
 * - "corte": entra de golpe en `desde` y sale de golpe en `hasta` (punch-in).
 * - "suave": entra con resorte en `cuadrosSuave` cuadros desde `desde` y sale con resorte de modo que en `hasta`
 *   ya está en 1. Si el zoom dura poco, cada rampa se recorta a la mitad de su duración.
 * - Zooms seguidos: si el siguiente empieza antes de que este termine (o justo al terminar), este no sale:
 *   la toma pasa directo de uno al otro con la transición del siguiente. Así no hay saltos ni vuelta a 1 en medio.
 */
export function planZoom(zooms: readonly ZoomCuadros[], cuadrosSuave = 8): CambioZoom[] {
	const orden = [...zooms].filter((z) => z.hasta > z.desde).sort((a, b) => a.desde - b.desde || a.hasta - b.hasta);
	const cambios: CambioZoom[] = [];
	orden.forEach((z, i) => {
		const dur = z.hasta - z.desde;
		const suave = z.transicion === 'suave';
		const rampa = suave ? Math.max(1, Math.min(cuadrosSuave, Math.floor(dur / 2))) : 0;
		cambios.push({cuadro: z.desde, hacia: estadoDeZoom(z.escala, z.origen), suave, cuadros: rampa});
		const siguiente = orden[i + 1];
		if (siguiente && siguiente.desde <= z.hasta) return; // el siguiente toma la estafeta
		if (suave) cambios.push({cuadro: z.hasta - rampa, hacia: IDENTIDAD, suave: true, cuadros: rampa});
		else cambios.push({cuadro: z.hasta, hacia: IDENTIDAD, suave: false, cuadros: 0});
	});
	// Orden estable por cuadro (si dos cambios caen en el mismo cuadro, gana el último).
	return cambios.map((c, i) => ({c, i})).sort((a, b) => a.c.cuadro - b.c.cuadro || a.i - b.i).map((x) => x.c);
}

/** Estado de la toma base en el cuadro absoluto `f` según el plan. Cada cambio parte del estado en que iba el anterior. */
export function estadoZoomEn(f: number, cambios: readonly CambioZoom[]): EstadoZoom {
	let actual: EstadoZoom = IDENTIDAD;
	let previo: CambioZoom | null = null;
	let inicioPrevio: EstadoZoom = IDENTIDAD;
	const evaluar = (c: CambioZoom | null, inicio: EstadoZoom, cuadro: number): EstadoZoom => {
		if (!c) return IDENTIDAD;
		if (!c.suave || c.cuadros <= 0) return c.hacia;
		return mezclarZoom(inicio, c.hacia, rampaResorte(cuadro - c.cuadro, c.cuadros));
	};
	for (const c of cambios) {
		if (c.cuadro > f) break;
		const inicio = evaluar(previo, inicioPrevio, c.cuadro);
		previo = c;
		inicioPrevio = inicio;
	}
	actual = evaluar(previo, inicioPrevio, f);
	return actual;
}

// ───────────────────────── escritura letra por letra (tarjetas) ─────────────────────────

export type ParamsEscritura = {
	/** Caracteres (grafemas) por segundo. Cada salto de renglón y cada espacio cuentan como uno. */
	car_s: number;
	/** Cuadros con la caja ya puesta y sin ninguna letra, antes de la primera. */
	cuadros_vacia: number;
};

/**
 * Escritura de tus tarjetas cortas (1–2 renglones): 40 car/s (mediana de 11 tarjetas en 5 reels; 27.5–66.4) y
 * 1 cuadro de caja vacía (mediana, n=11). Detalle, n y fuente en MEDICIONES_CAPAS (src/estilo/capas.ts).
 */
export const ESCRITURA_MEDIDA: ParamsEscritura = {car_s: 40, cuadros_vacia: 1};

/** Escritura de tus tarjetas tipo prompt (3–4 renglones): 30.7 car/s (mediana, n=5 en 3 reels; 23.8–37.1) y 2 cuadros vacía. */
export const ESCRITURA_PROMPT_MEDIDA: ParamsEscritura = {car_s: 30.7, cuadros_vacia: 2};

/** En tus reels el texto queda completo, a más tardar, al 87 % de su tiempo en pantalla (n=16; mediana 56 %). */
export const ESCRITURA_TERMINA_MAX = 0.87;

const velocidadValida = (car_s: number): boolean => Number.isFinite(car_s) && car_s > 0;

/**
 * Cuántos caracteres (grafemas) se ven en el cuadro `f`, contado desde que aparece la tarjeta (0 = su primer cuadro).
 * Antes de `cuadros_vacia` no se ve ninguno; en `cuadros_vacia` sale el primero y luego van saliendo parejo a `car_s`
 * (1 + ⌊(f − vacía) · car_s / fps⌋), sin pasar de `total`. Determinista: el mismo cuadro da siempre lo mismo.
 * Con `car_s` infinito (o no válido) todo sale de golpe en `cuadros_vacia`.
 */
export function caracteresVisibles(f: number, total: number, p: ParamsEscritura, fps = FPS): number {
	const n = Math.max(0, Math.floor(total));
	if (n === 0 || f < p.cuadros_vacia) return 0;
	if (!velocidadValida(p.car_s)) return n;
	return Math.min(n, 1 + Math.floor(((f - p.cuadros_vacia) * p.car_s) / fps + 1e-9));
}

/** Primer cuadro (contado desde que aparece la tarjeta) en que ya se ve el texto completo. */
export function cuadroTextoCompleto(total: number, p: ParamsEscritura, fps = FPS): number {
	const n = Math.max(0, Math.floor(total));
	const vacia = Math.max(0, p.cuadros_vacia);
	if (n <= 1 || !velocidadValida(p.car_s)) return vacia;
	return vacia + Math.max(0, Math.ceil(((n - 1) * fps) / p.car_s - 1e-9));
}

/**
 * Velocidad para una tarjeta que se ve `duracion` cuadros: la medida, salvo que a esa velocidad el texto termine
 * después de `terminaMax` de su tiempo en pantalla; entonces sube lo justo para terminar ahí (nunca baja de la medida).
 * Si ni así alcanza (una tarjeta de 1–2 cuadros), todo sale de golpe en su primer cuadro.
 */
export function ajustarEscritura(total: number, duracion: number, p: ParamsEscritura, terminaMax = ESCRITURA_TERMINA_MAX, fps = FPS): ParamsEscritura {
	const n = Math.max(0, Math.floor(total));
	const limite = Math.floor(terminaMax * duracion + 1e-9);
	if (n <= 1 || cuadroTextoCompleto(n, p, fps) <= limite) return {...p};
	const vacia = Math.min(Math.max(0, p.cuadros_vacia), Math.max(0, limite - 1));
	const disponibles = limite - vacia;
	if (disponibles <= 0) return {car_s: Number.POSITIVE_INFINITY, cuadros_vacia: 0};
	return {car_s: ((n - 1) * fps) / disponibles, cuadros_vacia: vacia};
}

/**
 * Cursor opcional al final de lo escrito (en tus reels no hay): fijo mientras escribe y, ya completo, parpadea con
 * medios ciclos de `parpadeo` cuadros (0 = se queda fijo). Antes de que aparezca la tarjeta, oculto.
 */
export function cursorEncendido(f: number, total: number, p: ParamsEscritura, parpadeo = 15, fps = FPS): boolean {
	if (f < 0) return false;
	const fin = cuadroTextoCompleto(total, p, fps);
	if (f < fin || parpadeo <= 0) return true;
	return Math.floor((f - fin) / parpadeo) % 2 === 0;
}
