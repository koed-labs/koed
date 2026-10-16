FROM node:24-bookworm-slim
WORKDIR /app
COPY infra/component-signer/package*.json ./infra/component-signer/
RUN npm ci --prefix infra/component-signer --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
USER node
CMD ["node", "infra/component-signer/server.mjs"]
