import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const source = resolve("src/storage/migrations");
const target = resolve("dist/storage/migrations");
await mkdir(target, { recursive: true });
await copyFile(
  resolve(source, "001-initial.sql"),
  resolve(target, "001-initial.sql"),
);
await copyFile(
  resolve(source, "002-session-credential-lineage.sql"),
  resolve(target, "002-session-credential-lineage.sql"),
);
