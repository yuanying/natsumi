import AppKit
import NatsumiCore
import SwiftUI

/// The conversation window (ADR 0021): the connection's state, the history when it is unfolded, and the input
/// field at the bottom. Enter sends and Shift+Enter starts a new line; the window itself takes ⌘L and ⌘W.
struct ConversationView: View {
    let props: ConversationProps
    let field: EventSink
    let toggle: EventSink
    let send: EventSink

    /// The title bar and the status row: what the folded window has above its input field.
    static let statusRowHeight: CGFloat = 30
    static let titleBarHeight: CGFloat = NSWindow.frameRect(
        forContentRect: .zero, styleMask: [.titled, .closable, .resizable]
    ).height

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                StatusRow(props: props.status, send: send)
                Button { toggle(.historyToggleRequested) } label: {
                    Image(systemName: props.history == nil ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .bold))
                }
                .buttonStyle(.borderless)
                .help(props.toggleHelp)
            }
            .padding(.horizontal, 12)
            .frame(height: Self.statusRowHeight)
            Divider()
            if let history = props.history {
                HistoryList(props: history, send: send)
                Divider()
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(props.failures) { failure in
                    FailedRow(props: failure) { send(.outgoingDismissed(requestId: failure.requestId)) }
                }
                InputField(field: field)
            }
            .padding(8)
            // Folded, the input field has whatever the window gives it; unfolded, it keeps that height and the
            // history takes the rest.
            .frame(height: props.history == nil ? nil : inputHeight)
        }
        .frame(minWidth: ConversationWindow.minWidth, minHeight: 60)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var inputHeight: CGFloat {
        max(props.foldedHeight - Self.titleBarHeight - Self.statusRowHeight - 1, 60)
    }
}

/// The text box and its placeholder. The draft is drawing-local on purpose: while an input method is composing,
/// the text belongs to the text view and must not travel through the tree.
private struct InputField: View {
    let field: EventSink
    @State private var draft = ""

    var body: some View {
        InputTextView(text: $draft, onSubmit: submit)
            .overlay(alignment: .topLeading) {
                if draft.isEmpty {
                    Text("話しかける（Shift+Enter で改行）")
                        .foregroundStyle(.tertiary)
                        .padding(.leading, InputTextView.inset.width + 5)
                        .padding(.top, InputTextView.inset.height)
                        .allowsHitTesting(false)
                }
            }
            .font(Comic.font(13))
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(nsColor: .separatorColor)))
    }

    /// An empty draft is not a message: nothing is raised and what was typed stays.
    private func submit() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        field(.inputSubmitted(draft))
        draft = ""
    }
}

/// The connection state and what to do about it. It is always there, even when the connection is fine.
private struct StatusRow: View {
    let props: StatusProps
    let send: EventSink

    var body: some View {
        HStack {
            Text(props.text).foregroundStyle(.secondary)
            Spacer()
            if let action = props.action {
                Button(action.title) { send(action.event) }.controlSize(.small)
            }
        }
        .font(Comic.font(11))
    }
}

private struct FailedRow: View {
    let props: FailureProps
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(props.text).foregroundStyle(.red).lineLimit(2)
            Spacer(minLength: 0)
            Button(action: dismiss) { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
        }
        .font(Comic.font(11))
    }
}

/// The whole conversation, newest at the bottom, kept scrolled to the end as it grows.
private struct HistoryList: View {
    let props: HistoryProps
    let send: EventSink

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(props.rows) { row in
                        MessageRow(props: row, avatar: props.avatar)
                            // What the owner has in sight is what they have read, while the window is theirs
                            // (ADR 0022). Half a row showing counts as seeing it.
                            .onScrollVisibilityChange(threshold: 0.5) { isVisible in
                                send(.historyRowVisibilityChanged(messageId: row.messageId, isVisible: isVisible))
                            }
                    }
                    ForEach(props.outgoing) { item in
                        OutgoingRow(props: item) { send(.outgoingDismissed(requestId: item.requestId)) }
                    }
                    if props.isThinking {
                        HStack(spacing: 6) {
                            FaceView(expression: .thinking, size: FaceView.small, avatar: props.avatar)
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
        .frame(maxHeight: .infinity)
    }
}

private struct MessageRow: View {
    let props: HistoryRowProps
    let avatar: AvatarArt

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if props.isOwner { Spacer(minLength: 40) }
            if let face = props.face {
                FaceView(expression: face.expression, size: face.isLarge ? FaceView.large : FaceView.small, avatar: avatar)
                    .help(face.help)
                    // Level with the bottom of the bubble, not with the time under it.
                    .padding(.bottom, props.time == nil ? 0 : 16)
            }
            VStack(alignment: props.isOwner ? .trailing : .leading, spacing: 2) {
                bubble
                // When it was said stays out of the way: small and faint, under the bubble on its side.
                if let time = props.time {
                    Text(time).font(.caption2).foregroundStyle(.tertiary).padding(.horizontal, 4)
                }
            }
            if !props.isOwner { Spacer(minLength: 40) }
        }
    }

    private var bubble: some View {
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
    }
}

/// Her face for a feeling, round with the ink outline. A feeling that is not known is her neutral face, faded, so it
/// reads as "not recorded" rather than as calm (ADR 0027). Without even that face, a dashed circle stands in.
private struct FaceView: View {
    static let small: CGFloat = 28
    static let large: CGFloat = 52
    static let unknownOpacity = 0.4

    let expression: NatsumiCore.Expression?
    let size: CGFloat
    let avatar: AvatarArt

    var body: some View {
        if case .sprite(let asset) = avatar, let icon = asset.icon(for: expression ?? .neutral) {
            Image(decorative: icon, scale: 1)
                .resizable()
                .interpolation(.high)
                .scaledToFill()
                .frame(width: size, height: size)
                .background(Comic.paper)
                .clipShape(Circle())
                .overlay(Circle().stroke(Comic.ink, lineWidth: 1.5))
                .opacity(expression == nil ? Self.unknownOpacity : 1)
                .accessibilityHidden(true)
        } else {
            Circle()
                .fill(Comic.paper)
                .overlay(Circle().stroke(Comic.faint, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])))
                .overlay(Text("な").font(Comic.font(size * 0.4, bold: true)).foregroundStyle(Comic.faint))
                .frame(width: size, height: size)
                .accessibilityHidden(true)
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
