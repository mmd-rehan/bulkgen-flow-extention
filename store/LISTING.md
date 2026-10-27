# Chrome Web Store listing (copy and paste)

## Name
BulkGen for Flow

## Summary (132 characters max)
Queue many video prompts in Flow at once. Keeps the queue full, then downloads every video of the project in one click.

## Category
Productivity (Tools also fits)

## Language
English

## Description
BulkGen turns Flow into a batch video maker. Paste all your prompts once, pick your settings, click Start, and walk away. BulkGen sends the prompts one after another, keeps Flow's queue full, and tells you when each video is ready. One click on "Download all videos of this project" then saves them to your Downloads folder with clear names.

Free and open source (MIT license).

WHAT IT DOES
- One prompt per line, or separate longer prompts with a line containing ---
- Character and world notes plus a style line added to every prompt, so a series stays consistent
- Reads the video models Flow offers and sets the one you pick; seconds, resolution and aspect follow that model
- Optional reference images (Ingredients) for models that accept them, matched in order: image 1 goes with prompt 1, image 2 with prompt 2. Any number of images; prompts past the last image go without one
- Keeps up to your "At once" number of videos generating at the same time
- Nothing downloads until you click "Download all videos of this project"
- Saves files as Downloads/BulkGen/flow_001_title.mp4, numbered in prompt order even when videos finish out of order
- Downloads in 720p original or 1080p upscaled, and skips videos saved earlier
- The side panel shows only on Flow tabs and hides on other tabs
- Checks Flow's own credit estimate before sending and sends nothing if a video would cost more than your limit
- Pause, Resume and Stop at any time; if the page reloads, the run picks up where it left off
- Retries failed downloads and tells you clearly when it gives up
- "Test with 1 prompt" button, a log you can export, and a "Copy debug info" button that copies what BulkGen sees on the page for bug reports

HOW TO USE
1. Open your project on flow.google.com.
2. Click the BulkGen icon to open the side panel.
3. Paste your prompts, choose the model and settings, and click Start.

GOOD TO KNOW
- You need your own Flow account and credits. Every video uses credits as Flow shows them.
- While a run is going, Chrome shows a bar saying BulkGen is debugging the tab. BulkGen uses this only to click Flow's buttons, because Flow ignores clicks from scripts. Keep DevTools closed on the Flow tab during a run.
- The first time, Chrome may ask whether flow.google.com may download multiple files. Choose Allow.

PRIVACY
Everything stays in your browser. No servers, no accounts, no analytics, no data collection. BulkGen never asks for your password.

Website: https://bulkgen.mmd-rehan.com
Source code and issues: https://github.com/mmd-rehan/bulkgen-flow-extention

BulkGen for Flow is an independent project and is not made, endorsed or supported by Google.

## Homepage URL
https://bulkgen.mmd-rehan.com

## Support URL
https://github.com/mmd-rehan/bulkgen-flow-extention/issues

## Single purpose (Privacy practices tab)
Automates sending a list of video prompts to the Flow website the user has open and, when the user clicks the download button, downloads the project's videos to the user's computer.

## Permission justifications (Privacy practices tab)

debugger:
Flow ignores clicks sent by scripts on its generate and download buttons. BulkGen attaches the debugger only to the user's own Flow tab during a run and sends only mouse click events (Input.dispatchMouseEvent) at the button's position. It reads nothing through the debugger and detaches when the run ends.

downloads:
When the user clicks "Download all videos of this project", saves each video into a BulkGen folder in Downloads with a name based on the prompt order and title, and tracks whether each download completed so it can retry. Also used for the "Export log" button, and to save the debug info as a file when the clipboard is not available.

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
https://bulkgen.mmd-rehan.com/privacy

## Images
- Store icon: extension/icons/icon128.png
- Screenshot: store/screenshot-1280x800.png (add 1 to 4 more real screenshots of a run if you can)
- Small promo tile: store/promo-small-440x280.png
