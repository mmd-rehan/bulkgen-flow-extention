# BulkGen for Flow: Privacy Policy

Last updated: 24 October 2026

BulkGen for Flow ("the extension") is a browser extension that helps you send many video prompts to Flow (flow.google.com) and save the finished videos to your computer.

## What the extension stores

Everything stays in your own browser, in Chrome's local extension storage:

- the prompts, character notes, style text and settings you type into the side panel
- the reference images you choose (shrunk copies, so they can be attached to each prompt)
- the progress of the current run and a log of what the extension did
- the address of the last Flow project you used, and the list of models Flow offers

You can clear all of this at any time by removing the extension.

## What the extension sends, and where

- Your prompts and reference images go only to Flow, the same way they would if you typed or uploaded them yourself. Google's own terms and privacy policy apply to what you send to Flow.
- Finished videos are saved to your Downloads folder, in a BulkGen subfolder.
- The extension has no server of its own. It does not collect, sell, share or transmit any personal data, browsing history or usage statistics to the developer or to any third party. It contains no analytics and no ads, and it loads no remote code.

## Permissions

- **Flow pages (flow.google.com, labs.google/fx):** to fill in prompts, choose settings and find finished videos on the Flow page you have open.
- **debugger:** to click Flow's buttons the way a real mouse click would, because Flow ignores clicks sent by scripts. The extension only uses it on your Flow tab, only for mouse clicks, and only while a run is going. Chrome shows a notice bar while this is active.
- **downloads:** to save each finished video with a clear name such as `BulkGen/flow_001_title.mp4`.
- **storage, unlimitedStorage:** to keep your settings, queue and reference images locally.
- **sidePanel:** to show the extension's controls next to the Flow page.
- **scripting:** to restart the extension's helper on a Flow tab that was open before the extension was installed or updated.

## Contact

Questions: open an issue at https://github.com/mmd-rehan/bulkgen-flow-extention/issues

BulkGen for Flow is an independent project and is not made, endorsed or supported by Google.
