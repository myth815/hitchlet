import type { HyperVGuestInteractiveRequest } from "@hitchlet/contracts/internal";
export type HyperVGuestInteractivePort = {
  inspect(
    request: HyperVGuestInteractiveRequest,
    deadlineMs: number,
  ): Promise<unknown>;
  apply(
    request: HyperVGuestInteractiveRequest,
    password: string,
    deadlineMs: number,
  ): Promise<unknown>;
};
