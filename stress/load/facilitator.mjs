// Local stand-in for the x402 facilitator. /supported answers like the hosted one; /verify ALWAYS refuses with a
// marker reason, and /settle always fails, so nothing in the stress run can buy a pack or move money. A paid retry
// whose requirements matched the gateway's offer reaches /verify and comes back with the marker; one that did not
// match is refused by the gateway before any facilitator call. /count reports how many verifies arrived.
import http from "node:http";

const port = Number(process.env.FAC_PORT ?? 4999);
let verifies = 0;
let settles = 0;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") {
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "cardano:preprod",
        extra: { assetTransferMethods: ["default", "script"], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } } }], extensions: [], signers: {} }));
    } else if (req.url === "/verify") {
      verifies++;
      res.end(JSON.stringify({ isValid: false, invalidReason: "stress_stub_verify", payer: "" }));
    } else if (req.url === "/settle") {
      settles++;
      res.end(JSON.stringify({ success: false, errorReason: "stress_stub_settle", transaction: "", network: "cardano:preprod" }));
    } else if (req.url === "/count") {
      res.end(JSON.stringify({ verifies, settles }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
}).listen(port, "127.0.0.1", () => console.log(`[facilitator] stub on 127.0.0.1:${port}`));
