import React from "react";
import type {
  ProfileGrantRevokeRequest,
  RevocationImpact,
} from "@hitchlet/sdk";
import {
  managementError,
  useManagementRead,
  type ManagementUI,
} from "./ManagementUI.js";

/** Emergency revocation names a historical immutable revision and requires a reviewed CAS request. */
export function ProfileRevocation({
  client,
  disabled,
  action,
  kind,
  profile,
  onRevoked,
}: Pick<ManagementUI, "client" | "disabled" | "action"> & {
  kind: "network" | "storage";
  profile: { id: string; version: number };
  onRevoked: () => void;
}) {
  const load = React.useCallback(
    () => client.admin.profileRevisions(kind, profile.id),
    [client, kind, profile.id],
  );
  const history = useManagementRead(load);
  const [revision, setRevision] = React.useState(""),
    [reason, setReason] = React.useState(""),
    [preview, setPreview] = React.useState<{
      request: ProfileGrantRevokeRequest;
      impact: RevocationImpact;
    } | null>(null),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  React.useEffect(() => setPreview(null), [revision, reason, profile.version]);
  const current = history.data?.find((r) => r.id === revision);
  return (
    <section aria-label="紧急吊销固定修订">
      <h4>紧急吊销固定修订</h4>
      <p>
        永久吊销会终止引用该修订的 Ticket 和内部验证，清理查实前保留容量。NAS
        源文件与共享输出不会删除。底座依赖回收暂不支持，发现时阻止执行。
      </p>
      <label>
        吊销修订
        <select
          disabled={disabled || busy}
          value={revision}
          onChange={(e) => setRevision(e.target.value)}
        >
          <option value="">选择既有修订</option>
          {history.data?.map((r) => (
            <option key={r.id} value={r.id} disabled={r.revokedAt !== null}>
              revision {r.revision} · {r.id}
              {r.isCurrent ? " · 当前" : " · 历史"}
              {r.revokedAt ? " · 已吊销" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        吊销原因
        <input
          disabled={disabled || busy}
          value={reason}
          maxLength={1000}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error || history.error ? (
        <p role="alert">{error || history.error}</p>
      ) : null}
      <button
        type="button"
        disabled={
          disabled ||
          busy ||
          !!history.error ||
          !current ||
          !!current.revokedAt ||
          !reason.trim()
        }
        onClick={() => {
          setBusy(true);
          setError("");
          setPreview(null);
          const request: ProfileGrantRevokeRequest = {
            profileKind: kind,
            profileRevisionId: revision,
            reason: reason.trim(),
            expectedProfileVersion: profile.version,
          };
          void client.admin
            .previewGrantRevocation(request)
            .then((impact) => setPreview({ request, impact }))
            .catch((e) => setError(managementError(e)))
            .finally(() => setBusy(false));
        }}
      >
        预览吊销影响（不写入）
      </button>
      {preview ? (
        <>
          <p>
            按逻辑 Profile v{preview.request.expectedProfileVersion}，修订{" "}
            {preview.request.profileRevisionId}，原因「{preview.request.reason}
            」：Ticket {preview.impact.affectedTicketIds.length}，验证{" "}
            {preview.impact.affectedValidationIds.length}，底座{" "}
            {preview.impact.affectedInfrastructureAllocationIds.length}
            。执行时事务重新枚举；并发变化需要重新预览。
          </p>
          <ul>
            {[
              ...preview.impact.affectedTicketIds,
              ...preview.impact.affectedValidationIds,
              ...preview.impact.affectedInfrastructureAllocationIds,
            ].map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
          {!preview.impact.canRevoke ? (
            <p role="alert">{preview.impact.disabledReasons.join("；")}</p>
          ) : null}
          <button
            type="button"
            disabled={
              disabled ||
              busy ||
              !!history.error ||
              !preview.impact.canRevoke ||
              preview.request.profileRevisionId !== revision ||
              preview.request.reason !== reason.trim() ||
              preview.request.expectedProfileVersion !== profile.version
            }
            onClick={() => {
              setBusy(true);
              void action(
                `永久吊销 ${preview.request.profileRevisionId}`,
                (key) => client.admin.revokeGrants(preview.request, key),
              )
                .then((ok) => {
                  if (ok) {
                    setPreview(null);
                    void history.refresh();
                    onRevoked();
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            确认永久吊销此修订并终止引用
          </button>
        </>
      ) : null}
    </section>
  );
}
