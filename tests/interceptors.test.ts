import axios, { AxiosAdapter, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { HttpInterceptors, InterceptorManager, attachInterceptors } from '../src/utils/interceptors';
import { createApiHttpClient } from '../src/utils/http';

function respond(status: number, data: unknown = {}): AxiosAdapter {
  return async (config: InternalAxiosRequestConfig) => {
    const response = { data, status, statusText: String(status), headers: {}, config };
    if (status >= 400) {
      throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, undefined, response);
    }
    return response;
  };
}

describe('InterceptorManager', () => {
  it('chains interceptors in registration order, including async ones', async () => {
    const manager = new InterceptorManager<string[]>();
    manager.use((v) => [...v, 'a']);
    manager.use(async (v) => [...v, 'b']);
    manager.use((v) => [...v, 'c']);

    await expect(manager.run([])).resolves.toEqual(['a', 'b', 'c']);
  });

  it('ejects and clears interceptors', async () => {
    const manager = new InterceptorManager<number>();
    const id = manager.use((v) => v + 1);
    manager.use((v) => v * 10);
    manager.eject(id);
    manager.eject(99);

    expect(manager.size).toBe(1);
    await expect(manager.run(1)).resolves.toBe(10);

    manager.clear();
    expect(manager.size).toBe(0);
    await expect(manager.run(1)).resolves.toBe(1);
  });

  it('routes a thrown error to later rejected handlers, which can recover', async () => {
    const manager = new InterceptorManager<number>();
    const skipped = jest.fn((v: number) => v);
    manager.use(() => {
      throw new Error('boom');
    });
    manager.use(skipped);
    manager.use(undefined, (err) => (err as Error).message.length);
    manager.use((v) => v + 1);

    await expect(manager.run(0)).resolves.toBe(5);
    expect(skipped).not.toHaveBeenCalled();
  });

  it('rejects when no handler recovers', async () => {
    const manager = new InterceptorManager<number>();
    manager.use(async () => {
      throw new Error('nope');
    });

    await expect(manager.run(0)).rejects.toThrow('nope');
    await expect(manager.run(new Error('initial'), true)).rejects.toThrow('initial');
  });
});

describe('attachInterceptors', () => {
  it('lets request interceptors modify outgoing requests', async () => {
    const interceptors = new HttpInterceptors();
    interceptors.request.use(async (config) => {
      config.headers.set('X-Trace-Id', 'trace-1');
      return config;
    });

    let seen: InternalAxiosRequestConfig | undefined;
    const instance = axios.create({
      adapter: async (config) => {
        seen = config;
        return respond(200)(config);
      },
    });
    attachInterceptors(instance, interceptors);

    await instance.get('/x');
    expect(seen?.headers.get('X-Trace-Id')).toBe('trace-1');
  });

  it('lets response interceptors transform responses', async () => {
    const interceptors = new HttpInterceptors();
    interceptors.response.use((res) => ({ ...res, data: { wrapped: res.data } }));
    interceptors.response.use(async (res) => ({ ...res, data: { ...(res.data as object), n: 2 } }));

    const instance = axios.create({ adapter: respond(200, { id: 1 }) });
    attachInterceptors(instance, interceptors);

    const res = await instance.get('/x');
    expect(res.data).toEqual({ wrapped: { id: 1 }, n: 2 });
  });

  it('passes transport errors through response error handlers', async () => {
    const interceptors = new HttpInterceptors();
    const onError = jest.fn((err: unknown) => {
      throw err;
    });
    interceptors.response.use(undefined, onError);

    const instance = axios.create({ adapter: respond(404) });
    attachInterceptors(instance, interceptors);

    await expect(instance.get('/x')).rejects.toBeInstanceOf(AxiosError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('allows response error handlers to recover with a fallback response', async () => {
    const interceptors = new HttpInterceptors();
    interceptors.response.use(undefined, (err) => {
      const response = (err as AxiosError).response!;
      return { ...response, status: 200, data: { fallback: true } };
    });

    const instance = axios.create({ adapter: respond(404) });
    attachInterceptors(instance, interceptors);

    await expect(instance.get('/x')).resolves.toMatchObject({ data: { fallback: true } });
  });

  it('picks up interceptors registered after the client is created', async () => {
    const interceptors = new HttpInterceptors();
    const instance = axios.create({ adapter: respond(200, 'raw') });
    attachInterceptors(instance, interceptors);

    interceptors.response.use((res) => ({ ...res, data: 'late' }));
    await expect(instance.get('/x')).resolves.toMatchObject({ data: 'late' });
  });
});

describe('createApiHttpClient interceptors option', () => {
  it('runs request interceptors once per attempt when retrying', async () => {
    const interceptors = new HttpInterceptors();
    const onRequest = jest.fn((config: InternalAxiosRequestConfig) => config);
    const onResponse = jest.fn((res) => res);
    interceptors.request.use(onRequest);
    interceptors.response.use(onResponse);

    const http = createApiHttpClient({
      baseURL: 'https://api.test',
      interceptors,
      retry: { retries: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
    });
    let calls = 0;
    http.defaults.adapter = async (config) => {
      calls += 1;
      return respond(calls === 1 ? 503 : 200, { ok: true })(config);
    };

    const res = await http.get('/gigs');
    expect(res.data).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });
});
