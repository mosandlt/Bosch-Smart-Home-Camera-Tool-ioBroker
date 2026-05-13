/**
 * Shared axios mock helpers for unit tests.
 *
 * Uses axios.defaults.adapter (the officially supported mock point for axios v1.x)
 * so stubs intercept both `axios(config)` and `axios.request(config)` call forms.
 */

import axios, {
    type AxiosResponse,
    type AxiosAdapter,
    type InternalAxiosRequestConfig,
} from "axios";

let _savedAdapter: AxiosAdapter | string | readonly (string | AxiosAdapter)[] | undefined;

/**
 * Creates an axios adapter stub that responds with the given sequence of
 * responses. Each call to axios returns the next response in order.
 * Call `restoreAxios()` in afterEach.
 */
export function stubAxiosSequence(responses: Array<Partial<AxiosResponse>>): void {
    _savedAdapter = axios.defaults.adapter;
    let callIndex = 0;
    axios.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
        const resp = responses[callIndex++];
        if (!resp) {
            return Promise.reject(
                new Error(`stubAxiosSequence: no response configured for call #${callIndex}`),
            );
        }
        return Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: {},
            data: null,
            config,
            request: {},
            ...resp,
        } as AxiosResponse);
    };
}

/**
 * Creates an axios adapter stub that rejects every call with an HTTP error.
 * Call `restoreAxios()` in afterEach.
 */
export function stubAxiosError(status: number, body?: unknown): void {
    _savedAdapter = axios.defaults.adapter;
    axios.defaults.adapter = (_config: InternalAxiosRequestConfig): Promise<never> => {
        const error: Error & {
            response?: { status: number; data: unknown; headers: Record<string, string> };
            isAxiosError?: boolean;
        } = new Error(`Request failed with status code ${status}`);
        error.response = { status, data: body ?? null, headers: {} };
        error.isAxiosError = true;
        return Promise.reject(error);
    };
}

/**
 * Restores the original axios adapter. Call in afterEach.
 */
export function restoreAxios(): void {
    if (_savedAdapter !== undefined) {
        axios.defaults.adapter = _savedAdapter as AxiosAdapter;
        _savedAdapter = undefined;
    }
}
