import { CoinGecko } from "./coingecko";
import { CoinMarketCap } from "./coinmarketcap";

// Must match each exchanger's exchangerDetails().id and the `acurast.fiat.exchangerId`
// setting (default 2 = CoinGecko). byId() resolves on these numeric ids.
export enum ExchangeId {
  CoinMarketCap = 1,
  CoinGecko = 2,
}

export interface FiatCurrency {
  id: string;
  name: string;
  sign: string;
  symbol: string;
}

export interface FiatListResponse {
  data: FiatCurrency[];
  timestamp: string; // ISO 8601
}

export interface ExchangerInfo {
  name: string,
  id: number
}

export interface IExchanger {
  getListOfFiat(): Promise<FiatListResponse>;
  getACUIDToken(): string;
  /** Returns the current ACU price in the given fiat (default "usd"). */
  getACULatestPrice(fiat?: string): Promise<number>;
  exchangerDetails(): ExchangerInfo;
  setApiKey(apiKey: string): void;
}


export class Exchanger {
  supportedExchanger: IExchanger[] = [new CoinMarketCap(), new CoinGecko()];

  // use to know how to show the list of exchange in the UI
  public getSupportedExchanger(): ExchangerInfo[] {
    return this.supportedExchanger.map(x => x.exchangerDetails());
  }

  public byId(id: number): IExchanger | undefined {
    return this.supportedExchanger.find(x => x.exchangerDetails().id === id);
  }
}
