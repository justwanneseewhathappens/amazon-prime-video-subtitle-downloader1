Amazon Prime Video Subtitle Downloader (APVSD)

Download every subtitle track from any Amazon Prime Video title — movies and full seasons — as a single ZIP, with SRT, TTML and VTT output, live progress, and SDH / CC / Forced detection.

✨ Features


• One-click ZIP download of every subtitle track on the current title

• Multi-format export: SRT, TTML and VTT bundled together

• Full season capture — toggle Start season capture and every episode you open is auto-added to a single season ZIP

• Smart labelling — SDH, CC and Forced tracks are detected and tagged in filenames

• Live progress panel with per-track status and error reporting

🌐 Compatibility

• Chrome / Chromium (Brave, Arc, Opera, Vivaldi, …)

• Microsoft Edge

• Firefox

• Safari (via Userscripts app)

Userscript managers

• Tampermonkey ✅ recommended
• Violentmonkey ✅
• Greasemonkey 4+ ✅
• Userscripts (Safari) ✅

An active Prime Video subscription and access to the title you want subtitles from
Playback must actually start at least once — the script captures subtitle manifests from Prime's playback requests

🚀 How to use
1. Install a userscript manager
Install Tampermonkey or Violentmonkey in your browser.

2. Install the script
From Greasy Fork: click Install this script, or
From GitHub: Open [`amazon-prime-subtitle-downloader-v4.6.0.user.js`](amazon-prime-subtitle-downloader-v4.6.0.user.js) and click **Raw** — your userscript manager will prompt to install.
If your browser blocks the one-click install (Chrome/Edge often do), download the .user.js file and drag it onto your userscript manager's dashboard.

3. Open a title on Prime Video
Go to any movie or episode on primevideo.com or amazon.* and press play for a moment. The script needs playback to start so it can intercept the subtitle manifest.

4. Open the APVSD panel
A small floating APVSD panel appears in the corner. It lists every subtitle track it has detected, with language, format and SDH/CC/Forced tags.

5. Download
Single title (movie or one episode):

Tick the languages / formats you want.
Click Download ZIP.
You'll get Title - Language.srt (+ .ttml / .vtt) bundled in one ZIP.

Whole season:

1. Enable Start season capture in the panel.

2. Open each episode of the season and let playback start for a second — the panel confirms Stored: SxxExx – Episode Title.

3. Repeat for every episode you want (order doesn't matter, duplicates are ignored).

4. Click Download season ZIP to get one archive with all captured episodes, correctly named.

5. Toggle capture off (buffer is kept until you download or clear it manually) or click Clear buffer to start over.

❓ Troubleshooting

• Panel is empty — press play on the title for a few seconds, then reopen the panel. Prime only serves subtitle manifests after playback initialises.


• Season ZIP only has one episode — make sure Start season capture is enabled before opening each episode, and wait until you see the Stored: confirmation before switching.


• Wrong episode name — refresh the episode page and let playback start; metadata is re-fetched from Prime's detail API on each new playback.


• Chrome blocks install — download the .user.js file and drag it into Tampermonkey's Installed userscripts tab.


📄 License

• MIT — free to use, modify and redistribute. Not affiliated with Amazon or Prime Video.
