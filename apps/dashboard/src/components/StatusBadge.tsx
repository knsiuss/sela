/**
 * Status pill that never relies on colour alone.
 *
 * Every state renders an explicit text label plus a `data-status` hook, so the
 * value is available to assistive technology and to tests without CSS.
 */

import type { ReactElement } from "react";

/** Visual tone of a badge; orthogonal to the meaning it carries. */
export type BadgeTone = "neutral" | "positive" | "warning" | "critical";

/** Props for {@link StatusBadge}. */
export interface StatusBadgeProps {
  label: string;
  tone: BadgeTone;
  /** Machine-readable state written to `data-status`. */
  status: string;
}

/**
 * Render a labelled status badge.
 *
 * @param props - Label, tone, and machine-readable status.
 * @returns The badge element.
 */
export function StatusBadge(props: StatusBadgeProps): ReactElement {
  return (
    <span className={`badge badge--${props.tone}`} data-status={props.status}>
      {props.label}
    </span>
  );
}