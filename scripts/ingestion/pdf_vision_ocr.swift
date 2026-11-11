import AppKit
import Foundation
import PDFKit
import Vision

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: pdf_vision_ocr.swift <pdf-path>\n", stderr)
    exit(2)
}

let pdfURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: pdfURL) else {
    fputs("Could not open PDF\n", stderr)
    exit(1)
}

let pageCount = min(document.pageCount, 3)
var recognizedPages: [String] = []

for pageIndex in 0..<pageCount {
    guard let page = document.page(at: pageIndex) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let longestEdge = max(bounds.width, bounds.height)
    let scale = min(3.0, 2400.0 / max(longestEdge, 1.0))
    let image = page.thumbnail(
        of: CGSize(width: bounds.width * scale, height: bounds.height * scale),
        for: .mediaBox
    )
    guard let cgImage = image.cgImage(
        forProposedRect: nil,
        context: nil,
        hints: nil
    ) else { continue }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    do {
        try VNImageRequestHandler(cgImage: cgImage).perform([request])
    } catch {
        fputs("Vision OCR failed on page \(pageIndex + 1): \(error)\n", stderr)
        continue
    }

    let lines = (request.results ?? []).compactMap { observation -> (CGFloat, String)? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        return (observation.boundingBox.midY, text)
    }.sorted { $0.0 > $1.0 }.map { $0.1 }
    recognizedPages.append(lines.joined(separator: "\n"))
}

print(recognizedPages.joined(separator: "\n\n"))
