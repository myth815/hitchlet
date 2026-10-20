import type { Storage } from "./index.js";
import type { Statement, SqlValue } from "./protocol.js";
const DAY = 86400000;
const terminal = "('succeeded','failed','cancelled')";

/** Only ledger history is removed here. No Provider, filesystem or secret deletion is performed. */
export async function pruneHistory(
  db: Storage,
  now: number,
): Promise<{ tickets: number; renewals: number; events: number }> {
  let tickets = 0,
    renewals = 0;
  // High-frequency renewal history has its own short window; current/unknown
  // guards and Agent dependencies are retained even when the Ticket is released.
  const oldRenewals = await db.all<{ id: string; operation_id: string }>(
    `SELECT r.id,r.operation_id FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id JOIN operations o ON o.id=r.operation_id WHERE t.phase='released' AND r.state<>'pending' AND r.updated_at_ms<? AND o.state IN ${terminal} AND NOT EXISTS(SELECT 1 FROM agent_commands c WHERE c.operation_id=o.id) LIMIT 200`,
    [now - 7 * DAY],
  );
  for (const r of oldRenewals) {
    const refs = await referenceGuard(
      db,
      [r.id, r.operation_id],
      [],
      [r.operation_id],
    );
    if (refs.referenced) continue;
    try {
      await db.batchTransaction([
        refs.fence,
        {
          kind: "run",
          sql: "DELETE FROM idempotency_keys WHERE renewal_id=? AND created_at_ms<=?",
          params: [r.id, now - 7 * DAY],
        },
        {
          kind: "run",
          sql: "DELETE FROM lease_renewals WHERE id=? AND state<>'pending' AND updated_at_ms<? AND EXISTS(SELECT 1 FROM leases l JOIN tickets t ON t.id=l.ticket_id WHERE l.id=lease_renewals.lease_id AND t.phase='released')",
          params: [r.id, now - 7 * DAY],
          expectChanges: 1,
        },
        {
          kind: "run",
          sql: `DELETE FROM operations WHERE id=? AND state IN ${terminal}`,
          params: [r.operation_id],
          expectChanges: 1,
        },
      ]);
      renewals++;
    } catch {
      /* A new FK/JSON dependency retains the entire transaction. */
    }
  }
  const oldTickets = await db.all<{ id: string }>(
    "SELECT id FROM tickets WHERE phase='released' AND released_at_ms<? AND cleanup_status IN('complete','not_needed') ORDER BY released_at_ms LIMIT 100",
    [now - 180 * DAY],
  );
  for (const t of oldTickets) {
    const allocations = await db.all<{
      id: string;
      resolved_provision_contract_id: string | null;
    }>(
      "SELECT id,resolved_provision_contract_id FROM allocations WHERE ticket_id=?",
      [t.id],
    );
    const ops = await db.all<{ id: string; state: string }>(
      "SELECT id,state FROM operations WHERE allocation_id IN(SELECT id FROM allocations WHERE ticket_id=?)",
      [t.id],
    );
    if (
      ops.some((o) => !["succeeded", "failed", "cancelled"].includes(o.state))
    )
      continue;
    const unsafe = await db.get(
      "SELECT 1 FROM allocations a WHERE ticket_id=? AND (cleanup_status<>'complete' OR EXISTS(SELECT 1 FROM capacity_claims c WHERE c.allocation_id=a.id AND c.state<>'released') OR EXISTS(SELECT 1 FROM managed_resources m WHERE m.allocation_id=a.id AND m.ownership='owned' AND m.observed_state<>'absent'))",
      [t.id],
    );
    if (unsafe) continue;
    const ids = [
      t.id,
      ...allocations.flatMap((a) =>
        a.resolved_provision_contract_id
          ? [a.id, a.resolved_provision_contract_id]
          : [a.id],
      ),
      ...ops.map((o) => o.id),
    ];
    const refs = await referenceGuard(
      db,
      ids,
      [t.id, ...allocations.map((a) => a.id)],
      ops.map((o) => o.id),
    );
    if (refs.referenced) continue;
    const sub = "SELECT id FROM allocations WHERE ticket_id=?",
      opSub = `SELECT id FROM operations WHERE allocation_id IN(${sub})`;
    const statements: Statement[] = [
      refs.fence,
      {
        kind: "run",
        sql: `DELETE FROM idempotency_keys WHERE ticket_id=? OR operation_id IN(${opSub}) OR renewal_id IN(SELECT r.id FROM lease_renewals r JOIN leases l ON l.id=r.lease_id WHERE l.ticket_id=?)`,
        params: [t.id, t.id, t.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM agent_receipts WHERE command_id IN(SELECT id FROM agent_commands WHERE operation_id IN(${opSub}) AND state IN('completed','expired','cancelled')) AND received_at_ms<?`,
        params: [t.id, now - 180 * DAY],
      },
      {
        kind: "run",
        sql: `DELETE FROM agent_commands WHERE operation_id IN(${opSub}) AND state IN('completed','expired','cancelled') AND not_after_ms<?`,
        params: [t.id, now - 180 * DAY],
      },
      {
        kind: "run",
        sql: "DELETE FROM lease_renewals WHERE lease_id IN(SELECT id FROM leases WHERE ticket_id=?) AND state<>'pending'",
        params: [t.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM operations WHERE allocation_id IN(${sub}) AND state IN ${terminal}`,
        params: [t.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM managed_resources WHERE allocation_id IN(${sub}) AND (ownership='reference' OR observed_state='absent')`,
        params: [t.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM capacity_claims WHERE allocation_id IN(${sub}) AND state='released'`,
        params: [t.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM leases WHERE ticket_id=?",
        params: [t.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM allocations WHERE ticket_id=? AND cleanup_status='complete'",
        params: [t.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM ticket_storage_grants WHERE ticket_id=?",
        params: [t.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM tickets WHERE id=? AND phase='released' AND released_at_ms<?",
        params: [t.id, now - 180 * DAY],
        expectChanges: 1,
      },
    ];
    for (const a of allocations)
      if (a.resolved_provision_contract_id)
        statements.push({
          kind: "run",
          sql: "DELETE FROM resolved_provision_contracts WHERE id=? AND NOT EXISTS(SELECT 1 FROM allocations WHERE resolved_provision_contract_id=?)",
          params: [
            a.resolved_provision_contract_id,
            a.resolved_provision_contract_id,
          ],
        });
    try {
      await db.batchTransaction(statements);
      tickets++;
    } catch {
      /* FK or changed evidence: preserve the whole historical graph. */
    }
  }
  // Unpublished, unreferenced completed validation history has the same
  // long retention as Ticket summaries. Published manifests retain their report.
  const validations = await db.all<{ id: string; report_id: string | null }>(
    "SELECT id,report_id FROM image_validations WHERE state IN('succeeded','failed','cancelled') AND cleanup_status='complete' AND finished_at_ms<? LIMIT 100",
    [now - 180 * DAY],
  );
  for (const validation of validations) {
    const allocations = await db.all<{
      id: string;
      resolved_provision_contract_id: string | null;
    }>(
      "SELECT id,resolved_provision_contract_id FROM allocations WHERE image_validation_id=?",
      [validation.id],
    );
    const ops = await db.all<{ id: string; state: string }>(
      "SELECT id,state FROM operations WHERE allocation_id IN(SELECT id FROM allocations WHERE image_validation_id=?)",
      [validation.id],
    );
    if (
      ops.some((o) => !["succeeded", "failed", "cancelled"].includes(o.state))
    )
      continue;
    const ids = [
      validation.id,
      ...(validation.report_id ? [validation.report_id] : []),
      ...allocations.map((a) => a.id),
      ...ops.map((o) => o.id),
    ];
    const refs = await referenceGuard(
      db,
      ids,
      [validation.id, ...allocations.map((a) => a.id)],
      ops.map((o) => o.id),
      [validation.id],
    );
    if (refs.referenced) continue;
    const sub = "SELECT id FROM allocations WHERE image_validation_id=?",
      opSub = `SELECT id FROM operations WHERE allocation_id IN(${sub})`;
    const statements: Statement[] = [
      refs.fence,
      {
        kind: "run",
        sql: `DELETE FROM idempotency_keys WHERE operation_id IN(${opSub})`,
        params: [validation.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM agent_receipts WHERE command_id IN(SELECT id FROM agent_commands WHERE operation_id IN(${opSub}) AND state IN('completed','expired','cancelled')) AND received_at_ms<?`,
        params: [validation.id, now - 180 * DAY],
      },
      {
        kind: "run",
        sql: `DELETE FROM agent_commands WHERE operation_id IN(${opSub}) AND state IN('completed','expired','cancelled') AND not_after_ms<?`,
        params: [validation.id, now - 180 * DAY],
      },
      {
        kind: "run",
        sql: `DELETE FROM operations WHERE allocation_id IN(${sub}) AND state IN ${terminal}`,
        params: [validation.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM managed_resources WHERE allocation_id IN(${sub}) AND (ownership='reference' OR observed_state='absent')`,
        params: [validation.id],
      },
      {
        kind: "run",
        sql: `DELETE FROM capacity_claims WHERE allocation_id IN(${sub}) AND state='released'`,
        params: [validation.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM allocations WHERE image_validation_id=? AND cleanup_status='complete'",
        params: [validation.id],
      },
      {
        kind: "run",
        sql: "DELETE FROM image_validations WHERE id=? AND state IN('succeeded','failed','cancelled') AND cleanup_status='complete' AND finished_at_ms<?",
        params: [validation.id, now - 180 * DAY],
        expectChanges: 1,
      },
    ];
    for (const allocation of allocations)
      if (allocation.resolved_provision_contract_id)
        statements.push({
          kind: "run",
          sql: "DELETE FROM resolved_provision_contracts WHERE id=? AND NOT EXISTS(SELECT 1 FROM allocations WHERE resolved_provision_contract_id=?)",
          params: [
            allocation.resolved_provision_contract_id,
            allocation.resolved_provision_contract_id,
          ],
        });
    try {
      await db.batchTransaction(statements);
    } catch {
      /* Published JSON/FK or changed live state preserves the whole graph. */
    }
  }
  // Successful side-effect details expire earlier than the compact summary.
  // Keep all still-live, unknown, receipt-dependent and power-recovery records.
  await db.run(
    `UPDATE operations SET result_json=json_object('detailsPrunedAtMs',?,'outcome','succeeded') WHERE state='succeeded' AND updated_at_ms<? AND allocation_id IN(SELECT id FROM allocations WHERE cleanup_status='complete') AND json_type(result_json,'$.detailsPrunedAtMs') IS NULL AND NOT EXISTS(SELECT 1 FROM agent_commands c WHERE c.operation_id=operations.id) AND NOT EXISTS(SELECT 1 FROM lease_renewals r WHERE r.operation_id=operations.id) AND NOT EXISTS(SELECT 1 FROM image_versions v WHERE instr(v.manifest_json,operations.id)>0)`,
    [now, now - 30 * DAY],
  );
  // Audit is low-frequency. Configuration revisions/revocations and Agent
  // tombstones remain small permanent evidence; snapshots overwrite in D20.
  await db.run("DELETE FROM audit_entries WHERE occurred_at_ms<?", [
    now - 180 * DAY,
  ]);
  const result = await db.run(
    `DELETE FROM events WHERE occurred_at_ms<? AND aggregate_id NOT IN(SELECT id FROM tickets WHERE phase<>'released' UNION SELECT id FROM allocations WHERE cleanup_status<>'complete' UNION SELECT id FROM operations WHERE state NOT IN ${terminal} UNION SELECT id FROM machines WHERE power_cycle_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.state NOT IN ${terminal} AND (instr(events.payload_json,o.id)>0 OR instr(o.intent_json,events.aggregate_id)>0 OR EXISTS(SELECT 1 FROM json_tree(COALESCE(o.result_json,'{}')) j WHERE j.key IN('eventId','eventCursor','acceptedEventId','restoreEventId') AND CAST(j.value AS TEXT)=CAST(events.id AS TEXT)))) AND NOT EXISTS(SELECT 1 FROM image_versions v WHERE EXISTS(SELECT 1 FROM json_tree(v.manifest_json) j WHERE j.key IN('eventId','eventCursor','acceptedEventId','restoreEventId') AND CAST(j.value AS TEXT)=CAST(events.id AS TEXT)))`,
    [now - 30 * DAY],
  );
  // Unreferenced successful installation actions can leave after 30 days. All
  // live power cycles/recovery obligations and published reports survive.
  await db.run(
    `DELETE FROM operations WHERE state='succeeded' AND updated_at_ms<? AND kind NOT LIKE 'power.%' AND allocation_id IS NULL AND machine_id IS NULL AND node_id IS NULL AND NOT EXISTS(SELECT 1 FROM idempotency_keys i WHERE i.operation_id=operations.id) AND NOT EXISTS(SELECT 1 FROM profile_grant_revocations r WHERE r.operation_id=operations.id) AND NOT EXISTS(SELECT 1 FROM agent_commands c WHERE c.operation_id=operations.id) AND NOT EXISTS(SELECT 1 FROM image_versions v WHERE instr(v.manifest_json,operations.id)>0)`,
    [now - 30 * DAY],
  );
  return { tickets, renewals, events: Number(result.changes) };
}

async function referenceGuard(
  db: Storage,
  ids: string[],
  ownAggregates: string[],
  ownOperations: string[],
  ownValidations: string[] = [],
) {
  // Match only this candidate's finite identifiers. Recheck in the short delete
  // transaction: unrelated writes neither expand a snapshot nor defeat cleanup.
  // UUID matching remains conservative for historical untyped JSON references.
  const sql = `SELECT 1 FROM (
 SELECT 'operation' k,id,intent_json||COALESCE(result_json,'') body FROM operations WHERE id NOT IN(SELECT value FROM json_each(?))
 UNION ALL SELECT 'image',id,manifest_json FROM image_versions
 UNION ALL SELECT 'validation',id,accepted_contract_json||scope_json||checks_json||COALESCE(report_id,'') FROM image_validations WHERE id NOT IN(SELECT value FROM json_each(?))
 UNION ALL SELECT 'machine',id,management_json FROM machines
 UNION ALL SELECT 'policy',id,config_json FROM policies
 UNION ALL SELECT 'event',CAST(id AS TEXT),payload_json FROM events WHERE aggregate_id NOT IN(SELECT value FROM json_each(?))
 UNION ALL SELECT 'maintenance','1',COALESCE(recovery_json,'') FROM system_maintenance
 ) source WHERE EXISTS(SELECT 1 FROM json_each(?) target WHERE instr(source.body,target.value)>0) LIMIT 1`;
  const params: SqlValue[] = [
    JSON.stringify(ownOperations),
    JSON.stringify(ownValidations),
    JSON.stringify(ownAggregates),
    JSON.stringify(ids),
  ];
  return {
    referenced: !!(await db.get(sql, params)),
    fence: {
      kind: "run",
      sql: `UPDATE system_maintenance SET version=version WHERE singleton=1 AND NOT EXISTS(${sql})`,
      params,
      expectChanges: 1,
    } satisfies Statement,
  };
}
