# cyphertempre.ai ChainChat beta

The production static root is `dashboard/public`. It contains **Cypher Tempre ChainChat**, with the original read-only auditor at `audit/` and embedded below the chat. Deploy only this static tree; never upload the repository root or local runtime state.

## Local bridge

Download the chat beta release or use `apps/cypher-tempre-chat`, install Node.js 20+ and Python 3.10+, and run:

```sh
cd apps/cypher-tempre-chat
npm ci --ignore-scripts
npm run beta
```

Open https://cyphertempre.ai, choose Pair bridge, and enter the code from the local terminal. Allow the browser's local-network prompt if requested. The chat bridge listens only on `127.0.0.1:8790` and trusts exactly the two declared site origins. Verify a wallet holding at least 21,000 CPHY on Base, pair your existing skill directory or create a genesis, then connect your own model API. Existing chains can be paired and inspected without holdings. No API key is stored in hosting or browser storage. The current block-height display reads the last sealed block index; genesis is 0.

The auditor pairs separately with `dashboard/server.mjs` on port 8788. Its local root redirects to `/audit/index.html`; its engine and API behavior are retained. The chat sends selected context to the user's chosen model provider; the read-only auditor does not make model calls.

## Hostinger deployment

The existing Hostinger GIT installation for cyphertempre.ai serves the root of the `site-deploy` branch into `public_html`. Keep that installation and branch. Publish the static tree with normal fast-forward Git commits; do not force-push or install `main` into `public_html`.

In hPanel, manage cyphertempre.ai and check the deployment dashboard for the exact `site-deploy` commit. Use the existing Redeploy control if an update was not automatically deployed. A push alone is not proof of publication: verify the completed deployment and public page, `/audit/`, font/JS assets, headers and hosted-to-local pairing afterward. The official page uses port 8790; custom ports require corresponding CSP changes or local serving. Publish a matching bridge release together with the frontend.

## Holdings access

Beta 0.4.0 uses **holdings**, not payments: at least 21,000 CPHY at `0x08Df470d41C11Ba5Cb60242747D76C65Ca52c94c`, Base 8453. No new contract, treasury transfer, token approval or permit is required. The earlier payment registry in `contracts/` is an unused prototype, not an activation step.

The paired bridge generates a single-use, expiring Sign-In with Ethereum message bound to the exact page origin, Base, bridge key and pairing session. The bridge verifies the wallet signature and reads the token balance at a canonical block. Authorization lasts at most 30 minutes, and balance checks expire within 30 seconds. Protected operations recheck access; expiry, insufficient balance and RPC errors hold new work. History, chain inspection and the original auditor remain accessible.

A native write already admitted while authorized may complete if eligibility changes during it. The bridge preserves that block's real receipt and completed-block counts, then holds subsequent work. It does not roll back immutable history or claim an existing block was never committed.

No customer database is introduced. Wallet signatures and session grants remain in bridge memory; model keys and chain contents are not sent to hosting. Addresses/balances and network metadata are not anonymous. The official page is static and enforcement runs in the user-controlled open-source bridge; modified copies can remove it. A qualifying wallet can authorize multiple installations. Neither a balance threshold nor a software key reserves exclusive instances or proves unique physical hardware. A strict hosted access boundary would require a separate protected service.
