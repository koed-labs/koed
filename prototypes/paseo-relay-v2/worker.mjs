import relay, { RelayDurableObject } from "@getpaseo/relay/cloudflare";
export { RelayDurableObject };
export default {
  fetch(request, env) {
    return relay.fetch(request, { ...env, PASEO_RELAY_UPSTREAM: undefined });
  }
};
