/**
 * editar.ts — /editar de punta a punta, con sus puntos de control.
 *
 *   npx tsx herramientas/editar.ts <crudo> [--slug s]                  1. ingesta, transcripción y propuesta de cortes → para en el TEXTO
 *   npx tsx herramientas/editar.ts --slug s --aprobar-texto [archivo]  2. cortes aprobados, base, cara, encuadre, subtítulos y dirección → para en la DIRECCIÓN
 *   npx tsx herramientas/editar.ts --slug s --borrador                 3. armar-edl, validar, borrador 720p y QA → para en la REVISIÓN
 *   npx tsx herramientas/editar.ts --slug s --final [--version N]      4. render final con loudness y QA final
 *   npx tsx herramientas/editar.ts <crudo> --todo [--slug s]           todo sin parar (texto propuesto y dirección tal cual)
 *
 * Cada etapa corre como su propia CLI (y queda en el manifest del proyecto). Este comando está excluido del
 * sandbox porque llama a whisper (GPU), Vision (cara) y Chrome (render): va SOLO en su llamada de Bash.
 * Entre el paso 2 y el 3, Claude revisa direccion.md y, si quiere cambiar algo, escribe notas-director.json
 * y vuelve a correr `npx tsx herramientas/director.ts <slug>` antes de --borrador.
 * Tiempos por etapa: proyectos/<slug>/editar.json.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {parseArgs} from 'node:util';
import {correr, esPrincipal, fallo, FalloEditor, type CodigoFallo} from './lib/fallo';
import {RAIZ} from './lib/manifest';
import {esSlugValido, REGLA_SLUG} from './lib/slug';
import {ingerir} from './ingesta';

const USO = 'npx tsx herramientas/editar.ts <crudo> [--slug s] | --slug s --aprobar-texto [archivo] | --slug s --borrador | --slug s --final [--version N] | <crudo> --todo';

type Registro = {
	version: 1;
	slug: string;
	crudo: string | null;
	punto_de_control: 'texto' | 'direccion' | 'revision' | 'listo' | null;
	etapas: Array<{etapa: string; inicio: string; duracion_s: number; ok: boolean}>;
};

const dirDe = (slug: string) => join(RAIZ, 'proyectos', slug);

function leerRegistro(slug: string): Registro {
	const ruta = join(dirDe(slug), 'editar.json');
	if (existsSync(ruta)) return JSON.parse(readFileSync(ruta, 'utf8')) as Registro;
	return {version: 1, slug, crudo: null, punto_de_control: null, etapas: []};
}

function guardarRegistro(r: Registro): void {
	writeFileSync(join(dirDe(r.slug), 'editar.json'), `${JSON.stringify(r, null, '\t')}\n`);
}

/** Corre una CLI del proyecto como etapa; si falla, propaga su código con una frase clara. */
function etapa(r: Registro, nombre: string, script: string, args: string[]): void {
	const inicio = Date.now();
	console.log(`\n▶ ${nombre}`);
	const res = spawnSync('npx', ['tsx', script, ...args], {cwd: RAIZ, stdio: 'inherit', env: process.env});
	const ok = res.status === 0;
	r.etapas.push({etapa: nombre, inicio: new Date(inicio).toISOString(), duracion_s: Math.round((Date.now() - inicio) / 100) / 10, ok});
	guardarRegistro(r);
	if (!ok) {
		const codigo = ([1, 2, 3].includes(res.status ?? 1) ? res.status : 1) as CodigoFallo;
		throw fallo(`terminar la etapa "${nombre}"`, `${script} salió con código ${res.status ?? res.signal}`, `revisa el mensaje de arriba y vuelve a correr este paso de editar.ts`, codigo);
	}
}

const existe = (rel: string) => existsSync(join(RAIZ, rel));

/** Paso 1: ingesta + transcripción + propuesta de cortes. */
async function paso1(crudo: string, slugPedido: string | undefined): Promise<Registro> {
	const ing = await ingerir({ruta: crudo, slug: slugPedido});
	const r = leerRegistro(ing.slug);
	r.crudo = crudo;
	guardarRegistro(r);
	etapa(r, 'transcribir', 'herramientas/transcribir.ts', [ing.slug]);
	etapa(r, 'cortes (propuesta)', 'herramientas/cortes.ts', [ing.slug]);
	r.punto_de_control = 'texto';
	guardarRegistro(r);
	return r;
}

/** Paso 2: texto aprobado → base → cara → encuadre → base reencuadrada → cara → subtítulos → dirección. */
function paso2(r: Registro, textoAprobado: string | null): void {
	const s = r.slug;
	if (textoAprobado) etapa(r, 'cortes (texto aprobado)', 'herramientas/cortes.ts', [s, '--aplicar-texto', textoAprobado]);
	const cortes = `proyectos/${s}/cortes.json`;
	etapa(r, 'base', 'herramientas/base.ts', [s, '--cortes', cortes]);
	etapa(r, 'cara', 'herramientas/cara.ts', [s]);
	if (existe('herramientas/encuadre.ts') && !existe('estilo/encuadre.json')) {
		console.error('Aviso: no hay estilo/encuadre.json (objetivo de encuadre): sigo sin reencuadrar. Apréndelo con /aprender-estilo.');
	} else if (existe('herramientas/encuadre.ts')) {
		// Calcula el recorte para que tu cara quede como en tus reels y, con --aplicar, rehace la base desde el original.
		etapa(r, 'encuadre', 'herramientas/encuadre.ts', [s, '--aplicar']);
		const rutaEncuadre = join(dirDe(s), 'encuadre.json');
		const identidad = existsSync(rutaEncuadre) ? (JSON.parse(readFileSync(rutaEncuadre, 'utf8')) as {identidad?: boolean}).identidad !== false : true;
		if (!identidad) etapa(r, 'cara (base reencuadrada)', 'herramientas/cara.ts', [s]);
	}
	etapa(r, 'subtítulos', 'herramientas/subtitulos.ts', [s]);
	if (existe('herramientas/director.ts')) etapa(r, 'dirección (borrador)', 'herramientas/director.ts', [s]);
	r.punto_de_control = 'direccion';
	guardarRegistro(r);
}

function versionMasAlta(slug: string): number {
	return Math.max(
		0,
		...readdirSync(dirDe(slug))
			.map((n) => Number(/^edicion-v(\d+)\.json$/.exec(n)?.[1] ?? 0))
			.filter((n) => n > 0),
	);
}

/** Paso 3: armar la edición, validarla, borrador y QA del borrador. */
function paso3(r: Registro): number {
	const s = r.slug;
	etapa(r, 'armar la edición', 'herramientas/armar-edl.ts', [s]);
	const v = versionMasAlta(s);
	etapa(r, 'validar', 'herramientas/validar.ts', [`proyectos/${s}/edicion-v${v}.json`]);
	etapa(r, 'borrador', 'herramientas/render.ts', [s, '--version', String(v), '--borrador']);
	etapa(r, 'QA del borrador', 'herramientas/qa.ts', [s, '--version', String(v), '--borrador']);
	r.punto_de_control = 'revision';
	guardarRegistro(r);
	return v;
}

/** Paso 4: render final con loudness y QA final. */
function paso4(r: Registro, version: number): void {
	const s = r.slug;
	etapa(r, 'render final', 'herramientas/render.ts', [s, '--version', String(version)]);
	etapa(r, 'QA final', 'herramientas/qa.ts', [s, '--version', String(version)]);
	r.punto_de_control = 'listo';
	guardarRegistro(r);
}

function resumenTiempos(r: Registro): string {
	const total = r.etapas.reduce((a, e) => a + e.duracion_s, 0);
	return `${r.etapas.length} etapas en ${total.toFixed(1)} s (detalle en proyectos/${r.slug}/editar.json)`;
}

async function main(): Promise<void> {
	let v: Record<string, string | boolean | undefined>;
	let pos: string[];
	try {
		const p = parseArgs({
			allowPositionals: true,
			options: {
				slug: {type: 'string'},
				'aprobar-texto': {type: 'boolean'},
				borrador: {type: 'boolean'},
				final: {type: 'boolean'},
				todo: {type: 'boolean'},
				version: {type: 'string'},
			},
		});
		v = p.values;
		pos = p.positionals;
	} catch (error) {
		throw fallo('leer las opciones', (error as Error).message, `usa: ${USO}`, 2);
	}
	const slug = v.slug as string | undefined;
	if (slug !== undefined && !esSlugValido(slug)) throw fallo('editar', `"${slug}" no es un slug válido`, `usa ${REGLA_SLUG}`, 2);

	if (v.todo) {
		const crudo = pos[0];
		if (!crudo) throw fallo('editar', 'falta la ruta del crudo', `usa: ${USO}`, 2);
		const r = await paso1(crudo, slug);
		paso2(r, null);
		const version = paso3(r);
		paso4(r, version);
		console.log(`\n✔ Listo: proyectos/${r.slug}/salida/final-v${version}.mp4 · ${resumenTiempos(r)}`);
		return;
	}
	if (v['aprobar-texto']) {
		if (!slug) throw fallo('editar', 'falta --slug', `usa: ${USO}`, 2);
		const archivo = pos[0] ?? null;
		const r = leerRegistro(slug);
		paso2(r, archivo);
		console.log(`\n⏸ Punto de control (dirección): revisa proyectos/${slug}/direccion.md. Para cambiar algo, escribe proyectos/${slug}/notas-director.json y corre npx tsx herramientas/director.ts ${slug}. Luego: npx tsx herramientas/editar.ts --slug ${slug} --borrador`);
		return;
	}
	if (v.borrador) {
		if (!slug) throw fallo('editar', 'falta --slug', `usa: ${USO}`, 2);
		const r = leerRegistro(slug);
		const version = paso3(r);
		console.log(`\n⏸ Punto de control (revisión): borrador en proyectos/${slug}/salida/borrador-v${version}.mp4 y hojas en proyectos/${slug}/qa/. Si todo está bien: npx tsx herramientas/editar.ts --slug ${slug} --final --version ${version}`);
		return;
	}
	if (v.final) {
		if (!slug) throw fallo('editar', 'falta --slug', `usa: ${USO}`, 2);
		const r = leerRegistro(slug);
		const version = v.version ? Number(v.version) : versionMasAlta(slug);
		if (!Number.isInteger(version) || version < 1) throw fallo('editar', `la versión "${v.version}" no es válida`, 'usa --version N con un número entero', 2);
		paso4(r, version);
		console.log(`\n✔ Listo: proyectos/${slug}/salida/final-v${version}.mp4 · ${resumenTiempos(r)}`);
		return;
	}
	const crudo = pos[0];
	if (!crudo) throw fallo('editar', 'falta la ruta del crudo', `usa: ${USO}`, 2);
	const r = await paso1(crudo, slug);
	console.log(`\n⏸ Punto de control (texto): revisa proyectos/${r.slug}/texto-propuesto.md (${relative(RAIZ, join(dirDe(r.slug), 'texto-propuesto.md'))}). Si lo apruebas tal cual: npx tsx herramientas/editar.ts --slug ${r.slug} --aprobar-texto; si lo editas: … --aprobar-texto <archivo>`);
}

if (esPrincipal(import.meta.url)) {
	void correr(async () => {
		try {
			await main();
		} catch (error) {
			if (error instanceof FalloEditor) throw error;
			throw fallo('editar', (error as Error).message ?? String(error), 'revisa el mensaje y vuelve a correr', 1, error);
		}
	});
}
