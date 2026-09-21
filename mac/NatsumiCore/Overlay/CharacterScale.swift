import CoreGraphics
import Foundation

/// How large the character is drawn, from 50% to 200% in 25% steps.
public struct CharacterScale: Equatable, Sendable {
    public static let range: ClosedRange<Double> = 0.5...2
    public static let step = 0.25
    public static let `default` = CharacterScale(1)
    /// One cell of the spritesheet is 2x pixels, so at 100% it is drawn at half its pixel size.
    public static let baseArtSize = CGSize(width: 96, height: 104)
    /// Text grows and shrinks with the character, but stays readable.
    static let textRange: ClosedRange<Double> = 0.85...1.4

    public let value: Double

    public init(_ value: Double) {
        guard value.isFinite else {
            self.value = 1
            return
        }
        let stepped = (value / Self.step).rounded() * Self.step
        self.value = min(max(stepped, Self.range.lowerBound), Self.range.upperBound)
    }

    public var percent: Int { Int((value * 100).rounded()) }

    public var artSize: CGSize {
        CGSize(width: Self.baseArtSize.width * value, height: Self.baseArtSize.height * value)
    }

    public var textScale: Double { min(max(value, Self.textRange.lowerBound), Self.textRange.upperBound) }
}

/// The look of the character and its conversation, kept in the settings. Nothing here is secret.
public struct OverlaySettings {
    public static let characterScaleKey = "characterScale"
    /// The widest a panel in the column may be (ADR 0010). Until ADR 0021 it was the input field's width, and the
    /// input field's saved size is what it is read from when nothing has been saved under its own key.
    public static let columnWidthKey = "columnWidth"
    public static let conversationWindowKey = "conversationWindow"
    /// Where earlier versions saved the input field's width and height (ADR 0010).
    public static let legacyInputBoxSizeKey = "inputBoxSize"

    public static let columnWidthRange: ClosedRange<CGFloat> = 200...640
    public static let defaultColumnWidth: CGFloat = 280
    /// What the input field's box had around its text: the title bar, the status row and the paddings the window
    /// has instead. Only for reading an old size as a folded height once.
    static let legacyChrome: CGFloat = 84

    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var characterScale: CharacterScale {
        get {
            guard let number = defaults.object(forKey: Self.characterScaleKey) as? NSNumber else { return .default }
            return CharacterScale(number.doubleValue)
        }
        nonmutating set { defaults.set(newValue.value, forKey: Self.characterScaleKey) }
    }

    public var columnWidth: CGFloat {
        get {
            let saved = (defaults.object(forKey: Self.columnWidthKey) as? NSNumber).map { CGFloat($0.doubleValue) }
                ?? legacyInputBoxSize?.width
            guard let saved, saved.isFinite else { return Self.defaultColumnWidth }
            return min(max(saved, Self.columnWidthRange.lowerBound), Self.columnWidthRange.upperBound)
        }
        nonmutating set { defaults.set(Double(newValue), forKey: Self.columnWidthKey) }
    }

    public var conversationWindow: ConversationWindow {
        get {
            guard let saved = defaults.dictionary(forKey: Self.conversationWindowKey) else {
                // The input field's size is the nearest thing an earlier version kept: its width, and its box as
                // the folded height.
                guard let legacy = legacyInputBoxSize else { return .default }
                return ConversationWindow(
                    origin: nil, width: legacy.width, foldedHeight: legacy.height + Self.legacyChrome,
                    unfoldedHeight: ConversationWindow.default.unfoldedHeight, showsHistory: false)
            }
            func number(_ key: String) -> CGFloat? { (saved[key] as? NSNumber).map { CGFloat($0.doubleValue) } }
            func point(_ key: String) -> CGPoint? {
                guard let pair = saved[key] as? [NSNumber], pair.count == 2 else { return nil }
                return CGPoint(x: pair[0].doubleValue, y: pair[1].doubleValue)
            }
            var window = ConversationWindow(
                origin: point("origin"), width: number("width") ?? .nan, foldedHeight: number("foldedHeight") ?? .nan,
                unfoldedHeight: number("unfoldedHeight") ?? .nan,
                showsHistory: (saved["showsHistory"] as? NSNumber)?.boolValue ?? false)
            window.foldedOrigin = point("foldedOrigin")
            if let rect = saved["unfoldedFrame"] as? [NSNumber], rect.count == 4 {
                window.unfoldedFrame = CGRect(
                    x: rect[0].doubleValue, y: rect[1].doubleValue, width: rect[2].doubleValue, height: rect[3].doubleValue)
            }
            return window
        }
        nonmutating set {
            var saved: [String: Any] = [
                "width": Double(newValue.width), "foldedHeight": Double(newValue.foldedHeight),
                "unfoldedHeight": Double(newValue.unfoldedHeight), "showsHistory": newValue.showsHistory,
            ]
            func store(_ point: CGPoint?, as key: String) {
                if let point { saved[key] = [Double(point.x), Double(point.y)] }
            }
            store(newValue.origin, as: "origin")
            store(newValue.foldedOrigin, as: "foldedOrigin")
            if let rect = newValue.unfoldedFrame {
                saved["unfoldedFrame"] = [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
            }
            defaults.set(saved, forKey: Self.conversationWindowKey)
        }
    }

    private var legacyInputBoxSize: (width: CGFloat, height: CGFloat)? {
        guard let pair = defaults.array(forKey: Self.legacyInputBoxSizeKey) as? [NSNumber], pair.count == 2,
              pair[0].doubleValue.isFinite, pair[1].doubleValue.isFinite
        else { return nil }
        return (CGFloat(pair[0].doubleValue), CGFloat(pair[1].doubleValue))
    }
}
