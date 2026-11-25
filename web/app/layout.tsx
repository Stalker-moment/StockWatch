import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./globals.css";
import "./classic.css";
import SiteNav from "./site-nav";

export const metadata: Metadata = {
  title: "StockWatch · IDX Web Terminal",
  description: "Versi web terminal C++ StockWatch dengan kuotasi IDX, IHSG, dan grafik candlestick.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body><SiteNav />{children}</body>
    </html>
  );
}

