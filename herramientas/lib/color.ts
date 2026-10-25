// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Color para medir subtítulos: sRGB ↔ CIELAB (D65, observador 2°) y diferencia de color ΔE2000.
 *
 * - `rgbALab([r,g,b])` con r,g,b en 0–255 (sRGB con su curva gamma) → [L, a, b].
 * - `labARgb(lab)` → sRGB 0–255 (recortado al gamut y redondeado).
 * - `deltaE2000(lab1, lab2)`: fórmula CIEDE2000 (Sharma, Wu y Dalal, 2005) con kL = kC = kH = 1.
 *   Guía rápida: ≤1 no se nota, ≤5 casi no se nota (umbral del A/B de la Fase 1), >10 se ve otro color.
 * - `deltaE76`: distancia euclidiana en Lab (barata; sirve para agrupar, no para criterios).
 * - `medianaLab`: mediana por componente (para agregar colores de muchos eventos sin que un outlier mande).
 *
 * Todo es puro (sin disco ni red) y se prueba en pruebas/unit/medir.test.ts.
 */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

/** Blanco de referencia D65 (2°), el de sRGB. */
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

/** Tabla sRGB (0–255) → lineal (0–1). */
const LINEAL = new Float64Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	LINEAL[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Un canal sRGB 0–255 (acepta no enteros) → lineal 0–1. */
export function srgbALineal(canal: number): number {
	if (Number.isInteger(canal) && canal >= 0 && canal <= 255) return LINEAL[canal];
	const c = Math.min(1, Math.max(0, canal / 255));
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Lineal 0–1 → canal sRGB 0–255 (sin redondear). */
export function linealASrgb(v: number): number {
	const c = Math.min(1, Math.max(0, v));
	const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	return s * 255;
}

const EPS = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27;

function f(t: number): number {
	return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function fInv(t: number): number {
	const t3 = t * t * t;
	return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

/** sRGB 0–255 → CIELAB (D65). */
export function rgbALab(rgb: Rgb): Lab {
	const r = srgbALineal(rgb[0]);
	const g = srgbALineal(rgb[1]);
	const b = srgbALineal(rgb[2]);
	// Matriz sRGB → XYZ (D65), IEC 61966-2-1.
	const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
	const fx = f(x / XN);
	const fy = f(y / YN);
	const fz = f(z / ZN);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB (D65) → sRGB 0–255, recortado al gamut y redondeado. */
export function labARgb(lab: Lab): Rgb {
	const fy = (lab[0] + 16) / 116;
	const fx = fy + lab[1] / 500;
	const fz = fy - lab[2] / 200;
	const x = XN * fInv(fx);
	const y = YN * (lab[0] > KAPPA * EPS ? fy * fy * fy : lab[0] / KAPPA);
	const z = ZN * fInv(fz);
	const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
	const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
	const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
	return [Math.round(linealASrgb(r)), Math.round(linealASrgb(g)), Math.round(linealASrgb(b))];
}

/** ΔE*ab 1976: distancia euclidiana en Lab. */
export function deltaE76(a: Lab, b: Lab): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const RAD = Math.PI / 180;
const POT25_7 = Math.pow(25, 7);

/** ΔE2000 (CIEDE2000) entre dos colores Lab, con kL = kC = kH = 1. */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
	const [L1, a1, b1] = lab1;
	const [L2, a2, b2] = lab2;
	const C1 = Math.hypot(a1, b1);
	const C2 = Math.hypot(a2, b2);
	const Cm = (C1 + C2) / 2;
	const Cm7 = Math.pow(Cm, 7);
	const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + POT25_7)));
	const a1p = (1 + G) * a1;
	const a2p = (1 + G) * a2;
	const C1p = Math.hypot(a1p, b1);
	const C2p = Math.hypot(a2p, b2);
	const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) / RAD + 360) % 360;
	const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) / RAD + 360) % 360;

	const dLp = L2 - L1;
	const dCp = C2p - C1p;
	let dhp = 0;
	if (C1p * C2p !== 0) {
		dhp = h2p - h1p;
		if (dhp > 180) dhp -= 360;
		else if (dhp < -180) dhp += 360;
	}
	const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

	const Lmp = (L1 + L2) / 2;
	const Cmp = (C1p + C2p) / 2;
	let hmp = h1p + h2p;
	if (C1p * C2p !== 0) {
		if (Math.abs(h1p - h2p) <= 180) hmp = (h1p + h2p) / 2;
		else if (h1p + h2p < 360) hmp = (h1p + h2p + 360) / 2;
		else hmp = (h1p + h2p - 360) / 2;
	}

	const T =
		1 -
		0.17 * Math.cos((hmp - 30) * RAD) +
		0.24 * Math.cos(2 * hmp * RAD) +
		0.32 * Math.cos((3 * hmp + 6) * RAD) -
		0.2 * Math.cos((4 * hmp - 63) * RAD);
	const dTheta = 30 * Math.exp(-Math.pow((hmp - 275) / 25, 2));
	const Cmp7 = Math.pow(Cmp, 7);
	const RC = 2 * Math.sqrt(Cmp7 / (Cmp7 + POT25_7));
	const Lm50 = (Lmp - 50) * (Lmp - 50);
	const SL = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50);
	const SC = 1 + 0.045 * Cmp;
	const SH = 1 + 0.015 * Cmp * T;
	const RT = -Math.sin(2 * dTheta * RAD) * RC;

	const tL = dLp / SL;
	const tC = dCp / SC;
	const tH = dHp / SH;
	return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

/** [r,g,b] 0–255 → "#RRGGBB". */
export function rgbAHex(rgb: Rgb): string {
	return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** "#RRGGBB" o "RRGGBB" → [r,g,b]. Lanza si no es un hex de 6 dígitos. */
export function hexARgb(hex: string): Rgb {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) throw new Error(`color hex inválido: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mediana por componente de una lista de colores Lab (null si la lista está vacía). */
export function medianaLab(colores: Lab[]): Lab | null {
	if (colores.length === 0) return null;
	const med = (k: 0 | 1 | 2) => {
		const v = colores.map((c) => c[k]).sort((x, y) => x - y);
		const m = v.length >> 1;
		return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
	};
	return [med(0), med(1), med(2)];
}

/** Luminancia relativa (0–1, lineal) de un color sRGB 0–255. */
export function luminancia(rgb: Rgb): number {
	return 0.2126 * srgbALineal(rgb[0]) + 0.7152 * srgbALineal(rgb[1]) + 0.0722 * srgbALineal(rgb[2]);
}
