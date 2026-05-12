/**
 * Bosch Smart Home Camera — ioBroker Adapter
 *
 * Entry point. Authenticates against Bosch Keycloak (OAuth2 PKCE),
 * discovers cameras via the Bosch Residential Cloud API, and manages
 * ioBroker state objects for each camera entity.
 *
 * Implementation roadmap (skeleton stubs only in v0.1.0):
 *   1. [auth.ts]   OAuth2 PKCE login → access_token + refresh_token
 *   2. [cameras.ts] GET /v1/accounts/{id}/cameras → camera list
 *   3. [states.ts]  Create ioBroker state tree per camera
 *   4. [stream.ts]  Register go2rtc RTSPS sources per camera
 *   5. [fcm.ts]     FCM push registration → motion/audio/person events
 *   6. [digest.ts]  HTTP Digest auth for local camera RCP+ commands
 */
import "./lib/adapter-config";
//# sourceMappingURL=main.d.ts.map