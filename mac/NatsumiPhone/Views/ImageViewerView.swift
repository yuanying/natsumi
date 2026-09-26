import NatsumiCore
import SwiftUI

/// A picture, whole, over everything: fitted to the screen, with 「閉じる」 at the top (ADR 0045).
struct ImageViewerView: View {
    let props: ImageViewerProps
    let send: PhoneEventSink
    /// How far the owner has pinched the picture open. Drawing-local: it belongs to this look at the picture and
    /// goes with it.
    @State private var zoom: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let image = props.image.full() {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .scaleEffect(zoom * pinch)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .gesture(MagnifyGesture()
                        .updating($pinch) { value, state, _ in state = value.magnification }
                        .onEnded { value in zoom = min(max(zoom * value.magnification, 1), 4) })
                    .onTapGesture(count: 2) { withAnimation { zoom = zoom > 1 ? 1 : 2 } }
                    .accessibilityLabel(props.title)
            }
            Button { send(.imageViewerClosed) } label: {
                Text("閉じる")
                    .font(Comic.font(15, bold: true))
                    .foregroundStyle(Comic.ink)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Comic.paper))
            }
            .buttonStyle(.plain)
            .padding(16)
        }
    }
}
