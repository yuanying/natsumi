import NatsumiCore
import SwiftUI
import UIKit

/// The comic look carried over from the Mac: black ink outlines, white paper balloons, yellow notices and rounded
/// lettering. The page follows light and dark; her balloons and the notices stay paper-white and yellow in both.
enum Comic {
    static let ink = Color(rgb: 0x141414)
    static let paper = Color.white
    static let notice = Color(rgb: 0xFFE66B)
    static let noticeCount = Color(rgb: 0x4D4630)
    static let send = Color(rgb: 0xFFCC1A)
    /// Grey lettering on paper.
    static let faint = Color(rgb: 0x6B6660)
    static let rule = Color(rgb: 0xEFE9DE)
    static let connected = Color(rgb: 0x2F8F55)
    static let waiting = Color(rgb: 0xC9951C)
    static let trouble = Color(rgb: 0xB3261E)

    static let page = Color(light: 0xF4EFE6, dark: 0x181714)
    static let pageInk = Color(light: 0x141414, dark: 0xF2EEE6)
    /// Controls on the page: white on the light page, a little lighter than the page on the dark one.
    static let surface = Color(light: 0xFFFFFF, dark: 0x26231F)
    static let pageFaint = Color(light: 0x5E5953, dark: 0xA8A198)
    static let floor = Color(light: 0xE3DBCC, dark: 0x2E2A25)
    static let disabled = Color(light: 0xEDE6D8, dark: 0x2E2A25)
    static let disabledInk = Color(rgb: 0x8A847C)

    static let outline: CGFloat = 2.5

    /// Hiragino Maru Gothic, which iOS has; the rounded system font for bold, which it has no weight of.
    static func font(_ size: CGFloat, bold: Bool = false) -> Font {
        if !bold, UIFont(name: "HiraMaruProN-W4", size: size) != nil { return .custom("HiraMaruProN-W4", size: size) }
        return .system(size: size, weight: bold ? .bold : .medium, design: .rounded)
    }
}

extension Color {
    init(rgb: UInt32) {
        self.init(
            .sRGB, red: Double(rgb >> 16 & 0xFF) / 255, green: Double(rgb >> 8 & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(Color(rgb: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }
}

/// A speech balloon: a rounded box with a tail pointing down at her from the middle of its bottom edge.
struct SpeechBalloonShape: Shape {
    var radius: CGFloat = 16
    var tailWidth: CGFloat = 16
    var tailHeight: CGFloat = 9

    func path(in rect: CGRect) -> Path {
        let box = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height - tailHeight)
        let r = min(radius, box.height / 2, box.width / 2)
        var path = Path()
        path.move(to: CGPoint(x: box.minX + r, y: box.minY))
        path.addLine(to: CGPoint(x: box.maxX - r, y: box.minY))
        path.addArc(tangent1End: CGPoint(x: box.maxX, y: box.minY), tangent2End: CGPoint(x: box.maxX, y: box.maxY), radius: r)
        path.addArc(tangent1End: CGPoint(x: box.maxX, y: box.maxY), tangent2End: CGPoint(x: box.minX, y: box.maxY), radius: r)
        path.addLine(to: CGPoint(x: box.midX + tailWidth / 2, y: box.maxY))
        path.addLine(to: CGPoint(x: box.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: box.midX - tailWidth / 2, y: box.maxY))
        path.addArc(tangent1End: CGPoint(x: box.minX, y: box.maxY), tangent2End: CGPoint(x: box.minX, y: box.minY), radius: r)
        path.addArc(tangent1End: CGPoint(x: box.minX, y: box.minY), tangent2End: CGPoint(x: box.maxX, y: box.minY), radius: r)
        path.closeSubpath()
        return path
    }
}

/// Paper with the ink outline, in the shape given.
struct InkedPaper<S: Shape>: View {
    let shape: S
    var fill: Color = Comic.paper
    var ink: Color = Comic.ink
    var line: CGFloat = Comic.outline

    var body: some View {
        ZStack {
            shape.fill(fill)
            shape.stroke(ink, lineWidth: line)
        }
    }
}

/// Her face for a feeling, cut round with an ink outline (ADR 0027). An avatar without that face draws a dotted
/// circle with 「な」 in it.
struct FaceView: View {
    let avatar: AvatarArt
    let expression: NatsumiCore.Expression
    let size: CGFloat

    var body: some View {
        Group {
            if case .sprite(let asset) = avatar, let icon = asset.icon(for: expression) {
                Image(decorative: icon, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .background(Comic.paper)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Comic.ink, lineWidth: Comic.outline))
            } else {
                Text("な")
                    .font(Comic.font(size * 0.4, bold: true))
                    .foregroundStyle(Comic.pageFaint)
                    .frame(width: size, height: size)
                    .overlay(Circle().stroke(Comic.pageInk, style: StrokeStyle(lineWidth: 2, dash: [5, 4])))
            }
        }
        .accessibilityHidden(true)
    }
}
