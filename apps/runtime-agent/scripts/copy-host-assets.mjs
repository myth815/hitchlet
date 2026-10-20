import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
await copyFile(
  resolve("src/host-windows.ps1"),
  resolve("dist/host-windows.ps1"),
);
