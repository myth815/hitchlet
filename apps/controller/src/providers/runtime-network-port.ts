import type {
  RuntimeNetworkCommand,
  RuntimeNetworkResult,
} from "@hitchlet/contracts/internal";

type Command<K extends RuntimeNetworkCommand["kind"]> = Extract<
  RuntimeNetworkCommand,
  { kind: K }
>;

/** Narrow boundary used by the Docker Provider to delegate only host firewall work. */
export interface RuntimeNetworkPort {
  ensure(command: Command<"network.ensure">): Promise<RuntimeNetworkResult>;
  inspect(command: Command<"network.inspect">): Promise<RuntimeNetworkResult>;
  revoke(command: Command<"network.revoke">): Promise<RuntimeNetworkResult>;
  remove(command: Command<"network.remove">): Promise<RuntimeNetworkResult>;
}
