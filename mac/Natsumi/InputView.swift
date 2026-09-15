import AppKit
import NatsumiCore
import SwiftUI

/// The text box under the character. Enter sends, Esc closes.
struct InputView: View {
    let model: AppModel
    let openHistory: () -> Void
    let close: () -> Void
    @State private var draft = ""

    static let width: CGFloat = 260

    var body: some View {
        let scale = model.characterScale.textScale
        VStack(alignment: .leading, spacing: 6 * scale) {
            if model.status != .connected {
                StatusRow(model: model, scale: scale)
            }
            ForEach(model.conversation.outbox.filter { $0.status != .sending }) { item in
                FailedRow(item: item, scale: scale) { model.dismiss(requestId: item.requestId) }
            }
            HStack(spacing: 6 * scale) {
                InputField(text: $draft, placeholder: "ナツミに話しかける", fontSize: 13 * scale, onSubmit: send, onCancel: close)
                Button(action: openHistory) { Image(systemName: "clock.arrow.circlepath") }
                    .buttonStyle(.borderless)
                    .help("履歴")
            }
        }
        .padding(8 * scale)
        .frame(width: Self.width * scale)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 10 * scale))
        .overlay(RoundedRectangle(cornerRadius: 10 * scale).stroke(Color.secondary.opacity(0.5)))
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
                SettingsLink { Text("設定を開く") }.controlSize(.small)
            case .needsLogin:
                Button("GitHub でログイン") { Task { await model.login() } }.controlSize(.small)
            case .replaced, .stopped, .unavailable:
                Button("接続し直す") { model.resume() }.controlSize(.small)
            default:
                EmptyView()
            }
        }
        .font(.system(size: 11 * scale))
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
        .font(.system(size: 11 * scale))
    }
}

/// An AppKit text field, so that the Enter that confirms Japanese input is left to the input method.
struct InputField: NSViewRepresentable {
    static let identifier = NSUserInterfaceItemIdentifier("natsumi.input")

    @Binding var text: String
    let placeholder: String
    let fontSize: CGFloat
    let onSubmit: () -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        field.identifier = Self.identifier
        field.placeholderString = placeholder
        field.bezelStyle = .roundedBezel
        field.cell?.isScrollable = true
        field.cell?.wraps = false
        field.delegate = context.coordinator
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        context.coordinator.parent = self
        if field.font?.pointSize != fontSize { field.font = .systemFont(ofSize: fontSize) }
        if let editor = field.currentEditor() as? NSTextView, editor.hasMarkedText() { return }
        if field.stringValue != text { field.stringValue = text }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: InputField

        init(_ parent: InputField) {
            self.parent = parent
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // While text is being composed, Enter and Esc belong to the input method.
            guard !textView.hasMarkedText() else { return false }
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
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
