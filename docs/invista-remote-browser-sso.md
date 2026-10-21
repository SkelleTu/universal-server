# Invista remote-browser SSO

## Status
This is the server-to-server, one-time handoff foundation. It is not production-ready until the platform backend is deployed with the same service key, the canonical HTTPS URLs are configured, and the trusted Browser Use client has a secure way to obtain a launch URL.

## Flow
1. An already-authenticated platform session requests `POST /api/auth/remote-access-ticket`.
2. The platform backend requests a grant from Universal Server using `x-invista-server-key`.
3. Universal Server issues a cryptographically random grant valid for 60 seconds, bound to the user ID and one platform (`main` or `aura`).
4. The platform returns a one-time launch URL. The remote browser opens that URL on the platform's own HTTPS origin.
5. The platform consumes the grant server-to-server, regenerates its own session, and establishes Passport authentication in that browser only.
6. A used, expired, or cross-platform grant is rejected. Trading remains disarmed.

## Required environment
Universal Server:
- `INVISTA_UNIVERSAL_SERVER_KEY`: high-entropy shared backend-to-backend secret. Must be configured in production.

Each platform deployment:
- `UNIVERSAL_SERVER_URL`: canonical Universal Server HTTPS origin.
- `INVISTA_UNIVERSAL_SERVER_KEY`: same secret as Universal Server.
- `INVISTA_PLATFORM`: `main` for V10, `aura` for Aura.
- `INVISTA_PUBLIC_URL`: canonical HTTPS origin for that deployment.

## Security boundaries
- Deriv tokens and session cookies are not included in SSO tickets.
- The Universal Server logs paths without query strings; the platform suppresses the ticket endpoint response body from request logs.
- Grants are single-use and short-lived. The current grant store is in memory, so a Universal Server restart invalidates outstanding grants safely.
- Never add an unauthenticated endpoint that returns the currently active user or the latest grant. That would let an unrelated visitor impersonate a user.
- The Browser Use connector needs its own trusted authorization to request or receive a launch URL. Do not put a long-lived service secret in a public URL or browser task.
- The Deriv WebSocket/token broker and persistence are separate from this browser SSO handshake and must be verified independently.
