import AppKit
import NatsumiCore
import SwiftUI

/// The text box under the character. Enter sends, Shift+Enter starts a new line, Esc closes, and the grip in the
/// bottom-right corner changes its size.
struct InputView: View {
    let model: AppModel
    let openHistory: () -> Void
    let close: () -> Void
    @State private var draft = ""
    @State private var resizeStart: (mouse: NSPoint, size: InputBoxSize)?

    var body: some View {
        let scale = model.characterScale.textScale
        let fontSize = 13 * scale
        let box = model.inputBoxSize
        let ink = Comic.outline(scale)
        let shape = RoundedRectangle(cornerRadius: Comic.radius(scale))
        VStack(alignment: .leading, spacing: 6 * scale) {
            if model.status != .connected {
                StatusRow(model: model, scale: scale)
            }
            ForEach(model.conversation.outbox.filter { $0.status != .sending }) { item in
                FailedRow(item: item, scale: scale) { model.dismiss(requestId: item.requestId) }
            }
            HStack(alignment: .bottom, spacing: 6 * scale) {
                InputTextView(
                    text: $draft, fontSize: fontSize, onSubmit: send, onCancel: close,
                    onHeight: { height in if model.inputTextHeight != height { model.inputTextHeight = height } }
                )
                .frame(height: box.textHeight(content: model.inputTextHeight, minimum: InputTextView.lineHeight(fontSize: fontSize)))
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
                Button(action: openHistory) { Image(systemName: "clock.arrow.circlepath") }
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
        .overlay(alignment: .bottomTrailing) { grip.padding(2 * scale) }
        .padding(ink)
        .environment(\.colorScheme, .light)
    }

    /// Dragging right widens the box on both sides (it stays centered under the character); dragging down makes it taller.
    private var grip: some View {
        Image(systemName: "arrow.down.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(Comic.faint)
            .frame(width: 14, height: 14)
            .contentShape(Rectangle())
            .help("ドラッグで大きさを変える")
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        let mouse = NSEvent.mouseLocation
                        let start = resizeStart ?? (mouse, model.inputBoxSize)
                        resizeStart = start
                        model.inputBoxSize = InputBoxSize(
                            width: start.size.width + (mouse.x - start.mouse.x) * 2,
                            height: start.size.height + (start.mouse.y - mouse.y))
                    }
                    .onEnded { _ in resizeStart = nil })
    }

    private func send() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.send(draft)
        draft = ""
    }
}

/// The connection state and what to do about it, as the history shows it.
struct StatusRow: View {
    let model: AppModel
    let scale: Double

    var body: some View {
        HStack {
            Text(model.statusText).foregroundStyle(.secondary)
            Spacer()
            switch model.status {
            case .needsServer:
                Button("設定を開く") { model.openSettings() }.controlSize(.small)
            case .needsLogin:
                Button("GitHub でログイン") { Task { await model.login() } }.controlSize(.small)
            case .replaced, .stopped, .unavailable:
                Button("接続し直す") { model.resume() }.controlSize(.small)
            default:
                EmptyView()
            }
        }
        .font(Comic.font(11 * scale))
    }
}

private struct FailedRow: View {
    let item: OutgoingMessage
    let scale: Double
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            switch item.status {
            case .rejected(let code), .unavailable(let code):
                Text("「\(item.text)」を送れませんでした（\(code)）").foregroundStyle(.red).lineLimit(2)
            case .sending:
                EmptyView()
            }
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
