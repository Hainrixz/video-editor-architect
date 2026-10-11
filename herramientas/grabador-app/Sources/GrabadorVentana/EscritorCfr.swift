// Escritor de MP4 H.264 a cuadros por segundo CONSTANTES a partir de cuadros que llegan a destiempo.
//
// Lo usa la grabación real (Grabador.swift, con los cuadros de ScreenCaptureKit) y la prueba sintética
// (--prueba-escritor, sin pantalla ni permisos): así lo que se prueba es exactamente lo que graba.
// - Cada ranura n del MP4 lleva el tiempo de presentación n/fps (escala de tiempo = fps): CFR exacto.
// - RelojCfr decide qué cuadro va en cada ranura; donde no llegó uno nuevo se repite el último.
// - Al cerrar, endSession(total/fps): el último cuadro dura 1/fps y el MP4 dura exactamente total/fps.
// - Sin pista de audio. H.264 High, sin reordenar cuadros (sin B-frames), un cuadro completo cada 15 (como la base
//   del editor: Remotion salta exacto), color BT.709.
// No es seguro entre hilos: úsalo desde una sola cola serie.

import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

final class EscritorCfr {
	let salida: String
	let ancho: Int
	let alto: Int
	let fps: Int
	private(set) var reloj: RelojCfr
	private(set) var falla: FalloGrabador?
	private(set) var cerrado = false
	private let escritor: AVAssetWriter
	private let entrada: AVAssetWriterInput
	private let adaptador: AVAssetWriterInputPixelBufferAdaptor
	private var ultimo: CVPixelBuffer?

	/// `tiempoReal`: true para la captura en vivo (el codificador no se queda atrás), false para la prueba sintética.
	init(salida: String, ancho: Int, alto: Int, fps: Int, segundos: Double, tiempoReal: Bool) throws {
		self.salida = salida
		self.ancho = ancho
		self.alto = alto
		self.fps = fps
		self.reloj = RelojCfr(fps: fps, segundos: segundos)
		let url = URL(fileURLWithPath: salida)
		if FileManager.default.fileExists(atPath: salida) {
			// Quien llama ya revisó que se pidió sobrescribir (validarPedido).
			try FileManager.default.removeItem(at: url)
		}
		do {
			escritor = try AVAssetWriter(outputURL: url, fileType: .mp4)
		} catch {
			throw FalloGrabador(codigo: 1, que: "preparar el MP4", porque: "AVAssetWriter no pudo crear \(salida)", siguiente: "revisa que la carpeta se pueda escribir")
		}
		let bitrate = min(80_000_000, max(6_000_000, Int(Double(ancho * alto * fps) * 0.25)))
		let ajustes: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: ancho,
			AVVideoHeightKey: alto,
			AVVideoColorPropertiesKey: [
				AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
				AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
				AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
			],
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: bitrate,
				AVVideoExpectedSourceFrameRateKey: fps,
				AVVideoMaxKeyFrameIntervalKey: 15,
				AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
				AVVideoAllowFrameReorderingKey: false,
			],
		]
		entrada = AVAssetWriterInput(mediaType: .video, outputSettings: ajustes)
		entrada.expectsMediaDataInRealTime = tiempoReal
		// Escala de tiempo = fps: cada ranura es exactamente 1 unidad (sin redondeos de 1/600).
		entrada.mediaTimeScale = CMTimeScale(fps)
		adaptador = AVAssetWriterInputPixelBufferAdaptor(
			assetWriterInput: entrada,
			sourcePixelBufferAttributes: [
				kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
				kCVPixelBufferWidthKey as String: ancho,
				kCVPixelBufferHeightKey as String: alto,
			])
		guard escritor.canAdd(entrada) else {
			throw FalloGrabador(codigo: 1, que: "preparar el MP4", porque: "AVAssetWriter no aceptó la pista de video \(ancho)×\(alto)", siguiente: "avísame con el log")
		}
		escritor.add(entrada)
		escritor.movieTimeScale = CMTimeScale(fps * 100)
		guard escritor.startWriting() else {
			let codigo = (escritor.error as NSError?)?.code ?? 0
			try? FileManager.default.removeItem(at: url)
			if codigo == -11834 {
				// AVErrorEncoderNotFound: el codificador de la Mac no está al alcance (p. ej. dentro del sandbox de Claude Code).
				throw FalloGrabador(
					codigo: 3, que: "preparar el MP4", porque: "el codificador H.264 de la Mac no está disponible (error -11834)",
					siguiente: "córrelo fuera del sandbox (con open o como comando excluido)")
			}
			throw FalloGrabador(codigo: 1, que: "preparar el MP4", porque: "AVAssetWriter no arrancó (error \(codigo))", siguiente: "revisa que la carpeta de salida se pueda escribir")
		}
		escritor.startSession(atSourceTime: .zero)
	}

	/// Llega un cuadro nuevo con tiempo de presentación t (s).
	func llega(_ pixel: CVPixelBuffer, en t: Double) {
		guard falla == nil, !cerrado else { return }
		for e in reloj.llega(t) {
			switch e {
			case .repetir(let n):
				if let u = ultimo { escribir(u, n) }
			case .nuevo(let n):
				escribir(pixel, n)
			}
		}
		ultimo = pixel
	}

	/// El tiempo avanza sin cuadro nuevo: rellena con el último.
	func avanza(_ t: Double) {
		guard falla == nil, !cerrado, let u = ultimo else { return }
		for e in reloj.avanza(t) { escribir(u, e.ranura) }
	}

	private func escribir(_ pixel: CVPixelBuffer, _ ranura: Int) {
		guard falla == nil else { return }
		var esperas = 0
		while !entrada.isReadyForMoreMediaData && esperas < 400 {
			usleep(5000)
			esperas += 1
		}
		guard entrada.isReadyForMoreMediaData else {
			falla = FalloGrabador(codigo: 1, que: "escribir el MP4", porque: "el codificador no aceptó más cuadros en 2 s", siguiente: "vuelve a intentarlo con una ventana más chica")
			return
		}
		if !adaptador.append(pixel, withPresentationTime: CMTime(value: CMTimeValue(ranura), timescale: CMTimeScale(fps))) {
			let codigo = (escritor.error as NSError?)?.code ?? 0
			falla = FalloGrabador(codigo: 1, que: "escribir el MP4", porque: "AVAssetWriter no aceptó el cuadro \(ranura) (error \(codigo))", siguiente: "vuelve a intentarlo; si se repite, avísame con el log")
		}
	}

	/// Completa las ranuras con el último cuadro y cierra el archivo. `listo` recibe el error, si hubo.
	func cerrar(_ listo: @escaping (FalloGrabador?) -> Void) {
		guard !cerrado else { return }
		cerrado = true
		if falla == nil, let u = ultimo {
			for e in reloj.cierra() { escribir(u, e.ranura) }
		}
		if falla == nil && !reloj.hayCuadro {
			falla = FalloGrabador(codigo: 2, que: "grabar la ventana", porque: "no llegó ningún cuadro", siguiente: "deja la ventana visible y vuelve a intentarlo")
		}
		if let f = falla {
			cancelar()
			listo(f)
			return
		}
		entrada.markAsFinished()
		escritor.endSession(atSourceTime: CMTime(value: CMTimeValue(reloj.total), timescale: CMTimeScale(fps)))
		let w = escritor
		w.finishWriting {
			if w.status == .completed {
				listo(nil)
			} else {
				let codigo = (w.error as NSError?)?.code ?? 0
				listo(FalloGrabador(codigo: 1, que: "cerrar el MP4", porque: "AVAssetWriter terminó con error \(codigo)", siguiente: "vuelve a intentarlo"))
			}
		}
	}

	/// Cancela y borra el MP4 a medias (es de esta corrida).
	func cancelar() {
		cerrado = true
		if escritor.status == .writing { escritor.cancelWriting() }
		try? FileManager.default.removeItem(atPath: salida)
	}
}

// ───────────────────────────── prueba sintética (--prueba-escritor) ─────────────────────────────

/// Gris del cuadro fuente k (el que se lee de vuelta en el MP4 para saber qué cuadro quedó en cada ranura).
func grisDePrueba(_ k: Int) -> UInt8 { UInt8(min(250, 10 + 6 * k)) }

/// Tiempos de llegada de la prueba: ~24 fps con temblor de ±4 ms, un hueco de 0.8 a 1.3 s y uno al final.
func llegadasDePrueba() -> [Double] {
	var t: [Double] = []
	var k = 0
	var semilla: UInt64 = 2026
	while true {
		let base = Double(k) / 24
		if base >= 1.75 { break }
		k += 1
		if base > 0.8 && base < 1.3 { continue }
		semilla = semilla &* 6364136223846793005 &+ 1442695040888963407
		let temblor = (Double(semilla >> 11) / Double(1 << 53) - 0.5) * 0.008
		t.append(500 + base + temblor)
	}
	return t
}

/// Escribe un MP4 de 2 s a 30 fps (640×360) con cuadros grises que llegan a destiempo y deja junto a él
/// <ruta>.esperado.json con el cuadro fuente que debe quedar en cada ranura (según RelojCfr).
func correrPruebaEscritor(ruta: String) -> Int32 {
	let llegadas = llegadasDePrueba()
	let escritor: EscritorCfr
	do {
		escritor = try EscritorCfr(salida: ruta, ancho: 640, alto: 360, fps: 30, segundos: 2, tiempoReal: false)
	} catch let f as FalloGrabador {
		avisar(f.mensaje)
		return f.codigo
	} catch {
		return 1
	}
	var fuente = [Int](repeating: -1, count: escritor.reloj.total)
	var simulado = RelojCfr(fps: 30, segundos: 2)
	var ultimo = -1
	for (k, t) in llegadas.enumerated() {
		var pixel: CVPixelBuffer?
		let atributos = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
		CVPixelBufferCreate(kCFAllocatorDefault, 640, 360, kCVPixelFormatType_32BGRA, atributos, &pixel)
		guard let p = pixel else { return 1 }
		CVPixelBufferLockBaseAddress(p, [])
		if let base = CVPixelBufferGetBaseAddress(p) {
			let g = grisDePrueba(k)
			let bytes = CVPixelBufferGetBytesPerRow(p) * 360
			memset(base, Int32(g), bytes)
			// Alfa opaco en cada pixel (BGRA).
			let puntero = base.assumingMemoryBound(to: UInt8.self)
			for i in stride(from: 3, to: bytes, by: 4) { puntero[i] = 255 }
		}
		CVPixelBufferUnlockBaseAddress(p, [])
		// Lo que el reloj debe decidir (para comparar en la integración).
		for e in simulado.llega(t) {
			switch e {
			case .repetir(let n): fuente[n] = ultimo
			case .nuevo(let n): fuente[n] = k
			}
		}
		ultimo = k
		escritor.llega(p, en: t)
	}
	for e in simulado.cierra() { fuente[e.ranura] = ultimo }
	let fin = DispatchSemaphore(value: 0)
	var resultado: FalloGrabador?
	escritor.cerrar { f in
		resultado = f
		fin.signal()
	}
	fin.wait()
	if let f = resultado {
		avisar(f.mensaje)
		return f.codigo
	}
	let esperado: [String: Any] = [
		"cuadros": escritor.reloj.total, "fps": 30, "ancho": 640, "alto": 360,
		"fuente_por_ranura": fuente, "gris_por_fuente": (0..<llegadas.count).map { Int(grisDePrueba($0)) },
		"nuevos": escritor.reloj.nuevos, "repetidos": escritor.reloj.repetidos,
	]
	do { try escribirJson(esperado, en: ruta + ".esperado.json") } catch { return 1 }
	print("Listo: \(ruta) — \(escritor.reloj.total) cuadros (\(escritor.reloj.nuevos) nuevos, \(escritor.reloj.repetidos) repetidos)")
	return 0
}
