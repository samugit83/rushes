# The project config contract

`rushes.config.json` lives in the repository of the app being filmed, never in
the skill. It is the only place an application-specific fact is allowed to
exist: grepping the engine for a product's name returns nothing, and a test
enforces that.

**Nothing is required except `baseUrl`.** A public marketing site needs three
lines. Start there and add only what the app forces you to.

```jsonc
{ "baseUrl": "http://localhost:8000" }
```

Every string value may interpolate `${ENV_VAR}` from the **ambient**
environment, including an object KEY. A resolved value is registered with the
secret scrubber the moment it is expanded, so it can never reach a diagnostic, a
receipt or a log line.

---

## Auth, as a ladder

Climb it in order. Most people stop at the second rung.

### `none`

```jsonc
{ "auth": { "kind": "none" } }
```

### `storage-state` — the universal answer

```jsonc
{ "auth": {
    "kind": "storage-state",
    "statePath": ".rushes/state.json",
    "maxAgeHours": 168,
    "signedInWhen":  { "text": "Sign out" },
    "signedOutWhen": { "css": "form[action*='login']" }
} }
```

Run `rushes login` once: the browser opens headed, the human signs in however
their app actually requires — a password manager, a TOTP prompt, an SSO
redirect, a hardware key — and the cookies and localStorage are saved. It works
with Django sessions, Rails, Laravel, Next.js and anything else, and the skill
never sees the credential.

The state file is a bearer credential. It is written `0600`, it never enters
`out/`, it never enters a receipt, and it never enters the packaged payload.
Recording is refused, not attempted, once it is older than `maxAgeHours`:
filming a logged-out app produces a complete, correctly narrated video of a login
screen.

### `form-login`

```jsonc
{ "auth": {
    "kind": "form-login",
    "path": "/accounts/login/",
    "fields": { "username": "${DEMO_USER}", "password": "${DEMO_PASS}" },
    "csrfField": "csrfmiddlewaretoken",
    "submit": { "role": "button", "name": "Log in" }
} }
```

`csrfField` covers Django's `csrfmiddlewaretoken`, Rails' `authenticity_token`,
and anything else that hides a token in the rendered form. The login runs on a
separate page that is closed before recording starts, because a login surface
must never be screenshotted.

### `jwt-cookie`, `basic`, `header`

```jsonc
{ "auth": { "kind": "jwt-cookie", "cookie": "app-auth", "secretEnv": "APP_SECRET",
            "alg": "HS256", "claims": { "sub": "${DEMO_USER_ID}", "role": "admin" },
            "ttlSeconds": 10800 } }
{ "auth": { "kind": "basic",  "user": "${U}", "pass": "${P}" } }
{ "auth": { "kind": "header", "name": "Authorization", "value": "Bearer ${TOKEN}" } }
```

`secretEnv` NAMES an environment variable you already export. The skill never
stores it.

**`basic` and `header` set context-wide credentials**, which Playwright applies
to every request from the context. They are therefore stripped at every origin
boundary, and that is not configurable. See "Two allowlists" below.

---

## Readiness

```jsonc
{ "readiness": {
    "quietMs": 500,
    "timeoutMs": 20000,
    "readySelector": null,
    "busySelector": ".spinner, [aria-busy='true']"
} }
```

The engine waits for: `readyState === 'complete'`, then no in-flight requests for
`quietMs`, then no running animation on a visible element, then optionally
`readySelector` visible and `busySelector` not.

**`busySelector` is the highest-value line in this file.** The app's own spinner
is more reliable than any heuristic the engine could invent. On timeout the
engine names which condition never became true, rather than continuing into a
scene against a half-loaded page.

Framework notes:

| Shape | What to set |
|---|---|
| Static site | nothing; it settles in one paint |
| Django / Rails / server-rendered | usually nothing; raise `timeoutMs` for slow renders |
| Next.js / React SPA | `busySelector`, or raise `quietMs` if the app polls |
| An app that polls forever | `busySelector`, and accept `readiness/busy-selector-stuck` as a warning |

---

## Pre-state

```jsonc
{
  "seed": {
    "localStorage": { "app-theme": "dark" },
    "sessionStorage": {},
    "cookies": [{ "name": "consent", "value": "accepted" }]
  },
  "preflight": [
    { "method": "PATCH", "path": "/api/user/preferences",
      "json": { "featureKey": "theme", "value": "dark" },
      "restoreAfter": true, "restoreKey": "theme", "restoreValuePath": "value" }
  ],
  "dismiss": [
    { "locator": { "text": "Accept all" }, "checkAllCheckboxes": true, "optional": true }
  ],
  "colorScheme": "dark"
}
```

**A hard-won note about themes.** When an app reads its own storage key before it
reads a server preference, seed BOTH, or the recording silently comes back in the
wrong theme. `colorScheme` emulates the browser-level preference, which every
framework respects; app-level theme forcing belongs in `seed` and `preflight`.

`preflight` runs through the authenticated request context before the clock
starts. It is bounded, because an unbounded one is authenticated request forgery
by config:

- `GET`, `HEAD`, `PATCH` and `POST` only. `DELETE` and `PUT` are refused.
- The path must be same-origin and relative. Absolute URLs, scheme-relative `//`
  and any `..` segment are refused.
- Every preflight, its method, path and status, is written into the receipt.

`restoreAfter` puts the prior value back. Two fields describe how:

- **`restoreKey`** is where to READ the prior value in the GET response.
- **`restoreValuePath`** is where inside `json` the value lives, so the restore
  is re-sent **in the shape the endpoint accepts**. Without it the restore sends
  a bare `{ key: value }` pair, which an endpoint whose contract is
  `{ featureKey, value }` answers with a 400. Set it whenever `json` is anything
  richer than the value itself.

The restore is a **compare and set**: if the value changed under us, it is
ABORTED and reported rather than clobbering someone else's write. A restore the
app REJECTS is reported too — a non-2xx there means the pre-state is still
mutated, and that failing silently is the exact outcome this machinery exists to
prevent. It is also crash-safe: pending restores are persisted before they are
applied, signal handlers put back every live session's state, and the next run
refuses to start while a leftover file exists.

---

## Two allowlists, two purposes

This is the part people get wrong, so it is stated twice.

**`allowHosts` governs the APPLICATION origin.** `external.allow` governs
LEAVING it. Neither widens the other: an off-origin page must pass the
resolved-IP classification **and** be listed in `external.allow`.

```jsonc
{
  "allowHosts": ["localhost", "127.0.0.1"],
  "external": {
    "allow": ["github.com"],
    "readiness": { "quietMs": 1200, "timeoutMs": 30000 },
    "dismiss": [{ "locator": { "text": "Accept all" }, "optional": true }],
    "volatile": true,
    "publishConsent": "the pages listed are public and safe to show"
  }
}
```

Classification is on the **resolved IP**, never the hostname, because an
in-scope-looking name can point at a cloud metadata address or an unauthenticated
internal service, and DNS rebinding defeats name checks by construction. Every
resolved address must clear the policy, and **the address that passed is pinned
into the browser's own resolver at launch**, so the name the browser connects to
cannot resolve differently from the name that was checked.

There is one optional control on top of that:

```jsonc
{ "egress": { "strictSubresources": true } }
```

With it, a name that was never classified does not resolve at all — not for a
navigation, and not for a subresource either. It is **off by default**, and that
is a deliberate trade rather than an oversight: a real application legitimately
loads a font, an avatar or an error reporter from a host nobody listed, and
turning those into DNS failures would break real recordings to close a hole the
navigation checks already cover. Turn it on when filming something that should be
reaching nothing else, and expect to add hosts to `allowHosts`.

Four things are enforced and none of them is configurable:

1. Credentials are withheld at the origin boundary. An off-origin page is filmed
   from a separate context that was never granted one, and its rendered result is
   painted into the recording with the source URL visible. Cookies and
   localStorage were already origin-scoped; `httpCredentials` cannot be unset
   after a context exists, so not granting it is the only guarantee that holds.

   The visit stays open for the rest of the scene, so `scroll`, `click`, `hover`
   and `wait` still act on that page and the recording shows them. It ends at the
   scene boundary, or at the next `goto` or `slide`.
2. Every redirect hop is re-classified with its own pinned address.
3. `file://` is allowed by PATH, not by scheme: only inside the compiled slide
   directory, with `..`, symlinks and absolute escapes resolved first.
4. External origins use `external.readiness` and `external.dismiss`, because the
   app's busy selector does not exist on someone else's site.

`volatile: true` exempts external scenes from rehearsal EQUALITY, because a third
party's page carries rotating content nobody controls. They must still satisfy
their `expect`, and the exemption is recorded in the receipt so a green rehearsal
is not overclaimed.

---

## The optional app runner

```jsonc
{ "runner": {
    "start": "python manage.py runserver 8000",
    "cwd": ".",
    "readyWhen": { "http": "http://127.0.0.1:8000/healthz", "status": 200 },
    "timeoutMs": 60000,
    "stopAfter": true
} }
```

`readyWhen` accepts an HTTP probe or a log-line regex.

**This is arbitrary code execution, and it is treated as such.** It never
auto-runs. The exact command, its working directory and the config's sha256 are
printed, and an explicit approval is recorded against THAT SHA256 — so any edit
to the config invalidates it. It is refused entirely when stdin is not a TTY or
under `--non-interactive`.

---

## Branding, output and publishing

```jsonc
{
  "brand": {
    "name": "Acme",
    "wordmark": [{ "text": "Ac", "color": "#ef5350" }, { "text": "me", "color": "#ffffff" }],
    "kicker": "PRODUCT DEMO",
    "logo": "assets/logo.png",
    "accent": "#f59e0b",
    "background": "#0b0a10",
    "disclaimer": "…",
    "closingTagline": "…",
    "links": { "Website": "https://acme.example" }
  },
  "video": { "width": 1920, "height": 1080, "fps": 30, "bitrate": "12M" },
  "pronunciation": { "SSRF": "S.S.R.F.", "OSINT": "oh-sint" },
  "redact": [".customer-name", "[data-pii]"],
  "neverShow": ["Contoso", "unreleased"],
  "canvasConfirm": { "text": "Details" },
  "recordingIdentity": { "operatorAccounts": ["alice@example.com"] },
  "publish": {
    "youtube": {
      "titlePrefix": "Acme - ", "playlistId": "PL…", "privacy": "unlisted",
      "tags": ["Acme", "demo"], "footer": "publish/footer.md"
    }
  }
}
```

With no `brand`, the cards and the thumbnail fall back to a neutral, unbranded
look, so a first run produces something usable rather than something wearing
someone else's logo.

`pronunciation` extends and overrides the generic map, which ships only what is
true everywhere (API, HTTP, JSON, UI, SDK, 2D, 3D). Domain-specific entries
belong here.

Omit `publish` entirely and the upload module is absent. A video on disk is a
complete outcome.
