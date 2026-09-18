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

/// A card's drawing: it animates itself when its drawing parameters change, and says how big it has become so that
/// its panel can follow.
///
/// The panel is not what animates. Animating the window and swapping the drawing over in one go never worked: the
/// window is what clips the drawing, so one direction looked like a reveal and the other like nothing at all.
/// `withAnimation` around the root view of a hosting view does nothing either — the change happens outside that
/// transaction. `.animation(_:value:)` is attached to the drawing itself, so it animates whenever its parameters
/// change, however they were handed in.
struct CardPanel<Value: Equatable, Content: View>: View {
    let value: Value
    let content: Content
    let onSize: (CGSize) -> Void

    var body: some View {
        content
            .animation(.easeInOut(duration: CardAnimation.duration), value: value)
            .onGeometryChange(for: CGSize.self) { $0.size } action: { onSize($0) }
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
