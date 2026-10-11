// Grabación de UNA ventana con ScreenCaptureKit (macOS 15+) a un MP4 H.264 de cuadros por segundo constantes, sin audio.
//
// - Filtro de ventana suelta (SCContentFilter(desktopIndependentWindow:)): solo sale esa ventana, aunque otra la tape.
// - Tamaño = ventana (puntos) × su escala (pointPixelScale), sin la sombra (ignoreShadowsSingleWindow).
// - ScreenCaptureKit manda cuadros solo cuando algo cambia; RelojCfr los acomoda en ranuras de 1/fps y repite el último
//   cuadro donde no llegó uno nuevo. El MP4 sale con exactamente round(segundos × fps) cuadros a fps/1.
// - Si falta el permiso de Grabación de pantalla (TCC), sale con código 3 y el mensaje de PORQUE_SIN_PERMISO.

import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// Lado máximo que acepta el codificador H.264 de la Mac.
let LADO_MAXIMO_H264 = 4096

func descripcionVentana(_ pedido: Pedido) -> String {
	switch (pedido.app, pedido.titulo) {
	case let (app?, titulo?): return "\"\(app)\" con \"\(titulo)\" en el título"
	case let (app?, nil): return "\"\(app)\""
	case let (nil, titulo?): return "con \"\(titulo)\" en el título"
	default: return "(sin criterio)"
	}
}

/// Traduce un error de ScreenCaptureKit al formato de la casa (código 3: servicio externo o permiso).
func traducirError(_ error: Error) -> FalloGrabador {
	if let f = error as? FalloGrabador { return f }
	let ns = error as NSError
	if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.Code.userDeclined.rawValue { return falloSinPermiso() }
	return FalloGrabador(
		codigo: 3, que: "grabar la ventana", porque: "ScreenCaptureKit respondió con un error (\(ns.domain) \(ns.code))",
		siguiente: "vuelve a intentarlo; si se repite, revisa el permiso de Grabación de pantalla de GrabadorVentana")
}

/// Elige la ventana del pedido: capa normal, visible, del tamaño de una ventana de verdad; si hay varias, la de más al frente.
func buscarVentana(_ contenido: SCShareableContent, pedido: Pedido) throws -> SCWindow {
	let normal = { (s: String) in s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "es")) }
	let candidatas = contenido.windows.filter { w in
		guard w.windowLayer == 0, w.isOnScreen, w.frame.width >= 80, w.frame.height >= 50 else { return false }
		if let app = pedido.app {
			let nombre = w.owningApplication?.applicationName ?? ""
			let bundle = w.owningApplication?.bundleIdentifier ?? ""
			if normal(nombre) != normal(app) && normal(bundle) != normal(app) { return false }
		}
		if let titulo = pedido.titulo {
			guard let t = w.title, normal(t).contains(normal(titulo)) else { return false }
		}
		return true
	}
	if candidatas.isEmpty {
		// Solo nombres de apps (no títulos: pueden traer datos personales).
		let apps = Set(contenido.windows.filter { $0.windowLayer == 0 && $0.isOnScreen }.compactMap { $0.owningApplication?.applicationName })
			.sorted()
		throw FalloGrabador(
			codigo: 2, que: "grabar la ventana",
			porque: "no encontré una ventana visible \(descripcionVentana(pedido)) (apps con ventanas visibles: \(apps.prefix(12).joined(separator: ", ")))",
			siguiente: "abre esa ventana (que no esté minimizada) o corrige \"app\" o \"titulo\" en el pedido")
	}
	// CGWindowList devuelve las ventanas de adelante hacia atrás.
	let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	let orden = info.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
	let posicion = { (w: SCWindow) in orden.firstIndex(of: Int(w.windowID)) ?? Int.max }
	return candidatas.min { posicion($0) < posicion($1) }!
}

/// Graba según el pedido. Devuelve el resumen para el JSON de resultado.
func grabar(_ pedido: Pedido) async throws -> [String: Any] {
	// 1. Permiso de Grabación de pantalla (lo tiene la app, no la terminal: por eso se abre con `open -a`).
	if !CGPreflightScreenCaptureAccess() {
		if pedido.pedirPermiso { _ = CGRequestScreenCaptureAccess() }
		throw falloSinPermiso()
	}
	// 2. La ventana.
	let contenido: SCShareableContent
	do {
		contenido = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
	} catch {
		throw traducirError(error)
	}
	let ventana = try buscarVentana(contenido, pedido: pedido)
	let filtro = SCContentFilter(desktopIndependentWindow: ventana)
	var marco = filtro.contentRect
	var escala = Double(filtro.pointPixelScale)
	if marco.width < 1 || marco.height < 1 || escala <= 0 {
		// Respaldo: el marco de la ventana y la escala de la pantalla donde está.
		marco = ventana.frame
		escala = Double(NSScreen.screens.first { $0.frame.intersects(ventana.frame) }?.backingScaleFactor ?? 2)
	}
	let tam = tamanoVideo(ancho: Double(marco.width), alto: Double(marco.height), escala: escala)
	if tam.w > LADO_MAXIMO_H264 || tam.h > LADO_MAXIMO_H264 {
		throw FalloGrabador(
			codigo: 2, que: "grabar la ventana", porque: "la ventana mide \(tam.exactoW)×\(tam.exactoH) px y H.264 acepta hasta \(LADO_MAXIMO_H264) por lado",
			siguiente: "achica la ventana y vuelve a intentarlo")
	}
	let app = ventana.owningApplication
	FileHandle.standardError.write(
		Data("GrabadorVentana: \(app?.applicationName ?? "?") — \(Int(marco.width))×\(Int(marco.height)) pt × \(escala) → \(tam.w)×\(tam.h) px a \(pedido.fps) fps, \(pedido.segundos) s\n".utf8))

	// 3. Captura y escritura.
	let grabacion = Grabacion(pedido: pedido, ancho: tam.w, alto: tam.h)
	try await grabacion.correr(filtro: filtro)

	return [
		"ventana": [
			"id": Int(ventana.windowID), "app": app?.applicationName ?? "", "bundle": app?.bundleIdentifier ?? "", "titulo": ventana.title ?? "",
			"x": Double(marco.origin.x), "y": Double(marco.origin.y), "w": Double(marco.width), "h": Double(marco.height),
		],
		"escala": escala,
		"ventana_px": ["w": tam.exactoW, "h": tam.exactoH],
		"video": [
			"w": tam.w, "h": tam.h, "fps": pedido.fps, "cuadros": grabacion.reloj.total, "segundos": Double(grabacion.reloj.total) / Double(pedido.fps),
			"codec": "h264", "audio": false,
		],
		"cuadros": [
			"nuevos": grabacion.reloj.nuevos, "repetidos": grabacion.reloj.repetidos, "descartados": grabacion.reloj.descartados,
			"capturados": grabacion.capturados,
		],
		"salida": pedido.salida,
	]
}

/// Todo su estado mutable se toca solo en `cola` (una cola serie: cuadros de ScreenCaptureKit y temporizador), por eso
/// es seguro pasarla entre hilos aunque Swift no lo pueda comprobar solo.
final class Grabacion: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
	let pedido: Pedido
	let ancho: Int
	let alto: Int
	private let cola = DispatchQueue(label: "local.claude-editor.grabador-ventana.cuadros")
	private var escritor: EscritorCfr?
	private(set) var capturados = 0
	private var stream: SCStream?
	private var temporizador: DispatchSourceTimer?
	private var arranque = 0.0
	/// Tiempo de presentación del primer cuadro menos el reloj del sistema al recibirlo: el temporizador mide en el
	/// mismo reloj que los cuadros aunque ScreenCaptureKit use otra base de tiempo.
	private var desfase: Double?
	private var cerrando = false
	private var continuacion: CheckedContinuation<Void, Error>?

	init(pedido: Pedido, ancho: Int, alto: Int) {
		self.pedido = pedido
		self.ancho = ancho
		self.alto = alto
	}

	/// Lo que decidió el reloj (para el resultado).
	var reloj: RelojCfr { escritor?.reloj ?? RelojCfr(fps: pedido.fps, segundos: pedido.segundos) }

	/// Reloj del sistema (el mismo de los tiempos de presentación de ScreenCaptureKit).
	static func ahora() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

	func correr(filtro: SCContentFilter) async throws {
		let e = try EscritorCfr(salida: pedido.salida, ancho: ancho, alto: alto, fps: pedido.fps, segundos: pedido.segundos, tiempoReal: true)
		escritor = e
		let cfg = SCStreamConfiguration()
		cfg.width = ancho
		cfg.height = alto
		cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(pedido.fps))
		cfg.pixelFormat = kCVPixelFormatType_32BGRA
		cfg.colorSpaceName = CGColorSpace.sRGB
		cfg.showsCursor = pedido.cursor
		cfg.capturesAudio = false
		cfg.queueDepth = 8
		cfg.scalesToFit = true
		cfg.ignoreShadowsSingleWindow = true
		cfg.captureResolution = .best
		let s = SCStream(filter: filtro, configuration: cfg, delegate: self)
		do {
			try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: cola)
			stream = s
			try await s.startCapture()
		} catch {
			e.cancelar()
			throw traducirError(error)
		}
		try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
			cola.async {
				self.continuacion = c
				self.arrancar()
			}
		}
	}

	/// En la cola: arranca el temporizador que rellena ranuras y decide cuándo terminar.
	private func arrancar() {
		arranque = Grabacion.ahora()
		let tiempo = DispatchSource.makeTimerSource(queue: cola)
		tiempo.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
		tiempo.setEventHandler { [weak self] in self?.tic() }
		temporizador = tiempo
		tiempo.resume()
	}

	private func tic() {
		guard !cerrando, let escritor else { return }
		if let f = escritor.falla { return fallar(f) }
		let t = Grabacion.ahora()
		if !escritor.reloj.hayCuadro {
			if t - arranque > 5 {
				fallar(
					FalloGrabador(
						codigo: 2, que: "grabar la ventana", porque: "ScreenCaptureKit no mandó ningún cuadro en 5 s (¿la ventana está minimizada o en otro escritorio?)",
						siguiente: "deja la ventana visible y vuelve a intentarlo"))
			}
			return
		}
		let tCuadros = t + (desfase ?? 0)
		escritor.avanza(tCuadros)
		// 0.1 s de más para que llegue un cuadro atrasado de la última ranura.
		if escritor.reloj.termino(tCuadros - 0.1) { cerrar() }
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen, !cerrando, sampleBuffer.isValid, let escritor else { return }
		guard
			let adjuntos = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
			let crudo = adjuntos.first?[.status] as? Int,
			let estado = SCFrameStatus(rawValue: crudo),
			estado == .complete || estado == .started,
			let pixel = sampleBuffer.imageBuffer
		else { return }
		capturados += 1
		let pts = sampleBuffer.presentationTimeStamp.seconds
		if desfase == nil { desfase = pts - Grabacion.ahora() }
		escritor.llega(pixel, en: pts)
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		cola.async {
			guard !self.cerrando else { return }
			let ns = error as NSError
			self.fallar(
				FalloGrabador(
					codigo: 2, que: "grabar la ventana", porque: "la captura se detuvo antes de tiempo (¿se cerró la ventana? \(ns.domain) \(ns.code))",
					siguiente: "deja la ventana abierta durante toda la grabación y vuelve a intentarlo"))
		}
	}

	private func detenerCaptura() {
		temporizador?.cancel()
		temporizador = nil
		let s = stream
		Task { try? await s?.stopCapture() }
	}

	/// En la cola: completa las ranuras, cierra el MP4 y avisa.
	private func cerrar() {
		guard !cerrando, let escritor else { return }
		cerrando = true
		detenerCaptura()
		escritor.cerrar { [self] f in
			cola.async {
				if let f { self.continuacion?.resume(throwing: f) } else { self.continuacion?.resume() }
				self.continuacion = nil
			}
		}
	}

	/// En la cola: detiene todo, borra el MP4 a medias (es de esta corrida) y avisa el error.
	private func fallar(_ f: FalloGrabador) {
		guard !cerrando else { return }
		cerrando = true
		detenerCaptura()
		escritor?.cancelar()
		continuacion?.resume(throwing: f)
		continuacion = nil
	}
}
