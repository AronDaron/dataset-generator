import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // trailing slash keeps the export friendly to StaticFiles: routes like
  // `/history` resolve to `out/history/index.html` instead of `out/history.html`,
  // which FastAPI's StaticFiles(html=True) can serve out of the box.
  trailingSlash: true,
};

export default nextConfig;
