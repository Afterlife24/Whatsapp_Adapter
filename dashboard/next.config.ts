import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  
  // No basePath needed - deployed as standalone app
  // No rewrites needed - API calls go directly to backend via NEXT_PUBLIC_API_URL
};

export default nextConfig;
