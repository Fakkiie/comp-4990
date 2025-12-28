"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contracts = exports.EvContract = void 0;
const fabric_contract_api_1 = require("fabric-contract-api");
class EvContract extends fabric_contract_api_1.Contract {
    constructor() {
        super("ev-contract");
    }
    async WriteSession(ctx, sessionId, source, payload) {
        console.log("==== WriteSession CALLED ====");
        console.log("sessionId:", sessionId);
        console.log("source:", source);
        console.log("payload:", payload);
        const existing = await ctx.stub.getState(sessionId);
        if (existing && existing.length > 0) {
            throw new Error(`Session ${sessionId} already exists`);
        }
        const txTime = ctx.stub.getTxTimestamp();
        const millis = txTime.seconds.low * 1000 + Math.floor(txTime.nanos / 1000000);
        const timestamp = new Date(millis).toISOString();
        const record = {
            sessionId,
            source,
            payload,
            timestamp,
        };
        await ctx.stub.putState(sessionId, Buffer.from(JSON.stringify(record), "utf8"));
        console.log("==== WriteSession DONE ====");
    }
    async ReadSession(ctx, sessionId) {
        const data = await ctx.stub.getState(sessionId);
        if (!data || data.length === 0) {
            throw new Error(`Session ${sessionId} does not exist`);
        }
        return data.toString();
    }
}
exports.EvContract = EvContract;
exports.contracts = [EvContract];
