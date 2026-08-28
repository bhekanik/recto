import SwiftUI

struct ContentView: View {
  @Bindable var model: SpikeModel
  private let log = SpikeLogBuffer.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      status
      Divider()
      switch model.phase {
      case .configurationMissing:
        Text("Config missing. Run scripts/write-local-config.sh, then rebuild.")
          .foregroundStyle(.red)
      case .signedOut, .failed:
        signInForm
      case .awaitingCode(let address):
        codeForm(address)
      case .authenticating:
        ProgressView("Signing in…")
      case .ready:
        documentList
      }
      Divider()
      logPane
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var status: some View {
    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
      row("Convex auth", model.convexAuthState)
      row("Socket", model.socketState)
      row("User", model.userLabel)
      row("Subscription updates", "\(model.subscriptionUpdates)")
      row("Token claims", model.lastClaims)
    }
    .font(.system(.callout, design: .monospaced))
  }

  private func row(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(.secondary)
      Text(value).textSelection(.enabled)
    }
  }

  private var signInForm: some View {
    VStack(alignment: .leading, spacing: 8) {
      if case .failed(let message) = model.phase {
        Text(message).foregroundStyle(.red).font(.callout)
      }
      TextField("email", text: $model.email)
        .frame(maxWidth: 340)
      HStack {
        Button("Send email code") { Task { await model.sendEmailCode() } }
          .disabled(model.email.isEmpty)
        Button("Sign in with Google") { Task { await model.signInWithGoogle() } }
      }
    }
  }

  private func codeForm(_ address: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Code sent to \(address)")
      TextField("code", text: $model.code)
        .frame(maxWidth: 160)
      Button("Verify") { Task { await model.verifyCode() } }
        .disabled(model.code.isEmpty)
    }
  }

  private var documentList: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Button("Create document") { Task { await model.createDocument() } }
        Button("Rename newest") { Task { await model.renameNewestDocument() } }
        Button("Log token") { Task { await model.logTokenClaims() } }
        Button("Sign out") { Task { await model.signOut() } }
      }
      Text("documents:list — \(model.documents.count) rows")
        .font(.headline)
      List(model.documents) { document in
        VStack(alignment: .leading) {
          Text(document.title)
          Text("\(Int(document.wordCount)) words · \(document.id)")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      .frame(minHeight: 160)
    }
  }

  private var logPane: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(log.lines.enumerated()), id: \.offset) { index, line in
            Text(line).font(.system(size: 10, design: .monospaced)).id(index)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(minHeight: 180)
      .onChange(of: log.lines.count) { _, count in
        proxy.scrollTo(count - 1, anchor: .bottom)
      }
    }
  }
}
