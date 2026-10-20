import React from "react";
import { type HitchletClient } from "@hitchlet/sdk";

type Admin = HitchletClient["admin"];
type Configuration = Awaited<ReturnType<Admin["powerConfiguration"]>>;
type Preview = Awaited<ReturnType<Admin["powerPreview"]>>;
type PolicyPreview = Awaited<ReturnType<Admin["previewPowerPolicy"]>>;
type Event = Parameters<Admin["advancePowerPreview"]>[2]["event"];
const message = (e: unknown) =>
  e instanceof Error ? e.message : "电源预演请求失败";

/** Explicit sandbox labels and synthetic inputs keep power previews distinct from actual Host facts. */
export function PowerPanel({
  client,
  machineId,
  machineVersion,
  canWrite,
  connected,
}: {
  client: HitchletClient;
  machineId: string;
  machineVersion: number;
  canWrite: boolean;
  connected: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [configuration, setConfiguration] =
    React.useState<Configuration | null>(null);
  const [capabilityDraft, setCapabilityDraft] = React.useState<
    Parameters<Admin["updatePowerCapabilities"]>[1]["conclusions"] | null
  >(null);
  const [draft, setDraft] = React.useState<Configuration["policy"] | null>(
    null,
  );
  const [policyPreview, setPolicyPreview] =
    React.useState<PolicyPreview | null>(null);
  const [previews, setPreviews] = React.useState<Preview[]>([]);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [risk, setRisk] = React.useState("");
  const [plug, setPlug] = React.useState({
    deviceId: "",
    macAddress: "",
    endpointRef: "",
    credentialVersionRef: "",
  });
  const [plugDirty, setPlugDirty] = React.useState(false);
  const active = React.useRef(true),
    generation = React.useRef(0),
    running = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current++;
    };
  }, []);
  React.useEffect(() => {
    generation.current++;
    setPolicyPreview(null);
  }, [canWrite, connected, machineVersion]);
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      if (active.current) setError(message(e));
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function refresh(reset = false) {
    const epoch = generation.current;
    const [c, ps] = await Promise.all([
      client.admin.powerConfiguration(machineId),
      client.admin.powerPreviews(machineId),
    ]);
    if (!active.current || epoch !== generation.current) return;
    setConfiguration(c);
    setPreviews(ps);
    if (reset || !draft) setDraft(c.policy);
    if (reset || !capabilityDraft)
      setCapabilityDraft({
        sleep:
          c.capabilities.sleep === "unsupported" ? "unsupported" : "unverified",
        normalShutdown:
          c.capabilities.normalShutdown === "unsupported"
            ? "unsupported"
            : "unverified",
        wakeFromSleep:
          c.capabilities.wakeFromSleep === "unsupported"
            ? "unsupported"
            : "unverified",
        coldBoot:
          c.capabilities.coldBoot === "unsupported"
            ? "unsupported"
            : "unverified",
        wolWhilePossiblyOn:
          c.capabilities.wolWhilePossiblyOn === "unsupported"
            ? "unsupported"
            : "unverified",
        wakeRouteRef: c.capabilities.wakeRouteRef,
      });
    if (reset || !plugDirty)
      setPlug({
        deviceId: c.binding?.device.deviceId ?? "",
        macAddress: c.binding?.device.macAddress ?? "",
        endpointRef: c.binding?.endpointRef ?? "",
        credentialVersionRef: c.binding?.credentialVersionRef ?? "",
      });
    if (configuration && configuration.version !== c.version)
      setPolicyPreview(null);
  }
  const current = previews.find(
    (p) =>
      !["complete", "cancelled", "manual"].includes(p.phase) ||
      p.restoreRequired,
  );
  // Continuous idle sampling is opt-in by opening this panel; closing it stops sampling safely.
  React.useEffect(() => {
    if (
      !open ||
      !connected ||
      !canWrite ||
      !current ||
      ![
        "idle",
        "draining",
        "off_wait",
        "shutdown_requested",
        "waking",
        "verifying",
      ].includes(current.phase)
    )
      return;
    const timer = setInterval(() => {
      void run(async () => {
        await client.admin.advancePowerPreview(
          machineId,
          current.id,
          { expectedVersion: current.version, event: { kind: "evaluate" } },
          crypto.randomUUID(),
        );
        await refresh();
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [
    open,
    connected,
    canWrite,
    current?.id,
    current?.version,
    current?.phase,
  ]);
  const disabled = !canWrite || !connected || busy;
  async function advance(event: Event) {
    if (!current) return;
    await client.admin.advancePowerPreview(
      machineId,
      current.id,
      { expectedVersion: current.version, event },
      crypto.randomUUID(),
    );
    await refresh();
  }
  return (
    <details
      open={open}
      onToggle={(e) => {
        const expanded = e.currentTarget.open;
        setOpen(expanded);
        if (expanded && !configuration) void run(() => refresh(true));
      }}
    >
      <summary>电源策略与隔离预演</summary>
      <p>
        当前仅 D22a
        沙盘。所有状态、受理、断电读回和恢复供电义务均为虚拟；不会关机、发送 WOL
        或操作插座，也不会阻止真实 Ticket。实际逐机能力待 D22b 验收。
      </p>
      <p>
        面板打开时每 5 秒推进预演；关闭后停止空闲采样，超过 30
        秒中断会重置连续空闲。后台每 5
        秒检查到期的虚拟恢复责任；重启仍沿原断电等待期限继续。
      </p>
      {!connected ? (
        <p role="alert">连接中断；以下为历史预演，编辑和推进已禁用。</p>
      ) : null}
      <button
        disabled={busy || !connected}
        onClick={() => void run(() => refresh())}
      >
        刷新电源预演
      </button>
      {configuration && draft ? (
        <>
          <p>
            策略版本 {configuration.version} · 真实 Machine epoch{" "}
            {configuration.machineEpoch} · 实际执行禁用
          </p>
          {configuration.executionDisabledReasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
          <details>
            <summary>当前关机阻塞证据</summary>
            {configuration.shutdownDisabledReasons.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </details>
          <fieldset disabled={disabled}>
            <legend>电源策略（始终 dry-run）</legend>
            <label>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => {
                  setDraft({ ...draft, enabled: e.target.checked });
                  setPolicyPreview(null);
                }}
              />
              启用策略预演
            </label>
            <label>
              连续空闲秒数
              <input
                type="number"
                min={1}
                max={604800}
                value={draft.idleSeconds}
                onChange={(e) => {
                  setDraft({ ...draft, idleSeconds: Number(e.target.value) });
                  setPolicyPreview(null);
                }}
              />
            </label>
            <label>
              空闲动作
              <select
                value={draft.idleAction}
                onChange={(e) => {
                  setDraft({
                    ...draft,
                    idleAction: e.target
                      .value as Configuration["policy"]["idleAction"],
                  });
                  setPolicyPreview(null);
                }}
              >
                <option value="none">不动作</option>
                <option value="shutdown">正常关机预演</option>
                <option value="sleep" disabled>
                  睡眠预演（后置，不能按冷启动处理）
                </option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.wakeOnDemand}
                onChange={(e) => {
                  setDraft({ ...draft, wakeOnDemand: e.target.checked });
                  setPolicyPreview(null);
                }}
              />
              按需唤醒预演（真实能力仍禁用）
            </label>
            <label>
              故障恢复
              <select
                value={draft.faultRecovery.mode}
                onChange={(e) => {
                  if (
                    e.target.value === "smart_plug_cycle" &&
                    configuration.binding
                  )
                    setDraft({
                      ...draft,
                      faultRecovery: {
                        mode: "smart_plug_cycle",
                        plugBindingId: configuration.binding.id,
                        authorization: "operator",
                        minimumOffSeconds: 600,
                        maximumCyclesPerIncident: 1,
                      },
                    });
                  else
                    setDraft({ ...draft, faultRecovery: { mode: "disabled" } });
                  setPolicyPreview(null);
                }}
              >
                <option value="disabled">禁用</option>
                <option
                  value="smart_plug_cycle"
                  disabled={!configuration.binding}
                >
                  独立插座故障恢复沙盘（600秒）
                </option>
              </select>
            </label>
            <button
              onClick={() =>
                void run(async () => {
                  const epoch = generation.current;
                  const p = await client.admin.previewPowerPolicy(machineId, {
                    expectedVersion: configuration.version,
                    policy: draft,
                  });
                  if (active.current && epoch === generation.current)
                    setPolicyPreview(p);
                })
              }
            >
              预演电源策略
            </button>
            <button
              disabled={!policyPreview}
              onClick={() =>
                void run(async () => {
                  if (!policyPreview) return;
                  await client.admin.updatePowerPolicy(
                    machineId,
                    {
                      expectedVersion: policyPreview.configuration.version,
                      policy: policyPreview.configuration.policy,
                    },
                    crypto.randomUUID(),
                  );
                  setPolicyPreview(null);
                  await refresh(true);
                })
              }
            >
              保存电源策略
            </button>
            {policyPreview ? (
              <p>
                策略预演完成；仍不可执行真实电源动作。保存时重新复核当前账本。
              </p>
            ) : null}
          </fieldset>
          {capabilityDraft ? (
            <details>
              <summary>能力结论（不能登记 verified）</summary>
              <p>
                以下仅为配置结论，不是实机验收证据。D22a 不接受任何 verified
                写入。
              </p>
              <fieldset disabled={disabled}>
                {(
                  [
                    "sleep",
                    "normalShutdown",
                    "wakeFromSleep",
                    "coldBoot",
                    "wolWhilePossiblyOn",
                  ] as const
                ).map((k) => (
                  <label key={k}>
                    {k}
                    <select
                      aria-label={`能力 ${k}`}
                      value={capabilityDraft[k]}
                      onChange={(e) =>
                        setCapabilityDraft({
                          ...capabilityDraft,
                          [k]: e.target.value as "unverified" | "unsupported",
                        })
                      }
                    >
                      <option value="unverified">未验证</option>
                      <option value="unsupported">不支持</option>
                    </select>
                  </label>
                ))}
                <button
                  onClick={() =>
                    void run(async () => {
                      await client.admin.updatePowerCapabilities(
                        machineId,
                        {
                          expectedMachineVersion: configuration.machineVersion,
                          conclusions: capabilityDraft,
                        },
                        crypto.randomUUID(),
                      );
                      await refresh(true);
                      setPolicyPreview(null);
                    })
                  }
                >
                  保存能力结论
                </button>
              </fieldset>
            </details>
          ) : null}
          <details>
            <summary>独立插座绑定（仅固定引用，无 token 输入）</summary>
            <p>
              设备ID、MAC与绑定ID全局唯一。更改绑定时禁止存在未完成电源预演。供电对象必须是本机；独占接线与通电自启仍待实测。
            </p>
            <pre>
              {configuration.binding
                ? JSON.stringify(configuration.binding, null, 2)
                : "未绑定"}
            </pre>
            <fieldset disabled={disabled || !!current}>
              {(
                [
                  ["deviceId", "精确设备 ID"],
                  ["macAddress", "MAC 地址"],
                  ["endpointRef", "管理端点引用"],
                  ["credentialVersionRef", "固定秘密版本引用"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    aria-label={label}
                    value={plug[key]}
                    placeholder={
                      key === "endpointRef"
                        ? "endpoint:plug-a"
                        : key === "credentialVersionRef"
                          ? "secret:32位固定版本"
                          : ""
                    }
                    onChange={(e) => {
                      setPlug({ ...plug, [key]: e.target.value });
                      setPlugDirty(true);
                    }}
                  />
                </label>
              ))}
              <button
                disabled={Object.values(plug).some((v) => !v.trim())}
                onClick={() =>
                  void run(async () => {
                    await client.admin.updateSmartPlugBinding(
                      machineId,
                      {
                        expectedMachineVersion: configuration.machineVersion,
                        binding: {
                          id: configuration.binding?.id ?? crypto.randomUUID(),
                          machineId,
                          adapter: "xiaomi_miio_lan",
                          device: {
                            model: "cuco.plug.v3",
                            deviceId: plug.deviceId.trim(),
                            macAddress: plug.macAddress.trim(),
                          },
                          endpointRef: plug.endpointRef.trim(),
                          credentialVersionRef:
                            plug.credentialVersionRef.trim(),
                          dedicatedSupply: "unverified",
                          acPowerOn: "unverified",
                          verificationReportIds: [],
                        },
                      },
                      crypto.randomUUID(),
                    );
                    setPlugDirty(false);
                    await refresh(true);
                    setPolicyPreview(null);
                  })
                }
              >
                保存独立插座绑定
              </button>
              <button
                disabled={!configuration.binding}
                onClick={() =>
                  void run(async () => {
                    await client.admin.updateSmartPlugBinding(
                      machineId,
                      {
                        expectedMachineVersion: configuration.machineVersion,
                        binding: null,
                      },
                      crypto.randomUUID(),
                    );
                    setPlugDirty(false);
                    await refresh(true);
                    setPolicyPreview(null);
                  })
                }
              >
                清除插座绑定
              </button>
            </fieldset>
          </details>
          <fieldset disabled={disabled}>
            <legend>持久沙盘周期</legend>
            <button
              disabled={!!current}
              onClick={() =>
                void run(async () => {
                  await client.admin.startPowerPreview(
                    machineId,
                    {
                      expectedPolicyVersion: configuration.version,
                      mode: "idle_shutdown",
                    },
                    crypto.randomUUID(),
                  );
                  await refresh();
                })
              }
            >
              开始连续空闲预演
            </button>
            <label>
              失联风险确认（仅用于虚拟恢复）
              <input value={risk} onChange={(e) => setRisk(e.target.value)} />
            </label>
            <button
              disabled={
                !!current ||
                configuration.policy.faultRecovery.mode !==
                  "smart_plug_cycle" ||
                risk.length < 12
              }
              onClick={() =>
                void run(async () => {
                  await client.admin.startPowerPreview(
                    machineId,
                    {
                      expectedPolicyVersion: configuration.version,
                      mode: "fault_recovery",
                      incidentId: crypto.randomUUID(),
                      riskAcknowledgement: risk,
                    },
                    crypto.randomUUID(),
                  );
                  await refresh();
                })
              }
            >
              开始插座故障恢复预演
            </button>
            {current ? (
              <>
                <p>
                  虚拟阶段 {current.phase} · 预演版本 {current.version} · 虚拟
                  epoch {current.virtualEpoch}（真实机器不变）
                </p>
                <p>
                  虚拟 observedPower {current.observedPower} · 恢复供电责任{" "}
                  {String(current.restoreRequired)} · 最早恢复{" "}
                  {current.restoreNotBeforeMs === null
                    ? "未建立"
                    : new Date(current.restoreNotBeforeMs).toLocaleString()}
                </p>
                {current.reasons.map((r) => (
                  <p key={r}>{r}</p>
                ))}
                <button
                  onClick={() => void run(() => advance({ kind: "evaluate" }))}
                >
                  重新复核 / 推进时间
                </button>
                {current.phase === "draining" ? (
                  <button
                    onClick={() =>
                      void run(() =>
                        advance({
                          kind: "accept_shutdown",
                          simulatedLocalCheck: "complete_absent_clear",
                        }),
                      )
                    }
                  >
                    模拟本地最终复核及正常关机受理
                  </button>
                ) : null}
                {current.binding &&
                [
                  "inspect",
                  "off_pending",
                  "inspect_off",
                  "off_wait",
                  "on_pending",
                ].includes(current.phase) ? (
                  <>
                    {(["on", "off", "unknown"] as const).map((state) => (
                      <button
                        key={state}
                        onClick={() =>
                          void run(() =>
                            advance({
                              kind: "plug_readback",
                              deviceId: current.binding!.device.deviceId,
                              macAddress: current.binding!.device.macAddress,
                              state,
                            }),
                          )
                        }
                      >
                        模拟精确插座读回 {state}
                      </button>
                    ))}
                    {current.phase === "off_pending" ? (
                      <button
                        onClick={() =>
                          void run(() =>
                            advance({ kind: "off_result_unknown" }),
                          )
                        }
                      >
                        模拟 off 回执丢失
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  onClick={() => void run(() => advance({ kind: "cancel" }))}
                >
                  {current.restoreRequired
                    ? "模拟原请求取消（保留恢复供电责任）"
                    : "取消虚拟周期"}
                </button>
              </>
            ) : null}
          </fieldset>
          <details>
            <summary>持久预演历史</summary>
            {previews.map((p) => (
              <p key={p.id}>
                {p.id} · {p.mode} · 虚拟 {p.phase} · restoreRequired=
                {String(p.restoreRequired)}
              </p>
            ))}
          </details>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
