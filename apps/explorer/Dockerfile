# syntax=docker/dockerfile:1.7
FROM node:24.13.1-alpine AS base
WORKDIR /app

RUN corepack enable \
  && corepack prepare pnpm@11.1.2 --activate

COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS build
ARG VITE_KOED_API_BASE_URL=http://localhost:3000
ENV VITE_KOED_API_BASE_URL=$VITE_KOED_API_BASE_URL

RUN pnpm --filter @koed/explorer build

FROM node:24.13.1-alpine AS runtime
WORKDIR /app/apps/explorer

ENV NODE_ENV=production
ENV PORT=5174

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 5174

CMD ["sh", "-c", "node node_modules/vite/bin/vite.js preview --host 0.0.0.0 --port \"${PORT:-5174}\""]
