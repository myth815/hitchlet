# D00 local run

Requirements: Node.js 24 LTS and pnpm 10. Install dependencies with `pnpm install`, then run `pnpm dev` (it defaults `DATA_DIR` to a local `data/` directory). The API listens at `http://localhost:3000` by default and the Vite GUI at `http://localhost:5173`; Vite proxies `/healthz` to the API. Set `DATA_DIR` to a writable directory before starting the controller. Invalid configuration stops startup with field-level messages.

For the single-container deployment, copy `.env.example` to `.env`, then run `docker compose up --build`. Open `http://localhost:3000`. Compose keeps `/var/lib/hitchlet` on a named volume. D00 does not yet write application data there. The health endpoint and static page are not an authentication boundary; do not expose this D00 service to untrusted networks.

`GET /healthz` returns the service status, current stage (`D00`), and `simulator: not_implemented`. This confirms process health only; it does not check compute nodes or allocate resources. Stop with Ctrl-C locally or `docker compose down` in deployment. Container shutdown closes Fastify cleanly.

D04 Simulator is explicitly opt-in. Keep `EXECUTION_MODE=disabled` for ordinary local runs. To exercise the simulator, set `EXECUTION_MODE=simulator` and set `SIMULATOR_DATA_DIR` to a writable directory separate from `DATA_DIR`, then start with `pnpm dev`. Only Nodes whose internal `config_json.executionMode` is explicitly `simulator` create simulator work. Missing mode is treated as `unconfigured`; `portainer` is pinned to its Operation and is never claimed by the Simulator. This internal setting does not add a public ProviderKind and does not enable a real Portainer worker.

The external simulator directory is its own durable resource ledger; do not point it at the SQLite control directory. Simulator recovery can test operation ordering and cleanup evidence but does not configure Docker, iptables, storage mounts, VM isolation, or lease enforcement. Reset only disposable simulator data after stopping the controller.

D00 is infrastructure groundwork only. D04 adds persistent simulator workflows but does not complete M0 or the wider design in `docs/design/README.md` section 19. Real provider integration and lease API workflows remain later work.
