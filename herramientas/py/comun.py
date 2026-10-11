"""
Utilidades comunes de los scripts de visión en Python (ocr.py, cara.py, mascara.py).

Estos scripts son el motor multiplataforma (macOS, Windows y Linux) equivalente a los binarios de Apple Vision de
herramientas/vision/*.swift: leen los mismos argumentos, reciben los mismos cuadros RGBA por stdin y escriben
exactamente la misma salida. Los elige herramientas/lib/plataforma.ts (motorVision).

- Errores: una línea "No pude <qué>: <por qué>. Siguiente paso: <qué hacer>." en stderr (el formato de
  herramientas/lib/fallo.ts). Códigos: 0 bien · 1 fallo interno · 2 argumentos o entrada inválidos ·
  3 no se pudo bajar un modelo (red).
- Modelos: se bajan la primera vez a la carpeta de modelos (EDITOR_MODELOS o ~/.cache/video-editor/modelos),
  nunca dentro del repo, y se verifican con su sha256.
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import NoReturn

# MediaPipe arrastra matplotlib, que quiere escribir su caché en ~/.matplotlib: va a un temporal.
os.environ.setdefault('MPLCONFIGDIR', os.path.join(tempfile.gettempdir(), 'video-editor-matplotlib'))
os.environ.setdefault('GLOG_minloglevel', '2')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')


def salir_con_fallo(que: str, porque: str, siguiente: str, codigo: int) -> NoReturn:
	try:
		sys.stdout.flush()
	except Exception:
		pass
	sys.stderr.write(f'No pude {que}: {porque}. Siguiente paso: {siguiente}.\n')
	sys.stderr.flush()
	os._exit(codigo)


def aviso(nombre: str, texto: str) -> None:
	sys.stderr.write(f'{nombre}: {texto}\n')


# ───────────────────────────── argumentos ─────────────────────────────


class Argumentos:
	"""Lector de argumentos al estilo de los binarios Swift (mismos nombres y mismos mensajes)."""

	def __init__(self, argv: list[str], ejemplo: str):
		self.args = list(argv)
		self.ejemplo = ejemplo

	def hay(self) -> bool:
		return bool(self.args)

	def siguiente(self) -> str:
		return self.args.pop(0)

	def valor(self, nombre: str) -> str:
		if not self.args:
			salir_con_fallo('leer los argumentos', f'a {nombre} le falta su valor', f'revisa el comando (ej. {self.ejemplo})', 2)
		return self.args.pop(0)

	def numero(self, nombre: str) -> float:
		texto = self.valor(nombre)
		try:
			n = float(texto)
		except ValueError:
			salir_con_fallo('leer los argumentos', f'{nombre} no es un número ({texto})', 'revisa el comando', 2)
		if n != n or n in (float('inf'), float('-inf')):
			salir_con_fallo('leer los argumentos', f'{nombre} no es un número ({texto})', 'revisa el comando', 2)
		return n


# ───────────────────────────── cuadros por stdin ─────────────────────────────


def leer_cuadro(n: int, indice: int, estricto: bool = True) -> bytes | None:
	"""Lee exactamente n bytes de stdin. None = EOF limpio; un cuadro a medias sale con 2 (si es estricto)."""
	entrada = sys.stdin.buffer
	partes: list[bytes] = []
	total = 0
	while total < n:
		trozo = entrada.read(n - total)
		if not trozo:
			break
		partes.append(trozo)
		total += len(trozo)
	if total == 0:
		return None
	if total < n:
		if not estricto:
			return None
		salir_con_fallo(
			f'leer el cuadro {indice}',
			f'llegaron {total} de {n} bytes (el tamaño no cuadra con --ancho/--alto o ffmpeg se cortó)',
			'revisa que --ancho/--alto sean los del -vf de ffmpeg y que use -pix_fmt rgba',
			2,
		)
	return b''.join(partes)


def escribir_linea(linea: str) -> None:
	"""Una línea JSON en stdout, siempre con \\n (también en Windows) y en UTF-8."""
	sys.stdout.buffer.write(linea.encode('utf-8') + b'\n')


# ───────────────────────────── JSON a mano (mismo formato que Swift) ─────────────────────────────


def num(v: float | None, decimales: int = 5, sin_menos_cero: bool = False) -> str:
	"""Como `String(format: "%.Nf")` de Swift; null si no es finito."""
	if v is None:
		return 'null'
	v = float(v)
	if v != v or v in (float('inf'), float('-inf')):
		return 'null'
	texto = f'{v:.{decimales}f}'
	if sin_menos_cero and texto == '-0.' + '0' * decimales:
		return texto[1:]
	return texto


def json_texto(s: str) -> str:
	"""Cadena JSON escapada igual que en los binarios Swift (UTF-8 tal cual, controles como \\u00XX)."""
	r = ['"']
	for ch in s:
		o = ord(ch)
		if ch == '"':
			r.append('\\"')
		elif ch == '\\':
			r.append('\\\\')
		elif ch == '\n':
			r.append('\\n')
		elif ch == '\r':
			r.append('\\r')
		elif ch == '\t':
			r.append('\\t')
		elif o < 0x20:
			r.append(f'\\u{o:04x}')
		else:
			r.append(ch)
	r.append('"')
	return ''.join(r)


# ───────────────────────────── modelos ─────────────────────────────


def carpeta_modelos() -> Path:
	propia = os.environ.get('EDITOR_MODELOS', '').strip()
	return Path(propia).expanduser().resolve() if propia else Path.home() / '.cache' / 'video-editor' / 'modelos'


def sha256_de(ruta: Path) -> str:
	h = hashlib.sha256()
	with open(ruta, 'rb') as f:
		for bloque in iter(lambda: f.read(1 << 20), b''):
			h.update(bloque)
	return h.hexdigest()


def asegurar_modelo(nombre: str, url: str, sha256: str) -> Path:
	"""Ruta local del modelo; si no está (o no cuadra su sha256), lo baja de su URL oficial una sola vez."""
	carpeta = carpeta_modelos() / 'mediapipe'
	ruta = carpeta / nombre
	if ruta.exists() and sha256_de(ruta) == sha256:
		return ruta
	try:
		carpeta.mkdir(parents=True, exist_ok=True)
	except OSError as e:
		salir_con_fallo(f'preparar el modelo {nombre}', f'no puedo crear {carpeta} ({e.strerror})', 'pon EDITOR_MODELOS en una carpeta donde se pueda escribir', 2)
	temporal = ruta.with_name(f'{nombre}.{os.getpid()}.tmp')
	try:
		with urllib.request.urlopen(url, timeout=120) as r, open(temporal, 'wb') as f:
			while True:
				bloque = r.read(1 << 20)
				if not bloque:
					break
				f.write(bloque)
	except Exception as e:  # red, proxy, DNS…
		temporal.unlink(missing_ok=True)
		salir_con_fallo(f'bajar el modelo {nombre}', f'{url} no respondió ({str(e)[:160]})', f'revisa tu conexión o bájalo tú a {ruta}', 3)
	recibido = sha256_de(temporal)
	if recibido != sha256:
		temporal.unlink(missing_ok=True)
		salir_con_fallo(f'bajar el modelo {nombre}', f'el archivo bajado no cuadra con su sha256 (llegó {recibido[:12]}…)', 'vuelve a intentarlo; si se repite, avísame', 3)
	os.replace(temporal, ruta)
	return ruta


def importar_numpy():
	try:
		import numpy as np  # noqa: PLC0415
	except ImportError:
		salir_con_fallo('preparar la visión en Python', 'falta numpy en el .venv', 'corre uv pip install --python <python del .venv> -r herramientas/py/requirements.txt', 2)
	return np
