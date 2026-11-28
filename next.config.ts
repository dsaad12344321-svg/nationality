import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config, { dev }) {
    // PDF.js uses Web Workers and dynamic code generation. Next.js' eval-based
    // development source maps can trigger "Object.defineProperty called on non-object".
    // Use regular source maps in development to avoid the Webpack eval interop bug.
    if (dev) {
      config.devtool = "source-map";
    }
    return config;
  },
};

export default nextConfig;
