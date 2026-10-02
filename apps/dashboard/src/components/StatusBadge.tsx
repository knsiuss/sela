/**
 * Status pill that never relies on colour alone.
 *
 * Every state renders an explicit text label, a `data-status` hook, and a
 * per-tone shape marker. The label and the shape are the accessible signal; the
 * tone class only adds hue on top, which keeps the badge readable in greyscale
 * and for colour-vision deficiency (WCAG 1.4.1). The marker is `aria-hidden`
 * and drawn entirely in CSS, so it never enters the accessibility tree.
 */

import type { ReactElement } from "react";
import type { BadgeTone } from "./status_tone";

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
      <span className="badge__marker" aria-hidden="true" />
      {props.label}
    </span>
  );
}