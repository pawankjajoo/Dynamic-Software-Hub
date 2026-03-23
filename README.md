# Software Hub

Checks latest versions of software we care about (TrackIR, SimHub, Fanatec drivers, NVIDIA, AMD, Pimax, etc.) and updates an HTML dashboard.

## How it works

Three-tier scraping approach because vendor websites are all over the place:
1. Normal HTTP requests with stealth headers (works for most)
2. cloudscraper for Cloudflare-protected sites
3. Playwright headless Chromium for JavaScript-rendered pages

Each page gets run through 6 different parse strategies in parallel — heading tags, download links, class/data attributes, JSON-LD, keyword proximity, and a broad regex fallback with confidence scoring. Takes the highest-confidence match.

## Usage

```
pip install -r requirements.txt
python pss_tools_updater.py
python pss_tools_updater.py --only trackir,simhub
python pss_tools_updater.py --dry-run
```

Rate limited to 1-2.5s between requests so we don't get blocked.
