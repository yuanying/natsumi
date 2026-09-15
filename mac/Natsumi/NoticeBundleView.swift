import NatsumiCore
import SwiftUI

/// Unchecked notices at the far end of the column: yellow comic cards, the oldest in front, the others stacked behind.
struct NoticeBundleView: View {
    let model: AppModel
    let placement: ColumnPlacement
    let openHistory: () -> Void

    var body: some View {
        let scale = model.characterScale.textScale
        if let stack = model.notices.stack {
            let edges = min(stack.behind, placement.budget.behind)
            let step = Comic.edgeStep(scale)
            let ink = Comic.outline(scale)
            // Cards behind go away from the character: up in the upright column, down when it is flipped.
            let upward = placement.tail == .down
            let shape = RoundedRectangle(cornerRadius: Comic.radius(scale))
            card(stack, scale: scale)
                .padding(.horizontal, 14 * scale)
                .padding(.vertical, 10 * scale)
                .frame(maxWidth: max(placement.width - step * CGFloat(edges) - ink * 2, 80), alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .background {
                    StackedEdges(count: edges, step: step, upward: upward, fill: Comic.noticePaper, lineWidth: ink, shape: shape)
                    shape.fill(Comic.noticePaper)
                    shape.stroke(Comic.ink, lineWidth: ink)
                }
                .padding(.trailing, step * CGFloat(edges))
                .padding(upward ? .top : .bottom, step * CGFloat(edges))
                .padding(ink)
                .environment(\.colorScheme, .light)
        }
    }

    @ViewBuilder
    private func card(_ stack: NoticeStack, scale: Double) -> some View {
        VStack(alignment: .leading, spacing: 4 * scale) {
            HStack(spacing: 6 * scale) {
                Image(systemName: "bell.fill").font(.system(size: 10 * scale, weight: .bold))
                Text("お知らせ").font(Comic.font(11 * scale, bold: true))
                if stack.more > 0 {
                    Text("あと \(stack.more) 件").font(Comic.font(11 * scale, bold: true)).foregroundStyle(Comic.faint)
                }
            }
            .foregroundStyle(Comic.ink)
            Button(action: model.acknowledgeFrontNotice) {
                Group {
                    switch stack.front {
                    case .notice(let message):
                        Text(BalloonText.preview(message.text).text)
                    case .older(let ids):
                        Text("前の知らせが \(ids.count) 件あります（本文は履歴より前のため出せません）")
                    }
                }
                .font(Comic.font(13 * scale))
                .lineSpacing(3 * scale)
                .foregroundStyle(Comic.ink)
                .lineLimit(placement.budget.lines)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(stackHelp(stack))
            if case .notice(let message) = stack.front, BalloonText.preview(message.text).isTruncated || placement.budget.lines < BalloonText.maxLines {
                Button("続きは履歴で", action: openHistory)
                    .buttonStyle(.link)
                    .font(Comic.font(11 * scale))
            }
        }
    }

    private func stackHelp(_ stack: NoticeStack) -> String {
        if case .older = stack.front { return "クリックでまとめて確かめる" }
        return stack.more > 0 ? "クリックで確かめて次へ" : "クリックで確かめて閉じる"
    }
}
