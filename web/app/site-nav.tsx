"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Terminal asli" },
  { href: "/ringkas/", label: "Ringkas" },
  { href: "/kode/", label: "Kode C++" },
];

export default function SiteNav() {
  const pathname = usePathname();
  return (
    <header className="site-switch">
      <Link href="/" className="site-switch-brand" aria-label="StockWatch, halaman utama">
        <span aria-hidden="true">›_</span> StockWatch
      </Link>
      <nav aria-label="Mode StockWatch">
        {items.map(({ href, label }) => {
          const current = href === "/" ? pathname === "/" : pathname.startsWith(href) || pathname === href.slice(0, -1);
          return <Link key={href} href={href} aria-current={current ? "page" : undefined}>{label}</Link>;
        })}
      </nav>
    </header>
  );
}

