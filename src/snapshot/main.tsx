import "../assets/favicon";
import { render } from "preact";
import { App } from "../explorer/App";
import "../explorer/explorer.css";

render(<App />, document.getElementById("root")!);
