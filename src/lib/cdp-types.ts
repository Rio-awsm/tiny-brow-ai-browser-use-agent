export type CdpState = "detached" | "attached" | "restricted";

export interface CdpStatus {
  state: CdpState;
  tabId: number | null;
  url: string;
  /** Set when `state` is "restricted", or to explain an involuntary detach. */
  reason?: string;
  /** This session was opened explicitly, rather than for a single capture. */
  pinned: boolean;
  /**
   * Chrome reports a debugger on this tab and it is ours. When false while
   * attached, something else holds it — DevTools, another extension, or a
   * session our own service worker lost track of when it was evicted.
   */
  owned: boolean;
  attachedAt?: number;
}

export interface Screenshot {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: number;
  /** Milliseconds from attach (or reuse) to image in hand. */
  tookMs: number;
}

/** Scheme -> how to write it in a message. `about:` and `view-source:` are not
 *  hierarchical, so "about://" would be wrong. */
const RESTRICTED_SCHEMES: Record<string, string> = {
  "chrome:": "chrome://",
  "chrome-extension:": "chrome-extension://",
  "chrome-untrusted:": "chrome-untrusted://",
  "devtools:": "devtools://",
  "edge:": "edge://",
  "about:": "about:",
  "view-source:": "view-source:",
};

const RESTRICTED_HOSTS = ["chromewebstore.google.com"];

/**
 * Chrome refuses debugger attachment on its own pages and the Web Store. The
 * failure is a generic message from `attach()`, so the URL is checked first to
 * produce something the user can act on.
 */
export function restrictionFor(url: string): string | null {
  if (!url) return "No page loaded in this tab.";

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `Unrecognised URL: ${url}`;
  }

  const scheme = RESTRICTED_SCHEMES[u.protocol];
  if (scheme) {
    return `Chrome blocks debugger access to ${scheme} pages. Open a normal web page and try again.`;
  }
  if (RESTRICTED_HOSTS.includes(u.host)) {
    return "Chrome blocks debugger access to the Web Store. Open a normal web page and try again.";
  }
  if (u.protocol === "file:") {
    return 'Local files need "Allow access to file URLs" enabled for this extension.';
  }
  return null;
}
