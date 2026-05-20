FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
RUN npm install -g pnpm@10.30.3 --force
COPY . .
RUN pnpm install --frozen-lockfile
RUN CI=true COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_ENABLE_STRICT=0 pnpm -C apps/history-browser/t3code-history-browser --config.package-manager-strict=false install --ignore-scripts --frozen-lockfile=false

FROM base AS build
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_KOED_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_KOED_HISTORY_BROWSER=1
RUN CI=true COREPACK_ENABLE_PROJECT_SPEC=0 COREPACK_ENABLE_STRICT=0 pnpm -C apps/history-browser/t3code-history-browser --config.package-manager-strict=false --filter @t3tools/web build

FROM node:22-alpine AS runtime
WORKDIR /app/apps/history-browser/t3code-history-browser/apps/web
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 5174
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5174"]
