# EV Hyperledger Fabric – Full Setup Guide (Reproducible)

This guide explains how to install Fabric, bring up the test network (2 Orgs + CA), deploy the custom TypeScript chaincode, write from Org1 (SECC), and read from Org2 (CPO).

## Prerequisites
- macOS with Docker & Docker Compose installed
- Git, curl, Node.js (>=14), npm
- Sufficient permissions to run Docker commands

---

## 1. Install Fabric Samples + Binaries

```bash
git clone https://github.com/hyperledger/fabric-samples.git
cd fabric-samples

# Install Fabric binaries + docker images
curl -sSL https://bit.ly/2ysbOFE | bash -s

# Add Fabric binaries to PATH for the current shell
export PATH=${PWD}/bin:$PATH
```

---

## 2. Start the Test Network (2 Orgs + CA)

```bash
cd ~/fabric-samples/test-network

# Tear down any existing network, then bring it up with CAs and create channel
./network.sh down
./network.sh up createChannel -ca
```

Verify containers are running:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

---

## 3. Build Custom Chaincode (TypeScript)

From your project repo:

```bash
cd /Users/landonhadre/Documents/school/f2025/4990/final/ev-hyperledger-project/chaincode/ev-contract
npm install
npm run build
```

You should now have a `dist/` folder.

---

## 4. Deploy Chaincode

From the test-network folder:

```bash
cd ~/fabric-samples/test-network

./network.sh deployCC \
  -ccn ev-contract \
  -ccp /Users/landonhadre/Documents/school/f2025/4990/final/ev-hyperledger-project/chaincode/ev-contract \
  -ccl typescript
```

Verify chaincode container(s) exist:

```bash
docker ps | grep ev-contract
```

---

## 5. Load Fabric Environment Variables (Required Each Time)

From the test-network folder:

```bash
cd ~/fabric-samples/test-network

export PATH=${PWD}/../bin:$PATH
export FABRIC_CFG_PATH=${PWD}/../config/

# Load helper functions (setGlobals, etc.)
source ./scripts/envVar.sh
```

---

## 6. Write From Org1 (SECC)

Set Org1 globals and run the invoke. Example sets a PEER0_ORG2_CA path for cross-org TLS verification:

```bash
# Set environment for Org1
setGlobals 1

# Path to Org2 peer0 TLS cert (update if your path differs)
export PEER0_ORG2_CA=/Users/landonhadre/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/tlsca/tlsca.org2.example.com-cert.pem

peer chaincode invoke \
  -o localhost:7050 \
  --tls \
  --cafile "$ORDERER_CA" \
  -C mychannel \
  -n ev-contract \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles "$PEER0_ORG1_CA" \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles "$PEER0_ORG2_CA" \
  -c '{"Args":["WriteSession","session999","SECC","{\"msg\":\"hello from SECC\"}"]}'
```

Expected output:

```text
Chaincode invoke successful. result: status:200
```

---

## 7. Read From Org1

```bash
# Org1
setGlobals 1

peer chaincode query \
  -C mychannel \
  -n ev-contract \
  -c '{"Args":["ReadSession","session999"]}'
```

---

## 8. Read From Org2 (Cross-Org Read)

```bash
# Switch to Org2
setGlobals 2

peer chaincode query \
  -C mychannel \
  -n ev-contract \
  -c '{"Args":["ReadSession","session999"]}'
```

Expected JSON (timestamp will vary):

```json
{
  "sessionId": "session999",
  "source": "SECC",
  "payload": "{\"msg\":\"hello from SECC\"}",
  "timestamp": "..."
}
```

---

## 9. View Chaincode Container Logs

List containers:

```bash
docker ps --format 'table {{.ID}}\t{{.Names}}'
```

View logs (replace <container-id>):

```bash
docker logs <container-id> | tail -100
```

Example:

```bash
docker logs 32d6ff611b19 | tail -50
```

---

## 10. Shut Down Network

```bash
cd ~/fabric-samples/test-network
./network.sh down
```

---

Notes
- Paths in this guide are based on the local project layout used here — update paths if your workspace differs.
- Always run `source ./scripts/envVar.sh` (or re-open your shell) in `fabric-samples/test-network` before using `peer` helper functions.
- If you change chaincode, re-run the build in `ev-contract` and redeploy via `./network.sh deployCC`.