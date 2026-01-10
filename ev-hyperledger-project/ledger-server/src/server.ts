import "dotenv/config";
import path from "path";
import fs from "fs";
import express, { Request, Response } from "express";
import cors from "cors";
import { Gateway, Wallets } from "fabric-network";

import { healthRouter } from "./routes/health.routes";
import { createSessionsRouter } from "./routes/session.routes";
import { initLedgerQueue, getQueueStatus, retryDeadEvents, queueStats } from "./lib/ledgerQueue";

const app = express();
app.use(cors());
app.use(express.json());

let contract: any = null;

//sse clients
const sseClients = new Set<Response>();

function broadcastSSE(data: any) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      //handler will clean up
    }
  }
}

//red wrapper
const contractRef = {
  get: () => contract,
};

//routes 
app.use("/health", healthRouter);
app.use("/api/sessions", createSessionsRouter(contractRef, broadcastSSE));

//queue status endpoint
app.get("/api/queue/status", async (req: Request, res: Response) => {
  try {
    const dbStatus = await getQueueStatus();
    res.json({
      ok: true,
      queue: dbStatus,
      stats: queueStats,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

//retry dead events endpoint
app.post("/api/queue/retry", async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    const count = await retryDeadEvents(sessionId);
    res.json({ ok: true, retriedCount: count });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

//fabric identity setup
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

//init fabric
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

  //init ledger queue
  initLedgerQueue(contractRef, broadcastSSE);
  console.log("Ledger queue initialized - background processor running.");
}

//sse endpoint
app.get("/events", (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // @ts-ignore
  res.flushHeaders?.();

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

//start server
app.listen(4000, () => {
  console.log("Ledger server listening on http://localhost:4000");
});

initFabric().catch((err) => {
  console.error(
    "Fabric init failed (DB routes still available, queue will retry when Fabric is up):",
    err.message || err
  );
  
  //still start ledger queue without Fabric
  initLedgerQueue(contractRef, broadcastSSE);
});