import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RuntimeNetworkCommand,
  RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";

type Entry = { hash: string; result?: RuntimeNetworkResult };
type Allocation = {
  generation: number;
  controlVersion: number;
  state: "active" | "revoked" | "removed";
  rulesetHash: string | null;
};
type JournalData = {
  controllerEpoch: number;
  commands: Record<string, Entry>;
  allocations: Record<string, Allocation>;
};

const empty = (): JournalData => ({
  controllerEpoch: 0,
  commands: {},
  allocations: {},
});

/** A small fsync + rename journal, protected by the process-wide serial queue. */
export class FileJournal {
  private data: JournalData = empty();
  private ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    this.ready = this.load();
  }

  async initialize(): Promise<void> {
    await this.ready;
  }

  async serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      await this.ready;
      return work();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  get commandMap(): Record<string, Entry> {
    return this.data.commands;
  }
  get allocationMap(): Record<string, Allocation> {
    return this.data.allocations;
  }
  get epoch(): number {
    return this.data.controllerEpoch;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    const file = await open(temp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(this.data));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, this.path);
    const directory = await open(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  setEpoch(epoch: number): void {
    this.data.controllerEpoch = epoch;
  }
  removeCommand(id: string): void {
    delete this.data.commands[id];
  }
  setCommand(id: string, entry: Entry): void {
    this.data.commands[id] = entry;
  }
  setAllocation(id: string, value: Allocation): void {
    this.data.allocations[id] = value;
  }

  private async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("invalid journal");
      const value = raw as Partial<JournalData>;
      if (
        !Number.isSafeInteger(value.controllerEpoch) ||
        !value.commands ||
        !value.allocations ||
        typeof value.commands !== "object" ||
        typeof value.allocations !== "object"
      )
        throw new Error("invalid journal");
      this.data = value as JournalData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Runtime Agent journal is invalid; refusing to start");
    }
  }
}

export type { Allocation as JournalAllocation, Entry as JournalEntry };
