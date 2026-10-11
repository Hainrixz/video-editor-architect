#!/bin/sh
# Fuente monoespaciada de la terminal animada (src/reel/TerminalAnimada.tsx): JetBrains Mono, OFL-1.1.
#
#   sh biblioteca/fuentes/jetbrains-mono/preparar.sh            (desde la raíz del proyecto)
#
# Qué hace, sin gastar nada:
# 1. Baja la fuente variable de github.com/google/fonts FIJADA a un commit y revisa su sha256.
# 2. Baja su OFL.txt (también con sha256) a biblioteca/fuentes/jetbrains-mono/.
# 3. Saca instancias estáticas con fonttools del .venv (las mismas opciones que biblioteca/fuentes/preparar.sh):
#    varLib.instancer --static --remove-overlaps --update-name-table --no-recalc-timestamp
#    (el mismo archivo da el mismo sha256 cada vez).
# 4. Revisa el sha256 de cada instancia contra el que se midió (src/estilo/terminal.ts y
#    biblioteca/licencias/terminal.md).
#
# Los .ttf no se versionan (.gitignore); este script los vuelve a crear idénticos.
# Si un sha256 no coincide, el script se detiene sin dejar archivos a medias.
set -eu

RAIZ=$(cd "$(dirname "$0")/../../.." && pwd)
DESTINO="$RAIZ/biblioteca/fuentes/jetbrains-mono"
FONTTOOLS="$RAIZ/.venv/bin/fonttools"
COMMIT=9710da1eacb3be272583c3224dcb70f9da6eadbb
URL_BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl/jetbrainsmono"
TEMPORAL="${TMPDIR:-/tmp}/cev-jetbrains-mono-$$"

fallo() {
	echo "No pude preparar JetBrains Mono: $1. Siguiente paso: $2." >&2
	rm -rf "$TEMPORAL"
	exit "${3:-1}"
}

if [ ! -x "$FONTTOOLS" ]; then
	fallo "no encontré fonttools en .venv/bin" "recrea el .venv del proyecto con uv (fonttools y skia-pathops)" 2
fi

sha() {
	if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

bajar() { # url destino sha256
	curl -sS --fail --max-time 180 -o "$2" "$1" || fallo "no se pudo bajar $1" "revisa tu conexión (el sandbox deja raw.githubusercontent.com)" 3
	real=$(sha "$2")
	[ "$real" = "$3" ] || fallo "$(basename "$2") llegó con sha256 $real y esperaba $3" "no la uses; avísame para revisar el commit de google/fonts" 3
}

instanciar() { # variable salida sha256 ejes...
	variable=$1
	salida=$2
	esperado=$3
	shift 3
	"$FONTTOOLS" varLib.instancer -q --static --remove-overlaps --no-recalc-timestamp --update-name-table \
		-o "$TEMPORAL/$(basename "$salida")" "$variable" "$@" ||
		fallo "fonttools no pudo instanciar $(basename "$salida")" "revisa que el .venv traiga skia-pathops" 1
	real=$(sha "$TEMPORAL/$(basename "$salida")")
	if [ "$real" != "$esperado" ]; then
		fallo "$(basename "$salida") salió con sha256 $real y esperaba $esperado" \
			"si cambiaste de versión de fonttools, revisa la terminal en un still y actualiza src/estilo/terminal.ts y biblioteca/licencias/terminal.md" 1
	fi
	mv "$TEMPORAL/$(basename "$salida")" "$salida"
	echo "  $(basename "$salida")  $real"
}

mkdir -p "$TEMPORAL" "$DESTINO"

bajar "$URL_BASE/JetBrainsMono%5Bwght%5D.ttf" "$TEMPORAL/jetbrains-mono.ttf" \
	48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda
bajar "$URL_BASE/OFL.txt" "$TEMPORAL/OFL.txt" \
	b2fe5e8987594e9ffd1d2ca52a2f5d73eb8335243893c5d6254b5ad69269591d
echo "JetBrains Mono:"
instanciar "$TEMPORAL/jetbrains-mono.ttf" "$DESTINO/JetBrainsMono-Regular.ttf" \
	dd5e2d9fd69a610770d9e2d226ac32cd95f6cff4c2a7e1323d0e111c0f07cc55 wght=400
instanciar "$TEMPORAL/jetbrains-mono.ttf" "$DESTINO/JetBrainsMono-Medium.ttf" \
	a06024eaeffed21fc2387ac726de4abd9caa21c08a6d1394471658b4e16e3d5f wght=500
instanciar "$TEMPORAL/jetbrains-mono.ttf" "$DESTINO/JetBrainsMono-Bold.ttf" \
	18769effdd12fe681a8f1c3b4be6e6254bee54998fbc0d6cbde26bb13d7f84ce wght=700
mv "$TEMPORAL/OFL.txt" "$DESTINO/OFL.txt"

rm -rf "$TEMPORAL"
echo "Listo: 3 instancias y OFL.txt en biblioteca/fuentes/jetbrains-mono/ (commit $COMMIT de google/fonts)."
