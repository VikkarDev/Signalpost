# Contributing

Bug reports and PRs are welcome.

**Bugs:** open an issue with what you expected, what happened, and the relevant lines from the container log (it's JSON, one line per event). Leave out hostnames or webhook URLs you don't want public.

**Code:**

- You need Node 24. Run `npm ci` and `npm test` before opening a PR. If you change behaviour, add or update a test in `test/`.
- Keep dependencies to a minimum. The app currently has one (nodemailer), and adding another needs a good reason.
- Schema changes go in a new migration at the end of `src/migrations.js`. Never edit one that's already released.
- HTML goes through the `html` template tag in `src/lib/html.js`, which escapes everything. Only use `raw()` for markup the app generates itself.
- No inline `<script>` or `style` attributes. The CSP blocks them.
- Formatting: 2 spaces, single quotes, semicolons. Match the code around you.

For bigger changes it's worth opening an issue first so we can agree on the approach.
