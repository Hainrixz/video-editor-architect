/**
 * La lista "Prohibido" de la voz del creador (un voice.md; su ruta va en creador.json → voz) convertida en reglas que
 * se pueden revisar sobre un texto (el titular y los textos de inserts).
 *
 * Qué se saca de la sección "## Prohibido":
 *  - palabras sueltas al inicio de un renglón ("usted / …") → palabra prohibida (también su plural);
 *  - frases entre comillas ("revolucionario", "cambiará tu vida", "el secreto definitivo") → frase prohibida;
 *  - plantillas con X / Y ("no es X, es Y", "no se trata de X sino de Y") → patrón;
 *  - "!!!" → signos repetidos; "MAYÚSCULAS gritando" → palabra de 5+ letras toda en mayúsculas; "em-dash" → "—";
 *  - "Emojis" → cualquier emoji;
 *  - preguntas-gancho huecas → la del ejemplo y el patrón "¿Listo para…?";
 *  - "Stacks de 3 adjetivos" → solo AVISO (una lista "a, b y c" puede ser de sustantivos).
 * El texto de voice.md es dato: solo se leen sus comillas y renglones, nunca se ejecuta nada de ahí.
 * Puro salvo `leerVoz`.
 */
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {expandirRuta, leerCreador, type Creador} from '../creador.ts';

/** Ruta del voice.md del creador (creador.json → voz), o null si no la dice. */
export const rutaVoz = (creador: Creador = leerCreador()): string | null => (creador.voz ? expandirRuta(creador.voz) : null);

export type ReglaVoz = {
	id: string;
	/** "falla": no puede ir en el titular; "aviso": se dice, pero no bloquea. */
	nivel: 'falla' | 'aviso';
	descripcion: string;
	re: RegExp;
};

/** Sin acentos, minúsculas (para comparar frases). */
export function normalizar(texto: string): string {
	return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const escapar = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sección "## Prohibido" (hasta el siguiente "## "). */
export function seccionProhibido(md: string): string {
	const i = md.search(/^##\s+Prohibido/im);
	if (i < 0) return '';
	const resto = md.slice(i).split('\n').slice(1).join('\n');
	const fin = resto.search(/^##\s+/m);
	return fin < 0 ? resto : resto.slice(0, fin);
}

/** Convierte "no es X, es Y" en un patrón: X/Y = cualquier tramo corto de texto. */
function plantillaARegex(frase: string): RegExp {
	const partes = normalizar(frase)
		.split(/\b[xy]\b/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => escapar(p).replace(/\s+/g, '\\s+'));
	return new RegExp(partes.join('.{1,60}?'), 'i');
}

/** Reglas a partir del texto de voice.md. */
export function reglasDeVoz(md: string): ReglaVoz[] {
	const seccion = seccionProhibido(md);
	const reglas: ReglaVoz[] = [];
	const agregar = (r: ReglaVoz) => {
		if (!reglas.some((x) => x.id === r.id)) reglas.push(r);
	};
	for (const renglon of seccion.split('\n')) {
		const linea = renglon.replace(/^\s*[-*]\s*/, '').trim();
		if (!linea) continue;
		// Palabra suelta al inicio: "usted / lenguaje corporativo-neutro."
		const suelta = /^([\p{L}]+)\s*\//u.exec(linea);
		if (suelta) {
			const p = normalizar(suelta[1]);
			agregar({id: `palabra:${p}`, nivel: 'falla', descripcion: `"${suelta[1]}" (voice.md: Prohibido)`, re: new RegExp(`(^|[^\\p{L}])${escapar(p)}(es|s)?(?=$|[^\\p{L}])`, 'iu')});
		}
		for (const m of linea.matchAll(/["“”«]([^"“”«»]+)["“”»]/g)) {
			const frase = m[1].trim();
			if (!frase) continue;
			if (/^[!?¡¿.]+$/.test(frase)) {
				agregar({id: 'signos-repetidos', nivel: 'falla', descripcion: `signos de más ("${frase}")`, re: /([!¡?¿])\1{1,}/});
				continue;
			}
			if (/\b[XY]\b/.test(frase)) {
				agregar({id: `patron:${normalizar(frase)}`, nivel: 'falla', descripcion: `el tic "${frase}"`, re: plantillaARegex(frase)});
				continue;
			}
			const n = normalizar(frase).replace(/[¿?¡!.,]/g, '').trim();
			if (n.split(/\s+/).length > 6) continue; // ejemplos largos (hooks y CTAs de otra sección) no son prohibiciones
			// Entre palabra y palabra puede ir puntuación ("rápido, fácil y poderoso").
			agregar({id: `frase:${n}`, nivel: 'falla', descripcion: `"${frase}" (voice.md: Prohibido)`, re: new RegExp(`(^|[^\\p{L}])${escapar(n).replace(/\s+/g, '[\\s,;:]+')}(?=$|[^\\p{L}])`, 'iu')});
		}
		const ln = normalizar(linea);
		if (ln.includes('mayusculas')) agregar({id: 'mayusculas', nivel: 'falla', descripcion: 'MAYÚSCULAS gritando (una palabra de 5+ letras toda en mayúsculas)', re: /(?<![\p{L}])[\p{Lu}]{5,}(?![\p{L}])/u});
		if (ln.includes('em-dash') || ln.includes('em dash') || linea.includes('—')) agregar({id: 'em-dash', nivel: 'falla', descripcion: 'em-dash decorativo (—)', re: /—/});
		if (ln.includes('emoji')) agregar({id: 'emoji', nivel: 'falla', descripcion: 'emoji dentro del texto', re: /\p{Extended_Pictographic}/u});
		if (ln.includes('preguntas-gancho') || ln.includes('preguntas gancho')) agregar({id: 'pregunta-hueca', nivel: 'falla', descripcion: 'pregunta-gancho hueca ("¿Listo para…?")', re: /¿\s*(est[aá]s\s+)?list[oa]s?\s+para\b/iu});
		if (ln.includes('adjetivos')) agregar({id: 'tres-adjetivos', nivel: 'aviso', descripcion: 'posible stack de 3 adjetivos ("a, b y c"): revísalo', re: /(?<![\p{L}])\p{L}+,\s*\p{L}+\s+y\s+\p{L}+(?![\p{L}])/u});
	}
	return reglas;
}

export type CoincidenciaVoz = {id: string; nivel: 'falla' | 'aviso'; descripcion: string; texto: string};

/** Qué reglas rompe un texto (se compara sin acentos para las palabras y frases). */
export function revisarVoz(texto: string, reglas: readonly ReglaVoz[]): CoincidenciaVoz[] {
	const salida: CoincidenciaVoz[] = [];
	const plano = texto.replace(/\s+/g, ' ');
	const sinAcentos = normalizar(plano);
	for (const r of reglas) {
		// Palabras, frases y plantillas se buscan sin acentos; mayúsculas, emojis, signos y rayas en el texto tal cual.
		const objetivo = r.id.startsWith('palabra:') || r.id.startsWith('frase:') || r.id.startsWith('patron:') ? sinAcentos : plano;
		const m = r.re.exec(objetivo);
		if (m) salida.push({id: r.id, nivel: r.nivel, descripcion: r.descripcion, texto: m[0].trim()});
	}
	return salida;
}

/** Lee voice.md. null si no hay ruta o no existe (entonces la regla queda N/A). */
export function leerVoz(ruta: string | null = rutaVoz()): {reglas: ReglaVoz[]; fuente: string} | null {
	if (!ruta || !existsSync(ruta)) return null;
	try {
		return {reglas: reglasDeVoz(readFileSync(ruta, 'utf8')), fuente: ruta.replace(homedir(), '~')};
	} catch {
		return null;
	}
}
