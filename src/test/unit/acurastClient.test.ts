import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcurastClient } from '../../sdk/acurastClient';
import { RPC_ENDPOINTS } from '../../sdk/constants';

const { mockConnect, mockDisconnect, mockGetBalance, mockApi } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockDisconnect: vi.fn().mockResolvedValue(undefined),
  mockGetBalance: vi.fn().mockResolvedValue(42),
  mockApi: {},
}));

vi.mock('@acurast/sdk/chain', () => ({
  AcurastService: vi.fn().mockImplementation(function (rpc: string) {
    return { rpc, connect: mockConnect, disconnect: mockDisconnect, api: mockApi };
  }),
  getBalance: mockGetBalance,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockGetBalance.mockResolvedValue(42);
});

describe('AcurastClient', () => {
  describe('getRpc / configure', () => {
    it('uses the default RPC endpoint when no overrides are configured', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      await client.service('mainnet');
      expect(AcurastService).toHaveBeenCalledWith(RPC_ENDPOINTS.mainnet);
    });

    it('uses override when configure provides one', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      client.configure(() => ({ mainnet: 'wss://my-custom-rpc.example.com' }));
      await client.service('mainnet');
      expect(AcurastService).toHaveBeenCalledWith('wss://my-custom-rpc.example.com');
    });

    it('falls back to default RPC for networks not in override', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      client.configure(() => ({ mainnet: 'wss://custom.example.com' }));
      await client.service('canary');
      expect(AcurastService).toHaveBeenCalledWith(RPC_ENDPOINTS.canary);
    });
  });

  describe('service()', () => {
    it('calls connect on first access', async () => {
      const client = new AcurastClient();
      await client.service('mainnet');
      expect(mockConnect).toHaveBeenCalledOnce();
    });

    it('reuses the same service instance on subsequent calls', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      await client.service('mainnet');
      await client.service('mainnet');
      expect(AcurastService).toHaveBeenCalledOnce();
    });

    it('creates separate services per network', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      await client.service('mainnet');
      await client.service('canary');
      expect(AcurastService).toHaveBeenCalledTimes(2);
    });
  });

  describe('getBalance()', () => {
    it('delegates to SDK getBalance with the resolved api', async () => {
      const client = new AcurastClient();
      const result = await client.getBalance('mainnet', 'some-address');
      expect(mockGetBalance).toHaveBeenCalledWith(mockApi, 'some-address');
      expect(result).toBe(42);
    });
  });

  describe('dispose()', () => {
    it('disconnects all active services and clears them', async () => {
      const client = new AcurastClient();
      await client.service('mainnet');
      await client.service('canary');
      await client.dispose();
      expect(mockDisconnect).toHaveBeenCalledTimes(2);
    });

    it('does not throw when no services are active', async () => {
      const client = new AcurastClient();
      await expect(client.dispose()).resolves.toBeUndefined();
    });

    it('creates a fresh service after dispose', async () => {
      const { AcurastService } = await import('@acurast/sdk/chain');
      const client = new AcurastClient();
      await client.service('mainnet');
      await client.dispose();
      await client.service('mainnet');
      expect(AcurastService).toHaveBeenCalledTimes(2);
    });
  });
});
