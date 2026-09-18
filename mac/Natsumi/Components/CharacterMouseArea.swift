import AppKit
import SwiftUI

/// The owner carrying the character: when they take hold of her, how far they have moved her since, and when
/// they let go.
enum CharacterDrag: Equatable {
    case began
    /// How far from where she was taken hold of, in screen points.
    case moved(by: CGSize)
    case ended
}

/// How far the mouse has to move before it counts as a drag rather than an unsteady click.
private let dragThreshold: CGFloat = 3

/// The part of the stage that is the character, for the mouse: a click reports where it landed (origin at the top
/// left), a drag carries her, a right click or control-click shows her menu. It is an AppKit view laid over her
/// drawing, because a drag has to be measured from the mouse-down and must not be swallowed by the drawing's own
/// buttons.
struct CharacterMouseArea: NSViewRepresentable {
    let onClick: @MainActor (CGPoint) -> Void
    let onDrag: @MainActor (CharacterDrag) -> Void
    let menu: @MainActor () -> NSMenu?

    func makeNSView(context: Context) -> CharacterMouseView {
        let view = CharacterMouseView()
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: CharacterMouseView, context: Context) {
        view.onClick = onClick
        view.onDrag = onDrag
        view.menuProvider = menu
    }
}

final class CharacterMouseView: NSView {
    var onClick: @MainActor (CGPoint) -> Void = { _ in }
    var onDrag: @MainActor (CharacterDrag) -> Void = { _ in }
    var menuProvider: @MainActor () -> NSMenu? = { nil }
    /// Where the mouse was when the button went down, so a drag is measured from there.
    private var anchor: CGPoint?
    private var isDragging = false
    private var swallowsClick = false

    /// A click works on the first click, without bringing the app to the front.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        // A drag whose mouse-up never arrived (the Space changed, the screen locked) would otherwise leave her held
        // for good. The next press ends it.
        if isDragging { onDrag(.ended) }
        isDragging = false
        swallowsClick = false
        anchor = NSEvent.mouseLocation
        if event.modifierFlags.contains(.control) {
            // Handled as a right click; the mouse-up that follows must not also open the input field, and this is
            // not the start of a drag.
            swallowsClick = true
            anchor = nil
            showMenu(with: event)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard var anchor else { return }
        let mouse = NSEvent.mouseLocation
        if !isDragging {
            let dx = mouse.x - anchor.x, dy = mouse.y - anchor.y
            guard (dx * dx + dy * dy).squareRoot() >= dragThreshold else { return }
            isDragging = true
            swallowsClick = true
            // Taking hold of her stops whatever run she was in the middle of, so the drag is measured from where she
            // is now and not from where she was when the button went down.
            onDrag(.began)
            anchor = mouse
            self.anchor = anchor
        }
        onDrag(.moved(by: CGSize(width: mouse.x - anchor.x, height: mouse.y - anchor.y)))
    }

    override func mouseUp(with event: NSEvent) {
        anchor = nil
        if isDragging {
            isDragging = false
            onDrag(.ended)
            return
        }
        guard !swallowsClick else { return }
        let point = convert(event.locationInWindow, from: nil)
        onClick(CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y))
    }

    override func rightMouseDown(with event: NSEvent) {
        showMenu(with: event)
    }

    private func showMenu(with event: NSEvent) {
        guard let menu = menuProvider() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}
