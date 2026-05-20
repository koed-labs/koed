FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS build
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm --filter @koed/console build

FROM node:22-alpine AS runtime
WORKDIR /app/apps/console
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 5173
CMD ["node", "../../node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0"]
