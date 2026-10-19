import { LocalSecretStore } from "./storage/secret-store.js";

const root = process.env.DATA_DIR;
const keyFile = process.env.HITCHLET_SECRET_KEY_FILE;
if (!root || !keyFile)
  throw new Error("Set DATA_DIR and HITCHLET_SECRET_KEY_FILE");
if (process.argv[2] !== "add")
  throw new Error("Usage: secret-cli add (secret is read from stdin)");
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
let value = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/u, "");
if (!value) throw new Error("No secret was provided on stdin");
const store = await LocalSecretStore.open(root, keyFile);
const ref = await store.put(value);
value = "";
process.stdout.write(`${ref}\n`);
