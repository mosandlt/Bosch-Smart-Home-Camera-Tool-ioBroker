// Augment the ioBroker AdapterConfig type with adapter-specific settings
// populated from admin/jsonConfig.json

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Bosch SingleKey ID email address */
            username: string;
            /** Bosch SingleKey ID password */
            password: string;
            /** Cloud region: "EU" | "US" */
            region: string;
        }
    }
}

export {};
