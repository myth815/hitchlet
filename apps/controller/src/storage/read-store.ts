import type { Storage } from "./index.js";
export type ReadRow = Record<string, string | number | bigint | null>;

/** Cohesive parameterized read statements used by application projections. */
export class SQLiteReadStore {
  constructor(private readonly storage: Storage) {}
  ticketPage(
    consumerId: string,
    phase: string | null,
    created: number | null,
    id: string,
    limit: number,
  ) {
    return this.storage.all<ReadRow>(
      `SELECT id,consumer_id,phase,version,image_version_id,terminal_reason,cleanup_status,created_at_ms,updated_at_ms,ready_at_ms,released_at_ms
      FROM tickets WHERE consumer_id=? AND (? IS NULL OR phase=?) AND (? IS NULL OR created_at_ms<? OR (created_at_ms=? AND id>?))
      ORDER BY created_at_ms DESC,id ASC LIMIT ?`,
      [consumerId, phase, phase, created, created, created, id, limit],
    );
  }
  ticketDetail(ticketId: string, consumerId: string | null = null) {
    return this.storage.get<ReadRow>(
      `SELECT t.*, l.id AS lease_id,l.generation AS lease_generation,l.version AS lease_version,l.state AS lease_state,
      l.claim_by_ms,l.claimed_at_ms,l.expires_at_ms,l.renew_until_ms,l.revoked_at_ms,a.machine_id,a.node_id,a.image_artifact_id,n.backend_kind,ia.architecture,
      (SELECT id FROM lease_renewals r WHERE r.lease_id=l.id AND r.state='pending') AS renewal_id,
      (SELECT proposed_version FROM lease_renewals r WHERE r.lease_id=l.id AND r.state='pending') AS renewal_version,
      (SELECT proposed_expires_at_ms FROM lease_renewals r WHERE r.lease_id=l.id AND r.state='pending') AS renewal_expires,
      (SELECT decision_deadline_ms FROM lease_renewals r WHERE r.lease_id=l.id AND r.state='pending') AS renewal_deadline,n.observed_health,n.observed_at_ms,
      (SELECT json_extract(o.intent_json,'$.executionMode') FROM operations o WHERE o.allocation_id=a.id AND o.kind='allocation.provision' ORDER BY o.created_at_ms DESC LIMIT 1) AS execution_mode,
      EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AS network_revoked,
      EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id) AS storage_revoked,
      (SELECT json_group_array(json_object('managedResourceId',m.id,'kind',m.kind,'retainUntilMs',m.retention_until_ms,'state',m.observed_state)) FROM managed_resources m WHERE m.allocation_id=a.id AND a.cleanup_status='blocked' AND m.observed_state<>'absent' AND m.cleanup_policy<>'keep') AS cleanup_blockers
      FROM tickets t LEFT JOIN leases l ON l.ticket_id=t.id LEFT JOIN allocations a ON a.ticket_id=t.id LEFT JOIN nodes n ON n.id=a.node_id LEFT JOIN image_artifacts ia ON ia.id=a.image_artifact_id
      WHERE t.id=? AND (? IS NULL OR t.consumer_id=?)`,
      [ticketId, consumerId, consumerId],
    );
  }
  ticketGrants(ticketId: string) {
    return this.storage.all<ReadRow>(
      "SELECT storage_profile_revision_id FROM ticket_storage_grants WHERE ticket_id=? ORDER BY id",
      [ticketId],
    );
  }
  consumerImageScope(consumerId: string) {
    return this.storage.get<ReadRow>(
      "SELECT authorization_json FROM consumers WHERE id=? AND status='active'",
      [consumerId],
    );
  }
  images(
    consumerId: string,
    imageIds: "all" | readonly string[],
    afterId: string | null,
    limit: number,
  ) {
    if (imageIds !== "all" && imageIds.length === 0) return Promise.resolve([]);
    const scoped =
      imageIds === "all"
        ? "1=1"
        : `i.id IN (${imageIds.map(() => "?").join(",")})`;
    return this.storage.all<ReadRow>(
      `SELECT i.id,i.name,i.description FROM images i WHERE i.status='active' AND (${scoped}) AND (i.owner_consumer_id IS NULL OR i.owner_consumer_id=?)
      AND EXISTS(SELECT 1 FROM image_versions v WHERE v.image_id=i.id AND v.status='published') AND (? IS NULL OR i.id>?) ORDER BY i.id LIMIT ?`,
      [
        ...(imageIds === "all" ? [] : imageIds),
        consumerId,
        afterId,
        afterId,
        limit,
      ],
    );
  }
  imageVersion(
    versionId: string,
    consumerId: string,
    imageIds: "all" | readonly string[],
  ) {
    if (imageIds !== "all" && !imageIds.length)
      return Promise.resolve(undefined);
    const scoped =
      imageIds === "all"
        ? "1=1"
        : `i.id IN (${imageIds.map(() => "?").join(",")})`;
    return this.storage.get<ReadRow>(
      `SELECT v.id,v.image_id,v.version,v.status,min(a.minimum_cpu_millis) AS minimum_cpu_millis,min(a.minimum_memory_mib) AS minimum_memory_mib,min(a.minimum_scratch_mib) AS minimum_scratch_mib
      FROM image_versions v JOIN images i ON i.id=v.image_id JOIN image_artifacts a ON a.image_version_id=v.id WHERE v.id=? AND v.status='published' AND i.status='active'
      AND (${scoped}) AND (i.owner_consumer_id IS NULL OR i.owner_consumer_id=?) GROUP BY v.id`,
      [versionId, ...(imageIds === "all" ? [] : imageIds), consumerId],
    );
  }
  imageArtifacts(versionId: string) {
    return this.storage.all<ReadRow>(
      "SELECT id,backend_kind,environment_kind,architecture,guest_os,content_digest,access_recipe_json FROM image_artifacts WHERE image_version_id=? ORDER BY id",
      [versionId],
    );
  }
  events(
    consumerId: string,
    after: bigint,
    ticketId: string | null,
    limit: number,
  ) {
    return this.storage.all<ReadRow>(
      `SELECT e.* FROM events e WHERE
      (e.consumer_id=? OR (e.consumer_id IS NULL AND e.aggregate_type='ticket' AND EXISTS(SELECT 1 FROM tickets t WHERE t.id=e.aggregate_id AND t.consumer_id=?)))
      AND e.id>? AND (? IS NULL OR (e.aggregate_type='ticket' AND e.aggregate_id=?)) ORDER BY e.id LIMIT ?`,
      [consumerId, consumerId, after, ticketId, ticketId, limit],
    );
  }
  accessContext(ticketId: string, consumerId: string) {
    return this.storage.get<ReadRow>(
      `SELECT t.phase,t.request_json,l.id AS lease_id,l.generation,l.version AS lease_version,l.state AS lease_state,l.claimed_at_ms,l.expires_at_ms,
      a.desired_state,a.ownership_json,a.actual_resources_json,a.access_secret_ref,
      (SELECT json_extract(o.intent_json,'$.executionMode') FROM operations o WHERE o.allocation_id=a.id AND o.kind='allocation.provision' ORDER BY o.created_at_ms DESC LIMIT 1) AS execution_mode,
      EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AS network_revoked,
      EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id) AS storage_revoked
      FROM tickets t JOIN leases l ON l.ticket_id=t.id JOIN allocations a ON a.id=l.allocation_id
      WHERE t.id=? AND t.consumer_id=?`,
      [ticketId, consumerId],
    );
  }
}
