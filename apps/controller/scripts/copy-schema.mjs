import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
const source = resolve("src/storage/migrations");
const target = resolve("dist/storage/migrations");
await mkdir(target, { recursive: true });
for (const name of (await readdir(source))
  .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
  .sort()) {
  await copyFile(resolve(source, name), resolve(target, name));
}
