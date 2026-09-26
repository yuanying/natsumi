import CoreGraphics
import Foundation

/// Where one picture stands on this device.
public enum ImageSlot: Equatable, Sendable {
    /// Asked for, not answered yet.
    case loading
    case loaded(LoadedImage)
    /// The server does not have it; it is not asked for again.
    case missing
    /// It could not be had; it is asked for again once the connection is back.
    case unavailable
}

/// The pictures this device has fetched, by ID (client-contract「会話の画像」). The same ID is always the same picture,
/// so each is fetched once and kept: a conversation's until the owner logs out, an approval's until the approval is
/// no longer waiting. It is part of the mediator's state; the root only fetches what it is asked to.
public struct ImageShelf: Equatable, Sendable {
    private var slots: [String: ImageSlot] = [:]
    /// The pictures of approvals, which go when their approval does.
    private var approvalIds: Set<String> = []

    public init() {}

    public subscript(imageId: String) -> ImageSlot? { slots[imageId] }

    /// Marks the pictures not asked for yet as being fetched, and returns them, in order, for the root to fetch.
    public mutating func request(_ ids: [String], forApproval: Bool = false) -> [String] {
        var asked: [String] = []
        for id in ids where slots[id] == nil {
            slots[id] = .loading
            if forApproval { approvalIds.insert(id) }
            asked.append(id)
        }
        return asked
    }

    /// Puts what came of a fetch in its place. An answer nobody is waiting for — one that was on its way when the
    /// owner logged out, or when its approval closed — is dropped.
    public mutating func receive(_ id: String, _ fetch: ImageFetch) {
        guard slots[id] == .loading else { return }
        slots[id] = switch fetch {
        case .loaded(let image): .loaded(image)
        case .missing: .missing
        case .unavailable: .unavailable
        }
    }

    /// Forgets the pictures that could not be had, so that they are asked for again.
    public mutating func retryUnavailable() {
        slots = slots.filter { $0.value != .unavailable }
    }

    /// Lets go of the pictures of approvals that are no longer waiting (the contract: an approval's pictures are
    /// thrown away when it closes).
    public mutating func keepApprovalImages(_ pending: Set<String>) {
        let gone = approvalIds.subtracting(pending)
        guard !gone.isEmpty else { return }
        for id in gone { slots[id] = nil }
        approvalIds.subtract(gone)
    }
}

/// How a picture is drawn in a strip.
public enum ImageTileContent: Equatable, Sendable {
    /// On its way: a blank of the size it will have.
    case loading
    case loaded(LoadedImage)
    /// It could not be had: the place says so, and the text around it stays.
    case failed
}

/// One small picture in a strip, at the size it is drawn.
public struct ImageTileProps: Equatable, Identifiable, Sendable {
    public var imageId: String
    /// In points. It is known before the picture comes, so that nothing moves when it does.
    public var size: CGSize
    public var content: ImageTileContent
    /// 「画像 1/2」: which of the pictures this is, for the ear.
    public var label: String
    /// What the pointer resting on it is told.
    public var help: String

    public init(imageId: String, size: CGSize, content: ImageTileContent, label: String, help: String) {
        self.imageId = imageId
        self.size = size
        self.content = content
        self.label = label
        self.help = help
    }

    public var id: String { imageId }

    /// Only a picture that came can be opened large.
    public var canOpen: Bool {
        if case .loaded = content { true } else { false }
    }
}

/// One picture, whole: the window (on the Mac) or the screen (on the iPhone) it is opened large in.
public struct ImageViewerProps: Equatable, Sendable {
    public var image: LoadedImage
    public var title: String

    public init(image: LoadedImage, title: String) {
        self.image = image
        self.title = title
    }
}

/// A row of small pictures: all at one height, each as wide as its shape asks, and the whole row shrunk to fit the
/// width it has. A picture whose shape is not known yet is square until it comes.
public struct ImageStrip: Equatable, Sendable {
    /// Pictures narrower or wider than this are drawn cut to it, so that one strip does not become a line or a post.
    static let aspectRange: ClosedRange<CGFloat> = 1.0 / 3...3

    public var height: CGFloat
    public var maxWidth: CGFloat
    public var spacing: CGFloat

    public init(height: CGFloat, maxWidth: CGFloat, spacing: CGFloat) {
        self.height = height
        self.maxWidth = maxWidth
        self.spacing = spacing
    }

    public func sizes(_ aspects: [CGFloat?]) -> [CGSize] {
        let widths = aspects.map { height * min(max($0 ?? 1, Self.aspectRange.lowerBound), Self.aspectRange.upperBound) }
        let room = max(maxWidth - spacing * CGFloat(max(widths.count - 1, 0)), 0)
        let total = widths.reduce(0, +)
        guard total > room, total > 0 else { return widths.map { CGSize(width: $0, height: height) } }
        // Divided last, so that each length is rounded once.
        return widths.map { CGSize(width: $0 * room / total, height: height * room / total) }
    }

    /// The tiles of a line's or an approval's pictures, as far as each has come. `openHelp` is what a picture that
    /// can be opened says it does.
    public func tiles(_ images: [ShownImage], shelf: ImageShelf, openHelp: String) -> [ImageTileProps] {
        let aspects = images.map { image -> CGFloat? in
            if let aspect = image.aspectRatio { return aspect }
            if case .loaded(let loaded) = shelf[image.imageId] { return loaded.pixelSize.width / loaded.pixelSize.height }
            return nil
        }
        return zip(images.indices, sizes(aspects)).map { index, size in
            let image = images[index]
            let content: ImageTileContent
            let help: String
            switch shelf[image.imageId] {
            case .loaded(let loaded):
                content = .loaded(loaded)
                help = openHelp
            case .missing, .unavailable:
                content = .failed
                help = "画像を取れませんでした"
            case .loading, nil:
                content = .loading
                help = "画像を読み込んでいます"
            }
            return ImageTileProps(
                imageId: image.imageId, size: size, content: content, label: "画像 \(index + 1)/\(images.count)", help: help)
        }
    }
}
