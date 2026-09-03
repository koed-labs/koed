FROM node:22-bookworm-slim

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/postgresql.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.1.2 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm source-runtime:prepare \
  && pnpm --filter @koed/koed-server build

ENV KOED_HOME=/data/koed
ENV KOED_DEVICE_PROOF_DIR=/data/koed-device-proof/device-proof
ENV KOED_REPO_ROOT=/app
ENV KOED_RUNTIME_MODE=external
ENV KOED_DEPENDENCY_MODE=external
ENV API_HOST=0.0.0.0
ENV API_HOST_PORT=3300

EXPOSE 3300

CMD ["sh", "-c", "umask 077 && mkdir -p \"$KOED_HOME\" \"$KOED_DEVICE_PROOF_DIR\" && chmod 700 \"$KOED_HOME\" \"$(dirname \"$KOED_DEVICE_PROOF_DIR\")\" \"$KOED_DEVICE_PROOF_DIR\" && exec node packages/koed-server/dist/cli.js start"]
