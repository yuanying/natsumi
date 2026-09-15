import AppKit
import NatsumiCore
import SwiftUI

@MainActor
final class ConversationWindowController {
    private let window: NSWindow

    init(model: AppModel) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 480),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: true)
        window.title = "natsumi"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ConversationView(model: model))
    }

    func toggle(near anchor: NSRect?) {
        if window.isVisible { window.orderOut(nil) } else { show(near: anchor) }
    }

    /// Opens beside the character, on whichever side fits the screen.
    func show(near anchor: NSRect?) {
        if !window.isVisible, let anchor, let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchor) }) ?? NSScreen.main {
            let visible = screen.visibleFrame
            let size = window.frame.size
            var x = anchor.minX - size.width - 8
            if x < visible.minX { x = min(anchor.maxX + 8, visible.maxX - size.width) }
            let top = min(max(anchor.maxY, visible.minY + size.height), visible.maxY)
            window.setFrameTopLeftPoint(NSPoint(x: x, y: top))
        }
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }
}

struct ConversationView: View {
    let model: AppModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.conversation.messages) { MessageRow(message: $0) }
                        ForEach(model.conversation.outbox) { item in
                            OutgoingRow(item: item) { model.dismiss(requestId: item.requestId) }
                        }
                        if model.conversation.isThinking {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("考え中…").foregroundStyle(.secondary)
                            }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(12)
                }
                .onChange(of: model.conversation.messages.count) { proxy.scrollTo("bottom") }
                .onChange(of: model.conversation.outbox.count) { proxy.scrollTo("bottom") }
            }
            Divider()
            HStack {
                TextField("メッセージ", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(send)
                Button("送信", action: send)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(12)
        }
        .frame(minWidth: 280, minHeight: 320)
    }

    private var statusBar: some View {
        HStack {
            Text(model.statusText).font(.caption).foregroundStyle(.secondary)
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
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.send(text)
        draft = ""
    }
}

private struct MessageRow: View {
    let message: ShownMessage

    var body: some View {
        let isOwner = message.role == .owner
        HStack {
            if isOwner { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                if message.isNotice {
                    Label("お知らせ", systemImage: "bell").font(.caption2).foregroundStyle(.secondary)
                }
                Text(message.text).textSelection(.enabled)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(background(isOwner: isOwner), in: RoundedRectangle(cornerRadius: 10))
            if !isOwner { Spacer(minLength: 40) }
        }
    }

    private func background(isOwner: Bool) -> Color {
        if isOwner { return .accentColor.opacity(0.2) }
        return message.isNotice ? .yellow.opacity(0.2) : .gray.opacity(0.15)
    }
}

private struct OutgoingRow: View {
    let item: OutgoingMessage
    let dismiss: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 2) {
                Text(item.text)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                switch item.status {
                case .sending:
                    Text("受付中…").font(.caption2).foregroundStyle(.secondary)
                case .rejected(let code), .unavailable(let code):
                    HStack(spacing: 4) {
                        Text("送れませんでした（\(code)）").font(.caption2).foregroundStyle(.red)
                        Button(action: dismiss) { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
                    }
                }
            }
        }
    }
}
