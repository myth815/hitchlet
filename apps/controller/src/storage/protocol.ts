export type SqlValue = string | number | bigint | Buffer | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export type Statement =
  | {
      kind: "run";
      sql: string;
      params?: readonly SqlValue[];
      expectChanges?: number;
    }
  | {
      kind: "get" | "all";
      sql: string;
      params?: readonly SqlValue[];
    };
export type RunResult = { changes: bigint; lastInsertRowid: bigint };
export type Command =
  | { kind: "run" | "get" | "all"; sql: string; params?: readonly SqlValue[] }
  | { kind: "batch"; statements: readonly Statement[] }
  | { kind: "close" };
export type Reply = {
  id: number;
  result?: unknown;
  error?: { code: string; message: string };
};
export type Request = { id: number; command: Command };
