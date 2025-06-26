FROM node:22-alpine AS builder

ARG BUILD_HASH
ENV BUILD_HASH=${BUILD_HASH}

WORKDIR /app

# remove when 10.12.4 released
RUN npm install -g pnpm@10.12.1

COPY package.json pnpm-lock.yaml .npmrc ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch --prod

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts --prod --offline

RUN pnpm run build

# --------------------------------------------

FROM node:22-alpine AS runner

ENV NITRO_CLUSTER_WORKERS=1

WORKDIR /app

COPY --from=builder /app/.output ./

CMD ["node", "/app/server/index.mjs"]