import type { ExchangerInfo, FiatListResponse, IExchanger } from "./exchanger";

const BASE_URL = "https://pro-api.coinmarketcap.com";
const ACU_UCID = "36492";

type CmcFiat = { id: number; name: string; sign: string; symbol: string };
type CmcFiatMapResponse = { data: CmcFiat[]; status: { timestamp: string } };
type CmcQuote = { quote: Record<string, { price: number }> };
type CmcQuotesResponse = { data: Record<string, CmcQuote> };

export class CoinMarketCap implements IExchanger {

    constructor() { }

    private apiKey?: string

    exchangerDetails(): ExchangerInfo {
        return {
            name: "CoinMarketCap",
            id: 1
        }
    }


    setApiKey(apiKey: string) {
        this.apiKey = apiKey;
    }

    async getListOfFiat(): Promise<FiatListResponse> {
        this.validateInit()
        const res = await fetch(`${BASE_URL}/v1/fiat/map`, {
            headers: { "X-CMC_PRO_API_KEY": this.apiKey! },
        });
        if (!res.ok) {
            throw new Error(`CoinMarketCap fiat/map failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as CmcFiatMapResponse;
        return {
            data: json.data.map(c => ({
                id: String(c.id),
                name: c.name,
                sign: c.sign,
                symbol: c.symbol,
            })),
            timestamp: json.status.timestamp,
        };
    }

    getACUIDToken(): string {
        return ACU_UCID;
    }

    async getACULatestPrice(fiat: string = "usd"): Promise<number> {
        this.validateInit()
        const ucid = this.getACUIDToken();
        const convert = fiat.toUpperCase();
        const res = await fetch(
            `${BASE_URL}/v2/cryptocurrency/quotes/latest?id=${ucid}&convert=${encodeURIComponent(convert)}`,
            { headers: { "X-CMC_PRO_API_KEY": this.apiKey! } },
        );
        if (!res.ok) {
            throw new Error(`CoinMarketCap quotes/latest failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as CmcQuotesResponse;
        const entry = json.data[ucid];
        if (!entry) {
            throw new Error(`ACU (ucid=${ucid}) not found in CoinMarketCap response`);
        }
        const quote = entry.quote[convert];
        if (!quote) {
            throw new Error(`ACU quote for fiat=${convert} not found in CoinMarketCap response`);
        }
        return quote.price;
    }

    private isApiKeySet(): boolean {
        return Boolean(this.apiKey?.trim())
    }

    private validateInit() {
        if (!this.isApiKeySet()) {
            throw new Error("CoinMarketCap API Key was not set")
        }
    }
}
