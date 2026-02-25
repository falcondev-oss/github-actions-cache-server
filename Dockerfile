ARG BASE_IMAGE=node:25-alpine

FROM ${BASE_IMAGE} AS builder

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm npm install -g pnpm@latest-10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch --prod
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --offline

COPY . .

ARG BUILD_HASH
ENV BUILD_HASH=${BUILD_HASH}
RUN pnpm run build

# --------------------------------------------

FROM ${BASE_IMAGE} AS runner

ENV NITRO_CLUSTER_WORKERS=1

WORKDIR /app

COPY --from=builder /app/.output ./

CMD ["node", "--expose-gc", "/app/server/index.mjs"]