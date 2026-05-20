import { describe, it, expect } from 'vitest';
import { Exchanger } from '../../sdk/exchanger/exchanger';
import { CoinGecko } from '../../sdk/exchanger/coingecko';
import { CoinMarketCap } from '../../sdk/exchanger/coinmarketcap';

describe('Exchanger registry', () => {
  const exchanger = new Exchanger();

  it('lists two supported exchangers', () => {
    const list = exchanger.getSupportedExchanger();
    expect(list).toHaveLength(2);
  });

  it('byId(1) returns CoinMarketCap', () => {
    const e = exchanger.byId(1);
    expect(e?.exchangerDetails().name).toBe('CoinMarketCap');
  });

  it('byId(2) returns CoinGecko', () => {
    const e = exchanger.byId(2);
    expect(e?.exchangerDetails().name).toBe('CoinGecko');
  });

  it('byId with unknown id returns undefined', () => {
    expect(exchanger.byId(99)).toBeUndefined();
  });
});

describe('CoinGecko', () => {
  it('returns correct exchanger details', () => {
    const cg = new CoinGecko();
    expect(cg.exchangerDetails()).toEqual({ name: 'CoinGecko', id: 2 });
  });

  it('defaults to demo plan', () => {
    expect(new CoinGecko().getPlan()).toBe('demo');
  });

  it('setPlan changes the plan', () => {
    const cg = new CoinGecko();
    cg.setPlan('pro');
    expect(cg.getPlan()).toBe('pro');
  });

  it('returns the correct ACU token id', () => {
    expect(new CoinGecko().getACUIDToken()).toBe('acurast');
  });

  it('pro plan without API key throws on getListOfFiat', async () => {
    const cg = new CoinGecko('pro');
    await expect(cg.getListOfFiat()).rejects.toThrow('API key');
  });

  it('pro plan without API key throws on getACULatestPrice', async () => {
    const cg = new CoinGecko('pro');
    await expect(cg.getACULatestPrice()).rejects.toThrow('API key');
  });
});

describe('CoinMarketCap', () => {
  it('returns correct exchanger details', () => {
    const cmc = new CoinMarketCap();
    expect(cmc.exchangerDetails()).toEqual({ name: 'CoinMarketCap', id: 1 });
  });

  it('returns the correct ACU UCID token', () => {
    expect(new CoinMarketCap().getACUIDToken()).toBe('36492');
  });

  it('throws on getListOfFiat when API key is not set', async () => {
    const cmc = new CoinMarketCap();
    await expect(cmc.getListOfFiat()).rejects.toThrow('API Key');
  });

  it('throws on getACULatestPrice when API key is not set', async () => {
    const cmc = new CoinMarketCap();
    await expect(cmc.getACULatestPrice()).rejects.toThrow('API Key');
  });
});
