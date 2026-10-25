// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {describe, expect, it} from 'vitest';
import {energiaEnIntervalo, parsearWav, PISO_DBFS} from '../../herramientas/lib/energia';
import {esTokenEspecial, parsearWhisperJson, type PalabraWhisper} from '../../herramientas/lib/whisper-json';
import {armarTramos, palabrasFinales} from '../../herramientas/transcribir';

/** Arma un JSON -ojf falso byte por byte: los strings van en UTF-8 y los Buffer van crudos. */
function jsonCrudo(...partes: (string | number[])[]): Buffer {
	return Buffer.concat(partes.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p))));
}

function token(texto: string, desde: number, hasta: number, p: number, tDtw: number): string {
	return `{"text":"${texto}","timestamps":{"from":"x","to":"y"},"offsets":{"from":${desde},"to":${hasta}},"id":1,"p":${p},"t_dtw":${tDtw}}`;
}

// "ñ" = C3 B1. El token " a" termina con C3 y el token "o" empieza con B1, como lo deja whisper 1.8.4.
const conEnePartida = jsonCrudo(
	'{"systeminfo":"x","model":{"type":"large"},"transcription":[{"offsets":{"from":0,"to":1000},"text":" el año","tokens":[',
	token('[_BEG_]', 0, 0, 0.02, -1),
	',',
	token(' el', 0, 200, 0.9, 12),
	',',
	'{"text":" a',
	[0xc3],
	'","offsets":{"from":200,"to":450},"id":2,"p":0.8,"t_dtw":25}',
	',{"text":"',
	[0xb1],
	'o","offsets":{"from":450,"to":700},"id":3,"p":0.6,"t_dtw":45}',
	',',
	token('[_TT_50]', 1000, 1000, 0.4, -1),
	',',
	token('<|endoftext|>', 1000, 1000, 0.4, -1),
	']}]}',
);

describe('parsearWhisperJson', () => {
	it('une la "ñ" partida entre dos tokens y devuelve "año"', () => {
		// Control: decodificado como UTF-8 directo, la ñ se pierde (por eso el parser lee bytes).
		expect(conEnePartida.toString('utf8')).not.toContain('"text":" año"');

		const palabras = parsearWhisperJson(conEnePartida, {desplazamientoS: 0});
		expect(palabras.map((p) => p.texto)).toEqual(['el', 'año']);
		const anio = palabras[1];
		expect(anio.tokens).toBe(2);
		expect(anio.p).toBeCloseTo(0.7, 6); // media de 0.8 y 0.6
		expect(anio.inicioOffsetsMs).toBe(200);
		expect(anio.finMs).toBe(700); // offsets.to del último token
	});

	it('ignora los tokens especiales', () => {
		const palabras = parsearWhisperJson(conEnePartida, {desplazamientoS: 0});
		const textos = palabras.map((p) => p.texto).join(' ');
		expect(textos).not.toMatch(/\[_|<\|/);
		expect(palabras).toHaveLength(2);
		expect(esTokenEspecial('[_BEG_]')).toBe(true);
		expect(esTokenEspecial('[_TT_1500]')).toBe(true);
		expect(esTokenEspecial('<|endoftext|>')).toBe(true);
		expect(esTokenEspecial(' año')).toBe(false);
	});

	it('convierte t_dtw (centésimas) a ms y suma el desplazamiento del tramo', () => {
		const sinDesplazar = parsearWhisperJson(conEnePartida, {desplazamientoS: 0});
		expect(sinDesplazar.map((p) => p.inicioDtwMs)).toEqual([120, 250]);

		const desplazadas = parsearWhisperJson(conEnePartida, {desplazamientoS: 12.5});
		expect(desplazadas.map((p) => p.inicioDtwMs)).toEqual([12620, 12750]);
		expect(desplazadas.map((p) => p.inicioOffsetsMs)).toEqual([12500, 12700]);
		expect(desplazadas[1].finMs).toBe(13200);
	});

	it('arranca la palabra en el primer token con letras ("¿Cómo" no empieza en el "¿")', () => {
		const json = jsonCrudo(
			'{"transcription":[{"tokens":[',
			token('[_BEG_]', 0, 0, 0.1, -1),
			',',
			token(' ¿', 0, 120, 0.2, 24),
			',',
			token('Cómo', 120, 430, 0.8, 80),
			',',
			token(' hacer', 750, 750, 0.9, 96),
			',',
			token('?', 900, 900, 0.9, 99),
			']}]}',
		);
		const palabras = parsearWhisperJson(json, {desplazamientoS: 0});
		expect(palabras.map((p) => p.texto)).toEqual(['¿Cómo', 'hacer?']);
		expect(palabras[0].inicioDtwMs).toBe(800);
		expect(palabras[0].inicioOffsetsMs).toBe(120);
		expect(palabras[0].finMs).toBe(430);
	});

	it('une un carácter partido entre dos segmentos sin pegar palabras de segmentos distintos', () => {
		const json = jsonCrudo(
			'{"transcription":[{"tokens":[',
			token(' Espa', 0, 300, 0.9, 10),
			',{"text":"',
			[0xc3],
			'","offsets":{"from":300,"to":320},"p":0.5,"t_dtw":30}]},{"tokens":[{"text":"',
			[0xb1],
			'","offsets":{"from":320,"to":340},"p":0.5,"t_dtw":32}',
			',',
			token('a', 340, 500, 0.9, 34),
			',',
			token(' es', 600, 700, 0.9, 60),
			']},{"tokens":[',
			// Primer token del segmento sin espacio y sin ser mitad de carácter: abre palabra.
			token('Bien', 900, 1200, 0.9, 90),
			']}]}',
		);
		const palabras = parsearWhisperJson(json, {desplazamientoS: 0});
		expect(palabras.map((p) => p.texto)).toEqual(['España', 'es', 'Bien']);
		expect(palabras[0].segmento).toBe(0);
		expect(palabras[0].finMs).toBe(500);
		expect(palabras[2].segmento).toBe(2);
	});

	it('escapa caracteres de control crudos dentro de strings', () => {
		const json = jsonCrudo('{"transcription":[{"tokens":[{"text":" uno', [0x09], 'dos","offsets":{"from":0,"to":10},"p":1,"t_dtw":0}]}]}');
		const palabras = parsearWhisperJson(json, {desplazamientoS: 0});
		expect(palabras).toHaveLength(1);
		expect(palabras[0].texto).toBe('uno\tdos');
	});

	it('falla con código 1 si el JSON no tiene la forma de -ojf', () => {
		expect(() => parsearWhisperJson(Buffer.from('{"otra":1}'), {desplazamientoS: 0})).toThrowError(/Siguiente paso:/);
		try {
			parsearWhisperJson(Buffer.from('no es json'), {desplazamientoS: 0});
		} catch (error) {
			expect((error as {codigo?: number}).codigo).toBe(1);
		}
	});
});

/** WAV PCM s16 mono en memoria, con un chunk LIST antes de "data" (como lo deja ffmpeg). */
function wavEnMemoria(muestras: number[], frecuencia = 16000): Buffer {
	const lista = Buffer.from('LIST\x04\x00\x00\x00INFO', 'latin1');
	const datos = Buffer.alloc(muestras.length * 2);
	muestras.forEach((m, i) => datos.writeInt16LE(m, i * 2));
	const fmt = Buffer.alloc(24);
	fmt.write('fmt ', 0, 'ascii');
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(1, 8);
	fmt.writeUInt16LE(1, 10);
	fmt.writeUInt32LE(frecuencia, 12);
	fmt.writeUInt32LE(frecuencia * 2, 16);
	fmt.writeUInt16LE(2, 20);
	fmt.writeUInt16LE(16, 22);
	const cabeceraDatos = Buffer.alloc(8);
	cabeceraDatos.write('data', 0, 'ascii');
	cabeceraDatos.writeUInt32LE(datos.length, 4);
	const cuerpo = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, lista, cabeceraDatos, datos]);
	const riff = Buffer.alloc(8);
	riff.write('RIFF', 0, 'ascii');
	riff.writeUInt32LE(cuerpo.length, 4);
	return Buffer.concat([riff, cuerpo]);
}

describe('energía (lib/energia.ts)', () => {
	it('da el RMS en dBFS de un intervalo y el piso en silencio', () => {
		// 1 s de silencio + 1 s de onda cuadrada de amplitud 3277 (≈ −20 dBFS de RMS).
		const muestras = [...Array(16000).fill(0), ...Array.from({length: 16000}, (_, i) => (i % 2 === 0 ? 3277 : -3277))];
		const wav = parsearWav(wavEnMemoria(muestras));
		expect(wav.frecuencia).toBe(16000);
		expect(wav.duracionS).toBe(2);
		expect(energiaEnIntervalo(wav, 0, 1)).toBe(PISO_DBFS);
		expect(energiaEnIntervalo(wav, 1, 2)).toBeCloseTo(20 * Math.log10(3277 / 32768), 3);
		// Medio y medio: la potencia se promedia (−3 dB respecto a la parte con señal).
		expect(energiaEnIntervalo(wav, 0.5, 1.5)).toBeCloseTo(20 * Math.log10(3277 / 32768) - 3.0103, 2);
	});

	it('rechaza un WAV estéreo con código 2', () => {
		const buffer = wavEnMemoria([0, 0, 0, 0]);
		buffer.writeUInt16LE(2, 22); // canales = 2
		try {
			parsearWav(buffer, 'prueba.wav');
			expect.unreachable();
		} catch (error) {
			expect((error as {codigo?: number}).codigo).toBe(2);
		}
	});
});

describe('tramos y palabras finales (transcribir.ts)', () => {
	it('une tramos separados por < 0.3 s y les da 0.2 s de margen sin encimarlos', () => {
		const tramos = armarTramos(
			[
				{inicio: 1.0, fin: 2.0},
				{inicio: 2.2, fin: 3.0}, // hueco de 0.2 s → se une al anterior
				{inicio: 3.35, fin: 4.0}, // hueco de 0.35 s → tramo aparte, margen recortado a la mitad del hueco
				{inicio: 9.9, fin: 10.0},
			],
			10.05,
			16000,
		);
		expect(tramos.map((t) => [t.inicio, t.fin])).toEqual([
			[0.8, 3.175],
			[3.175, 4.2],
			[9.7, 10.05],
		]);
	});

	function palabra(texto: string, inicioOffsetsMs: number, inicioDtwMs: number, finMs: number): PalabraWhisper {
		return {texto, inicioOffsetsMs, inicioDtwMs, finMs, p: 0.9, segmento: 0, tokens: 1};
	}

	it('usa t_dtw×10 − k como inicio y ancla la duración de offsets cuando estos quedaron corridos', () => {
		const finales = palabrasFinales(
			[
				palabra('hola', 1000, 1050, 1300),
				// offsets corridos 700 ms hacia atrás respecto al DTW (pasa en tramos largos)
				palabra('mundo', 1300, 2020, 1500),
				palabra('cruel', 2100, 2300, 2500),
			],
			't_dtw',
			20,
		);
		expect(finales).toEqual([
			// la duración de offsets (300 ms) se ancla en d: 1.03 + 0.3
			{i: 0, t: 'hola', d: 1.03, h: 1.33, p: 0.9},
			{i: 1, t: 'mundo', d: 2, h: 2.2, p: 0.9},
			{i: 2, t: 'cruel', d: 2.28, h: 2.68, p: 0.9},
		]);
	});

	it('con offsets usa offsets.from y offsets.to tal cual', () => {
		const finales = palabrasFinales([palabra('hola', 1000, 1050, 1300), palabra('mundo', 1400, 1500, 1700)], 'offsets', 0);
		expect(finales.map((p) => [p.d, p.h])).toEqual([
			[1, 1.3],
			[1.4, 1.7],
		]);
	});
});
