const openApiEndpoints: Array<[string, string]> = [
  ["GET", "/v1/access/check"],
  ["GET", "/v1/capture-policy/effective"],
  ["GET", "/v1/capture-policies"],
  ["PUT", "/v1/capture-policies"],
  ["POST", "/v1/sessions"],
  ["POST", "/v1/sessions/{sessionId}/events"],
  ["POST", "/v1/memory/capture-personal-event"],
  ["POST", "/v1/memory/conversation-items"],
  ["POST", "/v1/memory/token-usage"],
  ["POST", "/v1/memory/conversation-items/project"],
  ["GET", "/v1/memory/clusters"],
  ["GET", "/v1/memory/clusters/{clusterId}/memories"],
  ["GET", "/v1/memory/items"],
  ["GET", "/v1/memory/graph/overview"],
  ["GET", "/v1/memory/graph/nodes"],
  ["GET", "/v1/memory/graph/nodes/{nodeId}"],
  ["GET", "/v1/memory/graph/threads"],
  ["GET", "/v1/memory/graph/events"],
  ["GET", "/v1/memory/graph/events/{eventId}"],
  ["PATCH", "/v1/memory/graph/events/{eventId}"],
  ["DELETE", "/v1/memory/graph/events/{eventId}"],
  ["GET", "/v1/memory/export"],
  ["GET", "/v1/memory/questions"],
  ["POST", "/v1/memory/questions"],
  ["POST", "/v1/memory/questions/claim-pending"],
  ["GET", "/v1/memory/questions/{questionId}"],
  ["PATCH", "/v1/memory/questions/{questionId}"],
  ["POST", "/v1/memory/search"],
  ["POST", "/v1/memory/answer"],
  ["PATCH", "/v1/memory/nodes/{nodeId}"],
  ["DELETE", "/v1/memory/nodes/{nodeId}"],
  ["GET", "/v1/memory/lcm/summaries/pending"],
  ["POST", "/v1/memory/lcm/summaries/{nodeId}"],
  ["GET", "/v1/memory/nodes/{nodeId}"],
  ["GET", "/v1/memory/nodes/{nodeId}/expand"]
];

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Koed Self-Hosted API", version: "0.1.0" },
  components: {
    securitySchemes: { bearerApiToken: { type: "http", scheme: "bearer" } }
  },
  security: [{ bearerApiToken: [] }],
  paths: Object.fromEntries(
    openApiEndpoints.map(([method, path]) => [
      path,
      {
        [method.toLowerCase()]: {
          responses: { "200": { description: "OK" } },
          security: [{ bearerApiToken: [] }]
        }
      }
    ])
  )
};
