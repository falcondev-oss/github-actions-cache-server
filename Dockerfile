FROM node:22-alpine as builder

ARG BUILD_HASH
ENV BUILD_HASH=${BUILD_HASH}

WORKDIR /app

RUN npm install -g pnpm@latest-10

COPY package.json pnpm-lock.yaml .npmrc ./
COPY patches patches

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch --prod

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts --prod --offline

RUN pnpm run build

# --------------------------------------------

FROM node:22-alpine as runner

WORKDIR /app

COPY --from=builder /app/.output ./

CMD node /app/server/index.mjs