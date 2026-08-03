import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export type UpstreamNetworkProfile =
  | "developer"
  | "local_personal"
  | "private_vps"
  | "team_self_hosted"
  | "koed_managed_cloud";

export interface RegisteredUpstreamNetworkTarget {
  baseUrl: string;
  profile?: UpstreamNetworkProfile | null;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

type AddressClass = "public" | "private" | "loopback" | "forbidden";

interface SecureUpstreamFetchDependencies {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  createDispatcher?: (target: {
    hostname: string;
    address: string;
    family: 4 | 6;
  }) => Dispatcher;
  fetch?: (
    input: string | URL | Request,
    init: RequestInit & { dispatcher: Dispatcher }
  ) => Promise<Response>;
}

export interface SecureUpstreamFetchOptions {
  allowPrivateNetworkForUrl?: (url: URL) => boolean;
  dependencies?: SecureUpstreamFetchDependencies;
}

export type SecureUpstreamFetch = typeof fetch & {
  close: () => Promise<void>;
};

const ipv4Number = (address: string): number | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    ((octets[0]! << 24) >>> 0) +
    (octets[1]! << 16) +
    (octets[2]! << 8) +
    octets[3]!
  );
};

const inIpv4Range = (value: number, base: number, prefix: number): boolean => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
};

const classifyIpv4 = (address: string): AddressClass => {
  const value = ipv4Number(address);
  if (value === null) return "forbidden";
  if (inIpv4Range(value, 0x7f000000, 8)) return "loopback";
  if (
    inIpv4Range(value, 0x00000000, 8) ||
    inIpv4Range(value, 0xa9fe0000, 16) ||
    inIpv4Range(value, 0xc0000000, 24) ||
    inIpv4Range(value, 0xc0000200, 24) ||
    inIpv4Range(value, 0xc6120000, 15) ||
    inIpv4Range(value, 0xc6336400, 24) ||
    inIpv4Range(value, 0xcb007100, 24) ||
    inIpv4Range(value, 0xe0000000, 4) ||
    inIpv4Range(value, 0xf0000000, 4)
  ) {
    return "forbidden";
  }
  if (
    inIpv4Range(value, 0x0a000000, 8) ||
    inIpv4Range(value, 0x64400000, 10) ||
    inIpv4Range(value, 0xac100000, 12) ||
    inIpv4Range(value, 0xc0a80000, 16)
  ) {
    return "private";
  }
  return "public";
};

const classifyIpv6 = (address: string): AddressClass => {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "forbidden";
  if (normalized.startsWith("::ffff:")) {
    return classifyIpv4(normalized.slice("::ffff:".length));
  }
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(first)) return "forbidden";
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "forbidden";
  if ((first & 0xff00) === 0xff00) return "forbidden";
  if (normalized.startsWith("2001:db8:")) return "forbidden";
  return "public";
};

export const classifyUpstreamAddress = (address: string): AddressClass => {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return "forbidden";
};

const exactLoopbackHostname = (hostname: string): boolean =>
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());

const targetUrl = (input: string | URL | Request): URL =>
  input instanceof URL
    ? new URL(input)
    : typeof input === "string"
      ? new URL(input)
      : new URL(input.url);

const defaultLookup = async (hostname: string): Promise<ResolvedAddress[]> => {
  const literalFamily = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (literalFamily) {
    return [
      {
        address: hostname.replace(/^\[|\]$/g, ""),
        family: literalFamily === 6 ? 6 : 4
      }
    ];
  }
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4
  }));
};

const defaultDispatcher = (target: {
  hostname: string;
  address: string;
  family: 4 | 6;
}): Dispatcher =>
  new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname.toLowerCase() !== target.hostname.toLowerCase()) {
          callback(new Error("Secure upstream DNS target changed"), "", 4);
          return;
        }
        if (options.all) {
          callback(null, [
            { address: target.address, family: target.family }
          ] as never);
          return;
        }
        callback(null, target.address, target.family);
      }
    }
  });

const defaultFetch = async (
  input: string | URL | Request,
  init: RequestInit & { dispatcher: Dispatcher }
): Promise<Response> =>
  (await undiciFetch(
    input as string | URL,
    init as never
  )) as unknown as Response;

const assertAllowedAddresses = (
  url: URL,
  addresses: ResolvedAddress[],
  allowPrivateNetwork: boolean
): ResolvedAddress => {
  if (addresses.length === 0) {
    throw new Error("Upstream hostname did not resolve");
  }
  const classes = new Set(
    addresses.map(({ address }) => classifyUpstreamAddress(address))
  );
  if (classes.has("forbidden")) {
    throw new Error("Upstream URL resolved to a forbidden network target");
  }
  if (classes.has("loopback") && !exactLoopbackHostname(url.hostname)) {
    throw new Error(
      "Upstream hostname must not resolve indirectly to loopback"
    );
  }
  if (exactLoopbackHostname(url.hostname) && classes.size !== 1) {
    throw new Error("Loopback upstream resolved outside loopback");
  }
  if (classes.has("private") && !allowPrivateNetwork) {
    throw new Error("Upstream URL resolved to an unapproved private network");
  }
  if (classes.size > 1) {
    throw new Error("Upstream hostname resolved across network trust classes");
  }
  return addresses[0]!;
};

export const registeredPrivateNetworkPolicy =
  (
    targets: () => readonly RegisteredUpstreamNetworkTarget[]
  ): ((url: URL) => boolean) =>
  (url) =>
    targets().some((target) => {
      if (
        target.profile !== "private_vps" &&
        target.profile !== "team_self_hosted"
      ) {
        return false;
      }
      const base = new URL(target.baseUrl);
      const basePath = base.pathname.replace(/\/+$/, "");
      return (
        base.origin === url.origin &&
        (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
      );
    });

export const createSecureUpstreamFetch = (
  options: SecureUpstreamFetchOptions = {}
): SecureUpstreamFetch => {
  const lookup = options.dependencies?.lookup ?? defaultLookup;
  const createDispatcher =
    options.dependencies?.createDispatcher ?? defaultDispatcher;
  const request = options.dependencies?.fetch ?? defaultFetch;
  const dispatchers = new Map<string, Dispatcher>();
  let closePromise: Promise<void> | null = null;

  const secureFetch = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ) => {
    if (closePromise) {
      throw new Error("Secure upstream fetch is closed");
    }
    const url = targetUrl(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Upstream request must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      throw new Error("Upstream request must not include credentials");
    }
    if (url.protocol === "http:" && !exactLoopbackHostname(url.hostname)) {
      throw new Error("Upstream request must use HTTPS outside loopback");
    }
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""));
    const selected = assertAllowedAddresses(
      url,
      addresses,
      options.allowPrivateNetworkForUrl?.(url) ?? false
    );
    if (closePromise) {
      throw new Error("Secure upstream fetch is closed");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const dispatcherKey = JSON.stringify([
      hostname.toLowerCase(),
      selected.address,
      selected.family
    ]);
    let dispatcher = dispatchers.get(dispatcherKey);
    if (!dispatcher) {
      dispatcher = createDispatcher({
        hostname,
        address: selected.address,
        family: selected.family
      });
      dispatchers.set(dispatcherKey, dispatcher);
    }
    return request(input, {
      ...init,
      redirect: "error",
      dispatcher
    });
  };

  const fetchWithLifecycle = secureFetch as SecureUpstreamFetch;
  fetchWithLifecycle.close = () => {
    if (!closePromise) {
      const ownedDispatchers = [...dispatchers.values()];
      dispatchers.clear();
      closePromise = Promise.all(
        ownedDispatchers.map((dispatcher) => dispatcher.close())
      ).then(() => undefined);
    }
    return closePromise;
  };
  return fetchWithLifecycle;
};
