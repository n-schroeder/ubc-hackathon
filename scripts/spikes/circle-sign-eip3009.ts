// M0 spike 1: can a Circle Developer-Controlled Wallet sign an EIP-3009
// TransferWithAuthorization (the authorization x402 "exact" payments use) through the API?
//
// Signs one authorization for Arc testnet USDC via Circle's signTypedData, then checks
// locally that the signature recovers to the Circle wallet's address and that our
// EIP-712 domain matches the token's onchain DOMAIN_SEPARATOR. Nothing is broadcast,
// so this needs no funds.
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, hashDomain, http, parseAbi, recoverTypedDataAddress, getAddress } from "viem";
import { arcTestnet } from "viem/chains";
import { config } from "dotenv";

config({ path: realpathSync(".env"), quiet: true });
const env = (k: string) => process.env[k] ?? (() => { throw new Error(`Missing ${k}`); })();

const USDC = "0x3600000000000000000000000000000000000000" as const;
const domain = { name: "USDC", version: "2", chainId: arcTestnet.id, verifyingContract: USDC } as const;
const types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const from = getAddress(env("CIRCLE_FIREWALL_WALLET_ADDRESS"));
const message = {
  from,
  to: getAddress(env("BASELINE_ADDRESS")),
  value: 1000n, // 0.001 USDC (6 decimals)
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
  nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
};

// 1. Our domain matches the token's onchain domain separator.
const pc = createPublicClient({ chain: arcTestnet, transport: http() });
const onchain = await pc.readContract({
  address: USDC, abi: parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]), functionName: "DOMAIN_SEPARATOR",
});
const ours = hashDomain({ domain, types: { EIP712Domain: [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] } });
console.log(`domain separator matches onchain: ${ours === onchain}`);

// 2. Circle signs it.
const client = initiateDeveloperControlledWalletsClient({ apiKey: env("TEST_API_KEY"), entitySecret: env("ENTITY_SECRET") });
const typedData = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" },
      { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ],
    ...types,
  },
  domain,
  primaryType: "TransferWithAuthorization",
  message,
};
const res = await client.signTypedData({
  walletId: env("CIRCLE_FIREWALL_WALLET_ID"),
  data: JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  memo: "M0 spike: EIP-3009 signing test",
});
const signature = res.data?.signature as `0x${string}` | undefined;
if (!signature) throw new Error("Circle returned no signature");
console.log(`signature: ${signature.slice(0, 18)}…`);

// 3. The signature recovers to the Circle wallet.
const recovered = await recoverTypedDataAddress({ domain, types, primaryType: "TransferWithAuthorization", message, signature });
console.log(`recovered: ${recovered}`);
console.log(`expected:  ${from}`);
console.log(recovered === from ? "PASS: Circle API produced a valid EIP-3009 authorization" : "FAIL: signer mismatch");
process.exit(recovered === from && ours === onchain ? 0 : 1);
