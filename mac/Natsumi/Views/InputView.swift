import AppKit
import NatsumiCore
import SwiftUI

/// The text box under the character. Enter sends, Shift+Enter starts a new line, Esc closes, and the grip in the
/// bottom-right corner changes its size.
struct InputView: View {
    let props: InputProps?
    let field: EventSink
    let historyButton: EventSink
    let grip: EventSink
    let send: EventSink
    /// The text being written. It is drawing-local on purpose: while an input method is composing, the text belongs
    /// to the text view and must not travel through the tree.
    @State private var draft = ""

    var body: some View {
        if let props {
            let scale = props.textScale
            let fontSize = 13 * scale
            let box = props.boxSize
            let ink = Comic.outline(scale)
            let shape = RoundedRectangle(cornerRadius: Comic.radius(scale))
            VStack(alignment: .leading, spacing: 6 * scale) {
                if let status = props.status {
                    StatusRow(props: status, scale: scale, send: send)
                }
                ForEach(props.failures) { failure in
                    FailedRow(props: failure, scale: scale) { send(.outgoingDismissed(requestId: failure.requestId)) }
                }
                HStack(alignment: .bottom, spacing: 6 * scale) {
                    InputTextView(
                        text: $draft, fontSize: fontSize, onSubmit: submit,
                        onCancel: { field(.inputEscaped) },
                        onHeight: { height in field(.inputTextHeightMeasured(height)) }
                    )
                    .frame(height: box.textHeight(
                        content: props.measuredTextHeight, minimum: InputTextView.lineHeight(fontSize: fontSize)))
                    .overlay(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text("話しかける（Shift+Enter で改行）")
                                .font(Comic.font(fontSize))
                                .foregroundStyle(Comic.faint)
                                .padding(.leading, InputTextView.inset.width + 5)
                                .padding(.top, InputTextView.inset.height)
                                .allowsHitTesting(false)
                        }
                    }
                    Button { historyButton(.historyButtonClicked) } label: {
                        Image(systemName: "clock.arrow.circlepath")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Comic.ink)
                    .help("履歴")
                }
            }
            .padding(.horizontal, 12 * scale)
            .padding(.vertical, 8 * scale)
            .padding(.bottom, 4)
            .frame(width: box.width - ink * 2)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                shape.fill(Comic.paper)
                shape.stroke(Comic.ink, lineWidth: ink)
            }
            .overlay(alignment: .bottomTrailing) { gripHandle.padding(2 * scale) }
            .padding(ink)
            .environment(\.colorScheme, .light)
        }
    }

    /// Dragging right widens the box on both sides; dragging down makes it taller. Where it ends up is the
    /// mediator's to decide, so only the mouse is reported.
    private var gripHandle: some View {
        Image(systemName: "arrow.down.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Comic.faint)
            .frame(width: 14, height: 14)
            .contentShape(Rectangle())
            .help("ドラッグで大きさを変える")
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in grip(.gripDragged(to: NSEvent.mouseLocation)) }
                    .onEnded { _ in grip(.gripReleased) })
    }

    /// An empty draft is not a message: nothing is raised and what was typed stays.
    private func submit() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        field(.inputSubmitted(draft))
        draft = ""
    }
}

/// The connection state and what to do about it, as the history shows it too.
struct StatusRow: View {
    let props: StatusProps
    let scale: Double
    let send: EventSink

    var body: some View {
        HStack {
            Text(props.text).foregroundStyle(.secondary)
            Spacer()
            if let action = props.action {
                Button(action.title) { send(action.event) }.controlSize(.small)
            }
        }
        .font(Comic.font(11 * scale))
    }
}

private struct FailedRow: View {
    let props: FailureProps
    let scale: Double
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(props.text).foregroundStyle(.red).lineLimit(2)
            Spacer(minLength: 0)
            Button(action: dismiss) { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
        }
        .font(Comic.font(11 * scale))
    }
}

/// An AppKit text view, so that the Enter that confirms Japanese input is left to the input method and long text
/// scrolls inside the box.
struct InputTextView: NSViewRepresentable {
    static let identifier = NSUserInterfaceItemIdentifier("natsumi.input")
    static let inset = NSSize(width: 4, height: 4)

    @Binding var text: String
    let fontSize: CGFloat
    let onSubmit: () -> Void
    let onCancel: () -> Void
    let onHeight: (CGFloat) -> Void

    static func lineHeight(fontSize: CGFloat) -> CGFloat {
        let font = Comic.nsFont(fontSize)
        return ceil(NSLayoutManager().defaultLineHeight(for: font) + inset.height * 2)
    }

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
        textView.font = Comic.nsFont(fontSize)
        // The panel is paper-white in both appearances.
        textView.textColor = .black
        textView.insertionPointColor = .black
        textView.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? NSTextView else { return }
        if textView.font?.pointSize != fontSize { textView.font = Comic.nsFont(fontSize) }
        if !textView.hasMarkedText(), textView.string != text { textView.string = text }
        context.coordinator.reportHeight(of: textView)
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
            reportHeight(of: textView)
        }

        func reportHeight(of textView: NSTextView) {
            guard let layout = textView.layoutManager, let container = textView.textContainer else { return }
            layout.ensureLayout(for: container)
            let height = ceil(layout.usedRect(for: container).height + textView.textContainerInset.height * 2)
            let report = parent.onHeight
            // Reported after the view update, which must not change state it reads.
            DispatchQueue.main.async { report(height) }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // While text is being composed, Enter and Esc belong to the input method.
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
            case #selector(NSResponder.cancelOperation(_:)):
                parent.onCancel()
                return true
            default:
                return false
            }
        }
    }
}
