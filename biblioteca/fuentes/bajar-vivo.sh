#!/bin/sh
# Baja las fuentes del estilo "texto vivo" (src/estilo/texto-vivo.ts), todas OFL-1.1 de google/fonts en un commit fijo,
# y revisa su sha256. Caveat es variable: se instancia a wght 700 con fonttools del .venv.
# Uso, desde la raíz del proyecto:  sh biblioteca/fuentes/bajar-vivo.sh
set -eu

COMMIT=9710da1eacb3be272583c3224dcb70f9da6eadbb
BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl"
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
DESTINO="$RAIZ/biblioteca/fuentes"
TEMPORAL="${TMPDIR:-/tmp}/fuentes-vivo-$$"
mkdir -p "$TEMPORAL" "$DESTINO/instrument-serif" "$DESTINO/caveat" "$DESTINO/anton"

revisar() { # archivo esperado
	real="$(shasum -a 256 "$1" | cut -d' ' -f1)"
	if [ "$real" != "$2" ]; then
		echo "No pude preparar $1: su sha256 ($real) no es el esperado ($2). Siguiente paso: avísame, no la uses." >&2
		rm -rf "$TEMPORAL"
		exit 3
	fi
}
bajar() { # url destino sha256
	curl -sSfL -o "$TEMPORAL/x" "$1"
	revisar "$TEMPORAL/x" "$3"
	mv "$TEMPORAL/x" "$2"
	echo "✔ $2"
}

bajar "$BASE/instrumentserif/InstrumentSerif-Italic.ttf" "$DESTINO/instrument-serif/InstrumentSerif-Italic.ttf" 08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385
bajar "$BASE/instrumentserif/OFL.txt" "$DESTINO/instrument-serif/OFL.txt" 129ed7618959716959f2941fdd5b49e0ad6e6c1d78726761786a00253d865521
bajar "$BASE/anton/Anton-Regular.ttf" "$DESTINO/anton/Anton-Regular.ttf" a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab
bajar "$BASE/anton/OFL.txt" "$DESTINO/anton/OFL.txt" ee67e6ee22790b7929f1a3769ca2801d565c64b5a9096942c1adf5596de9c9e4
bajar "$BASE/caveat/OFL.txt" "$DESTINO/caveat/OFL.txt" 1f9d81d094273d82f3898a1ee8b598a717d050ecbf5ff7bede105b704880157b
curl -sSfL -o "$TEMPORAL/caveat.ttf" "$BASE/caveat/Caveat%5Bwght%5D.ttf"
"$RAIZ/.venv/bin/fonttools" varLib.instancer --static --remove-overlaps --update-name-table --no-recalc-timestamp "$TEMPORAL/caveat.ttf" wght=700 -o "$TEMPORAL/Caveat-Bold.ttf" >/dev/null
revisar "$TEMPORAL/Caveat-Bold.ttf" 87d9a31f0993aada44ccd0a9f91faf92407f6f08c71afb410181afb85f1f49f8
mv "$TEMPORAL/Caveat-Bold.ttf" "$DESTINO/caveat/Caveat-Bold.ttf"
echo "✔ $DESTINO/caveat/Caveat-Bold.ttf"
rm -rf "$TEMPORAL"
