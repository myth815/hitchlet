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

await copyFile(
  resolve(source, "003-validation-evidence.sql"),
  resolve(target, "003-validation-evidence.sql"),
);

await copyFile(
  resolve(source, "004-managed-resource-identities.sql"),
  resolve(target, "004-managed-resource-identities.sql"),
);
await copyFile(
  resolve(source, "005-host-observations.sql"),
  resolve(target, "005-host-observations.sql"),
);

await copyFile(
  resolve(source, "006-power-dry-run.sql"),
  resolve(target, "006-power-dry-run.sql"),
);
