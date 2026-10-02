"use client";

/**
 * Sortable, filterable, tenant-scoped appointment list.
 *
 * Accessibility contract: a real `<table>` with a `<caption>`, `<th scope>`,
 * and `aria-sort` on the active column. Every sort control is a real `<button>`
 * inside the header cell so it is reachable and operable by keyboard, and the
 * result count is announced through a polite live region.
 */

import { useId, useMemo, useState, type ReactElement } from "react";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_SORT_KEYS,
  DEFAULT_APPOINTMENT_SORT,
  filter_appointments,
  MAX_FILTER_QUERY_LENGTH,
  next_sort_direction,
  sort_appointments,
  type AppointmentFilter,
  type AppointmentRow,
  type AppointmentSortKey,
  type SortDirection,
} from "@/domain/appointments_view";
import { StatusBadge, type BadgeTone } from "./StatusBadge";

/** Props for {@link AppointmentTable}. */
export interface AppointmentTableProps {
  rows: readonly AppointmentRow[];
  tenant_id: string;
}

const COLUMN_LABELS: Readonly<Record<AppointmentSortKey, string>> = {
  appointment_id: "Appointment", resource_id: "Resource", version: "Version",
  starts_at_iso: "Starts at", ends_at_iso: "Ends at", status: "Status",
};

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  confirmed: "positive", held: "warning", cancelled: "neutral", completed: "neutral", no_show: "critical",
};

/** Sort and filter state the table owns. */
interface ListControls {
  sort_key: AppointmentSortKey;
  direction: SortDirection;
  query: string;
  status: string;
}

/**
 * Render the appointment list with sorting and filtering controls.
 *
 * @param props - Tenant-scoped rows and the resolved tenant id.
 * @returns The table region.
 */
export function AppointmentTable(props: AppointmentTableProps): ReactElement {
  const [controls, set_controls] = useState<ListControls>({
    sort_key: DEFAULT_APPOINTMENT_SORT.key,
    direction: DEFAULT_APPOINTMENT_SORT.direction,
    query: "",
    status: "all",
  });

  const visible = useMemo(() => sort_appointments(
    filter_appointments(props.rows, { query: controls.query, status: status_filter(controls.status) }),
    controls.sort_key,
    controls.direction,
  ), [props.rows, controls]);

  function on_sort(column: AppointmentSortKey): void {
    const direction = next_sort_direction(column, controls.sort_key, controls.direction);
    set_controls((previous) => ({ ...previous, sort_key: column, direction }));
  }

  function on_query(query: string): void {
    set_controls((previous) => ({ ...previous, query }));
  }

  function on_status(status: string): void {
    set_controls((previous) => ({ ...previous, status }));
  }

  return (
    <section className="panel" aria-labelledby="appointments-heading">
      <h2 id="appointments-heading">Appointments</h2>
      <AppointmentFilters query={controls.query} status={controls.status} on_query={on_query} on_status={on_status} />
      <p className="result-count" role="status">
        {visible.length} of {props.rows.length} appointments shown for tenant {props.tenant_id}.
      </p>
      <AppointmentTableBody rows={visible} controls={controls} on_sort={on_sort} />
    </section>
  );
}

interface AppointmentFiltersProps {
  query: string;
  status: string;
  on_query: (value: string) => void;
  on_status: (value: string) => void;
}

function AppointmentFilters(props: AppointmentFiltersProps): ReactElement {
  const query_id = useId();
  const status_id = useId();
  return (
    <div className="filters">
      <div className="field">
        <label htmlFor={query_id}>Search appointment or resource id</label>
        <input
          id={query_id}
          type="search"
          value={props.query}
          maxLength={MAX_FILTER_QUERY_LENGTH}
          onChange={(event) => props.on_query(event.target.value)}
          aria-describedby={`${query_id}-hint`}
        />
        <p id={`${query_id}-hint`} className="field__hint">Identifiers only. No customer content is stored or searched.</p>
      </div>
      <div className="field">
        <label htmlFor={status_id}>Status</label>
        <select id={status_id} value={props.status} onChange={(event) => props.on_status(event.target.value)}>
          <option value="all">All statuses</option>
          {APPOINTMENT_STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
    </div>
  );
}

interface AppointmentTableBodyProps {
  rows: readonly AppointmentRow[];
  controls: ListControls;
  on_sort: (column: AppointmentSortKey) => void;
}

function AppointmentTableBody(props: AppointmentTableBodyProps): ReactElement {
  return (
    <table className="data-table">
      <caption className="sr-only">
        Appointments for this tenant, sorted by {props.controls.sort_key} {props.controls.direction}.
      </caption>
      <thead>
        <tr>{APPOINTMENT_SORT_KEYS.map((key) => <SortableHeader key={key} column={key} controls={props.controls} on_sort={props.on_sort} />)}</tr>
      </thead>
      <tbody>
        {props.rows.map((row) => <AppointmentRowCells key={row.appointment_id} row={row} />)}
        {props.rows.length === 0 && (
          <tr><td colSpan={APPOINTMENT_SORT_KEYS.length}>No appointments match the current filters.</td></tr>
        )}
      </tbody>
    </table>
  );
}

interface SortableHeaderProps {
  column: AppointmentSortKey;
  controls: ListControls;
  on_sort: (column: AppointmentSortKey) => void;
}

function SortableHeader(props: SortableHeaderProps): ReactElement {
  return (
    <th scope="col" aria-sort={aria_sort_for(props.column, props.controls.sort_key, props.controls.direction)}>
      <button type="button" onClick={() => props.on_sort(props.column)}>
        {COLUMN_LABELS[props.column]}
      </button>
    </th>
  );
}

interface AppointmentRowCellsProps {
  row: AppointmentRow;
}

function AppointmentRowCells(props: AppointmentRowCellsProps): ReactElement {
  const row = props.row;
  return (
    <tr>
      <td>{row.appointment_id}</td>
      <td>{row.resource_id}</td>
      <td>{row.version}</td>
      <td><time dateTime={row.starts_at_iso}>{row.starts_at_iso}</time></td>
      <td><time dateTime={row.ends_at_iso}>{row.ends_at_iso}</time></td>
      <td><StatusBadge label={row.status} tone={STATUS_TONES[row.status] ?? "neutral"} status={row.status} /></td>
    </tr>
  );
}

function aria_sort_for(key: AppointmentSortKey, sort_key: AppointmentSortKey, direction: SortDirection): "ascending" | "descending" | "none" {
  if (key !== sort_key) return "none";
  return direction === "asc" ? "ascending" : "descending";
}

/** Narrow the select value to the domain status union before filtering. */
function status_filter(value: string): AppointmentFilter["status"] {
  return APPOINTMENT_STATUSES.find((candidate) => candidate === value) ?? "all";
}