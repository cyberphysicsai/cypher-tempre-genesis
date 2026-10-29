# cyphertempre.ai Static Site

**The chat beta replaces the hosted landing page. See [CHAT-BETA.md](CHAT-BETA.md) for current deployment and local bridge instructions.** The legacy setup below describes the original read-only auditor, now preserved at `/audit/`. Its no-model-call behavior does not describe the new chat. Keep the existing Hostinger `site-deploy` installation and deploy its updated branch; do not delete or reinstall it using the old setup steps below.

Use `dashboard/public` as the production static publish directory for
`https://cyphertempre.ai`. The hosted site is only a UI shell — every byte of
Timechain data stays on the user's machine, read by their own local bridge.
**The dashboard is free: no payment, no wallet, no accounts.**

## Recommended Hostinger Setup

1. In Hostinger hPanel, open Websites and manage `cyphertempre.ai`.
2. Open File Manager for the domain, then `public_html`.
3. Delete the previous site files so `public_html` contains only the current
   static dashboard files.
4. Upload every file from `dashboard/public` into `public_html`:

```text
   index.html
   styles.css
   app.js
   config.js
   _headers
   .htaccess
```

5. Visit `https://cyphertempre.ai` and hard-refresh (Cmd/Ctrl+Shift+R) so the
   new `?v=` asset versions bypass any cache.

### Git deployment (recommended)

Hostinger's GIT feature deploys a **branch root** into `public_html` — it
cannot publish a repo subdirectory. Deploying `main` therefore 403s (no root
`index.html`) and exposes the whole repo over HTTP. Use the dedicated
`site-deploy` branch instead, whose root IS the static site:

1. Run `./site/deploy.sh` (splits `dashboard/public` into the `site-deploy`
   branch and pushes it).
2. hPanel → **Advanced → GIT**: remove any existing deployment of `main`.
3. File Manager → `public_html` → delete all previously deployed files
   (Hostinger needs a clean target).
4. Add the repository again with **branch `site-deploy`** and install path
   blank (deploys into `public_html`), then **Deploy**.
5. Optional: enable the auto-deploy webhook so every `site-deploy` push goes
   live automatically.

## Cloudflare Pages Alternative

Create a Pages project on this repository with build command `none` and build
output directory `dashboard/public`, then add the `cyphertempre.ai` and
`www.cyphertempre.ai` custom domains.

## User Flow In Production

1. User opens `https://cyphertempre.ai`.
2. User starts the local bridge:

```bash
cd dashboard
npm install
npm run bridge
```

3. The bridge prints a pairing code; the user enters it on the site.
4. The hosted page calls the user's local bridge at `http://127.0.0.1:8788`
   and the dashboard loads — immediately, for free.

No hosted service stores agent Timechain data. The local bridge binds to
localhost, refuses unpaired remote origins, and makes zero outbound network
calls.

## Staging

```bash
CT_DASHBOARD_PUBLIC_ORIGINS=https://staging.cyphertempre.ai npm run bridge
```
