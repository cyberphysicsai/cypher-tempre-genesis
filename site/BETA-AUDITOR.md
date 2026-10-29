# Preserved Timechain auditor

`dashboard/public/audit/` copies the existing production auditor from main commit
`73c5013f654979b26dc10bbec58d834d976f3c34`. Original skill files and bridge engine
code are unchanged. The root `dashboard/public` chat replacement is a separate
integration step.

Changes inside the preserved copy:

- Three visible former gate-acronym labels in `index.html` now say PoI.
- Orbitron replaces every declared font, including code and form fields. It uses
  the same locally bundled font as the chat at `../fonts/orbitron/`, with its
  original SIL OFL license. Existing motifs and audit features remain present.
- `/audit/` explicitly connects to the original local audit bridge at
  `http://127.0.0.1:8788`, including when the surrounding chat is previewed locally.
- Pairing credentials remain in page memory. Startup removes a token saved by
  the earlier UI, reload requires pairing again, and changing bridge URLs clears
  the current token. The pairing code input is cleared after success.
- Bridge URLs accept only HTTP `localhost` or `127.0.0.1`, with no credentials,
  non-root path, query or fragment. Browser CSP permits official ports 8788 and
  8790; a custom port requires a corresponding hosting policy change.
- Relative asset URLs continue to work below `/audit/`. Audit API paths retain
  their original `/api/...` names against the selected local bridge origin.
- The nested `.htaccess` allows same-origin framing. The root policy permits the
  same-origin frame but still forbids another site from embedding the chat.
  The optional Pages `_headers` applies a common CSP to every path, with an
  additional restrictive `frame-ancestors 'none'` policy on the root document.

Suggested embedding below the main chat:

```html
<section class="audit-section" aria-labelledby="audit-heading">
  <h2 id="audit-heading">Audit your agent's Timechain</h2>
  <iframe src="./audit/" title="Local Timechain auditor" loading="lazy"
    sandbox="allow-scripts allow-same-origin allow-downloads"
    referrerpolicy="no-referrer"></iframe>
  <a href="./audit/" target="_blank" rel="noopener noreferrer">Open the auditor separately</a>
</section>
```

Use a generous responsive frame height and preserve scrolling inside it. The
auditor pairs independently with port 8788; chat pairs with port 8790. A shared
pairing code is not implied. `allow-scripts` plus `allow-same-origin` is necessary
for this same-origin app; the sandbox is not a security boundary against trusted
same-origin script. It still limits unrequested navigation and browser actions.

## Deployment

The existing live domain is served by Hostinger from the `site-deploy` branch
root, which corresponds to the static `dashboard/public` subtree. Keep a source
commit on main and a corresponding static-only deployment commit. Use normal
fast-forward pushes and check for intervening remote changes. Do not use the
existing force-push script as an unreviewed deployment shortcut.

At inspection time GitHub had no deployment webhook configured. A Git push is
therefore not proof of live publication: use Hostinger's existing Deploy/upload
flow and verify the returned page and HTTP security headers from
`https://cyphertempre.ai` afterward. Do not upload the repository root, local
state, credentials, or chains to `public_html`.

Validation: `node --check dashboard/public/audit/app.js` and
`node --test dashboard/test/audit-site.test.mjs`.

For a Node-served local preview, `.htaccess` is not interpreted. The preview
server must itself emit `frame-ancestors 'self'` for `/audit/` documents and allow
`frame-src 'self'` on the parent. Otherwise it will block the iframe despite the
correct production Hostinger configuration.
