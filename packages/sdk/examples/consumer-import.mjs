import { HitchletClient } from "@hitchlet/sdk";

const origin = process.env.HITCHLET_ORIGIN;
if (!origin) throw new Error("Set HITCHLET_ORIGIN to the API origin");

const client = new HitchletClient(origin);
const health = await client.health();
console.log(`Hitchlet API is ${health.status}`);
