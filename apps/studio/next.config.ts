import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  ...(process.env.NEXT_PUBLIC_KOED_STUDIO_HOSTED === "1"
    ? { basePath: "/studio" }
    : {}),
  turbopack: { root: path.resolve(__dirname, "../..") }
};

export default nextConfig;
