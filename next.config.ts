import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Export the browser-only sample app for Cloudflare; keep local Next.js preview available.
  ...(process.env.CLOUDFLARE_EXPORT === "1" ? { output: "export" as const, images: { unoptimized: true } } : {}),
};

export default nextConfig;
