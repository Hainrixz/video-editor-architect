/**
 * Trazos de los motion graphics flotantes: polilíneas con su largo (para dibujarlas con strokeDashoffset y saber dónde
 * va la punta de la pluma), un óvalo hecho a mano, la superelipse de las esquinas continuas de Apple y la gráfica de
 * una curva cubic-bezier.
 *
 * Puro: sin React, sin Remotion y sin Node. Unidades: las que le pases (px base o de la escena).
 */

export type Punto = {x: number; y: number};
export type Trazo = {puntos: Punto[]; acumulado: number[]; largo: number; d: string};

/** Arma un trazo (path SVG + largo acumulado) desde sus puntos. */
export function trazoDe(puntos: Punto[], cerrado = false): Trazo {
	const pts = cerrado && puntos.length > 1 ? [...puntos, puntos[0]] : puntos;
	const acumulado: number[] = [0];
	for (let i = 1; i < pts.length; i++) acumulado.push(acumulado[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
	const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + (cerrado ? ' Z' : '');
	return {puntos: pts, acumulado, largo: acumulado[acumulado.length - 1] ?? 0, d};
}

/** Punto a la fracción `p` (0–1) del largo del trazo: la punta de la pluma. */
export function puntoEn(t: Trazo, p: number): Punto {
	const n = t.puntos.length;
	if (n === 0) return {x: 0, y: 0};
	if (n === 1 || t.largo === 0) return t.puntos[0];
	const objetivo = Math.min(1, Math.max(0, p)) * t.largo;
	let i = 1;
	while (i < n - 1 && t.acumulado[i] < objetivo) i++;
	const a = t.puntos[i - 1];
	const b = t.puntos[i];
	const tramo = t.acumulado[i] - t.acumulado[i - 1];
	const k = tramo > 0 ? (objetivo - t.acumulado[i - 1]) / tramo : 0;
	return {x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k};
}

/** Ruido determinista suave (suma de senos) para que lo "hecho a mano" no sea perfecto, sin azar entre cuadros. */
function ondulacion(u: number, semilla: number): number {
	return 0.55 * Math.sin(u * 2 + semilla * 1.7) + 0.3 * Math.sin(u * 3 + semilla * 3.1) + 0.15 * Math.sin(u * 5 + semilla * 0.7);
}

/**
 * Óvalo de pluma alrededor de algo: arranca arriba a la izquierda, da una vuelta y se pasa `extra_grados` de su
 * inicio (como una mano real), con el radio ondulando ±`temblor` (fracción) y la espiral abriéndose apenas.
 */
export function ovaloAMano(cx: number, cy: number, rx: number, ry: number, o: {extra_grados?: number; temblor?: number; semilla?: number; puntos?: number} = {}): Trazo {
	const extra = ((o.extra_grados ?? 18) * Math.PI) / 180;
	const temblor = o.temblor ?? 0.035;
	const semilla = o.semilla ?? 1;
	const n = o.puntos ?? 120;
	const a0 = Math.PI * 1.08; // a la izquierda, un poco arriba
	const total = Math.PI * 2 + extra;
	const pts: Punto[] = [];
	for (let i = 0; i <= n; i++) {
		const u = i / n;
		const a = a0 + total * u;
		// La segunda pasada queda un poco por fuera (espiral): +4 % al final.
		const k = 1 + temblor * ondulacion(a, semilla) + 0.04 * u;
		pts.push({x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k});
	}
	return trazoDe(pts);
}

/** Línea un poco curva (tachón de pluma): de a a b con una panza de `panza` px hacia la normal. */
export function lineaAMano(a: Punto, b: Punto, panza = 6, n = 24): Trazo {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const l = Math.hypot(dx, dy) || 1;
	const nx = -dy / l;
	const ny = dx / l;
	const pts: Punto[] = [];
	for (let i = 0; i <= n; i++) {
		const u = i / n;
		const c = Math.sin(Math.PI * u) * panza;
		pts.push({x: a.x + dx * u + nx * c, y: a.y + dy * u + ny * c});
	}
	return trazoDe(pts);
}

/**
 * Superelipse |x/a|^n + |y/b|^n = 1 centrada en (cx, cy): con n alto es un rectángulo de esquinas vivas; con n ≈ 5 es
 * la "esquina continua" de los íconos de Apple. Arranca arriba al centro y va en el sentido del reloj; siempre el
 * mismo número de puntos (para poder interpolar entre dos n).
 */
export function superelipse(cx: number, cy: number, a: number, b: number, n: number, puntos = 160): Trazo {
	const pts: Punto[] = [];
	for (let i = 0; i < puntos; i++) {
		const th = -Math.PI / 2 + (2 * Math.PI * i) / puntos;
		const c = Math.cos(th);
		const s = Math.sin(th);
		const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * a;
		const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * b;
		pts.push({x: cx + x, y: cy + y});
	}
	return trazoDe(pts, true);
}

/** Interpola punto a punto dos trazos con el mismo número de puntos (p = 0 → a, 1 → b). */
export function interpolarTrazos(a: Trazo, b: Trazo, p: number, cerrado = true): Trazo {
	const na = cerrado ? a.puntos.length - 1 : a.puntos.length;
	const pts: Punto[] = [];
	for (let i = 0; i < na; i++) {
		const pa = a.puntos[i];
		const pb = b.puntos[Math.min(i, b.puntos.length - 1)];
		pts.push({x: pa.x + (pb.x - pa.x) * p, y: pa.y + (pb.y - pa.y) * p});
	}
	return trazoDe(pts, cerrado);
}

/**
 * Gráfica de una curva de tiempo (t → valor) dentro de la caja (x, y, w, h): x = tiempo, y = avance (hacia arriba).
 * Sirve para dibujar la cubic-bezier(0.23, 1, 0.32, 1) de verdad.
 */
export function graficaCurva(curva: (t: number) => number, x: number, y: number, w: number, h: number, n = 48): Trazo {
	const pts: Punto[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		pts.push({x: x + w * t, y: y + h - h * curva(t)});
	}
	return trazoDe(pts);
}

/** Punto de una curva cuadrática de Bézier (para los vuelos en arco). */
export function bezierCuadratica(p0: Punto, p1: Punto, p2: Punto, t: number): Punto {
	const u = 1 - t;
	return {x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y};
}
