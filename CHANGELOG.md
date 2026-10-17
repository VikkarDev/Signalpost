# Changelog

## 1.2.9

- Hovering (or tapping) a day in the history bars shows a breakdown: uptime that day, how long each incident lasted by impact, measured downtime and slow time, maintenance, and links to the related incidents
- Incident and maintenance times come from their actual start and end. Down and slow times are estimated from the number of failed or slow checks and are marked with *
- Fixed: on phones, tapping a bar opened the tooltip and closed it again straight away

## 1.2.8

- New alert channels: **ntfy** for push notifications to your phone (ntfy.sh or your own server, optional access token), and **webhook** for any URL that takes a JSON POST (Home Assistant, n8n, Slack-style webhooks)
- Webhook URLs, ntfy topics and tokens are masked in the admin area
- Database migration 3 runs automatically on start. Existing alert rules and their history are kept

## 1.2.7

- "checked 12s ago" and "Updated ..." count up live in the browser, every second, without extra requests. Uses the server's clock, so a wrong clock on the visitor's device doesn't matter. Hover for the exact time.
- Same for the "Checked", "Last check" and "Last sent" times in the admin area
- If a monitor misses its checks (more than two intervals with no result), the time turns yellow and says "(late)", so a stuck monitor doesn't sit there looking green

## 1.2.6

- Status icons show recent trouble: a service that's up again but failed within the last few hours shows a yellow "Recovered" icon instead of a green check (Settings -> Display, default 3 hours, can be turned off)
- Group headers say what's going on inside, e.g. "1 of 3 down", "1 slow" or "1 recovered recently"
- Fixed: a service inside a group with problems could take on the group's colour even when it was fine itself
- API: new `last_failure_at` per component (`status` is still the live state)

## 1.2.5

- Two new layouts for the public page, selectable under Settings -> Display:
  - Compact list: one row per service
  - Cards: a tile per service with a 24-hour response-time graph
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
