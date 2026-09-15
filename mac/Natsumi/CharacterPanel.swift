import AppKit
import NatsumiCore
import SwiftUI

/// The small character that stays on the desktop. It floats above other windows without taking focus,
/// can be dragged anywhere, and opens the conversation when clicked.
@MainActor
final class CharacterPanelController {
    private let panel: NSPanel

    init(model: AppModel, onClick: @escaping @MainActor () -> Void) {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 120, height: 130),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = ClickOrDragHostingView(rootView: CharacterView(model: model), onClick: onClick)
        if !panel.setFrameUsingName("natsumi.character"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - 160, y: visible.minY + 40))
        }
        panel.setFrameAutosaveName("natsumi.character")
        panel.orderFrontRegardless()
    }

    var frame: NSRect { panel.frame }
}

/// A click opens the conversation; a drag moves the window.
final class ClickOrDragHostingView<Content: View>: NSHostingView<Content> {
    private var onClick: @MainActor () -> Void = {}
    private var dragged = false

    init(rootView: Content, onClick: @escaping @MainActor () -> Void) {
        self.onClick = onClick
        super.init(rootView: rootView)
    }

    required init(rootView: Content) {
        super.init(rootView: rootView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragged else { return }
        dragged = true
        window?.performDrag(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        if !dragged { onClick() }
    }
}

struct CharacterView: View {
    let model: AppModel

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
            art(elapsed: context.date.timeIntervalSinceReferenceDate)
        }
        .frame(width: 120, height: 130)
        .overlay(alignment: .bottomTrailing) {
            if model.status != .connected {
                Circle().fill(.gray).frame(width: 10, height: 10).padding(8).help(model.statusText)
            }
        }
    }

    @ViewBuilder
    private func art(elapsed: TimeInterval) -> some View {
        switch model.avatar {
        case .sprite(let asset):
            // Frames are 2x pixels, drawn at half size.
            Image(decorative: asset.frame(for: model.expression, elapsed: elapsed), scale: 2)
                .interpolation(.high)
        case .placeholder:
            Text(PlaceholderArt.symbol(for: model.expression))
                .font(.system(size: 64))
        }
    }
}
