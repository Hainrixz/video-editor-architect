// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * logo.ts (fuente 2 de stickers): logos reales de las marcas que mencionas, en dos variantes:
 *   - "tile": cuadro blanco redondeado con el logo a color y el nombre abajo en TikTok Sans, como el tile de
 *     Claude que usas en tus reels.
 *   - "solo": el logo solo, con borde blanco tipo sticker.
 * Las dos llevan sombra suave (lib/borde.ts) y salen con las 4 esquinas transparentes.
 *
 *   npx tsx herramientas/stickers/logo.ts                    # todas las marcas de la lista
 *   npx tsx herramientas/stickers/logo.ts --marcas claude,github
 *   npx tsx herramientas/stickers/logo.ts --sin-red          # solo con los SVG ya guardados en logos/fuentes/
 *   npx tsx herramientas/stickers/logo.ts --lista            # qué marcas hay, de dónde sale cada logo y cuáles faltan
 *
 * De dónde sale cada logo (todo a commit fijo, por raw.githubusercontent.com):
 *   1. Press kit oficial: no se baja. Los sitios de las marcas quedan fuera de la red permitida del sandbox
 *      (solo github.com, *.githubusercontent.com, npm, pypi, kenney.nl e Instagram), así que no son "descargables"
 *      desde aquí. La guía de marca de cada una queda anotada en el catálogo cuando la fuente la trae.
 *   2. Simple Icons (CC0, monocromo) para las marcas cuyo logo oficial es de UNA tinta: se pinta con su color
 *      oficial (el `hex` de Simple Icons), que es como Simple Icons los publica.
 *   3. svgl (MIT) para las marcas cuyo logo oficial es de varias tintas o con degradado (pintarlas de un solo
 *      color sería recolorear el logo) y para las que no están en Simple Icons (OpenAI/ChatGPT, Canva, Codex,
 *      Remotion). El plan aprobado (v5) lista svgl como alternativa.
 *   Las marcas que no están en ninguna de las dos quedan fuera (FUERA) y se dicen.
 *
 * Sin recolorear ni deformar: el SVG se dibuja tal cual (solo se recorta su caja a la tinta y se escala sin
 * cambiar la proporción). Geometría del tile medida en tus reels (tile de Claude en reel P9 t≈1.5 s,
 * reel P1 t≈2 s y reel P10 t≈0.5 s): esquinas 22.2–23.0 % del lado (n = 4 esquinas en 2 reels); logo
 * de 56–57 % de ancho y 58–59 % de alto, de 12.7 % a 70–71 % del alto (n = 2); nombre de 51.7 % de ancho y
 * 12.2 % de alto con su base en 88.4 % (n = 3). En tus reels el nombre de Claude va en su propia letra con
 * remates; aquí va en TikTok Sans (la que tenemos con licencia OFL).
 *
 * Catálogo: biblioteca/stickers/logos/catalogo.json, una fila por PNG:
 *   {id, fuente:"logo", marca, archivo, variante:"tile"|"solo", ancho, alto, caja_tinta, etiquetas, licencia,
 *    fuente_url, fuente_repo, commit, color, guia_marca_url, uso:"editorial", sha256, svg, svg_sha256}
 * Las fuentes SVG y sus licencias se guardan en biblioteca/stickers/logos/fuentes/ con su sha256 en fuentes.json
 * (si un SVG guardado cambia, el CLI se detiene).
 *
 * Códigos: 0 bien · 1 fallo interno · 2 entrada inválida (marca desconocida, falta un SVG con --sin-red)
 *          · 3 la red falló al bajar un SVG.
 */
import {Resvg} from '@resvg/resvg-js';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {CANDIDATAS} from '../../src/estilo/fuentes.ts';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';
import {RAIZ} from '../lib/manifest.ts';
import {abrirFuente, type FuenteFk} from '../lib/texto-ancho.ts';
import {cajaTinta, guardarPng, leerPng, ponerBorde, ponerSombra, sha256, type ImagenRGBA, type ResultadoBorde} from './lib/borde.ts';
import {guardarCatalogo, leerCatalogo, type FilaCatalogo} from './procesar.ts';

/** Simple Icons 16.33.0: commit de refs/tags/16.33.0^{} (git ls-remote, 3 de octubre de 2026). */
export const COMMIT_SIMPLE_ICONS = 'e01988cc57a3aca39621023f9881e9b733ebcd77';
/** pheralb/svgl: HEAD de la rama principal el 3 de octubre de 2026 (git ls-remote). */
export const COMMIT_SVGL = 'ed75393dbe6eba6e446e208abb6826ecd1abd36d';

const RAW_SI = `https://raw.githubusercontent.com/simple-icons/simple-icons/${COMMIT_SIMPLE_ICONS}`;
const RAW_SVGL = `https://raw.githubusercontent.com/pheralb/svgl/${COMMIT_SVGL}`;

export const DIR_LOGOS = join(RAIZ, 'biblioteca', 'stickers', 'logos');
export const DIR_FUENTES = join(DIR_LOGOS, 'fuentes');

export type Origen = {repo: 'simple-icons'; slug: string} | {repo: 'svgl'; ruta: string};

export type Marca = {
	/** id corto: claude, chatgpt, hugging-face… */
	id: string;
	/** Texto del tile. */
	nombre: string;
	origen: Origen;
	etiquetas: string[];
	/** Comparte el logo de otra marca: solo se hace su tile (el "solo" sería idéntico). */
	logoDe?: string;
	/** Por qué esta fuente (va al --lista y al reporte). */
	porque: string;
	/** Dónde buscar la guía de marca si la fuente del logo no la trae (la misma marca en la otra fuente). */
	guiaDe?: Origen;
};

const si = (slug: string): Origen => ({repo: 'simple-icons', slug});
const svgl = (ruta: string): Origen => ({repo: 'svgl', ruta});
const UNA_TINTA = 'logo de una tinta: Simple Icons con su color oficial';
const VARIAS_TINTAS = 'logo oficial de varias tintas o con degradado: svgl (en Simple Icons sería de un solo color)';
const NO_EN_SI = 'no está en Simple Icons a ese commit: svgl';

/** Marcas que mencionas (lista del plan + tu biblioteca/vocabulario.json). */
export const MARCAS: readonly Marca[] = [
	{id: 'claude', nombre: 'Claude', origen: si('claude'), etiquetas: ['claude', 'anthropic', 'ia'], porque: UNA_TINTA},
	{id: 'claude-code', nombre: 'Claude Code', origen: si('claude'), etiquetas: ['claude', 'claude-code', 'anthropic', 'ia', 'codigo'], logoDe: 'claude', porque: 'mismo logo que Claude (de tu vocabulario), con su nombre en el tile'},
	{id: 'anthropic', nombre: 'Anthropic', origen: si('anthropic'), etiquetas: ['anthropic', 'claude', 'ia'], porque: UNA_TINTA},
	{id: 'chatgpt', nombre: 'ChatGPT', origen: svgl('openai.svg'), etiquetas: ['chatgpt', 'openai', 'gpt', 'ia'], porque: NO_EN_SI},
	{id: 'openai', nombre: 'OpenAI', origen: svgl('openai.svg'), etiquetas: ['openai', 'chatgpt', 'gpt', 'ia'], logoDe: 'chatgpt', porque: 'mismo logo que ChatGPT, con su nombre en el tile'},
	{id: 'codex', nombre: 'Codex', origen: svgl('codex_light.svg'), etiquetas: ['codex', 'openai', 'ia', 'codigo'], porque: NO_EN_SI},
	{id: 'gemini', nombre: 'Gemini', origen: svgl('gemini.svg'), etiquetas: ['gemini', 'google', 'ia'], porque: VARIAS_TINTAS},
	{id: 'google', nombre: 'Google', origen: svgl('google.svg'), etiquetas: ['google', 'buscador'], porque: VARIAS_TINTAS, guiaDe: si('google')},
	{id: 'github', nombre: 'GitHub', origen: si('github'), etiquetas: ['github', 'git', 'codigo'], porque: UNA_TINTA},
	{id: 'cloudflare', nombre: 'Cloudflare', origen: si('cloudflare'), etiquetas: ['cloudflare', 'seguridad', 'nube'], porque: UNA_TINTA},
	{id: 'notion', nombre: 'Notion', origen: si('notion'), etiquetas: ['notion', 'notas', 'productividad'], porque: UNA_TINTA},
	{id: 'figma', nombre: 'Figma', origen: svgl('figma.svg'), etiquetas: ['figma', 'diseno'], porque: VARIAS_TINTAS},
	{id: 'vercel', nombre: 'Vercel', origen: si('vercel'), etiquetas: ['vercel', 'hosting', 'web'], porque: UNA_TINTA},
	{id: 'cursor', nombre: 'Cursor', origen: si('cursor'), etiquetas: ['cursor', 'codigo', 'ia'], porque: UNA_TINTA, guiaDe: svgl('cursor_light.svg')},
	{id: 'youtube', nombre: 'YouTube', origen: si('youtube'), etiquetas: ['youtube', 'video', 'redes'], porque: UNA_TINTA},
	{id: 'instagram', nombre: 'Instagram', origen: svgl('instagram-icon.svg'), etiquetas: ['instagram', 'redes', 'reels', 'meta'], porque: VARIAS_TINTAS},
	{id: 'tiktok', nombre: 'TikTok', origen: svgl('tiktok-icon-light.svg'), etiquetas: ['tiktok', 'redes', 'video'], porque: VARIAS_TINTAS},
	{id: 'whatsapp', nombre: 'WhatsApp', origen: si('whatsapp'), etiquetas: ['whatsapp', 'mensajes', 'meta'], porque: UNA_TINTA},
	{id: 'canva', nombre: 'Canva', origen: svgl('canva.svg'), etiquetas: ['canva', 'diseno'], porque: NO_EN_SI},
	{id: 'perplexity', nombre: 'Perplexity', origen: si('perplexity'), etiquetas: ['perplexity', 'ia', 'buscador'], porque: UNA_TINTA},
	{id: 'meta', nombre: 'Meta', origen: svgl('meta.svg'), etiquetas: ['meta', 'facebook', 'redes'], porque: VARIAS_TINTAS, guiaDe: si('meta')},
	{id: 'apple', nombre: 'Apple', origen: si('apple'), etiquetas: ['apple', 'iphone', 'mac'], porque: UNA_TINTA},
	{id: 'python', nombre: 'Python', origen: svgl('python.svg'), etiquetas: ['python', 'codigo', 'programacion'], porque: VARIAS_TINTAS, guiaDe: si('python')},
	{id: 'react', nombre: 'React', origen: si('react'), etiquetas: ['react', 'codigo', 'web'], porque: UNA_TINTA},
	{id: 'supabase', nombre: 'Supabase', origen: svgl('supabase.svg'), etiquetas: ['supabase', 'base-de-datos', 'codigo'], porque: VARIAS_TINTAS},
	{id: 'stripe', nombre: 'Stripe', origen: si('stripe'), etiquetas: ['stripe', 'pagos'], porque: UNA_TINTA},
	{id: 'shopify', nombre: 'Shopify', origen: svgl('shopify.svg'), etiquetas: ['shopify', 'tienda', 'ecommerce'], porque: VARIAS_TINTAS},
	{id: 'wordpress', nombre: 'WordPress', origen: si('wordpress'), etiquetas: ['wordpress', 'web', 'blog'], porque: UNA_TINTA},
	{id: 'zapier', nombre: 'Zapier', origen: si('zapier'), etiquetas: ['zapier', 'automatizacion'], porque: UNA_TINTA},
	{id: 'n8n', nombre: 'n8n', origen: si('n8n'), etiquetas: ['n8n', 'automatizacion', 'agentes'], porque: UNA_TINTA},
	{id: 'hugging-face', nombre: 'Hugging Face', origen: svgl('hugging_face.svg'), etiquetas: ['hugging-face', 'huggingface', 'ia', 'modelos'], porque: VARIAS_TINTAS},
	{id: 'remotion', nombre: 'Remotion', origen: svgl('remotion.svg'), etiquetas: ['remotion', 'video', 'codigo'], porque: NO_EN_SI},
];

/** Marcas de tu lista que no tienen logo en ninguna de las dos fuentes (a esos commits). */
export const FUERA: readonly {nombre: string; motivo: string}[] = [
	{nombre: 'Higgsfield', motivo: 'no está en Simple Icons 16.33.0 ni en svgl (commit ed75393)'},
	{nombre: 'Apify', motivo: 'no está en Simple Icons 16.33.0 ni en svgl (commit ed75393)'},
];

const LICENCIA_SI =
	'SVG: Simple Icons (proyecto CC0-1.0; este ícono no trae licencia propia en sus datos, y su DISCLAIMER aclara que eso no garantiza que el ícono sea CC0). El logo es marca de su dueño: uso editorial (hablar del producto), sin sugerir patrocinio; revisa su guía de marca antes de usarlo en un anuncio';
const LICENCIA_SVGL =
	'SVG: repositorio svgl (MIT, (c) 2022 Pablo Hdez; LICENSE-svgl.txt). El logo es marca de su dueño: uso editorial (hablar del producto), sin sugerir patrocinio; revisa su guía de marca antes de usarlo en un anuncio';

// ───────────────────────────── Geometría del tile (medida en tus reels; ver arriba) ─────────────────────────────

/** Lado del tile en px del PNG (en tus reels se ve de 251–335 px en base 1080; 600 deja margen para zoom). */
export const LADO_TILE = 600;
export const TILE = {
	radio: 0.225,
	/** Caja máxima del logo (fracción del lado) y su centro. */
	logoAncho: 0.64,
	logoAlto: 0.585,
	logoCentroY: 0.42,
	/** Alto de la tinta de "Claude" (mayúscula y astas) y línea base del nombre. */
	nombreAltoClaude: 0.122,
	nombreBase: 0.884,
	nombreAnchoMax: 0.84,
	colorNombre: '#141413',
} as const;
/** Lado mayor del logo en la variante "solo" (px). */
export const LADO_SOLO = 520;
/** Peso de TikTok Sans para el nombre del tile: 600 se parece más al peso del nombre en tu tile de Claude que 800 (comparados lado a lado con reel P10 t≈0.5 s). */
export const PESO_NOMBRE = 600;

// ───────────────────────────── Fuentes SVG ─────────────────────────────

export function urlDe(origen: Origen): string {
	return origen.repo === 'simple-icons' ? `${RAW_SI}/icons/${origen.slug}.svg` : `${RAW_SVGL}/static/library/${origen.ruta}`;
}

export function archivoDe(origen: Origen): string {
	return origen.repo === 'simple-icons' ? `simple-icons-${origen.slug}.svg` : `svgl-${origen.ruta}`;
}

type InfoFuente = {
	url: string;
	sha256: string;
	repo: string;
	commit: string;
	titulo?: string;
	hex?: string;
	guia?: string | null;
	/** Guía de marca tomada de la misma marca en la otra fuente (si la del logo no trae). */
	guia_alterna?: string | null;
	guia_alterna_de?: string | null;
	origen_oficial?: string | null;
	licencia_icono?: string | null;
};
type Bloqueo = {
	simple_icons: {commit: string; etiqueta: string; datos_url: string; datos_sha256: string};
	svgl: {commit: string; indice_url: string; indice_sha256: string};
	archivos: Record<string, InfoFuente>;
};

/** Baja con curl (el fetch de Node no pasa por el proxy del sandbox). */
export function bajar(url: string): Buffer {
	const dir = mkdtempSync(join(tmpdir(), 'logos-'));
	try {
		const destino = join(dir, 'x');
		const r = spawnSync('curl', ['-sSfL', '--max-time', '60', '--retry', '2', '-o', destino, url], {encoding: 'utf8'});
		if (r.status !== 0) {
			throw fallo('bajar el logo', `curl no pudo traer ${url} (${(r.stderr ?? '').trim().split('\n')[0] || `salió con ${r.status}`})`, 'revisa tu conexión y vuelve a correrlo, o usa --sin-red con los SVG ya guardados', 3);
		}
		return readFileSync(destino);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}

function escribirAtomico(ruta: string, contenido: string | Buffer): void {
	mkdirSync(join(ruta, '..'), {recursive: true});
	const temporal = `${ruta}.${process.pid}.tmp`;
	writeFileSync(temporal, contenido);
	renameSync(temporal, ruta);
}

const slugTitulo = (t: string) =>
	t.toLowerCase().replace(/\+/g, 'plus').replace(/\./g, 'dot').replace(/&/g, 'and').normalize('NFD').replace(/[^a-z0-9]/g, '');

/** Datos de Simple Icons (color, guía de marca, origen) de los slugs pedidos, del data/simple-icons.json fijo. */
function datosSimpleIcons(slugs: Set<string>): {sha: string; porSlug: Map<string, {title: string; hex: string; guidelines?: string; source?: string; license?: {type: string}}>} {
	const buf = bajar(`${RAW_SI}/data/simple-icons.json`);
	const lista = JSON.parse(buf.toString('utf8')) as {title: string; hex: string; slug?: string; guidelines?: string; source?: string; license?: {type: string}}[];
	const porSlug = new Map<string, (typeof lista)[number]>();
	for (const d of lista) {
		const s = d.slug ?? slugTitulo(d.title);
		if (slugs.has(s)) porSlug.set(s, d);
	}
	return {sha: sha256(buf), porSlug};
}

/** brandUrl de svgl para las rutas pedidas (del índice src/data/svgs.ts fijo). */
function datosSvgl(rutas: Set<string>): {sha: string; guia: Map<string, string | null>} {
	const buf = bajar(`${RAW_SVGL}/src/data/svgs.ts`);
	const texto = buf.toString('utf8');
	const guia = new Map<string, string | null>();
	for (const bloque of texto.split(/\n\s*\{\s*\n/)) {
		const marca = /brandUrl:\s*["']([^"']+)["']/.exec(bloque)?.[1] ?? null;
		for (const ruta of rutas) {
			if (bloque.includes(`/library/${ruta}"`) || bloque.includes(`/library/${ruta}'`)) guia.set(ruta, marca);
		}
	}
	return {sha: sha256(buf), guia};
}

const RUTA_BLOQUEO = () => join(DIR_FUENTES, 'fuentes.json');

/**
 * Se asegura de tener cada SVG en logos/fuentes/ (lo baja si falta, salvo con sinRed) y de que su sha256
 * sea el anotado en fuentes.json. Guarda también las licencias de las dos fuentes.
 */
export function asegurarFuentes(marcas: readonly Marca[], sinRed: boolean): Bloqueo {
	const ruta = RUTA_BLOQUEO();
	const previo: Bloqueo | null = existsSync(ruta) ? (JSON.parse(readFileSync(ruta, 'utf8')) as Bloqueo) : null;
	const faltan = marcas.filter((m) => !existsSync(join(DIR_FUENTES, archivoDe(m.origen))) || !previo?.archivos[archivoDe(m.origen)]);
	const licencias = [
		{archivo: 'LICENSE-simple-icons.md', url: `${RAW_SI}/LICENSE.md`},
		{archivo: 'DISCLAIMER-simple-icons.md', url: `${RAW_SI}/DISCLAIMER.md`},
		{archivo: 'LICENSE-svgl.txt', url: `${RAW_SVGL}/LICENSE`},
	];
	const faltanLicencias = licencias.filter((l) => !existsSync(join(DIR_FUENTES, l.archivo)));
	const faltanGuias = marcas.filter((m) => m.guiaDe && previo?.archivos[archivoDe(m.origen)] && previo.archivos[archivoDe(m.origen)].guia_alterna_de === undefined);
	if (faltan.length === 0 && faltanLicencias.length === 0 && faltanGuias.length === 0 && previo) {
		for (const m of marcas) revisarSha(m, previo);
		return previo;
	}
	if (sinRed) {
		const nombres = [...faltan.map((m) => archivoDe(m.origen)), ...faltanLicencias.map((l) => l.archivo)];
		throw fallo('preparar los logos', `faltan ${nombres.slice(0, 4).join(', ')}${nombres.length > 4 ? '…' : ''} en biblioteca/stickers/logos/fuentes/`, 'córrelo sin --sin-red para bajarlos', 2);
	}
	mkdirSync(DIR_FUENTES, {recursive: true});
	for (const l of faltanLicencias) escribirAtomico(join(DIR_FUENTES, l.archivo), bajar(l.url));
	const todos = marcas.flatMap((m) => (m.guiaDe ? [m.origen, m.guiaDe] : [m.origen]));
	const slugs = new Set(todos.flatMap((o) => (o.repo === 'simple-icons' ? [o.slug] : [])));
	const rutas = new Set(todos.flatMap((o) => (o.repo === 'svgl' ? [o.ruta] : [])));
	const di = slugs.size > 0 ? datosSimpleIcons(slugs) : null;
	const dv = rutas.size > 0 ? datosSvgl(rutas) : null;
	const bloqueo: Bloqueo = previo ?? {
		simple_icons: {commit: COMMIT_SIMPLE_ICONS, etiqueta: '16.33.0', datos_url: `${RAW_SI}/data/simple-icons.json`, datos_sha256: ''},
		svgl: {commit: COMMIT_SVGL, indice_url: `${RAW_SVGL}/src/data/svgs.ts`, indice_sha256: ''},
		archivos: {},
	};
	if (di) bloqueo.simple_icons.datos_sha256 = di.sha;
	if (dv) bloqueo.svgl.indice_sha256 = dv.sha;
	const guiaDe = (o: Origen): string | null => (o.repo === 'simple-icons' ? (di?.porSlug.get(o.slug)?.guidelines ?? null) : (dv?.guia.get(o.ruta) ?? null));
	for (const m of marcas) {
		const nombre = archivoDe(m.origen);
		if (bloqueo.archivos[nombre] && existsSync(join(DIR_FUENTES, nombre))) {
			if (m.guiaDe && bloqueo.archivos[nombre].guia_alterna_de === undefined) {
				bloqueo.archivos[nombre].guia_alterna = guiaDe(m.guiaDe);
				bloqueo.archivos[nombre].guia_alterna_de = urlDe(m.guiaDe);
			}
			continue;
		}
		const url = urlDe(m.origen);
		const buf = existsSync(join(DIR_FUENTES, nombre)) ? readFileSync(join(DIR_FUENTES, nombre)) : bajar(url);
		if (!buf.toString('utf8').includes('<svg')) {
			throw fallo('bajar el logo', `${url} no trajo un SVG`, 'revisa la ruta del logo en MARCAS (logo.ts)', 1);
		}
		escribirAtomico(join(DIR_FUENTES, nombre), buf);
		if (m.origen.repo === 'simple-icons') {
			const d = di?.porSlug.get(m.origen.slug);
			if (!d) throw fallo('preparar los logos', `Simple Icons no tiene datos de ${m.origen.slug}`, 'revisa el slug en MARCAS (logo.ts)', 1);
			bloqueo.archivos[nombre] = {
				url,
				sha256: sha256(buf),
				repo: 'simple-icons',
				commit: COMMIT_SIMPLE_ICONS,
				titulo: d.title,
				hex: `#${d.hex.toUpperCase()}`,
				guia: d.guidelines ?? null,
				origen_oficial: d.source ?? null,
				licencia_icono: d.license?.type ?? null,
			};
		} else {
			bloqueo.archivos[nombre] = {url, sha256: sha256(buf), repo: 'svgl', commit: COMMIT_SVGL, guia: dv?.guia.get(m.origen.ruta) ?? null};
		}
		if (m.guiaDe) {
			bloqueo.archivos[nombre].guia_alterna = guiaDe(m.guiaDe);
			bloqueo.archivos[nombre].guia_alterna_de = urlDe(m.guiaDe);
		}
	}
	escribirAtomico(ruta, `${JSON.stringify(bloqueo, null, '\t')}\n`);
	for (const m of marcas) revisarSha(m, bloqueo);
	return bloqueo;
}

function revisarSha(m: Marca, bloqueo: Bloqueo): void {
	const nombre = archivoDe(m.origen);
	const info = bloqueo.archivos[nombre];
	const actual = sha256(readFileSync(join(DIR_FUENTES, nombre)));
	if (!info || info.sha256 !== actual) {
		throw fallo('preparar los logos', `el SVG ${nombre} no coincide con su sha256 de fuentes.json`, `bórralo (y su entrada en fuentes.json) para bajarlo de nuevo del commit fijo`, 2);
	}
}

// ───────────────────────────── SVG → imagen ─────────────────────────────

/** Atributos de la etiqueta <svg> raíz. */
function etiquetaRaiz(svg: string): {inicio: number; fin: number; texto: string} {
	const inicio = svg.search(/<svg[\s>]/);
	if (inicio < 0) throw fallo('leer el logo', 'el archivo no trae etiqueta <svg>', 'revisa el SVG', 2);
	const fin = svg.indexOf('>', inicio);
	return {inicio, fin, texto: svg.slice(inicio, fin + 1)};
}

function atributo(etiqueta: string, nombre: string): string | null {
	const m = new RegExp(`\\s${nombre}\\s*=\\s*["']([^"']*)["']`).exec(etiqueta);
	return m ? m[1] : null;
}

/** viewBox del SVG (o 0 0 width height si no trae). */
export function viewBoxDe(svg: string): [number, number, number, number] {
	const {texto} = etiquetaRaiz(svg);
	const vb = atributo(texto, 'viewBox');
	if (vb) {
		const n = vb.split(/[\s,]+/).map(Number);
		if (n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0) return n as [number, number, number, number];
	}
	const w = parseFloat(atributo(texto, 'width') ?? '');
	const h = parseFloat(atributo(texto, 'height') ?? '');
	if (w > 0 && h > 0) return [0, 0, w, h];
	throw fallo('leer el logo', 'el SVG no trae viewBox ni tamaño', 'revisa el SVG', 2);
}

/** Cambia la etiqueta raíz: viewBox nuevo, tamaño explícito y proporción fija (sin deformar). */
export function conViewBox(svg: string, vb: readonly [number, number, number, number], ancho: number, alto: number, relleno?: string): string {
	const {inicio, fin, texto} = etiquetaRaiz(svg);
	let etiqueta = texto
		.replace(/\s(viewBox|width|height|preserveAspectRatio)\s*=\s*["'][^"']*["']/g, '')
		.replace(/^<svg/, `<svg viewBox="${vb.map((v) => +v.toFixed(4)).join(' ')}" width="${ancho}" height="${alto}" preserveAspectRatio="xMidYMid meet"`);
	if (relleno) etiqueta = etiqueta.replace(/\sfill\s*=\s*["'][^"']*["']/g, '').replace(/^<svg/, `<svg fill="${relleno}"`);
	return svg.slice(0, inicio) + etiqueta + svg.slice(fin + 1);
}

/** Dibuja un SVG con resvg (sin fuentes del sistema) y lo regresa como RGBA de alfa recto. */
export function dibujarSvg(svg: string, ancho: number): ImagenRGBA {
	const r = new Resvg(svg, {fitTo: {mode: 'width', value: Math.round(ancho)}, background: 'rgba(0,0,0,0)', font: {loadSystemFonts: false}});
	return leerPng(r.render().asPng());
}

/** Recorta el viewBox a la tinta (con 0.5 % de aire) para que todos los logos llenen su caja igual. */
export function viewBoxATinta(svg: string): [number, number, number, number] {
	const vb = viewBoxDe(svg);
	const base = 1024;
	const alto = Math.max(1, Math.round((base * vb[3]) / vb[2]));
	const img = dibujarSvg(conViewBox(svg, vb, base, alto), base);
	const caja = cajaTinta(img, 8);
	if (!caja) throw fallo('dibujar el logo', 'el SVG no pinta nada', 'revisa el SVG (¿es blanco sobre transparente?)', 2);
	const escala = vb[2] / img.ancho;
	const aire = 0.005 * Math.max(caja.w, caja.h);
	return [vb[0] + (caja.x - aire) * escala, vb[1] + (caja.y - aire) * escala, (caja.w + 2 * aire) * escala, (caja.h + 2 * aire) * escala];
}

// ───────────────────────────── Texto con fontkit (trazos, sin depender de fuentes del sistema) ─────────────────────────────

/** Ruta SVG del texto con la línea base en y = 0 y el inicio en x = 0, más su caja de tinta (en px). */
export function textoATrazo(fuente: FuenteFk, texto: string, tamano: number): {d: string; avance: number; tinta: {x0: number; x1: number; y0: number; y1: number}} {
	const s = tamano / fuente.unitsPerEm;
	const corrida = fuente.layout(texto);
	let x = 0;
	const partes: string[] = [];
	let x0 = Infinity;
	let x1 = -Infinity;
	let y0 = Infinity;
	let y1 = -Infinity;
	const f = (v: number) => +v.toFixed(2);
	corrida.glyphs.forEach((g, i) => {
		const p = corrida.positions[i];
		const ox = x + p.xOffset * s;
		const oy = -p.yOffset * s;
		for (const c of g.path.commands) {
			const a = c.args;
			const px = (k: number) => f(ox + a[k] * s);
			const py = (k: number) => f(oy - a[k] * s);
			if (c.command === 'moveTo') partes.push(`M${px(0)} ${py(1)}`);
			else if (c.command === 'lineTo') partes.push(`L${px(0)} ${py(1)}`);
			else if (c.command === 'quadraticCurveTo') partes.push(`Q${px(0)} ${py(1)} ${px(2)} ${py(3)}`);
			else if (c.command === 'bezierCurveTo') partes.push(`C${px(0)} ${py(1)} ${px(2)} ${py(3)} ${px(4)} ${py(5)}`);
			else if (c.command === 'closePath') partes.push('Z');
		}
		const b = g.bbox;
		if (b.minX !== null && b.maxX !== null && b.minY !== null && b.maxY !== null && b.maxX > b.minX) {
			x0 = Math.min(x0, ox + b.minX * s);
			x1 = Math.max(x1, ox + b.maxX * s);
			y0 = Math.min(y0, oy - b.maxY * s);
			y1 = Math.max(y1, oy - b.minY * s);
		}
		x += p.xAdvance * s;
	});
	return {d: partes.join(''), avance: x, tinta: {x0, x1, y0, y1}};
}

function fuenteNombre(): FuenteFk {
	const archivo = CANDIDATAS['tiktok-sans'].archivos[PESO_NOMBRE];
	if (!archivo) throw fallo('preparar el nombre del tile', `TikTok Sans no tiene el peso ${PESO_NOMBRE}`, 'revisa src/estilo/fuentes.ts', 1);
	return abrirFuente(join(RAIZ, archivo.ruta));
}

/** Tamaño de letra del nombre: el que da a "Claude" el alto de tinta medido en tus reels. */
export function tamanoNombre(fuente: FuenteFk, lado = LADO_TILE): number {
	const ref = textoATrazo(fuente, 'Claude', 100);
	return (TILE.nombreAltoClaude * lado * 100) / (ref.tinta.y1 - ref.tinta.y0);
}

const aBase64 = (texto: string) => Buffer.from(texto, 'utf8').toString('base64');

/** Tile: cuadro blanco redondeado, logo centrado arriba y nombre abajo; con sombra. */
export function armarTile(svgLogo: string, nombre: string, fuente: FuenteFk, lado = LADO_TILE): ResultadoBorde {
	const vb = viewBoxATinta(svgLogo);
	const cajaW = TILE.logoAncho * lado;
	const cajaH = TILE.logoAlto * lado;
	const escala = Math.min(cajaW / vb[2], cajaH / vb[3]);
	const w = vb[2] * escala;
	const h = vb[3] * escala;
	const x = (lado - w) / 2;
	const y = TILE.logoCentroY * lado - h / 2;
	const logo = conViewBox(svgLogo, vb, Math.round(w * 4), Math.round(h * 4));
	let tamano = tamanoNombre(fuente, lado);
	let trazo = textoATrazo(fuente, nombre, tamano);
	const anchoMax = TILE.nombreAnchoMax * lado;
	if (trazo.tinta.x1 - trazo.tinta.x0 > anchoMax) {
		tamano *= anchoMax / (trazo.tinta.x1 - trazo.tinta.x0);
		trazo = textoATrazo(fuente, nombre, tamano);
	}
	const tx = lado / 2 - (trazo.tinta.x0 + trazo.tinta.x1) / 2;
	const ty = TILE.nombreBase * lado;
	const r = TILE.radio * lado;
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">` +
		`<rect x="0" y="0" width="${lado}" height="${lado}" rx="${r}" ry="${r}" fill="#FFFFFF"/>` +
		`<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${aBase64(logo)}"/>` +
		`<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)})" fill="${TILE.colorNombre}" d="${trazo.d}"/>` +
		`</svg>`;
	const img = dibujarSvg(svg, lado);
	return ponerSombra(img);
}

/** Solo el logo, con borde blanco tipo sticker y sombra. */
export function armarSolo(svgLogo: string, lado = LADO_SOLO): ResultadoBorde {
	const vb = viewBoxATinta(svgLogo);
	const escala = lado / Math.max(vb[2], vb[3]);
	const w = Math.round(vb[2] * escala);
	const h = Math.round(vb[3] * escala);
	const img = dibujarSvg(conViewBox(svgLogo, vb, w, h), w);
	// Silueta desde α ≥ 8 (no 50 %): algunos logos traen capas semitransparentes (Remotion) que también son logo.
	return ponerBorde(img, {umbral: 8});
}

// ───────────────────────────── Generar ─────────────────────────────

export type OpcionesGenerar = {marcas?: string[]; sinRed?: boolean; destino?: string};

/** Genera los PNG y el catálogo de las marcas pedidas (todas por defecto). Devuelve las filas nuevas. */
export function generarLogos(op: OpcionesGenerar = {}): {filas: FilaCatalogo[]; catalogo: string} {
	const elegidas = op.marcas && op.marcas.length > 0 ? op.marcas : MARCAS.map((m) => m.id);
	const desconocidas = elegidas.filter((id) => !MARCAS.some((m) => m.id === id));
	if (desconocidas.length > 0) {
		const fuera = desconocidas.filter((id) => FUERA.some((f) => f.nombre.toLowerCase() === id.toLowerCase()));
		throw fallo(
			'hacer los logos',
			fuera.length > 0 ? `${fuera.join(', ')} no tiene logo en las fuentes permitidas` : `no conozco la marca ${desconocidas.join(', ')}`,
			'usa --lista para ver las marcas disponibles',
			2,
		);
	}
	const marcas = MARCAS.filter((m) => elegidas.includes(m.id));
	// Una marca que comparte logo necesita la fuente de la otra (y nada más).
	const bloqueo = asegurarFuentes(marcas, op.sinRed ?? false);
	const destino = op.destino ?? DIR_LOGOS;
	const rutaCatalogo = join(destino, 'catalogo.json');
	let catalogo = leerCatalogo(rutaCatalogo);
	const fuente = fuenteNombre();
	const nuevas: FilaCatalogo[] = [];
	for (const m of marcas) {
		const nombreSvg = archivoDe(m.origen);
		const info = bloqueo.archivos[nombreSvg];
		let svg = readFileSync(join(DIR_FUENTES, nombreSvg), 'utf8');
		const color = m.origen.repo === 'simple-icons' ? info.hex ?? null : null;
		if (color) {
			const vb = viewBoxDe(svg);
			svg = conViewBox(svg, vb, vb[2], vb[3], color);
		}
		const variantes: ('tile' | 'solo')[] = m.logoDe ? ['tile'] : ['tile', 'solo'];
		for (const variante of variantes) {
			const res = variante === 'tile' ? armarTile(svg, m.nombre, fuente) : armarSolo(svg);
			const archivo = join(destino, `${m.id}-${variante}.png`);
			const {sha256: sha} = guardarPng(archivo, res.imagen);
			const etiquetasSolo = variante === 'solo' ? MARCAS.filter((o) => o.logoDe === m.id).flatMap((o) => o.etiquetas) : [];
			const fila: FilaCatalogo = {
				id: `logo-${m.id}-${variante}`,
				fuente: 'logo',
				marca: m.nombre,
				archivo: relative(RAIZ, archivo).split(sep).join('/'),
				variante,
				ancho: res.imagen.ancho,
				alto: res.imagen.alto,
				caja_tinta: res.cuerpo,
				etiquetas: [...new Set([...m.etiquetas, ...etiquetasSolo, 'logo', variante])],
				licencia:
					m.origen.repo === 'svgl'
						? LICENCIA_SVGL
						: info.licencia_icono
							? `SVG: Simple Icons, con licencia propia del ícono (${info.licencia_icono}). El logo es marca de su dueño: uso editorial, sin sugerir patrocinio`
							: LICENCIA_SI,
				fuente_url: info.url,
				fuente_repo: m.origen.repo,
				commit: info.commit,
				color,
				guia_marca_url: info.guia ?? info.guia_alterna ?? null,
				uso: 'editorial',
				sha256: sha,
				svg: relative(RAIZ, join(DIR_FUENTES, nombreSvg)).split(sep).join('/'),
				svg_sha256: info.sha256,
			};
			catalogo = [...catalogo.filter((f) => f.id !== fila.id), fila];
			nuevas.push(fila);
		}
	}
	guardarCatalogo(rutaCatalogo, catalogo);
	return {filas: nuevas, catalogo: rutaCatalogo};
}

async function main(): Promise<void> {
	const {values} = parseArgs({
		options: {
			marcas: {type: 'string'},
			'sin-red': {type: 'boolean', default: false},
			lista: {type: 'boolean', default: false},
		},
	});
	if (values.lista) {
		for (const m of MARCAS) {
			const de = m.origen.repo === 'simple-icons' ? `simple-icons/${m.origen.slug}` : `svgl/${m.origen.ruta}`;
			console.log(`${m.id.padEnd(13)} ${m.nombre.padEnd(13)} ${de.padEnd(34)} ${m.porque}`);
		}
		for (const f of FUERA) console.log(`(fuera)       ${f.nombre.padEnd(13)} ${f.motivo}`);
		return;
	}
	const marcas = values.marcas?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
	const {filas, catalogo} = generarLogos({marcas, sinRed: values['sin-red']});
	console.log(`Listo: ${filas.length} PNG de logos en biblioteca/stickers/logos/ y su catálogo (${relative(RAIZ, catalogo)}).`);
	if (!marcas) for (const f of FUERA) console.log(`Fuera: ${f.nombre} (${f.motivo}).`);
}

if (esPrincipal(import.meta.url)) void correr(main);
