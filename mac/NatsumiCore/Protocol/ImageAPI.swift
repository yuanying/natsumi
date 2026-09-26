import CoreGraphics
import Foundation
import ImageIO

/// A picture fetched from the server and read: a small copy for the strips it is shown in, and the bytes as they came
/// for looking at it whole (client-contract「会話の画像」). The same ID is always the same picture, so two are equal
/// when their IDs and sizes are; the pixels are never compared.
public struct LoadedImage: Equatable, @unchecked Sendable {
    /// The longest side of the small copy, in pixels. The strips draw it at a fraction of this, at twice the
    /// resolution of the screen at most.
    public static let thumbnailSide = 512

    public let imageId: String
    /// The picture's own size, in pixels.
    public let pixelSize: CGSize
    public let thumbnail: CGImage
    /// The picture as the server sent it. Only the small copy is kept decoded; the whole picture is decoded when it is
    /// looked at.
    public let data: Data

    /// nil when the bytes are not a picture ImageIO can read.
    public init?(imageId: String, data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceShouldCacheImmediately: true,
                  kCGImageSourceThumbnailMaxPixelSize: min(Self.thumbnailSide, max(width, height)),
              ] as CFDictionary)
        else { return nil }
        self.imageId = imageId
        self.pixelSize = CGSize(width: width, height: height)
        self.thumbnail = thumbnail
        self.data = data
    }

    /// The whole picture, decoded now.
    public func full() -> CGImage? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
    }

    public static func == (lhs: LoadedImage, rhs: LoadedImage) -> Bool {
        lhs.imageId == rhs.imageId && lhs.pixelSize == rhs.pixelSize
    }
}

/// What came of fetching a picture.
public enum ImageFetch: Equatable, Sendable {
    case loaded(LoadedImage)
    /// The server does not have it (404), or what came is not a picture: asking again would not change that.
    case missing
    /// It could not be had now — no connection, or the session was refused — and may be had later.
    case unavailable
}

/// `GET /v1/images/<imageId>`, with the session's Bearer token.
public enum ImageAPI {
    /// nil for an ID not of the contract's form (letters, digits and `-`), which is not put in the path.
    public static func request(server: ServerAddress, token: String, imageId: String) -> URLRequest? {
        guard isValid(imageId) else { return nil }
        var request = URLRequest(url: server.url(path: "/v1/images/\(imageId)"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // The app keeps what it fetched itself; the server says not to store it anyway.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    /// Reads the answer. Decoding happens here, so the root calls this away from the main thread.
    public static func fetch(status: Int, body: Data, imageId: String) -> ImageFetch {
        switch status {
        case 200: LoadedImage(imageId: imageId, data: body).map { .loaded($0) } ?? .missing
        case 404: .missing
        default: .unavailable
        }
    }

    static func isValid(_ imageId: String) -> Bool {
        !imageId.isEmpty && imageId.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-"
        }
    }
}
