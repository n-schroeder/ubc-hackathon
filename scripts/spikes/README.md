# M0 spikes (historical)

Throwaway experiments from milestone 0 that answered "can this stack work at all?" before the real code existed. [`docs/SPEC.md`](../../docs/SPEC.md) cites them as evidence. Nothing in setup or the demo needs them; they have no npm scripts. Run one with `npx tsx scripts/spikes/<file>.ts` if you want to repeat the experiment.

- `circle-sign-eip3009.ts`: Circle's Developer-Controlled Wallet signs an EIP-3009 `TransferWithAuthorization` for Arc USDC, and the signature recovers to the wallet. Signs only, broadcasts nothing.
- `usdc-domain.ts`: reads Arc testnet USDC's ERC-20 metadata and EIP-712 domain from the chain. Read-only.
- `gateway-nanopayment.ts`: one real $0.001 Gateway nanopayment signed through Circle, against a throwaway local seller. **Spends testnet USDC**, and deposits 5 USDC into Gateway first if the balance is under 1. Use `npm run gateway:deposit` for the deposit step instead.
