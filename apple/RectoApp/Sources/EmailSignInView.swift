import SwiftUI

struct EmailSignInView: View {
    let model: RectoApplicationModel
    @State private var emailAddress = ""
    @State private var code = ""
    @State private var isWorking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Recto")
                .font(.largeTitle)
            Text("Sign in to open your synced documents.")
                .foregroundStyle(.secondary)
            if model.isWaitingForEmailCode {
                TextField("Six-digit code", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(verify)
                Button("Verify code", action: verify)
                    .buttonStyle(.borderedProminent)
                    .disabled(code.isEmpty || isWorking)
            } else {
                TextField("Email address", text: $emailAddress)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(sendCode)
                Button("Email me a code", action: sendCode)
                    .buttonStyle(.borderedProminent)
                    .disabled(emailAddress.isEmpty || isWorking)
            }
            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .frame(width: 360)
        .padding(40)
    }

    private func sendCode() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            await model.sendEmailCode(to: emailAddress)
            isWorking = false
        }
    }

    private func verify() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            await model.verifyEmailCode(code)
            isWorking = false
        }
    }
}
