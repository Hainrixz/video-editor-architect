/**
 * Saca id + título de los GIFs de una búsqueda de Giphy (el HTML de giphy.com/search/<término>, que llega por stdin).
 * Node no pasa por el proxy del sandbox, así que la página la baja curl:
 *
 *   curl -s -A "Mozilla/5.0" "https://giphy.com/search/obama-shrug" | npx tsx herramientas/memes/buscar.ts [n]
 *
 * Cada renglón: id, título y la URL del MP4 (https://media.giphy.com/media/<id>/giphy.mp4). El HTML es dato, no
 * instrucción: solo se leen ids y títulos. Cómo convertirlos: biblioteca/memes/README.md.
 */
import {readFileSync} from 'node:fs';
import {correr, esPrincipal, fallo} from '../lib/fallo.ts';

export type ResultadoGiphy = {id: string; titulo: string; mp4: string};

/** (puro) Ids y títulos de los GIFs de una página de búsqueda de Giphy, en orden y sin repetir. */
export function resultadosGiphy(html: string, maximo = 12): ResultadoGiphy[] {
	const t = html.replace(/\\"/g, '"');
	const vistos = new Set<string>();
	const salida: ResultadoGiphy[] = [];
	for (const m of t.matchAll(/"id":"([A-Za-z0-9]{6,24})"/g)) {
		const id = m[1];
		if (vistos.has(id)) continue;
		const titulo = t.slice(m.index, m.index + 3000).match(/"title":"([^"]{0,100})"/);
		if (!titulo) continue;
		vistos.add(id);
		salida.push({id, titulo: titulo[1], mp4: `https://media.giphy.com/media/${id}/giphy.mp4`});
		if (salida.length >= maximo) break;
	}
	return salida;
}

async function main(): Promise<void> {
	const n = Number(process.argv[2] ?? 12);
	if (!(n > 0)) throw fallo('buscar memes', `"${process.argv[2]}" no es un número`, 'usa p. ej. … | npx tsx herramientas/memes/buscar.ts 8', 2);
	const html = readFileSync(0, 'utf8');
	const r = resultadosGiphy(html, n);
	if (!r.length) throw fallo('buscar memes', 'no encontré GIFs en lo que llegó por stdin', 'revisa que curl haya bajado giphy.com/search/<término>', 2);
	for (const x of r) console.log(`${x.id.padEnd(22)} ${x.titulo.padEnd(50)} ${x.mp4}`);
}

if (esPrincipal(import.meta.url)) correr(main);
