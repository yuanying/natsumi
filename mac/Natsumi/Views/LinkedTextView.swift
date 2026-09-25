import AppKit
import NatsumiCore
import SwiftUI

/// A message's text with its URLs as links, drawn by an `NSTextView` (ADR 0038).
///
/// The text view does what it does for any link: the pointing hand over it and the click on it, and the selection
/// where the text is selectable. A click on a link is not opened here: it is raised as `.linkClicked` for the
/// mediator to decide. Where the text is not selectable (the balloon, the notice card), a click anywhere off the
/// links raises `click` instead, as the card's own click always did.
struct LinkedText: NSViewRepresentable {
    let runs: [TextRun]
    let font: NSFont
    var color: NSColor = .black
    var lineSpacing: CGFloat = 0
    /// nil for as many lines as it takes.
    var lineLimit: Int? = nil
    /// The history's text can be selected. The cards' cannot: a click on them is `click`.
    var isSelectable = false
    var click: UIEvent? = nil
    /// The cards' text takes the whole width, so that a click beside a short line is still the card's; the history's
    /// is as wide as what it says, like a `Text`.
    var fillsWidth = false
    let sink: EventSink

    func makeNSView(context: Context) -> LinkedTextNSView {
        let view = LinkedTextNSView()
        view.delegate = context.coordinator
        return view
    }

    func updateNSView(_ view: LinkedTextNSView, context: Context) {
        context.coordinator.sink = sink
        view.sink = sink
        view.click = isSelectable ? nil : click
        view.isSelectionAllowed = isSelectable
        view.textContainer?.maximumNumberOfLines = lineLimit ?? 0
        view.textContainer?.lineBreakMode = lineLimit == nil ? .byWordWrapping : .byTruncatingTail
        let text = attributed
        // Set again only when it changed, so that a selection is not lost to a redraw.
        if view.textStorage?.isEqual(to: text) != true {
            view.textStorage?.setAttributedString(text)
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: LinkedTextNSView, context: Context) -> CGSize? {
        // Measured apart from the view's own container, which the view resizes to its frame as it is laid out.
        let width = proposal.width ?? .greatestFiniteMagnitude
        let storage = NSTextStorage(attributedString: attributed)
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = lineLimit ?? 0
        container.lineBreakMode = lineLimit == nil ? .byWordWrapping : .byTruncatingTail
        layout.addTextContainer(container)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        let fitted = min(ceil(used.width), width)
        return CGSize(width: fillsWidth ? (proposal.width ?? fitted) : fitted, height: ceil(used.height))
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(sink: sink)
    }

    private var attributed: NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        let text = NSMutableAttributedString()
        for run in runs {
            switch run {
            case .plain(let plain):
                text.append(NSAttributedString(string: plain, attributes: base))
            case .link(let link, let url):
                var attributes = base
                attributes[.link] = url
                text.append(NSAttributedString(string: link, attributes: attributes))
            }
        }
        return text
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var sink: EventSink

        init(sink: EventSink) {
            self.sink = sink
        }

        /// The link is the mediator's to open (ADR 0038).
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            let url = (link as? URL) ?? (link as? String).flatMap(URL.init(string:))
            if let url {
                MainActor.assumeIsolated { sink(.linkClicked(url)) }
            }
            return true
        }
    }
}

/// The text view itself: read-only, transparent, and laid out to the width SwiftUI gives it.
final class LinkedTextNSView: NSTextView {
    var sink: EventSink = .ignored
    /// Raised by a click off the links where the text cannot be selected.
    var click: UIEvent?
    /// The history's text can be selected; on the cards a drag selects nothing.
    var isSelectionAllowed = false

    init() {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        // Links are followed only in a selectable text view; on the cards, what a drag would select is refused below.
        isSelectable = true
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = false
        isHorizontallyResizable = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: container)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard !isSelectionAllowed, !isOnLink(event) else { return super.mouseDown(with: event) }
        if let click { sink(click) }
    }

    private func isOnLink(_ event: NSEvent) -> Bool {
        guard let layout = layoutManager, let container = textContainer, let storage = textStorage,
              storage.length > 0
        else { return false }
        let point = convert(event.locationInWindow, from: nil)
        var fraction: CGFloat = 0
        let index = layout.characterIndex(
            for: point, in: container, fractionOfDistanceBetweenInsertionPoints: &fraction)
        // A point past the end of a line answers with the last character; it is on it only if inside its glyph.
        let glyph = layout.glyphIndexForCharacter(at: index)
        let rect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard rect.contains(point) else { return false }
        return storage.attribute(.link, at: index, effectiveRange: nil) != nil
    }
}
