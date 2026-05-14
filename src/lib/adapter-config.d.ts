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
            /**
             * Expose the per-camera TLS proxy to the LAN (bind 0.0.0.0).
             * Default false — proxy listens on 127.0.0.1 only.
             * Enable when an external recorder (BlueIris, Frigate, etc.)
             * on a separate host needs to pull the stream. Forum #84538.
             */
            rtsp_expose_to_lan?: boolean;
            /**
             * Hostname / IP that the published `stream_url` should use when
             * `rtsp_expose_to_lan` is on. Typically the ioBroker host's LAN
             * IP, e.g. "192.168.1.50". Empty / unset → falls back to
             * "127.0.0.1".
             */
            rtsp_external_host?: string;
            /**
             * v0.5.3: when true (default), every motion / person / audio_alarm
             * event (via FCM push or polling fallback) auto-fetches a fresh
             * snapshot and writes a base64 copy into
             * `cameras.<id>.last_event_image` for direct
             * Telegram/Signal/Matrix push consumption.
             */
            auto_snapshot_on_motion?: boolean;
        }
    }
}

export {};
