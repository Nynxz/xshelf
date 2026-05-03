import { render } from "preact";
import { MasterApp } from "./MasterApp";
import "../explorer/explorer.css";
import "./master.css";

// Master lives at xshelf/index.html — media is at ./media/<author>/...
(window as { xshelfMediaPrefix?: string }).xshelfMediaPrefix = "media/";

render(<MasterApp />, document.getElementById("root")!);
