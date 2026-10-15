# Signalpost

[![CI](https://github.com/VikkarDev/Signalpost/actions/workflows/ci.yml/badge.svg)](https://github.com/VikkarDev/Signalpost/actions/workflows/ci.yml)

A small self-hosted status page with built-in uptime monitoring. One container, one SQLite file, no external services.

It checks your services over HTTP, TCP or ping, keeps 90 days of history, and shows it on a public page in the style of the big hosted status pages. There's an admin area for monitors, incidents, maintenance windows and alerts (Discord and email).

I built it to run on a Synology NAS behind Cloudflare Tunnel, but it runs anywhere Docker does.

![Status page, light theme](docs/screenshot-light.png)

## Features

- Public status page with overall banner, per-service 90-day history bars and uptime percentage. Works on mobile and has a light and dark theme.
- HTTP(S), TCP and ping checks. Configurable interval, timeout, expected status codes, keyword match, "slow" threshold and how many failures in a row count as down.
- Separate **internal**, **public** and **canary** checks, so you can tell "the app is down" apart from "the tunnel/DNS/internet is down" (more below).
- Incidents with a public timeline, and maintenance windows that pause alerts and don't count against uptime.
- Alerts to Discord webhooks and email, with rules per event type, per service and optional reminders while something stays down. Also warns before TLS certificates expire.
- Read-only JSON API at `/api/v1/status`.
- Small footprint: about 30-60 MB RAM, a single dependency (nodemailer), Node 24's built-in SQLite.

![Admin dashboard, dark theme](docs/screenshot-admin-dark.png)

## Quick start

```bash
git clone https://github.com/VikkarDev/Signalpost.git signalpost && cd signalpost
# edit docker-compose.yml: set ADMIN_PASSWORD and PUBLIC_URL
docker compose up -d --build
```

Open `http://localhost:3000` for the status page and `http://localhost:3000/admin` to log in.

The admin account is created on first start from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. After that the env var isn't used anymore, so you can change the password in Settings and remove it from the compose file.

Data is stored in the `signalpost-data` volume and survives restarts and updates.

## How the checks fit together

**Components** are what visitors see ("Website", "Files", "API"). **Monitors** do the actual checking and belong to a component. Every monitor has a scope:

- **internal**: talks to the service directly, e.g. `http://my-container:8080` on the Docker network or a LAN IP. Tells you whether the app itself works.
- **public**: goes through the same path as your visitors, e.g. `https://files.example.com` via DNS, Cloudflare and the tunnel.
- **canary**: something that should always be up, like `https://1.1.1.1` or ping `8.8.8.8`. If all canaries fail, the server has lost its internet connection.

When something breaks, the admin dashboard uses these to tell you where:

| internal | public | canaries | you'll see |
|---|---|---|---|
| down | - | - | Application failure |
| up | down, Cloudflare 52x/530 | up | Cloudflare / tunnel problem |
| up | down, DNS error | up | DNS problem |
| up | down, other error | up | Problem between the internet and your server |
| - | down | all down | The server's internet connection is down |

You don't have to use internal checks, but if you only check the public URL you can't tell these cases apart.

### Uptime and history

Uptime is `(up + slow) / all checks`. It's only calculated from checks that actually ran, so a new monitor shows "No data yet" and grey bars until data comes in. Checks during maintenance are stored but left out.

A component's uptime is its worst monitor's uptime. Canaries are never counted.

Bar colours per day:
- green: no failures
- yellow: some slow responses
- orange: failures, but at least 99% up
- red: below 99%
- blue: maintenance only
- grey: no data

Individual check results are kept for 14 days (`RAW_RETENTION_DAYS`). The daily totals behind the bars are kept for 400 days.

## Running on a Synology NAS

This works with Container Manager on DSM 7.2 and doesn't need SSH.

1. In **File Station**, create `docker/signalpost` and upload the project into it. The easiest way is to upload a zip of the repo and use *Extract here*.
2. Open **Container Manager → Project → Create**:
   - Name: `signalpost`
   - Path: `/docker/signalpost`
   - Source: *Use existing docker-compose.yml*
3. Edit the compose file in the editor that opens. At minimum set `ADMIN_PASSWORD`, `PUBLIC_URL` and `TZ`.
4. Click through to **Done**. Container Manager builds the image (a couple of minutes the first time) and starts it.
5. Under **Container**, `signalpost` should show as running and, after about 20 seconds, healthy. The **Log** tab should show `http server listening`.

The app runs as UID 1000. The named volume in the compose file handles permissions for you. If you'd rather use a folder (`./data:/data`) so Hyper Backup can see it, give UID 1000 write access to that folder, or the container will log that `/data` isn't writable.

## Behind Cloudflare Tunnel

If cloudflared runs as a container, put Signalpost on the same Docker network and skip the port mapping. In `docker-compose.yml`, remove `ports:`, uncomment the `networks:` sections and set the network name to the one cloudflared uses.

Then in the Cloudflare dashboard, under **Zero Trust → Networks → Tunnels → your tunnel → Public Hostname → Add**:

- Subdomain/domain: e.g. `status` / `example.com`
- Path: empty
- Service: `HTTP`, URL `signalpost:3000`

I'd also recommend putting **Cloudflare Access** in front of the `/admin` path (Access → Applications → Self-hosted, path `admin`). That gives the admin area a second login without touching the public page.

The app reads the visitor IP from `CF-Connecting-IP`. If the port is also published on your LAN, see the note in [SECURITY.md](SECURITY.md).

## Setting things up

A typical setup for one service:

| Monitor | Type | Scope | Target |
|---|---|---|---|
| files public | HTTP | public | `https://files.example.com` |
| files internal | HTTP | internal | `http://filebrowser:80` |
| NAS DSM | TCP | internal | `192.168.1.10` port `5001` |
| cloudflare canary | HTTP | canary | `https://1.1.1.1` |
| google canary | Ping | canary | `8.8.8.8` |

Defaults that work well: 60 s interval, 10 s timeout, 2 failures before down.
- For apps behind a login page, allow `401` in the expected status codes.
- Only tick "ignore TLS errors" for internal services with self-signed certificates.

For Discord alerts, create a webhook in your server (Server Settings → Integrations → Webhooks) and paste the URL into a new alert rule. **Send test** confirms it works.

## Configuration

Everything is set through environment variables. Only `ADMIN_PASSWORD` is needed, and only on the first start.

| Variable | Default | |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | | Creates the admin account if none exists. Min. 12 characters |
| `ADMIN_RESET_PASSWORD` | `false` | Set to `true` once to reset the admin password to `ADMIN_PASSWORD` |
| `PUBLIC_URL` | `http://localhost:3000` | Used in alert links and the checker's User-Agent |
| `TZ` / `STATUS_TIMEZONE` | `UTC` | Timezone for day boundaries and displayed times. `STATUS_TIMEZONE` wins if both are set |
| `SITE_NAME` | `Status` | Initial site name (can be changed in Settings) |
| `PORT` | `3000` | |
| `DATA_DIR` | `/data` | Where the database is stored |
| `LOG_LEVEL` | `info` | `debug` logs every check |
| `SESSION_TTL_HOURS` | `12` | Admin session lifetime, extended while active |
| `COOKIE_SECURE` | `auto` | Secure cookies when served over HTTPS. Set `false` to log in over plain HTTP |
| `TRUST_PROXY` | `true` | Trust `CF-Connecting-IP` / `X-Forwarded-*` headers |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failed logins per IP before a lockout |
| `LOGIN_WINDOW_MINUTES` | `15` | Lockout window |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` | `120` | Requests per minute per IP |
| `MAX_CONCURRENT_CHECKS` | `8` | |
| `MIN_CHECK_INTERVAL_SECONDS` | `20` | Lowest interval the admin form accepts |
| `RAW_RETENTION_DAYS` | `14` | How long individual check results are kept |
| `DAILY_RETENTION_DAYS` | `400` | How long daily totals are kept (min. 91) |
| `SMTP_HOST` | | Email is disabled when empty |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for port 465. Otherwise STARTTLS is used when available |
| `SMTP_USER`, `SMTP_PASSWORD` | | |
| `SMTP_FROM` | | e.g. `Status <status@example.com>` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long to wait for running checks on shutdown |

If you can't log in when testing over plain HTTP on your LAN, `COOKIE_SECURE=false` is usually the fix.

## Updating

```bash
git pull
docker compose up -d --build
```

On Synology: stop the project, replace the files (keep your compose file), then use **Action → Build**.

Database migrations run automatically on startup. Older versions refuse to start against a database from a newer version rather than risk damaging it.

Back up first. **Settings → Download database backup** gives you a consistent copy even while the app is running. To restore:
1. Stop the container.
2. Put the file in the data folder as `signalpost.db` and delete any `signalpost.db-wal` / `-shm` files next to it.
3. Start the container again.

## Known limitations

- One admin account, no roles or user management.
- No built-in 2FA. Use Cloudflare Access or similar in front of `/admin`.
- Visitors can't subscribe to updates.
- No DNS-record or UDP checks.
- History is per day. Uptime counts checks, not minutes. That's the same thing unless you change a monitor's interval.
- Rate limits and login lockouts are kept in memory and reset on restart. It's meant to run as a single instance.
- Ping needs Docker to allow the `net.ipv4.ping_group_range` sysctl. That's the default on any recent Docker. On very old versions, remove the `sysctls` line and ping monitors will report "not permitted". HTTP and TCP still work.

## Development

Needs Node 24.

```bash
npm ci
npm test
DATA_DIR=./.localdata ADMIN_PASSWORD=dev-password-123 COOKIE_SECURE=false npm start
```

`npm test` starts the real server against a temporary database and runs it through login, checks, incidents, maintenance, alerts and backups. There are also unit tests for the timezone and status logic.

```
src/server.js          http server, routing, shutdown
src/config.js          environment variables
src/db.js              sqlite + migration runner
src/migrations.js      schema (append-only)
src/auth.js            passwords, sessions, csrf, login limits
src/monitor/probes.js  http / tcp / ping checks
src/monitor/engine.js  scheduler, storing results, retention
src/status.js          component status, uptime, diagnosis
src/notify/index.js    alert rules, discord, email
src/routes/            public and admin routes
src/views/             server-rendered html
public/                css, js, svg
test/                  node:test suites
```

Schema changes go in a new entry at the end of `src/migrations.js`. Don't edit existing ones.

See [CONTRIBUTING.md](CONTRIBUTING.md) if you want to send a PR, and [SECURITY.md](SECURITY.md) for how the app handles auth and how to report a vulnerability.

## License

[MIT](LICENSE)
