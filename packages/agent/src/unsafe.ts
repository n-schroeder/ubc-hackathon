// The "without the firewall" baseline (F22), for the before/after demo shot only.
//
// This is how most agent wallets work today: the agent process holds a key and signs whatever its tools
// ask for. No budget, no allowlist, no price check, no breaker. It uses BASELINE_PRIVATE_KEY, a separate
// throwaway wallet holding a few testnet dollars, and never the firewall's wallet.
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET, USDC_ADDRESS, formatUsdc, loadRegistry, parseUsdc, toListing, txUrl, type RegistryEntry } from "@asf/shared";
import { payQuote, requestQuote } from "@asf/firewall/x402";
import type { PaymentBackend, ToolOutput } from "./backend.ts";

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export class UnsafeBackend implements PaymentBackend {
  readonly label = "unsafe";
  readonly address: `0x${string}`;
  spent = 0n;
  private account;
  private wallet;
  private chain;
  private registry: RegistryEntry[];

  constructor(privateKey: string, private task: string, registry = loadRegistry()) {
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    this.address = this.account.address;
    this.wallet = createWalletClient({ account: this.account, chain: ARC_TESTNET, transport: http() });
    this.chain = createPublicClient({ chain: ARC_TESTNET, transport: http() });
    this.registry = registry;
  }

  async listServices(): Promise<ToolOutput> {
    return { services: this.registry.map(toListing) };
  }

  async callPaidApi(service: string, path: string, _reason: string): Promise<ToolOutput> {
    const s = this.registry.find((r) => r.id === service);
    if (!s) return { paid: false, error: `unknown service "${service}"` };
    const url = new URL(s.baseUrl + (path.startsWith("/") ? path : `/${path}`)).toString();
    const q = await requestQuote(url);
    if (q.kind === "free") return { paid: false, data: q.data };
    // Signs exactly what the vendor asked for, whatever the price or payee (P2).
    const signer = { address: this.address, signTypedData: (p: any) => this.account.signTypedData(p) };
    const r = await payQuote(url, q.required, q.option, signer as any);
    this.spent += q.quote.amount;
    // Same shape the firewalled backend returns for an approved call, so the side-by-side demo differs only
    // in who decides, not in what the model gets to see.
    return {
      outcome: "approved", amount: formatUsdc(q.quote.amount), detail: `paid ${formatUsdc(q.quote.amount)} USDC`,
      paid: true, gatewayTransferId: r.gatewayTransferId, data: r.data,
    };
  }

  async sendPayment(recipient: string, amount: string, _reason: string): Promise<ToolOutput> {
    if (!isAddress(recipient)) return { paid: false, error: "recipient is not an address" };
    const value = parseUsdc(amount);
    if (value <= 0n) return { paid: false, error: "amount must be positive" };
    const hash = await this.wallet.sendTransaction({
      to: USDC_ADDRESS,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(recipient), value] }),
    });
    const receipt = await this.chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { paid: false, txHash: hash, explorerUrl: txUrl(hash), error: "transfer reverted" };
    this.spent += value;
    return { paid: true, amount: formatUsdc(value), recipient, txHash: hash, explorerUrl: txUrl(hash) };
  }

  async checkPayment(intentId: string): Promise<ToolOutput> {
    return { error: `no pending payment ${intentId}: payments here complete immediately` };
  }

  async getMandate(): Promise<ToolOutput> {
    return { task: this.task, spent: formatUsdc(this.spent) };
  }
}
