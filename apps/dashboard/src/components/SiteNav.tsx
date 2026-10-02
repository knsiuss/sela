"use client";

/**
 * Primary navigation for the operator workspace.
 *
 * The active link carries `aria-current="page"` so screen-reader users know
 * where they are without relying on the visual highlight.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/appointments", label: "Appointments" },
  { href: "/conflicts", label: "Conflicts" },
  { href: "/queue", label: "Queue" },
  { href: "/actions", label: "Actions" },
  { href: "/audit", label: "Audit" },
];

/**
 * Render the primary navigation landmark.
 *
 * @returns The nav element with one link per workspace view.
 */
export function SiteNav(): ReactElement {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Primary">
      <ul className="site-nav__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}