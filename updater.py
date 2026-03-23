#!/usr/bin/env python3
"""
PSS Software Hub — Adaptive Link & Version Updater
===================================================

Scrapling-inspired adaptive web scraper that checks each software tile's
download page for the latest version and download links — even if the page
layout changes, elements rearrange, or Cloudflare protection is active.

FETCH STRATEGY (escalating):
  1. Stealth HTTP      — requests + real-browser headers (fast, low footprint)
  2. Cloudflare bypass — cloudscraper with JS challenge solver
  3. Headless browser  — Playwright Chromium (full JS rendering, anti-bot stealth)
     Sites that are known SPAs / JS-heavy go straight to tier 3.

PARSE STRATEGY (adaptive, survives redesigns):
  a. Headings & page titles
  b. Download button / link text + href
  c. Elements with version-related class/id/data attributes
  d. Hint-keyword proximity search
  e. JSON-LD / structured data / meta tags
  f. Broad regex with confidence scoring

USAGE:
  python hub_updater.py "PSS Software Hub.html"
  python hub_updater.py "PSS Software Hub.html" --dry-run
  python hub_updater.py "PSS Software Hub.html" --only trackir,simhub
  python hub_updater.py "PSS Software Hub.html" --headless          # force all through Playwright
  python hub_updater.py "PSS Software Hub.html" --no-headless       # skip Playwright entirely
"""

import re
import sys
import json
import time
import random
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from urllib.parse import urljoin

# ───────────────────────────────────────────────────────────────
# DEPENDENCY BOOTSTRAP — auto-installs if missing
# ───────────────────────────────────────────────────────────────
_PIP_FLAGS = ['--break-system-packages', '-q']

def _pip_install(*pkgs):
    subprocess.check_call(
        [sys.executable, '-m', 'pip', 'install', *pkgs, *_PIP_FLAGS]
    )

def ensure_core_deps():
    """Install the always-needed packages."""
    required = {
        'requests':      'requests',
        'bs4':           'beautifulsoup4',
        'cloudscraper':  'cloudscraper',
    }
    missing = [pkg for mod, pkg in required.items()
               if not _mod_available(mod)]
    if missing:
        print(f"[setup] Installing: {', '.join(missing)}")
        _pip_install(*missing)

def ensure_playwright():
    """
    Install playwright + chromium if not already present.
    Returns True if Playwright is usable, False otherwise.
    """
    if not _mod_available('playwright'):
        print("[setup] Installing playwright…")
        try:
            _pip_install('playwright')
        except Exception as e:
            print(f"[setup] ✗ pip install playwright failed: {e}")
            return False

    # Ensure the Chromium browser binary is downloaded
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'playwright', 'install', 'chromium'],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            # Try installing system deps too (needs sudo on some systems)
            print("[setup] Installing Playwright system deps…")
            subprocess.run(
                [sys.executable, '-m', 'playwright', 'install-deps', 'chromium'],
                capture_output=True, text=True, timeout=120,
            )
            subprocess.run(
                [sys.executable, '-m', 'playwright', 'install', 'chromium'],
                capture_output=True, text=True, timeout=120,
            )
    except Exception as e:
        print(f"[setup] ✗ Playwright browser install failed: {e}")
        return False

    return _mod_available('playwright')

def _mod_available(mod_name):
    try:
        __import__(mod_name)
        return True
    except ImportError:
        return False

# Bootstrap core deps immediately
ensure_core_deps()

import requests
from bs4 import BeautifulSoup
import cloudscraper


# ═══════════════════════════════════════════════════════════════
# ADAPTIVE FETCHER — 3-tier escalating strategy
# ═══════════════════════════════════════════════════════════════
class AdaptiveFetcher:
    """
    Fetches web pages using escalating strategies to bypass protections
    and render JS-heavy SPAs.

    Tier 1 — Stealth HTTP (requests + browser UA)
    Tier 2 — Cloudflare bypass (cloudscraper)
    Tier 3 — Headless Chromium (Playwright) — full JS execution
    """

    STEALTH_HEADERS = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/131.0.0.0 Safari/537.36'
        ),
        'Accept': (
            'text/html,application/xhtml+xml,application/xml;'
            'q=0.9,image/avif,image/webp,*/*;q=0.8'
        ),
        'Accept-Language':            'en-US,en;q=0.5',
        'Accept-Encoding':            'gzip, deflate, br',
        'DNT':                         '1',
        'Connection':                  'keep-alive',
        'Upgrade-Insecure-Requests':   '1',
        'Sec-Fetch-Dest':              'document',
        'Sec-Fetch-Mode':              'navigate',
        'Sec-Fetch-Site':              'none',
        'Sec-Fetch-User':              '?1',
    }

    def __init__(self, playwright_mode='auto'):
        """
        playwright_mode:
          'auto'  — use Playwright only as last resort or when js_render=True
          'force' — always use Playwright (--headless flag)
          'off'   — never use Playwright (--no-headless flag)
        """
        self.pw_mode = playwright_mode
        self.session = requests.Session()
        self.session.headers.update(self.STEALTH_HEADERS)
        self.cf_scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        self._pw_ready = None          # lazy-init: None=unknown, True/False
        self._pw_browser = None
        self._pw_playwright = None

    # ── public API ───────────────────────────────────────────
    def fetch(self, url, timeout=20, js_render=False):
        """
        Fetch a page using escalating strategies.
        If js_render=True or pw_mode='force', go straight to Playwright.
        Returns (html_str, status_code) or (None, error_str).
        """
        force_pw = (self.pw_mode == 'force') or js_render
        skip_pw  = (self.pw_mode == 'off')

        if force_pw and not skip_pw:
            # Jump directly to headless browser
            html, status = self._try_playwright(url, timeout)
            if html:
                return html, status
            # If Playwright unavailable, fall through to HTTP strategies
            print(f"    ↳ Playwright unavailable, falling back to HTTP")

        # Tier 1 + 2: HTTP strategies
        strategies = [
            ('stealth-requests', self._fetch_stealth),
            ('cloudscraper',     self._fetch_cf),
        ]

        last_err = None
        for name, fn in strategies:
            try:
                html, status = fn(url, timeout)
                if status == 200 and html and len(html) > 500:
                    # Quick check: if page is a JS shell, escalate
                    if self._is_js_shell(html) and not skip_pw:
                        print(f"    ↳ {name} got JS shell, escalating to Playwright")
                        pw_html, pw_status = self._try_playwright(url, timeout)
                        if pw_html:
                            return pw_html, pw_status
                    return html, status
            except Exception as e:
                last_err = f"{name}: {e}"
                continue

        # Tier 3: last resort — headless browser
        if not skip_pw:
            html, status = self._try_playwright(url, timeout)
            if html:
                return html, status

        return None, last_err or 'all_strategies_failed'

    def close(self):
        """Clean up Playwright resources."""
        if self._pw_browser:
            try:
                self._pw_browser.close()
            except Exception:
                pass
        if self._pw_playwright:
            try:
                self._pw_playwright.stop()
            except Exception:
                pass

    # ── Tier 1: stealth HTTP ────────────────────────────────
    def _fetch_stealth(self, url, timeout):
        r = self.session.get(url, timeout=timeout, allow_redirects=True)
        return r.text, r.status_code

    # ── Tier 2: cloudscraper ────────────────────────────────
    def _fetch_cf(self, url, timeout):
        r = self.cf_scraper.get(url, timeout=timeout, allow_redirects=True)
        return r.text, r.status_code

    # ── Tier 3: Playwright headless Chromium ────────────────
    def _try_playwright(self, url, timeout):
        """
        Full headless browser fetch. Renders JS, waits for network idle,
        then captures the fully-rendered DOM.
        """
        if not self._ensure_pw():
            return None, 'playwright_unavailable'

        try:
            from playwright.sync_api import TimeoutError as PWTimeout

            context = self._pw_browser.new_context(
                user_agent=self.STEALTH_HEADERS['User-Agent'],
                viewport={'width': 1920, 'height': 1080},
                locale='en-US',
                timezone_id='America/New_York',
                # Stealth extras
                java_script_enabled=True,
                bypass_csp=True,
                extra_http_headers={
                    'Accept-Language': 'en-US,en;q=0.9',
                    'DNT': '1',
                },
            )

            page = context.new_page()

            # Block heavy resources to speed up load
            def route_handler(route):
                blocked = ('image', 'media', 'font', 'stylesheet')
                if route.request.resource_type in blocked:
                    route.abort()
                else:
                    route.continue_()

            page.route('**/*', route_handler)

            try:
                page.goto(url, wait_until='domcontentloaded',
                          timeout=timeout * 1000)
            except PWTimeout:
                pass  # partial load is fine, we still grab the DOM

            # Wait a bit for JS frameworks to render
            try:
                page.wait_for_load_state('networkidle', timeout=8000)
            except PWTimeout:
                pass

            # Extra wait for late-rendering SPAs
            page.wait_for_timeout(2000)

            html = page.content()
            context.close()

            if html and len(html) > 500:
                return html, 200
            return None, 'playwright_empty_page'

        except Exception as e:
            return None, f'playwright_error: {e}'

    def _ensure_pw(self):
        """Lazy-initialize Playwright browser."""
        if self._pw_ready is not None:
            return self._pw_ready

        if not ensure_playwright():
            self._pw_ready = False
            return False

        try:
            from playwright.sync_api import sync_playwright

            self._pw_playwright = sync_playwright().start()
            self._pw_browser = self._pw_playwright.chromium.launch(
                headless=True,
                args=[
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--disable-extensions',
                ],
            )
            self._pw_ready = True
            print("[playwright] ✓ Chromium headless browser ready")
            return True

        except Exception as e:
            print(f"[playwright] ✗ Failed to launch: {e}")
            self._pw_ready = False
            return False

    # ── Helpers ──────────────────────────────────────────────
    @staticmethod
    def _is_js_shell(html):
        """
        Detect pages that are empty JS shells (SPA skeletons).
        These need a headless browser to render actual content.
        """
        soup = BeautifulSoup(html, 'html.parser')
        body = soup.find('body')
        if not body:
            return True

        # Get visible text length (ignoring script/style)
        for tag in body.find_all(['script', 'style', 'noscript']):
            tag.decompose()

        visible = body.get_text(strip=True)

        # SPA shells typically have <div id="app"></div> and almost no text
        if len(visible) < 200:
            return True

        # Check for common SPA "please enable JS" messages
        noscript = soup.find('noscript')
        if noscript and ('enable javascript' in (noscript.get_text() or '').lower()
                         or 'javascript' in (noscript.get_text() or '').lower()):
            if len(visible) < 500:
                return True

        return False


# ═══════════════════════════════════════════════════════════════
# ADAPTIVE PARSER — survives page redesigns via multi-strategy
# ═══════════════════════════════════════════════════════════════
class AdaptiveParser:
    """
    Extracts version numbers and download links using MULTIPLE
    independent strategies so it still works when page elements
    move around, get renamed, or change structure.
    """

    VERSION_PATS = [
        re.compile(r'[Vv](?:ersion)?\s*[:.\s]\s*(\d+\.\d+\.\d+(?:\.\d+)?)'),
        re.compile(r'(\d+\.\d+\.\d+(?:\.\d+)?)\s*(?:download|release|latest|install)', re.I),
        re.compile(r'(?:download|release|latest|version|install|update|software).*?(\d+\.\d+\.\d+(?:\.\d+)?)', re.I),
        re.compile(r'(\d+\.\d+\.\d+(?:\.\d+)?)'),
    ]

    DL_EXTS = ('.exe', '.msi', '.zip', '.dmg', '.pkg', '.appimage',
               '.deb', '.rpm', '.tar.gz', '.tar.bz2')

    @classmethod
    def find_version(cls, html, hints=None):
        """
        Adaptive version discovery using 6 independent strategies.
        Returns the highest-confidence version string, or None.
        """
        soup = BeautifulSoup(html, 'html.parser')
        candidates = []          # list of (version_str, confidence_score)

        # ── Strategy 1: headings & page title ────────────────────
        for tag in soup.find_all(['title', 'h1', 'h2', 'h3', 'h4']):
            text = tag.get_text(strip=True)
            for pat in cls.VERSION_PATS:
                m = pat.search(text)
                if m:
                    candidates.append((m.group(1), 10))

        # ── Strategy 2: download link text + href ────────────────
        for a in soup.find_all('a', href=True):
            href = a['href'].lower()
            text = a.get_text(strip=True)
            if (any(href.endswith(ext) for ext in cls.DL_EXTS)
                    or 'download' in text.lower()
                    or 'download' in href):
                combined = f"{text} {a['href']}"
                for pat in cls.VERSION_PATS:
                    m = pat.search(combined)
                    if m:
                        candidates.append((m.group(1), 8))

        # ── Strategy 3: version-related class / id / data attrs ──
        for attr in ('class', 'id'):
            for el in soup.find_all(
                    attrs={attr: re.compile(r'version|release|update|build', re.I)}):
                text = el.get_text(strip=True)
                for pat in cls.VERSION_PATS:
                    m = pat.search(text)
                    if m:
                        candidates.append((m.group(1), 7))

        # data-version, data-release, etc.
        for el in soup.find_all(attrs=re.compile(r'^data-(?:version|release|build)')):
            for attr_name, attr_val in el.attrs.items():
                if attr_name.startswith('data-') and isinstance(attr_val, str):
                    for pat in cls.VERSION_PATS:
                        m = pat.search(attr_val)
                        if m:
                            candidates.append((m.group(1), 9))

        # ── Strategy 4: JSON-LD / structured data ────────────────
        for script in soup.find_all('script', type='application/ld+json'):
            try:
                data = json.loads(script.string or '')
                cls._extract_versions_from_json(data, candidates, score=9)
            except (json.JSONDecodeError, TypeError):
                pass

        # Also check inline JSON blobs in <script> tags
        for script in soup.find_all('script'):
            if script.string and 'version' in (script.string or '').lower():
                # Look for "version": "x.y.z" patterns in JS
                for m in re.finditer(
                        r'["\']version["\']\s*:\s*["\'](\d+\.\d+\.\d+(?:\.\d+)?)["\']',
                        script.string, re.I):
                    candidates.append((m.group(1), 8))

        # ── Strategy 5: hint-keyword proximity search ────────────
        if hints:
            all_text = soup.get_text()
            for hint in hints:
                prox = re.compile(
                    rf'{re.escape(hint)}.{{0,120}}?(\d+\.\d+\.\d+(?:\.\d+)?)',
                    re.I | re.DOTALL,
                )
                for m in prox.finditer(all_text):
                    candidates.append((m.group(1), 6))

        # ── Strategy 6: broad regex on all visible text ──────────
        all_text = soup.get_text()
        for pat in cls.VERSION_PATS[:-1]:          # skip the catch-all
            for m in pat.finditer(all_text):
                candidates.append((m.group(1), 3))

        if not candidates:
            return None

        # Pick highest score; break ties by largest version number
        def ver_key(item):
            v, score = item
            parts = [int(p) for p in v.split('.')]
            return (score, parts)

        candidates.sort(key=ver_key, reverse=True)
        return candidates[0][0]

    @classmethod
    def _extract_versions_from_json(cls, data, candidates, score=9):
        """Recursively extract version fields from JSON-LD / structured data."""
        if isinstance(data, dict):
            for key, val in data.items():
                if isinstance(val, str) and 'version' in key.lower():
                    for pat in cls.VERSION_PATS:
                        m = pat.search(val)
                        if m:
                            candidates.append((m.group(1), score))
                elif isinstance(val, (dict, list)):
                    cls._extract_versions_from_json(val, candidates, score)
        elif isinstance(data, list):
            for item in data:
                cls._extract_versions_from_json(item, candidates, score)

    @classmethod
    def find_download_links(cls, html, base_url=''):
        """Find download links adaptively."""
        soup = BeautifulSoup(html, 'html.parser')
        links = []

        for a in soup.find_all('a', href=True):
            href = a['href']
            text = a.get_text(strip=True)

            is_dl = (
                any(href.lower().endswith(ext) for ext in cls.DL_EXTS)
                or 'download' in text.lower()
                or 'download' in href.lower()
                or a.get('data-download') is not None
            )

            if is_dl and href:
                if not href.startswith('http'):
                    href = urljoin(base_url, href)
                links.append({'label': text or 'Download', 'url': href})

        return links


# ═══════════════════════════════════════════════════════════════
# PER-SOFTWARE SCRAPE CONFIGS
# ═══════════════════════════════════════════════════════════════
# Fields:
#   url        — primary download page
#   alt_urls   — fallback pages if primary fails
#   hints      — keywords near the version number
#   js_render  — True = site is a JS SPA, go straight to Playwright
#   check      — False to skip this entry entirely
# ═══════════════════════════════════════════════════════════════
SOFTWARE_CONFIGS = {
    'trackir': {
        'url':      'https://www.trackir.com/downloads/',
        'alt_urls': [
            'https://www.naturalpoint.com/trackir/downloads/',
            'https://www.naturalpoint.com/update/news/content/trackir5/news.html',
        ],
        'hints':     ['TrackIR', 'Software'],
        'js_render': True,          # trackir.com is a Vue SPA
        'check':     True,
    },
    'teamviewer': {
        'url':   'https://www.teamviewer.com/en-us/download/windows/',
        'hints': ['TeamViewer'],
        'check': True,
    },
    'steam': {
        'url':   'https://store.steampowered.com/about/',
        'hints': ['Steam'],
        'check': True,
    },
    'simucube': {
        'url':       'https://simucube.com/en-us/support/simucube-downloads/',
        'hints':     ['True Drive', 'Simucube'],
        'js_render': True,
        'check':     True,
    },
    'fanatec': {
        'url':       'https://www.fanatec.com/us/en/s/download-apps-driver',
        'hints':     ['Fanatec', 'driver'],
        'js_render': True,          # React SPA
        'check':     True,
    },
    'leobodnar': {
        'url':   'https://www.simsteering.com/downloads.html',
        'hints': ['SimSteering', 'firmware'],
        'check': True,
    },
    'simhub': {
        'url':       'https://www.simhubdash.com/download-2/',
        'hints':     ['SimHub'],
        'js_render': True,          # WordPress with late-loading version
        'check':     True,
    },
    'dbox': {
        'url':       'https://www.d-box.com/en/software-downloads',
        'hints':     ['D-BOX', 'Motion'],
        'js_render': True,
        'check':     True,
    },
    'qubic': {
        'url':   'https://qubicsystem.com/software/',
        'hints': ['QubicManager', 'Qubic'],
        'check': True,
    },
    'nvidia': {
        'url':       'https://www.nvidia.com/en-eu/software/',
        'hints':     ['GeForce', 'Game Ready', 'driver'],
        'js_render': True,          # heavy React SPA
        'check':     True,
    },
    'amd': {
        'url':       'https://www.amd.com/en/support/download/drivers.html',
        'hints':     ['Radeon', 'Adrenalin', 'driver'],
        'js_render': True,          # Angular SPA
        'check':     True,
    },
    'pimax': {
        'url':       'https://pimax.com/pages/downloads',
        'alt_urls':  ['https://pimax.com/downloads/'],
        'hints':     ['Pimax', 'PimaxXR', 'Play'],
        'js_render': True,
        'check':     True,
    },
    'varjo': {
        'url':       'https://varjo.com/downloads/',
        'hints':     ['Varjo', 'Base'],
        'js_render': True,
        'check':     True,
    },
    'simapp': {
        'url':   'https://www.winctrl.com/simapppro/',
        'hints': ['SimApp'],
        'check': True,
    },
    'haversine': {
        'url':   'https://haversine.com/airtrack/downloads',
        'hints': ['AirTrack', 'HSAIR'],
        'check': True,
    },
}


# ═══════════════════════════════════════════════════════════════
# HTML UPDATER — patches the CARDS array in the hub file
# ═══════════════════════════════════════════════════════════════
class HubUpdater:
    """Read the hub HTML, patch version fields, write it back."""

    def __init__(self, html_path):
        self.path = Path(html_path)
        self.html = self.path.read_text(encoding='utf-8')
        self.changes = 0

    # ── update / insert a version field on a card ────────────
    def update_card_version(self, card_id, version):
        # Case 1: card already has a version field → replace it
        pat = re.compile(
            rf"(id:\s*'{re.escape(card_id)}'.*?)"
            rf"version:\s*'[^']*'",
            re.DOTALL,
        )
        if pat.search(self.html):
            self.html = pat.sub(
                rf"\g<1>version:  '{version}'", self.html, count=1
            )
            self.changes += 1
            return

        # Case 2: no version field yet → inject one after the id line
        id_pat = re.compile(
            rf"(id:\s*'{re.escape(card_id)}',\n)"
        )
        m = id_pat.search(self.html)
        if m:
            insert_at = m.end()
            indent = '      '
            snippet = f"{indent}version:  '{version}',\n"
            self.html = self.html[:insert_at] + snippet + self.html[insert_at:]
            self.changes += 1

    # ── update download links for a card ─────────────────────
    def update_card_links(self, card_id, new_links):
        """
        Replace the `links: [...]` array for a card.
        Only updates if new_links is non-empty and looks valid.
        """
        if not new_links:
            return

        # Build the replacement JS array
        entries = []
        for lnk in new_links[:5]:
            label = lnk['label'].replace("'", "\\'")
            url   = lnk['url'].replace("'", "\\'")
            entries.append(f"        {{ label: '{label}', url: '{url}' }}")
        js_array = "[\n" + ",\n".join(entries) + "\n      ]"

        # Locate existing links array for this card
        pat = re.compile(
            rf"(id:\s*'{re.escape(card_id)}'.*?)"
            rf"links:\s*\[.*?\]",
            re.DOTALL,
        )
        if pat.search(self.html):
            self.html = pat.sub(
                rf"\g<1>links: {js_array}", self.html, count=1
            )
            self.changes += 1

    def save(self):
        self.path.write_text(self.html, encoding='utf-8')


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════
def main():
    import argparse
    ap = argparse.ArgumentParser(
        description='PSS Software Hub — Adaptive Link & Version Updater'
    )
    ap.add_argument('html', help='Path to PSS Software Hub.html')
    ap.add_argument('--dry-run', action='store_true',
                    help='Check versions but do not modify the HTML file')
    ap.add_argument('--only', type=str, default='',
                    help='Comma-separated list of card IDs to check (default: all)')
    ap.add_argument('--update-links', action='store_true',
                    help='Also update download links (not just version numbers)')

    pw_group = ap.add_mutually_exclusive_group()
    pw_group.add_argument('--headless', action='store_true',
                          help='Force ALL sites through Playwright headless browser')
    pw_group.add_argument('--no-headless', action='store_true',
                          help='Disable Playwright entirely (HTTP-only mode)')
    args = ap.parse_args()

    # Determine Playwright mode
    if args.headless:
        pw_mode = 'force'
    elif args.no_headless:
        pw_mode = 'off'
    else:
        pw_mode = 'auto'

    # Filter configs
    configs = SOFTWARE_CONFIGS
    if args.only:
        only_ids = set(args.only.split(','))
        configs = {k: v for k, v in configs.items() if k in only_ids}

    fetcher = AdaptiveFetcher(playwright_mode=pw_mode)
    updater = HubUpdater(args.html)

    results = {}
    total = len([c for c in configs.values() if c.get('check', False)])
    done  = 0

    js_count = len([c for c in configs.values()
                    if c.get('check') and c.get('js_render')])

    print(f"\n{'═'*60}")
    print(f"  PSS Software Hub — Adaptive Version Checker")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Checking {total} software pages "
          f"({js_count} require JS rendering)")
    print(f"  Playwright mode: {pw_mode}")
    print(f"{'═'*60}")

    for card_id, config in configs.items():
        if not config.get('check', False):
            continue

        done += 1
        js_flag = config.get('js_render', False)
        print(f"\n[{done}/{total}] {card_id}"
              f"{' ⚡ JS' if js_flag else ''}")
        print(f"  URL: {config['url']}")

        urls = [config['url']] + config.get('alt_urls', [])
        found = False

        for url in urls:
            html, status = fetcher.fetch(
                url, timeout=25,
                js_render=js_flag,
            )
            if not html:
                print(f"  ✗ Failed to fetch {url} ({status})")
                continue

            version = AdaptiveParser.find_version(html, config.get('hints'))
            links   = AdaptiveParser.find_download_links(html, url)

            if version:
                print(f"  ✓ Version: {version}")
                if links:
                    print(f"  ✓ {len(links)} download link(s) found")
                results[card_id] = {
                    'version':  version,
                    'links':    [{'label': l['label'][:60], 'url': l['url']}
                                 for l in links[:5]],
                    'checked':  datetime.now().isoformat(),
                    'source':   url,
                    'js_rendered': js_flag,
                }

                if not args.dry_run:
                    updater.update_card_version(card_id, version)
                    if args.update_links and links:
                        updater.update_card_links(card_id, links)
                found = True
                break
            else:
                print(f"  ✗ No version found on {url}")

        if not found and card_id not in results:
            print(f"  ⚠ Could not determine version for {card_id}")

        # polite rate limiting
        time.sleep(random.uniform(1.0, 2.5))

    # Clean up Playwright
    fetcher.close()

    # ── Summary ──────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"  RESULTS: {len(results)}/{total} versions found")
    print(f"{'═'*60}")

    if results:
        print()
        max_id = max(len(k) for k in results)
        for card_id, data in results.items():
            js_tag = " ⚡" if data.get('js_rendered') else ""
            print(f"  {card_id:<{max_id}}  v{data['version']}{js_tag}")

    if not args.dry_run and updater.changes > 0:
        updater.save()
        print(f"\n✓ {updater.changes} update(s) written to: {args.html}")
    elif args.dry_run:
        print(f"\n(dry run — no files modified)")
    else:
        print(f"\n(no changes needed)")

    # Save JSON sidecar for programmatic use
    json_path = Path(args.html).with_suffix('.versions.json')
    json_path.write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(f"✓ Version data → {json_path}")


if __name__ == '__main__':
    main()