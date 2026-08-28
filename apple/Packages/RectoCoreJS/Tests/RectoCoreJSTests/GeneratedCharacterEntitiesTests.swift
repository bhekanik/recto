import Foundation
import Testing

@Suite("Generated character entities")
struct GeneratedCharacterEntitiesTests {
    @Test("Committed table matches character-entities")
    func generatedTableIsCurrent() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "bun", "Scripts/generate-character-entities.ts", "--check",
        ]
        process.currentDirectoryURL = packageRoot
        process.standardOutput = output
        process.standardError = output

        try process.run()
        process.waitUntilExit()
        let message = String(
            decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(process.terminationStatus == 0, Comment(rawValue: message))
    }
}
