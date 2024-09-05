FROM node:20-alpine as builder

ARG BUILD_HASH
ENV BUILD_HASH=${BUILD_HASH}

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@latest-9 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
COPY patches patches

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch --prod

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts --prod --offline

RUN pnpm run build

# --------------------------------------------

FROM node:20-alpine as runner

WORKDIR /app

COPY --from=builder /app/.output ./

CMD node /app/server/index.mjs