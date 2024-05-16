FROM node:20-alpine as builder

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@8.15.7 --activate

COPY package.json pnpm-lock.yaml .npmrc ./

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm fetch --prod

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts --prod --offline

RUN pnpm run build

# --------------------------------------------

FROM node:20-alpine as runner

WORKDIR /app

COPY --from=builder /app/.output ./

CMD node /app/server/index.mjs