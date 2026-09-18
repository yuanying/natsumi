import NatsumiCore
import SwiftUI

/// The stage: one transparent view the size of the screen, with the character and her cards placed on it at the
/// frames the layout gave them.
///
/// Everything that moves on a Mac is a view inside a window; a window's own frame is not interpolated by the render
/// server, and it clips what is drawn in it. So the window stays put and covers the screen, and what the owner sees
/// move — a card opening, the column settling around it, the character running with her cards beside her — is
/// these views changing frame in one animation, on one clock. `.animation(_:value:)` rather than `withAnimation`:
/// the drawing is handed in by replacing the hosting view's root view, which happens outside any transaction.
struct StageView<Character: View, Balloon: View, Notices: View>: View {
    let props: StageProps
    let character: Character
    let balloon: Balloon?
    let notices: Notices?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            placed(character, at: props.characterFrame, anchor: .center)
            if let balloon, let frame = props.balloonFrame {
                // A card keeps to the character's side of its frame, and appears and goes from that side.
                let anchor: Alignment = props.balloon?.tail == .up ? .top : .bottom
                placed(balloon, at: frame, anchor: anchor)
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: anchor == .top ? .top : .bottom)))
            }
            if let notices, let frame = props.noticesFrame {
                let anchor: Alignment = props.notices?.edgesUpward == false ? .top : .bottom
                placed(notices, at: frame, anchor: anchor)
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: anchor == .top ? .top : .bottom)))
            }
        }
        .frame(width: props.size.width, height: props.size.height, alignment: .topLeading)
        .animation(props.transition.animation, value: props)
    }

    private func placed<V: View>(_ view: V, at frame: CGRect, anchor: Alignment) -> some View {
        view
            .frame(width: frame.width, height: frame.height, alignment: anchor)
            .position(x: frame.midX, y: frame.midY)
    }
}

/// The character on the stage: her drawing, with the mouse's part of her laid over it.
struct CharacterStageView: View {
    let props: CharacterProps
    let mouse: CharacterMouseArea

    var body: some View {
        CharacterView(props: props).overlay { mouse }
    }
}

extension StageTransition {
    /// The time and the curve the root chose, as SwiftUI takes them. A run follows the same curve `CharacterRun`
    /// computes with, so that a run stopped part way is stopped where she was seen.
    var animation: Animation? {
        switch self {
        case .immediate: return nil
        case .card: return .easeInOut(duration: CardAnimation.duration)
        case .run(let duration):
            let c = CharacterRun.curve
            return .timingCurve(c.0, c.1, c.2, c.3, duration: duration)
        }
    }
}
