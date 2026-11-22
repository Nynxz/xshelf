import "../assets/favicon";
import { render } from "preact";
import { App } from "./App";
import "./shelf.css";

// The shelf lives at xshelf/index.html — media is at ./media/<author>/...
// (dev.html pre-sets a stub prefix before this runs).
if (!window.xshelfMediaPrefix) window.xshelfMediaPrefix = "media/";

// We own scroll position (per-view memory + keeping the lightbox's item in
// view). The browser's own restore on Back would yank the page to wherever
// it was when the lightbox opened.
history.scrollRestoration = "manual";

render(<App />, document.getElementById("root")!);
