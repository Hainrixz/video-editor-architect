// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Síntesis propia de SFX con ffmpeg `aevalsrc` (licencia tuya: no viene de terceros).
 *
 *   npx tsx herramientas/sfx/sintesis.ts --salida <carpeta> [--receta <id>]
 *
 * Escribe un WAV mono de 48 kHz en float32 por receta, SIN normalizar (de eso se encarga catalogar.ts).
 * Hay 2 recetas por categoría porque en el conteo del plan la síntesis vale como máximo 2 de las 5 fuentes.
 * Las dos de cada categoría son diseños distintos (no la misma con otro tono), si no, no contarían como
 * fuentes distintas.
 *
 * Notas de las expresiones:
 * - `random(0)` es ruido uniforme determinista (su estado vive en la variable 0): mismo WAV en cada corrida.
 * - `st()`/`ld()` guardan estado entre muestras: así va un filtro de estado variable (Chamberlin) cuya
 *   frecuencia cambia en el tiempo, que es lo que hace que un whoosh "pase".
 */
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {TASA_SFX} from '../lib/sfx.ts';

export type Receta = {
	id: string;
	categoria: string;
	descripcion: string;
	duracion_s: number;
	/** Expresión de aevalsrc (una sola, mono). */
	expresion: string;
	/** Filtros opcionales de ffmpeg (-af) después de generar. */
	filtros?: string;
};

/** Filtro de estado variable (pasabanda) sobre ruido, con su frecuencia `fc` (expresión en t) y su amortiguación q. */
const whooshSvf = (fc: string, q: number, envolvente: string): string =>
	[
		`st(3,2*sin(PI*(${fc})/${TASA_SFX}))`,
		'st(1,ld(1)+ld(3)*ld(2))',
		`st(4,(2*random(0)-1)-ld(1)-${q}*ld(2))`,
		'st(2,ld(2)+ld(3)*ld(4))',
		`ld(2)*(${envolvente})`,
	].join(';');

export const RECETAS: Receta[] = [
	{
		id: 'pop-boca',
		categoria: 'pop',
		descripcion: 'pop de boca: seno que cae de ~1.2 kHz a 140 Hz en 8 ms, decae en 28 ms',
		duracion_s: 0.16,
		expresion: '(1-exp(-t/0.0006))*exp(-t/0.028)*sin(2*PI*(140*t+8.8*(1-exp(-t/0.008))))',
	},
	{
		id: 'pop-resonante',
		categoria: 'pop',
		descripcion: 'pok: ráfaga de ruido de 4 ms más un seno de 900 Hz que decae en 18 ms',
		duracion_s: 0.12,
		expresion: '0.6*(2*random(0)-1)*exp(-t/0.004)+0.8*(1-exp(-t/0.0005))*exp(-t/0.018)*sin(2*PI*900*t)',
		filtros: 'lowpass=f=6000,highpass=f=120',
	},
	{
		id: 'burbuja-sube',
		categoria: 'burbuja',
		descripcion: 'burbuja: seno que sube de 450 Hz a ~1.4 kHz en 70 ms (Minnaert), decae en 35 ms',
		duracion_s: 0.14,
		expresion: '(1-exp(-t/0.002))*exp(-t/0.035)*sin(2*PI*450*(t+15.714*t*t))',
	},
	{
		id: 'burbuja-doble',
		categoria: 'burbuja',
		descripcion: 'dos burbujas (blub-blub): 380 Hz y luego 620 Hz a los 75 ms, cada una sube y decae',
		duracion_s: 0.2,
		expresion:
			'(1-exp(-t/0.002))*exp(-t/0.03)*sin(2*PI*380*(t+12*t*t))+if(gte(t,0.075),0.8*(1-exp(-(t-0.075)/0.002))*exp(-(t-0.075)/0.03)*sin(2*PI*620*((t-0.075)+12*(t-0.075)*(t-0.075))),0)',
	},
	{
		id: 'pluck-cuerda',
		categoria: 'pluck',
		descripcion: 'cuerda pulsada: 6 armónicos de 330 Hz, los agudos se apagan antes',
		duracion_s: 0.5,
		expresion:
			'(1-exp(-t/0.0008))*(sin(2*PI*330*t)*exp(-t/0.25)+0.5*sin(2*PI*660*t)*exp(-t/0.125)+0.33*sin(2*PI*990*t)*exp(-t/0.083)+0.25*sin(2*PI*1320*t)*exp(-t/0.0625)+0.2*sin(2*PI*1650*t)*exp(-t/0.05)+0.16*sin(2*PI*1980*t)*exp(-t/0.042))',
	},
	{
		id: 'pluck-kalimba',
		categoria: 'pluck',
		descripcion: 'kalimba: 523 Hz con parciales inarmónicos (×2.76, ×5.4) y golpe de ruido corto',
		duracion_s: 0.45,
		expresion:
			'(1-exp(-t/0.0005))*(sin(2*PI*523*t)*exp(-t/0.18)+0.35*sin(2*PI*1443*t)*exp(-t/0.05)+0.15*sin(2*PI*2824*t)*exp(-t/0.02))+0.15*(2*random(0)-1)*exp(-t/0.002)',
	},
	{
		id: 'brillo-destello',
		categoria: 'brillo',
		descripcion: 'destello: arpegio de 4 parciales agudos (2.6–5.3 kHz) separados 35 ms',
		duracion_s: 0.6,
		expresion:
			'sin(2*PI*2637*t)*exp(-t/0.12)+if(gte(t,0.035),0.8*sin(2*PI*3136*(t-0.035))*exp(-(t-0.035)/0.12),0)+if(gte(t,0.07),0.65*sin(2*PI*3951*(t-0.07))*exp(-(t-0.07)/0.12),0)+if(gte(t,0.105),0.5*sin(2*PI*5274*(t-0.105))*exp(-(t-0.105)/0.14),0)',
	},
	{
		id: 'brillo-campana',
		categoria: 'brillo',
		descripcion: 'campanita FM: portadora de 1.76 kHz, moduladora ×1.41 con índice que cae',
		duracion_s: 0.9,
		expresion: '(1-exp(-t/0.001))*exp(-t/0.35)*sin(2*PI*1760*t+2.5*exp(-t/0.15)*sin(2*PI*2481.6*t))',
	},
	{
		id: 'clic-boton',
		categoria: 'clic',
		descripcion: 'clic de botón: ruido de 0.8 ms más un seno de 2.4 kHz que decae en 3 ms',
		duracion_s: 0.03,
		expresion: '(2*random(0)-1)*exp(-t/0.0008)+0.7*sin(2*PI*2400*t)*exp(-t/0.003)',
		filtros: 'highpass=f=700',
	},
	{
		id: 'clic-mouse',
		categoria: 'clic',
		descripcion: 'clic de mouse (bajar y soltar): dos transitorios de 1.6 kHz separados 45 ms',
		duracion_s: 0.08,
		expresion:
			'0.6*(2*random(0)-1)*exp(-t/0.0005)+sin(2*PI*1600*t)*exp(-t/0.004)+if(gte(t,0.045),0.4*(2*random(0)-1)*exp(-(t-0.045)/0.0004)+0.6*sin(2*PI*1900*(t-0.045))*exp(-(t-0.045)/0.003),0)',
		filtros: 'highpass=f=400',
	},
	{
		id: 'blip-cuadrado',
		categoria: 'blip',
		descripcion: 'blip: 880 Hz con armónicos impares (casi cuadrada suave), 30 ms de caída',
		duracion_s: 0.12,
		expresion: '(1-exp(-t/0.0008))*exp(-t/0.03)*(sin(2*PI*880*t)+0.3*sin(2*PI*2640*t)+0.15*sin(2*PI*4400*t))',
	},
	{
		id: 'blip-dos-tonos',
		categoria: 'blip',
		descripcion: 'blip de dos tonos que sube: 660 Hz y luego 990 Hz a los 50 ms',
		duracion_s: 0.16,
		expresion:
			'if(lt(t,0.05),(1-exp(-t/0.0008))*exp(-t/0.04)*sin(2*PI*660*t),(1-exp(-(t-0.05)/0.0008))*exp(-(t-0.05)/0.035)*sin(2*PI*990*(t-0.05)))',
	},
	{
		id: 'toque-madera',
		categoria: 'toque',
		descripcion: 'bloque de madera: modos de 620 y 1630 Hz que decaen en 18 y 9 ms, más el golpe',
		duracion_s: 0.12,
		expresion: '0.9*sin(2*PI*620*t)*exp(-t/0.018)+0.5*sin(2*PI*1630*t)*exp(-t/0.009)+0.3*(2*random(0)-1)*exp(-t/0.0015)',
	},
	{
		id: 'toque-sordo',
		categoria: 'toque',
		descripcion: 'golpe sordo: seno de 95 Hz con caída de tono y ruido corto, pasabajos a 2.5 kHz',
		duracion_s: 0.2,
		expresion: '(1-exp(-t/0.001))*exp(-t/0.045)*sin(2*PI*(95*t+3*(1-exp(-t/0.01))))+0.25*(2*random(0)-1)*exp(-t/0.004)',
		filtros: 'lowpass=f=2500',
	},
	{
		id: 'whoosh-pasa',
		categoria: 'whoosh',
		descripcion: 'whoosh que pasa: ruido por un pasabanda que sube a 3 kHz y vuelve, envolvente sen² de 0.5 s',
		duracion_s: 0.5,
		expresion: whooshSvf('400+2600*sin(PI*t/0.5)', 0.7, 'pow(sin(PI*t/0.5),2)'),
	},
	{
		id: 'whoosh-baja',
		categoria: 'whoosh',
		descripcion: 'swoosh que baja: pasabanda de 4.5 kHz a 600 Hz, ataque de 6 ms y caída de 90 ms',
		duracion_s: 0.35,
		expresion: whooshSvf('600+3900*exp(-t/0.1)', 0.5, '(1-exp(-t/0.006))*exp(-t/0.09)'),
	},
	{
		id: 'impacto-bombo',
		categoria: 'impacto',
		descripcion: 'bombo: seno que cae de 150 a 45 Hz, decae en 350 ms, con golpe de ruido de 6 ms',
		duracion_s: 0.9,
		expresion: '(1-exp(-t/0.0015))*exp(-t/0.35)*sin(2*PI*(45*t+3.675*(1-exp(-t/0.035))))+0.4*(2*random(0)-1)*exp(-t/0.006)',
		filtros: 'lowpass=f=4000',
	},
	{
		id: 'impacto-retumbo',
		categoria: 'impacto',
		descripcion: 'golpe con retumbo: seno de 60 Hz más ruido grave que se apaga en 120 ms',
		duracion_s: 0.9,
		expresion: '0.9*(1-exp(-t/0.001))*sin(2*PI*(60*t+2*(1-exp(-t/0.02))))*exp(-t/0.18)+0.6*(2*random(0)-1)*exp(-t/0.12)',
		filtros: 'lowpass=f=900,lowpass=f=900',
	},
];

/** Argumentos de ffmpeg para una receta (sin shell). */
export function argsSintesis(r: Receta, salida: string): string[] {
	return [
		'-nostdin',
		'-v',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		`aevalsrc=exprs='${r.expresion}':s=${TASA_SFX}:d=${r.duracion_s}`,
		...(r.filtros ? ['-af', r.filtros] : []),
		'-ac',
		'1',
		'-ar',
		String(TASA_SFX),
		'-c:a',
		'pcm_f32le',
		salida,
	];
}

/** Genera el WAV crudo de una receta. */
export function sintetizar(r: Receta, salida: string): void {
	mkdirSync(resolve(salida, '..'), {recursive: true});
	const p = spawnSync('ffmpeg', argsSintesis(r, salida), {encoding: 'utf8'});
	if (p.error) throw fallo(`sintetizar ${r.id}`, `no pude arrancar ffmpeg (${p.error.message})`, 'instala ffmpeg (brew install ffmpeg) y vuelve a intentar', 2, p.error);
	if (p.status !== 0 || !existsSync(salida) || statSync(salida).size <= 44) {
		throw fallo(`sintetizar ${r.id}`, `ffmpeg falló (${p.stderr.trim().split('\n').pop() ?? p.status})`, 'revisa la expresión de la receta en herramientas/sfx/sintesis.ts', 1, {args: argsSintesis(r, salida), stderr: p.stderr});
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const valor = (nombre: string): string | undefined => {
		const i = args.findIndex((a) => a === nombre || a.startsWith(`${nombre}=`));
		if (i < 0) return undefined;
		return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
	};
	const salida = valor('--salida');
	if (!salida) throw fallo('sintetizar los SFX', 'falta --salida <carpeta>', 'corre: npx tsx herramientas/sfx/sintesis.ts --salida $TMPDIR/sintesis', 2);
	const filtro = valor('--receta');
	const recetas = filtro ? RECETAS.filter((r) => r.id === filtro) : RECETAS;
	if (recetas.length === 0) throw fallo('sintetizar los SFX', `no hay receta "${filtro}"`, `usa una de: ${RECETAS.map((r) => r.id).join(', ')}`, 2);
	for (const r of recetas) {
		const ruta = join(resolve(salida), `${r.id}.wav`);
		sintetizar(r, ruta);
		console.log(`${r.id} (${r.categoria}): ${ruta}`);
	}
}

if (esPrincipal(import.meta.url)) await correr(main);
