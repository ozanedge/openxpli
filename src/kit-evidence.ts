export interface AdEvidence {
  object: string;
  fields: Record<string, string>;
}
export interface PageEvidence {
  url: string;
  text: string;
  observedAt: number;
  ads?: AdEvidence[];
}
export function canonicalField(label: string): string {
  const name = label.trim().toLowerCase();
  if (/^(headline|title|ad title)$/.test(name)) return "headline";
  if (/^(cta|cta copy|call to action)$/.test(name)) return "cta";
  if (/^(destination url|destination|landing page url)$/.test(name)) return "destination URL";
  return name;
}

// Runs in the page. Only labeled table rows establish an ad/field relationship.
export function readAdRows(): AdEvidence[] {
  const ads: AdEvidence[] = [];
  for (const table of Array.from(document.querySelectorAll("table"))) {
    const rows = Array.from(table.rows);
    const headers = rows[0] ? Array.from(rows[0].cells) : [];
    if (!headers.length || headers.some(cell => cell.tagName !== "TH" || cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
    const labels = headers.map(cell => cell.innerText.trim());
    const objectIndex = labels.findIndex(label => /^(ad|ad name)$/i.test(label));
    if (objectIndex < 0 || new Set(labels.map(label => label.toLowerCase())).size !== labels.length) continue;
    for (const row of rows.slice(1)) {
      if (!row.getClientRects().length || row.cells.length !== labels.length) continue;
      const cells = Array.from(row.cells);
      if (cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) continue;
      const object = cells[objectIndex].innerText.trim();
      if (!object || object.length > 300) continue;
      const fields: Record<string, string> = {};
      cells.forEach((cell, index) => {
        const value = cell.innerText.trim();
        if (index !== objectIndex && value && value.length <= 4000) fields[labels[index]] = value;
      });
      ads.push({ object, fields });
      if (ads.length >= 100) return ads;
    }
  }
  return ads;
}
