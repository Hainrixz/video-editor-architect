/**
 * Contrato entre los dos motores de visión: los scripts de Python (herramientas/py/*.py) deben escribir EXACTAMENTE
 * la forma de los binarios de Apple Vision (herramientas/vision/*.swift) que leen lib/ocr.ts y lib/cara.ts.
 *
 * - Siempre (si hay un Python 3): las funciones puras de ocr.py y cara.py (sin numpy ni modelos) contra líneas de
 *   ejemplo con la forma de ocr.swift y cara.swift: mismas claves, mismo orden y lo que acepta cada parser.
 * - Si el .venv trae rapidocr-onnxruntime: OCR de punta a punta de una imagen con texto hecha en el momento.
 * - Si además están los modelos de MediaPipe en la carpeta de modelos y el clip de prueba: cara.py de punta a punta.
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {construirCara, type CuadroVision} from '../../herramientas/lib/cara.ts';
import {parsearLineaOcr} from '../../herramientas/lib/ocr.ts';
import {pythonVenv, RAIZ_PROYECTO, rutaModelos} from '../../herramientas/lib/plataforma.ts';

const DIR_PY = join(RAIZ_PROYECTO, 'herramientas', 'py');
const PYTHON = [pythonVenv(), 'python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; assert sys.version_info >= (3, 9)'], {encoding: 'utf8'}).status === 0);

function py(codigo: string, entrada?: Buffer): {status: number | null; stdout: string; stderr: string} {
	const r = spawnSync(PYTHON!, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(DIR_PY)})\n${codigo}`], {
		input: entrada,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		timeout: 120_000,
		env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
	});
	return {status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
}
const importa = (modulo: string) => !!PYTHON && py(`import ${modulo}`).status === 0;

/** Una línea real con la forma de ocr.swift (con --palabras-cajas). */
const LINEA_SWIFT_OCR =
	'{"i":0,"t":0.500000,"cajas":[{"texto":"hola mundo","confianza":0.9800,"x":0.31000,"y":0.74000,"w":0.38000,"h":0.03000,"palabras":[{"texto":"hola","x":0.31000,"y":0.74000,"w":0.15000,"h":0.03000},{"texto":"mundo","x":0.48000,"y":0.74000,"w":0.21000,"h":0.03000}]}]}';

/** Una cara con la forma de cara.swift (con --silueta). */
const CARA_SWIFT =
	'{"x":0.31000,"y":0.22000,"w":0.38000,"h":0.21000,"confianza":0.9900,"confianza_puntos":0.8300,"roll":0.0100,"yaw":0.0000,"pitch":-0.1000,"barbilla":{"x":0.50000,"y":0.44000},"boca":{"x":0.50000,"y":0.39000},"contorno":[[0.3200,0.3000],[0.5000,0.4400],[0.6800,0.3000]],"ojo_izq":[[0.4000,0.2900]],"ojo_der":[[0.6000,0.2900]],"nariz":[[0.5000,0.3500]],"bordes_barbilla":[[0.45000,12.00]],"silueta":{"tope":0.15000,"izq":0.28000,"der":0.72000}}';

const claves = (o: object) => Object.keys(o);

describe.skipIf(!PYTHON)('contrato OCR: ocr.py escribe lo mismo que ocr.swift', () => {
	it('misma forma y orden de claves, con y sin palabras, y lib/ocr.ts la acepta', () => {
		const r = py(`
import ocr
res = [[[[100, 400], [500, 400], [500, 440], [100, 440]], 'Hola Claude', 0.97], [[[10, 10], [60, 10], [60, 14], [10, 14]], 'chiquito', 0.9], [[[0, 0], [1, 0], [1, 1], [0, 1]], '   ', 0.9]]
print(ocr.linea_de_cuadro(3, 1.5, res, 720, 1280, None, True))
print(ocr.linea_de_cuadro(4, 2.0, res, 720, 1280, 0.001, False))
print(ocr.linea_de_cuadro(5, 2.5, None, 720, 1280, None, False))
`);
		expect(r.status, r.stderr).toBe(0);
		const [conPalabras, sinPalabras, vacia] = r.stdout.trim().split('\n').map((l) => parsearLineaOcr(l));
		const swift = parsearLineaOcr(LINEA_SWIFT_OCR);
		expect(claves(conPalabras)).toEqual(claves(swift));
		expect(claves(conPalabras.cajas[0])).toEqual(claves(swift.cajas[0]));
		expect(claves(conPalabras.cajas[0].palabras![0])).toEqual(claves(swift.cajas[0].palabras![0]));
		// El texto bajito (4 px de 1280 < 1/32) se quita como en Vision; el vacío también.
		expect(conPalabras.cajas.map((c) => c.texto)).toEqual(['Hola Claude']);
		expect(conPalabras.cajas[0]).toMatchObject({x: 0.13889, y: 0.3125, w: 0.55556, h: 0.03125, confianza: 0.97});
		expect(conPalabras.cajas[0].palabras!.map((p) => p.texto)).toEqual(['Hola', 'Claude']);
		expect(conPalabras.t).toBe(1.5);
		// Con --min-alto chico entra el bajito; sin --palabras-cajas no hay "palabras".
		expect(sinPalabras.cajas.map((c) => c.texto)).toEqual(['chiquito', 'Hola Claude']);
		expect('palabras' in sinPalabras.cajas[0]).toBe(false);
		expect(vacia).toEqual({i: 5, t: 2.5, cajas: []});
		// Mismos decimales que Swift: 5 en cajas, 4 en confianza, 6 en t.
		expect(r.stdout).toMatch(/"t":1\.500000,"cajas":\[\{"texto":"Hola Claude","confianza":0\.9700,"x":0\.13889/);
	});

	it('escapa el texto igual que Swift (comillas, barras, saltos y controles)', () => {
		const r = py(`
from comun import json_texto
print(json_texto('a"b\\\\c\\nd\\x01é'))
`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout.trim()).toBe('"a\\"b\\\\c\\nd\\u0001é"');
		expect(JSON.parse(r.stdout.trim())).toBe('a"b\\c\nd\u0001é');
	});
});

describe.skipIf(!PYTHON)('contrato cara: cara.py escribe lo mismo que cara.swift', () => {
	it('misma forma y orden de claves; la barbilla y la boca son los puntos más bajos; construirCara la acepta', () => {
		// Una malla sintética de 478 puntos: una cara centrada (y crece hacia abajo con el índice de ejemplo).
		const r = py(`
import cara, json
pts = [(0.5, 0.3)] * 478
pts = [list(p) for p in pts]
for k, i in enumerate(cara.CONTORNO):
	pts[i] = [0.3 + 0.4 * k / (len(cara.CONTORNO) - 1), 0.40 + 0.05 * (1 - abs(k - 10) / 10)]
for i in cara.OJO_IZQ: pts[i] = [0.58, 0.30]
for i in cara.OJO_DER: pts[i] = [0.42, 0.30]
for i in cara.NARIZ: pts[i] = [0.5, 0.36]
for k, i in enumerate(cara.LABIOS_FUERA): pts[i] = [0.45 + 0.005 * k, 0.39 + 0.001 * k]
pts[10] = [0.5, 0.18]
pts = [tuple(p) for p in pts]
lum = lambda y0, y1, x0, x1: [0.0 if y < (y0 + y1) // 2 else 200.0 for y in range(y0, y1 + 1)]
persona = lambda x, y: 0.25 * 100 <= x <= 0.75 * 100 and y >= 12
sil = cara.datos_silueta(persona, 100, 100, pts)
print(cara.json_cara(pts, cara.confianza_de(pts, [(0.2, 0.1, 0.6, 0.6, 0.93)]), 720, 1280, lum, sil))
print(cara.json_cara(pts, cara.confianza_de(pts, []), 720, 1280, None, None))
`);
		expect(r.status, r.stderr).toBe(0);
		const [conTodo, simple] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
		const swift = JSON.parse(CARA_SWIFT);
		expect(claves(conTodo)).toEqual(claves(swift));
		expect(claves(simple)).toEqual(claves(swift).filter((k) => k !== 'silueta'));
		expect(conTodo.confianza).toBe(0.93);
		expect(simple.confianza).toBe(0.5);
		expect(conTodo.barbilla).toEqual({x: 0.5, y: 0.45});
		expect(conTodo.boca.y).toBeCloseTo(0.409, 3);
		expect(conTodo.contorno).toHaveLength(21);
		expect(conTodo.bordes_barbilla.length).toBeGreaterThan(0);
		expect(simple.bordes_barbilla).toEqual([]);
		expect(conTodo.silueta).toEqual({tope: 0.12, izq: 0.25, der: 0.76});
		expect([conTodo.roll, conTodo.yaw, conTodo.pitch, conTodo.confianza_puntos]).toEqual([null, null, null, null]);

		// lib/cara.ts la usa igual que una de Vision.
		const cuadros: CuadroVision[] = Array.from({length: 12}, (_, k) => ({n: k * 3, t: k / 10, caras: [conTodo]}));
		const c = construirCara(cuadros, {fuente: 'x.mp4', ancho: 1080, alto: 1920, fpsVideo: 30, cuadrosVideo: 36, paso: 3, anchoAnalisis: 720, altoAnalisis: 1280, silueta: true, motor: 'python'});
		expect(c.resumen.muestras_con_cara).toBe(12);
		expect(c.analisis.vision).toMatch(/MediaPipe/);
	});

	it('redondea como Swift (.rounded(): los medios lejos del cero)', () => {
		const r = py('import cara; print(cara.round_swift(2.5), cara.round_swift(-2.5), cara.round_swift(3.49))');
		expect(r.stdout.trim()).toBe('3 -3 3');
	});
});

const HAY_RAPIDOCR = importa('rapidocr_onnxruntime') && importa('PIL');

describe.skipIf(!HAY_RAPIDOCR)('ocr.py de punta a punta (RapidOCR instalado)', () => {
	it('lee un texto de una imagen hecha en el momento', () => {
		const img = spawnSync(PYTHON!, ['-c', `import sys
from PIL import Image, ImageDraw, ImageFont
im = Image.new('RGBA', (640, 360), (20, 20, 20, 255))
d = ImageDraw.Draw(im)
try:
	f = ImageFont.load_default(size=48)
except TypeError:
	f = ImageFont.load_default()
d.text((60, 150), 'Hola Claude 2026', font=f, fill=(255, 255, 255, 255))
sys.stdout.buffer.write(im.tobytes())
`], {maxBuffer: 16 * 1024 * 1024, timeout: 60_000});
		expect(img.status, String(img.stderr)).toBe(0);
		const r = spawnSync(PYTHON!, ['-B', join(DIR_PY, 'ocr.py'), '--ancho', '640', '--alto', '360', '--fps', '1', '--palabras-cajas'], {
			input: img.stdout,
			encoding: 'utf8',
			timeout: 120_000,
		});
		expect(r.status, r.stderr).toBe(0);
		const linea = parsearLineaOcr(r.stdout.trim());
		expect(linea.cajas.map((c) => c.texto).join(' ')).toMatch(/Hola\s*Claude\s*2026/);
	}, 150_000);
});

const MODELOS_MP = ['face_landmarker.task', 'blaze_face_short_range.tflite', 'selfie_segmenter.tflite'].map((m) => join(rutaModelos(), 'mediapipe', m));
const CLIP = join(RAIZ_PROYECTO, 'pruebas', 'fixtures', 'clip-6s.mp4');
const HAY_MEDIAPIPE = importa('mediapipe') && MODELOS_MP.every((m) => existsSync(m)) && existsSync(CLIP);

describe.skipIf(!HAY_MEDIAPIPE)('cara.py de punta a punta (MediaPipe y sus modelos ya bajados)', () => {
	it('encuentra la cara del clip de prueba con silueta', () => {
		const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', CLIP, '-vf', "select='not(mod(n,60))',scale=360:640", '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: 64 * 1024 * 1024});
		expect(ff.status).toBe(0);
		const r = spawnSync(PYTHON!, ['-B', join(DIR_PY, 'cara.py'), '--ancho', '360', '--alto', '640', '--fps', '0.5', '--silueta'], {input: ff.stdout, encoding: 'utf8', timeout: 120_000});
		expect(r.status, r.stderr).toBe(0);
		const lineas = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
		expect(lineas.length).toBeGreaterThan(0);
		expect(lineas.some((l) => l.caras.length > 0)).toBe(true);
		const cara = lineas.find((l) => l.caras.length > 0).caras[0];
		expect(claves(cara)).toEqual(claves(JSON.parse(CARA_SWIFT)));
	}, 150_000);
});
