// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Fuentes OFL-1.1 del motor, en TypeScript (funciona igual en macOS, Windows y Linux).
 *
 * Es el equivalente de los scripts de `biblioteca/fuentes/` (preparar.sh, jetbrains-mono/preparar.sh,
 * press-start-2p/bajar.sh y bajar-vivo.sh): mismas URLs (google/fonts fijado a un commit), mismos sha256 y las
 * mismas opciones de `fonttools varLib.instancer`. Los .sh siguen sirviendo en macOS y Linux; instalar.ts usa esto.
 *
 * Qué hace por familia:
 * 1. Baja la fuente (variable o estática) y su OFL.txt, y revisa su sha256.
 * 2. Si es variable, saca cada instancia estática con el fonttools del .venv (`python -m fontTools`):
 *    --static --remove-overlaps --update-name-table --no-recalc-timestamp (el mismo archivo da el mismo sha256).
 * 3. Revisa el sha256 de cada instancia y solo entonces la mueve a biblioteca/fuentes/<familia>/.
 * Si algo no cuadra, para sin dejar archivos a medias.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fallo} from './fallo.ts';
import {pythonVenv, RAIZ_PROYECTO} from './plataforma.ts';

export const COMMIT_FUENTES = '9710da1eacb3be272583c3224dcb70f9da6eadbb';
const URL_BASE = `https://raw.githubusercontent.com/google/fonts/${COMMIT_FUENTES}/ofl`;

type Instancia = {archivo: string; sha256: string; ejes: string[]};
export type FamiliaOfl = {
	carpeta: string;
	/** Ruta dentro de google/fonts/ofl (ya codificada para URL). */
	fuente: string;
	/** sha256 de la fuente bajada (null si el script original no lo fijaba: entonces se revisa la instancia). */
	sha256Fuente: string | null;
	ofl: {ruta: string; sha256: string};
	/** Variable → instancias que se sacan con fonttools. Estática → se copia tal cual con este nombre. */
	instancias: Instancia[] | {archivo: string};
};

export const FAMILIAS_OFL: readonly FamiliaOfl[] = [
	{
		carpeta: 'tiktok-sans',
		fuente: 'tiktoksans/TikTokSans%5Bopsz%2Cslnt%2Cwdth%2Cwght%5D.ttf',
		sha256Fuente: '0e7f0a3e924c9a86478fc6fc2946de2e4ab8fc704ed72ee40434ade94bb9b0c6',
		ofl: {ruta: 'tiktoksans/OFL.txt', sha256: '99e743f68f5eac487004c73aaca69c5d80d91ddb7b75c04bdf5f39331d9b7158'},
		instancias: [
			{archivo: 'TikTokSans-SemiBold.ttf', sha256: 'd4f0326ad15b1b33e12de03906f92e1ac273b7be2855d05c80446771d687550f', ejes: ['wght=600', 'opsz=36', 'wdth=100', 'slnt=0']},
			{archivo: 'TikTokSans-ExtraBold.ttf', sha256: 'd020e2219da84f2ea17262807472e38bafe675d6493615042a5ee775b465dab6', ejes: ['wght=800', 'opsz=36', 'wdth=100', 'slnt=0']},
		],
	},
	{
		carpeta: 'instrument-sans',
		fuente: 'instrumentsans/InstrumentSans%5Bwdth%2Cwght%5D.ttf',
		sha256Fuente: 'b24f1812584816958afcf22e22d08e44318c5e51651e25d2438efdde389b33b1',
		ofl: {ruta: 'instrumentsans/OFL.txt', sha256: '9e27a72ed30eb49a08678f6a5d6ed98ec7ba5368f541637ee0683ec9134ef966'},
		instancias: [
			{archivo: 'InstrumentSans-SemiBold.ttf', sha256: 'a63d55f34a30bac7377b13f3d66d1b1fae0c72f7ae5b364653a029a4e9f8da69', ejes: ['wght=600', 'wdth=100']},
			{archivo: 'InstrumentSans-Bold.ttf', sha256: 'b4c8e52409c0a58a238a4e7b558f3354c8e6550b8facbe9e5f3d07af7e269124', ejes: ['wght=700', 'wdth=100']},
		],
	},
	{
		carpeta: 'inter',
		fuente: 'inter/Inter%5Bopsz%2Cwght%5D.ttf',
		sha256Fuente: '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031',
		ofl: {ruta: 'inter/OFL.txt', sha256: '5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57'},
		instancias: [
			{archivo: 'Inter-SemiBold.ttf', sha256: '4e2353ba2b6a3514acdfe5d2409ad59468bb4d0b8ee01aabf03120ecf2dae95a', ejes: ['wght=600', 'opsz=14']},
			{archivo: 'Inter-Bold.ttf', sha256: 'd289ec2c941d44e340fdc16adae7e82dbb3674c3ce6ed7d7c0d5d0558f5aa73e', ejes: ['wght=700', 'opsz=14']},
			{archivo: 'Inter-ExtraBold.ttf', sha256: '0a63d47e990a5107e1fa64c5c904458fdebf11c86f3a56f9c0e07a42bd8f13e7', ejes: ['wght=800', 'opsz=14']},
		],
	},
	{
		carpeta: 'jetbrains-mono',
		fuente: 'jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
		sha256Fuente: '48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda',
		ofl: {ruta: 'jetbrainsmono/OFL.txt', sha256: 'b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d'},
		instancias: [
			{archivo: 'JetBrainsMono-Regular.ttf', sha256: 'dd5e2d9fd69a610770d9e2d226ac32cd95f6cff4c2a7e1323d0e111c0f07cc55', ejes: ['wght=400']},
			{archivo: 'JetBrainsMono-Medium.ttf', sha256: 'a06024eaeffed21fc2387ac726de4abd9caa21c08a6d1394471658b4e16e3d5f', ejes: ['wght=500']},
			{archivo: 'JetBrainsMono-Bold.ttf', sha256: '18769effdd12fe681a8f1c3b4be6e6254bee54998fbc0d6cbde26bb13d7f84ce', ejes: ['wght=700']},
		],
	},
	{
		carpeta: 'press-start-2p',
		fuente: 'pressstart2p/PressStart2P-Regular.ttf',
		sha256Fuente: '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d',
		ofl: {ruta: 'pressstart2p/OFL.txt', sha256: '705960c3281a5765ecc0b59bd4ed7ca59eed165748076bc2fc3e8fdbfeb944b0'},
		instancias: {archivo: 'PressStart2P-Regular.ttf'},
	},
	{
		carpeta: 'instrument-serif',
		fuente: 'instrumentserif/InstrumentSerif-Italic.ttf',
		sha256Fuente: '08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385',
		ofl: {ruta: 'instrumentserif/OFL.txt', sha256: '129ed7618959716959f2941fdd5b49e0ad6e6c1d78726761786a00253d865521'},
		instancias: {archivo: 'InstrumentSerif-Italic.ttf'},
	},
	{
		carpeta: 'anton',
		fuente: 'anton/Anton-Regular.ttf',
		sha256Fuente: 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab',
		ofl: {ruta: 'anton/OFL.txt', sha256: 'ee67e6ee22790b7929f1a3769ca2801d565c64b5a9096942c1adf5596de9c9e4'},
		instancias: {archivo: 'Anton-Regular.ttf'},
	},
	{
		carpeta: 'caveat',
		fuente: 'caveat/Caveat%5Bwght%5D.ttf',
		sha256Fuente: null,
		ofl: {ruta: 'caveat/OFL.txt', sha256: '1f9d81d094273d82f3898a1ee8b598a717d050ecbf5ff7bede105b704880157b'},
		instancias: [{archivo: 'Caveat-Bold.ttf', sha256: '87d9a31f0993aada44ccd0a9f91faf92407f6f08c71afb410181afb85f1f49f8', ejes: ['wght=700']}],
	},
];

/** Archivos .ttf que deja cada familia (rutas relativas a biblioteca/fuentes/). */
export function archivosFuentes(familias: readonly FamiliaOfl[] = FAMILIAS_OFL): string[] {
	return familias.flatMap((f) => (Array.isArray(f.instancias) ? f.instancias.map((i) => `${f.carpeta}/${i.archivo}`) : [`${f.carpeta}/${f.instancias.archivo}`]));
}

/** Los .ttf que faltan en biblioteca/fuentes/ (vacío = están todas). */
export function fuentesFaltantes(raiz: string = RAIZ_PROYECTO, existe: (ruta: string) => boolean = existsSync): string[] {
	return archivosFuentes().filter((r) => !existe(join(raiz, 'biblioteca', 'fuentes', ...r.split('/'))));
}

const sha256 = (datos: Buffer): string => createHash('sha256').update(datos).digest('hex');

async function bajarRevisado(url: string, esperado: string | null): Promise<Buffer> {
	let respuesta: Response;
	try {
		respuesta = await fetch(url, {signal: AbortSignal.timeout(180_000)});
	} catch (error) {
		throw fallo('bajar las fuentes', `${url} no respondió (${error instanceof Error ? error.message : String(error)})`, 'revisa tu conexión y vuelve a correr el instalador', 3);
	}
	if (!respuesta.ok) throw fallo('bajar las fuentes', `${url} respondió ${respuesta.status}`, 'revisa tu conexión y vuelve a correr el instalador', 3);
	const datos = Buffer.from(await respuesta.arrayBuffer());
	if (esperado && sha256(datos) !== esperado) {
		throw fallo('bajar las fuentes', `${url.split('/').pop()} llegó con otro sha256 (esperaba ${esperado.slice(0, 12)}…)`, 'no la uses; revisa el commit de google/fonts antes de seguir', 3);
	}
	return datos;
}

/**
 * Baja y prepara las familias que falten (o todas con `todas`). Necesita el .venv con fonttools y skia-pathops.
 * Devuelve los archivos que escribió.
 */
export async function prepararFuentes(op: {raiz?: string; python?: string; todas?: boolean; log?: (linea: string) => void} = {}): Promise<string[]> {
	const raiz = op.raiz ?? RAIZ_PROYECTO;
	const python = op.python ?? pythonVenv({raiz});
	const log = op.log ?? ((l: string) => console.log(l));
	const faltan = new Set(fuentesFaltantes(raiz));
	const familias = FAMILIAS_OFL.filter((f) => op.todas || archivosFuentes([f]).some((a) => faltan.has(a)));
	const necesitaFonttools = familias.some((f) => Array.isArray(f.instancias));
	if (necesitaFonttools && !existsSync(python)) {
		throw fallo('preparar las fuentes', 'no encontré el Python del .venv (con fonttools)', 'crea el .venv primero: npx tsx herramientas/instalar.ts --solo venv --si', 2);
	}
	const temporal = mkdtempSync(join(tmpdir(), 'editor-fuentes-'));
	const escritos: string[] = [];
	try {
		for (const f of familias) {
			const destino = join(raiz, 'biblioteca', 'fuentes', f.carpeta);
			mkdirSync(destino, {recursive: true});
			const fuente = await bajarRevisado(`${URL_BASE}/${f.fuente}`, f.sha256Fuente);
			const ofl = await bajarRevisado(`${URL_BASE}/${f.ofl.ruta}`, f.ofl.sha256);
			if (!Array.isArray(f.instancias)) {
				writeFileSync(join(destino, f.instancias.archivo), fuente);
				escritos.push(`${f.carpeta}/${f.instancias.archivo}`);
			} else {
				const variable = join(temporal, `${f.carpeta}-variable.ttf`);
				writeFileSync(variable, fuente);
				for (const inst of f.instancias) {
					const salida = join(temporal, inst.archivo);
					const r = spawnSync(
						python,
						['-m', 'fontTools', 'varLib.instancer', '-q', '--static', '--remove-overlaps', '--no-recalc-timestamp', '--update-name-table', '-o', salida, variable, ...inst.ejes],
						{encoding: 'utf8', windowsHide: true},
					);
					if (r.status !== 0 || !existsSync(salida)) {
						throw fallo('preparar las fuentes', `fonttools no pudo instanciar ${inst.archivo}`, 'revisa que el .venv traiga fonttools y skia-pathops (npx tsx herramientas/doctor.ts)', 1, r.stderr);
					}
					const real = sha256(readFileSync(salida));
					if (real !== inst.sha256) {
						throw fallo('preparar las fuentes', `${inst.archivo} salió con otro sha256 (${real.slice(0, 12)}…)`, 'usa las versiones fijas de herramientas/py/requirements.txt (fonttools 4.63.0, skia-pathops 0.9.2)', 1);
					}
					copyFileSync(salida, join(destino, inst.archivo)); // copia: temporal y proyecto pueden estar en discos distintos
					escritos.push(`${f.carpeta}/${inst.archivo}`);
				}
			}
			writeFileSync(join(destino, 'OFL.txt'), ofl);
			log(`  ✔ ${f.carpeta}`);
		}
	} finally {
		rmSync(temporal, {recursive: true, force: true});
	}
	return escritos;
}
