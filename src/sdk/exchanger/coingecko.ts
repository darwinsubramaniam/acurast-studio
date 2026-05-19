import type { ExchangerInfo, FiatListResponse, IExchanger } from "./exchanger";

// CoinGecko auth: https://docs.coingecko.com/v3.0.1/reference/authentication
// - Public (no key): api.coingecko.com/api/v3 — no auth header
// - Demo plan:       api.coingecko.com/api/v3     with header `x-cg-demo-api-key`
// - Pro plan:        pro-api.coingecko.com/api/v3 with header `x-cg-pro-api-key`
const DEMO_BASE_URL = "https://api.coingecko.com/api/v3";
const PRO_BASE_URL = "https://pro-api.coingecko.com/api/v3";
const ACU_ID = "acurast";

export type CoinGeckoPlan = "demo" | "pro";

type CgExchangeRate = { name: string; unit: string; value: number; type: string };
type CgExchangeRatesResponse = { rates: Record<string, CgExchangeRate> };

export class CoinGecko implements IExchanger {

    constructor(private plan: CoinGeckoPlan = "demo") { }

    private apiKey?: string;

    setPlan(plan: CoinGeckoPlan): void {
        this.plan = plan;
    }

    getPlan(): CoinGeckoPlan {
        return this.plan;
    }

    exchangerDetails(): ExchangerInfo {
        return {
            name: "CoinGecko",
            id: 2
        };
    }

    setApiKey(apiKey: string): void {
        this.apiKey = apiKey;
    }

    async getListOfFiat(): Promise<FiatListResponse> {
        this.validatePlan();
        const res = await fetch(`${this.baseUrl()}/exchange_rates`, {
            headers: this.headers(),
        });
        if (!res.ok) {
            throw new Error(`CoinGecko exchange_rates failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as CgExchangeRatesResponse;
        const data = Object.entries(json.rates)
            .filter(([, r]) => r.type === "fiat")
            .map(([id, r]) => ({
                id,
                name: r.name,
                sign: r.unit,
                symbol: id.toUpperCase(),
            }));
        return { data, timestamp: new Date().toISOString() };
    }

    getACUIDToken(): string {
        return ACU_ID;
    }

    async getACULatestPrice(fiat: string = "usd"): Promise<number> {
        this.validatePlan();
        const id = this.getACUIDToken();
        const vs = fiat.toLowerCase();
        const res = await fetch(
            `${this.baseUrl()}/simple/price?ids=${id}&vs_currencies=${encodeURIComponent(vs)}`,
            { headers: this.headers() },
        );
        if (!res.ok) {
            throw new Error(`CoinGecko simple/price failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as Record<string, Record<string, number | undefined>>;
        const price = json[id]?.[vs];
        if (price === undefined) {
            throw new Error(`ACU (id=${id}) price not found for fiat=${vs} in CoinGecko response`);
        }
        return price;
    }

    private isApiKeySet(): boolean {
        return Boolean(this.apiKey?.trim());
    }

    private validatePlan(): void {
        if (this.plan === "pro" && !this.isApiKeySet()) {
            throw new Error("CoinGecko Pro plan requires an API key — set one in Settings or switch to Demo (keyless).");
        }
    }

    private baseUrl(): string {
        return this.plan === "pro" ? PRO_BASE_URL : DEMO_BASE_URL;
    }

    private headers(): Record<string, string> {
        if (!this.isApiKeySet()) return {};
        const headerName = this.plan === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key";
        return { [headerName]: this.apiKey! };
    }
}
