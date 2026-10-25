# Meross Connect for Homey

An independent Homey app for the **MSG100 Smart Garage Door Opener**, with
authenticator-based sign-in. It builds the Meross SDK from this exact checkout.
The app uses its own ID, `com.metalcated.meross`, and can coexist with both existing
Meross apps. Paired devices and Flows from those apps are not migrated.

## Install on your self-hosted Homey

With Docker running on your Mac:

```bash
HOMEY_AUTH_VOLUME=homey-lennox-cli-auth bash /Users/mgomon/Code/homey/node-meross-sdk/homey-app/scripts/install.sh --via-foreman
```

This reuses the established Homey CLI sign-in volume. Select your self-hosted
Homey when asked. A separate Meross installer sign-in volume is used if you omit
`HOMEY_AUTH_VOLUME`. Any Homey authorization code belongs in the terminal, never
in chat. Meross credentials are entered later in Homey's pairing modal.

The script builds and tests inside Docker, verifies that the tunnel belongs to
the selected Homey, uploads with `clean:false`, and confirms the exact app ID,
version, enabled state, and running state. It installs the app without operating
or pairing a garage opener. It does not change either existing Meross app or
restart Homey. Requires Homey 13 or newer and Node.js 22 or newer in Homey's app
runtime. The build uses Node.js 24 and Homey CLI 4.6.1.

Optional environment variables:

| Variable | Purpose / default |
| --- | --- |
| `HOMEY_AUTH_VOLUME` | Docker volume containing Homey CLI account authorization; `homey-meross-cli-auth` |
| `HOMEY_ID` | Select an existing Homey by ID instead of the interactive selector |
| `HOMEY_SSH_JUMP` | SSH tunnel host; `foreman.gnet.com` |
| `HOMEY_SSH_TARGET` | Homey host as seen from the tunnel host; `iot-mgmt` |
| `HOMEY_TUNNEL_PORT` | Local tunnel port; `14859` |

Omit `--via-foreman` for a Homey directly reachable through its ordinary CLI
connection. The script can be launched by absolute path from any directory.
Installer containers and the selected authorization volume are retained; the
temporary SSH tunnel closes when the script exits.

## Pair and use the MSG100

1. In Homey, add a device under **Meross Connect → MSG100 Smart Garage Door Opener**.
2. Sign in using the Meross account that owns the opener.
3. When asked, enter the current six-digit authenticator code. An incorrect or
   expired code can be retried within the modal.
4. Select the discovered MSG100 and complete pairing.

Version **0.1.2** provides a read-only **Door: Closed / Open** sensor and separate
**Open** and **Close** buttons. Device tiles have no quick action, so opening the
device panel does not operate the door. A button completes when the opener
acknowledges the command. Door status continues to come from the physical contact
sensor; accepting a command never changes the reported position by itself. The
app monitors the requested position for up to 45 seconds, warns if it cannot be
confirmed, and does not automatically resend the command. Another command is
blocked while this check is in progress. An already satisfied request does not
pulse the opener again. Unknown position, an offline opener, or an expired session
leaves the device unavailable. The SDK uses local HTTP where available, with
cloud MQTT fallback. Sign-in and initial discovery require the Meross cloud.

Version **0.1.1** refreshes the current contact state after reconnecting and before
deciding whether a command is already satisfied. During command confirmation it
requests the actual channel every three seconds, so a missing final push cannot
leave Homey showing the enrollment snapshot. Normal local background checks run
at 30-second intervals even when MQTT is connected. All of these checks are GETs;
they do not repeat an open/close command.

Homey explicitly opts into an MSG100-only state polling profile that requests
System.All and GarageDoor.State channel 0, the read forms verified on the target
unit. It does not use the unverified all-channel sentinel or optional configuration
queries. Other SDK users keep the default polling policy unless they opt in.
Existing devices gain the new controls on startup without pairing again. Device
identity, account records, MFA behavior, and the original `garagedoor_closed`
capability, Flow cards, tags, and history are preserved. Its toggle is hidden from
the device UI. Existing standard garage-door Flow actions retain their original
behavior: they wait for acknowledgment and the reported target position. New
**Open the garage door** and **Close the garage door** app Flow cards complete on
acknowledgment, just like the new buttons; their completion does not establish
that movement has finished. Read **Door** or use the existing reported-position
Flow conditions and triggers when later actions depend on the contact state.

Command diagnostics record the failing phase, elapsed time, error code, and stack
frames without raw response bodies, credentials, or account identifiers. The
status-refresh defect, control/status separation, and capability migration are
covered by regression tests. The updated layout and elimination of the observed
10-second live error still require checking on Homey after the update.

Homey's persistent app settings hold only the Meross session token and account
metadata. Passwords and authenticator codes are not persisted, logged, or stored
in browser storage. App restarts restore the token. Use the device's **Repair**
screen for an expired session. Repair requires the same Meross account, validates
a candidate session before replacing the current one, and preserves the existing
Homey device identity. An offline opener can reconnect after account repair.

This first version covers MSG100-family garage openers. It does not expose
calibration, device configuration changes, or other Meross product categories.
The SDK remains at `0.6.0-alpha`; the checked-out source is compiled and verified
against the upload archive, including the existing MSG100 firmware compatibility
fix in commit `9ed662e`.

## Validation and rollback

The Docker build runs the existing SDK lint, typecheck, and tests, then the Homey
app's modal, account-lifecycle, device, and installer tests. It checks the actual
upload archive, pairing and repair pages, production dependencies, SDK build
identity, and absence of credential files and installer tooling. These checks use
fixtures and mocks; they do not perform a real Meross login or move a garage door.

After installation, validate MFA pairing, reported door position, manual open and
close, app restart, repair, and recovery after a network interruption. Test the
Flow cards you intend to use. Incorrect-code and cancellation handling should be
checked from the actual Homey pairing screen before relying on the integration.

To stop using the test app, disable **Meross Connect** in Homey. Existing community
and official Meross apps remain installed with their own data. Future upgrades
should preserve a Homey backup and can reinstall a previously tested commit using
the same script. The installer does not automatically downgrade or delete data.
