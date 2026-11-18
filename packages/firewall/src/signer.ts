// The only code that can move money. Loaded by the firewall process only (never the agent).
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getAddress } from "viem";
import { ARC_CHAIN_ID, CIRCLE_BLOCKCHAIN, USDC_ADDRESS, formatUsdc, requireEnv, type Address } from "@asf/shared";

export type TypedDataParams = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address; salt?: `0x${string}` };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** Compatible with @circle-fin/x402-batching's BatchEvmSigner ({ address, signTypedData }). */
export interface Signer {
  address: Address;
  signTypedData(params: TypedDataParams): Promise<`0x${string}`>;
  /** Execute a contract call, wait until onchain, return the tx hash. */
  contractCall(contract: Address, abiFunctionSignature: string, abiParameters: unknown[]): Promise<{ txHash: string }>;
  /** Direct USDC transfer (base units), wait until onchain, return the tx hash. */
  transfer(to: Address, amount: bigint, idempotencyKey?: string): Promise<{ txHash: string }>;
}

function assertArc(chainId: number) {
  if (Number(chainId) !== ARC_CHAIN_ID) throw new Error(`Refusing to sign for chainId ${chainId}: Arc testnet only`);
}

const EIP712_DOMAIN_FIELDS = [
  ["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"],
] as const;

export class CircleWalletSigner implements Signer {
  readonly address: Address;
  private client = initiateDeveloperControlledWalletsClient({
    apiKey: requireEnv("TEST_API_KEY"),
    entitySecret: requireEnv("ENTITY_SECRET"),
  });
  private walletId = requireEnv("CIRCLE_FIREWALL_WALLET_ID");

  constructor() {
    this.address = getAddress(requireEnv("CIRCLE_FIREWALL_WALLET_ADDRESS")) as Address;
  }

  async signTypedData(p: TypedDataParams): Promise<`0x${string}`> {
    assertArc(p.domain.chainId);
    const EIP712Domain = EIP712_DOMAIN_FIELDS.filter(([k]) => (p.domain as any)[k] !== undefined).map(([name, type]) => ({ name, type }));
    const data = JSON.stringify(
      { types: { EIP712Domain, ...p.types }, domain: p.domain, primaryType: p.primaryType, message: p.message },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    const res = await this.client.signTypedData({ walletId: this.walletId, data });
    const sig = res.data?.signature;
    if (!sig) throw new Error("Circle signTypedData returned no signature");
    return sig as `0x${string}`;
  }

  async contractCall(contract: Address, abiFunctionSignature: string, abiParameters: unknown[]) {
    const res = await this.client.createContractExecutionTransaction({
      walletId: this.walletId,
      contractAddress: contract,
      abiFunctionSignature,
      abiParameters: abiParameters.map((v) => (typeof v === "bigint" ? v.toString() : v)),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const id = res.data?.id;
    if (!id) throw new Error("Circle createContractExecutionTransaction returned no id");
    return this.waitConfirmed(id);
  }

  async transfer(to: Address, amount: bigint, idempotencyKey?: string) {
    if (amount <= 0n) throw new Error("transfer amount must be positive");
    const res = await this.client.createTransaction({
      walletId: this.walletId,
      tokenAddress: USDC_ADDRESS,
      amount: [formatUsdc(amount)],
      destinationAddress: getAddress(to),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const id = res.data?.id;
    if (!id) throw new Error("Circle createTransaction returned no id");
    return this.waitConfirmed(id);
  }

  /** Wait for CONFIRMED (not just a tx hash): later calls are simulated against chain state. */
  private async waitConfirmed(id: string) {
    const tx = await this.client.getTransaction({ id, waitForState: "CONFIRMED", signal: AbortSignal.timeout(120_000) });
    const txHash = tx.data?.transaction?.txHash;
    if (!txHash) throw new Error(`Circle transaction ${id} confirmed without a txHash`);
    return { txHash };
  }
}

export { CIRCLE_BLOCKCHAIN };
