import React from "react";
import { HitchletClient } from "@hitchlet/sdk";
export function StatusPage({
  client: providedClient,
}: {
  client?: HitchletClient;
}) {
  const [client] = React.useState(
    () => providedClient ?? new HitchletClient(window.location.origin),
  );
  const [state, setState] = React.useState<{
    loading: boolean;
    health?: string;
    error?: string;
  }>({ loading: true });
  React.useEffect(() => {
    let alive = true;
    void client
      .health()
      .then((health) => {
        if (alive)
          setState({
            loading: false,
            health: `${health.status} · ${health.stage}`,
          });
      })
      .catch((error: unknown) => {
        if (alive)
          setState({
            loading: false,
            error: error instanceof Error ? error.message : "API 请求失败",
          });
      });
    return () => {
      alive = false;
    };
  }, [client]);
  return (
    <main>
      <div className="eyebrow">HITCHLET · DEVELOPMENT STATUS</div>
      <h1>计算资源，凭票上车</h1>
      <p className="intro">独立的临时计算资源管理系统</p>
      <section>
        <h2>控制服务</h2>
        <p>
          {state.loading
            ? "正在读取健康状态…"
            : state.error
              ? `连接失败：${state.error}`
              : `健康：${state.health}`}
        </p>
        <p>当前阶段：D00 基础工程</p>
      </section>
      <section className="notice">
        <h2>Simulator 尚未实现</h2>
        <p>当前版本只验证控制服务连通性；尚不能申请、分配或回收计算环境。</p>
      </section>
      <footer>Hitchlet · 设计基线 v1.3</footer>
    </main>
  );
}
