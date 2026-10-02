import type { ReactElement, ReactNode } from "react";

/**
 * Shared page-header pattern.
 *
 * One `<h1>` plus an optional eyebrow and description, so every route frames
 * its content identically and no page drifts into a bare heading on the canvas.
 * The component is a server component: it carries no state and ships no client
 * JavaScript.
 */

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** Route heading; the single `<h1>` for the page. */
  title: string;
  /** Small label above the title, such as the owning subsystem. */
  eyebrow?: string;
  /** Explanatory sentence describing what the page is for. */
  description?: ReactNode;
}

/**
 * Render the page header.
 *
 * @param props - Eyebrow, title, and description.
 * @returns The header region.
 */
export function PageHeader(props: PageHeaderProps): ReactElement {
  return (
    <div className="page-header">
      {props.eyebrow === undefined ? null : <p className="page-header__eyebrow">{props.eyebrow}</p>}
      <h1>{props.title}</h1>
      {props.description === undefined ? null : <p className="page-header__description">{props.description}</p>}
    </div>
  );
}