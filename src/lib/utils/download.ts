/**
 * Triggers a browser download of in-memory content via a transient
 * object URL — the same anchor-click technique the app's original
 * transcript-download handler used, generalized so every export format
 * (TXT/SRT/PDF) shares one implementation instead of three copies.
 */
export function downloadBlob(data: Blob | string, mimeType: string, filename: string): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    // Not appended visibly, but must be in the document for click() to
    // reliably trigger a download in every browser this app supports.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoking synchronously (rather than immediately after click()) risks
    // invalidating the URL before some browsers finish handing the
    // download off — defer one tick, same margin the browser's own
    // download-start signal effectively requires.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
