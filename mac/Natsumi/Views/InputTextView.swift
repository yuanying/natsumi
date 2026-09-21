import AppKit
import SwiftUI

/// An AppKit text view, so that the Enter that confirms Japanese input is left to the input method and long text
/// scrolls inside the box. It fills whatever it is given; the window's height is the owner's to set.
struct InputTextView: NSViewRepresentable {
    static let identifier = NSUserInterfaceItemIdentifier("natsumi.input")
    static let inset = NSSize(width: 4, height: 4)
    static let fontSize: CGFloat = 13

    @Binding var text: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let textView = scroll.documentView as! NSTextView
        textView.identifier = Self.identifier
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textContainerInset = Self.inset
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.font = Comic.nsFont(Self.fontSize)
        // The window follows the appearance, and so does its text.
        textView.textColor = .textColor
        textView.insertionPointColor = .textColor
        textView.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? NSTextView else { return }
        if !textView.hasMarkedText(), textView.string != text { textView.string = text }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: InputTextView

        init(_ parent: InputTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // While text is being composed, Enter belongs to the input method.
            guard !textView.hasMarkedText() else { return false }
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                parent.text = textView.string
                parent.onSubmit()
                return true
            default:
                return false
            }
        }
    }
}
