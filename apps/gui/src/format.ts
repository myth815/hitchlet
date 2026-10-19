export function phaseLabel(phase: string) {
  return (
    (
      {
        queued: "排队中",
        reserved: "已预留",
        provisioning: "准备环境",
        ready: "可接用",
        releasing: "回收中",
        released: "已释放",
      } as Record<string, string>
    )[phase] ?? phase
  );
}

export function cleanupLabel(status: string) {
  return (
    (
      {
        not_needed: "无需清理",
        pending: "等待清理",
        running: "清理中",
        blocked: "清理受阻，仍占用资源",
        complete: "清理完成",
      } as Record<string, string>
    )[status] ?? status
  );
}

export function reasonLabel(code: string) {
  return (
    (
      {
        no_matching_node: "没有匹配的节点",
        insufficient_capacity: "可用资源不足",
        image_unavailable: "镜像暂不可用",
        network_profile_unavailable: "网络配置不可用",
        scratch_limit_unverified: "临时盘硬限制未验证",
        provider_unavailable: "执行后端不可用",
        cleanup_blocked: "存在尚未回收的资源",
        inspection_unknown: "资源状态尚未查实",
      } as Record<string, string>
    )[code] ?? code
  );
}

export function terminalLabel(reason: string | null) {
  if (!reason) return "无";
  return (
    (
      {
        consumer_release: "用户确认归还",
        consumer_cancel: "用户取消",
        queue_timeout: "排队超时",
        provision_timeout: "环境准备超时",
        provision_failed: "环境准备失败",
        unclaimed_timeout: "未按时接用",
        lease_expired: "租约到期",
        max_lifetime: "达到总寿命上限",
        resource_lost: "资源丢失",
        admin_revoke: "管理员撤销",
      } as Record<string, string>
    )[reason] ?? reason
  );
}

export function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}
