# Blockly Examples

Ready-to-import Blockly scripts for common automation patterns with this
adapter. Copy the XML, open the **javascript** adapter → **Scripts** → new
**Blockly** script → click the **XML** icon in the toolbar → paste → done.

Before running each example, replace every `<CAM_UUID>` placeholder with your
actual camera ID (visible under `bosch-smart-home-camera.0.cameras.<UUID>` in
the Objects tab).

## Available examples

| File | Purpose |
| --- | --- |
| [`master-wallwasher-switch.xml`](./master-wallwasher-switch.xml) | One virtual datapoint `0_userdata.0.master_wallwasher` drives the wallwasher of every camera in lock-step. Toggle once, all four light up. |
| [`dusk-auto-wallwasher.xml`](./dusk-auto-wallwasher.xml) | Sun-elevation trigger: wallwasher turns on at dusk, off at dawn. No manual schedule, follows the seasons automatically. |
| [`hue-pir-to-bosch-motion.xml`](./hue-pir-to-bosch-motion.xml) | Bridge a Philips Hue motion sensor into a synthetic Bosch motion event so existing motion-driven scripts fire immediately, before the Bosch cam itself detects anything. |

## Master-wallwasher prerequisites

`0_userdata.0.master_wallwasher` (boolean, read+write) needs to exist. Create
it once via Objects → Custom → `+` → State, type `boolean`, role `switch.light`.
Or import [`master-wallwasher-userdata.xml`](./master-wallwasher-userdata.xml)
into Objects → Custom to set it up.

## Dusk trigger prerequisites

The Astro feature requires that the **javascript** adapter has lat/lon
configured (Instances → javascript.0 → settings tab). The example uses sun
elevation −5° (civil twilight) as the threshold — tweak via the `astro` block
inside the script if you want darker / lighter cut-off.

## Notes

- All examples are written for the JavaScript adapter's Blockly editor
  (`iobroker.javascript`). They will not import into the Node-RED adapter as-is.
- The Bosch adapter instance is hardcoded to `bosch-smart-home-camera.0` in the
  examples. If you run multiple instances, search-and-replace before saving.
- After import, **always click "Save" then "Run"** in the Blockly editor — the
  script only takes effect once it's running.
