/**
 * Resorte amortiguado en forma cerrada (la misma física que `spring` de Remotion: masa, rigidez y amortiguación,
 * velocidad inicial 0), pero evaluable en cuadros FRACCIONARIOS. Lo necesitan los motion graphics flotantes para el
 * desenfoque de movimiento por muestreo (src/reel/motion/materiales.tsx → Estela), que dibuja la misma pieza en
 * f, f − 0.125, f − 0.25…
 *
 * Puro: sin React, sin Remotion y sin Node.
 */

export type ConfigResorte = {damping: number; stiffness: number; mass: number};

/**
 * Resortes con nombre (decisión de diseño 2026-10-04, no medida en tus reels). Rebote sutil, como pide el criterio de animación
 * (bounce 0.1–0.3): ζ = damping / (2·√(stiffness·mass)).
 *  - pesado: objetos grandes (la hoja, la pantalla). ζ ≈ 0.77, sin rebote visible, ~18 cuadros.
 *  - vivo: piezas chicas (fichas, pestañas, tecla). ζ ≈ 0.65, sobrepaso ≈ 7 %, ~10 cuadros.
 *  - vuelo: lo que viaja lejos rápido (el comando que se despega). ζ ≈ 0.62, ~9 cuadros.
 */
export const RESORTES = {
	pesado: {damping: 20, stiffness: 120, mass: 1.4},
	vivo: {damping: 15, stiffness: 220, mass: 0.6},
	vuelo: {damping: 18, stiffness: 260, mass: 0.8},
} as const satisfies Record<string, ConfigResorte>;

/**
 * Avance 0 → 1 del resorte `cuadros` después de soltarlo (fraccionario; ≤ 0 → 0). Puede pasar de 1 (sobrepaso).
 */
export function resorte(cuadros: number, c: ConfigResorte = RESORTES.vivo, fps = 30): number {
	if (!(cuadros > 0)) return 0;
	const t = cuadros / fps;
	const w0 = Math.sqrt(c.stiffness / c.mass);
	const zeta = c.damping / (2 * Math.sqrt(c.stiffness * c.mass));
	if (zeta < 1) {
		const wd = w0 * Math.sqrt(1 - zeta * zeta);
		const e = Math.exp(-zeta * w0 * t);
		return 1 - e * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
	}
	if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
	// Sobreamortiguado.
	const r = Math.sqrt(zeta * zeta - 1);
	const s1 = -w0 * (zeta - r);
	const s2 = -w0 * (zeta + r);
	const a = s2 / (s2 - s1);
	const b = -s1 / (s2 - s1);
	return 1 - (a * Math.exp(s1 * t) + b * Math.exp(s2 * t));
}

/** Sobrepaso máximo (fracción) de un resorte subamortiguado: e^(−πζ/√(1−ζ²)). 0 si no rebota. */
export function sobrepaso(c: ConfigResorte): number {
	const zeta = c.damping / (2 * Math.sqrt(c.stiffness * c.mass));
	if (zeta >= 1) return 0;
	return Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
}

/** Cuadros hasta que el resorte queda a menos de `tol` de 1 para siempre (búsqueda hacia atrás, paso 0.25). */
export function cuadrosAsentado(c: ConfigResorte, tol = 0.01, fps = 30, max = 240): number {
	for (let f = max; f > 0; f -= 0.25) {
		if (Math.abs(1 - resorte(f, c, fps)) > tol) return Math.ceil(f + 0.25);
	}
	return 0;
}
