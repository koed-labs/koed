# Self-Hosting

Koed Self-Hosted runs as four runtime services: API, worker, embedding service, and console. Postgres with pgvector stores Users, API Tokens, Memory Events, Memory Nodes, embeddings, and Capture Policies. Redis backs BullMQ queues.

## Local Run

```bash
pnpm install
pnpm build
docker compose up --build
```

If ports conflict with another local app:

```bash
API_HOST_PORT=3300 CONSOLE_HOST_PORT=5573 CONSOLE_API_BASE_URL=http://localhost:3300 docker compose up --build
```

Open `http://localhost:5173`, or the host port you selected. The console guides setup:

1. Create the first local admin.
2. Create an API token.
3. Run the smoke test.
4. Copy the generated AI-client fields into your local client.

The browser console cannot write local AI-client configuration files. This is deliberate: self-hosted users keep control of local client setup, and each AI client will have different MCP/configuration conventions.

## Production Notes

Keep Postgres and Redis private. Expose only the console/API through your reverse proxy. Set strong `API_DATA_ENCRYPTION_KEY`, `API_TOKEN_PEPPER`, database password, and Redis password. Use TLS at the reverse proxy if the console or API are reachable beyond localhost.
