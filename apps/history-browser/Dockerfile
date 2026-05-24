# syntax=docker/dockerfile:1.7
FROM node:24.13.1-alpine AS base
WORKDIR /app

ARG HISTORY_BROWSER_REPO=https://github.com/koed-labs/koed-history-browser.git
ARG HISTORY_BROWSER_REF=main

ENV HISTORY_BROWSER_REPO=$HISTORY_BROWSER_REPO
ENV HISTORY_BROWSER_REF=$HISTORY_BROWSER_REF

RUN apk add --no-cache git \
  && corepack enable \
  && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile

RUN --mount=type=secret,id=github_token,required=false \
  HISTORY_BROWSER_GITHUB_TOKEN="$(cat /run/secrets/github_token 2>/dev/null || true)" \
  node scripts/sync-history-browser.mjs

RUN CI=true pnpm -C apps/history-browser/t3code-history-browser install --frozen-lockfile

FROM base AS build
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_KOED_API_BASE_URL=$VITE_API_BASE_URL
ENV HISTORY_BROWSER_SKIP_SYNC=1

RUN CI=true pnpm -C apps/history-browser/t3code-history-browser build

FROM node:24.13.1-alpine AS runtime
WORKDIR /app/apps/history-browser/t3code-history-browser/apps/web

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 5174

CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5174"]
