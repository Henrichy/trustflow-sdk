import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import type { AxiosInstance } from 'axios';

const INSTRUMENTATION_NAME = '@trustflow/sdk';
const instrumentedClients = new WeakSet<object>();

/** Creates a W3C traceparent value from the active OpenTelemetry span. */
export function activeTraceparent(): string | undefined {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (
    !spanContext ||
    !/^[0-9a-f]{32}$/i.test(spanContext.traceId) ||
    !/^[0-9a-f]{16}$/i.test(spanContext.spanId)
  ) {
    return undefined;
  }

  return `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 0xff)
    .toString(16)
    .padStart(2, '0')}`;
}

/** Adds the active W3C trace context to Axios-based transports. */
export function installTraceContextInterceptor(client: AxiosInstance): void {
  if (instrumentedClients.has(client)) return;
  if (!client?.interceptors?.request?.use) return;
  instrumentedClients.add(client);

  client.interceptors.request.use((request) => {
    const traceparent = activeTraceparent();
    if (traceparent) request.headers.set('traceparent', traceparent);
    return request;
  });
}

/** Gets an SDK tracer from the supplied provider, or the globally configured provider. */
export function getSdkTracer(provider?: TracerProvider): Tracer {
  return (provider ?? trace.getTracerProvider()).getTracer(INSTRUMENTATION_NAME);
}

/**
 * Runs an operation in a span, recording duration, status, and structured error
 * metadata. A returned SDK result with `ok: false` is treated as an error.
 */
export async function withSdkSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    const startedAt = Date.now();
    try {
      const result = await operation(span);
      const value = result as {
        ok?: boolean;
        error?: unknown;
        success?: boolean;
        message?: unknown;
      };
      if (value && (value.ok === false || value.success === false)) {
        markSpanError(span, value.error ?? value.message ?? 'operation failed');
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (error) {
      markSpanError(span, error);
      throw error;
    } finally {
      span.setAttribute('duration_ms', Math.max(0, Date.now() - startedAt));
      span.end();
    }
  });
}

/** Records an exception and marks its span as failed. */
export function markSpanError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute('error.message', message);
  if (error instanceof Error) {
    span.setAttribute('error.type', error.name);
    span.recordException(error);
  } else {
    span.setAttribute('error.type', typeof error);
  }
}
