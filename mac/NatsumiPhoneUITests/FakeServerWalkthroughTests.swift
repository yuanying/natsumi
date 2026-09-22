import XCTest

/// Walks the iPhone app through the fake server (`npm run fake-server`) and keeps a screenshot of every step.
///
/// This is for looking at the screens, not a gate: it needs the fake server on http://localhost:8787, which the
/// simulator reaches as the Mac's own loopback. Screenshots are attached to the result bundle, and are also written
/// to `$NATSUMI_SCREENSHOTS` when it is set (pass it as `TEST_RUNNER_NATSUMI_SCREENSHOTS` to xcodebuild).
/// `$NATSUMI_SERVER` points it at a fake server on another port.
@MainActor
final class FakeServerWalkthroughTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testWalkthrough() throws {
        app.launch()
        logInIfAsked()

        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 15), "つながらない")
        shoot("2-main")

        let close = app.buttons["既読にして閉じる"]
        if close.waitForExistence(timeout: 2) {
            close.tap()
            shoot("3-read")
        }

        let field = app.textFields["話しかける"]
        field.tap()
        field.typeText("明日の午前って空いてる？")
        shoot("4-typing")
        app.buttons["送る"].tap()
        sleep(1)
        shoot("5-sent")
        XCTAssertTrue(app.staticTexts["メモを読み返してる"].waitForExistence(timeout: 10))
        shoot("6-thinking")
        XCTAssertTrue(app.staticTexts["「明日の午前って空いてる？」だね。わかった。"].waitForExistence(timeout: 15))
        shoot("7-reply")

        app.buttons["会話の履歴"].tap()
        XCTAssertTrue(app.navigationBars["会話"].waitForExistence(timeout: 5))
        sleep(1)
        shoot("8-history")
        app.navigationBars.buttons.firstMatch.tap()
        // Everything was seen in the history, so the notice card is gone.
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 5))
        shoot("9-main-after-history")

        app.buttons["設定"].tap()
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
        shoot("10-settings")
        app.buttons["ログアウト"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
        shoot("11-logged-out")
    }

    /// The login screen, when the app has no session: the fake server's address, the button, and the system's
    /// question whether the app may sign in with it.
    private func logInIfAsked() {
        let button = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "GitHub でログイン")).firstMatch
        guard button.waitForExistence(timeout: 5) else { return }
        shoot("1-login")
        let field = app.textFields.firstMatch
        field.tap()
        if let old = field.value as? String, !old.isEmpty, old != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        field.typeText(ProcessInfo.processInfo.environment["NATSUMI_SERVER"] ?? "http://localhost:8787")
        button.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for title in ["続ける", "Continue"] {
            let allow = springboard.buttons[title]
            if allow.waitForExistence(timeout: 3) {
                allow.tap()
                break
            }
        }
    }

    private func shoot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["NATSUMI_SCREENSHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
