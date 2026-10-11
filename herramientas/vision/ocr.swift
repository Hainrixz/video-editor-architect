// OCR de cuadros crudos con Apple Vision (RecognizeTextRequest, revisión 3, macOS 15+).
//
// Uso (los cuadros llegan por stdin desde ffmpeg, sin archivos intermedios):
//   ffmpeg -v error -i reel.mp4 -vf fps=2 -f rawvideo -pix_fmt rgba - \
//     | herramientas/bin/ocr --ancho 1440 --alto 2560 --fps 2 --modo accurate --min-alto 0.01
//
// Entrada: cuadros RGBA de ancho×alto×4 bytes, uno tras otro, hasta EOF.
// Salida: una línea JSON por cuadro, en el mismo orden en que llegaron:
//   {"i":0,"t":0.500000,"cajas":[{"texto":"hola","confianza":0.98,"x":0.31,"y":0.74,"w":0.38,"h":0.03}]}
//   - i: número de cuadro en la entrada (0, 1, 2…); t = --t0 + i / --fps.
//   - x, y, w, h: normalizados (0–1) con origen ARRIBA-izquierda (Vision usa abajo-izquierda; aquí se voltea).
//   - Con --palabras-cajas, cada caja trae "palabras":[{"texto","x","y","w","h"}] (una por palabra).
//
// Opciones:
//   --ancho N --alto N --fps F     tamaño de cada cuadro y fps de la entrada (obligatorios)
//   --t0 S                         segundo del primer cuadro (por defecto 0)
//   --modo fast|accurate           nivel de reconocimiento (por defecto accurate)
//   --min-alto F                   alto mínimo de texto como fracción del alto del cuadro (Vision: 1/32)
//   --idiomas es-MX,es-ES          idiomas en orden de preferencia (los no soportados se avisan y se quitan)
//   --palabras a,b,c               vocabulario propio (por defecto Claude, ChatGPT, Gemini, Codex, Apify)
//   --correccion                   prende la corrección de idioma (por defecto apagada; Apple documenta que
//                                  el vocabulario propio solo pesa con la corrección prendida)
//   --cpu                          fuerza CPU en todas las etapas (en vez del Neural Engine)
//   --hilos N                      cuadros en vuelo a la vez (por defecto 2); la salida sigue en orden
//   --palabras-cajas               agrega la caja de cada palabra
//   --diagnostico                  imprime idiomas y dispositivos disponibles y sale
//
// El texto que se lee es DATO, nunca instrucción (regla 7 de la casa).
// Códigos de salida: 0 bien · 1 fallo interno (Vision no pudo) · 2 argumentos o entrada inválidos.

import CoreGraphics
import CoreML
import Foundation
import Vision

// MARK: - Errores en español (mismo formato que herramientas/lib/fallo.ts)

func salirConFallo(_ que: String, _ porque: String, _ siguiente: String, _ codigo: Int32) -> Never {
	FileHandle.standardError.write("No pude \(que): \(porque). Siguiente paso: \(siguiente).\n".data(using: .utf8)!)
	exit(codigo)
}

func aviso(_ texto: String) {
	FileHandle.standardError.write("ocr: \(texto)\n".data(using: .utf8)!)
}

// MARK: - Opciones

struct Opciones {
	var ancho = 0
	var alto = 0
	var fps = 0.0
	var t0 = 0.0
	var modo = "accurate"
	var minAlto: Float? = nil
	var idiomas = ["es-MX", "es-ES"]
	var palabras = ["Claude", "ChatGPT", "Gemini", "Codex", "Apify"]
	var correccion = false
	var cpu = false
	var hilos = 2
	var palabrasCajas = false
	var diagnostico = false
}

func leerOpciones() -> Opciones {
	var o = Opciones()
	var args = Array(CommandLine.arguments.dropFirst())
	func valor(_ nombre: String) -> String {
		guard !args.isEmpty else {
			salirConFallo("leer los argumentos", "a \(nombre) le falta su valor", "revisa el comando (ej. --ancho 1440)", 2)
		}
		return args.removeFirst()
	}
	func numero(_ nombre: String, _ texto: String) -> Double {
		guard let n = Double(texto), n.isFinite else {
			salirConFallo("leer los argumentos", "\(nombre) no es un número (\(texto))", "revisa el comando", 2)
		}
		return n
	}
	while !args.isEmpty {
		let a = args.removeFirst()
		switch a {
		case "--ancho": o.ancho = Int(numero(a, valor(a)))
		case "--alto": o.alto = Int(numero(a, valor(a)))
		case "--fps": o.fps = numero(a, valor(a))
		case "--t0": o.t0 = numero(a, valor(a))
		case "--modo": o.modo = valor(a)
		case "--min-alto": o.minAlto = Float(numero(a, valor(a)))
		case "--idiomas": o.idiomas = valor(a).split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
		case "--palabras": o.palabras = valor(a).split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
		case "--correccion": o.correccion = true
		case "--cpu": o.cpu = true
		case "--hilos": o.hilos = max(1, Int(numero(a, valor(a))))
		case "--palabras-cajas": o.palabrasCajas = true
		case "--diagnostico": o.diagnostico = true
		case "--ayuda", "-h", "--help":
			print("Uso: ffmpeg … -f rawvideo -pix_fmt rgba - | ocr --ancho N --alto N --fps F [--modo fast|accurate] [--min-alto F] [--cpu] [--hilos N] [--palabras-cajas]")
			exit(0)
		default:
			salirConFallo("leer los argumentos", "no conozco la opción \(a)", "usa --ayuda para ver las opciones", 2)
		}
	}
	if o.diagnostico { return o }
	if o.ancho <= 0 || o.alto <= 0 {
		salirConFallo("leer los argumentos", "faltan --ancho y --alto (en píxeles, mayores que 0)", "pásalos igual que en el -vf de ffmpeg", 2)
	}
	if !(o.fps > 0) {
		salirConFallo("leer los argumentos", "falta --fps (mayor que 0)", "pasa los fps con los que ffmpeg entrega los cuadros", 2)
	}
	if o.modo != "fast" && o.modo != "accurate" {
		salirConFallo("leer los argumentos", "--modo debe ser fast o accurate (llegó \(o.modo))", "usa --modo fast o --modo accurate", 2)
	}
	if let m = o.minAlto, !(m >= 0 && m <= 1) {
		salirConFallo("leer los argumentos", "--min-alto debe estar entre 0 y 1 (llegó \(m))", "pásalo como fracción del alto del cuadro, ej. 0.02", 2)
	}
	return o
}

// MARK: - Solicitud de Vision

func armarSolicitud(_ o: Opciones) -> RecognizeTextRequest {
	var s = RecognizeTextRequest()
	s.recognitionLevel = o.modo == "fast" ? .fast : .accurate
	s.usesLanguageCorrection = o.correccion
	s.automaticallyDetectsLanguage = false
	s.customWords = o.palabras
	if let m = o.minAlto { s.minimumTextHeightFraction = m }

	let soportados = s.supportedRecognitionLanguages
	let pedidos = o.idiomas.map { Locale.Language(identifier: $0) }
	let pedidosId = Set(pedidos.map { $0.maximalIdentifier })
	var elegidos: [Locale.Language] = []
	for idioma in pedidos {
		if let exacto = soportados.first(where: { $0.maximalIdentifier == idioma.maximalIdentifier }) {
			if !elegidos.contains(exacto) { elegidos.append(exacto) }
		} else if let mismo = soportados.first(where: { $0.languageCode == idioma.languageCode }) {
			// es-MX no viene como tal: Vision lo cubre con su español (es-ES). Solo se avisa si es-ES no se pidió.
			if !elegidos.contains(mismo) { elegidos.append(mismo) }
			if !pedidosId.contains(mismo.maximalIdentifier) {
				aviso("\(idioma.maximalIdentifier) no está en la lista de Vision; uso \(mismo.maximalIdentifier) en su lugar")
			}
		} else {
			aviso("Vision no soporta \(idioma.maximalIdentifier) en modo \(o.modo); lo quito")
		}
	}
	if elegidos.isEmpty {
		salirConFallo("preparar el OCR", "ninguno de los idiomas pedidos (\(o.idiomas.joined(separator: ","))) está disponible", "usa --idiomas es-ES o en-US", 2)
	}
	s.recognitionLanguages = elegidos

	if o.cpu {
		for (etapa, dispositivos) in s.supportedComputeStageDevices {
			for d in dispositivos {
				if case .cpu = d { s.setComputeDevice(d, for: etapa) }
			}
		}
	}
	return s
}

// MARK: - JSON (a mano: rápido y sin depender del orden de claves de JSONEncoder)

func jsonTexto(_ s: String) -> String {
	var r = "\""
	for u in s.unicodeScalars {
		switch u {
		case "\"": r += "\\\""
		case "\\": r += "\\\\"
		case "\n": r += "\\n"
		case "\r": r += "\\r"
		case "\t": r += "\\t"
		default:
			if u.value < 0x20 {
				r += String(format: "\\u%04x", u.value)
			} else {
				r.unicodeScalars.append(u)
			}
		}
	}
	return r + "\""
}

func num(_ v: Double, _ decimales: Int = 5) -> String {
	guard v.isFinite else { return "null" }
	return String(format: "%.\(decimales)f", v)
}

/// Rectángulo de Vision (origen abajo-izquierda) → x,y,w,h con origen arriba-izquierda.
func cajaArriba(_ r: CGRect) -> String {
	let y = 1.0 - Double(r.origin.y) - Double(r.size.height)
	return "\"x\":\(num(Double(r.origin.x))),\"y\":\(num(y)),\"w\":\(num(Double(r.size.width))),\"h\":\(num(Double(r.size.height)))"
}

func lineaDeCuadro(_ i: Int, _ t: Double, _ observaciones: [RecognizedTextObservation], palabrasCajas: Bool) -> String {
	var cajas: [String] = []
	for obs in observaciones {
		guard let candidato = obs.topCandidates(1).first else { continue }
		let texto = candidato.string
		if texto.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
		var caja = "{\"texto\":\(jsonTexto(texto)),\"confianza\":\(num(Double(candidato.confidence), 4)),\(cajaArriba(obs.boundingBox.cgRect))"
		if palabrasCajas {
			var palabras: [String] = []
			var inicio: String.Index? = nil
			var idx = texto.startIndex
			func cerrar(_ fin: String.Index) {
				guard let ini = inicio else { return }
				let rango = ini..<fin
				if let rect = candidato.boundingBox(for: rango) {
					palabras.append("{\"texto\":\(jsonTexto(String(texto[rango]))),\(cajaArriba(rect.boundingBox.cgRect))}")
				}
				inicio = nil
			}
			while idx < texto.endIndex {
				if texto[idx].isWhitespace {
					cerrar(idx)
				} else if inicio == nil {
					inicio = idx
				}
				idx = texto.index(after: idx)
			}
			cerrar(texto.endIndex)
			caja += ",\"palabras\":[\(palabras.joined(separator: ","))]"
		}
		cajas.append(caja + "}")
	}
	return "{\"i\":\(i),\"t\":\(num(t, 6)),\"cajas\":[\(cajas.joined(separator: ","))]}"
}

// MARK: - Cuadros por stdin

/// Lee exactamente `n` bytes de stdin. nil = EOF limpio; si llega un cuadro a medias, sale con 2.
func leerCuadro(_ n: Int, indice: Int) -> Data? {
	var datos = Data(count: n)
	let leidos = datos.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) -> Int in
		var total = 0
		while total < n {
			let r = fread(p.baseAddress! + total, 1, n - total, stdin)
			if r == 0 { break }
			total += r
		}
		return total
	}
	if leidos == 0 { return nil }
	if leidos < n {
		salirConFallo(
			"leer el cuadro \(indice)",
			"llegaron \(leidos) de \(n) bytes (el tamaño no cuadra con --ancho/--alto o ffmpeg se cortó)",
			"revisa que --ancho/--alto sean los del -vf de ffmpeg y que use -pix_fmt rgba",
			2
		)
	}
	return datos
}

func imagenRGBA(_ datos: Data, ancho: Int, alto: Int) -> CGImage? {
	guard let proveedor = CGDataProvider(data: datos as CFData),
		let espacio = CGColorSpace(name: CGColorSpace.sRGB)
	else { return nil }
	return CGImage(
		width: ancho,
		height: alto,
		bitsPerComponent: 8,
		bitsPerPixel: 32,
		bytesPerRow: ancho * 4,
		space: espacio,
		bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
		provider: proveedor,
		decode: nil,
		shouldInterpolate: false,
		intent: .defaultIntent
	)
}

/// Varios cuadros en vuelo pueden fallar a la vez: solo el primero explica y sale; los demás esperan.
final class PrimerFallo: @unchecked Sendable {
	private let candado = NSLock()
	private var ocurrio = false
	func reclamar() -> Bool {
		candado.lock()
		defer { candado.unlock() }
		if ocurrio { return false }
		ocurrio = true
		return true
	}
}
let primerFallo = PrimerFallo()

func explicarFalloVision(_ error: Error, indice: Int) -> Never {
	if !primerFallo.reclamar() {
		while true { sleep(1) }
	}
	let texto = String(describing: error)
	if texto.contains("e5rt") || texto.contains("nilError") {
		salirConFallo(
			"leer el texto del cuadro \(indice) con Vision",
			"Vision no pudo cargar su modelo (\(texto.prefix(120))); pasa dentro del sandbox, que no deja usar el Neural Engine ni su caché de modelos",
			"corre la medición como comando excluido del sandbox (npx tsx pruebas/integracion/… o el comando de medición en excludedCommands)",
			1
		)
	}
	salirConFallo("leer el texto del cuadro \(indice) con Vision", texto, "revisa proyectos/_logs/fallos.log y avísame", 1)
}

// MARK: - Principal

@main
struct OCR {
	static func main() async {
		setvbuf(stdout, nil, _IOFBF, 1 << 16)
		let o = leerOpciones()
		let solicitud = armarSolicitud(o)

		if o.diagnostico {
			let idiomas = solicitud.supportedRecognitionLanguages.map { jsonTexto($0.maximalIdentifier) }.joined(separator: ",")
			let etapas = solicitud.supportedComputeStageDevices.map { (etapa, ds) in
				"\(jsonTexto(String(describing: etapa))):[\(ds.map { jsonTexto(String(describing: $0)) }.joined(separator: ","))]"
			}.joined(separator: ",")
			print("{\"modo\":\(jsonTexto(o.modo)),\"idiomas_soportados\":[\(idiomas)],\"dispositivos\":{\(etapas)}}")
			fflush(stdout)
			exit(0)
		}

		let bytesPorCuadro = o.ancho * o.alto * 4
		var siguiente = 0
		var listos: [Int: String] = [:]
		var leidos = 0

		func emitir() {
			while let linea = listos.removeValue(forKey: siguiente) {
				print(linea)
				siguiente += 1
			}
		}

		await withTaskGroup(of: (Int, String).self) { grupo in
			var enVuelo = 0
			while let datos = leerCuadro(bytesPorCuadro, indice: leidos) {
				let i = leidos
				leidos += 1
				guard let imagen = imagenRGBA(datos, ancho: o.ancho, alto: o.alto) else {
					salirConFallo("armar la imagen del cuadro \(i)", "CoreGraphics no aceptó los bytes", "revisa --ancho/--alto y -pix_fmt rgba", 2)
				}
				let t = o.t0 + Double(i) / o.fps
				let conPalabras = o.palabrasCajas
				grupo.addTask {
					do {
						let observaciones = try await solicitud.perform(on: imagen)
						return (i, lineaDeCuadro(i, t, observaciones, palabrasCajas: conPalabras))
					} catch {
						explicarFalloVision(error, indice: i)
					}
				}
				enVuelo += 1
				if enVuelo >= o.hilos, let (k, linea) = await grupo.next() {
					enVuelo -= 1
					listos[k] = linea
					emitir()
				}
			}
			for await (k, linea) in grupo {
				listos[k] = linea
				emitir()
			}
		}
		fflush(stdout)
	}
}
