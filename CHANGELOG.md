# Changelog

## 1.2.5

- New compact list layout for the public page (one row per service), selectable under Settings -> Display
- "Powered by Signalpost" links to the project on GitHub

## 1.2.0

- Atom/RSS feed of incidents and maintenance at `/feed.xml`
- Component groups: give components a group name and they're shown together in a collapsible section
- Upload your own logo (also used as favicon) and add footer links in Settings
- Display settings: 30/60/90 days of history, your own orange/red thresholds, whether slow responses count as up, and which details are shown publicly
- The status page updates itself every 30 seconds without reloading, and pauses in background tabs
- API: new `uptime_percent` and `page.history_days`; `uptime_90d` is deprecated

## 1.1.0

- Admin area works properly on phones: compact header with scrollable tabs, monitor lists as two-line rows, other tables collapse into cards
- Dashboard shows a one-line summary instead of the stat boxes
- Dashboard tables use the same column widths in every card
- Public page: plainer header background, no colour legend, "no incidents" shown once instead of per day
- Theme switch is an icon button
- Alert titles without emoji ("X is down", "X is back up")
- Shorter times and durations ("1h" instead of "1h 0m", "17:29:31" for today's checks)

## 1.0.0

First public release.

- Status page with 90-day history, uptime, incidents, maintenance, light/dark theme
- HTTP, TCP and ping monitors with internal / public / canary scopes and failure diagnosis
- Discord and email alerts with per-rule events, component filter and reminders
- Admin area with session auth, CSRF protection and login rate limiting
- Database backup download, automatic migrations
