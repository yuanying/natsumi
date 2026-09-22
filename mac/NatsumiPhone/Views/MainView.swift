import NatsumiCore
import SwiftUI

/// The main screen: the connection at the top, the notices under it, her balloon over her, and the input field at
/// the bottom. It is the only screen where she moves.
struct MainView: View {
    let props: PhoneMainProps
    let sinks: ScreenSinks

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                StatusView(props: props.status, send: sinks.status)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            if let notices = props.notices {
                NoticeCardView(props: notices)
                    .padding(.horizontal, 16)
                    .padding(.top, 16)
            }

            // The balloon takes what her standing place leaves, and only its own text scrolls when that is not
            // enough; the character and the input field stay where they are. When the room is short (the keyboard
            // is up), she gives up to half of it so that what she said can still be read.
            GeometryReader { room in
                VStack(spacing: 16) {
                    Spacer(minLength: 0)
                    switch props.balloon {
                    case .reply(let reply):
                        ReplyBalloonView(props: reply, send: sinks.balloon)
                    case .thought(let thinking):
                        ThoughtBubbleView(props: thinking)
                    case nil:
                        EmptyView()
                    }
                    CharacterView(props: props.character, maxHeight: room.size.height / 2)
                }
                .frame(width: room.size.width, height: room.size.height)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            ForEach(props.failures) { failure in
                FailureRow(props: failure, send: sinks.failures)
            }
            InputBar(send: sinks.input)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
    }
}

/// Where the connection stands: a dot and a line, and a button when there is something to do about it.
struct StatusView: View {
    let props: PhoneStatusProps
    let send: PhoneEventSink

    var body: some View {
        let pill = HStack(spacing: 8) {
            Circle().fill(dot).frame(width: 8, height: 8)
            Text(props.text).lineLimit(1)
            if let action = props.action {
                Text(action.title).underline()
            }
        }
        .font(Comic.font(13))
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background { InkedPaper(shape: Capsule(), fill: Comic.surface, ink: Comic.pageInk, line: 2) }

        if let action = props.action {
            Button { send(action.event) } label: { pill }
                .buttonStyle(.plain)
        } else {
            pill
        }
    }

    private var dot: Color {
        switch props.tone {
        case .connected: Comic.connected
        case .waiting: Comic.waiting
        case .trouble: Comic.trouble
        }
    }
}

/// The yellow card of the notice in front, with the edges of those behind it.
struct NoticeCardView: View {
    let props: PhoneNoticeProps

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("お知らせ")
                Spacer()
                Text(props.count).foregroundStyle(Comic.noticeCount)
            }
            .font(Comic.font(12, bold: true))
            Text(props.text)
                .font(Comic.font(14))
                .lineLimit(1)
        }
        .foregroundStyle(Comic.ink)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background {
            ZStack {
                ForEach(Array(stride(from: props.edges, to: 0, by: -1)), id: \.self) { i in
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.notice)
                        .padding(.horizontal, 6 * CGFloat(i))
                        .offset(y: 5 * CGFloat(i))
                }
                InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.notice)
            }
        }
        .padding(.bottom, 5 * CGFloat(props.edges))
    }
}

/// Her last reply, whole. The text scrolls inside the balloon when it is longer than the room it has.
struct ReplyBalloonView: View {
    let props: PhoneReplyProps
    let send: PhoneEventSink

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(props.header)
                    .font(Comic.font(12))
                    .foregroundStyle(Comic.faint)
                Spacer()
                Button { send(.balloonCloseTapped) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Comic.ink)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("既読にして閉じる")
                .padding(.vertical, -10)
            }
            ViewThatFits(in: .vertical) {
                text
                ScrollView { text }
                    .scrollIndicators(.visible)
            }
            if let thinking = props.thinking {
                ThinkingLine(props: thinking, size: 12)
                    .padding(.top, 6)
                    .overlay(alignment: .top) { Rectangle().fill(Comic.rule).frame(height: 2) }
            }
        }
        .foregroundStyle(Comic.ink)
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .padding(.top, 6)
        .padding(.bottom, 12 + 9)
        .background { InkedPaper(shape: SpeechBalloonShape()) }
    }

    private var text: some View {
        Text(props.text)
            .font(Comic.font(16))
            .lineSpacing(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.trailing, 12)
            .textSelection(.enabled)
    }
}

/// The comic thought bubble while she is receiving or thinking, with small circles leading down to her.
struct ThoughtBubbleView: View {
    let props: ThinkingProps

    var body: some View {
        ThinkingLine(props: props, size: 14)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(width: 260, alignment: .leading)
            .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 26)) }
            .overlay(alignment: .bottom) {
                ZStack(alignment: .topLeading) {
                    InkedPaper(shape: Circle()).frame(width: 14, height: 14)
                    InkedPaper(shape: Circle(), line: 2).frame(width: 8, height: 8).offset(x: 10, y: 14)
                }
                .frame(width: 24, height: 24, alignment: .topLeading)
                .offset(y: 26)
            }
            .padding(.bottom, 22)
    }
}

/// What she is thinking in one line: the line she is writing, or what she is doing until one arrives.
struct ThinkingLine: View {
    let props: ThinkingProps
    let size: CGFloat

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "ellipsis")
                .font(.system(size: size, weight: .bold))
            Text(props.line ?? "\(props.label)…")
                .font(Comic.font(size))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(Comic.faint)
    }
}

/// She stands on a little shadow of a floor, in the frame of the animation her face calls for.
struct CharacterView: View {
    let props: PhoneCharacterProps
    /// The most she and her floor may take; she is drawn smaller rather than pushed out.
    var maxHeight: CGFloat = .infinity

    /// A cell of the spritesheet is 192×208 pixels.
    private static let fullSize = CGSize(width: 176, height: 176 * 208 / 192)
    private static let floor: CGFloat = 12 + 6

    private var size: CGSize {
        let scale = min(1, max(0, maxHeight - Self.floor) / Self.fullSize.height)
        return CGSize(width: Self.fullSize.width * scale, height: Self.fullSize.height * scale)
    }

    var body: some View {
        let size = size
        VStack(spacing: 6) {
            switch props.avatar {
            case .sprite(let asset):
                TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
                    Image(
                        decorative: asset.frame(
                            for: props.expression, elapsed: context.date.timeIntervalSinceReferenceDate),
                        scale: 1
                    )
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width, height: size.height)
                }
            case .placeholder:
                Text(PlaceholderArt.symbol(for: props.expression))
                    .font(.system(size: 96 * size.height / Self.fullSize.height))
                    .frame(width: size.width, height: size.height)
            }
            Ellipse().fill(Comic.floor).frame(width: 140, height: 12)
        }
        .accessibilityElement()
        .accessibilityLabel("なつみ")
    }
}

/// A message that could not be recorded, with its ×.
struct FailureRow: View {
    let props: FailureProps
    let send: PhoneEventSink

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(props.text).lineLimit(2)
            Spacer(minLength: 0)
            Button { send(.outgoingDismissed(requestId: props.requestId)) } label: {
                Image(systemName: "xmark").frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("消す")
        }
        .font(Comic.font(13))
        .foregroundStyle(Comic.trouble)
        .padding(.horizontal, 20)
    }
}

/// The text field and the yellow send button.
struct InputBar: View {
    let send: PhoneEventSink

    /// What the owner is typing. The input method keeps what it is converting on its own side, so the text belongs
    /// to the field until it is sent.
    @State private var draft = ""

    var body: some View {
        let isEmpty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        HStack(alignment: .bottom, spacing: 10) {
            TextField("話しかける", text: $draft, axis: .vertical)
                .font(Comic.font(16))
                .lineLimit(1...5)
                .padding(.horizontal, 18)
                .padding(.vertical, 13)
                .frame(minHeight: 50)
                .background {
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 25), fill: Comic.surface, ink: Comic.pageInk)
                }
            Button {
                send(.inputSubmitted(draft))
                draft = ""
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(isEmpty ? Comic.disabledInk : Comic.ink)
                    .frame(width: 50, height: 50)
                    .background {
                        InkedPaper(
                            shape: Circle(), fill: isEmpty ? Comic.disabled : Comic.send,
                            ink: isEmpty ? Comic.disabledInk : Comic.ink)
                    }
            }
            .buttonStyle(.plain)
            .disabled(isEmpty)
            .accessibilityLabel("送る")
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}
