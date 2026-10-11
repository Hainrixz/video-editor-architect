/**
 * Energía de audio para la transcripción: lee un WAV PCM s16 mono (el `audio16k.wav` de la ingesta,
 * 16 kHz) y da el RMS en dBFS por ventana o en un intervalo.
 *
 * dBFS = 20·log10(RMS / 32768). Una muestra a escala completa constante da 0 dBFS; el silencio
 * digital se recorta a PISO_DBFS para no arrastrar −Infinity a medianas ni a JSON.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fallo} from './fallo';

export const PISO_DBFS = -120;

export interface Wav {
	/** Muestras por segundo (Hz). */
	frecuencia: number;
	/** Muestras mono en s16. */
	muestras: Int16Array;
	/** Duración en segundos. */
	duracionS: number;
}

function invalido(ruta: string, porque: string): Error {
	return fallo(
		`leer el audio ${ruta}`,
		porque,
		'genera el WAV con ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le (lo hace la ingesta) y vuelve a correr',
		2,
	);
}

/** Lee los chunks RIFF ("fmt ", "data"; ignora LIST y demás) de un WAV PCM s16 mono. */
export function parsearWav(buffer: Buffer, ruta = 'WAV'): Wav {
	if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
		throw invalido(ruta, 'no es un WAV (falta la cabecera RIFF/WAVE)');
	}
	let pos = 12;
	let formato: {tipo: number; canales: number; frecuencia: number; bits: number} | null = null;
	let datos: {inicio: number; largo: number} | null = null;
	while (pos + 8 <= buffer.length) {
		const id = buffer.toString('ascii', pos, pos + 4);
		const declarado = buffer.readUInt32LE(pos + 4);
		const inicio = pos + 8;
		// ffmpeg por pipe deja el tamaño en 0 o 0xFFFFFFFF: se toma lo que haya en el archivo.
		const largo = Math.min(declarado === 0 && id === 'data' ? buffer.length - inicio : declarado, buffer.length - inicio);
		if (id === 'fmt ') {
			if (largo < 16) throw invalido(ruta, 'el chunk "fmt " está incompleto');
			let tipo = buffer.readUInt16LE(inicio);
			// WAVE_FORMAT_EXTENSIBLE: el formato real viene en el subformato (GUID que empieza con el código).
			if (tipo === 0xfffe && largo >= 40) tipo = buffer.readUInt16LE(inicio + 24);
			formato = {
				tipo,
				canales: buffer.readUInt16LE(inicio + 2),
				frecuencia: buffer.readUInt32LE(inicio + 4),
				bits: buffer.readUInt16LE(inicio + 14),
			};
		} else if (id === 'data') {
			datos = {inicio, largo};
			break;
		}
		pos = inicio + largo + (largo % 2);
	}
	if (!formato) throw invalido(ruta, 'no trae el chunk "fmt "');
	if (!datos) throw invalido(ruta, 'no trae el chunk "data"');
	if (formato.tipo !== 1 || formato.bits !== 16) {
		throw invalido(ruta, `no es PCM de 16 bits (formato ${formato.tipo}, ${formato.bits} bits)`);
	}
	if (formato.canales !== 1) throw invalido(ruta, `tiene ${formato.canales} canales y se espera mono`);

	const n = Math.floor(datos.largo / 2);
	const muestras = new Int16Array(n);
	for (let i = 0; i < n; i++) muestras[i] = buffer.readInt16LE(datos.inicio + 2 * i);
	return {frecuencia: formato.frecuencia, muestras, duracionS: n / formato.frecuencia};
}

/** Lee un WAV PCM s16 mono de disco. Si `frecuenciaEsperada` se da, la exige. */
export function leerWav(ruta: string, frecuenciaEsperada?: number): Wav {
	let buffer: Buffer;
	try {
		buffer = readFileSync(ruta);
	} catch {
		throw fallo(`leer el audio ${ruta}`, 'el archivo no existe o no se puede abrir', 'corre primero la ingesta del proyecto', 2);
	}
	const wav = parsearWav(buffer, ruta);
	if (frecuenciaEsperada !== undefined && wav.frecuencia !== frecuenciaEsperada) {
		throw invalido(ruta, `está a ${wav.frecuencia} Hz y se espera ${frecuenciaEsperada} Hz`);
	}
	return wav;
}

/** Escribe muestras s16 mono como WAV PCM (cabecera de 44 bytes). */
export function escribirWav(ruta: string, muestras: Int16Array, frecuencia: number): void {
	const datos = muestras.length * 2;
	const buffer = Buffer.alloc(44 + datos);
	buffer.write('RIFF', 0, 'ascii');
	buffer.writeUInt32LE(36 + datos, 4);
	buffer.write('WAVE', 8, 'ascii');
	buffer.write('fmt ', 12, 'ascii');
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(frecuencia, 24);
	buffer.writeUInt32LE(frecuencia * 2, 28); // bytes por segundo
	buffer.writeUInt16LE(2, 32); // bytes por muestra
	buffer.writeUInt16LE(16, 34); // bits
	buffer.write('data', 36, 'ascii');
	buffer.writeUInt32LE(datos, 40);
	for (let i = 0; i < muestras.length; i++) buffer.writeInt16LE(muestras[i], 44 + 2 * i);
	writeFileSync(ruta, buffer);
}

/** Índice de muestra para un tiempo (s), recortado al rango del audio. */
export function muestraEn(wav: Wav, segundos: number): number {
	return Math.min(wav.muestras.length, Math.max(0, Math.round(segundos * wav.frecuencia)));
}

/** RMS en dBFS de las muestras [desde, hasta) (índices). Intervalo vacío → PISO_DBFS. */
export function rmsDbfs(muestras: Int16Array, desde: number, hasta: number): number {
	const a = Math.max(0, Math.floor(desde));
	const b = Math.min(muestras.length, Math.floor(hasta));
	if (b <= a) return PISO_DBFS;
	let suma = 0;
	for (let i = a; i < b; i++) suma += muestras[i] * muestras[i];
	const rms = Math.sqrt(suma / (b - a));
	if (rms === 0) return PISO_DBFS;
	return Math.max(PISO_DBFS, 20 * Math.log10(rms / 32768));
}

/** RMS en dBFS del intervalo [a, b) en segundos. */
export function energiaEnIntervalo(wav: Wav, a: number, b: number): number {
	return rmsDbfs(wav.muestras, muestraEn(wav, a), muestraEn(wav, b));
}

export interface EnergiaPorVentana {
	ventanaS: number;
	saltoS: number;
	/** dBFS de la ventana k, que empieza en k·saltoS. */
	dbfs: Float64Array;
}

/** RMS en dBFS por ventana (por defecto 20 ms sin solape) sobre todo el audio. */
export function energiaPorVentana(wav: Wav, ventanaS = 0.02, saltoS = ventanaS): EnergiaPorVentana {
	const ventana = Math.max(1, Math.round(ventanaS * wav.frecuencia));
	const salto = Math.max(1, Math.round(saltoS * wav.frecuencia));
	const total = wav.muestras.length < ventana ? 0 : Math.floor((wav.muestras.length - ventana) / salto) + 1;
	const dbfs = new Float64Array(total);
	for (let k = 0; k < total; k++) dbfs[k] = rmsDbfs(wav.muestras, k * salto, k * salto + ventana);
	return {ventanaS: ventana / wav.frecuencia, saltoS: salto / wav.frecuencia, dbfs};
}

/** Mediana de una lista de números (vacía → NaN). */
export function mediana(valores: ArrayLike<number>): number {
	const orden = Array.from(valores).sort((x, y) => x - y);
	if (orden.length === 0) return Number.NaN;
	const medio = Math.floor(orden.length / 2);
	return orden.length % 2 === 1 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}
