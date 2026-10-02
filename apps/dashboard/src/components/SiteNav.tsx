"use client";

/**
 * Primary navigation for the operator workspace.
 *
 * The active link carries `aria-current="page"` so screen-reader users know
 * where they are without relying on the visual highlight; the CSS turns that
 * same attribute into an accent tint plus a solid bar, so the active route is
 * still obvious without colour.
 *
 * DOM order is a tested contract: the skip link must stay the first focusable
 * element and these six links must follow it in document order, so nothing
 * focusable may be inserted into this list.
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
 * Render the workspace brand block and primary navigation landmark.
 *
 * @returns The nav element with one link per workspace view.
 */
export function SiteNav(): ReactElement {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Primary">
      <div className="shell-brand">
        <span className="shell-brand__name">Appointment Agent</span>
        <span className="shell-brand__meta">
          <span className="chip">Local only</span>
          <span className="chip">No auth</span>
        </span>
      </div>
      <ul className="site-nav__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="site-nav__link"
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}