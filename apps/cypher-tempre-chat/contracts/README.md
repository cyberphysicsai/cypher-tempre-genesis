# Cypher Tempre seat registry beta

This is a reviewed implementation draft with local EVM tests. It is **not deployed**, independently audited, or accepting payments. Do not send CPHY directly to a treasury address expecting a seat: only the registry purchase methods create seats.

One persistent seat costs exactly **21,000 CPHY**. Purchases of N seats cost N times that amount. The contract forwards CPHY directly from the paying wallet to the immutable treasury; it does not retain a payment balance. It verifies the treasury's actual token increase and reverts the whole transaction if the amount differs. The payer owns every purchased seat, including seats bought for other bridge installations.

## Base configuration

| Setting | Required value |
| --- | --- |
| Chain | Base Mainnet, 8453 |
| Token | `0x08Df470d41C11Ba5Cb60242747D76C65Ca52c94c` |
| Treasury | `0x7932CCa1BD502d6850842c423d21f527de47A0Ca` |
| Token decimals | 18 |
| Atomic unit price | `21000000000000000000000` |

The constructor receives token and treasury addresses, checks that the token is a contract with 18 decimals, and permanently fixes both. No setter, administrator, proxy upgrade, withdrawal, or seat marketplace exists. The browser and bridge must check chain ID, exact runtime bytecode, token, treasury, and price before accepting a deployment. Deploying this source with different constructor arguments creates a different contract and does not configure the official product.

## Build and tests

Requires Node.js 20 or later. Tooling dependencies are isolated here and are not required to run the local bridge.

```sh
cd contracts
npm ci --ignore-scripts
npm run compile
npm test
```

Compilation is deterministic with the pinned lockfile, Solidity 0.8.38, optimizer enabled for 200 runs, and EVM Paris. `artifacts/CypherTempreSeats.json` contains ABI, bytecode, method identifiers, immutable locations, and the expected runtime for the Base settings above. `artifacts/CypherTempreSeats.abi.json` is the standalone public ABI. `artifacts/base-deployment.json` contains a prepared creation transaction and its hashes. Compiling does not connect to a wallet, estimate fees, broadcast a transaction, or spend money.

The lockfile explicitly marks Ganache's nested `fsevents` package as optional, matching its `chokidar` dependency declaration. Ganache's bundled lock omits that metadata; retaining the correction lets `npm ci --ignore-scripts` skip the macOS-only watcher on Windows and Linux without `--force`. Package versions and integrity values remain unchanged.

Tests use a disposable in-process Ganache EVM with mock tokens. They cover exact payment and ownership, bounded batch purchases, atomic rollback, absent or insufficient allowance/balance, duplicate keys, owner-only binding and rotation, generation invalidation, false and empty ERC-20 returns, under-receipt, malicious reentrancy, constructor validation, raw-transfer non-activation, ETH rejection, and predicted-versus-actual runtime equality. They do not establish production security or live CPHY behavior.

## Methods and binding semantics

- `purchase(quantity)` buys 1–64 unbound seats and returns the first seat ID.
- `purchaseAndBind(bytes32[] deviceKeys)` buys and binds 1–64 seats in one atomic transaction. Zero keys or keys already active for the purchasing wallet reject the entire purchase, including payment. Duplicate keys within the same batch also reject it.
- `bind(seatId, deviceKey)` assigns a previously unbound seat. Only the purchasing wallet may call it.
- `rotate(seatId, deviceKey)` replaces an existing binding. Only the purchasing wallet may call it. The old reverse mapping is cleared and the generation increases. A new online verification must reject the previous key/generation.
- `seats(seatId)` returns `(address owner, uint64 generation, bytes32 deviceKey)`.
- `seatOfDevice(owner, deviceKey)` returns that owner's active seat ID, or zero if none. The locally selected expected owner is mandatory; never infer an owner from an observed public key or event.

Seat IDs begin at 1. Unbound seats have generation 0; the first binding has generation 1. A device key is an opaque nonzero 32-byte commitment. The bridge uses the SHA-256 hash of its Ed25519 SPKI DER public key; the contract does not inspect the key format or receive a private key. A fresh challenge from the paired browser proves possession locally. Chain contents, genesis hashes, model keys, names, hardware serials, and email addresses are not placed in this registry.

An active binding must be unique within its owning wallet. The reverse mapping is namespaced by owner because a public key hash can be copied from a pending transaction: another wallet must not be able to reserve that hash and block the honest buyer. Different owners may bind the same hash to their own paid seats, but that never grants control over each other's seats. The bridge verifies the locally selected expected owner as well as the key and generation. A released old key can later be attached to another paid seat. Wallet owners can recover seats to new bridge keys, but losing the owning wallet permanently loses that recovery authority. There is no administrator override. A wallet buying seats for other people also retains their seat recovery authority; make that arrangement explicit.

## Production activation handoff

1. Review the source, dependency lockfile, unit price, constructor addresses, expected code hashes, and test evidence. Arrange independent review appropriate for a contract accepting payments.
2. The deployer's wallet must be on Base Mainnet. The owner reviews and submits the prepared creation transaction from `artifacts/base-deployment.json`; deployment requires ETH for gas. No application script submits it.
3. Wait for the desired confirmation/finality policy, retrieve the resulting address and `eth_getCode`, and compare its raw-byte SHA-256 with `expectedRuntimeSha256` in the manifest. Verify the three immutable getters and confirm the source on an explorer with the exact compiler settings and constructor arguments.
4. Configure that verified address in the bridge and official frontend. Keep payments disabled when the address is absent or any setting or runtime check fails. Users approve only the exact intended CPHY amount to that verified registry, then invoke a purchase method. The wallet must approve every transaction itself.
5. Test one owner-controlled seat end to end before advertising a paid beta: payment receipt, bridge proof, reload, wrong key rejection, re-pairing, rotation, old-generation revocation, provider failure, and RPC/finality failure behavior.

## Security and privacy boundaries

The registry prevents unrelated wallets from taking already-owned seats or squatting on another owner's public commitment namespace. It records at most one active commitment per seat and one seat per commitment within an owning wallet. It does not prove that a key belongs to unique physical hardware or enforce a global simultaneous-session count. Software keys can be copied, and people can modify an open-source local bridge. Hardware-backed keys or an online lease authority would add different constraints and dependencies.

Wallets, amounts, seat ownership, and key commitments are public blockchain data. Hosting and RPC providers can observe connection metadata. No customer database is required, but this is pseudonymous access rather than an anonymous payment system or invulnerable infrastructure. Do not publish local chain contents or API keys.

A pending transaction is not final. Base L2 inclusion and Ethereum batch finality have different guarantees; the UI and bridge must apply the same explicit confirmation policy. Recheck current state for rotation and avoid granting an indefinite lease from an old cached receipt.

The CPHY token is external code. Its verified implementation has liquidity-pool tax behavior. The exact-receipt check rejects transfers that do not deliver the full price. These tests do not constitute an audit of CPHY, its owner permissions, the wallet, RPC providers, website, or device security. Reentrancy protections and atomic payment checks address the registry's immediate external-token boundary.

References: [Base network configuration](https://docs.base.org/get-started/connect-to-base), [Base finality](https://docs.base.org/specifications/transactions/transaction-finality), [ERC-20](https://eips.ethereum.org/EIPS/eip-20), [OpenZeppelin SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20), [CPHY token metadata](https://base.blockscout.com/api/v2/tokens/0x08Df470d41C11Ba5Cb60242747D76C65Ca52c94c).
