#!/usr/bin/env python3
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
"""
Caras y barbilla de cuadros crudos con MediaPipe (Face Landmarker, 478 puntos, + Face Detector para la confianza
+ Image Segmenter "selfie" para la silueta): el par multiplataforma de herramientas/vision/cara.swift.

Uso (los cuadros llegan por stdin desde ffmpeg, sin archivos intermedios):
	ffmpeg -v error -i base.mp4 -vf "select='not(mod(n,3))',scale=720:1280" -fps_mode passthrough \
		-f rawvideo -pix_fmt rgba - | .venv/bin/python herramientas/py/cara.py --ancho 720 --alto 1280 --fps 10

Salida: una línea JSON por cuadro con EXACTAMENTE los campos y el orden de cara.swift:
	{"i":0,"t":0.000000,"caras":[{"x","y","w","h","confianza","confianza_puntos","roll","yaw","pitch","barbilla",
	  "boca","contorno","ojo_izq","ojo_der","nariz","bordes_barbilla"[,"silueta"]}]}
	Todo normalizado (0–1) al cuadro, origen ARRIBA-izquierda. Cómo se traduce cada campo desde la malla:
	- x, y, w, h: la caja que contiene los 478 puntos de la malla (frente a barbilla, mejilla a mejilla).
	- confianza: la del Face Detector cuya caja contiene la punta de la nariz; si ninguna la contiene, 0.5 (el umbral
	  de detección con que se corre el Landmarker). confianza_puntos, roll, yaw y pitch: null (la malla no los da
	  con el mismo significado que Vision; lib/cara.ts no los usa).
	- contorno: el óvalo de la cara de oreja a oreja por abajo (la quijada, como faceContour de Vision).
	- ojo_izq / ojo_der: los contornos de los ojos (LEFT_EYE / RIGHT_EYE de la malla, del lado de la persona).
	- nariz: puente, punta, aletas y base de la nariz. boca: el punto más bajo de los labios por fuera.
	- barbilla: el punto más bajo del contorno. bordes_barbilla: el mismo cálculo de luminancia de cara.swift.
	- silueta (con --silueta): tope y lados de la cabeza medidos en la máscara de persona, igual que cara.swift.
	Las caras van de la más grande a la más chica.

Opciones: --ancho N --alto N --fps F (obligatorios) · --t0 S · --silueta · --diagnostico.
--hilos, --puntos y --cpu se aceptan por compatibilidad (MediaPipe corre en CPU, un cuadro a la vez).
Los modelos se bajan la primera vez a EDITOR_MODELOS (o ~/.cache/video-editor/modelos)/mediapipe/.
Códigos de salida: 0 bien · 1 fallo interno · 2 argumentos o entrada inválidos · 3 no se pudo bajar un modelo.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from comun import Argumentos, asegurar_modelo, escribir_linea, importar_numpy, leer_cuadro, num, salir_con_fallo  # noqa: E402

MODELOS = {
	'landmarker': (
		'face_landmarker.task',
		'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
		'64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
	),
	'detector': (
		'blaze_face_short_range.tflite',
		'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
		'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
	),
	'segmentador': (
		'selfie_segmenter.tflite',
		'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
		'191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
	),
}

# Índices de la malla de 478 puntos (FaceLandmarksConnections de MediaPipe).
CONTORNO = [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234]
OJO_IZQ = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
OJO_DER = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
NARIZ = [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 327, 64, 294]
LABIOS_FUERA = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
PUNTA_NARIZ = 1
CONFIANZA_SIN_DETECTOR = 0.5


def leer_opciones(argv: list[str]) -> dict:
	o = {'ancho': 0, 'alto': 0, 'fps': 0.0, 't0': 0.0, 'silueta': False, 'diagnostico': False, 'puntos': 76}
	a = Argumentos(argv, '--ancho 720')
	while a.hay():
		x = a.siguiente()
		if x == '--ancho':
			o['ancho'] = int(a.numero(x))
		elif x == '--alto':
			o['alto'] = int(a.numero(x))
		elif x == '--fps':
			o['fps'] = a.numero(x)
		elif x == '--t0':
			o['t0'] = a.numero(x)
		elif x == '--hilos':
			a.numero(x)
		elif x == '--puntos':
			o['puntos'] = int(a.numero(x))
		elif x == '--silueta':
			o['silueta'] = True
		elif x == '--cpu':
			pass
		elif x == '--diagnostico':
			o['diagnostico'] = True
		elif x in ('--ayuda', '-h', '--help'):
			print('Uso: ffmpeg … -f rawvideo -pix_fmt rgba - | cara.py --ancho N --alto N --fps F [--t0 S] [--silueta]')
			sys.exit(0)
		else:
			salir_con_fallo('leer los argumentos', f'no conozco la opción {x}', 'usa --ayuda para ver las opciones', 2)
	if o['diagnostico']:
		return o
	if o['ancho'] <= 0 or o['alto'] <= 0:
		salir_con_fallo('leer los argumentos', 'faltan --ancho y --alto (en píxeles, mayores que 0)', 'pásalos igual que en el -vf de ffmpeg', 2)
	if not o['fps'] > 0:
		salir_con_fallo('leer los argumentos', 'falta --fps (mayor que 0)', 'pasa los fps con los que ffmpeg entrega los cuadros', 2)
	if o['puntos'] not in (65, 76):
		salir_con_fallo('leer los argumentos', f"--puntos debe ser 65 o 76 (llegó {o['puntos']})", 'usa --puntos 76', 2)
	return o


# ───────────────────────────── cálculo (puro: listas de Python, con pruebas) ─────────────────────────────


def json_puntos(puntos: list[tuple[float, float]]) -> str:
	return '[' + ','.join(f'[{num(x, 4, True)},{num(y, 4, True)}]' for x, y in puntos) + ']'


def bordes_barbilla(lum_filas, barbilla: tuple[float, float], ojos_y: float, ancho_cara: float, ancho: int, alto: int):
	"""
	Bordes oscuro→claro bajando desde la barbilla (mismo cálculo que cara.swift). `lum_filas(y0, y1, x0, x1)` da la
	luminancia media de cada fila y0..y1 (inclusive) en las columnas x0..x1.
	"""
	cx = barbilla[0] * ancho
	cy = barbilla[1] * alto
	f = (barbilla[1] - ojos_y) * alto
	if not f > 8:
		return []
	x0 = max(0, int(round_swift(cx - 0.1 * ancho_cara * ancho)))
	x1 = min(ancho - 1, int(round_swift(cx + 0.1 * ancho_cara * ancho)))
	y0 = max(0, int(round_swift(cy - 0.03 * f)) - 1)
	y1 = min(alto - 1, int(round_swift(cy + 0.25 * f)) + 1)
	if not (x1 > x0 and y1 - y0 >= 8):
		return []
	cruda = list(lum_filas(y0, y1, x0, x1))
	fila = []
	for i in range(len(cruda)):
		a = max(0, i - 1)
		b = min(len(cruda) - 1, i + 1)
		fila.append(sum(cruda[a:b + 1]) / (b - a + 1))
	g = [float('-inf')] * len(fila)
	for i in range(2, len(fila) - 2):
		g[i] = fila[i + 2] - fila[i - 2]
	bordes = []
	for i in range(3, len(fila) - 3):
		if g[i] >= 6 and g[i] >= g[i - 1] and g[i] >= g[i + 1]:
			bordes.append(((y0 + i + 0.5) / alto, g[i]))
			if len(bordes) == 5:
				break
	return bordes


def round_swift(v: float) -> float:
	"""`.rounded()` de Swift: al más cercano, los medios lejos del cero (Python redondea medios al par)."""
	import math  # noqa: PLC0415

	return math.floor(v + 0.5) if v >= 0 else -math.floor(-v + 0.5)


def json_silueta(persona, m_ancho: int, m_alto: int, caja: tuple[float, float, float, float], ojos_y: float | None, nariz_y: float | None, centro_x: float) -> str:
	"""Tope y lados de la cabeza en la máscara (mismo recorrido que cara.swift). `persona(x, y)` → bool."""
	cx0, cy0, cw, ch = caja

	def mx(x: float) -> int:
		return min(m_ancho - 1, max(0, int(x * m_ancho // 1)))

	def my(y: float) -> int:
		return min(m_alto - 1, max(0, int(y * m_alto // 1)))

	fila_ojos = my(ojos_y if ojos_y is not None else cy0 + 0.35 * ch)
	tope = None
	c0 = mx(cx0 + 0.3 * cw)
	c1 = mx(cx0 + 0.7 * cw)
	if c1 >= c0:
		for c in range(c0, c1 + 1):
			if not persona(c, fila_ojos):
				continue
			f = fila_ojos
			while f > 0 and persona(c, f - 1):
				f -= 1
			tope = f if tope is None else min(tope, f)
	fila_nariz = max(fila_ojos, my(nariz_y if nariz_y is not None else cy0 + 0.6 * ch))
	centro = mx(centro_x)
	izquierdas, derechas = [], []
	for f in range(fila_ojos, fila_nariz + 1):
		if not persona(centro, f):
			continue
		a = centro
		while a > 0 and persona(a - 1, f):
			a -= 1
		b = centro
		while b < m_ancho - 1 and persona(b + 1, f):
			b += 1
		izquierdas.append(a)
		derechas.append(b + 1)
	if tope is None and not izquierdas:
		return 'null'

	def mediana_int(v: list[int]) -> int:
		return sorted(v)[len(v) // 2]

	tope_t = num(tope / m_alto) if tope is not None else 'null'
	izq_t = num(mediana_int(izquierdas) / m_ancho) if izquierdas else 'null'
	der_t = num(mediana_int(derechas) / m_ancho) if derechas else 'null'
	return f'{{"tope":{tope_t},"izq":{izq_t},"der":{der_t}}}'


def json_cara(puntos: list[tuple[float, float]], confianza: float, ancho: int, alto: int, lum_filas, silueta: str | None) -> str:
	"""Una cara de la malla (478 puntos normalizados) → el objeto JSON de cara.swift."""
	xs = [p[0] for p in puntos]
	ys = [p[1] for p in puntos]
	x0, x1 = max(0.0, min(xs)), min(1.0, max(xs))
	y0, y1 = max(0.0, min(ys)), min(1.0, max(ys))
	contorno = [puntos[k] for k in CONTORNO]
	ojo_izq = [puntos[k] for k in OJO_IZQ]
	ojo_der = [puntos[k] for k in OJO_DER]
	nariz = [puntos[k] for k in NARIZ]
	barbilla = max(contorno, key=lambda p: p[1]) if contorno else None
	labios = [puntos[k] for k in LABIOS_FUERA]
	boca = max(labios, key=lambda p: p[1]) if labios else None
	campos = [
		f'"x":{num(x0, 5, True)}',
		f'"y":{num(y0, 5, True)}',
		f'"w":{num(x1 - x0, 5, True)}',
		f'"h":{num(y1 - y0, 5, True)}',
		f'"confianza":{num(confianza, 4, True)}',
		'"confianza_puntos":null',
		'"roll":null',
		'"yaw":null',
		'"pitch":null',
		'"barbilla":' + (f'{{"x":{num(barbilla[0], 5, True)},"y":{num(barbilla[1], 5, True)}}}' if barbilla else 'null'),
		'"boca":' + (f'{{"x":{num(boca[0], 5, True)},"y":{num(boca[1], 5, True)}}}' if boca else 'null'),
		f'"contorno":{json_puntos(contorno)}',
		f'"ojo_izq":{json_puntos(ojo_izq)}',
		f'"ojo_der":{json_puntos(ojo_der)}',
		f'"nariz":{json_puntos(nariz)}',
	]
	ojos = ojo_izq + ojo_der
	if barbilla and lum_filas and ojos:
		ojos_y = sum(p[1] for p in ojos) / len(ojos)
		bordes = bordes_barbilla(lum_filas, barbilla, ojos_y, x1 - x0, ancho, alto)
		campos.append('"bordes_barbilla":[' + ','.join(f'[{num(y, 5, True)},{num(fu, 2, True)}]' for y, fu in bordes) + ']')
	else:
		campos.append('"bordes_barbilla":[]')
	if silueta is not None:
		campos.append(f'"silueta":{silueta}')
	return '{' + ','.join(campos) + '}'


def area_caja(puntos: list[tuple[float, float]]) -> float:
	xs = [p[0] for p in puntos]
	ys = [p[1] for p in puntos]
	return (max(xs) - min(xs)) * (max(ys) - min(ys))


def confianza_de(puntos: list[tuple[float, float]], detecciones: list[tuple[float, float, float, float, float]]) -> float:
	"""Score del detector cuya caja (x, y, w, h normalizados) contiene la punta de la nariz; si ninguna, 0.5."""
	px, py = puntos[PUNTA_NARIZ]
	dentro = [s for x, y, w, h, s in detecciones if x <= px <= x + w and y <= py <= y + h]
	return max(dentro) if dentro else CONFIANZA_SIN_DETECTOR


def datos_silueta(persona, m_ancho: int, m_alto: int, puntos: list[tuple[float, float]]) -> str:
	ojos = [puntos[k] for k in OJO_IZQ + OJO_DER]
	nariz = [puntos[k] for k in NARIZ]
	xs = [p[0] for p in puntos]
	ys = [p[1] for p in puntos]
	caja = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
	ojos_y = sum(p[1] for p in ojos) / len(ojos) if ojos else None
	centro_x = sum(p[0] for p in ojos) / len(ojos) if ojos else caja[0] + caja[2] / 2
	nariz_y = max(p[1] for p in nariz) if nariz else None
	return json_silueta(persona, m_ancho, m_alto, caja, ojos_y, nariz_y, centro_x)


# ───────────────────────────── MediaPipe ─────────────────────────────


def preparar(silueta: bool):
	try:
		import mediapipe as mp  # noqa: PLC0415
		from mediapipe.tasks.python import BaseOptions, vision  # noqa: PLC0415
	except ImportError:
		salir_con_fallo('preparar la búsqueda de caras', 'falta mediapipe en el .venv', 'corre uv pip install --python <python del .venv> -r herramientas/py/requirements.txt', 2)
	try:
		landmarker = vision.FaceLandmarker.create_from_options(
			vision.FaceLandmarkerOptions(
				base_options=BaseOptions(model_asset_path=str(asegurar_modelo(*MODELOS['landmarker']))),
				running_mode=vision.RunningMode.IMAGE,
				num_faces=4,
				min_face_detection_confidence=CONFIANZA_SIN_DETECTOR,
				min_face_presence_confidence=CONFIANZA_SIN_DETECTOR,
			)
		)
		detector = vision.FaceDetector.create_from_options(
			vision.FaceDetectorOptions(
				base_options=BaseOptions(model_asset_path=str(asegurar_modelo(*MODELOS['detector']))),
				running_mode=vision.RunningMode.IMAGE,
				min_detection_confidence=0.3,
			)
		)
		segmentador = None
		if silueta:
			segmentador = vision.ImageSegmenter.create_from_options(
				vision.ImageSegmenterOptions(
					base_options=BaseOptions(model_asset_path=str(asegurar_modelo(*MODELOS['segmentador']))),
					running_mode=vision.RunningMode.IMAGE,
					output_confidence_masks=True,
					output_category_mask=False,
				)
			)
	except SystemExit:
		raise
	except Exception as e:
		salir_con_fallo('preparar la búsqueda de caras', f'MediaPipe no arrancó ({str(e)[:160]})', 'reinstala las dependencias de herramientas/py/requirements.txt', 1)
	return mp, landmarker, detector, segmentador


def main() -> None:
	o = leer_opciones(sys.argv[1:])
	if o['diagnostico']:
		import mediapipe as mp  # noqa: PLC0415

		escribir_linea(f'{{"motor":"mediapipe","version":"{mp.__version__}","puntos":478,"modelos":["{MODELOS["landmarker"][0]}","{MODELOS["detector"][0]}","{MODELOS["segmentador"][0]}"]}}')
		sys.stdout.flush()
		return
	np = importar_numpy()
	mp, landmarker, detector, segmentador = preparar(o['silueta'])
	ancho, alto = o['ancho'], o['alto']
	bytes_cuadro = ancho * alto * 4
	i = 0
	while True:
		datos = leer_cuadro(bytes_cuadro, i)
		if datos is None:
			break
		rgba = np.frombuffer(datos, dtype=np.uint8).reshape(alto, ancho, 4)
		rgb = np.ascontiguousarray(rgba[:, :, :3])
		imagen = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
		try:
			res = landmarker.detect(imagen)
			det = detector.detect(imagen)
			mascara = None
			if segmentador is not None:
				seg = segmentador.segment(imagen)
				if seg.confidence_masks:
					conf = seg.confidence_masks[0].numpy_view()
					mascara = conf.reshape(conf.shape[0], conf.shape[1]) >= 0.5
		except Exception as e:
			salir_con_fallo(f'buscar la cara en el cuadro {i} con MediaPipe', str(e)[:300], 'revisa proyectos/_logs/fallos.log y avísame', 1)
		detecciones = []
		for d in det.detections or []:
			b = d.bounding_box
			score = d.categories[0].score if d.categories else CONFIANZA_SIN_DETECTOR
			detecciones.append((b.origin_x / ancho, b.origin_y / alto, b.width / ancho, b.height / alto, float(score)))
		lum = (rgba[:, :, 0].astype(np.float64) * 0.299 + rgba[:, :, 1] * 0.587 + rgba[:, :, 2] * 0.114)

		def lum_filas(y0: int, y1: int, x0: int, x1: int):
			return lum[y0:y1 + 1, x0:x1 + 1].mean(axis=1).tolist()

		caras = [[(float(p.x), float(p.y)) for p in cara] for cara in (res.face_landmarks or [])]
		caras.sort(key=area_caja, reverse=True)
		objetos = []
		for puntos in caras:
			silueta = None
			if o['silueta']:
				if mascara is None:
					silueta = 'null'
				else:
					m_alto, m_ancho = mascara.shape
					silueta = datos_silueta(lambda x, y: bool(mascara[y, x]), m_ancho, m_alto, puntos)
			objetos.append(json_cara(puntos, confianza_de(puntos, detecciones), ancho, alto, lum_filas, silueta))
		t = o['t0'] + i / o['fps']
		escribir_linea(f'{{"i":{i},"t":{num(t, 6)},"caras":[{",".join(objetos)}]}}')
		i += 1
	sys.stdout.flush()


if __name__ == '__main__':
	main()
