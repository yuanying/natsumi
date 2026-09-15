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
}
