# BulkGen website

Static landing page for BulkGen for Flow, served by Vercel at https://bulkgen.mmd-rehan.com (project root directory: `website`).

- `index.html` home page, with SEO meta tags, Open Graph and Twitter cards, and JSON-LD (WebSite, SoftwareApplication, SoftwareSourceCode, Person)
- `privacy.html` privacy policy (served at /privacy), `404.html` not found page
- `assets/` logo, wordmark, app icons, Open Graph image
- `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`, `site.webmanifest`
- `robots.txt`, `sitemap.xml`, `llms.txt`
- `vercel.json` clean URLs and response headers

Preview locally: `python3 -m http.server` in this folder, then open http://localhost:8000.
