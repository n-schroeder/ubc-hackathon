// Fund the firewall wallet's Gateway balance, which every nanopayment the firewall makes is paid from.
//
//   npm run gateway:deposit [-- <amount, default 5>]
//
// Signs through Circle (CircleWalletSigner), so no key is ever in this process: approve USDC to the
// GatewayWallet contract, deposit, then wait for Gateway to see it. Deposits only when the Gateway balance
// is under 1 USDC. The unsafe baseline's wallet has its own script, `npm run baseline:deposit`.
import { GATEWAY_WALLET_ADDRESS, USDC_ADDRESS, formatUsdc, parseUsdc, txUrl } from "@asf/shared";
import { CircleWalletSigner } from "@asf/firewall/signer";
import { gatewayBalance, waitForGatewayBalance } from "./lib/gateway.ts";

const MIN = parseUsdc("1");

async function main() {
  const amount = parseUsdc(process.argv[2] ?? "5");
  const signer = new CircleWalletSigner();
  console.log("firewall (Circle wallet):", signer.address);

  const bal = await gatewayBalance(signer.address);
  console.log("gateway balance:", formatUsdc(bal));
  if (bal >= MIN) return console.log("already funded; nothing to do");

  console.log(`depositing ${formatUsdc(amount)} USDC…`);
  const a = await signer.contractCall(USDC_ADDRESS, "approve(address,uint256)", [GATEWAY_WALLET_ADDRESS, amount]);
  console.log("approve tx:", txUrl(a.txHash));
  const d = await signer.contractCall(GATEWAY_WALLET_ADDRESS, "deposit(address,uint256)", [USDC_ADDRESS, amount]);
  console.log("deposit tx:", txUrl(d.txHash));

  await waitForGatewayBalance(signer.address, MIN, (b) => console.log("  gateway balance:", formatUsdc(b)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
