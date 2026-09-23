import NatsumiCore
import SwiftUI

/// The settings: the server and how the connection stands, this iPhone, and logging out.
struct SettingsView: View {
    let props: PhoneSettingsProps
    let send: PhoneEventSink

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                section("サーバー") {
                    row("URL") { Text(props.serverOrigin) }
                    divider
                    row("状態") {
                        HStack(spacing: 6) {
                            Circle().fill(dot).frame(width: 8, height: 8)
                            Text(props.status.text)
                        }
                    }
                    if let action = props.status.action {
                        divider
                        Button { send(action.event) } label: {
                            Text(action.title)
                                .font(Comic.font(15, bold: true))
                                .frame(maxWidth: .infinity, minHeight: 52)
                        }
                        .buttonStyle(.plain)
                    }
                }
                section("この端末") {
                    row("端末 ID") { Text(props.device.isEmpty ? "まだありません" : props.device) }
                }
                Button { send(.logoutRequested) } label: {
                    Text("ログアウト")
                        .font(Comic.font(16, bold: true))
                        .foregroundStyle(Comic.trouble)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background {
                            InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                        }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
        .navigationTitle("設定")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Comic.page, for: .navigationBar)
    }

    private var dot: Color {
        switch props.status.tone {
        case .connected: Comic.connected
        case .waiting: Comic.waiting
        case .trouble: Comic.trouble
        }
    }

    private var divider: some View {
        Rectangle().fill(Comic.floor).frame(height: 2).padding(.horizontal, 16)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(Comic.font(13, bold: true))
                .foregroundStyle(Comic.pageFaint)
                .padding(.leading, 6)
            VStack(spacing: 0, content: content)
                .background {
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                }
        }
    }

    private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(spacing: 12) {
            Text(label).font(Comic.font(15))
            Spacer(minLength: 12)
            value()
                .font(Comic.font(14))
                .foregroundStyle(Comic.pageFaint)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
    }
}
