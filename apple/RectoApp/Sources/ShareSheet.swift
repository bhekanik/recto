import RectoSync
import SwiftUI

/// `components/share-dialog.tsx`: invite by email at a role, see who has
/// access, revoke it.
struct ShareSheet: View {
    let title: String
    let cloud: CloudDocumentContext?
    let dismiss: () -> Void
    @State private var shares: [RemoteShare] = []
    @State private var email = ""
    @State private var role: RemoteShare.Role = .suggester
    @State private var error: String?
    @State private var pending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Share “\(title)”").font(.headline)
            Text("Invite someone by email. They get access once they sign in with that address.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                TextField("name@example.com", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await invite() } }
                Button("Invite") { Task { await invite() } }.disabled(pending)
            }
            Picker("Access level", selection: $role) {
                ForEach(RemoteShare.Role.allCases, id: \.self) { role in
                    Text("\(role.label) — \(role.hint)").tag(role)
                }
            }
            .pickerStyle(.radioGroup)
            if let error {
                Text(error).font(.callout).foregroundStyle(.red)
            }
            Divider()
            if shares.isEmpty {
                Text("Only you can see this document.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(shares) { share in
                HStack {
                    Text(share.granteeEmail)
                    Spacer()
                    Text(share.role.label).foregroundStyle(.secondary)
                    Button { Task { await revoke(share) } } label: { Image(systemName: "xmark.circle") }
                        .buttonStyle(.plain)
                        .help("Revoke access")
                        .accessibilityLabel("Revoke access for \(share.granteeEmail)")
                }
            }
            HStack {
                Spacer()
                Button("Done", action: dismiss).keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task { await follow() }
    }

    private func follow() async {
        guard let cloud, let convexId = cloud.convexId else {
            error = "This document hasn't synced yet, so it can't be shared."
            return
        }
        let stream: AsyncThrowingStream<[RemoteShare], any Error> =
            await cloud.api.subscribe(ConvexFunction.reviewListShares, args: ["documentId": .string(convexId)])
        do {
            for try await list in stream { shares = list }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func invite() async {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            error = "Enter an email address to invite."
            return
        }
        guard let cloud, let convexId = cloud.convexId else { return }
        pending = true
        defer { pending = false }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.reviewAddShare, args: [
                "documentId": .string(convexId), "email": .string(trimmed), "role": .string(role.rawValue),
            ])
            email = ""
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func revoke(_ share: RemoteShare) async {
        guard let cloud else { return }
        do {
            let _: ConvexVoid = try await cloud.api.mutation(ConvexFunction.reviewRevokeShare, args: ["shareId": .string(share.id)])
        } catch {
            self.error = error.localizedDescription
        }
    }
}
