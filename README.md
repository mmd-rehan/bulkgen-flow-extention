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

1. Bump `version` in `extension/manifest.json`, commit and push to `main`.
2. GitHub Actions builds the zip and publishes it as a GitHub Release named `v<version>` (see the Releases page). Pushes that keep the same version do not create a release.
3. Download the zip from the release (or run `./build.sh` locally) and upload it in the Chrome Web Store developer dashboard.

To install without the store: download the zip from the latest release, unzip it, and load the folder with "Load unpacked" in chrome://extensions.

BulkGen for Flow is an independent project and is not made, endorsed or supported by Google.
