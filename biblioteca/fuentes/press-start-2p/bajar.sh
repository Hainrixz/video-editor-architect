#!/bin/sh
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
# Baja Press Start 2P (OFL-1.1) de google/fonts en un commit fijo y revisa su sha256.
# La usa el generador voxel de la mascota para los letreros (herramientas/stickers/voxel/fuente-pixel.ts).
# Uso, desde la raíz del proyecto:  sh biblioteca/fuentes/press-start-2p/bajar.sh
set -eu

COMMIT=9710da1eacb3be272583c3224dcb70f9da6eadbb
BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl/pressstart2p"
DESTINO="$(cd "$(dirname "$0")" && pwd)"
TEMPORAL="${TMPDIR:-/tmp}/press-start-2p-$$"
mkdir -p "$TEMPORAL"

bajar() {
	archivo="$1"
	esperado="$2"
	curl -sSfL -o "$TEMPORAL/$archivo" "$BASE/$archivo"
	real="$(shasum -a 256 "$TEMPORAL/$archivo" | cut -d' ' -f1)"
	if [ "$real" != "$esperado" ]; then
		echo "No pude bajar $archivo: su sha256 ($real) no es el esperado ($esperado). Siguiente paso: avísame, no la uses." >&2
		rm -rf "$TEMPORAL"
		exit 3
	fi
	mv "$TEMPORAL/$archivo" "$DESTINO/$archivo"
	echo "✔ $archivo ($real)"
}

bajar PressStart2P-Regular.ttf 034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d
bajar OFL.txt 705960c3281a5765ecc0b59bd4ed7ca59eed165748076bc2fc3e8fdbfeb944b0
rm -rf "$TEMPORAL"
