#!/usr/bin/env python3
"""
Máscara de persona por cuadro con MediaPipe (Image Segmenter "selfie"): el par multiplataforma de
herramientas/vision/mascara.swift. Sirve para el estilo "texto vivo" (la silueta va encima de los titulares).

Uso (cuadros por stdin desde ffmpeg y máscaras por stdout hacia otro ffmpeg, sin archivos intermedios):
	ffmpeg -v error -i base.mp4 -vf scale=720:1280 -f rawvideo -pix_fmt rgba - \
		| .venv/bin/python herramientas/py/mascara.py --ancho 720 --alto 1280 \
		| ffmpeg -f rawvideo -pix_fmt gray -s 720x1280 -r 30 -i - …

Entrada: cuadros RGBA de ancho×alto×4 bytes. Salida: un cuadro gris (1 byte por pixel, 255 = persona) del MISMO
ancho×alto por cada cuadro de entrada, en el mismo orden, con bordes suaves (la confianza × 255). Si no hay nadie,
el cuadro sale en negro. --calidad accurate|balanced|fast se acepta por compatibilidad (hay un solo modelo).
Códigos de salida: 0 bien · 1 fallo interno · 2 argumentos inválidos · 3 no se pudo bajar el modelo.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from comun import Argumentos, asegurar_modelo, importar_numpy, leer_cuadro, salir_con_fallo  # noqa: E402
from cara import MODELOS  # noqa: E402


def leer_opciones(argv: list[str]) -> dict:
	o = {'ancho': 0, 'alto': 0}
	a = Argumentos(argv, '--ancho 720')
	while a.hay():
		x = a.siguiente()
		if x == '--ancho':
			o['ancho'] = int(a.numero(x))
		elif x == '--alto':
			o['alto'] = int(a.numero(x))
		elif x == '--calidad':
			a.valor(x)
		else:
			salir_con_fallo('leer las opciones', f'no conozco {x}', 'uso: mascara.py --ancho N --alto N [--calidad accurate|balanced|fast]', 2)
	if o['ancho'] <= 0 or o['alto'] <= 0:
		salir_con_fallo('leer las opciones', 'faltan --ancho y --alto', 'pásalos con el tamaño de los cuadros', 2)
	return o


def main() -> None:
	o = leer_opciones(sys.argv[1:])
	np = importar_numpy()
	try:
		import mediapipe as mp  # noqa: PLC0415
		from mediapipe.tasks.python import BaseOptions, vision  # noqa: PLC0415
	except ImportError:
		salir_con_fallo('separar a la persona', 'falta mediapipe en el .venv', 'corre uv pip install --python <python del .venv> -r herramientas/py/requirements.txt', 2)
	try:
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
		salir_con_fallo('separar a la persona', f'MediaPipe no arrancó ({str(e)[:160]})', 'reinstala las dependencias de herramientas/py/requirements.txt', 1)
	ancho, alto = o['ancho'], o['alto']
	bytes_cuadro = ancho * alto * 4
	salida = sys.stdout.buffer
	i = 0
	while True:
		# Como mascara.swift: un cuadro a medias al final se descarta sin error.
		datos = leer_cuadro(bytes_cuadro, i, estricto=False)
		if datos is None:
			break
		rgba = np.frombuffer(datos, dtype=np.uint8).reshape(alto, ancho, 4)
		imagen = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgba[:, :, :3]))
		try:
			res = segmentador.segment(imagen)
		except Exception as e:
			salir_con_fallo(f'separar a la persona en el cuadro {i} con MediaPipe', str(e)[:160], 'revisa proyectos/_logs/fallos.log y avísame', 1)
		cuadro = np.zeros((alto, ancho), dtype=np.uint8)
		if res.confidence_masks:
			conf = res.confidence_masks[0].numpy_view()
			if conf.shape[:2] == (alto, ancho):
				cuadro = np.clip(np.rint(conf.reshape(alto, ancho) * 255.0), 0, 255).astype(np.uint8)
		salida.write(cuadro.tobytes())
		i += 1
	salida.flush()


if __name__ == '__main__':
	main()
