import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct Span: Decodable {
  let line: Int
  let start: Int
  let end: Int
}

struct Order: Decodable {
  let ranges: [Span]
}

func stop(_ reason: String) -> Never {
  FileHandle.standardError.write(Data((reason + "\n").utf8))
  exit(1)
}

func send(_ message: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: message) else { stop("cannot encode reply") }
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func upright(_ data: Data) -> CGImage {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let stored = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { stop("input is not an image") }
  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  let tag = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
  let orientation = CGImagePropertyOrientation(rawValue: tag) ?? .up
  if orientation == .up { return stored }
  let turned = CIImage(cgImage: stored).oriented(orientation)
  guard let image = CIContext().createCGImage(turned, from: turned.extent) else { stop("cannot turn image upright") }
  return image
}

guard let first = readLine(), let input = Data(base64Encoded: first) else { stop("input is not base64") }
let image = upright(input)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US", "ru-RU"]
do {
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
  stop("recognition failed")
}

let found = (request.results ?? [])
  .sorted { ($0.boundingBox.midY, -$0.boundingBox.minX) > ($1.boundingBox.midY, -$1.boundingBox.minX) }
  .compactMap { observation in observation.topCandidates(1).first.map { (observation, $0) } }

send(["lines": found.map { $0.1.string }])

guard let second = readLine(), let order = try? JSONDecoder().decode(Order.self, from: Data(second.utf8)) else {
  stop("ranges are not readable")
}

let width = CGFloat(image.width)
let height = CGFloat(image.height)
guard
  let canvas = CGContext(
    data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
else { stop("cannot create canvas") }
canvas.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
canvas.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))

for span in order.ranges {
  guard found.indices.contains(span.line) else { stop("range names a line that does not exist") }
  let (observation, text) = found[span.line]
  guard span.start >= 0, span.start < span.end, span.end <= text.string.utf16.count else { stop("range is outside its line") }
  let from = String.Index(utf16Offset: span.start, in: text.string)
  let to = String.Index(utf16Offset: span.end, in: text.string)
  let box = ((try? text.boundingBox(for: from..<to)) ?? nil)?.boundingBox ?? observation.boundingBox
  let margin = box.height * height * 0.2
  canvas.fill(
    CGRect(
      x: box.minX * width - margin, y: box.minY * height - margin,
      width: box.width * width + margin * 2, height: box.height * height + margin * 2))
}

guard let painted = canvas.makeImage() else { stop("cannot finish image") }
let format = CommandLine.arguments.dropFirst().first == "jpeg" ? UTType.jpeg : UTType.png
let output = NSMutableData()
guard let destination = CGImageDestinationCreateWithData(output, format.identifier as CFString, 1, nil) else {
  stop("cannot encode image")
}
CGImageDestinationAddImage(destination, painted, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
guard CGImageDestinationFinalize(destination) else { stop("cannot encode image") }
send(["image": output.base64EncodedString()])
