# D00 local run

Requirements: Node.js 24 LTS and pnpm 10. Install dependencies with `pnpm install`, then run `pnpm dev` (it defaults `DATA_DIR` to a local `data/` directory). The API listens at `http://localhost:3000` by default and the Vite GUI at `http://localhost:5173`; Vite proxies `/healthz` to the API. Set `DATA_DIR` to a writable directory before starting the controller. Invalid configuration stops startup with field-level messages.

For the single-container deployment, copy `.env.example` to `.env`, then run `docker compose up --build`. Open `http://localhost:3000`. Compose keeps `/var/lib/hitchlet` on a named volume. D00 does not yet write application data there. The health endpoint and static page are not an authentication boundary; do not expose this D00 service to untrusted networks.

`GET /healthz` returns the service status, current stage (`D00`), and `simulator: not_implemented`. This confirms process health only; it does not check compute nodes or allocate resources. Stop with Ctrl-C locally or `docker compose down` in deployment. Container shutdown closes Fastify cleanly.

D00 is infrastructure groundwork only. It does not complete M0 or the wider design in `docs/design/README.md` section 19; Simulator workflows and persistence belong to later batches.
