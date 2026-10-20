import {
  AuthorizedCatalogSchema,
  ManagementOperationSchema,
  ManagementOverviewSchema,
  ManagementTicketPageSchema,
  type ManagementTicketQuery,
} from "@hitchlet/contracts/admin";
import { AcquireRequestSchema, type AcquireRequest } from "@hitchlet/contracts";
import { SQLiteManagementStore } from "../storage/management-store.js";
import { SQLiteMachineNodeStore } from "../storage/machine-node-store.js";
import { SQLiteOperationStore } from "../storage/operation-store.js";
import type { Storage } from "../storage/index.js";
import { integer, type Row } from "../storage/admin-store-utils.js";
import { TicketQueries } from "./queries.js";
import { TicketService } from "./tickets.js";
import { ApplicationError } from "./errors.js";
import { roleScopes } from "../domain/role-scopes.js";
import { isNodeObservationFresh } from "../domain/human-use.js";

export type ManagementActor = {
  consumerId: string;
  role: "viewer" | "consumer" | "operator" | "admin";
  scopes: readonly string[];
};
const permits = (scope: "all" | readonly string[], id: unknown) =>
  scope === "all" || (typeof id === "string" && scope.includes(id));
/** Management reads reuse the same scope rule as revocation; internal allocation/secret documents never escape. */
export class ManagementService {
  private readonly configuration: SQLiteManagementStore;
  private readonly tickets: TicketQueries;
  private readonly commands: TicketService;
  private readonly operationStore: SQLiteOperationStore;
  private readonly inventory: SQLiteMachineNodeStore;
  constructor(
    db: Storage,
    private readonly now = Date.now,
  ) {
    this.inventory = new SQLiteMachineNodeStore(db, now);
    this.operationStore = new SQLiteOperationStore(db);
    this.configuration = new SQLiteManagementStore(db, now);
    this.tickets = new TicketQueries(db, now);
    this.commands = new TicketService({ storage: db, now });
  }
  async catalog(consumerId: string) {
    const { authorization: a, quota } =
      await this.configuration.scope(consumerId);
    const [versions, networks, storage, nodes] = await Promise.all([
      this.configuration.versions(),
      this.configuration.profiles("network"),
      this.configuration.profiles("storage"),
      this.configuration.nodes(),
    ]);
    const grouped = new Map<
      string,
      {
        id: string;
        imageId: string;
        imageName: string;
        version: string;
        kind: "container";
        architectures: string[];
        platforms: {
          architecture: string;
          artifactId: string;
          digest: string;
          minimumResources: {
            cpuMillis: number;
            memoryMiB: number;
            scratchMiB: number;
          };
        }[];
      }
    >();
    for (const r of versions) {
      if (
        !permits(a.imageIds, r.image_id) ||
        (r.owner_consumer_id !== null && r.owner_consumer_id !== consumerId)
      )
        continue;
      const amounts = {
        cpuMillis: integer(r.minimum_cpu_millis),
        memoryMiB: integer(r.minimum_memory_mib),
        scratchMiB: integer(r.minimum_scratch_mib),
      };
      const existing = grouped.get(String(r.id));
      if (existing) {
        existing.architectures.push(String(r.architecture));
        existing.platforms.push({
          architecture: String(r.architecture),
          artifactId: String(r.artifact_id),
          digest: String(r.content_digest),
          minimumResources: amounts,
        });
      } else
        grouped.set(String(r.id), {
          id: String(r.id),
          imageId: String(r.image_id),
          imageName: String(r.image_name),
          version: String(r.version),
          kind: "container",
          architectures: [String(r.architecture)],
          platforms: [
            {
              architecture: String(r.architecture),
              artifactId: String(r.artifact_id),
              digest: String(r.content_digest),
              minimumResources: amounts,
            },
          ],
        });
    }
    const observedAtMs = this.now();
    return AuthorizedCatalogSchema.parse({
      observedAtMs,
      quota,
      versions: [...grouped.values()],
      networks: networks
        .filter((r) => permits(a.networkProfileIds, r.id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          revisionId: r.revision_id,
          revision: integer(r.revision),
        })),
      storage: storage
        .filter((r) => permits(a.storageProfileIds, r.id))
        .map((r) => {
          const config = JSON.parse(String(r.config_json)) as Record<
            string,
            unknown
          >;
          return {
            id: r.id,
            name: r.name,
            revisionId: r.revision_id,
            revision: integer(r.revision),
            allowedSubpaths: config.allowedSubpaths,
            allowedModes: config.allowedModes,
          };
        }),
      nodes: nodes
        .filter((r) => permits(a.nodeIds, r.id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          machineId: r.machine_id,
          machineName: r.machine_name,
          architecture: r.architecture,
          admission: r.admission,
          version: integer(r.version),
          health: isNodeObservationFresh(
            r.observed_at_ms === null ? null : integer(r.observed_at_ms),
            observedAtMs,
          )
            ? r.observed_health
            : "unknown",
        })),
    });
  }
  async feasibility(consumerId: string, body: unknown) {
    return this.commands.preview(consumerId, body);
  }
  private fullAdmin(actor: ManagementActor) {
    const expected = roleScopes("admin");
    return (
      actor.role === "admin" &&
      actor.scopes.length === expected.length &&
      expected.every((s) => actor.scopes.includes(s))
    );
  }
  private async readScope(actor: ManagementActor) {
    return this.fullAdmin(actor)
      ? null
      : (await this.configuration.scope(actor.consumerId)).authorization;
  }
  async authorize(actor: ManagementActor, ticketId: string) {
    if (
      !(await this.configuration.visibleTicket(
        ticketId,
        await this.readScope(actor),
      ))
    )
      throw new ApplicationError("not_found");
  }
  async ticketsPage(
    actor: ManagementActor,
    query: ManagementTicketQuery & { limit: number },
  ) {
    const items: NonNullable<Awaited<ReturnType<TicketQueries["getAny"]>>>[] =
      [];
    let cursor = query.cursor;
    let exhausted = false;
    // Scope filtering happens before page membership; scan is bounded to avoid unbounded work for narrow operators.
    for (let page = 0; page < 10 && items.length < query.limit; page++) {
      const rows = await this.configuration.ticketIds({
        ...query,
        ...(cursor ? { cursor } : {}),
        limit: query.limit,
      });
      for (const row of rows) {
        cursor = String(row.id);
        try {
          await this.authorize(actor, cursor);
        } catch (error) {
          if (error instanceof ApplicationError && error.code === "not_found")
            continue;
          throw error;
        }
        const ticket = await this.tickets.getAny(cursor);
        if (ticket) items.push(ticket);
        if (items.length === query.limit) break;
      }
      if (rows.length < query.limit) {
        exhausted = true;
        break;
      }
    }
    return ManagementTicketPageSchema.parse({
      observedAtMs: this.now(),
      items,
      nextCursor: exhausted ? null : (cursor ?? null),
    });
  }
  async ticket(actor: ManagementActor, id: string) {
    await this.authorize(actor, id);
    const ticket = await this.tickets.getAny(id);
    if (!ticket) throw new ApplicationError("not_found");
    return ticket;
  }
  private operation(row: Row) {
    return ManagementOperationSchema.parse({
      id: row.id,
      ticketId: row.ticket_id,
      nodeId: row.node_id,
      runtimeIdentityId: row.runtime_identity_id,
      connectionRevisionId: row.connection_revision_id,
      kind: row.kind,
      state: row.state,
      attemptCount: integer(row.attempt_count),
      version: integer(row.version),
      nextCheckAtMs: integer(row.next_check_at_ms),
      updatedAtMs: integer(row.updated_at_ms),
      errorCode: typeof row.error_code === "string" ? row.error_code : null,
      retryable:
        row.state === "failed" &&
        ["allocation.cleanup", "allocation.provision"].includes(
          String(row.kind),
        ),
    });
  }
  async operations(actor: ManagementActor, ticketId?: string, limit = 200) {
    if (ticketId) await this.authorize(actor, ticketId);
    const rows = await this.configuration.operations(ticketId, limit),
      allowed = [];
    for (const row of rows) {
      try {
        await this.authorizeOperation(actor, row);
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "not_found")
          continue;
        throw error;
      }
      allowed.push(this.operation(row));
    }
    return allowed;
  }
  private async authorizeOperation(actor: ManagementActor, row: Row) {
    if (this.fullAdmin(actor)) return;
    if (typeof row.ticket_id === "string")
      await this.authorize(actor, row.ticket_id);
    else if (
      String(row.kind).startsWith("image-cache.") &&
      typeof row.node_id === "string" &&
      typeof row.image_artifact_id === "string"
    )
      await this.authorizeCache(actor, row.node_id, row.image_artifact_id);
    else throw new ApplicationError("not_found");
  }
  async operationById(actor: ManagementActor, id: string) {
    const row = await this.configuration.operation(id);
    if (!row) throw new ApplicationError("not_found");
    await this.authorizeOperation(actor, row);
    return this.operation(row);
  }
  async timeline(actor: ManagementActor, id: string) {
    await this.authorize(actor, id);
    return {
      operations: await this.operations(actor, id),
      events: (await this.configuration.events(id)).map((r) => ({
        id: String(r.id),
        type: String(r.type),
        occurredAtMs: integer(r.occurredAtMs),
        version: r.version === null ? null : integer(r.version),
        actorId: typeof r.actorId === "string" ? r.actorId : null,
        reason: typeof r.reason === "string" ? r.reason : null,
      })),
    };
  }
  async retry(
    actor: ManagementActor,
    id: string,
    input: { expectedVersion: number; reason: string },
    requestId: string,
  ) {
    const operation = await this.operationById(actor, id);
    if (!operation.retryable || operation.version !== input.expectedVersion)
      throw new ApplicationError("conflict");
    await this.operationStore.retryFailedOperation(
      id,
      input.reason,
      this.now(),
      input.expectedVersion,
      { actorId: actor.consumerId, requestId },
    );
    return this.operationById(actor, id);
  }
  async authorizeAdmission(
    actor: ManagementActor,
    kind: "nodes" | "machines",
    id: string,
  ) {
    if (!this.fullAdmin(actor)) {
      const { authorization } = await this.configuration.scope(
        actor.consumerId,
      );
      const ids =
        kind === "nodes"
          ? [id]
          : (await this.configuration.nodes())
              .filter((n) => n.machine_id === id)
              .map((n) => String(n.id));
      if (!ids.length || ids.some((id) => !permits(authorization.nodeIds, id)))
        throw new ApplicationError("not_found");
    }
  }
  async authorizeCache(
    actor: ManagementActor,
    nodeId: string,
    artifactId: string,
  ) {
    await this.authorizeAdmission(actor, "nodes", nodeId);
    if (this.fullAdmin(actor)) return;
    const artifact = await this.configuration.artifactScope(artifactId),
      { authorization } = await this.configuration.scope(actor.consumerId);
    if (!artifact || !permits(authorization.imageIds, artifact.image_id))
      throw new ApplicationError("not_found");
  }
  async admission(
    actor: ManagementActor,
    kind: "nodes" | "machines",
    id: string,
    input: { expectedVersion: number; admission: string; reason: string },
    requestId: string,
  ) {
    await this.authorizeAdmission(actor, kind, id);
    return this.configuration.admission(
      kind,
      id,
      input,
      actor.consumerId,
      requestId,
    );
  }
  consumers() {
    return this.configuration.consumers();
  }
  saveConsumer(...args: Parameters<SQLiteManagementStore["saveConsumer"]>) {
    return this.configuration.saveConsumer(...args);
  }
  policies() {
    return this.configuration.policies();
  }
  savePolicy(...args: Parameters<SQLiteManagementStore["savePolicy"]>) {
    return this.configuration.savePolicy(...args);
  }
  issueCredential(
    ...args: Parameters<SQLiteManagementStore["issueCredential"]>
  ) {
    return this.configuration.issueCredential(...args);
  }
  retire(...args: Parameters<SQLiteManagementStore["retire"]>) {
    return this.configuration.retire(...args);
  }
  async updateNetworkDeny(
    ...args: Parameters<SQLiteManagementStore["updateNetworkDeny"]>
  ) {
    await this.configuration.updateNetworkDeny(...args);
    return this.inventory.getInstallation();
  }
  async overview(actor: ManagementActor) {
    const scope = await this.readScope(actor),
      counts = await this.configuration.overviewCounts(scope, actor.consumerId),
      phases: Record<string, number> = {};
    let cleanupBlocked = 0;
    for (const row of counts.phases) {
      phases[String(row.phase)] = integer(row.count);
      cleanupBlocked += integer(row.cleanup_blocked);
    }
    const facts = counts.initialization,
      initialization = {
        connections: integer(facts.connections),
        machines: integer(facts.machines),
        nodes: integer(facts.nodes),
        publishedVersions: integer(facts.publishedVersions),
      },
      nodeScope = scope?.nodeIds ?? "all";
    const observedAtMs = this.now();
    const observations = new Map(
      (await this.configuration.nodes()).map((n) => [
        String(n.id),
        isNodeObservationFresh(
          n.observed_at_ms === null ? null : integer(n.observed_at_ms),
          observedAtMs,
        )
          ? String(n.observed_health)
          : "unknown",
      ]),
    );
    const power = new Map(
      (await this.configuration.machinePower()).map((m) => [
        String(m.id),
        String(m.observed_power),
      ]),
    );
    const machines = (await this.inventory.listMachineDependencies())
      .filter(
        (m) =>
          this.fullAdmin(actor) ||
          (m.nodes.length > 0 &&
            m.nodes.every((n) => permits(nodeScope, n.id))),
      )
      .map((m) => ({
        id: m.machineId,
        name: m.name,
        admission: m.admission,
        observedPower: power.get(m.machineId) ?? "unknown",
        hostObservation: m.hostObservation.state,
        humanPresence: m.hostObservation.humanPresence,
        capacity: m.capacity,
        claimed: m.physicalUsage,
        systemReserve: m.systemReserve,
        nodes: m.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          admission: n.admission,
          health: observations.get(n.id) ?? "unknown",
          available: n.available,
          canAdmit: n.canAdmit,
          reasons: n.disabledReasons,
        })),
      }));
    return ManagementOverviewSchema.parse({
      observedAtMs: this.now(),
      phases,
      cleanupBlocked,
      unknownOperations: counts.unknownOperations,
      machines,
      initialization,
    });
  }
}
