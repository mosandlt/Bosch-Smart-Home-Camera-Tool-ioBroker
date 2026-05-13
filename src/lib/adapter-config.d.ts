// Augment the ioBroker AdapterConfig type with adapter-specific settings
// populated from admin/jsonConfig.json

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /**
             * One-time-use OIDC redirect URL pasted by the user after browser login.
             * Format: "https://www.bosch.com/boschcam?code=XXX&state=YYY"
             * Cleared by the adapter after successful token exchange.
             */
            redirect_url: string;
            /** Cloud region: "EU" | "US" */
            region: string;
        }
    }
}

export {};
