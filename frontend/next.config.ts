import type { NextConfig } from "next";

// Static export is used only for the desktop build (`npm run build` packages
// the frontend into `out/`, which FastAPI serves in pywebview). In `next dev`
// we keep the standard dev server — Turbopack's dev cache clashes with
// `output: "export"` and corrupts the routes manifest, breaking navigation.
const isProductionBuild = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  images: { unoptimized: true },
  ...(isProductionBuild
    ? {
        output: "export",
        // trailing slash keeps the export friendly to StaticFiles: routes like
        // `/history` resolve to `out/history/index.html` instead of
        // `out/history.html`, which FastAPI's StaticFiles(html=True) serves
        // out of the box.
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
