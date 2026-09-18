import AppKit
import NatsumiCore
import SwiftUI

/// The comic look of the character's panels: paper with a bold black outline and rounded lettering. The panels keep
/// the light appearance, so a balloon stays white with black text in dark mode too.
enum Comic {
    static let ink = Color.black
    static let paper = Color.white
    static let noticePaper = Color(nsColor: NSColor(srgbRed: 1.0, green: 0.9, blue: 0.42, alpha: 1))
    static let badge = Color(nsColor: NSColor(srgbRed: 1.0, green: 0.8, blue: 0.1, alpha: 1))
    static let faint = Color(nsColor: NSColor(white: 0.4, alpha: 1))

    static func outline(_ textScale: Double) -> CGFloat { max(1.5, 2.5 * textScale) }
    static func radius(_ textScale: Double) -> CGFloat { 14 * textScale }
    /// How far each card behind the front one is offset.
    static func edgeStep(_ textScale: Double) -> CGFloat { 5 * textScale }

    private static let roundedNames = ["HiraMaruProN-W4", "HiraMaruPro-W4"]

    /// Hiragino Maru Gothic when the Mac has it, otherwise the rounded system font.
    static func nsFont(_ size: CGFloat, bold: Bool = false) -> NSFont {
        if !bold, let name = roundedNames.first(where: { NSFont(name: $0, size: size) != nil }), let font = NSFont(name: name, size: size) {
            return font
        }
        let system = NSFont.systemFont(ofSize: size, weight: bold ? .bold : .medium)
        guard let descriptor = system.fontDescriptor.withDesign(.rounded) else { return system }
        return NSFont(descriptor: descriptor, size: size) ?? system
    }

    static func font(_ size: CGFloat, bold: Bool = false) -> Font {
        Font(nsFont(size, bold: bold))
    }
}

/// A card's drawing, inside a panel that is held open for it.
///
/// What animates on a Mac is a view inside a window, never the window itself: a window's frame is not interpolated
/// on the render server, and — the part that cost the most here — a window clips whatever is drawn in it. With the
/// panel sized to its drawing, every change became a window resize, and all that could be seen was the clipping.
/// So the panel is held at a size that fits both the drawing it has and the drawing it is going to, and the
/// drawing animates inside it, against the side the character is on, before the panel takes its exact size.
///
/// `.animation(_:value:)` and not `withAnimation`: the drawing is handed in by replacing a hosting view's root
/// view, which happens outside any transaction, so `withAnimation` around it does nothing at all.
struct CardPanel<Value: Equatable, Content: View>: View {
    let value: Value
    /// Where the character is, so the drawing keeps to that side of a panel that is larger than it.
    let anchor: Alignment
    let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: anchor)
            .animation(.easeInOut(duration: CardAnimation.duration), value: value)
    }
}

/// Cards behind the front one, offset away from the character, each with the same outline.
struct StackedEdges<S: Shape>: View {
    let count: Int
    let step: CGFloat
    /// Offsets go up (the column is upright) or down (flipped).
    let upward: Bool
    let fill: Color
    let lineWidth: CGFloat
    let shape: S

    var body: some View {
        ZStack {
            ForEach(Array(stride(from: count, to: 0, by: -1)), id: \.self) { i in
                ZStack {
                    shape.fill(fill)
                    shape.stroke(Comic.ink, lineWidth: lineWidth)
                }
                .offset(x: step * CGFloat(i), y: (upward ? -1 : 1) * step * CGFloat(i))
            }
        }
    }
}
