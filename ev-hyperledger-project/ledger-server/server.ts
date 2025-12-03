import path from "path";
import fs from "fs";
import express, { Request, Response } from "express";
import cors from "cors";
import { Gateway, Wallets } from "fabric-network";

const app = express();
app.use(cors());
app.use(express.json());

let contract: any = null;
const sseClients = new Set<Response>();

//load wallet identity
async function loadIdentity() {
  const walletPath = path.join(__dirname, "wallet");
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identityLabel = "appUser";

  const existing = await wallet.get(identityLabel);
  if (existing) {
    console.log(`Wallet already has identity "${identityLabel}".`);
    return { wallet, identityLabel };
  }

  console.log(
    `Identity "${identityLabel}" not found — importing Admin@org1...`
  );

  const mspPath = path.resolve(
    process.env.HOME || "",
    "fabric-samples",
    "test-network",
    "organizations",
    "peerOrganizations",
    "org1.example.com",
    "users",
    "Admin@org1.example.com",
    "msp"
  );

  const certPath = path.join(
    mspPath,
    "signcerts",
    fs.readdirSync(path.join(mspPath, "signcerts"))[0]
  );
  const keyPath = path.join(
    mspPath,
    "keystore",
    fs.readdirSync(path.join(mspPath, "keystore"))[0]
  );

  const certificate = fs.readFileSync(certPath, "utf8");
  const privateKey = fs.readFileSync(keyPath, "utf8");

//identity format
  const identity: any = {
    credentials: {
      certificate,
      privateKey,
    },
    mspId: "Org1MSP",
    type: "X.509",
  };

  await wallet.put(identityLabel, identity);

  console.log(`Imported Admin@org1 as "${identityLabel}".`);
  return { wallet, identityLabel };
}

//init fab maybe remove this 
async function initFabric() {
  const ccpPath = path.resolve(
    process.env.HOME || "",
    "fabric-samples",
    "test-network",
    "organizations",
    "peerOrganizations",
    "org1.example.com",
    "connection-org1.json"
  );
  const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));

  const { wallet, identityLabel } = await loadIdentity();

  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: identityLabel,
    discovery: { enabled: true, asLocalhost: true },
  });

  const network = await gateway.getNetwork("mychannel");
  contract = network.getContract("ev-contract");

  console.log("Fabric connection ready (discovery ON, event service OFF).");
}

//writes event to chain and sse
app.post("/api/log", async (req: Request, res: Response) => {
  try {
    if (!contract) {
      return res.status(500).json({ error: "Fabric not initialized" });
    }

    const { sessionId, source, payload } = req.body;

    if (!sessionId || !source || !payload) {
      return res.status(400).json({
        error: "sessionId, source, and payload are required",
      });
    }

    //create transaction to get tx id
    const tx = contract.createTransaction("WriteSession");

    let txId: string;

    if (typeof tx.getTransactionId === "function") {
      const raw = tx.getTransactionId();
      txId =
        raw?.getTransactionID?.() || raw?.transactionId || raw || "UNKNOWN_TX";
    } else {
      txId = "UNKNOWN_TX";
    }

    console.log("Resolved TX ID:", txId);

    //submit chaincode call
    await tx.submit(sessionId, source, payload);

    //build record for SSE
    const record = {
      sessionId,
      source,
      payload,
      timestamp: new Date().toISOString(),
      txId,
    };

    //broadcast to SSE clients
    for (const client of sseClients) {
      client.write(
        `data: ${JSON.stringify({
          eventName: "WriteSession",
          txId,
          payload: record,
        })}\n\n`
      );
    }

    return res.json({ ok: true, txId });
  } catch (err: any) {
    console.error("Error in /api/log:", err);
    return res.status(500).json({ error: err.message });
  }
});

//sse endpoint to get events
app.get("/events", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  sseClients.add(res);
  console.log("SSE client connected:", sseClients.size);

  req.on("close", () => {
    sseClients.delete(res);
    console.log("SSE client disconnected:", sseClients.size);
  });
});

//start server after fabric init
initFabric()
  .then(() => {
    app.listen(4000, () => {
      console.log("Ledger server listening on http://localhost:4000");
    });
  })
  .catch((err) => {
    console.error("Failed to init Fabric:", err);
    process.exit(1);
  });
