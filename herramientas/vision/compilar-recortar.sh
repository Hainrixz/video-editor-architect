#!/bin/bash
# Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
# SPDX-License-Identifier: MIT
# id: er-2f298797
# Compila herramientas/vision/recortar.swift → herramientas/bin/recortar (alfa de stickers con Apple Vision).
#
#   sh herramientas/vision/compilar-recortar.sh
#
# Va aparte de compilar.sh (ese es del OCR y no se toca). Usa la caché de módulos en $TMPDIR, porque el sandbox
# solo deja escribir ahí y en el proyecto. herramientas/bin/ está en .gitignore: el binario se regenera con esto.
# Compilar sí funciona dentro del sandbox; USAR Vision no (corre procesar.ts, que es comando excluido).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="${TMPDIR:-/tmp}/swift-cache"
FUENTE="$RAIZ/herramientas/vision/recortar.swift"
SALIDA="$RAIZ/herramientas/bin/recortar"
mkdir -p "$RAIZ/herramientas/bin" "$CACHE"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "No pude compilar recortar: no encuentro swiftc. Siguiente paso: instala las Command Line Tools (xcode-select --install, lo corres tú)." >&2
	exit 2
fi
if [ ! -f "$FUENTE" ]; then
	echo "No pude compilar recortar: no existe herramientas/vision/recortar.swift. Siguiente paso: revisa que el archivo esté en su lugar." >&2
	exit 2
fi

inicio=$(date +%s)
if ! swiftc -O -parse-as-library -module-cache-path "$CACHE" "$FUENTE" -o "$SALIDA"; then
	echo "No pude compilar recortar: swiftc terminó con error (arriba está el detalle). Siguiente paso: revisa herramientas/vision/recortar.swift." >&2
	exit 1
fi
fin=$(date +%s)
echo "Listo: herramientas/bin/recortar ($(( fin - inicio )) s, $(swiftc --version 2>&1 | head -1 | sed -E 's/.*(Swift version [0-9.]+).*/\1/'))"
