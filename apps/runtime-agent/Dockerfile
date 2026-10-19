FROM node:24-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @hitchlet/runtime-agent...
RUN pnpm --filter @hitchlet/contracts build \
    && pnpm --filter @hitchlet/runtime-agent build \
    && pnpm --filter @hitchlet/runtime-agent deploy --legacy --prod /runtime-agent-out

FROM node:24-bookworm-slim AS dockercli
ARG TARGETARCH
ARG DOCKER_CLI_VERSION=29.5.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && case "$TARGETARCH" in \
         amd64) docker_arch=x86_64 ;; \
         arm64) docker_arch=aarch64 ;; \
         *) echo "Unsupported Docker CLI architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && install -D /tmp/docker/docker /out/usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz /var/lib/apt/lists/*

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iptables conntrack iproute2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /out/usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/hitchlet-runtime-agent
COPY --from=build /runtime-agent-out ./
ENV HITCHLET_RUNTIME_AGENT_CONFIG=/run/hitchlet/runtime-agent.json
ENTRYPOINT ["node", "/opt/hitchlet-runtime-agent/dist/main.js"]
