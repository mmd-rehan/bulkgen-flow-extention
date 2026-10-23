# BulkGen for Flow

Chrome extension that queues many video prompts in Flow (flow.google.com), keeps the queue full and saves every finished video to Downloads/BulkGen automatically.

## Folders

- `extension/` the Chrome extension (load this folder unpacked in chrome://extensions)
- `website/` landing page design
- `store/` Chrome Web Store listing text and images
- `PRIVACY.md` privacy policy
- `build.sh` builds the store upload zip into `dist/`

## Develop

1. Open chrome://extensions and turn on Developer mode.
2. Click "Load unpacked" and choose the `extension` folder.
3. Open your Flow project and click the BulkGen icon to open the side panel.

## Release

1. Bump `version` in `extension/manifest.json`.
2. Run `./build.sh`.
3. Upload `dist/bulkgen-flow-<version>.zip` in the Chrome Web Store developer dashboard.

BulkGen for Flow is an independent project and is not made, endorsed or supported by Google.
