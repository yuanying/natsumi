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

/// The size the owner gave the input field: its width and the height of its text area. It is kept apart from the
/// character's scale.
public struct InputBoxSize: Equatable, Sendable {
    public static let widthRange: ClosedRange<Double> = 200...640
    public static let heightRange: ClosedRange<Double> = 40...400
    /// How tall the text area grows with its lines when the chosen height is smaller; beyond it, the text scrolls.
    public static let growthLimit: Double = 160
    public static let `default` = InputBoxSize(width: 280, height: 40)

    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        guard width.isFinite, height.isFinite else {
            self.width = 280
            self.height = 40
            return
        }
        self.width = min(max(width, Self.widthRange.lowerBound), Self.widthRange.upperBound)
        self.height = min(max(height, Self.heightRange.lowerBound), Self.heightRange.upperBound)
    }

    /// The text area is at least the chosen height (and one line), grows with its lines, and stops at the larger of
    /// the growth limit and the chosen height.
    public func textHeight(content: CGFloat, minimum: CGFloat) -> CGFloat {
        let floor = max(height, minimum)
        return min(max(content, floor), max(floor, Self.growthLimit))
    }
}

/// The look of the character and its conversation, kept in the settings. Nothing here is secret.
public struct OverlaySettings {
    public static let characterScaleKey = "characterScale"
    public static let inputBoxSizeKey = "inputBoxSize"

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

    public var inputBoxSize: InputBoxSize {
        get {
            guard let pair = defaults.array(forKey: Self.inputBoxSizeKey) as? [NSNumber], pair.count == 2 else { return .default }
            return InputBoxSize(width: pair[0].doubleValue, height: pair[1].doubleValue)
        }
        nonmutating set { defaults.set([newValue.width, newValue.height], forKey: Self.inputBoxSizeKey) }
    }
}
