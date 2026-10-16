import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  
  // Base path for production deployment under /dashboard/whatsapp
  basePath: process.env.NODE_ENV === "production" ? "/dashboard/whatsapp" : "",

  // Proxy /api/adapter/* → adapter backend (same-origin cookie fix).
  //
  // rewrites() runs at BUILD TIME in standalone mode, so runtime env vars
  // are not available. We read the env var here but it must be passed as a
  // build ARG in the Dockerfile (via --build-arg) for it to take effect.
  // The Dockerfile already passes ADAPTER_INTERNAL_URL as a build arg.
  // Fallback: localhost:8001 for local `next dev`.
  async rewrites() {
    const target =
      process.env.ADAPTER_INTERNAL_URL || "http://localhost:8001";
    return [
      {
        source: "/api/adapter/:path*",
        destination: `${target}/:path*`,
      },
    ];
  },
};

export default nextConfig;
