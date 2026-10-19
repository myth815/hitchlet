import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const source = resolve("../../docs/design/schema.sql");
const target = resolve("dist/storage/migrations/001-initial.sql");
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
