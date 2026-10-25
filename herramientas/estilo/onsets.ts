// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * onsets.ts: encuentra los momentos en que arranca un SFX (clic, pop, ping, glitch…) encima de tu voz.
 *
 *   npx tsx herramientas/estilo/onsets.ts <reel.mp4|audio.wav> [--salida referencias/reels/<id>/onsets.json]
 *
 * Cómo (ver herramientas/lib/onsets.ts): banco de detectores con umbral adaptable a lo que hizo tu voz en ±1.5 s:
 * clic impulsivo de agudos, flujo espectral de 4–16 kHz, tonos nuevos de 2–14 kHz, golpes graves (30–90 Hz y
 * 90–600 Hz) y, si el audio es estéreo con la voz al centro, el canal lateral (L − R).
 * Solo usa ffmpeg: corre dentro del sandbox. No gasta nada.
 * Salida por defecto: referencias/reels/<nombre del archivo sin extensión>/onsets.json.
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (no existe, no trae audio, falta ffmpeg).
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {detectarOnsets, FS_ONSETS, leerAudio, PARAMETROS_ONSETS, type FuenteOnset, type Onset, type ParametrosOnsets} from '../lib/onsets.ts';

export type ReporteOnsets = {
	version: 1;
	generado_por: string;
	fuente: string;
	fs: number;
	canales: number;
	duracion_s: number;
	metodo: string;
	parametros: ParametrosOnsets;
	lateral: {usado: boolean; diferencia_db: number | null; nota: string};
	n_onsets: number;
	onsets_por_min: number;
	por_fuente: Partial<Record<FuenteOnset, number>>;
	onsets: Onset[];
	segundos: number;
};

export const METODO_ONSETS =
	'banco de detectores con umbral adaptable a la voz en ±1.5 s (sin el propio evento): clic impulsivo 4–16 kHz (sube en 2 ms y se apaga en 4–12 ms), flujo espectral de 4 bandas entre 4 y 16 kHz sobre el p90 local, parciales estables nuevos de 2–14 kHz, golpes graves 30–90 y 90–600 Hz sobre el p95 local, y canal lateral (L−R) si la voz va al centro; fusión a 60 ms (queda el más temprano)';

/** Analiza un archivo y arma el reporte (sin escribirlo). */
export async function analizarOnsets(ruta: string, p: ParametrosOnsets = PARAMETROS_ONSETS): Promise<ReporteOnsets> {
	const t0 = performance.now();
	const audio = await leerAudio(ruta, FS_ONSETS);
	if (audio.duracionS < 0.5) {
		throw fallo(`buscar SFX en ${basename(ruta)}`, `el audio dura ${audio.duracionS.toFixed(2)} s`, 'usa un audio de al menos medio segundo', 2);
	}
	const r = detectarOnsets(audio.central, audio.fs, p, audio.lateral ?? undefined);
	const porFuente: Partial<Record<FuenteOnset, number>> = {};
	for (const o of r.onsets) for (const f of o.fuentes) porFuente[f] = (porFuente[f] ?? 0) + 1;
	const nota = audio.lateral
		? r.lateral.usado
			? `el lateral va ${r.lateral.diferenciaDb} dB bajo el central cuando hablas: la voz va al centro y se usó`
			: `el lateral va solo ${r.lateral.diferenciaDb} dB bajo el central: trae voz o música y no se usó`
		: 'audio mono (L = R): sin canal lateral';
	return {
		version: 1,
		generado_por: 'herramientas/estilo/onsets.ts',
		fuente: ruta,
		fs: audio.fs,
		canales: audio.canales,
		duracion_s: Number(audio.duracionS.toFixed(3)),
		metodo: METODO_ONSETS,
		parametros: p,
		lateral: {usado: r.lateral.usado, diferencia_db: r.lateral.diferenciaDb, nota},
		n_onsets: r.onsets.length,
		onsets_por_min: Number(((r.onsets.length / audio.duracionS) * 60).toFixed(1)),
		por_fuente: porFuente,
		onsets: r.onsets,
		segundos: Number(((performance.now() - t0) / 1000).toFixed(2)),
	};
}

/** Ruta de salida por defecto: referencias/reels/<id>/onsets.json. */
export function salidaPorDefecto(ruta: string, archivo = 'onsets.json'): string {
	return join(RAIZ, 'referencias', 'reels', basename(ruta, extname(ruta)), archivo);
}

async function main(): Promise<void> {
	const {values, positionals} = parseArgs({allowPositionals: true, options: {salida: {type: 'string'}}});
	if (positionals.length !== 1) {
		throw fallo('buscar SFX', 'falta el archivo (o sobran argumentos)', 'usa: npx tsx herramientas/estilo/onsets.ts <reel.mp4|audio.wav> [--salida x.json]', 2);
	}
	const ruta = resolve(positionals[0]);
	const salida = resolve(values.salida ?? salidaPorDefecto(ruta));
	const reporte = await analizarOnsets(ruta);
	mkdirSync(dirname(salida), {recursive: true});
	writeFileSync(salida, `${JSON.stringify(reporte, null, '\t')}\n`);
	const fuentes = Object.entries(reporte.por_fuente).map(([f, n]) => `${f} ${n}`).join(', ') || 'ninguna';
	console.log(`${basename(ruta)}: ${reporte.n_onsets} onsets en ${reporte.duracion_s} s (${reporte.onsets_por_min}/min; ${fuentes}).`);
	console.log(`  ${reporte.lateral.nota}.`);
	console.log(`Tiempo: ${reporte.segundos} s. Detalle: ${relative(RAIZ, salida)}`);
}

if (esPrincipal(import.meta.url)) void correr(main);
