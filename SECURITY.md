# Security

Rushes drives an authenticated browser against a real application, can execute a
command named in a config file, sends frames to a model, and can publish to a
public channel. Each of those is treated as a boundary, not a convenience.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the address in the
repository metadata. Please do not open a public issue for anything that would
expose a credential or a private artifact.

We will acknowledge within a week and tell you what we intend to do.

## The credential model, stated plainly

**Rushes stores exactly two secrets, and both are about the voice.** A credential
the filmed application needs is either:

- an ambient environment variable that the config NAMES and that you already
  export, or
- a browser state file that you captured yourself with `rushes login`.

There is no third option and no exception for convenience. `rushes doctor` fails
the build if the skill's own `.env` grows a third key, and a test asserts the
allowlist is exactly two entries.

## What is enforced in code

| Boundary | Rule |
|---|---|
| **Egress** | every host is classified on its RESOLVED IP, not its name, and every resolved address must clear the policy. The address that passed is pinned into the browser's own resolver, so a name cannot resolve differently between the check and the connection. `egress.strictSubresources` additionally refuses to resolve anything unclassified; it is off by default because it breaks apps that load third-party subresources |
| **Origin** | an off-origin page is filmed from a SEPARATE CONTEXT that was never granted a credential — no cookies, no storage, no headers, no HTTP credentials — rather than by taking one away from a context that has it. `httpCredentials` cannot be unset after a context is created, so withholding is the only version of this that is true. Every redirect hop is re-classified. Not configurable |
| **`file://`** | allowed by PATH, not by scheme: only inside the compiled slide directory, with `..`, symlinks and absolute escapes resolved first |
| **`runner.start`** | never auto-runs. The command, its cwd and the config's sha256 are printed, and approval is recorded against that sha256, so any config edit invalidates it. Refused entirely when stdin is not a TTY |
| **`preflight`** | `GET`, `HEAD`, `PATCH`, `POST` only; same-origin relative paths only; every call recorded in the receipt |
| **The vision check** | bound to no tools; the reply is parsed as one of three exact tokens. Free text from a model that read attacker-controlled pixels steers nothing |
| **Diagnostics** | every resolved secret is scrubbed BY VALUE from every diagnostic, receipt and log line before write; a leak at write time fails the build |
| **Screenshots** | never taken while an auth strategy is running, and never of a page matching the configured login path. A screenshot cannot be redacted |
| **The state file** | written `0600`, never copied into `out/`, never in a receipt, never in the packaged payload |
| **Every frame** | scanned for key-shaped strings and for the project's never-show list. A hit is an error at every quality profile |
| **Publishing** | absent unless configured, gated on `--confirm` AND a receipt whose hashes still match the bytes on disk |

## Supply chain

Every dependency is pinned to an exact version, and a test asserts it. Chrome is
resolved from `PATH` and never downloaded at run time. No CDN font, script or
stylesheet anywhere: slides and cards embed their assets as base64 at build time,
and nothing is fetched during a recording.

## No telemetry

Rushes reports nothing anywhere. If an update check is ever added it will be a
notice, never an install, and it will be disableable.
