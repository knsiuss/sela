/** Dependency-free Prometheus-compatible metrics for bounded service signals. */

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const MAX_SERIES = 10_000;

/** Narrow metrics port used by application boundaries. */
export interface MetricsSink {
  increment(name: string, labels?: Readonly<Record<string, string>>, value?: number): void;
  set_gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value_ms: number, labels?: Readonly<Record<string, string>>): void;
}

/** No-op sink for focused unit tests and embedders that own telemetry. */
export class NoopMetrics implements MetricsSink {
  increment(_name: string, _labels?: Readonly<Record<string, string>>, _value?: number): void {}
  set_gauge(_name: string, _value: number, _labels?: Readonly<Record<string, string>>): void {}
  observe(_name: string, _value_ms: number, _labels?: Readonly<Record<string, string>>): void {}
}

interface HistogramValue {
  counts: number[];
  sum: number;
  count: number;
}

/** Bounded in-process registry exposed as Prometheus text. */
export class MetricsRegistry implements MetricsSink {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramValue>();

  /** Increment a counter by a finite non-negative amount. */
  increment(name: string, labels: Readonly<Record<string, string>> = {}, value = 1): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = series_key(name, labels);
    ensure_capacity(this.counters, key);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  /** Set a finite gauge value. */
  set_gauge(name: string, value: number, labels: Readonly<Record<string, string>> = {}): void {
    if (!Number.isFinite(value)) return;
    const key = series_key(name, labels);
    ensure_capacity(this.gauges, key);
    this.gauges.set(key, value);
  }

  /** Observe a duration in milliseconds using fixed latency buckets. */
  observe(name: string, value_ms: number, labels: Readonly<Record<string, string>> = {}): void {
    if (!Number.isFinite(value_ms) || value_ms < 0) return;
    const key = series_key(name, labels);
    ensure_capacity(this.histograms, key);
    const current = this.histograms.get(key) ?? {
      counts: HISTOGRAM_BUCKETS_MS.map(() => 0),
      sum: 0,
      count: 0,
    };
    for (let index = 0; index < HISTOGRAM_BUCKETS_MS.length; index += 1) {
      if (value_ms <= HISTOGRAM_BUCKETS_MS[index]!) current.counts[index] += 1;
    }
    current.sum += value_ms;
    current.count += 1;
    this.histograms.set(key, current);
  }

  /** Render deterministic Prometheus exposition text without tenant/message labels. */
  render_prometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of [...this.counters.entries()].sort()) {
      const parsed = parse_series_key(key);
      lines.push(`${metric_line("counter", parsed.name, parsed.labels, value)}`);
    }
    for (const [key, value] of [...this.gauges.entries()].sort()) {
      const parsed = parse_series_key(key);
      lines.push(`${metric_line("gauge", parsed.name, parsed.labels, value)}`);
    }
    for (const [key, value] of [...this.histograms.entries()].sort()) {
      const parsed = parse_series_key(key);
      const base = parsed.labels;
      for (let index = 0; index < HISTOGRAM_BUCKETS_MS.length; index += 1) {
        lines.push(metric_line(
          "histogram",
          `${parsed.name}_bucket`,
          { ...base, le: String(HISTOGRAM_BUCKETS_MS[index]) },
          value.counts[index] ?? 0,
        ));
      }
      lines.push(metric_line("histogram", `${parsed.name}_bucket`, { ...base, le: "+Inf" }, value.count));
      lines.push(metric_line("histogram", `${parsed.name}_sum`, base, value.sum));
      lines.push(metric_line("histogram", `${parsed.name}_count`, base, value.count));
    }
    return `${lines.join("\n")}\n`;
  }

  /** Return a point-in-time counter for tests and alert evaluation. */
  counter_value(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(series_key(name, labels)) ?? 0;
  }

  /** Return a point-in-time gauge for tests and alert evaluation. */
  gauge_value(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.gauges.get(series_key(name, labels)) ?? 0;
  }
}

function ensure_capacity<T>(store: Map<string, T>, key: string): void {
  if (!store.has(key) && store.size >= MAX_SERIES) throw new Error("metrics-series-limit-exceeded");
}

function metric_line(
  type: "counter" | "gauge" | "histogram",
  name: string,
  labels: Readonly<Record<string, string>>,
  value: number,
): string {
  const rendered_labels = render_labels(labels);
  const type_suffix = type === "histogram" || (type === "counter" && name.endsWith("_total"))
    ? ""
    : `_${type}`;
  return `${name}${type_suffix}${rendered_labels} ${format_number(value)}`;
}

function render_labels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escape_label(value)}"`).join(",")}}`;
}

function series_key(name: string, labels: Readonly<Record<string, string>>): string {
  if (!/^[_a-zA-Z][_a-zA-Z0-9:]*$/.test(name) || name.length > 128) {
    throw new TypeError("metric-name-invalid");
  }
  const entries = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(key) || key.length > 64) {
        throw new TypeError("metric-label-invalid");
      }
      if (value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError("metric-label-value-invalid");
      }
      return `${key}=${value}`;
    });
  return `${name}\u0000${entries.join("\u0001")}`;
}

function parse_series_key(key: string): { name: string; labels: Record<string, string> } {
  const [name, encoded] = key.split("\u0000");
  const labels: Record<string, string> = {};
  if (encoded !== undefined) {
    for (const item of encoded.split("\u0001")) {
      const separator = item.indexOf("=");
      if (separator > 0) labels[item.slice(0, separator)] = item.slice(separator + 1);
    }
  }
  return { name: name ?? "invalid_metric", labels };
}

function escape_label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function format_number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(12).replace(/0+$/u, "").replace(/\.$/u, "");
}
