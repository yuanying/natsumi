import AppKit
import SwiftUI

/// A panel in the character's layer: above other windows and full-screen apps, on every Space, without activating
/// the app.
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
        // `.borderless` is the empty mask, so `contains(.borderless)` is always true; test for a title bar instead.
        // A titled panel made clear and then opaque again draws none of its content.
        if !style.contains(.titled) {
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            // The comic panels are paper-white with black ink in both appearances.
            panel.appearance = NSAppearance(named: .aqua)
        }
        return panel
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

/// Buttons in a panel of an inactive app work on the first click. The panel's frame comes only from the layout: the
/// hosting view must not resize its window to the view's ideal size, which moves the panel off its place.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    required init(rootView: Content) {
        super.init(rootView: rootView)
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// A menu item that runs a closure.
final class ActionMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("not used")
    }

    @objc private func run() {
        // Menus call their actions on the main thread.
        let handler = handler
        MainActor.assumeIsolated { handler() }
    }
}

/// How far the mouse has to move before it counts as a drag rather than an unsteady click.
private let dragThreshold: CGFloat = 3

/// A click reports where it landed (origin at the top left); a drag moves the window; a right click or
/// control-click shows the menu.
final class ClickOrDragHostingView<Content: View>: NSHostingView<Content> {
    private var onClick: @MainActor (CGPoint) -> Void = { _ in }
    private var onDrag: @MainActor (Bool) -> Void = { _ in }
    /// Where the pointer is when it is over the character herself. A global monitor is blind inside the app's own
    /// windows, so this tracking area covers what it cannot see.
    private var onPointer: @MainActor () -> Void = {}
    private var menuProvider: @MainActor () -> NSMenu? = { nil }
    /// Where the window and the mouse were when the button went down, so a drag is measured from there.
    private var anchor: (window: CGPoint, mouse: CGPoint)?
    private var isDragging = false
    private var swallowsClick = false

    init(
        rootView: Content, onClick: @escaping @MainActor (CGPoint) -> Void,
        onDrag: @escaping @MainActor (Bool) -> Void, onPointer: @escaping @MainActor () -> Void,
        menu: @escaping @MainActor () -> NSMenu?
    ) {
        self.onClick = onClick
        self.onDrag = onDrag
        self.onPointer = onPointer
        self.menuProvider = menu
        super.init(rootView: rootView)
        // The character's frame is set only by its scale, the owner's drag, and where the mediator sends her.
        sizingOptions = []
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        // `.activeAlways`: the app is never the active one, and the pointer still has to be seen.
        addTrackingArea(NSTrackingArea(
            rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { onPointer() }
    override func mouseMoved(with event: NSEvent) { onPointer() }

    override func rightMouseDown(with event: NSEvent) {
        showMenu(with: event)
    }

    private func showMenu(with event: NSEvent) {
        guard let menu = menuProvider() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
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
        isDragging = false
        swallowsClick = false
        anchor = window.map { (window: $0.frame.origin, mouse: NSEvent.mouseLocation) }
        if event.modifierFlags.contains(.control) {
            // Handled as a right click; the mouse-up that follows must not also open the input field, and this is
            // not the start of a drag.
            swallowsClick = true
            anchor = nil
            showMenu(with: event)
        }
    }

    /// The window is moved here rather than with `performDrag`, which runs a modal loop of its own: inside it the
    /// run loop does not come round, so nothing is redrawn and the character stands still while she is carried.
    override func mouseDragged(with event: NSEvent) {
        guard let window, var anchor else { return }
        let mouse = NSEvent.mouseLocation
        if !isDragging {
            let dx = mouse.x - anchor.mouse.x, dy = mouse.y - anchor.mouse.y
            guard (dx * dx + dy * dy).squareRoot() >= dragThreshold else { return }
            isDragging = true
            swallowsClick = true
            // Taking hold of her stops whatever run she was in the middle of, so the drag is measured from where
            // she is now and not from where she was when the button went down.
            onDrag(true)
            anchor = (window: window.frame.origin, mouse: mouse)
            self.anchor = anchor
        }
        window.setFrameOrigin(NSPoint(
            x: anchor.window.x + (mouse.x - anchor.mouse.x),
            y: anchor.window.y + (mouse.y - anchor.mouse.y)))
    }

    override func mouseUp(with event: NSEvent) {
        anchor = nil
        if isDragging {
            isDragging = false
            onDrag(false)
            return
        }
        guard !swallowsClick else { return }
        let point = convert(event.locationInWindow, from: nil)
        onClick(CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y))
    }
}
