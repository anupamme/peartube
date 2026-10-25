import SwiftUI
import UIKit
import AVFoundation
import CoreImage.CIFilterBuiltins

struct ShareQR: View {
    let uri: String
    @Environment(\.dismiss) private var dismiss
    private var image: UIImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(uri.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage, let cg = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), from: output.extent.applying(CGAffineTransform(scaleX: 8, y: 8))) else { return nil }
        return UIImage(cgImage: cg)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Text("Share a little cinema.").font(.title2.bold())
                    if let image { Image(uiImage: image).interpolation(.none).resizable().scaledToFit().padding(18).background(.white).frame(maxWidth: 320).accessibilityLabel("PearTube sharing QR code").accessibilityIdentifier("share.qr") }
                    Text(uri).font(.footnote.monospaced()).textSelection(.enabled).accessibilityIdentifier("share.uri")
                    HStack {
                        Button("Copy Link", systemImage: "doc.on.doc") { UIPasteboard.general.string = uri }.accessibilityIdentifier("share.copy")
                        ShareLink("Share", item: uri).accessibilityIdentifier("share.system")
                    }.buttonStyle(.bordered)
                }.padding()
            }.navigationTitle("Sharing QR").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct QRScanner: View {
    var onScanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScannerCamera(onScanned: onScanned)
                .overlay(alignment: .bottom) { Text("Point the camera at a PearTube channel, stream, or TV pairing QR code.").font(.callout).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14)).padding() }
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Scan QR Code")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("scanner.cancel") } }
        }
    }
}

private struct ScannerCamera: UIViewControllerRepresentable {
    let onScanned: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController { let controller = ScannerController(); controller.onScanned = onScanned; return controller }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: ScannerController, coordinator: ()) { uiViewController.stop() }
}

private final class CaptureEngine: @unchecked Sendable {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "peartube.camera")
    private var stopped = false
    func configure(delegate: AVCaptureMetadataOutputObjectsDelegate, completion: @escaping (String?) -> Void) {
        queue.async {
            guard !self.stopped else { return }
            do {
                guard let device = AVCaptureDevice.default(for: .video) else { throw AppFailure("This device has no camera. You can still paste a PearTube link.") }
                let input = try AVCaptureDeviceInput(device: device)
                self.session.beginConfiguration()
                guard self.session.canAddInput(input) else { self.session.commitConfiguration(); throw AppFailure("The camera cannot be opened.") }
                self.session.addInput(input)
                let output = AVCaptureMetadataOutput()
                guard self.session.canAddOutput(output) else { self.session.commitConfiguration(); throw AppFailure("QR scanning is not available on this camera.") }
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(delegate, queue: .main)
                output.metadataObjectTypes = [.qr]
                self.session.commitConfiguration()
                self.session.startRunning()
                DispatchQueue.main.async { completion(nil) }
            } catch { DispatchQueue.main.async { completion(error.localizedDescription) } }
        }
    }
    func stop() { queue.async { self.stopped = true; if self.session.isRunning { self.session.stopRunning() } } }
}

@MainActor
private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?
    private let engine = CaptureEngine()
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false
    private let message = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        message.numberOfLines = 0; message.textColor = .white; message.textAlignment = .center; message.translatesAutoresizingMaskIntoConstraints = false
        message.accessibilityIdentifier = "scanner.message"
        view.addSubview(message)
        NSLayoutConstraint.activate([message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), message.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: begin()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in Task { @MainActor in if allowed { self?.begin() } else { self?.denied() } } }
        default: denied()
        }
    }
    private func denied() { message.text = "Camera access is disabled. Enable it in iOS Settings to scan QR codes, or paste a PearTube link instead." }
    private func begin() {
        guard !delivered else { return }
        let layer = AVCaptureVideoPreviewLayer(session: engine.session); layer.videoGravity = .resizeAspectFill; layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0); preview = layer
        engine.configure(delegate: self) { [weak self] error in self?.message.text = error }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); preview?.frame = view.bounds
        if let connection = preview?.connection, let scene = view.window?.windowScene {
            let angle: CGFloat
            switch scene.interfaceOrientation { case .landscapeLeft: angle = 0; case .landscapeRight: angle = 180; case .portraitUpsideDown: angle = 270; default: angle = 90 }
            if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        }
    }
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        Task { @MainActor [weak self] in
            guard let self, !self.delivered else { return }
            self.delivered = true; self.stop(); self.onScanned?(value)
        }
    }
    func stop() { delivered = true; engine.stop() }
}
