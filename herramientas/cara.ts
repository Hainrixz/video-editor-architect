/**
 * Cara, barbilla y coronilla de un proyecto (o de un video suelto) → cara.json. Motor: Apple Vision en macOS (si
 * está compilado) o MediaPipe en el .venv (Windows, Linux o EDITOR_VISION=python); ver herramientas/lib/plataforma.ts.
 *
 *   npx tsx herramientas/cara.ts <slug> [--forzar] [--hilos N] [--sin-silueta] [--crudo <archivo.jsonl>]
 *   npx tsx herramientas/cara.ts --video <mp4> --salida <json> [--cortes 14.9,26.7] [--fps-muestreo 30] [--fondo]
 *                                [--hilos N] [--sin-silueta] [--crudo <archivo.jsonl>]
 *
 * Con <slug>: lee proyectos/<slug>/base.mp4 y sus cortes (manifest → etapas.base.parametros.tramos_cuadros),
 * escribe proyectos/<slug>/cara.json y registra la etapa "cara" en el manifest. Si la etapa sigue vigente
 * (misma base, mismos parámetros y mismo código), no repite el trabajo; --forzar la rehace.
 * Con --video: para medir reels publicados (estilo); no toca ningún manifest. --cortes son segundos de ese video.
 *   --fps-muestreo 30 analiza cada cuadro (lo que pide la detección de zooms); --fondo verifica cada zoom con el
 *   fondo (un zoom digital escala también el fondo; un corte entre tomas no).
 * --sin-silueta: sin la silueta de persona (coronilla y lados salen de las fórmulas; el motor tarda ~la mitad).
 * --crudo guarda las lecturas crudas del motor (una línea JSON por muestra), para depurar.
 *
 *   npx tsx herramientas/cara.ts <slug> --mascara   → proyectos/<slug>/persona.webm: la silueta de la persona recortada
 *   (VP9 con alfa; Vision VNGeneratePersonSegmentationRequest accurate con herramientas/bin/mascara, o MediaPipe con
 *   herramientas/py/mascara.py). Es la capa "persona encima" del estilo texto vivo: los titulares con `detras: true`
 *   quedan entre el fondo y la persona (src/reel/TextoVivo.tsx). La cadena ffmpeg → máscara → ffmpeg se arma con
 *   tres procesos y tuberías de Node (sin shell).
 *
 * Si hay cara en menos del 80 % de los cuadros, avisa (no falla): los stickers irán a la banda baja de zona_ui.
 * Formato de cara.json y método: herramientas/lib/cara.ts.
 *
 * Apple Vision no funciona dentro del sandbox: este comando está en excludedCommands (va SOLO en su llamada de Bash).
 * Códigos: 0 bien · 1 fallo interno · 2 falta algo tuyo o de una etapa anterior (base, binario, argumentos).
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
	analizarCara,
	binarioCaraDesactualizado,
	comandoCara,
	cortesDeTramos,
	detectarZooms,
	FUENTE_CARA_PY,
	FUENTE_CARA_SWIFT,
	leerCara,
	PARAMETROS_CARA,
	SUPUESTOS,
	verificarZoomsConFondo,
	type Cara,
	type CuadroVision,
	type ZoomDetectado,
	type ZoomVerificado,
} from './lib/cara.ts';
import {correr, esPrincipal, fallo} from './lib/fallo.ts';
import {DIR_PROYECTOS, dirProyecto, etapaVigente, hashearArchivo, leerManifest, RAIZ, registrarEtapa} from './lib/manifest.ts';
import {comandoVision, comoInstalar, faltaParaVision, type MotorVision} from './lib/plataforma.ts';

const USO =
	'npx tsx herramientas/cara.ts <slug> [--forzar] [--hilos N] [--sin-silueta]  ·  npx tsx herramientas/cara.ts --video <mp4> --salida <json> [--cortes s1,s2] [--fps-muestreo 30] [--fondo] [--hilos N] [--sin-silueta]';

/** Debajo de esta cobertura se avisa (plan, etapa 6: sin cara en más del 20 % de los cuadros). */
export const COBERTURA_AVISO = 0.8;
export const NOMBRE_SALIDA = 'cara.json';
const LIB_CARA = join(RAIZ, 'herramientas', 'lib', 'cara.ts');

/**
 * sha256 del código que decide el resultado (cara.swift o cara.py según el motor, + lib/cara.ts): si cambia, la
 * etapa se rehace. Con Vision se hashea igual que siempre (las etapas ya hechas siguen vigentes).
 */
export function hashCodigoCara(motor: MotorVision = comandoCara().motor): string {
	const h = createHash('sha256');
	for (const ruta of [motor === 'python' ? FUENTE_CARA_PY : FUENTE_CARA_SWIFT, LIB_CARA]) h.update(existsSync(ruta) ? readFileSync(ruta) : Buffer.alloc(0));
	return h.digest('hex');
}

/** Escribe un JSON de forma atómica (temporal + rename). */
export function escribirJsonAtomico(ruta: string, datos: unknown): void {
	mkdirSync(dirname(ruta), {recursive: true});
	const temporal = `${ruta}.tmp-${process.pid}`;
	writeFileSync(temporal, `${JSON.stringify(datos)}\n`);
	renameSync(temporal, ruta);
}

function escribirCrudo(ruta: string, cuadros: CuadroVision[]): void {
	mkdirSync(dirname(ruta), {recursive: true});
	writeFileSync(ruta, cuadros.map((c) => JSON.stringify(c)).join('\n') + '\n');
}

/** "--cortes 14.9,26.7" → [14.9, 26.7]. */
export function parsearCortes(texto: string | undefined): number[] | undefined {
	if (texto === undefined) return undefined;
	const cortes = texto
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
		.map(Number);
	if (cortes.some((c) => !Number.isFinite(c) || c < 0)) {
		throw fallo('leer los argumentos', `--cortes debe ser una lista de segundos ≥ 0 separados por comas (llegó "${texto}")`, `usa ${USO}`, 2);
	}
	return cortes;
}

function leerNumero(nombre: string, texto: string | undefined, min: number, max: number, entero: boolean): number | undefined {
	if (texto === undefined) return undefined;
	const n = Number(texto);
	if (!Number.isFinite(n) || n < min || n > max || (entero && !Number.isInteger(n))) {
		throw fallo('leer los argumentos', `${nombre} debe ser ${entero ? 'un entero' : 'un número'} de ${min} a ${max} (llegó "${texto}")`, `usa ${USO}`, 2);
	}
	return n;
}

/** Avance cada 20 % (Vision tarda unos segundos por minuto de video). */
function avance(etiqueta: string): (hechos: number, total: number) => void {
	let siguiente = 0.2;
	return (hechos, total) => {
		const f = total > 0 ? hechos / total : 0;
		while (f >= siguiente - 1e-9 && siguiente < 1 - 1e-9) {
			console.log(`  … ${etiqueta} ${Math.round(siguiente * 100)} %`);
			siguiente += 0.2;
		}
	};
}

export type ResultadoCaraProyecto = {cara: Cara; salida: string; reutilizada: boolean};

/** Cortes de la base de un proyecto (s), a partir de manifest.etapas.base.parametros.tramos_cuadros. */
export function cortesDelProyecto(tramos: unknown): number[] {
	const validos = Array.isArray(tramos) && tramos.every((t) => Array.isArray(t) && t.length === 2 && t.every((n) => Number.isInteger(n)));
	return validos ? cortesDeTramos(tramos as Array<[number, number]>) : [];
}

/** Cara de proyectos/<slug>/base.mp4 → proyectos/<slug>/cara.json + etapa "cara" en el manifest. */
export async function caraDeProyecto(
	slug: string,
	op: {forzar?: boolean; hilos?: number; silueta?: boolean; crudo?: string; proyectos?: string; alAvance?: (hechos: number, total: number) => void} = {},
): Promise<ResultadoCaraProyecto> {
	const proyectos = op.proyectos ?? DIR_PROYECTOS;
	const dir = dirProyecto(slug, proyectos);
	const base = join(dir, 'base.mp4');
	const salida = join(dir, NOMBRE_SALIDA);
	const etapaBase = leerManifest(slug, proyectos)?.etapas.base;
	if (!etapaBase || etapaBase.estado !== 'terminada' || !existsSync(base)) {
		throw fallo(`buscar la cara en ${slug}`, 'ese proyecto todavía no tiene su base.mp4 terminada', `corre antes npx tsx herramientas/base.ts ${slug} --cortes proyectos/${slug}/cortes.json`, 2);
	}
	// tramos_cuadros va en cuadros del crudo; con la base acelerada (velocidad F) cada corte cae en t/F.
	const velocidad = typeof etapaBase.parametros.velocidad === 'number' ? etapaBase.parametros.velocidad : 1;
	const cortes = cortesDelProyecto(etapaBase.parametros.tramos_cuadros).map((c) => c / velocidad);
	const silueta = op.silueta ?? true;
	const motor = comandoCara().motor;

	const entradas = [await hashearArchivo(base)];
	const parametros: Record<string, unknown> = {
		version: 1,
		cortes_s: cortes,
		silueta,
		analisis: PARAMETROS_CARA,
		supuestos: SUPUESTOS,
		codigo_sha256: hashCodigoCara(motor),
	};
	// Solo se anota si no es Vision: así las etapas ya hechas con Vision siguen vigentes.
	if (motor !== 'vision') parametros.motor = motor;
	if (!op.forzar && !op.crudo && (await etapaVigente(slug, 'cara', entradas, parametros, proyectos))) {
		return {cara: leerCara(salida), salida, reutilizada: true};
	}

	registrarEtapa(slug, 'cara', {estado: 'en-curso', entradas, parametros}, proyectos);
	let cara: Cara;
	try {
		cara = await analizarCara(base, {
			cortes,
			hilos: op.hilos,
			silueta,
			alCuadro: op.alAvance,
			alLeer: op.crudo ? (c) => escribirCrudo(resolve(op.crudo!), c) : undefined,
		});
		escribirJsonAtomico(salida, cara);
	} catch (error) {
		registrarEtapa(slug, 'cara', {estado: 'fallida', entradas, parametros}, proyectos);
		throw error;
	}
	const archivo = await hashearArchivo(salida, dir);
	registrarEtapa(
		slug,
		'cara',
		{
			estado: 'terminada',
			entradas,
			parametros,
			salidas: [archivo],
			extra: {resumen: cara.resumen, tiempos_s: cara.tiempos_s, duracion_proceso_s: cara.tiempos_s?.total},
		},
		proyectos,
	);
	return {cara, salida, reutilizada: false};
}

/** Cara de un video suelto (p. ej. un reel publicado) → el JSON que digas. No toca manifests ni el video. */
export async function caraDeVideo(
	video: string,
	salida: string,
	op: {cortes?: number[]; hilos?: number; crudo?: string; silueta?: boolean; fpsMuestreo?: number; alAvance?: (hechos: number, total: number) => void} = {},
): Promise<Cara> {
	const ruta = resolve(video);
	if (!existsSync(ruta)) throw fallo(`buscar la cara en ${video}`, `no existe ${ruta}`, 'revisa la ruta (arrástrala a la terminal para copiarla exacta)', 2);
	const destino = resolve(salida);
	if (destino === ruta) throw fallo(`buscar la cara en ${video}`, '--salida apunta al mismo video', 'usa otra ruta terminada en .json', 2);
	const cara = await analizarCara(ruta, {
		cortes: op.cortes,
		hilos: op.hilos,
		silueta: op.silueta ?? true,
		parametros: op.fpsMuestreo ? {fps_objetivo: op.fpsMuestreo} : undefined,
		alCuadro: op.alAvance,
		alLeer: op.crudo ? (c) => escribirCrudo(resolve(op.crudo!), c) : undefined,
	});
	escribirJsonAtomico(destino, cara);
	return cara;
}

const pct = (f: number) => `${(f * 100).toFixed(1)} %`;
const px = (v: number | null) => (v === null ? 'N/A' : `${Math.round(v)} px`);

/** Avisos para el creador (no fallan). */
export function avisosCara(cara: Cara): string[] {
	const r = cara.resumen;
	const avisos: string[] = [];
	if (r.cobertura < COBERTURA_AVISO) {
		avisos.push(
			`Aviso: solo hay cara en el ${pct(r.cobertura)} de los cuadros (${r.cuadros - r.cuadros_sin_cara} de ${r.cuadros}); donde no hay cara, los stickers van a la banda baja de zona_ui.`,
		);
	}
	if (r.cuadros > 0 && r.muestras_con_cara === 0) {
		avisos.push(
			comandoCara().motor === 'vision'
				? 'Aviso: Vision no vio ninguna cara. Si esto corrió dentro del sandbox, ahí Vision no ve caras: córrelo solo en su llamada de Bash (está en excludedCommands).'
				: 'Aviso: MediaPipe no vio ninguna cara (no es el sandbox: el motor Python sí corre ahí). Revisa que el video tenga una persona de frente y bien iluminada.',
		);
	}
	if (r.barbillas_estimadas > 0) {
		avisos.push(`Nota: en ${r.barbillas_estimadas} muestras el motor no dio el contorno y la barbilla se estimó con la caja (factor ${r.factores.barbilla.valor}, ${r.factores.barbilla.fuente}).`);
	}
	if (cara.analisis.silueta && r.muestras_con_cara > 0 && r.coronillas_medidas < r.muestras_con_cara * 0.5) {
		avisos.push(`Nota: la silueta solo dio coronilla creíble en ${r.coronillas_medidas} de ${r.muestras_con_cara} muestras con cara; en las demás se usó la fórmula (factor ${r.factores.coronilla.valor}, ${r.factores.coronilla.fuente}).`);
	}
	if (binarioCaraDesactualizado()) {
		avisos.push('Aviso: herramientas/bin/cara es más viejo que herramientas/vision/cara.swift; recompílalo con herramientas/vision/compilar-cara.sh.');
	}
	return avisos;
}

/** Resumen de una cara en español (para la terminal). */
export function resumenCara(cara: Cara, salida: string, reutilizada: boolean): string {
	const r = cara.resumen;
	const rel = relative(RAIZ, salida);
	const lineas = [`Cara ${reutilizada ? 'ya estaba al día' : 'lista'}: ${rel.startsWith('..') ? salida : rel}`];
	lineas.push(
		`  cobertura ${pct(r.cobertura)} de ${r.cuadros} cuadros a 30 fps (${cara.analisis.vision.startsWith('MediaPipe') ? 'MediaPipe' : 'Vision'} vio cara en ${r.muestras_con_cara} de ${r.muestras} muestras a ${cara.fps_muestreo} fps)`,
	);
	lineas.push(`  barbilla p50 ${px(r.barbilla_y.p50)} · p90 ${px(r.barbilla_y.p90)} · máx ${px(r.barbilla_y.max)} · boca p50 ${px(r.boca_y?.p50 ?? null)} · máx ${px(r.boca_y?.max ?? null)} (labios en ${r.bocas_medidas ?? 0} de ${r.muestras_con_cara} muestras) · coronilla p50 ${px(r.coronilla_y.p50)} (base 1080×1920)`);
	const f = r.factores;
	lineas.push(
		`  coronilla medida con la silueta en ${r.coronillas_medidas} de ${r.muestras_con_cara} muestras (factor ${f.coronilla.valor}, ${f.coronilla.fuente}, n=${f.coronilla.n}) · lados medidos en ${r.lados_medidos}`,
	);
	const extra = [`${cara.cortes_s.length} corte${cara.cortes_s.length === 1 ? '' : 's'} reinicia${cara.cortes_s.length === 1 ? '' : 'n'} el suavizado`];
	if (cara.tiempos_s && cara.duracion_s > 0) {
		extra.push(`${cara.tiempos_s.total.toFixed(1)} s (${((cara.tiempos_s.total / cara.duracion_s) * 60).toFixed(1)} s por minuto de video)`);
	}
	lineas.push(`  ${extra.join(' · ')}`);
	return lineas.join('\n');
}

/** Zooms detectados (para --video): "3 zooms: 12.4 s ×1.18 alejar, …". */
export function resumenZooms(cara: Cara, zooms: ReadonlyArray<ZoomDetectado | ZoomVerificado>): string {
	const nota = cara.analisis.paso > 1 ? ' (con muestras salteadas una toma en mano se puede colar: usa --fps-muestreo 30)' : '';
	if (zooms.length === 0) return `  zooms (salto de tamaño de cara > 7 %): ninguno${nota}`;
	const lista = zooms
		.slice(0, 12)
		.map((z) => `${z.t.toFixed(2)} s ×${z.razon.toFixed(2)} ${z.tipo}${'fondo' in z ? ` [fondo: ${z.fondo.veredicto}]` : ''}`)
		.join(', ');
	const confirmados = zooms.filter((z) => 'fondo' in z && z.fondo.veredicto === 'zoom').length;
	const fondo = zooms.some((z) => 'fondo' in z) ? ` · ${confirmados} confirmados por el fondo` : '';
	return `  zooms (salto de tamaño de cara > 7 %): ${zooms.length}${fondo}${nota} → ${lista}${zooms.length > 12 ? ', …' : ''}`;
}

/** Tamaño al que el motor separa a la persona (la máscara se escala al de la base con bordes suaves). */
export const MASCARA_VISION = {ancho: 720, alto: 1280} as const;

/**
 * Argumentos de los tres procesos que arman persona.webm (puro): base → cuadros RGBA → motor de máscara → máscara
 * gris → alphamerge con la base → VP9 con alfa. Sin shell: cada uno es un arreglo para spawn.
 */
export function argumentosMascara(base: string, salida: string, tam: {ancho: number; alto: number}): {entrada: string[]; mascara: string[]; salida: string[]} {
	const {ancho, alto} = MASCARA_VISION;
	return {
		entrada: ['-v', 'error', '-nostdin', '-i', base, '-vf', `scale=${ancho}:${alto}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		mascara: ['--ancho', String(ancho), '--alto', String(alto)],
		salida: [
			'-v', 'error', '-y', '-i', base,
			'-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${ancho}x${alto}`, '-r', '30', '-i', '-',
			'-filter_complex', `[1:v]scale=${tam.ancho}:${tam.alto}:flags=bicubic,boxblur=1[m];[0:v][m]alphamerge,format=yuva420p[v]`,
			'-map', '[v]', '-an',
			'-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-auto-alt-ref', '0',
			salida,
		],
	};
}

/** Corre ffmpeg | motor de máscara | ffmpeg con tuberías de Node. Resuelve con el stderr de quien falló (o null). */
function correrCadenaMascara(args: ReturnType<typeof argumentosMascara>): Promise<string | null> {
	const motor = comandoVision('mascara', {raiz: RAIZ});
	return new Promise((resolver) => {
		const a = spawn('ffmpeg', args.entrada, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
		const m = spawn(motor.programa, [...motor.prefijo, ...args.mascara], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...motor.env}, windowsHide: true});
		const b = spawn('ffmpeg', args.salida, {stdio: ['pipe', 'inherit', 'pipe'], windowsHide: true});
		const errores = {a: '', m: '', b: ''};
		const juntar = (k: keyof typeof errores) => (d: Buffer) => {
			errores[k] = (errores[k] + d.toString()).slice(-4000);
		};
		a.stderr.on('data', juntar('a'));
		m.stderr.on('data', juntar('m'));
		b.stderr.on('data', juntar('b'));
		m.stdin.on('error', () => {});
		b.stdin.on('error', () => {});
		a.stdout.pipe(m.stdin);
		m.stdout.pipe(b.stdin);
		const codigos: Record<string, number | null> = {};
		let listo = false;
		const terminar = (k: 'a' | 'm' | 'b', codigo: number | null) => {
			codigos[k] = codigo;
			if (codigo !== 0 && !listo) {
				listo = true;
				for (const p of [a, m, b]) p.kill('SIGKILL');
				resolver(`${k === 'm' ? motor.nombre : 'ffmpeg'} salió con ${codigo}: ${errores[k].trim().split('\n').pop() ?? ''}`);
				return;
			}
			if (!listo && ['a', 'm', 'b'].every((x) => codigos[x] === 0)) {
				listo = true;
				resolver(null);
			}
		};
		for (const [k, p] of [['a', a], ['m', m], ['b', b]] as const) {
			p.on('error', (e) => {
				errores[k] += e.message;
				terminar(k, -1);
			});
			p.on('close', (c) => terminar(k, c));
		}
	});
}

/** proyectos/<slug>/persona.webm (la silueta de la persona con alfa, a la resolución de la base). */
export async function mascaraDeProyecto(slug: string): Promise<string> {
	const dir = dirProyecto(slug);
	const base = join(dir, 'base.mp4');
	if (!existsSync(base)) throw fallo('recortar la silueta', `no existe ${relative(RAIZ, base)}`, `corre primero npx tsx herramientas/base.ts ${slug}`, 2);
	const motor = comandoVision('mascara', {raiz: RAIZ});
	const falta = faltaParaVision(motor);
	if (falta) throw fallo('recortar la silueta', `no existe ${falta === motor.programa && motor.motor === 'python' ? 'el Python del .venv' : motor.nombre}`, motor.comoInstalar, 2);
	const sonda = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', base], {encoding: 'utf8', windowsHide: true});
	if (sonda.error) throw fallo('recortar la silueta', 'no encuentro ffprobe en el PATH', `instala ffmpeg (${comoInstalar('ffmpeg')})`, 2, sonda.error);
	const [ancho, alto] = sonda.stdout.trim().split(',').map(Number);
	if (!(ancho > 0 && alto > 0)) throw fallo('recortar la silueta', 'ffprobe no dio el tamaño de la base', 'revisa que base.mp4 sea un video', 1, sonda.stderr);
	const salida = join(dir, 'persona.webm');
	const temporal = join(dir, `persona.tmp-${process.pid}.webm`);
	const error = await correrCadenaMascara(argumentosMascara(base, temporal, {ancho, alto}));
	if (error !== null) {
		const siguiente = motor.motor === 'vision' ? 'córrelo solo en su llamada de Bash (Vision no funciona en el sandbox)' : 'revisa el detalle en proyectos/_logs/fallos.log';
		throw fallo('recortar la silueta', `falló la cadena ffmpeg → ${motor.nombre} → ffmpeg`, siguiente, 1, error);
	}
	renameSync(temporal, salida);
	return salida;
}

/** "Vision" o "MediaPipe", para los mensajes. */
function nombreMotor(): string {
	return comandoCara().motor === 'vision' ? 'Vision' : 'MediaPipe';
}

async function main(): Promise<void> {
	let valores;
	let posicionales: string[];
	try {
		({values: valores, positionals: posicionales} = parseArgs({
			allowPositionals: true,
			options: {
				video: {type: 'string'},
				salida: {type: 'string'},
				cortes: {type: 'string'},
				hilos: {type: 'string'},
				crudo: {type: 'string'},
				'sin-silueta': {type: 'boolean', default: false},
				'fps-muestreo': {type: 'string'},
				fondo: {type: 'boolean', default: false},
				forzar: {type: 'boolean', default: false},
				mascara: {type: 'boolean', default: false},
				ayuda: {type: 'boolean', short: 'h', default: false},
			},
		}));
	} catch (error) {
		const mensaje = error instanceof Error ? error.message : String(error);
		const desconocida = /Unknown option '([^']+)'/.exec(mensaje);
		throw fallo('leer los argumentos', desconocida ? `no conozco la opción ${desconocida[1]}` : 'los argumentos no tienen la forma esperada', `usa ${USO}`, 2, mensaje);
	}
	if (valores.ayuda) {
		console.log(`Uso: ${USO}`);
		return;
	}
	const hilos = leerNumero('--hilos', valores.hilos, 1, 16, true);
	const silueta = !valores['sin-silueta'];

	if (valores.video !== undefined) {
		if (posicionales.length > 0) throw fallo('leer los argumentos', 'con --video no va un slug', `usa ${USO}`, 2);
		if (!valores.salida) throw fallo('leer los argumentos', 'con --video falta --salida <archivo.json>', `usa ${USO}`, 2);
		const fpsMuestreo = leerNumero('--fps-muestreo', valores['fps-muestreo'], 1, 60, false);
		console.log(`Buscando la cara en ${valores.video} (${nombreMotor()}, ${fpsMuestreo ?? PARAMETROS_CARA.fps_objetivo} fps${silueta ? ', con silueta' : ''})…`);
		const cara = await caraDeVideo(valores.video, valores.salida, {cortes: parsearCortes(valores.cortes), hilos, crudo: valores.crudo, silueta, fpsMuestreo, alAvance: avance(nombreMotor())});
		console.log(resumenCara(cara, resolve(valores.salida), false));
		const zooms = detectarZooms(cara);
		console.log(resumenZooms(cara, valores.fondo ? await verificarZoomsConFondo(resolve(valores.video), cara, zooms) : zooms));
		for (const a of avisosCara(cara)) console.log(a);
		return;
	}

	if (posicionales.length !== 1) {
		throw fallo('leer los argumentos', posicionales.length === 0 ? 'falta el slug del proyecto (o --video)' : 'me pasaste más de un slug', `usa ${USO}`, 2);
	}
	if (valores.cortes !== undefined || valores.salida !== undefined || valores['fps-muestreo'] !== undefined || valores.fondo) {
		throw fallo('leer los argumentos', '--cortes, --salida, --fps-muestreo y --fondo solo van con --video (en un proyecto los cortes salen del manifest)', `usa ${USO}`, 2);
	}
	const slug = posicionales[0];
	if (valores.mascara) {
		console.log(`Recortando la silueta en proyectos/${slug}/base.mp4 (${nombreMotor()})…`);
		const t0 = Date.now();
		const salida = await mascaraDeProyecto(slug);
		console.log(`Silueta lista: ${relative(RAIZ, salida)} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
		return;
	}
	console.log(`Buscando la cara en proyectos/${slug}/base.mp4 (${nombreMotor()}, ${PARAMETROS_CARA.fps_objetivo} fps${silueta ? ', con silueta' : ''})…`);
	const r = await caraDeProyecto(slug, {forzar: valores.forzar, hilos, silueta, crudo: valores.crudo, alAvance: avance(nombreMotor())});
	console.log(resumenCara(r.cara, r.salida, r.reutilizada));
	for (const a of avisosCara(r.cara)) console.log(a);
}

if (esPrincipal(import.meta.url)) await correr(main);
