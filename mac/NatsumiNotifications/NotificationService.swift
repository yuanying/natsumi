import Foundation
import ImageIO
import UniformTypeIdentifiers
import UserNotifications

/// Opens natsumi's line before the notification shows (ADR 0029). The server sealed it to this iPhone's key; the
/// alert it sent says only 「返事があります」 or 「知らせがあります」, and that stays whenever the line cannot be opened.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let alert = AlertPush(userInfo: content.userInfo), let sealed = alert.sealed,
              let key = try? PushKeyStore(accessGroup: PushKeyStore.sharedGroup()).load(),
              let line = try? PushCrypto.open(sealed, messageId: alert.messageId, with: key)
        else {
            contentHandler(request.content)
            return
        }
        content.body = line.text
        if alert.kind == .notice { content.subtitle = "知らせ" }
        // Her face for the feeling in the line; the neutral one when the line has none.
        if let face = Face.attachment(line.expression ?? "neutral") { content.attachments = [face] }
        contentHandler(content)
    }
}

/// The faces in `icons/` are WebP, which a notification cannot show, so the one needed is written out as PNG.
private enum Face {
    static func attachment(_ expression: String) -> UNNotificationAttachment? {
        guard let source = Bundle.main.url(forResource: expression, withExtension: "webp", subdirectory: "icons"),
              let image = CGImageSourceCreateWithURL(source as CFURL, nil).flatMap({ CGImageSourceCreateImageAtIndex($0, 0, nil) })
        else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return try? UNNotificationAttachment(identifier: "face", url: url)
    }
}
