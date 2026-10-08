# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
RUN pnpm build

FROM node:24-alpine AS runtime
RUN addgroup -S awty && adduser -S -G awty awty
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=awty:awty /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=awty:awty /app/node_modules ./node_modules
COPY --from=build --chown=awty:awty /app/dist ./dist
USER awty
EXPOSE 3000
CMD ["node", "dist/app/server.js"]
