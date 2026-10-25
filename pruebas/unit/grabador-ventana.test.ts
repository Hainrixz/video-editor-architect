// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
/**
 * Pruebas de herramientas/grabador/ventana.ts (Fase 7, grabador de UNA ventana): lo que no necesita abrir la app.
 * Argumentos, pedido, argumentos de `open`, lectura del resultado, revisión del MP4 (CFR, cuadros, tamaño) y la
 * búsqueda de secretos en el texto del OCR (siempre enmascarados). Corren dentro del sandbox.
 * La app real (ScreenCaptureKit) la prueba pruebas/integracion/f7-grabador.ts.
 */
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {FalloEditor} from '../../herramientas/lib/fallo.ts';
import {
	BINARIO_APP,
	COMANDO_EXCLUIDO,
	RUTA_APP,
	argumentosOpen,
	buscarSecretos,
	enmascarar,
	esBloqueoDeOpen,
	interpretarResultado,
	leerArgumentos,
	pedidoDe,
	revisarVideo,
	tiemposDePaquetes,
	type ResultadoApp,
	type SondaVideo,
} from '../../herramientas/grabador/ventana.ts';

const RAIZ = '/proyecto';

function codigoDe(f: () => unknown): number | null {
	try {
		f();
		return null;
	} catch (e) {
		return e instanceof FalloEditor ? e.codigo : -1;
	}
}

describe('argumentos', () => {
	it('lo mínimo: app, segundos y salida relativa al proyecto; 30 fps, cursor y revisión de secretos por defecto', () => {
		const op = leerArgumentos(['--app', 'Terminal', '--segundos', '10', '--salida', 'demos/d1/terminal.mp4'], RAIZ);
		expect(op).toEqual({
			modo: 'grabar',
			app: 'Terminal',
			titulo: null,
			segundos: 10,
			salida: '/proyecto/demos/d1/terminal.mp4',
			fps: 30,
			cursor: true,
			pedirPermiso: true,
			sobrescribir: false,
			revisarSecretos: true,
		});
	});

	it('banderas y título', () => {
		const op = leerArgumentos(
			['--titulo', 'zsh', '--segundos', '2.5', '--salida', 'out/x.mp4', '--fps', '60', '--sin-cursor', '--sobrescribir', '--no-pedir-permiso', '--sin-revisar-secretos'],
			RAIZ,
		);
		expect(op).toMatchObject({app: null, titulo: 'zsh', segundos: 2.5, fps: 60, cursor: false, sobrescribir: true, pedirPermiso: false, revisarSecretos: false});
	});

	it('--permiso va solo', () => {
		expect(leerArgumentos(['--permiso'], RAIZ)).toEqual({modo: 'permiso'});
		expect(codigoDe(() => leerArgumentos(['--permiso', '--app', 'x'], RAIZ))).toBe(2);
	});

	it.each([
		['sin app ni título', ['--segundos', '3', '--salida', 'a.mp4']],
		['sin segundos', ['--app', 'Terminal', '--salida', 'a.mp4']],
		['segundos en cero', ['--app', 'Terminal', '--segundos', '0', '--salida', 'a.mp4']],
		['más de 600 s', ['--app', 'Terminal', '--segundos', '700', '--salida', 'a.mp4']],
		['fps con decimales', ['--app', 'Terminal', '--segundos', '3', '--salida', 'a.mp4', '--fps', '29.97']],
		['salida que no es mp4', ['--app', 'Terminal', '--segundos', '3', '--salida', 'a.mov']],
		['salida fuera del proyecto', ['--app', 'Terminal', '--segundos', '3', '--salida', '/home/otro/a.mp4']],
		['salida que se escapa con ..', ['--app', 'Terminal', '--segundos', '3', '--salida', '../fuera.mp4']],
		['salida en entrada/ (solo lectura)', ['--app', 'Terminal', '--segundos', '3', '--salida', 'entrada/a.mp4']],
		['opción desconocida', ['--app', 'Terminal', '--segundos', '3', '--salida', 'a.mp4', '--audio']],
		['opción sin valor', ['--app', '--segundos', '3', '--salida', 'a.mp4']],
	])('rechaza %s con código 2', (_n, argv) => {
		expect(codigoDe(() => leerArgumentos(argv, RAIZ))).toBe(2);
	});

	it('el error dice cómo se usa, en español', () => {
		try {
			leerArgumentos(['--segundos', '3'], RAIZ);
		} catch (e) {
			expect((e as Error).message).toMatch(/^No pude entender el pedido de grabación: falta --app o --titulo .*Siguiente paso: úsalo así: npx tsx herramientas\/grabador\/ventana\.ts/);
		}
	});
});

describe('pedido y open', () => {
	const op = leerArgumentos(['--app', 'Terminal', '--segundos', '10', '--salida', 'demos/d1/t.mp4'], RAIZ);
	if (op.modo !== 'grabar') throw new Error('modo');

	it('el pedido trae lo que valida la app (Pedido.swift), con rutas absolutas', () => {
		expect(pedidoDe(op, '/tmp/r.json')).toEqual({
			version: 1,
			app: 'Terminal',
			segundos: 10,
			salida: '/proyecto/demos/d1/t.mp4',
			fps: 30,
			resultado: '/tmp/r.json',
			cursor: true,
			pedir_permiso: true,
			sobrescribir: false,
		});
	});

	it('open: instancia nueva, espera a que termine y usa la ruta EXACTA de la app', () => {
		const args = argumentosOpen(RUTA_APP, ['--pedido', '/tmp/p.json'], '/tmp/log.txt');
		expect(args).toEqual(['-n', '-W', '-a', RUTA_APP, '--stdout', '/tmp/log.txt', '--stderr', '/tmp/log.txt', '--args', '--pedido', '/tmp/p.json']);
		expect(RUTA_APP.endsWith(join('herramientas', 'bin', 'GrabadorVentana.app'))).toBe(true);
		expect(BINARIO_APP).toBe(join(RUTA_APP, 'Contents', 'MacOS', 'GrabadorVentana'));
	});

	it('reconoce el bloqueo de open del sandbox (−600, −10810, −10822, −54)', () => {
		expect(esBloqueoDeOpen('LSOpenURLsWithRole() failed with error -600 for the file /x.app.')).toBe(true);
		expect(esBloqueoDeOpen('error -10822')).toBe(true);
		// Lo que respondió macOS 27 dentro del sandbox el 2026-10-03:
		expect(esBloqueoDeOpen('cannot be opened for an unexpected reason, error=Error Domain=NSOSStatusErrorDomain Code=-10810 "kLSUnknownErr"')).toBe(true);
		expect(esBloqueoDeOpen('The application cannot be opened because it is damaged.')).toBe(false);
		expect(COMANDO_EXCLUIDO).toBe('npx tsx herramientas/grabador/ventana.ts *');
	});
});

describe('resultado de la app', () => {
	it('éxito: lo devuelve tal cual', () => {
		const r = interpretarResultado({ok: true, codigo: 0, mensaje: 'Listo'});
		expect(r.mensaje).toBe('Listo');
	});

	it('sin permiso: código 3 con el mensaje acordado (el mismo de la app)', () => {
		const porque =
			'falta el permiso de Grabación de pantalla para GrabadorVentana: Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla';
		try {
			interpretarResultado({ok: false, codigo: 3, que: 'grabar la ventana', porque, siguiente_paso: 'prende GrabadorVentana en esa lista', mensaje: 'x'});
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(FalloEditor);
			expect((e as FalloEditor).codigo).toBe(3);
			expect((e as Error).message).toBe(`No pude grabar la ventana: ${porque}. Siguiente paso: prende GrabadorVentana en esa lista.`);
		}
	});

	it('ventana que no está: código 2; código raro → 1', () => {
		expect(codigoDe(() => interpretarResultado({ok: false, codigo: 2, que: 'grabar la ventana', porque: 'no está', siguiente_paso: 'ábrela'}))).toBe(2);
		expect(codigoDe(() => interpretarResultado({ok: false, codigo: 9, mensaje: '???'}))).toBe(1);
		expect(codigoDe(() => interpretarResultado('nada'))).toBe(1);
	});
});

describe('revisión del MP4 (CFR, cuadros y tamaño = ventana × escala)', () => {
	const res: ResultadoApp = {
		ok: true,
		codigo: 0,
		mensaje: 'Listo',
		ventana: {id: 1, app: 'Terminal', bundle: 'com.apple.Terminal', titulo: 'zsh', x: 0, y: 0, w: 800, h: 600},
		escala: 2,
		video: {w: 1600, h: 1200, fps: 30, cuadros: 300, segundos: 10, codec: 'h264', audio: false},
	};
	const bueno: SondaVideo = {
		codec: 'h264',
		w: 1600,
		h: 1200,
		rFrameRate: '30/1',
		avgFrameRate: '30/1',
		cuadros: 300,
		audio: false,
		tiempos: Array.from({length: 300}, (_, i) => i / 30),
	};

	it('un MP4 correcto no tiene problemas', () => {
		expect(revisarVideo(bueno, res, 30, 10)).toEqual([]);
	});

	it.each([
		['otro códec', {codec: 'hevc'}, /h264/],
		['con audio', {audio: true}, /audio/],
		['VFR (avg distinto)', {avgFrameRate: '2997/100'}, /avg_frame_rate/],
		['cuadros de menos', {cuadros: 299}, /299 cuadros/],
		['tamaño que no es ventana × escala', {w: 1500, h: 1200}, /ventana × escala/],
		['un cuadro fuera de su ranura', {tiempos: [...bueno.tiempos.slice(0, 100), 100 / 30 + 0.01, ...bueno.tiempos.slice(101)]}, /no es CFR/],
	])('detecta %s', (_n, cambio, texto) => {
		const problemas = revisarVideo({...bueno, ...cambio} as SondaVideo, res, 30, 10);
		expect(problemas.join(' ')).toMatch(texto);
	});

	it('lee los tiempos de ffprobe sin inventar un 0 por la línea vacía del final', () => {
		expect(tiemposDePaquetes('0.033333\n0.000000\n0.066667\n\n')).toEqual([0, 0.033333, 0.066667]);
		expect(tiemposDePaquetes('N/A\n0.5,\n')).toEqual([0.5]);
	});

	it('a 1× con ventana impar acepta 1 px de diferencia (H.264 pide tamaños pares)', () => {
		const impar: ResultadoApp = {...res, ventana: {...res.ventana!, w: 801, h: 601}, escala: 1, video: {...res.video!, w: 800, h: 600}};
		expect(revisarVideo({...bueno, w: 800, h: 600}, impar, 30, 10)).toEqual([]);
	});
});

describe('secretos en el texto del OCR', () => {
	it.each([
		['correo', 'escríbeme a creador.ejemplo@gmail.com'],
		['llave sk-', 'ANTHROPIC_API_KEY=sk-ant-TEST-0123456789abcdef'],
		['llave sk_', 'stripe sk_live_51HxYzABCDEFGHIJ'],
		['llave de Google (AIza)', 'AIzaSyA1234567890abcdefghijklmnopq'],
		['token de Apify', 'apify_api_ABCDEFGHIJ1234'],
		['token de GitHub', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456'],
		['token de GitHub', 'github_pat_11ABCDEFG0123456789_abcdef'],
		['token de Hugging Face', 'hf_ABCDEFGHIJKLMNOPQRSTU'],
		['llave de AWS', 'AKIAIOSFODNN7EXAMPLE'],
		['token de Slack', 'xoxb-1234567890-abcdefghij'],
		['token JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0'],
		['llave privada', '-----BEGIN TEST PRIVATE KEY-----'],
		['valor junto a key/token/secret', 'token: 9f8e7d6c5b4a39281706'],
	])('encuentra %s', (tipo, texto) => {
		expect(buscarSecretos(texto).map((h) => h.tipo)).toContain(tipo);
	});

	it('no se dispara con texto normal de terminal', () => {
		expect(buscarSecretos('~/mi-reel ❯ npm run render\n✓ 120 cuadros en 3.1 s\nsalida/final-v2.mp4\ngit push origin main')).toEqual([]);
	});

	it('nunca devuelve el secreto completo: solo el principio y el largo', () => {
		const secreto = 'sk-ant-TEST-0123456789abcdefghijklmnop';
		const hallazgos = buscarSecretos(`clave ${secreto}`);
		for (const h of hallazgos) {
			expect(h.muestra).not.toContain(secreto);
			expect(h.muestra).not.toContain('0123456789');
		}
		expect(enmascarar(secreto)).toBe(`sk-a…(${secreto.length} car.)`);
		expect(enmascarar('ab@c.io')).toBe('ab…(7 car.)');
	});
});
