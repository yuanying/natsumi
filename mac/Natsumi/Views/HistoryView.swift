import NatsumiCore
import SwiftUI

/// The whole conversation, opened only when the owner wants to look back.
struct HistoryView: View {
    let props: HistoryProps?
    let send: EventSink

    var body: some View {
        if let props {
            VStack(spacing: 0) {
                StatusRow(props: props.status, scale: 1, send: send)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(props.rows) { MessageRow(props: $0) }
                            ForEach(props.outgoing) { item in
                                OutgoingRow(props: item) { send(.outgoingDismissed(requestId: item.requestId)) }
                            }
                            if props.isThinking {
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
                    .onChange(of: props.rows.count) { proxy.scrollTo("bottom") }
                    .onChange(of: props.outgoing.count) { proxy.scrollTo("bottom") }
                }
            }
            .frame(minWidth: 280, minHeight: 240)
            .background(Color(nsColor: .windowBackgroundColor))
        }
    }
}

private struct MessageRow: View {
    let props: HistoryRowProps

    var body: some View {
        HStack(alignment: .top) {
            if props.isOwner { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                if props.isNotice || props.isUnread {
                    HStack(spacing: 6) {
                        if props.isNotice {
                            Label("お知らせ", systemImage: "bell.fill").font(Comic.font(10, bold: true))
                        }
                        if props.isUnread {
                            Label(props.isNotice ? "未確認" : "未読", systemImage: "circle.fill")
                                .font(Comic.font(10, bold: true))
                                .foregroundStyle(props.isNotice ? Color.orange : Color.blue)
                        }
                    }
                    .foregroundStyle(Comic.ink)
                }
                Text(props.text).font(Comic.font(13)).lineSpacing(3).textSelection(.enabled)
            }
            .foregroundStyle(props.isOwner ? Color.primary : Comic.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background {
                // natsumi's words look like her balloons: paper or yellow with the ink outline.
                let shape = RoundedRectangle(cornerRadius: Comic.radius(1))
                if props.isOwner {
                    shape.fill(Color.accentColor.opacity(0.2))
                } else {
                    shape.fill(props.isNotice ? Comic.noticePaper : Comic.paper)
                    shape.stroke(Comic.ink, lineWidth: 1.5)
                }
            }
            .padding(1)
            if !props.isOwner { Spacer(minLength: 40) }
        }
    }
}

private struct OutgoingRow: View {
    let props: OutgoingRowProps
    let dismiss: () -> Void

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 2) {
                Text(props.text)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                if let failure = props.failure {
                    HStack(spacing: 4) {
                        Text(failure).font(.caption2).foregroundStyle(.red)
                        Button(action: dismiss) { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
                    }
                } else {
                    Text("受付中…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}
