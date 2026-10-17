# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's **Report a vulnerability** button on the Security tab of this repo (private advisory) and I'll get back to you as soon as I can.

Only the latest release gets fixes.

## How the app handles security

Notes on what's in place, mostly so you know what you're deploying.

### Admin login

- Passwords are hashed with scrypt (N=65536, r=8, p=1, random salt). Minimum length is 12. The placeholder from the example compose file is rejected.
- The first admin account can only be created from the `ADMIN_PASSWORD` env var. There's no web-based setup page, so nobody can claim a fresh install before you do.
- Sessions:
  - 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` when served over HTTPS.
  - The database only stores a SHA-256 hash of the token.
  - Logging out deletes the session on the server.
  - Changing your password signs out all other sessions.
- Every form that changes something carries a per-session CSRF token.
- Failed logins are limited per IP and per username. Once over the limit, even the right password is refused until the window passes.
- There is no 2FA. If the admin area is reachable from the internet, put Cloudflare Access (or another auth proxy) in front of `/admin`.

### Secrets

- Admin and SMTP passwords come from environment variables and are never stored in plain text.
- Discord and other webhook URLs, ntfy topics and access tokens are stored in the database. They're masked in the admin UI (tokens are never shown at all) and never shown publicly.
- The database backup download contains webhook URLs. Keep backups private.

### What the public can see

The public page, `/history`, `/incidents/:id` and `/api/v1/status` show component names, descriptions, status, uptime, response time, incidents and maintenance.

They never show monitor targets, hostnames, IPs, error messages, canary monitors, monitors without a component, or hidden components. `/healthz` only returns `{"status":"ok"}`.

Everything under `/admin` needs a session.

### Rate limiting

- All dynamic routes are rate limited per client IP (120/min by default).
- Request bodies are capped at 64 KB, and slow requests time out.

The client IP is taken from `CF-Connecting-IP` / `X-Forwarded-For` when `TRUST_PROXY=true` (the default). If you publish the port on your LAN *and* run behind Cloudflare, someone on your LAN could fake that header to dodge the per-IP limits. Either don't publish the port, or set `TRUST_PROXY=false` if you don't use a proxy at all.

### Browser side

- All HTML output is escaped by default.
- There's a strict Content-Security-Policy: no inline scripts, no framing.
- Also sent: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and the cross-origin headers.
- HSTS is left to your proxy.
- Redirects after login only go to local paths.

### Container

- Runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped and `no-new-privileges`.
- Ping uses unprivileged ICMP sockets, so it doesn't need `NET_RAW`.

### Things to be aware of

Monitors can point anywhere, including your LAN. That's the whole point, but it also means anyone with admin access can use the app to probe your network. Treat the admin login accordingly.
