import { CONTENT_READY, type ContentMessage, type PageProbe } from "@/lib/messaging";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    console.log(CONTENT_READY, location.href);

    chrome.runtime.onMessage.addListener(
      (msg: ContentMessage, _sender, sendResponse) => {
        if (msg?.kind !== "probePage") return false;
        console.log("[tiny-brow content] probePage");
        sendResponse(probe());
        return false;
      },
    );
  },
});

function probe(): PageProbe {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    elementCount: document.querySelectorAll("*").length,
  };
}
