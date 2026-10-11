import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';
import {
	chequeosLlaves,
	detectarRetina,
	estadoLlaves,
	FILTROS_REQUERIDOS,
	filtrosFaltantes,
	formatearTabla,
	LLAVES,
	problemasConfigPlaywright,
	revisarConfigsPlaywright,
} from '../../herramientas/doctor';

const RAIZ = fileURLToPath(new URL('../..', import.meta.url));

// Valores falsos: si alguno aparece en una salida, el doctor está filtrando llaves.
const FALSO_ARCHIVO = 'VALOR-FALSO-ARCHIVO-9f3a1c';
const FALSO_EXPORT = 'apify_api_VALORFALSOEXPORT77';
const FALSO_ENTORNO = 'VALOR-FALSO-ENTORNO-7c1b2d';

const temporales: string[] = [];
function carpetaTemporal(prefijo: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefijo));
	temporales.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temporales) rmSync(dir, {recursive: true, force: true});
});

/** HOME temporal con ~/.config/claude-editor/.env falso. */
function homeConEnv(contenido: string): string {
	const home = carpetaTemporal('doctor-home-');
	mkdirSync(join(home, '.config', 'claude-editor'), {recursive: true});
	writeFileSync(join(home, '.config', 'claude-editor', '.env'), contenido, {mode: 0o600});
	return home;
}

describe('problemasConfigPlaywright (configs simuladas)', () => {
	it('no marca nada en un config vacío o seguro', () => {
		expect(problemasConfigPlaywright({})).toEqual([]);
		expect(problemasConfigPlaywright({browser: {browserName: 'chromium', isolated: true}})).toEqual([]);
		expect(problemasConfigPlaywright({browser: {userDataDir: null, cdpEndpoint: ''}})).toEqual([]);
		expect(problemasConfigPlaywright({outputDir: 'salida', timeouts: {action: 5000}})).toEqual([]);
	});

	it('marca userDataDir con valor', () => {
		expect(problemasConfigPlaywright({browser: {userDataDir: '/home/x/perfil'}})).toEqual(['userDataDir']);
	});

	it('marca isolated:false', () => {
		expect(problemasConfigPlaywright({browser: {isolated: false}})).toEqual(['isolated:false']);
	});

	it('marca cdpEndpoint con valor', () => {
		expect(problemasConfigPlaywright({browser: {cdpEndpoint: 'http://localhost:9222'}})).toEqual(['cdpEndpoint']);
	});

	it('los encuentra en la raíz o anidados, y los tres juntos en orden fijo', () => {
		expect(problemasConfigPlaywright({cdpEndpoint: 'ws://x', isolated: false})).toEqual(['isolated:false', 'cdpEndpoint']);
		expect(
			problemasConfigPlaywright({
				browser: {cdpEndpoint: 'ws://127.0.0.1:9222', launchOptions: {headless: false}},
				perfiles: [{userDataDir: '~/perfil'}],
				otro: {isolated: false},
			}),
		).toEqual(['userDataDir', 'isolated:false', 'cdpEndpoint']);
	});

	it('no truena con valores que no son objetos', () => {
		for (const x of [null, undefined, 'texto', 42, true, []]) expect(problemasConfigPlaywright(x)).toEqual([]);
	});
});

describe('revisarConfigsPlaywright (archivos)', () => {
	it('pasa si no hay config o si la config es segura', () => {
		const dir = carpetaTemporal('doctor-pw-');
		const segura = join(dir, 'segura.json');
		writeFileSync(segura, JSON.stringify({browser: {isolated: true}}));
		const r = revisarConfigsPlaywright([segura, join(dir, 'no-existe.json')]);
		expect(r.ok).toBe(true);
		expect(r.obligatorio).toBe(true);
	});

	it('falla con una config peligrosa y solo nombra la clave, nunca su valor', () => {
		const dir = carpetaTemporal('doctor-pw-');
		const peligrosa = join(dir, 'cli.config.json');
		writeFileSync(
			peligrosa,
			JSON.stringify({browser: {userDataDir: '/ruta/perfil-secreto', cdpEndpoint: 'ws://host-secreto:9222', cdpHeaders: {Authorization: FALSO_ARCHIVO}}}),
		);
		const r = revisarConfigsPlaywright([peligrosa]);
		expect(r.ok).toBe(false);
		expect(r.detalle).toContain('userDataDir');
		expect(r.detalle).toContain('cdpEndpoint');
		expect(r.detalle).not.toContain('perfil-secreto');
		expect(r.detalle).not.toContain('host-secreto');
		expect(r.detalle).not.toContain(FALSO_ARCHIVO);
	});

	it('falla si la config no es JSON válido (no se puede comprobar que sea segura)', () => {
		const dir = carpetaTemporal('doctor-pw-');
		const rota = join(dir, 'cli.config.json');
		writeFileSync(rota, '{ "browser": { "isolated": false ');
		expect(revisarConfigsPlaywright([rota]).ok).toBe(false);
	});
});

describe('llaves: estado sin valor (HOME temporal con .env falso)', () => {
	const contenido = [
		'# comentario: GOOGLE_API_KEY=esto-no-cuenta',
		`GEMINI_API_KEY=${FALSO_ARCHIVO}`,
		`export APIFY_TOKEN="${FALSO_EXPORT}"`,
		'GOOGLE_API_KEY_VIEJA=no-es-la-misma-llave',
		'',
	].join('\n');

	it('dice presente (archivo), presente (entorno) o falta, y nunca devuelve el valor', () => {
		const home = homeConEnv(contenido);
		const r = estadoLlaves(LLAVES, {home, env: {GOOGLE_API_KEY: FALSO_ENTORNO}});
		expect(r.map((l) => [l.nombre, l.estado])).toEqual([
			['GEMINI_API_KEY', 'presente (archivo)'],
			['GOOGLE_API_KEY', 'presente (entorno)'],
			['APIFY_TOKEN', 'presente (archivo)'],
		]);
		const serializado = JSON.stringify(r);
		for (const valor of [FALSO_ARCHIVO, FALSO_EXPORT, FALSO_ENTORNO]) expect(serializado).not.toContain(valor);
	});

	it('marca falta si no está en ningún lado, si el valor está vacío o si solo es un prefijo', () => {
		const home = homeConEnv(['GEMINI_API_KEY=', 'APIFY_TOKEN=""', 'GOOGLE_API_KEY_VIEJA=x', '#GOOGLE_API_KEY=x'].join('\n'));
		const r = estadoLlaves(LLAVES, {home, env: {GEMINI_API_KEY: ''}});
		expect(r.every((l) => l.estado === 'falta')).toBe(true);
	});

	it('marca falta cuando no existe el archivo ni la variable', () => {
		const home = carpetaTemporal('doctor-home-vacio-');
		expect(estadoLlaves(LLAVES, {home, env: {}}).map((l) => l.estado)).toEqual(['falta', 'falta', 'falta']);
	});

	it('la tabla y las notas tampoco muestran el valor', () => {
		const home = homeConEnv(contenido);
		const {chequeos, notas} = chequeosLlaves({home, env: {GOOGLE_API_KEY: FALSO_ENTORNO, GEMINI_API_KEY: FALSO_ENTORNO}});
		const texto = `${formatearTabla(chequeos)}\n${notas.join('\n')}`;
		expect(texto).toContain('presente (archivo)');
		expect(texto).toContain('presente (entorno)');
		for (const valor of [FALSO_ARCHIVO, FALSO_EXPORT, FALSO_ENTORNO]) expect(texto).not.toContain(valor);
		// Las llaves son aviso en la Fase 0: nunca cambian el código de salida.
		expect(chequeos.every((c) => !c.obligatorio)).toBe(true);
	});

	it('el doctor completo (CLI) con HOME temporal no imprime ningún valor y sale con 0 o 2', () => {
		const home = homeConEnv(contenido);
		const cwd = carpetaTemporal('doctor-cwd-');
		const env: NodeJS.ProcessEnv = {...process.env, HOME: home, GOOGLE_API_KEY: FALSO_ENTORNO};
		// Ninguna llave real de tu shell entra a esta prueba.
		delete env.GEMINI_API_KEY;
		delete env.APIFY_TOKEN;
		const r = spawnSync(join(RAIZ, 'node_modules', '.bin', 'tsx'), [join(RAIZ, 'herramientas', 'doctor.ts')], {
			cwd,
			env,
			encoding: 'utf8',
			timeout: 90_000,
		});
		const salida = `${r.stdout}\n${r.stderr}`;
		expect(salida).toContain('GEMINI_API_KEY (aviso)');
		expect(salida).toContain('presente (archivo)');
		expect(salida).toContain('presente (entorno)');
		for (const valor of [FALSO_ARCHIVO, FALSO_EXPORT, FALSO_ENTORNO]) expect(salida).not.toContain(valor);
		expect([0, 2]).toContain(r.status);
	}, 120_000);
});

describe('lectores de salidas del sistema', () => {
	it('filtrosFaltantes lee el formato de ffmpeg -filters', () => {
		const listado = [
			'Filters:',
			'  T.. = Timeline support',
			' .S aspectralstats    A->A       Show frequency domain statistics about audio frames.',
			' .S astats            A->A       Show time domain statistics about audio frames.',
			' .. ebur128           A->N       EBU R128 scanner.',
			' .. aevalsrc          |->A       Generate an audio signal generated by an expression.',
		].join('\n');
		expect(filtrosFaltantes(listado, FILTROS_REQUERIDOS)).toEqual(['scale_vt', 'loudnorm', 'silencedetect', 'scdet']);
	});

	it('detectarRetina encuentra la pantalla del MacBook y no la confunde con la LG', () => {
		const conRetina = [
			'      Displays:',
			'        LG ULTRAGEAR:',
			'          Resolution: 2560 x 1080 (UW-UXGA - Ultra Wide - Ultra Extended Graphics Array)',
			'        Color LCD:',
			'          Display Type: Built-in Liquid Retina XDR Display',
			'          Resolution: 3024 x 1964 Retina',
		].join('\n');
		expect(detectarRetina(conRetina)).toEqual({hay: true, detalle: 'Color LCD · 3024 x 1964 Retina'});
		const soloLg = conRetina.split('\n').slice(0, 3).join('\n');
		expect(detectarRetina(soloLg).hay).toBe(false);
	});
});
