/**
 * OB-Zotero Academic Ingestion - Content Extractor
 * Extracts academic metadata, structured sections, high-res figures, and tables
 * from major scientific publisher platforms and PMC.
 */

(() => {
  function extractMeta(name) {
    const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i]`);
    return el ? el.getAttribute("content") : null;
  }

  function extractAllMeta(name) {
    const els = document.querySelectorAll(`meta[name="${name}" i], meta[property="${name}" i]`);
    return Array.from(els).map(el => el.getAttribute("content")).filter(Boolean);
  }

  function cleanText(text) {
    if (!text) return "";
    return text.replace(/\s+/g, " ").trim();
  }

  function extractPdfUrl() {
    // JAMA publishes a stable DOI-based PDF route; page links may contain expiring filenames.
    if (window.location.hostname === "jamanetwork.com" || window.location.hostname.endsWith(".jamanetwork.com")) {
      const doi = extractMeta("citation_doi");
      const journal = window.location.pathname.match(/^\/journals\/([^/]+)\//)?.[1];
      if (doi && journal && /^10\.1001\//i.test(doi)) {
        return `https://jamanetwork.com/journals/${journal}/articlepdf/${doi}`;
      }
      const jamaPdfEl = document.querySelector('a[href*="/articlepdf/"], a.toolbar-item-pdf, a[data-article-url*="articlepdf"]');
      if (jamaPdfEl && jamaPdfEl.href) {
        try {
          return new URL(jamaPdfEl.href, window.location.href).href;
        } catch (e) {}
      }
      const m = window.location.pathname.match(/\/journals\/([^\/]+)\/fullarticle\/(\d+)/);
      if (m) {
        return `https://jamanetwork.com/journals/${m[1]}/articlepdf/${m[2]}`;
      }
    }

    // NEJM uses its DOI PDF route. Avoid generic .pdf links to supplements.
    if (window.location.hostname === "nejm.org" || window.location.hostname.endsWith(".nejm.org")) {
      const doi = extractMeta("citation_doi") || window.location.pathname.match(/\/doi\/(?:full|abs|pdf)\/(10\.1056\/[^/?#]+)/i)?.[1];
      if (doi && /^10\.1056\//i.test(doi)) {
        return `https://www.nejm.org/doi/pdf/${doi}?download=true`;
      }
    }

    // Other publishers expose the article PDF in citation metadata.
    let pdfUrl = extractMeta("citation_pdf_url") ||
                 extractMeta("dc.identifier.uri") ||
                 extractMeta("fulltext_pdf");
    if (pdfUrl) {
      try {
        const resolved = new URL(pdfUrl, window.location.href).href;
        if (!resolved.includes("adobe.com") && !resolved.includes("get.adobe")) return resolved;
      } catch (e) {}
    }

    // 3. Specific publisher links
    const selectors = [
      'a[data-article-pdf]',
      'a.pdf-link',
      'a.c-pdf-download__link',
      'a[data-test="pdf-link"]',
      'a.download-pdf',
      'a.view-pdf',
      'a[data-track-action="download pdf"]',
      'a[data-aa-name="download-pdf"]',
      'a.int-view-pdf',
      'a[href*="/articlepdf/"]',
      'a[href*="/doi/pdf/"]',
      'a[href*="/action/showPdf"]',
      'a[href*="/pdfft?"]',
      'a[href*="/pdf/"]',
      'a[href$=".pdf"]',
      'a[aria-label*="PDF" i]',
      'a[title*="PDF" i]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.href) {
        try {
          const resolved = new URL(el.href, window.location.href).href;
          if (!resolved.includes("adobe.com") && !resolved.includes("get.adobe")) {
            return resolved;
          }
        } catch (e) {}
      }
    }

    // 4. If current URL is already a PDF
    if (window.location.pathname.toLowerCase().endsWith(".pdf") ||
        window.location.pathname.toLowerCase().includes("/articlepdf/") ||
        document.contentType === "application/pdf") {
      return window.location.href;
    }

    return null;
  }

  function extractMetadata() {
    // DOI
    let doi = extractMeta("citation_doi") ||
              extractMeta("dc.identifier") ||
              extractMeta("dc.doi") ||
              extractMeta("biorxiv.doi") ||
              extractMeta("medrxiv.doi");

    if (!doi) {
      const doiLink = document.querySelector('a[href*="doi.org/10."]');
      if (doiLink) {
        const m = doiLink.href.match(/10\.\d{4,9}\/[-._;()/:+A-Za-z0-9]+/);
        if (m) doi = m[0];
      }
    }

    // PMID
    let pmid = extractMeta("citation_pmid") || extractMeta("pmid");
    if (!pmid) {
      const pmidEl = document.querySelector('.current-id, [data-ga-category="PMID"], .identifier.pubmed a');
      if (pmidEl) {
        const m = pmidEl.textContent.match(/\b\d{7,9}\b/);
        if (m) pmid = m[0];
      }
      if (!pmid && window.location.hostname.includes("pubmed.ncbi.nlm.nih.gov")) {
        const m = window.location.pathname.match(/\/(\d{7,9})\/?/);
        if (m) pmid = m[1];
      }
    }

    // Title
    let title = extractMeta("citation_title") ||
                extractMeta("dc.title") ||
                extractMeta("og:title") ||
                document.querySelector("h1.c-article-title, h1.article-header__title, h1#title, h1.heading-title, h1")?.textContent;
    title = cleanText(title);

    // Authors
    let authors = extractAllMeta("citation_author");
    if (authors.length === 0) {
      const authorEls = document.querySelectorAll('.c-article-author-list__item, .author-name, .full-name');
      authors = Array.from(authorEls).map(el => cleanText(el.textContent)).filter(Boolean);
    }
    const authorsStr = authors.length > 0 ? authors.join(", ") : "";

    // Journal
    let journal = extractMeta("citation_journal_title") ||
                  extractMeta("citation_journal_abbrev") ||
                  extractMeta("dc.source") ||
                  document.querySelector(".c-article-info-details a, .journal-actions a, .journal-title")?.textContent;
    journal = cleanText(journal);

    // Publication Year
    let pubDate = extractMeta("citation_publication_date") ||
                  extractMeta("citation_date") ||
                  extractMeta("dc.date");
    let year = null;
    if (pubDate) {
      const m = pubDate.match(/\b(19\d\d|20\d\d)\b/);
      if (m) year = parseInt(m[1], 10);
    }
    if (!year) {
      const dateEl = document.querySelector(".c-article-identifiers__item time, .cit, .article-header__date");
      if (dateEl) {
        const m = dateEl.textContent.match(/\b(19\d\d|20\d\d)\b/);
        if (m) year = parseInt(m[1], 10);
      }
    }

    // Abstract
    let abstract = extractMeta("citation_abstract") || extractMeta("description");
    if (!abstract || abstract.length < 50) {
      const absEl = document.querySelector("#abstract, .abstract, .c-article-section__content[id*='Abs'], #Abs1-section, .abstract-content, .article-section__abstract");
      if (absEl) {
        abstract = cleanText(absEl.textContent);
      }
    }

    const pdfUrl = extractPdfUrl();

    return {
      title,
      authors: authorsStr,
      journal,
      year,
      doi,
      pmid,
      abstract,
      url: window.location.href,
      pdf_url: pdfUrl,
    };
  }

  function extractSections() {
    const sections = [];
    const articleRoot = document.querySelector("article, main, .c-article-body, #mc, .entry-content, body");
    if (!articleRoot) return sections;

    // Headings to capture
    const headings = articleRoot.querySelectorAll("h2, h3");
    headings.forEach((headingEl) => {
      const headingText = cleanText(headingEl.textContent);
      if (!headingText) return;

      // Filter out utility sections like references, disclosures, acknowledgements if too cluttered
      const lower = headingText.toLowerCase();
      if (lower.includes("reference") || lower.includes("cookie") || lower.includes("disclosure") || lower.includes("competing interest")) {
        return;
      }

      const level = headingEl.tagName.toLowerCase() === "h2" ? 2 : 3;

      // Collect sibling paragraphs until next heading
      const paragraphs = [];
      let sibling = headingEl.nextElementSibling;
      while (sibling && !["H1", "H2", "H3"].includes(sibling.tagName)) {
        if (sibling.tagName === "P" || sibling.classList?.contains("paragraph") || sibling.classList?.contains("c-article-section__paragraph")) {
          const pText = cleanText(sibling.textContent);
          if (pText.length > 10) {
            paragraphs.push(pText);
          }
        }
        sibling = sibling.nextElementSibling;
      }

      if (paragraphs.length > 0) {
        sections.push({
          heading: headingText,
          level: level,
          text: paragraphs.join("\n\n"),
        });
      }
    });

    return sections;
  }

  function extractFigures() {
    const figures = [];
    const seen = new Set();
    const addFigure = (src, caption, label) => {
      if (!src || src.startsWith("data:")) return;
      try {
        src = new URL(src, window.location.href).href;
        const key = new URL(src).pathname;
        if (seen.has(key)) return;
        seen.add(key);
        figures.push({ src, caption, label });
      } catch (e) {}
    };

    // JAMA's View Large figures are CDN anchors and may sit outside <figure>.
    if (window.location.hostname === "jamanetwork.com" || window.location.hostname.endsWith(".jamanetwork.com")) {
      const largeLinks = document.querySelectorAll('a[href*="cdn.jamanetwork.com"]');
      largeLinks.forEach((link) => {
        let url;
        try { url = new URL(link.href, window.location.href); } catch (e) { return; }
        if (!/\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname)) return;
        if (!/view large/i.test(`${link.textContent || ""} ${link.getAttribute("aria-label") || ""}`)) return;
        let container = link.parentElement;
        let label = "";
        for (let depth = 0; container && depth < 6; depth++, container = container.parentElement) {
          const text = cleanText(container.textContent);
          const match = text.match(/\bFigure\s+\d+\b/i);
          if (match && text.length < 3000) {
            label = match[0];
            break;
          }
        }
        const caption = cleanText(container?.querySelector?.("figcaption, .caption, .figure-description")?.textContent || "");
        addFigure(url.href, caption, label || `Figure_${figures.length + 1}`);
      });
      if (figures.length > 0) return figures;
    }
    const figEls = document.querySelectorAll("figure, .c-article-section__figure, .figure-wrap, .highwire-figure");

    figEls.forEach((figEl, idx) => {
      // Find image element
      const img = figEl.querySelector("img");
      if (!img) return;

      // High-res source priority: a[href], data-src, srcset, src
      let src = "";
      const highResLink = figEl.querySelector('a[href$=".jpg" i], a[href$=".png" i], a[data-figure-link]');
      if (highResLink && highResLink.href) {
        src = highResLink.href;
      } else if (img.getAttribute("data-src")) {
        src = img.getAttribute("data-src");
      } else if (img.srcset) {
        const parts = img.srcset.split(",").map(p => p.trim());
        if (parts.length > 0) {
          src = parts[parts.length - 1].split(" ")[0];
        }
      } else {
        src = img.src;
      }

      // Absolute URL resolution
      try {
        src = new URL(src, window.location.href).href;
      } catch (e) {}

      // Find caption
      const captionEl = figEl.querySelector("figcaption, .c-article-section__figure-description, .caption, p");
      const caption = cleanText(captionEl ? captionEl.textContent : "");

      // Label (e.g. Fig. 1)
      const labelEl = figEl.querySelector(".figure-title, strong, b, h3, h4");
      let label = labelEl ? cleanText(labelEl.textContent) : `Figure_${idx + 1}`;
      if (!label || label.length > 30) label = `Figure_${idx + 1}`;

      addFigure(src, caption, label);
    });

    return figures;
  }

  function tableToMarkdown(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll("tr"));
    if (rows.length === 0) return "";

    let md = "";
    const colCount = Math.max(...rows.map(r => r.querySelectorAll("th, td").length));

    rows.forEach((row, rIdx) => {
      const cells = Array.from(row.querySelectorAll("th, td")).map(c => cleanText(c.textContent).replace(/\|/g, "\\|"));
      while (cells.length < colCount) cells.push("");
      md += `| ${cells.join(" | ")} |\n`;

      // Insert separator after header
      if (rIdx === 0) {
        md += `| ${Array(colCount).fill("---").join(" | ")} |\n`;
      }
    });

    return md;
  }

  function extractTables() {
    const tables = [];
    const tableWraps = document.querySelectorAll(".table-wrap, .c-article-table, figure.table, table");

    tableWraps.forEach((wrapEl, idx) => {
      const table = wrapEl.tagName === "TABLE" ? wrapEl : wrapEl.querySelector("table");
      if (!table) return;

      const captionEl = wrapEl.querySelector("caption, .table-title, figcaption, .caption");
      const caption = cleanText(captionEl ? captionEl.textContent : `Table ${idx + 1}`);

      const mdTable = tableToMarkdown(table);
      if (mdTable && mdTable.length > 20) {
        tables.push({
          caption,
          markdown: mdTable,
        });
      }
    });

    return tables;
  }

  // Execute extraction
  const data = {
    metadata: extractMetadata(),
    sections: extractSections(),
    figures: extractFigures(),
    tables: extractTables(),
    cookies: document.cookie,
  };

  return data;
})();
