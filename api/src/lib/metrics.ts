/**
 * Minimal Prometheus metrics registry (counters, gauges, histograms) in pure
 * TypeScript — no prom-client dependency. Exposes the text exposition format
 * consumed by Prometheus scrapers. Labels are supported via a small key set.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',');
}

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
}

class Counter implements Metric {
  type = 'counter' as const;
  private values = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  *series(): Generator<[string, number]> {
    for (const [k, v] of this.values) yield [k, v];
  }
}

class Gauge implements Metric {
  type = 'gauge' as const;
  private values = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }
  *series(): Generator<[string, number]> {
    for (const [k, v] of this.values) yield [k, v];
  }
}

// Fixed buckets (seconds) suitable for HTTP latencies.
const HIST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

class Histogram implements Metric {
  type = 'histogram' as const;
  private buckets = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  observe(value: number, labels: Labels = {}): void {
    const k = labelKey(labels);
    const b = this.buckets.get(k) ?? HIST_BUCKETS.map(() => 0);
    HIST_BUCKETS.forEach((le, i) => { if (value <= le) b[i]++; });
    this.buckets.set(k, b);
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
  render(): string {
    let out = '';
    for (const [k, b] of this.buckets) {
      const base = k ? `{${k}` : '{';
      let cumulative = 0;
      HIST_BUCKETS.forEach((le, i) => {
        cumulative += b[i];
        out += `${this.name}_bucket${base}${k ? ',' : ''}le="${le}"} ${cumulative}\n`;
      });
      out += `${this.name}_bucket${base}${k ? ',' : ''}le="+Inf"} ${this.counts.get(k) ?? 0}\n`;
      out += `${this.name}_sum${k ? `{${k}}` : ''} ${this.sums.get(k) ?? 0}\n`;
      out += `${this.name}_count${k ? `{${k}}` : ''} ${this.counts.get(k) ?? 0}\n`;
    }
    return out;
  }
}

class Registry {
  private metrics: (Counter | Gauge | Histogram)[] = [];
  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }
  gauge(name: string, help: string): Gauge {
    const g = new Gauge(name, help);
    this.metrics.push(g);
    return g;
  }
  histogram(name: string, help: string): Histogram {
    const h = new Histogram(name, help);
    this.metrics.push(h);
    return h;
  }
  /** Render all metrics in Prometheus text exposition format. */
  render(): string {
    let out = '';
    for (const m of this.metrics) {
      out += `# HELP ${m.name} ${m.help}\n# TYPE ${m.name} ${m.type}\n`;
      if (m instanceof Histogram) {
        out += m.render();
      } else {
        for (const [k, v] of m.series()) {
          out += `${m.name}${k ? `{${k}}` : ''} ${v}\n`;
        }
        // Emit a zero sample so the series always appears.
        if ([...m.series()].length === 0) out += `${m.name} 0\n`;
      }
    }
    return out;
  }
}

export const registry = new Registry();

// --- Application metrics ---
export const httpRequests = registry.counter('jtm_http_requests_total', 'Total HTTP requests by method, route and status.');
export const httpDuration = registry.histogram('jtm_http_request_duration_seconds', 'HTTP request duration in seconds.');
export const paymentsTotal = registry.counter('jtm_payments_total', 'Payment outcomes by provider and status.');
export const vouchersRedeemed = registry.counter('jtm_vouchers_redeemed_total', 'Vouchers redeemed.');
export const invoicesCreated = registry.counter('jtm_invoices_created_total', 'Invoices created.');
export const subscribersSuspended = registry.counter('jtm_subscribers_suspended_total', 'Subscriber suspensions.');
export const fupThrottled = registry.counter('jtm_fup_throttled_total', 'FUP throttle enforcements.');
