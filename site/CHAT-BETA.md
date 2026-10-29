# cyphertempre.ai chat beta

The production static root is `dashboard/public`. It contains the Agentic Timechain Metaprogramming Interface, with the original read-only auditor at `audit/` and embedded below the chat. Deploy only this static tree; never upload the repository root or local runtime state.

## Local bridge

Download the chat beta release or use `apps/cypher-tempre-chat`, install Node.js 20+ and Python 3.10+, and run:

```sh
cd apps/cypher-tempre-chat
npm run beta
```

Open https://cyphertempre.ai, choose Pair bridge, and enter the code from the local terminal. Allow the browser's local-network prompt if requested. The chat bridge listens only on `127.0.0.1:8790` and trusts exactly the two declared site origins. Pair your existing skill directory in the interface, then connect your own model API. No API key is stored in hosting or browser storage.

The auditor pairs separately with `dashboard/server.mjs` on port 8788. Its local root redirects to `/audit/index.html`; its engine and API behavior are retained. The chat sends selected context to the user's chosen model provider; the read-only auditor does not make model calls.

## Hostinger deployment

The existing Hostinger GIT installation for cyphertempre.ai serves the root of the `site-deploy` branch into `public_html`. Keep that installation and branch. Publish the static tree with normal fast-forward Git commits; do not force-push or install `main` into `public_html`.

In hPanel, manage cyphertempre.ai, open Advanced → GIT, and deploy the existing `site-deploy` installation. No webhook was configured during this work, so a push is not proof of publication. Verify the public page, `/audit/`, font/JS assets, headers and hosted-to-local pairing afterward. The official page uses port 8790; custom ports require corresponding CSP changes or local serving.

## Payment activation

Payments are disabled in beta 0.3.0. No Base registry has been deployed. Do not send CPHY directly to the treasury: direct transfers do not register seats. The registry, ABI, tests, and wallet deployment transaction are in `apps/cypher-tempre-chat/contracts`.

After a reviewed wallet deployment, verify its runtime hash, Base 8453, CPHY token, treasury and 21,000 CPHY unit price. Update `apps/cypher-tempre-chat/public/license-config.json`, synchronize it into the static publish tree, rebuild the bridge release, and publish both together. Only then set `required:true`. Users approve each wallet transaction themselves.

The registry stores paid seat ownership and owner-scoped bridge-key commitments. It does not store Timechain contents, API keys, names or emails. Wallet activity is public. Installation keys do not prove physical-machine identity, and an open-source local app cannot prevent all copying or modification. Two Base L2 confirmations give provisional activation, not final settlement.
