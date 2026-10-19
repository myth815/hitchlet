import type { Storage } from "./index.js";
import { createHash } from "node:crypto";
type Row = Record<string, string | number | bigint | null>;
export class SQLiteRenewalStore {
  constructor(private readonly db: Storage) {}
  context(ticketId: string, consumerId: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      `SELECT t.id,t.consumer_id,t.phase,t.request_json,l.id AS lease_id,l.generation,l.version AS lease_version,l.state AS lease_state,
      l.claim_by_ms,l.claimed_at_ms,l.expires_at_ms,l.renew_until_ms,l.allocation_id,a.control_version,a.runtime_identity_id,a.image_artifact_id,
      (SELECT json_extract(o.intent_json,'$.executionMode') FROM operations o WHERE o.allocation_id=a.id AND o.kind='allocation.provision' ORDER BY o.created_at_ms DESC LIMIT 1) AS execution_mode,
      EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id) AS network_revoked,
      EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id) AS storage_revoked
      FROM tickets t JOIN leases l ON l.ticket_id=t.id JOIN allocations a ON a.id=l.allocation_id WHERE t.id=? AND t.consumer_id=?`,
      [ticketId, consumerId],
    );
  }
  idempotency(consumerId: string, key: string): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT request_hash,renewal_id FROM idempotency_keys WHERE consumer_id=? AND route_scope='tickets.renew' AND idempotency_key=?",
      [consumerId, key],
    );
  }
  pendingForTicket(
    ticketId: string,
    consumerId: string,
  ): Promise<Row | undefined> {
    return this.db.get<Row>(
      "SELECT r.id FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id WHERE t.id=? AND t.consumer_id=? AND r.state='pending' LIMIT 1",
      [ticketId, consumerId],
    );
  }
  pendingRows(now: number): Promise<Row[]> {
    return this.db.all<Row>(
      `SELECT r.*,l.id AS lease_id,l.generation,l.version AS lease_version,l.state AS lease_state,l.claimed_at_ms,l.claim_by_ms,l.expires_at_ms,l.renew_until_ms,
      t.id AS ticket_id,t.consumer_id,t.phase,t.request_json,a.control_version,a.id AS allocation_id,o.intent_json,json_extract(o.intent_json,'$.executionMode') AS execution_mode,
      EXISTS(SELECT 1 FROM profile_grant_revocations p WHERE p.network_profile_revision_id=t.network_profile_revision_id) AS network_revoked,
      EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations p ON p.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id) AS storage_revoked
      FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id JOIN allocations a ON a.id=l.allocation_id JOIN operations o ON o.id=r.operation_id WHERE r.state='pending' ORDER BY r.created_at_ms LIMIT 100`,
      [],
    );
  }
  async createPending(input: {
    ticketId: string;
    consumerId: string;
    key: string;
    requestHash: string;
    renewalId: string;
    operationId: string;
    generation: number;
    expectedVersion: number;
    proposedExpiresAt: number;
    decisionDeadline: number;
    initial: boolean;
    now: number;
  }): Promise<void> {
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `INSERT INTO operations(id,allocation_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms)
        SELECT ?,a.id,a.generation,a.control_version,i.controller_epoch,'lease.renew',?,?,'planned',?,json_object('executionMode','simulator','renewalId',?,'ticketId',?),?,?,?,? FROM allocations a JOIN installations i ON i.singleton=1 WHERE a.ticket_id=?`,
        params: [
          input.operationId,
          input.renewalId,
          `lease:${input.renewalId}`,
          input.requestHash,
          input.renewalId,
          input.ticketId,
          input.now,
          input.decisionDeadline,
          input.now,
          input.now,
          input.ticketId,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: `INSERT INTO lease_renewals(id,lease_id,operation_id,expected_version,proposed_version,proposed_expires_at_ms,is_initial_claim,decision_deadline_ms,state,version,created_at_ms,updated_at_ms)
        SELECT ?,l.id,?,?,?, ?,? ,?,'pending',1,?,? FROM leases l JOIN tickets t ON t.id=l.ticket_id WHERE t.id=? AND t.consumer_id=? AND t.phase='ready' AND l.generation=? AND l.version=? AND l.state='active' AND l.expires_at_ms>? AND ?>? AND NOT EXISTS(SELECT 1 FROM lease_renewals r WHERE r.lease_id=l.id AND r.state='pending')
        AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.network_profile_revision_id=t.network_profile_revision_id)
        AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations r ON r.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id)`,
        params: [
          input.renewalId,
          input.operationId,
          input.expectedVersion,
          input.expectedVersion + 1,
          input.proposedExpiresAt,
          input.initial ? 1 : 0,
          input.decisionDeadline,
          input.now,
          input.now,
          input.ticketId,
          input.consumerId,
          input.generation,
          input.expectedVersion,
          input.now,
          input.decisionDeadline,
          input.now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,renewal_id,response_status,safe_response_json,created_at_ms,retain_until_ms) VALUES(?,'tickets.renew',?,?,?,?,202,?,?,?)",
        params: [
          input.consumerId,
          input.key,
          input.requestHash,
          input.ticketId,
          input.renewalId,
          JSON.stringify({ renewalId: input.renewalId }),
          input.now,
          input.now + 180 * 86400000,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) SELECT 'ticket',t.id,t.version,'lease.renewal_pending',t.consumer_id,?,? FROM tickets t WHERE t.id=?",
        params: [
          input.now,
          JSON.stringify({
            renewalId: input.renewalId,
            proposedVersion: input.expectedVersion + 1,
          }),
          input.ticketId,
        ],
      },
    ]);
  }
  async decidePending(input: {
    renewalId: string;
    now: number;
    claimedAt: number;
    receiptJson: string;
    rejectCode?: string;
  }): Promise<void> {
    if (input.rejectCode) {
      await this.db.batchTransaction([
        {
          kind: "run",
          sql: "UPDATE lease_renewals SET state='rejected',rejection_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='pending'",
          params: [
            JSON.stringify({ code: input.rejectCode }),
            input.now,
            input.renewalId,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE operations SET state='failed',result_json=?,version=version+1,updated_at_ms=? WHERE id=(SELECT operation_id FROM lease_renewals WHERE id=?) AND state='planned'",
          params: [
            JSON.stringify({ code: input.rejectCode }),
            input.now,
            input.renewalId,
          ],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: "UPDATE idempotency_keys SET response_status=409 WHERE renewal_id=?",
          params: [input.renewalId],
        },
      ]);
      return;
    }
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: `UPDATE leases SET claimed_at_ms=coalesce(claimed_at_ms,?),last_renewed_at_ms=?,expires_at_ms=(SELECT proposed_expires_at_ms FROM lease_renewals WHERE id=?),version=version+1,updated_at_ms=? WHERE id=(SELECT lease_id FROM lease_renewals WHERE id=?) AND state='active' AND version=(SELECT expected_version FROM lease_renewals WHERE id=?) AND expires_at_ms>? AND EXISTS(
        SELECT 1 FROM lease_renewals r JOIN tickets t ON t.id=(SELECT ticket_id FROM leases WHERE id=r.lease_id) JOIN allocations a ON a.id=(SELECT allocation_id FROM leases WHERE id=r.lease_id) JOIN operations o ON o.id=r.operation_id
        WHERE r.id=? AND r.state='pending' AND r.decision_deadline_ms>? AND t.phase='ready' AND a.desired_state='present' AND a.generation=(SELECT generation FROM leases WHERE id=r.lease_id)
        AND a.control_version=o.control_version AND o.generation=a.generation AND o.kind='lease.renew' AND json_extract(o.intent_json,'$.executionMode')='simulator'
        AND (r.is_initial_claim=0 OR (SELECT claim_by_ms FROM leases WHERE id=r.lease_id)>?) AND (SELECT renew_until_ms FROM leases WHERE id=r.lease_id)>?
        AND r.proposed_expires_at_ms<=(SELECT renew_until_ms FROM leases WHERE id=r.lease_id)
        AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations p WHERE p.network_profile_revision_id=t.network_profile_revision_id)
        AND NOT EXISTS(SELECT 1 FROM ticket_storage_grants g JOIN profile_grant_revocations p ON p.storage_profile_revision_id=g.storage_profile_revision_id WHERE g.ticket_id=t.id))`,
        params: [
          input.claimedAt,
          input.now,
          input.renewalId,
          input.now,
          input.renewalId,
          input.renewalId,
          input.now,
          input.renewalId,
          input.now,
          input.now,
          input.now,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='confirmed',confirmed_receipt_json=?,version=version+1,updated_at_ms=? WHERE id=? AND state='pending'",
        params: [input.receiptJson, input.now, input.renewalId],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='succeeded',result_json=?,version=version+1,updated_at_ms=? WHERE id=(SELECT operation_id FROM lease_renewals WHERE id=?) AND state='planned'",
        params: [input.receiptJson, input.now, input.renewalId],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE idempotency_keys SET response_status=200,safe_response_json=? WHERE renewal_id=?",
        params: [
          JSON.stringify({ renewalId: input.renewalId }),
          input.renewalId,
        ],
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) SELECT 'ticket',t.id,t.version,'lease.renewed',t.consumer_id,?,? FROM tickets t JOIN leases l ON l.ticket_id=t.id JOIN lease_renewals r ON r.lease_id=l.id WHERE r.id=?",
        params: [
          input.now,
          JSON.stringify({ renewalId: input.renewalId }),
          input.renewalId,
        ],
      },
    ]);
  }
  /** Reject an expired proposal and publish its lease termination/cleanup intent atomically. */
  async rejectExpiredAndTerminate(input: {
    renewalId: string;
    cleanupId: string;
    now: number;
  }): Promise<void> {
    const target = await this.db.get<{ ticket_id: string }>(
      "SELECT t.id AS ticket_id FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id WHERE r.id=? AND r.state='pending' AND r.decision_deadline_ms<=?",
      [input.renewalId, input.now],
    );
    if (!target) return;
    const cleanupHash = createHash("sha256")
      .update(`${target.ticket_id}:cleanup`)
      .digest("hex");
    await this.db.batchTransaction([
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='rejected',rejection_json=json_object('code','decision_deadline_expired'),version=version+1,updated_at_ms=? WHERE id=? AND state='pending' AND decision_deadline_ms<=?",
        params: [input.now, input.renewalId, input.now],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='failed',result_json=json_object('code','decision_deadline_expired'),version=version+1,updated_at_ms=? WHERE id=(SELECT operation_id FROM lease_renewals WHERE id=?) AND state='planned'",
        params: [input.now, input.renewalId],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE idempotency_keys SET response_status=409 WHERE renewal_id=?",
        params: [input.renewalId],
      },
      {
        kind: "run",
        sql: "UPDATE tickets SET phase='releasing',terminal_reason='lease_expired',cleanup_status='pending',termination_requested_at_ms=?,version=version+1,updated_at_ms=? WHERE id=? AND phase='ready'",
        params: [input.now, input.now, target.ticket_id],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE allocations SET desired_state='absent',control_version=control_version+1,version=version+1,updated_at_ms=? WHERE ticket_id=? AND desired_state='present'",
        params: [input.now, target.ticket_id],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE leases SET state='revoking',version=version+1,updated_at_ms=? WHERE ticket_id=? AND state='active'",
        params: [input.now, target.ticket_id],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "UPDATE lease_renewals SET state='cancelled',rejection_json=json_object('code','termination_requested'),version=version+1,updated_at_ms=? WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='pending'",
        params: [input.now, target.ticket_id],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',version=version+1,updated_at_ms=? WHERE id IN (SELECT operation_id FROM lease_renewals WHERE lease_id IN (SELECT id FROM leases WHERE ticket_id=?) AND state='cancelled') AND kind='lease.renew' AND state='planned'",
        params: [input.now, target.ticket_id],
      },
      {
        kind: "run",
        sql: "UPDATE operations SET state='cancelled',version=version+1,owner_token=NULL,locked_until_ms=NULL,updated_at_ms=? WHERE allocation_id=(SELECT id FROM allocations WHERE ticket_id=?) AND kind='allocation.provision' AND state='planned'",
        params: [input.now, target.ticket_id],
      },
      {
        kind: "run",
        sql: "INSERT INTO operations(id,allocation_id,runtime_identity_id,connection_revision_id,image_artifact_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms) SELECT ?,a.id,a.runtime_identity_id,o.connection_revision_id,a.image_artifact_id,a.generation,a.control_version,o.controller_epoch,'allocation.cleanup','cleanup',a.id||':cleanup:'||a.generation||':'||a.control_version,'planned',?,json_object('reason','lease_expired','purpose','tenant','executionMode',json_extract(o.intent_json,'$.executionMode')),?,?,?,? FROM allocations a JOIN operations o ON o.allocation_id=a.id AND o.kind='allocation.provision' WHERE a.ticket_id=?",
        params: [
          input.cleanupId,
          cleanupHash,
          input.now,
          input.now + 30000,
          input.now,
          input.now,
          target.ticket_id,
        ],
        expectChanges: 1,
      },
      {
        kind: "run",
        sql: "INSERT INTO events(aggregate_type,aggregate_id,aggregate_version,event_type,consumer_id,occurred_at_ms,payload_json) SELECT 'ticket',id,version,'ticket.terminated',consumer_id,?,json_object('reason','lease_expired') FROM tickets WHERE id=? AND phase='releasing'",
        params: [input.now, target.ticket_id],
      },
    ]);
  }
  renewal(
    ticketId: string,
    consumerId: string,
    renewalId: string,
  ): Promise<Row | undefined> {
    return this.db.get<Row>(
      `SELECT r.*,l.id AS lease_id FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id
      WHERE t.id=? AND t.consumer_id=? AND r.id=?`,
      [ticketId, consumerId, renewalId],
    );
  }
}
