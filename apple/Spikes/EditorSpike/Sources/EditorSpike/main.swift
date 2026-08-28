import AppKit

// EditorSpike — N0b. Two modes:
//   EditorSpike measure <corpus-dir>   run the benchmark, print the report, exit
//   EditorSpike open <file.md>         open one document in a window to look at it

setbuf(stdout, nil)

let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? "measure"
let app = NSApplication.shared

switch mode {
case "open":
    app.setActivationPolicy(.regular)
    let delegate = OpenDelegate(path: args.count > 1 ? args[1] : nil)
    app.delegate = delegate
    app.run()

case "measure":
    guard args.count > 1 else {
        FileHandle.standardError.write(Data("usage: EditorSpike measure <corpus-dir>\n".utf8))
        exit(2)
    }
    // .accessory: the window renders and receives the synthesised events without
    // stealing focus from whatever the machine is doing.
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    MainActor.assumeIsolated {
        Measure.run(corpusDir: URL(fileURLWithPath: args[1]))
    }
    exit(0)

case "mem":
    // Footprint of one document, so variants can be compared to find out what
    // the memory is actually spent on.
    guard args.count > 1 else {
        FileHandle.standardError.write(Data("usage: EditorSpike mem <file.md>\n".utf8))
        exit(2)
    }
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    MainActor.assumeIsolated {
        let h = Harness.make(fontSize: 19, readingWidth: 720, activate: false)
        pump(0.2)
        let empty = footprintMB()
        let text = (try? String(contentsOfFile: args[1], encoding: .utf8)) ?? ""
        h.load(text, fullLayout: false)
        pump(0.3)
        print(
            String(
                format: "%@  chars=%d  empty=%.1f MB  peak=%.1f MB  settled=%.1f MB",
                (args[1] as NSString).lastPathComponent, (text as NSString).length, empty,
                footprintMB(), settledFootprintMB()))
        // SPIKE_HOLD=1 keeps the process alive so `vmmap` can say what the
        // footprint is actually made of.
        if ProcessInfo.processInfo.environment["SPIKE_HOLD"] == "1" { pump(40) }
    }
    exit(0)

default:
    FileHandle.standardError.write(Data("unknown mode \(mode)\n".utf8))
    exit(2)
}

final class OpenDelegate: NSObject, NSApplicationDelegate {
    let path: String?
    var harness: Harness?

    init(path: String?) { self.path = path }

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            let h = Harness.make(fontSize: 19, readingWidth: 720, activate: true)
            harness = h
            let text =
                path.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }
                ?? "# EditorSpike\n\nPass a path: `EditorSpike open file.md`\n"
            h.load(text)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
