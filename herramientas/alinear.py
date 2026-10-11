#!/usr/bin/env python3
"""
alinear.py — alineación forzada (CTC) de un texto contra su audio, palabra por palabra.

Uso (desde la raíz, con el .venv del proyecto):
	.venv/bin/python herramientas/alinear.py --audio <wav 16k mono> --texto <txt> --idioma spa \
		--modelo <id de Hugging Face> --salida <json>

Opciones:
	--motor auto|onnx|torch     auto: ONNX para MahmoudAshraf/mms-300m-1130-forced-aligner (el export que usa
	                            ctc-forced-aligner 1.0.2) y torch/transformers para cualquier otro modelo CTC.
	--romanizar auto|si|no      auto: sí para MMS (vocabulario a-z), no para los demás (vocabulario nativo).
	--dispositivo auto|cpu|mps  solo para torch (auto = mps si está disponible).
	--normalizar auto|si|no     media 0 y varianza 1 sobre todo el audio antes del modelo. auto = lo que diga
	                            el preprocessor_config.json del modelo (do_normalize).
	--ventana 30 --contexto 2   el audio largo se procesa en ventanas de 30 s con 2 s de contexto a cada lado.
	--lote 1                    ventanas por llamada al modelo (1 gasta menos memoria y en CPU no es más lento).
	--revision <sha>            commit del repo de Hugging Face (los modelos conocidos ya vienen fijados).

Qué hace:
1. Lee el WAV (PCM s16, mono, 16 kHz) y el texto (las palabras se separan por espacios o saltos de línea).
2. Calcula las log-probabilidades del modelo por ventanas con contexto (un cuadro cada 20 ms).
3. Pasa cada palabra al vocabulario del modelo (números en español a letras; romaniza si toca).
4. Alinea con Viterbi CTC (el alineador en C++ de ctc-forced-aligner 1.0.2) con un comodín <star> antes de
   cada palabra (log-prob 0, como en ctc-forced-aligner), que absorbe lo que se dijo y no está en el texto.
5. Escribe un JSON con una entrada por palabra del texto, en el mismo orden: {i, t, d, h, score, alineada, fichas}
	d: inicio (s) = inicio del primer cuadro de su primera letra en el camino de Viterbi (cuadro × 20 ms).
	h: fin (s) = fin del último cuadro de su última letra.
	score: media geométrica de la probabilidad de sus letras en sus cuadros (0–1).
	Una palabra sin letras alineables (solo puntuación) sale con alineada=false y d/h/score en null.

Todo es local y gratis: los modelos se bajan una vez de Hugging Face a ~/.cache/huggingface, sin token.
Errores: una línea en español en stderr. Códigos: 1 fallo interno · 2 entrada inválida · 3 descarga/servicio.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
import wave

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
# Nunca se usa ni se lee un token de Hugging Face: los modelos son públicos.
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('TRANSFORMERS_NO_ADVISORY_WARNINGS', '1')
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
# Sin esto, transformers busca en segundo plano (con red) una versión safetensors de los modelos .bin.
os.environ.setdefault('DISABLE_SAFETENSORS_CONVERSION', 'true')

FRECUENCIA = 16000
PASO_MUESTRAS = 320  # wav2vec2: un cuadro cada 320 muestras (20 ms), campo receptivo de 400 muestras
MODELO_MMS = 'MahmoudAshraf/mms-300m-1130-forced-aligner'
# Export ONNX del mismo modelo (MODEL_URL de ctc-forced-aligner 1.0.2). Verificado contra los pesos originales
# en torch: |Δp| máx 0.0007, argmax idéntico en el 100% de los cuadros y el mismo inicio en las 841 palabras
# de los 3 fixtures de la compuerta.
ONNX_MMS = ('deskpai/ctc_forced_aligner', '04ac86b67129634da93aea76e0147ef3.onnx')
# Commits fijos de los modelos conocidos (lo que se midió en la compuerta).
REVISIONES = {
	'deskpai/ctc_forced_aligner': '77d85f9ffaa8cd367699ecff985c70e9064ca41c',
	MODELO_MMS: '49402e9577b1158620820667c218cd494cc44486',
	'jonatasgrosman/wav2vec2-large-xlsr-53-spanish': '96d7e9b4e4a78af515a3c6d3cee7c0826045d276',
}


class FalloAlineacion(Exception):
	def __init__(self, porque: str, siguiente: str, codigo: int = 1):
		super().__init__(f'No pude alinear: {porque}. Siguiente paso: {siguiente}.')
		self.codigo = codigo


# ───────────────────────── entrada ─────────────────────────


def leer_wav(ruta: str):
	import numpy as np

	if not os.path.isfile(ruta):
		raise FalloAlineacion(f'no existe el audio {ruta}', 'revisa la ruta (debe ser el audio16k.wav de la ingesta)', 2)
	try:
		with wave.open(ruta, 'rb') as w:
			canales, ancho, frecuencia, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
			crudo = w.readframes(n)
	except (wave.Error, EOFError) as error:
		raise FalloAlineacion(f'{ruta} no es un WAV PCM legible ({error})', 'genera el WAV con ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le', 2)
	if canales != 1 or ancho != 2 or frecuencia != FRECUENCIA:
		raise FalloAlineacion(
			f'{ruta} es {canales} canal(es), {ancho * 8} bits, {frecuencia} Hz y se espera mono, 16 bits, 16 kHz',
			'genera el WAV con ffmpeg -vn -ac 1 -ar 16000 -c:a pcm_s16le',
			2,
		)
	muestras = np.frombuffer(crudo, dtype='<i2').astype(np.float32) / 32768.0
	if muestras.size < FRECUENCIA // 10:
		raise FalloAlineacion(f'{ruta} dura menos de 0.1 s', 'revisa que el audio traiga tu voz', 2)
	return muestras


def leer_palabras(ruta: str) -> list[str]:
	if not os.path.isfile(ruta):
		raise FalloAlineacion(f'no existe el texto {ruta}', 'revisa la ruta del .txt con las palabras', 2)
	try:
		with open(ruta, encoding='utf-8') as f:
			texto = f.read()
	except UnicodeDecodeError:
		raise FalloAlineacion(f'{ruta} no está en UTF-8', 'guarda el texto en UTF-8', 2)
	palabras = texto.split()
	if not palabras:
		raise FalloAlineacion(f'{ruta} no trae palabras', 'pásale el texto de la transcripción', 2)
	return palabras


# ───────────────────────── texto → fichas del modelo ─────────────────────────

_UNIDADES = [
	'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
	'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno',
	'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve',
]
_DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa']
_CENTENAS = [
	'', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos',
	'ochocientos', 'novecientos',
]


def entero_en_letras(n: int) -> str:
	"""Entero ≥ 0 en letras (español). Más de 12 dígitos: dígito por dígito."""
	if n < 30:
		return _UNIDADES[n]
	if n < 100:
		d, u = divmod(n, 10)
		return _DECENAS[d] + ('' if u == 0 else ' y ' + _UNIDADES[u])
	if n < 1000:
		c, r = divmod(n, 100)
		if n == 100:
			return 'cien'
		return _CENTENAS[c] + ('' if r == 0 else ' ' + entero_en_letras(r))
	if n < 1_000_000:
		m, r = divmod(n, 1000)
		base = 'mil' if m == 1 else _apocope(entero_en_letras(m)) + ' mil'
		return base + ('' if r == 0 else ' ' + entero_en_letras(r))
	if n < 10**12:
		m, r = divmod(n, 1_000_000)
		base = 'un millón' if m == 1 else _apocope(entero_en_letras(m)) + ' millones'
		return base + ('' if r == 0 else ' ' + entero_en_letras(r))
	return ' '.join(_UNIDADES[int(c)] for c in str(n))


def _apocope(texto: str) -> str:
	if texto.endswith('veintiuno'):
		return texto[: -len('veintiuno')] + 'veintiún'
	if texto.endswith('uno'):
		return texto[:-3] + 'un'
	return texto


_NUMERO = re.compile(r'(\d+)(?:([.,])(\d+))?(\s*%)?')


def verbalizar_numeros(palabra: str) -> str:
	"""'5.5' → 'cinco punto cinco', '30%' → 'treinta por ciento' (solo español)."""

	def cambiar(m: re.Match) -> str:
		entero, separador, decimales, porciento = m.group(1), m.group(2), m.group(3), m.group(4)
		texto = entero_en_letras(int(entero))
		if decimales:
			nombre = 'punto' if separador == '.' else 'coma'
			parte = ' '.join(_UNIDADES[int(c)] for c in decimales) if decimales.startswith('0') else entero_en_letras(int(decimales))
			texto += f' {nombre} {parte}'
		if porciento:
			texto += ' por ciento'
		return f' {texto} '

	return _NUMERO.sub(cambiar, palabra)


def fichas_de_palabra(palabra: str, vocab: dict[str, int], romanizar: bool, idioma: str) -> list[str]:
	"""
	Letras de la palabra que existen en el vocabulario del modelo (en minúsculas). Solo letras: la
	puntuación que algunos vocabularios traen (' - |) no se pronuncia y no se alinea.
	"""
	from unidecode import unidecode

	texto = unicodedata.normalize('NFKC', palabra).lower()
	if idioma == 'spa':
		texto = verbalizar_numeros(texto)
	if romanizar:
		texto = unidecode(texto).lower()
	fichas: list[str] = []
	for caracter in texto:
		if not caracter.isalpha():
			continue
		if caracter in vocab:
			fichas.append(caracter)
		elif not romanizar:
			# Vocabulario nativo: una letra que no esté (p. ej. 'à') se intenta sin acento.
			fichas.extend(c for c in unidecode(caracter).lower() if c.isalpha() and c in vocab)
	return fichas


# ───────────────────────── modelo y emisiones ─────────────────────────


def _silenciar_bibliotecas() -> None:
	import logging

	for nombre in ('huggingface_hub', 'transformers', 'torch'):
		logging.getLogger(nombre).setLevel(logging.ERROR)
	try:
		from transformers.utils import logging as tlogging

		tlogging.set_verbosity_error()
		tlogging.disable_progress_bar()
	except Exception:
		pass


def _archivo_hf(repo: str, archivo: str, revision: str | None, obligatorio: bool = True) -> str | None:
	"""Ruta local de un archivo del repo: primero la caché (sin red), si no, lo baja (gratis, sin token)."""
	from huggingface_hub import hf_hub_download

	try:
		return hf_hub_download(repo, archivo, revision=revision, token=False, local_files_only=True)
	except Exception:
		pass
	try:
		return hf_hub_download(repo, archivo, revision=revision, token=False)
	except Exception as error:
		if not obligatorio and type(error).__name__ in ('EntryNotFoundError', 'RemoteEntryNotFoundError'):
			return None
		raise FalloAlineacion(
			f'no pude bajar {repo}/{archivo} de Hugging Face ({type(error).__name__})',
			'revisa tu conexión y el id del modelo; la descarga es gratis y queda en ~/.cache/huggingface',
			3,
		)


class Modelo:
	"""Envuelve un modelo CTC: logits(lote [B, N] float32) → [B, T, C]."""

	def __init__(self, modelo: str, motor: str, dispositivo: str, revision: str | None):
		self.id = modelo
		self.motor = motor
		self.dispositivo = 'cpu'
		self.revision = revision or REVISIONES.get(modelo)
		_silenciar_bibliotecas()
		if motor == 'onnx':
			if modelo != MODELO_MMS:
				raise FalloAlineacion(f'el motor onnx solo existe para {MODELO_MMS}', 'usa --motor torch con ese modelo', 2)
			import onnxruntime
			from ctc_forced_aligner import VOCAB_DICT

			ruta = _archivo_hf(ONNX_MMS[0], ONNX_MMS[1], REVISIONES[ONNX_MMS[0]])
			opciones = onnxruntime.SessionOptions()
			opciones.log_severity_level = 3
			self.sesion = onnxruntime.InferenceSession(ruta, sess_options=opciones, providers=['CPUExecutionProvider'])
			self.vocab = dict(VOCAB_DICT)
			self.blank = self.vocab['<blank>']
			self.origen = f'{ONNX_MMS[0]}/{ONNX_MMS[1]}@{REVISIONES[ONNX_MMS[0]][:10]}'
			self.do_normalize = self._do_normalize(modelo)
			return
		try:
			import torch
			from transformers import AutoModelForCTC
		except ImportError:
			raise FalloAlineacion(
				'falta torch o transformers en el .venv',
				'instala torch==2.14.1 y transformers==5.18.0 con uv pip install --python .venv/bin/python',
				2,
			)
		if dispositivo == 'auto':
			dispositivo = 'mps' if torch.backends.mps.is_available() else 'cpu'
		self.dispositivo = dispositivo
		red = None
		for solo_local in (True, False):
			try:
				red = AutoModelForCTC.from_pretrained(modelo, revision=self.revision, token=False, local_files_only=solo_local)
				break
			except OSError as error:
				if not solo_local:
					raise FalloAlineacion(
						f'no pude cargar {modelo} de Hugging Face ({str(error).splitlines()[0][:160]})',
						'revisa el id del modelo y tu conexión; la descarga es gratis y queda en ~/.cache/huggingface',
						3,
					)
		self.red = red.eval().to(dispositivo)
		with open(_archivo_hf(modelo, 'vocab.json', self.revision), encoding='utf-8') as f:
			vocab = json.load(f)
		if vocab and all(isinstance(v, dict) for v in vocab.values()):
			raise FalloAlineacion(f'{modelo} trae un vocabulario por idioma', 'usa un modelo CTC con vocab.json plano', 2)
		self.vocab = {k: int(v) for k, v in vocab.items()}
		pad = self.red.config.pad_token_id
		self.blank = int(pad if pad is not None else 0)
		self.origen = f'{modelo}@{(self.revision or "main")[:10]}'
		self.do_normalize = self._do_normalize(modelo)

	def _do_normalize(self, modelo: str) -> bool:
		ruta = _archivo_hf(modelo, 'preprocessor_config.json', self.revision, obligatorio=False)
		if not ruta:
			return False
		with open(ruta, encoding='utf-8') as f:
			return bool(json.load(f).get('do_normalize', False))

	def logits(self, lote):
		import numpy as np

		if self.motor == 'onnx':
			return self.sesion.run(['logits'], {'input_values': lote.astype(np.float32)})[0]
		import torch

		with torch.inference_mode():
			x = torch.from_numpy(lote).to(self.dispositivo)
			return self.red(x).logits.float().cpu().numpy()


def calcular_emisiones(modelo: Modelo, audio, ventana_s: float, contexto_s: float, lote: int = 1):
	"""
	Log-probabilidades [T, C] por ventanas de `ventana_s` con `contexto_s` a cada lado (el contexto se recorta).
	El cuadro f cubre las muestras [320·f, 320·f + 400) del audio; T = ceil(muestras / 320).
	"""
	import numpy as np

	ventana = int(round(ventana_s * FRECUENCIA))
	contexto = int(round(contexto_s * FRECUENCIA))
	if ventana <= 0 or contexto < 0 or ventana % PASO_MUESTRAS or contexto % PASO_MUESTRAS:
		raise FalloAlineacion('la ventana y el contexto deben ser múltiplos positivos de 20 ms', 'usa p. ej. --ventana 30 --contexto 2', 2)
	n = audio.shape[0]
	n_ventanas = max(1, math.ceil(n / ventana))
	relleno = np.pad(audio, (contexto, contexto + n_ventanas * ventana - n))
	cuadros_contexto = contexto // PASO_MUESTRAS
	cuadros_ventana = ventana // PASO_MUESTRAS
	partes = []
	for i in range(0, n_ventanas, max(1, lote)):
		bloque = np.stack([relleno[k * ventana: k * ventana + ventana + 2 * contexto] for k in range(i, min(n_ventanas, i + max(1, lote)))])
		salida = modelo.logits(bloque)
		if salida.shape[1] < cuadros_contexto + cuadros_ventana:
			raise FalloAlineacion(f'el modelo devolvió {salida.shape[1]} cuadros por ventana', 'avísame: el modelo no usa pasos de 20 ms', 1)
		partes.append(salida[:, cuadros_contexto: cuadros_contexto + cuadros_ventana, :])
	logits = np.concatenate(partes, axis=0).reshape(-1, partes[0].shape[-1])
	logits = logits[: math.ceil(n / PASO_MUESTRAS)].astype(np.float64)
	logits -= logits.max(axis=1, keepdims=True)
	logp = logits - np.log(np.exp(logits).sum(axis=1, keepdims=True))
	return logp.astype(np.float32)


# ───────────────────────── alineación ─────────────────────────


def _alineador_c():
	"""El alineador Viterbi en C++ de ctc-forced-aligner 1.0.2 (align_ops)."""
	try:
		from ctc_forced_aligner.ctc_aligner import align_sequences
	except Exception as error:
		raise FalloAlineacion(
			f'no cargó el alineador de ctc-forced-aligner ({type(error).__name__})',
			'reinstala con uv pip install --python .venv/bin/python ctc-forced-aligner==1.0.2 (necesita las Command Line Tools)',
			2,
		)
	return align_sequences


def alinear_fichas(logp, fichas_por_palabra: list[list[str]], vocab: dict[str, int], blank: int):
	"""
	Viterbi CTC con <star> antes de cada palabra alineable. Devuelve, por palabra, la lista de tramos
	(cuadro_inicio, cuadro_fin_inclusive) de cada una de sus letras, o None si no tiene letras.
	"""
	import numpy as np

	align_sequences = _alineador_c()
	T, C = logp.shape
	estrella = C  # columna extra con log-prob 0 (comodín), como en ctc-forced-aligner
	emisiones = np.concatenate([logp, np.zeros((T, 1), dtype=np.float32)], axis=1)
	objetivos: list[int] = []
	duenos: list[int] = []  # a qué palabra pertenece cada objetivo (-1 = estrella)
	for j, fichas in enumerate(fichas_por_palabra):
		if not fichas:
			continue
		objetivos.append(estrella)
		duenos.append(-1)
		for f in fichas:
			objetivos.append(vocab[f])
			duenos.append(j)
	if not objetivos:
		raise FalloAlineacion('ninguna palabra tiene letras del vocabulario del modelo', 'revisa el idioma del texto y el modelo', 2)
	repetidos = sum(1 for a, b in zip(objetivos, objetivos[1:]) if a == b)
	if T < len(objetivos) + repetidos:
		raise FalloAlineacion(
			f'el texto ({len(objetivos)} fichas) no cabe en el audio ({T} cuadros de 20 ms)',
			'revisa que el texto corresponda a este audio',
			2,
		)
	caminos, _ = align_sequences(emisiones[None, :, :], np.asarray([objetivos], dtype=np.int64), blank)
	camino = caminos[0]
	# Cada racha de una misma etiqueta no-blank es una emisión del siguiente objetivo, en orden
	# (CTC exige un blank entre dos objetivos iguales seguidos).
	tramos_por_objetivo: list[tuple[int, int] | None] = [None] * len(objetivos)
	k = -1
	t = 0
	while t < T:
		etiqueta = int(camino[t])
		if etiqueta == blank:
			t += 1
			continue
		fin = t
		while fin + 1 < T and int(camino[fin + 1]) == etiqueta:
			fin += 1
		k += 1
		if k >= len(objetivos) or objetivos[k] != etiqueta:
			raise FalloAlineacion('el camino de Viterbi no coincide con el texto', 'avísame: es un fallo interno del alineador', 1)
		tramos_por_objetivo[k] = (t, fin)
		t = fin + 1
	if k != len(objetivos) - 1:
		raise FalloAlineacion(f'el camino de Viterbi emitió {k + 1} de {len(objetivos)} fichas', 'avísame: es un fallo interno del alineador', 1)
	por_palabra: list[list[tuple[int, int]] | None] = [None] * len(fichas_por_palabra)
	for dueno, tramo in zip(duenos, tramos_por_objetivo):
		if dueno >= 0:
			por_palabra[dueno] = (por_palabra[dueno] or []) + [tramo]
	return por_palabra


def resultados_por_palabra(palabras, fichas_por_palabra, tramos, logp, vocab, paso_s=PASO_MUESTRAS / FRECUENCIA):
	salida = []
	for j, (palabra, fichas, letras) in enumerate(zip(palabras, fichas_por_palabra, tramos)):
		if not letras:
			salida.append({'i': j, 't': palabra, 'd': None, 'h': None, 'score': None, 'alineada': False, 'fichas': ''})
			continue
		logs = [float(logp[t, vocab[f]]) for f, (a, b) in zip(fichas, letras) for t in range(a, b + 1)]
		salida.append({
			'i': j,
			't': palabra,
			'd': round(letras[0][0] * paso_s, 3),
			'h': round((letras[-1][1] + 1) * paso_s, 3),
			'score': round(math.exp(sum(logs) / len(logs)), 4),
			'alineada': True,
			'fichas': ''.join(fichas),
		})
	return salida


# ───────────────────────── CLI ─────────────────────────


def versiones() -> dict[str, str]:
	from importlib.metadata import PackageNotFoundError, version

	salida = {'python': sys.version.split()[0]}
	for paquete in ['ctc-forced-aligner', 'onnxruntime', 'numpy', 'torch', 'transformers', 'huggingface-hub', 'unidecode']:
		try:
			salida[paquete] = version(paquete)
		except PackageNotFoundError:
			pass
	return salida


class _Analizador(argparse.ArgumentParser):
	def error(self, message: str):  # una línea en español en vez del uso de argparse
		faltan = re.search(r'required: (.+)', message)
		opcion = re.search(r"argument (\S+): invalid choice: '?([^']*)'? \(choose from (.+)\)", message)
		numero = re.search(r'argument (\S+): invalid (?:float|int) value', message)
		sobran = re.search(r'unrecognized arguments: (.+)', message)
		if faltan:
			porque = f'faltan {faltan.group(1)}'
		elif opcion:
			porque = f"{opcion.group(1)} no acepta '{opcion.group(2)}' (usa {opcion.group(3)})"
		elif numero:
			porque = f'{numero.group(1)} espera un número'
		elif sobran:
			porque = f'no reconozco {sobran.group(1)}'
		else:
			porque = f'los argumentos no son válidos ({message})'
		raise FalloAlineacion(porque, 'corre con --audio, --texto, --idioma, --modelo y --salida', 2)


def principal(argv: list[str]) -> int:
	analizador = _Analizador(description='Alineación forzada CTC palabra por palabra (local y gratis).')
	analizador.add_argument('--audio', required=True)
	analizador.add_argument('--texto', required=True)
	analizador.add_argument('--idioma', default='spa')
	analizador.add_argument('--modelo', default=MODELO_MMS)
	analizador.add_argument('--salida', required=True)
	analizador.add_argument('--motor', choices=['auto', 'onnx', 'torch'], default='auto')
	analizador.add_argument('--romanizar', choices=['auto', 'si', 'no'], default='auto')
	analizador.add_argument('--dispositivo', choices=['auto', 'cpu', 'mps'], default='auto')
	analizador.add_argument('--normalizar', choices=['auto', 'si', 'no'], default='auto')
	analizador.add_argument('--ventana', type=float, default=30.0)
	analizador.add_argument('--contexto', type=float, default=2.0)
	analizador.add_argument('--lote', type=int, default=1)
	analizador.add_argument('--revision', default=None)
	args = analizador.parse_args(argv)

	inicio_total = time.perf_counter()
	audio = leer_wav(args.audio)
	palabras = leer_palabras(args.texto)

	motor = args.motor
	if motor == 'auto':
		motor = 'onnx' if args.modelo == MODELO_MMS else 'torch'
	romanizar = args.romanizar == 'si' or (args.romanizar == 'auto' and args.modelo == MODELO_MMS)

	t0 = time.perf_counter()
	modelo = Modelo(args.modelo, motor, args.dispositivo, args.revision)
	t_carga = time.perf_counter() - t0

	import numpy as np

	normalizar = args.normalizar == 'si' or (args.normalizar == 'auto' and modelo.do_normalize)
	entrada = (audio - audio.mean()) / (audio.std() + 1e-7) if normalizar else audio
	t0 = time.perf_counter()
	logp = calcular_emisiones(modelo, entrada.astype(np.float32), args.ventana, args.contexto, args.lote)
	t_emisiones = time.perf_counter() - t0

	fichas = [fichas_de_palabra(p, modelo.vocab, romanizar, args.idioma) for p in palabras]
	t0 = time.perf_counter()
	tramos = alinear_fichas(logp, fichas, modelo.vocab, modelo.blank)
	salida_palabras = resultados_por_palabra(palabras, fichas, tramos, logp, modelo.vocab)
	t_alineacion = time.perf_counter() - t0

	duracion = audio.shape[0] / FRECUENCIA
	resultado = {
		'modelo': args.modelo,
		'origen_pesos': modelo.origen,
		'motor': motor,
		'dispositivo': modelo.dispositivo,
		'idioma': args.idioma,
		'romanizar': romanizar,
		'normalizar_audio': bool(normalizar),
		'ventana_s': args.ventana,
		'contexto_s': args.contexto,
		'paso_s': PASO_MUESTRAS / FRECUENCIA,
		'convencion_tiempo': 'd = primer cuadro de la primera letra × 20 ms; h = (último cuadro de la última letra + 1) × 20 ms',
		'duracion_s': round(duracion, 3),
		'n_palabras': len(palabras),
		'alineadas': sum(1 for p in salida_palabras if p['alineada']),
		'tiempos_s': {
			'carga': round(t_carga, 3),
			'emisiones': round(t_emisiones, 3),
			'alineacion': round(t_alineacion, 3),
			'total': round(time.perf_counter() - inicio_total, 3),
		},
		'versiones': versiones(),
		'palabras': salida_palabras,
	}
	os.makedirs(os.path.dirname(os.path.abspath(args.salida)), exist_ok=True)
	temporal = f'{args.salida}.tmp'
	with open(temporal, 'w', encoding='utf-8') as f:
		json.dump(resultado, f, ensure_ascii=False, indent='\t')
		f.write('\n')
	os.replace(temporal, args.salida)
	print(
		f"Listo: {resultado['alineadas']}/{len(palabras)} palabras alineadas con {args.modelo} ({motor}, {modelo.dispositivo}) "
		f"en {resultado['tiempos_s']['total']:.1f} s para {duracion:.1f} s de audio → {args.salida}"
	)
	return 0


def main() -> None:
	try:
		codigo = principal(sys.argv[1:])
	except FalloAlineacion as error:
		print(str(error), file=sys.stderr)
		codigo = error.codigo
	except KeyboardInterrupt:
		print('No pude alinear: se interrumpió a mano. Siguiente paso: vuelve a correrlo.', file=sys.stderr)
		codigo = 1
	except MemoryError:
		print('No pude alinear: se acabó la memoria. Siguiente paso: usa --lote 1 o un audio más corto.', file=sys.stderr)
		codigo = 1
	except Exception as error:  # cualquier otra cosa es un fallo interno: una línea, sin traza
		motivo = str(error).splitlines()[0][:200] if str(error) else type(error).__name__
		print(f'No pude alinear: {type(error).__name__}: {motivo}. Siguiente paso: avísame con este mensaje.', file=sys.stderr)
		codigo = 1
	sys.exit(codigo)


if __name__ == '__main__':
	main()
