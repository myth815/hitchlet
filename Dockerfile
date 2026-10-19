FROM node:24.22.0-bookworm AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/gui/package.json apps/gui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @hitchlet/contracts build && pnpm --filter @hitchlet/sdk build && pnpm --filter @hitchlet/gui build && pnpm --filter @hitchlet/controller build
RUN pnpm deploy --legacy --filter @hitchlet/controller --prod /out/controller

FROM node:24.22.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/lib/hitchlet GUI_DIR=/app/gui
WORKDIR /app
COPY --from=build /out/controller ./
COPY --from=build /workspace/apps/gui/dist ./gui
RUN mkdir -p /var/lib/hitchlet && chown node:node /var/lib/hitchlet
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
