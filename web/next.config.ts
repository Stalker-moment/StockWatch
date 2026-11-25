import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const staticExport = process.env.STATIC_EXPORT === "1";

const config: NextConfig = {
  ...(staticExport ? { output: "export", pageExtensions: ["tsx", "jsx", "mdx"] } : {}),
  trailingSlash: true,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  turbopack: { root: fileURLToPath(new URL("..", import.meta.url)) },
  devIndicators: false,
};

export default config;
