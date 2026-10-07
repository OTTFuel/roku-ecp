import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EcpClient, EcpScreenshotError } from '../client.js';
import { EcpAuthError } from '../errors.js';
import { digestGet, digestUpload } from '../digest.js';

vi.mock('../digest.js', () => ({ digestGet: vi.fn(), digestUpload: vi.fn() }));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = Buffer.from([255, 216, 255, 224, 0]);
const client = new EcpClient('192.168.0.4', { devPassword: 'test-password' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(digestUpload).mockResolvedValue('Screenshot ok');
});

describe('takeScreenshot', () => {
  it('downloads the JPEG named by the capture response without probing stale PNG', async () => {
    vi.mocked(digestUpload).mockResolvedValue('<img src="/pkgs/dev.jpg?time=123&amp;x=1">');
    vi.mocked(digestGet).mockResolvedValue(jpeg);
    expect(await client.takeScreenshot()).toEqual(jpeg);
    expect(digestGet).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(digestGet).mock.calls[0][0]);
    expect(url.pathname).toBe('/pkgs/dev.jpg');
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('time')).not.toBe('123');
    expect(digestGet).toHaveBeenCalledWith(url.href, 'rokudev', 'test-password');
  });

  it('accepts a relative PNG link', async () => {
    vi.mocked(digestUpload).mockResolvedValue("<a href='pkgs/dev.png'>Screenshot</a>");
    vi.mocked(digestGet).mockResolvedValue(png);
    expect(await client.takeScreenshot()).toEqual(png);
    expect(new URL(vi.mocked(digestGet).mock.calls[0][0]).pathname).toBe('/pkgs/dev.png');
  });

  it('keeps downloads on the configured device for absolute response URLs', async () => {
    vi.mocked(digestUpload).mockResolvedValue('<img src="http://other-host/pkgs/dev.jpg">');
    vi.mocked(digestGet).mockResolvedValue(jpeg);
    await client.takeScreenshot();
    expect(new URL(vi.mocked(digestGet).mock.calls[0][0]).hostname).toBe('192.168.0.4');
  });

  it('uses PNG when the capture response has no image path', async () => {
    vi.mocked(digestGet).mockResolvedValue(png);
    expect(await client.takeScreenshot()).toEqual(png);
    expect(digestGet).toHaveBeenCalledTimes(1);
  });

  it('falls back to JPEG only when the PNG path is missing', async () => {
    vi.mocked(digestGet).mockRejectedValueOnce(new EcpAuthError('not found', 404)).mockResolvedValueOnce(jpeg);
    expect(await client.takeScreenshot()).toEqual(jpeg);
    expect(vi.mocked(digestGet).mock.calls.map(([url]) => new URL(url).pathname))
      .toEqual(['/pkgs/dev.png', '/pkgs/dev.jpg']);
  });

  it.each([401, 403, 500])('preserves HTTP %i errors without fallback', async status => {
    const error = new EcpAuthError('failure', status);
    vi.mocked(digestGet).mockRejectedValue(error);
    await expect(client.takeScreenshot()).rejects.toBe(error);
    expect(digestGet).toHaveBeenCalledTimes(1);
  });

  it('preserves network errors without fallback', async () => {
    const error = new TypeError('network failed');
    vi.mocked(digestGet).mockRejectedValue(error);
    await expect(client.takeScreenshot()).rejects.toBe(error);
    expect(digestGet).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to a potentially stale image when a reported path fails', async () => {
    vi.mocked(digestUpload).mockResolvedValue('<img src="/pkgs/dev.jpg">');
    vi.mocked(digestGet).mockRejectedValue(new EcpAuthError('not found', 404));
    await expect(client.takeScreenshot()).rejects.toThrow('not found');
    expect(digestGet).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error when neither image exists', async () => {
    vi.mocked(digestGet).mockRejectedValue(new EcpAuthError('not found', 404));
    await expect(client.takeScreenshot()).rejects.toThrow('not found');
    expect(digestGet).toHaveBeenCalledTimes(2);
  });

  it.each([Buffer.from('<html>error</html>'), Buffer.from([137, 80]), Buffer.alloc(0)])
    ('rejects non-image responses', async image => {
      vi.mocked(digestGet).mockResolvedValue(image);
      await expect(client.takeScreenshot()).rejects.toBeInstanceOf(EcpScreenshotError);
    });

  it('does not download if screenshot generation fails', async () => {
    vi.mocked(digestUpload).mockRejectedValue(new Error('capture failed'));
    await expect(client.takeScreenshot()).rejects.toThrow('capture failed');
    expect(digestGet).not.toHaveBeenCalled();
  });
});
