/**
 * Lectura de llaves (regla 10 de la casa).
 *
 * Las llaves viven en ~/.config/claude-editor/.env, un archivo que creas tú (carpeta 700, archivo 600),
 * con una línea NOMBRE=valor por llave. Se ignoran las líneas vacías, los comentarios (#), el prefijo
 * `export` y las comillas que envuelven el valor.
 *
 * Prioridad: primero ese archivo y luego las variables de entorno.
 *
 * Este módulo NUNCA imprime ni registra un valor: no usa console y sus errores solo llevan
 * el nombre de la variable y la ruta del archivo.
 */
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, sep} from 'node:path';
import {fallo} from './fallo.ts';

export type FuenteLlave = 'archivo' | 'entorno' | 'falta';

export type OpcionesLlaves = {
	/** Carpeta personal donde buscar .config/claude-editor/.env. Por defecto, os.homedir(); las pruebas pasan una temporal. */
	home?: string;
	/** Variables de entorno. Por defecto, process.env. */
	entorno?: Readonly<Record<string, string | undefined>>;
};

const NOMBRE_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Ruta del archivo de llaves dentro de `home`. */
export function rutaArchivoLlaves(home: string = homedir()): string {
	return join(home, '.config', 'claude-editor', '.env');
}

/** De dónde sale la llave: 'archivo', 'entorno' o 'falta'. Nunca devuelve el valor. */
export function fuenteDeLlave(nombre: string, opciones: OpcionesLlaves = {}): FuenteLlave {
	return buscar(nombre, opciones).fuente;
}

/**
 * Devuelve el valor de la llave. Si no está en ningún lado, lanza un FalloEditor con código 3
 * que dice el nombre de la variable y dónde ponerla (nunca un valor).
 */
export function obtenerLlave(nombre: string, opciones: OpcionesLlaves = {}): string {
	const {fuente, valor, ruta} = buscar(nombre, opciones);
	if (fuente === 'falta') {
		const donde = mostrarRuta(ruta);
		throw fallo(
			`usar ${nombre}`,
			`no está en ${donde} ni en tus variables de entorno`,
			`agrégala tú a ${donde} con la línea ${nombre}=<tu llave> y deja ese archivo con permisos 600`,
			3,
			{nombre},
		);
	}
	return valor;
}

function buscar(nombre: string, opciones: OpcionesLlaves): {fuente: FuenteLlave; valor: string; ruta: string} {
	revisarNombre(nombre);
	const ruta = rutaArchivoLlaves(opciones.home ?? homedir());
	const delArchivo = leerArchivo(ruta).get(nombre)?.trim();
	if (delArchivo) return {fuente: 'archivo', valor: delArchivo, ruta};
	const delEntorno = (opciones.entorno ?? process.env)[nombre]?.trim();
	if (delEntorno) return {fuente: 'entorno', valor: delEntorno, ruta};
	return {fuente: 'falta', valor: '', ruta};
}

function revisarNombre(nombre: unknown): void {
	if (typeof nombre !== 'string' || !NOMBRE_VALIDO.test(nombre)) {
		const visto = typeof nombre === 'string' ? nombre.replace(/[^\x20-\x7E]/g, '?').slice(0, 40) : String(nombre);
		throw fallo(
			'buscar la llave',
			`«${visto}» no es un nombre de variable válido`,
			'usa solo letras, números y guion bajo, como GEMINI_API_KEY',
			1,
		);
	}
}

/** Lee y parsea el archivo. Si no existe, no hay llaves de archivo; si existe y no se puede leer, falla con 3. */
function leerArchivo(ruta: string): Map<string, string> {
	let texto: string;
	try {
		texto = readFileSync(ruta, 'utf8');
	} catch (error) {
		const codigo = (error as NodeJS.ErrnoException | undefined)?.code;
		if (codigo === 'ENOENT' || codigo === 'ENOTDIR') return new Map();
		const donde = mostrarRuta(ruta);
		if (codigo === 'EACCES' || codigo === 'EPERM') {
			throw fallo(
				'leer tus llaves',
				`no tengo permiso para abrir ${donde} (${codigo})`,
				'si esto corrió dentro del sandbox, córrelo fuera de él con tu permiso; si no, revisa que ese archivo sea tuyo y tenga permisos 600',
				3,
				{codigo},
			);
		}
		if (codigo === 'EISDIR') {
			throw fallo(
				'leer tus llaves',
				`${donde} es una carpeta y no un archivo`,
				'deja ahí un archivo de texto con una línea NOMBRE=valor por llave',
				3,
				{codigo},
			);
		}
		throw fallo(
			'leer tus llaves',
			`falló al abrir ${donde} (${codigo ?? 'error sin código'})`,
			'revisa ese archivo y vuelve a intentarlo',
			3,
			{codigo},
		);
	}
	return parsear(texto);
}

/** KEY=VALUE por línea. Si una llave se repite, gana la última. Las líneas que no se entienden se ignoran sin mostrarlas. */
function parsear(texto: string): Map<string, string> {
	const llaves = new Map<string, string>();
	for (const cruda of texto.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const linea = cruda.trim().replace(/^export\s+/, '');
		if (linea === '' || linea.startsWith('#')) continue;
		const igual = linea.indexOf('=');
		if (igual <= 0) continue;
		const nombre = linea.slice(0, igual).trim();
		if (!NOMBRE_VALIDO.test(nombre)) continue;
		llaves.set(nombre, leerValor(linea.slice(igual + 1)));
	}
	return llaves;
}

const ESCAPES: Readonly<Record<string, string>> = {n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\'};

/**
 * Valor de lo que va después del `=`: entre comillas simples va literal; entre dobles acepta \" \\ \n \r \t.
 * Sin comillas, un # al inicio o después de un espacio empieza un comentario (`abc#def` sí es un valor),
 * y se recortan los espacios. Una comilla que no cierra se toma tal cual.
 */
function leerValor(despuesDelIgual: string): string {
	const crudo = despuesDelIgual.trim();
	const comilla = crudo[0];
	if (comilla === '"' || comilla === "'") {
		let valor = '';
		for (let i = 1; i < crudo.length; i++) {
			const c = crudo[i];
			if (c === comilla) return valor;
			if (comilla === '"' && c === '\\' && i + 1 < crudo.length) {
				const siguiente = crudo[++i];
				valor += ESCAPES[siguiente] ?? `\\${siguiente}`;
				continue;
			}
			valor += c;
		}
		return crudo;
	}
	const comentario = crudo.search(/(?:^|\s)#/);
	return (comentario >= 0 ? crudo.slice(0, comentario) : crudo).trim();
}

/** La ruta como la lees tú: con ~ en lugar de tu carpeta personal. */
function mostrarRuta(ruta: string): string {
	const casa = homedir();
	if (casa && (ruta === casa || ruta.startsWith(casa + sep))) return `~${ruta.slice(casa.length)}`;
	return ruta;
}
