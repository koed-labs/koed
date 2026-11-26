# Optional desktop sign-in

Desktop signs in directly with WorkOS AuthKit. It uses a public client, which identifies the app without a server secret.
WorkOS handles Google, GitHub, email/password registration, email verification, and password recovery.
Desktop does not require a remote Koed backend for these features.

Open the profile badge at the bottom of the navigation rail to sign in or sign out.
The badge shows the WorkOS picture or initials for the signed-in account.
During sign-in, its menu shows browser instructions and a Cancel sign-in action.

Local Personal Memory remains available without sign-in and while offline.
Sign-in does not upload Memory, change Memory ownership, rotate API Tokens, or enable Capture.
It does not enroll a device or grant Team Membership, Workspace Access, rewards, or paid features.

## Configuration and staging setup

Source builds disable accounts and hide the profile badge by default.
The source file, `apps/desktop/account-config.json`, contains:

```json
{ "enabled": false }
```

When accounts are disabled, Desktop does not initialize WorkOS or open account storage.
Desktop also hides the badge until it reads account availability from Electron main, the process that controls the app.
Authentication starts only when the User selects Sign in.

To enable sign-in in a source build:

1. Run `pnpm env:sync` from the repository root.
2. Run `pnpm env:setup` to add missing values to the root `.env`.
3. Set these five values in the root `.env`:

   ```dotenv
   DESKTOP_ACCOUNT_ENABLED=true
   DESKTOP_ACCOUNT_CLIENT_ID=client_YOUR_STAGING_DESKTOP_APPLICATION
   DESKTOP_ACCOUNT_ENVIRONMENT=staging
   DESKTOP_ACCOUNT_LOGIN_MODE=forwarder
   DESKTOP_ACCOUNT_FORWARDER_URL=https://login.example.com/desktop/callback
   ```

4. Replace the example forwarder URL with your deployed HTTPS callback URL.
5. Complete the staging WorkOS configuration below.
6. Restart Desktop with `pnpm desktop:start`.

Desktop imports these five public values and the optional account API origin
from the root file.
For a different source environment file, set `KOED_ENV_PATH` before starting Desktop.
Missing or unreadable environment files do not block local startup.

Source configuration follows this order, with the first nonempty value taking precedence:

1. Explicit `KOED_ACCOUNT_*` process values.
2. Explicit `DESKTOP_ACCOUNT_*` process values.
3. The root file's `DESKTOP_ACCOUNT_*` values, or values from `KOED_ENV_PATH`.
4. The bundled `account-config.json` values.

Packaged apps do not read checkout `.env` files or `KOED_ENV_PATH` for accounts.
Release packaging reads explicit build inputs instead.
A local source configuration cannot enable sign-in in a release package.
Packaged apps use the complete bundled account configuration and ignore runtime account overrides.

| Process variable             | Purpose                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `KOED_ACCOUNT_ENABLED`       | Set exactly `true` to enable sign-in in source or build configuration. Set `false` to disable it. |
| `KOED_ACCOUNT_CLIENT_ID`     | The public WorkOS Client ID for the Desktop application.                                          |
| `KOED_ACCOUNT_ENVIRONMENT`   | The WorkOS environment, such as `staging` or `production`.                                        |
| `KOED_ACCOUNT_LOGIN_MODE`    | Use `forwarder` for the configured HTTPS callback. Use `direct` for the native callback.          |
| `KOED_ACCOUNT_FORWARDER_URL` | The full HTTPS callback URL, required in forwarder mode.                                          |

`KOED_ACCOUNT_FORWARDER_URL` sets the full HTTPS callback URL in source runs and package builds.
The root `.env` name is `DESKTOP_ACCOUNT_FORWARDER_URL`.
Forwarder mode requires this value. Direct mode does not use it.

Local configuration without a login mode, or with a blank mode, uses `direct`.
Enabled release builds still require explicit account inputs.
Missing or invalid account configuration leaves local startup available.
Do not put a WorkOS API key or provider secret in Desktop configuration.

### Callback URLs

The callback is the URL that receives the WorkOS sign-in response.
A native URL opens a registered desktop application.
In `forwarder` mode, WorkOS sends the response to your forwarder over HTTPS.
The forwarder opens a fixed native URL, which returns the response to Desktop.

The forwarder URL comes from your local or build configuration.
It must use HTTPS on the standard port and end with exactly `/desktop/callback`.
Omit the port from the URL.
Use a lowercase hostname without embedded credentials, query parameters, or fragments.
Desktop rejects URLs that require normalization, such as paths containing `..`.

The native callback remains fixed in the app.
For staging development, it is `ai.koed.desktop.auth.dev://callback`.
The forwarder must return to that exact native callback.
Changing the forwarder URL does not change the native callback.

In your WorkOS staging environment:

1. Deploy your forwarder before enabling `forwarder` mode in Desktop.
2. Add the exact `DESKTOP_ACCOUNT_FORWARDER_URL` value to Redirect URIs.
3. Allow `ai.koed.desktop.auth.dev://callback` for direct mode.
4. Set the default Sign-out URI to your forwarder's sign-out return page.
5. Enable email/password registration, email verification, password recovery, Google, and GitHub.
6. Use a real inbox to test email delivery.

The hosted sign-in screen can use the default WorkOS domain.
Use a WorkOS staging application and its public Client ID for development.
Each WorkOS environment has separate configuration and Users.
To develop without a forwarder, select `direct` mode and register the native callback in WorkOS.

## Local packages

Local packages keep accounts disabled unless the build configuration enables them.
To enable sign-in in a local package, set the `KOED_ACCOUNT_*` process variables before running the platform packaging command.
Packaging reads these build inputs directly and does not load the root `.env`.

The packager includes public account configuration without changing the disabled source file.
Installed apps read that configuration without shell variables.
Enabled packages register only their selected account callback scheme.
Packages with accounts disabled do not register an account scheme.
Packaging rejects missing or invalid forwarder URLs when `forwarder` mode is enabled.
Changing account configuration in an installed app requires a new package.
Do not include a WorkOS API key or provider secret in a package.

## Credentials and session storage

PKCE protects the exchange of authorization codes.
It binds a sign-in response to the Desktop installation that started it.
Electron main keeps the PKCE verifier, the secret required for the code exchange.
It exchanges the authorization code directly with WorkOS and makes sure that the session identifies a verified User.
Your forwarder receives the code and protected sign-in state.
It cannot exchange the code without the verifier.
The forwarder does not authenticate the User or grant access.

The renderer, the process that displays the interface, receives only account status and read-only profile fields.
Tokens, callback URLs, PKCE material, and provider error payloads stay outside renderer state and support exports.
Team and device credentials remain under separate `koed-server` control.

The optional account API provides email preferences and Kin unlocks. In a
source build, set `DESKTOP_ACCOUNT_PROFILE_API_ORIGIN` to the account API
origin. A loopback HTTP origin can serve local fixtures. For a packaged
build, supply an HTTPS origin as `KOED_ACCOUNT_PROFILE_API_ORIGIN` at build
time. Desktop keeps its existing sign-in mode. Electron main sends the
WorkOS access token and returns the profile to Desktop.
Open **Settings → Account**, or choose **Expand** in the sidebar account menu. The profile card shows the signed-in User, Free tier, and the WorkOS account creation date when available. Use the **Email updates** checkbox to read the notice and change consent for the displayed address. Desktop shows
the saved preference and a notification after the API confirms it. If Desktop cannot confirm the change, the notification prompts you to refresh your profile. Open **Project settings → Kin → Accessories**
to see and equip the items available to that account. If the API is unavailable, retry
with **Refresh profile** on the Account page. Desktop shows a notification when the refresh succeeds or fails. Free items stay available and saved Kins retain their
appearance.

Electron `safeStorage` encrypts the session, cached profile, sign-in attempt, and installation secret.
Its asynchronous APIs use the operating system credential service.
Linux `basic_text` storage is rejected.
Storage failures never cause account credentials to be written as plaintext.
Key rotation replaces the encrypted file without exposing a partial write.

The storage file is scoped to the installation, WorkOS environment, Client ID, and native callback.
Both login modes use the same file.
Changing modes or forwarder URLs preserves the session and discards incompatible sign-in attempts.
Sign-out and cancellation remove the file immediately and prevent unfinished storage operations from restoring it.

Desktop accepts each callback once, against matching encrypted state that expires after ten minutes.
It rejects late callbacks after cancellation, sign-out, or a replacement attempt.
Session refresh and callback completion run in sequence to protect rotated credentials.

During restoration or an explicit profile refresh, Desktop requests a fresh session from WorkOS.
A temporary outage can leave a cached profile visible, but the profile grants no access.
A stale cached account remains signed in without granting authorization.
Focus and connectivity events retry the refresh at most once every 30 seconds.
A failed refresh does not create a polling loop.
An expired or revoked session requires sign-in again.
Desktop detects revocation through refresh, rather than relying only on an unexpired access token.

Sign-out clears local credentials before opening WorkOS browser sign-out.
Opening the browser does not prove that remote sign-out completed.
A sign-out return page does not end a session when visited directly.

## Profile pictures

The account menu shows the full name from WorkOS, or the first and last names when supplied separately. If WorkOS supplies only an email address, the menu shows it once.
It shows a profile picture when WorkOS supplies a supported URL.
Initials appear while the picture loads, when it is absent, or when loading fails.

Desktop accepts HTTPS pictures from `workoscdn.com`, its subdomains, `*.googleusercontent.com`, and `avatars.githubusercontent.com`.
It rejects embedded credentials and nonstandard ports.
The renderer requests pictures with `no-referrer` and no WorkOS token.

## Troubleshooting

Desktop requires a keyless WorkOS client.
Do not export `WORKOS_API_KEY` into the Desktop process.
If that variable is present, sign-in stops before creating a client.
The root account loader does not import it from `.env`.

If automatic browser handoff fails, select Open Koed on the return page.
If the app is absent or the link expires, open Koed and start sign-in again.

If the forwarder is unavailable, select Cancel sign-in in the account menu.
An unanswered Desktop attempt expires after ten minutes.
Local Personal Memory remains available.

For a source launch without the forwarder, run:

```sh
KOED_ACCOUNT_LOGIN_MODE=direct pnpm desktop:start
```

Keep the staging native callback allowed in WorkOS when using direct mode.
Restart Desktop and start a new sign-in attempt after changing modes.

## Testing sign-in

Test these cases with your WorkOS staging application:

- Google, GitHub, and email/password sign-in, registration, email verification, and password recovery.
- Automatic browser handoff and the manual Open Koed action.
- Callbacks with the installed app open and fully closed, on each shipping platform.
- Session restoration, provider revocation, cancellation, and local/browser sign-out.
- Local Personal Memory while signed out, offline, or unable to reach the forwarder.

The presentation test uses synthetic account data without provider credentials.
Run `pnpm --filter @koed-labs/desktop test:browser:account` on a host that supports the Electron interface.
It covers signed-out, signed-in, and offline views in light/dark themes at 100%/200% zoom.
It stops after 30 seconds.
A passing presentation test does not establish a successful WorkOS sign-in or installed callback.
