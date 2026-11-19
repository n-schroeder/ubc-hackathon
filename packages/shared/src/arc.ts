// Arc testnet constants. Verified 2026-11-17: USDC metadata read onchain
// (scripts/spikes/usdc-domain.ts); Gateway addresses from @circle-fin/x402-batching@4.0.0.
import { arcTestnet } from "viem/chains";

export const ARC_TESTNET = arcTestnet;
export const ARC_CHAIN_ID = 5042002 as const;
/** CAIP-2 network id, as x402 uses it. */
export const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}` as const;
export const CIRCLE_BLOCKCHAIN = "ARC-TESTNET" as const;

/** USDC ERC-20 on Arc testnet (6 decimals; EIP-712 domain name "USDC", version "2"). */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
/** Circle Gateway Wallet (deposit target) on testnets. */
export const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;
/** Circle Gateway Minter on testnets. */
export const GATEWAY_MINTER_ADDRESS = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const;
export const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com/v1" as const;

export const EXPLORER_URL = arcTestnet.blockExplorers.default.url;
export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (addr: string) => `${EXPLORER_URL}/address/${addr}`;
/** "0x3600…0000" for an address or tx hash; short strings pass through, a missing one prints "?". */
export const short = (a?: string) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? "?"));
