import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname),
  outputFileTracingIncludes: {
    "/*": ["./node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
  },
  outputFileTracingExcludes: {
    "/*": ["./data/**", "./.env*", "./desktop/**", "./test-artifacts/**"],
  },
};

export default nextConfig;
