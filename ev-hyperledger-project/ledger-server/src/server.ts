import "dotenv/config";
import path from "path";
import fs from "fs";
import express, { Request, Response } from "express";
import cors from "cors";
import { Gateway, Wallets } from "fabric-network";

import { healthRouter } from "./routes/health.routes";
import { createSessionsRouter } from "./routes/session.routes";

const app = express();
app.use(cors());
app.use(express.json());

let contract: any = null;

/** ---------------- SSE ---------------- */
const sseClients = new Set<Response>();

function broadcastSSE(data: any) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      // ignore; close handler will clean up
    }
  }
}

/** contract ref wrapper so routes can fetch latest contract after init */
const contractRef = {
  get: () => contract,
};

/** ---------------- Routes ---------------- */
app.use("/health", healthRouter);

// ✅ IMPORTANT: pass broadcaster so session routes push to UI live
app.use("/api/sessions", createSessionsRouter(contractRef, broadcastSSE));

/** ---------------- Fabric Identity ---------------- */
async function loadIdentity() {
  const walletPath = path.join(__dirname, "wallet");
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identityLabel = "appUser";

  const existing = await wallet.get(identityLabel);
  if (existing) {
    console.log(`Wallet already has identity "${identityLabel}".`);
    return { wallet, identityLabel };
  }

  console.log(`Identity "${identityLabel}" not found — importing Admin@org1...`);

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

  const identity: any = {
    credentials: { certificate, privateKey },
    mspId: "Org1MSP",
    type: "X.509",
  };

  await wallet.put(identityLabel, identity);
  console.log(`Imported Admin@org1 as "${identityLabel}".`);
  return { wallet, identityLabel };
}

/** ---------------- Fabric Init ---------------- */
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

  console.log("Fabric connection ready (discovery ON).");
}

/** ---------------- /api/log (kept) ---------------- */
app.post("/api/log", async (req: Request, res: Response) => {
  try {
    if (!contract) {
      return res
        .status(503)
        .json({ error: "Fabric not initialized (still ok for DB endpoints)" });
    }

    const { sessionId, source, payload } = req.body;

    if (!sessionId || !source || !payload) {
      return res
        .status(400)
        .json({ error: "sessionId, source, and payload are required" });
    }

    const tx = contract.createTransaction("WriteSession");

    let txId: string;
    if (typeof tx.getTransactionId === "function") {
      const raw = tx.getTransactionId();
      txId =
        raw?.getTransactionID?.() || raw?.transactionId || raw || "UNKNOWN_TX";
    } else {
      txId = "UNKNOWN_TX";
    }

    await tx.submit(sessionId, source, payload);

    const record = {
      sessionId,
      source,
      payload,
      timestamp: new Date().toISOString(),
      txId,
    };

    // ✅ broadcast so UI sees it
    broadcastSSE({ eventName: "WriteSession", txId, payload: record });

    return res.json({ ok: true, txId });
  } catch (err: any) {
    console.error("Error in /api/log:", err);
    return res.status(500).json({ error: err.message });
  }
});

/** ---------------- SSE endpoint (reliable: flush + heartbeat) ---------------- */
app.get("/events", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // @ts-ignore
  res.flushHeaders?.();

  // immediate hello event so UI can confirm connection
  res.write(
    `data: ${JSON.stringify({
      eventName: "SSE_CONNECTED",
      ts: new Date().toISOString(),
    })}\n\n`
  );

  sseClients.add(res);
  console.log("SSE client connected:", sseClients.size);

  const heartbeat = setInterval(() => {
    try {
      res.write(
        `data: ${JSON.stringify({
          eventName: "PING",
          ts: new Date().toISOString(),
        })}\n\n`
      );
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log("SSE client disconnected:", sseClients.size);
  });
});

/** ---------------- Start server, then init Fabric ---------------- */
app.listen(4000, () => {
  console.log("Ledger server listening on http://localhost:4000");
});

initFabric().catch((err) => {
  console.error(
    "Fabric init failed (DB routes still available):",
    err.message || err
  );
});
