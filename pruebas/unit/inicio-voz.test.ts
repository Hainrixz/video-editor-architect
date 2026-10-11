import {describe, expect, it} from 'vitest';
import type {Wav} from '../../herramientas/lib/energia';
import {ajustarInicios, analizarSenal, detectarArranque, OPCIONES_INICIO_VOZ} from '../../herramientas/lib/inicio-voz';

// Señales sintéticas a 16 kHz: piso de ruido blanco + piezas con inicio conocido. Todo es
// determinista (ruido con LCG de semilla fija), así que las pruebas no dependen del azar.
const FS = 16000;
const TOLERANCIA_MS = 10;

function lcg(semilla: number): () => number {
	let s = semilla >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return (s / 2 ** 32) * 2 - 1; // uniforme en [-1, 1)
	};
}

const amp = (dbfs: number) => 10 ** (dbfs / 20);
const n = (s: number) => Math.round(s * FS);

class Senal {
	readonly x: Float64Array;
	constructor(duracionS: number, pisoDbfs = -70, semilla = 7) {
		this.x = new Float64Array(n(duracionS));
		const azar = lcg(semilla);
		const a = amp(pisoDbfs) * Math.sqrt(3); // uniforme: RMS = a/√3
		for (let i = 0; i < this.x.length; i++) this.x[i] = a * azar();
	}

	/** "Vocal": armónicos de 120 Hz (1/k) con ataque de 5 ms y caída de 10 ms; nivel = RMS en dBFS. */
	voz(inicioS: number, duracionS: number, nivelDbfs = -20, f0 = 120): this {
		const armonicos = Math.floor(3000 / f0);
		let norma = 0;
		for (let k = 1; k <= armonicos; k++) norma += 1 / (k * k) / 2;
		const escala = amp(nivelDbfs) / Math.sqrt(norma);
		const i0 = n(inicioS);
		const largo = n(duracionS);
		for (let i = 0; i < largo && i0 + i < this.x.length; i++) {
			const t = i / FS;
			let v = 0;
			for (let k = 1; k <= armonicos; k++) v += Math.sin(2 * Math.PI * k * f0 * t + k * k * 0.7) / k;
			this.x[i0 + i] += escala * v * envolvente(t, duracionS, 0.005, 0.01);
		}
		return this;
	}

	/** Ruido blanco (respiración) con rampas de 30 ms; nivel = RMS en dBFS. */
	respiracion(inicioS: number, duracionS: number, nivelDbfs = -40, semilla = 11): this {
		const azar = lcg(semilla);
		const a = amp(nivelDbfs) * Math.sqrt(3);
		const i0 = n(inicioS);
		for (let i = 0; i < n(duracionS); i++) this.x[i0 + i] += a * azar() * envolvente(i / FS, duracionS, 0.03, 0.03);
		return this;
	}

	/** "s": ruido blanco derivado dos veces (casi toda su energía arriba de 4 kHz). */
	fricativa(inicioS: number, duracionS: number, nivelDbfs = -30, semilla = 13): this {
		const azar = lcg(semilla);
		const largo = n(duracionS);
		const ruido = Array.from({length: largo + 2}, () => azar());
		const d2 = Array.from({length: largo}, (_, i) => ruido[i + 2] - 2 * ruido[i + 1] + ruido[i]);
		const rms = Math.sqrt(d2.reduce((s, v) => s + v * v, 0) / largo);
		const i0 = n(inicioS);
		for (let i = 0; i < largo; i++) this.x[i0 + i] += (amp(nivelDbfs) / rms) * d2[i] * envolvente(i / FS, duracionS, 0.003, 0.003);
		return this;
	}

	/** Clic: oscilación de 2 kHz amortiguada, ~1.5 ms; nivel = pico en dBFS. */
	clic(enS: number, picoDbfs = -6): this {
		const i0 = n(enS);
		for (let i = 0; i < 24; i++) this.x[i0 + i] += amp(picoDbfs) * Math.sin((2 * Math.PI * 2000 * i) / FS) * Math.exp(-i / 6);
		return this;
	}

	/** Golpe grave: 3 ciclos de 30 Hz con ventana Hann (100 ms); nivel = RMS en dBFS. */
	golpe(inicioS: number, nivelDbfs = -30): this {
		const largo = n(0.1);
		const a = amp(nivelDbfs) * Math.sqrt(2) / Math.sqrt(3 / 8);
		const i0 = n(inicioS);
		for (let i = 0; i < largo; i++) {
			const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (largo - 1));
			this.x[i0 + i] += a * hann * Math.sin((2 * Math.PI * 30 * i) / FS);
		}
		return this;
	}

	wav(): Wav {
		const muestras = Int16Array.from(this.x, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
		return {frecuencia: FS, muestras, duracionS: muestras.length / FS};
	}
}

/** Rampa coseno de subida y de bajada. */
function envolvente(t: number, duracion: number, subida: number, bajada: number): number {
	if (t < subida) return 0.5 - 0.5 * Math.cos((Math.PI * t) / subida);
	if (t > duracion - bajada) return Math.max(0, 0.5 - 0.5 * Math.cos((Math.PI * (duracion - t)) / bajada));
	return 1;
}

const T0 = 1.0; // inicio conocido de la voz (s)
const T0_MS = T0 * 1000;

describe.each([12, 20, 28])('ajustarInicios con X = %i dB', (umbralDb) => {
	const opciones = {umbralDb};

	it('encuentra el arranque de una vocal tras silencio aunque la estimación llegue tarde o temprano', () => {
		const wav = new Senal(2).voz(T0, 0.4).wav();
		for (const desfase of [-180, -60, 0, 80, 150, 190]) {
			const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + desfase}], opciones);
			expect(r.ajustada).toBe(true);
			expect(r.motivo).toBe('tras-pausa');
			expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
		}
	});

	it('ignora un clic aislado 100 ms antes de la voz', () => {
		const wav = new Senal(2).clic(T0 - 0.1).voz(T0, 0.4).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 120}], opciones);
		expect(r.ajustada).toBe(true);
		expect(r.ignorados.clics).toBeGreaterThanOrEqual(1);
		expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('ignora una respiración que termina 80 ms antes de la voz', () => {
		const wav = new Senal(2).respiracion(T0 - 0.3, 0.22).voz(T0, 0.4).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 100}], opciones);
		expect(r.ajustada).toBe(true);
		expect(r.ignorados.respiraciones).toBeGreaterThanOrEqual(1);
		expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('respeta una "s" pegada a su vocal: el arranque es el de la fricativa', () => {
		const wav = new Senal(2).fricativa(T0, 0.1).voz(T0 + 0.1, 0.4).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 150}], opciones);
		expect(r.ajustada).toBe(true);
		expect(r.ignorados.respiraciones).toBe(0);
		expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('ignora un golpe grave (30 Hz) antes de la voz gracias al paso-alto', () => {
		const wav = new Senal(2).golpe(T0 - 0.25).voz(T0, 0.4).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 100}], opciones);
		expect(r.ajustada).toBe(true);
		expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('funciona igual con un piso de ruido alto (−50 dBFS): el umbral es relativo al piso', () => {
		const wav = new Senal(2, -50).voz(T0, 0.4, -15).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS - 120}], opciones);
		expect(r.ajustada).toBe(true);
		expect(Math.abs((r.inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('no toca una palabra en medio del habla', () => {
		// Voz continua de 0.2 a 1.0 s y otra de 1.0 a 1.6 s: la frontera no tiene pausa.
		const wav = new Senal(2).voz(0.2, 0.82).voz(T0, 0.6, -20, 150).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 40}], opciones);
		expect(r.ajustada).toBe(false);
		expect(r.inicioMs).toBe(T0_MS + 40);
	});
});

describe('ajustarInicios: bordes', () => {
	it('deja en null la palabra sin estimación y no la cuenta como ajustada', () => {
		const wav = new Senal(2).voz(T0, 0.4).wav();
		const r = ajustarInicios(wav, [{inicioMs: null}, {inicioMs: T0_MS + 50}]);
		expect(r[0]).toMatchObject({inicioMs: null, ajustada: false, motivo: 'sin-estimacion'});
		expect(r[1].ajustada).toBe(true);
	});

	it('resta el desplazamiento calibrado al arranque', () => {
		const wav = new Senal(2).voz(T0, 0.4).wav();
		const [sin] = ajustarInicios(wav, [{inicioMs: T0_MS + 50}]);
		const [con] = ajustarInicios(wav, [{inicioMs: T0_MS + 50}], {desplazamientoMs: 15});
		expect(con.arranqueMs).toBe(sin.arranqueMs);
		expect(con.inicioMs).toBe((sin.inicioMs as number) - 15);
	});

	it('ajusta cada palabra tras su pausa y nunca pone una antes de la anterior', () => {
		// Palabra 1 en 1.0 s (200 ms), pausa de 300 ms, palabra 2 en 1.5 s.
		const wav = new Senal(3).voz(T0, 0.2).voz(T0 + 0.5, 0.3, -18, 140).wav();
		const r = ajustarInicios(wav, [{inicioMs: T0_MS + 60}, {inicioMs: T0_MS + 500 - 150}]);
		expect(Math.abs((r[0].inicioMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
		expect(Math.abs((r[1].inicioMs as number) - (T0_MS + 500))).toBeLessThanOrEqual(TOLERANCIA_MS);
		// Si la estimación de la segunda cae tan temprano que la ventana alcanza a la primera, no la toma.
		const temprana = ajustarInicios(wav, [{inicioMs: T0_MS + 60}, {inicioMs: T0_MS + 200}]);
		expect(temprana[1].inicioMs as number).toBeGreaterThan(temprana[0].inicioMs as number);
		expect(Math.abs((temprana[1].inicioMs as number) - T0_MS)).toBeGreaterThan(50);
	});

	it('no cuenta como tras pausa si la palabra anterior empezó hace menos de 150 ms', () => {
		const wav = new Senal(2).voz(T0, 0.4).wav();
		// La anterior no tiene voz en su ventana (se queda en T0 − 120); la siguiente ve el arranque en T0.
		const r = ajustarInicios(wav, [{inicioMs: T0_MS - 120}, {inicioMs: T0_MS - 60}]);
		expect(r[0]).toMatchObject({ajustada: false, inicioMs: T0_MS - 120});
		expect(Math.abs((r[1].arranqueMs as number) - T0_MS)).toBeLessThanOrEqual(TOLERANCIA_MS);
		expect(r[1]).toMatchObject({ajustada: false, motivo: 'en-medio-del-habla', inicioMs: T0_MS - 60});
	});

	it('no toma por pausa un valle de habla suave muy por encima del ruido de fondo', () => {
		// Voz, 200 ms de ruido suave a −40 dBFS (30 dB sobre el fondo) y otra voz: no hubo pausa.
		const wav = new Senal(2).voz(0.2, 0.8).respiracion(T0 - 0.01, 0.22, -40).voz(T0 + 0.2, 0.4, -20, 150).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS + 250}], {umbralDb: 12});
		expect((r.pisoDbfs as number) - (r.fondoDbfs as number)).toBeGreaterThan(OPCIONES_INICIO_VOZ.pisoSobreFondoMaxDb);
		expect(r).toMatchObject({ajustada: false, inicioMs: T0_MS + 250});
		// Control: sin esa regla, el valle sí pasaría por pausa y la palabra se movería al arranque de la voz.
		const [sinRegla] = ajustarInicios(wav, [{inicioMs: T0_MS + 250}], {umbralDb: 12, pisoSobreFondoMaxDb: 100});
		expect(sinRegla.ajustada).toBe(true);
		expect(Math.abs((sinRegla.inicioMs as number) - (T0_MS + 200))).toBeLessThanOrEqual(TOLERANCIA_MS);
	});

	it('no encuentra arranque en silencio puro y conserva la estimación', () => {
		const wav = new Senal(2).wav();
		const [r] = ajustarInicios(wav, [{inicioMs: T0_MS}]);
		expect(r).toMatchObject({ajustada: false, motivo: 'sin-arranque', inicioMs: T0_MS});
	});

	it('mide el piso de ruido local y pone el umbral X dB arriba', () => {
		const wav = new Senal(2, -60).voz(T0, 0.4).wav();
		const s = analizarSenal(wav);
		const d = detectarArranque(s, T0_MS + 100, T0_MS - 200, T0_MS + 300, {umbralDb: 18});
		// Ruido blanco a −60 dBFS: tras el paso-alto de 80 Hz la RMS por ventana de 10 ms anda en −60 ± 1.5 dB.
		expect(d.pisoDbfs as number).toBeGreaterThan(-63);
		expect(d.pisoDbfs as number).toBeLessThan(-59);
		expect((d.umbralDbfs as number) - (d.pisoDbfs as number)).toBeCloseTo(18, 6);
	});

	it('rechaza opciones imposibles con un error en español', () => {
		const wav = new Senal(1).wav();
		expect(() => ajustarInicios(wav, [{inicioMs: 500}], {umbralDb: Number.NaN})).toThrow(/No pude buscar el inicio de la voz/);
		expect(() => ajustarInicios(wav, [{inicioMs: 500}], {bandaVozHz: [300, 9000]})).toThrow(/banda de voz/);
		expect(OPCIONES_INICIO_VOZ.umbralDb).toBeGreaterThan(0);
	});
});
