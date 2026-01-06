# Smart Harvester

Smart Harvester is a browser extension that lets you extract structured product data directly from e-commerce websites.

It allows you to select products on a page and capture relevant information such as title, price, images, availability, and metadata, producing clean, structured output (JSON) that can be exported or processed further.

This extension is designed for developers, analysts, and automation workflows that require reliable product extraction from real-world e-commerce pages.

## Get started

Install the extension by loading it locally in your browser (Chrome / Chromium-based browsers).

> Public store releases may be added in the future.

### Install locally (Chromium)

1. Clone the repository:

    ```bash
    git clone https://github.com/deborahfam/ecom-scraper.git

    ```

2. Build the extension:

    `npm install npm run build`

3. Open your browser and navigate to `chrome://extensions`
4. Enable **Developer mode**
5. Click **Load unpacked** and select the `dist/` directory

## Use the extension

Once installed:

1. Navigate to an e-commerce product or listing page
2. Activate the extension
3. Select or detect product elements on the page
4. Extract structured product data
5. Export or consume the extracted data as needed

The exact extraction logic may vary depending on the site structure.

## Output format

Extracted data is designed to be machine-friendly and typically includes:

- Product name
- Price (raw and normalized)
- Currency
- Images
- Availability
- URL
- Additional attributes when available

The output can be easily integrated into scraping pipelines, databases, or downstream AI/ML workflows.

## Roadmap

In no particular order:

- Improved product detection heuristics
- Support for pagination and product listings
- Export to CSV / API endpoints
- Site-specific extraction profiles
- Schema validation for extracted products
- Optional AI-assisted normalization

## Developers

### Build

`npm run build`

This creates:

- `dist/` for Chromium-based browsers
- `dist_firefox/` for Firefox (experimental / optional)
- `dist_safari/` for Safari (if supported)

### Development workflow

- Source code lives in `src/`
- Browser-specific builds are generated automatically
- Keep permissions minimal and explicit in `manifest.json`

## Third-party libraries

This project uses several open-source libraries, including:

- webextension-polyfill — browser compatibility
- defuddle — content extraction
- turndown — HTML to Markdown conversion
- dayjs — date parsing and formatting
- lz-string — template compression
- lucide — icons
- dompurify — HTML sanitization

See `package.json` for the full dependency list.

## License

This project is licensed under the MIT License.

### Attribution

Parts of this codebase are derived from the project **[obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper)**, originally licensed under the MIT License.

Copyright (c) 2024 Obsidian Publish Ltd. and contributors
