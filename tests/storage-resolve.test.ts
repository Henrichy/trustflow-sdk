import axios from 'axios';
import { IPFSStorage } from '../src/storage/ipfs';
import { TrustFlowError } from '../src/errors';

describe('IPFSStorage.resolve - Issue #348', () => {
  const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const expectedData = { title: 'TrustFlow Agreement', amount: 500 };
  let getSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    getSpy = jest.spyOn(axios, 'get');
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  it('resolves valid JSON from the primary gateway', async () => {
    getSpy.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: expectedData,
    });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com', 'https://gw2.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(
      `https://gw1.example.com/ipfs/${cid}`,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('falls back to secondary gateway when primary returns empty body', async () => {
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: '', // empty body
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: expectedData,
      });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com', 'https://gw2.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to secondary gateway when primary returns HTML error page', async () => {
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        data: '<html><body>502 Bad Gateway</body></html>',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: expectedData,
      });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com', 'https://gw2.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to secondary gateway when response is HTML string even without text/html header', async () => {
    getSpy
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: '<!DOCTYPE html><html><head><title>Error</title></head></html>',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: expectedData,
      });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com', 'https://gw2.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('parses stringified JSON when gateway returns JSON as text', async () => {
    getSpy.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      data: JSON.stringify(expectedData),
    });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
  });

  it('falls back when primary gateway encounters a network or HTTP error', async () => {
    getSpy
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: expectedData,
      });

    const storage = new IPFSStorage({
      gateways: ['https://gw1.example.com', 'https://gw2.example.com'],
    });

    const result = await storage.resolve<typeof expectedData>(cid);
    expect(result).toEqual(expectedData);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('throws TrustFlowError with code STORAGE_GATEWAY_ERROR when all gateways fail', async () => {
    getSpy
      .mockRejectedValueOnce(new Error('Gateway 1 down'))
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: '<html>Error</html>',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: '',
      });

    const storage = new IPFSStorage({
      gateways: [
        'https://gw1.example.com',
        'https://gw2.example.com',
        'https://gw3.example.com',
      ],
    });

    await expect(storage.resolve(cid)).rejects.toThrow(TrustFlowError);

    try {
      await storage.resolve(cid);
    } catch (err) {
      expect(err).toBeInstanceOf(TrustFlowError);
      const tfErr = err as TrustFlowError;
      expect(tfErr.code).toBe('STORAGE_GATEWAY_ERROR');
      expect(tfErr.message).toContain(cid);
    }
  });

  it('rejects invalid CIDs before querying gateways', async () => {
    const storage = new IPFSStorage();
    await expect(storage.resolve('invalid-cid')).rejects.toThrow(TrustFlowError);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
