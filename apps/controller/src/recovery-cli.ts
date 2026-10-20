import { readFile } from "node:fs/promises";
import {
  restoreBackup,
  acceptRecoveryControls,
  RecoveryControlPlanSchema,
} from "./application/recovery.js";
import { LocalSecretStore } from "./storage/secret-store.js";
import { openStorage } from "./storage/index.js";
import { recoveryControlVerifier } from "./providers/recovery-control.js";

// Offline operational commands deliberately have no HTTP database-replacement equivalent.
const mode = process.argv[2];
if (mode === "restore") {
  const backupFile = process.env.BACKUP_FILE,
    destination = process.env.RESTORE_DATA_DIR;
  if (
    !backupFile ||
    !destination ||
    process.env.OLD_CONTROLLER_STOPPED !== "true"
  )
    throw new Error(
      "Set BACKUP_FILE, empty RESTORE_DATA_DIR and OLD_CONTROLLER_STOPPED=true after stopping the old controller",
    );
  const result = await restoreBackup({
    backupFile,
    destination,
    oldControllerStopped: true,
    ...(process.env.RESTORE_SECRETS_DIR
      ? { encryptedSecretsDir: process.env.RESTORE_SECRETS_DIR }
      : {}),
    ...(process.env.HITCHLET_SECRET_KEY_FILE
      ? { masterKeyFile: process.env.HITCHLET_SECRET_KEY_FILE }
      : {}),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} else if (mode === "takeover") {
  const dataDir = process.env.DATA_DIR,
    keyFile = process.env.HITCHLET_SECRET_KEY_FILE,
    planFile = process.env.CONTROL_TAKEOVER_FILE;
  if (!dataDir || !keyFile || !planFile)
    throw new Error(
      "Set DATA_DIR, separate HITCHLET_SECRET_KEY_FILE and CONTROL_TAKEOVER_FILE; stop the restored controller first",
    );
  const plan = RecoveryControlPlanSchema.parse(
      JSON.parse(await readFile(planFile, "utf8")),
    ),
    db = await openStorage(dataDir);
  try {
    const secrets = await LocalSecretStore.open(dataDir, keyFile);
    await acceptRecoveryControls(
      db,
      plan,
      recoveryControlVerifier(db, secrets),
    );
    process.stdout.write(
      "External control reacquired; restart in isolated reconciliation mode. Admission still closed.\n",
    );
  } finally {
    await db.close();
  }
} else throw new Error("Use recovery-cli.js restore|takeover");
