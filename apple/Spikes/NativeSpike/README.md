# NativeSpike — plan 023 phase N0a

Throwaway multiplatform SwiftUI app that answers one question: can the Apple
apps talk to Clerk and Convex directly, from Swift, on macOS and iPadOS?

It signs in to Clerk with an email code, mints a **`convex` JWT-template**
token, subscribes to `documents:list`, runs `documents:create` /
`documents:rename`, and logs the socket state and the token's claims. Nothing
here is meant to ship; N4 lifts the parts it needs.

## Setup

```bash
# Values come from the repo's .env.local (both are gitignored).
CLERK_PUBLISHABLE_KEY=pk_test_… \
CONVEX_URL=https://your-deployment.convex.cloud \
  apple/Spikes/NativeSpike/scripts/write-local-config.sh
```

That writes `Config/Local.xcconfig`, which `Config/Base.xcconfig` includes and
`Resources/Info.plist` reads. `NativeSpike.xcodeproj` is committed; regenerate
it with `xcodegen generate` after editing `project.yml`.

## Build

```bash
cd apple/Spikes/NativeSpike

# Mac
xcodebuild -scheme NativeSpike -destination 'platform=macOS' build

# iPad simulator (`xcrun simctl list devices available` for the id;
# the name+OS form needs the exact runtime, e.g. OS=26.4.1, not OS=26.4)
xcodebuild -scheme NativeSpike -destination 'id=<simulator-udid>' build

# Signed, sandboxed macOS Release archive
xcodebuild archive -scheme NativeSpike -configuration Release \
  -destination 'generic/platform=macOS' \
  -archivePath /tmp/NativeSpike.xcarchive
```

## Run

The UI works on its own, and these environment variables drive it headlessly so
a run leaves a log to point at:

| Variable | Effect |
|---|---|
| `SPIKE_EMAIL`, `SPIKE_CODE` | Sign in at launch. A Clerk test address (`…+clerk_test@example.com`) with code `424242` needs no mailbox. |
| `SPIKE_FRESH=1` | Discard the restored keychain session first, so the run exercises a real sign-in. |
| `SPIKE_CREATE=1` | Create one document once authenticated. |
| `SPIKE_MUTATE_EVERY=<s>` | Rename the newest document every N seconds. |
| `SPIKE_TOKEN_POLL=<s>` | Log the token's claims every N seconds. |
| `SPIKE_DEFAULT_TEMPLATE=1` | Use Clerk's default session token instead of the `convex` template — the negative test. |

```bash
# Mac, with stdout captured
SPIKE_EMAIL=recto-e2e+clerk_test@example.com SPIKE_CODE=424242 SPIKE_CREATE=1 \
  /path/to/NativeSpike.app/Contents/MacOS/NativeSpike | tee /tmp/mac.log

# iPad simulator
xcrun simctl install <udid> /path/to/NativeSpike.app
SIMCTL_CHILD_SPIKE_EMAIL=recto-e2e+clerk_test@example.com \
SIMCTL_CHILD_SPIKE_CODE=424242 \
  xcrun simctl launch --console-pty <udid> com.bhekani.recto.spike.native
```

A mutation from outside the app, to watch it arrive live:

```bash
bunx convex run documents:create '{"title":"hello"}' \
  --identity '{"subject":"user_…","issuer":"https://<instance>.clerk.accounts.dev"}' \
  --codegen disable --typecheck disable
```
