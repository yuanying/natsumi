import AppKit
import NatsumiCore
import SwiftUI

/// The yellow of notices, readable with the primary text color in both appearances.
enum NoticeColors {
    static let background = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.34, green: 0.28, blue: 0.05, alpha: 1)
            : NSColor(srgbRed: 1.0, green: 0.93, blue: 0.58, alpha: 1)
    })
    static let border = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.85, green: 0.7, blue: 0.2, alpha: 1)
            : NSColor(srgbRed: 0.85, green: 0.62, blue: 0.05, alpha: 1)
    })
    /// The badge keeps dark text on yellow in both appearances.
    static let badge = Color(nsColor: NSColor(srgbRed: 1.0, green: 0.8, blue: 0.1, alpha: 1))
}

/// Unchecked notices beside the character, apart from the replies: the oldest in front, the others stacked behind.
struct NoticeBundleView: View {
    let model: AppModel
    let openHistory: () -> Void

    static let maxWidth: CGFloat = 240
    static func edgeStep(_ textScale: Double) -> CGFloat { 5 * textScale }

    var body: some View {
        let scale = model.characterScale.textScale
        if let stack = model.notices.stack {
            let edges = stack.behind
            let step = Self.edgeStep(scale)
            card(stack, scale: scale)
                .padding(.horizontal, 10 * scale)
                .padding(.vertical, 8 * scale)
                .frame(maxWidth: Self.maxWidth * scale, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .background { cardShape(scale: scale) }
                // The notices behind show as edges below the front card.
                .padding(.bottom, step * CGFloat(edges))
                .background(alignment: .top) {
                    GeometryReader { geometry in
                        let size = geometry.size
                        let cardHeight = size.height - step * CGFloat(edges)
                        ForEach(Array((1...max(edges, 1)).reversed()), id: \.self) { i in
                            if i <= edges {
                                let inset = 10 * scale * CGFloat(i)
                                cardShape(scale: scale)
                                    .frame(width: max(size.width - inset * 2, 0), height: max(cardHeight, 0))
                                    .offset(x: inset, y: step * CGFloat(i))
                            }
                        }
                    }
                }
        }
    }

    private func cardShape(scale: Double) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10 * scale)
        return ZStack {
            shape.fill(NoticeColors.background)
            shape.stroke(NoticeColors.border, lineWidth: 1)
        }
    }

    @ViewBuilder
    private func card(_ stack: NoticeStack, scale: Double) -> some View {
        VStack(alignment: .leading, spacing: 4 * scale) {
            HStack(spacing: 6 * scale) {
                Label("お知らせ", systemImage: "bell.fill")
                    .font(.system(size: 10 * scale, weight: .semibold))
                if stack.more > 0 {
                    Text("あと \(stack.more) 件").font(.system(size: 10 * scale)).foregroundStyle(.secondary)
                }
            }
            Button(action: model.acknowledgeFrontNotice) {
                Group {
                    switch stack.front {
                    case .notice(let message):
                        Text(BalloonText.preview(message.text).text)
                    case .older(let ids):
                        Text("前の知らせが \(ids.count) 件あります（本文は履歴より前のため出せません）")
                    }
                }
                .font(.system(size: 12 * scale))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(stackHelp(stack))
            if case .notice(let message) = stack.front, BalloonText.preview(message.text).isTruncated {
                Button("続きは履歴で", action: openHistory)
                    .buttonStyle(.link)
                    .font(.system(size: 11 * scale))
            }
        }
    }

    private func stackHelp(_ stack: NoticeStack) -> String {
        if case .older = stack.front { return "クリックでまとめて確かめる" }
        return stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる"
    }
}
