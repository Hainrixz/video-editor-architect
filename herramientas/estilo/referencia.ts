/**
 * referencia.ts: prepara un reel de REFERENCIA para entrenar un estilo nuevo (/entrenar-estilo). Mide el ritmo de
 * cortes y arma las hojas de contacto que Claude mira para ver lo que al creador le gusta. Todo local y gratis.
 *
 *   npx tsx herramientas/estilo/referencia.ts <reel.mp4 | URL pública> --estilo <id> [--nombre x]
 *
 * Con una URL la baja con yt-dlp, sin cookies (a veces Instagram no deja; entonces pídele el mp4 al creador).
 * Salida en referencias/estilos/<id>/<nombre>/ (git la ignora):
 *   - video.mp4: copia, o lo bajado.
 *   - ritmo.json: duración, cortes de toma (detector de escena de ffmpeg), cortes por minuto y toma media/mediana.
 *   - hoja.jpg: 1 cuadro por segundo, todo el reel.
 *   - gancho.jpg: 4 cuadros por segundo, los primeros 3 s.
 * Lo fino (subtítulos, tarjetas, stickers, SFX) se mide aparte con medir.ts, medir-capas.ts y overlays.ts.
 *
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (no existe, no es video, falta --estilo) · 3 no se pudo bajar.
 */
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, extname, join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';

/** Umbral del detector de escena de ffmpeg (0–1): con 0.3 salen los cortes secos y no el movimiento de cámara. */
export const UMBRAL_ESCENA = 0.3;

/** Tiempos (s) de los cortes que reporta `showinfo` tras `select='gt(scene,U)'`. Pura. */
export function cortesDeShowinfo(texto: string): number[] {
	const t: number[] = [];
	for (const m of texto.matchAll(/pts_time:\s*([0-9.]+)/g)) {
		const v = Number(m[1]);
		if (Number.isFinite(v)) t.push(v);
	}
	return t.sort((a, b) => a - b);
}

export type Ritmo = {
	duracion_s: number;
	cortes: number;
	cortes_por_min: number;
	toma_media_s: number;
	toma_mediana_s: number;
	tiempos_corte_s: number[];
	umbral_escena: number;
};

/** Ritmo de cortes de un reel: tomas entre cortes (incluye la primera y la última). Pura. */
export function calcularRitmo(cortes: readonly number[], duracion: number, umbral = UMBRAL_ESCENA): Ritmo {
	if (!(duracion > 0)) throw fallo('medir el ritmo', `la duración no sirve (${duracion})`, 'revisa que el archivo sea un video', 2);
	const dentro = [...new Set(cortes.filter((c) => c > 0.05 && c < duracion - 0.05).map((c) => +c.toFixed(3)))].sort((a, b) => a - b);
	const bordes = [0, ...dentro, duracion];
	const tomas = bordes.slice(1).map((b, i) => b - bordes[i]);
	const orden = [...tomas].sort((a, b) => a - b);
	const mitad = Math.floor(orden.length / 2);
	const mediana = orden.length % 2 ? orden[mitad] : (orden[mitad - 1] + orden[mitad]) / 2;
	const r3 = (v: number) => +v.toFixed(3);
	return {
		duracion_s: r3(duracion),
		cortes: dentro.length,
		cortes_por_min: r3((dentro.length / duracion) * 60),
		toma_media_s: r3(duracion / tomas.length),
		toma_mediana_s: r3(mediana),
		tiempos_corte_s: dentro,
		umbral_escena: umbral,
	};
}

/** Nombre de carpeta seguro a partir de un archivo o una URL (el shortCode de Instagram si lo trae). Pura. */
export function nombreDeReferencia(entrada: string): string {
	const ig = entrada.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
	const base = ig ? ig[1] : basename(entrada, extname(entrada));
	const limpio = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!limpio) throw fallo('nombrar la referencia', `no saco un nombre de "${entrada}"`, 'pasa --nombre', 2);
	return limpio.slice(0, 60);
}

function ejecutar(cmd: string, args: string[]): {codigo: number; salida: string; error: string} {
	const r = spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
	return {codigo: r.status ?? 1, salida: r.stdout ?? '', error: r.stderr ?? ''};
}

function principal(argv: string[]): void {
	const {values: v, positionals} = parseArgs({args: argv, allowPositionals: true, options: {estilo: {type: 'string'}, nombre: {type: 'string'}}});
	const entrada = positionals[0];
	if (!entrada || !v.estilo) throw fallo('preparar la referencia', 'faltan argumentos', 'usa: npx tsx herramientas/estilo/referencia.ts <reel.mp4 | URL> --estilo <id> [--nombre x]', 2);
	if (!/^[a-z0-9-]+$/.test(v.estilo)) throw fallo('preparar la referencia', `--estilo "${v.estilo}" no es un id válido`, 'usa minúsculas, números y guiones', 2);
	const nombre = v.nombre ?? nombreDeReferencia(entrada);
	const dir = join(RAIZ, 'referencias', 'estilos', v.estilo, nombre);
	mkdirSync(dir, {recursive: true});
	const video = join(dir, 'video.mp4');

	if (/^https?:\/\//.test(entrada)) {
		if (!existsSync(video)) {
			const r = ejecutar('yt-dlp', ['-f', 'mp4/best', '-o', video, '--no-playlist', '--quiet', entrada]);
			if (r.codigo !== 0 || !existsSync(video)) throw fallo('bajar la referencia', `yt-dlp no pudo bajar ${entrada}`, 'pídele al creador el mp4 (o pasa la ruta local)', 3);
		}
	} else {
		if (!existsSync(entrada)) throw fallo('preparar la referencia', `no existe ${entrada}`, 'revisa la ruta', 2);
		copyFileSync(entrada, video);
	}

	const sonda = ejecutar('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]);
	const duracion = Number(sonda.salida.trim());
	if (sonda.codigo !== 0 || !(duracion > 0)) throw fallo('leer la referencia', `${relative(RAIZ, video)} no parece un video`, 'pasa un mp4', 2);

	const escena = ejecutar('ffmpeg', ['-hide_banner', '-i', video, '-vf', `select='gt(scene,${UMBRAL_ESCENA})',showinfo`, '-an', '-f', 'null', '-']);
	const ritmo = calcularRitmo(cortesDeShowinfo(escena.error), duracion);
	writeFileSync(join(dir, 'ritmo.json'), `${JSON.stringify({fuente: entrada, ...ritmo}, null, '\t')}\n`);

	const columnas = 8;
	const filas = Math.max(1, Math.ceil(duracion / columnas));
	ejecutar('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-vf', `fps=1,scale=180:-1,tile=${columnas}x${filas}`, '-frames:v', '1', join(dir, 'hoja.jpg')]);
	ejecutar('ffmpeg', ['-y', '-loglevel', 'error', '-t', '3', '-i', video, '-vf', 'fps=4,scale=240:-1,tile=6x2', '-frames:v', '1', join(dir, 'gancho.jpg')]);

	console.log(`Listo: ${relative(RAIZ, dir)}/ · ${ritmo.duracion_s} s · ${ritmo.cortes} cortes (${ritmo.cortes_por_min}/min, toma mediana ${ritmo.toma_mediana_s} s) · hoja.jpg y gancho.jpg`);
}

if (esPrincipal(import.meta.url)) correr(() => principal(process.argv.slice(2)));
