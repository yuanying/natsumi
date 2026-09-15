import NatsumiCore
import SwiftUI

/// The whole conversation, opened only when the owner wants to look back.
struct HistoryView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            StatusRow(model: model, scale: 1)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.conversation.messages) { MessageRow(message: $0, isUnread: model.conversation.isUnread($0)) }
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
                .onAppear { proxy.scrollTo("bottom") }
                .onChange(of: model.conversation.messages.count) { proxy.scrollTo("bottom") }
                .onChange(of: model.conversation.outbox.count) { proxy.scrollTo("bottom") }
            }
        }
        .frame(minWidth: 280, minHeight: 240)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct MessageRow: View {
    let message: ShownMessage
    /// An unread reply or a notice not checked yet. Opening the history does not read it.
    let isUnread: Bool

    var body: some View {
        let isOwner = message.role == .owner
        HStack(alignment: .top) {
            if isOwner { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                if message.isNotice || isUnread {
                    HStack(spacing: 6) {
                        if message.isNotice {
                            Label("お知らせ", systemImage: "bell.fill").font(Comic.font(10, bold: true))
                        }
                        if isUnread {
                            Label(message.isNotice ? "未確認" : "未読", systemImage: "circle.fill")
                                .font(Comic.font(10, bold: true))
                                .foregroundStyle(message.isNotice ? Color.orange : Color.blue)
                        }
                    }
                    .foregroundStyle(Comic.ink)
                }
                Text(message.text).font(Comic.font(13)).lineSpacing(3).textSelection(.enabled)
            }
            .foregroundStyle(isOwner ? Color.primary : Comic.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background {
                // natsumi's words look like her balloons: paper or yellow with the ink outline.
                let shape = RoundedRectangle(cornerRadius: Comic.radius(1))
                if isOwner {
                    shape.fill(Color.accentColor.opacity(0.2))
                } else {
                    shape.fill(message.isNotice ? Comic.noticePaper : Comic.paper)
                    shape.stroke(Comic.ink, lineWidth: 1.5)
                }
            }
            .padding(1)
            if !isOwner { Spacer(minLength: 40) }
        }
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
