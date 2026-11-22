import icon from "./icon.svg";

const favicon = document.createElement("link");
favicon.rel = "icon";
favicon.href = icon;
document.head.append(favicon);
