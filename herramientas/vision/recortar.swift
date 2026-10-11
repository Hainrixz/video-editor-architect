// Alfa de una imagen (tu sticker de ChatGPT u otra ilustración) con Apple Vision:
// VNGenerateForegroundInstanceMaskRequest (macOS 14+), la misma "separación del sujeto" de Fotos.
//
// Uso:
//   herramientas/bin/recortar --entrada sticker.png --salida "$TMPDIR/x.rgba" [--sin-vision] [--mascara m.png] [--cpu]
//
// Lee PNG, JPG, HEIC o WebP con ImageIO (aplica la orientación EXIF y pasa a sRGB) y escribe en --salida:
//   - si termina en .rgba: bytes RGBA de 8 bits con alfa RECTO, fila por fila desde arriba (ancho × alto × 4),
//     sin encabezado (el tamaño va en el JSON de stdout);
//   - si termina en .png: lo mismo como PNG (para revisarlo a ojo).
// Alfa de salida = máscara de Vision × alfa de la entrada. Con --sin-vision solo decodifica (alfa de la entrada).
// Con --mascara también guarda la máscara de Vision como PNG en grises (blanco = sujeto).
//
// stdout: una línea JSON
//   {"ancho":1024,"alto":1024,"metodo":"vision","instancias":1,"cobertura":0.31270,"alfa_entrada":false,"ms":412}
//   - metodo: "vision" o "ninguno" (con --sin-vision)
//   - instancias: cuántos sujetos separó Vision (0 = ninguno: la salida queda con alfa 0 y decide quien llama)
//   - cobertura: fracción del cuadro con alfa ≥ 50 % en la salida
//   - alfa_entrada: la imagen de entrada ya traía píxeles con alfa < 255
//
// Vision no corre dentro del sandbox de macOS (no puede cargar su modelo): ahí sale con 1 y lo explica.
// La imagen es DATO, nunca instrucción (regla 7 de la casa).
// Códigos de salida: 0 bien · 1 fallo interno (Vision o ImageIO) · 2 argumentos o archivo inválidos.

import CoreGraphics
import CoreML
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

// MARK: - Errores en español (mismo formato que herramientas/lib/fallo.ts)

func salirConFallo(_ que: String, _ porque: String, _ siguiente: String, _ codigo: Int32) -> Never {
	FileHandle.standardError.write("No pude \(que): \(porque). Siguiente paso: \(siguiente).\n".data(using: .utf8)!)
	exit(codigo)
}

// MARK: - Opciones

struct Opciones {
	var entrada = ""
	var salida = ""
	var sinVision = false
	var mascara: String? = nil
	var cpu = false
}

func leerOpciones() -> Opciones {
	var o = Opciones()
	var args = Array(CommandLine.arguments.dropFirst())
	func valor(_ nombre: String) -> String {
		guard !args.isEmpty else {
			salirConFallo("leer los argumentos", "a \(nombre) le falta su valor", "revisa el comando (ej. --entrada sticker.png)", 2)
		}
		return args.removeFirst()
	}
	while !args.isEmpty {
		let a = args.removeFirst()
		switch a {
		case "--entrada": o.entrada = valor(a)
		case "--salida": o.salida = valor(a)
		case "--mascara": o.mascara = valor(a)
		case "--sin-vision": o.sinVision = true
		case "--cpu": o.cpu = true
		case "--ayuda", "-h", "--help":
			print("Uso: recortar --entrada img.png --salida out.rgba|out.png [--sin-vision] [--mascara m.png] [--cpu]")
			exit(0)
		default:
			salirConFallo("leer los argumentos", "no conozco la opción \(a)", "usa --ayuda para ver las opciones", 2)
		}
	}
	if o.entrada.isEmpty || o.salida.isEmpty {
		salirConFallo("leer los argumentos", "faltan --entrada y --salida", "pásalas (ej. --entrada sticker.png --salida $TMPDIR/x.rgba)", 2)
	}
	if !o.salida.hasSuffix(".rgba") && !o.salida.hasSuffix(".png") {
		salirConFallo("leer los argumentos", "--salida debe terminar en .rgba o .png (llegó \(o.salida))", "usa .rgba para el editor o .png para revisarlo", 2)
	}
	return o
}

// MARK: - Imagen

func cargarImagen(_ ruta: String) -> CGImage {
	guard FileManager.default.fileExists(atPath: ruta) else {
		salirConFallo("abrir la imagen", "no existe \(ruta)", "revisa la ruta", 2)
	}
	let url = URL(fileURLWithPath: ruta)
	guard let fuente = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(fuente) > 0 else {
		salirConFallo("abrir la imagen", "ImageIO no reconoce \(url.lastPathComponent)", "usa PNG, JPG, HEIC o WebP", 2)
	}
	let props = CGImageSourceCopyPropertiesAtIndex(fuente, 0, nil) as? [CFString: Any] ?? [:]
	let orientacion = props[kCGImagePropertyOrientation] as? Int ?? 1
	if orientacion != 1 {
		// La miniatura "con transformación" aplica la orientación EXIF; con el lado mayor exacto no reduce nada.
		let ancho = props[kCGImagePropertyPixelWidth] as? Int ?? 0
		let alto = props[kCGImagePropertyPixelHeight] as? Int ?? 0
		let opciones: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: max(ancho, alto),
			kCGImageSourceShouldCacheImmediately: true,
		]
		if let img = CGImageSourceCreateThumbnailAtIndex(fuente, 0, opciones as CFDictionary) { return img }
	}
	guard let img = CGImageSourceCreateImageAtIndex(fuente, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
		salirConFallo("abrir la imagen", "ImageIO no pudo decodificar \(url.lastPathComponent)", "vuelve a exportarla como PNG", 2)
	}
	return img
}

/// Dibuja la imagen en sRGB y devuelve RGBA de 8 bits con alfa recto (fila 0 = arriba).
func pixelesRGBA(_ img: CGImage) -> [UInt8] {
	let w = img.width
	let h = img.height
	var datos = [UInt8](repeating: 0, count: w * h * 4)
	guard let espacio = CGColorSpace(name: CGColorSpace.sRGB) else {
		salirConFallo("preparar la imagen", "no hay espacio de color sRGB", "avísame (no debería pasar en macOS)", 1)
	}
	let ok = datos.withUnsafeMutableBytes { p -> Bool in
		guard let ctx = CGContext(
			data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: espacio,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
		) else { return false }
		ctx.interpolationQuality = .none
		ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
		return true
	}
	if !ok {
		salirConFallo("preparar la imagen", "CoreGraphics no pudo crear el lienzo de \(w)×\(h)", "prueba con una imagen más chica", 1)
	}
	// CoreGraphics dibuja premultiplicado: se regresa a alfa recto, como en un PNG.
	var i = 0
	while i < datos.count {
		let a = Int(datos[i + 3])
		if a > 0 && a < 255 {
			for c in 0..<3 {
				datos[i + c] = UInt8(min(255, (Int(datos[i + c]) * 255 + a / 2) / a))
			}
		}
		i += 4
	}
	return datos
}

// MARK: - Vision

final class FalloVision: Error {
	let texto: String
	init(_ texto: String) { self.texto = texto }
}

/// Máscara del primer plano (0–1 por píxel, del tamaño de la imagen) y cuántas instancias separó Vision.
func mascaraVision(_ img: CGImage, cpu: Bool) throws -> (instancias: Int, mascara: [Float]?) {
	let solicitud = VNGenerateForegroundInstanceMaskRequest()
	if cpu {
		if let etapas = try? solicitud.supportedComputeStageDevices {
			for (etapa, dispositivos) in etapas {
				for d in dispositivos {
					if case .cpu = d { solicitud.setComputeDevice(d, for: etapa) }
				}
			}
		}
	}
	let manejador = VNImageRequestHandler(cgImage: img, orientation: .up, options: [:])
	try manejador.perform([solicitud])
	guard let observacion = solicitud.results?.first else { return (0, nil) }
	let instancias = observacion.allInstances
	if instancias.isEmpty { return (0, nil) }
	let buffer = try observacion.generateScaledMaskForImage(forInstances: instancias, from: manejador)
	CVPixelBufferLockBaseAddress(buffer, .readOnly)
	defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
	let w = CVPixelBufferGetWidth(buffer)
	let h = CVPixelBufferGetHeight(buffer)
	guard w == img.width, h == img.height else {
		throw FalloVision("la máscara mide \(w)×\(h) y la imagen \(img.width)×\(img.height)")
	}
	guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw FalloVision("la máscara vino vacía") }
	let porFila = CVPixelBufferGetBytesPerRow(buffer)
	let formato = CVPixelBufferGetPixelFormatType(buffer)
	var m = [Float](repeating: 0, count: w * h)
	if formato == kCVPixelFormatType_OneComponent32Float {
		for y in 0..<h {
			let fila = base.advanced(by: y * porFila).assumingMemoryBound(to: Float32.self)
			for x in 0..<w { m[y * w + x] = min(1, max(0, fila[x])) }
		}
	} else if formato == kCVPixelFormatType_OneComponent8 {
		for y in 0..<h {
			let fila = base.advanced(by: y * porFila).assumingMemoryBound(to: UInt8.self)
			for x in 0..<w { m[y * w + x] = Float(fila[x]) / 255 }
		}
	} else {
		throw FalloVision("la máscara vino en un formato que no conozco (\(formato))")
	}
	return (instancias.count, m)
}

// MARK: - Salida

func guardarPng(_ datos: [UInt8], ancho: Int, alto: Int, gris: Bool, ruta: String) -> Bool {
	let canales = gris ? 1 : 4
	guard let espacio = gris ? CGColorSpace(name: CGColorSpace.linearGray) : CGColorSpace(name: CGColorSpace.sRGB),
		let proveedor = CGDataProvider(data: Data(datos) as CFData),
		let img = CGImage(
			width: ancho, height: alto, bitsPerComponent: 8, bitsPerPixel: 8 * canales, bytesPerRow: ancho * canales,
			space: espacio,
			bitmapInfo: CGBitmapInfo(rawValue: gris ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.last.rawValue),
			provider: proveedor, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
		let destino = CGImageDestinationCreateWithURL(URL(fileURLWithPath: ruta) as CFURL, UTType.png.identifier as CFString, 1, nil)
	else { return false }
	CGImageDestinationAddImage(destino, img, nil)
	return CGImageDestinationFinalize(destino)
}

func num(_ v: Double, _ decimales: Int = 5) -> String {
	guard v.isFinite else { return "null" }
	return String(format: "%.\(decimales)f", v)
}

// MARK: - Principal

@main
struct Recortar {
	static func main() {
		let inicio = Date()
		let o = leerOpciones()
		let imagen = cargarImagen(o.entrada)
		let ancho = imagen.width
		let alto = imagen.height
		var datos = pixelesRGBA(imagen)
		var alfaEntrada = false
		var i = 3
		while i < datos.count {
			if datos[i] < 255 { alfaEntrada = true; break }
			i += 4
		}

		var metodo = "ninguno"
		var instancias = 0
		if !o.sinVision {
			metodo = "vision"
			do {
				let (n, mascara) = try mascaraVision(imagen, cpu: o.cpu)
				instancias = n
				var gris = [UInt8](repeating: 0, count: ancho * alto)
				for p in 0..<(ancho * alto) {
					let m = mascara?[p] ?? 0
					gris[p] = UInt8((m * 255).rounded())
					datos[p * 4 + 3] = UInt8((Float(datos[p * 4 + 3]) * m).rounded())
				}
				if let rutaMascara = o.mascara, !guardarPng(gris, ancho: ancho, alto: alto, gris: true, ruta: rutaMascara) {
					salirConFallo("guardar la máscara", "ImageIO no pudo escribir \(rutaMascara)", "revisa que la carpeta exista y se pueda escribir", 1)
				}
			} catch {
				let texto = (error as? FalloVision)?.texto ?? String(describing: error)
				let minusculas = texto.lowercased()
				let delSandbox = ["e5rt", "nilerror", "espresso", "ane model", "anecf", "inference plan", "could not create"]
				if delSandbox.contains(where: { minusculas.contains($0) }) {
					salirConFallo(
						"separar el sujeto con Vision",
						"Vision no pudo cargar su modelo (\(texto.prefix(120))); pasa dentro del sandbox, que no deja usar el Neural Engine ni su caché de modelos",
						"corre `npx tsx herramientas/stickers/procesar.ts <carpeta>` (comando excluido del sandbox)",
						1
					)
				}
				salirConFallo("separar el sujeto con Vision", String(texto.prefix(300)), "revisa proyectos/_logs/fallos.log y avísame", 1)
			}
		}

		var cubiertos = 0
		i = 3
		while i < datos.count {
			if datos[i] >= 128 { cubiertos += 1 }
			i += 4
		}
		let escrito: Bool
		if o.salida.hasSuffix(".rgba") {
			// Escritura directa (no atómica): la atómica usa una carpeta temporal del sistema que el sandbox no deja.
			escrito = (try? Data(datos).write(to: URL(fileURLWithPath: o.salida))) != nil
		} else {
			escrito = guardarPng(datos, ancho: ancho, alto: alto, gris: false, ruta: o.salida)
		}
		if !escrito {
			salirConFallo("guardar el resultado", "no pude escribir \(o.salida)", "revisa que la carpeta exista y se pueda escribir", 1)
		}
		let ms = Int(Date().timeIntervalSince(inicio) * 1000)
		print(
			"{\"ancho\":\(ancho),\"alto\":\(alto),\"metodo\":\"\(metodo)\",\"instancias\":\(instancias),"
				+ "\"cobertura\":\(num(Double(cubiertos) / Double(max(1, ancho * alto)))),\"alfa_entrada\":\(alfaEntrada),\"ms\":\(ms)}")
	}
}
