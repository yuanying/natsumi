import Foundation
import NatsumiCore

/// Fetches one picture with the session, for the root to hand back to the mediator (ADR 0045). The picture is read
/// away from the main thread.
enum ImageFetcher {
    /// `request` is nil when the picture's ID cannot be put in the path.
    static func fetch(_ request: URLRequest?, imageId: String) async -> ImageFetch {
        guard let request else { return .missing }
        do {
            let (body, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return await Task.detached { ImageAPI.fetch(status: status, body: body, imageId: imageId) }.value
        } catch {
            return .unavailable
        }
    }
}
