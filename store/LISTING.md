# Chrome Web Store listing (copy and paste)

## Name
BulkGen for Flow

## Summary (132 characters max)
Queue many video prompts in Flow at once. Keeps the queue full and saves every finished video to Downloads automatically.

## Category
Productivity (Tools also fits)

## Language
English

## Description
BulkGen turns Flow into a batch video maker. Paste all your prompts once, pick your settings, click Start, and walk away. BulkGen sends the prompts one after another, keeps Flow's queue full, and saves each finished video to your Downloads folder with a clear name.

What it does
- One prompt per line, or separate longer prompts with a line containing ---
- Character and world notes and a style line added to every prompt, so a series stays consistent
- Reads the models Flow offers and lets you pick one; seconds, resolution and aspect follow the model
- Optional reference images (Ingredients) attached to every prompt, for models that accept them
- Keeps up to "At once" videos generating at the same time
- Saves files as Downloads/BulkGen/flow_001_title.mp4, numbered in prompt order even when videos finish out of order
- Checks Flow's credit estimate before sending and stops if a video would cost more than your limit
- Pause, Resume and Stop at any time; a page reload resumes where it left off
- Retries failed downloads and tells you clearly when it gives up
- "Test with 1 prompt" button and a log you can export

How to use
1. Open your project on flow.google.com.
2. Click the BulkGen icon to open the side panel.
3. Paste your prompts, choose model and settings, and click Start.

Good to know
- You need your own Flow account and credits. Every video uses credits as Flow shows them.
- While a run is going, Chrome shows a bar saying BulkGen is debugging the tab. BulkGen uses this only to click Flow's buttons, because Flow ignores clicks from scripts. Keep DevTools closed on the Flow tab during a run.
- The first time, Chrome may ask whether flow.google.com may download multiple files. Choose Allow.

Privacy: everything stays in your browser. No servers, no analytics, no data collection.

BulkGen for Flow is an independent project and is not made, endorsed or supported by Google.

## Single purpose (Privacy practices tab)
Automates sending a list of video prompts to the Flow website the user has open and downloads the resulting videos to the user's computer.

## Permission justifications (Privacy practices tab)

debugger:
Flow ignores clicks sent by scripts on its generate and download buttons. BulkGen attaches the debugger only to the user's own Flow tab during a run and sends only mouse click events (Input.dispatchMouseEvent) at the button's position. It reads nothing through the debugger and detaches when the run ends.

downloads:
Saves each finished video into a BulkGen folder in Downloads with a name based on the prompt order and title, and tracks whether each download completed so it can retry. Also used for the "Export log" button.

storage:
Keeps the user's prompts, settings, run progress and log on the device so a run survives a page reload or browser restart.

unlimitedStorage:
The user's reference images are stored locally as image data and can go past the default storage limit.

sidePanel:
The extension's controls are shown in Chrome's side panel next to the Flow page.

scripting:
Injects the extension's own content script into a Flow tab that was already open before the extension was installed or updated, so the user does not have to reload the page.

Host permissions (flow.google.com, labs.google/fx):
The extension only works on Flow. It needs to read the Flow page to type prompts, choose settings, see when videos are finished and click their download buttons.

Remote code:
No, I am not using remote code. All code is included in the package.

## Data usage (Privacy practices tab)
Collected data types: tick none. The extension does not collect or transmit user data. Prompts and reference images are only entered into the Flow page by the user's own request and stay on the device otherwise.
Certify all three statements (not sold, not used for unrelated purposes, not used for credit decisions).

## Privacy policy URL
https://github.com/mmd-rehan/bulkgen-flow-extention/blob/main/PRIVACY.md

## Images
- Store icon: extension/icons/icon128.png
- Screenshot: store/screenshot-1280x800.png (add 1 to 4 more real screenshots of a run if you can)
- Small promo tile: store/promo-small-440x280.png
