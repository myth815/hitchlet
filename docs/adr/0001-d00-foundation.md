# ADR 0001: D00 foundation and boundaries

Status: Accepted for D00

Hitchlet starts as a pnpm TypeScript monorepo on Node.js 24 LTS. The controller is one Fastify process, validates environment configuration with Zod, serves the GUI from the same origin, and owns the API health endpoint. The GUI uses the small SDK health client. D00's shared health response schema and type live in `packages/contracts`; the existing public DTO files under `docs/design/contracts/public.ts` remain the design baseline for later migration, so D00 does not duplicate or rewrite that large contract set.

D00 implements no Ticket workflow, persistence schema, simulator, provider, VM, or scheduling behavior. `/healthz` reports the implementation stage and explicitly marks the Simulator as not implemented. The named Portainer/Docker, Hyper-V, and Tart backends remain architectural options; this foundation does not bind the runtime to one of them. Hitchlet remains independent of OpenClaw and task-specific business logic.

The first Compose deployment contains one controller image and a named persistent data volume reserved for later control data. No database is initialized in D00. Configuration fails at startup for invalid required values; secrets are supplied by deployment environment and are never checked into the repository.
