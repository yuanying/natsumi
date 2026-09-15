import AppKit
import NatsumiCore
import SwiftUI

/// A panel in the character's layer: above other windows and full-screen apps, on every Space, without activating the app.
final class OverlayPanel: NSPanel {
    /// The input field and the history take keyboard focus; the character and the balloon never do.
    var acceptsKey = false
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { acceptsKey }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    static func make(style: NSWindow.StyleMask = [.borderless], acceptsKey: Bool = false) -> OverlayPanel {
        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: style.union(.nonactivatingPanel),
            backing: .buffered, defer: false)
        panel.acceptsKey = acceptsKey
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        if style.contains(.borderless) {
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
        }
        return panel
    }
}

/// The character and everything around it: the balloon above, the input field below and the history beside it.
/// The others are child windows of the character's panel, so they move with it while it is dragged.
@MainActor
final class OverlayController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private let character = OverlayPanel.make()
    private let balloon = OverlayPanel.make()
    private let input = OverlayPanel.make(acceptsKey: true)
    private let history = OverlayPanel.make(style: [.titled, .closable, .resizable, .utilityWindow], acceptsKey: true)
    private let placement = BalloonPlacement()
    private var outsideClickMonitor: Any?
    private var wasInputOpen = false
    private var wasHistoryOpen = false

    private static let historySize = NSSize(width: 340, height: 440)

    init(model: AppModel) {
        self.model = model
        super.init()

        character.delegate = self
        character.contentView = ClickOrDragHostingView(rootView: CharacterView(model: model)) { [weak self] in
            self?.update { $0.characterClicked() }
        }
        balloon.contentView = FirstMouseHostingView(rootView: BalloonView(model: model, placement: placement, openHistory: openHistory))
        input.contentView = FirstMouseHostingView(rootView: InputView(model: model, openHistory: openHistory) { [weak self] in
            self?.update { $0.escape() }
        })
        input.onCancel = { [weak self] in self?.update { $0.escape() } }
        history.title = "natsumi の履歴"
        history.delegate = self
        history.setContentSize(Self.historySize)
        history.contentView = NSHostingView(rootView: HistoryView(model: model))
        history.onCancel = { [weak self] in self?.update { $0.closeHistory() } }

        if !character.setFrameUsingName("natsumi.character"), let screen = NSScreen.main {
            let visible = screen.visibleFrame
            character.setFrameOrigin(NSPoint(x: visible.maxX - 160, y: visible.minY + 40))
        }
        character.setFrameAutosaveName("natsumi.character")
        fitCharacter()
        character.orderFrontRegardless()

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.fitCharacter() }
        }
        observe()
    }

    func openInput() { update { $0.openInput() } }
    func openHistory() { update { $0.openHistory() } }

    private func update(_ change: (inout OverlayVisibility) -> Void) {
        change(&model.visibility)
    }

    /// Lays the panels out again whenever what they show changes.
    private func observe() {
        withObservationTracking {
            _ = (model.characterScale, model.balloon, model.visibility, model.status, model.conversation.outbox, model.avatar)
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.fitCharacter()
                self.observe()
            }
        }
    }

    // MARK: - Layout

    private var visibleFrame: CGRect {
        let center = NSPoint(x: character.frame.midX, y: character.frame.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(center) } ?? character.screen ?? NSScreen.main
        return screen?.visibleFrame ?? character.frame
    }

    /// Sizes the character to the scale, keeping its feet in place and the whole of it on the screen.
    private func fitCharacter() {
        let frame = OverlayLayout.resized(character.frame, to: model.characterScale.artSize, within: visibleFrame)
        if frame != character.frame { character.setFrame(frame, display: true) }
        layout(placeHistory: false)
    }

    private func layout(placeHistory: Bool) {
        let visibility = model.visibility
        let scale = model.characterScale.textScale
        let balloonSize = model.balloon.content == nil ? nil : fittingSize(
            of: BalloonView(model: model, placement: placement, openHistory: {}), width: BalloonView.maxWidth * scale)
        let inputSize = visibility.isInputOpen
            ? fittingSize(of: InputView(model: model, openHistory: {}, close: {}), width: InputView.width * scale) : nil
        let historyOpening = visibility.isHistoryOpen && !wasHistoryOpen
        let layout = OverlayLayout.make(
            visible: visibleFrame, character: character.frame, balloon: balloonSize, input: inputSize,
            history: visibility.isHistoryOpen && (placeHistory || historyOpening) ? history.frame.size : nil)

        placement.tail = layout.tail
        placement.tailX = layout.tailX
        place(balloon, at: layout.balloon)

        place(input, at: layout.input)
        if visibility.isInputOpen && !wasInputOpen {
            input.makeKey()
            if let field = input.contentView?.descendant(withIdentifier: InputField.identifier) {
                input.makeFirstResponder(field)
            }
        }
        wasInputOpen = visibility.isInputOpen
        watchOutsideClicks(visibility.isInputOpen)

        if visibility.isHistoryOpen {
            place(history, at: layout.history ?? history.frame)
            if historyOpening { history.makeKey() }
        } else {
            place(history, at: nil)
        }
        wasHistoryOpen = visibility.isHistoryOpen
    }

    private func place(_ panel: NSPanel, at frame: CGRect?) {
        guard let frame else {
            if panel.parent != nil { character.removeChildWindow(panel) }
            panel.orderOut(nil)
            return
        }
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        if panel.parent == nil { character.addChildWindow(panel, ordered: .above) }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    private func fittingSize<V: View>(of view: V, width: CGFloat) -> CGSize {
        let size = NSHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 10_000))
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    /// A click in another app closes the input field.
    private func watchOutsideClicks(_ watching: Bool) {
        if watching, outsideClickMonitor == nil {
            outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                MainActor.assumeIsolated { self?.update { $0.clickedOutside() } }
            }
        } else if !watching, let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }

    // MARK: - NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        guard (notification.object as? NSWindow) === character else { return }
        layout(placeHistory: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === history { update { $0.closeHistory() } }
        return false
    }
}

extension NSView {
    func descendant(withIdentifier identifier: NSUserInterfaceItemIdentifier) -> NSView? {
        if self.identifier == identifier { return self }
        for subview in subviews {
            if let found = subview.descendant(withIdentifier: identifier) { return found }
        }
        return nil
    }
}

/// Buttons in a panel of an inactive app work on the first click.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A click opens the input field; a drag moves the window.
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
        let scale = model.characterScale
        TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
            art(elapsed: context.date.timeIntervalSinceReferenceDate, scale: scale)
        }
        .frame(width: scale.artSize.width, height: scale.artSize.height)
        .overlay(alignment: .bottomTrailing) {
            if model.status != .connected {
                Circle().fill(.gray).frame(width: 10, height: 10).padding(4).help(model.statusText)
            }
        }
    }

    @ViewBuilder
    private func art(elapsed: TimeInterval, scale: CharacterScale) -> some View {
        switch model.avatar {
        case .sprite(let asset):
            // Frames are 2x pixels; they are resampled smoothly to the chosen size.
            Image(decorative: asset.frame(for: model.expression, elapsed: elapsed), scale: 2)
                .resizable()
                .interpolation(.high)
                .antialiased(true)
                .frame(width: scale.artSize.width, height: scale.artSize.height)
        case .placeholder:
            Text(PlaceholderArt.symbol(for: model.expression))
                .font(.system(size: 64 * scale.value))
        }
    }
}
