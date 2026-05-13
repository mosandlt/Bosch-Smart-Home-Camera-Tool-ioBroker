/**
 * Shared ioBroker.Adapter mock helper for unit tests.
 *
 * Uses @iobroker/testing v4.x API:
 *   utils.unit.createMocks(adapterOptions) → { database, adapter }
 *
 * The adapter.config field is populated via adapterOptions.config.
 * Call createAdapterMock() in beforeEach for full test isolation.
 */

import { utils } from "@iobroker/testing";

export interface BoschCameraAdapterConfig {
    username: string;
    password: string;
    region: string;
    [key: string]: unknown;
}

/**
 * Returns a fresh MockAdapter instance for each test.
 * The adapter's config is pre-populated with sensible defaults that can be
 * overridden via configOverrides.
 *
 * @example
 * let adapter: ReturnType<typeof createAdapterMock>;
 * beforeEach(() => { adapter = createAdapterMock(); });
 */
export function createAdapterMock(
    configOverrides: Partial<BoschCameraAdapterConfig> = {},
): ReturnType<typeof utils.unit.createMocks>["adapter"] {
    const config: BoschCameraAdapterConfig = {
        username: "test@example.com",
        password: "secret",
        region: "EU",
        ...configOverrides,
    };

    const { adapter } = utils.unit.createMocks({ config } as Partial<ioBroker.AdapterOptions>);
    return adapter;
}
