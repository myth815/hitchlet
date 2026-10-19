#!/usr/bin/env node
'use strict';

/**
 * 可复现的 SQLite 设计骨架验收。运行：node verify-schema.cjs
 * 语法依赖：Node.js 内置模块、PATH 中的 sqlite3（>= 3.37，启用 JSON）。
 * 生产要求 SQLite 3.51.3+ 修复版本；本脚本在旧版通过不代表可生产部署。
 * 不连接任何真实节点；只在 OS 临时目录创建一次性数据库并输出报告。
 * 验证范围：DDL/约束、示例事务的 CAS/容量守卫、底座分组件记账、
 * 不可变运行时/配置绑定、验证实例、续租/撤销守卫及电源状态字段。
 * 不证明真实 Provider、完整领域状态机、并发进程或电源控制已实现。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compute-schema-'));
const database = path.join(work, 'verification.sqlite');
const reportFile = path.join(work, 'verification.txt');
const report = [];
let passed = 0;
function log(line) { report.push(line); process.stdout.write(`${line}\n`); }
function raw(sql) {
  const result = spawnSync('sqlite3', ['-batch', '-bail', database], {
    input: `PRAGMA foreign_keys=ON;\n${sql}\n`, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function run(sql) {
  const result = raw(sql);
  assert.equal(result.status, 0, result.stderr || 'sqlite3 failed');
  return result.stdout.trim();
}
function pass(label) { passed += 1; log(`PASS ${label}`); }
function rejected(label, sql, pattern) {
  const result = raw(sql);
  assert.notEqual(result.status, 0, `Unexpected acceptance: ${label}`);
  assert.match(result.stderr, pattern, `Unexpected failure reason: ${label}`);
  pass(label);
}
function equal(label, sql, expected) {
  assert.equal(run(sql), expected, label);
  pass(label);
}

try {
  log(`Schema: ${path.join(__dirname, 'schema.sql')}`);
  log(`Database: ${database}`);
  log(`SQLite: ${spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
  log('Version scope: SQL compatibility only; production requires patched SQLite 3.51.3+.');
  run(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  pass('DDL executes on a fresh local SQLite database');

  run(`
INSERT INTO installations(singleton,installation_id,created_at_ms) VALUES (1,'installation-1',1);
INSERT INTO consumers(id,name,kind,authorization_json,quota_json,created_at_ms)
 VALUES ('c1','consumer one','agent','{"imageIds":"all","nodeIds":"all","networkProfileIds":"all","storageProfileIds":"all"}',
 '{"maxQueuedTickets":10,"maxActiveTickets":10,"maxResources":{"cpuMillis":32000,"memoryMiB":65536,"scratchMiB":204800},"maxLeaseTtlSeconds":3600,"maxLifetimeSeconds":86400}',1),
 ('c2','consumer two','agent','{"imageIds":[],"nodeIds":[],"networkProfileIds":[],"storageProfileIds":[]}',
 '{"maxQueuedTickets":1,"maxActiveTickets":1,"maxResources":{"cpuMillis":1000,"memoryMiB":1024,"scratchMiB":1024},"maxLeaseTtlSeconds":900,"maxLifetimeSeconds":3600}',1);
INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms)
 VALUES ('deny-v1',1,'[{"cidr":"192.0.2.0/24","protocol":"any","ports":"any"}]','initial management network','c1',1);
UPDATE installations SET current_network_deny_revision_id='deny-v1' WHERE singleton=1;
INSERT INTO network_profiles(id,name,created_at_ms) VALUES ('net','isolated',1);
INSERT INTO network_profile_revisions(id,profile_id,revision,policy_json,created_at_ms)
 VALUES ('net-v1','net',1,'{"mode":"isolated_bridge"}',1);
UPDATE network_profiles SET current_revision_id='net-v1' WHERE id='net';
INSERT INTO storage_profiles(id,name,created_at_ms) VALUES ('storage','external-data',1);
INSERT INTO storage_profile_revisions(id,profile_id,revision,kind,config_json,secret_version_ref,created_at_ms)
 VALUES ('storage-v1','storage',1,'nfs','{"root":"/exports/data"}','secret-v1',1);
UPDATE storage_profiles SET current_revision_id='storage-v1' WHERE id='storage';
INSERT INTO gui_sessions(id,consumer_id,token_hash,csrf_token_hash,created_at_ms,expires_at_ms)
 VALUES ('session-1','c1',printf('%064d',1),printf('%064d',2),1,10000);
INSERT INTO images(id,name,created_at_ms) VALUES ('img','linux-development',1);
INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms,published_at_ms)
 VALUES ('iv','img','1.0','published','{}',1,2);
INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms)
 VALUES ('vm-art','iv','hyperv','vm','amd64','linux','template.vhdx','sha256:fixture',1000,512,1024,'{}',1),
 ('container-art','iv','portainer','container','amd64','linux','registry/image@sha256:fixture','sha256:fixture',1000,512,1024,'{}',1);
INSERT INTO machines(id,name,usage_mode,host_os,architecture,created_at_ms)
 VALUES ('m1','windows-host','shared','windows','amd64',1),('m2','ubuntu-host','dedicated','linux','amd64',1);
INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms)
 VALUES ('rt-hv','hyperv','hyperv_host','host-1',1),
 ('rt-docker','portainer','docker_engine','engine-2',1),
 ('rt-child','portainer','docker_engine','engine-3',1);
INSERT INTO provider_connections(id,backend_kind,runtime_identity_id)
 VALUES ('pc-hv','hyperv','rt-hv'),('pc-docker','portainer','rt-docker'),('pc-child','portainer','rt-child');
INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms)
 VALUES ('pc-hv-v1','pc-hv',1,'agent://m1','host-1','rt-hv',1,'{}',1),
 ('pc-docker-v1','pc-docker',1,'https://portainer.example.invalid','environment-2','rt-docker',1,'{}',1),
 ('pc-child-v1','pc-child',1,'https://portainer.example.invalid','environment-3','rt-child',1,'{}',1);
UPDATE provider_connections SET current_revision_id=id||'-v1';
INSERT INTO capacity_pools(id,machine_id,total_cpu_millis,total_memory_mib,total_scratch_mib)
 VALUES ('p1','m1',12000,49152,102400),('p2','m2',8000,16384,102400);
INSERT INTO nodes(id,machine_id,name,backend_kind,pool_id,provider_connection_id,runtime_identity_id)
 VALUES ('n1','m1','hyperv','hyperv','p1','pc-hv','rt-hv'),
 ('n2','m2','docker','portainer','p2','pc-docker','rt-docker');
INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json)
 VALUES ('contract-v1','n1',printf('%064d',0),1,'net-v1','deny-v1',printf('%064d',0),'[]','{"networkProfileRevisionId":"net-v1","platformDenyRevisionId":"deny-v1"}'),
 ('contract-docker','n2',printf('%064d',0),1,'net-v1','deny-v1',printf('%064d',0),'[]','{"networkProfileRevisionId":"net-v1","platformDenyRevisionId":"deny-v1"}');
INSERT INTO tickets(id,consumer_id,image_version_id,network_profile_revision_id,phase,cleanup_status,request_json,request_hash,accepted_contract_json,requested_cpu_millis,requested_memory_mib,requested_scratch_mib,created_at_ms,queue_deadline_ms)
 VALUES ('t1','c1','iv','net-v1','reserved','pending','{}',printf('%064d',0),'{}',1000,512,1024,1,10000),
 ('t2','c1','iv','net-v1','reserved','pending','{}',printf('%064d',0),'{}',1000,512,1024,1,10000),
 ('t3','c1','iv','net-v1','reserved','pending','{}',printf('%064d',0),'{}',2500,512,1024,1,10000),
 ('t4','c1','iv','net-v1','reserved','pending','{}',printf('%064d',0),'{}',2500,512,1024,1,10000);
INSERT INTO allocations(id,purpose,ticket_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms)
 VALUES ('a1','tenant','t1','m1','n1','rt-hv','contract-v1','vm-art',1,'present','{}',1),
 ('base','infrastructure',NULL,'m1','n1','rt-hv','contract-v1','vm-art',1,'present','{}',1),
 ('a3','tenant','t3','m1','n1','rt-hv','contract-v1','vm-art',1,'present','{}',1),
 ('a4','tenant','t4','m1','n1','rt-hv','contract-v1','vm-art',1,'present','{}',1);
INSERT INTO capacity_claims(id,allocation_id,pool_id,component,state,cpu_millis,memory_mib,scratch_mib,created_at_ms)
 VALUES ('claim1','a1','p1','combined','reserved',1000,512,1024,1),
 ('base-runtime','base','p1','runtime','committed',8000,24576,0,1),
 ('base-storage','base','p1','storage','committed',0,0,20480,1);
INSERT INTO capacity_pools(id,machine_id,parent_allocation_id,total_cpu_millis,total_memory_mib,total_scratch_mib)
 VALUES ('child-pool','m1','base',7000,22528,19456);
INSERT INTO nodes(id,machine_id,name,backend_kind,pool_id,provider_connection_id,runtime_identity_id)
 VALUES ('child-node','m1','docker-in-vm','portainer','child-pool','pc-child','rt-child');
INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json)
 VALUES ('contract-child','child-node',printf('%064d',0),1,'net-v1','deny-v1',printf('%064d',0),'[]','{"networkProfileRevisionId":"net-v1","platformDenyRevisionId":"deny-v1"}');
INSERT INTO allocations(id,purpose,ticket_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms)
 VALUES ('a2','tenant','t2','m1','child-node','rt-child','contract-child','container-art',1,'present','{}',1);
INSERT INTO capacity_claims(id,allocation_id,pool_id,state,cpu_millis,memory_mib,scratch_mib,created_at_ms)
 VALUES ('claim2','a2','child-pool','committed',1000,512,1024,1);
INSERT INTO leases(id,ticket_id,allocation_id,generation,state,claim_by_ms,expires_at_ms,renew_until_ms)
 VALUES ('l1','t1','a1',1,'active',1000,5000,10000);
INSERT INTO agents(id,machine_id,kind,credential_hash)
 VALUES ('ag1','m1','host','fixture-hash'),('ag2','m2','host','fixture-hash-2');
INSERT INTO operations(id,allocation_id,runtime_identity_id,connection_revision_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,state,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms)
 VALUES ('op1','a1','rt-hv','pc-hv-v1',1,1,1,'create','create-1','dedup-create-1','unknown',printf('%064d',0),'{}',10,1,1);
INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms)
 VALUES ('backup1','installation-1',1,'backup','backup-request-1','dedup-backup-1',printf('%064d',0),'{}',10,1,1);
INSERT INTO managed_resources(id,allocation_id,node_id,generation,kind,provider_id,ownership,ownership_json,cleanup_policy)
 VALUES ('r1','a1','n1',1,'vm','vm-external-1','owned','{}','destroy');
INSERT INTO agent_commands(id,agent_id,operation_id,sequence,controller_epoch,machine_epoch,generation,control_version,kind,payload_json,request_hash,state,not_after_ms,created_at_ms)
 VALUES ('cmd1','ag1','op1',1,1,1,1,1,'create','{}',printf('%064d',0),'unknown',10000,1);
INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,created_at_ms,retain_until_ms)
 VALUES ('c1','POST /v1/tickets','same-key',printf('%064d',0),'t1',1,100000);
  `);
  pass('Fixture represents Machine -> base VM -> child pool -> Docker Node -> tenant');

  rejected('Consumer update timestamp cannot precede creation', "UPDATE consumers SET updated_at_ms=0 WHERE id='c1';", /CHECK constraint/);

  rejected('Invalid Ticket state rejected', "UPDATE tickets SET phase='running' WHERE id='t1';", /CHECK constraint/);
  rejected('GUI session expiry must follow creation', "UPDATE gui_sessions SET expires_at_ms=1 WHERE id='session-1';", /CHECK constraint/);
  equal('GUI session authorization lookup excludes expired and revoked sessions', `
SELECT count(*) FROM gui_sessions WHERE id='session-1' AND expires_at_ms>100 AND revoked_at_ms IS NULL;
SELECT count(*) FROM gui_sessions WHERE id='session-1' AND expires_at_ms>10000 AND revoked_at_ms IS NULL;
UPDATE gui_sessions SET revoked_at_ms=200 WHERE id='session-1';
SELECT count(*) FROM gui_sessions WHERE id='session-1' AND expires_at_ms>300 AND revoked_at_ms IS NULL;`, '1\n0\n0');
  equal('Installation-wide Operation needs no Machine/Node/Allocation', "SELECT installation_id FROM operations WHERE id='backup1' AND allocation_id IS NULL AND machine_id IS NULL AND node_id IS NULL;", 'installation-1');
  rejected('Installation-wide Operation cannot also target a Machine', "UPDATE operations SET machine_id='m1',machine_epoch=1 WHERE id='backup1';", /CHECK constraint/);
  rejected('Duplicate installation operation step rejected', "INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms) VALUES ('backup-dup','installation-1',1,'backup','backup-request-1','different-dedup',printf('%064d',0),'{}',10,1,1);", /UNIQUE constraint/);
  rejected('Blocked cleanup cannot become released', "UPDATE tickets SET phase='released',terminal_reason='consumer_release',cleanup_status='blocked',released_at_ms=200 WHERE id='t1';", /CHECK constraint/);
  rejected('Negative resource rejected', "UPDATE capacity_claims SET cpu_millis=-1 WHERE id='claim1';", /CHECK constraint/);
  rejected('Fractional integer resource rejected by STRICT', "UPDATE capacity_claims SET memory_mib=1.5 WHERE id='claim1';", /cannot store REAL/);
  rejected('Second tenant Allocation for one Ticket rejected', "INSERT INTO allocations(id,purpose,ticket_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms) VALUES ('dup','tenant','t1','m1','n1','rt-hv','contract-v1','vm-art',2,'present','{}',1);", /UNIQUE constraint/);
  rejected('Lease generation mismatch rejected', "UPDATE leases SET generation=2 WHERE id='l1';", /FOREIGN KEY constraint/);
  rejected('Lease maximum deadline enforced', "UPDATE leases SET expires_at_ms=10001 WHERE id='l1';", /CHECK constraint/);
  rejected('Cross-Machine pool reference rejected', "UPDATE nodes SET pool_id='p2' WHERE id='n1';", /FOREIGN KEY constraint/);
  rejected('Wrong ProviderConnection kind rejected', "UPDATE nodes SET provider_connection_id='pc-docker' WHERE id='n1';", /FOREIGN KEY constraint/);
  rejected('Malformed JSON rejected', "UPDATE consumers SET quota_json='not-json' WHERE id='c1';", /CHECK constraint/);
  rejected('Wrong Agent receipt rejected', "INSERT INTO agent_receipts(id,command_id,agent_id,agent_boot_id,receipt_sequence,phase,request_hash,result_json,observed_at_ms,received_at_ms) VALUES ('bad','cmd1','ag2','boot1',1,'succeeded',printf('%064d',0),'{}',2,3);", /FOREIGN KEY constraint/);
  rejected('Duplicate consumer-scoped idempotency key rejected', "INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,created_at_ms,retain_until_ms) VALUES ('c1','POST /v1/tickets','same-key',printf('%064d',0),'t1',1,100000);", /UNIQUE constraint/);
  rejected('Shared reference cannot use destructive cleanup', "UPDATE managed_resources SET ownership='reference',cleanup_policy='destroy' WHERE id='r1';", /CHECK constraint/);
  rejected('Operation must have one target', "UPDATE operations SET machine_id='m1',machine_epoch=1 WHERE id='op1';", /CHECK constraint/);
  rejected('Root pool unique per Machine', "INSERT INTO capacity_pools(id,machine_id,total_cpu_millis,total_memory_mib,total_scratch_mib) VALUES ('dup-root','m1',1,1,1);", /UNIQUE constraint/);
  rejected('Storage component cannot reserve CPU', "UPDATE capacity_claims SET cpu_millis=1 WHERE id='base-storage';", /CHECK constraint/);
  rejected('Duplicate live runtime Claim rejected', "INSERT INTO capacity_claims(id,allocation_id,pool_id,component,state,cpu_millis,memory_mib,scratch_mib,created_at_ms) VALUES ('duplicate-runtime','base','p1','runtime','reserved',1000,512,0,1);", /UNIQUE constraint/);

  rejected('One physical runtime identity cannot register twice', "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES ('rt-dup','portainer','docker_engine','engine-2',1);", /UNIQUE constraint/);
  rejected('Runtime native identity kind must match its backend', "INSERT INTO runtime_identities(id,backend_kind,native_kind,native_id,created_at_ms) VALUES ('rt-wrong-kind','portainer','hyperv_host','engine-new',1);", /CHECK constraint/);
  rejected('One runtime cannot become two scheduling Nodes', "INSERT INTO nodes(id,machine_id,name,backend_kind,pool_id,provider_connection_id,runtime_identity_id) VALUES ('n2-dup','m2','duplicate-engine','portainer','p2','pc-docker','rt-docker');", /UNIQUE constraint/);
  rejected('Connection cannot be repointed to a different runtime', "UPDATE provider_connections SET runtime_identity_id='rt-child' WHERE id='pc-docker';", /runtime identity is immutable/);
  rejected('Connection revision with a different verified engine is rejected', "INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms) VALUES ('pc-docker-bad','pc-docker',2,'https://new.invalid','99','rt-child',2,'{}',2);", /FOREIGN KEY constraint/);
  rejected('Existing connection revision cannot be edited', "UPDATE provider_connection_revisions SET endpoint_ref='https://changed.invalid' WHERE id='pc-hv-v1';", /revision is immutable/);
  equal('Transport change creates a same-runtime revision while old Operation stays pinned', `
INSERT INTO provider_connection_revisions(id,connection_id,revision,endpoint_ref,provider_endpoint_id,verified_runtime_identity_id,verified_at_ms,evidence_json,created_at_ms)
 VALUES ('pc-hv-v2','pc-hv',2,'agent://new-route','host-1','rt-hv',2,'{}',2);
UPDATE provider_connections SET current_revision_id='pc-hv-v2',version=version+1 WHERE id='pc-hv';
SELECT current_revision_id FROM provider_connections WHERE id='pc-hv';
SELECT connection_revision_id FROM operations WHERE id='op1';`, 'pc-hv-v2\npc-hv-v1');
  rejected('Allocation runtime identity cannot be changed', "UPDATE allocations SET runtime_identity_id='rt-child' WHERE id='a1';", /allocation identity/);
  equal('Identity mismatch cannot serve as absence evidence in example cleanup guard', `BEGIN IMMEDIATE;
UPDATE capacity_claims SET state='released',released_at_ms=100,release_evidence_ref='mismatched-observation'
 WHERE id='claim1' AND EXISTS (SELECT 1 FROM allocations WHERE id='a1' AND runtime_identity_id='rt-child');
SELECT changes(); SELECT state FROM capacity_claims WHERE id='claim1'; COMMIT;`, '0\nreserved');
  equal('Operation version CAS rejects stale writer', `BEGIN IMMEDIATE;
UPDATE operations SET version=version+1,updated_at_ms=2 WHERE id='op1' AND version=1;
SELECT changes();
UPDATE operations SET version=version+1,updated_at_ms=3 WHERE id='op1' AND version=1;
SELECT changes(); COMMIT;`, '1\n0');

  // No runtime is contacted. The following fixture is an unpublished image's
  // validation allocation; controller validation/publication is still app code.
  run(`
INSERT INTO image_versions(id,image_id,version,status,manifest_json,created_at_ms)
 VALUES ('iv-draft','img','2.0','draft','{}',2);
INSERT INTO image_artifacts(id,image_version_id,backend_kind,environment_kind,architecture,guest_os,artifact_ref,content_digest,minimum_cpu_millis,minimum_memory_mib,minimum_scratch_mib,access_recipe_json,created_at_ms)
 VALUES ('draft-art','iv-draft','portainer','container','amd64','linux','registry/draft@sha256:test','sha256:test',1000,512,1024,'{}',2);
INSERT INTO image_validations(id,image_artifact_id,node_id,requested_by_consumer_id,accepted_contract_json,deadline_ms,created_at_ms,updated_at_ms)
 VALUES ('validation-1','draft-art','n2','c1','{}',10000,2,2);
INSERT INTO allocations(id,purpose,image_validation_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms)
 VALUES ('validation-a','validation','validation-1','m2','n2','rt-docker','contract-docker','draft-art',1,'present','{}',2);
INSERT INTO capacity_claims(id,allocation_id,pool_id,state,cpu_millis,memory_mib,scratch_mib,created_at_ms)
 VALUES ('validation-claim','validation-a','p2','committed',1000,512,1024,2);
UPDATE image_validations SET state='releasing',test_outcome='passed',report_id='report-1',version=version+1 WHERE id='validation-1';`);
  equal('Draft image can reserve an isolated validation allocation without a consumer Lease', "SELECT a.purpose||'|'||i.status||'|'||(SELECT count(*) FROM leases WHERE allocation_id=a.id) FROM allocations a JOIN image_artifacts f ON f.id=a.image_artifact_id JOIN image_versions i ON i.id=f.image_version_id WHERE a.id='validation-a';", 'validation|draft|0');
  rejected('Validation allocation cannot also own a consumer Ticket', "INSERT INTO allocations(id,purpose,ticket_id,image_validation_id,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms) VALUES ('validation-invalid','validation','t4','validation-1','m2','n2','rt-docker','contract-v1','draft-art',1,'present','{}',2);", /CHECK constraint/);
  rejected('Validation allocation cannot own a child pool', "INSERT INTO capacity_pools(id,machine_id,parent_allocation_id,total_cpu_millis,total_memory_mib,total_scratch_mib) VALUES ('invalid-child','m2','validation-a',1000,512,1024);", /requires infrastructure VM/);
  rejected('Validation success cannot be asserted while cleanup is blocked', "UPDATE image_validations SET state='succeeded',cleanup_status='blocked',finished_at_ms=20 WHERE id='validation-1';", /CHECK constraint/);
  const finishValidation = `UPDATE image_validations SET state='succeeded',cleanup_status='complete',finished_at_ms=20,version=version+1
 WHERE id='validation-1' AND test_outcome='passed'
 AND EXISTS (SELECT 1 FROM allocations a WHERE a.image_validation_id=image_validations.id AND a.cleanup_status='complete')
 AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.image_validation_id=image_validations.id AND a.cleanup_status<>'complete')
 AND NOT EXISTS (SELECT 1 FROM allocations a JOIN capacity_claims c ON c.allocation_id=a.id WHERE a.image_validation_id=image_validations.id AND c.state<>'released'); SELECT changes();`;
  equal('Validation completion guard waits for allocation and Claim cleanup', `BEGIN IMMEDIATE; ${finishValidation}
UPDATE allocations SET desired_state='absent',observed_state='absent',cleanup_status='complete',control_version=control_version+1,version=version+1 WHERE id='validation-a';
UPDATE capacity_claims SET state='released',released_at_ms=20,release_evidence_ref='fixture-validation-cleanup',version=version+1 WHERE id='validation-claim';
${finishValidation} COMMIT;`, '0\n1');

  run(`
INSERT INTO leases(id,ticket_id,allocation_id,generation,state,claim_by_ms,expires_at_ms,renew_until_ms)
 VALUES ('l2','t2','a2',1,'active',1000,5000,10000),('l3','t3','a3',1,'active',1000,5000,10000);
UPDATE tickets SET phase='ready',ready_at_ms=100 WHERE id IN ('t2','t3');
INSERT INTO operations(id,allocation_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms)
 VALUES ('renew-op','a2',1,1,1,'renew_lease','renew-1','renew-dedup-1',printf('%064d',0),'{}',10,1,1),
 ('renew-op-2','a2',1,1,1,'renew_lease','renew-2','renew-dedup-2',printf('%064d',0),'{}',10,1,1),
 ('renew-op-3','a3',1,1,1,'renew_lease','renew-3','renew-dedup-3',printf('%064d',0),'{}',10,1,1);
INSERT INTO lease_renewals(id,lease_id,operation_id,expected_version,proposed_version,proposed_expires_at_ms,is_initial_claim,decision_deadline_ms,created_at_ms,updated_at_ms)
 VALUES ('renewal-1','l2','renew-op',1,2,6000,1,1000,500,500),
 ('renewal-3','l3','renew-op-3',1,2,6000,1,1000,500,500);
INSERT INTO idempotency_keys(consumer_id,route_scope,idempotency_key,request_hash,ticket_id,renewal_id,response_status,safe_response_json,created_at_ms,retain_until_ms)
 VALUES ('c1','POST /v1/tickets/t2/renew','renew-key',printf('%064d',0),'t2','renewal-1',202,'{"state":"pending"}',500,100000);`);
  rejected('Only one renewal proposal may be pending for a Lease', "INSERT INTO lease_renewals(id,lease_id,operation_id,expected_version,proposed_version,proposed_expires_at_ms,is_initial_claim,decision_deadline_ms,created_at_ms,updated_at_ms) VALUES ('renewal-duplicate','l2','renew-op-2',1,2,7000,1,1000,600,600);", /UNIQUE constraint/);
  equal('Consumer renewal lookup is scoped through own Ticket', "SELECT count(*) FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id WHERE r.id='renewal-1' AND t.consumer_id='c1'; SELECT count(*) FROM lease_renewals r JOIN leases l ON l.id=r.lease_id JOIN tickets t ON t.id=l.ticket_id WHERE r.id='renewal-1' AND t.consumer_id='c2';", '1\n0');
  equal('Initial renewal guard rejects expired claim deadline before sweeper runs', `BEGIN IMMEDIATE;
UPDATE leases SET version=version+1,claimed_at_ms=1200,expires_at_ms=6000
 WHERE id='l2' AND version=1 AND state='active' AND expires_at_ms>1200
 AND (claimed_at_ms IS NOT NULL OR claim_by_ms>1200);
SELECT changes(); ROLLBACK;`, '0');
  equal('Timely proposal with late ACK cannot activate the initial claim', `BEGIN IMMEDIATE;
UPDATE leases SET version=2,claimed_at_ms=1100,expires_at_ms=6000
 WHERE id='l2' AND version=1 AND state='active' AND expires_at_ms>1100
 AND (claimed_at_ms IS NOT NULL OR claim_by_ms>1100)
 AND EXISTS (SELECT 1 FROM lease_renewals WHERE id='renewal-1' AND state='pending' AND decision_deadline_ms>1100);
SELECT changes(); ROLLBACK;`, '0');
  equal('Confirmed renewal updates Lease, proposal and idempotent response atomically', `BEGIN IMMEDIATE;
UPDATE leases SET version=2,claimed_at_ms=900,expires_at_ms=6000
 WHERE id='l2' AND version=1 AND state='active' AND expires_at_ms>900
 AND (claimed_at_ms IS NOT NULL OR claim_by_ms>900)
 AND EXISTS (SELECT 1 FROM tickets t WHERE t.id=leases.ticket_id AND t.phase='ready' AND t.terminal_reason IS NULL)
 AND EXISTS (SELECT 1 FROM lease_renewals WHERE id='renewal-1' AND state='pending' AND decision_deadline_ms>900);
SELECT changes();
UPDATE lease_renewals SET state='confirmed',confirmed_receipt_json='{"leaseVersion":2,"expiresAt":6000}',version=version+1,updated_at_ms=900
 WHERE id='renewal-1' AND EXISTS (SELECT 1 FROM leases WHERE id='l2' AND version=2 AND claimed_at_ms=900);
UPDATE idempotency_keys SET response_status=200,safe_response_json=(SELECT confirmed_receipt_json FROM lease_renewals WHERE id=renewal_id)
 WHERE renewal_id='renewal-1' AND EXISTS (SELECT 1 FROM lease_renewals WHERE id=renewal_id AND state='confirmed');
SELECT response_status||'|'||json_extract(safe_response_json,'$.leaseVersion') FROM idempotency_keys WHERE renewal_id='renewal-1'; COMMIT;`, '1\n200|2');
  equal('Admin revoke invalidates pending renewals and stale ACK in the same termination transaction', `BEGIN IMMEDIATE;
UPDATE tickets SET phase='releasing',terminal_reason='admin_revoke',cleanup_status='pending',termination_requested_at_ms=700,version=version+1 WHERE id='t3' AND version=1;
UPDATE allocations SET desired_state='absent',control_version=control_version+1,version=version+1 WHERE id='a3';
UPDATE leases SET state='revoking',version=version+1 WHERE id='l3';
UPDATE lease_renewals SET state='cancelled',rejection_json='{"code":"ADMIN_REVOKE"}',version=version+1,updated_at_ms=700 WHERE lease_id='l3' AND state='pending';
INSERT INTO operations(id,allocation_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms)
 VALUES ('revoke-cleanup','a3',1,2,1,'cleanup','revoke-1','revoke-cleanup-1',printf('%064d',0),'{}',700,700,700);
INSERT INTO audit_entries(actor_type,actor_id,action,target_type,target_id,request_id,occurred_at_ms,safe_details_json)
 VALUES ('consumer','c1','admin_revoke','ticket','t3','req-revoke',700,'{"reason":"fixture revoke"}');
UPDATE leases SET version=2,expires_at_ms=6000 WHERE id='l3' AND version=1 AND state='active'
 AND EXISTS (SELECT 1 FROM lease_renewals WHERE id='renewal-3' AND state='pending');
SELECT changes();
SELECT t.terminal_reason||'|'||a.control_version||'|'||l.state||'|'||r.state
 FROM tickets t JOIN allocations a ON a.ticket_id=t.id JOIN leases l ON l.ticket_id=t.id JOIN lease_renewals r ON r.lease_id=l.id WHERE t.id='t3'; COMMIT;`, '0\nadmin_revoke|2|revoking|cancelled');

  // Initial ready uses its own proposal, before any consumer renewal exists.
  // Reserve inserted Lease version 1; the Agent receives proposed version 2.
  // ACK version and frozen deadlines must match before DB publishes active/2.
  run(`INSERT INTO leases(id,ticket_id,allocation_id,generation,state,version)
 VALUES ('initial-ready-lease','t4','a4',1,'pending',1);
UPDATE tickets SET phase='provisioning' WHERE id='t4';
INSERT INTO operations(id,allocation_id,generation,control_version,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,deadline_ms,created_at_ms,updated_at_ms)
 VALUES ('initial-ready-op','a4',1,1,1,'activate_lease','initial-ready-1','initial-ready-1',printf('%064d',0),
 '{"expectedLeaseVersion":1,"proposedLeaseVersion":2,"startsAt":200,"claimBy":1200,"expiresAt":1700,"renewUntil":10200}',200,500,200,200);`);
  const initialReadyAck = (ackVersion, acknowledgedAt) => `
UPDATE leases AS l SET state='active',version=json_extract(o.intent_json,'$.proposedLeaseVersion'),
 starts_at_ms=json_extract(o.intent_json,'$.startsAt'),claim_by_ms=json_extract(o.intent_json,'$.claimBy'),
 expires_at_ms=json_extract(o.intent_json,'$.expiresAt'),renew_until_ms=json_extract(o.intent_json,'$.renewUntil')
 FROM operations o JOIN allocations a ON a.id=o.allocation_id JOIN tickets t ON t.id=a.ticket_id
 WHERE l.id='initial-ready-lease' AND o.id='initial-ready-op' AND l.state='pending'
 AND l.version=json_extract(o.intent_json,'$.expectedLeaseVersion')
 AND ${ackVersion}=json_extract(o.intent_json,'$.proposedLeaseVersion')
 AND json_extract(o.intent_json,'$.proposedLeaseVersion')=l.version+1
 AND o.generation=l.generation AND o.control_version=a.control_version
 AND t.phase='provisioning' AND t.terminal_reason IS NULL
 AND o.state IN ('planned','running') AND o.deadline_ms>${acknowledgedAt}
 AND json_extract(o.intent_json,'$.claimBy')>${acknowledgedAt}
 AND json_extract(o.intent_json,'$.expiresAt')>${acknowledgedAt};
SELECT changes();`;
  equal('Initial ready rejects an ACK for reserved version 1 instead of proposed version 2',
    `BEGIN IMMEDIATE; ${initialReadyAck(1, 300)} SELECT state||'|'||version FROM leases WHERE id='initial-ready-lease'; ROLLBACK;`, '0\npending|1');
  equal('Initial ready rejects late ACK without activating or recalculating deadlines',
    `BEGIN IMMEDIATE; ${initialReadyAck(2, 1800)} SELECT state||'|'||version FROM leases WHERE id='initial-ready-lease'; ROLLBACK;`, '0\npending|1');
  equal('Initial ready publishes exactly the proposed guard version and frozen deadlines', `BEGIN IMMEDIATE;
${initialReadyAck(2, 300)}
UPDATE tickets SET phase='ready',ready_at_ms=300,version=version+1 WHERE id='t4'
 AND EXISTS (SELECT 1 FROM leases WHERE id='initial-ready-lease' AND state='active' AND version=2);
SELECT l.state||'|'||l.version||'|'||json_extract(o.intent_json,'$.proposedLeaseVersion')||'|'||l.starts_at_ms||'|'||l.claim_by_ms||'|'||l.expires_at_ms
 FROM leases l,operations o WHERE l.id='initial-ready-lease' AND o.id='initial-ready-op'; COMMIT;`, '1\nactive|2|2|200|1200|1700');

  rejected('off_expected needs an accepted shutdown and wake guard', "UPDATE machines SET power_lifecycle='off_expected',power_cycle_id='cycle-1',power_transition_id='shutdown-1',power_transition_deadline_ms=10000 WHERE id='m2';", /CHECK constraint/);
  equal('Expected-off wake guard permits owned shutdown cycle without pretending physical off', `BEGIN IMMEDIATE;
UPDATE machines SET power_lifecycle='off_expected',observed_power='unknown',power_cycle_id='cycle-1',power_transition_id='shutdown-1',shutdown_accepted_at_ms=1000,wake_not_before_ms=121000,power_transition_deadline_ms=200000 WHERE id='m2';
UPDATE machines SET power_lifecycle='waking',power_transition_id='wake-1',wake_attempt_count=wake_attempt_count+1
 WHERE id='m2' AND power_lifecycle='off_expected' AND power_cycle_id='cycle-1' AND wake_not_before_ms<=120000;
SELECT changes();
UPDATE machines SET power_lifecycle='waking',power_transition_id='wake-1',wake_attempt_count=wake_attempt_count+1
 WHERE id='m2' AND power_lifecycle='off_expected' AND power_cycle_id='cycle-1' AND wake_not_before_ms<=121000;
SELECT changes(); SELECT power_lifecycle||'|'||observed_power FROM machines WHERE id='m2'; COMMIT;`, '0\n1\nwaking|unknown');
  equal('Unexplained offline state is not an expected-off wake candidate', "SELECT count(*) FROM machines WHERE id='m1' AND power_lifecycle IN ('off_expected','off_confirmed');", '0');

  run(`INSERT INTO ticket_storage_grants(id,ticket_id,storage_profile_revision_id,authorized_subpath,mount_path,mode,created_at_ms) VALUES ('grant-1','t1','storage-v1','tenant-a','/data','read_write',1);
INSERT INTO storage_profile_revisions(id,profile_id,revision,kind,config_json,secret_version_ref,created_at_ms) VALUES ('storage-v2','storage',2,'nfs','{"root":"/exports/new"}','secret-v2',2);
UPDATE storage_profiles SET current_revision_id='storage-v2',version=version+1 WHERE id='storage';
INSERT INTO network_profile_revisions(id,profile_id,revision,policy_json,created_at_ms) VALUES ('net-v2','net',2,'{"mode":"isolated_bridge"}',2);
UPDATE network_profiles SET current_revision_id='net-v2',version=version+1 WHERE id='net';`);
  equal('Logical profile changes leave existing Ticket and grants pinned', "SELECT current_revision_id FROM storage_profiles WHERE id='storage'; SELECT storage_profile_revision_id FROM ticket_storage_grants WHERE id='grant-1'; SELECT network_profile_revision_id FROM tickets WHERE id='t1';", 'storage-v2\nstorage-v1\nnet-v1');
  rejected('Pinned storage revision cannot be edited', "UPDATE storage_profile_revisions SET config_json='{}' WHERE id='storage-v1';", /revision is immutable/);
  rejected('Pinned network revision cannot be edited', "UPDATE network_profile_revisions SET policy_json='{}' WHERE id='net-v1';", /revision is immutable/);
  rejected('Ticket cannot silently switch to a new network revision', "UPDATE tickets SET network_profile_revision_id='net-v2' WHERE id='t1';", /network revision is immutable/);
  rejected('Frozen resolved source and secret bindings cannot change', "UPDATE resolved_provision_contracts SET storage_bindings_json='[{}]' WHERE id='contract-v1';", /contract is immutable/);
  rejected('Accepted Ticket grant selection cannot be rewritten before placement', "UPDATE tickets SET accepted_contract_json='{\"changed\":true}' WHERE id='t1';", /selection is immutable/);
  rejected('Accepted validation grant selection cannot be rewritten', "UPDATE image_validations SET accepted_contract_json='{\"changed\":true}' WHERE id='validation-1';", /selection is immutable/);
  rejected('A resolved contract cannot be used on a different Node', "INSERT INTO allocations(id,purpose,machine_id,node_id,runtime_identity_id,resolved_provision_contract_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms) VALUES ('wrong-resolution','infrastructure','m2','n2','rt-docker','contract-v1','container-art',1,'present','{}',1);", /FOREIGN KEY constraint/);
  run(`INSERT INTO operations(id,installation_id,controller_epoch,kind,step_key,dedup_key,request_hash,intent_json,next_check_at_ms,created_at_ms,updated_at_ms)
 VALUES ('revoke-profile-op','installation-1',1,'revoke_profile_grants','revoke-profile-1','revoke-profile-1',printf('%064d',0),'{}',10,1,1);
INSERT INTO profile_grant_revocations(id,storage_profile_revision_id,reason,created_by_consumer_id,operation_id,created_at_ms)
 VALUES ('revocation-1','storage-v1','revoke old data root','c1','revoke-profile-op',10);`);
  equal('Revocation overlay blocks old revision without rewriting frozen grant', `
SELECT count(*) FROM storage_profile_revisions p WHERE p.id='storage-v1'
 AND NOT EXISTS (SELECT 1 FROM profile_grant_revocations r WHERE r.storage_profile_revision_id=p.id);
SELECT storage_profile_revision_id FROM ticket_storage_grants WHERE id='grant-1';`, '0\nstorage-v1');
  rejected('A profile revocation targets exactly one revision kind', "INSERT INTO profile_grant_revocations(id,storage_profile_revision_id,network_profile_revision_id,reason,created_by_consumer_id,operation_id,created_at_ms) VALUES ('revocation-bad','storage-v2','net-v1','bad double target','c1','backup1',10);", /CHECK constraint/);
  rejected('Revocation history cannot be silently undone', "DELETE FROM profile_grant_revocations WHERE id='revocation-1';", /revocation is immutable/);
  equal('Network enforcement objects participate in the owned cleanup manifest', `INSERT INTO managed_resources(id,allocation_id,node_id,generation,kind,provider_id,ownership,ownership_json,cleanup_policy,observed_state,details_json)
 VALUES ('network-rule-1','a2','child-node',1,'network_policy','rule-1','owned','{}','destroy','present','{"enforcer":"runtime_agent","revision":"net-v1","frozenPlatformDenyRevisionId":"deny-v1","appliedPlatformDenyRevisionId":"deny-v1"}');
SELECT kind||'|'||ownership||'|'||cleanup_policy FROM managed_resources WHERE id='network-rule-1';`, 'network_policy|owned|destroy');
  rejected('Platform management deny baseline revision is immutable', "UPDATE platform_network_deny_revisions SET management_deny_rules_json='[]' WHERE id='deny-v1';", /deny revision is immutable/);
  equal('Current deny baseline can advance while accepted contract remains frozen', `
INSERT INTO platform_network_deny_revisions(id,revision,management_deny_rules_json,reason,created_by_consumer_id,created_at_ms)
 VALUES ('deny-v2',2,'[{"cidr":"192.0.2.0/24","protocol":"any","ports":"any"},{"cidr":"198.51.100.10/32","protocol":"tcp","ports":[443,9443]}]','new management address','c1',10);
UPDATE installations SET current_network_deny_revision_id='deny-v2' WHERE singleton=1;
-- Synthetic evidence only: real RuntimeAgent must verify rule application.
UPDATE managed_resources SET details_json=json_set(details_json,'$.appliedPlatformDenyRevisionId','deny-v2') WHERE id='network-rule-1';
SELECT r.platform_deny_revision_id||'|'||i.current_network_deny_revision_id||'|'||json_extract(m.details_json,'$.appliedPlatformDenyRevisionId')
 FROM resolved_provision_contracts r,installations i,managed_resources m WHERE r.id='contract-v1' AND i.singleton=1 AND m.id='network-rule-1';
UPDATE managed_resources SET observed_state='absent' WHERE id='network-rule-1';`, 'deny-v1|deny-v2|deny-v2');
  equal('Stored NAS management deny rule scopes TCP management ports without a whole-host deny', `
SELECT json_extract(r.value,'$.protocol')||'|'||json_extract(r.value,'$.ports[0]')||'|'||json_extract(r.value,'$.ports[1]')
 FROM platform_network_deny_revisions d,json_each(d.management_deny_rules_json) r
 WHERE d.id='deny-v2' AND json_extract(r.value,'$.cidr')='198.51.100.10/32';
SELECT count(*) FROM platform_network_deny_revisions d,json_each(d.management_deny_rules_json) r,json_each(r.value,'$.ports') p
 WHERE d.id='deny-v2' AND json_extract(r.value,'$.cidr')='198.51.100.10/32' AND p.value=445;`, 'tcp|443|9443\n0');

  equal('Lease CAS rejects stale version', `BEGIN IMMEDIATE;
UPDATE leases SET version=version+1,expires_at_ms=6000,claimed_at_ms=500 WHERE id='l1' AND version=1 AND state='active' AND expires_at_ms>500 AND (claimed_at_ms IS NOT NULL OR claim_by_ms>500);
SELECT changes();
UPDATE leases SET version=version+1,expires_at_ms=7000 WHERE id='l1' AND version=1 AND state='active' AND expires_at_ms>500 AND (claimed_at_ms IS NOT NULL OR claim_by_ms>500);
SELECT changes(); COMMIT;`, '1\n0');

  equal('Identity, observation version and control intent remain independent', `BEGIN IMMEDIATE;
UPDATE allocations SET version=version+1,observed_state='running' WHERE id='a1';
UPDATE allocations SET version=version+1,control_version=control_version+1,desired_state='absent' WHERE id='a1' AND control_version=1;
UPDATE allocations SET desired_state='present',version=version+1 WHERE id='a1' AND generation=1 AND control_version=1;
SELECT changes();
SELECT generation||'|'||version||'|'||control_version FROM allocations WHERE id='a1'; COMMIT;`, '0\n1|3|2');

  equal('Root and child usage are not double-counted', `SELECT
(SELECT SUM(cpu_millis) FROM capacity_claims WHERE pool_id='p1' AND state<>'released') || '|' ||
(SELECT SUM(cpu_millis) FROM capacity_claims WHERE pool_id='child-pool' AND state<>'released');`, '9000|1000');

  // This is an example serialized capacity transaction, not the Scheduler implementation.
  const guardedClaim = (id, allocation) => `
INSERT INTO capacity_claims(id,allocation_id,pool_id,state,cpu_millis,memory_mib,scratch_mib,created_at_ms)
SELECT '${id}','${allocation}','p1','reserved',2500,512,1024,1 FROM capacity_pools p WHERE p.id='p1'
AND COALESCE((SELECT SUM(cpu_millis) FROM capacity_claims WHERE pool_id=p.id AND state<>'released'),0)+2500<=p.total_cpu_millis-p.system_cpu_millis
AND COALESCE((SELECT SUM(memory_mib) FROM capacity_claims WHERE pool_id=p.id AND state<>'released'),0)+512<=p.total_memory_mib-p.system_memory_mib
AND COALESCE((SELECT SUM(scratch_mib) FROM capacity_claims WHERE pool_id=p.id AND state<>'released'),0)+1024<=p.total_scratch_mib-p.system_scratch_mib;
SELECT changes();`;
  equal('Serialized reservation guard accepts first fitting request and rejects second',
    `BEGIN IMMEDIATE; ${guardedClaim('guarded3', 'a3')} ${guardedClaim('guarded4', 'a4')} COMMIT;`, '1\n0');

  equal('Unknown external result does not release Claim', "SELECT state FROM operations WHERE id='op1'; SELECT state FROM capacity_claims WHERE id='claim1';", 'unknown\nreserved');

  // Supply synthetic cleanup evidence to test the ledger only. No actual VM stops.
  equal('Base stop releases runtime budget while retaining disk accounting', `BEGIN IMMEDIATE;
UPDATE capacity_claims SET state='released',released_at_ms=200,release_evidence_ref='fixture-child-cleanup',version=version+1 WHERE id='claim2';
UPDATE allocations SET desired_state='absent',observed_state='absent',cleanup_status='complete',version=version+1 WHERE id='a2';
UPDATE allocations SET desired_state='stopped',observed_state='stopped',control_version=control_version+1,version=version+1 WHERE id='base';
UPDATE capacity_claims SET state='released',released_at_ms=201,release_evidence_ref='fixture-base-stopped',version=version+1 WHERE id='base-runtime';
SELECT SUM(cpu_millis)||'|'||SUM(scratch_mib) FROM capacity_claims WHERE pool_id='p1' AND state<>'released';
SELECT state FROM capacity_claims WHERE id='base-storage'; COMMIT;`, '3500|22528\ncommitted');

  equal('A later base start can add one new runtime Claim without deleting history', `
INSERT INTO capacity_claims(id,allocation_id,pool_id,component,state,cpu_millis,memory_mib,scratch_mib,created_at_ms)
 VALUES ('base-runtime-2','base','p1','runtime','reserved',8000,24576,0,300);
SELECT count(*) FROM capacity_claims WHERE allocation_id='base' AND component='runtime';`, '2');

  equal('Platform reserve is deducted once before serialized reservation', `BEGIN IMMEDIATE;
UPDATE capacity_pools SET total_cpu_millis=15000,system_cpu_millis=1000 WHERE id='p1';
${guardedClaim('reserve-once-1', 'a4')}
${guardedClaim('reserve-once-2', 'a3')}
ROLLBACK;`, '1\n0');

  rejected('Final renewal decision cannot be rewritten',
    "UPDATE lease_renewals SET confirmed_receipt_json='{}' WHERE id='renewal-1';", /final renewal decision is immutable/);
  rejected('Cancelled renewal must include a reason code', `
INSERT INTO lease_renewals(id,lease_id,operation_id,expected_version,proposed_version,proposed_expires_at_ms,is_initial_claim,decision_deadline_ms,state,rejection_json,created_at_ms,updated_at_ms)
 VALUES ('reasonless-renewal','l2','renew-op-2',2,3,7000,0,2000,'cancelled','{}',1500,1500);`, /CHECK constraint/);

  rejected('Referenced resolved contract cannot be purged',
    "DELETE FROM resolved_provision_contracts WHERE id='contract-v1';", /referenced provision contract cannot be purged/);
  rejected('Active ticket storage grant cannot be purged',
    "DELETE FROM ticket_storage_grants WHERE id='grant-1';", /active storage grant cannot be purged/);
  rejected('Accepted request and resource budget cannot be rewritten',
    "UPDATE tickets SET requested_cpu_millis=2000 WHERE id='t1';", /accepted ticket request is immutable/);
  rejected('Frozen allocation contract cannot be cleared',
    "UPDATE allocations SET resolved_provision_contract_id=NULL WHERE id='a1';", /resolved provision binding is write-once/);

  equal('Reservation can bind a resolved contract once after wake and inspection', `BEGIN IMMEDIATE;
INSERT INTO tickets(id,consumer_id,image_version_id,network_profile_revision_id,phase,cleanup_status,request_json,request_hash,accepted_contract_json,requested_cpu_millis,requested_memory_mib,requested_scratch_mib,created_at_ms,queue_deadline_ms)
 VALUES ('late-bind-ticket','c1','iv','net-v1','reserved','pending','{}',printf('%064d',0),'{}',1000,512,1024,1,10000);
INSERT INTO allocations(id,purpose,ticket_id,machine_id,node_id,runtime_identity_id,image_artifact_id,generation,desired_state,ownership_json,created_at_ms)
 VALUES ('late-bind-allocation','tenant','late-bind-ticket','m2','n2','rt-docker','container-art',1,'present','{}',1);
SELECT resolved_provision_contract_id IS NULL FROM allocations WHERE id='late-bind-allocation';
UPDATE allocations SET resolved_provision_contract_id='contract-docker',version=version+1
 WHERE id='late-bind-allocation' AND version=1 AND resolved_provision_contract_id IS NULL;
SELECT changes(); ROLLBACK;`, '1\n1');

  equal('Retention can delete unreferenced contract and released-ticket grant', `BEGIN IMMEDIATE;
INSERT INTO resolved_provision_contracts(id,node_id,selection_hash,resolved_at_ms,network_profile_revision_id,platform_deny_revision_id,contract_hash,storage_bindings_json,network_binding_json)
 VALUES ('gc-contract','n2',printf('%064d',0),1,'net-v1','deny-v1',printf('%064d',0),'[]','{}');
DELETE FROM resolved_provision_contracts WHERE id='gc-contract'; SELECT changes();
INSERT INTO tickets(id,consumer_id,image_version_id,network_profile_revision_id,phase,terminal_reason,cleanup_status,request_json,request_hash,accepted_contract_json,requested_cpu_millis,requested_memory_mib,requested_scratch_mib,created_at_ms,queue_deadline_ms,released_at_ms)
 VALUES ('gc-ticket','c1','iv','net-v1','released','consumer_cancel','not_needed','{}',printf('%064d',0),'{}',1000,512,1024,1,10000,100);
INSERT INTO ticket_storage_grants(id,ticket_id,storage_profile_revision_id,authorized_subpath,mount_path,mode,created_at_ms)
 VALUES ('gc-grant','gc-ticket','storage-v1','old','/data','read_only',1);
DELETE FROM ticket_storage_grants WHERE id='gc-grant'; SELECT changes();
DELETE FROM tickets WHERE id='gc-ticket'; SELECT changes(); ROLLBACK;`, '1\n1\n1');

  rejected('Runtime Agent cannot submit a physical machine snapshot', `
INSERT INTO agents(id,machine_id,node_id,kind,credential_hash) VALUES ('runtime-snapshot-agent','m2','n2','runtime','fixture');
INSERT INTO machine_snapshots(machine_id,agent_id,agent_boot_id,sequence,observed_at_ms,received_at_ms,sessions_json,workloads_json,resources_json,probe_status)
 VALUES ('m2','runtime-snapshot-agent','boot-runtime',1,1,1,'{}','{}','{}','complete');`, /physical snapshot requires host agent/);

  equal('All foreign keys valid', 'PRAGMA foreign_key_check;', '');
  equal('SQLite integrity check', 'PRAGMA integrity_check;', 'ok');
  log(`Tables: ${run("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';")}`);
  log(`Passed checks: ${passed}`);
  log('Scope: schema constraints and illustrative serialized SQL only; no concurrent workers, real backends, API state machine, offline lease enforcement or power actions tested.');
} catch (error) {
  log(`FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  log(`Report: ${reportFile}`);
  fs.writeFileSync(reportFile, `${report.join('\n')}\n`);
}
