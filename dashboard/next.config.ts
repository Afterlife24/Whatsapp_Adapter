import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export", // Export as static HTML for S3
  images: {
    unoptimized: true, // Required for static export (no Next.js Image Optimization API)
  },
  
  // Trailing slashes for S3/CloudFront compatibility
  trailingSlash: true,
  
  // No basePath needed - deployed as standalone app
  // No rewrites needed - API calls go directly to backend via NEXT_PUBLIC_API_URL
};

export default nextConfig;
