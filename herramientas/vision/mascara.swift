// Máscara de persona por cuadro con Apple Vision (VNGeneratePersonSegmentationRequest, calidad accurate).
// Sirve para el estilo "texto vivo": los titulares van DETRÁS de ti y tu silueta se dibuja encima.
//
// Uso (los cuadros llegan por stdin desde ffmpeg y salen por stdout hacia otro ffmpeg, sin archivos intermedios):
//   ffmpeg -v error -i base.mp4 -vf scale=720:1280 -f rawvideo -pix_fmt rgba - \
//     | herramientas/bin/mascara --ancho 720 --alto 1280 [--calidad accurate|balanced] \
//     | ffmpeg -f rawvideo -pix_fmt gray -s 720x1280 -r 30 -i - …
//
// Entrada: cuadros RGBA de ancho×alto×4 bytes. Salida: un cuadro gris (1 byte por pixel, 255 = persona) del MISMO
// ancho×alto por cada cuadro de entrada, en el mismo orden. Si Vision no encuentra a nadie, sale el cuadro en negro.
// Vision no funciona dentro del sandbox: lo corre `npx tsx herramientas/cara.ts <slug> --mascara` (excludedCommands).
import CoreGraphics
import CoreImage
import Foundation
import Vision

func salirConFallo(_ que: String, _ porque: String, _ siguiente: String, _ codigo: Int32) -> Never {
	FileHandle.standardError.write("No pude \(que): \(porque). Siguiente paso: \(siguiente).\n".data(using: .utf8)!)
	exit(codigo)
}

struct Opciones {
	var ancho = 0
	var alto = 0
	var calidad = VNGeneratePersonSegmentationRequest.QualityLevel.accurate
}

func leerOpciones() -> Opciones {
	var o = Opciones()
	var args = CommandLine.arguments.dropFirst().makeIterator()
	while let a = args.next() {
		switch a {
		case "--ancho": o.ancho = Int(args.next() ?? "") ?? 0
		case "--alto": o.alto = Int(args.next() ?? "") ?? 0
		case "--calidad":
			switch args.next() ?? "" {
			case "balanced": o.calidad = .balanced
			case "fast": o.calidad = .fast
			default: o.calidad = .accurate
			}
		default:
			salirConFallo("leer las opciones", "no conozco \(a)", "uso: mascara --ancho N --alto N [--calidad accurate|balanced|fast]", 2)
		}
	}
	if o.ancho <= 0 || o.alto <= 0 { salirConFallo("leer las opciones", "faltan --ancho y --alto", "pásalos con el tamaño de los cuadros", 2) }
	return o
}

func leerCuadro(_ n: Int) -> Data? {
	var datos = Data(capacity: n)
	while datos.count < n {
		let parte = FileHandle.standardInput.readData(ofLength: n - datos.count)
		if parte.isEmpty { return datos.isEmpty ? nil : nil }
		datos.append(parte)
	}
	return datos
}

@main
struct Mascara {
	static func main() {
		let o = leerOpciones()
		let bytes = o.ancho * o.alto * 4
		let contexto = CIContext(options: [.useSoftwareRenderer: false])
		let gris = CGColorSpaceCreateDeviceGray()
		let salida = FileHandle.standardOutput
		var i = 0
		while let datos = leerCuadro(bytes) {
			guard let proveedor = CGDataProvider(data: datos as CFData),
				let imagen = CGImage(width: o.ancho, height: o.alto, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: o.ancho * 4,
					space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
					provider: proveedor, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
			else { salirConFallo("armar el cuadro \(i)", "CoreGraphics no aceptó los bytes", "revisa --ancho/--alto y -pix_fmt rgba", 2) }
			let s = VNGeneratePersonSegmentationRequest()
			s.qualityLevel = o.calidad
			s.outputPixelFormat = kCVPixelFormatType_OneComponent8
			do {
				try VNImageRequestHandler(cgImage: imagen, orientation: .up, options: [:]).perform([s])
			} catch {
				salirConFallo("separar a la persona en el cuadro \(i) con Vision", String(describing: error).prefix(160).description,
					"corre npx tsx herramientas/cara.ts <slug> --mascara solo en su Bash (fuera del sandbox)", 1)
			}
			var cuadro = Data(count: o.ancho * o.alto)
			if let buffer = s.results?.first?.pixelBuffer {
				// La máscara sale más chica que el cuadro: se escala con Core Image (bilineal, bordes suaves).
				let ci = CIImage(cvPixelBuffer: buffer)
				let escalada = ci.transformed(by: CGAffineTransform(scaleX: CGFloat(o.ancho) / ci.extent.width, y: CGFloat(o.alto) / ci.extent.height))
				cuadro.withUnsafeMutableBytes { p in
					contexto.render(escalada, toBitmap: p.baseAddress!, rowBytes: o.ancho, bounds: CGRect(x: 0, y: 0, width: o.ancho, height: o.alto),
						format: .L8, colorSpace: gris)
				}
			}
			salida.write(cuadro)
			i += 1
		}
	}
}
