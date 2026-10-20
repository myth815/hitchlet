import React from "react";
import type { HitchletClient } from "@hitchlet/sdk";

/** SDK-only event transport. Snapshot polling remains a bounded compensation path after disconnect/retention gaps. */
export function EventUpdates({
  client,
  onRefresh,
}: {
  client: HitchletClient;
  onRefresh: () => void;
}) {
  const [connected, setConnected] = React.useState(false),
    [at, setAt] = React.useState<number | null>(null);
  const refresh = React.useRef(onRefresh);
  refresh.current = onRefresh;
  React.useEffect(() => {
    let active = true,
      cursor = "0",
      controller: AbortController | undefined,
      timer: number | undefined,
      refreshTimer: number | undefined,
      attempts = 0;
    const start = async () => {
      controller = new AbortController();
      try {
        await client.watchEvents(
          cursor,
          controller.signal,
          (event) => {
            cursor = event.id;
            setAt(Date.now());
            if (refreshTimer === undefined)
              refreshTimer = window.setTimeout(() => {
                refreshTimer = undefined;
                if (active) refresh.current();
              }, 250);
          },
          () => {
            if (active) {
              attempts = 0;
              setConnected(true);
              setAt(Date.now());
              refresh.current();
            }
          },
        );
      } catch {
        /* Snapshot polling carries availability; no user command is retried here. */
      } finally {
        if (active) {
          setConnected(false);
          if (++attempts === 3) {
            cursor = "0";
            refresh.current();
          }
          timer = window.setTimeout(
            () => void start(),
            Math.min(30000, 2000 * attempts),
          );
        }
      }
    };
    void start();
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
      window.clearTimeout(refreshTimer);
    };
  }, [client]);
  return (
    <p role="status" className={connected ? "muted" : "muted-banner"}>
      {connected
        ? "事件通知已连接"
        : "实时更新断开；正在使用有界轮询补偿，以下状态以最近快照为准"}{" "}
      · 最后事件/连接 {at === null ? "尚无" : new Date(at).toLocaleString()}
    </p>
  );
}
