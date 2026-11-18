// QuickNode Streams filter for the onchain watchdog. Network: Arc testnet. Dataset: logs.
//
// Keeps only USDC Transfer logs whose `from` is the firewall's wallet, i.e. every USDC that leaves it.
// `npm run watchdog:stream` fills in WALLET from CIRCLE_FIREWALL_WALLET_ADDRESS before uploading this.
//
// Two emitters, because Arc logs each USDC movement twice (verified on testnet):
//   0x3600…0000  the USDC ERC-20 interface, value in 6 decimals
//   0xffff…fffe  Arc's native-USDC balance, value in 18 decimals
// The webhook merges the pair into one outflow. Keeping both means a movement that only shows up as one of
// them is still seen.
//
// Returning null when nothing matches means QuickNode skips the delivery, so the webhook only hears about
// blocks where money left the wallet.
var WALLET = "__FIREWALL_WALLET__";

function main(stream) {
  var TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  var EMITTERS = ["0x3600000000000000000000000000000000000000", "0xfffffffffffffffffffffffffffffffffffffffe"];
  var fromTopic = "0x000000000000000000000000" + WALLET.toLowerCase().slice(2);
  var out = [];

  // The logs dataset nests logs by block and by receipt; walk any depth so a layout change can't hide a log.
  function walk(x, depth) {
    if (!x || depth > 6) return;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i], depth + 1); return; }
    if (x.topics && x.address) {
      var t = x.topics;
      if (t.length >= 3 && String(t[0]).toLowerCase() === TRANSFER && String(t[1]).toLowerCase() === fromTopic &&
          EMITTERS.indexOf(String(x.address).toLowerCase()) >= 0) {
        out.push({
          address: x.address, topics: t, data: x.data, transactionHash: x.transactionHash,
          blockNumber: x.blockNumber, logIndex: x.logIndex, removed: x.removed === true,
        });
      }
      return;
    }
    if (x.logs) walk(x.logs, depth + 1);
  }

  walk(stream.data, 0);
  return out.length ? { outflows: out } : null;
}
