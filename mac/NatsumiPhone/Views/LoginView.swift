import NatsumiCore
import SwiftUI

/// The login screen: her greeting over her face, the server, and 「GitHub でログイン」.
struct LoginView: View {
    let props: PhoneLoginProps
    let send: PhoneEventSink

    /// What the owner is typing. It is decided only when the button is pressed, like the Mac's settings field; it
    /// starts with the server saved before.
    @State private var server = ""

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 22) {
                Text(props.greeting)
                    .font(Comic.font(16))
                    .lineSpacing(6)
                    .foregroundStyle(Comic.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                    .padding(.bottom, 9)
                    .background { InkedPaper(shape: SpeechBalloonShape(radius: 14)) }
                    .frame(width: 300)
                FaceView(avatar: props.avatar, expression: props.face, size: 132)
            }
            .padding(.top, 48)

            Spacer(minLength: 24)

            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("サーバー")
                        .font(Comic.font(14, bold: true))
                    TextField("https://natsumi.example.net", text: $server)
                        .font(Comic.font(16))
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(submit)
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .background {
                            InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                        }
                }
                if let message = props.message {
                    Text(message)
                        .font(Comic.font(13))
                        .foregroundStyle(Comic.trouble)
                }
                Button(action: submit) {
                    HStack(spacing: 10) {
                        Text(props.buttonTitle)
                        if !props.isLoggingIn { Image(systemName: "arrow.right") }
                    }
                    .font(Comic.font(17, bold: true))
                    .foregroundStyle(Comic.paper)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background {
                        RoundedRectangle(cornerRadius: 14).fill(Comic.ink)
                        RoundedRectangle(cornerRadius: 14).stroke(Comic.pageInk, lineWidth: Comic.outline)
                    }
                }
                .buttonStyle(.plain)
                .disabled(props.isLoggingIn)
                .opacity(props.isLoggingIn ? 0.6 : 1)
                Text("サーバーに登録した GitHub アカウントだけが入れます。")
                    .font(Comic.font(13))
                    .foregroundStyle(Comic.pageFaint)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
        .foregroundStyle(Comic.pageInk)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Comic.page)
        .onAppear { if server.isEmpty { server = props.serverOrigin } }
    }

    private func submit() {
        send(.loginSubmitted(server: server))
    }
}
